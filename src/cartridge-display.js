import { Container, Graphics, Rectangle } from "pixi.js";

export function cartridgeDisplayLayout(viewWidth, viewHeight, gameWidth, gameHeight) {
  // A display resize never changes a cartridge's coordinates or simulation.
  const resolution = Math.min(1, 960 / Math.max(1, viewWidth), 720 / Math.max(1, viewHeight));
  const width = Math.max(1, Math.round(viewWidth * resolution));
  const height = Math.max(1, Math.round(viewHeight * resolution));
  // FILL the tube, not a fitted 16:9 rectangle inside it. Keep every gameplay
  // coordinate visible rather than using cover/zoom (which would hide paddles).
  return { width, height, scaleX: width / gameWidth, scaleY: height / gameHeight };
}

export function mountCartridgeDisplay(app, runtime, viewport) {
  const display = new Container();
  const glass = new Graphics();
  // Games can spawn entities beyond their playfield. The old filterArea hid
  // those; keep that boundary when the CRT filter moves to the larger tube.
  const playfield = new Graphics().rect(0, 0, runtime.api.width, runtime.api.height).fill(0xffffff);
  runtime.screenLayer.addChild(playfield);
  runtime.screenLayer.mask = playfield;
  display.addChild(glass, runtime.screenLayer);
  // Move the existing CRT pass, don't stack a second one. The game's logical
  // coordinates stay intact; its image fills the entire physical tube.
  runtime.screenLayer.filters = null;
  display.filters = [runtime.crtFilter];
  app.stage.addChild(display);
  const resize = () => {
    const layout = cartridgeDisplayLayout(viewport.clientWidth, viewport.clientHeight, runtime.api.width, runtime.api.height);
    app.renderer.resize(layout.width, layout.height);
    glass.clear().rect(0, 0, layout.width, layout.height).fill(0x02070d);
    display.filterArea = new Rectangle(0, 0, layout.width, layout.height);
    runtime.screenLayer.scale.set(layout.scaleX, layout.scaleY);
    runtime.screenLayer.position.set(0, 0);
  };
  const observer = new ResizeObserver(resize);
  observer.observe(viewport);
  resize();
  const onPageHide = event => {
    if (!event.persisted) observer.disconnect();
  };
  window.addEventListener("pagehide", onPageHide);
  return {
    // The hub applies its own CRT during the zoom. Never filter twice.
    present(crt) {
      display.filters = crt ? [runtime.crtFilter] : null;
    },
    dispose() { observer.disconnect(); window.removeEventListener("pagehide", onPageHide); },
  };
}
