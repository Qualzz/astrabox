import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const tests = (await readdir(new URL('../tests/', import.meta.url))).filter(name => name.endsWith('.test.js'));
const child = spawn(process.execPath, ['--test', ...tests.map(name => `tests/${name}`)], {
  cwd: root, stdio: 'inherit', env: { ...process.env, ARCADE_BROWSER_TESTS: '1' },
});
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
