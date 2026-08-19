import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  assertPathWithin,
  buildTuiTitle,
  buildWindowsTerminalArgs,
  findWindowsTerminalPackageExecutable,
  selectExistingExecutable,
  selectPowerShellProfile,
} from "./tui-presentation.mjs";

const ROOT = process.cwd();
const SESSION_ID = "01a010fc-7377-7330-b20f-9089aa5d93b6";
const OWNER_TOKEN = "01900000-0000-7000-8000-000000000001";

test("executable selection ignores non-materialized Windows app aliases", () => {
  const alias = "C:\\Users\\Tester\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe";
  const installed = "C:\\Program Files\\WindowsApps\\Microsoft.WindowsTerminal_1.0.0.0_x64__8wekyb3d8bbwe\\wt.exe";
  const existing = new Set([installed]);

  assert.equal(selectExistingExecutable([alias, installed], { exists: (candidate) => existing.has(candidate) }), installed);
});

test("Windows Terminal package fallback resolves the installed executable", () => {
  const installLocation = "C:\\Program Files\\WindowsApps\\Microsoft.WindowsTerminal_1.0.0.0_x64__8wekyb3d8bbwe";
  const executable = join(installLocation, "wt.exe");
  const execute = () => JSON.stringify(installLocation);

  assert.equal(findWindowsTerminalPackageExecutable({}, {
    execute,
    exists: (candidate) => candidate === executable,
  }), executable);
});

test("selectPowerShellProfile prefers PowerShell 7 and falls back to Windows PowerShell", () => {
  const settings = {
    profiles: {
      list: [
        { name: "Windows PowerShell", guid: "desktop" },
        { name: "PowerShell", guid: "core", source: "Windows.Terminal.PowershellCore" },
      ],
    },
  };
  assert.deepEqual(selectPowerShellProfile(settings, {
    pwshPath: "C:\\Tools\\pwsh.exe",
    windowsPowerShellPath: "C:\\Windows\\powershell.exe",
  }), {
    profile: "core",
    profileName: "PowerShell",
    powerShellBinary: "C:\\Tools\\pwsh.exe",
    edition: "core",
  });
  assert.equal(selectPowerShellProfile(settings, {
    windowsPowerShellPath: "C:\\Windows\\powershell.exe",
  }).profile, "desktop");
});

test("buildWindowsTerminalArgs keeps all user-derived values as separate arguments", () => {
  const args = buildWindowsTerminalArgs({
    profile: "core",
    title: "Grok Build · project; still-data",
    cwd: ROOT,
    powerShellBinary: join(ROOT, "pwsh.exe"),
    launcherScript: join(ROOT, "Start-GrokTui.ps1"),
    nodeBinary: process.execPath,
    hostScript: join(ROOT, "tui-host.mjs"),
    statePath: join(ROOT, "state.json"),
    grokBinary: join(ROOT, "grok.exe"),
    leaderSocket: join(ROOT, "leader.sock"),
    leaderOwnerToken: OWNER_TOKEN,
    mode: "resume",
    sessionId: SESSION_ID,
    launchId: "launch-1",
  });
  assert.equal(args[0], "-w");
  assert.equal(args[1], "new");
  assert.ok(args.includes("new-tab"));
  assert.ok(args.includes("-File"));
  assert.ok(args.includes("-LeaderOwnerToken"));
  assert.ok(args.some((item) => item.includes("project; still-data")));
  assert.equal(args.at(-1), "launch-1");
  assert.equal(args.some((item) => /cmd\s*\/c|powershell\s+-Command/i.test(item)), false);
});

test("buildTuiTitle is bounded and assertPathWithin rejects escape", () => {
  assert.match(buildTuiTitle({ cwd: ROOT, sessionId: SESSION_ID, mode: "resume" }), /01a010fc/);
  assert.equal(buildTuiTitle({ cwd: ROOT, sessionId: SESSION_ID, mode: "resume" }).length < 120, true);
  assert.throws(() => assertPathWithin(ROOT, join(ROOT, "..", "outside.json")), /must be a file below/);
});
