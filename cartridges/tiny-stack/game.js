import { Container, Graphics, Text } from 'pixi.js';

const DEFAULTS = { initialWidth: 260, blockHeight: 28, baseSpeed: 230, speedPerBlock: 7, maxSpeed: 420, placementPause: 0.16, volume: 0.45, cream: '#f5edda', coral: '#df6452', ink: '#51382f' };
const LEFT = 230, RIGHT = 868, BASE = 452;
const clone = value => JSON.parse(JSON.stringify(value));
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

export default function createGame() {
  let cfg = { ...DEFAULTS }, state = null, play = null, attract = null;
  let clock = 0, audioReady = false;
  const aliases = { place: 'tiny-stack-place', start: 'tiny-stack-start', miss: 'tiny-stack-miss' };

  function prepareAudio(arcade) {
    if (audioReady) return;
    audioReady = true;
    for (const [key, file] of Object.entries({ place: 'pepSound1.ogg', start: 'highUp.ogg', miss: 'lowDown.ogg' })) {
      try {
        const loading = arcade.audio.add(aliases[key], `/assets/audio/kenney-digital/${file}`);
        if (loading && typeof loading.catch === 'function') loading.catch(() => {});
      } catch { /* Audio availability must not interrupt play. */ }
    }
  }
  function sound(arcade, key) {
    prepareAudio(arcade);
    try {
      const playing = arcade.audio.play(aliases[key], { volume: cfg.volume });
      if (playing && typeof playing.catch === 'function') playing.catch(() => {});
    } catch { /* A missing sound does not change the simulation. */ }
  }
  function rect(g, x, y, w, h, color, alpha = 1) {
    if (w > 0 && h > 0) g.rect(x, y, w, h).fill({ color, alpha });
  }
  // HUD only: convert the original editorial layout into the CRT-safe rectangle.
  // Measure again after every dynamic text update; the playfield is unaffected.
  function fitLabel(t) {
    const { x, y, width, height, scale } = t.hudLayout;
    t.scale.set(1);
    const bounds = t.getLocalBounds();
    const factor = Math.min(scale, width / Math.max(1, bounds.width), height / Math.max(1, bounds.height));
    t.scale.set(factor);
    t.position.set(x - bounds.x * factor, y - bounds.y * factor);
  }
  function label(parent, content, x, y, size, color = cfg.ink, maxWidth = 928 - x) {
    const t = new Text({ text: content, style: { fontFamily: 'Arial, Helvetica, sans-serif', fontSize: size, fontWeight: '800', fill: color, letterSpacing: size > 65 ? -4 : 1 } });
    const h = parent.hudLayout;
    const px = h.left + (x - 32) * h.sx;
    const py = h.top + (y - 39) * h.sy;
    t.hudLayout = { x: px, y: py, width: Math.min(maxWidth * h.sx, h.right - px), height: Math.min((size * 1.3 + 4) * h.sy, h.bottom - py), scale: Math.min(1, h.sx, h.sy) };
    parent.addChild(t);
    fitLabel(t);
    return t;
  }
  function panel(arcade) {
    const root = new Container();
    root.scale.set(Math.min(arcade.width / 960, arcade.height / 540));
    root.position.set((arcade.width - 960 * root.scale.x) / 2, (arcade.height - 540 * root.scale.y) / 2);
    const safe = arcade.hudSafeArea || { left: 80, top: 54, right: 880, bottom: 486, width: 800, height: 432 };
    const left = (safe.left - root.x) / root.scale.x;
    const top = (safe.top - root.y) / root.scale.y;
    const right = (safe.right - root.x) / root.scale.x;
    const bottom = (safe.bottom - root.y) / root.scale.y;
    root.hudLayout = { left, top, right, bottom, sx: (right - left) / 896, sy: (bottom - top) / 487 };
    const paper = new Graphics();
    rect(paper, 0, 0, 960, 540, cfg.cream);
    for (let y = 8; y < 540; y += 12) {
      for (let x = 8; x < 960; x += 12) {
        if ((x * 7 + y * 11) % 31 < 13) rect(paper, x, y, 1, 1, cfg.ink, 0.085);
      }
    }
    rect(paper, 32, 25, 896, 3, cfg.ink);
    rect(paper, 32, 494, 896, 3, cfg.ink);
    root.addChild(paper);
    return root;
  }
  function block(g, x, y, w, h, color = cfg.coral, alpha = 1) {
    rect(g, x + 3, y + 3, w, h - 2, cfg.ink, 0.22 * alpha);
    rect(g, x, y, w, h - 2, color, alpha);
    rect(g, x, y + h - 6, w, 4, cfg.ink, 0.13 * alpha);
    if (w > 18) rect(g, x + 6, y + 4, w - 12, 2, cfg.cream, 0.25 * alpha);
  }
  function newMoving() {
    const top = state.blocks[state.blocks.length - 1];
    const direction = state.score % 2 === 0 ? 1 : -1;
    state.moving = { id: state.nextId++, x: direction === 1 ? LEFT : RIGHT - top.w, w: top.w, level: top.level + 1, direction };
  }
  function start(arcade) {
    state = { playerId: 1, score: 0, startingWidth: cfg.initialWidth, nextId: 1, blocks: [{ id: 0, x: (LEFT + RIGHT - cfg.initialWidth) / 2, w: cfg.initialWidth, level: 0 }], moving: null, pieces: [], pause: 0, camera: 0, feedback: '', feedbackTime: 0, phase: 'playing', failTime: 0, ended: false };
    newMoving();
    sound(arcade, 'start');
    drawPlay();
  }
  function yFor(level) { return BASE - level * cfg.blockHeight + state.camera; }
  function chip(x, w, level, direction) {
    if (w > 0) state.pieces.push({ id: state.nextId++, x, w, level, offsetY: 0, vx: direction * 75, vy: 65, age: 0 });
  }
  function place(arcade) {
    const m = state.moving, top = state.blocks[state.blocks.length - 1];
    const left = Math.max(m.x, top.x), right = Math.min(m.x + m.w, top.x + top.w);
    if (right <= left) {
      chip(m.x, m.w, m.level, m.direction);
      state.phase = 'falling';
      state.failTime = 0;
      state.feedback = 'À CÔTÉ !';
      state.feedbackTime = 1;
      sound(arcade, 'miss');
      return;
    }
    if (m.x < left) chip(m.x, left - m.x, m.level, -1);
    if (m.x + m.w > right) chip(right, m.x + m.w - right, m.level, 1);
    const lost = m.w - (right - left);
    state.blocks.push({ id: m.id, x: left, w: right - left, level: m.level });
    state.score++;
    state.feedback = lost < 4 ? 'AU MILLIMÈTRE !' : '+1';
    state.feedbackTime = 0.7;
    state.pause = cfg.placementPause;
    if (state.blocks.length > 32) state.blocks.shift();
    newMoving();
    sound(arcade, 'place');
  }
  function drawPlay() {
    if (!play || !state) return;
    const { g, score, message, width } = play;
    g.clear();
    rect(g, LEFT - 15, 482, RIGHT - LEFT + 30, 3, cfg.ink);
    if (state.phase === 'playing') {
      const m = state.moving;
      rect(g, m.x, yFor(m.level) + cfg.blockHeight, m.w, cfg.blockHeight, cfg.coral, 0.07);
    }
    for (const b of state.blocks) {
      const y = yFor(b.level);
      if (y > 478 || y < 100) continue;
      block(g, b.x, y, b.w, Math.min(cfg.blockHeight, 480 - y), b.level === 0 ? cfg.ink : cfg.coral);
    }
    for (const p of state.pieces) {
      const y = yFor(p.level) + p.offsetY;
      if (y < 478) block(g, p.x, y, p.w, Math.min(cfg.blockHeight, 480 - y), cfg.coral, Math.max(0, 1 - p.age / 0.9));
    }
    if (state.phase === 'playing') {
      const m = state.moving;
      block(g, m.x, yFor(m.level), m.w, cfg.blockHeight);
      rect(g, m.x, yFor(m.level) - 5, m.w, 2, cfg.ink);
    }
    score.text = String(state.score).padStart(2, '0');
    score.style.fontSize = state.score > 999 ? 62 : 88;
    message.text = state.feedbackTime > 0 ? state.feedback : '';
    width.text = `${Math.ceil(state.blocks[state.blocks.length - 1].w / state.startingWidth * 100)} % RESTANT`;
    for (const t of [score, message, width]) fitLabel(t);
  }
  function mount(arcade) {
    const root = panel(arcade);
    label(root, 'TINY STACK', 40, 39, 30);
    label(root, 'UN BLOC À LA FOIS.', 598, 46, 17);
    label(root, 'BLOCS POSÉS', 40, 154, 16);
    const score = label(root, '00', 34, 175, 88, cfg.coral, 180);
    const width = label(root, '', 40, 292, 12, cfg.ink, 174);
    const message = label(root, '', 250, 100, 21, cfg.coral);
    const g = new Graphics(); root.addChild(g);
    const footerPaper = new Graphics(); root.addChild(footerPaper);
    const footerLabels = [
      label(root, 'A  /  POSER', 40, 506, 15),
      label(root, 'SEUL LE CHEVAUCHEMENT RESTE.', 488, 506, 15)
    ];
    // Small paper flats above the terrain and below these two labels only.
    const h = root.hudLayout;
    for (const t of footerLabels) {
      const b = t.getLocalBounds();
      const left = Math.max(h.left, t.x + b.x * t.scale.x - 5 * h.sx);
      const top = Math.max(h.top, t.y + b.y * t.scale.y - 3 * h.sy);
      const right = Math.min(h.right, t.x + (b.x + b.width) * t.scale.x + 5 * h.sx);
      const bottom = Math.min(h.bottom, t.y + (b.y + b.height) * t.scale.y + 3 * h.sy);
      rect(footerPaper, left, top, right - left, bottom - top, cfg.cream);
    }
    play = { root, g, score, message, width };
    drawPlay();
    return root;
  }
  function update(dt, arcade) {
    if (!state || state.ended) return;
    dt = clamp(Number(dt) || 0, 0, 0.05);
    state.feedbackTime = Math.max(0, state.feedbackTime - dt);
    state.pause = Math.max(0, state.pause - dt);
    if (state.phase === 'playing' && state.pause === 0) {
      if (arcade.input.pressed(1, 'a')) place(arcade);
      else {
        const m = state.moving;
        const speed = Math.min(cfg.maxSpeed, cfg.baseSpeed + state.score * cfg.speedPerBlock);
        m.x += m.direction * speed * dt;
        if (m.x < LEFT) { m.x = LEFT + (LEFT - m.x); m.direction = 1; }
        if (m.x + m.w > RIGHT) { m.x = RIGHT - m.w - (m.x + m.w - RIGHT); m.direction = -1; }
      }
    }
    const cameraTarget = Math.max(0, state.moving.level * cfg.blockHeight - 205);
    state.camera += (cameraTarget - state.camera) * Math.min(1, dt * 12);
    for (const p of state.pieces) {
      p.age += dt; p.x += p.vx * dt; p.vy += 1200 * dt; p.offsetY += p.vy * dt;
    }
    state.pieces = state.pieces.filter(p => p.age < 0.9);
    if (state.phase === 'falling') {
      state.failTime += dt;
      if (state.failTime >= 0.75) {
        state.ended = true;
        arcade.endGame({ score: state.score, label: 'BLOCS POSÉS', detail: 'Plus aucun chevauchement.' });
      }
    }
    drawPlay();
  }
  function renderAttract(arcade, { controls }) {
    const root = panel(arcade);
    label(root, 'JEU D’ADRESSE  /  SOLO', 42, 45, 17);
    label(root, 'TINY', 34, 79, 114, cfg.coral);
    label(root, 'STACK', 34, 181, 114, cfg.coral);
    label(root, 'Visez juste. Montez haut.', 42, 321, 25);
    label(root, 'A pose le bloc. Ce qui dépasse tombe.', 42, 364, 17);
    const startLabel = label(root, 'START  /  JOUER', 42, 425, 29);
    label(root, `${controls?.p1Start || 'START'}  ·  DÉMARRER`, 42, 506, 14);
    label(root, 'UNE PILE. UN BOUTON.', 676, 506, 14);
    const g = new Graphics(); root.addChild(g);
    attract = { root, g, startLabel };
    drawAttract();
    return root;
  }
  function drawAttract() {
    if (!attract) return;
    const g = attract.g; g.clear();
    rect(g, 582, 450, 306, 4, cfg.ink);
    [258, 241, 214, 181, 156].forEach((w, i) => block(g, 602 + i * 13, 414 - i * 38, w, 38, i === 0 ? cfg.ink : cfg.coral));
    block(g, 649 + Math.sin(clock * 1.7) * 72, 194, 156, 38);
    rect(g, 590, 168, 292, 2, cfg.ink, 0.2);
    attract.startLabel.alpha = 0.75 + 0.25 * Math.cos(clock * 3);
  }
  function renderGameOver(arcade, { result, controls }) {
    const root = panel(arcade);
    label(root, 'TINY STACK  /  FIN DE PARTIE', 42, 44, 20);
    label(root, 'BELLE', 37, 89, 82, cfg.coral);
    label(root, 'PILE !', 37, 166, 82, cfg.coral);
    label(root, String(result.score ?? 0), 40, 267, 104, cfg.ink, 460);
    label(root, 'BLOCS POSÉS', 44, 380, 18);
    label(root, 'PLUS AUCUN CHEVAUCHEMENT.', 44, 421, 14);
    const g = new Graphics(); rect(g, 530, 93, 3, 363, cfg.ink); root.addChild(g);
    label(root, 'LES RECORDS', 574, 101, 31);
    const entries = (result.leaderboard || []).slice(0, 5);
    if (!entries.length) label(root, 'La prochaine pile sera plus haute.', 574, 183, 16);
    entries.forEach((entry, i) => {
      const y = 168 + i * 51;
      label(root, String(i + 1).padStart(2, '0'), 576, y, 22, cfg.coral);
      label(root, String(entry.name || 'P1').slice(0, 13), 628, y + 2, 19, cfg.ink, 145);
      const value = label(root, String(entry.score), 785, y, 24, cfg.ink, 107);
      value.x += value.hudLayout.width - value.getLocalBounds().width * value.scale.x;
      const h = root.hudLayout;
      rect(g, h.left + (574 - 32) * h.sx, h.top + (y + 37 - 39) * h.sy, 320 * h.sx, h.sy, cfg.ink, 0.2);
    });
    label(root, 'START  /  REJOUER', 42, 506, 18);
    label(root, `${controls?.p1Start || 'START'}  ·  ENCORE UNE PILE`, 589, 507, 13);
    return root;
  }
  function configure(config) {
    cfg = { ...DEFAULTS, ...config };
    for (const key of ['initialWidth', 'blockHeight', 'baseSpeed', 'speedPerBlock', 'maxSpeed', 'placementPause', 'volume']) {
      if (!Number.isFinite(cfg[key])) cfg[key] = DEFAULTS[key];
    }
    cfg.initialWidth = clamp(cfg.initialWidth, 40, 400);
    cfg.blockHeight = clamp(cfg.blockHeight, 12, 48);
    cfg.baseSpeed = clamp(cfg.baseSpeed, 20, 1000);
    cfg.maxSpeed = clamp(cfg.maxSpeed, cfg.baseSpeed, 1200);
    cfg.speedPerBlock = clamp(cfg.speedPerBlock, 0, 100);
    cfg.placementPause = clamp(cfg.placementPause, 0, 1);
    cfg.volume = clamp(cfg.volume, 0, 1);
  }
  function restoreState(snapshot) {
    const s = clone(snapshot);
    if (!s || !Array.isArray(s.blocks) || !s.blocks.length || !s.moving || !Number.isInteger(s.score) || s.score < 0) throw new Error('État TINY STACK incompatible');
    for (const b of [...s.blocks, s.moving]) {
      if (![b.id, b.x, b.w, b.level].every(Number.isFinite) || b.w <= 0 || b.x < LEFT - 0.01 || b.x + b.w > RIGHT + 0.01) throw new Error('Bloc invalide');
    }
    state = { playerId: 1, startingWidth: s.blocks[0].level === 0 ? s.blocks[0].w : cfg.initialWidth, pieces: [], camera: 0, pause: 0, feedback: '', feedbackTime: 0, phase: 'playing', failTime: 0, ended: false, ...s };
    state.nextId ??= Math.max(...state.blocks.map(b => b.id), state.moving.id, ...state.pieces.map(p => p.id)) + 1;
    state.moving.direction = state.moving.direction === -1 ? -1 : 1;
    drawPlay();
    return true;
  }
  return {
    stateVersion: 1, configure, mount, start, update,
    captureState: () => clone(state), restoreState, renderAttract, renderGameOver,
    updateAttract(dt, arcade) { prepareAudio(arcade); clock += clamp(dt || 0, 0, 0.05); drawAttract(); },
    destroy() { play = null; attract = null; state = null; }
  };
}
