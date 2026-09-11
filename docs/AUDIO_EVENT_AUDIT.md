# Sound event audit — build 852

Build 853 implements the approved mix/priority/fairness changes and selected missing cues. See AUDIO_PROTOTYPE.md for the current behavior. The findings below describe the audited build 852.

## Findings

The reported sounds are implemented and connected. Their audibility is not assured: the current mix puts continuous wind above work and completion cues, distance attenuates them heavily, and the shared voice budget can discard them. This is a source and synthesized-signal audit, not a listening measurement of the user's speakers or a recording of the reported match.

### Existing coverage

| Event | Current sound | Trigger / limitation |
| --- | --- | --- |
| Walking | Footsteps / snow footsteps | Actual position change and walking flag; up to four nearby groups per scan |
| Cavalry movement | Hoofbeats | Same movement scan |
| Ranged attack | Bow release | Arrow projectile spawn; crossbows share the bow sound |
| Melee or projectile hit on unit | Shared muffled impact | Combat notification; clubs, spears and swords do not have separate samples |
| Hit on building | Dull impact | Combat notification |
| Chopping | Filtered woody texture | Worker actively harvesting wood |
| Food gathering / farming | Rustle | Active node harvest or farm harvest timer |
| Stone / gold mining | Dull tapping | Active node harvest; shared sample |
| Construction / repairs | Muffled hammer | Worker at the site with isBuilding set; not walking or fighting |
| Building completed | Two-note cue | completeConstruction, after completion; duplicate completion calls are ignored |
| Unit trained | Short two-note cue | Successful unit creation in production update |
| Research completed | Rising cue | Timed research completion, human and AI |
| Age advanced | Research cue | Timed age completion, human and AI; no distinct age cue |
| Wonder completed | Building-completed cue | Generic construction hook; no distinct wonder cue |
| Wind | Continuous seasonal texture | Active scene; zoom changes volume |
| Campfire | Continuous texture plus crackles | Nearest visible rendered campfire |

### Missing cues

These are missing sound hooks or distinct sound identities, not a recommendation to sonify every event.

| Event family | Missing coverage | Suggested priority |
| --- | --- | --- |
| Death and destruction | Unit death; building collapse; wonder destruction; deliberate demolition/deletion | High for combat deaths and collapse; distinct wonder destruction is useful |
| Healing | Priest healing/channel activity and completion | Medium; grouped, sparse and soft, never every simulation tick |
| Tower combat | Tower projectile launch (stone projectiles have no launch cue); impacts already sound | Medium |
| Important match events | Match start; seat elimination; victory/defeat/draw; wonder victory countdown/warning | High for outcome and wonder warning; sparse elsewhere |
| Player commands | Selection; accepted move/attack/guard/formation orders; invalid orders | Medium, optional UI feedback rather than voices |
| Economy transitions | Resource delivery; node exhaustion; repair completed | Medium for exhaustion; low for delivery and repair completion |
| Production beginnings | Construction placement/start; research start; training start; age advancement start | Low, optional player feedback; avoid notifying every AI action |
| Tactical alerts | First enemy contact; own settlement under attack; resource/capacity warnings | Medium, rate-limited and only information the player is entitled to know |
| Pause and controls | Pause/resume/speed changes and formation selection | Low; lightweight UI feedback if desired |
| Environmental sound | Water/shore, vegetation movement, wildlife, torch/lantern fire | Optional atmospheric additions; not gameplay event failures |
| Distinct identities | Crossbow versus bow; weapon-specific melee; age versus research; wonder versus ordinary building | Optional refinement; currently shared cues, not wholly silent events |

## Why sounds can be hard to hear

1. **Mix imbalance.** Measured synthesized buffer RMS with current default gain multipliers, camera centred, summer wind, and no distance attenuation: wind about -47 dBFS; chopping -59; food gathering -58; mining -60; construction -63; building/research/training completion about -57. These are estimated pre-output signal levels (one deterministic variant, before live wind filtering/compression), not perceived loudness. They identify a roughly 10–16 dB imbalance, with continuous wind competing against short cues. Headphones/speakers and ambient room noise affect actual audibility.
2. **Strong distance attenuation.** Gain falls with the square of distance remaining to the hearing boundary. At half the radius another 12 dB is lost; zooming out reduces gain again. The radius never exceeds 150 world units. A building can be on screen but acoustically almost absent.
3. **Completion events are spatial too.** A player's research is not a global notification: it plays at the nearest visible building belonging to that civilization. Training and construction play at their building. Off-camera or sufficiently distant completions are silent. Research placement is a presentation approximation, not necessarily its actual research host.
4. **Shared admission limit.** All short sounds share 14 voices and 20 starts per real second. Completion cues have no priority over footsteps or combat. A rejected cue is discarded, with no retry. The same completion type in the same 14-unit cell also has a one-second cooldown.
5. **Worker scan competition.** Only the three strongest worker groups are attempted per 160 ms scan. A nearer group can occupy that shortlist even while its sound is on cooldown; quieter groups are not used as replacements. This can starve a nearby activity type of sound.
6. **Work sounds require actual work.** Idle showcase workers, walking workers, carriers and exhausted resources are intentionally silent. “Inspect workers” only moves the camera; it does not start harvesting/building. Brief work intervals can also occur between audio scans at accelerated game speed; that is a possible sampling limitation, not a reproduced match failure.
7. **Mute and scene gates.** Samples now respect Mute. Pause, hidden tab, inactive game screen and replay suppress sound. There is no backlog when audio resumes. These are intentional. Ambience controls work sounds; Effects controls completion cues; saved slider levels may independently make either category quiet.

## Recommended next pass

1. Rebalance wind and fire beneath the activity layer; retain rounded envelopes and muffled timbre. Calibrate work cues by measured energy and a listening pass instead of raising every sound indiscriminately.
2. Give completion cues a small reserved budget and duck ambience briefly beneath them. Keep simultaneous completions coalesced rather than playing a cascade of chimes.
3. Separate player notifications from spatial world sounds: own research/training/building completions should remain quietly audible off camera. Spectator notifications need a distinct policy (currently viewed seat, or rate-limited all-seat cues); do not expose hidden enemy actions to a player.
4. Fill worker sound slots with groups eligible to play now, with fair rotation between nearby activity types. Keep the existing workload and voice limits.
5. Add a small developer diagnostic that records attempts and suppression reasons: mute, inactive scene, visibility, distance, cooldown, global budget. This will distinguish missing events from a quiet mix during user tests.
6. Add death/collapse and match outcome/wonder alerts first, then healing and tower launches. Outcome cues need a UI audio path: the current world audio gate closes when the match ends.

No gameplay or sound settings were changed during this audit.
