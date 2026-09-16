import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { cdpListIsCursor } from '../cursor-ensure-core.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(ROOT);

function listPayload(url, title = 'Cursor Agents') {
  return JSON.stringify([{ title, url }]);
}

const CASES = [
  {
    name: 'mac-system',
    expected: true,
    payload: listPayload('vscode-file://vscode-app/Applications/Cursor.app/Contents/Resources/app/out/vs/code/electron-sandbox/workbench/workbench.html'),
  },
  {
    name: 'mac-user',
    expected: true,
    payload: listPayload('vscode-file://vscode-app/Users/alex/Applications/Cursor.app/Contents/Resources/app/out/vs/code/electron-sandbox/workbench/workbench.html'),
  },
  {
    name: 'mac-spaces',
    expected: true,
    payload: listPayload('vscode-file://vscode-app/Users/alex/My%20Applications/Cursor.app/Contents/Resources/app/out/vs/code/electron-sandbox/workbench/workbench.html'),
  },
  {
    name: 'mac-case',
    expected: true,
    payload: listPayload('vscode-file://vscode-app/applications/cursor.app/contents/resources/app/out/vs/code/electron-sandbox/workbench/workbench.html'),
  },
  {
    name: 'win-resources',
    expected: true,
    payload: listPayload('vscode-file://vscode-app/d:/tool/cursor/resources/app/out/vs/code/electron-sandbox/workbench/workbench.html'),
  },
  {
    name: 'win-exe',
    expected: true,
    payload: JSON.stringify([{ title: 'Cursor', url: 'file:///C:/Users/alex/AppData/Local/Programs/cursor/Cursor.exe' }]),
  },
  {
    name: 'linux-resources',
    expected: true,
    payload: listPayload('vscode-file://vscode-app/usr/share/cursor/resources/app/out/vs/code/electron-sandbox/workbench/workbench.html'),
  },
  {
    name: 'linux-opt-app',
    expected: true,
    payload: listPayload('vscode-file://vscode-app/opt/cursor/app/out/vs/code/electron-sandbox/workbench/workbench.html'),
  },
  {
    name: 'chrome',
    expected: false,
    payload: JSON.stringify([{ title: 'Google Chrome', url: 'https://chromium.org' }]),
  },
  {
    name: 'title-only',
    expected: false,
    payload: JSON.stringify([{ title: 'Cursor Agents', url: 'about:blank' }]),
  },
  {
    name: 'vscode-mac',
    expected: false,
    payload: listPayload('vscode-file://vscode-app/Applications/Visual Studio Code.app/Contents/Resources/app/out/vs/code/electron-sandbox/workbench/workbench.html', 'Visual Studio Code'),
  },
  {
    name: 'other-mac-app',
    expected: false,
    payload: listPayload('vscode-file://vscode-app/Applications/Slack.app/Contents/Resources/app/src/index.html', 'Slack'),
  },
  {
    name: 'similar-cursor-app-name',
    expected: false,
    payload: listPayload('vscode-file://vscode-app/Applications/NotCursor.app/Contents/Resources/app/out/vs/code/electron-sandbox/workbench/workbench.html'),
  },
  {
    name: 'win-windsurf',
    expected: false,
    payload: JSON.stringify([{
      title: 'Windsurf',
      url: 'vscode-file://vscode-app/C:/Users/alex/AppData/Local/Programs/Windsurf/resources/app/out/vs/code/electron-sandbox/workbench/workbench.html',
    }]),
  },
  {
    name: 'mac-windsurf',
    expected: false,
    payload: listPayload('vscode-file://vscode-app/Applications/Windsurf.app/Contents/Resources/app/out/vs/code/electron-sandbox/workbench/workbench.html', 'Windsurf'),
  },
  {
    name: 'mixed-windsurf-veto',
    expected: false,
    payload: JSON.stringify([
      {
        title: 'Cursor Agents',
        url: 'vscode-file://vscode-app/Applications/Cursor.app/Contents/Resources/app/out/vs/code/electron-sandbox/workbench/workbench.html',
      },
      {
        title: 'Windsurf',
        url: 'vscode-file://vscode-app/C:/Users/alex/AppData/Local/Programs/Windsurf/resources/app/out/vs/code/electron-sandbox/workbench/workbench.html',
      },
    ]),
  },
  {
    name: 'empty-list',
    expected: false,
    payload: JSON.stringify([]),
  },
  {
    name: 'empty-string',
    expected: false,
    payload: '',
  },
];

test('cdpListIsCursor covers macOS Cursor.app paths without weakening Windows or Windsurf rules', () => {
  assert.equal(CASES.length, 18);
  for (const item of CASES) {
    assert.equal(cdpListIsCursor(item.payload), item.expected, item.name);
  }
});

test('cdpListIsCursor does not treat a Cursor Agents title as identity', () => {
  assert.equal(cdpListIsCursor({ title: 'Cursor Agents' }), false);
});

test('rebuilt adapter and supervisor bundles keep the macOS Cursor.app identity rule', () => {
  const marker = 'cursor\\.app[\\/\\\\]contents[\\/\\\\]resources[\\/\\\\]app[\\/\\\\]';
  for (const relative of ['dist/cursor-bridge.mjs', 'dist/cursor-lifecycle-supervisor.mjs']) {
    const source = readFileSync(join(REPO, relative), 'utf8');
    assert.ok(source.includes(marker), relative);
  }
});
