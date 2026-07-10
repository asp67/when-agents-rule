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
- **M2 — buildings**: textured builders for all building types with baked AO;
  construction-site state. Includes purpose-built pyramid/prism roof meshes
  (the M0 cone-as-pyramid hack exposed an apex-face bug in the cylinder
  builder for rTop=0 — fix or supersede it here) and a winding audit so
  back-face culling can be switched on.
- **M3 — units**: composed primitives, team-color masking, walk/harvest/attack
  cosmetic animation, health bars (billboards).
- **M4 — integration**: implement the renderer API on the new engine — fog
  plane (existing canvas), picking (ground-plane ray + radius, already
  math-only), instanced props, selection rings.
- **M5 — atmosphere**: water + foam, sky backdrop, day tint, effects pools
  (projectiles, rings, dust, death animations).
- **M6 — swap**: game runs on the in-house engine, Three.js script tag
  deleted, README updated; Three.js path retired with the branch merge.
