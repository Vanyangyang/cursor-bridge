// Bundle MCP adapters + standalone supervisors for plugin installs.
// Plugins do not npm install; persistent entrypoints must be cache-independent ESM.
// 用法：npm install && npm run build
import { build } from 'esbuild';

const external = ['bufferutil', 'utf-8-validate'];
const banner = {
  js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
};
const grokOnly = process.argv.includes('--grok-only');

if (!grokOnly) {
  await build({
    entryPoints: ['server.mjs'],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: 'dist/cursor-bridge.mjs',
    external,
    banner,
  });
}

await build({
  entryPoints: ['plugins/grok-build-supervisor/scripts/server.mjs'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: 'plugins/grok-build-supervisor/dist/grok-build-supervisor.mjs',
  external,
  banner,
});

await build({
  entryPoints: ['plugins/grok-build-supervisor/scripts/supervisor-daemon.mjs'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: 'plugins/grok-build-supervisor/dist/supervisor-daemon.mjs',
  external,
  banner,
});

if (!grokOnly) {
  await build({
    entryPoints: ['cursor-lifecycle-supervisor.mjs'],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: 'dist/cursor-lifecycle-supervisor.mjs',
    external,
    banner,
  });
}

if (!grokOnly) {
  console.log('✅ built dist/cursor-bridge.mjs');
  console.log('✅ built dist/cursor-lifecycle-supervisor.mjs');
}
console.log('✅ built plugins/grok-build-supervisor/dist/grok-build-supervisor.mjs');
console.log('✅ built plugins/grok-build-supervisor/dist/supervisor-daemon.mjs');
