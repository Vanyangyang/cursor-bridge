import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { parse as parseJsonc } from 'jsonc-parser';

const bridgeTools = ['cursor_context_engine', 'cursor_search', 'cursor_search_deep', 'cursor_do',
  'cursor_init', 'cursor_launch', 'cursor_cce', 'cursor_model', 'cursor_runtime', 'cursor_status',
  'cursor_task_control', 'cursor_session_control'];

const MAX_CONFIG_FILE_BYTES = 4 * 1024 * 1024;
const PLUGIN_MANIFEST_CANDIDATES = [
  ['.cursor-plugin', 'plugin.json'],
  ['.claude-plugin', 'plugin.json'],
  ['plugin.json'],
];

function resolveUserHome(env = process.env, explicitHome) {
  if (explicitHome && String(explicitHome).trim()) return explicitHome;
  const fromEnv = process.platform === 'win32'
    ? (env.USERPROFILE || env.HOME)
    : (env.HOME || env.USERPROFILE);
  return (fromEnv && String(fromEnv).trim()) ? fromEnv : homedir();
}

export async function findCliProjectRoot(cwd) {
  const start = resolve(String(cwd || '.'));
  let current = start;
  while (true) {
    try {
      await access(join(current, '.git'));
      return current;
    } catch {
      // Keep walking upward until a .git file/directory or filesystem root is reached.
    }
    const parent = dirname(current);
    if (parent === current) return start;
    current = parent;
  }
}

export function computeCliProjectSlug(projectRoot) {
  return String(projectRoot || '')
    .replace(/[^a-zA-Z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function readJsoncFileSafe(filePath) {
  let buffer;
  try {
    buffer = await readFile(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR' || error?.code === 'EISDIR') return { ok: true, data: null };
    return { ok: false, data: null, category: 'mcp_config_read_error' };
  }
  if (buffer.length > MAX_CONFIG_FILE_BYTES) return { ok: false, data: null, category: 'mcp_config_too_large' };
  const errors = [];
  const data = parseJsonc(buffer.toString('utf8'), errors, { allowTrailingComma: true });
  if (errors.length > 0 || !data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, data: null, category: 'mcp_config_parse_error' };
  }
  return { ok: true, data };
}

function extractMcpServerNames(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return [];
  if (config.mcpServers && typeof config.mcpServers === 'object' && !Array.isArray(config.mcpServers)) {
    return Object.keys(config.mcpServers).filter(key => typeof key === 'string' && key.trim());
  }
  // Some plugin .mcp.json files define servers directly at the top level.
  if (!('mcpServers' in config)) {
    return Object.entries(config)
      .filter(([key, value]) => typeof key === 'string' && key.trim() && key !== '$schema'
        && value && typeof value === 'object' && !Array.isArray(value))
      .map(([key]) => key);
  }
  return [];
}

async function listSubdirectoriesSafe(directory) {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries.filter(entry => entry.isDirectory()).map(entry => entry.name);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return [];
    throw error;
  }
}

async function collectPluginMcpIds(pluginDir, fallbackName, ids, categories) {
  let manifest = null;
  for (const parts of PLUGIN_MANIFEST_CANDIDATES) {
    const res = await readJsoncFileSafe(join(pluginDir, ...parts));
    if (!res.ok) categories.add(res.category);
    if (res.data) {
      manifest = res.data;
      break;
    }
  }
  const pluginName = (typeof manifest?.name === 'string' && manifest.name.trim()) ? manifest.name.trim() : fallbackName;
  if (!pluginName) return;
  const serverNames = new Set();
  if (manifest?.mcpServers && typeof manifest.mcpServers === 'object' && !Array.isArray(manifest.mcpServers)) {
    for (const key of Object.keys(manifest.mcpServers)) {
      if (typeof key === 'string' && key.trim()) serverNames.add(key.trim());
    }
  }
  for (const filename of ['mcp.json', '.mcp.json']) {
    const res = await readJsoncFileSafe(join(pluginDir, filename));
    if (!res.ok) categories.add(res.category);
    for (const name of extractMcpServerNames(res.data)) serverNames.add(name.trim());
  }
  for (const serverName of serverNames) ids.add(`plugin-${pluginName}-${serverName}`);
}

export async function enumerateNativeMcpServerIds({ env = process.env, projectRoot = null, userHome = null } = {}) {
  const home = resolveUserHome(env, userHome);
  const ids = new Set();
  const categories = new Set();

  const userMcp = await readJsoncFileSafe(join(home, '.cursor', 'mcp.json'));
  if (!userMcp.ok) categories.add(userMcp.category);
  for (const name of extractMcpServerNames(userMcp.data)) ids.add(name.trim());

  if (projectRoot) {
    const projectMcp = await readJsoncFileSafe(join(projectRoot, '.cursor', 'mcp.json'));
    if (!projectMcp.ok) categories.add(projectMcp.category);
    for (const name of extractMcpServerNames(projectMcp.data)) ids.add(name.trim());
  }

  try {
    const localBase = join(home, '.cursor', 'plugins', 'local');
    for (const name of await listSubdirectoriesSafe(localBase)) {
      await collectPluginMcpIds(join(localBase, name), name, ids, categories);
    }
  } catch {
    categories.add('mcp_plugin_scan_error');
  }

  try {
    const cacheBase = join(home, '.cursor', 'plugins', 'cache');
    for (const marketplace of await listSubdirectoriesSafe(cacheBase)) {
      const marketplaceDir = join(cacheBase, marketplace);
      for (const pluginSlug of await listSubdirectoriesSafe(marketplaceDir)) {
        const slugDir = join(marketplaceDir, pluginSlug);
        for (const sha of await listSubdirectoriesSafe(slugDir)) {
          await collectPluginMcpIds(join(slugDir, sha), pluginSlug, ids, categories);
        }
      }
    }
  } catch {
    categories.add('mcp_plugin_scan_error');
  }

  const partialErrorCategory = categories.size > 0 ? [...categories][0] : null;
  return { ids: [...ids].filter(Boolean).sort(), partialErrorCategory };
}

// Cursor's --model writes cli-config.json. Keep each request's settings and chat
// storage private, while native authentication and project rules stay native.
// Unless CURSOR_BRIDGE_CCE_CLI_MCP=native, disable native MCP servers in private
// CURSOR_DATA_DIR so CCE CLI turns avoid unrelated MCP startup latency.
export async function createCliConfigScope(env = process.env, options = {}) {
  const configured = env.CURSOR_CONFIG_DIR;
  const userHome = resolveUserHome(env, options.userHome);
  const source = configured?.trim() ? configured
    : env.XDG_CONFIG_HOME?.trim() ? join(env.XDG_CONFIG_HOME, 'cursor') : join(userHome, '.cursor');
  if (!isAbsolute(source)) throw Object.assign(new Error('Cursor CLI configuration directory must be absolute'), { code: 'CURSOR_CLI_CONFIG_INVALID', confirmedNotSent: true });
  const parent = resolve(tmpdir()), prefix = 'cursor-bridge-cce-config-', dataPrefix = 'cursor-bridge-cce-data-';
  const directory = await mkdtemp(join(parent, prefix));
  const dataDirectory = await mkdtemp(join(parent, dataPrefix));
  let released = false;
  const cleanup = async () => {
    if (released) return;
    if (dirname(resolve(directory)) !== parent || !basename(directory).startsWith(prefix)) throw new Error('Refusing to remove an unexpected CLI configuration directory');
    if (dirname(resolve(dataDirectory)) !== parent || !basename(dataDirectory).startsWith(dataPrefix)) throw new Error('Refusing to remove an unexpected CLI data directory');
    await Promise.all([
      rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }),
      rm(dataDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }),
    ]);
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
      if (contents.length > MAX_CONFIG_FILE_BYTES) throw new Error('Cursor CLI configuration file exceeds 4 MiB');
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

    const mcpModeRaw = String(env.CURSOR_BRIDGE_CCE_CLI_MCP || '').trim().toLowerCase();
    let mcpIsolation;
    if (mcpModeRaw === 'native') {
      mcpIsolation = { enabled: false, mode: 'native', disabledCount: 0, slug: null, verified: null, reason: null };
    } else if (!options.cwd) {
      mcpIsolation = { enabled: false, mode: 'no_workspace', disabledCount: 0, slug: null, verified: null, reason: null };
    } else {
      try {
        const projectRoot = await findCliProjectRoot(options.cwd);
        const slug = computeCliProjectSlug(projectRoot);
        if (!slug) throw Object.assign(new Error('Empty project slug'), { category: 'mcp_slug_empty' });
        const enumerator = options.enumerateMcpImpl || enumerateNativeMcpServerIds;
        const enumerated = await enumerator({ env, projectRoot, userHome });
        const ids = Array.isArray(enumerated) ? enumerated : (Array.isArray(enumerated?.ids) ? enumerated.ids : []);
        const partialErrorCategory = !Array.isArray(enumerated) ? (enumerated?.partialErrorCategory || null) : null;
        const projectDir = join(dataDirectory, 'projects', slug);
        await mkdir(projectDir, { recursive: true, mode: 0o700 });
        await writeFile(join(projectDir, 'mcp-disabled.json'), JSON.stringify(ids, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
        mcpIsolation = {
          enabled: true,
          mode: 'disabled_list',
          disabledCount: ids.length,
          slug,
          verified: null,
          reason: partialErrorCategory,
        };
      } catch (error) {
        mcpIsolation = {
          enabled: false,
          mode: 'fail_open',
          disabledCount: 0,
          slug: null,
          verified: false,
          reason: error?.category || error?.code || 'mcp_isolation_failed',
        };
      }
    }

    const verifyProjectSlug = async () => {
      if (!mcpIsolation.enabled || !mcpIsolation.slug) return { ok: true, reason: null };
      try {
        const entries = await readdir(join(dataDirectory, 'projects'), { withFileTypes: true });
        const unexpected = entries.filter(entry => entry.isDirectory() && entry.name !== mcpIsolation.slug);
        if (unexpected.length > 0) {
          mcpIsolation.verified = false;
          mcpIsolation.reason = 'slug_mismatch';
          return { ok: false, reason: 'slug_mismatch' };
        }
        mcpIsolation.verified = true;
        return { ok: true, reason: null };
      } catch (error) {
        if (error?.code === 'ENOENT') return { ok: true, reason: null };
        mcpIsolation.verified = false;
        mcpIsolation.reason = error?.code || 'slug_verify_failed';
        return { ok: false, reason: mcpIsolation.reason };
      }
    };

    return {
      directory,
      dataDirectory,
      env: { ...env, CURSOR_CONFIG_DIR: directory, CURSOR_DATA_DIR: dataDirectory },
      mcpIsolation,
      verifyProjectSlug,
      cleanup,
    };
  } catch (cause) {
    await cleanup().catch(() => {});
    throw Object.assign(new Error('Cannot prepare the private Cursor CLI configuration', { cause }), { code: 'CURSOR_CLI_CONFIG_INVALID', confirmedNotSent: true });
  }
}
