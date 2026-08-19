import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableEventJournal, MemoryEventJournal } from "./event-journal.mjs";

test("memory journal keeps a bounded cursor window", () => {
  const journal = new MemoryEventJournal({ maxRecentEvents: 3 });
  for (let index = 0; index < 5; index += 1) {
    journal.append("session_update", { index });
  }
  const updates = journal.updates({ afterSequence: 1, limit: 10 });
  assert.deepEqual(updates.events.map((event) => event.sequence), [3, 4, 5]);
  assert.equal(updates.cursorGap, true);
  assert.equal(updates.latestSequence, 5);
});

test("session-scoped updates advance across unrelated events while retaining global control events", () => {
  const journal = new MemoryEventJournal();
  journal.append("session_update", { sessionId: "session-a", text: "a" });
  journal.append("session_update", { sessionId: "session-b", text: "b" });
  journal.append("leader_exit", { code: 1 });
  const updates = journal.updates({ afterSequence: 0, sessionId: "session-a" });
  assert.deepEqual(updates.events.map((event) => event.sequence), [1, 3]);
  assert.equal(updates.nextAfterSequence, 3);
  assert.equal(updates.hasMore, false);
});

test("durable journal rotates JSONL segments and resumes sequence numbers", (t) => {
  const root = mkdtempSync(join(tmpdir(), "grok-supervisor-journal-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const first = new DurableEventJournal({ root, maxRecentEvents: 3, maxSegmentEvents: 2 });
  first.append("leader_started", { pid: 1 });
  first.append("session_update", { text: "one" });
  first.append("prompt_completed", { result: { stopReason: "end_turn" } });
  assert.equal(first.info().closedSegmentCount, 1);

  const recovered = new DurableEventJournal({ root, maxRecentEvents: 3, maxSegmentEvents: 2 });
  const next = recovered.append("session_update", { text: "two" });
  assert.equal(next.sequence, 4);
  assert.deepEqual(recovered.evidence([1, 4]).map((event) => event.sequence), [1, 4]);
  assert.equal(recovered.info().durable, true);
});

test("durable journal exposes paths without returning the full history", (t) => {
  const root = mkdtempSync(join(tmpdir(), "grok-supervisor-journal-info-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const journal = new DurableEventJournal({ root, maxSegmentEvents: 1 });
  journal.append("session_update", { text: "bounded" });
  const info = journal.info();
  assert.equal(info.format, "segmented-jsonl");
  assert.equal(info.closedSegmentCount, 1);
  assert.equal("events" in info, false);
  assert.match(info.latestClosedPath, /events-\d+-\d+\.jsonl$/);
});
