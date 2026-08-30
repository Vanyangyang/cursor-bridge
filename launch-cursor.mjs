#!/usr/bin/env node
/**
 * launch-cursor.mjs — public ensureCursorRunning entry used by the MCP adapter.
 *
 * By default, every stdio adapter talks to a user-level singleton lifecycle
 * supervisor so Cursor is not parented by a Codex Job Object session process.
 * Set CURSOR_BRIDGE_INLINE_ENSURE=1 to force the legacy in-process ensure path
 * (tests / emergency fallback).
 *
 * Usage: node launch-cursor.mjs   （或被 server 自愈钩子 import { ensureCursorRunning }）
 */
import { pathToFileURL } from 'url';
import { ensureCursorRunningLocal, resolveProjectPath, CDP_PORT } from './cursor-ensure-core.mjs';
import { ensureCursorViaSupervisor } from './cursor-lifecycle-client.mjs';
import {
  readWorkspaceBinding,
  resolveClaudeProjectPath,
  resolveWorkspaceBindingFile,
  resolveWorkspaceBindingKey,
} from './workspace-binding.mjs';

function lifecycleCapabilities(mode) {
  if (mode === 'supervised') {
    return { canLaunchCursor: true, canOpenWorkspaceWindow: true, survivesHostExit: 'cursor-yes-tasks-no' };
  }
  if (mode === 'attached') {
    return { canLaunchCursor: false, canOpenWorkspaceWindow: false, survivesHostExit: 'cursor-yes-tasks-no' };
  }
  return { canLaunchCursor: true, canOpenWorkspaceWindow: true, survivesHostExit: 'not-guaranteed' };
}

function withLifecycle(result, mode, extra = {}) {
  return {
    ...result,
    lifecycleMode: mode,
    persistent: mode === 'supervised',
    degradedReason: extra.degradedReason || null,
    spawnErrorCode: extra.spawnErrorCode ?? null,
    capabilities: lifecycleCapabilities(mode),
    ...extra,
  };
}

export {
  CDP_PORT,
  CDP_ORIGIN,
  CDP_HOST,
  looksLikePluginRuntimePath,
  resolveProjectPath,
  findCursorExe,
  cdpUp,
  cdpIsCursor,
  cursorRunning,
  waitForCdp,
  ensureCursorRunningLocal,
} from './cursor-ensure-core.mjs';

/**
 * Ensure Cursor is running with CDP. Prefer the singleton supervisor.
 * Returns the historical status fields plus lifecycle diagnostics:
 * adapterPid, supervisorPid, reusedSupervisor, createdSupervisor, launchReason.
 */
export async function ensureCursorRunning(options = {}) {
  const bindingFile = options.workspaceFile || resolveWorkspaceBindingFile();
  const bindingKey = options.workspaceKey || resolveWorkspaceBindingKey();
  const persistedBinding = readWorkspaceBinding(bindingFile, bindingKey);
  const hostProjectPath = resolveClaudeProjectPath();
  const projectPath = Object.hasOwn(options, 'projectPath')
    ? options.projectPath
    : resolveProjectPath(persistedBinding && persistedBinding.projectPath || process.env.CURSOR_PROJECT_PATH, {
      cwd: hostProjectPath || options.adapterStartCwd || process.cwd(),
    });
  const ensureOptions = { ...options, projectPath };
  if (process.env.CURSOR_BRIDGE_INLINE_ENSURE === '1' || process.env.CURSOR_BRIDGE_NO_SUPERVISOR === '1') {
    const local = await ensureCursorRunningLocal(ensureOptions);
    return withLifecycle({
      ...local,
      adapterPid: process.pid,
      supervisorPid: null,
      reusedSupervisor: false,
      createdSupervisor: false,
      launchReason: local.status === 'launched' ? 'inline-spawned-cursor' : `inline-${local.status}`,
    }, 'inline');
  }
  try {
    const supervised = await ensureCursorViaSupervisor({
      ...ensureOptions,
      reason: options.reason || 'ensureCursorRunning',
    });
    return withLifecycle(supervised, 'supervised', {
      runtimeUpgradeDeferred: supervised.runtimeUpgradeDeferred === true,
    });
  } catch (error) {
    if (error?.canAttachFallback !== true) throw error;
    const local = await ensureCursorRunningLocal({
      ...ensureOptions,
      allowSpawn: false,
      allowProcessControl: false,
    });
    return withLifecycle({
      ...local,
      adapterPid: process.pid,
      supervisorPid: null,
      reusedSupervisor: false,
      createdSupervisor: false,
      spawnMethod: null,
      launchReason: local.ok ? 'attached-after-supervisor-blocked' : `attached-${local.status}`,
      supervisorError: error instanceof Error ? error.message : String(error),
      supervisorStderr: error.stderr || null,
    }, 'attached', {
      degradedReason: error.degradedReason || 'supervisor-unavailable',
      spawnErrorCode: error.errorCode ?? error.returnValue ?? null,
      supervisorErrorKind: error.errorKind || null,
      supervisorCommandLine: error.commandLine || null,
      supervisorSpawnCwd: error.spawnCwd || null,
      spawnAttempts: error.attempts ?? null,
      runtimeUpgradeDeferred: false,
    });
  }
}

// 仅在「直接 node launch-cursor.mjs」时自执行。文件名守卫不可省：被 esbuild 打进 server 单文件后，
// import.meta.url 和 process.argv[1] 对所有内联模块都指向同一个 bundle，光靠 === 会让本块误判为入口
// → 往 stdout 打 JSON 污染 MCP 协议流 + process.exit 杀掉 server。
const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href
  && import.meta.url.endsWith('launch-cursor.mjs');
if (isMain) {
  ensureCursorRunning({ reason: 'cli' })
    .then((r) => { console.log(JSON.stringify(r)); process.exit(r.ok ? 0 : 1); })
    .catch((e) => { console.error('LAUNCH_FAIL: ' + (e && e.message || e)); process.exit(1); });
}
