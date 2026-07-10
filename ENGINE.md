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
- **M4 — integration**: implement the renderer API on the new engine — fog
  plane (existing canvas), picking (ground-plane ray + radius, already
  math-only), instanced props, selection rings.
- **M5 — atmosphere**: water + foam, sky backdrop, day tint, effects pools
  (projectiles, rings, dust, death animations).
- **M6 — swap**: game runs on the in-house engine, Three.js script tag
  deleted, README updated; Three.js path retired with the branch merge.
