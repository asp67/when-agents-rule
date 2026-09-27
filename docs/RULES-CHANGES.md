# Rules changes

A rules change alters what happens in a match: who wins a fight, how fast an economy grows, or what a model is told. Results from before and after such a change are not comparable. The contract fingerprint recorded in every transcript already separates them, because it hashes the simulation sources and the harness. This page says what changed, and why.

Most entries come from the determinism work: making a match replay exactly from its seed and its commands. Each step changes rules on purpose, and the golden traces in `tests/sim/` are re-recorded with it.

Newest first. The build is the `?v=` number on `js/game.js` in `index.html`.

## Build 959: tale of the tape and the live seat-health strip (27 September 2026)

No change in what happens in a match or what a model is told.

- **The tale of the tape:** the analyzer's **🥊 Tale of the tape** puts the seats side by side:
  - model, civilization, provider and server;
  - context, token cap, temperature, reasoning, lanes, tool fallback and an own system prompt;
  - turns, rounds missed, advice received, spectator pauses and each kind of harness adaptation, counted from the transcript's notes;
  - the result.

  A row appears only when some seat has something in it. A file from before the notes existed shows none.
- **The seat-health strip:** in the arena, each model's leaderboard card shows its recent answer time, command success, missed rounds, endpoint errors, context overflows and silence over a minute. A paused seat's silence is not shown. The numbers come from the same function the results screen uses (`seatMetrics`), and each appears only once it happened.
- **Moment links:** `turn=` now counts a seat's turns, not the markers filed beside them.

## Build 958: moment links and chapters (27 September 2026)

No change in what happens in a match or what a model is told.

- **Moment links:** `?match=<id>&t=1:04:30&seat=2&turn=17` opens a published sample in the analyzer at that moment. It shows the seat's view (seats count from 1), that seat's n-th turn, or the last record at or before the time. In a seat's view that is the seat's own record, never a rival's later one. The time reads h:mm:ss, m:ss or seconds.
- **Copy link:** the analyzer's **🔗 Copy link** makes such a link for the moment on screen. It is offered only for a published sample, because only those open anywhere else. The link is a plain query string, so it works on a plain-http LAN host too.
- **Copy chapters:** **📋 Copy chapters** copies the analyzer's chapters in YouTube's format. The first chapter is at 0:00 and each is at least 10 s after the last, all shifted by the video offset you give.

## Build 957: broadcast mode and captions for recordings (27 September 2026)

No change in what happens in a match or what a model is told.

- **Broadcast mode:** the **📺** button in the arena, left with Esc. It hides the operator's controls: the decision log, leaderboard, advice, tempo and the inspect card. In their place:
  - a scoreboard with every seat's age, army, workers and buildings;
  - an **advised ×n** badge on any seat a spectator's advice reached;
  - the chronicle as lower-third captions;
  - a held Wonder as a large countdown in its seat's colour.
- **Decisive moments:** a brief band of light, at most one every third of a second, and none when the viewer's system asks for reduced motion.
- **Captions for recordings:** the results screen offers the chronicle as WebVTT captions (**🎬 Captions (.vtt)**), timed on the wall clock (which a video runs on) and shifted by the recording's own offset.

## Build 956: the intent layer (27 September 2026)

No change in what happens in a match or what a model is told. In the arena, the **🎯 Intent** button (on by default, remembered) draws each model's newest orders over the 3-D view. It reads the turn logs only.

- **Arrows** run from the units an order moves to what it targets. A target is resolved exactly:
  - an entity id, to that entity;
  - a map tile, to its centre;
  - coordinates, to that point.

  The units come from the ids the model named, or, when it named none, from the whole army, as the tool defines it.
- **Markers:** a target whose units the harness chooses (an explore with no unit named) gets a marker without an arrow. A target that does not resolve gets nothing: no arrow is ever guessed.
- **Refused orders** are drawn as refused, grey and crossed out, as soon as the harness has answered.
- **Reasons:** each seat's reason is shown beside its order, verbatim up to 160 characters, one bubble per seat. Turns that land together, as in a turn-based round, are staggered 0.6 s apart.
- **Leaderboard:** each model's card now shows its current objective.

## Build 955: the match chronicle and captions (27 September 2026)

No change in what happens in a match or what a model is told. The chronicle (`js/chronicle.js`) only reads the match, and a test checks that a match with it and a match without it reach the same world.

It tells the match from the game's own records:
- two seats meeting;
- fighting breaking out, and how each fight ended per side;
- a building, Town Center or Wonder lost, and to whom;
- a new age;
- a Wonder raised and its last 120, 60, 30 and 10 seconds;
- an elimination;
- speed and pauses.

Every entry goes into the transcript as a `chronicle` line. The analyzer keeps these lines apart from the turns.

In the arena, notable entries appear as captions under the status bar, one at a time. The new **CC** button turns them off, and the choice is remembered. Captions no longer depend on sound. Sound captions stay for what you hear, except eliminations and Wonder warnings, which the chronicle now tells.

## Build 954: the re-simulated replay in the analyzer (27 September 2026)

No change in what happens in a match or what a model is told.

- **Re-simulate:** the analyzer offers a **Re-simulate** chip for a transcript with inputs (build 952 on). It plays the match again from its inputs through the real rules, in a worker, and checks every recorded world hash on the way. The stage shows the observer's view, unfogged, with play, pause, speed and a time slider. Seeking back rebuilds from the start. It ends with "Certified: all N recorded world hashes reached" or names the time and step where the world stopped being the recorded one.
- **When it is offered:** only when the rules (`coreHash`) and the harness (`harnessHash`) this page runs are the ones in the transcript's contract. The worker hashes the very texts it runs. Otherwise the chip is disabled: "Rules changed since recording: snapshot mode only."
- **One core:** `js/resim.js` is shared by the worker and by `tools/bench/transcript-replay.cjs`.
- **The analyzer's map:** the analyzer rebuilds a match's map from its seed, and it placed the spawns at 85 % of the half-size where the arena uses 85 % of (half-size − 40). Stone and gold are laid out around the spawns, so the analyzer drew them where no match had them: in the seven shipped samples, up to 11 of 31 known stone and gold nodes had no place on its map. It now uses the arena's own spawns, and all known nodes of all seven samples land on it. The replay found this, since its world's nodes did not all land on the analyzer's map.

## Build 953: input lines stay out of the analyzer's rows (27 September 2026)

Build 952's input lines have a type, and the analyzer listed every typed line as a marker row: hundreds of them a match. They are now kept apart for the re-simulation.

## Build 952: transcripts record their inputs (27 September 2026)

No change in what happens in a match or what a model is told. An arena transcript now also records every input that changes the world, each stamped with the simulation step it happened at and a short hash of the world right after it:

- **observe:** a seat was shown the board. This carries the seat's turn counter, which decides which scout an `explore` sends.
- **batch:** a seat's answer ran. This carries the whole envelope, the commands, objective and plan as parsed.
- **speed:** the tempo changed.
- **demote:** a seat fell back to the rule-based player.

`node tools/bench/transcript-replay.cjs <transcript.jsonl>` rebuilds the match from its header (map seed, difficulty, seats and anchor styles). It applies the inputs in order and checks each recorded hash. A match that reaches them all is certified: the rules produce the recorded world from the recorded inputs alone. Otherwise it names the step where the replay diverged. Transcripts from before this build have no inputs and say so. Multi-lane seats are not yet covered.

## Build 950: the match clock models read works again (27 September 2026)

From build 934 to build 949, every model was told `clock.matchSeconds: 0` on every turn. Build 934's single simulation clock measured the state's clock from the simulation's start while subtracting the timeline's wall-clock origin. Those are two different clocks, and the difference was always clamped to 0. One recorded match (build 945) shows 314 turns out of 314 at 0 seconds.

- **The fix:** the state now reads the match clock in real seconds. It stops while the game is paused and stands still in lockstep while the seats think.
- **Results:** matches from builds 934–949 were played with a broken match clock. Models could still see other time fields (`secondsRemaining`, round deadlines, ages of events), but not how long the match had run.
- **The analyzer:** it placed turns by this clock, so it stacked all the turns of those transcripts at 0 seconds. It now recognises such a file (every turn at 0, while the turns' own time stamps span more than a few seconds) and places the turns by their stamps from the match start instead. Healthy files are unchanged.

Found while building WAR Bench: a baseline's state read `matchSeconds: 0` after 20 simulated seconds.

## Build 949: strict seats for WAR Bench (27 September 2026)

No change for arena seats. A seat can now be marked strict (`controller._strict`), which WAR Bench's runner does. A strict seat gets no second chances: a refused request parameter is not adapted and retried, a rate limit is not retried, and a context overflow does not shrink the next request. A benchmark scores the request it declared, not one the harness repaired, so each of these is a failed round.

## Build 948: scenario prompts (27 September 2026)

No change in what an arena model is told: the default system prompt is byte-identical. Its victory paragraph is now a named constant, so a WAR Bench scenario (`war-scenario-v1`) can replace exactly that paragraph with its objective and leave everything else as it is (`OpenAIAIManager.scenarioSystemPrompt`).

## Build 947: one request builder (27 September 2026)

No change in what a model is sent. The request for a seat's turn is now built by one function, `buildTurnRequest`, which reads the seat and the state and changes nothing. The arena sends exactly what it builds, and WAR Bench will call the same function, so a bench request is the request the arena would have sent. `tests/bench-request.test.cjs` compares the two, byte for byte, over four turns with a growing history, an objective and a plan, and spectator advice. The harness fingerprint changes only because the file changed.

## Build 946: lockstep, an option of turn-based play (27 September 2026)

Turn-based play gives every model the same number of moves. The world still ran on while a round waited for the slowest answer, though, so a model that thought for two minutes acted on a board two minutes old. Lockstep closes that gap. It is set per match under the turn-based setting (**World time per round**: off, or 1, 2, 5, 10 or 20 seconds).

- **While models think:** the world stands still, and so does the match clock. Thinking time is no time in the game.
- **When all moves are in:** they run together, as in turn-based play. Then the world plays exactly one slice of simulated time, a whole number of 50 ms steps, and stops for the next round.
- **Every round spans the same world time,** however long the models take. It is the precise form of slowing a match down. The tempo buttons then only set how fast a slice plays on screen.
- **What models are told:** the state's clock carries `worldSecondsPerRound` in lockstep matches.
- **What the record says:** the header records `lockstepSliceMs`, and the contract's protocol becomes `turn-based-lockstep-<ms>ms`. A lockstep match is never compared with plain turn-based play, nor with a different slice.
- **When it applies:** lockstep needs a model seat to hold a round for, so an all-rule-based match simply runs. When every model seat is paused or defeated, the world plays on, slice after slice.

With lockstep off, nothing changes: the golden traces are untouched. `tests/sim/lockstep.test.cjs` drives the real round machinery with seats that answer after a set delay. It checks that the world never moves while a round waits, and that round *k* is asked and executed at exactly (*k* − 1) × slice of world time. It also checks that a seat answering in half a second and one answering in twenty get the same world time per round.

## Build 945: a rejected purchase says what it is short of (27 September 2026)

A model is now told what it lacks. "Cannot afford" for a unit, a building, a tech or an age-up now names the shortfall and what the seat holds, counted after the earlier commands of the same turn. For example: `Cannot afford tech "armor" - short of 30 stone, 105 gold (you have 75 stone, 0 gold after this turn's earlier commands).` Before, it said only "Cannot afford".

The trigger was a match in which GLM-5.3, playing Yamato, built a temple and researched Sword Armor (`armor`) in the same turn, paying for both from the same stone and gold. The temple was paid for first. The tech was rejected with a bare "Cannot afford", and the model asked for it again over four more turns. This changes what models are told, so the harness fingerprint changes. The rules of the game do not.

## Build 944: the rule-based army finds its rivals (27 September 2026)

When the rule-based AI has no enemy in sight, it sends its army out in search legs. Calibrating the anchor styles showed that these legs never reached anyone. In 48 matches of 45 minutes between rule-based seats, no seat was eliminated, and every army ended with all of its soldiers alive. There were three faults:

- **Legs cut short:** a leg was abandoned after 12 thinks (24 s). An army walks about 85 units in that time, so no longer leg was ever finished. The army turned round short of every far target and stayed within about 120 units of home. A leg is now abandoned only when the army has not got closer for about 12 s.
- **Legs too short:** leg length was capped at half the map, measured from the army's own base. In a two-seat match the rival base is about 612 units away, so no leg could reach it.
- **Blind search:** with 15-unit sight, a sweep that ignored where the army had already been could cross the map for half an hour without passing a base. A leg now heads for the least-explored tile of the same 7×7 exploration summary the models are shown (nearest first), so the army searches with no more than a model knows. A tile the army gave up on (unreachable) is not chosen again. The old sweep remains as the fallback when there is no summary.

Measured:

- **Search:** an 8-soldier army on the arena's two-seat spawns now sees the rival town centre after about 10 minutes. With the old rules it never does (`tests/sim/anchors.test.cjs`).
- **Matches:** between rule-based seats, 83 of 96 matches now end by elimination, at a median of 24 minutes. The styles' calibration is in [ANCHORS.md](ANCHORS.md).
- **Golden trace:** the opening-economy trace changes from its 5.5-minute checkpoint, when the first army marches.

The rule-based AI now attacks where it used to wander. Campaign opponents and the arena's rule-based seats are much harder than in earlier builds.

## Build 943: anchor styles for the rule-based AI (27 September 2026)

The rule-based AI can now play in four named styles, chosen per seat in the arena setup (**Style**, under a rule-based seat's control):

- **Standard:** the classic rule-based AI, exactly as before. Its numbers moved into a table (`AI_PROFILES` in `js/ai.js`) without changing any of them. A 25-minute two-seat match and a four-seat match reproduce the previous build's state at every minute.
- **Turtle:** a larger economy and up to three towers. It raises an army of 20, then saves for the next age before spending more on soldiers or towers, and attacks with 20 or more.
- **Legion:** trains the unit class that beats the army it has seen most of (infantry beats cavalry, cavalry beats ranged, ranged beats infantry). It knows only what its own units and buildings have seen, and it attacks with 12.
- **Raider:** thinks every second instead of every two. It has fewer workers, trains soldiers early, attacks with 4, and goes for enemy workers it can see before anything else.

The styles are anchors: fixed opponents to measure models against. They are not part of the model contract, and a rules change can move any of them. So the contract line in each transcript lists rule-based seats under `anchors`, each keyed to the core hash it ran under and marked `contractIdentical: false`. Their order is decided by calibration (`tools/anchor-calibration.cjs`: seat-swapped pairs on the same maps), not by their names.

Two behaviour changes come with this:

- **Think timing:** each rule-based seat now keeps its own think timer, starting from zero. There used to be one timer for all rule-based seats, and it lived as long as the page.
- **Rematch:** the rule-based AI's 250 ms discovery timer now resets at every match start. Before this, a Rematch (and any second match in the same page) started both timers where the last match left them, so it was not the match it repeats. It now is: `tests/sim/anchors.test.cjs` plays a match and its Rematch in one page and compares them to a match in a fresh page.

## Build 941: a fixed simulation step (27 September 2026)

The simulation used to advance by however much time had passed since the last drawn frame, cut into sub-steps of up to 50 ms. So the sequence of steps, and with it every result, depended on the frame rate. It now advances in fixed 50 ms steps (`Game.stepOnce`). Frames only add real time to an accumulator, and the remainder carries to the next frame. Everything that decides the game runs inside a step:

- the rule-based brain;
- the simulation;
- unit spacing;
- model discovery;
- the shore clamp;
- the battle ledger;
- the win check.

What this changes:

- **Frame rate:** a match reaches exactly the same state at any frame rate, and in a hidden tab. Tested at 16, 25, 50, 125 and 250 ms frames.
- **Frozen-step driver:** `Game.advanceSim(ms)` runs the same steps with no clock at all, while the world waits for model turns. It reaches the same state as a framed run. It is the base for a lockstep arena mode and for the benchmark runner.
- **Timers:** every periodic timer is a whole number of 50 ms steps, so none of them loses a remainder any more. Those losses cost about 1% of attack and harvest rates at 60 fps. Periodic timers now carry their remainder anyway, so a future period that is not a multiple still keeps time. (The affected timers are attack 1 s, tower 1.5 s, defense 0.6 s, target acquisition 0.15 s, discovery 0.25 s and the AI's think 2 s.)
- **Browser and server:** the Platform's headless server already steps by 50 ms, so the two now run identical step sequences.
- **Drawing:** the world updates twenty times a second, and frames are drawn between the last two steps, so movement stays smooth at any display rate. This is presentation only. The analyzer, which shows recorded positions, is never smoothed.

Measured on the golden traces:

- **Fights:** end with the same winners, one or two units apart in losses.
- **Opening economy:** Greece ends identical, while Persia takes a different path, as a single rule-based run does when its timing shifts.

## Build 937: portable math (27 September 2026)

Rule code measures distances and angles with `Math.hypot`, `Math.sin`, `Math.cos` and `Math.atan2`. The language fixes `+ − × ÷` and `sqrt` to the last bit, but leaves these functions to each engine. Engines differ, and so do builds of the same engine: on 27 September 2026, Chrome 152 differed from Node 24 (both V8) in the last bit for 2–18% of `sin`, `cos` and `atan2` inputs. In a simulation, one last-bit difference in a distance can decide which unit reaches a target first, and from there a fight. So a match in the browser and the same match on a Node server could not stay identical, and neither could a transcript replayed in another browser.

Rule code now uses `js/simulation/math.js`. It is built from the exact operations only and follows the routines Node's V8 uses: fdlibm for `sin`, `cos` and `atan2`, and V8's own `hypot`. The effects:

- **In Node on x64:** results are bit-identical to before. A million sampled inputs per function match, and the golden traces pass unchanged.
- **Across machines:** the same Node 24.14.1 on ARM64 (the Platform server) differs from x64 in the last bit for about 0.5% of `sin`, `cos` and `atan2` inputs. `WarMath` gives the same bits on both, checked with one pinned fingerprint of 480,000 outputs.
- **In a browser:** the results are now Node's. In Chrome 152 that changes `sin`, `cos` and `atan2` in the last bit for a few percent of inputs.
- **Maps:** a map seed produces the same map in Chrome and in Node, checked bit for bit on three seeds.

The texture painters keep `Math`; they only paint. A test rejects the other functions in rule files.

## Build 936: ids are seeded (26 September 2026)

Unit, building and player ids come from the match's keyed draws: a prefix and eleven base-36 characters (`unit_01b9tq47n3o`). They used to be `unit_<milliseconds>_<random>`.

- **Repeatable:** the same match now produces the same ids. The same seed gave identical ids in a browser and in Node.
- **No clock:** the milliseconds in an old id told any model reading an enemy's id exactly when that unit was trained. A counter would have been repeatable too, but it would have told a model how many units a seat had made. So the new id carries neither.
- **Shorter:** 16–20 characters instead of 26–32 for every enemy unit and building in a model's state.

Ids are labels and decide nothing. The golden traces have identical counts at every checkpoint, and their whole state, ids aside, is identical over six minutes of play. What changes for a model is the text of the ids it reads and copies back.

With this step, a match makes no `Math.random` call from its start to its end. A test counts the calls, and it also compares the full state, ids included, across different leftover randomness.

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
