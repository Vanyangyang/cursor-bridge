import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { createIsolatedTestEnv } from '../scripts/test.mjs';

test('test runner isolates host Cursor Bridge and coding-agent session variables without dropping system paths', () => {
  const polluted = {
    PATH: 'C:\\Windows\\System32',
    APPDATA: 'C:\\Users\\dev\\AppData\\Roaming',
    LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local',
    USERPROFILE: 'C:\\Users\\dev',
    CURSOR_BRIDGE_DELEGATION: 'off',
    CURSOR_BRIDGE_NO_AUTOLAUNCH: '1',
    CURSOR_BRIDGE_CCE_CLI_CHILD: '1',
    CURSOR_BRIDGE_RUNTIME_MODE: 'minimal',
    CURSOR_BRIDGE_RUNTIME_FILE: 'C:\\host\\runtime.json',
    CURSOR_BRIDGE_WORKSPACE_FILE: 'C:\\host\\workspaces.json',
    CURSOR_BRIDGE_MODEL_PREFERENCES_FILE: 'C:\\host\\model-preferences.json',
    CURSOR_BRIDGE_SESSION_FILE: 'C:\\host\\sessions.json',
    CURSOR_BRIDGE_CCE_SOURCE_FILE: 'C:\\host\\cce-source.json',
    CURSOR_BRIDGE_CLI_PATH: 'C:\\host\\cursor-agent.ps1',
    CURSOR_BRIDGE_CCE_CLI_MCP: 'native',
    CURSOR_BRIDGE_CLI_INSPECT_TTL_MS: '0',
    CURSOR_BRIDGE_CCE_CLI_ACP: 'off',
    CURSOR_BRIDGE_CCE_CLI_ACP_IDLE_MS: '5000',
    CURSOR_BRIDGE_CCE_CLI_CONCURRENCY: '1',
    CURSOR_BRIDGE_TEST_SERVER: 'http://127.0.0.1:9999',
    CURSOR_CONFIG_DIR: 'C:\\host\\.cursor-config',
    CURSOR_DATA_DIR: 'C:\\host\\.cursor-data',
    CURSOR_PROJECT_PATH: 'C:\\host\\project',
    CURSOR_EXE: 'C:\\host\\Cursor.exe',
    CODEX_THREAD_ID: 'thread-123',
    CLAUDE_PROJECT_DIR: 'C:\\host\\claude-project',
    CLAUDE_CODE_PROJECT_DIR: 'C:\\host\\claude-code-project',
    CLAUDE_CODE_SESSION_ID: 'claude-session-123',
    CLAUDE_SESSION_ID: 'session-456',
    CLAUDE_PLUGIN_DATA: 'C:\\host\\plugin-data',
    TMP: 'C:\\host\\tmp',
    TEMP: 'C:\\host\\temp',
    TMPDIR: 'C:\\host\\tmpdir',
  };

  const tempDir = 'C:\\temp\\test-run';
  const isolated = createIsolatedTestEnv(polluted, tempDir);

  assert.equal(isolated.PATH, polluted.PATH);
  assert.equal(isolated.APPDATA, polluted.APPDATA);
  assert.equal(isolated.LOCALAPPDATA, polluted.LOCALAPPDATA);
  assert.equal(isolated.USERPROFILE, polluted.USERPROFILE);
  assert.equal(isolated.CURSOR_BRIDGE_TEST_SERVER, 'http://127.0.0.1:9999');
  assert.equal(isolated.CURSOR_BRIDGE_CCE_SOURCE_FILE, join(tempDir, 'cce-source.json'));
  assert.equal(isolated.TMP, polluted.TMP);
  assert.equal(isolated.TEMP, polluted.TEMP);
  assert.equal(isolated.TMPDIR, polluted.TMPDIR);

  for (const key of [
    'CURSOR_BRIDGE_DELEGATION',
    'CURSOR_BRIDGE_NO_AUTOLAUNCH',
    'CURSOR_BRIDGE_CCE_CLI_CHILD',
    'CURSOR_BRIDGE_RUNTIME_MODE',
    'CURSOR_BRIDGE_RUNTIME_FILE',
    'CURSOR_BRIDGE_WORKSPACE_FILE',
    'CURSOR_BRIDGE_MODEL_PREFERENCES_FILE',
    'CURSOR_BRIDGE_SESSION_FILE',
    'CURSOR_BRIDGE_CLI_PATH',
    'CURSOR_BRIDGE_CCE_CLI_MCP',
    'CURSOR_BRIDGE_CLI_INSPECT_TTL_MS',
    'CURSOR_BRIDGE_CCE_CLI_ACP',
    'CURSOR_BRIDGE_CCE_CLI_ACP_IDLE_MS',
    'CURSOR_BRIDGE_CCE_CLI_CONCURRENCY',
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
  ]) {
    assert.equal(Object.hasOwn(isolated, key), false, `${key} should be stripped`);
  }
});
