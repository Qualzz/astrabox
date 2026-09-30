import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";
import { init as initModuleLexer, parse as parseModules } from "es-module-lexer";
import { chromium } from "playwright";

const MAX_BYTES = 20 * 1024 * 1024;
const MAX_FILES = 256;
const ALLOWED_PACKAGES = new Set(["pixi.js", "@pixi/sound"]);
const ALLOWED_EXTENSIONS = new Set([".js", ".mjs", ".json", ".png", ".jpg", ".jpeg", ".webp", ".avif", ".gif", ".svg", ".wav", ".ogg", ".mp3", ".mid", ".midi", ".woff", ".woff2", ".ttf", ".md", ".txt"]);
const SENSITIVE_NAMES = /^(?:\.env(?:\..*)?|\.git|\.ssh|\.codex|node_modules|package(?:-lock)?\.json|id_rsa|id_ed25519|credentials(?:\..*)?|auth\.json)$/i;
const isInside = (root, target) => target === root || target.startsWith(`${root}${path.sep}`);

function invalid(message, report = {}) {
  const error = new Error(message);
  error.code = "CARTRIDGE_VALIDATION_FAILED";
  error.report = { ok: false, errors: [message], ...report };
  return error;
}

function localAsset(value, name) {
  if (typeof value !== "string" || !value || value.includes("\\") || value.includes("\0") || value.includes("%")
    || value.startsWith("/") || /[?#:]/.test(value) || value.split("/").some((part) => !part || part === "." || part === "..")) {
    throw invalid(`${name} doit être un chemin relatif local sans traversée.`);
  }
  return value;
}

async function readJson(root, name, files) {
  if (!files.has(name)) throw invalid(`${name} est obligatoire.`);
  try {
    const value = JSON.parse(await readFile(path.join(root, name), "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("objet JSON attendu");
    return value;
  } catch (error) {
    throw invalid(`${name} invalide : ${error.message}`);
  }
}

function manifestFrom(raw, expectedId, files) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(raw.id ?? "") || raw.id.length > 64) throw invalid("Identifiant de cartouche invalide.");
  if (expectedId && raw.id !== expectedId) throw invalid("L’identifiant du jeu ne peut pas être modifié.");
  if (typeof raw.title !== "string" || !raw.title.trim() || raw.title.length > 100) throw invalid("Titre absent ou trop long (100 caractères maximum).");
  if (raw.description != null && (typeof raw.description !== "string" || raw.description.length > 500)) throw invalid("Description invalide (500 caractères maximum).");
  if (raw.maxPlayers !== 1 && raw.maxPlayers !== 2) throw invalid("maxPlayers doit valoir 1 ou 2.");
  const entry = raw.entry ?? "game.js";
  if (entry !== "game.js") throw invalid("Le point d’entrée doit être game.js.");
  if (!files.has(entry)) throw invalid("game.js est absent.");
  if (raw.accent != null && !/^#[0-9a-f]{6}$/i.test(raw.accent)) throw invalid("accent doit être une couleur #RRGGBB.");
  const manifest = { id: raw.id, title: raw.title.trim(), description: raw.description ?? "", maxPlayers: raw.maxPlayers, entry, accent: raw.accent ?? "#fff5a8" };
  if (raw.stateVersion != null) {
    if (!Number.isInteger(raw.stateVersion) || raw.stateVersion < 1) throw invalid("stateVersion doit être un entier positif.");
    manifest.stateVersion = raw.stateVersion;
  }
  if (raw.liveUpdate != null) {
    if (!["restart", "state"].includes(raw.liveUpdate)) throw invalid("liveUpdate doit valoir state ou restart.");
    manifest.liveUpdate = raw.liveUpdate;
  }
  if (raw.screenshot != null && raw.screenshot !== "") {
    const shared = typeof raw.screenshot === "string" && raw.screenshot.startsWith("/assets/");
    manifest.screenshot = shared ? `/${localAsset(raw.screenshot.slice(1), "screenshot")}` : localAsset(raw.screenshot, "screenshot");
    if ((!shared && !files.has(manifest.screenshot)) || !/\.(png|jpe?g|webp|avif)$/i.test(manifest.screenshot)) throw invalid("La miniature doit être une image locale existante.");
  }
  return manifest;
}

async function listCartridgeFiles(directory) {
  const root = path.resolve(directory);
  const rootInfo = await lstat(root);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw invalid("Le dossier cartouche ne doit pas être un lien symbolique.");
  const canonicalRoot = await realpath(root);
  if (canonicalRoot !== root) throw invalid("Le dossier cartouche ne doit pas traverser de lien symbolique.");
  const files = new Map();
  let totalBytes = 0;
  async function walk(relative = "", depth = 0) {
    if (depth > 8) throw invalid("Arborescence trop profonde.");
    for (const name of (await readdir(path.join(root, relative))).sort()) {
      if (SENSITIVE_NAMES.test(name) || name.startsWith(".") || /[\\\0]/.test(name)) throw invalid(`Chemin non autorisé : ${path.join(relative, name)}`);
      const rel = relative ? `${relative}/${name}` : name;
      const info = await lstat(path.join(root, rel));
      if (info.isSymbolicLink()) throw invalid(`Lien symbolique interdit : ${rel}`);
      if (info.isDirectory()) { await walk(rel, depth + 1); continue; }
      if (!info.isFile()) throw invalid(`Fichier spécial interdit : ${rel}`);
      if (!ALLOWED_EXTENSIONS.has(path.extname(name).toLowerCase()) && !/^LICENSE$/i.test(name)) throw invalid(`Type de fichier non autorisé : ${rel}`);
      totalBytes += info.size;
      files.set(rel, info.size);
      if (files.size > MAX_FILES || totalBytes > MAX_BYTES) throw invalid("Budget cartouche dépassé (256 fichiers / 20 Mio maximum).");
    }
  }
  await walk();
  return { root, files, totalBytes };
}

async function hashFiles(root, files) {
  const hash = createHash("sha256");
  for (const name of [...files.keys()].sort()) {
    // Briefs, licenses and test reports must not trigger a running-game reload.
    if (/\.(?:md|txt)$/i.test(name) || /(?:^|\/)LICENSE$/i.test(name) || name.startsWith("docs/")) continue;
    const content = await readFile(path.join(root, name));
    hash.update(`${name}\0${content.length}\0`);
    hash.update(content);
  }
  return hash.digest("hex");
}

export async function hashCartridge(directory) {
  const { root, files } = await listCartridgeFiles(directory);
  return hashFiles(root, files);
}

/** Static inspection only. It never evaluates cartridge JavaScript. */
export async function inspectCartridge({ directory, expectedId }) {
  const { root, files, totalBytes } = await listCartridgeFiles(directory);
  const manifest = manifestFrom(await readJson(root, "game.json", files), expectedId, files);
  const config = await readJson(root, "config.json", files);
  await initModuleLexer;
  for (const filename of files.keys()) {
    if (!/\.m?js$/.test(filename)) continue;
    let imports;
    try { [imports] = parseModules(await readFile(path.join(root, filename), "utf8"), filename); }
    catch (error) { throw invalid(`JavaScript invalide dans ${filename} : ${error.message}`); }
    for (const specifier of imports) {
      if (specifier.d === -2) continue; // import.meta.url is useful for cartridge-local assets.
      if (typeof specifier.n !== "string") throw invalid(`Import calculé interdit dans ${filename} : utiliser un chemin littéral local.`);
      if (ALLOWED_PACKAGES.has(specifier.n)) continue;
      if (!specifier.n.startsWith("./") && !specifier.n.startsWith("../")) throw invalid(`Import non autorisé : ${specifier.n}`);
      const candidate = path.resolve(root, path.dirname(filename), specifier.n);
      if (!isInside(root, candidate)) throw invalid(`Import hors cartouche : ${specifier.n}`);
      const relative = path.relative(root, candidate).split(path.sep).join("/");
      if (!files.has(relative)) throw invalid(`Import local introuvable : ${specifier.n}`);
    }
  }
  let bundled;
  try {
    bundled = await build({
      absWorkingDir: root, entryPoints: [manifest.entry], bundle: true, write: false,
      format: "esm", platform: "browser", target: "es2022", metafile: true, logLevel: "silent",
      plugins: [{ name: "cartridge-import-boundary", setup(builder) {
        builder.onResolve({ filter: /.*/ }, async (args) => {
          if (args.kind === "entry-point") return undefined;
          if (ALLOWED_PACKAGES.has(args.path)) return { path: args.path, external: true };
          if (!args.path.startsWith("./") && !args.path.startsWith("../")) return { errors: [{ text: `Import non autorisé : ${args.path}` }] };
          const candidate = path.resolve(args.resolveDir, args.path);
          if (!isInside(root, candidate)) return { errors: [{ text: `Import hors cartouche : ${args.path}` }] };
          // Browser modules require the full file name (no Node directory/extension resolution).
          const rel = path.relative(root, candidate).split(path.sep).join("/");
          if (!files.has(rel)) return { errors: [{ text: `Import local introuvable : ${args.path}` }] };
          if (!/\.(?:m?js|json)$/.test(rel)) return { errors: [{ text: `Utiliser une URL pour charger cet asset : ${args.path}` }] };
          return { path: candidate };
        });
      } }],
    });
  } catch (error) {
    throw invalid(`Compilation de la cartouche refusée : ${error.errors?.map((item) => item.text).join(" ; ") ?? error.message}`);
  }
  if (!Object.values(bundled.metafile.outputs).some((output) => output.exports.includes("default"))) throw invalid("game.js doit exporter une factory par défaut.");
  return { manifest, config, revision: await hashFiles(root, files), report: {
    ok: true, checked: ["paths-and-symlinks", "file-budget", "manifest", "config-json", "module-import-boundary", "javascript-compilation", "default-export"],
    warnings: bundled.warnings.map((warning) => warning.text), fileCount: files.size, bytes: totalBytes,
  } };
}

export async function validateCartridge({ directory, expectedId, previewUrl }) {
  const inspected = await inspectCartridge({ directory, expectedId });
  let url;
  try { url = new URL(previewUrl); } catch { throw invalid("Une URL locale de preview est obligatoire pour les tests navigateur.", { checked: inspected.report.checked }); }
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw invalid("La preview doit être servie sur localhost en HTTP.");
  const browserErrors = [];
  let browser;
  try {
    browser = await chromium.launch({ headless: true, args: ["--enable-unsafe-swiftshader"] });
    const context = await browser.newContext({ viewport: { width: 960, height: 540 }, serviceWorkers: "block", acceptDownloads: false });
    const previewSession = url.searchParams.get("session");
    const publishedGame = url.searchParams.get("game");
    if (publishedGame ? !/^[a-z0-9][a-z0-9-]{0,63}$/.test(publishedGame) : !previewSession || !/^[a-zA-Z0-9_-]+$/.test(previewSession)) throw invalid("Cible de preview absente ou invalide.");
    const previewPrefix = publishedGame ? `/cartridges/${publishedGame}/` : `/preview/${previewSession}/`;
    await context.routeWebSocket("**/*", (socket) => socket.close());
    await context.route("**/*", (route) => {
      const requestUrl = new URL(route.request().url());
      if (["data:", "blob:"].includes(requestUrl.protocol)) return route.continue();
      const allowedPath = requestUrl.pathname === url.pathname || requestUrl.pathname.startsWith(previewPrefix)
        || requestUrl.pathname.startsWith("/node_modules/") || requestUrl.pathname.startsWith("/assets/")
        || ["/src/cartridge-preview.js", "/src/audio.js", "/src/midi.js", "/src/midi-player.js", "/src/hud-safe-area.js"].includes(requestUrl.pathname);
      if (requestUrl.origin === url.origin && allowedPath && ["GET", "HEAD"].includes(route.request().method())) return route.continue();
      browserErrors.push(`Requête interdite pendant le test : ${requestUrl.origin}${requestUrl.pathname}`);
      return route.abort();
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => browserErrors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error") browserErrors.push(message.text()); });
    page.on("response", (response) => { if (response.status() >= 400) browserErrors.push(`HTTP ${response.status()} : ${new URL(response.url()).pathname}`); });
    await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 20_000 });
    await page.waitForFunction(() => globalThis.__cartridgeValidation?.done === true, null, { timeout: 20_000 });
    const result = await page.evaluate(() => globalThis.__cartridgeValidation);
    browserErrors.push(...(result.errors ?? []));
    if (browserErrors.length) throw invalid("La cartouche a échoué au smoke test navigateur.", { checked: inspected.report.checked, errors: [...new Set(browserErrors)], browser: result.summary });
    return { ...inspected, report: { ...inspected.report, checked: [...inspected.report.checked, "browser-webgl-smoke"], browser: result.summary,
      limitations: ["Ce smoke test ne prouve pas la qualité artistique, l’équilibrage, toutes les collisions ou une partie complète.", "Ce contrôle de code et de réseau n’est pas une sandbox de sécurité pour du code hostile."] } };
  } catch (error) {
    if (error.code === "CARTRIDGE_VALIDATION_FAILED") throw error;
    throw invalid(`Smoke test navigateur impossible : ${error.message}`, { checked: inspected.report.checked, errors: [...new Set([...browserErrors, error.message])] });
  } finally { await browser?.close(); }
}
