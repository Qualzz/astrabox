import { Container, Graphics, Text } from "pixi.js";

export const defaultConfig = Object.freeze({ paddleSpeed: 430, paddleWidth: 120, ballSpeed: 335, ballRadius: 8, background: "#f1eadb", paddleColor: "#675283", ballColor: "#d27f5e", brickColor: "#8663b4" });
const WIDTH = 960;
const HEIGHT = 540;
const PADDLE_Y = 474;
const limits = { paddleSpeed: [20, 1200], paddleWidth: [30, 500], ballSpeed: [40, 900], ballRadius: [3, 25] };
const metadata = { id: "quiet-breakout", title: "QUIET BREAKOUT", maxPlayers: 1, description: "A quiet wall, three chances. Solo only.", accent: "#8663b4" };
const SOUND_FILES = { brick: "pepSound3.ogg", paddle: "lowRandom.ogg", loss: "lowDown.ogg" };

function text(value, x, y, size, fill, anchor = 0, title = false) {
  const node = new Text({ text: value, style: { fontFamily: title ? "Trebuchet MS, sans-serif" : "ui-monospace, monospace", fontSize: size, fontWeight: title ? "bold" : "500", fill, letterSpacing: title ? -2 : 0 } });
  node.anchor.set(anchor, 0.5);
  node.position.set(x, y);
  return node;
}

const FALLBACK_HUD = Object.freeze({ left: 80, top: 54, right: 880, bottom: 486, width: 800, height: 432 });
function hudArea(api) { return api?.hudSafeArea ?? FALLBACK_HUD; }

// Fit measured glyph bounds, including multiline text and unusually long scores.
// Only informational nodes are resized; the playfield keeps its coordinates.
function fitHud(node, box, align = 0) {
  node.scale.set(1);
  node.position.set(0, 0);
  let bounds = node.getBounds();
  const scale = Math.min(1, box.width / Math.max(1, bounds.width), box.height / Math.max(1, bounds.height));
  node.scale.set(scale);
  bounds = node.getBounds();
  node.position.set(box.x + (box.width - bounds.width) * align - bounds.x, box.y + (box.height - bounds.height) / 2 - bounds.y);
  return node;
}
function hudText(value, box, size, fill, align = 0, title = false) {
  return fitHud(text(value, 0, 0, size, fill, 0, title), box, align);
}
function menuBox(safe, x, y, width, height) {
  return { x: safe.left + x * safe.width, y: safe.top + y * safe.height, width: width * safe.width, height: height * safe.height };
}

function validateConfig(next, previous) {
  const config = { ...previous };
  for (const [key, value] of Object.entries(next ?? {})) {
    if (!Object.hasOwn(defaultConfig, key)) throw new Error(`Unknown Quiet Breakout setting: ${key}`);
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
  let state = { version: 1, paddleX: 420, ball: { x: 480, y: 410, vx: 210, vy: -260 }, bricks: [], lives: 3, score: 0, ballSpeedBasis: config.ballSpeed };
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
    Promise.resolve().then(() => {
      if (!actors.destroyed) return service.play(`${metadata.id}:${SOUND_FILES[name]}`, { volume: 0.15, ...options });
    }).then((instance) => { if (actors.destroyed) instance?.stop?.(); }).catch(() => {});
  }

  function resetBall() {
    const ratio = config.ballSpeed / Math.hypot(210, 260);
    state.ball = { x: WIDTH / 2, y: 410, vx: 210 * ratio * (Math.random() > 0.5 ? 1 : -1), vy: -260 * ratio };
    state.paddleX = (WIDTH - config.paddleWidth) / 2;
    state.ballSpeedBasis = config.ballSpeed;
  }

  function buildBricks() {
    state.bricks = [];
    for (let row = 0; row < 5; row += 1) {
      for (let column = 0; column < 11; column += 1) state.bricks.push({ x: 52 + column * 78, y: 82 + row * 34, width: 66, height: 20, alive: true, row });
    }
  }

  function background() {
    const scene = new Container();
    scene.addChild(new Graphics().rect(0, 0, WIDTH, HEIGHT).fill(config.background));
    return scene;
  }

  function syncView() {
    if (!view || view.actors.destroyed) return;
    view.background.clear().rect(0, 0, WIDTH, HEIGHT).fill(config.background);
    const actors = view.actors.clear();
    for (const brick of state.bricks) {
      if (brick.alive) actors.roundRect(brick.x, brick.y, brick.width, brick.height, 3).fill({ color: config.brickColor, alpha: 0.5 + brick.row * 0.12 });
    }
    actors.roundRect(state.paddleX, PADDLE_Y, config.paddleWidth, 14, 7).fill(config.paddleColor).circle(state.ball.x, state.ball.y, config.ballRadius).fill(config.ballColor);
    view.score.text = `score ${String(state.score).padStart(6, "0")}`;
    view.lives.text = `chances ${"● ".repeat(state.lives).trim()}`;
    view.score.style.fill = view.lives.style.fill = config.paddleColor;
    const safe = view.safe;
    const width = (safe.width - 24) / 2;
    fitHud(view.score, { x: safe.left, y: safe.top, width, height: 24 });
    fitHud(view.lives, { x: safe.right - width, y: safe.top, width, height: 24 }, 1);
  }

  function rescaleBall() {
    const ratio = config.ballSpeed / state.ballSpeedBasis;
    state.ball.vx *= ratio;
    state.ball.vy *= ratio;
    state.ballSpeedBasis = config.ballSpeed;
  }

  function applyConfig(next) {
    config = validateConfig(next, config);
    rescaleBall();
    state.paddleX = Math.min(state.paddleX, WIDTH - config.paddleWidth - 20);
    syncView();
  }

  // Small simulation steps prevent a fast ball from crossing a brick undetected.
  function advanceBall(dt, api) {
    const ball = state.ball;
    const previousY = ball.y;
    ball.x += ball.vx * dt;
    ball.y += ball.vy * dt;
    if ((ball.x < config.ballRadius && ball.vx < 0) || (ball.x > WIDTH - config.ballRadius && ball.vx > 0)) {
      ball.vx *= -1;
      ball.x = Math.max(config.ballRadius, Math.min(WIDTH - config.ballRadius, ball.x));
    }
    if (ball.y < 64 + config.ballRadius && ball.vy < 0) {
      ball.vy *= -1;
      ball.y = 64 + config.ballRadius;
    }
    if (ball.vy > 0 && previousY + config.ballRadius <= PADDLE_Y && ball.y + config.ballRadius >= PADDLE_Y && ball.x + config.ballRadius > state.paddleX && ball.x - config.ballRadius < state.paddleX + config.paddleWidth) {
      ball.vy = -Math.abs(ball.vy);
      ball.vx += ((ball.x - (state.paddleX + config.paddleWidth / 2)) / (config.paddleWidth / 2)) * 120;
      const speed = Math.hypot(ball.vx, ball.vy);
      ball.vx *= config.ballSpeed / speed;
      ball.vy *= config.ballSpeed / speed;
      ball.y = PADDLE_Y - config.ballRadius;
      cue("paddle", { volume: 0.12, end: 0.12 });
    }
    for (const brick of state.bricks) {
      if (!brick.alive) continue;
      const hit = ball.x + config.ballRadius > brick.x && ball.x - config.ballRadius < brick.x + brick.width && ball.y + config.ballRadius > brick.y && ball.y - config.ballRadius < brick.y + brick.height;
      if (hit) {
        brick.alive = false;
        ball.vy *= -1;
        state.score += 100 + brick.row * 25;
        cue("brick", { speed: 1.3, end: 0.08 });
        break;
      }
    }
    if (ball.y > HEIGHT + 20) {
      state.lives -= 1;
      if (state.lives <= 0) {
        syncView();
        api.endGame({ score: state.score, label: "SCORE", detail: "Three chances, well spent." });
        return true;
      }
      resetBall();
      cue("loss", { volume: 0.2, end: 0.25 });
    }
    if (state.bricks.every((brick) => !brick.alive)) {
      syncView();
      api.endGame({ score: state.score + state.lives * 500, label: "SCORE", detail: "A clean slate." });
      return true;
    }
    return false;
  }

  return {
    ...metadata,
    stateVersion: 1,
    configure: applyConfig,
    applyConfig,
    mount(api) {
      const scene = background();
      view = { safe: hudArea(api), background: scene.children[0], actors: new Graphics(), score: text("", 28, 40, 14, config.paddleColor), lives: text("", WIDTH - 28, 40, 14, config.paddleColor, 1) };
      scene.addChild(new Graphics().moveTo(28, 61).lineTo(WIDTH - 28, 61).stroke({ color: config.paddleColor, width: 1, alpha: 0.25 }), view.actors, view.score, view.lives);
      return scene;
    },
    start(api) {
      prepareAudio(api);
      state = { version: 1, paddleX: 420, ball: {}, bricks: [], lives: 3, score: 0, ballSpeedBasis: config.ballSpeed };
      buildBricks();
      resetBall();
      syncView();
    },
    onPlayerJoinRequested() { return false; },
    update(dt, api) {
      prepareAudio(api);
      state.paddleX += (Number(api.input.down(1, "right")) - Number(api.input.down(1, "left"))) * config.paddleSpeed * dt;
      state.paddleX = Math.max(20, Math.min(WIDTH - config.paddleWidth - 20, state.paddleX));
      const steps = Math.max(1, Math.ceil(dt * 120));
      for (let i = 0; i < steps; i += 1) if (advanceBall(dt / steps, api)) return;
      syncView();
    },
    captureState() { return structuredClone(state); },
    restoreState(snapshot) {
      const valid = snapshot?.version === 1 && finiteFields(snapshot, ["paddleX", "lives", "score", "ballSpeedBasis"]) && snapshot.ballSpeedBasis > 0
        && Number.isInteger(snapshot.lives) && snapshot.lives >= 0 && snapshot.lives <= 3 && Number.isInteger(snapshot.score) && snapshot.score >= 0
        && finiteFields(snapshot.ball, ["x", "y", "vx", "vy"])
        && Array.isArray(snapshot.bricks) && snapshot.bricks.length > 0 && snapshot.bricks.length <= 10000
        && snapshot.bricks.every((brick) => finiteFields(brick, ["x", "y", "width", "height", "row"]) && brick.width > 0 && brick.height > 0 && Number.isInteger(brick.row) && brick.row >= 0 && brick.row < 5 && typeof brick.alive === "boolean");
      if (!valid) throw new Error("Quiet Breakout: incompatible live state");
      state = structuredClone(snapshot);
      rescaleBall();
      syncView();
      return true;
    },
    renderAttract(api, { game = metadata, controls = {} } = {}) {
      const scene = background();
      const tiles = new Graphics();
      for (let row = 0; row < 4; row += 1) for (let column = 0; column < 3; column += 1) tiles.roundRect(686 + column * 65, 120 + row * 52, 53, 39, 8).fill({ color: config.brickColor, alpha: 0.45 + row * 0.17 });
      tiles.circle(779, 379, 11).fill(config.ballColor).roundRect(718, 416, 124, 13, 7).fill(config.paddleColor);
      const safe = hudArea(api);
      const box = (...args) => menuBox(safe, ...args);
      scene.addChild(tiles,
        hudText("a small exercise in letting go", box(0, 0.06, 0.72, 0.09), 15, config.paddleColor),
        hudText(game.title.toLowerCase().replace(" ", "\n"), box(0, 0.20, 0.72, 0.41), 76, config.paddleColor, 0, true),
        hudText("One paddle. One wall. Three chances.", box(0, 0.66, 0.72, 0.10), 16, config.paddleColor),
        hudText(`${controls.confirm ?? "A"}  begin`, box(0, 0.82, 0.72, 0.09), 23, config.ballColor),
        hudText(`${controls.back ?? "B"}  back     ${controls.exit ?? "START 3 SEC"}  hub     ${controls.codex ?? "CODEX"}  modify`, box(0, 0.95, 1, 0.05), 12, config.paddleColor));
      return scene;
    },
    renderGameOver(api, { result, controls = {} }) {
      const scene = background();
      const safe = hudArea(api);
      const box = (...args) => menuBox(safe, ...args);
      scene.addChild(
        hudText("take a breath.", box(0, 0.10, 0.66, 0.16), 63, config.paddleColor, 0, true),
        hudText(result.detail, box(0, 0.30, 0.66, 0.10), 17, config.paddleColor),
        hudText(String(result.score).padStart(6, "0"), box(0, 0.47, 0.66, 0.19), 62, config.ballColor, 0, true),
        hudText("personal bests", box(0.71, 0.10, 0.29, 0.10), 25, config.paddleColor, 0, true));
      (result.leaderboard ?? []).slice(0, 5).forEach((row, index) => {
        const rowBox = box(0.71, 0.25 + index * 0.097, 0.29, 0.06);
        scene.addChild(new Graphics().moveTo(rowBox.x + 0.5, rowBox.y + rowBox.height + 4).lineTo(safe.right - 0.5, rowBox.y + rowBox.height + 4).stroke({ color: config.paddleColor, width: 1, alpha: 0.18 }));
        const width = (rowBox.width - 12) / 2;
        scene.addChild(
          hudText(`${index + 1}. ${row.name}`, { ...rowBox, width }, 16, config.paddleColor),
          hudText(String(row.score), { ...rowBox, x: safe.right - width, width }, 16, config.paddleColor, 1));
      });
      scene.addChild(
        hudText(`${controls.confirm ?? "A"}  another try`, box(0, 0.82, 1, 0.09), 22, config.ballColor),
        hudText(`${controls.back ?? "B"}  back     ${controls.exit ?? "START 3 SEC"}  hub     ${controls.codex ?? "CODEX"}  modify`, box(0, 0.95, 1, 0.05), 12, config.paddleColor));
      return scene;
    },
  };
}
