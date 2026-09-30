# Release verification — 2026-09-30

These notes describe this clean release tree, not historical prototype sessions.

## Installation and source checks

- Fresh `npm ci` completed successfully on macOS ARM64 (Node 25.8.0).
- `npm run check`: all source syntax, undefined identifiers, browser entry-point
  import graphs and four cartridge manifests passed.
- `npm test`: 267 passed, 6 optional Chromium tests skipped, no failures.
- `npm audit --omit=dev`: no reported vulnerabilities at verification time.
- Real CLI `list` against the running local server returned the four release examples.
- No personal host paths, private network settings, credentials or conversation IDs
  were copied into the release source. Local runtime data is ignored by Git.

## Native Codex diagnostics

`npm run doctor` started the pinned App Server and confirmed authentication and
availability of the configured model through the real `account/read` and
`model/list` endpoints. It closed the diagnostic process afterwards.
This did **not** start a generation, spend a coding turn, open a microphone or
establish that every native voice scenario works.

## Refactor comparison

The original scene and extracted factories were instantiated with the same
Three.js version. Hashes of geometry attributes, instanced transforms/colors,
hierarchies, transforms and material/shader settings matched for the sky dome,
star field, Milky Way, Earth, lunar terrain, rocks, Sun and robot platform.
This is a structural comparison, not a claim of pixel-identical output on every GPU.

## Real browser interaction

The release ran at a separate localhost port in the existing in-app browser.
Native accessibility/keyboard interactions were used; no Playwright browser was
launched for these screenshots. Captures show the actual application, not mockups.

- Main menu and CRT/cabinet overlay rendered with the authored robot.
- Selecting and launching Meteor through its thumbnail opened its embedded runtime.
- START P2 joined Meteor and switched Pong to a two-player match.
- A launched Tiny Stack; a subsequent action placed a block, visible in its score.
- A launched Quiet Breakout and served its ball into the playfield.
- CODEX focused the robot without opening the microphone; pressing it again returned
  to selection. Escape returned from cartridges to the same hub.

Screenshots: [menu](screenshots/menu.jpg), [Meteor 2P](screenshots/game.jpg),
[robot](screenshots/robot.jpg), [Tiny Stack](screenshots/tiny-stack.jpg),
[Quiet Breakout](screenshots/breakout.jpg).

The first browser pass exposed an omitted constant after the scene split and
an existing unbound-fetch MIDI bug. Both were fixed; undefined-name linting and
a MIDI receiver regression now cover these failures.

## Not claimed

- The six optional headless browser smoke tests were not rerun in this preparation.
- No fresh end-to-end voice generation or full creation/edit turn was executed.
- Physical joysticks, microphone, speakers and this release's Pi installer were
  not tested on hardware during this pass.
- Windows, hosted deployment and hostile generated code are not validated.
- Short desktop interactions do not establish gameplay balance or universal frame rates.

The initial public commit passed [GitHub CI on macOS and Linux with Node 22](https://github.com/Qualzz/astrabox/actions/runs/36777772197).
Optional browser smoke tests can be run
manually using `npm run test:browser` or the workflow's explicit browser option.
