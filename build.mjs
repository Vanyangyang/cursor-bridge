// Bundle MCP adapter + standalone lifecycle supervisor for plugin installs.
// Plugins do not npm install; both entrypoints must be zero-dependency ESM.
// 用法：npm install && npm run build
import { build } from 'esbuild';

const external = ['bufferutil', 'utf-8-validate'];
const banner = {
  js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
};

await build({
  entryPoints: ['server.mjs'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: 'dist/cursor-bridge.mjs',
  external,
  banner,
});

await build({
  entryPoints: ['cursor-lifecycle-supervisor.mjs'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: 'dist/cursor-lifecycle-supervisor.mjs',
  external,
  banner,
});

console.log('✅ built dist/cursor-bridge.mjs');
console.log('✅ built dist/cursor-lifecycle-supervisor.mjs');
