import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  computeCliProjectSlug,
  createCliConfigScope,
  enumerateNativeMcpServerIds,
  findCliProjectRoot,
} from '../cursor-cli-config.mjs';

test('private CLI profiles preserve native settings and permissions without modifying their source', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cce-native-config-'));
  const settings = '{"model":{"modelId":"auto"},"permissions":{"deny":["Write(*)"]}}\n';
  const permissions = '{"terminalAllowlist":["rg"],"mcpAllowlist":[]}\n';
  let scope;
  try {
    await writeFile(join(directory, 'cli-config.json'), settings);
    await writeFile(join(directory, 'permissions.json'), permissions);
    await writeFile(join(directory, 'auth.json'), 'AUTH_MUST_NOT_BE_COPIED');
    scope = await createCliConfigScope({ CURSOR_CONFIG_DIR: directory, PRESERVED_ENV: 'yes' });
    assert.notEqual(scope.env.CURSOR_CONFIG_DIR, directory);
    assert.equal(scope.env.PRESERVED_ENV, 'yes');
    assert.deepEqual((await readdir(scope.directory)).sort(), ['cli-config.json', 'permissions.json']);
    assert.equal(await readFile(join(scope.directory, 'permissions.json'), 'utf8'), permissions);
    const privateSettings = JSON.parse(await readFile(join(scope.directory, 'cli-config.json'), 'utf8'));
    assert.equal(privateSettings.model.modelId, 'auto');
    assert.ok(privateSettings.permissions.deny.includes('Write(*)'));
    assert.ok(privateSettings.permissions.deny.includes('Mcp(*:cursor_context_engine)'));
    assert.ok(privateSettings.permissions.deny.includes('Mcp(*:cursor_init)'));
    assert.equal(privateSettings.permissions.deny.includes('Mcp(*:*)'), false);
    await writeFile(join(scope.directory, 'cli-config.json'), '{"model":{"modelId":"fixture-model"}}');
    assert.equal(await readFile(join(directory, 'cli-config.json'), 'utf8'), settings);
    assert.equal(await readFile(join(directory, 'permissions.json'), 'utf8'), permissions);
    await scope.cleanup(); await scope.cleanup();
    await assert.rejects(readFile(join(scope.directory, 'cli-config.json')), { code: 'ENOENT' });
  } finally { await scope?.cleanup(); await rm(directory, { recursive: true, force: true }); }
});

test('private CLI profiles default safely for absent settings and reject relative native directories', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cce-empty-native-config-'));
  let scope;
  try {
    scope = await createCliConfigScope({ CURSOR_CONFIG_DIR: directory });
    assert.deepEqual(await readdir(scope.directory), ['cli-config.json']);
    assert.ok(scope.dataDirectory);
    assert.equal(scope.env.CURSOR_DATA_DIR, scope.dataDirectory);
    assert.equal(scope.mcpIsolation.mode, 'no_workspace');
    await assert.rejects(createCliConfigScope({ CURSOR_CONFIG_DIR: 'relative' }), error => error.code === 'CURSOR_CLI_CONFIG_INVALID' && error.confirmedNotSent);
  } finally { await scope?.cleanup(); await rm(directory, { recursive: true, force: true }); }
});

test('findCliProjectRoot and computeCliProjectSlug handle .git directories, worktree .git files, and no-git fallback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cce-slug-root-'));
  try {
    const repo = join(root, 'repo-main');
    const nested = join(repo, 'src', 'nested');
    await mkdir(join(repo, '.git'), { recursive: true });
    await mkdir(nested, { recursive: true });
    assert.equal(await findCliProjectRoot(nested), repo);

    const worktree = join(root, 'worktree-sub');
    const worktreeSub = join(worktree, 'packages', 'app');
    await mkdir(worktreeSub, { recursive: true });
    await writeFile(join(worktree, '.git'), 'gitdir: ../repo-main/.git/worktrees/sub\n');
    assert.equal(await findCliProjectRoot(worktreeSub), worktree);

    const isolated = join(root, 'plain-dir');
    await mkdir(isolated, { recursive: true });
    assert.equal(await findCliProjectRoot(isolated), isolated);

    assert.equal(
      computeCliProjectSlug('C:\\Users\\Administrator\\plugins\\cursor-bridge\\.tmp\\cce-cli-speed'),
      'C-Users-Administrator-plugins-cursor-bridge-tmp-cce-cli-speed',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('enumerateNativeMcpServerIds collects user, project, local and cached plugin MCP servers using JSONC', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cce-mcp-enum-'));
  try {
    const userHome = join(root, 'home');
    const projectRoot = join(root, 'project');
    await mkdir(join(userHome, '.cursor', 'plugins', 'local', 'local-alpha', '.cursor-plugin'), { recursive: true });
    await mkdir(join(userHome, '.cursor', 'plugins', 'local', 'dir-fallback'), { recursive: true });
    await mkdir(join(userHome, '.cursor', 'plugins', 'cache', 'mkt', 'cached-beta', 'sha1', '.claude-plugin'), { recursive: true });
    await mkdir(join(projectRoot, '.cursor'), { recursive: true });

    await writeFile(join(userHome, '.cursor', 'mcp.json'), '// comment\n{\n  "mcpServers": {\n    "user-srv": {"command": "node"},\n  },\n}\n');
    await writeFile(join(projectRoot, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { 'proj-srv': { command: 'node' } } }));
    await writeFile(join(userHome, '.cursor', 'plugins', 'local', 'local-alpha', '.cursor-plugin', 'plugin.json'), JSON.stringify({ name: 'alpha' }));
    await writeFile(join(userHome, '.cursor', 'plugins', 'local', 'local-alpha', 'mcp.json'), JSON.stringify({ mcpServers: { svc: { url: 'https://example.invalid/mcp' } } }));
    await writeFile(join(userHome, '.cursor', 'plugins', 'local', 'dir-fallback', '.mcp.json'), JSON.stringify({ directSrv: { command: 'npx' } }));
    await writeFile(
      join(userHome, '.cursor', 'plugins', 'cache', 'mkt', 'cached-beta', 'sha1', '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'beta-pkg', mcpServers: { inlineSrv: { command: 'node' } } }),
    );
    await writeFile(
      join(userHome, '.cursor', 'plugins', 'cache', 'mkt', 'cached-beta', 'sha1', '.mcp.json'),
      JSON.stringify({ mcpServers: { fileSrv: { command: 'node' } } }),
    );

    const result = await enumerateNativeMcpServerIds({ env: {}, projectRoot, userHome });
    assert.deepEqual(result.ids, [
      'plugin-alpha-svc',
      'plugin-beta-pkg-fileSrv',
      'plugin-beta-pkg-inlineSrv',
      'plugin-dir-fallback-directSrv',
      'proj-srv',
      'user-srv',
    ]);
    assert.equal(result.partialErrorCategory, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('createCliConfigScope isolates MCP in CURSOR_DATA_DIR, respects native override, fails open, and checks slug mismatch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cce-data-scope-'));
  let scope, nativeScope, failOpenScope;
  try {
    const userHome = join(root, 'home');
    const configDir = join(userHome, '.cursor');
    const worktree = join(root, 'repo', '.tmp', 'wt');
    await mkdir(join(configDir), { recursive: true });
    await mkdir(join(worktree, 'sub'), { recursive: true });
    await writeFile(join(worktree, '.git'), 'gitdir: ../../.git/worktrees/wt\n');
    await writeFile(join(configDir, 'mcp.json'), JSON.stringify({ mcpServers: { x: { url: 'https://x.invalid' } } }));

    scope = await createCliConfigScope({ CURSOR_CONFIG_DIR: configDir }, { cwd: join(worktree, 'sub'), userHome });
    assert.equal(scope.env.CURSOR_DATA_DIR, scope.dataDirectory);
    assert.equal(scope.mcpIsolation.enabled, true);
    assert.equal(scope.mcpIsolation.mode, 'disabled_list');
    assert.equal(scope.mcpIsolation.disabledCount, 1);
    const disabledPath = join(scope.dataDirectory, 'projects', scope.mcpIsolation.slug, 'mcp-disabled.json');
    assert.deepEqual(JSON.parse(await readFile(disabledPath, 'utf8')), ['x']);
    assert.equal((await scope.verifyProjectSlug()).ok, true);
    assert.equal(scope.mcpIsolation.verified, true);

    await mkdir(join(scope.dataDirectory, 'projects', 'unexpected-other-slug'), { recursive: true });
    const mismatch = await scope.verifyProjectSlug();
    assert.equal(mismatch.ok, false);
    assert.equal(mismatch.reason, 'slug_mismatch');
    assert.equal(scope.mcpIsolation.reason, 'slug_mismatch');

    const dataDirBeforeCleanup = scope.dataDirectory;
    await scope.cleanup();
    await assert.rejects(readFile(disabledPath), { code: 'ENOENT' });
    await assert.rejects(readdir(dataDirBeforeCleanup), { code: 'ENOENT' });

    nativeScope = await createCliConfigScope({ CURSOR_CONFIG_DIR: configDir, CURSOR_BRIDGE_CCE_CLI_MCP: 'native' }, { cwd: worktree, userHome });
    assert.equal(nativeScope.mcpIsolation.enabled, false);
    assert.equal(nativeScope.mcpIsolation.mode, 'native');
    await assert.rejects(readdir(join(nativeScope.dataDirectory, 'projects')), { code: 'ENOENT' });

    failOpenScope = await createCliConfigScope(
      { CURSOR_CONFIG_DIR: configDir },
      { cwd: worktree, userHome, enumerateMcpImpl: async () => { throw new Error('SECRET_TOKEN_SHOULD_NOT_LEAK'); } },
    );
    assert.equal(failOpenScope.mcpIsolation.enabled, false);
    assert.equal(failOpenScope.mcpIsolation.mode, 'fail_open');
    assert.equal(JSON.stringify(failOpenScope.mcpIsolation).includes('SECRET_TOKEN'), false);
  } finally {
    await scope?.cleanup();
    await nativeScope?.cleanup();
    await failOpenScope?.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});
