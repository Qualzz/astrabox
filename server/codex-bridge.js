import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { generationConfig } from "./config.js";

const DEFAULT_TIMEOUT = 30_000;
const MAX_MESSAGE_LENGTH = 32 * 1024 * 1024;

// Native model/list identifies the Fast tier as "priority".
export const DEFAULT_GENERATION = generationConfig();

export class CodexRpcError extends Error {
  constructor(message, code, data) {
    super(message);
    this.name = "CodexRpcError";
    this.code = code;
    this.data = data;
  }
}

/** JSONL transport for the installed Codex CLI. No credentials enter the browser. */
export class CodexBridge extends EventEmitter {
  constructor({ command = process.env.CODEX_BIN || "codex", args = [], cwd = process.cwd(), spawnImpl = spawn, timeoutMs = DEFAULT_TIMEOUT } = {}) {
    super();
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.spawnImpl = spawnImpl;
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
    this.nextId = 1;
    this.process = null;
    this.connecting = null;
    this.initialized = false;
    this.closed = false;
    this.initializeResult = null;
  }

  async connect() {
    if (this.closed) throw new Error("Le transport Codex est fermé.");
    if (this.initialized) return this.initializeResult;
    if (this.connecting) return this.connecting;
    this.connecting = this._connect();
    try {
      return await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  async _connect() {
    // The installed CLI gates native voice behind this process-local experimental flag.
    // This does not alter the user's global Codex settings or select a replacement model.
    const child = this.spawnImpl(this.command, [...this.args, "app-server", "--enable", "realtime_conversation", "--enable", "fast_mode", "--listen", "stdio://"], {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.process = child;
    const decoder = new StringDecoder("utf8");
    let buffered = "";
    let ended = false;
    const disconnect = (error) => {
      if (ended) return;
      ended = true;
      if (this.process === child) {
        this.process = null;
        this.initialized = false;
      }
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(error);
      }
      this.pending.clear();
      this.emit("disconnect", error);
    };
    child.on("error", (error) => disconnect(new Error(error.code === "ENOENT"
      ? "Codex CLI introuvable. Installe Codex ou configure CODEX_BIN."
      : "Impossible de démarrer le transport Codex.")));
    child.on("exit", () => disconnect(new Error("La connexion au processus Codex a été fermée.")));
    child.stdin.on("error", () => disconnect(new Error("Le canal d’écriture Codex a été fermé.")));
    // Drain diagnostics without recording account details, tokens, or user content.
    child.stderr?.resume();
    child.stdout.on("data", (chunk) => {
      buffered += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      if (buffered.length > MAX_MESSAGE_LENGTH) {
        disconnect(new Error("Le message Codex dépasse la taille autorisée."));
        child.kill();
        return;
      }
      let newline;
      while ((newline = buffered.indexOf("\n")) !== -1) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          disconnect(new Error("Réponse invalide du transport Codex (JSONL attendu)."));
          child.kill();
          return;
        }
        this._receive(message);
      }
    });
    try {
      const result = await this._request("initialize", {
        clientInfo: { name: "astrabox", title: "ASTRABOX", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      }, this.timeoutMs);
      this._send({ method: "initialized", params: {} });
      this.initialized = true;
      this.initializeResult = result;
      return result;
    } catch (error) {
      disconnect(error);
      child.kill();
      throw error;
    }
  }

  _receive(message) {
    if (!message || typeof message !== "object") return;
    if (typeof message.method === "string") {
      if (Object.hasOwn(message, "id")) {
        this.emit("request", { id: message.id, method: message.method, params: message.params ?? {} });
      } else {
        this.emit("notification", { method: message.method, params: message.params ?? {} });
      }
      return;
    }
    const entry = this.pending.get(message.id);
    if (!entry) return;
    this.pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) {
      entry.reject(new CodexRpcError(message.error.message || "Erreur Codex", message.error.code, message.error.data));
    } else if (Object.hasOwn(message, "result")) {
      entry.resolve(message.result);
    } else {
      entry.reject(new Error("Réponse Codex sans résultat."));
    }
  }

  _send(message) {
    if (!this.process?.stdin?.writable || this.process.killed) throw new Error("Codex n’est pas connecté.");
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  _request(method, params, timeoutMs) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex n’a pas répondu à ${method} dans le délai prévu.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this._send({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async request(method, params = {}, timeoutMs = this.timeoutMs) {
    await this.connect();
    return this._request(method, params, timeoutMs);
  }

  respond(id, result) {
    this._send({ id, result });
  }

  respondError(id, code = -32603, message = "La requête n’a pas pu être traitée.") {
    this._send({ id, error: typeof code === "object" ? code : { code, message } });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    const child = this.process;
    this.process = null;
    this.initialized = false;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error("Le transport Codex a été fermé."));
    }
    this.pending.clear();
    if (child) {
      child.stdin.end();
      child.kill();
    }
  }
}
