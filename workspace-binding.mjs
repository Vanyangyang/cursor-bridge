import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { defaultLifecycleDir } from './lifecycle-paths.mjs';

const WORKSPACE_BINDING_VERSION = 1;

function pluginRuntimePath(candidate) {
  const value = String(candidate || '').replace(/\//g, '\\').toLowerCase();
  return value.includes('\\.codex\\.tmp\\marketplaces\\')
    || value.includes('\\.codex\\plugins\\cache\\')
    || value.includes('\\.claude\\plugins\\cache\\')
    || value.includes('\\appdata\\local\\npm-cache\\_npx\\');
}

export function normalizeWorkspacePath(value) {
  let raw = String(value || '').trim().replace(/^(["'])(.*)\1$/, '$2').trim();
  if (!raw) return '';
  if (raw === '~') raw = homedir();
  else if (raw.startsWith('~/') || raw.startsWith('~\\')) raw = join(homedir(), raw.slice(2));
  if (/^\\\\\?\\UNC\\/i.test(raw)) return resolve(`\\\\${raw.slice(8)}`);
  if (/^\\\\\?\\[a-zA-Z]:\\/.test(raw)) return resolve(raw.slice(4));
  return resolve(raw);
}

export function isAbsoluteWorkspacePath(value) {
  const raw = String(value || '').trim().replace(/^(["'])(.*)\1$/, '$2').trim();
  if (!raw) return false;
  if (raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\')) return true;
  return isAbsolute(raw)
    || /^\\\\\?\\(?:UNC\\|[a-zA-Z]:\\)/i.test(raw)
    || /^\\\\[^\\]+\\[^\\]+/.test(raw);
}

function isWorkspaceTarget(projectPath, options = {}) {
  const existsImpl = options.existsImpl || existsSync;
  if (!projectPath || !existsImpl(projectPath)) return false;
  const statImpl = options.statImpl || statSync;
  try {
    const info = statImpl(projectPath);
    return info.isDirectory() || (info.isFile() && extname(projectPath).toLowerCase() === '.code-workspace');
  } catch {
    return false;
  }
}

export function resolveWorkspaceBindingFile(env = process.env) {
  return resolve(env.CURSOR_BRIDGE_WORKSPACE_FILE || join(defaultLifecycleDir(), 'workspaces.json'));
}

export function resolveWorkspaceBindingKey(env = process.env, options = {}) {
  const codexThreadId = String(env.CODEX_THREAD_ID || '').trim();
  if (codexThreadId) return `codex-thread:${codexThreadId}`;

  const claudeProject = normalizeWorkspacePath(
    env.CLAUDE_PROJECT_DIR || env.CLAUDE_CODE_PROJECT_DIR || '',
  );
  if (claudeProject && !pluginRuntimePath(claudeProject)) {
    return `claude-project:${claudeProject.replace(/\\/g, '/').toLowerCase()}`;
  }

  const hostId = String(env.CURSOR_BRIDGE_HOST_ID || '').trim();
  if (hostId) return `host:${hostId}`;

  const cwd = normalizeWorkspacePath(options.cwd ?? process.cwd());
  if (cwd && !pluginRuntimePath(cwd)) {
    return `cwd:${cwd.replace(/\\/g, '/').toLowerCase()}`;
  }

  const claudeSessionId = String(env.CLAUDE_CODE_SESSION_ID || env.CLAUDE_SESSION_ID || '').trim();
  if (claudeSessionId) return `claude-session:${claudeSessionId}`;
  return 'default';
}

export function readWorkspaceBindings(filePath) {
  if (!filePath) return { version: WORKSPACE_BINDING_VERSION, bindings: {} };
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    if (!parsed || parsed.version !== WORKSPACE_BINDING_VERSION || !parsed.bindings || typeof parsed.bindings !== 'object') {
      return { version: WORKSPACE_BINDING_VERSION, bindings: {} };
    }
    return { version: WORKSPACE_BINDING_VERSION, bindings: { ...parsed.bindings } };
  } catch {
    return { version: WORKSPACE_BINDING_VERSION, bindings: {} };
  }
}

export function readWorkspaceBinding(filePath, bindingKey, options = {}) {
  const entry = readWorkspaceBindings(filePath).bindings[String(bindingKey || '')];
  if (!entry || typeof entry.projectPath !== 'string') return null;
  const projectPath = normalizeWorkspacePath(entry.projectPath);
  if (!isWorkspaceTarget(projectPath, options)) return null;
  return {
    projectPath,
    updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : null,
  };
}

export function writeWorkspaceBinding(filePath, bindingKey, projectPath, options = {}) {
  if (!filePath) throw new Error('persistent cursor_init storage is disabled for this server');
  const key = String(bindingKey || '').trim();
  if (!key) throw new Error('cursor_init could not identify the current Codex or Claude Code workspace session');
  if (!isAbsoluteWorkspacePath(projectPath)) {
    throw new Error('Provide an absolute project path, for example C:\\Projects\\my-app or /Users/me/Projects/my-app');
  }
  const normalized = normalizeWorkspacePath(projectPath);
  const existsImpl = options.existsImpl || existsSync;
  if (!normalized || !existsImpl(normalized)) {
    throw new Error(`Workspace not found: ${normalized || projectPath}`);
  }
  if (!isWorkspaceTarget(normalized, options)) {
    throw new Error('The workspace must be a project directory or a .code-workspace file');
  }

  const state = readWorkspaceBindings(filePath);
  const updatedAt = options.updatedAt || new Date().toISOString();
  state.bindings[key] = { projectPath: normalized, updatedAt };
  mkdirSync(dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(state, null, 2) + '\n', 'utf8');
    renameSync(temporary, filePath);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw new Error(`failed to persist cursor_init at ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { projectPath: normalized, updatedAt };
}

export function resolveClaudeProjectPath(env = process.env, options = {}) {
  const candidate = normalizeWorkspacePath(
    env.CLAUDE_PROJECT_DIR || env.CLAUDE_CODE_PROJECT_DIR || options.cwd || '',
  );
  if (!candidate || pluginRuntimePath(candidate)) return null;
  return (options.existsImpl || existsSync)(candidate) ? candidate : null;
}

