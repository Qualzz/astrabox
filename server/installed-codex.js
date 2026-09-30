import path from 'node:path';
import { CodexBridge } from './codex-bridge.js';

export function installedCodexCommand(root, env = process.env) {
  // Run the package's JS launcher with Node, avoiding shell-dependent .cmd shims.
  return env.CODEX_BIN
    ? { command: env.CODEX_BIN, args: [] }
    : { command: process.execPath, args: [path.join(root, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')] };
}

export function createInstalledCodexBridge(root) {
  return new CodexBridge({ ...installedCodexCommand(root), cwd: root });
}
