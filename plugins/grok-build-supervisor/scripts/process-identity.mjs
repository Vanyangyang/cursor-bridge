import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

export function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function inspectProcessIdentity(pid) {
  if (!processIsAlive(pid) || process.platform !== "win32") {
    return null;
  }
  const command = [
    `$process = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'`,
    "if ($null -eq $process) { exit 1 }",
    "$created = if ($process.CreationDate) { $process.CreationDate.ToUniversalTime().ToString('o') } else { $null }",
    "[pscustomobject]@{ Name = $process.Name; ExecutablePath = $process.ExecutablePath; CommandLine = $process.CommandLine; CreatedAt = $created } | ConvertTo-Json -Compress",
  ].join("; ");
  try {
    const output = execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 3000,
      maxBuffer: 64 * 1024,
    });
    const raw = JSON.parse(output);
    const identity = {
      name: typeof raw.Name === "string" ? raw.Name : null,
      executablePath: typeof raw.ExecutablePath === "string" ? raw.ExecutablePath : null,
      createdAt: typeof raw.CreatedAt === "string" ? raw.CreatedAt : null,
      commandLineHash: createHash("sha256").update(String(raw.CommandLine || "")).digest("hex"),
    };
    return {
      ...identity,
      fingerprint: createHash("sha256").update(JSON.stringify(identity)).digest("hex"),
    };
  } catch {
    return null;
  }
}
