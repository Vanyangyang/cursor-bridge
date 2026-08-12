#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, '..');
const DATA_FILE = resolve(ROOT, 'assets', 'star-history.json');
const SVG_FILE = resolve(ROOT, 'assets', 'star-history.svg');
const README_FILES = [resolve(ROOT, 'README.md'), resolve(ROOT, 'README.zh-CN.md')];

function utcDay(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`invalid observation date: ${value}`);
  return date.toISOString().slice(0, 10);
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function niceStep(maximum) {
  if (maximum <= 5) return 1;
  const raw = maximum / 4;
  const power = 10 ** Math.floor(Math.log10(raw));
  const normalized = raw / power;
  const factor = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return factor * power;
}

function formatMonth(timestamp) {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(timestamp));
}

export function normalizeHistory(value) {
  if (!value || typeof value !== 'object') throw new Error('star history must be an object');
  const repository = String(value.repository || '').trim();
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) throw new Error('repository must use owner/name form');
  const createdAt = new Date(value.repositoryCreatedAt);
  if (!Number.isFinite(createdAt.getTime())) throw new Error('repositoryCreatedAt must be an ISO timestamp');

  const snapshots = Array.isArray(value.snapshots) ? value.snapshots.map((entry) => {
    const stars = Number(entry && entry.stars);
    if (!Number.isInteger(stars) || stars < 0) throw new Error('snapshot stars must be a non-negative integer');
    return {
      date: utcDay(entry && entry.date),
      stars,
      kind: String(entry && entry.kind || 'repository-count-snapshot'),
    };
  }) : [];

  snapshots.sort((a, b) => a.date.localeCompare(b.date));
  for (let index = 1; index < snapshots.length; index += 1) {
    if (snapshots[index - 1].date === snapshots[index].date) {
      throw new Error(`duplicate snapshot date: ${snapshots[index].date}`);
    }
  }

  return {
    version: 1,
    repository,
    repositoryCreatedAt: createdAt.toISOString(),
    updatedAt: value.updatedAt ? new Date(value.updatedAt).toISOString() : createdAt.toISOString(),
    sources: value.sources && typeof value.sources === 'object' ? value.sources : {},
    snapshots,
  };
}

export function recordSnapshot(historyValue, starsValue, observedAt = new Date().toISOString()) {
  const history = normalizeHistory(historyValue);
  const stars = Number(starsValue);
  if (!Number.isInteger(stars) || stars < 0) throw new Error('star count must be a non-negative integer');
  const date = utcDay(observedAt);
  const existing = history.snapshots.find((entry) => entry.date === date);
  const previous = history.snapshots.at(-1);

  if (!existing && previous && date < previous.date) {
    throw new Error(`observation date ${date} predates the latest snapshot ${previous.date}`);
  }

  if (existing) {
    if (existing.stars === stars) return { history, changed: false };
    existing.stars = stars;
    existing.kind = 'repository-count-snapshot';
  } else {
    if (previous && previous.stars === stars) return { history, changed: false };
    history.snapshots.push({ date, stars, kind: 'repository-count-snapshot' });
    history.snapshots.sort((a, b) => a.date.localeCompare(b.date));
  }

  history.updatedAt = new Date(observedAt).toISOString();
  return { history, changed: true };
}

export function renderStarHistorySvg(historyValue) {
  const history = normalizeHistory(historyValue);
  const width = 900;
  const height = 500;
  const left = 80;
  const right = 850;
  const top = 80;
  const bottom = 410;
  const createdMs = new Date(history.repositoryCreatedAt).getTime();
  const lastSnapshot = history.snapshots.at(-1) || { date: utcDay(history.repositoryCreatedAt), stars: 0 };
  const endMs = Math.max(createdMs + 86400000, new Date(`${lastSnapshot.date}T23:59:59Z`).getTime());
  const latestStars = lastSnapshot.stars;
  const maximumStars = Math.max(1, ...history.snapshots.map((entry) => entry.stars));
  const yStep = niceStep(maximumStars);
  let yMaximum = Math.max(yStep, Math.ceil(maximumStars / yStep) * yStep);
  if (yMaximum === maximumStars) yMaximum += yStep;
  const scaleX = (timestamp) => left + ((timestamp - createdMs) / (endMs - createdMs)) * (right - left);
  const scaleY = (stars) => bottom - (stars / yMaximum) * (bottom - top);
  const points = [
    { timestamp: createdMs, stars: 0 },
    ...history.snapshots.map((entry) => ({
      timestamp: new Date(`${entry.date}T23:59:59Z`).getTime(),
      stars: entry.stars,
    })),
  ];

  let linePath = `M${left} ${scaleY(0).toFixed(2)}`;
  for (const point of points.slice(1)) {
    const x = scaleX(point.timestamp).toFixed(2);
    const y = scaleY(point.stars).toFixed(2);
    linePath += ` H${x} V${y}`;
  }
  linePath += ` H${right}`;
  const areaPath = `${linePath} V${bottom} H${left} Z`;

  const yTicks = [];
  for (let value = 0; value <= yMaximum; value += yStep) yTicks.push(value);
  const xTicks = [createdMs, createdMs + (endMs - createdMs) / 2, endMs];
  const updatedDay = utcDay(history.updatedAt);
  const repositoryName = history.repository.split('/').at(-1);
  const title = `${repositoryName} — Star History`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">
  <title id="title">${escapeXml(title)}</title>
  <desc id="desc">GitHub star observations from ${formatMonth(createdMs)} through ${formatMonth(endMs)}, latest snapshot ${latestStars} stars.</desc>
  <style>
    :root { --bg: #ffffff; --fg: #1f2328; --muted: #656d76; --grid: #d8dee4; --line: #1f883d; --dot: #2da44e; --fill: #dafbe1; }
    @media (prefers-color-scheme: dark) { :root { --bg: #0d1117; --fg: #f0f6fc; --muted: #8b949e; --grid: #30363d; --line: #3fb950; --dot: #56d364; --fill: #12261e; } }
    text { font-family: "Comic Sans MS", "Comic Sans", cursive; fill: var(--fg); }
    .muted { fill: var(--muted); }
    .grid { stroke: var(--grid); stroke-width: 1; stroke-dasharray: 5 7; }
  </style>
  <defs>
    <filter id="sketch" x="-3%" y="-3%" width="106%" height="106%">
      <feTurbulence type="fractalNoise" baseFrequency="0.012" numOctaves="2" seed="7" result="noise" />
      <feDisplacementMap in="SourceGraphic" in2="noise" scale="1.25" xChannelSelector="R" yChannelSelector="G" />
    </filter>
    <linearGradient id="area" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="var(--fill)" stop-opacity="0.85" />
      <stop offset="1" stop-color="var(--fill)" stop-opacity="0.18" />
    </linearGradient>
  </defs>
  <rect width="${width}" height="${height}" rx="18" fill="var(--bg)" />
  <text x="62" y="48" font-size="27" font-weight="700">${escapeXml(title)}</text>
  <text x="838" y="48" text-anchor="end" font-size="17" class="muted">${latestStars} stars</text>
  <g aria-hidden="true">
${yTicks.map((value) => {
    const y = scaleY(value).toFixed(2);
    return `    <line x1="${left}" y1="${y}" x2="${right}" y2="${y}" class="grid" />\n    <text x="61" y="${(Number(y) + 6).toFixed(2)}" text-anchor="end" font-size="15" class="muted">${value}</text>`;
  }).join('\n')}
    <line x1="${left}" y1="${top}" x2="${left}" y2="${bottom}" stroke="var(--fg)" stroke-width="2" />
    <line x1="${left}" y1="${bottom}" x2="${right}" y2="${bottom}" stroke="var(--fg)" stroke-width="2" />
    <text x="${left}" y="440" font-size="15" class="muted">${formatMonth(xTicks[0])}</text>
    <text x="${(left + right) / 2}" y="440" text-anchor="middle" font-size="15" class="muted">${formatMonth(xTicks[1])}</text>
    <text x="${right}" y="440" text-anchor="end" font-size="15" class="muted">${formatMonth(xTicks[2])}</text>
  </g>
  <path d="${areaPath}" fill="url(#area)" />
  <path d="${linePath}" fill="none" stroke="var(--line)" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" filter="url(#sketch)" />
  <g fill="var(--dot)" stroke="var(--bg)" stroke-width="2">
${points.slice(1).map((point, index) => `    <circle cx="${scaleX(point.timestamp).toFixed(2)}" cy="${scaleY(point.stars).toFixed(2)}" r="${index === points.length - 2 ? 6 : 5}" />`).join('\n')}
  </g>
  <g transform="translate(814 91)" fill="none" stroke="var(--dot)" stroke-width="2.3" stroke-linejoin="round">
    <path d="M0 -12 L3.6 -3.7 L12 -3.7 L5.2 1.4 L7.8 10 L0 5 L-7.8 10 L-5.2 1.4 L-12 -3.7 L-3.6 -3.7 Z" />
  </g>
  <text x="830" y="96" font-size="15" class="muted">${latestStars}</text>
  <text x="80" y="476" font-size="13" class="muted">Source: GitHub API · automatically updated ${updatedDay}</text>
</svg>
`;
}

export function updateReadmeChartCacheKey(content, svg, repository) {
  const cacheKey = createHash('sha256').update(svg).digest('hex').slice(0, 12);
  const chartUrl = `https://raw.githubusercontent.com/${repository}/master/assets/star-history.svg?v=${cacheKey}`;
  const chartPattern = /(!\[Cursor Bridge Star History\]\()(?:\.\/assets\/star-history\.svg|https:\/\/raw\.githubusercontent\.com\/[^\s)]+\/master\/assets\/star-history\.svg)(?:\?v=[a-f0-9]+)?(\))/;
  if (!chartPattern.test(content)) throw new Error('README does not embed the generated star history chart');
  return content.replace(chartPattern, `$1${chartUrl}$2`);
}

async function fetchRepositoryCount(repository, token = process.env.GITHUB_TOKEN) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'cursor-bridge-star-history',
    'X-GitHub-Api-Version': '2026-03-10',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`https://api.github.com/repos/${repository}`, { headers });
  if (!response.ok) throw new Error(`GitHub repository API returned ${response.status}`);
  const value = await response.json();
  if (!Number.isInteger(value.stargazers_count)) throw new Error('GitHub response did not include stargazers_count');
  return value.stargazers_count;
}

function parseArguments(argv) {
  const options = { fetch: false, count: null, at: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--fetch') options.fetch = true;
    else if (argument === '--count') options.count = Number(argv[++index]);
    else if (argument === '--at') options.at = argv[++index];
    else throw new Error(`unknown argument: ${argument}`);
  }
  if (options.fetch && options.count !== null) throw new Error('use either --fetch or --count, not both');
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  let history = normalizeHistory(JSON.parse(readFileSync(DATA_FILE, 'utf8')));
  let historyChanged = false;

  if (options.fetch || options.count !== null) {
    const count = options.fetch ? await fetchRepositoryCount(history.repository) : options.count;
    const recorded = recordSnapshot(history, count, options.at || new Date().toISOString());
    history = recorded.history;
    historyChanged = recorded.changed;
  }

  const serialized = `${JSON.stringify(history, null, 2)}\n`;
  const svg = renderStarHistorySvg(history);
  if (readFileSync(DATA_FILE, 'utf8') !== serialized) writeFileSync(DATA_FILE, serialized, 'utf8');
  if (readFileSync(SVG_FILE, 'utf8') !== svg) writeFileSync(SVG_FILE, svg, 'utf8');
  for (const readmeFile of README_FILES) {
    const content = readFileSync(readmeFile, 'utf8');
    const updated = updateReadmeChartCacheKey(content, svg, history.repository);
    if (content !== updated) writeFileSync(readmeFile, updated, 'utf8');
  }
  console.log(JSON.stringify({
    repository: history.repository,
    stars: history.snapshots.at(-1)?.stars || 0,
    updatedAt: history.updatedAt,
    historyChanged,
  }));
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
