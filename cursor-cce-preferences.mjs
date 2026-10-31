import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

export const CURSOR_CCE_SOURCES = Object.freeze(['ide', 'cli']);

export function normalizeCceSource(value, fallback = '') {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return CURSOR_CCE_SOURCES.includes(normalized) ? normalized : fallback;
}

export function resolveCceSourceFile(value = process.env.CURSOR_BRIDGE_CCE_SOURCE_FILE) {
  const configured = String(value || '').trim();
  if (configured) return resolve(configured);
  const configRoot = process.platform === 'win32' && process.env.APPDATA
    ? process.env.APPDATA
    : process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(configRoot, 'cursor-bridge', 'cce-source.json');
}

function invalidConfig(message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = 'CURSOR_CCE_SOURCE_CONFIG_INVALID';
  return error;
}

export function readCcePreferences(filePath) {
  const defaults = { version: 1, source: 'ide', updatedAt: null };
  if (!filePath) return defaults;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return defaults;
    throw invalidConfig(`Cannot read CCE source configuration at ${filePath}: ${error.message}`, error);
  }
  const source = normalizeCceSource(parsed?.source);
  if (!parsed || Array.isArray(parsed) || parsed.version !== 1 || !source
    || (parsed.updatedAt != null && typeof parsed.updatedAt !== 'string')) {
    throw invalidConfig(`Invalid CCE source configuration at ${filePath}; expected version 1 and source ide or cli`);
  }
  return { version: 1, source, updatedAt: parsed.updatedAt ?? null };
}

export function writeCcePreferences(filePath, preferences) {
  if (!filePath) throw new Error('persistent CCE source storage is disabled for this server');
  const source = normalizeCceSource(preferences?.source);
  if (!source) throw invalidConfig('CCE source must be ide or cli');
  const target = resolve(filePath);
  const normalized = { version: 1, source, updatedAt: new Date().toISOString() };
  mkdirSync(dirname(target), { recursive: true });
  const temporary = join(dirname(target), `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    renameSync(temporary, target);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  return normalized;
}

export function updateCcePreferences(filePath, { action = 'show', source } = {}) {
  const normalizedAction = typeof action === 'string' ? action.trim().toLowerCase() : '';
  if (normalizedAction === 'show') return readCcePreferences(filePath);
  if (normalizedAction === 'set') return writeCcePreferences(filePath, { source });
  throw new Error(`unsupported CCE source action: ${action}; expected show or set`);
}
