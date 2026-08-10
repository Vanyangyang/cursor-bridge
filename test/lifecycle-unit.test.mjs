import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import test from 'node:test';

import {
  lifecycleEndpointTag,
  supervisorSockPath,
  supervisorLogPath,
} from '../lifecycle-paths.mjs';
import {
  quoteCmdArg,
  buildCommandLine,
  buildHiddenWmiCreateScript,
  allowUnsafeCmdStart,
  spawnOutsideJob,
} from '../win-job-breakaway.mjs';
import {
  applyBootEnv,
  writeSupervisorDiag,
} from '../cursor-lifecycle-supervisor.mjs';
import {
  listBootEnvFiles,
  ensureSupervisorConnected,
  pingSupervisor,
} from '../cursor-lifecycle-client.mjs';
import {
  normalizeCodexThreadCwd,
  resolveCodexThreadProjectPath,
  resolveProjectPath,
  selectNewCdpTarget,
  targetTitleMatchesProject,
} from '../cursor-ensure-core.mjs';
import {
  normalizeWorkspacePath,
  readWorkspaceBinding,
  resolveWorkspaceBindingKey,
  writeWorkspaceBinding,
} from '../workspace-binding.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(ROOT);
const MOCK_ENSURE = join(REPO, 'test', 'fixtures', 'mock-ensure.mjs');

test('new Cursor CDP targets bind a newly opened project without relying on generic window titles', () => {
  const before = new Set(['existing-target']);
  assert.equal(selectNewCdpTarget(before, [
    { id: 'existing-target', title: 'Cursor Agents' },
    { id: 'vesperix-target', title: 'Cursor Agents' },
  ]).id, 'vesperix-target');
  assert.equal(selectNewCdpTarget(before, [
    { id: 'generic-new', title: 'Cursor Agents' },
    { id: 'vesperix-target', title: 'VESPERIX - Cursor' },
  ], 'G:\\u2dProject\\u6project\\VESPERIX').id, 'vesperix-target');
  assert.equal(selectNewCdpTarget(before, [{ id: 'existing-target' }]), null);
});

test('existing Editor targets can recover a project binding while generic Agents titles cannot', () => {
  assert.equal(targetTitleMatchesProject('VESPERIX - Cursor', 'G:\\u2dProject\\u6project\\VESPERIX'), true);
  assert.equal(targetTitleMatchesProject('Cursor Agents', 'G:\\u2dProject\\u6project\\VESPERIX'), false);
  assert.equal(targetTitleMatchesProject('game - Cursor', 'G:\\game.code-workspace'), true);
});

test('Codex thread cwd escapes plugin-cache cwd without exposing a workspace tool parameter', (t) => {
  const project = mkdtempSync(join(tmpdir(), 'cb-thread-project-'));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  const extended = `\\\\?\\${project}`;
  assert.equal(normalizeCodexThreadCwd(extended), project);
  assert.equal(resolveProjectPath('', {
    cwd: 'C:\\Users\\test\\.codex\\plugins\\cache\\cursor-bridge',
    threadProjectPath: extended,
  }), resolve(project));
  assert.equal(resolveCodexThreadProjectPath({
    threadId: 'thread-test',
    useCache: false,
    lookupThreadCwd: () => extended,
  }), resolve(project));
});

test('Codex thread lookup degrades cleanly when node:sqlite is unavailable', () => {
  assert.equal(resolveCodexThreadProjectPath({
    threadId: 'thread-node18',
    useCache: false,
    requireImpl: () => { throw new Error('node:sqlite unavailable'); },
  }), null);
});

test('cursor_init workspace bindings persist per Codex thread and can be reinitialized', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'cb-workspace-binding-'));
  const first = join(directory, 'first');
  const second = join(directory, 'second');
  const file = join(directory, 'state', 'workspaces.json');
  mkdirSync(first, { recursive: true });
  mkdirSync(second, { recursive: true });
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const key = resolveWorkspaceBindingKey({ CODEX_THREAD_ID: 'thread-a' });
  assert.equal(key, 'codex-thread:thread-a');
  writeWorkspaceBinding(file, key, first, { updatedAt: '2026-08-10T00:00:00.000Z' });
  assert.equal(readWorkspaceBinding(file, key).projectPath, normalizeWorkspacePath(first));
  writeWorkspaceBinding(file, key, second, { updatedAt: '2026-08-10T00:01:00.000Z' });
  assert.equal(readWorkspaceBinding(file, key).projectPath, normalizeWorkspacePath(second));
  assert.equal(readWorkspaceBinding(file, 'codex-thread:other'), null);
});

function makeDir() {
  return mkdtempSync(join(tmpdir(), 'cb-unit-'));
}

function killPid(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(pid), '/F', '/T'], { stdio: 'ignore', windowsHide: true });
    } else {
      process.kill(pid, 'SIGTERM');
    }
  } catch {}
}

async function withEnv(env, fn) {
  const previous = { ...process.env };
  for (const key of Object.keys(process.env)) {
    if (!(key in env) && key.startsWith('CURSOR_BRIDGE_')) delete process.env[key];
  }
  Object.assign(process.env, env);
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in previous)) delete process.env[key];
    }
    Object.assign(process.env, previous);
  }
}

test('lifecycleEndpointTag: shared long prefix dirs get distinct tags; same path is stable', () => {
  const prefix = 'C:\\Users\\Administrator\\AppData\\Local\\cursor-bridge\\lifecycle-very-long-prefix-aaaaaaaaaaaaaaaa';
  const a = `${prefix}-alpha`;
  const b = `${prefix}-bravo`;
  const tagA = lifecycleEndpointTag(a);
  const tagB = lifecycleEndpointTag(b);
  assert.equal(tagA.length, 24);
  assert.equal(tagB.length, 24);
  assert.notEqual(tagA, tagB);
  assert.equal(lifecycleEndpointTag(a), tagA);
  assert.equal(lifecycleEndpointTag(a), lifecycleEndpointTag(a));

  const legacyA = Buffer.from(a).toString('base64url').slice(0, 24);
  const legacyB = Buffer.from(b).toString('base64url').slice(0, 24);
  assert.equal(legacyA, legacyB, 'precondition: legacy base64 truncations collide');
  assert.notEqual(tagA, tagB);

  if (process.platform === 'win32') {
    const sockA = supervisorSockPath(a);
    const sockB = supervisorSockPath(b);
    assert.notEqual(sockA, sockB);
    assert.match(sockA, new RegExp(tagA));
    assert.match(sockB, new RegExp(tagB));
    assert.equal(supervisorSockPath(a), sockA);
  }
});

test('quoteCmdArg covers spaces, embedded quotes, and trailing backslashes', () => {
  assert.equal(quoteCmdArg('simple'), 'simple');
  assert.equal(quoteCmdArg(''), '""');
  assert.equal(quoteCmdArg('a b'), '"a b"');
  assert.equal(quoteCmdArg('say "hi"'), '"say \\"hi\\""');

  assert.equal(quoteCmdArg('C:\\dir with space\\'), '"C:\\dir with space\\\\"');
  assert.equal(quoteCmdArg('ends with \\'), '"ends with \\\\"');
  assert.equal(quoteCmdArg('x\\"y'), '"x\\\\\\"y"');

  const file = 'C:\\Program Files\\node.exe';
  const script = 'C:\\path with space\\script.mjs';
  const flagged = '--flag="value"';
  const trailing = 'noSpaceTrail\\';
  assert.equal(quoteCmdArg(file), '"C:\\Program Files\\node.exe"');
  assert.equal(quoteCmdArg(script), '"C:\\path with space\\script.mjs"');
  assert.equal(quoteCmdArg(flagged), '"--flag=\\"value\\""');
  assert.equal(quoteCmdArg(trailing), trailing);
  const line = buildCommandLine(file, [script, flagged, trailing]);
  assert.equal(line, [quoteCmdArg(file), quoteCmdArg(script), quoteCmdArg(flagged), quoteCmdArg(trailing)].join(' '));
});

test('allowUnsafeCmdStart is off by default', () => {
  assert.equal(allowUnsafeCmdStart({}), false);
  assert.equal(allowUnsafeCmdStart({ CURSOR_BRIDGE_UNSAFE_CMD_START: '1' }), true);
  assert.equal(allowUnsafeCmdStart({ CURSOR_BRIDGE_ALLOW_UNSAFE_JOB_BREAKAWAY: '1' }), true);
});

test('WMI create script starts console processes without a visible window', () => {
  const script = buildHiddenWmiCreateScript(
    '"C:\\Program Files\\nodejs\\node.exe" "C:\\it\'s here\\supervisor.mjs"',
    'C:\\work dir',
  );
  assert.match(script, /Win32_ProcessStartup/);
  assert.match(script, /CreateFlags = \[uint32\]0x00000008/);
  assert.match(script, /ShowWindow = \[uint16\]0/);
  assert.match(script, /ProcessStartupInformation = \$startup/);
  assert.match(script, /it''s here/);
});

test('WMI failure without unsafe env is an explicit failure (no silent cmd-start)', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('Windows-only spawn policy');
    return;
  }
  const result = spawnOutsideJob(process.execPath, ['-e', 'process.exit(0)'], {
    env: {
      ...process.env,
      CURSOR_BRIDGE_TEST_FORCE_WMI_FAIL: '1',
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.method, 'failed');
  assert.match(String(result.error), /WMI/);
  assert.match(String(result.error), /disabled|CURSOR_BRIDGE_UNSAFE_CMD_START/);
});

test('unsafe cmd-start fallback is marked degraded/unsafe when explicitly enabled', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('Windows-only spawn policy');
    return;
  }
  const result = spawnOutsideJob(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 2000)'], {
    env: {
      ...process.env,
      CURSOR_BRIDGE_TEST_FORCE_WMI_FAIL: '1',
      CURSOR_BRIDGE_UNSAFE_CMD_START: '1',
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.method, 'cmd-start-trampoline');
  assert.equal(result.degraded, true);
  assert.equal(result.unsafe, true);
  assert.match(String(result.warning || ''), /unsafe|WMI/i);
  if (result.pid) killPid(result.pid);
});

test('applyBootEnv deletes boot-env file after successful read', () => {
  const dir = makeDir();
  try {
    const boot = join(dir, 'boot-env-test.json');
    writeFileSync(boot, JSON.stringify({ CURSOR_BRIDGE_TEST_MARKER: 'from-boot' }), 'utf8');
    delete process.env.CURSOR_BRIDGE_TEST_MARKER;
    const result = applyBootEnv(boot);
    assert.equal(result.applied, true);
    assert.equal(result.deleted, true);
    assert.equal(existsSync(boot), false);
    assert.equal(process.env.CURSOR_BRIDGE_TEST_MARKER, 'from-boot');
  } finally {
    delete process.env.CURSOR_BRIDGE_TEST_MARKER;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('client best-effort deletes boot-env on spawn failure', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('spawn-failure via forced WMI miss is Windows-specific');
    return;
  }
  const dir = makeDir();
  try {
    await withEnv({
      ...process.env,
      CURSOR_BRIDGE_LIFECYCLE_DIR: dir,
      CURSOR_BRIDGE_SUPERVISOR_SCRIPT: join(REPO, 'cursor-lifecycle-supervisor.mjs'),
      CURSOR_BRIDGE_ENSURE_MODULE: MOCK_ENSURE,
      CURSOR_BRIDGE_TEST_FORCE_WMI_FAIL: '1',
    }, async () => {
      delete process.env.CURSOR_BRIDGE_UNSAFE_CMD_START;
      delete process.env.CURSOR_BRIDGE_ALLOW_UNSAFE_JOB_BREAKAWAY;
      let threw = false;
      try {
        await ensureSupervisorConnected({ createWaitMs: 500 });
      } catch (error) {
        threw = true;
        assert.match(String(error.message || error), /failed to spawn|WMI/i);
      }
      assert.equal(threw, true);
      assert.deepEqual(listBootEnvFiles(dir), []);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('successful supervisor start leaves no boot-env-* files', async () => {
  const dir = makeDir();
  const counter = join(dir, 'ensure-count.txt');
  writeFileSync(counter, '0\n', 'utf8');
  try {
    await withEnv({
      ...process.env,
      CURSOR_BRIDGE_LIFECYCLE_DIR: dir,
      CURSOR_BRIDGE_ENSURE_MODULE: MOCK_ENSURE,
      CURSOR_BRIDGE_TEST_COUNTER: counter,
      CURSOR_BRIDGE_SUPERVISOR_IDLE_MS: '5000',
      CURSOR_BRIDGE_SUPERVISOR_SCRIPT: join(REPO, 'cursor-lifecycle-supervisor.mjs'),
    }, async () => {
      const ready = await pingSupervisor();
      assert.equal(ready.ok, true);
      assert.deepEqual(listBootEnvFiles(dir), []);
      await new Promise((r) => setTimeout(r, 200));
      assert.deepEqual(listBootEnvFiles(dir), []);
      killPid(ready.supervisorPid);
      await new Promise((r) => setTimeout(r, 400));
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('client cleans boot-env on IPC timeout path', async () => {
  const dir = makeDir();
  const stuck = join(dir, 'stuck-supervisor.mjs');
  writeFileSync(stuck, 'process.exit(0);\n', 'utf8');
  try {
    await withEnv({
      ...process.env,
      CURSOR_BRIDGE_LIFECYCLE_DIR: dir,
      CURSOR_BRIDGE_SUPERVISOR_SCRIPT: stuck,
      CURSOR_BRIDGE_ENSURE_MODULE: MOCK_ENSURE,
    }, async () => {
      let threw = false;
      try {
        await ensureSupervisorConnected({ createWaitMs: 400 });
      } catch {
        threw = true;
      }
      assert.equal(threw, true);
      assert.deepEqual(listBootEnvFiles(dir), []);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeSupervisorDiag records start/listen-like events without secrets and rotates', () => {
  const dir = makeDir();
  try {
    const logPath = supervisorLogPath(dir);
    writeSupervisorDiag(logPath, 'start', { reason: 'unit', dir, adapterPid: 123 });
    writeSupervisorDiag(logPath, 'listen', { reason: 'listening', sock: 'sock-path' });
    writeSupervisorDiag(logPath, 'ensure-result', {
      ok: true,
      status: 'already',
      reason: 'ping',
      adapterPid: 123,
      ensureCount: 1,
    });
    writeSupervisorDiag(logPath, 'idle', { reason: 'idle-1', clients: 0 });
    writeSupervisorDiag(logPath, 'idle-suppressed', { reason: 'minimal-runtime-owns-window-guard', clients: 0 });
    writeSupervisorDiag(logPath, 'cleanup', { reason: 'shutdown', code: 0 });

    const body = readFileSync(logPath, 'utf8');
    assert.match(body, /"event":"start"/);
    assert.match(body, /"event":"listen"/);
    assert.match(body, /"event":"ensure-result"/);
    assert.match(body, /"event":"idle"/);
    assert.match(body, /"event":"idle-suppressed"/);
    assert.match(body, /"event":"cleanup"/);
    assert.match(body, /"supervisorPid":/);
    assert.match(body, /"adapterPid":123/);
    assert.doesNotMatch(body, /CURSOR_BRIDGE_API_KEY|password|PROMPT|-----BEGIN/i);
    assert.doesNotMatch(body, /"env":/);

    writeFileSync(logPath, 'x'.repeat(300 * 1024), 'utf8');
    writeSupervisorDiag(logPath, 'fatal', { reason: 'rotate-check', error: 'boom' });
    assert.equal(existsSync(`${logPath}.1`), true);
    const fresh = readFileSync(logPath, 'utf8');
    assert.match(fresh, /"event":"fatal"/);
    assert.ok(fresh.length < 300 * 1024);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
