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
import { ensureCursorRunningLocal, CDP_PORT } from './cursor-ensure-core.mjs';
import { ensureCursorViaSupervisor } from './cursor-lifecycle-client.mjs';

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
  if (process.env.CURSOR_BRIDGE_INLINE_ENSURE === '1' || process.env.CURSOR_BRIDGE_NO_SUPERVISOR === '1') {
    const local = await ensureCursorRunningLocal(options);
    return {
      ...local,
      adapterPid: process.pid,
      supervisorPid: null,
      reusedSupervisor: false,
      createdSupervisor: false,
      launchReason: local.status === 'launched' ? 'inline-spawned-cursor' : `inline-${local.status}`,
    };
  }
  return ensureCursorViaSupervisor({
    ...options,
    reason: options.reason || 'ensureCursorRunning',
  });
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
