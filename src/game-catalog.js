export const GAME_CATALOG = Object.freeze([
  Object.freeze({
    id: "meteor-dodge",
    title: "METEOR DODGE",
    description: "Survive the storm. P2 can join instantly.",
    maxPlayers: 2,
    screenshot: "/assets/screenshots/meteor-dodge.png",
    accent: "#ff9f68",
  }),
  Object.freeze({
    id: "line-pong",
    title: "LINE PONG",
    description: "P2 interrupts solo play and starts versus.",
    maxPlayers: 2,
    screenshot: "/assets/screenshots/line-pong.png",
    accent: "#52e6d0",
  }),
  Object.freeze({
    id: "quiet-breakout",
    title: "QUIET BREAKOUT",
    description: "A deliberately solo cartridge.",
    maxPlayers: 1,
    screenshot: "/assets/screenshots/quiet-breakout.png",
    accent: "#ffd166",
  }),
]);

export const GAME_CATALOG_BY_ID = Object.freeze(
  Object.fromEntries(GAME_CATALOG.map((game) => [game.id, game])),
);
