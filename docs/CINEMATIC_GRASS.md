# Cinematic grass

Select **Cinematic** under **Camera and graphics → Graphics**. Short grass tufts
appear in close views, become sparser at wider zoom, and disappear at camera
half-height 160, with the base layer's zoom fade starting at 90. The extra dense
layers still fade out by half-height 55. Balanced and Low do not render or retain grass buffers.

Grass is purely decorative. Overlapping clumps vary up to 0.58 world units, with
smooth world-space changes in height and shorter grass toward drier areas.
The same moisture field used to paint the terrain controls density: thick green
patches, thin transitions, no grass on dry soil. Blades sample the ground color
texture directly, with a small root-to-tip variation. Desert and winter retain
much sparser coverage. Placement avoids resource clearances and measured building
footprints plus a border for entrances. Resource clearings are circular, with radii
of 1.05 for trees and 1.8 for other nodes (half the previous width). Depletion or
removal restores grass; construction invalidates affected patches.
Two world-space sine waves move the tips; roots stay fixed. All wind animation
runs in the vertex shader. Grass receives scene shadows but casts none.

Both grass and older decorative props remain visible on explored terrain (fog states 1 and 2), like resource nodes.
Whole hidden grass patches are culled on the CPU, with decisions cached until the
fog revision changes. Partially visible patches use a nearest-filtered visibility
mask in the fragment shader, preventing blades leaking through the boundary.
Older decorations are excluded before the shadow and main passes unless their
whole clearance is explored. Only unexplored ground hides decorative clutter.

## Rendering limits

- 16-unit tiles with three independent layers of at most 1,024 tufts each, keeping
  every buffer within WebGL 1's 16-bit index range. Extra layers favor the greenest
  ground and fade out with distance and zoom; half-height 55 retains only the base layer.
- Six double-sided triangular blades per tuft: twelve triangles, no transparency.
- At most 108 visible tiles (324 draw batches) and 216 cached tiles.
- At most one tile / three mesh uploads per frame after camera travel.
- Zoom and distance reduce the drawn tuft count and blade height.
- Buffers are released on eviction, terrain replacement and leaving Cinematic.

`game.renderer.grassStats` exposes patches, tufts, triangles, uploads and CPU
assembly time for the current frame. CPU time is not GPU render time.

## Validation, build 787

Geometry/placement tests verify deterministic scattering, theme density,
WebGL 1 index bounds, clearances, upload/draw/cache limits, buffer disposal and
construction invalidation, dry soil exclusion, low blade height, ground-aligned UVs,
fog revision changes and zero hidden-patch uploads. Run `node --test tests/*.test.cjs`.

A local headless Chrome run on the NVIDIA RTX 5080 rendered the Greek showcase
at 1440×1000, close zoom: 52,471 tufts, 40 tiles / 120 batches, 629,652 triangles.
Triple-density, base-layer-only and grass-off comparisons retained identical
Cinematic shadow settings. All conditions had median frame intervals around
6.9 ms and 95th percentiles around 7.1 ms. Grass CPU assembly had a 95th percentile
of 0.3 ms after warm-up. No JavaScript errors occurred. The build 786 forced hidden-fog test
produced zero grass batches, uploads or decoration draws. A partial-fog screenshot
with the fog overlay removed verified that grass itself stops at the boundary.

These are frame-pacing observations in a showcase, not isolated GPU timings or
a worst-case battle benchmark. The display cadence can hide small GPU costs.
Slower GPUs and large battles still need live play testing.

## Pebble ground cover (build 794)

Cinematic adds irregular charcoal/brown pebble patches on dry summer ground and
in the desert. Stones are 0.035–0.10 world units high and roughly 0.11–0.28 wide;
they are decorative, never resources or obstacles. Winter retains its existing cover.
Pebbles occupy base-layer tuft slots (12 triangles each), keeping the same batch,
upload, cache and distance budgets. They have no wind motion or shadow-map draws.
They share explored-terrain masking, building clearances and circular resource
clearings, and regenerate when resources disappear.

A mipmapped gravel mask in the existing ground-detail texture adds fine surface
texture beneath the geometry and remains after the close-up meshes fade out.
No additional texture sampler or draw call is used. Grass statistics now count
both grass tufts and pebble instances in the existing tuft/triangle totals.

Build 796 extends the clutter radius from 100 to 150 world units and the distance
fade to 52.5 units. The cache retains up to 216 tiles. The nearest 108 admitted
tiles render, with a fade at the budget boundary to avoid hard tile swaps during
follow shots. Culling has a wider margin to prepare tiles before they enter view.
The upload limit remains one tile (three meshes) per frame.
