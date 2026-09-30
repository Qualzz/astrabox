import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReadStream } from 'node:fs';
import { readFile, readdir, stat, realpath } from 'node:fs/promises';
import { build } from 'esbuild';
import { Workshop } from './workshop.js';
import { hashCartridge } from './validate-cartridge.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.mjs':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.json':'application/json; charset=utf-8', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.webp':'image/webp', '.svg':'image/svg+xml', '.glb':'model/gltf-binary', '.ogg':'audio/ogg', '.mp3':'audio/mpeg', '.wav':'audio/wav', '.woff2':'font/woff2', '.txt':'text/plain; charset=utf-8' };
TYPES['.mid'] = TYPES['.midi'] = 'audio/midi';
const slug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const inside = (base, target) => target === base || target.startsWith(`${base}${path.sep}`);
const isPublic = relative => /^(?:src\/|assets\/|node_modules\/(?:three|pixi\.js|@pixi\/sound)\/)/.test(relative)
  || ['index.html','moon.html','moon.css','styles.css','workshop.css','preview.html','controls.html'].includes(relative);

function json(response, status, value) {
  response.writeHead(status, { 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store' });
  response.end(JSON.stringify(value));
}

async function body(request) {
  if (!(request.headers['content-type'] ?? '').startsWith('application/json')) throw Object.assign(new Error('Content-Type application/json requis.'), { status: 415 });
  let data = '';
  for await (const chunk of request) {
    data += chunk;
    if (Buffer.byteLength(data) > 6 * 1024 * 1024) throw Object.assign(new Error('Requête trop volumineuse.'), { status: 413 });
  }
  const result = JSON.parse(data || '{}');
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Objet JSON attendu.');
  return result;
}

async function serveFile(response, request, base, relative, publicOnly = false) {
  const filename = path.resolve(base, relative);
  if (!inside(base, filename)) throw Object.assign(new Error('Chemin interdit.'), { status:403 });
  const canonical = await realpath(filename);
  if (!inside(base, canonical)) throw Object.assign(new Error('Lien externe interdit.'), { status:403 });
  if (publicOnly && !isPublic(path.relative(base, canonical).split(path.sep).join('/'))) throw Object.assign(new Error('Fichier privé interdit.'), { status:403 });
  const info = await stat(canonical);
  if (!info.isFile()) throw Object.assign(new Error('Fichier introuvable.'), { status:404 });
  response.writeHead(200, { 'Content-Type': TYPES[path.extname(filename)] ?? 'application/octet-stream', 'Content-Length':info.size, 'Cache-Control':'no-cache' });
  if (request.method === 'HEAD') response.end();
  else createReadStream(canonical).pipe(response);
}

function sse(request, response, emitter, eventName, history = [], named = false) {
  response.writeHead(200, { 'Content-Type':'text/event-stream', 'Cache-Control':'no-cache', Connection:'keep-alive', 'X-Accel-Buffering':'no' });
  response.write(': connected\n\n');
  const send = event => response.write(`${named ? `event: ${event.type}\n` : ''}data: ${JSON.stringify(event)}\n\n`);
  for (const event of history) send(event);
  emitter.on(eventName, send);
  const timer = setInterval(() => response.write(': keepalive\n\n'), 20_000);
  request.on('close', () => { clearInterval(timer); emitter.off(eventName, send); });
}

export async function createArcadeServer({ root = ROOT, port = 8080, host = '127.0.0.1', workshop: suppliedWorkshop } = {}) {
  const workshop = suppliedWorkshop ?? new Workshop({ root, origin: `http://${host}:${port}` });
  await workshop.initialize();
  const bundles = new Map();
  const server = http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'same-origin');
    try {
      const expectedPort = server.address()?.port ?? port;
      const allowedHosts = new Set([`127.0.0.1:${expectedPort}`, `localhost:${expectedPort}`]);
      if (!allowedHosts.has(request.headers.host)) return json(response, 403, { error:'Cet atelier est disponible uniquement sur localhost.' });
      const origin = request.headers.origin;
      if (origin && ![...allowedHosts].some(value => origin === `http://${value}`)) return json(response, 403, { error:'Origine non autorisée.' });
      if (request.headers['sec-fetch-site'] === 'cross-site') return json(response, 403, { error:'Requête intersite refusée.' });
      const rawPath = request.url.split('?')[0];
      const decoded = decodeURIComponent(rawPath);
      if (decoded.includes('\\') || decoded.includes('\0') || decoded.split('/').some(part => part === '..' || part.startsWith('.'))) return json(response, 403, { error:'Chemin interdit.' });
      const url = new URL(request.url, `http://${request.headers.host}`);
      const pathname = url.pathname;
      if (pathname === '/api/status' && request.method === 'GET') return json(response, 200, await workshop.accountStatus());
      if (pathname === '/api/events' && request.method === 'GET') return sse(request, response, workshop, 'global', [], true);
      if (pathname === '/api/workshop/state' && request.method === 'GET') return json(response, 200, {
        sessions: [...workshop.sessions.values()].map(s => ({ sessionId:s.id, threadId:s.threadId, gameId:s.gameId, revision:s.revision, state:s.state, message:s.message, published:s.published, voice:s.voice })),
      });
      if (pathname === '/api/games' && request.method === 'GET') {
        const games = [];
        const base = path.join(root, 'cartridges');
        for (const entry of await readdir(base, { withFileTypes:true })) {
          if (!entry.isDirectory() || !slug.test(entry.name)) continue;
          const directory = path.join(base, entry.name);
          try {
            const manifest = JSON.parse(await readFile(path.join(directory, 'game.json'), 'utf8'));
            if (manifest.id !== entry.name) continue;
            const revision = await hashCartridge(directory);
            const generated = await workshop.getThumbnail(entry.name, revision);
            const screenshot = generated ? `/api/games/${entry.name}/thumbnail`
              : manifest.screenshot?.startsWith('/') ? manifest.screenshot : manifest.screenshot ? `/cartridges/${entry.name}/${manifest.screenshot}` : '';
            games.push({ ...manifest, screenshot, revision });
          } catch (error) { workshop.emit('diagnostic', `Cartouche ignorée ${entry.name}: ${error.message}`); }
        }
        return json(response, 200, { games });
      }
      const configMatch = pathname.match(/^\/api\/games\/([a-z0-9-]+)\/config$/);
      if (configMatch && request.method === 'GET') return json(response, 200, JSON.parse(await readFile(path.join(root, 'cartridges', configMatch[1], 'config.json'), 'utf8')));
      const thumbnailMatch = pathname.match(/^\/api\/games\/([a-z0-9-]+)\/thumbnail$/);
      if (thumbnailMatch && ['GET', 'HEAD'].includes(request.method)) {
        const screenshot = await workshop.getThumbnail(thumbnailMatch[1], url.searchParams.get('revision'));
        if (!screenshot) return json(response, 404, { error:'Vignette indisponible pour cette modification.' });
        const image = Buffer.from(screenshot.split(',')[1], 'base64');
        response.writeHead(200, { 'Content-Type':'image/png', 'Content-Length':image.length, 'Cache-Control':'no-cache' });
        return response.end(request.method === 'HEAD' ? undefined : image);
      }
      if (pathname === '/api/workshop/session' && request.method === 'POST') return json(response, 200, await workshop.session(await body(request)));
      const route = pathname.match(/^\/api\/workshop\/([a-f0-9-]{36})\/(events|context|message|voice\/start|voice\/stop|interrupt)$/);
      if (route) {
        const session = workshop.get(route[1]);
        if (route[2] === 'events' && request.method === 'GET') return sse(request, response, workshop, `session:${session.id}`, session.events.slice(-20));
        if (request.method !== 'POST') return json(response, 405, { error:'Méthode non autorisée.' });
        const payload = await body(request);
        if (route[2] === 'context') { await workshop.updateContext(session, payload.context, payload.requestId); return json(response, 200, { ok:true }); }
        if (route[2] === 'message') { await workshop.message(session, payload); return json(response, 202, { ok:true }); }
        if (route[2] === 'voice/start') return json(response, 200, await workshop.startVoice(session, payload));
        if (route[2] === 'voice/stop') { await workshop.stopVoice(session); return json(response, 200, { ok:true }); }
        if (route[2] === 'interrupt') { await workshop.interrupt(session); return json(response, 200, { ok:true }); }
      }
      if (pathname.startsWith('/api/')) return json(response, 404, { error:'Endpoint introuvable.' });
      if (!['GET', 'HEAD'].includes(request.method)) return json(response, 405, { error:'Méthode non autorisée.' });
      const preview = pathname.match(/^\/preview\/([a-f0-9-]{36})\/(.+)$/);
      if (preview) {
        const session = workshop.get(preview[1]);
        return await serveFile(response, request, path.join(session.workspace, 'cartridge'), decodeURIComponent(preview[2]));
      }
      const cartridge = pathname.match(/^\/cartridges\/([a-z0-9-]+)\/(?:@([^/]+)\/)?(.+)$/);
      if (cartridge) {
        const directory = path.join(root, 'cartridges', cartridge[1]);
        const relative = decodeURIComponent(cartridge[3]);
        if (relative === 'game.js') {
          const revision = await hashCartridge(directory);
          let cached = bundles.get(cartridge[1]);
          if (cached?.revision !== revision) {
            const output = await build({ entryPoints:[path.join(directory, 'game.js')], bundle:true, write:false, format:'esm', platform:'browser', target:'es2022', external:['pixi.js','@pixi/sound'], logLevel:'silent' });
            cached = { revision, code:output.outputFiles[0].text };
            bundles.set(cartridge[1], cached);
          }
          response.writeHead(200, { 'Content-Type':TYPES['.js'], 'Cache-Control':'no-store' });
          return response.end(request.method === 'HEAD' ? undefined : cached.code);
        }
        return await serveFile(response, request, directory, relative);
      }
      const relative = pathname === '/' ? 'moon.html' : decodeURIComponent(pathname.slice(1));
      if (!isPublic(relative)) return json(response, 404, { error:'Fichier introuvable.' });
      await serveFile(response, request, root, relative, true);
    } catch (error) {
      if (!response.headersSent) json(response, error.status ?? (error.code === 'ENOENT' ? 404 : 400), { error:String(error.message).slice(0, 1600) });
      else response.end();
    }
  });
  server.requestTimeout = 45_000;
  server.on('close', () => { workshop.close().catch(() => {}); });
  return { server, workshop, listen: () => new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); workshop.origin = `http://${host}:${server.address().port}`; resolve(server.address()); });
  }) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT invalide.');
  const app = await createArcadeServer({ port });
  await app.listen();
  console.log(`Arcade : http://localhost:${port}/moon.html`);
  const stop = async () => { await app.workshop.close(); app.server.closeAllConnections(); app.server.close(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
