# Measuring frame time

Two instruments, both switched on from the address bar. Neither changes what a match does.

## The live readout: `?perf=1`

Open the game with `?perf=1` added to the address and a small panel appears at the bottom
of the page, over whatever is on screen: a live match, the analyzer, a replay.

```
frame  16.7 ms   p95 18.2   p99 33.4   max 51.0   60 fps
build  4.1 ms   GPU 6.3 ms   2431 draws   412k tris
slow   3 of 600 over 33 ms
High   1920x1080
```

| Line | What it says |
|---|---|
| frame | Time from one frame to the next over the last 600 frames: the median, the slowest 5 % and 1 %, the worst one, and the frame rate the median stands for. |
| build | Time the page spends building and submitting one frame. `GPU` is what the graphics card reports for it, where the browser allows the question (`n/a` otherwise). Then draw calls and triangles of the last frame. |
| slow | Frames that took longer than 33 ms, the line below which a picture stops looking smooth. A gap of more than a second counts as a stall (the tab was away), not as a slow frame. |
| last | Graphics tier and the size of the picture being drawn. |

The strip under the text is the last 300 frames, one column each, with lines at 16.7 ms and
33 ms. A display that refreshes 60 times a second shows 16.7 ms however little a frame
costs, so the readout says whether the picture is smooth, not how much room is left. The
benchmark answers that.

## The benchmark: `?perf=bench`

Open the game with `?perf=bench`. It takes the page for half a minute to a few minutes,
depending on the machine, and ends with a table.

It draws the same frames everywhere: one late-game moment of a shipped match (157 units,
72 buildings, every forest standing), at 1920x1080 whatever the window is, along a fixed
path of five shots, once for each graphics tier and once more with Cinematic light. Every
frame is timed from the first call that builds it until the graphics card has finished it,
so the number is what a frame costs. 16.7 ms is the budget for 60 frames a second, 33 ms
for 30.

```
ms per frame                mean  median    p95    p99    fps  build    GPU  draws    tris  vs last
Low                         4.04    2.40   9.90  10.70    247   0.50   0.51    627    298k   +0.9 %
Balanced                    4.89    5.00  10.00  10.90    205   0.60   1.56   1179    593k   +3.7 %
High                       10.87   10.20  19.81  22.30     92   2.60   4.84   1860   1349k   -1.6 %
```

`vs last` compares the mean with the previous run on the same machine and appears from the
second run on. `Save report` writes everything, including the cost of each shot, to a JSON
file named after the build.

For numbers worth comparing:

- Close other things that use the graphics card, and plug a laptop in.
- Keep the window in front until the table appears.
- Run it twice. Two runs on a quiet machine should agree within about 5 %.

To run it on another computer on your network, start the server with
`node serve.cjs --host 0.0.0.0` and open `http://<this computer's address>:8088/?perf=bench`
there.

## What the look steps cost (builds 1174 to 1176)

Light and colour, contact shading and lived-in ground (overhaul steps A1 to A3) were built
before the office machines had been measured. On the development machine (RTX 5080, the
card 96 % busy with other work, so the absolute numbers are high and only the comparison
counts), build 1173 against build 1177, three runs each, taken in turn with the tab in front:

| ms per frame, mean of three runs | build 1173 | build 1177 | |
| --- | --- | --- | --- |
| Low | 4.19 | 4.58 | +9 % |
| Balanced | 5.03 | 5.40 | +7 % |
| High | 11.65 | 11.77 | +1 % |

The time the page spends building a frame did not change (0.5, 0.6 and 2.6 ms); the
difference is the graphics card's. Draw calls and triangles are the same in both builds.
On Low about half of it was the broad variation of the ground, six sines on every piece
of ground: build 1178 leaves that out on Low and came to 4.45 against 4.24 in two further
runs taken in turn, +5 %. The rest is the new light sum.

Two things this taught about measuring. A run taken while the tab is not in front, or
while something else is running on the machine, is worthless: the first run of build 1177
was taken in a background tab during a test run and came out 40 to 68 % slower than the
run before it. And a difference is only a difference between runs taken in turn on the
same machine in the same minutes.

What these steps cost on an office machine has not been measured.

## The draw-call diet (overhaul step A4)

A draw call costs the page time whatever it draws, and on an office machine the page's
time is the scarce one. Where the calls go, counted in the benchmark's scene on High
(the shadow pass draws every solid thing a second time and is not in these numbers):

| shot | solid | see-through | of the solid: buildings | units | grass |
| --- | --- | --- | --- | --- | --- |
| overview, the whole map | 1881 | 893 | 1385 (72 buildings, 19 each) | 598 (157 units, 4 each: the far model) | 0 |
| town | 769 | 195 | 345 (23, 15 each) | 94 (5 units, 19 each) | 3 |
| close-up | 426 | 123 | 253 (19, 13 each) | 62 (3, 21 each) | 17 |
| night town | 1103 | 213 | 403 (20, 20 each) | 281 (15, 19 each) | 302 |

So a building is some fifteen to twenty calls and a unit some nineteen, each twice where
shadows are cast; at the whole-map zoom every building is still drawn part by part.

**Step 1, build 1179: WebGL 2 and vertex array objects.** The context is WebGL 2 where the
browser has it, WebGL 1 otherwise (and with `?webgl=1`, to compare or to get around a
driver). The shaders are the same. A mesh is now pointed at once per program and
remembered in a vertex array object, so a draw is three calls to the card instead of
some ten. On the development machine the page's time building a frame went from about
2.6 to about 2.3 ms on High and stayed at half a millisecond on Low and Balanced, which
is inside what two runs differ by there: that machine's processor is not the one this is
for. Draw calls and triangles are unchanged. What it buys on an office machine has not
been measured.

**Step 2, build 1180: buildings.** A shadow has no material, so a building now casts as
one merged shape instead of once per material batch (six to eight draws each before). Its
dressing (jars, fences, lamps, a hearth) is merged per material and cached with the model
like the building itself, and is left out, with the worn patch before the door, from the
height where units become their far models and it is smaller than a pixel; the lamps and
hearths still light the night from there. The benchmark, build 1173 against build 1180,
two runs each taken in turn, the card quiet this time:

| | draw calls, median | | ms per frame, mean | | |
| --- | --- | --- | --- | --- | --- |
| | 1173 | 1180 | 1173 | 1180 | |
| Low | 627 | 627 | 1.94 | 1.88 | -3 % |
| Balanced | 1179 | 1092 | 2.24 | 2.24 | 0 % |
| High | 1860 | 1571 | 6.54 | 5.95 | -9 % |
| High, Cinematic light | 1866 | 1577 | 6.39 | 5.57 | -13 % |

That is the whole of steps A1 to A4 so far against the build before them: the look steps
and the diet together leave Low and Balanced where they were and make High faster. The
page's time building a frame went from 0.4, 0.5 and 1.8 ms to 0.3, 0.4 and 1.6.

**Step 3, build 1182: units.** A unit was a draw per material and bone, sixteen to twenty
of them and up to thirty-six on horseback, so that an arm could swing, and each again in
the shadow pass. Now every vertex carries the number of the bone it hangs on and the
shader moves it: a unit is a draw per material, nine to fourteen, and its shadow is one
draw. Nothing about how a unit looks or moves changes; the far model, the death pose and
the trebuchet's arm go the same way.

The benchmark's own shots have few units close by, so a view with an army in it was
measured as well: the benchmark's scene with three more of every unit beside it (628
units), the camera where they stand thickest, High, 150 frames each, build 1173 against
build 1182:

| | draw calls a frame | | ms a frame, median | | |
| --- | --- | --- | --- | --- | --- |
| | 1173 | 1182 | 1173 | 1182 | |
| 200 units in view (half-height 45) | 9516 | 4328 | 14.4 | 8.1 | -44 % |
| 256 units in view (half-height 90) | 11954 | 5503 | 17.3 | 9.9 | -43 % |

And the benchmark itself, one run each taken in turn: draw calls on Low 627 to 565, on
Balanced 1179 to 875, on High 1860 to 1321; a frame on High 6.88 to 6.16 ms.

The plan's target was under 900 draw calls with 400 units in view. This is not there: a
unit is still about eleven calls with its shadow, because each of its materials has its
own texture. Getting further means one texture for a unit's plain materials at the
distances where their grain cannot be seen (the far model already does this from the
whole-map height), which changes how units look at middle distance and so is a step to
look at, not only to measure.

**Step 4, builds 1183 and 1184: one shared texture at middle distance.** From a
camera half-height of 30 up (`EngineRenderer.MID_UNIT_HALF_H`), a unit's plain materials
(skin, hair, leather, iron, wood) can be drawn as one mesh that reads each part's average
colour from the palette texture, with the bones kept: a unit is then four or five draws
instead of eleven. It was built switched off (`renderer.unitPalette`) in build 1183, shown to asp67 as
side-by-side stills at half-heights 35, 60 and 100, and switched on in build 1184. The same army view as above, own textures
against the shared one, two runs each taken in turn on build 1183:

| | draw calls a frame | | ms a frame, median | | |
| --- | --- | --- | --- | --- | --- |
| | own | shared | own | shared | |
| 200 units in view (half-height 45) | 4330 | 3129 | 8.1 | 5.5 | -33 % |
| 256 units in view (half-height 90) | 5503 | 3855 | 10.1 | 6.7 | -34 % |

With it, 200 units are about a thousand of those calls; the other two thousand are the
town around them, which is where the diet would have to go on.

**Step 5, build 1185: the town.** A count of what the other two thousand calls were named
three things, and each was cut where nothing can be seen of the cut:

- *A worker's lantern* was six or seven draws and two more for its shadow, at every
  camera height, the whole-map view included: with a hundred workers at night, about nine
  hundred draws for something a hand's breadth wide. Up close it is drawn as it was. From
  the middle distance (`MID_UNIT_HALF_H`, where a unit shares one texture) its iron frame
  and its flame are drawn and it casts no shadow of its own. From where units are their
  far models (`FAR_UNIT_HALF_H`) only its light is drawn, the glow on the ground and
  around the flame, which is what is seen of it from there.
- *A building's dressing* (carts, jars, benches) was merged per tint in step 2, and each
  of those batches was drawn again for its shadow. It now casts as one shape, like the
  building, and only while it is drawn solid.
- *A forest chunk* was drawn into the shadow map once per material, five or so a chunk.
  Every solid part is now also in the chunk's one caster; a felled or fogged tree is
  collapsed in both.

A caster is made with `GLCore.createShadowBuffers`: positions, bones where there are any,
and indices. The shadow's program reads nothing else, so casters no longer hold normals
and texture coordinates on the card.

The army view again (628 units, High, night, so the lanterns count), build 1184 against
build 1185, two runs of 1185:

| | draw calls a frame | | ms a frame, median | | |
| --- | --- | --- | --- | --- | --- |
| | 1184 | 1185 | 1184 | 1185 | |
| 200 units in view (half-height 45) | 3129 | 2650 | 5.5 | 4.8 | -13 % |
| 256 units in view (half-height 90) | 3855 | 3120 | 6.7 | 6.0 | -10 % |

Against build 1173, before the diet, the same views were 9516 and 11954 calls and 14.4
and 17.3 ms: a third of the calls and a third of the time. The benchmark on build 1185,
one run: draw calls on Low 463, on Balanced 660, on High 1066 (build 1173: 627, 1179,
1860); a frame 1.92, 2.09 and 5.98 ms, High with Cinematic light 5.63.

Still not the plan's 900 calls with 400 units in view. What is left in a town is the
props (a draw and a shadow draw each), a building's pole and runner, and the units
themselves at four or five draws; and the frame still allocates its matrices anew.
