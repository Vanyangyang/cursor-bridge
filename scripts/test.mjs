import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HOST_SESSION_ENV_KEYS = new Set([
  'CURSOR_CONFIG_DIR',
  'CURSOR_DATA_DIR',
  'CURSOR_PROJECT_PATH',
  'CURSOR_EXE',
  'CODEX_THREAD_ID',
  'CLAUDE_PROJECT_DIR',
  'CLAUDE_CODE_PROJECT_DIR',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_SESSION_ID',
  'CLAUDE_PLUGIN_DATA',
]);

export function createIsolatedTestEnv(baseEnv = process.env, tempDirectory = '') {
  const env = {};
  for (const [key, value] of Object.entries(baseEnv || {})) {
    const upper = key.toUpperCase();
    if (upper.startsWith('CURSOR_BRIDGE_') && upper !== 'CURSOR_BRIDGE_TEST_SERVER') continue;
    if (HOST_SESSION_ENV_KEYS.has(upper)) continue;
    if (value !== undefined) env[key] = value;
  }
  if (tempDirectory) {
    // IDE fixtures must not load a developer's saved CLI/provider credentials.
    // Source-specific tests supply their own explicit preference files.
    env.CURSOR_BRIDGE_CCE_SOURCE_FILE = join(tempDirectory, 'cce-source.json');
  }
  return env;
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;
if (isMain) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const directory = mkdtempSync(join(tmpdir(), 'cursor-bridge-tests-'));
  try {
    const args = process.argv.slice(2);
    const explicitFiles = [];
    const runnerFlags = [];
    for (const arg of args) {
      if (!arg.startsWith('-') && /\.(?:mjs|js)$/i.test(arg)) {
        explicitFiles.push(resolve(root, arg));
      } else {
        runnerFlags.push(arg);
      }
    }
    const files = explicitFiles.length > 0
      ? explicitFiles
      : readdirSync(join(root, 'test')).filter(name => name.endsWith('.test.mjs')).sort()
        .map(name => join(root, 'test', name));
    const child = spawnSync(process.execPath, ['--test', ...runnerFlags, ...files], {
      cwd: root,
      stdio: 'inherit',
      env: createIsolatedTestEnv(process.env, directory),
    });
    if (child.error) throw child.error;
    process.exitCode = child.status ?? 1;
  } finally {
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('cursor-bridge-tests-')) {
      throw new Error('Refusing to clean an unexpected test configuration directory');
    }
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}
