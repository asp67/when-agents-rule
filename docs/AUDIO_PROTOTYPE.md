# Optional game audio — build 896

WAR generates its sound palette locally in `js/audio.js` using Web Audio. It includes no imported recordings, music, voices or Microsoft audio assets.

## Controls and coverage

Open the speaker below the minimap and uncheck **Mute**. A page reload starts muted. The mute choice carries across internal menu/showcase navigation; master, ambience and effects levels are remembered locally. Explore civilizations includes individual sound auditions.

- Seasonal wind and crackling campfires provide ambience.
- Infantry and horses have grass, snow/sand and gravel footsteps. At 2x and 4x game speed, cadence increases to 1.5x and 2x without changing pitch.
- Working units produce chopping, harvesting, mining and construction sounds.
- Combat distinguishes bows, crossbows, sword clashes, other impacts, building collapse and soft healing. Towers sound once per volley.
- Accepted commands use a small bell; attack and harvest use a slightly higher version of the movement bell.
- Building, training, research and age completions use short procedural horn signals with echo. Match start, elimination, defeat and victory have distinct fanfares. Start alternates short/long notes (long is 25% longer); victory uses long/short/short/long, low/low/low/high.
- Wonder completion and countdown warnings are audible. Unit deaths, resource delivery/exhaustion and repair completion intentionally have no separate cue.

## Visibility and playback

World sounds respect visibility, camera distance, mute, pause and hidden tabs. Non-positional announcements and command feedback do not fade with camera distance. Own completion notifications can sound off camera; spectator completion signals require visible nearby activity. Limits, cooldowns and shared group sounds prevent event backlogs. There are two ambience loops, up to 12 world-effect voices and two reserved notification voices.

Spectator horn events that actually play can show a localized bottom caption for three seconds, then fade for one second. New events replace it. Muted or suppressed signals do not create captions. English, German, Spanish and Chinese are supported.

Audio does not consume gameplay randomness or change simulation state. Transcript snapshots do not generate inferred combat audio. Showcase auditions are samples, not simulated actions.

## Validation and listening

Automated checks cover finite bounded waveforms, timing, cadence, visibility, voice limits, notification priority, completion hooks and mute behavior. User listening passes tune the sound; automated checks do not establish subjective quality or replace long-match performance testing.

For debugging, `game.sound.diagnostics` reports played and suppressed attempts without credentials or transcript content. `AUDIO_EVENT_AUDIT.md` preserves the historical build-852 audit, not the current feature inventory.
