import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readCursorSessionRegistry, updateCursorSessionRegistry } from '../cursor-session-registry.mjs';

import {
  CursorBridge,
  CURSOR_RUNTIME_MODES,
  buildContextEnginePrompt,
  buildToolDefinitions,
  isConfirmedCompletedReply,
  isSessionTurnReplyReady,
  shouldScheduleParallelOriginRestore,
  normalizeCceSearchResult,
  normalizeAllowedPath,
  normalizeDelegationMode,
  pathsOverlap,
  scoreCursorPageCandidate,
  selectCursorPageCandidate,
  selectPageForUiPreference,
  classifyChatPanelDiagnostic,
  toolErrorResult,
  selectNewAgentEntry,
  selectUniqueNewAgentEntry,
  selectPromotedParallelEntry,
  selectPromotedFifoEntry,
  EXPR_VISIBLE,
  EXPR_FIND_NEWAGENT,
  exprCreateAgentForWorkspace,
  exprInspectWorkspaceRepository,
  EXPR_PAGE_CAPABILITIES,
  EXPR_HISTORY_ENTRIES,
  EXPR_PROVIDER_ERROR,
  EXPR_CLICK_SEND,
  EXPR_PREPARE_INPUT,
  exprOpenAgent,
  exprClickSelectedAgentStop,
  EXPR_VISIBLE_COMPOSER,
  exprClickBoundComposerStop,
  isTargetedStopConfirmed,
  updateStableEntryObservation,
  classifyParallelTerminalIcon,
  isDurablyRegisteredParallelEntry,
  uncertainSubmissionReservationScope,
  providerErrorSignature,
  createProviderError,
  promoteAgentsWorkspaceLifecycle,
  summarizeCdpPages,
  shouldRecoverNormalAgentsPresentation,
  releaseAdapterWorkingDirectory,
  lifecycleFailureSummary,
  PLUGIN_VERSION,
} from '../server.mjs';

test('status snapshot lists CDP titles without requiring a live page probe', () => {
  const summary = summarizeCdpPages([
    { type: 'page', title: 'Cursor Settings - cursor-bridge - Cursor', url: 'vscode-file://settings' },
    { type: 'page', title: 'Cursor Agents', url: 'vscode-file://agents' },
    { type: 'worker', title: '' },
  ]);
  assert.equal(summary.pageCount, 2);
  assert.equal(summary.agentsWindowPresent, true);
  assert.deepEqual(summary.pageTitles, [
    'Cursor Settings - cursor-bridge - Cursor',
    'Cursor Agents',
  ]);
  assert.equal(summary.page, 'vscode-file://agents');
});

test('lifecycle failures retain the original supervisor cause', () => {
  const message = lifecycleFailureSummary({
    status: 'external-launch-required',
    lifecycleMode: 'attached',
    message: 'Cursor is not reachable on CDP 9223.',
    degradedReason: 'wmi-unknown-8',
    spawnErrorCode: 8,
    supervisorErrorKind: 'wmi-unknown',
    spawnAttempts: 2,
    supervisorError: 'failed to spawn lifecycle supervisor: WMI Win32_Process.Create failed: 8',
  }, 'Cursor lifecycle failed');
  assert.match(message, /status=external-launch-required/);
  assert.match(message, /degradedReason=wmi-unknown-8/);
  assert.match(message, /spawnErrorCode=8/);
  assert.match(message, /spawnAttempts=2/);
  assert.match(message, /Original supervisor error: .*Win32_Process\.Create failed: 8/);
});

test('adapter releases the plugin cache cwd into an explicit stable directory', (t) => {
  const target = mkdtempSync(join(tmpdir(), 'cb-adapter-runtime-cwd-'));
  t.after(() => rmSync(target, { recursive: true, force: true }));
  let changedTo = null;
  const released = releaseAdapterWorkingDirectory({
    targetDir: target,
    chdir(value) { changedTo = value; },
  });
  assert.equal(released, target);
  assert.equal(changedTo, target);
});

test('adapter default cwd release does not create lifecycle state inside the sandbox', () => {
  let changedTo = null;
  const released = releaseAdapterWorkingDirectory({
    chdir(value) { changedTo = value; },
  });
  assert.equal(released, dirname(process.execPath));
  assert.equal(changedTo, dirname(process.execPath));
});

test('normal Agents reuse requests a bounded non-activating compositor recovery', async () => {
  const now = Date.parse('2026-08-20T00:00:00.000Z');
  const base = {
    runtimeMode: 'normal',
    workspaceAction: 'reused-agents-window',
    cursorPid: 27324,
    platform: 'win32',
    now,
  };
  assert.equal(shouldRecoverNormalAgentsPresentation(base), true);
  assert.equal(shouldRecoverNormalAgentsPresentation({ ...base, runtimeMode: 'minimal' }), false);
  assert.equal(shouldRecoverNormalAgentsPresentation({ ...base, workspaceAction: 'reused-project-target' }), false);
  assert.equal(shouldRecoverNormalAgentsPresentation({ ...base, platform: 'linux' }), false);
  assert.equal(shouldRecoverNormalAgentsPresentation({
    ...base,
    lastPresentation: {
      applied: true,
      action: 'show',
      pid: 27324,
      at: '2026-08-19T23:59:00.000Z',
    },
  }), false);
  assert.equal(shouldRecoverNormalAgentsPresentation({
    ...base,
    lastPresentation: {
      applied: true,
      action: 'show',
      pid: 27324,
      at: '2026-08-19T23:54:59.000Z',
    },
  }), true);

  const bridge = new CursorBridge({ runtimeFile: null, workspaceFile: null, runtimeMode: 'normal' });
  let showCalls = 0;
  bridge.applyRuntimePresentation = async (action) => {
    showCalls += 1;
    bridge._lastPresentation = {
      supported: true,
      applied: true,
      action,
      pid: 27324,
      changedWindows: 1,
      at: new Date(now).toISOString(),
    };
    return bridge._lastPresentation;
  };
  const lifecycle = { workspaceAction: 'reused-agents-window', cursorPid: 27324, presentation: null };
  const recovered = await bridge.recoverNormalAgentsPresentation(lifecycle, now);
  assert.equal(recovered.action, 'show');
  assert.equal(lifecycle.presentation.changedWindows, 1);
  assert.equal(showCalls, 1);
  assert.equal(await bridge.recoverNormalAgentsPresentation(lifecycle, now + 1000), null);
  assert.equal(showCalls, 1);
});

test('page capability scoring prefers Cursor Agents and pins an existing target', () => {
  const legacy = {
    id: 'legacy',
    url: 'cursor://workbench/workbench.html',
    capabilities: {
      hasWritableInput: true,
      uiFlavor: 'legacy',
      agentAdapterKind: 'legacy',
      hasComposer: true,
      visible: true,
      focused: true,
    },
  };
  const agentsV2 = {
    id: 'agents-v2',
    url: 'cursor://workbench/workbench.html',
    capabilities: {
      hasWritableInput: true,
      uiFlavor: 'agents_v2',
      agentAdapterKind: 'agents_v2',
      hasComposer: true,
      visible: false,
      focused: false,
    },
  };

  assert.ok(scoreCursorPageCandidate(agentsV2, 'parallel_agent') > scoreCursorPageCandidate(legacy, 'parallel_agent'));
  assert.equal(selectCursorPageCandidate([legacy, agentsV2], { purpose: 'parallel_agent' }).id, 'agents-v2');
  assert.equal(selectCursorPageCandidate([legacy, agentsV2], { targetId: 'legacy' }).id, 'legacy');
  assert.throws(
    () => selectCursorPageCandidate([legacy, agentsV2], { targetId: 'missing' }),
    /target disappeared/,
  );
  assert.equal(selectPageForUiPreference([legacy, agentsV2], { preferAgentsV2: true }).id, 'agents-v2');
  assert.equal(selectPageForUiPreference([legacy, agentsV2], { preferLegacy: true }).id, 'legacy');
});

test('input and New Agent expressions cover legacy and Cursor Agents UI contracts', () => {
  assert.match(EXPR_VISIBLE, /ui-prompt-input-editor__input/);
  assert.match(EXPR_VISIBLE, /tiptap\.ProseMirror/);
  assert.match(EXPR_VISIBLE, /aislash-editor-input/);
  assert.match(EXPR_PAGE_CAPABILITIES, /role="dialog"/);
  assert.match(EXPR_PAGE_CAPABILITIES, /settingsOrCustomizeVisible/);
  assert.match(EXPR_PAGE_CAPABILITIES, /ui-customize-view/);
  assert.match(EXPR_PAGE_CAPABILITIES, /signInControlVisible/);
  assert.match(EXPR_PAGE_CAPABILITIES, /!node\.closest\(configurationSelector\)/);
  assert.match(EXPR_PAGE_CAPABILITIES, /signInVisible/);
  assert.match(EXPR_PAGE_CAPABILITIES, /agentSurfaceVisible/);
  assert.match(EXPR_PAGE_CAPABILITIES, /composer-react-transcript-root/);
  assert.doesNotMatch(EXPR_PAGE_CAPABILITIES, /\|\|!!document\.querySelector\('\.aichat-container'\)/);
  assert.match(EXPR_PREPARE_INPUT, /selectNodeContents/);
  assert.match(EXPR_CLICK_SEND, /ui-prompt-input-submit-button/);
  assert.match(EXPR_CLICK_SEND, /data-state="send"/);
  assert.match(EXPR_CLICK_SEND, /aria-label="Send message"/);
  assert.match(EXPR_CLICK_SEND, /agent-prompt-input-root/);
  assert.match(EXPR_FIND_NEWAGENT, /innerText/);
  assert.match(EXPR_FIND_NEWAGENT, /glass-sidebar-agent-menu-btn/);
  assert.match(EXPR_PAGE_CAPABILITIES, /glass-sidebar-agent-list-container/);
  assert.match(EXPR_PAGE_CAPABILITIES, /agentAdapterKind/);
});

test('Cursor Agents workspace expression creates a new Agent inside the exact repository section', () => {
  let clicked = 0;
  const section = {
    querySelector(selector) {
      if (selector === '.ui-sidebar-section-head') return { innerText: 'VESPERIX' };
      return null;
    },
    querySelectorAll() {
      return [{ getAttribute: (name) => name === 'aria-label' ? 'New Agent' : null, click: () => { clicked++; } }];
    },
  };
  const document = { querySelectorAll: () => [section] };
  const result = JSON.parse(Function('document', `return ${exprCreateAgentForWorkspace('G:\\\\project\\\\VESPERIX')};`)(document));
  assert.equal(result.ok, true);
  assert.equal(result.workspace, 'vesperix');
  assert.equal(clicked, 1);

  const missing = JSON.parse(Function('document', `return ${exprCreateAgentForWorkspace('G:\\\\project\\\\other')};`)(document));
  assert.equal(missing.ok, false);
  assert.equal(missing.state, 'repository_not_found');
  assert.deepEqual(missing.available, ['VESPERIX']);

  const ready = JSON.parse(Function('document', `return ${exprInspectWorkspaceRepository('G:\\\\project\\\\VESPERIX')};`)(document));
  assert.deepEqual(ready, { ok: true, state: 'repository_ready', workspace: 'vesperix' });
});

test('Cursor 3.16.17 Agents Window binds a repo by sidebar head when the legacy section wrapper is gone', () => {
  let clicked = 0;
  const newAgent = {
    getAttribute: (name) => name === 'aria-label' ? 'New Agent' : null,
    innerText: 'New Agent',
    click: () => { clicked++; },
  };
  const makeHead = (name, row) => {
    const head = {
      innerText: name,
      textContent: name,
      parentElement: row,
      querySelectorAll: () => [],
    };
    return head;
  };
  const makeRow = (name) => {
    const row = {
      parentElement: { parentElement: null, querySelectorAll: () => [] },
      querySelectorAll(selector) {
        if (selector === '.ui-sidebar-section-head') return [row.head];
        if (selector === 'button,[role=button]') return [newAgent];
        return [];
      },
    };
    row.head = makeHead(name, row);
    return row;
  };
  const bridgeRow = makeRow('cursor-bridge');
  const vesperixRow = makeRow('vesperix');
  const document = {
    querySelectorAll(selector) {
      if (selector === 'section.glass-sidebar-workspace-section-root') return [];
      if (selector === '.ui-sidebar-section-head') return [bridgeRow.head, vesperixRow.head];
      return [];
    },
  };

  const created = JSON.parse(Function('document', `return ${exprCreateAgentForWorkspace('G:\\\\u2dProject\\\\u6project\\\\VESPERIX')};`)(document));
  assert.equal(created.ok, true);
  assert.equal(created.workspace, 'vesperix');
  assert.equal(clicked, 1);

  const ready = JSON.parse(Function('document', `return ${exprInspectWorkspaceRepository('G:\\\\u2dProject\\\\u6project\\\\VESPERIX')};`)(document));
  assert.deepEqual(ready, { ok: true, state: 'repository_ready', workspace: 'vesperix' });

  const missing = JSON.parse(Function('document', `return ${exprInspectWorkspaceRepository('G:\\\\project\\\\other')};`)(document));
  assert.equal(missing.ok, false);
  assert.equal(missing.state, 'repository_not_found');
  assert.deepEqual(missing.available, ['cursor-bridge', 'vesperix']);
});

test('chat panel diagnostics distinguish actionable missing-input states', () => {
  const cases = [
    [{ signInControlVisible: true, signInVisible: true }, 'sign_in_required', 'sign_in_to_cursor'],
    [{ settingsOrCustomizeVisible: true, signInControlVisible: true, signInVisible: false, agentSurfaceVisible: true, composerCount: 0, pageTitle: 'Cursor Agents' }, 'settings_or_customize_open', 'complete_or_close_configuration'],
    [{ modalVisible: true, modalLabel: 'Configure MCP' }, 'modal_dialog_open', 'complete_or_close_dialog'],
    [{ visibilityState: 'hidden' }, 'cursor_window_unavailable', 'make_cursor_window_available'],
    [{ inputStateChanged: true, agentSurfaceVisible: true, composerCount: 1 }, 'input_state_changed', 'open_new_chat'],
    [{ visibilityState: 'visible' }, 'agent_chat_panel_not_open', 'open_agent_chat_panel'],
    [{ visibilityState: 'visible', agentSurfaceVisible: true, composerCount: 1 }, 'composer_input_unavailable', 'open_new_chat'],
  ];
  for (const [snapshot, state, needsAction] of cases) {
    const diagnostic = classifyChatPanelDiagnostic(snapshot);
    assert.equal(diagnostic.schemaVersion, 1);
    assert.equal(diagnostic.code, 'CURSOR_CHAT_PANEL_UNAVAILABLE');
    assert.equal(diagnostic.state, state);
    assert.equal(diagnostic.needsAction, needsAction);
    assert.equal(diagnostic.retryable, true);
    assert.match(diagnostic.nextStep, /Complete or close the current Customize\/Settings dialog/);
    assert.match(diagnostic.nextStep, /open Cursor's main Agent\/Chat panel or New Chat/);
    assert.match(diagnostic.nextStep, /retry the same request/);
  }
});

test('trusted prompt fill waits for Cursor to expose an exact send control', async () => {
  const bridge = new CursorBridge({
    runtimeFile: null,
    workspaceFile: null,
    modelPreferencesFile: null,
    sessionFile: null,
  });
  const snapshots = [
    JSON.stringify({ inputTextLength: 5, sendReady: false }),
    JSON.stringify({ inputTextLength: 5, sendReady: true }),
  ];
  const calls = [];
  const client = {
    async send(method, params) {
      calls.push({ method, params });
      if (method === 'Input.insertText') return {};
      const value = params.expression === EXPR_PREPARE_INPUT
        ? 'READY'
        : snapshots.shift() || JSON.stringify({ inputTextLength: 5, sendReady: true });
      return { result: { value } };
    },
  };

  assert.equal(await bridge._fillPrompt(client, 'hello', null, 250), 'hello');
  assert.deepEqual(calls.find((call) => call.method === 'Input.insertText').params, { text: 'hello' });

  const neverReady = {
    async send(method, params) {
      if (method === 'Input.insertText') return {};
      return { result: { value: params.expression === EXPR_PREPARE_INPUT
        ? 'READY'
        : JSON.stringify({ inputTextLength: 5, sendReady: false }) } };
    },
  };
  await assert.rejects(
    bridge._fillPrompt(neverReady, 'hello', null, 20),
    (error) => error.code === 'CURSOR_COMPOSER_NOT_SEND_READY'
      && error.confirmedNotSent === true
      && error.composerDiagnostic.inputTextLength === 5,
  );
});

test('missing chat input returns structured diagnostics without navigation or clicks', async () => {
  const bridge = new CursorBridge({ runtimeFile: null, workspaceFile: null });
  const calls = [];
  const client = {
    async send(method, params) {
      calls.push({ method, params });
      return {
        result: {
          value: JSON.stringify({
            writableInputVisible: false,
            settingsOrCustomizeVisible: true,
            modalVisible: true,
            signInControlVisible: true,
            signInVisible: false,
            modalLabel: 'Customize Cursor',
            visibilityState: 'visible',
            focused: true,
            pageTitle: 'Cursor Settings',
          }),
        },
      };
    },
  };

  let failure;
  try {
    await bridge._ensureChatPanel(client);
  } catch (error) {
    failure = error;
  }
  assert.ok(failure);
  assert.equal(failure.code, 'CURSOR_CHAT_PANEL_UNAVAILABLE');
  assert.equal(failure.uiDiagnostic.state, 'settings_or_customize_open');
  assert.deepEqual(calls.map((call) => call.method), ['Runtime.evaluate']);

  const result = toolErrorResult(failure);
  const payload = JSON.parse(result.content[0].text);
  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent, payload);
  assert.equal(payload.error.code, 'CURSOR_CHAT_PANEL_UNAVAILABLE');
  assert.equal(payload.uiDiagnostic.state, 'settings_or_customize_open');
  assert.equal(payload.uiDiagnostic.evidence.modalLabel, 'Customize Cursor');
  assert.equal(payload.uiDiagnostic.evidence.signInControlVisible, true);
  assert.equal(payload.uiDiagnostic.evidence.signInVisible, false);

  const job = { id: 'task-panel-diag', kind: 'do', status: 'running', phase: 'running', settled: true };
  bridge._failJob(job, failure);
  assert.equal(job.status, 'failed');
  assert.equal(bridge._taskView(job).uiDiagnostic.state, 'settings_or_customize_open');

  const modalCalls = [];
  await assert.rejects(
    bridge._ensureChatPanel({
      async send(method) {
        modalCalls.push(method);
        return { result: { value: JSON.stringify({ hasWritableInput: true, modalVisible: true, modalLabel: 'Confirm' }) } };
      },
    }),
    (error) => error.uiDiagnostic.state === 'modal_dialog_open',
  );
  assert.deepEqual(modalCalls, ['Runtime.evaluate']);

  const raceCalls = [];
  await assert.rejects(
    bridge._throwChatPanelUnavailableAfterNoInput({
      async send(method) {
        raceCalls.push(method);
        return { result: { value: JSON.stringify({ hasWritableInput: true, agentSurfaceVisible: true, composerCount: 1 }) } };
      },
    }),
    (error) => error.uiDiagnostic.state === 'input_state_changed',
  );
  assert.deepEqual(raceCalls, ['Runtime.evaluate']);
});

test('Cursor Agents v2 React adapter normalizes headers and opens by header identity', async () => {
  const selected = [];
  class ReactiveValue {
    constructor(value) { this._value = value; }
    get value() { return this._value; }
  }
  const headers = [
    {
      id: new ReactiveValue('agent-a'),
      name: new ReactiveValue('Alpha'),
      status: new ReactiveValue('in_progress'),
      lastUpdatedAt: new ReactiveValue(100),
    },
    {
      id: new ReactiveValue('agent-b'),
      name: new ReactiveValue('Beta'),
      status: new ReactiveValue('done'),
      lastUpdatedAt: new ReactiveValue(200),
    },
  ];
  const root = {
    parentElement: null,
    '__reactProps$test': {
      section: { headers },
      selectedAgentId: new ReactiveValue('agent-a'),
      onSelectAgent(header) { selected.push(header); },
    },
  };
  const document = {
    querySelectorAll(selector) {
      if (selector === '.glass-sidebar-agent-list-container') return [root];
      if (selector === '.compact-agent-history-react-menu-label') return [];
      return [];
    },
  };

  const snapshot = JSON.parse(Function('document', `return ${EXPR_HISTORY_ENTRIES};`)(document));
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.kind, 'agents_v2');
  assert.deepEqual(
    snapshot.entries.map((entry) => [
      entry.id,
      entry.label,
      entry.timestamp,
      entry.isSelected,
      entry.showSpinner,
      entry.icon,
    ]),
    [
      ['local:agent-a', 'Alpha', 100, true, true, 'loading'],
      ['local:agent-b', 'Beta', 200, false, false, 'check-circled'],
    ],
  );
  assert.equal(await Function('document', `return ${exprOpenAgent('local:agent-b')};`)(document), 'OPENED');
  assert.equal(selected[0], headers[1]);
});

test('Cursor Agents v2 React adapter supports Cursor 3.17 split row handlers', async () => {
  const selected = [];
  class ReactiveValue {
    constructor(value) { this._value = value; }
    get value() { return this._value; }
  }
  const headers = [
    {
      id: new ReactiveValue('agent-317-a'),
      name: new ReactiveValue('Cursor 3.17 Alpha'),
      status: new ReactiveValue('completed'),
      lastUpdatedAt: new ReactiveValue(31700),
    },
    {
      id: new ReactiveValue('agent-317-b'),
      name: new ReactiveValue('Cursor 3.17 Beta'),
      status: new ReactiveValue('in_progress'),
      lastUpdatedAt: new ReactiveValue(31701),
    },
  ];
  const root = {
    parentElement: null,
    '__reactProps$test': {
      section: { id: 'workspace:cursor-bridge', headers },
      committedSelectedAgentId: new ReactiveValue('agent-317-a'),
      rowHandlers: {
        onSelect(header, event) { selected.push([header, event]); },
      },
    },
  };
  const document = {
    querySelectorAll(selector) {
      if (selector === '.glass-sidebar-agent-list-container') return [root];
      if (selector === '.compact-agent-history-react-menu-label') return [];
      return [];
    },
  };

  const snapshot = JSON.parse(Function('document', `return ${EXPR_HISTORY_ENTRIES};`)(document));
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.kind, 'agents_v2');
  assert.deepEqual(
    snapshot.entries.map((entry) => [entry.id, entry.label, entry.isSelected]),
    [
      ['local:agent-317-a', 'Cursor 3.17 Alpha', true],
      ['local:agent-317-b', 'Cursor 3.17 Beta', false],
    ],
  );
  assert.equal(await Function('document', `return ${exprOpenAgent('local:agent-317-b')};`)(document), 'OPENED');
  assert.equal(selected.length, 1);
  assert.equal(selected[0][0], headers[1]);
  assert.equal(selected[0][1], undefined);
});

test('Cursor Agents v2 React adapter exposes a selected 3.17 draft before History inserts it', async () => {
  const selected = [];
  const headers = [
    {
      id: 'existing-agent',
      name: 'Existing Agent',
      status: 'completed',
      lastUpdatedAt: 100,
    },
  ];
  const composer = {
    dataset: {
      composerId: 'draft-agent',
      composerStatus: 'completed',
    },
    offsetParent: {},
  };
  const root = {
    parentElement: null,
    '__reactProps$test': {
      section: { id: 'workspace:cursor-bridge', headers },
      selectedAgentId: 'draft-agent',
      rowHandlers: {
        onSelect(header) { selected.push(header); },
      },
    },
  };
  const document = {
    querySelectorAll(selector) {
      if (selector === '.glass-sidebar-agent-list-container') return [root];
      if (selector === '.composer-bar[data-composer-id]') return [composer];
      if (selector === '.compact-agent-history-react-menu-label') return [];
      return [];
    },
  };

  const snapshot = JSON.parse(Function('document', `return ${EXPR_HISTORY_ENTRIES};`)(document));
  assert.equal(snapshot.ok, true);
  assert.deepEqual(
    snapshot.entries.map((entry) => [entry.id, entry.isSelected, entry.showSpinner, entry.icon]),
    [
      ['local:existing-agent', false, false, 'check-circled'],
      ['local:draft-agent', true, false, 'check-circled'],
    ],
  );
  assert.equal(await Function('document', `return ${exprOpenAgent('local:draft-agent')};`)(document), 'OPENED');
  assert.equal(selected.length, 0);
});

test('Cursor 3.17.21 section map keeps draft Agents addressable before headers insert them', async () => {
  const selected = [];
  const globalProps = {
    sectionIdByAgentId: new Map([
      ['draft-a', 'repo:github.com/vanyangyang/cursor-bridge'],
      ['draft-b', 'repo:github.com/vanyangyang/cursor-bridge'],
    ]),
    selectedAgentId: 'draft-b',
    async onSelectAgent(id, options) {
      selected.push([id, options]);
      globalProps.selectedAgentId = id;
      return true;
    },
  };
  const global = {
    parentElement: null,
    '__reactProps$global': globalProps,
  };
  const root = {
    parentElement: global,
    '__reactProps$section': {
      section: { id: 'repo:github.com/vanyangyang/cursor-bridge', headers: [] },
      selectedAgentId: 'draft-b',
      rowHandlers: { onSelect() {} },
    },
  };
  const composer = {
    dataset: { composerId: 'draft-b', composerStatus: 'completed' },
    offsetParent: {},
  };
  const document = {
    querySelectorAll(selector) {
      if (selector === '.glass-sidebar-agent-list-container') return [root];
      if (selector === '.composer-bar[data-composer-id]') return [composer];
      if (selector === '.compact-agent-history-react-menu-label') return [];
      return [];
    },
  };

  const snapshot = JSON.parse(Function('document', `return ${EXPR_HISTORY_ENTRIES};`)(document));
  assert.deepEqual(snapshot.entries.map((entry) => [
    entry.id, entry.isSelected, entry.icon, entry.durable, entry.registeredBySectionMap,
  ]), [
    ['local:draft-b', true, 'check-circled', true, true],
    ['local:draft-a', false, 'registered', true, true],
  ]);
  assert.equal(await Function('document', `return ${exprOpenAgent('local:draft-a')};`)(document), 'OPENED');
  assert.deepEqual(selected, [['draft-a', { preserveSidebarAction: true }]]);
  const selectedSnapshot = JSON.parse(Function('document', `return ${EXPR_HISTORY_ENTRIES};`)(document));
  assert.deepEqual(selectedSnapshot.entries.map((entry) => [entry.id, entry.isSelected]), [
    ['local:draft-a', true],
    ['local:draft-b', false],
  ]);
});

test('provider error tray expression extracts terminal evidence without clicking controls', () => {
  const titleNode = { innerText: 'LLM provider error' };
  const buttons = [
    { innerText: 'Copy ID' },
    { innerText: 'Try again' },
  ];
  const tray = {
    innerText: [
      'LLM provider error',
      'Connection error. Request ID: 0238f19d-7066-41c8-8ea9-6d5c69ccdc8d',
      'Copy ID',
      'Try again',
    ].join('\n'),
    querySelector(selector) {
      return selector === '.ui-tray-header__title' ? titleNode : null;
    },
    querySelectorAll(selector) {
      return selector === 'button' ? buttons : [];
    },
  };
  const document = {
    querySelectorAll(selector) {
      return selector === '.ui-tray.ui-notification-tray[data-visible="true"]' ? [tray] : [];
    },
  };

  const result = JSON.parse(Function('document', `return ${EXPR_PROVIDER_ERROR};`)(document));
  assert.equal(result.found, true);
  assert.equal(result.title, 'LLM provider error');
  assert.equal(result.message, 'Connection error. Request ID: 0238f19d-7066-41c8-8ea9-6d5c69ccdc8d');
  assert.equal(result.requestId, '0238f19d-7066-41c8-8ea9-6d5c69ccdc8d');
  assert.equal(result.retryAvailable, true);
  assert.equal(providerErrorSignature(result), result.signature);
  assert.doesNotMatch(EXPR_PROVIDER_ERROR, /\.click\(/);

  const error = createProviderError(result);
  assert.equal(error.sent, true);
  assert.equal(error.confirmedTerminal, true);
  assert.equal(error.providerError.requestId, result.requestId);
  assert.match(error.terminalEvidence, /provider_error_tray:0238f19d/);
});

test('provider error tray expression supports Cursor 3.16 hashed header classes', () => {
  const buttons = [
    { innerText: 'Copy ID' },
    { innerText: 'Try again' },
  ];
  const tray = {
    innerText: [
      'LLM provider error',
      'Connection error. Request ID: cursor-3-16-request',
      'Copy ID',
      'Try again',
    ].join('\n'),
    querySelector() {
      return null;
    },
    querySelectorAll(selector) {
      return selector === 'button' ? buttons : [];
    },
  };
  const document = {
    querySelectorAll(selector) {
      return selector === '.ui-tray.ui-notification-tray[data-visible="true"]' ? [tray] : [];
    },
  };

  const result = JSON.parse(Function('document', `return ${EXPR_PROVIDER_ERROR};`)(document));
  assert.equal(result.found, true);
  assert.equal(result.title, 'LLM provider error');
  assert.equal(result.message, 'Connection error. Request ID: cursor-3-16-request');
  assert.equal(result.requestId, 'cursor-3-16-request');
  assert.equal(result.retryAvailable, true);
  assert.doesNotMatch(EXPR_PROVIDER_ERROR, /\.click\(/);
});

test('Agents workspace recovery clears stale failure guidance before reporting ready', () => {
  const promoted = promoteAgentsWorkspaceLifecycle({
    status: 'workspace-not-ready',
    projectPath: 'G:\\project\\VESPERIX',
    message: 'old failure',
    needsAction: 'retry_initialization',
    nextStep: 'old retry',
    retryable: true,
  }, {
    targetId: 'agents-target',
    targetUiFlavor: 'agents_v2',
    workspace: 'VESPERIX',
  });
  assert.equal(promoted.status, 'agents-workspace-ready');
  assert.equal(promoted.targetId, 'agents-target');
  assert.equal(promoted.needsAction, null);
  assert.equal(promoted.nextStep, null);
  assert.equal(promoted.retryable, false);
  assert.doesNotMatch(promoted.message, /old failure|old retry/);
});

class OfflineBridge extends CursorBridge {
  constructor(options = {}) {
    super({ runtimeFile: null, workspaceFile: null, modelPreferencesFile: null, sessionFile: null, runtimeMode: 'normal', ...options });
  }

  async _ensureCursor() {}
  _drain() {}
}

class SearchProbeBridge extends OfflineBridge {
  constructor() {
    super();
    this.ensureCalls = 0;
    this.searchJobs = [];
  }

  async _ensureCursor() {
    this.ensureCalls++;
  }

  _enqueue(kind, prompt, options) {
    this.searchJobs.push({ kind, prompt, options });
    return {
      promise: Promise.resolve('preamble\nCCE_SEARCH_RESULT intent: probe\nevidence:\n- server.mjs:1-2 | probe | evidence | exact\ngaps: none\nconfidence: high'),
    };
  }
}

class TaskControlBridge extends OfflineBridge {
  constructor(options = {}) {
    super(options);
    this.entrySnapshots = [];
    this.collectResult = 'recovered result';
    this.collectError = null;
    this.stopResult = { confirmed: true, clicked: true, state: 'stopped' };
    this.monitorStarts = 0;
  }

  async _readParallelEntry() {
    if (this.entrySnapshots.length === 0) return null;
    if (this.entrySnapshots.length === 1) return this.entrySnapshots[0];
    return this.entrySnapshots.shift();
  }

  async _collectParallelAgent() {
    if (this.collectError) throw this.collectError;
    return this.collectResult;
  }

  async _stopParallelAgent() {
    return this.stopResult;
  }

  _startParallelMonitor(job) {
    this.monitorStarts++;
    job.monitorAttached = true;
    return true;
  }

  _maybeRestoreParallelOrigin() {}
}

class DeferredSubmitBridge extends CursorBridge {
  constructor() {
    super({ runtimeFile: null, runtimeMode: 'normal' });
    this.stopCalls = 0;
    this.monitorStarts = 0;
    this.submitStarted = new Promise((resolve) => { this._markSubmitStarted = resolve; });
    this.submitGate = new Promise((resolve) => { this._resolveSubmit = resolve; });
  }

  async _ensureCursor() {}
  async _submitParallelAgent(job) {
    job.agentId = 'local:prebound-before-return';
    job.agentLabel = 'prebound';
    this._markSubmitStarted();
    return this.submitGate;
  }
  async _stopParallelAgent() {
    this.stopCalls++;
    return { confirmed: true, clicked: true, state: 'stopped' };
  }
  _startParallelMonitor() {
    this.monitorStarts++;
    return true;
  }
  _maybeRestoreParallelOrigin() {}
}

class MonitorGenerationBridge extends OfflineBridge {
  constructor() {
    super();
    this.gates = new Map();
  }

  _monitorParallelAgent(job, generation) {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    this.gates.set(generation, { promise, resolve });
    return promise;
  }
}

class SentFifoFailureBridge extends CursorBridge {
  constructor() {
    super({ runtimeFile: null, runtimeMode: 'normal' });
  }

  async _ensureCursor() {}
  async _run() {
    const error = new Error('post-send response unavailable');
    error.sent = true;
    throw error;
  }
  _maybeRestoreParallelOrigin() {}
}

class ConfirmedFifoFailureBridge extends CursorBridge {
  constructor() {
    super({ runtimeFile: null, runtimeMode: 'normal' });
  }

  async _ensureCursor() {}
  async _run() {
    throw createProviderError({
      found: true,
      title: 'LLM provider error',
      message: 'Connection error. Request ID: confirmed-request-id',
      requestId: 'confirmed-request-id',
      retryAvailable: true,
      signature: 'LLM provider error|Connection error|confirmed-request-id',
    });
  }
  _maybeRestoreParallelOrigin() {}
}

class CancellableFifoBridge extends CursorBridge {
  constructor({ fallback = false } = {}) {
    super({ runtimeFile: null, runtimeMode: 'normal' });
    this.fallback = fallback;
    this.runStarted = new Promise((resolve) => { this._markRunStarted = resolve; });
  }

  async _ensureCursor() {}
  async _submitParallelAgent() {
    return { fallbackReason: this.fallback ? 'parallel capability unavailable' : null };
  }
  async _run(prompt, job) {
    this._markRunStarted();
    while (!job.cancelRequested) await new Promise((resolve) => setTimeout(resolve, 1));
    const error = new Error(job.cancelReason || 'cancelled');
    error.cancelled = true;
    error.stopConfirmed = false;
    error.sent = true;
    throw error;
  }
  _maybeRestoreParallelOrigin() {}
}

function makeOrphan(bridge, view, options = {}) {
  const job = bridge.tasks.get(view.taskId);
  bridge.queue = bridge.queue.filter((candidate) => candidate.id !== job.id);
  job.status = 'running';
  job.phase = 'running';
  job.startedAt = new Date().toISOString();
  job.agentId = options.agentId === undefined ? 'local:test-agent' : options.agentId;
  bridge._orphanParallelJob(job, new Error(options.error || 'history unavailable'));
  return job;
}

async function openBundledClient(serverPath, env, name) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env,
  });
  const client = new Client({ name, version: '1.0.0' });
  await client.connect(transport);
  return client;
}

test('allowed path normalization and prefix overlap are deterministic', () => {
  assert.equal(normalizeAllowedPath('Assets\\Scripts\\'), 'assets/scripts');
  assert.equal(normalizeAllowedPath('./Assets//Scripts/../Scripts/Battle'), 'assets/scripts/battle');
  assert.equal(pathsOverlap('Assets/Scripts', 'assets/scripts/Battle'), true);
  assert.equal(pathsOverlap('Assets/Foo', './Assets/Bar/../Foo'), true);
  assert.equal(pathsOverlap('Assets/Scripts/A', 'Assets/Scripts/B'), false);
  assert.equal(pathsOverlap('.', 'Assets/Scripts'), true);
});

test('delegation mode recognizes only explicit off and otherwise stays enabled', () => {
  assert.equal(normalizeDelegationMode('off'), 'off');
  assert.equal(normalizeDelegationMode(' OFF '), 'off');
  assert.equal(normalizeDelegationMode('on'), 'on');
  assert.equal(normalizeDelegationMode('false'), 'on');
  assert.equal(normalizeDelegationMode(''), 'on');
});

test('normal runtime is the fresh default and minimal remains an explicit persistent opt-in', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'cursor-bridge-runtime-view-'));
  const runtimeFile = join(directory, 'runtime.json');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const first = new OfflineBridge({ runtimeFile, runtimeMode: undefined });
  const peer = new OfflineBridge({ runtimeFile, runtimeMode: undefined });
  assert.equal(first.runtimeMode, 'normal');
  assert.equal(first.runtimeModeDefault, 'normal');
  assert.equal(first.runtimeModeSource, 'default');
  assert.equal(first.runtimeModeScope, 'default');
  first.applyRuntimePresentation = async (action) => ({ supported: true, applied: false, action, reason: 'offline-test' });
  const enabled = await first.setRuntimeMode('minimal');
  assert.deepEqual(CURSOR_RUNTIME_MODES, ['normal', 'minimal']);
  assert.equal(enabled.runtimeMode, 'minimal');
  assert.equal(enabled.startupBehavior, 'hidden_prewarm_on_adapter_start');
  assert.equal(enabled.modeStored, true);
  assert.equal(enabled.presentation.action, 'hide');
  assert.match(enabled.minimalModeWarning, /Switch CCE to normal mode/i);
  assert.match(enabled.recovery, /switch CCE to normal mode/i);
  assert.equal(peer.runtimeModeView().runtimeMode, 'minimal');
  assert.equal(peer.runtimeModeSource, 'persistent');

  const restored = await first.setRuntimeMode('normal');
  assert.equal(restored.previousMode, 'minimal');
  assert.equal(restored.presentation.action, 'show');
  assert.equal(restored.minimalModeWarning, null);
  assert.equal(peer.runtimeModeView().runtimeMode, 'normal');

  const restarted = new OfflineBridge({ runtimeFile, runtimeMode: undefined });
  assert.equal(restarted.runtimeMode, 'normal');
  assert.equal(restarted.runtimeModeSource, 'persistent');
  assert.equal(restarted.runtimeModeView().persistsAcrossRestart, true);
});

test('cursor_init keeps a valid binding and returns child-friendly recovery when Cursor needs one safe restart', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'cursor-bridge-init-recovery-'));
  const project = join(directory, 'project');
  const workspaceFile = join(directory, 'state', 'workspaces.json');
  mkdirSync(project, { recursive: true });
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  class InitRecoveryBridge extends CursorBridge {
    constructor() {
      super({ runtimeFile: null, workspaceFile, workspaceKey: 'test-host', runtimeMode: 'normal' });
    }

    async _ensureCursor() {
      this._lastLifecycle = {
        status: 'running-no-debug',
        message: 'Cursor was already running.',
        nextStep: 'Save your work, exit Cursor normally once, then repeat initialization.',
        retryable: true,
      };
      throw new Error(this._lastLifecycle.message);
    }
  }

  const result = await new InitRecoveryBridge().initializeWorkspace(project);
  assert.equal(result.initialized, true);
  assert.equal(result.bindingPersisted, true);
  assert.equal(result.ready, false);
  assert.equal(result.status, 'running-no-debug');
  assert.equal(result.projectPath, project);
  assert.equal(result.retryable, true);
  assert.match(result.nextStep, /exit Cursor normally once/);
});

test('unified CCE prompt lets Cursor choose the minimum sufficient investigation depth', () => {
  const query = '谁负责计算最终伤害并如何进入最终结算？重点关注 Assets/Scripts/Battle。';
  const prompt = buildContextEnginePrompt(query);
  assert.match(prompt, /Cursor Context Engine \(CCE\)/);
  assert.match(prompt, /Search before answering/);
  assert.match(prompt, /Choose the search depth/);
  assert.match(prompt, /Explore or subagents/);
  assert.match(prompt, /does not prescribe Cursor's internal harness/);
  assert.match(prompt, /minimum sufficient evidence/);
  assert.match(prompt, /NOT_FOUND/);
  assert.match(prompt, /Assets\/Scripts\/Battle/);
  assert.match(prompt, /clue, not a hard boundary/);
  assert.match(prompt, /language of the user query/);
  assert.match(prompt, new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(prompt, /coverage: <focused\|extended>/);
  assert.match(prompt, /workspace-relative-path/);
  assert.match(prompt, /confidence: <high\|medium\|low>/);
});

test('CCE and cursor_do scaffolds preserve multilingual user text and request matching-language replies', async () => {
  const samples = [
    '请定位最终伤害的所有者。',
    'Locate the owner of final damage.',
    '最終ダメージの所有者を特定してください。',
    'حدد مالك الضرر النهائي.',
  ];
  for (const sample of samples) {
    const ccePrompt = buildContextEnginePrompt(sample);
    assert.equal(ccePrompt.includes(sample), true);
    assert.match(ccePrompt, /Write narrative output in the language of the user query/);

    const bridge = new OfflineBridge();
    const view = await bridge.doTask(sample);
    const delegatedPrompt = bridge.tasks.get(view.taskId).prompt;
    assert.equal(delegatedPrompt.startsWith(sample), true);
    assert.match(delegatedPrompt, /Reply in the language of the user task/);
  }

  const customBridge = new OfflineBridge();
  const custom = await customBridge.doTask('日本語で結果を返してください。', {
    completionContract: 'Return one verified result.',
  });
  const customPrompt = customBridge.tasks.get(custom.taskId).prompt;
  assert.match(customPrompt, /Reply in the language of the user task/);
  assert.match(customPrompt, /Acceptance and reporting contract:\nReturn one verified result\./);
});

test('unified context engine reuses readiness, FIFO, read-only options, and result normalization', async () => {
  const bridge = new SearchProbeBridge();
  const result = await bridge.contextEngine('trace caller to storage, starting from src');
  assert.equal(bridge.ensureCalls, 1);
  assert.deepEqual(bridge.searchJobs.map((job) => job.kind), ['context_engine']);
  for (const job of bridge.searchJobs) {
    assert.equal(job.options.execution, 'fifo');
    assert.equal(job.options.readOnly, true);
    assert.deepEqual(job.options.allowedPaths, []);
    assert.equal(job.options.newChat, true);
  }
  assert.equal(result.startsWith('CCE_SEARCH_RESULT\nintent:'), true);
});

test('CCE result normalization removes conversational preamble without inventing evidence', () => {
  const raw = '先解释一段。\n\nCCE_SEARCH_RESULT intent: locate owner\nevidence:\n- a.js:1-2 | fn | owner | exact\ngaps: none\nconfidence: high';
  const normalized = normalizeCceSearchResult(raw);
  assert.equal(normalized.startsWith('CCE_SEARCH_RESULT\nintent:'), true);
  assert.doesNotMatch(normalized, /先解释/);
  const compact = normalizeCceSearchResult('CCE_SEARCH_RESULT intent: locate owner coverage: focused | enough evidence: - a.js:1-2 | fn | owner | exact gaps: none confidence: high');
  assert.match(compact, /intent: locate owner\ncoverage:/);
  assert.match(compact, /\nevidence:/);
  assert.match(compact, /\ngaps: none\nconfidence: high/);
  const unbulleted = normalizeCceSearchResult('CCE_SEARCH_RESULT\nintent: locate owner\ncoverage: focused | enough\nevidence:\nserver.mjs:76-91 | buildContextEnginePrompt | owner | source-read\ngaps: none\nconfidence: high');
  assert.match(unbulleted, /\nevidence:\n- server\.mjs:76-91 \|/);
  assert.equal(normalizeCceSearchResult('legacy result'), 'legacy result');
});

test('CCE tool description states real capabilities and explicit limits', () => {
  const bridge = new OfflineBridge();
  const tools = buildToolDefinitions(bridge);
  const search = tools.find((tool) => tool.name === 'cursor_context_engine');
  const init = tools.find((tool) => tool.name === 'cursor_init');
  const runtime = tools.find((tool) => tool.name === 'cursor_runtime');
  assert.match(search.description, /Cursor Context Engine \(CCE\)/);
  assert.match(search.description, /unknown implementation location/);
  assert.match(search.description, /known exact file or symbol can answer the question through direct reading or exact search/);
  assert.match(search.description, /semantic retrieval/);
  assert.match(search.description, /autonomously chooses/);
  assert.match(search.description, /call chains/);
  assert.match(search.description, /minimum sufficient context/);
  assert.match(search.description, /NOT_FOUND/);
  assert.match(search.description, /not a filesystem sandbox/);
  assert.deepEqual(Object.keys(search.inputSchema.properties), ['query']);
  assert.deepEqual(Object.keys(init.inputSchema.properties), ['path']);
  assert.deepEqual(init.inputSchema.required, ['path']);
  assert.match(init.description, /never force-closes Cursor/);
  assert.match(init.description, /Agents Window/);
  assert.match(init.description, /instead of Home/);
  assert.equal(tools.some((tool) => tool.name === 'cursor_search'), false);
  assert.equal(tools.some((tool) => tool.name === 'cursor_search_deep'), false);
  assert.deepEqual(runtime.inputSchema.properties.mode.enum, ['normal', 'minimal']);
  assert.deepEqual(Object.keys(runtime.inputSchema.properties), ['mode']);
  assert.deepEqual(runtime.inputSchema.required, ['mode']);
  assert.match(runtime.description, /UI suppression, not a headless reimplementation/);
  const cursorDo = tools.find((tool) => tool.name === 'cursor_do');
  assert.match(cursorDo.description, /first in, first out/);
  assert.equal(Object.hasOwn(cursorDo.inputSchema.properties, 'new_chat'), false);
  assert.deepEqual(cursorDo.inputSchema.properties.session_mode.enum, ['isolated', 'create', 'continue']);
  assert.ok(cursorDo.inputSchema.properties.session_id);
  assert.ok(cursorDo.inputSchema.properties.request_id);
  const sessionControl = tools.find((tool) => tool.name === 'cursor_session_control');
  assert.deepEqual(sessionControl.inputSchema.properties.action.enum, ['reconcile', 'collect_result', 'close', 'forget', 'abandon']);
  const status = tools.find((tool) => tool.name === 'cursor_status');
  assert.deepEqual(Object.keys(status.inputSchema.properties), ['task_id', 'session_id']);
  assert.equal(tools.some((tool) => tool.name === 'cursor_launch'), false);
});

test('timeout completion rejects a generating partial reply and accepts confirmed stopped evidence', () => {
  assert.equal(isConfirmedCompletedReply({
    answer: 'reply with unknown final state',
    snapshot: null,
    sawStop: true,
    baselineCount: 10,
  }), false);
  assert.equal(isConfirmedCompletedReply({
    answer: 'partial markdown',
    snapshot: { stop: 1, messageCount: 12, replyLength: 16 },
    sawStop: true,
    baselineCount: 10,
  }), false);
  assert.equal(isConfirmedCompletedReply({
    answer: 'complete reply',
    snapshot: { stop: 0, messageCount: 12, replyLength: 14 },
    sawStop: true,
    baselineCount: 10,
  }), true);
  assert.equal(isConfirmedCompletedReply({
    answer: 'stable reply without sampled stop',
    snapshot: { stop: 0, messageCount: 12, replyLength: 33 },
    sawStop: false,
    baselineCount: 10,
  }), true);
});

test('disabled delegation rejects cursor_do before Cursor access', async () => {
  const bridge = new OfflineBridge({ delegationMode: 'off' });
  assert.equal(bridge.delegationEnabled, false);
  await assert.rejects(bridge.doTask('must not delegate'), /CURSOR_BRIDGE_DELEGATION=off/);
  const missing = await bridge.status('cursor-missing');
  assert.equal(missing.delegationMode, 'off');
  assert.equal(missing.delegationEnabled, false);
  assert.equal(missing.environmentLockedOff, true);
});

test('bundled MCP hides cursor_do in off mode and rejects direct calls', async (t) => {
  const serverPath = fileURLToPath(new URL('../dist/cursor-bridge.mjs', import.meta.url));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: {
      ...process.env,
      CURSOR_BRIDGE_DELEGATION: 'off',
      CURSOR_BRIDGE_NO_AUTOLAUNCH: '1',
      CURSOR_BRIDGE_CDP_PORT: '1',
    },
  });
  const client = new Client({ name: 'cursor-bridge-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.equal(listed.tools.some((tool) => tool.name === 'cursor_do'), false);
    assert.equal(listed.tools.some((tool) => tool.name === 'cursor_context_engine'), true);
    assert.equal(listed.tools.some((tool) => tool.name === 'cursor_init'), true);
    assert.equal(listed.tools.some((tool) => tool.name === 'cursor_search'), false);
    assert.equal(listed.tools.some((tool) => tool.name === 'cursor_search_deep'), false);
    assert.equal(listed.tools.some((tool) => tool.name === 'cursor_task_control'), true);
    assert.equal(listed.tools.some((tool) => tool.name === 'cursor_policy'), false);
    assert.equal(listed.tools.some((tool) => tool.name === 'cursor_runtime'), true);
    assert.equal(listed.tools.some((tool) => tool.name === 'cursor_launch'), false);
    const search = listed.tools.find((tool) => tool.name === 'cursor_context_engine');
    assert.match(search.description, /Cursor Context Engine \(CCE\)/);
    assert.equal(Object.keys(search.inputSchema.properties).length, 1);
    assert.equal(Object.hasOwn(search.inputSchema.properties, 'max_results'), false);
    const runtime = listed.tools.find((tool) => tool.name === 'cursor_runtime');
    assert.deepEqual(Object.keys(runtime.inputSchema.properties), ['mode']);
    assert.deepEqual(runtime.inputSchema.required, ['mode']);
    const runtimeStatus = await client.callTool({ name: 'cursor_runtime', arguments: {} });
    assert.notEqual(runtimeStatus.isError, true);
    assert.ok(['normal', 'minimal'].includes(JSON.parse(runtimeStatus.content[0].text).runtimeMode));
    const hiddenShow = await client.callTool({ name: 'cursor_runtime', arguments: { action: 'show' } });
    assert.notEqual(hiddenShow.isError, true);
    assert.equal(JSON.parse(hiddenShow.content[0].text).presentation.action, 'show');
    const taskControl = listed.tools.find((tool) => tool.name === 'cursor_task_control');
    assert.deepEqual(taskControl.inputSchema.properties.action.enum, ['reap', 'cancel', 'abandon']);
    const missingTask = await client.callTool({
      name: 'cursor_task_control',
      arguments: { task_id: 'cursor-missing', action: 'reap' },
    });
    assert.equal(JSON.parse(missingTask.content[0].text).found, false);
    const blocked = await client.callTool({ name: 'cursor_do', arguments: { prompt: 'must not run' } });
    assert.equal(blocked.isError, true);
    assert.match(blocked.content[0].text, /CURSOR_BRIDGE_DELEGATION=off/);
  } finally {
    await client.close();
  }
});

test('bundled MCP exposes a fixed cursor_do contract without cursor_policy', async () => {
  const serverPath = fileURLToPath(new URL('../dist/cursor-bridge.mjs', import.meta.url));
  const env = {
    ...process.env,
    CURSOR_BRIDGE_DELEGATION: 'on',
    CURSOR_BRIDGE_NO_AUTOLAUNCH: '1',
  };

  const first = await openBundledClient(serverPath, env, 'cursor-bridge-fixed-contract');
  try {
    const listed = await first.listTools();
    assert.equal(listed.tools.some((tool) => tool.name === 'cursor_do'), true);
    assert.equal(listed.tools.some((tool) => tool.name === 'cursor_policy'), false);
    const cursorDo = listed.tools.find((tool) => tool.name === 'cursor_do');
    assert.match(cursorDo.description, /direct user opt-out always wins/i);
    assert.match(cursorDo.description, /first in, first out/i);
    assert.equal(Object.hasOwn(cursorDo.inputSchema.properties, 'new_chat'), false);
    assert.deepEqual(cursorDo.inputSchema.properties.session_mode.enum, ['isolated', 'create', 'continue']);
    assert.equal(listed.tools.some((tool) => tool.name === 'cursor_session_control'), true);
    assert.doesNotMatch(cursorDo.description, /manual|auto|active|eager|participation policy/i);
    const status = await first.callTool({ name: 'cursor_status', arguments: { task_id: 'cursor-missing' } });
    const view = JSON.parse(status.content[0].text);
    assert.equal(view.delegationMode, 'on');
    assert.equal(view.delegationEnabled, true);
    assert.equal(Object.hasOwn(view, 'policy'), false);
  } finally {
    await first.close();
  }
});

test('new agent selection uses ID diff, selected entry, then newest timestamp', () => {
  const before = [{ id: 'local:old' }];
  assert.equal(selectNewAgentEntry(before, before), null);
  assert.equal(selectNewAgentEntry(before, [
    ...before,
    { id: 'local:a', timestamp: 20, isSelected: false },
    { id: 'local:b', timestamp: 10, isSelected: true },
  ]).id, 'local:b');
  assert.equal(selectNewAgentEntry(before, [
    ...before,
    { id: 'local:a', timestamp: 20, isSelected: false },
    { id: 'local:b', timestamp: 10, isSelected: false },
  ]).id, 'local:a');
});

test('parallel agent identity stays provisional until one durable row is confirmed', () => {
  const before = [{ id: 'local:old' }];
  const draft = { id: 'local:abc', timestamp: 20, isSelected: true, durable: false, icon: '' };
  assert.equal(selectUniqueNewAgentEntry(before, [...before, draft]).id, 'local:abc');
  assert.equal(selectPromotedParallelEntry(before, 'local:abc', [...before, draft]), null);

  const runningDraft = { ...draft, durable: true, showSpinner: true };
  assert.equal(selectPromotedParallelEntry(before, 'local:abc', [...before, runningDraft]).id, 'local:abc');

  const durableId = { id: 'abc', timestamp: 30, isSelected: true, durable: true, showSpinner: true };
  assert.equal(selectPromotedParallelEntry(before, 'local:abc', [...before, durableId]).id, 'abc');

  const unrelated = { id: 'local:other', timestamp: 40, isSelected: true, durable: true, showSpinner: true };
  assert.equal(selectPromotedParallelEntry(before, 'local:abc', [...before, draft, unrelated]), null);
  assert.equal(selectUniqueNewAgentEntry(before, [...before, draft, unrelated]), null);
});

test('parallel task status never publishes a draft identity as agentId', async () => {
  const bridge = new OfflineBridge();
  const view = await bridge.doTask('只读草稿身份', { execution: 'parallel_agent', readOnly: true });
  const job = bridge.tasks.get(view.taskId);
  job.status = 'running';
  job.phase = 'submitting';
  job.provisionalAgentId = 'local:draft';
  const submitting = bridge._taskView(job);
  assert.equal(submitting.agentId, null);
  assert.equal(submitting.provisionalAgentId, 'local:draft');
});

test('cursor_do defaults to FIFO and keeps background task identity', async () => {
  const bridge = new OfflineBridge();
  const view = await bridge.doTask('检查一个明确任务', { newChat: false });
  assert.equal(view.status, 'queued');
  assert.equal(view.execution, 'fifo');
  assert.equal(view.effectiveExecution, 'fifo');
  assert.equal(Object.hasOwn(view, 'submittedPolicy'), false);
  assert.match(view.taskId, /^cursor-/);
  assert.equal(bridge.tasks.get(view.taskId).newChat, true);
});

test('continued sessions collect only a reply appended after the pre-send baseline', () => {
  const baseline = { messageCount: 14, replyLength: 120, replyHash: 42 };
  assert.equal(isSessionTurnReplyReady(baseline, { messageCount: 14, replyLength: 120, replyHash: 42 }), false);
  assert.equal(isSessionTurnReplyReady(baseline, { messageCount: 15, replyLength: 120, replyHash: 42 }), false);
  assert.equal(isSessionTurnReplyReady(baseline, { messageCount: 16, replyLength: 120, replyHash: 42 }), true);
  assert.equal(isSessionTurnReplyReady(baseline, { messageCount: 1, replyLength: 88, replyHash: 99 }), true);
  assert.equal(isSessionTurnReplyReady(baseline, { messageCount: 14, replyLength: 0, replyHash: 99 }), false);
  assert.equal(isSessionTurnReplyReady(null, { messageCount: 1 }), true);
});

test('persistent sessions keep their exact Agent selected between turns', () => {
  assert.equal(shouldScheduleParallelOriginRestore({ sessionMode: 'isolated' }), true);
  assert.equal(shouldScheduleParallelOriginRestore({ sessionMode: 'create' }), false);
  assert.equal(shouldScheduleParallelOriginRestore({ sessionMode: 'continue' }), false);
  assert.equal(shouldScheduleParallelOriginRestore({}), true);
});

test('continued sessions wait for the previous reply to hydrate before capturing a baseline', async () => {
  class BaselineBridge extends OfflineBridge {
    constructor() {
      super();
      this.snapshots = [
        { messageCount: 0, replyLength: 0, replyHash: 0, stop: 0 },
        { messageCount: 1, replyLength: 120, replyHash: 42, stop: 0 },
        { messageCount: 1, replyLength: 120, replyHash: 42, stop: 0 },
      ];
    }
    async _readResponseSnapshot() { return this.snapshots.shift() || this.snapshots.at(-1); }
  }
  const bridge = new BaselineBridge();
  assert.deepEqual(await bridge._captureSessionResponseBaseline(null, 1000, 0), {
    messageCount: 1,
    replyLength: 120,
    replyHash: 42,
  });
});

test('selected Agent confirmation retries only the same exact Agent ID once', async () => {
  class SelectionBridge extends OfflineBridge {
    constructor() {
      super();
      this.requests = [];
    }
    async _readAgentEntries() {
      return [{ id: 'local:exact-agent', isSelected: this.requests.length > 0 }];
    }
    async _requestExactAgentSelection(_client, agentId) {
      this.requests.push(agentId);
      return 'OPENED';
    }
  }
  const bridge = new SelectionBridge();
  assert.equal(await bridge._waitForSelectedAgent(null, 'local:exact-agent', 1000, 0, 0), true);
  assert.deepEqual(bridge.requests, ['local:exact-agent']);
});

test('persistent cursor_do sessions keep one stable session ID across explicit turns', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'cursor-do-session-'));
  const sessionFile = join(directory, 'sessions-v1.json');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bridge = new OfflineBridge({ sessionFile, projectPath: process.cwd(), sessionInstanceId: 'adapter-test' });

  const created = await bridge.doTask('建立持续会话', {
    sessionMode: 'create',
    readOnly: true,
    readOnlySpecified: true,
    requestId: 'turn-1',
  });
  assert.equal(created.sessionMode, 'create');
  assert.equal(created.execution, 'parallel_agent');
  assert.match(created.sessionId, /^cursor-session-/);
  assert.equal(created.sessionTurn, 1);
  const first = bridge.tasks.get(created.taskId);
  first.agentId = 'durable-agent-1';
  first.agentLabel = 'Persistent agent';
  bridge._bindSessionAgent(first);
  bridge._finishJob(first, 'turn one complete');
  assert.equal(bridge.sessionStatus(created.sessionId).sessionState, 'ready');
  assert.equal((await bridge.status(first.id)).result, 'turn one complete');

  const restarted = new OfflineBridge({ sessionFile, projectPath: process.cwd(), sessionInstanceId: 'adapter-after-update' });
  const continued = await restarted.doTask('继续同一个会话', {
    sessionMode: 'continue',
    sessionId: created.sessionId,
    readOnly: true,
    readOnlySpecified: true,
    requestId: 'turn-2',
  });
  assert.equal(continued.sessionId, created.sessionId);
  assert.equal(continued.sessionTurn, 2);
  assert.equal(continued.agentId, 'durable-agent-1');
  assert.equal(restarted.tasks.get(continued.taskId).newChat, false);

  const taskCount = restarted.tasks.size;
  const duplicate = await restarted.doTask('网络重试不得再次发送', {
    sessionMode: 'continue',
    sessionId: created.sessionId,
    readOnly: true,
    readOnlySpecified: true,
    requestId: 'turn-2',
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.taskId, continued.taskId);
  assert.equal(restarted.tasks.size, taskCount);
});

test('continued sessions fail closed on scope expansion and close before forget', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'cursor-do-session-scope-'));
  const sessionFile = join(directory, 'sessions-v1.json');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bridge = new OfflineBridge({ sessionFile, projectPath: process.cwd() });
  const created = await bridge.doTask('只读会话', {
    sessionMode: 'create',
    readOnly: true,
    readOnlySpecified: true,
  });
  const first = bridge.tasks.get(created.taskId);
  first.agentId = 'durable-agent-scope';
  bridge._bindSessionAgent(first);
  bridge._finishJob(first, 'done');
  await bridge.status(first.id);

  await assert.rejects(
    bridge.doTask('尝试扩大为写入', {
      sessionMode: 'continue',
      sessionId: created.sessionId,
      readOnly: false,
      readOnlySpecified: true,
      allowedPaths: ['src'],
      allowedPathsSpecified: true,
    }),
    /SESSION_SCOPE_EXPANSION/,
  );
  assert.equal((await bridge.sessionControl(created.sessionId, { action: 'close' })).sessionState, 'closed');
  await assert.rejects(
    bridge.sessionControl(created.sessionId, { action: 'forget' }),
    /SESSION_CONFIRM_REQUIRED/,
  );
  assert.equal((await bridge.sessionControl(created.sessionId, { action: 'forget', confirm: true })).state, 'forgotten');
  assert.equal(bridge.sessionStatus(created.sessionId).found, false);
});

test('an interrupted session requires explicit exact-Agent reconciliation without resubmission', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'cursor-do-session-reconcile-'));
  const sessionFile = join(directory, 'sessions-v1.json');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const beforeRestart = new OfflineBridge({ sessionFile, projectPath: process.cwd() });
  const created = await beforeRestart.doTask('会在宿主重启前发送', {
    sessionMode: 'create',
    readOnly: true,
    readOnlySpecified: true,
  });
  const sent = beforeRestart.tasks.get(created.taskId);
  sent.agentId = 'durable-agent-reconcile';
  sent.sendState = 'sent';
  beforeRestart._bindSessionAgent(sent);

  const restarted = new OfflineBridge({ sessionFile, projectPath: process.cwd() });
  restarted._readStableParallelEntry = async () => ({
    stable: true,
    entry: { id: 'durable-agent-reconcile', showSpinner: false, icon: 'check-circled' },
  });
  const reconciled = await restarted.sessionControl(created.sessionId, { action: 'reconcile' });
  assert.equal(reconciled.changed, true);
  assert.equal(reconciled.state, 'completed');
  assert.equal(reconciled.sessionState, 'ready');
  assert.equal(reconciled.lastTask.resultUnavailable, true);
  assert.equal(restarted.tasks.size, 0);
});

test('persistent sessions never downgrade to FIFO when exact Agent continuity is unavailable', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'cursor-do-session-no-fallback-'));
  const sessionFile = join(directory, 'sessions-v1.json');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  class NoSessionFallbackBridge extends CursorBridge {
    constructor() {
      super({
        runtimeFile: null,
        workspaceFile: null,
        modelPreferencesFile: null,
        sessionFile,
        runtimeMode: 'normal',
        projectPath: process.cwd(),
      });
      this.fifoRuns = 0;
    }
    async _ensureCursor() {}
    async _submitParallelAgent() { return { fallbackReason: 'Agent adapter unavailable' }; }
    async _run() { this.fifoRuns++; return 'must not run'; }
    _maybeRestoreParallelOrigin() {}
  }
  const bridge = new NoSessionFallbackBridge();
  await assert.rejects(
    bridge.doTask('不能降级', {
      background: false,
      sessionMode: 'create',
      readOnly: true,
      readOnlySpecified: true,
    }),
    /SESSION_CONTINUITY_UNAVAILABLE/,
  );
  assert.equal(bridge.fifoRuns, 0);
  const sessions = Object.values(readCursorSessionRegistry(sessionFile).sessions);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].state, 'failed');
});

test('uncertain sessions cannot close without explicit abandon risk acknowledgement', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'cursor-do-session-abandon-'));
  const sessionFile = join(directory, 'sessions-v1.json');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bridge = new OfflineBridge({ sessionFile, projectPath: process.cwd() });
  const created = await bridge.doTask('保持未确认状态', {
    sessionMode: 'create',
    readOnly: true,
    readOnlySpecified: true,
  });
  await assert.rejects(
    bridge.sessionControl(created.sessionId, { action: 'close' }),
    /SESSION_CLOSE_BLOCKED/,
  );
  await assert.rejects(
    bridge.sessionControl(created.sessionId, { action: 'abandon', confirm: true }),
    /SESSION_ABANDON_CONFIRM_REQUIRED/,
  );
  const abandoned = await bridge.sessionControl(created.sessionId, {
    action: 'abandon',
    confirm: true,
    reason: 'manual verification unavailable',
    acknowledgeMayStillWrite: true,
  });
  assert.equal(abandoned.sessionState, 'closed');
  assert.match(abandoned.warning, /may still run or write/);
});

test('an expired sender lease becomes needs_attention without creating a replacement task', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'cursor-do-session-expired-'));
  const sessionFile = join(directory, 'sessions-v1.json');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const first = new OfflineBridge({ sessionFile, projectPath: process.cwd() });
  const created = await first.doTask('创建后模拟 adapter 中断', {
    sessionMode: 'create',
    readOnly: true,
    readOnlySpecified: true,
  });
  updateCursorSessionRegistry(sessionFile, (registry) => {
    registry.sessions[created.sessionId].lease.expiresAt = '2000-01-01T00:00:00.000Z';
  });

  const restarted = new OfflineBridge({ sessionFile, projectPath: process.cwd() });
  await assert.rejects(
    restarted.doTask('不能自动重发', {
      sessionMode: 'continue',
      sessionId: created.sessionId,
      readOnly: true,
      readOnlySpecified: true,
    }),
    /SESSION_RECONCILE_REQUIRED/,
  );
  assert.equal(restarted.tasks.size, 0);
  assert.equal(restarted.sessionStatus(created.sessionId).sessionState, 'needs_attention');
});

test('parallel agent requires read_only or a writable path boundary', async () => {
  const bridge = new OfflineBridge();
  await assert.rejects(
    bridge.doTask('无边界写任务', { execution: 'parallel_agent' }),
    /must provide allowed_paths/,
  );
  const view = await bridge.doTask('只读任务', { execution: 'parallel_agent', readOnly: true });
  assert.equal(view.execution, 'parallel_agent');
  assert.equal(view.readOnly, true);
  await assert.rejects(
    bridge.doTask('矛盾边界', { execution: 'parallel_agent', readOnly: true, allowedPaths: ['Assets'] }),
    /cannot be combined/,
  );
  await assert.rejects(
    bridge.doTask('绝对路径', { execution: 'parallel_agent', allowedPaths: ['G:/repo/file.txt'] }),
    /must use workspace-relative paths/,
  );
  await assert.rejects(
    bridge.doTask('glob 路径', { execution: 'parallel_agent', allowedPaths: ['Assets/**/*.cs'] }),
    /do not accept globs/,
  );
});

test('overlapping writable parallel tasks are rejected before submission', async () => {
  const bridge = new OfflineBridge();
  await bridge.doTask('任务 A', {
    execution: 'parallel_agent',
    allowedPaths: ['Assets/Scripts/Battle'],
  });
  await assert.rejects(
    bridge.doTask('任务 B', {
      execution: 'parallel_agent',
      allowedPaths: ['Assets/Scripts/Battle/Effects'],
    }),
    /allowed_paths overlap task/,
  );
});

test('unsupported execution mode is rejected explicitly', async () => {
  const bridge = new OfflineBridge();
  await assert.rejects(bridge.doTask('任务', { execution: 'multitask' }), /expected fifo or parallel_agent/);
});

test('unbound uncertain parallel task becomes a global reservation', async () => {
  const bridge = new OfflineBridge();
  const view = await bridge.doTask('可能仍在运行的写任务', {
    execution: 'parallel_agent',
    allowedPaths: ['Tools/Reserved'],
  });
  const job = bridge.tasks.get(view.taskId);
  bridge._orphanParallelJob(job, new Error('history unavailable'));
  assert.equal(job.status, 'needs_attention');
  assert.equal(job.phase, 'orphaned');
  assert.equal(bridge.activeParallel.has(job.id), true);
  await assert.rejects(
    bridge.doTask('重叠写任务', {
      execution: 'parallel_agent',
      allowedPaths: ['Tools/Reserved/Sub'],
    }),
    /global Cursor reservation/,
  );
  assert.equal(job.reservationScope, 'global');
  assert.equal(bridge._taskView(job).blocksAll, true);
});

test('composer-bound Stop uses workbench debug-stop icon inside the matching composer', () => {
  let clicks = 0;
  const icon = { className: 'codicon codicon-debug-stop' };
  const iconButton = {
    offsetParent: {},
    querySelector(selector) {
      return selector.includes('codicon-debug-stop') ? icon : null;
    },
    closest() { return null; },
    click() { clicks++; },
  };
  const composer = {
    offsetParent: {},
    dataset: { composerId: 'wb-composer', composerStatus: 'generating' },
    querySelectorAll(selector) {
      return selector.includes('anysphere-icon-button') ? [iconButton] : [];
    },
  };
  const document = {
    querySelectorAll(selector) {
      if (selector === '.composer-bar[data-composer-id]') return [composer];
      return [];
    },
  };
  const result = JSON.parse(Function('document', `return ${exprClickBoundComposerStop('local:wb-composer')};`)(document));
  assert.equal(result.clicked, true);
  assert.equal(result.control, 'debug_stop_icon');
  assert.equal(clicks, 1);
});

test('composer-bound Stop clicks only the matching visible composer', () => {
  let clicks = 0;
  const composer = {
    offsetParent: {},
    dataset: { composerId: 'fifo-composer', composerStatus: 'generating' },
    querySelectorAll(selector) {
      return selector.includes('ui-prompt-input-submit-button') ? [button] : [];
    },
  };
  const other = {
    offsetParent: {},
    dataset: { composerId: 'other-composer', composerStatus: 'generating' },
    querySelectorAll() { return [wrongButton]; },
  };
  const button = {
    offsetParent: {},
    disabled: false,
    closest() { return composer; },
    click() { clicks++; },
  };
  const wrongButton = {
    offsetParent: {},
    disabled: false,
    closest() { return other; },
    click() { clicks += 10; },
  };
  const document = {
    querySelectorAll(selector) {
      if (selector === '.composer-bar[data-composer-id]') return [other, composer];
      if (selector.includes('ui-prompt-input-submit-button')) return [button];
      return [];
    },
  };
  const result = JSON.parse(Function('document', `return ${exprClickBoundComposerStop('local:fifo-composer')};`)(document));
  assert.equal(result.clicked, true);
  assert.equal(result.composerId, 'fifo-composer');
  assert.equal(result.control, 'stop_generation');
  assert.equal(clicks, 1);
  assert.match(EXPR_VISIBLE_COMPOSER, /data-composer-id/);
});

test('FIFO composer identity bind does not require History adapter', () => {
  const bridge = new OfflineBridge();
  const job = { targetUiFlavor: 'agents_v2', agentId: null };
  bridge._applyAgentIdentity(job, { id: 'local:composer-only' });
  assert.equal(job.agentId, 'local:composer-only');
  assert.equal(bridge._canBindFifoHistory({ targetUiFlavor: 'agents_v2' }), true);
  assert.equal(bridge._canBindFifoHistory({ targetUiFlavor: 'legacy' }), true);
});

test('_stopBoundAgentOnClient falls back to composer Stop when History is unavailable', async () => {
  const bridge = new OfflineBridge();
  let composerStops = 0;
  bridge._stopBoundAgentViaHistory = async () => {
    throw new Error('Cursor Agent 列表适配器不可用');
  };
  bridge._stopBoundAgentViaComposer = async (c, job) => {
    composerStops++;
    assert.equal(job.agentId, 'local:composer-only');
    return { confirmed: true, clicked: true, state: 'stopped' };
  };
  const stopped = await bridge._stopBoundAgentOnClient({}, { agentId: 'local:composer-only' });
  assert.equal(stopped.confirmed, true);
  assert.equal(composerStops, 1);
});

test('targeted Stop confirmation requires a real click and two stable terminal observations', () => {
  assert.equal(isTargetedStopConfirmed({ clicked: false }, 2), false);
  assert.equal(isTargetedStopConfirmed({ clicked: true }, 1), false);
  assert.equal(isTargetedStopConfirmed({ clicked: true }, 2), true);

  const expression = exprClickSelectedAgentStop('local:exact-agent');
  assert.match(expression, /data-state="stop"/);
  assert.match(expression, /aria-label="Stop generation"/);
  assert.match(expression, /ui-shell-tool-call__glass-stop/);
  assert.match(expression, /aria-label="Stop command"/);
  assert.match(expression, /composerStatus!==\'generating\'/);
  assert.doesNotMatch(expression, /aria-label\*=Cancel|debug-stop/);
});

test('targeted Stop expression executes against the React adapter and exact composer', () => {
  let clicks = 0;
  const label = {
    offsetParent: {},
    parentElement: null,
    '__reactProps$test': {
      entries: [{ id: 'local:exact-agent', isSelected: true }],
      onOpenEntry() {},
    },
  };
  const composer = {
    offsetParent: {},
    dataset: { composerId: 'exact-agent', composerStatus: 'generating' },
    querySelectorAll(selector) {
      return selector.includes('ui-prompt-input-submit-button') ? [button] : [];
    },
  };
  const button = {
    offsetParent: {},
    disabled: false,
    closest() { return composer; },
    click() { clicks++; },
  };
  const document = {
    querySelectorAll(selector) {
      if (selector === '.compact-agent-history-react-menu-label') return [label];
      if (selector === '.composer-bar[data-composer-id]') return [composer];
      return [];
    },
  };
  const expression = exprClickSelectedAgentStop('local:exact-agent');
  const result = JSON.parse(Function('document', `return ${expression};`)(document));
  assert.equal(result.clicked, true);
  assert.equal(result.selectedId, 'local:exact-agent');
  assert.equal(result.composerId, 'exact-agent');
  assert.equal(result.control, 'stop_generation');
  assert.equal(clicks, 1);
});

test('targeted Stop expression accepts the exact foreground command stop control', () => {
  let clicks = 0;
  const label = {
    offsetParent: {},
    parentElement: null,
    '__reactProps$test': {
      entries: [{ id: 'local:exact-agent', isSelected: true }],
      onOpenEntry() {},
    },
  };
  const composer = {
    offsetParent: {},
    dataset: { composerId: 'exact-agent', composerStatus: 'generating' },
    querySelectorAll(selector) {
      return selector.includes('ui-shell-tool-call__glass-stop') ? [button] : [];
    },
  };
  const button = {
    offsetParent: {},
    disabled: false,
    closest() { return composer; },
    click() { clicks++; },
  };
  const document = {
    querySelectorAll(selector) {
      if (selector === '.compact-agent-history-react-menu-label') return [label];
      if (selector === '.composer-bar[data-composer-id]') return [composer];
      return [];
    },
  };
  const result = JSON.parse(Function('document', `return ${exprClickSelectedAgentStop('local:exact-agent')};`)(document));
  assert.equal(result.clicked, true);
  assert.equal(result.control, 'stop_command');
  assert.equal(clicks, 1);
});

test('parallel failure icons require two identical stable observations', () => {
  assert.equal(classifyParallelTerminalIcon('needs-attention'), 'needs_attention');
  const entry = { id: 'local:agent', showSpinner: false, icon: 'warning' };
  const first = updateStableEntryObservation('', 0, entry);
  assert.equal(first.count, 1);
  const second = updateStableEntryObservation(first.signature, first.count, entry);
  assert.equal(second.count, 2);
  const changed = updateStableEntryObservation(second.signature, second.count, { ...entry, icon: 'loading', showSpinner: true });
  assert.equal(changed.count, 1);
  assert.notEqual(changed.signature, second.signature);
  assert.equal(classifyParallelTerminalIcon('circle-slash'), 'cancelled');
  assert.equal(classifyParallelTerminalIcon('warning'), 'failed');
  assert.equal(classifyParallelTerminalIcon('check-circled'), 'completed');
});

test('Cursor 3.17.21 FIFO safely rebinds a vanished composer ID to its selected durable Agent', () => {
  const before = [{ id: 'local:existing', durable: true, icon: 'check-circled' }];
  const promoted = {
    id: 'local:promoted',
    isSelected: true,
    durable: true,
    showSpinner: true,
    icon: 'loading',
  };
  assert.equal(selectPromotedFifoEntry(before, 'local:provisional', [...before, promoted]).id, 'local:promoted');
  assert.equal(selectPromotedFifoEntry(before, 'local:provisional', [
    ...before,
    { ...promoted, isSelected: false },
  ]), null);
  assert.equal(selectPromotedFifoEntry(before, 'local:provisional', [
    ...before,
    { ...promoted, durable: false },
  ]), null);
  assert.equal(selectPromotedFifoEntry(before, 'local:provisional', [
    ...before,
    { id: 'local:provisional', durable: true, showSpinner: true, icon: 'loading' },
    promoted,
  ]), null);
});

test('parallel submission waits for a durable History row before releasing the UI lock', () => {
  assert.equal(isDurablyRegisteredParallelEntry({ durable: false, showSpinner: true, icon: 'loading' }), false);
  assert.equal(isDurablyRegisteredParallelEntry({ durable: true, showSpinner: true, icon: 'loading' }), true);
  assert.equal(isDurablyRegisteredParallelEntry({ durable: true, showSpinner: false, icon: 'check-circled' }), true);
  assert.equal(isDurablyRegisteredParallelEntry({ showSpinner: true, icon: 'loading' }), true);
  assert.equal(isDurablyRegisteredParallelEntry({ durable: true, showSpinner: false, icon: 'draft' }), false);
  assert.match(EXPR_HISTORY_ENTRIES, /durable:true/);
  assert.match(EXPR_HISTORY_ENTRIES, /sectionIdByAgentId/);
  assert.match(EXPR_HISTORY_ENTRIES, /registeredBySectionMap/);
  assert.equal(uncertainSubmissionReservationScope({ readOnly: true }, { requiresGlobalReservation: true }), 'global');
  assert.equal(uncertainSubmissionReservationScope({ readOnly: true }, {}), 'agent');
  assert.equal(uncertainSubmissionReservationScope({ readOnly: false }, {}), 'paths');
});

test('orphaned task can be reaped to completed after its original promise was rejected', async () => {
  const bridge = new TaskControlBridge();
  const view = await bridge.doTask('可恢复的只读任务', { execution: 'parallel_agent', readOnly: true });
  const job = makeOrphan(bridge, view);
  assert.equal(job.settled, true);
  bridge.entrySnapshots = [
    { id: job.agentId, showSpinner: false, icon: 'check-circled' },
    { id: job.agentId, showSpinner: false, icon: 'check-circled' },
  ];

  const result = await bridge.taskControl(view.taskId, { action: 'reap' });
  assert.equal(result.state, 'completed');
  assert.equal(job.status, 'completed');
  assert.equal(job.result, 'recovered result');
  assert.equal(job.resultUnavailable, false);
  assert.equal(bridge.activeParallel.has(job.id), false);
});

test('reap reattaches monitoring when the exact orphaned Agent is still generating', async () => {
  const bridge = new TaskControlBridge();
  const view = await bridge.doTask('仍在运行的只读任务', { execution: 'parallel_agent', readOnly: true });
  const job = makeOrphan(bridge, view);
  bridge.entrySnapshots = [
    { id: job.agentId, showSpinner: true, icon: 'loading' },
    { id: job.agentId, showSpinner: true, icon: 'loading' },
  ];

  const result = await bridge.taskControl(view.taskId, { action: 'reap' });
  assert.equal(result.state, 'running');
  assert.equal(result.monitorReattached, true);
  assert.equal(job.status, 'running');
  assert.equal(job.recoveryState, 'monitoring');
  assert.equal(bridge.monitorStarts, 1);
  assert.equal(bridge.activeParallel.has(job.id), true);
});

test('stable completion keeps reservation when final response extraction is temporarily unavailable', async () => {
  const bridge = new TaskControlBridge();
  const view = await bridge.doTask('结果 DOM 丢失任务', {
    execution: 'parallel_agent',
    allowedPaths: ['Tools/Reaped'],
  });
  const job = makeOrphan(bridge, view);
  bridge.collectError = new Error('response DOM unavailable');
  bridge.entrySnapshots = [
    { id: job.agentId, showSpinner: false, icon: 'check-circled' },
    { id: job.agentId, showSpinner: false, icon: 'check-circled' },
  ];

  const result = await bridge.taskControl(view.taskId, { action: 'reap' });
  assert.equal(result.state, 'terminal_uncollected');
  assert.equal(job.status, 'needs_attention');
  assert.equal(job.resultUnavailable, true);
  assert.match(job.error, /response DOM unavailable/);
  assert.equal(bridge.activeParallel.has(job.id), true);
  await assert.rejects(bridge.doTask('原路径仍应保留', {
    execution: 'parallel_agent',
    allowedPaths: ['Tools/Reaped/Sub'],
  }), /overlap task/);

  bridge.collectError = null;
  bridge.collectResult = 'retry recovered result';
  bridge.entrySnapshots = [
    { id: job.agentId, showSpinner: false, icon: 'check-circled' },
    { id: job.agentId, showSpinner: false, icon: 'check-circled' },
  ];
  const retried = await bridge.taskControl(view.taskId, { action: 'reap' });
  assert.equal(retried.state, 'completed');
  assert.equal(retried.task.result, 'retry recovered result');
  assert.equal(retried.task.resultUnavailable, false);
  assert.equal(retried.task.reservationHeld, false);
});

test('targeted cancel requires the exact agent id and releases only after confirmed Stop', async () => {
  const bridge = new TaskControlBridge();
  const view = await bridge.doTask('需要停止的写任务', {
    execution: 'parallel_agent',
    allowedPaths: ['Tools/Cancelable'],
  });
  const job = makeOrphan(bridge, view);
  bridge.entrySnapshots = [
    { id: job.agentId, showSpinner: true, icon: 'loading' },
    { id: job.agentId, showSpinner: true, icon: 'loading' },
  ];

  await assert.rejects(
    bridge.taskControl(view.taskId, {
      action: 'cancel',
      confirm: true,
      expectedAgentId: 'local:wrong-agent',
    }),
    /expected_agent_id does not match/,
  );
  assert.equal(bridge.activeParallel.has(job.id), true);

  const cancelled = await bridge.taskControl(view.taskId, {
    action: 'cancel',
    confirm: true,
    expectedAgentId: job.agentId,
    reason: '用户终止旧任务',
  });
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(job.status, 'cancelled');
  assert.equal(job.underlyingStopConfirmed, true);
  assert.equal(bridge.activeParallel.has(job.id), false);
  await bridge.doTask('取消后路径可以重新使用', {
    execution: 'parallel_agent',
    allowedPaths: ['Tools/Cancelable/Sub'],
  });
});

test('unconfirmed cancel keeps reservation and reports the safe next action', async () => {
  const bridge = new TaskControlBridge();
  const view = await bridge.doTask('停止状态不明的写任务', {
    execution: 'parallel_agent',
    allowedPaths: ['Tools/StillReserved'],
  });
  const job = makeOrphan(bridge, view);
  bridge.entrySnapshots = [
    { id: job.agentId, showSpinner: true, icon: 'loading' },
    { id: job.agentId, showSpinner: true, icon: 'loading' },
  ];
  bridge.stopResult = { confirmed: false, state: 'stop_unconfirmed' };

  const result = await bridge.taskControl(view.taskId, {
    action: 'cancel',
    confirm: true,
    expectedAgentId: job.agentId,
  });
  assert.equal(result.state, 'cancel_unconfirmed');
  assert.equal(job.status, 'needs_attention');
  assert.equal(job.phase, 'orphaned');
  assert.equal(bridge.activeParallel.has(job.id), true);
  await assert.rejects(
    bridge.doTask('仍应冲突', {
      execution: 'parallel_agent',
      allowedPaths: ['Tools/StillReserved/Sub'],
    }),
    /overlap task/,
  );
  assert.equal(job.reservationScope, 'paths');
  assert.equal(bridge._taskView(job).blocksAll, false);
});

test('parallel cancel reports the actual terminal state when monitoring wins the race', async () => {
  const bridge = new TaskControlBridge();
  const view = await bridge.doTask('取消与终态竞态', { execution: 'parallel_agent', readOnly: true });
  const job = makeOrphan(bridge, view);
  bridge.entrySnapshots = [
    { id: job.agentId, showSpinner: true, icon: 'loading' },
    { id: job.agentId, showSpinner: true, icon: 'loading' },
  ];
  bridge._stopParallelAgent = async () => {
    bridge.activeParallel.delete(job.id);
    bridge._failJob(job, new Error('monitor reached failed first'));
    return { confirmed: true, clicked: true, state: 'stopped' };
  };

  const result = await bridge.taskControl(view.taskId, {
    action: 'cancel',
    confirm: true,
    expectedAgentId: job.agentId,
  });
  assert.equal(result.state, 'failed');
  assert.equal(result.task.status, 'failed');
  assert.match(result.task.error, /monitor reached failed first/);
});

test('cancel latched during parallel submission stops the bound Agent before monitoring starts', async () => {
  const bridge = new DeferredSubmitBridge();
  const view = await bridge.doTask('提交过程中取消', { execution: 'parallel_agent', readOnly: true });
  await bridge.submitStarted;

  const control = bridge.taskControl(view.taskId, {
    action: 'cancel',
    confirm: true,
    reason: '提交中停止',
  });
  const job = bridge.tasks.get(view.taskId);
  assert.equal(job.cancelRequested, true);

  bridge._resolveSubmit({
    agent: { id: 'local:prebound-before-return', label: 'bound' },
    previousSelectedId: null,
  });
  const result = await control;
  assert.equal(result.state, 'cancelled');
  assert.equal(result.task.status, 'cancelled');
  assert.equal(bridge.stopCalls, 1);
  assert.equal(bridge.monitorStarts, 0);
  assert.equal(bridge.activeParallel.size, 0);
});

test('stale monitor finally cannot clear a newer monitor generation', async () => {
  const bridge = new MonitorGenerationBridge();
  const view = await bridge.doTask('generation guard', { execution: 'parallel_agent', readOnly: true });
  const job = makeOrphan(bridge, view);

  assert.equal(bridge._startParallelMonitor(job), true);
  const firstGeneration = job.monitorGeneration;
  const firstPromise = job.monitorPromise;
  bridge._invalidateParallelMonitor(job);
  assert.equal(bridge._startParallelMonitor(job), true);
  const secondGeneration = job.monitorGeneration;
  const secondPromise = job.monitorPromise;
  assert.notEqual(firstGeneration, secondGeneration);

  bridge.gates.get(firstGeneration).resolve();
  await firstPromise;
  assert.equal(job.monitorPromise, secondPromise);
  assert.equal(job.monitorAttached, true);

  bridge.gates.get(secondGeneration).resolve();
  await secondPromise;
  assert.equal(job.monitorPromise, null);
  assert.equal(job.monitorAttached, false);
});

test('FIFO identity bind is attempted on the current editor and stays unbound if none exists', () => {
  const bridge = new OfflineBridge();
  assert.equal(bridge._canBindFifoHistory({ targetUiFlavor: 'agents_v2' }), true);
  assert.equal(bridge._canBindFifoHistory({ targetUiFlavor: 'legacy' }), true);
  assert.equal(bridge._canBindFifoHistory({ targetUiFlavor: null }), true);
  assert.equal(bridge._canBindFifoHistory(null), false);
});

test('unbound running FIFO still latches cancel_pending_fifo without clicking Stop', async () => {
  const bridge = new OfflineBridge();
  const view = await bridge.doTask('unbound fifo latch');
  const job = bridge.tasks.get(view.taskId);
  job.status = 'running';
  job.phase = 'running';
  job.agentId = null;
  job.targetUiFlavor = 'legacy';
  const result = await bridge._taskControlLocked(job, 'cancel', { reason: 'stop' });
  assert.equal(result.state, 'cancel_pending_fifo');
  assert.match(result.next, /no safely targetable agentId/);
});

test('FIFO with bound agentId latches cancel_pending_stop instead of unbound FIFO copy', async () => {
  const bridge = new OfflineBridge();
  const view = await bridge.doTask('bound fifo latch');
  const job = bridge.tasks.get(view.taskId);
  job.status = 'running';
  job.phase = 'running';
  job.agentId = 'local:fifo-bound';
  job.targetUiFlavor = 'agents_v2';
  const result = await bridge._taskControlLocked(job, 'cancel', { reason: 'stop' });
  assert.equal(result.state, 'cancel_pending_stop');
  assert.equal(job.recoveryState, 'cancel_pending_stop');
  assert.match(result.next, /stopped through its bound agentId/);
  assert.doesNotMatch(result.next, /no safely targetable agentId/);
});

test('running FIFO cancel with bound agentId uses targeted stop after the waiter yields', async () => {
  class BoundFifoBridge extends CancellableFifoBridge {
    constructor() {
      super();
      this.stopCalls = 0;
    }
    async _run(prompt, job) {
      job.agentId = 'local:fifo-bound';
      job.agentLabel = 'fifo-bound';
      job.targetUiFlavor = 'agents_v2';
      this._markRunStarted();
      while (!job.cancelRequested) await new Promise((resolve) => setTimeout(resolve, 1));
      const error = new Error(job.cancelReason || 'cancelled');
      error.cancelled = true;
      error.stopConfirmed = false;
      error.sent = true;
      throw error;
    }
    async _stopParallelAgent(job) {
      this.stopCalls++;
      assert.equal(job.agentId, 'local:fifo-bound');
      return { confirmed: true, clicked: true, state: 'stopped' };
    }
  }
  const bridge = new BoundFifoBridge();
  const view = await bridge.doTask('已绑定的 FIFO');
  await bridge.runStarted;
  const result = await bridge.taskControl(view.taskId, {
    action: 'cancel',
    confirm: true,
    expectedAgentId: 'local:fifo-bound',
    reason: '停止已绑定 FIFO',
  });
  assert.equal(result.state, 'cancelled');
  assert.equal(result.task.status, 'cancelled');
  assert.equal(result.task.underlyingStopConfirmed, true);
  assert.equal(bridge.stopCalls, 1);
  assert.equal(bridge.activeParallel.size, 0);
});

test('_waitComplete with bound agentId stops on the existing client', async () => {
  class WaitCompleteCancelBridge extends OfflineBridge {
    constructor() {
      super();
      this.stopCalls = 0;
    }
    async _throwIfNewProviderError() {}
    async _stopBoundAgentOnClient(c, job) {
      this.stopCalls++;
      assert.equal(job.agentId, 'local:fifo-wait');
      assert.equal(c, this.client);
      return { confirmed: true, state: 'stopped' };
    }
  }
  const bridge = new WaitCompleteCancelBridge();
  bridge.client = { id: 'existing-cdp' };
  const job = {
    cancelRequested: true,
    cancelReason: 'stop now',
    agentId: 'local:fifo-wait',
  };
  await assert.rejects(
    () => bridge._waitComplete(bridge.client, 5000, 0, job, ''),
    (error) => error.cancelled === true && error.stopConfirmed === true,
  );
  assert.equal(bridge.stopCalls, 1);
  assert.equal(job.terminalEvidence, 'targeted_stop:local:fifo-wait');
});

test('_waitComplete unbound FIFO cancel does not click Stop', async () => {
  class WaitCompleteUnboundBridge extends OfflineBridge {
    constructor() {
      super();
      this.stopCalls = 0;
    }
    async _throwIfNewProviderError() {}
    async _stopBoundAgentOnClient() {
      this.stopCalls++;
      return { confirmed: true, state: 'stopped' };
    }
  }
  const bridge = new WaitCompleteUnboundBridge();
  const job = { cancelRequested: true, cancelReason: 'stop now', agentId: null };
  await assert.rejects(
    () => bridge._waitComplete({ id: 'c' }, 5000, 0, job, ''),
    (error) => error.cancelled === true && error.stopConfirmed === false,
  );
  assert.equal(bridge.stopCalls, 0);
});

test('running FIFO cancel that cannot confirm Stop remains blocked with an explicit abandon path', async () => {
  const bridge = new CancellableFifoBridge();
  const view = await bridge.doTask('运行中的 FIFO');
  await bridge.runStarted;
  const job = bridge.tasks.get(view.taskId);
  const result = await bridge.taskControl(view.taskId, {
    action: 'cancel',
    confirm: true,
    reason: '停止 FIFO',
  });
  assert.equal(result.state, 'cancel_unconfirmed');
  assert.equal(result.task.status, 'needs_attention');
  assert.match(result.next, /abandon/);
  assert.equal(bridge._taskView(job).blocksFifo, true);
  assert.equal(bridge._taskView(job).blocksAll, true);
  await assert.rejects(bridge.doTask('全局占用期间不得提交并行任务', {
    execution: 'parallel_agent',
    readOnly: true,
  }), /global Cursor reservation/);

  const reaped = await bridge.taskControl(view.taskId, { action: 'reap' });
  assert.equal(reaped.state, 'not_parallel_reservation');
  assert.match(reaped.next, /FIFO orphan/);
});

test('parallel to FIFO fallback cancellation reports orphaned instead of pending agent binding', async () => {
  const bridge = new CancellableFifoBridge({ fallback: true });
  const view = await bridge.doTask('降级后取消', { execution: 'parallel_agent', readOnly: true });
  await bridge.runStarted;

  const result = await bridge.taskControl(view.taskId, {
    action: 'cancel',
    confirm: true,
    reason: '取消降级任务',
  });
  assert.equal(result.state, 'cancel_unconfirmed');
  assert.equal(result.task.status, 'needs_attention');
  assert.equal(result.task.effectiveExecution, 'fifo');
  assert.equal(result.task.reservationScope, 'global');
  assert.doesNotMatch(result.next, /bind the agentId/);
});

test('global orphan reservation blocks already queued work at the scheduler gate', async () => {
  const bridge = new OfflineBridge();
  const orphanView = await bridge.doTask('未知 FIFO');
  const queuedView = await bridge.doTask('已排队的并行只读', { execution: 'parallel_agent', readOnly: true });
  const orphan = bridge.tasks.get(orphanView.taskId);
  bridge.queue = bridge.queue.filter((job) => job.id !== orphan.id);
  orphan.status = 'running';
  orphan.phase = 'running';
  bridge._orphanParallelJob(orphan, new Error('stop unconfirmed'));
  let runs = 0;
  bridge._run = async () => { runs++; return 'unexpected'; };

  await CursorBridge.prototype._drain.call(bridge);
  assert.equal(runs, 0);
  assert.equal(bridge.queue.some((job) => job.id === queuedView.taskId), true);
  assert.equal(bridge._taskView(orphan).blocksAll, true);
});

test('FIFO failure after possible send becomes a global orphan instead of releasing silently', async () => {
  const bridge = new SentFifoFailureBridge();
  const view = await bridge.doTask('发送后读取失败');
  const job = bridge.tasks.get(view.taskId);
  await job.controlTail;
  assert.equal(job.status, 'needs_attention');
  assert.equal(job.phase, 'orphaned');
  assert.equal(job.reservationScope, 'global');
  assert.equal(bridge.activeParallel.has(job.id), true);
});

test('confirmed provider tray failure is terminal and releases the reservation', async () => {
  const bridge = new ConfirmedFifoFailureBridge();
  const view = await bridge.doTask('触发 provider error');
  const job = bridge.tasks.get(view.taskId);
  await job.controlTail;
  assert.equal(job.status, 'failed');
  assert.equal(job.phase, 'failed');
  assert.equal(job.providerError.requestId, 'confirmed-request-id');
  assert.match(job.terminalEvidence, /provider_error_tray:confirmed-request-id/);
  assert.equal(job.reservationScope, null);
  assert.equal(bridge.activeParallel.has(job.id), false);
  assert.equal(bridge._taskView(job).reservationHeld, false);
});

test('task identity is process-local and is not claimed recoverable after bridge reconstruction', async () => {
  const first = new OfflineBridge();
  const view = await first.doTask('进程内任务', { execution: 'parallel_agent', readOnly: true });
  const job = makeOrphan(first, view);
  assert.equal(first.activeParallel.has(job.id), true);

  const restarted = new OfflineBridge();
  const status = await restarted.status(view.taskId);
  assert.equal(status.found, false);
  assert.equal(restarted.activeParallel.size, 0);
});

test('abandon requires explicit risk acknowledgement and releases an orphan visibly', async () => {
  const bridge = new TaskControlBridge();
  const view = await bridge.doTask('无法绑定 agentId 的任务', {
    execution: 'parallel_agent',
    allowedPaths: ['Tools/Abandonable'],
  });
  const job = makeOrphan(bridge, view, { agentId: null });

  await assert.rejects(
    bridge.taskControl(view.taskId, {
      action: 'abandon',
      confirm: true,
      reason: '已在 Cursor 手工停止',
    }),
    /acknowledge_may_still_write=true/,
  );
  assert.equal(bridge.activeParallel.has(job.id), true);

  const result = await bridge.taskControl(view.taskId, {
    action: 'abandon',
    confirm: true,
    reason: '已在 Cursor 手工停止并关闭旧任务',
    acknowledgeMayStillWrite: true,
  });
  assert.equal(result.state, 'abandoned');
  assert.match(result.warning, /may still write files/);
  assert.equal(job.status, 'abandoned');
  assert.equal(job.underlyingStopConfirmed, false);
  assert.equal(bridge.activeParallel.has(job.id), false);
});

test('queued task cancellation is terminal and removed from the queue', async () => {
  const bridge = new TaskControlBridge();
  const view = await bridge.doTask('尚未发送的任务');
  assert.equal(bridge.queue.length, 1);

  const result = await bridge.taskControl(view.taskId, {
    action: 'cancel',
    confirm: true,
    reason: '不再需要',
  });
  assert.equal(result.state, 'cancelled');
  assert.equal(result.task.status, 'cancelled');
  assert.equal(result.task.underlyingStopConfirmed, true);
  assert.equal(bridge.queue.length, 0);
});

test('status is a pure snapshot and explicit reap performs recovery', async () => {
  const bridge = new TaskControlBridge();
  const view = await bridge.doTask('状态自动恢复任务', { execution: 'parallel_agent', readOnly: true });
  const job = makeOrphan(bridge, view);
  bridge.entrySnapshots = [
    { id: job.agentId, showSpinner: true, icon: 'loading' },
    { id: job.agentId, showSpinner: true, icon: 'loading' },
  ];
  const overall = await bridge.status();
  assert.equal(overall.pluginVersion, PLUGIN_VERSION);
  assert.equal(overall.statusPath, 'json-list');
  assert.deepEqual(overall.blockingTaskIds, [job.id]);
  assert.equal(overall.activeParallel[0].blocksFifo, true);

  job.status = 'needs_attention';
  job.phase = 'orphaned';
  job.monitorAttached = false;
  bridge.entrySnapshots = [
    { id: job.agentId, showSpinner: false, icon: 'check-circled' },
    { id: job.agentId, showSpinner: false, icon: 'check-circled' },
  ];

  const status = await bridge.status(view.taskId);
  assert.equal(status.status, 'needs_attention');
  assert.equal(status.result, null);
  assert.equal(status.reservationHeld, true);
  assert.equal(bridge.entrySnapshots.length, 2);
  assert.equal(bridge.monitorStarts, 0);

  const recovered = await bridge.taskControl(view.taskId, { action: 'reap' });
  assert.equal(recovered.state, 'completed');
  assert.equal(recovered.task.result, 'recovered result');
  assert.equal(recovered.task.reservationHeld, false);
});

test('UI lock serializes operations without poisoning later work after rejection', async () => {
  const bridge = new CursorBridge();
  const order = [];
  const first = bridge._withUiLock(async () => {
    order.push('a:start');
    await new Promise((resolve) => setTimeout(resolve, 20));
    order.push('a:end');
    throw new Error('expected');
  });
  const second = bridge._withUiLock(async () => {
    order.push('b');
    return 42;
  });
  await assert.rejects(first, /expected/);
  assert.equal(await second, 42);
  assert.deepEqual(order, ['a:start', 'a:end', 'b']);
});

test('per-job control lock serializes lifecycle transitions', async () => {
  const bridge = new OfflineBridge();
  const view = await bridge.doTask('job lock');
  const job = bridge.tasks.get(view.taskId);
  let active = 0;
  let maxActive = 0;
  const order = [];
  const run = (label, delay) => bridge._withJobLock(job, async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    order.push(`${label}:start`);
    await new Promise((resolve) => setTimeout(resolve, delay));
    order.push(`${label}:end`);
    active--;
  });

  await Promise.all([run('a', 15), run('b', 0), run('c', 0)]);
  assert.equal(maxActive, 1);
  assert.deepEqual(order, ['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end']);
});
