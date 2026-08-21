#!/usr/bin/env node
/** probe-cursor-targets.mjs — 只读：验证 CDP 端口上是哪个 IDE + 列出 page targets。
 *  用法：node scripts/probes/probe-cursor-targets.mjs [port]  （默认 9222） */
import http from 'http';
const PORT = Number(process.argv[2] || 9222);
function httpJson(path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: 'localhost', port: PORT, path }, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(new Error('非JSON: ' + d.slice(0, 80))); } });
    });
    req.on('error', reject);
    req.setTimeout(4000, () => req.destroy(new Error('端口 ' + PORT + ' 无响应')));
  });
}
(async () => {
  try {
    const v = await httpJson('/json/version');
    console.log('[port ' + PORT + '] Browser=' + (v.Browser || '?') + '  UA=' + (v['User-Agent'] || '').slice(0, 60));
    const list = await httpJson('/json/list');
    const pages = list.filter(t => t.type === 'page');
    console.log('page targets: ' + pages.length);
    for (const p of pages) console.log('  - ' + (p.title || '(无标题)').slice(0, 50) + '  ::  ' + (p.url || '').slice(0, 70));
  } catch (e) { console.log('FAIL: ' + e.message); process.exit(1); }
})();
