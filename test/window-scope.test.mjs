import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setCursorWindowPresentation } from '../cursor-runtime.mjs';

function capturedScript(showFlagPath, output = '1') {
  let script;
  const result = setCursorWindowPresentation({ platform: 'win32', pid: 12345,
    action: 'show', scope: 'agents', showFlagPath,
    execFileSyncImpl(_command, args) {
      script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
      return output;
    } });
  return { result, script };
}

test('Agents recovery keeps the process guard unchanged and fails closed without a match', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cursor-window-scope-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const flag = join(dir, 'show.flag');
  const { result, script } = capturedScript(flag);
  assert.equal(existsSync(flag), false);
  assert.equal(result.scope, 'agents');
  assert.equal(result.changedWindows, 1);
  assert.match(script, /Apply\(12345, \$true, \$true\)/);
  writeFileSync(flag, 'existing override');
  assert.equal(capturedScript(flag, '0').result.applied, false);
  assert.equal(readFileSync(flag, 'utf8'), 'existing override');
  const failed = setCursorWindowPresentation({ platform: 'win32', pid: 12345,
    action: 'show', scope: 'agents', showFlagPath: flag,
    execFileSyncImpl() { throw new Error('simulation'); } });
  assert.equal(failed.applied, false);
  assert.equal(readFileSync(flag, 'utf8'), 'existing override');
  assert.throws(() => setCursorWindowPresentation({ action: 'show', scope: 'typo' }), /scope/);
});

test('actual C# selection only changes one exact Agents window; missing and ambiguous matches do nothing',
  { skip: process.platform !== 'win32' }, () => {
    // Run the production selection algorithm against fake native calls, never user32.
    let source = capturedScript(join(tmpdir(), 'unused-agents-flag')).script
      .split("Add-Type -TypeDefinition @'\n")[1].split("\n'@")[0];
    const native = {
      EnumWindows: 'private static bool EnumWindows(EnumWindowsProc callback, IntPtr value) { for (int i=0;i<Titles.Length;i++) callback(new IntPtr(i+1),value); return true; }',
      GetWindowThreadProcessId: 'private static uint GetWindowThreadProcessId(IntPtr h, out uint pid) { pid=Pids[h.ToInt32()-1]; return 0; }',
      GetWindowTextLengthW: 'private static int GetWindowTextLengthW(IntPtr h) { return Titles[h.ToInt32()-1].Length; }',
      GetWindowTextW: 'private static int GetWindowTextW(IntPtr h, StringBuilder text, int max) { text.Append(Titles[h.ToInt32()-1]); return text.Length; }',
      GetClassNameW: 'private static int GetClassNameW(IntPtr h, StringBuilder text, int max) { text.Append(Classes[h.ToInt32()-1]); return text.Length; }',
      IsWindowVisible: 'private static bool IsWindowVisible(IntPtr h) { return false; }',
      IsIconic: 'private static bool IsIconic(IntPtr h) { return true; }',
      IsZoomed: 'private static bool IsZoomed(IntPtr h) { return false; }',
      IsWindowArranged: 'private static bool IsWindowArranged(IntPtr h) { return false; }',
      GetWindowRect: 'private static bool GetWindowRect(IntPtr h, out RECT rect) { rect=new RECT(); return false; }',
      ShowWindowAsync: 'private static bool ShowWindowAsync(IntPtr h, int command) { throw new Exception("unexpected hide"); }',
      SetWindowPos: 'private static bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int height, uint flags) { Changed.Add(h.ToInt32()); return true; }',
      RedrawWindow: 'private static bool RedrawWindow(IntPtr h, IntPtr rect, IntPtr region, uint flags) { return true; }',
    };
    source = source.replace(/^\s*\[DllImport[^\n]+$/gm, line => {
      const name = line.match(/extern\s+\w+\s+(\w+)\(/)?.[1];
      assert.ok(native[name], `missing native stub: ${line}`);
      return native[name];
    });
    assert.doesNotMatch(source, /DllImport|extern/);
    source = source.replace('public static class CursorBridgeWindowControl {', `public static class CursorBridgeWindowControl {
      public static string[] Titles = { "Cursor", "Cursor Agents", "Cursor Agents", "Cursor Agents" };
      public static uint[] Pids = { 12345, 12345, 54321, 12345 };
      public static string[] Classes = { "Chrome_WidgetWin_1", "Chrome_WidgetWin_1", "Chrome_WidgetWin_1", "other" };
      public static List<int> Changed = new List<int>();
    `);
    const script = `$ErrorActionPreference='Stop'\nAdd-Type -TypeDefinition @'\n${source}\n'@\n
      $type=[CursorBridgeWindowControl]
      if ($type::Apply(12345,$true,$true) -ne 1 -or $type::Changed[0] -ne 2) { throw 'wrong target' }
      $type::Changed.Clear(); $type::Titles[1]='Cursor'
      if ($type::Apply(12345,$true,$true) -ne 0 -or $type::Changed.Count -ne 0) { throw 'missing target modified windows' }
      $type::Titles[0]='Cursor Agents'; $type::Titles[1]='Cursor Agents'
      if ($type::Apply(12345,$true,$true) -ne 0 -or $type::Changed.Count -ne 0) { throw 'ambiguous target modified windows' }
      [Console]::Out.Write('PASS')`;
    const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    assert.equal(output.trim(), 'PASS');
  });
