import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { validateSessionId, validateWorkingDirectory } from "./supervisor-core.mjs";
import { writeJsonAtomic } from "./tui-presentation.mjs";

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

// Resolve junctions/symlinks and Windows case before assigning ownership. The
// caller's working directory is never a default for an absent workspace.
export function canonicalWorkspace(value, { mustExist = true } = {}) {
  if (typeof value !== "string" || !value.trim() || !isAbsolute(value)) {
    throw fail("GROK_WORKSPACE_REQUIRED", "cwd must be an absolute existing project directory");
  }
  let cwd = mustExist ? validateWorkingDirectory(value) : resolve(value);
  if (existsSync(cwd)) cwd = realpathSync.native(cwd);
  const identity = process.platform === "win32" ? cwd.toLowerCase() : cwd;
  return { cwd, identity, key: createHash("sha256").update(identity).digest("hex") };
}

function entryFor(key, cwd, stateRoot, supervisor, sessionIds = []) {
  return {
    key, cwd, stateRoot, supervisor, sessionIds: new Set(sessionIds),
    writerLease: null, opening: false, inFlightWrites: 0,
  };
}

export class WorkspaceRegistry {
  constructor({ stateRoot, legacySupervisor, createSupervisor }) {
    this.stateRoot = resolve(stateRoot);
    this.path = join(this.stateRoot, "workspaces.json");
    this.createSupervisor = createSupervisor;
    this.legacy = entryFor("legacy", null, this.stateRoot, legacySupervisor);
    this.entries = new Map([["legacy", this.legacy]]);
    this.initialization = null;
  }

  async initialize() {
    if (!this.initialization) this.initialization = this.load();
    return this.initialization;
  }

  createEntry(key, cwd, sessionIds = []) {
    const stateRoot = join(this.stateRoot, "workspaces", key);
    const supervisor = this.createSupervisor({
      stateRoot,
      workspaceCwd: cwd,
      proxySettingsPath: join(this.stateRoot, "proxy-settings.json"),
      persistTuiRuntime: true,
    });
    return entryFor(key, cwd, stateRoot, supervisor, sessionIds);
  }

  async load() {
    if (existsSync(this.path)) {
      let saved;
      try { saved = JSON.parse(readFileSync(this.path, "utf8")); } catch {
        throw fail("GROK_WORKSPACE_REGISTRY_INVALID", "The workspace registry is unreadable; refusing to guess session ownership");
      }
      if (saved?.schemaVersion !== 1 || !Array.isArray(saved.workspaces)) {
        throw fail("GROK_WORKSPACE_REGISTRY_INVALID", "Unsupported workspace registry");
      }
      const identities = new Set();
      const sessions = new Set();
      const keys = new Set();
      for (const row of saved.workspaces) {
        const workspace = canonicalWorkspace(row.cwd, { mustExist: false });
        if ((row.key !== "legacy" && row.key !== workspace.key) || keys.has(row.key)
          || identities.has(workspace.identity) || !Array.isArray(row.sessionIds)) {
          throw fail("GROK_WORKSPACE_REGISTRY_INVALID", "Conflicting workspace registry entries");
        }
        for (const id of row.sessionIds) {
          validateSessionId(id);
          if (sessions.has(id)) throw fail("GROK_WORKSPACE_REGISTRY_INVALID", "A session is registered to more than one workspace");
          sessions.add(id);
        }
        keys.add(row.key);
        identities.add(workspace.identity);
        if (row.key === "legacy") {
          this.legacy.cwd = workspace.cwd;
          this.legacy.sessionIds = new Set(row.sessionIds);
        } else {
          this.entries.set(row.key, this.createEntry(row.key, workspace.cwd, row.sessionIds));
        }
      }
    }

    // Keep the pre-upgrade core, socket, journal, and TUI ownership records in
    // place. Even an exited Leader's validly shaped record identifies which
    // workspace owns those files; it is not evidence that the process is live.
    const core = this.legacy.supervisor;
    const ownership = core.readLeaderOwnership?.();
    const currentSessionId = core.attachedSessionId || core.activeRun?.sessionId || core.recovery?.interruptedRun?.sessionId;
    const workspaceEvents = (core.events || []).filter((event) => typeof event.cwd === "string"
      && isAbsolute(event.cwd) && ["session_created", "session_attached", "session_opened"].includes(event.kind));
    const sessionEvent = currentSessionId && [...workspaceEvents].reverse().find((event) => event.sessionId === currentSessionId);
    const completeHistory = !core.journal || core.journal.nextSequence === (core.events?.length || 0) + 1;
    const historicalWorkspaces = completeHistory
      ? new Map(workspaceEvents.map((event) => {
        const workspace = canonicalWorkspace(event.cwd, { mustExist: false });
        return [workspace.identity, workspace.cwd];
      })) : new Map();
    const historicalCwd = historicalWorkspaces.size === 1 ? [...historicalWorkspaces.values()][0] : null;
    const cwd = core.attachedCwd || ownership?.record?.cwd || core.leaderCwd || sessionEvent?.cwd || historicalCwd || null;
    if (cwd) {
      const workspace = canonicalWorkspace(cwd, { mustExist: false });
      if (this.legacy.cwd && canonicalWorkspace(this.legacy.cwd, { mustExist: false }).identity !== workspace.identity) {
        throw fail("GROK_WORKSPACE_REGISTRY_INVALID", "Legacy Leader ownership disagrees with the workspace registry");
      }
      const other = this.findCwd(workspace.cwd);
      if (other && other !== this.legacy) {
        throw fail("GROK_WORKSPACE_REGISTRY_INVALID", "Legacy and isolated state claim the same workspace");
      }
      const previousCwd = this.legacy.cwd;
      const previousSessions = new Set(this.legacy.sessionIds);
      try {
        this.legacy.cwd = workspace.cwd;
        for (const id of [core.attachedSessionId, core.activeRun?.sessionId, core.recovery?.interruptedRun?.sessionId]) {
          if (id) this.addSession(this.legacy, id);
        }
        this.persist();
      } catch (cause) {
        this.legacy.cwd = previousCwd;
        this.legacy.sessionIds = previousSessions;
        if (cause?.code === "GROK_WORKSPACE_SESSION_MISMATCH") throw cause;
        throw Object.assign(fail("GROK_WORKSPACE_REGISTRY_WRITE_FAILED", "Could not save legacy workspace registration; existing sessions were not changed"), {
          cause, details: { cwd: workspace.cwd, verificationRequired: false },
        });
      }
    }
    return this;
  }

  persist() {
    writeJsonAtomic(this.path, {
      schemaVersion: 1,
      workspaces: [...this.entries.values()].filter((entry) => entry.cwd).map((entry) => ({
        key: entry.key, cwd: entry.cwd, sessionIds: [...entry.sessionIds],
      })),
    });
  }

  findCwd(cwd) {
    const identity = canonicalWorkspace(cwd, { mustExist: false }).identity;
    return [...this.entries.values()].find((entry) => entry.cwd
      && canonicalWorkspace(entry.cwd, { mustExist: false }).identity === identity) || null;
  }

  findSession(sessionId) {
    if (!sessionId) return null;
    validateSessionId(sessionId);
    const matches = [...this.entries.values()].filter((entry) => entry.sessionIds.has(sessionId)
      || entry.supervisor.attachedSessionId === sessionId
      || entry.supervisor.activeRun?.sessionId === sessionId
      || entry.supervisor.recovery?.interruptedRun?.sessionId === sessionId);
    if (matches.length > 1) throw fail("GROK_WORKSPACE_SESSION_MISMATCH", "More than one workspace claims this session");
    return matches[0] || null;
  }

  addSession(entry, sessionId) {
    validateSessionId(sessionId);
    const existing = this.findSession(sessionId);
    if (existing && existing !== entry) {
      throw fail("GROK_WORKSPACE_SESSION_MISMATCH", "This session belongs to another workspace");
    }
    entry.sessionIds.add(sessionId);
  }

  rememberSession(entry, sessionId) {
    if (!sessionId) return;
    const alreadyRegistered = entry.sessionIds.has(sessionId);
    this.addSession(entry, sessionId);
    try {
      this.persist();
    } catch (cause) {
      if (!alreadyRegistered) entry.sessionIds.delete(sessionId);
      throw Object.assign(fail("GROK_WORKSPACE_REGISTRY_WRITE_FAILED", "Session opened but its workspace registration could not be saved; inspect this exact cwd and session before retrying"), {
        cause, details: { cwd: entry.cwd, sessionId, stateRoot: entry.stateRoot, verificationRequired: true },
      });
    }
  }

  legacyHasHistory() {
    const core = this.legacy.supervisor;
    return Boolean(core.attachedSessionId || core.activeRun || core.events?.length
      || core.recovery?.interruptedRun || core.recovery?.orphanedPermissions?.length
      || core.recovery?.orphanedElicitations?.length || core.recovery?.orphanedWorkspaceTrust?.length);
  }

  async select(selectors = {}, { boundKey = null, create = false, readOnly = false } = {}) {
    await this.initialize();
    const { cwd, sessionId, runId, permissionId, elicitationId } = selectors;
    const candidates = [];
    const sessionEntry = this.findSession(sessionId);
    if (sessionId && !sessionEntry && !readOnly && !(cwd && create)) {
      throw fail("GROK_WORKSPACE_SESSION_MISMATCH", "The exact session is not registered to a workspace; inspect or resume it with its explicit cwd first");
    }
    if (sessionEntry) candidates.push(sessionEntry);
    for (const [id, match] of [
      [runId, (core) => core.activeRun?.runId === runId || core.recovery?.interruptedRun?.runId === runId],
      [permissionId, (core) => core.pendingPermissions?.has(permissionId)],
      [elicitationId, (core) => core.pendingElicitations?.has(elicitationId)],
    ]) {
      if (!id) continue;
      const matches = [...this.entries.values()].filter((entry) => match(entry.supervisor));
      if (matches.length > 1) throw fail("GROK_WORKSPACE_SESSION_MISMATCH", "The request identifier is ambiguous across workspaces");
      if (!matches.length && !readOnly) throw fail("GROK_WORKSPACE_SESSION_MISMATCH", "The exact run, permission, or input request is not active in a known workspace");
      if (matches[0]) candidates.push(matches[0]);
    }
    if (new Set(candidates).size > 1) {
      throw fail("GROK_WORKSPACE_SESSION_MISMATCH", "The request identifiers belong to different workspaces");
    }
    let entry = candidates[0] || null;
    if (cwd !== undefined && cwd !== null) {
      const workspace = canonicalWorkspace(cwd);
      let selected = this.findCwd(workspace.cwd);
      if (entry && selected !== entry) {
        throw fail("GROK_WORKSPACE_SESSION_MISMATCH", "The requested session or operation belongs to another workspace");
      }
      if (!selected && create) {
        if (!this.legacy.cwd && !this.legacyHasHistory()) {
          selected = this.legacy;
          selected.cwd = workspace.cwd;
        } else {
          selected = this.createEntry(workspace.key, workspace.cwd);
          this.entries.set(workspace.key, selected);
        }
        try {
          this.persist();
        } catch (cause) {
          if (selected === this.legacy) selected.cwd = null;
          else this.entries.delete(selected.key);
          throw Object.assign(fail("GROK_WORKSPACE_REGISTRY_WRITE_FAILED", "Workspace registration could not be saved; no session was opened"), {
            cause, details: { cwd: workspace.cwd, verificationRequired: false },
          });
        }
      }
      if (!selected) throw fail("GROK_WORKSPACE_REQUIRED", "Open or inspect the exact workspace before addressing its session");
      entry = selected;
    } else if (boundKey) {
      const bound = this.entries.get(boundKey);
      if (entry && bound && entry !== bound && !readOnly) {
        throw fail("GROK_WORKSPACE_SESSION_MISMATCH", "This host client is bound to another workspace; open the intended workspace explicitly");
      }
      entry ||= bound || null;
    }
    if (!entry) {
      const assigned = [...this.entries.values()].filter((item) => item.cwd);
      if (assigned.length === 0 && readOnly) entry = this.legacy;
      else if (assigned.length === 1 && readOnly && !sessionId && !runId && !permissionId && !elicitationId) entry = assigned[0];
      else throw fail("GROK_WORKSPACE_REQUIRED", "Specify the current project's absolute cwd or exact registered sessionId");
    }
    return entry;
  }

  snapshot() {
    return [...this.entries.values()].filter((entry) => entry.cwd).slice(0, 50).map((entry) => ({
      key: entry.key, cwd: entry.cwd, sessionId: entry.supervisor.attachedSessionId || null,
    }));
  }
}
