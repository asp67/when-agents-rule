# In-house engine (branch `engine`)

Goal: replace the Three.js CDN dependency with a small engine of our own —
**graphics only** — and use the switch to restyle the game toward the classic
isometric-RTS look ("original Age of Empires charm"), with enough deviation to
stay clearly our own thing. When this branch lands, the README's
dependency-free claim becomes literally true.

## Art direction

- **Locked dimetric camera**: orthographic projection, yaw 45°, pitch
  ≈ 26.57° (atan ½ — the classic 2:1 pixel diamond). Pan + zoom, no rotation.
  One fixed view angle means lighting, texture contrast and silhouettes are
  tuned for exactly one perspective, like the pre-rendered classics.
- **Procedural textures, no assets**: all materials are painted into offscreen
  canvases at load (wood grain, mudbrick, stone masonry, thatch, roof tiles,
  terrain splats) and uploaded as GPU textures. No downloads, no copyright
  surface, seeded and theme-aware.
- **Light model**: warm directional sun + cool ambient (hemisphere feel),
  Lambert diffuse over textures. Grounding comes from **baked ambient
  occlusion painted into textures** (edge darkening, under-eave shade) plus
  cheap **blob shadows**; a single ortho shadow map may come later (the fixed
  camera makes one tight frustum enough — no cascades).
- Units stay composed 3D primitives (small on screen — silhouette, palette
  and team color carry them); buildings and terrain get the texture budget.

## Architecture (plain global scripts, like the rest of the project)

| file | exports (window.*) | responsibility |
|---|---|---|
| js/engine/math3d.js | `M3D` | vec3 ops, column-major mat4 (ortho, lookAt, TRS, multiply) |
| js/engine/glcore.js | `GLCore` | context, program compile/link, mesh→buffers, canvas→texture, draw |
| js/engine/texgen.js | `TexGen` | seeded rng/value-noise + material painters (canvas 2D) |
| js/engine/mesh.js | `EngineMesh` | UV'd primitive builders: plane grid, box, cylinder (positions/normals/uvs/indices) |
| js/engine/buildings.js | `EngineBuildings` | building compositions: parts as {primitive, material, transform} |
| js/engine/units.js | `EngineUnits` | unit compositions (team-color + bone tags) and the cosmetic pose system |
| js/engine/gamerenderer.js | `EngineRenderer` | GameRenderer's full public surface on the new pipeline (M4) |
| engine-test.html | — | standalone pipeline demo + `window.__engineStats` for programmatic verification |

## Migration contract

The game talks to the renderer through a narrow API (`addUnit`, `addBuilding`,
`updateUnitPosition`, effects pools, fog canvas texture, ground-plane picking,
minimap is separate Canvas2D). That API is the freeze line: the new engine is
built behind it, `main` stays on Three.js until the swap milestone.

## Milestones

- **M0 — foundation (this commit)**: math + GL core + texture painters +
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
  separation, building clearance — copied bit-identical), ortho ground-plane
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
  → plaster + fired tile, gold finial at iron). A fixed noon is a deliberate
  part of the one-angle art direction — no day tint cycle.
- **M6 — swap (done)**: EngineRenderer is the only renderer — the Three.js
  CDN tag, the `?engine=1` opt-in and js/renderer.js (~2200 lines) are gone.
  terrain.js is pure data now (resource layout + walkability + minimap;
  resources carry plain visibility handles from birth); fogofwar.js owns only
  its grid + canvases and raises a `fogDirty` flag the renderer consumes. The
  old instanced ambient-prop scatter (bushes/flowers/snow/pebbles) is baked
  into the terrain mega-texture as painted flecks — same charm, zero draw
  calls. `grep THREE js/` outside js/engine returns nothing; the README's
  dependency-free claim is literally true.
