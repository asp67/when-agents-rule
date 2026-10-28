# README media

The Arena clips and the Wonder still come from the supplied September 9, 2026 four-model arena
recording, `2026-09-09 15-46-31.mp4`: OBS, 1920 x 1080, 60 fps, 2:11:10.
Persia wins by last civilization standing. The transcript helped locate Wonder
attacks. The Formations clips come from Episode 18's recording,
`2026-10-18 20-19-00.mp4` (OBS, 1920 x 1080, 60 fps, 48:52), whose storybook dates the
town-center kill. All video extracts come from continuous recordings, not
reconstructions or showcases.
The source videos, transcripts and results are not included in the repo.

## Selected footage

Times are offsets in the source recording, not the simulation clock.

| Asset | Source time | Content |
| --- | --- | --- |
| Arena.mp4 | 1:57:24–1:57:40 | Persian assault destroys an Egyptian Wonder; troops reform |
| Arena.gif | 1:57:29–1:57:39 | Shorter assault, destruction and regrouping cut |
| ArenaPoster.png | 1:57:30 | Wonder assault still |
| Formations.mp4 | Episode 18, 0:31:09.5–0:31:19.5 | At night, DeepSeek V4.1's 19-unit Yamato army burns down Qwen3.8's Maya town center (match clock 31:10, the match's first kill); armies clash on the ruins |
| Formations.gif | Episode 18, 0:31:09.5–0:31:19.5 | The same cut as a GIF |

Formations replaced a September clip on 21 October 2026: that one showed the same
Persian army in the same settlement two minutes after the Arena clip.

Clips retain normal recording speed: no synthesized frames, reverse playback or
artificial day/night acceleration. Gameplay speed changes already in the source
are retained. Fixed crops remove peripheral HUD panels: 1140 x 740 at (500, 240)
for the Wonder clips and still; 924 x 620 at (598, 250) for the Formations clip, unscaled.
No gameplay objects were edited.

MP4s: 924 x 600 (Wonder), 924 x 620 (Formations), 30 fps, H.264 CRF 18, slow preset, fast-start, no audio.
GIFs: 768 x 499 (Wonder), 768 x 515 (Formations), 250 frames each, uniform 40 ms delays (25 fps), 10 seconds,
looping. Lanczos scaling and per-clip palettes generated from frame differences.
The Wonder GIF uses 256 colors with ordered Bayer dithering. The night-time Formations
GIF uses 128 colors, no dithering and a light temporal denoise (hqdn3d 2:2:14:14),
because the dark grass's compression noise changed every frame and made the GIF
38 MB; it is now 11.8 MB. Linked MP4s retain more color/detail and are smaller downloads.
Source compression and any original recording frame-pacing issues remain.

## Episode stills

Three stills from later episodes replaced the September settlement, formation and
village stills on 7 October 2026. Each is an unchanged full frame (1920 x 1080) of
the episode's OBS recording; the matches themselves are in `samples/`.

| Asset | Source | Content |
| --- | --- | --- |
| WinterTown.jpg | Episode 9, OBS 0:50:14 | GLM 5.3's Egyptian town in a winter match, with its notes |
| ArcherRaid.jpg | Episode 10, OBS 0:25:42 | DeepSeek V4.1's Yamato archers raze GLM 5.3's Egyptian base |
| WonderHeld.jpg | Episode 12, OBS 0:34:34 | The whole island while Claude Sonnet 5.5's Greeks hold a Wonder |

## Rules illustrations

Two Windows screenshots of the game window during live arena matches, saved as JPEG
(quality 86) from the original PNGs, otherwise unchanged.

| Asset | Source | Content |
| --- | --- | --- |
| TowerCreep.jpg | Screenshot, 23 October 2026, 16:53 (1833 x 744) | Qwen3.8's Greek tower chain reaching DeepSeek V4.1's Egyptian town (build 1109) |
| Trebuchet.jpg | Screenshot, 25 October 2026, 21:43 (1096 x 647) | Qwen3.8's Vikings escort their trebuchet across the map (build 1110 test match) |

## Interface illustrations

AnalyzeTranscript.png shows the existing Episode 6 sample in the analyzer;
ModelLibrary.png shows connection controls in a clean browser profile.
These interface illustrations were captured in build 819. No private endpoints,
credentials or model-library exports are included.

## Agent harnesses and watching modes (build 1139)

Captured on 28 October 2026 in headless Chromium against a local copy of the game, with
a fresh browser profile and no credentials. No gameplay objects were edited.

| Asset | Content |
| --- | --- |
| McpLibrary.png | An MCP entry in the model library (Hermes Agent), down to step 1 of its manual setup. The download lines show the public site, as a visitor sees them. |
| McpAssistant.png | The setup assistant at step 3: a harness has reached a local test hub and is named. |
| McpArenaSeats.png | The arena setup: one MCP seat joined (green), one waiting for its harness, two rule-based seats, and the start note below. |
| AnalyzeMode.jpg / BroadcastMode.jpg | The same moment of a five-minute match, with and without the operator's panels. The four seats are stand-ins: a scripted endpoint answering with ordinary tool calls and reasons, under invented model names. They show the interface, not any model's play. |
