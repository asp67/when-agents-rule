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
