import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
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
  classifyOutsideJobSpawnError,
  spawnOutsideJob,
} from '../win-job-breakaway.mjs';
import {
  applyBootEnv,
  writeSupervisorDiag,
} from '../cursor-lifecycle-supervisor.mjs';
import {
  listBootEnvFiles,
  ensureSupervisorConnected,
  materializeLifecycleSupervisorRuntime,
  pingSupervisor,
} from '../cursor-lifecycle-client.mjs';
import {
  normalizeCodexThreadCwd,
  normalizeCursorExeCandidate,
  findCursorExeDetails,
  cursorRunning,
  ensureCursorRunningLocal,
  resolveCodexThreadProjectPath,
  resolveCursorLaunchCdpPort,
  resolveProjectPath,
  selectAgentsWindowTarget,
  selectNewCdpTarget,
  isAgentsWindowTitle,
  targetCanServeProject,
  targetTitleMatchesProject,
} from '../cursor-ensure-core.mjs';
import { ensureCursorRunning } from '../launch-cursor.mjs';
import {
  normalizeWorkspacePath,
  isAbsoluteWorkspacePath,
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

test('Cursor launch never uses privileged or invalid CDP ports', () => {
  assert.equal(resolveCursorLaunchCdpPort(1), 9223);
  assert.equal(resolveCursorLaunchCdpPort('1'), 9223);
  assert.equal(resolveCursorLaunchCdpPort(0), 9223);
  assert.equal(resolveCursorLaunchCdpPort(9223), 9223);
  assert.equal(resolveCursorLaunchCdpPort(9333), 9333);
});

test('lifecycle supervisor runtime is content-addressed outside the plugin source', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cb-supervisor-runtime-'));
  const source = join(root, 'source-supervisor.mjs');
  const state = join(root, 'state');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(source, 'console.log("v1")\n', 'utf8');

  const first = materializeLifecycleSupervisorRuntime({ sourceScript: source, dir: state });
  const second = materializeLifecycleSupervisorRuntime({ sourceScript: source, dir: state });
  assert.equal(first.script, second.script);
  assert.equal(first.fingerprint, second.fingerprint);
  assert.equal(readFileSync(first.script, 'utf8'), 'console.log("v1")\n');
  assert.match(first.script, /[\\/]runtime[\\/]supervisor-/);
  assert.equal(first.runtimeRoot.startsWith(state), true);
  assert.notEqual(dirname(first.script), dirname(source));
  assert.notEqual(first.script, source);

  writeFileSync(source, 'console.log("v2")\n', 'utf8');
  const changed = materializeLifecycleSupervisorRuntime({ sourceScript: source, dir: state });
  assert.notEqual(changed.fingerprint, first.fingerprint);
  assert.notEqual(changed.script, first.script);
});

class FakeSupervisorSocket extends EventEmitter {
  constructor(ping = {}) {
    super();
    this.ping = ping;
    this.requestTypes = [];
  }
  write(line) {
    const request = JSON.parse(String(line).trim());
    this.requestTypes.push(request.type);
    queueMicrotask(() => this.emit('data', `${JSON.stringify({
      id: request.id,
      type: 'pong',
      ok: true,
      ...this.ping,
    })}\n`));
    return true;
  }
  end() {}
  destroy() {}
}

test('healthy supervisor reuse is side-effect free and defers runtime replacement', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cb-reuse-first-'));
  const dir = join(root, 'must-not-be-created');
  const socket = new FakeSupervisorSocket({
    runtimeFingerprint: 'old-runtime',
    runtimeScript: 'old-supervisor.mjs',
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const connection = await ensureSupervisorConnected({
    dir,
    supervisorScript: join(REPO, 'cursor-lifecycle-supervisor.mjs'),
    connectSupervisorImpl: async () => socket,
    materializeRuntimeImpl: () => { throw new Error('must not materialize while reusing'); },
  });
  assert.equal(connection.reusedSupervisor, true);
  assert.equal(connection.runtimeUpgradeDeferred, true);
  assert.deepEqual(socket.requestTypes, ['ping']);
  assert.equal(existsSync(dir), false);
});

test('an unresponsive supervisor pipe degrades without attempting a competing spawn', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cb-unresponsive-supervisor-'));
  let spawned = false;
  t.after(() => rmSync(root, { recursive: true, force: true }));
  await assert.rejects(() => ensureSupervisorConnected({
    dir: join(root, 'lifecycle'),
    supervisorScript: join(REPO, 'cursor-lifecycle-supervisor.mjs'),
    connectSupervisorImpl: async () => { throw new Error('supervisor connect timeout (1500ms)'); },
    spawnNodeOutsideJobImpl: () => { spawned = true; return { ok: true, method: 'test', pid: 1 }; },
  }), (error) => {
    assert.equal(error.errorKind, 'supervisor-unresponsive');
    assert.equal(error.canAttachFallback, true);
    return true;
  });
  assert.equal(spawned, false);
});

test('existing Editor targets can recover a project binding while generic Agents titles cannot', () => {
  assert.equal(targetTitleMatchesProject('VESPERIX - Cursor', 'G:\\u2dProject\\u6project\\VESPERIX'), true);
  assert.equal(targetTitleMatchesProject('Cursor Agents', 'G:\\u2dProject\\u6project\\VESPERIX'), false);
  assert.equal(targetTitleMatchesProject('game - Cursor', 'G:\\game.code-workspace'), true);
  assert.equal(isAgentsWindowTitle('Cursor Agents'), true);
  assert.equal(isAgentsWindowTitle('Cursor Settings - cursor-bridge - Cursor'), false);
  assert.equal(targetCanServeProject('Cursor Agents', 'G:\\u2dProject\\u6project\\VESPERIX'), true);
  assert.equal(targetCanServeProject('Cursor Settings - cursor-bridge - Cursor', 'G:\\u2dProject\\u6project\\VESPERIX'), false);
  assert.equal(selectAgentsWindowTarget([
    { id: 'settings', title: 'Cursor Settings - cursor-bridge - Cursor' },
    { id: 'agents', title: 'Cursor Agents' },
  ]).id, 'agents');
});

function fakeSpawnRecorder() {
  const spawned = [];
  return {
    spawned,
    spawnImpl(exe, args, options) {
      spawned.push({ exe, args, options });
      return { unref() {} };
    },
  };
}

test('ensure reuses an already-open Agents Window and never opens an IDE window', async (t) => {
  const project = mkdtempSync(join(tmpdir(), 'cb-agents-reuse-'));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  const { spawned, spawnImpl } = fakeSpawnRecorder();
  const pages = [
    { id: 'settings', title: 'Cursor Settings - cursor-bridge - Cursor', type: 'page' },
    { id: 'agents', title: 'Cursor Agents', type: 'page' },
  ];
  const result = await ensureCursorRunningLocal({
    projectPath: project,
    cdpUpImpl: async () => true,
    cdpIsCursorImpl: async () => true,
    listCdpPageTargetsImpl: async () => pages,
    spawnImpl,
    findCursorExeDetailsImpl: () => ({
      path: 'C:\\Program Files\\Cursor\\Cursor.exe',
      source: 'test',
      platform: 'win32',
    }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'already');
  assert.equal(result.workspaceAction, 'reused-agents-window');
  assert.equal(result.targetId, 'agents');
  assert.equal(spawned.length, 0);
  assert.match(result.message, /without opening another IDE window/);

  const again = await ensureCursorRunningLocal({
    projectPath: project,
    cdpUpImpl: async () => true,
    cdpIsCursorImpl: async () => true,
    listCdpPageTargetsImpl: async () => pages,
    spawnImpl,
    findCursorExeDetailsImpl: () => ({
      path: 'C:\\Program Files\\Cursor\\Cursor.exe',
      source: 'test',
      platform: 'win32',
    }),
  });
  assert.equal(again.workspaceAction, 'reused-agents-window');
  assert.equal(spawned.length, 0);
});

test('attached ensure never spawns and reports an external launch requirement when CDP is absent', async (t) => {
  const project = mkdtempSync(join(tmpdir(), 'cb-attached-offline-'));
  let spawned = 0;
  t.after(() => rmSync(project, { recursive: true, force: true }));
  const result = await ensureCursorRunningLocal({
    projectPath: project,
    allowSpawn: false,
    allowProcessControl: false,
    cdpUpImpl: async () => false,
    spawnImpl: () => { spawned += 1; throw new Error('must not spawn'); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'external-launch-required');
  assert.equal(result.needsAction, 'launch_cursor_with_cdp');
  assert.equal(spawned, 0);
});

test('async child spawn EPERM becomes a structured failure instead of an uncaught error', async (t) => {
  const project = mkdtempSync(join(tmpdir(), 'cb-spawn-error-'));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  const result = await ensureCursorRunningLocal({
    projectPath: project,
    cdpUpImpl: async () => true,
    cdpIsCursorImpl: async () => true,
    listCdpPageTargetsImpl: async () => [{ id: 'other', title: 'other-project - Cursor', type: 'page' }],
    findCursorExeDetailsImpl: () => ({ path: 'C:\\Cursor\\Cursor.exe', source: 'test', platform: 'win32' }),
    spawnImpl: () => {
      const child = new EventEmitter();
      child.unref = () => {};
      queueMicrotask(() => child.emit('error', Object.assign(new Error('spawn denied'), { code: 'EPERM' })));
      return child;
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'spawn-blocked');
  assert.equal(result.errorCode, 'EPERM');
  assert.equal(result.needsAction, 'open_workspace_in_cursor');
});

test('policy-blocked supervisor spawn falls back to verified attached Cursor', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cb-attached-fallback-'));
  const project = join(root, 'project');
  mkdirSync(project, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = await ensureCursorRunning({
    dir: join(root, 'lifecycle'),
    projectPath: project,
    supervisorScript: join(REPO, 'cursor-lifecycle-supervisor.mjs'),
    spawnNodeOutsideJobImpl: () => ({
      ok: false,
      method: 'failed',
      error: 'spawnSync powershell.exe EPERM',
      errorKind: 'policy-blocked',
      degradedReason: 'spawn-policy-blocked',
      errorCode: 'EPERM',
      canAttachFallback: true,
    }),
    cdpUpImpl: async () => true,
    cdpIsCursorImpl: async () => true,
    listCdpPageTargetsImpl: async () => [{ id: 'agents', title: 'Cursor Agents', type: 'page' }],
  });
  assert.equal(result.ok, true);
  assert.equal(result.lifecycleMode, 'attached');
  assert.equal(result.persistent, false);
  assert.equal(result.degradedReason, 'spawn-policy-blocked');
  assert.equal(result.spawnErrorCode, 'EPERM');
  assert.equal(result.capabilities.canLaunchCursor, false);
  assert.equal(result.capabilities.canOpenWorkspaceWindow, false);
});

test('configuration-class supervisor failures do not silently attach', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cb-no-config-fallback-'));
  const project = join(root, 'project');
  mkdirSync(project, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  await assert.rejects(() => ensureCursorRunning({
    dir: join(root, 'lifecycle'),
    projectPath: project,
    supervisorScript: join(REPO, 'cursor-lifecycle-supervisor.mjs'),
    spawnNodeOutsideJobImpl: () => ({
      ok: false,
      method: 'failed',
      error: 'Win32_Process.Create failed: 21',
      errorKind: 'configuration',
      errorCode: 21,
      returnValue: 21,
      canAttachFallback: false,
    }),
    cdpUpImpl: async () => true,
    cdpIsCursorImpl: async () => true,
    listCdpPageTargetsImpl: async () => [{ id: 'agents', title: 'Cursor Agents', type: 'page' }],
  }), /failed to spawn lifecycle supervisor/);
});

test('ensure still opens a new workbench window when only another project editor is present', async (t) => {
  const project = mkdtempSync(join(tmpdir(), 'cb-new-window-'));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  const { spawned, spawnImpl } = fakeSpawnRecorder();
  let calls = 0;
  const result = await ensureCursorRunningLocal({
    projectPath: project,
    cdpUpImpl: async () => true,
    cdpIsCursorImpl: async () => true,
    async listCdpPageTargetsImpl() {
      calls += 1;
      if (calls === 1) return [{ id: 'other', title: 'other-app - Cursor', type: 'page' }];
      return [
        { id: 'other', title: 'other-app - Cursor', type: 'page' },
        { id: 'opened', title: `${project.split(/[\\/]/).pop()} - Cursor`, type: 'page' },
      ];
    },
    spawnImpl,
    findCursorExeDetailsImpl: () => ({
      path: 'C:\\Program Files\\Cursor\\Cursor.exe',
      source: 'test',
      platform: 'win32',
    }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.workspaceAction, 'opened-new-window');
  assert.equal(result.targetId, 'opened');
  assert.equal(spawned.length, 1);
  assert.deepEqual(spawned[0].args, ['--new-window', resolve(project)]);
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

test('cursor_init accepts only an absolute project directory or .code-workspace file', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'cb-workspace-validation-'));
  const project = join(directory, 'project');
  const workspace = join(directory, 'project.code-workspace');
  const ordinaryFile = join(directory, 'notes.txt');
  const stateFile = join(directory, 'state', 'workspaces.json');
  mkdirSync(project, { recursive: true });
  writeFileSync(workspace, '{}', 'utf8');
  writeFileSync(ordinaryFile, 'not a workspace', 'utf8');
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  assert.equal(isAbsoluteWorkspacePath(project), true);
  assert.equal(isAbsoluteWorkspacePath('relative/project'), false);
  assert.throws(() => writeWorkspaceBinding(stateFile, 'test', 'relative/project'), /absolute project path/);
  assert.throws(() => writeWorkspaceBinding(stateFile, 'test', ordinaryFile), /project directory or a \.code-workspace file/);
  assert.equal(writeWorkspaceBinding(stateFile, 'directory', project).projectPath, normalizeWorkspacePath(project));
  assert.equal(writeWorkspaceBinding(stateFile, 'workspace', workspace).projectPath, normalizeWorkspacePath(workspace));
  writeFileSync(stateFile, JSON.stringify({
    version: 1,
    bindings: { stale: { projectPath: ordinaryFile, updatedAt: '2026-08-10T00:00:00.000Z' } },
  }), 'utf8');
  assert.equal(readWorkspaceBinding(stateFile, 'stale'), null);
});

test('Cursor executable discovery normalizes easy Windows and macOS override formats', () => {
  const winExe = 'D:\\Portable Cursor\\Cursor.exe';
  assert.equal(normalizeCursorExeCandidate('"D:\\Portable Cursor"', {
    platform: 'win32',
    existsImpl: (candidate) => candidate === winExe,
  }), winExe);

  const macExe = '/Volumes/Apps/Cursor.app/Contents/MacOS/Cursor';
  assert.equal(normalizeCursorExeCandidate('/Volumes/Apps/Cursor.app', {
    platform: 'darwin',
    existsImpl: (candidate) => candidate === macExe,
  }), macExe);

  assert.deepEqual(findCursorExeDetails({
    platform: 'darwin',
    env: { CURSOR_EXE: '/Volumes/Apps/Cursor.app' },
    existsImpl: (candidate) => candidate === macExe,
  }), { path: macExe, source: 'CURSOR_EXE', platform: 'darwin' });
});

test('Windows Cursor discovery and process probes never invoke a command shell', () => {
  const calls = [];
  const winExe = 'D:\\Cursor Custom\\Cursor.exe';
  const details = findCursorExeDetails({
    platform: 'win32',
    env: {},
    existsImpl: (candidate) => candidate === winExe,
    execFileSyncImpl(command, args, options) {
      calls.push({ command, args, options });
      return `    (Default)    REG_SZ    ${winExe}\n`;
    },
  });
  assert.deepEqual(details, { path: winExe, source: 'windows_registry', platform: 'win32' });
  assert.equal(calls[0].command, 'reg.exe');
  assert.deepEqual(calls[0].args.slice(0, 2), [
    'query',
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Cursor.exe',
  ]);
  assert.equal(calls[0].options.windowsHide, true);
  assert.deepEqual(calls[0].options.stdio, ['ignore', 'pipe', 'ignore']);

  let tasklistCall;
  assert.equal(cursorRunning({
    platform: 'win32',
    execFileSyncImpl(command, args, options) {
      tasklistCall = { command, args, options };
      return 'Cursor.exe 123 Console 1 1,000 K';
    },
  }), true);
  assert.equal(tasklistCall.command, 'tasklist.exe');
  assert.deepEqual(tasklistCall.args, ['/fi', 'imagename eq Cursor.exe', '/nh']);
  assert.equal(tasklistCall.options.windowsHide, true);
  assert.deepEqual(tasklistCall.options.stdio, ['ignore', 'pipe', 'ignore']);
});

test('legacy registry probe injection remains isolated from the production execFile path', () => {
  const winExe = 'E:\\Legacy Stub\\Cursor.exe';
  let legacyCommand = '';
  const details = findCursorExeDetails({
    platform: 'win32',
    env: {},
    existsImpl: (candidate) => candidate === winExe,
    execSyncImpl(command) {
      legacyCommand = command;
      return `    (Default)    REG_SZ    ${winExe}\n`;
    },
  });
  assert.deepEqual(details, { path: winExe, source: 'windows_registry', platform: 'win32' });
  assert.match(legacyCommand, /^reg query /);
});

test('an already-running Cursor without CCE access fails safely with one simple retry step', async () => {
  const project = resolve('C:\\Projects\\demo');
  const result = await ensureCursorRunningLocal({
    projectPath: project,
    cdpUpImpl: async () => false,
    cursorRunningImpl: () => true,
    findCursorExeDetailsImpl: () => ({
      path: 'C:\\Program Files\\Cursor\\Cursor.exe',
      source: 'windows_standard_location',
      platform: 'win32',
    }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'running-no-debug');
  assert.equal(result.needsAction, 'close_cursor_and_retry');
  assert.equal(result.retryable, true);
  assert.match(result.message, /will not force-close/);
  assert.match(result.nextStep, /exit Cursor normally once/);
  assert.doesNotMatch(result.nextStep, /remote-debugging-port|9223/);
});

function makeDir() {
  return mkdtempSync(join(tmpdir(), 'cb-unit-'));
}

function killPid(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(pid), '/F', '/T'], { stdio: 'ignore', windowsHide: true });
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

test('outside-job errors preserve safe fallback classification and raw WMI codes', () => {
  const denied = classifyOutsideJobSpawnError(Object.assign(new Error('spawnSync powershell.exe EPERM'), { code: 'EPERM' }));
  assert.deepEqual(denied, {
    errorKind: 'policy-blocked',
    degradedReason: 'spawn-policy-blocked',
    errorCode: 'EPERM',
    returnValue: null,
    canAttachFallback: true,
  });
  for (const value of [2, 3]) {
    const classified = classifyOutsideJobSpawnError(new Error(`Win32_Process.Create failed: ${value}`));
    assert.equal(classified.errorKind, 'policy-blocked');
    assert.equal(classified.returnValue, value);
    assert.equal(classified.canAttachFallback, true);
  }
  const unknown8 = classifyOutsideJobSpawnError(new Error('Win32_Process.Create failed: 8'));
  assert.equal(unknown8.errorKind, 'wmi-unknown');
  assert.equal(unknown8.degradedReason, 'wmi-unknown-8');
  assert.equal(unknown8.errorCode, 8);
  assert.equal(unknown8.canAttachFallback, true);
  for (const value of [9, 21]) {
    const classified = classifyOutsideJobSpawnError(new Error(`Win32_Process.Create failed: ${value}`));
    assert.equal(classified.errorKind, 'configuration');
    assert.equal(classified.errorCode, value);
    assert.equal(classified.canAttachFallback, false);
  }
  const timedOut = classifyOutsideJobSpawnError(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }));
  assert.equal(timedOut.degradedReason, 'spawn-timeout');
  assert.equal(timedOut.canAttachFallback, true);
});

test('legacy unsafe shell fallback switch can no longer be enabled', () => {
  assert.equal(allowUnsafeCmdStart({ CURSOR_BRIDGE_UNSAFE_CMD_START: '1' }), false);
  assert.equal(allowUnsafeCmdStart({ CURSOR_BRIDGE_ALLOW_UNSAFE_JOB_BREAKAWAY: '1' }), false);
});

test('WMI failure is fail-closed even when a legacy unsafe fallback env is present', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('Windows-only spawn policy');
    return;
  }
  const result = spawnOutsideJob(process.execPath, ['-e', 'process.exit(0)'], {
    env: {
      ...process.env,
      CURSOR_BRIDGE_TEST_FORCE_WMI_FAIL: '1',
      CURSOR_BRIDGE_UNSAFE_CMD_START: '1',
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.method, 'failed');
  assert.match(String(result.error), /WMI/);
  assert.match(String(result.error), /without a shell fallback/);
  assert.doesNotMatch(String(result.error), /set CURSOR_BRIDGE_UNSAFE_CMD_START/);
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
      CURSOR_BRIDGE_SUPERVISOR_SCRIPT: join(REPO, 'dist', 'cursor-lifecycle-supervisor.mjs'),
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
      CURSOR_BRIDGE_SUPERVISOR_SCRIPT: join(REPO, 'dist', 'cursor-lifecycle-supervisor.mjs'),
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
