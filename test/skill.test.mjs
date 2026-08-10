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
  assert.match(skill, /Verify returned path:line evidence/);
  assert.doesNotMatch(skill, /TODO/);
  assert.match(metadata, /default_prompt: "Use \$cce-routing/);
  assert.match(metadata, /value: "cursor-bridge"/);
  assert.match(metadata, /allow_implicit_invocation: true/);
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

test('bilingual README documents plugin install and update commands', () => {
  for (const readme of ['README.md', 'README.zh-CN.md']) {
    const content = readProjectFile(readme);
    assert.match(content, /codex plugin marketplace upgrade vanyangyang/);
    assert.match(content, /codex plugin add cursor-bridge@vanyangyang/);
    assert.match(content, /claude plugin update cursor-bridge@vanyangyang/);
  }
});
