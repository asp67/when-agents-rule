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
