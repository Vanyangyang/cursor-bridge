import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function readProjectFile(relativePath) {
  return readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), 'utf8');
}

test('Grok native entries normalize explicit controls without implicit activation', () => {
  const root = 'plugins/grok-build-supervisor/';
  const policy = readProjectFile(root + 'skills/grok-build-supervisor/references/executor-policy.md');
  const transport = readProjectFile(root + 'skills/grok-build-supervisor/SKILL.md');
  const command = readProjectFile(root + 'commands/grok_execute.md');
  assert.equal(existsSync(fileURLToPath(new URL('../' + root + 'skills/grok-executor-mode/SKILL.md', import.meta.url))), false);
  assert.equal(existsSync(fileURLToPath(new URL('../' + root + 'skills/grok-executor-mode/agents/openai.yaml', import.meta.url))), false);
  for (const entry of ['$grok-executor-on', '$grok-executor-off', '/grok-build-supervisor:grok_execute on|off']) {
    assert.ok(policy.includes(entry), entry);
  }
  assert.match(policy, /extra arguments, and implicit skill selection are not control invocations/);
  assert.match(policy, /Selecting the Supervisor skill alone never toggles the mode/);
  assert.match(transport, /#host-entry-normalization/);
  assert.match(transport, /\$grok-build-supervisor init/);
  assert.match(command, /do not require the original slash text after expansion/);
  assert.doesNotMatch(command, /task text, direct Skill invocation,/);
});

test('Grok dedicated controls require no argument and stay explicit-only', () => {
  const root = 'plugins/grok-build-supervisor/';
  const policy = readProjectFile(root + 'skills/grok-build-supervisor/references/executor-policy.md');
  const manifest = JSON.parse(readProjectFile(root + '.codex-plugin/plugin.json'));
  for (const action of ['on', 'off']) {
    const name = `grok-executor-${action}`;
    const skill = readProjectFile(root + `skills/${name}/SKILL.md`);
    const metadata = readProjectFile(root + `skills/${name}/agents/openai.yaml`);
    assert.ok(skill.includes(`name: ${name}`));
    assert.match(skill, /no argument is required/);
    assert.match(skill, /Do not ask the user to type/);
    assert.match(skill, /\.\.\/grok-build-supervisor\/references\/executor-policy\.md/);
    assert.ok(metadata.includes(`display_name: "${action === 'on' ? 'Enable' : 'Disable'} Grok Execution"`));
    assert.match(metadata, /allow_implicit_invocation: false/);
    assert.ok(metadata.includes(`default_prompt: "$${name}"`));
    assert.ok(manifest.interface.defaultPrompt.includes(`$${name}`));
    assert.ok(policy.includes(`$${name}`));
  }
  assert.match(policy, /including reactivation after off/);
  assert.match(readProjectFile(root + 'skills/grok-executor-off/SKILL.md'), /Do not cancel work, disconnect ACP, close the terminal, or stop the Leader/);
});

test('cce-routing skill exposes shared implicit routing with explicit boundaries', () => {
  const skill = readProjectFile('skills/cce-routing/SKILL.md');
  const metadata = readProjectFile('skills/cce-routing/agents/openai.yaml');

  assert.match(skill, /^---\r?\nname: cce-routing\r?\ndescription: /);
  assert.match(skill, /cursor_context_engine/);
  assert.match(skill, /implementation location is unknown/);
  assert.match(skill, /callers and callees/);
  assert.match(skill, /known exact file or symbol can answer the question through direct reading or exact search/);
  assert.match(skill, /make CCE the first project-discovery surface/);
  assert.match(skill, /generic context-mode, grep, or blind local exploration/);
  assert.match(skill, /Verify returned path:line evidence/);
  assert.match(skill, /language of the user's current substantive request/);
  assert.match(skill, /Preserve `CCE_SEARCH_RESULT`/);
  assert.doesNotMatch(skill, /TODO/);
  assert.match(metadata, /default_prompt: "Use \$cce-routing/);
  assert.match(metadata, /value: "cursor-bridge"/);
  assert.match(metadata, /allow_implicit_invocation: true/);
});

test('delegation guidance defers unknown project semantics to CCE routing', () => {
  const delegation = readProjectFile('skills/cursor-delegate/SKILL.md');
  const contract = readProjectFile('skills/cursor-delegate/references/delegation-contract.md');
  assert.match(delegation, /follow `cce-routing` and try `cursor_context_engine` before generic local discovery/);
  assert.match(delegation, /language of the user's current substantive task/);
  assert.match(delegation, /Keep `task_id`, `agent_id`/);
  assert.match(contract, /current user-task language/);
  assert.match(contract, /Preserve paths, commands, identifiers, and machine tokens verbatim/);
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

test('bilingual READMEs keep the combined repository title without a rename notice', () => {
  const english = readProjectFile('README.md').split(/\r?\n/).slice(0, 30).join('\n');
  const chinese = readProjectFile('README.zh-CN.md').split(/\r?\n/).slice(0, 30).join('\n');
  for (const content of [english, chinese]) {
    assert.match(content, /^# Cursor Bridge \+ Grok Build Supervisor$/m);
    assert.doesNotMatch(content, /TEMPORARY_RENAME_NOTICE/);
    assert.doesNotMatch(content, /Grok Superpower/);
  }
  assert.doesNotMatch(english, /Upcoming rename/);
  assert.doesNotMatch(chinese, /即将更名/);
});

test('bilingual READMEs present coordination as added capability of the existing client', () => {
  const english = readProjectFile('README.md');
  const chinese = readProjectFile('README.zh-CN.md');

  assert.match(english, /Use Cursor and Grok Build from the client you already have/);
  assert.match(english, /I still use Codex as my daily client[\s\S]*Claude Code and Pi work the same way/);
  assert.match(english, /By AI client I mean the coding app you already chat with/);
  assert.match(english, /The plugins do not depend on each other[\s\S]*Install Cursor Bridge[\s\S]*Grok Build Supervisor[\s\S]*Installing both/);
  assert.match(english, /I did not add a separate orchestrator/);
  assert.doesNotMatch(english, /Choose one orchestrator|installed directly in Grok Build/);

  assert.match(chinese, /继续用你手头的客户端，接上 Cursor 和 Grok Build/);
  assert.match(chinese, /我自己日常还是 Codex[\s\S]*Claude Code 和 Pi 一样能接/);
  assert.match(chinese, /这里说的 AI 客户端，就是你正在对话的那套编程软件/);
  assert.match(chinese, /两个插件不绑在一起[\s\S]*装 Cursor Bridge[\s\S]*装 Grok Build Supervisor[\s\S]*两个都要/);
  assert.match(chinese, /我没有再做一层协调器/);
  assert.doesNotMatch(chinese, /选择一个编排客户端|直接安装进 Grok Build/);
});

test('bilingual quick starts separate installation, reload, initialization, and first use', () => {
  const english = readProjectFile('README.md');
  const chinese = readProjectFile('README.zh-CN.md');
  const englishSteps = [
    '### 1. Choose your AI client and install what you need',
    '### 2. Restart or reload your AI client',
    '### 3. Initialize the plugin you installed',
    '### 4. Try a real question',
  ];
  const chineseSteps = [
    '### 1. 选择当前 AI 客户端，按需安装',
    '### 2. 重启或重载当前 AI 客户端',
    '### 3. 初始化已经安装的插件',
    '### 4. 拿一个真问题试试',
  ];

  for (const [content, steps] of [[english, englishSteps], [chinese, chineseSteps]]) {
    const positions = steps.map((step) => content.indexOf(step));
    assert.ok(positions.every((position) => position >= 0));
    assert.deepEqual([...positions].sort((a, b) => a - b), positions);
    assert.match(content, /#### Codex/);
    assert.match(content, /#### Claude Code/);
    assert.match(content, /#### Grok Build/);
    assert.match(content, /#### Pi/);
  }
  assert.match(english, /#### Other MCP-capable AI clients/);
  assert.match(chinese, /#### 其他支持 MCP 的 AI 客户端/);
  assert.match(english, /<a id="other-mcp-hosts"><\/a>/);
  assert.match(chinese, /<a id="other-mcp-hosts"><\/a>/);
  assert.match(english, /docs\/ai-install\.md/);
  assert.match(chinese, /docs\/ai-install\.zh-CN\.md/);
  assert.match(english, /Report against the completion standard/);
  assert.match(chinese, /按文末完成标准逐项汇报/);
  const englishOther = english.match(/#### Other MCP-capable AI clients[\s\S]*?(?=### 2\.)/)?.[0] || '';
  const chineseOther = chinese.match(/#### 其他支持 MCP 的 AI 客户端[\s\S]*?(?=### 2\.)/)?.[0] || '';
  assert.match(englishOther, /vanyangyang-cursor-bridge/);
  assert.match(chineseOther, /vanyangyang-cursor-bridge/);
  assert.match(englishOther, /do not use a Pi package/);
  assert.match(chineseOther, /不要借用 Pi 包/);
  assert.doesNotMatch(englishOther, /pi install npm:pi-cursor-bridge/);
  assert.doesNotMatch(chineseOther, /pi install npm:pi-cursor-bridge/);
  assert.match(english, /Cursor Bridge and Grok Build Supervisor install separately: take one, or both/);
  assert.match(chinese, /Cursor Bridge 和 Grok Build Supervisor 分开装：只装一个也行，两个都装也行/);
});

test('public READMEs leave language-adaptation details to release history', () => {
  const readmes = [
    'README.md',
    'README.zh-CN.md',
    'plugins/grok-build-supervisor/README.md',
    'plugins/grok-build-supervisor/README.zh-CN.md',
    'pi-packages/pi-cursor-bridge/README.md',
    'pi-packages/pi-grok-build-supervisor/README.md',
  ].map(readProjectFile).join('\n');
  const cursorChangelog = readProjectFile('CHANGELOG.md');
  const supervisorChangelog = readProjectFile('plugins/grok-build-supervisor/CHANGELOG.md');

  assert.doesNotMatch(readmes, /current task language|runtime adaptation|面向用户的说明会跟随|运行时自适应/);
  assert.match(cursorChangelog, /5\.5\.0[\s\S]*language contract/);
  assert.match(supervisorChangelog, /0\.3\.7[\s\S]*current task language/);
});

test('repository marketplace keeps Cursor Bridge stable and publishes Grok as an isolated plugin', () => {
  const marketplace = JSON.parse(readProjectFile('.agents/plugins/marketplace.json'));
  const cursor = marketplace.plugins.find((plugin) => plugin.name === 'cursor-bridge');
  const grok = marketplace.plugins.find((plugin) => plugin.name === 'grok-build-supervisor');
  const grokManifest = JSON.parse(readProjectFile('plugins/grok-build-supervisor/.codex-plugin/plugin.json'));
  const grokMcp = JSON.parse(readProjectFile('plugins/grok-build-supervisor/.mcp.json'));
  const grokInitCommand = readProjectFile('plugins/grok-build-supervisor/commands/grok_init.md');
  const rootPackage = JSON.parse(readProjectFile('package.json'));
  const codexCursorManifest = JSON.parse(readProjectFile('.codex-plugin/plugin.json'));
  const claudeCursorManifest = JSON.parse(readProjectFile('.claude-plugin/plugin.json'));
  const serverSource = readProjectFile('server.mjs');
  const lifecycleSource = [
    readProjectFile('win-job-breakaway.mjs'),
    readProjectFile('launch-cursor.mjs'),
    serverSource,
  ].join('\n');
  const serverBundle = readProjectFile('dist/cursor-bridge.mjs');
  const claudeMarketplace = JSON.parse(readProjectFile('.claude-plugin/marketplace.json'));
  const claudeCursor = claudeMarketplace.plugins.find((plugin) => plugin.name === 'cursor-bridge');
  const claudeGrok = claudeMarketplace.plugins.find((plugin) => plugin.name === 'grok-build-supervisor');
  const claudeGrokManifest = JSON.parse(readProjectFile('plugins/grok-build-supervisor/.claude-plugin/plugin.json'));

  assert.deepEqual(cursor?.source, { source: 'local', path: './' });
  assert.deepEqual(grok?.source, { source: 'local', path: './plugins/grok-build-supervisor' });
  assert.equal(grokManifest.name, 'grok-build-supervisor');
  assert.match(grokManifest.version, /^0\.4\.3(?:\+codex\..+)?$/);
  assert.deepEqual(grokManifest.mcpServers, {
    'grok-build-supervisor': {
      command: 'node',
      args: ['./dist/grok-build-supervisor.mjs'],
      cwd: '.',
      default_tools_approval_mode: 'approve',
    },
  });
  assert.equal(grokManifest.repository, 'https://github.com/Vanyangyang/cursor-bridge');
  assert.ok(grokManifest.interface.defaultPrompt.some((prompt) => prompt.includes('$grok-build-supervisor init')));
  assert.deepEqual(
    grokMcp.mcpServers['grok-build-supervisor'].args,
    ['${CLAUDE_PLUGIN_ROOT}/dist/grok-build-supervisor.mjs'],
  );
  assert.equal(rootPackage.version, '6.0.4');
  assert.equal(rootPackage.name, 'cursor-bridge-workspace');
  assert.equal(rootPackage.private, true);
  assert.match(rootPackage.scripts.prepublishOnly, /repository root is private/);
  assert.match(codexCursorManifest.version, /^6\.0\.4(?:\+codex\.)?/);
  assert.equal(claudeCursorManifest.version, '6.0.4');
  assert.match(serverSource, /const PLUGIN_VERSION = '6\.0\.4';/);
  for (const content of [lifecycleSource, serverBundle]) {
    assert.match(content, /wmi-hresult-0x80004005/);
    assert.match(content, /spawnAttempts/);
    assert.match(content, /Original supervisor error:/);
  }
  assert.equal(claudeCursor?.source, '.');
  assert.equal(claudeCursor?.version, '6.0.4');
  assert.match(claudeCursor?.description || '', /Cursor 3\.21\.16/);
  assert.equal(claudeGrok?.source, './plugins/grok-build-supervisor');
  assert.equal(claudeGrok?.version, '0.4.3');
  assert.equal(claudeGrokManifest.name, 'grok-build-supervisor');
  assert.equal(claudeGrokManifest.version, '0.4.3');

  const english = readProjectFile('README.md');
  const chinese = readProjectFile('README.zh-CN.md');
  const englishImportant = english.match(/> \[!IMPORTANT\]\r?\n> ([^\r\n]*One-time Windows migration:[^\r\n]*)/)?.[1] || '';
  const chineseImportant = chinese.match(/> \[!IMPORTANT\]\r?\n> ([^\r\n]*Windows 一次性迁移：[^\r\n]*)/)?.[1] || '';
  const englishGrokSection = english.match(/## Grok Build Supervisor \(New\)\r?\n([\s\S]*?)\r?\n## Cursor Bridge/)?.[1] || '';
  const chineseGrokSection = chinese.match(/## Grok Build Supervisor（New）\r?\n([\s\S]*?)\r?\n## Cursor Bridge/)?.[1] || '';
  const englishMigration = english.match(/<a id="windows-update-migration"><\/a>[\s\S]*?(?=\r?\n<details>|$)/)?.[0] || '';
  const chineseMigration = chinese.match(/<a id="windows-update-migration"><\/a>[\s\S]*?(?=\r?\n<details>|$)/)?.[0] || '';
  assert.match(english, /\.\/plugins\/grok-build-supervisor\/README\.md/);
  assert.match(chinese, /\.\/plugins\/grok-build-supervisor\/README\.zh-CN\.md/);
  assert.match(englishImportant, /Cursor Bridge[\s\S]*5\.3\.6 or earlier[\s\S]*5\.4\.0 or any later release[\s\S]*#windows-update-migration/);
  assert.match(chineseImportant, /Cursor Bridge[\s\S]*5\.3\.6 或更早版本[\s\S]*5\.4\.0 或任何后续版本[\s\S]*#windows-update-migration/);
  assert.match(englishGrokSection, /stay on planning and review[\s\S]*Grok Build does the implementation[\s\S]*supervisor follows the run and the checks/i);
  assert.match(chineseGrokSection, /继续做计划和验收[\s\S]*落地交给 Grok Build[\s\S]*跟着看执行和核对/);
  assert.doesNotMatch(englishGrokSection, /optional/i);
  assert.doesNotMatch(chineseGrokSection, /可选/);
  assert.match(english, /Cursor \*\*3\.21\.16\*\*[\s\S]*Cursor Grok 4\.6\/high[\s\S]*both IDE and Agents Window/);
  assert.match(chinese, /Cursor \*\*3\.21\.16\*\*[\s\S]*IDE 与 Agents Window[\s\S]*Cursor Grok 4\.6\/high/);
  assert.doesNotMatch(englishGrokSection, /codex plugin|claude plugin|\/grok_execute|windows-update-migration/);
  assert.doesNotMatch(chineseGrokSection, /codex plugin|claude plugin|\/grok_execute|windows-update-migration/);
  assert.doesNotMatch(englishMigration, /Grok Build Supervisor|grok-build-supervisor/);
  assert.doesNotMatch(chineseMigration, /Grok Build Supervisor|grok-build-supervisor/);
  assert.match(english, /<a id="windows-update-migration"><\/a>\r?\n\r?\n## Update Cursor Bridge/);
  assert.match(chinese, /<a id="windows-update-migration"><\/a>\r?\n\r?\n## 更新 Cursor Bridge/);
  assert.doesNotMatch(english, /<summary><strong>Update Cursor Bridge<\/strong><\/summary>/);
  assert.doesNotMatch(chinese, /<summary><strong>更新 Cursor Bridge<\/strong><\/summary>/);
  for (const content of [english, chinese]) {
    assert.match(content, /<a id="windows-update-migration"><\/a>/);
    assert.match(content, /<a id="one-time-windows-migration"><\/a>/);
    assert.match(content, /5\.4\.0/);
    assert.match(content, /cursor-lifecycle-supervisor\.mjs/);
    assert.match(content, /%LOCALAPPDATA%\\cursor-bridge\\lifecycle\\runtime\\/);
    assert.match(content, /pi update npm:pi-cursor-bridge/);
    assert.doesNotMatch(content, /Get-CimInstance Win32_Process|\$oldPluginProcesses/);
  }
  assert.ok(englishMigration.indexOf('codex plugin marketplace upgrade vanyangyang') < englishMigration.indexOf('### One-time Windows migration'));
  assert.ok(chineseMigration.indexOf('codex plugin marketplace upgrade vanyangyang') < chineseMigration.indexOf('### 从 Cursor Bridge 5.3.6'));
  assert.match(englishMigration, /old Cursor Bridge MCP may disconnect[\s\S]*that is expected/);
  assert.match(chineseMigration, /旧 Cursor Bridge MCP 可能断开[\s\S]*这是预期现象/);
  assert.match(englishMigration, /restart Pi/);
  assert.match(chineseMigration, /重启 Pi/);
  for (const readme of [
    'plugins/grok-build-supervisor/README.md',
    'plugins/grok-build-supervisor/README.zh-CN.md',
  ]) {
    const content = readProjectFile(readme);
    assert.match(content, /claude plugin install grok-build-supervisor@vanyangyang/);
    assert.match(content, /\/grok_init/);
    assert.match(content, /0\.2\.0/);
    assert.doesNotMatch(content, /Get-CimInstance Win32_Process|\$oldPluginProcesses/);
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
  const executorSkill = readProjectFile('plugins/grok-build-supervisor/skills/grok-build-supervisor/references/executor-policy.md');
  const supervisorSkill = readProjectFile('plugins/grok-build-supervisor/skills/grok-build-supervisor/SKILL.md');
  const supervisionFlow = readProjectFile('plugins/grok-build-supervisor/skills/grok-build-supervisor/references/supervision-data-flow.md');
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
  assert.equal(manifest.interface.defaultPrompt.includes('$grok-executor-on'), true);
  assert.equal(manifest.interface.defaultPrompt.includes('$grok-executor-off'), true);
  assert.match(executeCommand, /bind Grok Executor Mode to the current host task's absolute project directory/);
  assert.match(executeCommand, /call `grok_session_open`/);
  assert.match(executeCommand, /OPEN_GROK_SESSION/);
  assert.match(executeCommand, /must not call `grok_session_prompt`/);
  assert.match(executeCommand, /must not be written to global proxy settings/);
  assert.match(executorSkill, /immediately reuse or open its guarded session/);
  assert.match(executorSkill, /Opening the TUI is authorized by `on`, but sending a development prompt is not/);
  assert.match(supervisorSkill, /Call `grok_session_open` during `\/grok_execute on`/);
  assert.match(supervisorSkill, /`progress\.phase`/);
  assert.match(supervisorSkill, /Quiet telemetry alone is neither failure nor a reason to ask the user to reauthorize waiting/);
  assert.match(supervisorSkill, /`progress\.changedFiles`/);
  assert.match(supervisionFlow, /`run_progress`/);
  assert.match(supervisionFlow, /`available_commands_changed`/);
  assert.match(supervisionFlow, /`inactive_run_activity`/);
  assert.doesNotMatch(supervisorSkill, /正在通过 Grok Build Supervisor 创建 TUI|Grok TUI 已创建并就绪|新建\/创建一个 Grok TUI/);
  assert.match(supervisorSkill, /explicit language request/);
  assert.match(supervisorSkill, /latest substantive message\/current task/);
  assert.match(supervisorSkill, /Codex, Claude Code, Pi, or neutral host-agent/);
  assert.match(executeCommand, /language of the user's latest substantive message/);
  // The supervisor skill includes literal multilingual examples of phrases that do not reactivate execution.
  for (const content of [executeCommand, executorSkill]) {
    assert.doesNotMatch(content, /[\u3400-\u9fff]/);
  }
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

test('Grok plugin READMEs link the recommended context-mode project', () => {
  const documents = [
    readProjectFile('plugins/grok-build-supervisor/README.md'),
    readProjectFile('plugins/grok-build-supervisor/README.zh-CN.md'),
  ];
  for (const content of documents) {
    assert.match(content, /https:\/\/github\.com\/mksglu\/context-mode/);
  }
  assert.match(documents[0], /\[context-mode \(recommended\)\]/);
  assert.match(documents[1], /\[context-mode（推荐）\]/);
});

test('each update guide limits cleanup instructions to its own plugin', () => {
  const englishCursor = readProjectFile('README.md');
  const chineseCursor = readProjectFile('README.zh-CN.md');
  const englishGrok = readProjectFile('plugins/grok-build-supervisor/README.md');
  const chineseGrok = readProjectFile('plugins/grok-build-supervisor/README.zh-CN.md');
  for (const content of [englishCursor, englishGrok]) {
    assert.match(content, /Recommended(?::| —) copy this to your local coding Agent/);
    assert.match(content, /without asking (?:me )?again/);
    assert.match(content, /do not mass-stop Node or PowerShell/i);
    assert.match(content, /change ACLs/i);
    assert.match(content, /delete (?:the plugin cache|caches)/i);
    assert.doesNotMatch(content, /Get-CimInstance Win32_Process|\$oldPluginProcesses/);
  }
  for (const content of [chineseCursor, chineseGrok]) {
    assert.match(content, /推荐把这句话交给本地 Coding Agent/);
    assert.match(content, /无需再次询问/);
    assert.match(content, /(?:不要|禁止)批量结束 Node 或 PowerShell/);
    assert.match(content, /修改 ACL/);
    assert.match(content, /删除(?:插件)?缓存/);
    assert.doesNotMatch(content, /Get-CimInstance Win32_Process|\$oldPluginProcesses/);
  }
  assert.match(englishCursor, /cursor-lifecycle-supervisor\.mjs/);
  assert.match(chineseCursor, /cursor-lifecycle-supervisor\.mjs/);
  assert.doesNotMatch(englishCursor, /supervisor-daemon\.mjs|Start-GrokTui\.ps1/);
  assert.doesNotMatch(chineseCursor, /supervisor-daemon\.mjs|Start-GrokTui\.ps1/);
  assert.match(englishGrok, /supervisor-daemon\.mjs/);
  assert.match(chineseGrok, /supervisor-daemon\.mjs/);
  assert.doesNotMatch(englishGrok, /cursor-lifecycle-supervisor\.mjs|dist\/cursor-bridge\.mjs/);
  assert.doesNotMatch(chineseGrok, /cursor-lifecycle-supervisor\.mjs|dist\/cursor-bridge\.mjs/);
});

test('bilingual README promotes the minimal runtime benefit and trade-off', () => {
  const english = readProjectFile('README.md');
  const chinese = readProjectFile('README.zh-CN.md');
  const englishTip = english.match(/> \[!TIP\][\s\S]*?(?=\r?\n\r?\n## Compatibility)/)?.[0] || '';
  const chineseTip = chinese.match(/> \[!TIP\][\s\S]*?(?=\r?\n\r?\n## 兼容性)/)?.[0] || '';

  assert.match(englishTip, /Recommended on Windows 11: minimal runtime/);
  assert.match(englishTip, /manually opening Cursor[\s\S]*Switch CCE to normal mode/);
  assert.match(chineseTip, /Windows 11 推荐：极简模式/);
  assert.match(chineseTip, /手动打开 Cursor[\s\S]*将 CCE 切换到普通模式/);
  assert.doesNotMatch(englishTip, /headless reimplementation|keyboard focus|minimized|maximized|snapped/);
  assert.doesNotMatch(chineseTip, /headless Cursor|键盘焦点|最小化、最大化|贴靠布局/);
  for (const content of [english, chinese]) {
    assert.ok(content.indexOf('> [!TIP]') < content.indexOf('<details>'));
    assert.doesNotMatch(content, /<summary><strong>(?:Minimal runtime details|极简运行时细节)<\/strong><\/summary>/);
  }
});

test('bilingual compatibility docs keep Cursor 3.21.16 acceptance evidence scoped', () => {
  const english = readProjectFile('README.md');
  const chinese = readProjectFile('README.zh-CN.md');
  const changelog = readProjectFile('CHANGELOG.md');

  assert.match(english, /3\.21\.16[\s\S]*Cursor Grok 4\.6\/high[\s\S]*minimal[\s\S]*normal/);
  assert.match(chinese, /3\.21\.16[\s\S]*Cursor Grok 4\.6\/high[\s\S]*`minimal`[\s\S]*normal/);
  for (const pattern of [/3\.21\.16/, /Cursor Grok 4\.6\/high/, /cursor_do/, /minimal/, /normal/]) {
    assert.match(changelog, pattern);
  }
  assert.match(changelog, /3\.17\.8 Agents v2[\s\S]*rowHandlers\.onSelect[\s\S]*selectedAgentId[\s\S]*parallel_agent/);
});

test('compatibility history keeps 6.0.4 current for Cursor 3.21.16 and archives 6.0.3', () => {
  const englishReadme = readProjectFile('README.md');
  const chineseReadme = readProjectFile('README.zh-CN.md');
  const english = readProjectFile('COMPATIBILITY.md');
  const chinese = readProjectFile('COMPATIBILITY.zh-CN.md');
  const data = JSON.parse(readProjectFile('compatibility.json'));

  assert.equal(data.policy, 'latest-only');
  assert.equal(data.candidate, undefined);
  assert.equal(data.current.cursorVersion, '3.21.16');
  assert.equal(data.current.cursorBridgeVersion, '6.0.4');
  assert.equal(data.current.sourceRef, 'main');
  assert.equal(data.current.status, 'current');
  assert.equal(data.current.acceptance.cursorVersionEvidence, 'installed-package-json-and-uninstall-registry-version');
  assert.equal(data.current.acceptance.ideWorkbench, '3.21.16-live-tested-single-window-cce-fifo');
  assert.equal(data.current.acceptance.agentsWindow, '3.21.16-live-tested-single-window-cce-fifo-parallel-session');
  assert.equal(data.current.acceptance.inheritedEvidenceRelease, '6.0.3');
  assert.equal(data.current.acceptance.attachedFallback, 'inherited-not-live-rechecked-on-3.21.16');
  assert.equal(data.current.acceptance.persistentSessions, '3.21.16-three-turn-session-restart-reconcile-and-unread-result-recovery-pass');
  assert.equal(data.current.acceptance.singleWindow, '3.21.16-default-cold-launch-restores-last-closed-type-both-close-orders');
  assert.equal(data.current.acceptance.minimalNormalRuntime, '3.21.16-hidden-cce-and-normal-restoration-pass-agents-window');
  assert.equal(data.current.acceptance.parallelAgentIdentity, '3.21.16-exact-agent-ids-without-fifo-fallback');
  assert.equal(data.current.acceptance.promptSubmission, '3.21.16-live-tested-ide-icon-send-and-agents-button');
  assert.match(data.current.acceptance.knownGaps, /native-6\.0\.4-pickup-pending.*macOS-real-device-acceptance-pending.*ETIMEDOUT-root-UNKNOWN/);
  assert.deepEqual(data.history, [
    {
      cursorVersion: '3.20.21',
      cursorBridgeVersion: '6.0.3',
      gitRef: 'cursor-bridge--v6.0.3',
      status: 'archived',
    },
    {
      cursorVersion: '3.20.17',
      cursorBridgeVersion: '6.0.2',
      gitRef: 'cursor-bridge--v6.0.2',
      status: 'archived',
    },
    {
      cursorVersion: '3.19.19',
      cursorBridgeVersion: '6.0.1',
      gitRef: 'cursor-bridge--v6.0.1',
      status: 'archived',
    },
    {
      cursorVersion: '3.19.13',
      cursorBridgeVersion: '6.0.0',
      gitRef: 'cursor-bridge--v6.0.0',
      status: 'archived',
    },
    {
      cursorVersion: '3.19.13',
      cursorBridgeVersion: '5.10.1',
      gitRef: 'cursor-bridge--v5.10.1',
      status: 'archived',
    },
    {
      cursorVersion: '3.19.13',
      cursorBridgeVersion: '5.10.0',
      gitRef: 'cursor-bridge--v5.10.0',
      status: 'archived',
    },
    {
      cursorVersion: '3.19.7',
      cursorBridgeVersion: '5.9.1',
      gitRef: 'cursor-bridge--v5.9.1',
      status: 'archived',
    },
    {
      cursorVersion: '3.19.7',
      cursorBridgeVersion: '5.9.0',
      gitRef: 'cursor-bridge--v5.9.0',
      status: 'archived',
    },
    {
      cursorVersion: '3.19.7',
      cursorBridgeVersion: '5.8.2',
      gitRef: 'cursor-bridge--v5.8.2',
      status: 'archived',
    },
    {
      cursorVersion: '3.18.25',
      cursorBridgeVersion: '5.8.1',
      gitRef: 'cursor-bridge--v5.8.1',
      status: 'archived',
    },
    {
      cursorVersion: '3.18.25',
      cursorBridgeVersion: '5.8.0',
      gitRef: 'cursor-bridge--v5.8.0',
      status: 'archived',
    },
    {
      cursorVersion: '3.18.9',
      cursorBridgeVersion: '5.7.1',
      gitRef: 'cursor-bridge--v5.7.1',
      status: 'archived',
    },
    {
      cursorVersion: '3.18.9',
      cursorBridgeVersion: '5.7.0',
      gitRef: 'cursor-bridge--v5.7.0',
      status: 'archived',
    },
    {
      cursorVersion: '3.17.21',
      cursorBridgeVersion: '5.6.2',
      gitRef: 'cursor-bridge--v5.6.2',
      status: 'archived',
    },
    {
      cursorVersion: '3.17.21',
      cursorBridgeVersion: '5.6.1',
      gitRef: 'cursor-bridge--v5.6.1',
      status: 'archived',
    },
    {
      cursorVersion: '3.17.21',
      cursorBridgeVersion: '5.6.0',
      gitRef: 'cursor-bridge--v5.6.0',
      status: 'archived',
    },
    {
      cursorVersion: '3.17.19',
      cursorBridgeVersion: '5.5.0',
      gitRef: 'cursor-bridge--v5.5.0',
      status: 'archived',
    },
    {
      cursorVersion: '3.17.8',
      cursorBridgeVersion: '5.4.2',
      gitRef: 'cursor-bridge--v5.4.2',
      status: 'archived',
    },
    {
      cursorVersion: '3.16.29',
      cursorBridgeVersion: '5.4.1',
      gitRef: 'cursor-bridge--v5.4.1',
      status: 'archived',
    },
    {
      cursorVersion: '3.16.17',
      cursorBridgeVersion: '5.4.0',
      gitRef: 'cursor-bridge--v5.4.0',
      status: 'archived',
    },
  ]);

  assert.match(englishReadme, /href="\.\/COMPATIBILITY\.md"/);
  assert.match(chineseReadme, /href="\.\/COMPATIBILITY\.zh-CN\.md"/);
  assert.match(english, /maintains only the latest Cursor release/);
  assert.match(chinese, /只维护 Cursor 最新版本/);
  assert.match(english, /Current maintained baseline[\s\S]*3\.21\.16[\s\S]*6\.0\.4[\s\S]*Native 6\.0\.4 pickup remains pending/);
  assert.match(chinese, /当前维护基线[\s\S]*3\.21\.16[\s\S]*6\.0\.4[\s\S]*原生 6\.0\.4 加载仍待验收/);
  assert.doesNotMatch(english, /Install the current version/);
  assert.doesNotMatch(chinese, /安装当前版本/);
  assert.match(english, /Cursor Bridge 5\.8\.1 — Cursor 3\.18\.25/);
  assert.match(chinese, /Cursor Bridge 5\.8\.1 — Cursor 3\.18\.25/);
  assert.match(english, /codex plugin marketplace add Vanyangyang\/cursor-bridge --ref cursor-bridge--v5\.8\.1/);
  assert.match(english, /Cursor Bridge 5\.8\.0 — Cursor 3\.18\.25/);
  assert.match(chinese, /Cursor Bridge 5\.8\.0 — Cursor 3\.18\.25/);
  assert.match(english, /codex plugin marketplace add Vanyangyang\/cursor-bridge --ref cursor-bridge--v5\.8\.0/);
  assert.match(english, /Cursor Bridge 5\.7\.1 — Cursor 3\.18\.9/);
  assert.match(chinese, /Cursor Bridge 5\.7\.1 — Cursor 3\.18\.9/);
  assert.match(english, /codex plugin marketplace add Vanyangyang\/cursor-bridge --ref cursor-bridge--v5\.7\.1/);
  assert.match(english, /Cursor Bridge 5\.7\.0 — Cursor 3\.18\.9/);
  assert.match(chinese, /Cursor Bridge 5\.7\.0 — Cursor 3\.18\.9/);
  assert.match(english, /codex plugin marketplace add Vanyangyang\/cursor-bridge --ref cursor-bridge--v5\.7\.0/);
  assert.match(english, /Cursor Bridge 5\.6\.2 — Cursor 3\.17\.21/);
  assert.match(chinese, /Cursor Bridge 5\.6\.2 — Cursor 3\.17\.21/);
  assert.match(english, /codex plugin marketplace add Vanyangyang\/cursor-bridge --ref cursor-bridge--v5\.6\.2/);
  assert.match(english, /Cursor Bridge 5\.6\.1 — Cursor 3\.17\.21/);
  assert.match(chinese, /Cursor Bridge 5\.6\.1 — Cursor 3\.17\.21/);
  assert.match(english, /codex plugin marketplace add Vanyangyang\/cursor-bridge --ref cursor-bridge--v5\.6\.1/);
  assert.match(english, /Cursor Bridge 5\.6\.0 — Cursor 3\.17\.21/);
  assert.match(chinese, /Cursor Bridge 5\.6\.0 — Cursor 3\.17\.21/);
  assert.match(english, /codex plugin marketplace add Vanyangyang\/cursor-bridge --ref cursor-bridge--v5\.6\.0/);
  assert.match(english, /Cursor Bridge 5\.5\.0 — Cursor 3\.17\.19/);
  assert.match(chinese, /Cursor Bridge 5\.5\.0 — Cursor 3\.17\.19/);
  assert.match(english, /codex plugin marketplace add Vanyangyang\/cursor-bridge --ref cursor-bridge--v5\.5\.0/);
  assert.match(english, /Cursor Bridge 5\.4\.2 — Cursor 3\.17\.8/);
  assert.match(chinese, /Cursor Bridge 5\.4\.2 — Cursor 3\.17\.8/);
  assert.match(english, /codex plugin marketplace add Vanyangyang\/cursor-bridge --ref cursor-bridge--v5\.4\.2/);
  assert.match(english, /Cursor Bridge 5\.4\.1 — Cursor 3\.16\.29/);
  assert.match(chinese, /Cursor Bridge 5\.4\.1 — Cursor 3\.16\.29/);
  assert.match(english, /codex plugin marketplace add Vanyangyang\/cursor-bridge --ref cursor-bridge--v5\.4\.1/);
  assert.match(english, /Cursor Bridge 5\.4\.0 — Cursor 3\.16\.17/);
  assert.match(chinese, /Cursor Bridge 5\.4\.0 — Cursor 3\.16\.17/);
  assert.match(english, /codex plugin marketplace add Vanyangyang\/cursor-bridge --ref cursor-bridge--v5\.4\.0/);
  assert.match(chinese, /grok plugin install Vanyangyang\/cursor-bridge@cursor-bridge--v5\.4\.0 --trust/);
  assert.doesNotMatch(english + chinese + JSON.stringify(data), /5\.3\.|5\.1\.0|4\.0\.0|3\.2\.0/);
});

test('legacy Workbench live smoke skips before submitting when Cursor exposes only Agents Window', () => {
  const script = readProjectFile('test/live-fifo-cancel-workbench.mjs');
  const skip = script.indexOf("reason: 'legacy-workbench-not-exposed'");
  const submit = script.indexOf('const submitted = await bridge.doTask');

  assert.match(script, /isAgentsWindowTitle/);
  assert.ok(skip >= 0);
  assert.ok(submit > skip);
  assert.match(script, /No task was submitted/);
});
