import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { build } from 'esbuild';
import { inspectCartridge } from '../server/validate-cartridge.js';
import { ESLint } from 'eslint';

const root = fileURLToPath(new URL('../', import.meta.url));
async function files(directory) {
  const entries = await readdir(path.join(root, directory), { withFileTypes: true });
  const nested = await Promise.all(entries.map(entry => entry.isDirectory()
    ? files(`${directory}/${entry.name}`) : [`${directory}/${entry.name}`]));
  return nested.flat();
}

// Check every source file, not just the server entry point. No browser or AI call.
const sources = (await Promise.all(['src', 'server', 'scripts', 'tests', 'cartridges', 'deploy'].map(files)))
  .flat().filter(file => /\.m?js$/.test(file));
for (const file of sources) {
  const result = spawnSync(process.execPath, ['--check', path.join(root, file)], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || `Syntax check failed: ${file}`);
}
const lint = new ESLint({ cwd: root });
const results = await lint.lintFiles(sources);
if (results.some(result => result.errorCount)) {
  const formatter = await lint.loadFormatter('stylish');
  throw new Error(formatter.format(results));
}
await build({
  absWorkingDir: root, entryPoints: ['src/moon-scene.js', 'src/main.js', 'src/controls-ui.js', 'src/cartridge-preview.js'],
  bundle: true, write: false, outdir: 'output/check', format: 'esm', platform: 'browser',
  target: 'es2022', external: ['three', 'three/*', 'pixi.js', '@pixi/sound'], logLevel: 'silent',
});
const cartridges = (await readdir(path.join(root, 'cartridges'), { withFileTypes: true })).filter(e => e.isDirectory());
for (const { name } of cartridges) await inspectCartridge({ directory: path.join(root, 'cartridges', name), expectedId: name });
console.log(`Syntax, browser import graphs and ${cartridges.length} cartridge manifests checked.`);
