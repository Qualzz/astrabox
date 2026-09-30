import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { generationConfig } from '../server/config.js';
import { installedCodexCommand } from '../server/installed-codex.js';
import { serviceUnit } from '../deploy/raspberry-pi/install-service.mjs';

test('generation defaults stay local and accept explicit account-specific settings', () => {
  assert.deepEqual(generationConfig({}), { model: 'gpt-6-astra', effort: 'high', serviceTier: 'priority' });
  assert.deepEqual(generationConfig({ ASTRABOX_MODEL: 'my-model', ASTRABOX_EFFORT: 'low' }),
    { model: 'my-model', effort: 'low', serviceTier: 'priority' });
  assert.throws(() => generationConfig({ ASTRABOX_EFFORT: 'turbo' }), /ASTRABOX_EFFORT/);
  assert.throws(() => generationConfig({ ASTRABOX_MODEL: '../bad' }), /identifier/);
});

test('the pinned Codex launcher uses Node directly, without a platform shell shim', () => {
  const root = path.resolve('project with spaces');
  assert.deepEqual(installedCodexCommand(root, {}), {
    command: process.execPath, args: [path.join(root, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')],
  });
  assert.deepEqual(installedCodexCommand(root, { CODEX_BIN: '/custom/codex' }), { command: '/custom/codex', args: [] });
});

test('optional host deployment quotes paths and escapes systemd specifiers', () => {
  const unit = serviceUnit('/home/example/project 100%', '/opt/node install/bin/node');
  assert.match(unit, /WorkingDirectory="\/home\/example\/project 100%%"/);
  assert.match(unit, /ExecStart="\/opt\/node install\/bin\/node" "\/home\/example\/project 100%%\/server\/index.js"/);
  assert.match(unit, /Environment=PORT=8080/);
  assert.throws(() => serviceUnit('/bad\nExecStart=other', '/node'), /Invalid path/);
});
