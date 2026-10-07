# README media

The clips and the Wonder still come from the supplied September 9, 2026 four-model arena
recording, `2026-09-09 15-46-31.mp4`: OBS, 1920 x 1080, 60 fps, 2:11:10.
Persia wins by last civilization standing. The transcript helped locate Wonder
attacks; video extracts come from the continuous recording, not reconstructions
or showcases.
The source video, transcript and results are not included in the repo.

## Selected footage

Times are offsets in the source recording, not the simulation clock.

| Asset | Source time | Content |
| --- | --- | --- |
| Arena.mp4 | 1:57:24–1:57:40 | Persian assault destroys an Egyptian Wonder; troops reform |
| Arena.gif | 1:57:29–1:57:39 | Shorter assault, destruction and regrouping cut |
| ArenaPoster.png | 1:57:30 | Wonder assault still |
| Formations.mp4 | 1:59:33–1:59:43 | Persian formation advances through the settlement |
| Formations.gif | 1:59:33–1:59:43 | Shorter formation movement cut |

Clips retain normal recording speed: no synthesized frames, reverse playback or
artificial day/night acceleration. Gameplay speed changes already in the source
are retained. Fixed crops remove peripheral HUD panels: 1140 x 740 at (500, 240)
for the Wonder clips and still; 1340 x 900 at (300, 100) for the formation clip.
No gameplay objects were edited.

MP4s: 924 x 600 (Wonder), 924 x 620 (formation), 30 fps, H.264 CRF 18, slow preset, fast-start, no audio.
GIFs: 768 x 499 (Wonder), 768 x 515 (formation), 250 frames each, uniform 40 ms delays (25 fps), 10 seconds,
looping. Lanczos scaling, per-clip 256-color palettes generated from frame
differences, and ordered Bayer dithering preserve smooth motion at reasonable
file sizes. Linked MP4s retain more color/detail and are smaller downloads.
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

## Interface illustrations

AnalyzeTranscript.png shows the existing Episode 6 sample in the analyzer;
ModelLibrary.png shows connection controls in a clean browser profile.
These interface illustrations were captured in build 819. No private endpoints,
credentials or model-library exports are included.
