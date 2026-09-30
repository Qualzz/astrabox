import { Container, Graphics, Text } from "pixi.js";

export const defaultConfig = Object.freeze({
  playerSpeed: 255, playerSize: 15, meteorSpeed: 230, meteorSize: 18,
  spawnInterval: 0.48, duration: 30, background: "#091426",
  meteorColor: "#ff9f68", player1Color: "#c7eeff", player2Color: "#ffc96b",
});
const WIDTH = 960;
const HEIGHT = 540;
const limits = { playerSpeed: [20, 1000], playerSize: [5, 50], meteorSpeed: [10, 900], meteorSize: [3, 60], spawnInterval: [0.06, 3], duration: [5, 300] };
const metadata = { id: "meteor-dodge", title: "METEOR DODGE", maxPlayers: 2, description: "Survive the storm. P2 can join instantly.", accent: "#ff9f68" };
const SOUND_FILES = { impact: "spaceTrash1.ogg", join: "phaseJump1.ogg" };

function text(value, x, y, size, fill, anchor = 0) {
  const node = new Text({ text: value, style: { fontFamily: "ui-monospace, monospace", fontSize: size, fontWeight: "600", fill } });
  node.anchor.set(anchor, 0.5);
  node.position.set(x, y);
  return node;
}

// Layout is render-only: never move the playfield or alter captured state.
function safeArea(api) {
  return api?.hudSafeArea ?? { left: 80, top: 54, right: 880, bottom: 486, width: 800, height: 432 };
}

function hudBox(safe, x, y, width, height) {
  return { left: safe.left + x * safe.width, top: safe.top + y * safe.height,
    width: width * safe.width, height: height * safe.height };
}

function fitHud(node, box, align = 0) {
  node.scale.set(1);
  node.position.set(0, 0);
  const natural = node.getBounds();
  // Leave a pixel of breathing room around the measured glyph/stroke bounds.
  node.scale.set(Math.min(1, (box.width - 2) / Math.max(1, natural.width), (box.height - 2) / Math.max(1, natural.height)));
  const bounds = node.getBounds();
  node.position.set(box.left + 1 + (box.width - 2 - bounds.width) * align - bounds.x,
    box.top + (box.height - bounds.height) / 2 - bounds.y);
  return node;
}

function hudText(value, size, fill, safe, x, y, width, height, align = 0) {
  return fitHud(text(value, 0, 0, size, fill), hudBox(safe, x, y, width, height), align);
}

function validateConfig(next, previous) {
  const config = { ...previous };
  for (const [key, value] of Object.entries(next ?? {})) {
    if (!Object.hasOwn(defaultConfig, key)) throw new Error(`Unknown Meteor Dodge setting: ${key}`);
    if (limits[key]) {
      const [min, max] = limits[key];
      if (!Number.isFinite(value) || value < min || value > max) throw new Error(`Invalid ${key}: expected ${min}–${max}`);
    } else if (typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value)) throw new Error(`Invalid color: ${key}`);
    config[key] = value;
  }
  return config;
}

function finiteFields(value, fields) { return value && fields.every((key) => Number.isFinite(value[key])); }

export default function createGame() {
  let config = { ...defaultConfig };
  let state = { version: 1, elapsed: 0, spawnTimer: 0, players: [], meteors: [] };
  let view;
  let audio;
  const clips = new Map();

  function prepareAudio(api) {
    if (!api?.audio?.add || audio === api.audio) return;
    audio = api.audio;
    const service = audio;
    for (const [name, file] of Object.entries(SOUND_FILES)) {
      Promise.resolve().then(() => service.add(`${metadata.id}:${file}`, {
        url: `/assets/audio/kenney-digital/${file}`, preload: true, loaded: () => {},
      })).then((clip) => { if (audio === service) clips.set(name, clip); }).catch(() => {});
    }
  }

  function cue(name, options = {}) {
    const actors = view?.actors;
    const service = audio;
    if (!actors || actors.destroyed || !clips.get(name)?.isLoaded || !service?.play) return;
    // Never queue a sound to be heard later, after the player has left the game.
    Promise.resolve().then(() => {
      if (!actors.destroyed) return service.play(`${metadata.id}:${SOUND_FILES[name]}`, { volume: 0.22, ...options });
    }).then((instance) => { if (actors.destroyed) instance?.stop?.(); }).catch(() => {});
  }

  function addPlayer(number) {
    state.players.push({ number, x: number === 1 ? 360 : 600, y: 450, lives: 3, invulnerable: 0 });
  }

  function background() {
    const scene = new Container();
    scene.addChild(new Graphics().rect(0, 0, WIDTH, HEIGHT).fill(config.background));
    const stars = new Graphics();
    for (let i = 0; i < 60; i += 1) stars.circle((i * 173 + 19) % WIDTH, (i * 97 + 53) % HEIGHT, i % 4 === 0 ? 1.4 : 0.65).fill({ color: 0xc7eeff, alpha: 0.35 });
    scene.addChild(stars);
    return scene;
  }

  function syncView() {
    if (!view || view.actors.destroyed) return;
    view.background.clear().rect(0, 0, WIDTH, HEIGHT).fill(config.background);
    const actors = view.actors.clear();
    for (const meteor of state.meteors) {
      const radius = meteor.sizeFactor * config.meteorSize;
      actors.moveTo(meteor.x - radius * 0.5, meteor.y - radius * 3).lineTo(meteor.x, meteor.y).stroke({ color: config.meteorColor, width: radius * 0.7, alpha: 0.22 });
      actors.circle(meteor.x, meteor.y, radius).fill(config.meteorColor);
    }
    for (const player of state.players) {
      if (player.lives <= 0 || (player.invulnerable > 0 && Math.floor(player.invulnerable * 12) % 2)) continue;
      const r = config.playerSize;
      actors.moveTo(player.x, player.y - r * 1.26).lineTo(player.x - r, player.y + r).lineTo(player.x + r, player.y + r).closePath().fill(player.number === 1 ? config.player1Color : config.player2Color);
    }
    view.time.text = `TIME ${Math.max(0, config.duration - state.elapsed).toFixed(1)}`;
    view.p1.text = `P1 ${"◆".repeat(state.players.find((player) => player.number === 1)?.lives ?? 0)}`;
    const p2 = state.players.find((player) => player.number === 2);
    view.p2.text = p2 ? `P2 ${"◆".repeat(p2.lives)}` : "P2 START TO JOIN";
    view.p1.style.fill = config.player1Color;
    view.p2.style.fill = config.player2Color;
    fitHud(view.time, hudBox(view.safe, 0, 0, 0.20, 0.075));
    fitHud(view.p1, hudBox(view.safe, 0.22, 0, 0.25, 0.075));
    fitHud(view.p2, hudBox(view.safe, 0.50, 0, 0.50, 0.075), 1);
  }

  function applyConfig(next) { config = validateConfig(next, config); syncView(); }

  return {
    ...metadata,
    stateVersion: 1,
    configure: applyConfig,
    applyConfig,
    mount(api) {
      const scene = background();
      const grid = new Graphics();
      for (let y = 90; y < HEIGHT; y += 45) grid.moveTo(0, y).lineTo(WIDTH, y).stroke({ color: 0x253955, width: 1 });
      view = { safe: safeArea(api), background: scene.children[0], actors: new Graphics(), time: text("", 28, 42, 14, 0x869bb9), p1: text("", 195, 42, 14, config.player1Color), p2: text("", WIDTH - 28, 42, 14, config.player2Color, 1) };
      scene.addChild(grid, view.actors, view.time, view.p1, view.p2);
      return scene;
    },
    start(api) {
      prepareAudio(api);
      state = { version: 1, elapsed: 0, spawnTimer: 0, players: [], meteors: [] };
      addPlayer(1);
      if (api.playerCount === 2) addPlayer(2);
      syncView();
    },
    onPlayerJoinRequested(player, api) {
      if (player !== 2 || state.players.some((entry) => entry.number === player)) return false;
      if (!api.acceptPlayer(player, "WINGMAN ONLINE")) return false;
      addPlayer(player);
      syncView();
      cue("join", { volume: 0.3 });
      return true;
    },
    update(dt, api) {
      prepareAudio(api);
      state.elapsed += dt;
      state.spawnTimer -= dt;
      if (state.spawnTimer <= 0) {
        state.meteors.push({ x: 40 + Math.random() * (WIDTH - 80), y: -60, sizeFactor: 0.55 + Math.random() * 0.95, speedFactor: 0.67 + Math.random() * 0.63 });
        state.spawnTimer = Math.max(config.spawnInterval / 3, config.spawnInterval - state.elapsed * config.spawnInterval / 60);
      }
      for (const player of state.players) {
        if (player.lives <= 0) continue;
        const dx = Number(api.input.down(player.number, "right")) - Number(api.input.down(player.number, "left"));
        const dy = Number(api.input.down(player.number, "down")) - Number(api.input.down(player.number, "up"));
        const margin = Math.max(24, config.playerSize * 1.3);
        player.x = Math.max(margin, Math.min(WIDTH - margin, player.x + dx * config.playerSpeed * dt));
        player.y = Math.max(70 + margin, Math.min(HEIGHT - margin, player.y + dy * config.playerSpeed * dt));
        player.invulnerable = Math.max(0, player.invulnerable - dt);
      }
      for (const meteor of state.meteors) {
        meteor.y += meteor.speedFactor * config.meteorSpeed * dt;
        for (const player of state.players) {
          if (player.lives <= 0 || player.invulnerable > 0) continue;
          if (Math.hypot(meteor.x - player.x, meteor.y - player.y) < meteor.sizeFactor * config.meteorSize + config.playerSize) {
            player.lives -= 1;
            player.invulnerable = 1.1;
            meteor.y = HEIGHT + 100;
            cue("impact", { end: 0.38 });
            break;
          }
        }
      }
      state.meteors = state.meteors.filter((meteor) => meteor.y < HEIGHT + 60);
      syncView();
      if (state.elapsed >= config.duration || state.players.every((player) => player.lives <= 0)) api.endGame({ score: state.elapsed * 100 + state.players.reduce((sum, player) => sum + player.lives * 500, 0), label: "SURVIVAL SCORE", detail: state.elapsed >= config.duration ? "STORM CLEARED" : "CREW LOST" });
    },
    captureState() { return structuredClone(state); },
    restoreState(snapshot) {
      const valid = snapshot?.version === 1 && finiteFields(snapshot, ["elapsed", "spawnTimer"]) && snapshot.elapsed >= 0
        && Array.isArray(snapshot.players) && snapshot.players.length >= 1 && snapshot.players.length <= 2
        && snapshot.players.every((player) => finiteFields(player, ["number", "x", "y", "lives", "invulnerable"]) && [1, 2].includes(player.number) && Number.isInteger(player.lives) && player.lives >= 0 && player.lives <= 3)
        && new Set(snapshot.players.map((player) => player.number)).size === snapshot.players.length
        && Array.isArray(snapshot.meteors) && snapshot.meteors.length <= 10000 && snapshot.meteors.every((meteor) => finiteFields(meteor, ["x", "y", "sizeFactor", "speedFactor"]) && meteor.sizeFactor > 0 && meteor.speedFactor > 0);
      if (!valid) throw new Error("Meteor Dodge: incompatible live state");
      state = structuredClone(snapshot);
      syncView();
      return true;
    },
    renderAttract(api, { game = metadata, controls = {} } = {}) {
      const scene = background();
      const safe = safeArea(api);
      const emblem = new Graphics().circle(790, 172, 75).stroke({ color: config.meteorColor, width: 2 }).moveTo(737, 120).lineTo(845, 225).stroke({ color: config.meteorColor, width: 13 });
      fitHud(emblem, hudBox(safe, 0.79, 0.10, 0.21, 0.38), 1);
      scene.addChild(emblem,
        hudText("FLIGHT CONTROL / SURVIVAL", 15, config.meteorColor, safe, 0, 0.025, 0.76, 0.06),
        hudText(game.title.replace(" ", "\n"), 72, 0xf5f3ed, safe, 0, 0.16, 0.76, 0.42),
        hudText("DODGE THE STORM. BRING A WINGMAN.", 17, 0x869bb9, safe, 0, 0.63, 1, 0.07),
        hudText(`${controls.confirm ?? "A"} / ${controls.p1Start ?? "START P1"}   LAUNCH`, 23, config.meteorColor, safe, 0, 0.79, 1, 0.08),
        hudText(`${controls.p2Start ?? "START P2"}   TWO PILOTS / JOIN IN FLIGHT`, 14, config.player2Color, safe, 0, 0.875, 1, 0.055),
        hudText(`${controls.back ?? "B"}  BACK   ${controls.exit ?? "START 3 SEC"}  HUB     ${controls.codex ?? "CODEX"}  CREATE / MODIFY`, 12, 0x869bb9, safe, 0, 0.95, 1, 0.05));
      return scene;
    },
    renderGameOver(api, { result, controls = {} }) {
      const scene = background();
      const safe = safeArea(api);
      scene.addChild(
        hudText("MISSION REPORT", 15, config.meteorColor, safe, 0, 0.025, 0.64, 0.06),
        hudText(result.detail, 43, 0xf5f3ed, safe, 0, 0.18, 0.64, 0.16),
        hudText(String(result.score).padStart(6, "0"), 66, config.meteorColor, safe, 0, 0.36, 0.64, 0.20),
        hudText(result.label, 15, 0x869bb9, safe, 0, 0.58, 0.64, 0.07),
        hudText("FLIGHT RECORDS", 18, config.player1Color, safe, 0.68, 0.11, 0.32, 0.07));
      (result.leaderboard ?? []).slice(0, 5).forEach((row, index) => scene.addChild(
        hudText(`${index + 1}   ${row.name}   ${String(row.score).padStart(6, "0")}`, 17, index === 0 ? config.meteorColor : 0x869bb9, safe, 0.68, 0.23 + index * 0.09, 0.32, 0.075)));
      scene.addChild(
        hudText(`${controls.confirm ?? "A"} / ${controls.p1Start ?? "START"}  FLY AGAIN`, 22, config.player1Color, safe, 0, 0.82, 1, 0.08),
        hudText(`${controls.back ?? "B"}  BACK   ${controls.exit ?? "START 3 SEC"}  HUB     ${controls.codex ?? "CODEX"}  MODIFY`, 13, 0x869bb9, safe, 0, 0.95, 1, 0.05));
      return scene;
    },
  };
}
