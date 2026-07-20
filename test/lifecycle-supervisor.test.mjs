import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import {
  ensureCursorViaSupervisor,
  pingSupervisor,
} from '../cursor-lifecycle-client.mjs';
import { supervisorPidPath } from '../lifecycle-paths.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(ROOT);
const MOCK_ENSURE = join(REPO, 'test', 'fixtures', 'mock-ensure.mjs');

function makeLifecycleSandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'cb-life-'));
  const counter = join(dir, 'ensure-count.txt');
  writeFileSync(counter, '0\n', { encoding: 'utf8' });
  return { dir, counter };
}

function envFor(dir, counter) {
  return {
    ...process.env,
    CURSOR_BRIDGE_LIFECYCLE_DIR: dir,
    CURSOR_BRIDGE_ENSURE_MODULE: MOCK_ENSURE,
    CURSOR_BRIDGE_TEST_COUNTER: counter,
    CURSOR_BRIDGE_TEST_ENSURE_DELAY_MS: '150',
    CURSOR_BRIDGE_SUPERVISOR_IDLE_MS: '5000',
    CURSOR_BRIDGE_SUPERVISOR_SCRIPT: join(REPO, 'cursor-lifecycle-supervisor.mjs'),
  };
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

function readCount(counter) {
  return Number(String(readFileSync(counter, 'utf8')).trim() || '0');
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

async function stopSupervisor(dir) {
  const pidPath = supervisorPidPath(dir);
  if (!existsSync(pidPath)) return;
  const pid = Number(String(readFileSync(pidPath, 'utf8')).trim());
  killPid(pid);
  await new Promise((r) => setTimeout(r, 400));
}

test('concurrent adapters share one supervisor ensure flight', async () => {
  const { dir, counter } = makeLifecycleSandbox();
  const env = envFor(dir, counter);
  try {
    await withEnv(env, async () => {
      const ready = await pingSupervisor();
      assert.equal(ready.ok, true);
      assert.ok(ready.supervisorPid);

      const results = await Promise.all([
        ensureCursorViaSupervisor({ reason: 't1', waitMs: 1000 }),
        ensureCursorViaSupervisor({ reason: 't2', waitMs: 1000 }),
        ensureCursorViaSupervisor({ reason: 't3', waitMs: 1000 }),
      ]);
      for (const r of results) {
        assert.equal(r.ok, true, r.message || JSON.stringify(r));
        assert.equal(r.supervisorPid, ready.supervisorPid);
        assert.equal(r.adapterPid, process.pid);
        assert.equal(r.reusedSupervisor, true);
        assert.equal(r.createdSupervisor, false);
        assert.ok(r.launchReason);
      }
      assert.equal(readCount(counter), 1, 'ensureCursorRunningLocal must run once under concurrency');
    });
  } finally {
    await stopSupervisor(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('adapter disconnect does not stop supervisor for another client', async () => {
  const { dir, counter } = makeLifecycleSandbox();
  const env = envFor(dir, counter);
  try {
    await withEnv(env, async () => {
      const first = await ensureCursorViaSupervisor({ reason: 'first', waitMs: 1000 });
      assert.equal(first.ok, true);
      const supervisorPid = first.supervisorPid;

      const second = await ensureCursorViaSupervisor({ reason: 'second', waitMs: 1000 });
      assert.equal(second.ok, true);
      assert.equal(second.supervisorPid, supervisorPid);
      assert.equal(second.reusedSupervisor, true);
      assert.equal(second.createdSupervisor, false);

      const childScript = join(dir, 'child-adapter.mjs');
      const clientUrl = pathToFileURL(join(REPO, 'cursor-lifecycle-client.mjs')).href;
      writeFileSync(childScript, `
import { ensureCursorViaSupervisor } from '${clientUrl}';
const r = await ensureCursorViaSupervisor({ reason: 'child', waitMs: 1000 });
if (!r.ok) { console.error(JSON.stringify(r)); process.exit(2); }
console.log(JSON.stringify({ supervisorPid: r.supervisorPid, reusedSupervisor: r.reusedSupervisor }));
process.exit(0);
`, { encoding: 'utf8' });

      const childOut = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [childScript], {
          env,
          cwd: REPO,
          windowsHide: true,
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (c) => { stdout += c; });
        child.stderr.on('data', (c) => { stderr += c; });
        child.on('error', reject);
        child.on('exit', (code) => resolve({ code, stdout, stderr }));
      });
      assert.equal(childOut.code, 0, childOut.stderr || childOut.stdout);
      const childResult = JSON.parse(childOut.stdout.trim());
      assert.equal(childResult.supervisorPid, supervisorPid);
      assert.equal(childResult.reusedSupervisor, true);

      const afterChild = await ensureCursorViaSupervisor({ reason: 'after-child', waitMs: 1000 });
      assert.equal(afterChild.ok, true);
      assert.equal(afterChild.supervisorPid, supervisorPid);
      assert.equal(afterChild.reusedSupervisor, true);
      assert.ok(readCount(counter) >= 1);
    });
  } finally {
    await stopSupervisor(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('singleton reconnect after supervisor restart', async () => {
  const { dir, counter } = makeLifecycleSandbox();
  const env = envFor(dir, counter);
  try {
    await withEnv(env, async () => {
      const first = await pingSupervisor();
      assert.equal(first.ok, true);
      const oldPid = first.supervisorPid;
      assert.ok(oldPid);

      await stopSupervisor(dir);

      const second = await pingSupervisor();
      assert.equal(second.ok, true);
      assert.ok(second.supervisorPid);
      assert.notEqual(second.supervisorPid, oldPid);
      assert.equal(second.createdSupervisor, true);

      const third = await pingSupervisor();
      assert.equal(third.ok, true);
      assert.equal(third.supervisorPid, second.supervisorPid);
      assert.equal(third.reusedSupervisor, true);
    });
  } finally {
    await stopSupervisor(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('inline ensure path still works without supervisor', async () => {
  const previousInline = process.env.CURSOR_BRIDGE_INLINE_ENSURE;
  const previousPort = process.env.CURSOR_BRIDGE_CDP_PORT;
  const previousExe = process.env.CURSOR_EXE;
  const missingDir = mkdtempSync(join(tmpdir(), 'cb-missing-'));
  process.env.CURSOR_BRIDGE_INLINE_ENSURE = '1';
  process.env.CURSOR_BRIDGE_CDP_PORT = '1';
  process.env.CURSOR_EXE = join(missingDir, 'missing-cursor-binary');
  try {
    const { ensureCursorRunning } = await import('../launch-cursor.mjs');
    const result = await ensureCursorRunning({ waitMs: 200, reason: 'inline-test' });
    assert.equal(result.ok, false);
    assert.ok(['no-exe', 'running-no-debug', 'timeout', 'port-not-cursor'].includes(result.status), result.status);
    assert.equal(result.adapterPid, process.pid);
    assert.equal(result.supervisorPid, null);
    assert.match(String(result.launchReason || ''), /^inline-/);
  } finally {
    if (previousInline == null) delete process.env.CURSOR_BRIDGE_INLINE_ENSURE;
    else process.env.CURSOR_BRIDGE_INLINE_ENSURE = previousInline;
    if (previousPort == null) delete process.env.CURSOR_BRIDGE_CDP_PORT;
    else process.env.CURSOR_BRIDGE_CDP_PORT = previousPort;
    if (previousExe == null) delete process.env.CURSOR_EXE;
    else process.env.CURSOR_EXE = previousExe;
    rmSync(missingDir, { recursive: true, force: true });
  }
});
