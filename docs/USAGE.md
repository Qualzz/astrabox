# Controls, voice and everyday use

## Input

P1 defaults to arrows, K/L and Enter; P2 to WASD, F/G and Space. C is the
system CODEX button. The controller icon on the hub opens `/controls.html?debug=1`.

Map directions first, then A/B/X/Y/L1/R1/L2/R2, START and CODEX. Missing action
buttons can be skipped. There is no third COIN button: a physical button labelled
COIN can be mapped to START. USB encoder assignments persist per browser origin.
Two identical encoders remain tied to their calibrated slots; recalibrate if the
OS changes their order. Clear or reassign profiles from the mapping screen if needed.

In menus A confirms and B returns. In gameplay they are ordinary game actions.
START P2 requests a join according to the cartridge's rules. Holding START P1 or
P2 for three seconds exits; the shrinking yellow indicator shows the remaining time.

## Voice

Press CODEX in the hub to focus the robot, then A or START to talk. During a game,
CODEX opens voice with that game's context and a second press stops the conversation.
Moving and playing remain available. Talk and pause; there is no audio send button.

The robot screen uses measured microphone input and received audio: a waveform
when listening and a deforming yellow shape when speaking. A flat line means silence.
The work animation and READY panel follow harness events, not just whether the
microphone is open. READY's fill duration is illustrative, not exact progress.

Allow the microphone for **localhost** when the browser asks. Audio may need a
click or keypress before the browser allows playback. If the input is flat, check
the chosen device and browser/OS permissions. Stop and reopen CODEX if a connection
fails; `npm run doctor` checks the local transport without starting a generation.

## Text and Remote

Use `scripts/arcade.mjs` or the text field at `/?debug=1`. Voice is optional for
both creation and editing. See [REMOTE.md](REMOTE.md) for CLI waits, timeouts and context.

## What survives a restart

Published games and edits stay in `cartridges/`. Workspaces and conversation IDs
stay in `.arcade/`. Highscores and mappings stay in the same browser's storage.
A live match is not a savegame for the next day; compatible edits preserve it
in memory while the application is open.

## Screens and HUD

The cabinet aperture is filled, not letterboxed. The game uses logical coordinates
and its HUD safe area to keep text away from the rounded CRT edges. Keep this
contract when adding games rather than modifying collisions to accommodate the frame.
