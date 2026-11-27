# Grass and ground cover

This file was written in September 2026 for a grass that only the highest tier drew,
one mesh a tile. It was rewritten on 27 November 2026 (build 1299) from the code as
it is: `js/engine/grass.js`, and the draw in `js/engine/gamerenderer.js`. Its name is
from the time the tier was called Cinematic; that tier is **High** today, and
"Cinematic" is now a lighting style that has nothing to do with grass.

## Who has grass

**Camera and graphics → Graphics** offers Auto, High, Balanced and Low.

| tier | grass | reach | tiles drawn at most | of a tile's tufts | layers | pebbles |
|---|---|---|---|---|---|---|
| High | yes | 150 world units | 108 | all | up to 3 | yes |
| Balanced (since build 1202) | yes | 110 | 60 | half | 1 | no |
| Low | none | | | | | |

Short tufts appear in close views, become sparser at wider zoom, and disappear at
camera half-height 160; the first layer's zoom fade starts at 90, and the denser
layers are gone by half-height 55. Changing the tier releases the grass buffers
(each tier sows its own), as does a new map.

## What it is

Grass is purely decorative. Overlapping clumps vary up to 0.58 world units, with
smooth world-space changes in height and shorter grass toward drier areas.
The same moisture field used to paint the terrain controls density: thick green
patches, thin transitions, no grass on dry soil. Blades sample the ground color
texture directly, with a small root-to-tip variation. Desert and winter retain
much sparser coverage. Placement avoids resource clearances and measured building
footprints plus a border for entrances. Resource clearings are circular, with radii
of 1.05 for trees and 1.8 for other nodes. Depletion or removal restores grass;
construction invalidates affected patches.

Two world-space sine waves move the tips; roots stay fixed. Since build 1203
travelling gusts also lean the grass with the wind and pale it as they pass (not with
reduced motion). All wind animation runs in the vertex shader. Grass receives scene
shadows but casts none.

Grass and the other ground clutter are drawn on explored ground. Explored is any fog
value above 0: the live game has the values 1 and 2, and the transcript analyzer
writes the fraction of a map square a seat uncovered (build 1231). What stands at
the shore is drawn though unexplored (build 1211). Whole hidden tiles are culled on
the CPU, with decisions cached until the fog revision changes. Partially visible
tiles use a nearest-filtered visibility mask in the fragment shader, so that blades
do not leak through the boundary.

## How it is drawn

- **Instanced (build 1202).** There is one tuft on the graphics card: six
  double-sided triangular blades, twelve triangles, no transparency. A 16-unit tile
  is a list of where its tufts stand, four numbers a tuft, and all three layers of a
  tile are one list, the denser ones after the first. How much of it is drawn is how
  far into the list the draw goes: **one draw a tile**. Until build 1202 a tile was a
  mesh of its own, 1.2 MB a layer and up to three draws, and only the highest tier
  could afford it.
- **Up to 1,024 tufts a layer.** The denser layers favor the greenest ground and are
  built only when the camera is close enough to draw them.
- **216 tiles cached.** The nearest tiles within the tier's limit are drawn, with a
  fade at the edge of the budget so that tiles do not swap hard during follow shots.
  The distance fade is 52.5 units on High and 38.5 on Balanced.
- **Built on a time budget (build 1007)**, not one tile a frame: 4 ms a frame, 8 ms
  right after a camera cut while more than 24 tiles are missing, and always at least
  one layer. A new tile grows in over 350 ms.
- Zoom and distance reduce the drawn tuft count and blade height.

`game.renderer.grassStats` gives, for the current frame, `patches` (tiles), `batches`
(draws), `tufts`, `triangles`, `uploaded` and `cpuMs`, the time of putting the frame's
grass together. `tufts` counts tufts; pebbles add to the triangles and the draws.
CPU time is not GPU render time.

## Pebbles (build 794, High only)

Irregular pebble patches lie on dry ground: charcoal and brown in the desert, grey
elsewhere. Winter keeps the cover it had. A pebble is 0.11–0.28 world units wide and
about 0.03–0.09 high; they are decorative, never resources or obstacles. Every
pebble is one mesh, turned and scaled. A tile's pebbles are a list and a draw of
their own, drawn only close up: below camera half-height 60, and only in the near
band. They have no wind motion and cast no shadows. They share explored-ground
masking, building clearances and circular resource clearings, and come back when a
resource disappears.

A mipmapped gravel mask in the ground-detail texture adds fine surface texture
beneath the geometry and remains after the close-up meshes fade out.

## Tests and measurements

`tests/grass.test.cjs` holds the scattering to its seed, the density by theme, the
clearances, the limits on draws, uploads and the cache, the release of buffers, the
invalidation on construction, dry soil staying bare, blade height, ground-aligned
UVs, fog revisions and that a hidden tile uploads nothing. Run
`node --test tests/*.test.cjs`.

What the grass costs is in [PERFORMANCE.md](PERFORMANCE.md), "Instanced grass". The
figures this file used to carry (build 787: 52,471 tufts in 40 tiles and 120 draws,
frame intervals around 6.9 ms on an RTX 5080) were of the renderer that drew a mesh
a tile; the same view is 40 tuft draws today, plus the pebbles'.
