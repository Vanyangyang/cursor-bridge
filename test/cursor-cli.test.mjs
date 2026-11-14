import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { mkdir, mkdtemp, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  classifyCliStderrCategory,
  inspectCursorCli,
  readCursorCliIdentity,
  resolveCursorCliLauncher,
  runCursorCli,
  verifyCursorCliModelSelection,
} from '../cursor-cli.mjs';

const projectPath = await realpath(path.dirname(fileURLToPath(import.meta.url)));
const cli = { brand: 'Cursor', launcher: { command: process.execPath, args: ['cursor-entry.js'] }, models: [{ id: 'grok-4.7-high', name: 'Grok 4.7 High' }] };
const preference = { model: 'grok-4.7', effort: 'high' };
const init = (extra = {}) => ({ type: 'system', subtype: 'init', model: 'Grok 4.7 256K High', cwd: projectPath, session_id: 'session-a', ...extra });
const result = (extra = {}) => ({ type: 'result', subtype: 'success', is_error: false, result: 'final answer', session_id: 'session-a', ...extra });
const line = event => JSON.stringify(event) + '\n';

function fakeProcess(action) {
  const calls = [], stopped = [];
  const spawn = (command, args, options) => {
    const child = new EventEmitter();
    Object.assign(child, { pid: 12345, stdout: new PassThrough(), stderr: new PassThrough() });
    const call = { command, args, options, child, input: '' }; calls.push(call);
    child.stdin = new Writable({ write(chunk, _encoding, callback) { call.input += chunk.toString(); callback(); }, final(callback) { callback(); action(call); } });
    child.finish = (code = 0) => child.emit('close', code, null);
    setImmediate(() => child.emit('spawn'));
    return child;
  };
  const killTree = async child => { stopped.push(child); setImmediate(() => child.finish(1)); return true; };
  return { spawn, killTree, calls, stopped, env: { ...process.env, CURSOR_CONFIG_DIR: path.join(projectPath, 'fixtures', 'missing-native-cli-profile') } };
}

const run = (options, extra = {}) => runCursorCli({ projectPath, prompt: 'hello', modelPreference: preference, cli, ...extra }, {
  env: { ...process.env, CURSOR_CONFIG_DIR: path.join(projectPath, 'fixtures', 'missing-native-cli-profile') }, ...options,
});

test('inspection verifies Cursor branding and parses advertised variants without prompts', async () => {
  const mock = fakeProcess(call => {
    call.child.stdout.write(call.args.includes('--help') ? 'Start the Cursor Agent\n--workspace --output-format stream-json\n' : 'Available models\ngrok-4.7-high - Grok 4.7 High (current, default)\nother-5-low - Other 5 Low\n');
    call.child.finish();
  });
  const found = await inspectCursorCli({ ...mock, launcher: cli.launcher });
  assert.deepEqual(found.models, [{ id: 'grok-4.7-high', name: 'Grok 4.7 High' }, { id: 'other-5-low', name: 'Other 5 Low' }]);
  assert.deepEqual(mock.calls.map(call => call.args.at(-1)), ['--help', 'models']);
  assert.ok(mock.calls.every(call => call.input === '' && call.options.shell === false));
});

test('inspection rejects a non-Cursor agent before requesting its model list', async () => {
  const mock = fakeProcess(call => { call.child.stdout.write('Grok Agent compatible with Cursor --workspace stream-json\n'); call.child.finish(); });
  await assert.rejects(inspectCursorCli({ ...mock, launcher: cli.launcher }), { code: 'CURSOR_CLI_WRONG_BRAND' });
  assert.equal(mock.calls.length, 1);
});

test('safe argv and UTF-8 stdin preserve special characters and success waits for close', async () => {
  let finish, dispatches = 0, initialized;
  const prompt = '中文 "quotes" $() `backticks`\nsecond line & | >';
  const mock = fakeProcess(call => { call.child.stdout.write(line(init()) + line(result())); finish = call.child.finish; });
  let settled = false;
  const pending = run(mock, { prompt, onDispatch: () => dispatches++, onInit: value => { initialized = value; } }).then(value => { settled = true; return value; });
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  const call = mock.calls[0];
  assert.equal(call.input, prompt);
  assert.equal(call.options.shell, false);
  assert.equal(call.options.windowsHide, true);
  assert.equal(call.options.env.CURSOR_BRIDGE_CCE_CLI_CHILD, '1');
  assert.equal(call.options.env.CURSOR_BRIDGE_NO_AUTOLAUNCH, '1');
  assert.equal(call.options.env.CURSOR_BRIDGE_DELEGATION, 'off');
  assert.deepEqual(call.args, ['cursor-entry.js', '--mode', 'ask', '--print', '--output-format', 'stream-json', '--model', 'grok-4.7-high', '--workspace', projectPath, '--trust']);
  assert.equal(call.args.includes(prompt), false);
  assert.equal(dispatches, 1);
  assert.equal(initialized.sessionId, 'session-a');
  finish();
  const answer = await pending;
  assert.equal(answer.result, 'final answer');
  assert.equal(answer.modelSelection.effectiveEffort, 'high');
  assert.equal(answer.modelSelection.cliModel, 'grok-4.7-high');
  assert.equal(answer.modelSelection.verificationSource, 'cursor_cli_init');
});

test('Auto, missing effort, unadvertised and ambiguous variants never spawn', async () => {
  for (const extra of [
    { modelPreference: { model: 'Auto', effort: 'high' } },
    { modelPreference: { model: 'grok-4.7' } },
    { modelPreference: { model: 'grok-4.7', effort: 'low' } },
    { cli: { ...cli, models: [...cli.models, ...cli.models] } },
    { cli: { ...cli, models: [{ id: 'grok-4.7-high', name: 'Grok 4.7 Extra High' }] } },
    { cli: { ...cli, models: [{ id: 'grok-4.7-high', name: 'Other Model High' }] } },
    { cli: { ...cli, models: [{ id: 'grok-4.7-high', name: 'Grok 4.6 High' }] } },
  ]) {
    const mock = fakeProcess(() => assert.fail('invalid preference must not spawn'));
    await assert.rejects(run(mock, extra), error => /^CURSOR_CLI_MODEL_/.test(error.code));
    assert.equal(mock.calls.length, 0);
  }
});

test('an invalid workspace is rejected before any process is spawned', async () => {
  const mock = fakeProcess(() => assert.fail('workspace file must not spawn'));
  await assert.rejects(run(mock, { projectPath: path.join(projectPath, 'missing-probe-project.code-workspace') }));
  assert.equal(mock.calls.length, 0);
});

test('multi-root workspaces preserve every root through cwd and add-dir arguments', async t => {
  const repository = path.dirname(projectPath);
  const directory = path.join(repository, '.tmp', 'cli-probe');
  await mkdir(directory, { recursive: true });
  const workspace = path.join(directory, `multi-root-${process.pid}-${Date.now()}.code-workspace`);
  await writeFile(workspace, JSON.stringify({ folders: [{ path: projectPath }, { path: repository }] }));
  t.after(() => unlink(workspace));
  const mock = fakeProcess(call => { call.child.stdout.write(line(init()) + line(result())); call.child.finish(); });
  const answer = await run(mock, { projectPath: workspace });
  assert.equal(answer.result, 'final answer');
  const call = mock.calls[0];
  assert.equal(call.options.cwd, projectPath);
  assert.equal(call.args[call.args.indexOf('--workspace') + 1], projectPath);
  assert.equal(call.args[call.args.indexOf('--add-dir') + 1], await realpath(repository));
  assert.equal(call.args.filter(value => value === '--add-dir').length, 1);
});

test('wrong cwd, model version, effort and session stop the child and never return partial content', async () => {
  for (const events of [
    [init({ cwd: path.dirname(projectPath) })],
    [init({ model: 'Grok 4.6 High' })],
    [init({ model: 'Grok 4.7 Low' })],
    [init(), result({ session_id: 'session-b' })],
    [init(), { type: 'assistant', message: { content: [{ type: 'text', text: 'partial' }] } }],
  ]) {
    const mock = fakeProcess(call => call.child.stdout.write(events.map(line).join('')));
    await assert.rejects(run(mock), error => {
      assert.equal(error.confirmedTerminal, true);
      assert.equal(error.sent, true);
      return ['CURSOR_CLI_PROTOCOL_ERROR', 'CURSOR_CLI_MODEL_MISMATCH'].includes(error.code);
    });
    assert.equal(mock.stopped.length, 1);
  }
});

test('malformed, truncated, missing and duplicate terminal events cannot succeed', async () => {
  const cases = [
    ['not-json\n', true],
    [line(init()) + JSON.stringify(result()), false],
    [line(init()) + line({ type: 'assistant', session_id: 'session-a', message: { content: [{ type: 'text', text: 'partial only' }] } }), false],
    [line(init()) + line(result()) + line(result()), true],
    [line(init()) + line(init()), true],
    [line(init()) + line(result({ result: '' })), true],
    [line(init()) + line(result({ is_error: true })), true],
  ];
  for (const [output, terminal] of cases) {
    const mock = fakeProcess(call => { call.child.stdout.write(output); setImmediate(() => call.child.finish()); });
    let captured;
    await assert.rejects(run(mock), error => {
      captured = error;
      return error.code === 'CURSOR_CLI_PROTOCOL_ERROR' && error.confirmedTerminal === terminal;
    });
    if (captured?.cliConfigDirectory) await rm(captured.cliConfigDirectory, { recursive: true, force: true });
    if (captured?.cliDataDirectory) await rm(captured.cliDataDirectory, { recursive: true, force: true });
  }
});

test('nonzero exit overrides an otherwise successful result', async () => {
  const mock = fakeProcess(call => { call.child.stdout.write(line(init()) + line(result())); call.child.finish(9); });
  let captured;
  await assert.rejects(run(mock), error => {
    captured = error;
    return error.code === 'CURSOR_CLI_EXIT_ERROR' && error.exitCode === 9 && error.confirmedTerminal === false;
  });
  if (captured?.cliConfigDirectory) await rm(captured.cliConfigDirectory, { recursive: true, force: true });
  if (captured?.cliDataDirectory) await rm(captured.cliDataDirectory, { recursive: true, force: true });
});

test('timeouts and output overflow terminate the process and await close', async () => {
  for (const overflow of [false, true]) {
    const mock = fakeProcess(call => { if (overflow) call.child.stdout.write('x'.repeat(200)); });
    await assert.rejects(run({ ...mock, maxOutputBytes: 100 }, { timeoutMs: 20 }), error => {
      assert.equal(error.code, overflow ? 'CURSOR_CLI_OUTPUT_LIMIT' : 'CURSOR_CLI_TIMEOUT');
      assert.equal(error.confirmedTerminal, true);
      return true;
    });
    assert.equal(mock.stopped.length, 1);
  }
});

test('abort preserves cancellation and confirmed tree-stop evidence', async () => {
  const controller = new AbortController();
  const mock = fakeProcess(() => controller.abort());
  await assert.rejects(run(mock, { signal: controller.signal }), error => error.cancelled === true && error.stopConfirmed === true && error.confirmedTerminal === true);
  assert.equal(mock.stopped.length, 1);
});

test('an already aborted request never spawns or inspects a launcher', async () => {
  const controller = new AbortController(); controller.abort();
  const mock = fakeProcess(() => assert.fail('aborted request spawned'));
  await assert.rejects(run(mock, { cli: undefined, signal: controller.signal }), error => error.cancelled === true && error.confirmedNotSent === true);
  assert.equal(mock.calls.length, 0);
});

test('stderr diagnostics do not expose a full prompt or recognizable credentials', async () => {
  const prompt = 'PRIVATE PROBE PROMPT';
  const mock = fakeProcess(call => {
    call.child.stderr.write(`failed ${prompt} api_key=secret-value Bearer credential-value user@example.test Authorization: Bearer FAKE_REVIEW_SECRET_123 {"api_key":"FAKE_JSON_SECRET_456"}`);
    call.child.finish(1);
  });
  let captured;
  await assert.rejects(run(mock, { prompt }), error => {
    captured = error;
    assert.doesNotMatch(error.message, /PRIVATE PROBE PROMPT|secret-value|credential-value|user@example|FAKE_REVIEW_SECRET_123|FAKE_JSON_SECRET_456/);
    return error.code === 'CURSOR_CLI_EXIT_ERROR';
  });
  if (captured?.cliConfigDirectory) await rm(captured.cliConfigDirectory, { recursive: true, force: true });
  if (captured?.cliDataDirectory) await rm(captured.cliDataDirectory, { recursive: true, force: true });
});

test('unconfirmed cleanup remains possibly sent and nonterminal', async () => {
  const mock = fakeProcess(() => {});
  let captured;
  await assert.rejects(run({ ...mock, killTree: async () => false, closeTimeoutMs: 15 }, { timeoutMs: 10 }), error => {
    captured = error;
    return error.sent === true && error.confirmedTerminal === false;
  });
  if (captured?.cliConfigDirectory) await rm(captured.cliConfigDirectory, { recursive: true, force: true });
  if (captured?.cliDataDirectory) await rm(captured.cliDataDirectory, { recursive: true, force: true });
});

test('an exited parent with an incomplete stream cannot prove that its descendants stopped', async () => {
  for (const output of [line(init()) + '{"partial":', line(init())]) {
    const mock = fakeProcess(call => { call.child.stdout.write(output); call.child.finish(); });
    let captured;
    await assert.rejects(run({ ...mock, killTree: async () => false }), error => {
      captured = error;
      return error.code === 'CURSOR_CLI_PROTOCOL_ERROR' && error.sent === true && error.confirmedTerminal === false;
    });
    if (captured?.cliConfigDirectory) await rm(captured.cliConfigDirectory, { recursive: true, force: true });
    if (captured?.cliDataDirectory) await rm(captured.cliDataDirectory, { recursive: true, force: true });
    assert.equal(mock.stopped.length, 0);
  }
});

test('a real local Node child is stopped on timeout without shell commands', async () => {
  const localCli = { ...cli, launcher: { command: process.execPath, args: ['-e', 'process.stdin.resume(); setInterval(() => {}, 1000)', '--'] } };
  await assert.rejects(run({}, { cli: localCli, timeoutMs: 150 }), error => error.code === 'CURSOR_CLI_TIMEOUT' && error.confirmedTerminal === true);
});

test('a real exited parent cannot manufacture terminal proof while its detached child survives', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cce-exited-parent-'));
  const pidFile = path.join(directory, 'owned-child.pid');
  const program = `const {spawn}=require('node:child_process');const fs=require('node:fs');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});c.unref();fs.writeFileSync(${JSON.stringify(pidFile)},String(c.pid));process.stdout.write(${JSON.stringify(line(init()) + '{"partial":')});`;
  const localCli = { ...cli, launcher: { command: process.execPath, args: ['-e', program, '--'] } };
  let ownedPid;
  let captured;
  try {
    await assert.rejects(run({}, { cli: localCli, timeoutMs: 5000 }), error => {
      captured = error;
      return error.code === 'CURSOR_CLI_PROTOCOL_ERROR' && error.confirmedTerminal === false && error.sent === true;
    });
    ownedPid = Number(await readFile(pidFile, 'utf8'));
    assert.ok(Number.isSafeInteger(ownedPid) && ownedPid > 0);
    assert.doesNotThrow(() => process.kill(ownedPid, 0));
  } finally {
    if (!ownedPid) try { ownedPid = Number(await readFile(pidFile, 'utf8')); } catch {}
    if (Number.isSafeInteger(ownedPid) && ownedPid > 0) try { process.kill(ownedPid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    if (captured?.cliConfigDirectory) await rm(captured.cliConfigDirectory, { recursive: true, force: true });
    if (captured?.cliDataDirectory) await rm(captured.cliDataDirectory, { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  }
});

test('selectVariant resolves fast and cursor-prefixed variants strictly without crossing speed tiers', async () => {
  const mixedCli = {
    brand: 'Cursor',
    launcher: cli.launcher,
    models: [
      { id: 'cursor-grok-4.6-medium', name: 'Grok 4.6 Medium' },
      { id: 'cursor-grok-4.6-medium-fast', name: 'Grok 4.6 Medium Fast' },
    ],
  };

  const fastMock = fakeProcess(call => {
    call.child.stdout.write(line(init({ model: 'Grok 4.6 Medium Fast' })) + line(result()));
    call.child.finish();
  });
  const fastAnswer = await run(fastMock, {
    cli: mixedCli,
    modelPreference: { model: 'grok-4.6-fast', effort: 'medium' },
  });
  assert.equal(fastAnswer.result, 'final answer');
  assert.equal(fastAnswer.modelSelection.cliModel, 'cursor-grok-4.6-medium-fast');
  assert.equal(fastAnswer.modelSelection.effectiveModel, 'grok-4.6-fast');
  assert.equal(fastAnswer.modelSelection.effectiveEffort, 'medium');
  assert.equal(fastMock.calls[0].args[fastMock.calls[0].args.indexOf('--model') + 1], 'cursor-grok-4.6-medium-fast');

  const standardMismatchMock = fakeProcess(call => {
    call.child.stdout.write(line(init({ model: 'Grok 4.6 Medium Fast' })) + line(result()));
  });
  await assert.rejects(
    run(standardMismatchMock, {
      cli: mixedCli,
      modelPreference: { model: 'grok-4.6', effort: 'medium' },
    }),
    error => error.code === 'CURSOR_CLI_MODEL_MISMATCH' && error.confirmedTerminal === true,
  );
  assert.equal(standardMismatchMock.calls[0].args[standardMismatchMock.calls[0].args.indexOf('--model') + 1], 'cursor-grok-4.6-medium');
  assert.equal(standardMismatchMock.stopped.length, 1);

  const missingFastMock = fakeProcess(() => assert.fail('missing fast variant must not spawn'));
  await assert.rejects(
    run(missingFastMock, {
      cli: { ...mixedCli, models: [{ id: 'cursor-grok-4.6-medium', name: 'Grok 4.6 Medium' }] },
      modelPreference: { model: 'grok-4.6-fast', effort: 'medium' },
    }),
    { code: 'CURSOR_CLI_MODEL_UNAVAILABLE' },
  );
  assert.equal(missingFastMock.calls.length, 0);
});

test('runCursorCli isolates MCPs via CURSOR_DATA_DIR, verifies project slug, and detects identity shifts', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cce-cli-identity-'));
  try {
    const entry = path.join(root, 'index.js');
    const exe = process.execPath;
    await writeFile(entry, '// v1\n');
    const id1 = await readCursorCliIdentity({ launcher: { command: exe, args: [entry], wrapper: path.join(root, 'cursor-agent.ps1') }, env: process.env });
    assert.equal(id1.available, true);
    await writeFile(entry, '// version-2-with-different-size\n');
    const id2 = await readCursorCliIdentity({ launcher: { command: exe, args: [entry], wrapper: path.join(root, 'cursor-agent.ps1') }, env: process.env });
    assert.notEqual(id1.key, id2.key);

    let seenDataDir;
    const mock = fakeProcess(async call => {
      const dataDir = call.options.env.CURSOR_DATA_DIR;
      seenDataDir = dataDir;
      assert.ok(dataDir);
      const projects = await (await import('node:fs/promises')).readdir(path.join(dataDir, 'projects'));
      assert.equal(projects.length, 1);
      const disabled = JSON.parse(await readFile(path.join(dataDir, 'projects', projects[0], 'mcp-disabled.json'), 'utf8'));
      assert.deepEqual(disabled, ['mock-mcp']);
      call.child.stdout.write(line(init()) + line(result()));
      call.child.finish();
    });
    const out = await runCursorCli(
      { projectPath, prompt: 'hello', modelPreference: preference, cli },
      { ...mock, enumerateMcpImpl: async () => ({ ids: ['mock-mcp'], partialErrorCategory: null }) },
    );
    assert.equal(out.cliTransport, 'print');
    assert.equal(out.mcpIsolation.enabled, true);
    assert.equal(out.mcpIsolation.disabledCount, 1);
    assert.equal(out.mcpIsolation.verified, true);
    await assert.rejects(readFile(path.join(seenDataDir, 'projects')), { code: 'ENOENT' });

    const mismatchMock = fakeProcess(async call => {
      await mkdir(path.join(call.options.env.CURSOR_DATA_DIR, 'projects', 'different-slug'), { recursive: true });
      call.child.stdout.write(line(init()) + line(result()));
      call.child.finish();
    });
    const mismatchOut = await runCursorCli(
      { projectPath, prompt: 'hello', modelPreference: preference, cli },
      { ...mismatchMock, enumerateMcpImpl: async () => ({ ids: ['mock-mcp'], partialErrorCategory: null }) },
    );
    assert.equal(mismatchOut.mcpIsolation.verified, false);
    assert.equal(mismatchOut.mcpIsolation.reason, 'slug_mismatch');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('resolveCursorCliLauncher discovers Windows/POSIX candidates and non-date version fallbacks', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cce-cli-launcher-'));
  try {
    const winUser = path.join(root, 'win-user');
    const localBin = path.join(winUser, '.local', 'bin');
    const customVersion = path.join(localBin, 'versions', 'custom-build');
    await mkdir(customVersion, { recursive: true });
    const wrapper = path.join(localBin, 'cursor-agent.ps1');
    const customNode = path.join(customVersion, 'node.exe');
    const customEntry = path.join(customVersion, 'index.js');
    await writeFile(wrapper, '& "$PSScriptRoot\\versions\\custom-build\\node.exe" "$PSScriptRoot\\versions\\custom-build\\index.js"\n');
    await writeFile(customNode, '');
    await writeFile(customEntry, '');

    const fallbackResolved = await resolveCursorCliLauncher({
      platform: 'win32',
      env: { USERPROFILE: winUser, PATH: '' },
    });
    assert.equal(fallbackResolved.command, await realpath(customNode));
    assert.deepEqual(fallbackResolved.args, [await realpath(customEntry)]);
    assert.equal(fallbackResolved.wrapper, await realpath(wrapper));

    const dateVersion = path.join(localBin, 'versions', '2026.11.14-abc1234');
    await mkdir(dateVersion, { recursive: true });
    const dateNode = path.join(dateVersion, 'node.exe');
    const dateEntry = path.join(dateVersion, 'index.js');
    await writeFile(dateNode, '');
    await writeFile(dateEntry, '');

    const datedResolved = await resolveCursorCliLauncher({
      platform: 'win32',
      env: { USERPROFILE: winUser, PATH: '' },
    });
    assert.equal(datedResolved.command, await realpath(dateNode));

    const winAppData = path.join(root, 'win-roaming');
    const exeDir = path.join(winAppData, 'cursor-agent');
    await mkdir(exeDir, { recursive: true });
    const exePath = path.join(exeDir, 'cursor-agent.exe');
    await writeFile(exePath, '');
    const exeResolved = await resolveCursorCliLauncher({
      platform: 'win32',
      env: { APPDATA: winAppData, PATH: '' },
    });
    assert.equal(exeResolved.command, await realpath(exePath));

    const posixHomeA = path.join(root, 'posix-a');
    await mkdir(path.join(posixHomeA, '.local', 'bin'), { recursive: true });
    const posixBinA = path.join(posixHomeA, '.local', 'bin', 'cursor-agent');
    await writeFile(posixBinA, '#!/bin/sh\n');
    const posixResolvedA = await resolveCursorCliLauncher({
      platform: 'linux',
      env: { HOME: posixHomeA, PATH: '' },
    });
    assert.equal(posixResolvedA.command, await realpath(posixBinA));

    const posixHomeB = path.join(root, 'posix-b');
    await mkdir(path.join(posixHomeB, '.cursor', 'bin'), { recursive: true });
    const posixBinB = path.join(posixHomeB, '.cursor', 'bin', 'agent');
    await writeFile(posixBinB, '#!/bin/sh\n');
    const posixResolvedB = await resolveCursorCliLauncher({
      platform: 'darwin',
      env: { HOME: posixHomeB, PATH: '' },
    });
    assert.equal(posixResolvedB.command, await realpath(posixBinB));

    await assert.rejects(
      resolveCursorCliLauncher({ platform: 'linux', env: { HOME: path.join(root, 'empty-home'), PATH: '' } }),
      { code: 'CURSOR_CLI_UNAVAILABLE' },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('classifyCliStderrCategory and verifyCursorCliModelSelection validate stderr categories and model variants', async () => {
  assert.equal(classifyCliStderrCategory(''), null);
  assert.equal(classifyCliStderrCategory('Not authenticated. Please login.'), 'auth');
  assert.equal(classifyCliStderrCategory('Workspace is untrusted'), 'trust');
  assert.equal(classifyCliStderrCategory('ECONNREFUSED 127.0.0.1:443'), 'network');
  assert.equal(classifyCliStderrCategory('HTTP 429 too many requests'), 'rate_limit');
  assert.equal(classifyCliStderrCategory('Unknown model selected'), 'model');
  assert.equal(classifyCliStderrCategory('Request timed out'), 'timeout');
  assert.equal(classifyCliStderrCategory('Unhandled assertion failure'), 'unknown');

  const authMock = fakeProcess(call => {
    call.child.stderr.write('Not authenticated. Run agent login first. Bearer sk-secret-token-123456\n');
    call.child.finish(1);
  });
  await assert.rejects(
    inspectCursorCli({ ...authMock, launcher: cli.launcher }),
    err => err.code === 'CURSOR_CLI_EXIT_ERROR'
      && err.diagnosticCategory === 'auth'
      && /authentication failed/i.test(err.message)
      && !err.message.includes('sk-secret-token'),
  );

  const selected = verifyCursorCliModelSelection(
    { brand: 'Cursor', models: [{ id: 'cursor-grok-4.6-medium-fast', name: 'Grok 4.6 Medium Fast' }] },
    { model: 'grok-4.6-fast', effort: 'medium' },
  );
  assert.equal(selected.selected.id, 'cursor-grok-4.6-medium-fast');
  assert.equal(selected.effort, 'medium');

  assert.throws(
    () => verifyCursorCliModelSelection(cli, { model: 'auto', effort: 'high' }),
    { code: 'CURSOR_CLI_MODEL_REQUIRED' },
  );
  assert.throws(
    () => verifyCursorCliModelSelection(cli, { model: 'missing-model', effort: 'high' }),
    { code: 'CURSOR_CLI_MODEL_UNAVAILABLE' },
  );
  assert.throws(
    () => verifyCursorCliModelSelection({ brand: 'Cursor', models: [] }, preference),
    { code: 'CURSOR_CLI_MODELS_UNAVAILABLE' },
  );

  const providerCli = {
    brand: 'Cursor',
    providerVerification: { catalogueVerified: true },
    preference: { model: 'example-reasoner', effort: 'xhigh' },
    models: [{ id: 'example-reasoner' }],
  };
  const providerSelected = verifyCursorCliModelSelection(providerCli, { model: 'example-reasoner', effort: 'xhigh' });
  assert.equal(providerSelected.selected.id, 'example-reasoner');
  assert.throws(
    () => verifyCursorCliModelSelection(providerCli, { model: 'example-reasoner', effort: 'low' }),
    { code: 'CURSOR_CLI_MODEL_UNAVAILABLE' },
  );
});
