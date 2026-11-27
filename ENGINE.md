# In-house engine

The game draws with a small engine of its own, **graphics only**, in `js/engine/`.
It replaced a Three.js CDN dependency in September 2026 and was used to restyle the
game toward the classic isometric-RTS look, with enough deviation to stay clearly our
own thing. Nothing is downloaded to draw a frame: the README's dependency-free claim
is literally true.

The first three sections say how the engine is today (checked against the code on
27 November 2026, build 1299). The last is the log of how it was built, kept as it
was written, with a list of what has changed since.

## Art direction

- **Classic RTS camera, narrow-FOV perspective**: 20° FOV with the eye far
  out along the view ray — reads like the dimetric classics but with real
  depth (pure ortho made the far map edge LOOK wider than the near one when
  zoomed out; a gentle perspective kills that illusion). Middle-drag turns
  (yaw, free) and tilts (pitch, 5°–89°; default atan ½ ≈ 26.57°). The
  materials are view-agnostic by construction (vertical AO gradients, light
  that belongs to the world and not to the camera), so the art holds at any
  heading and tilt.
- **Procedural textures, no assets**: all materials are painted into offscreen
  canvases at load (wood grain, mudbrick, stone masonry, thatch, roof tiles,
  terrain splats) and uploaded as GPU textures. No downloads, no copyright
  surface, seeded and theme-aware.
- **Light model**: warm directional sun + cool ambient (hemisphere feel),
  Lambert diffuse over textures. The sun travels through a cosmetic 12-minute
  day and the shadows with it. Grounding comes from **baked ambient occlusion
  painted into textures** (edge darkening, under-eave shade) and from **one
  shadow map** (no cascades; 1024 or 2048 by quality tier, off in the Simple
  lighting style and faded out when the camera is far). The old **blob
  shadows** remain as the Simple and far-view shadow and fade out under the
  real one.
- Units stay composed 3D primitives (small on screen — silhouette, palette
  and team color carry them); buildings and terrain get the texture budget.

## Architecture (plain global scripts, like the rest of the project)

| file | exports (window.*) | responsibility |
|---|---|---|
| js/engine/math3d.js | `M3D` | vec3 ops, column-major mat4 (perspective, ortho, lookAt, TRS, multiply), per-frame scratch matrices |
| js/engine/glcore.js | `GLCore` | context, program compile/link, mesh→buffers, canvas→texture, draw, instancing |
| js/engine/texgen.js | `TexGen` | material painters (canvas 2D). Its random numbers and the coast are the simulation's: it needs `js/simulation/rng.js` (`WarRng`) and `js/simulation/island.js` (`WarIsland`) loaded first |
| js/engine/mesh.js | `EngineMesh` | UV'd primitive builders: plane grid, box, cylinder, roofs, crops (positions/normals/uvs/indices), merging |
| js/engine/buildings.js | `EngineBuildings` | building compositions: parts as {primitive, material, transform} |
| js/engine/units.js | `EngineUnits` | unit compositions (team-color + bone tags) and the cosmetic pose system |
| js/engine/atmosphere.js | `EngineAtmosphere` | the shaders, the day and night, the sun's path, the shadow map's target and camera |
| js/engine/post.js | `EnginePost` | the scaled scene target and what is done to the finished picture (sharpen, tilt-shift) |
| js/engine/bloom.js | `EngineBloom` | bloom, in the Cinematic lighting style |
| js/engine/fx.js | `EngineFx` | fires, rubble, sparks and dust as instanced particles |
| js/engine/grass.js | `EngineGrass` | instanced grass tufts, on the tiers that have grass |
| js/engine/occlusion.js | `EngineOcclusion` | contact shading and worn ground around what stands on it |
| js/engine/perf.js | `EnginePerf` | what a frame costs, and the governor that picks a quality tier |
| js/engine/gamerenderer.js | `EngineRenderer` | the renderer the game talks to: scene, camera, picking, effects, the frame |
| engine-test.html | — | standalone pipeline demo (a village from six engine files and the two simulation files the painters need) + `window.__engineStats` for programmatic verification; `tests/engine-test-page.test.cjs` holds its script list to what it calls |

## The line between game and renderer

The game talks to the renderer through a narrow API (`addUnit`, `addBuilding`,
effects pools, ground picking by a ray from the eye; the minimap is separate
Canvas2D). The renderer moves nothing: where a unit stands is the simulation's, and
the renderer reads it each frame. Fog reaches it as a display canvas
(`js/fog-display.js`) and a `fogDirty` flag it consumes.

The engine was built behind the API of the Three.js renderer it replaced, and a few
stand-ins from that time remain so that game code written against the old shapes
still runs. They are inert, and this is the list `js/engine/gamerenderer.js` points to:

- `renderer` (`domElement`, `setSize`, `setPixelRatio`, `render`), `scene` (`add`,
  `remove`) and `camera` (`position.set`, `lookAt`, `updateProjectionMatrix`): a
  camera intent becomes a look-at target and a zoom.
- Entity handles shaped like the old ones: `mesh.visible`, `mesh.children`,
  `healthBar.material.color.setHex`, `unit.body.material.emissive.setHex`.
- `updateUnitPosition`: still called by the game, and empty.

## How it was built (September 2026)

The milestones as they were written when each was done. Read them as history;
where one says how the engine *is*, the sections above are the ones to trust.
What has changed since is listed after them.

- **M0 — foundation**: math + GL core + texture painters +
  UV'd primitives + locked-camera demo scene, verified end to end.
- **M1 — terrain**: splatted ground (grass/dirt/sand by noise + theme),
  shorelines, resource-node meshes, per-theme palettes.
- **M2 — buildings (done)**: EngineBuildings composes every building type from
  primitives + painted materials (plaster/thatch/rooftile/awning/field with
  baked AO), each grounded by a blended contact-shadow disc; generic
  construction site (plinth, waist walls, scaffold). New purpose-built roof
  and tier meshes (pyramid, gabled prism, rectangular frustum, disc). The
  winding audit (EngineMesh.auditWinding) passes 0-bad across the whole
  library and back-face culling is ON.
- **M3 — units (done)**: EngineUnits composes the roster (worker, infantry,
  ranged, cavalry, priest) from primitives with near-white cloth that a
  uTint uniform multiplies into the player color (team masking). Cosmetic
  pose system: named bones (legs/arms) swing around per-type pivots
  (M3D.rotateAround) for walk/harvest/attack/idle cycles plus body bob;
  weapons share the arm bone so they swing along. Health bars are
  camera-facing quads (M3D.billboard) drawn in the blended pass. Placement
  note: with the locked camera a unit dead-behind a prop is invisible —
  scenes flank, never stack, along the view diagonal.
- **M4 — integration (done)**: EngineRenderer implements GameRenderer's whole
  public surface — entity bookkeeping, embedded sim duties (AI movement lerp,
  separation, building clearance — copied bit-identical; separation and
  clearance have since moved into the simulation step, see
  docs/RULES-CHANGES.md build 933), ortho ground-plane
  picking, screen-space marquee, selection rings, building previews +
  validity, camera intents (position/lookAt map onto dimetric target + ortho
  zoom), health/food bars, projectiles, battle pings, flash-hit tints,
  collapse ghosts. Opt-in via `?engine=1` (game.js constructs EngineRenderer
  instead of GameRenderer); `main`'s Three.js path is untouched. Shim layer:
  `renderer`/`scene`/`camera` stand-ins plus inert THREE-shaped entity
  handles (`mesh.visible`, `healthBar.material.color.setHex`,
  `mesh.children`) let terrain.js / fogofwar.js / game.js run UNMODIFIED —
  fog's never-consumed `fogTexture.needsUpdate` doubles as our dirty bit for
  re-uploading the fog display canvas (NPOT: clamp + no mipmaps, the
  GL_INVALID_OPERATION lesson). Deferred to M5: dust particles, TC name
  banners, priest halos, carried-resource icons, per-age building variants.
- **M5 — atmosphere (done)**: pulsing/drifting shoreline foam strips (new
  uUvOffset + uAlpha shader uniforms; alpha fades now also soften death
  ghosts), pooled billboard dust bursts wired into kills, theme-tinted sun
  and a deep-sea clear color standing in for the sky (the locked ortho
  camera never sees a horizon — the sea IS the backdrop). Deferred M4 polish
  landed: TC name banners (canvas → cached texture per civ), priest halos,
  carried-goods diamonds over workers, pulsing wonder claim rings, and
  early/late material eras for town center, house and tower (timber + thatch
  → plaster + fired tile, gold finial at iron). A fixed noon was a deliberate
  part of the one-angle art direction at the time — superseded later by the
  cosmetic 12-minute day/night cycle (js/engine/atmosphere.js).
- **M6 — swap (done)**: EngineRenderer is the only renderer — the Three.js
  CDN tag, the `?engine=1` opt-in and js/renderer.js (~2200 lines) are gone.
  terrain.js is pure data now (resource layout + walkability + minimap;
  resources carry plain visibility handles from birth); fogofwar.js owns only
  its grid + canvases and raises a `fogDirty` flag the renderer consumes. The
  old instanced ambient-prop scatter (bushes/flowers/snow/pebbles) is baked
  into the terrain mega-texture as painted flecks — same charm, zero draw
  calls. `grep THREE js/` outside js/engine returns nothing; the README's
  dependency-free claim is literally true.

### What has changed since

- **The camera** is not locked and not orthographic: free yaw, pitch from 5° to
  89°, a 20° perspective. Picking is a ray from the eye, zoom is the half-height
  of the frame, and at a low pitch the camera sees a horizon: a sky colour, and
  open water running out to it.
- **The renderer moves nothing** (M4's "embedded sim duties"): all of it is in the
  simulation step.
- **The fog's canvases** moved from `fogofwar.js` to `js/fog-display.js` (build
  1188), which raises `fogDirty`. There is no `fogTexture.needsUpdate`.
- **The scatter is meshes again**: bushes, pebbles, flowers, ground scatter and
  reeds are drawn in chunks, grass as instanced tufts, and the ground texture has
  no painted flecks. Since build 1295 the scatter follows the map's size.
- **Dust** is instanced particles (build 1206), not pooled billboards. **Town
  Center banners** are cached per civilization and seat.
- **The winding audit** still passes for every part but the Maya farm's maize,
  whose blades are two-sided.
- `grep THREE js/` outside js/engine finds one line, a comment in
  `js/openai-ai.js` with the word in capitals.
- **engine-test.html** did not run from 26 September to 27 November 2026 (the
  painters had come to need the simulation's generator and island, which the page
  did not load). It runs again.
