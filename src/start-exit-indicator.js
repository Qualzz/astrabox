import { Container, Graphics } from "pixi.js";

export class StartExitIndicator extends Container {
  constructor(width, safeArea) {
    super();
    this.label = "start-exit-indicator";
    this.eventMode = "none";
    this.position.set(width / 2, safeArea.bottom - 10);
    this.addChild(new Graphics().rect(-120, -9, 240, 18).fill({ color: 0x000000, alpha: .92 }));
    this.fill = new Graphics().rect(-110, -3, 220, 6).fill({ color: 0xfff4a1, alpha: .9 });
    this.addChild(this.fill);
    this.visible = false;
  }

  update(progress) {
    this.visible = progress != null;
    // Scaling a retained rectangle avoids rebuilding geometry every frame.
    this.fill.scale.x = progress == null ? 1 : Math.max(0, Math.min(1, 1 - progress));
  }
}
