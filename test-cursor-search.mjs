#!/usr/bin/env node
/** test-cursor-search.mjs — 直接调 CursorBridge.contextEngine 端到端验证（不走 MCP stdio）。
 *  用法：node test-cursor-search.mjs ["查询"] */
import { bridge } from './server.mjs';
const q = process.argv[2] || '灵宠捕获概率在哪里计算';
(async () => {
  console.log('[test] 状态:', JSON.stringify(await bridge.status()));
  console.log('[test] 查询:', q);
  const t0 = Date.now();
  try {
    const r = await bridge.contextEngine(q);
    console.log('[test] 耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's，结果长度 ' + r.length);
    console.log('--- 结果 ---\n' + r.slice(0, 1500));
  } catch (e) {
    console.log('[test] FAIL: ' + e.message);
  }
  process.exit(0);
})();
