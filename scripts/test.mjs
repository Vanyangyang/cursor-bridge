import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = mkdtempSync(join(tmpdir(), 'cursor-bridge-tests-'));
try {
  const files = readdirSync(join(root, 'test')).filter(name => name.endsWith('.test.mjs')).sort()
    .map(name => join(root, 'test', name));
  const child = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...files], {
    cwd: root,
    stdio: 'inherit',
    // IDE fixtures must not load a developer's saved CLI/provider credentials.
    // Source-specific tests supply their own explicit preference files.
    env: { ...process.env, CURSOR_BRIDGE_CCE_SOURCE_FILE: join(directory, 'cce-source.json') },
  });
  if (child.error) throw child.error;
  process.exitCode = child.status ?? 1;
} finally {
  if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('cursor-bridge-tests-')) {
    throw new Error('Refusing to clean an unexpected test configuration directory');
  }
  rmSync(directory, { recursive: true, force: true });
}
