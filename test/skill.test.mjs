import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function readProjectFile(relativePath) {
  return readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), 'utf8');
}

test('cce-routing skill exposes shared implicit routing with explicit boundaries', () => {
  const skill = readProjectFile('skills/cce-routing/SKILL.md');
  const metadata = readProjectFile('skills/cce-routing/agents/openai.yaml');

  assert.match(skill, /^---\nname: cce-routing\ndescription: /);
  assert.match(skill, /cursor_context_engine/);
  assert.match(skill, /implementation location is unknown/);
  assert.match(skill, /callers and callees/);
  assert.match(skill, /known exact file or symbol can answer the question through direct reading or exact search/);
  assert.match(skill, /make CCE the first project-discovery surface/);
  assert.match(skill, /generic context-mode, grep, or blind local exploration/);
  assert.match(skill, /Verify returned path:line evidence/);
  assert.doesNotMatch(skill, /TODO/);
  assert.match(metadata, /default_prompt: "Use \$cce-routing/);
  assert.match(metadata, /value: "cursor-bridge"/);
  assert.match(metadata, /allow_implicit_invocation: true/);
});

test('delegation guidance defers unknown project semantics to CCE routing', () => {
  const delegation = readProjectFile('skills/cursor-delegate/SKILL.md');
  assert.match(delegation, /follow `cce-routing` and try `cursor_context_engine` before generic local discovery/);
});

test('Codex starter prompts stay user-facing and within manifest limits', () => {
  const manifest = JSON.parse(readProjectFile('.codex-plugin/plugin.json'));
  const prompts = manifest.interface.defaultPrompt;

  assert.ok(Array.isArray(prompts));
  assert.ok(prompts.length > 0 && prompts.length <= 3);
  for (const prompt of prompts) {
    assert.ok(prompt.length <= 128, `starter prompt exceeds 128 characters: ${prompt.length}`);
  }
});

test('repository marketplace keeps Cursor Bridge stable and publishes Grok as an isolated plugin', () => {
  const marketplace = JSON.parse(readProjectFile('.agents/plugins/marketplace.json'));
  const cursor = marketplace.plugins.find((plugin) => plugin.name === 'cursor-bridge');
  const grok = marketplace.plugins.find((plugin) => plugin.name === 'grok-build-supervisor');
  const grokManifest = JSON.parse(readProjectFile('plugins/grok-build-supervisor/.codex-plugin/plugin.json'));
  const grokMcp = JSON.parse(readProjectFile('plugins/grok-build-supervisor/.mcp.json'));
  const grokInitCommand = readProjectFile('plugins/grok-build-supervisor/commands/grok_init.md');
  const claudeMarketplace = JSON.parse(readProjectFile('.claude-plugin/marketplace.json'));
  const claudeCursor = claudeMarketplace.plugins.find((plugin) => plugin.name === 'cursor-bridge');
  const claudeGrok = claudeMarketplace.plugins.find((plugin) => plugin.name === 'grok-build-supervisor');
  const claudeGrokManifest = JSON.parse(readProjectFile('plugins/grok-build-supervisor/.claude-plugin/plugin.json'));

  assert.deepEqual(cursor?.source, { source: 'url', url: './' });
  assert.deepEqual(grok?.source, { source: 'local', path: './plugins/grok-build-supervisor' });
  assert.equal(grokManifest.name, 'grok-build-supervisor');
  assert.equal(grokManifest.mcpServers, './.mcp.json');
  assert.equal(grokManifest.repository, 'https://github.com/Vanyangyang/cursor-bridge');
  assert.ok(grokManifest.interface.defaultPrompt.some((prompt) => prompt.includes('/grok_init')));
  assert.deepEqual(
    grokMcp.mcpServers['grok-build-supervisor'].args,
    ['${CLAUDE_PLUGIN_ROOT}/dist/grok-build-supervisor.mjs'],
  );
  assert.equal(claudeCursor?.source, '.');
  assert.equal(claudeCursor?.version, '5.4.0');
  assert.equal(claudeGrok?.source, './plugins/grok-build-supervisor');
  assert.equal(claudeGrok?.version, '0.2.0');
  assert.equal(claudeGrokManifest.name, 'grok-build-supervisor');
  assert.equal(claudeGrokManifest.version, '0.2.0');

  const english = readProjectFile('README.md');
  const chinese = readProjectFile('README.zh-CN.md');
  assert.match(english, /\.\/plugins\/grok-build-supervisor\/README\.md/);
  assert.match(chinese, /\.\/plugins\/grok-build-supervisor\/README\.zh-CN\.md/);
  for (const content of [english, chinese]) {
    assert.match(content, /5\.4\.0/);
    assert.match(content, /cursor-lifecycle-supervisor\.mjs/);
    assert.match(content, /Get-CimInstance Win32_Process/);
    assert.match(content, /grok-build-supervisor@vanyangyang/);
  }
  for (const readme of [
    'plugins/grok-build-supervisor/README.md',
    'plugins/grok-build-supervisor/README.zh-CN.md',
  ]) {
    const content = readProjectFile(readme);
    assert.match(content, /claude plugin install grok-build-supervisor@vanyangyang/);
    assert.match(content, /\/grok_init/);
    assert.match(content, /0\.2\.0/);
    assert.match(content, /Get-CimInstance Win32_Process/);
  }
  assert.match(grokInitCommand, /call `grok_init`/);
  assert.match(grokInitCommand, /must not create or resume a Grok session/);
  assert.match(grokInitCommand, /only the persistent local proxy configuration/);
  assert.doesNotMatch(grokInitCommand, /bind(?:s|ing)? the current (?:project|workspace)/i);
});

test('Grok proxy setup requires persistent initialization instead of a fixed listener port', () => {
  const productionFiles = [
    'plugins/grok-build-supervisor/scripts/proxy-settings.mjs',
    'plugins/grok-build-supervisor/scripts/proxy-environment.mjs',
    'plugins/grok-build-supervisor/scripts/supervisor-core.mjs',
    'plugins/grok-build-supervisor/scripts/supervisor-transport.mjs',
    'plugins/grok-build-supervisor/scripts/server.mjs',
  ].map(readProjectFile);

  for (const content of productionFiles) assert.doesNotMatch(content, /\b7897\b/);
  assert.match(productionFiles.join('\n'), /GROK_PROXY_NOT_INITIALIZED/);
  assert.match(readProjectFile('plugins/grok-build-supervisor/commands/grok_init.md'), /HTTP CONNECT/);
});

test('Grok activation binds the current workspace and immediately ensures the visible TUI', () => {
  const manifest = JSON.parse(readProjectFile('plugins/grok-build-supervisor/.codex-plugin/plugin.json'));
  const english = readProjectFile('plugins/grok-build-supervisor/README.md');
  const chinese = readProjectFile('plugins/grok-build-supervisor/README.zh-CN.md');
  const executeCommand = readProjectFile('plugins/grok-build-supervisor/commands/grok_execute.md');
  const executorSkill = readProjectFile('plugins/grok-build-supervisor/skills/grok-executor-mode/SKILL.md');
  const supervisorSkill = readProjectFile('plugins/grok-build-supervisor/skills/grok-build-supervisor/SKILL.md');
  const supervisorMetadata = readProjectFile('plugins/grok-build-supervisor/skills/grok-build-supervisor/agents/openai.yaml');

  for (const content of [english, chinese]) {
    assert.match(content, /\/grok_execute on/);
    assert.match(content, /\/grok_execute off/);
    assert.doesNotMatch(content, /presentation:\s*none/);
  }
  assert.doesNotMatch(english, /Create a new Grok TUI|Create a guarded visible TUI/);
  assert.doesNotMatch(chinese, /在当前项目创建一个 Grok TUI|用自然语言创建受监督的可见 TUI/);
  assert.doesNotMatch(english, /Turning the mode on does not open Grok/);
  assert.doesNotMatch(chinese, /开启模式本身不会立即打开 Grok/);
  assert.equal(manifest.interface.defaultPrompt.some((prompt) => /Create a new Grok TUI/i.test(prompt)), false);
  assert.equal(manifest.interface.defaultPrompt.some((prompt) => prompt.includes('/grok_execute on')), true);
  assert.equal(manifest.interface.defaultPrompt.some((prompt) => prompt.includes('/grok_execute off')), true);
  assert.match(executeCommand, /bind Grok Executor Mode to the current host task's absolute project directory/);
  assert.match(executeCommand, /call `grok_session_open`/);
  assert.match(executeCommand, /OPEN_GROK_SESSION/);
  assert.match(executeCommand, /must not call `grok_session_prompt`/);
  assert.match(executeCommand, /must not be written to global proxy settings/);
  assert.match(executorSkill, /immediately reuse or open its guarded session/);
  assert.match(executorSkill, /Opening the TUI is authorized by `on`, but sending a development prompt is not/);
  assert.match(supervisorSkill, /Call `grok_session_open` during `\/grok_execute on`/);
  assert.doesNotMatch(supervisorSkill, /正在通过 Grok Build Supervisor 创建 TUI|Grok TUI 已创建并就绪|新建\/创建一个 Grok TUI/);
  assert.doesNotMatch(supervisorMetadata, /open or resume a guarded Grok TUI/);
});

test('bilingual README documents plugin install and update commands', () => {
  for (const readme of ['README.md', 'README.zh-CN.md']) {
    const content = readProjectFile(readme);
    assert.match(content, /codex plugin marketplace upgrade vanyangyang/);
    assert.match(content, /codex plugin add cursor-bridge@vanyangyang/);
    assert.match(content, /claude plugin update cursor-bridge@vanyangyang/);
  }
});

test('bilingual README promotes the minimal runtime benefit and trade-off', () => {
  const english = readProjectFile('README.md');
  const chinese = readProjectFile('README.zh-CN.md');
  const englishTip = english.match(/> \[!TIP\][\s\S]*?(?=\r?\n\r?\n## Compatibility)/)?.[0] || '';
  const chineseTip = chinese.match(/> \[!TIP\][\s\S]*?(?=\r?\n\r?\n## 兼容性)/)?.[0] || '';

  assert.match(englishTip, /Recommended on Windows 11: minimal runtime/);
  assert.match(englishTip, /manually opening Cursor[\s\S]*Switch CCE to normal mode/);
  assert.match(englishTip, /explicit, persistent opt-in[\s\S]*not a headless reimplementation/);
  assert.match(chineseTip, /Windows 11 推荐：极简模式/);
  assert.match(chineseTip, /手动打开 Cursor[\s\S]*将 CCE 切换到普通模式/);
  assert.match(chineseTip, /显式、持久选择[\s\S]*不是重新实现的 headless Cursor/);
  for (const content of [english, chinese]) {
    assert.ok(content.indexOf('> [!TIP]') < content.indexOf('<details>'));
    assert.doesNotMatch(content, /<summary><strong>(?:Minimal runtime details|极简运行时细节)<\/strong><\/summary>/);
  }
});
