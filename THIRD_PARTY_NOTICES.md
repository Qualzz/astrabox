# Third-party notices

The root MIT license covers original project source, example cartridges, the
procedural robot source/model, original MIDI composition and project display artwork.
The cabinet artwork was generated with an image-generation tool and prepared
with actual alpha transparency; its editable representation is the PNG itself.

## Sound effects

The 24 selected Ogg effects are from **Kenney — Digital Audio**, licensed **CC0**.
See `assets/audio/SOURCES.md`, `assets/audio/catalog.json` and
`assets/audio/kenney-digital/LICENSE.txt` for attribution, hashes and the original notice.
Cartridge-specific credits are kept with each example.

## OpenAI mark

`assets/logos/openai.svg` depicts the OpenAI mark and is used briefly on the
Codex-connected robot display. **The mark is excluded from the project's MIT
license**; OpenAI retains its trademark rights. Inclusion does not imply endorsement,
partnership or a grant of trademark rights. Remove or supply a different `logoUrl`
when distributing a differently branded application. The logo is not required for gameplay.

## Runtime dependencies

Third-party packages are installed by npm, not vendored into this repository:

- Three.js — MIT.
- PixiJS and @pixi/sound — MIT.
- esbuild and es-module-lexer — MIT.
- Playwright — Apache-2.0.
- @openai/codex — Apache-2.0; the native service remains subject to its own account terms.

Their licenses are distributed with the installed packages. Keep those notices
when redistributing a bundled installation.
