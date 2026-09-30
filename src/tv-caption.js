import { Container, Graphics, Text } from "pixi.js";

// System subtitles only. Cartridge artwork and typography remain independent.
export class TvCaption extends Container {
  constructor({ fontSize = 16, maxWidth = 850 } = {}) {
    super();
    this.plate = new Graphics();
    this.letters = new Text({ text: "", style: {
      fontFamily: "monospace", fontWeight: "bold", fontSize, fill: 0xfff4a1,
      letterSpacing: 1, align: "center", wordWrap: true, wordWrapWidth: maxWidth,
    } });
    this.letters.anchor.set(0.5, 1);
    this.addChild(this.plate, this.letters);
  }
  get text() { return this.letters.text; }
  set text(value) {
    this.letters.text = value;
    this.plate.clear();
    if (value) this.plate.rect(-this.letters.width / 2 - 8, -this.letters.height - 5,
      this.letters.width + 16, this.letters.height + 10).fill(0x000000);
  }
}
