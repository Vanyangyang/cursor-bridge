import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));

function readProjectFile(relativePath) {
  return readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), 'utf8');
}

test('AI install manifest matches committed bundles, skills, and commands', () => {
  const manifest = JSON.parse(readProjectFile('docs/ai-install.manifest.json'));
  assert.equal(manifest.version, 1);
  assert.equal(manifest.windowsOnly, true);
  assert.deepEqual(manifest.firstClassHosts, ['codex', 'claude-code', 'grok-build', 'pi']);
  assert.equal(manifest.durableCheckout.windows, '%LOCALAPPDATA%\\cursor-bridge\\checkout');

  const cursor = manifest.products['cursor-bridge'];
  const grok = manifest.products['grok-build-supervisor'];
  assert.equal(cursor.required, true);
  assert.equal(grok.required, false);
  assert.deepEqual(cursor.requiredTools, [
    'cursor_init',
    'cursor_context_engine',
    'cursor_status',
    'cursor_model',
  ]);

  for (const relativePath of [
    cursor.mcp.bundle,
    ...cursor.skills.map((skill) => join(skill.path, 'SKILL.md')),
    join('skills', 'cursor-delegate', 'references', 'delegation-contract.md'),
    grok.mcp.bundle,
    ...grok.skills.map((skill) => join(skill.path, 'SKILL.md')),
    ...grok.commands.map((command) => command.path),
    ...cursor.claudeCodeOnly.hooks,
  ]) {
    assert.equal(existsSync(join(repositoryRoot, relativePath)), true, relativePath);
  }
});

test('bilingual AI install playbooks share the same completion standard', () => {
  const english = readProjectFile('docs/ai-install.md');
  const chinese = readProjectFile('docs/ai-install.zh-CN.md');
  const manifest = JSON.parse(readProjectFile('docs/ai-install.manifest.json'));

  assert.match(english, /^# Cursor Bridge AI Install/m);
  assert.match(chinese, /^# Cursor Bridge AI 安装剧本/m);
  assert.match(english, /## Completion standard/);
  assert.match(chinese, /## 完成标准/);

  for (const content of [english, chinese]) {
    assert.match(content, /ai-install\.manifest\.json/);
    assert.match(content, /%LOCALAPPDATA%\\cursor-bridge\\checkout/);
    assert.match(content, /Windows only|只支持 Windows/);
    assert.match(content, /first-class marketplace \| generic-ai-install/);
    assert.match(content, /result: PASS \| FAIL/);
    assert.match(content, /skills_unsupported/);
    assert.match(content, /close_cursor_and_retry/);
    assert.match(content, /do not restore `cursor-mcp-bridge`|不要恢复 `cursor-mcp-bridge`/i);
    assert.doesNotMatch(content, /print-generic-mcp/);
    for (const tool of manifest.products['cursor-bridge'].requiredTools) {
      assert.match(content, new RegExp(tool));
    }
    for (const skill of manifest.products['cursor-bridge'].skills) {
      assert.match(content, new RegExp(skill.name));
    }
  }

  assert.match(english, /Do not rewrite, summarize, or flatten/);
  assert.match(chinese, /不要改写、摘要或打平/);
  assert.match(english, /Stop this playbook/);
  assert.match(chinese, /停止本剧本/);
  assert.match(english, /`result` is `PASS` while `init` is not `ready`/);
  assert.match(chinese, /`result` 写成 `PASS`，但 `init` 不是 `ready`/);
});

test('public READMEs send other hosts to the AI install playbook', () => {
  const english = readProjectFile('README.md');
  const chinese = readProjectFile('README.zh-CN.md');
  const englishGrok = readProjectFile('plugins/grok-build-supervisor/README.md');
  const chineseGrok = readProjectFile('plugins/grok-build-supervisor/README.zh-CN.md');

  assert.match(english, /docs\/ai-install\.md completely/);
  assert.match(chinese, /docs\/ai-install\.zh-CN\.md/);
  assert.match(english, /not a first-class host/);
  assert.match(chinese, /不是一等宿主/);
  assert.match(englishGrok, /docs\/ai-install\.md/);
  assert.match(chineseGrok, /docs\/ai-install\.zh-CN\.md/);
  assert.doesNotMatch(english + chinese, /print-generic-mcp/);
});
