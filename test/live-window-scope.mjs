// Controlled presentation check: no Agent submission or new window creation.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { findCursorPidByPort, setCursorWindowPresentation } from '../cursor-runtime.mjs';

const pid = findCursorPidByPort(9223);
assert.ok(pid, 'Cursor CDP must already be running');
const source = `using System; using System.Text; using System.Runtime.InteropServices; using System.Collections.Generic;
public static class InspectCursorWindows {
  public delegate bool Callback(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] static extern bool EnumWindows(Callback cb, IntPtr p);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out Rect rect);
  public class Window { public long Handle; public string Title; public bool Visible, Minimized, Maximized; public Rect Bounds; }
  public static long Foreground() { return GetForegroundWindow().ToInt64(); }
  public static Window[] Read(int expected) {
    var list=new List<Window>(); EnumWindows((h,p)=>{
      uint pid; GetWindowThreadProcessId(h,out pid); if(pid!=expected) return true;
      var type=new StringBuilder(256); GetClassNameW(h,type,256); if(type.ToString()!="Chrome_WidgetWin_1")return true;
      var title=new StringBuilder(1024); GetWindowTextW(h,title,1024); if(title.Length==0)return true;
      Rect rect; GetWindowRect(h,out rect); list.Add(new Window { Handle=h.ToInt64(),Title=title.ToString(),Visible=IsWindowVisible(h),Minimized=IsIconic(h),Maximized=IsZoomed(h),Bounds=rect }); return true;
    },IntPtr.Zero); return list.ToArray();
  }
}`;
function snapshot() {
  const script = `$ProgressPreference='SilentlyContinue'; Add-Type -TypeDefinition @'\n${source}\n'@\n
    @{ foreground=[InspectCursorWindows]::Foreground(); windows=@([InspectCursorWindows]::Read(${pid})) } | ConvertTo-Json -Depth 5 -Compress`;
  return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, encoding: 'utf8', timeout: 15000 }));
}
const before = snapshot();
assert.equal(before.windows.filter(w => w.Title === 'Cursor Agents').length, 1, 'requires one exact existing Agents window');
const result = setCursorWindowPresentation({ action: 'show', scope: 'agents', port: 9223 });
assert.equal(result.pid, pid);
assert.equal(result.changedWindows, 1);
const after = snapshot();
assert.equal(after.foreground, before.foreground, 'foreground changed during check');
assert.deepEqual(after.windows.map(w => w.Handle).sort(), before.windows.map(w => w.Handle).sort(), 'window set changed');
for (const original of before.windows.filter(w => w.Title !== 'Cursor Agents')) {
  assert.deepEqual(after.windows.find(w => w.Handle === original.Handle), original, 'non-Agents window changed');
}
console.log(JSON.stringify({ passed: true, pid, changedWindows: result.changedWindows,
  foregroundPreserved: true, protectedWindows: before.windows.filter(w => w.Title !== 'Cursor Agents').map(w => w.Title) }));
