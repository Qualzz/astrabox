# Architecture

ASTRABOX has three separate concerns: the application, optional host deployment,
and optional physical controls. None of the core server modules requires Raspberry Pi OS.

## Browser application

The lunar hub assembles independent scene factories from `src/lunar/`. Three.js
owns the menu camera, robot and preview zoom. The cabinet is one alpha PNG overlay
with a small CSS READY panel. It is visual identity, not a dependency on real hardware.

A cartridge is a PixiJS application with its own lifecycle. The selected game loads
in its preview and that same instance expands into the display. While playing, the
hub stops submitting Three.js frames. The embedded cartridge borrows the hub's
input instance so calibrated P1/P2 identity is preserved. See `src/hub-cartridge.js`.

`src/runtime.js` owns arcade state, scores, input, audio and updates. It delegates
visuals to each cartridge. The shared CRT shader is implemented for both renderers.
MIDI is played locally with a small Web Audio synthesizer; there is no external SoundFont.

The V3D rendering profile selects graphics settings from the actual GPU, not a
machine IP or OS name. Other GPUs retain the full profile. Performance on one
device is not a promise of identical frame rates on every device.

## Local server and harness

`server/index.js` serves the application and cartridges, exposes local API endpoints
and streams lifecycle events through SSE. `server/codex-bridge.js` handles the pinned
Codex CLI's JSONL App Server protocol. Authentication stays with Codex on the host.

`server/hub-router.js` supplies context-aware tools to the central assistant:
create a new game, edit an existing game, inspect the catalog or request a screenshot.
`server/workshop.js` owns the worker conversations, preparation directories and publication.
The central assistant and each cartridge worker have separate native thread IDs.
Voice and the text CLI route into this same system.

## Edit lifecycle

1. Codex edits its preparation workspace using the supplied contract and prompts.
2. Static checks validate identity, files, imports and compilation.
3. Publication saves the cartridge and emits `game-updated` immediately.
4. The browser imports the replacement and transfers the current state between ticks.
   Incompatible changes keep the old match running and offer a restart.
5. Browser smoke validation and thumbnail rendering happen afterwards. Their failure
   is reported; it is not disguised by restoring an older published copy.

Revision hashes invalidate imports and thumbnails; they are not archived versions.
Every published edit persists even if the player declines a restart.

## Optional deployment

`deploy/raspberry-pi/` only describes installing the host, signing in and starting
the server as a user service. It does not own the game runtime or duplicate the
server. A normal desktop launch does not execute anything in that directory.

## Local data boundaries

- `cartridges/<id>/`: current published code, configuration and game assets.
- `.arcade/`: private workspaces, thread metadata and thumbnail cache; ignored by Git.
- Browser local storage: control mapping and highscores.
- Codex's own profile: account credentials; never committed or served to the browser.

This is a trusted local development workflow, not a public execution sandbox.
