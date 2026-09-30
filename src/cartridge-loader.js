import { GAME_CATALOG } from "./game-catalog.js";

const SAFE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
function validateManifest(manifest) {
  if (!SAFE_ID.test(manifest.id) || manifest.entry !== "game.js" || ![1, 2].includes(manifest.maxPlayers)) {
    throw new Error("Manifeste de cartouche invalide.");
  }
  return manifest;
}

export async function loadCatalog() {
  try {
    const response = await fetch("/api/games", { cache: "no-store" });
    if (!response.ok) throw new Error("Catalogue indisponible");
    const result = await response.json();
    if (!Array.isArray(result.games) || !result.games.length) throw new Error("Catalogue vide");
    return result.games.map(validateManifest);
  } catch (error) {
    console.warn("Catalogue local de secours :", error.message);
    return GAME_CATALOG.map((game) => ({ ...game, entry: "game.js", revision: "local" }));
  }
}

export async function loadCartridge(manifest, { revision = manifest.revision ?? "local" } = {}) {
  validateManifest(manifest);
  const query = `?v=${encodeURIComponent(revision)}`;
  let response = await fetch(`/api/games/${manifest.id}/config${query}`, { cache: "no-store" });
  if (!response.ok) response = await fetch(`/cartridges/${manifest.id}/config.json${query}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`Configuration indisponible : ${manifest.id}`);
  const config = await response.json();
  // A path namespace also invalidates relative module imports. It is an alias to
  // the current published files, not an archive of previous versions.
  const moduleUrl = revision === "local"
    ? `/cartridges/${manifest.id}/${manifest.entry}${query}`
    : `/cartridges/${manifest.id}/@${encodeURIComponent(revision)}/${manifest.entry}`;
  const module = await import(moduleUrl);
  if (typeof module.default !== "function") throw new Error("La cartouche doit exporter createGame par défaut.");
  const game = module.default();
  for (const name of ["configure", "mount", "start", "update", "captureState", "restoreState", "renderAttract", "renderGameOver"]) {
    if (typeof game[name] !== "function") throw new Error(`Contrat cartouche : ${name}() manquant.`);
  }
  if (!Number.isInteger(game.stateVersion) || game.stateVersion < 1) throw new Error("Contrat cartouche : stateVersion invalide.");
  // The executable owns its state schema; stale optional manifest metadata must
  // never hide a migration requirement.
  Object.assign(game, manifest, { stateVersion: game.stateVersion, revision, config });
  return game;
}

export async function loadPublishedCartridge(gameId, revision) {
  const manifests = await loadCatalog();
  const manifest = manifests.find((entry) => entry.id === gameId);
  if (!manifest) throw new Error(`Cartouche introuvable : ${gameId}`);
  return loadCartridge(manifest, { revision: revision ?? manifest.revision });
}
