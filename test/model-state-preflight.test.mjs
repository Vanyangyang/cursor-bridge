import test from 'node:test';
import assert from 'node:assert/strict';
import { CursorBridge } from '../server.mjs';

const preference = { model: 'grok-4.7', effort: 'high' };
const configuration = () => ({
  found: true, verified: true, source: 'agents_composer_model_trigger', agentId: 'agent-1',
  owner: { triggerId: 'trigger-1', composerId: 'composer-1', agentId: 'agent-1' },
  modelName: 'grok-4.7', selectedModels: [{ modelId: 'grok-4.7', parameters: { reasoning_effort: 'high' } }],
});
const jobForAgent = () => ({ agentId: 'local:agent-1', composerId: 'composer-1', modelPreference: preference, sendState: 'not_sent' });

function harness(runtimeMode = 'normal') {
  const bridge = new CursorBridge({ runtimeFile: null, workspaceFile: null, modelPreferencesFile: null, sessionFile: null, runtimeMode });
  const ui = [];
  for (const method of ['_openModelPicker', '_closeModelPicker', '_clickModelPickerPoint', '_hoverModelPickerPoint']) {
    bridge[method] = async () => { ui.push(method); throw new Error(`unexpected UI: ${method}`); };
  }
  const client = { send: async method => { ui.push(method); throw new Error(`unexpected protocol input: ${method}`); } };
  return { bridge, ui, client };
}

test('normal and minimal exact committed configurations succeed with zero picker or protocol input', async () => {
  for (const mode of ['normal', 'minimal']) {
    const { bridge, ui, client } = harness(mode);
    bridge._readSelectedAgentModelConfig = async () => configuration();
    const job = jobForAgent();
    const result = await bridge._applyModelPreference(client, preference, job);
    assert.equal(result.applied, true);
    assert.equal(result.verificationSource, mode === 'normal' ? 'committed_composer_model_config' : 'selected_agent_model_config');
    assert.equal(result.requiresConfigRecheck, true);
    assert.equal(job.modelSelection, result);
    assert.deepEqual(ui, []);
    assert.equal(job.sendState, 'not_sent');
  }
});

test('legacy exact configuration binds the job Agent ID to its composer ID', async () => {
  const { bridge, ui, client } = harness();
  const snapshot = configuration();
  Object.assign(snapshot, { source: 'legacy_composer_model_trigger', agentId: null });
  snapshot.owner.agentId = null;
  bridge._readSelectedAgentModelConfig = async () => snapshot;
  const result = await bridge._applyModelPreference(client, preference, { agentId: 'local:composer-1', sendState: 'not_sent' });
  assert.equal(result.applied, true);
  assert.equal(result.requiresConfigRecheck, true);
  assert.deepEqual(ui, []);
});

test('wrong effort and missing proof retain the normal UI fallback', async () => {
  const badEffort = configuration(); badEffort.selectedModels[0].parameters.reasoning_effort = 'low';
  const unverified = configuration(); delete unverified.verified;
  for (const snapshot of [badEffort, { found: false }, unverified]) {
    const { bridge, ui, client } = harness();
    bridge._readSelectedAgentModelConfig = async () => snapshot;
    let opened = 0;
    bridge._openModelPicker = async () => { opened++; throw new Error('fallback picker reached'); };
    bridge._closeModelPicker = async () => {};
    await assert.rejects(bridge._applyModelPreference(client, preference, jobForAgent()), /fallback picker reached/);
    assert.equal(opened, 1);
    assert.deepEqual(ui, []);
  }
});

test('verified configuration from a different Agent refuses all UI interaction', async () => {
  const { bridge, ui, client } = harness();
  const snapshot = configuration(); snapshot.agentId = 'other-agent';
  bridge._readSelectedAgentModelConfig = async () => snapshot;
  await assert.rejects(bridge._applyModelPreference(client, preference, jobForAgent()), error => error.code === 'CURSOR_MODEL_OWNER_CHANGED');
  assert.deepEqual(ui, []);
});

test('configuration read errors remain errors without opening or cleaning up UI', async () => {
  const { bridge, ui, client } = harness();
  bridge._readSelectedAgentModelConfig = async () => { throw Object.assign(new Error('configuration transport failed'), { code: 'ECONNRESET' }); };
  await assert.rejects(bridge._applyModelPreference(client, preference, jobForAgent()), /configuration transport failed/);
  assert.deepEqual(ui, []);
});

test('cancellation before or during configuration reading cannot report applied or touch UI', async () => {
  for (const beforeRead of [true, false]) {
    const { bridge, ui, client } = harness();
    const job = { ...jobForAgent(), cancelRequested: beforeRead };
    let reads = 0;
    bridge._readSelectedAgentModelConfig = async () => { reads++; job.cancelRequested = true; return configuration(); };
    await assert.rejects(bridge._applyModelPreference(client, preference, job), error => error.cancelled === true);
    assert.equal(reads, beforeRead ? 0 : 1);
    assert.deepEqual(ui, []);
    assert.equal(job.sendState, 'not_sent');
  }
});

test('pre-send recheck accepts unchanged evidence and rejects configuration or identity changes', async () => {
  for (const mutate of [
    null,
    s => { s.selectedModels[0].parameters.reasoning_effort = 'low'; },
    s => { s.modelName = 'other-model'; s.selectedModels[0].modelId = 'other-model'; },
    s => { s.agentId = 'other-agent'; s.owner.agentId = 'other-agent'; },
    s => { s.owner.composerId = 'other-composer'; },
    s => { s.verified = false; },
  ]) {
    const { bridge, ui, client } = harness();
    let snapshot = configuration();
    bridge._readSelectedAgentModelConfig = async () => snapshot;
    const job = jobForAgent();
    await bridge._applyModelPreference(client, preference, job);
    snapshot = structuredClone(snapshot);
    mutate?.(snapshot);
    if (mutate) {
      await assert.rejects(bridge._verifyModelPreferenceBeforeSend(client, job, 'before_send'), error => error.code === 'CURSOR_MODEL_CONFIGURATION_CHANGED');
    } else await bridge._verifyModelPreferenceBeforeSend(client, job, 'before_send');
    assert.deepEqual(ui, []);
    assert.equal(job.sendState, 'not_sent');
  }
});

test('pre-send recheck skips jobs that did not use the configuration shortcut', async () => {
  const { bridge, ui, client } = harness();
  bridge._readSelectedAgentModelConfig = async () => assert.fail('UI-verified job does not require this recheck');
  await bridge._verifyModelPreferenceBeforeSend(client, { modelSelection: { applied: true, requiresConfigRecheck: false } }, 'before_send');
  assert.deepEqual(ui, []);
});

test('pre-send read errors and cancellation invalidate verification while preserving send certainty', async () => {
  for (const sendState of ['not_sent', 'dispatching']) {
    for (const cancelled of [false, true]) {
      // Once dispatch has begun, cancelRequested follows the existing stop
      // workflow rather than the before-send cancellation guard.
      if (cancelled && sendState === 'dispatching') continue;
      const { bridge, ui, client } = harness();
      const job = jobForAgent();
      bridge._readSelectedAgentModelConfig = async () => configuration();
      await bridge._applyModelPreference(client, preference, job);
      job.sendState = sendState;
      const transportError = Object.assign(new Error('recheck connection reset'), { code: 'ECONNRESET' });
      bridge._readSelectedAgentModelConfig = async () => {
        if (!cancelled) throw transportError;
        job.cancelRequested = true;
        return configuration();
      };
      await assert.rejects(bridge._verifyModelPreferenceBeforeSend(client, job, 'before_send'), error => {
        if (cancelled) assert.equal(error.cancelled, true);
        else {
          assert.equal(error, transportError);
          assert.equal(error.code, 'ECONNRESET');
        }
        assert.equal(error.sent, sendState === 'dispatching');
        assert.equal(error.confirmedNotSent, sendState === 'not_sent');
        return true;
      });
      assert.equal(job.modelSelection.applied, false);
      assert.equal(job.sendState, sendState);
      assert.deepEqual(ui, []);
    }
  }
});

test('changed configuration during dispatching retains possible-send status without UI fallback', async () => {
  const { bridge, ui, client } = harness();
  const job = jobForAgent();
  bridge._readSelectedAgentModelConfig = async () => configuration();
  await bridge._applyModelPreference(client, preference, job);
  job.sendState = 'dispatching';
  const changed = configuration();
  changed.modelName = 'different-model';
  changed.selectedModels[0].modelId = 'different-model';
  bridge._readSelectedAgentModelConfig = async () => changed;
  await assert.rejects(bridge._verifyModelPreferenceBeforeSend(client, job, 'before_send_fallback'), error => {
    assert.equal(error.code, 'CURSOR_MODEL_CONFIGURATION_CHANGED');
    assert.equal(error.sent, true);
    assert.equal(error.confirmedNotSent, false);
    return true;
  });
  assert.equal(job.modelSelection.applied, false);
  assert.equal(job.sendState, 'dispatching');
  assert.deepEqual(ui, []);
});

test('provisional and frozen Agent identities reject a different Agent with identical model settings', async () => {
  for (const identity of [
    { provisionalAgentId: 'local:agent-1', workspaceBinding: { agentId: 'local:agent-1' } },
    {},
  ]) {
    const { bridge, ui, client } = harness();
    const job = { ...identity, modelPreference: preference, sendState: 'not_sent' };
    let snapshot = configuration();
    bridge._readSelectedAgentModelConfig = async () => snapshot;
    const result = await bridge._applyModelPreference(client, preference, job);
    assert.equal(result.applied, true);
    assert.equal(result.verifiedAgentId, 'agent-1');
    assert.equal(result.verifiedComposerId, 'composer-1');
    snapshot = configuration();
    snapshot.agentId = 'agent-2';
    snapshot.owner.agentId = 'agent-2';
    await assert.rejects(bridge._verifyModelPreferenceBeforeSend(client, job, 'before_send'), error => error.code === 'CURSOR_MODEL_CONFIGURATION_CHANGED');
    assert.equal(job.modelSelection.applied, false);
    assert.equal(job.sendState, 'not_sent');
    assert.deepEqual(ui, []);
  }
});

test('contradictory available job identities reject the initial configuration without UI', async () => {
  for (const identity of [
    { agentId: 'local:agent-1', provisionalAgentId: 'local:agent-2' },
    { provisionalAgentId: 'local:agent-1', workspaceBinding: { agentId: 'local:agent-2' } },
    { agentId: 'local:agent-1', workspaceBindingChecks: { after_create: { agentId: 'local:agent-2' } } },
  ]) {
    const { bridge, ui, client } = harness();
    const job = { ...identity, modelPreference: preference, sendState: 'not_sent' };
    bridge._readSelectedAgentModelConfig = async () => configuration();
    await assert.rejects(bridge._applyModelPreference(client, preference, job), error => error.code === 'CURSOR_MODEL_OWNER_CHANGED');
    assert.equal(job.modelSelection.applied, false);
    assert.equal(job.sendState, 'not_sent');
    assert.deepEqual(ui, []);
  }
});
