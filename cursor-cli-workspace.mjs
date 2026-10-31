import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, extname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'jsonc-parser';

function invalid(message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = 'CURSOR_CLI_WORKSPACE_INVALID';
  error.confirmedNotSent = true;
  return error;
}

function localDirectory(path) {
  try {
    if (!statSync(path).isDirectory()) throw new Error('not a directory');
    return realpathSync(path);
  } catch (error) { throw invalid(`CCE CLI workspace directory is unavailable: ${path}`, error); }
}

export function resolveCliWorkspace(projectPath) {
  if (typeof projectPath !== 'string' || !isAbsolute(projectPath)) throw invalid('CCE CLI requires an absolute workspace path');
  const workspacePath = resolve(projectPath);
  let info;
  try { info = statSync(workspacePath); }
  catch (error) { throw invalid(`CCE CLI workspace is unavailable: ${workspacePath}`, error); }
  if (info.isDirectory()) return { workspacePath, cwd: localDirectory(workspacePath), additionalRoots: [] };
  if (!info.isFile() || extname(workspacePath).toLowerCase() !== '.code-workspace') throw invalid('CCE CLI requires a directory or .code-workspace file');
  if (info.size > 1024 * 1024) throw invalid('CCE workspace configuration exceeds 1 MiB');
  const errors = [];
  const document = parse(readFileSync(workspacePath, 'utf8').replace(/^\uFEFF/, ''), errors, { allowTrailingComma: true });
  if (errors.length || !Array.isArray(document?.folders) || !document.folders.length) throw invalid('CCE workspace configuration must contain valid local folders');
  const roots = [];
  for (const folder of document.folders) {
    if (!folder || typeof folder !== 'object' || Array.isArray(folder)) throw invalid('CCE workspace folder is invalid');
    const hasPath = typeof folder.path === 'string' && folder.path.trim().length > 0;
    const hasUri = typeof folder.uri === 'string' && folder.uri.trim().length > 0;
    if (hasPath === hasUri) throw invalid('CCE workspace folder must have exactly one local path or file URI');
    let path;
    if (hasPath) {
      if (/^[a-z][a-z\d+.-]*:/i.test(folder.path) && !/^[a-z]:[\\/]/i.test(folder.path)) throw invalid('CCE CLI supports local workspace folders only');
      path = resolve(dirname(workspacePath), folder.path);
    } else {
      try {
        const uri = new URL(folder.uri);
        if (uri.protocol !== 'file:' || uri.search || uri.hash) throw new Error('not a local file URI');
        path = fileURLToPath(uri);
      } catch (error) { throw invalid('CCE CLI supports local file-URI workspace folders only', error); }
    }
    const root = localDirectory(path);
    const key = value => process.platform === 'win32' ? value.toLowerCase() : value;
    if (!roots.some(existing => key(existing) === key(root))) roots.push(root);
  }
  return { workspacePath, cwd: roots[0], additionalRoots: roots.slice(1) };
}
