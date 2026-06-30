// 把 server.mjs（含动态 import 的 launch-cursor.mjs + 依赖 @modelcontextprotocol/sdk、ws）
// 打成零依赖单文件 dist/cursor-bridge.mjs，供 Claude Code 插件直接运行（插件不自动 npm install）。
// 用法：npm install && npm run build
import { build } from 'esbuild';

await build({
  entryPoints: ['server.mjs'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: 'dist/cursor-bridge.mjs',
  // ws 的可选原生加速件，缺失时 ws 自动回退纯 JS——标记 external 避免打包 .node 二进制
  external: ['bufferutil', 'utf-8-validate'],
  // ESM 产物里需要可用的 require（ws/sdk 内部对上面可选件做 try/catch require）
  banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
});

console.log('✅ built dist/cursor-bridge.mjs');
