import { isAbsolute } from 'node:path';

const fields = new Set(['kind', 'nodePath', 'entrypoint', 'baseUrl', 'apiKeyFile']);
export function normalizeCliProvider(value) {
  const invalid = () => Object.assign(new Error('Invalid local CLI provider; use openai-responses, absolute node/entrypoint/key-file paths and an HTTPS base URL'), { code: 'CURSOR_CLI_PROVIDER_CONFIG_INVALID' });
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.has(key)) || value.kind !== 'openai-responses') throw invalid();
  for (const key of ['nodePath', 'entrypoint', 'apiKeyFile']) if (typeof value[key] !== 'string' || !isAbsolute(value[key]) || /[\r\n\0]/.test(value[key])) throw invalid();
  let url;
  try { url = new URL(value.baseUrl); } catch { throw invalid(); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw invalid();
  return { kind: value.kind, nodePath: value.nodePath, entrypoint: value.entrypoint,
    baseUrl: url.href.replace(/\/+$/, ''), apiKeyFile: value.apiKeyFile };
}

export function localProviderSummary(provider) {
  return provider ? { kind: provider.kind, baseUrl: provider.baseUrl, protocol: 'responses', credentialSource: 'local-file', harness: 'cursor-agent-local' } : null;
}
