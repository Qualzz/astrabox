# Contributing

ASTRABOX is a small local-first project. Keep changes focused and preserve the
arcade experience: short labels, shared physical input, independent game identities.

1. Use Node.js 22 (22.13 or newer), or 24+, then `npm ci`.
2. Read `AGENTS.md` and `docs/CARTRIDGE_CONTRACT.md` before changing game APIs.
3. Run `npm run check` and `npm test`. Add a regression test for a fixed bug.
4. Test visible changes in a real browser and describe the route, input and result.
5. Keep Pi installation changes in `deploy/raspberry-pi/`; do not require them on desktops.

Browser smoke tests are optional (`npm run test:browser`) and do not replace
playing a game. Don't claim mocks verify native voice or a real Codex generation.
Never commit `.arcade`, authentication files, personal screenshots or generated
user games. Keep asset provenance and third-party licenses intact.

For issues, include OS, Node version, browser, reproduction steps and redacted
diagnostics. Do not include account tokens, full Codex profiles or private conversation logs.
