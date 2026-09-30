# Articulated robot source

`codex-robot-authored.blend` is the editable source; the runtime loads
`assets/models/codex-robot-authored.glb`. All geometry is procedurally authored
piece by piece in `build_robot.py`; no third-party Meshy geometry is included.

To rebuild using your own Blender installation:

```sh
blender --background --python art/robot/build_robot.py
```

The builder creates a fresh scene and regenerates the Blend, GLB and diagnostic
renders in `output/robot-authored/`. Run it in background, not inside an unsaved
interactive Blender session. Blender is optional for using ASTRABOX.

Rig contract:

- `robot-root` owns the chassis and wheel supports.
- `head-yaw` rotates at the neck; its child `head-pitch` owns the head/glass.
- `wheel-steer-{fl,fr,rl,rr}` turns vertically; child `wheel-spin-*` rolls laterally.
- `robot-screen` has planar UVs and the `arcade_screen` marker for the live display.
- Keep wheel, light strip, glass and shell part names stable for runtime finishing.

The exported model stays under 20,000 triangles and 2 MB; automated tests check
the rig hierarchy and dedicated TV surface. `src/robot-finish.js` supplies the
vintage cream/brown appearance at runtime; the source's blue materials are not
the final displayed color scheme.
