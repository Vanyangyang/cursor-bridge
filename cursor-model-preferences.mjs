import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

export const CURSOR_MODEL_TARGETS = Object.freeze(['cce', 'cursor_do']);
export const CURSOR_MODEL_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);

export function normalizeCursorModelTarget(value, fallback = '') {
  const normalized = String(value || '').trim().toLowerCase().replace(/-/g, '_');
  if (normalized === 'context_engine' || normalized === 'cursor_context_engine') return 'cce';
  if (normalized === 'do' || normalized === 'delegate') return 'cursor_do';
  return CURSOR_MODEL_TARGETS.includes(normalized) ? normalized : fallback;
}

export function normalizeCursorModelEffort(value, fallback = '') {
  const normalized = String(value || '').trim().toLowerCase().replace(/[_\s]+/g, '-');
  if (normalized === 'extra-high' || normalized === 'extra-high-thinking') return 'xhigh';
  return CURSOR_MODEL_EFFORTS.includes(normalized) ? normalized : fallback;
}

export function cursorEffortUiValue(value) {
  const normalized = normalizeCursorModelEffort(value, '');
  return normalized === 'xhigh' ? 'extra-high' : normalized;
}

export function normalizeCursorModelPreference(value, options = {}) {
  if (value == null) return null;
  const model = String(value.model || '').trim();
  if (!model) {
    if (options.allowEmpty) return null;
    throw new Error('model must not be empty');
  }
  if (model.length > 200) throw new Error('model exceeds the 200-character limit');
  const rawEffort = value.effort == null ? '' : String(value.effort).trim();
  const effort = rawEffort ? normalizeCursorModelEffort(rawEffort, '') : null;
  if (rawEffort && !effort) {
    throw new Error(`unsupported Cursor model effort: ${value.effort}; expected low, medium, high, xhigh, or max`);
  }
  return { model, effort };
}

export function resolveCursorModelPreferencesFile(value = process.env.CURSOR_BRIDGE_MODEL_PREFERENCES_FILE) {
  const configured = String(value || '').trim();
  if (configured) return resolve(configured);
  const configRoot = process.platform === 'win32' && process.env.APPDATA
    ? process.env.APPDATA
    : process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(configRoot, 'cursor-bridge', 'model-preferences.json');
}

function emptyPreferences() {
  return { version: 1, targets: { cce: null, cursor_do: null }, updatedAt: null };
}

export function readCursorModelPreferences(filePath) {
  const empty = emptyPreferences();
  if (!filePath) return empty;
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    const targets = parsed && typeof parsed.targets === 'object' ? parsed.targets : {};
    return {
      version: 1,
      targets: {
        cce: normalizeCursorModelPreference(targets.cce, { allowEmpty: true }),
        cursor_do: normalizeCursorModelPreference(targets.cursor_do, { allowEmpty: true }),
      },
      updatedAt: parsed && parsed.updatedAt ? String(parsed.updatedAt) : null,
    };
  } catch (error) {
    if (error && error.code === 'ENOENT') return empty;
    console.error(`[cursor-bridge] ignoring unreadable model preferences file ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    return empty;
  }
}

export function writeCursorModelPreferences(filePath, preferences) {
  if (!filePath) throw new Error('persistent cursor_model storage is disabled for this server');
  const target = resolve(filePath);
  const normalized = {
    version: 1,
    targets: {
      cce: normalizeCursorModelPreference(preferences && preferences.targets && preferences.targets.cce, { allowEmpty: true }),
      cursor_do: normalizeCursorModelPreference(preferences && preferences.targets && preferences.targets.cursor_do, { allowEmpty: true }),
    },
    updatedAt: new Date().toISOString(),
  };
  mkdirSync(dirname(target), { recursive: true });
  const temporary = join(dirname(target), `.${basename(target)}.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(temporary, target);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw new Error(`failed to persist cursor_model at ${target}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return normalized;
}

export function updateCursorModelPreferences(filePath, { action, target, model, effort } = {}) {
  const normalizedAction = String(action || 'show').trim().toLowerCase();
  if (!['show', 'set', 'reset'].includes(normalizedAction)) {
    throw new Error(`unsupported cursor_model action: ${action}; expected show, set, or reset`);
  }
  const selectedTargets = String(target || '').trim().toLowerCase() === 'both'
    ? [...CURSOR_MODEL_TARGETS]
    : [normalizeCursorModelTarget(target, '')].filter(Boolean);
  if (normalizedAction !== 'show' && selectedTargets.length === 0) {
    throw new Error('cursor_model set/reset requires target=cce, cursor_do, or both');
  }
  const current = readCursorModelPreferences(filePath);
  if (normalizedAction === 'show') return current;
  const next = { ...current, targets: { ...current.targets } };
  const preference = normalizedAction === 'set'
    ? normalizeCursorModelPreference({ model, effort })
    : null;
  for (const selectedTarget of selectedTargets) next.targets[selectedTarget] = preference;
  return writeCursorModelPreferences(filePath, next);
}
