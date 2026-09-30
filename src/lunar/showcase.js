import * as THREE from "three";
import { GameThumbnails } from "../game-thumbnails.js";
import { createShowcaseBlink } from "../showcase-blink.js";

export function createPhosphorTitle({ canvasTexture, titleScene }) {
  const texture = canvasTexture(2400, 320, (context, width, height) => {
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.font = "700 210px monospace";
    // Uniform bright phosphor; the shared CRT pass supplies the texture.
    context.fillStyle = "#ffffb0";
    context.fillText("ASTRABOX", width / 2, height / 2 + 5);
  });
  const title = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({ map: texture, transparent: true, opacity: 1, depthTest: false, depthWrite: false, toneMapped: false }),
  );
  title.name = "hub-phosphor-title";
  titleScene.add(title);
  return title;
}

export function createGameShowcase(games, { onPrevious, onNext, onStart }, { titleScene, viewport, reducedMotion }) {
  const root = document.querySelector("#game-showcase");
  const title = root.querySelector(".showcase-title");
  const players = root.querySelector(".showcase-players");
  const surface = document.createElement("canvas");
  surface.width = 1300;
  surface.height = 1200;
  const context = surface.getContext("2d");
  const texture = new THREE.CanvasTexture(surface);
  texture.colorSpace = THREE.SRGBColorSpace;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({
    map: texture, transparent: true, depthTest: false, depthWrite: false, toneMapped: false,
  }));
  mesh.name = "arcade-game-selection";
  const setPromptBright = createShowcaseBlink(mesh.material);
  titleScene.add(mesh);
  let selected = games[0];
  const shots = new GameThumbnails(() => drawImage());
  let lastBlink = -1;
  let thumbnail = { x: 0, y: 0, width: 1, height: 1 };
  let liveMesh = null;
  let launchMessage = "";

  const bind = (selector, handler) => {
    root.querySelector(selector).addEventListener("click", (event) => {
      event.currentTarget.blur();
      handler();
    });
  };
  bind(".showcase-arrow--left", onPrevious);
  bind(".showcase-arrow--right", onNext);
  bind(".showcase-prompt", () => onStart(1));
  bind(".showcase-preview", () => onStart(1));

  function drawImage() {
    if (!selected) return;
    context.clearRect(0, 0, 1300, 1200);
    const shot = shots.get(selected);
    if (shot?.complete && shot.naturalWidth) {
      context.fillStyle = "#061018";
      context.fillRect(140, 90, 1020, 574);
      context.drawImage(shot, 140, 90, 1020, 574);
    }
    context.fillStyle = "rgba(247,248,182,0.86)";
    context.shadowColor = "rgba(247,248,182,0.35)";
    context.shadowBlur = 10;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.font = "600 120px monospace";
    context.fillText("‹", 50, 377);
    context.fillText("›", 1250, 377);
    context.font = "700 68px monospace";
    context.fillStyle = "rgba(255,255,255,0.94)";
    context.shadowColor = "rgba(255,255,255,0.3)";
    context.fillText(selected.title, 650, 780, 1160);
    context.fillStyle = "rgba(247,248,182,0.86)";
    context.shadowColor = "rgba(247,248,182,0.35)";
    context.font = "500 37px monospace";
    context.globalAlpha = 0.75;
    context.fillText(selected.maxPlayers === 1 ? "1 PLAYER" : `1–${selected.maxPlayers} PLAYERS`, 650, 864);
    context.globalAlpha = 0.92;
    context.font = "600 50px monospace";
    if (launchMessage) {
      context.shadowBlur = 0;
      context.fillStyle = "#000";
      context.fillRect(650 - context.measureText(launchMessage).width / 2 - 16, 1023,
        context.measureText(launchMessage).width + 32, 74);
      context.fillStyle = "#f7f8b6";
    }
    context.fillText(launchMessage || "A · JOUER", 650, 1060);
    context.globalAlpha = 1;
    context.shadowBlur = 0;
    texture.needsUpdate = true;
  }

  function draw(index) {
    const game = games[index];
    if (!game) return;
    selected = game;
    title.textContent = game.title;
    players.textContent = game.maxPlayers === 1 ? "1 PLAYER" : `1–${game.maxPlayers} PLAYERS`;
    shots.retain(games);
    shots.load(game);
    drawImage();
  }

  function layout(width, height, robotRight = width * 0.26) {
    const portrait = width / height < 1.15;
    const available = Math.max(width * 0.5, width - robotRight);
    const planeWidth = portrait ? Math.min(width * 0.92, height * 0.67) : Math.min(available * 0.8, width * 0.5, height * 0.82);
    const planeHeight = planeWidth * 1200 / 1300;
    const centerX = portrait ? width / 2 : (robotRight + width) / 2;
    const centerY = height * (portrait ? 0.64 : 0.55);
    mesh.scale.set(planeWidth, planeHeight, 1);
    mesh.position.set(centerX - width / 2, height / 2 - centerY, 0);
    Object.assign(root.style, { left: `${centerX - planeWidth / 2}px`, top: `${centerY - planeHeight / 2}px`, width: `${planeWidth}px`, height: `${planeHeight}px` });
    thumbnail = {
      x: centerX - planeWidth / 2 + planeWidth * 140 / 1300,
      y: centerY - planeHeight / 2 + planeHeight * 90 / 1200,
      width: planeWidth * 1020 / 1300, height: planeHeight * 574 / 1200,
    };
    if (liveMesh) {
      liveMesh.scale.set(thumbnail.width, thumbnail.height, 1);
      liveMesh.position.set(thumbnail.x + thumbnail.width / 2 - width / 2,
        height / 2 - thumbnail.y - thumbnail.height / 2, 0.1);
    }
  }

  function update(elapsed, visible) {
    mesh.visible = visible;
    const blink = reducedMotion || elapsed % 1.3 < 0.85;
    if (visible && blink !== lastBlink) { setPromptBright(blink); lastBlink = blink; }
  }

  function clearLive() {
    if (!liveMesh) return;
    liveMesh.removeFromParent(); liveMesh.material.map.dispose();
    liveMesh.material.dispose(); liveMesh.geometry.dispose(); liveMesh = null;
  }
  return {
    root, draw, layout, update,
    get thumbnail() { return thumbnail; },
    setMessage(message) { launchMessage = message; drawImage(); },
    setLive(canvas) {
      clearLive();
      const liveTexture = new THREE.CanvasTexture(canvas);
      liveTexture.colorSpace = THREE.SRGBColorSpace;
      liveMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({
        map: liveTexture, depthTest: false, depthWrite: false, toneMapped: false,
      }));
      liveMesh.name = "live-cartridge-thumbnail";
      liveMesh.renderOrder = 10;
      liveMesh.scale.set(thumbnail.width, thumbnail.height, 1);
      liveMesh.position.set(thumbnail.x + thumbnail.width / 2 - viewport.clientWidth / 2,
        viewport.clientHeight / 2 - thumbnail.y - thumbnail.height / 2, 0.1);
      titleScene.add(liveMesh);
    },
    clearLive,
    refreshLive() { if (liveMesh) liveMesh.material.map.needsUpdate = true; },
  };
}
