import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createInstalledCodexBridge } from '../server/installed-codex.js';
import { DEFAULT_GENERATION } from '../server/codex-bridge.js';

const root = fileURLToPath(new URL('../', import.meta.url));
console.log(`Node ${process.version} · ${process.platform}/${process.arch}`);
console.log(`Generation: ${DEFAULT_GENERATION.model} · ${DEFAULT_GENERATION.effort} · Fast`);
const browserAvailable = await access(chromium.executablePath()).then(() => true, () => false);
console.log(browserAvailable ? 'Background validation browser installed.'
  : 'Background validation browser missing: run npx playwright install chromium. Existing games still run.');

const bridge = createInstalledCodexBridge(root);
try {
  await bridge.connect();
  const { account } = await bridge.request('account/read', { refreshToken: false });
  console.log(account ? 'Codex: authenticated.' : 'Codex: not signed in. Run npx codex login.');
  const { data = [] } = await bridge.request('model/list', { limit: 100 });
  const available = data.some(item => item.id === DEFAULT_GENERATION.model || item.model === DEFAULT_GENERATION.model);
  console.log(available ? 'Configured model is available to this account.'
    : 'Configured model not found. Set ASTRABOX_MODEL to a model available to your account.');
  if (!account || !available) process.exitCode = 1;
} catch (error) {
  // Don't print raw account details, credentials or arbitrary RPC error payloads.
  console.error(`Codex check failed: ${String(error.message).replace(/(?:sk-[\w-]+|Bearer\s+\S+)/gi, '[credential]').slice(0, 300)}`);
  process.exitCode = 1;
} finally { bridge.close(); }
