import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { writeJsonAtomic } from "./tui-presentation.mjs";

const SEGMENT_RE = /^events-(\d+)-(\d+)\.jsonl$/;
const DEFAULT_RECENT_LIMIT = 500;
const DEFAULT_SEGMENT_EVENT_LIMIT = 200;
const DEFAULT_SEGMENT_BYTE_LIMIT = 1024 * 1024;

function boundedPositiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

function parseEvents(path) {
  if (!existsSync(path)) {
    return [];
  }
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((event) => event && Number.isInteger(event.sequence) && event.sequence > 0 && typeof event.kind === "string");
}

function segmentDescriptor(path, name) {
  const match = SEGMENT_RE.exec(name);
  if (!match) {
    return null;
  }
  return {
    path,
    startSequence: Number.parseInt(match[1], 10),
    endSequence: Number.parseInt(match[2], 10),
  };
}

export class MemoryEventJournal {
  constructor({ maxRecentEvents = DEFAULT_RECENT_LIMIT, now = () => new Date().toISOString() } = {}) {
    this.maxRecentEvents = boundedPositiveInteger(maxRecentEvents, DEFAULT_RECENT_LIMIT, 5000);
    this.now = now;
    this.nextSequence = 1;
    this.recentEvents = [];
  }

  append(kind, data = {}) {
    const event = {
      ...data,
      sequence: this.nextSequence++,
      timestamp: this.now(),
      kind,
    };
    this.recentEvents.push(event);
    if (this.recentEvents.length > this.maxRecentEvents) {
      this.recentEvents.splice(0, this.recentEvents.length - this.maxRecentEvents);
    }
    return event;
  }

  updates({ afterSequence = 0, limit = 20, sessionId = null } = {}) {
    const boundedAfter = Number.isInteger(afterSequence) && afterSequence >= 0 ? afterSequence : 0;
    const boundedLimit = boundedPositiveInteger(limit, 20, 25);
    const available = this.recentEvents.filter((event) => event.sequence > boundedAfter);
    const selected = [];
    let scannedThroughSequence = boundedAfter;
    for (const event of available) {
      scannedThroughSequence = event.sequence;
      if (!sessionId || !event.sessionId || event.sessionId === sessionId) {
        selected.push(event);
      }
      if (selected.length >= boundedLimit) {
        break;
      }
    }
    const remaining = available.filter((event) => event.sequence > scannedThroughSequence);
    const oldestAvailableSequence = this.recentEvents[0]?.sequence ?? this.nextSequence;
    return {
      events: selected,
      nextAfterSequence: scannedThroughSequence,
      hasMore: remaining.some((event) => !sessionId || !event.sessionId || event.sessionId === sessionId),
      oldestAvailableSequence,
      latestSequence: this.nextSequence - 1,
      cursorGap: boundedAfter > 0 && boundedAfter < oldestAvailableSequence - 1,
    };
  }

  evidence(sequences = []) {
    const requested = new Set(sequences.filter((value) => Number.isInteger(value) && value > 0).slice(0, 20));
    return this.recentEvents.filter((event) => requested.has(event.sequence));
  }

  info() {
    return {
      durable: false,
      format: "memory",
      latestSequence: this.nextSequence - 1,
      recentFromSequence: this.recentEvents[0]?.sequence ?? this.nextSequence,
      recentEventCount: this.recentEvents.length,
    };
  }
}

export class DurableEventJournal extends MemoryEventJournal {
  constructor({
    root,
    maxRecentEvents = DEFAULT_RECENT_LIMIT,
    maxSegmentEvents = DEFAULT_SEGMENT_EVENT_LIMIT,
    maxSegmentBytes = DEFAULT_SEGMENT_BYTE_LIMIT,
    now,
  }) {
    if (!root) {
      throw new Error("DurableEventJournal requires a root directory");
    }
    super({ maxRecentEvents, now });
    this.root = resolve(root);
    this.activePath = join(this.root, "events-active.jsonl");
    this.statePath = join(this.root, "journal-state.json");
    this.maxSegmentEvents = boundedPositiveInteger(maxSegmentEvents, DEFAULT_SEGMENT_EVENT_LIMIT, 10_000);
    this.maxSegmentBytes = boundedPositiveInteger(maxSegmentBytes, DEFAULT_SEGMENT_BYTE_LIMIT, 64 * 1024 * 1024);
    mkdirSync(this.root, { recursive: true });
    this.closedSegments = this.scanClosedSegments();
    this.recover();
  }

  scanClosedSegments() {
    return readdirSync(this.root, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => segmentDescriptor(join(this.root, entry.name), entry.name))
      .filter(Boolean)
      .sort((left, right) => left.startSequence - right.startSequence);
  }

  recover() {
    const state = existsSync(this.statePath)
      ? (() => {
        try {
          return JSON.parse(readFileSync(this.statePath, "utf8"));
        } catch {
          return null;
        }
      })()
      : null;
    if (existsSync(this.activePath)) {
      const activeText = readFileSync(this.activePath, "utf8");
      if (activeText && !activeText.endsWith("\n")) {
        appendFileSync(this.activePath, "\n", "utf8");
      }
    }
    const activeEvents = parseEvents(this.activePath);
    const newestClosed = this.closedSegments.at(-1)?.endSequence ?? 0;
    const newestActive = activeEvents.at(-1)?.sequence ?? 0;
    const recordedNext = Number.isInteger(state?.nextSequence) ? state.nextSequence : 1;
    this.nextSequence = Math.max(newestClosed, newestActive, recordedNext - 1) + 1;
    this.activeStartSequence = activeEvents[0]?.sequence ?? this.nextSequence;
    this.activeEventCount = activeEvents.length;
    this.activeBytes = existsSync(this.activePath) ? statSync(this.activePath).size : 0;

    const recent = [...activeEvents];
    for (let index = this.closedSegments.length - 1; index >= 0 && recent.length < this.maxRecentEvents; index -= 1) {
      recent.unshift(...parseEvents(this.closedSegments[index].path));
    }
    recent.sort((left, right) => left.sequence - right.sequence);
    this.recentEvents = recent.slice(-this.maxRecentEvents);
    if (this.activeEventCount >= this.maxSegmentEvents || this.activeBytes >= this.maxSegmentBytes) {
      this.rotateActive();
    }
    this.persistState();
  }

  persistState() {
    writeJsonAtomic(this.statePath, {
      schemaVersion: 1,
      nextSequence: this.nextSequence,
      activeStartSequence: this.activeStartSequence,
      activeEventCount: this.activeEventCount,
      activeBytes: this.activeBytes,
      closedSegmentCount: this.closedSegments.length,
      updatedAt: this.now(),
    });
  }

  rotateActive() {
    if (!this.activeEventCount || !existsSync(this.activePath)) {
      this.activeStartSequence = this.nextSequence;
      this.activeEventCount = 0;
      this.activeBytes = 0;
      return null;
    }
    const endSequence = this.nextSequence - 1;
    const name = `events-${String(this.activeStartSequence).padStart(12, "0")}-${String(endSequence).padStart(12, "0")}.jsonl`;
    const closedPath = join(this.root, name);
    renameSync(this.activePath, closedPath);
    const descriptor = {
      path: closedPath,
      startSequence: this.activeStartSequence,
      endSequence,
    };
    this.closedSegments.push(descriptor);
    this.activeStartSequence = this.nextSequence;
    this.activeEventCount = 0;
    this.activeBytes = 0;
    return descriptor;
  }

  append(kind, data = {}) {
    const event = super.append(kind, data);
    const line = `${JSON.stringify(event)}\n`;
    appendFileSync(this.activePath, line, "utf8");
    if (this.activeEventCount === 0) {
      this.activeStartSequence = event.sequence;
    }
    this.activeEventCount += 1;
    this.activeBytes += Buffer.byteLength(line);
    if (this.activeEventCount >= this.maxSegmentEvents || this.activeBytes >= this.maxSegmentBytes) {
      this.rotateActive();
    }
    this.persistState();
    return event;
  }

  evidence(sequences = []) {
    const requested = new Set(sequences.filter((value) => Number.isInteger(value) && value > 0).slice(0, 20));
    if (!requested.size) {
      return [];
    }
    const found = new Map(super.evidence([...requested]).map((event) => [event.sequence, event]));
    const missing = () => [...requested].filter((sequence) => !found.has(sequence));
    for (const segment of this.closedSegments) {
      if (!missing().some((sequence) => sequence >= segment.startSequence && sequence <= segment.endSequence)) {
        continue;
      }
      for (const event of parseEvents(segment.path)) {
        if (requested.has(event.sequence)) {
          found.set(event.sequence, event);
        }
      }
    }
    if (missing().length && existsSync(this.activePath)) {
      for (const event of parseEvents(this.activePath)) {
        if (requested.has(event.sequence)) {
          found.set(event.sequence, event);
        }
      }
    }
    return [...found.values()].sort((left, right) => left.sequence - right.sequence);
  }

  info() {
    const base = super.info();
    return {
      ...base,
      durable: true,
      format: "segmented-jsonl",
      root: this.root,
      activePath: this.activePath,
      statePath: this.statePath,
      closedSegmentCount: this.closedSegments.length,
      latestClosedPath: this.closedSegments.at(-1)?.path ?? null,
    };
  }
}
