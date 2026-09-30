#!/usr/bin/env node
import { pathToFileURL } from "node:url";

const HELP = `Arcade — commandes texte du harness local

  node scripts/arcade.mjs list
  node scripts/arcade.mjs status
  node scripts/arcade.mjs new "Crée un jeu de…" [--no-wait]
  node scripts/arcade.mjs edit <game-id> "Modifie…" [--no-wait]
  node scripts/arcade.mjs wait <session-id>

Options : --timeout <secondes> (0.1 à 600, défaut 600), --help
Pour new/edit : --model <modèle> --effort <low|medium|high|xhigh|max|ultra>.
Ces réglages deviennent ceux de la conversation de cette cartouche.
ARCADE_URL : http://127.0.0.1:8080 par défaut ; localhost uniquement.
new/edit attendent le résultat, sauf --no-wait. Aucun appel vocal.`;
const GAME_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SESSION_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const clean = (value) => String(value ?? "").replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").slice(0, 16_000);
const oneLine = (value) => clean(value).replace(/[\n\r\t]+/g, " ");

export function localOrigin(value = "http://127.0.0.1:8080") {
  let url;
  try { url = new URL(value); } catch { throw new Error("ARCADE_URL invalide : utilise http://127.0.0.1:8080."); }
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname)
    || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("ARCADE_URL doit être une origine HTTP localhost/127.0.0.1, sans identifiants ni chemin. N’expose pas le harness publiquement.");
  }
  return url.origin;
}

export function parseArguments(argv) {
  const positional = [];
  let timeoutMs = 600_000;
  let noWait = false;
  const generation = {};
  let positionalOnly = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (positionalOnly) { positional.push(arg); continue; }
    if (arg === "--") { positionalOnly = true; continue; }
    if (arg === "--help" || arg === "-h") return { command: "help" };
    if (arg === "--no-wait") { noWait = true; continue; }
    if (arg === "--model" || arg === "--effort") {
      const value = argv[++index];
      if (arg === "--model" && !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value ?? "")) throw new Error("--model attend un identifiant de modèle.");
      if (arg === "--effort" && !["low", "medium", "high", "xhigh", "max", "ultra"].includes(value)) throw new Error("--effort attend low, medium, high, xhigh, max ou ultra.");
      generation[arg.slice(2)] = value;
      continue;
    }
    if (arg === "--timeout") {
      const seconds = Number(argv[++index]);
      if (!Number.isFinite(seconds) || seconds < 0.1 || seconds > 600) throw new Error("--timeout attend un nombre de secondes entre 0.1 et 600.");
      timeoutMs = Math.round(seconds * 1000);
      continue;
    }
    if (arg.startsWith("--")) throw new Error(`Option inconnue : ${clean(arg)}`);
    positional.push(arg);
  }
  const [command, ...values] = positional;
  if (!["list", "status", "new", "edit", "wait"].includes(command)) throw new Error("Commande attendue : list, status, new, edit ou wait. Utilise --help.");
  if (noWait && !["new", "edit"].includes(command)) throw new Error("--no-wait s’utilise uniquement avec new ou edit.");
  if (Object.keys(generation).length && !["new", "edit"].includes(command)) throw new Error("--model/--effort s’utilisent uniquement avec new ou edit.");
  if (["list", "status"].includes(command) && values.length) throw new Error(`${command} n’attend pas d’argument.`);
  if (command === "wait" && (values.length !== 1 || !SESSION_ID.test(values[0]))) throw new Error("wait attend un session-id UUID valide.");
  if (command === "edit" && !GAME_ID.test(values[0] ?? "")) throw new Error("edit attend un identifiant de jeu valide.");
  const text = values.slice(command === "edit" ? 1 : 0).join(" ").trim();
  if (["new", "edit"].includes(command) && (!text || text.length > 16_000)) throw new Error("La demande doit contenir entre 1 et 16000 caractères.");
  return { command, noWait, timeoutMs, text, generation, gameId: command === "edit" ? values[0] : null, sessionId: command === "wait" ? values[0] : null };
}

async function jsonRequest(origin, pathname, body, { signal } = {}) {
  let response;
  try {
    response = await fetch(`${origin}${pathname}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), Origin: origin },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000),
    });
  } catch (error) {
    throw new Error(`Harness local inaccessible (${clean(error.message)}). Vérifie npm start sur l’hôte ; aucune nouvelle tentative automatique.`);
  }
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error(clean(result?.error?.message ?? result?.error ?? `HTTP ${response.status}`));
  if (!result || typeof result !== "object") throw new Error("Réponse JSON invalide du harness.");
  return result;
}

function identifiers(session) {
  return `sessionId=${oneLine(session.sessionId)} threadId=${oneLine(session.threadId ?? "unavailable")} gameId=${oneLine(session.gameId ?? "unavailable")}`;
}

/** Open the event stream before sending a command. New/edit are gated by the
 * exact user-message acknowledgement so a replayed ready cannot finish a new job. */
async function followSession(origin, sessionId, { timeoutMs, expectText = null, print }) {
  const controller = new AbortController();
  const startedAt = Date.now();
  let acceptAfter = expectText == null ? startedAt : Infinity;
  let acknowledged = expectText == null;
  let finished = false;
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  function finish(result) {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    resolveDone(result);
    controller.abort();
  }
  const timer = setTimeout(() => finish({ status: "timeout", sessionId }), timeoutMs);
  let response;
  try {
    response = await fetch(`${origin}/api/workshop/${encodeURIComponent(sessionId)}/events`, {
      headers: { Accept: "text/event-stream", Origin: origin }, redirect: "error", signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error ?? `HTTP ${response.status}`);
    }
    if (!response.headers.get("content-type")?.startsWith("text/event-stream") || !response.body) throw new Error("Le harness n’a pas ouvert le flux d’événements attendu.");
  } catch (error) {
    if (!finished) finish({ status: "error", message: clean(error.message), sessionId });
    return { done, signal: controller.signal, begin() {}, cancel() { finish({ status: "cancelled", sessionId }); }, finish, get finished() { return finished; } };
  }

  function receive(event) {
    if (!event || typeof event.type !== "string" || (event.sessionId && event.sessionId !== sessionId)) return;
    if (typeof event.timestamp === "number" && event.timestamp < acceptAfter) return;
    if (!acknowledged) {
      if (acceptAfter === Infinity || event.type !== "message" || event.role !== "user" || event.text?.trim() !== expectText) return;
      acknowledged = true;
    }
    if (event.type === "message") {
      if (event.role === "assistant" && event.text) print(clean(event.text).split("\n").map((line) => `CODEX: ${line}`).join("\n"));
    } else if (event.type === "status") {
      print(`[${oneLine(event.state)}] ${oneLine(event.message)}`);
      if (["error", "ready", "idle"].includes(event.state)) finish({ status: event.state, message: event.message, sessionId });
    } else if (event.type === "game-updated") {
      finish({ status: "published", sessionId, gameId: event.gameId, revision: event.revision, requiresRestart: Boolean(event.requiresRestart) });
    } else if (event.type === "error") {
      finish({ status: "error", sessionId, message: event.message ?? "Erreur du harness." });
    }
  }

  void (async () => {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (!finished) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        if (buffer.length > 1_000_000) throw new Error("Événement du harness trop volumineux.");
        let separator;
        while ((separator = /\r?\n\r?\n/.exec(buffer))) {
          const block = buffer.slice(0, separator.index);
          buffer = buffer.slice(separator.index + separator[0].length);
          const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")).join("\n");
          if (data) receive(JSON.parse(data));
          if (finished) break;
        }
      }
      if (!finished) finish({ status: "error", sessionId, message: "Flux interrompu avant le résultat. Le travail n’a pas été annulé ; relance wait pour vérifier." });
    } catch (error) {
      if (!finished) finish({ status: "error", sessionId, message: clean(error.message) });
    } finally { reader.releaseLock(); }
  })();

  return { done, signal: controller.signal, begin() { acceptAfter = Date.now(); }, cancel() { finish({ status: "cancelled", sessionId }); }, finish, get finished() { return finished; } };
}

function reportResult(result, print) {
  if (result.status === "published") {
    print(`PUBLISHED gameId=${clean(result.gameId)} revision=${clean(result.revision)} sessionId=${clean(result.sessionId)}`);
    print(result.requiresRestart ? "Modification enregistrée ; le jeu proposera un redémarrage." : "Modification enregistrée et publiée ; le navigateur ouvert la reçoit via le harness.");
    return 0;
  }
  if (result.status === "timeout") {
    print(`TIMEOUT sessionId=${clean(result.sessionId)} — attente terminée, travail non annulé. Reprends avec : node scripts/arcade.mjs wait ${clean(result.sessionId)}`);
    return 2;
  }
  if (result.status === "error") { print(`ERROR ${clean(result.message)}`); return 1; }
  if (result.status === "ready") print(`READY sessionId=${clean(result.sessionId)} — ${clean(result.message || "Jeu à jour ; aucune nouvelle publication constatée dans ce suivi.")}`);
  else if (result.status === "idle") print(`IDLE sessionId=${clean(result.sessionId)} — ${clean(result.message || "Codex attend une demande ou une précision.")}`);
  return 0;
}

export async function run(argv = process.argv.slice(2), { env = process.env, print = console.log } = {}) {
  const options = parseArguments(argv);
  if (options.command === "help") { print(HELP); return 0; }
  const origin = localOrigin(env.ARCADE_URL);
  if (options.command === "list") {
    const { games } = await jsonRequest(origin, "/api/games");
    if (!Array.isArray(games)) throw new Error("Catalogue invalide.");
    for (const game of games) print(`${oneLine(game.id)}\t${oneLine(game.title)}\t${oneLine(game.maxPlayers)}P\t${oneLine(game.revision ?? "")}`);
    if (!games.length) print("Aucune cartouche publiée.");
    return 0;
  }
  if (options.command === "status") {
    const [account, { sessions }] = await Promise.all([jsonRequest(origin, "/api/status"), jsonRequest(origin, "/api/workshop/state")]);
    print(`HARNESS connected=${Boolean(account.connected)} authenticated=${Boolean(account.authenticated)} — ${clean(account.message)}`);
    if (!Array.isArray(sessions)) throw new Error("État des sessions invalide.");
    for (const session of sessions) print(`SESSION ${identifiers(session)} state=${clean(session.state)} — ${clean(session.message)}`);
    if (!sessions.length) print("Aucune session en cours.");
    return 0;
  }
  if (options.command === "wait") {
    const monitor = await followSession(origin, options.sessionId, { timeoutMs: options.timeoutMs, print });
    try {
      const { sessions } = await jsonRequest(origin, "/api/workshop/state", undefined, { signal: monitor.signal });
      const session = sessions?.find((entry) => entry.sessionId === options.sessionId);
      if (!session) throw new Error("Session introuvable.");
      print(`SESSION ${identifiers(session)}`);
      if (["ready", "idle", "error"].includes(session.state)) monitor.finish({ status: session.state, message: session.message, sessionId: session.sessionId });
      return reportResult(await monitor.done, print);
    } catch (error) {
      if (monitor.finished) return reportResult(await monitor.done, print);
      monitor.cancel();
      throw error;
    }
  }

  // Never reuse the hub's sessionId for `new`: that session may already own a
  // published cartridge. Existing-game sessions are resolved by the server.
  const session = await jsonRequest(origin, "/api/workshop/session", { gameId: options.gameId });
  if (!SESSION_ID.test(session.sessionId ?? "") || !session.threadId || !GAME_ID.test(session.gameId ?? "")) throw new Error("Session Codex incomplète ou invalide.");
  print(`SESSION ${identifiers(session)}`);
  const endpoint = `/api/workshop/${encodeURIComponent(session.sessionId)}/message`;
  if (options.noWait) {
    await jsonRequest(origin, endpoint, { text: options.text, ...options.generation });
    print(`ACCEPTED sessionId=${session.sessionId} — demande transmise, résultat non attendu. Suivi : node scripts/arcade.mjs wait ${session.sessionId}`);
    return 0;
  }
  const monitor = await followSession(origin, session.sessionId, { timeoutMs: options.timeoutMs, expectText: options.text, print });
  if (monitor.finished) return reportResult(await monitor.done, print);
  try {
    monitor.begin();
    await jsonRequest(origin, endpoint, { text: options.text, ...options.generation }, { signal: monitor.signal });
    return reportResult(await monitor.done, print);
  } catch (error) {
    if (monitor.finished) return reportResult(await monitor.done, print);
    monitor.cancel();
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = await run(); }
  catch (error) { console.error(`ERROR ${clean(error.message)}`); process.exitCode = 1; }
}
