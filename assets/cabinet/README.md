# Cabinet overlay

`astrabox-anime-native.png`: 1672 × 941 RGBA, original AI-generated project artwork.
Its CRT aperture is genuinely transparent; there is no CSS/SVG image mask or
opaque checkerboard. The empty right-hand recess hosts the CSS READY tubes.
The amber power switch is painted into the housing.

`src/cabinet.js` places this unchanged PNG over the live scene/game; `src/cabinet.css`
defines the aperture geometry. The canvas-based tests check transparency across
the HUD safe area and the 4:3 display proportions.

To change the bezel, preserve the aperture alignment or update the matching
CSS percentages and tests. Runtime graphics belong behind the overlay, not in the PNG.
