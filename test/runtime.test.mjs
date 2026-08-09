import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  CURSOR_RUNTIME_MODES,
  findCursorPidByPort,
  normalizeCursorRuntimeMode,
  parseNetstatListeningPid,
  readPersistedCursorRuntimeMode,
  setCursorWindowPresentation,
  startMinimalWindowGuard,
  writePersistedCursorRuntimeMode,
} from '../cursor-runtime.mjs';

test('runtime modes are intentionally limited to normal and minimal', () => {
  assert.deepEqual(CURSOR_RUNTIME_MODES, ['normal', 'minimal']);
  assert.equal(normalizeCursorRuntimeMode(' MINIMAL '), 'minimal');
  assert.equal(normalizeCursorRuntimeMode('headless'), 'normal');
  assert.equal(normalizeCursorRuntimeMode('headless', ''), '');
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
  assert.match(script, /Apply\(12345, \$false\)/);
});

test('minimal window guard is detached and bounded', () => {
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
