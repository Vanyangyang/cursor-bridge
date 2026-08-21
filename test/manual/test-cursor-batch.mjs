#!/usr/bin/env node
/** test-cursor-batch.mjs — 连续跑多个 query（每个自动开新对话），结果写 .artifacts/cursor_batch_results.json。 */
import { bridge } from '../../server.mjs';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
const __dir = dirname(fileURLToPath(import.meta.url));
const artifactDir = join(__dir, '..', '..', '.artifacts');
const queries = [
  '行动条战斗回合顺序怎么驱动',
  '灵宠进化路线和天赋系统在哪实现',
  '存档保存和读取在哪里',
];
(async () => {
  const out = [];
  for (const q of queries) {
    const t0 = Date.now();
    try {
      const r = await bridge.contextEngine(q);
      out.push({ q, sec: ((Date.now() - t0) / 1000).toFixed(1), len: r.length, result: r });
      console.log('[batch] ✓ ' + q + ' ' + ((Date.now() - t0) / 1000).toFixed(1) + 's len=' + r.length);
    } catch (e) {
      out.push({ q, error: e.message });
      console.log('[batch] ✗ ' + q + ' : ' + e.message);
    }
  }
  try { mkdirSync(artifactDir, { recursive: true }); } catch {}
  writeFileSync(join(artifactDir, 'cursor_batch_results.json'), JSON.stringify(out, null, 2), 'utf8');
  console.log('[batch] 全部完成，写入 .artifacts/cursor_batch_results.json');
  process.exit(0);
})();
