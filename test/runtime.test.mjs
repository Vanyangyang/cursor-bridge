import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  CURSOR_RUNTIME_MODES,
  cursorStartupBehavior,
  findCursorPidByPort,
  normalizeCursorRuntimeMode,
  parseNetstatListeningPid,
  readPersistedCursorRuntimeMode,
  setCursorWindowPresentation,
  shouldAutoLaunchCursor,
  startMinimalWindowGuard,
  writePersistedCursorRuntimeMode,
} from '../cursor-runtime.mjs';

test('runtime modes are intentionally limited to normal and minimal', () => {
  assert.deepEqual(CURSOR_RUNTIME_MODES, ['normal', 'minimal']);
  assert.equal(normalizeCursorRuntimeMode(' MINIMAL '), 'minimal');
  assert.equal(normalizeCursorRuntimeMode('headless'), 'normal');
  assert.equal(normalizeCursorRuntimeMode('headless', ''), '');
});

test('minimal runtime prewarms unless autolaunch is explicitly disabled', () => {
  assert.equal(shouldAutoLaunchCursor(undefined), true);
  assert.equal(shouldAutoLaunchCursor('0'), true);
  assert.equal(shouldAutoLaunchCursor('1'), false);
  assert.equal(cursorStartupBehavior('minimal'), 'hidden_prewarm_on_adapter_start');
  assert.equal(cursorStartupBehavior('normal'), 'normal_autolaunch');
  assert.equal(cursorStartupBehavior('minimal', '1'), 'manual_launch_only');
});

test('runtime mode persistence is atomic and rejects unknown values', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cursor-bridge-runtime-'));
  const file = join(directory, 'nested', 'runtime.json');
  try {
    assert.equal(readPersistedCursorRuntimeMode(file), null);
    writePersistedCursorRuntimeMode(file, 'minimal');
    assert.equal(readPersistedCursorRuntimeMode(file), 'minimal');
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).mode, 'minimal');
    writeFileSync(file, JSON.stringify({ version: 1, mode: 'headless' }), 'utf8');
    assert.equal(readPersistedCursorRuntimeMode(file), null);
    assert.throws(() => writePersistedCursorRuntimeMode(file, 'headless'), /unsupported Cursor runtime mode/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('netstat parser selects only the listening PID on the exact CDP port', () => {
  const output = [
    '  TCP    127.0.0.1:9222       0.0.0.0:0      LISTENING       111',
    '  TCP    127.0.0.1:9223       0.0.0.0:0      LISTENING       29788',
    '  TCP    127.0.0.1:9223       127.0.0.1:50100 ESTABLISHED     333',
  ].join('\r\n');
  assert.equal(parseNetstatListeningPid(output, 9223), 29788);
  assert.equal(parseNetstatListeningPid(output, 9333), null);
  assert.equal(findCursorPidByPort(9223, {
    platform: 'win32',
    execFileSyncImpl: () => output,
  }), 29788);
  assert.equal(findCursorPidByPort(9223, { platform: 'linux' }), null);
});

test('window presentation reports unsupported platforms without executing native control', () => {
  const result = setCursorWindowPresentation({ platform: 'linux', action: 'hide', port: 9223 });
  assert.equal(result.supported, false);
  assert.equal(result.applied, false);
  assert.match(result.reason, /not implemented/);
});

test('window presentation passes an exact PID and action to PowerShell', () => {
  let invocation;
  const result = setCursorWindowPresentation({
    platform: 'win32',
    action: 'hide',
    port: 9223,
    pid: 12345,
    execFileSyncImpl(command, args, options) {
      invocation = { command, args, options };
      return '2';
    },
  });
  assert.equal(result.applied, true);
  assert.equal(result.changedWindows, 2);
  assert.equal(invocation.command, 'powershell.exe');
  assert.equal(invocation.args.at(-2), '-EncodedCommand');
  const script = Buffer.from(invocation.args.at(-1), 'base64').toString('utf16le');
  assert.match(script, /CursorBridgeWindowControl/);
  assert.match(script, /Chrome_WidgetWin_1/);
  assert.match(script, /RedrawWindow/);
  assert.doesNotMatch(script, /SetForegroundWindow/);
  assert.match(script, /ShowWindowAsync\(hWnd, 4\)/);
  assert.match(script, /Apply\(12345, \$false\)/);
});

test('window presentation show override pauses and resumes the PID guard', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'cursor-bridge-show-'));
  const showFlagPath = join(directory, 'show-12345.flag');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const execFileSyncImpl = () => '1';

  const shown = setCursorWindowPresentation({
    platform: 'win32',
    action: 'show',
    port: 9223,
    pid: 12345,
    showFlagPath,
    execFileSyncImpl,
  });
  assert.equal(shown.applied, true);
  assert.equal(readFileSync(showFlagPath, 'utf8').trim(), '12345');

  const hidden = setCursorWindowPresentation({
    platform: 'win32',
    action: 'hide',
    port: 9223,
    pid: 12345,
    showFlagPath,
    execFileSyncImpl,
  });
  assert.equal(hidden.applied, true);
  assert.throws(() => readFileSync(showFlagPath, 'utf8'), /ENOENT/);
});

test('minimal window guard is detached and bounded when a duration is provided', () => {
  let invocation;
  let unrefCalled = false;
  const result = startMinimalWindowGuard(54321, {
    platform: 'win32',
    durationMs: 1000,
    intervalMs: 100,
    spawnImpl(command, args, options) {
      invocation = { command, args, options };
      return { pid: 999, unref() { unrefCalled = true; } };
    },
  });
  assert.equal(result.started, true);
  assert.equal(result.lifetime, false);
  assert.equal(unrefCalled, true);
  assert.equal(invocation.command, 'powershell.exe');
  assert.equal(invocation.args.at(-2), '-EncodedCommand');
  const script = Buffer.from(invocation.args.at(-1), 'base64').toString('utf16le');
  assert.match(script, /Apply\(54321, \$false\)/);
  assert.match(script, /\$i -lt 10/);
  assert.match(script, /Milliseconds 100/);
  assert.equal(invocation.options.windowsHide, true);
  assert.equal(invocation.options.detached, true);
});

test('minimal window guard defaults to one PID lifetime and supports a show override', () => {
  let invocation;
  const result = startMinimalWindowGuard(54321, {
    platform: 'win32',
    intervalMs: 250,
    showFlagPath: 'C:\\temp\\cursor-bridge-show.flag',
    spawnImpl(command, args, options) {
      invocation = { command, args, options };
      return { pid: 1001, unref() {} };
    },
  });
  assert.equal(result.started, true);
  assert.equal(result.lifetime, true);
  assert.equal(result.retainedBySupervisor, true);
  assert.equal(result.durationMs, null);
  assert.equal(invocation.options.detached, false);
  const script = Buffer.from(invocation.args.at(-1), 'base64').toString('utf16le');
  assert.match(script, /CursorBridgeMinimalGuard-54321/);
  assert.match(script, /while \(\$true\)/);
  assert.match(script, /Get-Process -Id 54321/);
  assert.match(script, /ProcessName -ine 'Cursor'/);
  assert.match(script, /Test-Path -LiteralPath 'C:\\temp\\cursor-bridge-show.flag'/);
  assert.match(script, /Milliseconds 250/);
});
