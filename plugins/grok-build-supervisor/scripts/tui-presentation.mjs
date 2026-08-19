import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const WINDOWS_TERMINAL_PACKAGE = "Microsoft.WindowsTerminal_8wekyb3d8bbwe";
const WINDOWS_TERMINAL_PREVIEW_PACKAGE = "Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe";

function cleanTitlePart(value, fallback) {
  const text = String(value || fallback).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return (text || fallback).slice(0, 80);
}

export function buildTuiTitle({ cwd, sessionId, mode }) {
  const project = cleanTitlePart(resolve(cwd).split(/[\\/]/).filter(Boolean).at(-1), "Grok");
  const session = cleanTitlePart(sessionId?.slice(0, 8), mode === "new" ? "new" : "session");
  return `Grok Build · ${project} · ${session}`;
}

export function findExecutable(executable, { env = process.env, platform = process.platform } = {}) {
  if (platform !== "win32") {
    return null;
  }
  try {
    const output = execFileSync("where.exe", [executable], {
      encoding: "utf8",
      env,
      windowsHide: true,
    });
    const matches = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    return selectExistingExecutable(matches);
  } catch {
    return null;
  }
}

export function selectExistingExecutable(candidates, { exists = existsSync } = {}) {
  return candidates.find((candidate) => typeof candidate === "string" && candidate.length > 0 && exists(candidate)) || null;
}

export function findWindowsTerminalPackageExecutable(
  env = process.env,
  { execute = execFileSync, exists = existsSync } = {},
) {
  const powershell = join(
    env.SystemRoot || env.SYSTEMROOT || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const command = [
    "$packages = @()",
    "$packages += Get-AppxPackage -Name Microsoft.WindowsTerminal",
    "$packages += Get-AppxPackage -Name Microsoft.WindowsTerminalPreview",
    "$packages | ForEach-Object { $_.InstallLocation } | ConvertTo-Json -Compress",
  ].join("; ");
  try {
    const output = execute(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
      encoding: "utf8",
      env,
      windowsHide: true,
    });
    const parsed = JSON.parse(output || "null");
    const locations = (Array.isArray(parsed) ? parsed : [parsed])
      .filter((location) => typeof location === "string" && location.length > 0);
    const candidates = locations.flatMap((location) => [
      join(location, "wt.exe"),
      join(location, "WindowsTerminal.exe"),
    ]);
    return selectExistingExecutable(candidates, { exists });
  } catch {
    return null;
  }
}

export function windowsTerminalSettingsPaths(env = process.env) {
  const localAppData = env.LOCALAPPDATA;
  if (!localAppData) {
    return [];
  }
  return [WINDOWS_TERMINAL_PACKAGE, WINDOWS_TERMINAL_PREVIEW_PACKAGE]
    .map((packageName) => join(localAppData, "Packages", packageName, "LocalState", "settings.json"));
}

export function readWindowsTerminalSettings(env = process.env) {
  for (const settingsPath of windowsTerminalSettingsPaths(env)) {
    if (!existsSync(settingsPath)) {
      continue;
    }
    try {
      return { settingsPath, settings: JSON.parse(readFileSync(settingsPath, "utf8")) };
    } catch (error) {
      throw new Error(`Could not parse Windows Terminal settings at ${settingsPath}: ${error.message}`);
    }
  }
  return { settingsPath: null, settings: null };
}

export function selectPowerShellProfile(settings, { pwshPath = null, windowsPowerShellPath = null } = {}) {
  const profiles = (settings?.profiles?.list || []).filter((profile) => profile && profile.hidden !== true);
  const core = profiles.find((profile) =>
    profile.source === "Windows.Terminal.PowershellCore" || /^PowerShell$/i.test(profile.name || ""));
  if (pwshPath && core) {
    return {
      profile: core.guid || core.name,
      profileName: core.name,
      powerShellBinary: pwshPath,
      edition: "core",
    };
  }

  const desktop = profiles.find((profile) => /^Windows PowerShell$/i.test(profile.name || ""));
  if (windowsPowerShellPath && desktop) {
    return {
      profile: desktop.guid || desktop.name,
      profileName: desktop.name,
      powerShellBinary: windowsPowerShellPath,
      edition: "desktop",
    };
  }
  return null;
}

export function resolveWindowsTerminalPresentation(env = process.env) {
  const explicitWtBinary = typeof env.WT_BIN === "string" && existsSync(env.WT_BIN) ? env.WT_BIN : null;
  const wtBinary = explicitWtBinary
    || findExecutable("wt.exe", { env })
    || findWindowsTerminalPackageExecutable(env);
  if (!wtBinary) {
    throw new Error("Windows Terminal was not found (wt.exe)");
  }
  const pwshPath = env.PWSH_BIN || findExecutable("pwsh.exe", { env });
  const windowsPowerShellPath = env.POWERSHELL_BIN
    || join(env.SystemRoot || env.SYSTEMROOT || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const { settingsPath, settings } = readWindowsTerminalSettings(env);
  const selected = selectPowerShellProfile(settings, {
    pwshPath,
    windowsPowerShellPath: existsSync(windowsPowerShellPath) ? windowsPowerShellPath : null,
  });
  if (!selected) {
    throw new Error(`No visible PowerShell profile was found in Windows Terminal settings${settingsPath ? ` (${settingsPath})` : ""}`);
  }
  return { wtBinary, settingsPath, ...selected };
}

export function buildWindowsTerminalArgs({
  profile,
  title,
  cwd,
  powerShellBinary,
  launcherScript,
  nodeBinary,
  hostScript,
  statePath,
  grokBinary,
  leaderSocket,
  leaderOwnerToken,
  mode,
  sessionId,
  launchId,
  windowName = "new",
}) {
  if (!profile || !isAbsolute(cwd) || !isAbsolute(powerShellBinary) || !isAbsolute(launcherScript)
    || !isAbsolute(nodeBinary) || !isAbsolute(hostScript) || !isAbsolute(statePath)
    || !isAbsolute(grokBinary) || !isAbsolute(leaderSocket)) {
    throw new Error("Windows Terminal launch paths must be absolute and a PowerShell profile is required");
  }
  if (!new Set(["new", "resume"]).has(mode) || !launchId || !leaderOwnerToken) {
    throw new Error("TUI mode must be new or resume");
  }
  const args = [
    "-w", windowName,
    "new-tab",
    "-p", profile,
    "--title", cleanTitlePart(title, "Grok Build"),
    "-d", cwd,
    powerShellBinary,
    "-NoLogo",
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", launcherScript,
    "-NodeBinary", nodeBinary,
    "-HostScript", hostScript,
    "-StatePath", statePath,
    "-GrokBinary", grokBinary,
    "-LeaderSocket", leaderSocket,
    "-LeaderOwnerToken", leaderOwnerToken,
    "-WorkingDirectory", cwd,
    "-Mode", mode,
    "-SessionId", sessionId,
    "-LaunchId", launchId,
  ];
  return args;
}

export function assertPathWithin(root, target, label = "path") {
  const fullRoot = resolve(root);
  const fullTarget = resolve(target);
  const rel = relative(fullRoot, fullTarget);
  if (rel === "" || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) {
    throw new Error(`${label} must be a file below ${fullRoot}: ${fullTarget}`);
  }
  return fullTarget;
}

export function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, "utf8");
  try {
    renameSync(temporary, path);
  } catch (error) {
    if (existsSync(path)) {
      unlinkSync(path);
      renameSync(temporary, path);
      return;
    }
    throw error;
  }
}

export function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function listTuiStateRecords(root) {
  if (!existsSync(root)) {
    return [];
  }
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => ({ path: join(root, entry.name), value: readJsonFile(join(root, entry.name)) }))
    .filter((entry) => entry.value && entry.value.schemaVersion === 1);
}
