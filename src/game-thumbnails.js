// One current image per cartridge. Revision is cache invalidation, not history.
export class GameThumbnails {
  constructor(onLoad, createImage = () => new Image()) {
    this.images = new Map();
    this.onLoad = onLoad;
    this.createImage = createImage;
  }

  url(game) {
    if (!game.screenshot) return '';
    const separator = game.screenshot.includes('?') ? '&' : '?';
    return game.screenshot + (game.revision ? `${separator}revision=${encodeURIComponent(game.revision)}` : '');
  }

  get(game) {
    const entry = this.images.get(game.id);
    return entry?.url === this.url(game) ? entry.image : null;
  }

  load(game) {
    const url = this.url(game);
    const previous = this.images.get(game.id);
    if (previous?.url === url) return;
    if (previous) previous.image.onload = previous.image.onerror = null;
    this.images.delete(game.id);
    if (!url) return;
    const image = this.createImage();
    const entry = { url, image };
    this.images.set(game.id, entry);
    image.onload = () => { if (this.images.get(game.id) === entry) this.onLoad(); };
    image.src = url;
  }

  retain(games) {
    const ids = new Set(games.map(game => game.id));
    for (const [id, entry] of this.images) {
      if (ids.has(id)) continue;
      entry.image.onload = entry.image.onerror = null;
      this.images.delete(id);
    }
  }
}
