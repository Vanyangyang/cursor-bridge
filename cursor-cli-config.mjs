import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

const bridgeTools = ['cursor_context_engine', 'cursor_search', 'cursor_search_deep', 'cursor_do',
  'cursor_init', 'cursor_launch', 'cursor_cce', 'cursor_model', 'cursor_runtime', 'cursor_status',
  'cursor_task_control', 'cursor_session_control'];

// Cursor's --model writes cli-config.json. Keep each request's settings and chat
// storage private, while native authentication, project rules and MCP stay native.
export async function createCliConfigScope(env = process.env) {
  const configured = env.CURSOR_CONFIG_DIR;
  const userHome = (process.platform === 'win32' ? env.USERPROFILE : env.HOME) || homedir();
  const source = configured?.trim() ? configured
    : env.XDG_CONFIG_HOME?.trim() ? join(env.XDG_CONFIG_HOME, 'cursor') : join(userHome, '.cursor');
  if (!isAbsolute(source)) throw Object.assign(new Error('Cursor CLI configuration directory must be absolute'), { code: 'CURSOR_CLI_CONFIG_INVALID', confirmedNotSent: true });
  const parent = resolve(tmpdir()), prefix = 'cursor-bridge-cce-config-';
  const directory = await mkdtemp(join(parent, prefix));
  let released = false;
  const cleanup = async () => {
    if (released) return;
    if (dirname(resolve(directory)) !== parent || !basename(directory).startsWith(prefix)) throw new Error('Refusing to remove an unexpected CLI configuration directory');
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    released = true;
  };
  try {
    // permissions.json also holds terminal/MCP allowlists and auto-run rules.
    // Retain native settings and opaque allowlist storage; never copy auth or
    // session files, and add only the recursion guard to the private preferences.
    let settings = { version: 1, editor: { vimMode: false }, permissions: { allow: [], deny: [] } };
    for (const name of ['cli-config.json', 'permissions.json']) {
      let contents;
      try { contents = await readFile(join(source, name)); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (contents.length > 4 * 1024 * 1024) throw new Error('Cursor CLI configuration file exceeds 4 MiB');
      if (name === 'cli-config.json') settings = JSON.parse(contents.toString('utf8'));
      else await writeFile(join(directory, name), contents, { flag: 'wx', mode: 0o600 });
    }
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)
      || settings.permissions != null && (typeof settings.permissions !== 'object' || Array.isArray(settings.permissions))
      || settings.permissions?.deny != null && !Array.isArray(settings.permissions.deny)) throw new Error('Invalid native CLI permissions configuration');
    settings.permissions = { ...settings.permissions,
      // An owned CCE turn must use native retrieval rather than recursively
      // submitting another Bridge turn or mutating the host's Bridge settings.
      deny: [...new Set([...(settings.permissions?.deny || []), ...bridgeTools.map(tool => `Mcp(*:${tool})`)])],
    };
    await writeFile(join(directory, 'cli-config.json'), JSON.stringify(settings, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return { directory, env: { ...env, CURSOR_CONFIG_DIR: directory }, cleanup };
  } catch (cause) {
    await cleanup().catch(() => {});
    throw Object.assign(new Error('Cannot prepare the private Cursor CLI configuration', { cause }), { code: 'CURSOR_CLI_CONFIG_INVALID', confirmedNotSent: true });
  }
}
