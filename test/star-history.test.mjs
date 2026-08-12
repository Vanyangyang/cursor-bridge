import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  recordSnapshot,
  renderStarHistorySvg,
  updateReadmeChartCacheKey,
} from '../scripts/update-star-history.mjs';

const root = new URL('../', import.meta.url);

function fixture() {
  return {
    version: 1,
    repository: 'owner/repo',
    repositoryCreatedAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-02T00:00:00Z',
    snapshots: [
      { date: '2025-01-02', stars: 1, kind: 'daily-cumulative' },
    ],
  };
}

test('star history records only changed daily counts', () => {
  const unchanged = recordSnapshot(fixture(), 1, '2025-01-03T08:00:00Z');
  assert.equal(unchanged.changed, false);
  assert.equal(unchanged.history.snapshots.length, 1);

  const changed = recordSnapshot(fixture(), 3, '2025-01-03T08:00:00Z');
  assert.equal(changed.changed, true);
  assert.deepEqual(changed.history.snapshots.at(-1), {
    date: '2025-01-03',
    stars: 3,
    kind: 'repository-count-snapshot',
  });

  const sameDay = recordSnapshot(changed.history, 4, '2025-01-03T20:00:00Z');
  assert.equal(sameDay.history.snapshots.length, 2);
  assert.equal(sameDay.history.snapshots.at(-1).stars, 4);

  assert.throws(
    () => recordSnapshot(changed.history, 2, '2024-12-31T20:00:00Z'),
    /predates the latest snapshot/,
  );
});

test('star history SVG is deterministic and reports the latest snapshot', () => {
  const history = recordSnapshot(fixture(), 7, '2025-02-01T00:00:00Z').history;
  const first = renderStarHistorySvg(history);
  const second = renderStarHistorySvg(history);
  assert.equal(first, second);
  assert.match(first, />7 stars</);
  assert.match(first, /automatically updated 2025-02-01/);
  assert.match(first, /prefers-color-scheme: dark/);
});

test('README chart cache key follows the generated SVG content', () => {
  const readme = [
    '[![Cursor Bridge Star History](./assets/star-history.svg)](https://example.com)',
    '[Download SVG](./assets/star-history.svg)',
    '`./assets/star-history.svg`',
  ].join('\n');
  const first = updateReadmeChartCacheKey(readme, '<svg>20</svg>', 'owner/repo');
  const repeated = updateReadmeChartCacheKey(first, '<svg>20</svg>', 'owner/repo');
  const changed = updateReadmeChartCacheKey(first, '<svg>21</svg>', 'owner/repo');

  assert.match(first, /https:\/\/raw\.githubusercontent\.com\/owner\/repo\/master\/assets\/star-history\.svg\?v=[a-f0-9]{12}/);
  assert.equal(repeated, first);
  assert.notEqual(changed, first);
  assert.match(first, /\[Download SVG\]\(\.\/assets\/star-history\.svg\)/);
  assert.match(first, /`\.\/assets\/star-history\.svg`/);
});

test('scheduled workflow uses GitHub repository metadata without a managed PAT', () => {
  const workflow = readFileSync(new URL('.github/workflows/star-history.yml', root), 'utf8');
  assert.match(workflow, /schedule:/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /contents: write/);
  assert.match(workflow, /node scripts\/update-star-history\.mjs --fetch/);
  assert.match(workflow, /GITHUB_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(workflow, /git diff --quiet -- .*README\.md README\.zh-CN\.md/);
  assert.match(workflow, /git add .*README\.md .*README\.zh-CN\.md/);
  assert.doesNotMatch(workflow, /STAR_HISTORY_TOKEN|secrets\./);
});

test('both READMEs embed the repository-owned generated chart', () => {
  const svg = readFileSync(new URL('assets/star-history.svg', root), 'utf8');
  const cacheKey = createHash('sha256').update(svg).digest('hex').slice(0, 12);
  const expectedUrl = `https://raw.githubusercontent.com/Vanyangyang/cursor-bridge/master/assets/star-history.svg?v=${cacheKey}`;
  for (const readme of ['README.md', 'README.zh-CN.md']) {
    const content = readFileSync(new URL(readme, root), 'utf8');
    assert.ok(content.includes(expectedUrl));
    assert.doesNotMatch(content, /api\.star-history\.com/);
    assert.doesNotMatch(content, /Vanyangyang\/cursor-bridge\/stargazers/);
  }
});
