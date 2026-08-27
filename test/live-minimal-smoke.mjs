#!/usr/bin/env node
/**
 * Opt-in live smoke test for the Windows UI-suppressed runtime.
 * It never persists runtime settings: hide the Cursor window serving CDP, run
 * one real CCE search, then restore the window in finally.
 */
import { CursorBridge } from '../server.mjs';

const argv = process.argv.slice(2);
const keepHidden = argv.includes('--keep-hidden');
const persist = argv.includes('--persist');
const query = argv.filter((value) => !['--keep-hidden', '--persist'].includes(value)).join(' ').trim()
  || 'Locate the implementation that registers the cursor_context_engine MCP tool. Return the defining function and tool schema evidence.';

const bridge = new CursorBridge({
  runtimeFile: persist ? undefined : null,
  runtimeMode: persist ? undefined : 'minimal',
  projectPath: process.cwd(),
  workspaceFile: null,
});

let result = null;
let error = null;
try {
  const hidden = persist
    ? await bridge.setRuntimeMode('minimal', 'persistent')
    : await bridge.applyRuntimePresentation('hide');
  console.log(JSON.stringify({ phase: 'hidden', presentation: hidden }));
  result = await bridge.contextEngine(query);
  console.log(JSON.stringify({ phase: 'search_completed', result }));
} catch (caught) {
  error = caught instanceof Error ? caught.message : String(caught);
  console.error(JSON.stringify({ phase: 'search_failed', error }));
} finally {
  if (keepHidden) {
    console.log(JSON.stringify({ phase: 'kept_hidden', runtime: bridge.runtimeModeView() }));
  } else {
    const shown = await bridge.applyRuntimePresentation('show');
    console.log(JSON.stringify({ phase: 'restored', presentation: shown }));
  }
}

process.exitCode = error ? 1 : 0;
