/**
 * Windows job-breakaway process spawn without installing a service or scheduled task.
 *
 * Codex/stdio hosts often place MCP adapters inside a Job Object with kill-on-close.
 * Node's spawn({detached:true}) only sets DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP;
 * it does NOT set CREATE_BREAKAWAY_FROM_JOB, so Cursor spawned by an adapter dies when
 * that adapter's job is reaped.
 *
 * Microsoft documents that processes created via Win32_Process.Create are NOT associated
 * with the caller's job. That is the only supported Windows path. If it fails we stop:
 * shell trampolines can flash a console, steal focus, and do not provide reliable breakaway.
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

// Backward-compatible source export. The unsafe shell trampoline was removed;
// no environment variable can re-enable it.
export function allowUnsafeCmdStart() {
  return false;
}

function wmiReturnValueFromError(error) {
  const message = error instanceof Error ? error.message : String(error || '');
  const match = message.match(/Win32_Process\.Create failed:\s*(\d+)/i);
  return match ? Number(match[1]) : null;
}

export function classifyOutsideJobSpawnError(error) {
  const code = error && typeof error === 'object' && error.code != null
    ? String(error.code)
    : null;
  const returnValue = wmiReturnValueFromError(error);
  if (code === 'EPERM' || code === 'EACCES') {
    return {
      errorKind: 'policy-blocked',
      degradedReason: 'spawn-policy-blocked',
      errorCode: code,
      returnValue,
      canAttachFallback: true,
    };
  }
  if (returnValue === 2 || returnValue === 3) {
    return {
      errorKind: 'policy-blocked',
      degradedReason: 'wmi-access-denied',
      errorCode: returnValue,
      returnValue,
      canAttachFallback: true,
    };
  }
  if (returnValue === 8) {
    return {
      errorKind: 'wmi-unknown',
      degradedReason: 'wmi-unknown-8',
      errorCode: returnValue,
      returnValue,
      canAttachFallback: true,
    };
  }
  if (returnValue === 9 || returnValue === 21) {
    return {
      errorKind: 'configuration',
      degradedReason: null,
      errorCode: returnValue,
      returnValue,
      canAttachFallback: false,
    };
  }
  if (code === 'ETIMEDOUT' || (error && typeof error === 'object' && error.killed === true)) {
    return {
      errorKind: 'timeout',
      degradedReason: 'spawn-timeout',
      errorCode: code || 'ETIMEDOUT',
      returnValue,
      canAttachFallback: true,
    };
  }
  return {
    errorKind: 'unknown',
    degradedReason: null,
    errorCode: code,
    returnValue,
    canAttachFallback: false,
  };
}

/**
 * Spawn a process that should outlive the current Windows job.
 * @returns {{ ok: boolean, method: string, pid?: number, error?: string, commandLine?: string }}
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
    const run = options.execFileSyncImpl || execFileSync;
    const out = run('powershell.exe', [
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
    const classification = classifyOutsideJobSpawnError(wmiError);
    const stderr = wmiError && typeof wmiError === 'object' && wmiError.stderr != null
      ? String(wmiError.stderr).trim() || null
      : null;
    return {
      ok: false,
      method: 'failed',
      commandLine,
      ...classification,
      stderr,
      error: `WMI Win32_Process.Create failed: ${wmiMsg}. Launch stopped without a shell fallback so Cursor Bridge cannot flash a console or create an unreliable orphan.`,
    };
  }
}

export function spawnNodeOutsideJob(scriptPath, scriptArgs = [], options = {}) {
  const node = whichNode();
  const env = { ...(options.env || process.env) };
  if (!env.PATH && process.env.Path) env.PATH = process.env.Path;
  return spawnOutsideJob(node, [scriptPath, ...scriptArgs], { ...options, env });
}

export { whichNode };
