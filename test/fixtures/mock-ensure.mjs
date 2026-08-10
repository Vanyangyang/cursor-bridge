/**
 * Test double for ensureCursorRunningLocal. Counts calls in a shared file so
 * concurrent supervisor clients can assert single-flight behavior.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

function counterPath() {
  const p = process.env.CURSOR_BRIDGE_TEST_COUNTER;
  if (!p) throw new Error('CURSOR_BRIDGE_TEST_COUNTER required for mock ensure');
  return p;
}

function readCount() {
  try {
    return Number(String(readFileSync(counterPath(), 'utf8')).trim() || '0') || 0;
  } catch {
    return 0;
  }
}

function writeCount(n) {
  const path = counterPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${n}\n`, { encoding: 'utf8' });
}

export async function ensureCursorRunningLocal({ waitMs = 30, runtimeMode = 'normal', projectPath = null } = {}) {
  const delay = Math.max(20, Math.min(200, Number(process.env.CURSOR_BRIDGE_TEST_ENSURE_DELAY_MS || 80)));
  const before = readCount();
  // Artificial overlap window for concurrent clients.
  await new Promise((r) => setTimeout(r, delay));
  const n = readCount() + 1;
  writeCount(n);
  if (process.env.CURSOR_BRIDGE_TEST_REQUEST) {
    writeFileSync(process.env.CURSOR_BRIDGE_TEST_REQUEST, `${JSON.stringify({ waitMs, runtimeMode, projectPath })}\n`, { encoding: 'utf8' });
  }
  void waitMs;
  return {
    ok: true,
    status: before === 0 ? 'launched' : 'already',
    port: Number(process.env.CURSOR_BRIDGE_CDP_PORT || 9223),
    message: `mock-ensure#${n}`,
    runtimeMode,
    projectPath,
  };
}
