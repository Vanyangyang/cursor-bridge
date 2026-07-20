/**
 * Windows job-breakaway process spawn without installing a service or scheduled task.
 *
 * Codex/stdio hosts often place MCP adapters inside a Job Object with kill-on-close.
 * Node's spawn({detached:true}) only sets DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP;
 * it does NOT set CREATE_BREAKAWAY_FROM_JOB, so Cursor spawned by an adapter dies when
 * that adapter's job is reaped.
 *
 * Microsoft documents that processes created via Win32_Process.Create are NOT associated
 * with the caller's job. That is the only reliable default Windows path. A cmd.exe `start`
 * trampoline is NOT treated as reliable job breakaway; it is available only when an
 * explicit unsafe/debug env var is set, and the return value is marked degraded/unsafe.
 *
 * Because WMI Create does not inherit the parent environment, callers must pass durable
 * config through argv / boot-env files (see cursor-lifecycle-client.mjs).
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

/**
 * Quote one Windows command-line argument for CreateProcess / CommandLineToArgvW rules.
 * Handles spaces, embedded quotes, and trailing backslashes (not a simple replace('"')).
 */
export function quoteCmdArg(value) {
  const s = String(value);
  if (s.length === 0) return '""';
  if (!/[\s"]/u.test(s)) return s;

  let out = '"';
  let numBackslashes = 0;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === '\\') {
      numBackslashes += 1;
      continue;
    }
    if (ch === '"') {
      out += '\\'.repeat(numBackslashes * 2 + 1);
      out += '"';
      numBackslashes = 0;
      continue;
    }
    out += '\\'.repeat(numBackslashes);
    out += ch;
    numBackslashes = 0;
  }
  out += '\\'.repeat(numBackslashes * 2);
  out += '"';
  return out;
}

export function buildCommandLine(file, args = []) {
  return [file, ...args].map(quoteCmdArg).join(' ');
}

function quotePowerShellSingle(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

// WMI rejects CREATE_NO_WINDOW with return code 21 on current Windows builds.
// DETACHED_PROCESS plus SW_HIDE keeps the console process headless while WMI
// still provides the required Job Object breakaway.
export function buildHiddenWmiCreateScript(commandLine, cwd) {
  return `
$ErrorActionPreference = 'Stop'
$cmd = ${quotePowerShellSingle(commandLine)}
$cwd = ${quotePowerShellSingle(cwd)}
$startup = New-CimInstance -ClassName Win32_ProcessStartup -Namespace 'root/cimv2' -ClientOnly -Property @{ CreateFlags = [uint32]0x00000008; ShowWindow = [uint16]0 }
$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd; CurrentDirectory = $cwd; ProcessStartupInformation = $startup }
if ($null -eq $r -or $r.ReturnValue -ne 0) { throw "Win32_Process.Create failed: $($r.ReturnValue)" }
Write-Output $r.ProcessId
`.trim();
}

function whichNode() {
  if (process.env.CURSOR_BRIDGE_NODE_EXE && existsSync(process.env.CURSOR_BRIDGE_NODE_EXE)) {
    return process.env.CURSOR_BRIDGE_NODE_EXE;
  }
  return process.execPath;
}

export function allowUnsafeCmdStart(env = process.env) {
  return env.CURSOR_BRIDGE_UNSAFE_CMD_START === '1'
    || env.CURSOR_BRIDGE_ALLOW_UNSAFE_JOB_BREAKAWAY === '1';
}

/**
 * Spawn a process that should outlive the current Windows job.
 * @returns {{ ok: boolean, method: string, pid?: number, error?: string, commandLine?: string, warning?: string, degraded?: boolean, unsafe?: boolean }}
 */
export function spawnOutsideJob(file, args = [], options = {}) {
  const cwd = options.cwd || process.cwd();
  const env = options.env || process.env;
  const commandLine = buildCommandLine(file, args);

  if (process.platform !== 'win32') {
    const child = spawn(file, args, {
      cwd,
      env,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    return { ok: true, method: 'detached-spawn', pid: child.pid, commandLine };
  }

  // 1) WMI Win32_Process.Create — documented job breakaway (child not associated with caller's job).
  try {
    if (env.CURSOR_BRIDGE_TEST_FORCE_WMI_FAIL === '1') {
      throw new Error('forced WMI failure for tests');
    }
    const ps = buildHiddenWmiCreateScript(commandLine, cwd);
    const out = execFileSync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-Command', ps,
    ], {
      encoding: 'utf8',
      windowsHide: true,
      env,
      timeout: 15000,
    }).trim();
    const pid = Number(String(out).trim().split(/\r?\n/).pop());
    if (!Number.isFinite(pid) || pid <= 0) {
      throw new Error(`unexpected WMI pid output: ${out}`);
    }
    return { ok: true, method: 'wmi-win32-process-create', pid, commandLine };
  } catch (wmiError) {
    const wmiMsg = wmiError instanceof Error ? wmiError.message : String(wmiError);
    if (!allowUnsafeCmdStart(env)) {
      return {
        ok: false,
        method: 'failed',
        commandLine,
        error: `WMI Win32_Process.Create failed: ${wmiMsg}. cmd.exe start fallback is disabled by default; set CURSOR_BRIDGE_UNSAFE_CMD_START=1 only for degraded/unsafe debug use.`,
      };
    }

    // Explicit unsafe/debug fallback — not reliable job breakaway; must be marked.
    try {
      const boot = spawn('cmd.exe', ['/c', 'start', '', '/b', file, ...args], {
        cwd,
        env,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      boot.unref();
      return {
        ok: true,
        method: 'cmd-start-trampoline',
        pid: boot.pid,
        commandLine,
        degraded: true,
        unsafe: true,
        warning: `unsafe cmd-start fallback after WMI failure: ${wmiMsg}`,
      };
    } catch (startError) {
      return {
        ok: false,
        method: 'failed',
        commandLine,
        degraded: true,
        unsafe: true,
        error: `WMI failed (${wmiMsg}); unsafe cmd-start also failed: ${startError instanceof Error ? startError.message : startError}`,
      };
    }
  }
}

export function spawnNodeOutsideJob(scriptPath, scriptArgs = [], options = {}) {
  const node = whichNode();
  const env = { ...(options.env || process.env) };
  if (!env.PATH && process.env.Path) env.PATH = process.env.Path;
  return spawnOutsideJob(node, [scriptPath, ...scriptArgs], { ...options, env });
}

export { whichNode };
