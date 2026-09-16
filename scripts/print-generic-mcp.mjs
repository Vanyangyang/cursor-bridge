#!/usr/bin/env node
/**
 * Print a portable stdio MCP snippet for hosts without a marketplace plugin.
 * Uses the committed, dependency-free bundles. Does not write host config files.
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(SCRIPT_DIR, '..');

export const GENERIC_MCP_PLUGINS = ['cursor', 'grok', 'both'];
export const GENERIC_MCP_FORMATS = ['mcpServers', 'vscode'];

const PLUGIN_BUNDLES = {
  cursor: {
    name: 'cursor-bridge',
    relativePath: join('dist', 'cursor-bridge.mjs'),
  },
  grok: {
    name: 'grok-build-supervisor',
    relativePath: join('plugins', 'grok-build-supervisor', 'dist', 'grok-build-supervisor.mjs'),
  },
};

export const GENERIC_MCP_HELP = `Print a generic stdio MCP snippet from this checkout's committed bundles.

Usage:
  node scripts/print-generic-mcp.mjs [--plugin cursor|grok|both] [--format mcpServers|vscode]

Options:
  --plugin <id>     cursor (default), grok, or both
  --format <name>   mcpServers (default) or vscode
  --root <dir>      repository root (default: this checkout)
  --command <exe>   command used to launch Node (default: node)
  --help, -h        show this help

The printed JSON is a snippet to merge into the host's MCP settings. It does
not install plugin skills, slash commands, marketplace updates, or hooks.
`;

export function parseGenericMcpArgs(argv) {
  const options = {
    plugin: 'cursor',
    format: 'mcpServers',
    root: DEFAULT_ROOT,
    command: 'node',
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const takeValue = () => {
      const value = argv[index + 1];
      if (value == null || value.startsWith('-')) {
        throw new Error(`${token} requires a value`);
      }
      index += 1;
      return value;
    };

    if (token === '--help' || token === '-h') {
      options.help = true;
      continue;
    }
    if (token === '--plugin') {
      options.plugin = takeValue();
      continue;
    }
    if (token === '--format') {
      options.format = takeValue();
      continue;
    }
    if (token === '--root') {
      options.root = resolve(takeValue());
      continue;
    }
    if (token === '--command') {
      options.command = takeValue();
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  if (!GENERIC_MCP_PLUGINS.includes(options.plugin)) {
    throw new Error(`Unsupported --plugin ${options.plugin}. Use cursor, grok, or both.`);
  }
  if (!GENERIC_MCP_FORMATS.includes(options.format)) {
    throw new Error(`Unsupported --format ${options.format}. Use mcpServers or vscode.`);
  }
  if (!String(options.command || '').trim()) {
    throw new Error('--command must not be empty');
  }

  return options;
}

function selectedPlugins(plugin) {
  return plugin === 'both' ? ['cursor', 'grok'] : [plugin];
}

export function resolveGenericMcpEntries({ root, plugin, command }) {
  const entries = [];
  for (const id of selectedPlugins(plugin)) {
    const bundle = PLUGIN_BUNDLES[id];
    const entryPath = resolve(root, bundle.relativePath);
    if (!existsSync(entryPath)) {
      throw new Error(`Missing committed bundle: ${entryPath}`);
    }
    entries.push({
      name: bundle.name,
      command,
      args: [entryPath],
    });
  }
  return entries;
}

export function buildGenericMcpConfig({ root, plugin, format, command }) {
  const entries = resolveGenericMcpEntries({ root, plugin, command });
  if (format === 'vscode') {
    return {
      servers: Object.fromEntries(entries.map((entry) => [entry.name, {
        type: 'stdio',
        command: entry.command,
        args: entry.args,
      }])),
    };
  }
  return {
    mcpServers: Object.fromEntries(entries.map((entry) => [entry.name, {
      command: entry.command,
      args: entry.args,
    }])),
  };
}

export function renderGenericMcpConfig(config) {
  return `${JSON.stringify(config, null, 2)}\n`;
}

function main(argv) {
  try {
    const options = parseGenericMcpArgs(argv);
    if (options.help) {
      process.stdout.write(GENERIC_MCP_HELP);
      return;
    }
    process.stdout.write(renderGenericMcpConfig(buildGenericMcpConfig(options)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main(process.argv.slice(2));
}
