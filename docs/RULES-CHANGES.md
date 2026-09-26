# Rules changes

A rules change alters what happens in a match: who wins a fight, how fast an economy grows, or what a model is told. Results from before and after such a change are not comparable. The contract fingerprint recorded in every transcript already separates them, because it hashes the simulation sources and the harness. This page says what changed, and why.

Most entries come from the determinism work: making a match replay exactly from its seed and its commands. Each step changes rules on purpose, and the golden traces in `tests/sim/` are re-recorded with it.

Newest first. The build is the `?v=` number on `js/game.js` in `index.html`.

## Build 935: every random choice is keyed to the match (26 September 2026)

The game's rules make many small random choices, and each one used to call the browser's shared generator:

- where a worker stands at its node or farm;
- where the rule-based AI and the model harness place a building;
- where a trained unit steps out of its building;
- where a scout heads, and where a start worker appears.

With one shared generator, the choices depended on everything drawn before them. One extra command from one model shifted every later choice for every seat, so no two runs of a match could line up.

Each choice is now a keyed draw from `js/simulation/rng.js`: a hash of the match seed, the seat that drew, what the draw is for, and how many draws that seat has made for that purpose. One seat's choices no longer depend on another seat's, and a whole match depends on its map seed and the commands given, nothing else. The spread of every choice is the same as before (uniform, the same ranges). Individual matches take different paths from before, because the values themselves are new.

The map generator and the texture painters each had their own copy of the same generator (mulberry32). Both now use the shared module, and their output is bit-identical: every existing map seed still produces its map.

Seed minting stays random, and so do unit, building and player ids until they are seeded as well (the next determinism step).

Measured on the golden traces:

- **40 v 40 and Wonder siege:** end with the same winner, with one or two units' difference in losses.
- **Opening economy:** a single six-minute run of two rule-based seats takes a different path. By minute six, Persia has trained 13 militia where the old values gave it none, which is the spread one run of a rule-based economy has.
- **Seed independence:** three runs with different leftover randomness now produce bit-identical unit positions. Only the map seed matters.

## Build 934: gameplay timers run on simulated time (26 September 2026)

The match now has one simulation clock, `game.clock`, which counts simulated steps and milliseconds. It runs faster at 2× and stands still on a pause. These timers read it instead of the computer's clock:

- **Auto-defense:** the window after a unit or building is hit (4 s).
- **Repair lock:** the lock after a building is hit (10 s).
- **Battle ledger:** when a fight counts as over (10 s without a blow), and how long it is kept for models to read (2 minutes).
- **Formation charge:** the timer that lets a formation break into a chase.
- **Model state:** the "under attack" window in the state a model receives (6 s).

Before, these ran on real time. So a pause aged them: after a long pause, a building was repairable at once, and a blow struck before the pause no longer drew a defense. At 2× they lasted twice as long in game terms as at 1×. Now a game second is a game second at any speed.

What a model is told stays in **real seconds**: "12s ago", `endedSecondsAgo`, `secondsElapsed` and the `secondsAgo` of a lost building. The clock records how fast simulated time ran against real time, so it converts between the two across speed changes and pauses.

Rule lengths quoted in the prompt ("repairs are locked until 10s after the last hit") are game seconds. At 1× that is the same as real seconds; at 2× the lock lasts 5 real seconds.

Camera, minimap pings and the timeline graph stay on real time; they decide nothing.

At 1× in a visible tab, simulated time and real time run together, and the golden traces did not change. `tests/sim/clock.test.cjs` covers pauses, 2× and the real-seconds conversion.

## Build 933: unit spacing moves into the simulation (26 September 2026)

Separation (units of one owner pushing apart) and building clearance (units pushed out of a building's footprint) decide where units stand, and so who reaches whom in a fight. They ran in the renderer, once per drawn frame, which made the display a rules input:

- **Hidden tab:** a hidden tab draws nothing, so its units did not separate or clear buildings at all while the match ran on in the background.
- **Frame rate:** a slow frame separated less. The push was capped at the strength of one 50 ms frame.
- **Pause:** units kept separating during a pause.

They now run in the simulation step, `js/simulation/position-rules.js`, called from `Game.tick` after every sub-step. The code is moved unchanged.

What changes:

- **Separation and clearance** now:
  - freeze with the world on a pause;
  - run in hidden tabs;
  - have the same strength at any frame rate.
- **Sub-steps:** the simulation's sub-steps are at most **50 ms** (were 100 ms), so no step is longer than the push is scaled for.
- **Model discovery:** what each model has discovered (resource nodes, enemy buildings) is sampled after every sub-step instead of once per frame.
  - A hidden tab ticks four times a second, so a unit grazing a node between two ticks used to leave it undiscovered.
  - This changes what models observe.
- **Contract fingerprint:** the renderer leaves the files the fingerprint hashes as rules (`CORE_FILES`). It no longer decides anything, so a visual change no longer splits comparable results.

Measured on the golden traces at 60 fps, where the old and new code differ least:

- **40 v 40 assault:** unchanged in every count.
- **Wonder siege:** a few hit points differ, and the same units die at the same times.
- **Opening economy:** from minute four, stockpiles differ by a few tens of wood or stone.

The larger effect is in hidden tabs, at low frame rates and during pauses. `tests/sim/position-step.test.cjs` covers those cases.

## Build 919: the rule-based AI loses two self-handicaps (26 September 2026)

- **Attack orders:** it re-issued its attack order to the whole army every 2-second think. Each re-issue reset every unit's swing timer, and a measured 10 v 10 lost about a fifth of its damage to this. Units already attacking the target are now left alone.
- **Clock:** it thought on wall time, so it kept thinking through a pause, and its strength depended on the speed setting. It now thinks on simulated time.

The rule-based AI plays stronger. Campaign opponents and the arena's rule-based seats are harder than in earlier builds.
