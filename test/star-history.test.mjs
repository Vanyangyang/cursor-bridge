import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { recordSnapshot, renderStarHistorySvg } from '../scripts/update-star-history.mjs';

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

test('scheduled workflow uses GitHub repository metadata without a managed PAT', () => {
  const workflow = readFileSync(new URL('.github/workflows/star-history.yml', root), 'utf8');
  assert.match(workflow, /schedule:/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /contents: write/);
  assert.match(workflow, /node scripts\/update-star-history\.mjs --fetch/);
  assert.match(workflow, /GITHUB_TOKEN: \$\{\{ github\.token \}\}/);
  assert.doesNotMatch(workflow, /STAR_HISTORY_TOKEN|secrets\./);
});

test('both READMEs embed the repository-owned generated chart', () => {
  for (const readme of ['README.md', 'README.zh-CN.md']) {
    const content = readFileSync(new URL(readme, root), 'utf8');
    assert.match(content, /\.\/assets\/star-history\.svg/);
    assert.doesNotMatch(content, /api\.star-history\.com/);
    assert.doesNotMatch(content, /Vanyangyang\/cursor-bridge\/stargazers/);
  }
});
