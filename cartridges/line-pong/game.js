import { Container, Graphics, Text } from "pixi.js";

export const defaultConfig = Object.freeze({ paddleSpeed: 330, paddleHeight: 80, ballSpeed: 260, ballRadius: 9, cpuSpeed: 205, targetScore: 5, background: "#214438", paddleColor: "#eee7c6", ballColor: "#ffce72" });
const WIDTH = 960;
const HEIGHT = 540;
const TOP = 78;
const BOTTOM = 504;
const limits = { paddleSpeed: [20, 1000], paddleHeight: [24, 250], ballSpeed: [40, 900], ballRadius: [3, 30], cpuSpeed: [0, 800], targetScore: [1, 99] };
const metadata = { id: "line-pong", title: "LINE PONG", maxPlayers: 2, description: "First to five. P2 START opens a new versus match.", accent: "#eee7c6" };
const SOUND_FILES = { paddle: "tone1.ogg", wall: "pepSound1.ogg", point: "highUp.ogg", join: "threeTone1.ogg" };

function text(value, x, y, size, fill, anchor = 0, serif = false) {
  const node = new Text({ text: value, style: { fontFamily: serif ? "Georgia, serif" : "ui-monospace, monospace", fontSize: size, fontWeight: serif ? "normal" : "600", fill } });
  node.anchor.set(anchor, 0.5);
  node.position.set(x, y);
  return node;
}

const HUD_FALLBACK = Object.freeze({ left: 80, top: 54, right: 880, bottom: 486, width: 800, height: 432 });
function hudBox(api, x, y, width, height) {
  const safe = api?.hudSafeArea ?? HUD_FALLBACK;
  return { x: safe.left + x * safe.width / 800, y: safe.top + y * safe.height / 432, width: width * safe.width / 800, height: height * safe.height / 432 };
}
function fitText(node, box) {
  // Measure the complete glyph bounds, including multiline and updated text.
  node.scale.set(1);
  const bounds = node.getLocalBounds();
  const scale = Math.min(1, box.width / Math.max(1, bounds.width), box.height / Math.max(1, bounds.height));
  node.scale.set(scale);
  node.position.set(
    box.x + (box.width - bounds.width * scale) * node.anchor.x - bounds.x * scale,
    box.y + (box.height - bounds.height * scale) / 2 - bounds.y * scale,
  );
  return node;
}
function hudText(api, value, x, y, width, height, size, fill, anchor = 0, serif = false) {
  return fitText(text(value, 0, 0, size, fill, anchor, serif), hudBox(api, x, y, width, height));
}

function validateConfig(next, previous) {
  const config = { ...previous };
  for (const [key, value] of Object.entries(next ?? {})) {
    if (!Object.hasOwn(defaultConfig, key)) throw new Error(`Unknown Line Pong setting: ${key}`);
    if (limits[key]) {
      const [min, max] = limits[key];
      if (!Number.isFinite(value) || value < min || value > max || (key === "targetScore" && !Number.isInteger(value))) throw new Error(`Invalid ${key}: expected ${min}–${max}`);
    } else if (typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value)) throw new Error(`Invalid color: ${key}`);
    config[key] = value;
  }
  return config;
}
function finiteFields(value, fields) { return value && fields.every((key) => Number.isFinite(value[key])); }

export default function createGame() {
  let config = { ...defaultConfig };
  let state = { version: 1, leftY: 230, rightY: 230, ball: { x: 480, y: 270, vx: 260, vy: 0 }, scores: [0, 0], rally: 0, bestRally: 0, player2Active: false, ballSpeedBasis: config.ballSpeed };
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
      if (!actors.destroyed) return service.play(`${metadata.id}:${SOUND_FILES[name]}`, { volume: 0.18, ...options });
    }).then((instance) => { if (actors.destroyed) instance?.stop?.(); }).catch(() => {});
  }

  function resetBall(direction = 1) {
    state.ball = { x: WIDTH / 2, y: (TOP + BOTTOM) / 2, vx: config.ballSpeed * direction, vy: (Math.random() - 0.5) * config.ballSpeed * 0.85 };
    state.rally = 0;
    state.ballSpeedBasis = config.ballSpeed;
  }

  function background() {
    const scene = new Container();
    scene.addChild(new Graphics().rect(0, 0, WIDTH, HEIGHT).fill(config.background));
    scene.addChild(new Graphics().rect(24, TOP, WIDTH - 48, BOTTOM - TOP).stroke({ color: config.paddleColor, width: 2, alpha: 0.22 }));
    return scene;
  }

  function syncView() {
    if (!view || view.actors.destroyed) return;
    view.background.clear().rect(0, 0, WIDTH, HEIGHT).fill(config.background);
    view.actors.clear().rect(36, state.leftY, 18, config.paddleHeight).fill(config.paddleColor).rect(WIDTH - 54, state.rightY, 18, config.paddleHeight).fill({ color: config.paddleColor, alpha: state.player2Active ? 1 : 0.6 }).circle(state.ball.x, state.ball.y, config.ballRadius).fill(config.ballColor);
    view.leftScore.text = String(state.scores[0]);
    view.rightScore.text = String(state.scores[1]);
    view.p2.text = state.player2Active ? "P2" : "CPU · P2 START";
    view.target.text = `FIRST TO ${config.targetScore}`;
    for (const key of ["leftScore", "rightScore", "p2", "target"]) fitText(view[key], view.boxes[key]);
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
    state.leftY = Math.min(state.leftY, BOTTOM - config.paddleHeight);
    state.rightY = Math.min(state.rightY, BOTTOM - config.paddleHeight);
    syncView();
  }

  return {
    ...metadata,
    stateVersion: 1,
    configure: applyConfig,
    applyConfig,
    mount(api) {
      const scene = background();
      const divider = new Graphics();
      for (let y = TOP; y < BOTTOM; y += 26) divider.rect(WIDTH / 2 - 1, y, 2, 12).fill({ color: config.paddleColor, alpha: 0.35 });
      view = { background: scene.children[0], actors: new Graphics(), leftScore: text("0", 420, 40, 36, config.paddleColor, 0.5), rightScore: text("0", 540, 40, 36, config.paddleColor, 0.5), p2: text("", 924, 40, 13, config.paddleColor, 1), target: text("", 36, 40, 13, config.paddleColor) };
      view.boxes = { target: hudBox(api, 0, 0, 260, 44), leftScore: hudBox(api, 280, 0, 120, 44), rightScore: hudBox(api, 400, 0, 120, 44), p2: hudBox(api, 540, 0, 260, 44) };
      for (const key of ["leftScore", "rightScore", "p2", "target"]) fitText(view[key], view.boxes[key]);
      scene.addChild(divider, view.actors, view.leftScore, view.rightScore, view.p2, view.target);
      return scene;
    },
    start(api) {
      prepareAudio(api);
      state = { version: 1, leftY: 230, rightY: 230, ball: {}, scores: [0, 0], rally: 0, bestRally: 0, player2Active: api.playerCount === 2, ballSpeedBasis: config.ballSpeed };
      resetBall(Math.random() > 0.5 ? 1 : -1);
      syncView();
    },
    onPlayerJoinRequested(player, api) {
      if (player !== 2 || state.player2Active || !api.acceptPlayer(player, "NEW CHALLENGER")) return false;
      state.player2Active = true;
      state.scores = [0, 0];
      state.rally = state.bestRally = 0;
      state.leftY = state.rightY = 230;
      resetBall(Math.random() > 0.5 ? 1 : -1);
      syncView();
      cue("join", { volume: 0.22, end: 0.6 });
      return true;
    },
    update(dt, api) {
      prepareAudio(api);
      state.leftY += (Number(api.input.down(1, "down")) - Number(api.input.down(1, "up"))) * config.paddleSpeed * dt;
      state.leftY = Math.max(TOP, Math.min(BOTTOM - config.paddleHeight, state.leftY));
      if (state.player2Active) state.rightY += (Number(api.input.down(2, "down")) - Number(api.input.down(2, "up"))) * config.paddleSpeed * dt;
      else {
        const offset = state.ball.y - (state.rightY + config.paddleHeight / 2);
        state.rightY += Math.sign(offset) * Math.min(Math.abs(offset), config.cpuSpeed * dt);
      }
      state.rightY = Math.max(TOP, Math.min(BOTTOM - config.paddleHeight, state.rightY));
      const ball = state.ball;
      const previousX = ball.x;
      ball.x += ball.vx * dt;
      ball.y += ball.vy * dt;
      if ((ball.y < TOP + config.ballRadius && ball.vy < 0) || (ball.y > BOTTOM - config.ballRadius && ball.vy > 0)) {
        ball.vy *= -1;
        ball.y = Math.max(TOP + config.ballRadius, Math.min(BOTTOM - config.ballRadius, ball.y));
        cue("wall", { volume: 0.1, end: 0.08 });
      }
      const hitLeft = ball.vx < 0 && previousX - config.ballRadius >= 54 && ball.x - config.ballRadius <= 54 && ball.y + config.ballRadius > state.leftY && ball.y - config.ballRadius < state.leftY + config.paddleHeight;
      const hitRight = ball.vx > 0 && previousX + config.ballRadius <= WIDTH - 54 && ball.x + config.ballRadius >= WIDTH - 54 && ball.y + config.ballRadius > state.rightY && ball.y - config.ballRadius < state.rightY + config.paddleHeight;
      if (hitLeft || hitRight) {
        ball.vx = -Math.sign(ball.vx) * Math.min(Math.abs(ball.vx) * 1.055, config.ballSpeed * 2.5);
        ball.x = hitLeft ? 54 + config.ballRadius : WIDTH - 54 - config.ballRadius;
        ball.vy += ((ball.y - ((hitLeft ? state.leftY : state.rightY) + config.paddleHeight / 2)) / (config.paddleHeight / 2)) * 105;
        state.rally += 1;
        state.bestRally = Math.max(state.bestRally, state.rally);
        cue("paddle", { speed: 1.5, end: 0.12 });
      }
      if (ball.x < -config.ballRadius || ball.x > WIDTH + config.ballRadius) {
        const leftScored = ball.x > WIDTH;
        state.scores[leftScored ? 0 : 1] += 1;
        if (state.scores[0] >= config.targetScore || state.scores[1] >= config.targetScore) {
          syncView();
          api.endGame({ score: state.bestRally, label: "BEST RALLY", detail: `${state.scores[0]} — ${state.scores[1]}` });
          return;
        }
        resetBall(leftScored ? -1 : 1);
        cue("point", { volume: 0.24, end: 0.3 });
      }
      syncView();
    },
    captureState() { return structuredClone(state); },
    restoreState(snapshot) {
      const valid = snapshot?.version === 1 && finiteFields(snapshot, ["leftY", "rightY", "rally", "bestRally", "ballSpeedBasis"]) && snapshot.ballSpeedBasis > 0
        && finiteFields(snapshot.ball, ["x", "y", "vx", "vy"]) && typeof snapshot.player2Active === "boolean"
        && Array.isArray(snapshot.scores) && snapshot.scores.length === 2 && snapshot.scores.every((score) => Number.isInteger(score) && score >= 0)
        && Number.isInteger(snapshot.rally) && snapshot.rally >= 0 && Number.isInteger(snapshot.bestRally) && snapshot.bestRally >= snapshot.rally;
      if (!valid) throw new Error("Line Pong: incompatible live state");
      state = structuredClone(snapshot);
      rescaleBall();
      syncView();
      return true;
    },
    renderAttract(api, { game = metadata, controls = {} } = {}) {
      const scene = background();
      scene.addChild(new Graphics().moveTo(650, 99).lineTo(650, 466).stroke({ color: config.paddleColor, width: 1, alpha: 0.4 }).circle(786, 277, 57).stroke({ color: config.ballColor, width: 3 }).rect(759, 259, 54, 36).fill(config.background));
      scene.addChild(
        hudText(api, "THE TWO-PADDLE SPORTS CLUB", 0, 44, 550, 30, 14, config.ballColor),
        hudText(api, game.title.replace(" ", "\n"), 0, 92, 550, 210, 93, config.paddleColor, 0, true),
        hudText(api, "One court. No excuses.", 0, 319, 550, 32, 20, config.paddleColor, 0, true),
        hudText(api, `${controls.confirm ?? "A"} / ${controls.p1Start ?? "START P1"}  VS CPU`, 600, 308, 200, 32, 15, config.paddleColor),
        hudText(api, `${controls.p2Start ?? "START P2"}  VS PLAYER`, 600, 343, 200, 32, 15, config.ballColor),
        hudText(api, `${controls.back ?? "B"}  BACK     ${controls.exit ?? "START 3 SEC"}  HUB     ${controls.codex ?? "CODEX"}  MODIFY`, 0, 400, 800, 32, 12, config.paddleColor),
      );
      return scene;
    },
    renderGameOver(api, { result, controls = {} }) {
      const scene = background();
      scene.addChild(hudText(api, "MATCH POINT", 0, 46, 510, 34, 18, config.ballColor), hudText(api, result.detail, 0, 116, 510, 126, 95, config.paddleColor, 0, true), hudText(api, `Longest rally: ${result.score}`, 0, 253, 510, 40, 24, config.paddleColor, 0, true), hudText(api, "CLUB RECORDS", 550, 52, 250, 34, 17, config.ballColor));
      (result.leaderboard ?? []).slice(0, 5).forEach((row, index) => scene.addChild(hudText(api, `${String(index + 1).padStart(2, "0")}  ${row.name}   ${row.score}`, 550, 111 + index * 39, 250, 36, 20, config.paddleColor, 0, true)));
      scene.addChild(hudText(api, `${controls.confirm ?? "A"} / ${controls.p1Start ?? "START"}  PLAY AGAIN`, 0, 357, 800, 40, 20, config.ballColor), hudText(api, `${controls.back ?? "B"}  BACK     ${controls.exit ?? "START 3 SEC"}  HUB     ${controls.codex ?? "CODEX"}  MODIFY`, 0, 402, 800, 30, 12, config.paddleColor));
      return scene;
    },
  };
}
