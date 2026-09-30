import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function quoted(value) {
  if (/[\r\n\0]/.test(value)) throw new Error('Invalid path in service definition.');
  // systemd percent specifiers expand even inside quotes.
  return `"${value.replaceAll('%', '%%').replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

export function serviceUnit(root, node) {
  return `[Unit]\nDescription=ASTRABOX local arcade workshop\nAfter=network.target\n\n[Service]\nType=simple\nWorkingDirectory=${quoted(root)}\nExecStart=${quoted(node)} ${quoted(path.join(root, 'server', 'index.js'))}\nRestart=on-failure\nRestartSec=3\nEnvironment=${quoted(`PATH=${path.dirname(node)}:/usr/local/bin:/usr/bin:/bin`)}\nEnvironment=PORT=8080\n\n[Install]\nWantedBy=default.target\n`;
}

async function install() {
  if (process.platform !== 'linux') throw new Error('This optional installer needs Linux with a systemd user session.');
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const config = process.env.XDG_CONFIG_HOME || path.join(homedir(), '.config');
  const directory = path.join(config, 'systemd', 'user');
  await mkdir(directory, { recursive: true });
  const unit = path.join(directory, 'astrabox.service');
  // Exclusive creation: no hidden overwrite of an operator's existing service.
  await writeFile(unit, serviceUnit(root, process.execPath), { flag: 'wx', mode: 0o600 });
  console.log(`Saved ${unit}\nRun: systemctl --user daemon-reload\nThen: systemctl --user enable --now astrabox.service`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  install().catch(error => { console.error(error.message); process.exitCode = 1; });
}
