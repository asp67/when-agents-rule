# Rules changes

A rules change alters what happens in a match: who wins a fight, how fast an economy grows, or what a model is told. Results from before and after such a change are not comparable. The contract fingerprint recorded in every transcript already separates them, because it hashes the simulation sources and the harness. This page says what changed, and why.

Most entries come from the determinism work: making a match replay exactly from its seed and its commands. Each step changes rules on purpose, and the golden traces in `tests/sim/` are re-recorded with it.

Newest first. The build is the `?v=` number on `js/game.js` in `index.html`.

## Build 1054: producing needs a free population slot (4 October 2026)

**Rules change (elimination); `game.js` changed.**
- **What happened:** GLM had lost every building but an archery range. It had the bank for archers and not one population slot to train one, and the elimination check kept it in the match: "a finished building that can produce such a unit and pay for one now". The check never looked at the cap.
- **Now:** a trainer or a Town Center keeps a seat in only if it has room to train.
- **Without room,** a seat is in only if it can climb back:
  - a worker who can found a Town Center;
  - a worker who can build a house the seat may build (its tech researched);
  - a Town Center site to finish.
- **A seat with nothing but a trainer and a full bank is out.**
- **Unchanged:** any fighting unit, or a unit already in training, still keeps a seat in.

## Build 1053: a defeated seat leaves the board (4 October 2026)

**Rules change; `game.js` changed.** asp67's decision, as in Age of Empires.
- **Before:** elimination set a flag and nothing else. In the 4 October match, Yamato was out at 85 minutes and still stood on the map at 193 with ten buildings and three units. They were listed in GLM's state and could be attacked, and the defeated seats' workers kept fighting under a standing order.
- **Now:** at the step a seat is found eliminated, everything it still has is removed, with the usual death and collapse effects, and marked dead so whatever was targeting it lets go.
- **Quiet:** no battle losses, no lost-building notes and no Town Center handling are written. Nothing here was destroyed by anyone.
- **Other seats** forget the defeated seat's buildings, as they already forgot its units.
- **Only matches with three or more seats are affected.** With two, the first elimination ends the match.

## Build 1052: workers under orders, razed buildings, and a cache-friendly history (4 October 2026)

**Rules and harness change; the rules hash moves.** Three issues asp67 found in a 197-minute, four-seat match (4 October, 02:12).

**Workers under a standing order picked fights:**
- **What happened:** Greek workers attacked Egyptian and Yamato workers nobody had touched, and went on doing it after Greece was eliminated at 56.7 minutes.
- **Measured in the replay:** every one of them was under a `hold` order space-bunny had given before its elimination, still standing. Standing orders pick targets for every member with an attack, workers included, and a worker under an order was exempt from the self-defense rule that otherwise governs it.
- **Now:** a worker under any order never picks a fight. It answers only the unit that has hit it in the last 4 s, within its usual 30, and otherwise keeps its slot. That is the 1 October rule ("a worker fights only for itself"), now under orders too.

**A Town Center remembered standing after the seat's own army razed it:**
- **What happened:** GLM razed Persia's Town Center at (-170, 310) at 179 minutes and moved on before its next turn. Its state listed that Town Center as standing, at 100%, for ten minutes. At 189 minutes GLM attacked it by id, mistaking it for the new one Persia had built at (150, 330), and was told it "died in the seconds between the state you read and this command".
- **Now:**
  - a building destroyed by the seat's own units is forgotten, as units already were;
  - an attack by id on a building the seat only remembered, that has since fallen, is told so ("you remembered it, out of sight, and it has fallen since you last saw it"), not that it died while the model thought.

**Turns took about 100 s instead of about 18 once the history was full:**
- **What happened:** GLM's prompt reached the context budget (110k tokens) at minute 58. From that turn on, every turn took about 100 s, for the rest of the match.
- **The cause:** the rolling history took the newest turns that fit, so once full it dropped the oldest on every turn. The conversation's first message changed every turn, and the server's prefix cache could reuse nothing.
- **Now:** the window's start stays put while the history fits. When it overflows, the start jumps forward once, leaving 60% of the budget (`HISTORY_REFILL`): one full recompute per jump. For GLM's match that is about every 85 turns, instead of every turn.
- **The cost:** the model sees on average about 80% of the budget as history instead of 100%.

**Not changed here:** a defeated seat's units and buildings still stood in the world (elimination only set a flag). Build 1053 removes them.

## Build 1051: two more refusals carry their code (4 October 2026)

**Harness change; the rules hash moves.** In the 4 October match four refusals came back without an outcome code, so the Bench counted them as uncoded:
- `attack_target` with neither a target id nor coordinates is now `attackNeedsCoords`;
- `assign_workers` with neither a resource type nor coordinates is now `assignNeedsResource`.

Both codes already existed for these cases on other paths. The Bench's ratchet on uncoded refusals in the harness drops from 6 to 4.

## Build 1050: a latecomer joins a standing formation at full speed (4 October 2026)

**Rules change (movement); `game.js` changed.** asp67 watched a whole army stand in formation while one chariot, still on its way, crept toward it as if the formation were marching.

**Measured in a replay of that match (23:44, GLM's turn 252):**
- Egypt's chariot (speed 2) closed 82 units on 68 units standing in their slots at 0.54. That is 8 units per 5 seconds, against 30 for chariots moving freely.
- 0.54 is the march's shared pace (0.9, the slowest member's) cut again to 60% because a priest was off healing.

**The cause:** the pace rules ran in the wrong order.
- The slowdown "a priest is healing: the group regroups at 60%" stood first, before the release "a unit still finding its place runs at its own speed".
- So it slowed exactly the units the group was waiting for.
- And once a formation had arrived, nothing released a latecomer from the shared pace at all.

**Now:**
1. **If part of the formation stands in its slots and it is not fighting,** any member not yet in its slot moves at its own top speed.
2. **The chase rules** are unchanged.
3. **A unit still finding its place** runs at its own speed.
4. **Only then the regrouping slowdowns** (a healing priest, stragglers behind the body), for the units already in place.

While a formation marches, nobody stands in a final slot, so the shared pace holds as before.

## Build 1049: an unknown move mode is refused with a code (3 October 2026)

**Harness change; the rules hash moves.**
- **The refusal:** `move_units` with a mode or `targets` value that does not exist (space-bunny sent `mode: "attack"` in two matches) was refused with the right text but no outcome code, so the Bench counted it as uncoded.
- **Now:** it is `moveBadMode`, classed as a reference error: the command named something that is not there.

## Build 1048: checkpoints that say where a replay leaves its recording (3 October 2026)

**No rules change in play; `game.js` and the harness changed, so the rules hash moves.** Transcripts recorded before this build no longer re-simulate on it, as with any such change.

**Why.** asp67's 19:53 match is the first of the day that does not re-simulate. Its world hash differs at step 15109, in the first fight of the siege on Persia, after matching at step 14838. Nothing was input between the two, and every seat's view stayed identical. A whole-world hash per input could only say that something differed somewhere in those 270 steps. These were ruled out:
- wall-clock reads in the rules;
- the camera, sound or panels writing to units;
- spectator input reaching unit orders;
- the renderer's unit-list order and measured footprints;
- standing orders;
- the age-up that fell in the window.

The cause is still open.

**What changes:**
- **Every 200 steps (ten game seconds) a transcript records a `checkpoint`.** It carries no input: just the world hash and a digest (`Game.stateDigest`), taken at the end of the step, where a replay compares. Per seat, the digest holds:
  - a hash of resources, age and research;
  - its units and buildings, each as one hash.
- **Every sixth checkpoint (the first, seventh, …) adds per-entity detail:** every unit (by handle) and building as four one-byte hashes, for position, health, orders and targets, and timers and cargo.
- **A replay compares each checkpoint and names what differs:** the seat, the part (resources, units, buildings, nodes) and, at a detailed checkpoint, the entity and kind of field. `tools/bench/transcript-replay.cjs` also prints the replay's own values for those entities.
- **Measured on the 18:34 match:** 469 checkpoints add 305 KB to a 6.1 MB transcript.

## Build 1047: no zooming out to the island in the middle of a siege (3 October 2026)

**No rules change; spectator camera only.** asp67 watched it live, in the siege on Persia's Stone Age town (3 October, 19:53 match): the camera "zoomed out in waves" to the whole island, which then sat in a third of the screen. Build 1046 fixed a real bug of the same look in the analyzer, but not this one.

**The cause:** the wide calm shots cut in during the fight.
- **A siege counts as a fight only around a blow:** within 1.5 game seconds of one landing, or while an attacker is within reach. Militia running after villagers and walking between houses are out of reach most of the time.
- **In those gaps the calm shots won:** an age-up (GLM's, as the siege began) queued the compare sweep, every camp from above at half-height 90, and the overview, due every 75 seconds, followed it. Fight 24, compare 90, 90, 90, overview 496: each a cut, each wider.
- **Measured in a replay of the match.** The match itself stops re-simulating at the siege's first fight, so the siege could not be replayed exactly.

**The fix:**
- **The compare sweep and the overview wait** until no blow has landed anywhere for 10 seconds (scaled by the timelapse factor). They are deferred, not dropped. The closer calm shots still fill the gaps between blows.
- **The overview fits the island to the screen,** as the analyzer's opening shot does, instead of a fixed 62% of the map size, which on a wide monitor left the island in a third of the screen.

## Build 1046: the auto camera no longer zooms out of a long fight (3 October 2026)

**No rules change; spectator camera only.** asp67: in a long fight for a settlement, the auto camera zoomed out in waves, further each time, until the whole island sat in a third of the screen.

**The cause, in the analyzer's re-simulated mode:**
- **The stage handed its director copies, not entities.** Each frame's scene names a unit's target as a plain copy, and the stage passed it on as the unit's `attackTarget`. The director added each copy to the fight as a new participant: frozen where the target stood then, and never dying.
- **A unit gone from the scene kept its last health.** Its last look still had it alive, so the director never let go of it either.
- **The result:** a long fight collected a ghost for every frame, spread over everywhere it had been, and the camera widened to hold them all. When a fight lapsed and a new one started, the frame snapped back, then widened again.
- **Measured:** in a fight that only walked 50, the old stage left 52 participants instead of 2 and a frame of 56 instead of 24. It keeps growing with the ground a fight covers.
- **The live arena was not affected:** its director is handed real entities. Replaying asp67's 18:34 match through the live director, no fight framed wider than 59.

**The fix:**
- **Targets resolve to the stage's own entities,** once the whole scene is placed.
- **Whatever leaves the scene is marked dead** for the director.

**A backstop in the director, from a first diagnosis that was wrong** (participants walking away):
- a fight is framed on who is fighting now;
- its frame has a ceiling (half-height 90), as the other shots have;
- the zoom eases toward a new size instead of jumping.

## Build 1045: holding units defend what they stand under; "noDefenders" counts every fighter (3 October 2026)

**Harness and prompt change (prompt agents-rule-v105); `game.js` changed.**
- **Hold defends the owner's things, not only itself.** In build 1044 a holding unit answered only attacks on its own group. A swordsman hacking at the tower 5 from a holding militia was left to it: the militia's own reach is about 1.5, and nobody had hit it. Now an enemy attacking anything of the seat's (a unit, a building, a farm) is answered like an attacker: by every holding unit whose slot is within 19 of it, released the same way.
  - What burns more than 19 from their spots stays the model's call. Holding units are not pulled out to it.
- **`threats.underAttack[].noDefenders` counts every fighter on site** (asp67's review of build 1044). It counted only the idle soldiers the auto-defense reflex sends, so guards, patrols and holds fighting the raider right there were reported as nobody. The fault is older: build 1042 carried it over from the UNDER ATTACK line's "no defenders in range". It now uses the reflex's own on-site test: anyone of the owner's fighting near the raider.

## Build 1044: a "hold" mode for defenders (3 October 2026)

**Harness and prompt change (prompt agents-rule-v104).** asp67 saw defenders break formation and wander out of a Town Center's or a tower's reach into the open, after whatever shot them, ruining the defense.
- **The cause.** Guard picks up any enemy within 48 of its post and chases an attacker up to 64 (hard cap 96). A tower shoots 18.

**What `hold` does:**
- **A new `move_units` mode.** On the way it travels as guard does. At its post, each unit keeps to its own formation slot:
  - it attacks unprovoked only what is within its own attack range of that slot (plus 1);
  - it answers an attacker only within **19** of that slot;
  - it lets an attacker go the moment it backs off past that;
  - idle members wait in their own slots while others fight.
- **The leash is fixed at 19, one past the longest reach in the game.** Ranged units are capped at the tower's 18, so anything that can hit a holding unit from its slot is within its answer, and nothing can shoot it from where it may not go.
- **`tests/hold-mode.test.cjs` keeps watch on future range changes.** It measures every unit of every civilization with every range bonus its civilization can research, and every building that shoots, the way combat measures reach. If any of them reaches 19, the test fails.
- **The leash is per slot, not per group:** a unit at the end of a line answers what it can reach without the middle running out.
- **The trade-off, told to the model:** melee units on hold will not run down archers, so hold belongs under one's own towers.

**Also in this build:**
- **`commandLimit`** (a command past the per-turn cap) is now in the Bench taxonomy as a constraint. It was emitted as a literal, so the taxonomy test never saw it, and the Bench counted it as unknown.
- **Build 1043's one-line state is kept.** The A/B with build 1042 (same seed and seats, 3 October) found no difference in how the models read the state:
  - no parse failures and no commands naming things that are not there;
  - refusals were timing and cost only;
  - memory fields were quoted more often.

  Prompts at the same turn were 1.2k to 9.5k tokens smaller.

## Build 1043: the game state goes to the model on one line (3 October 2026)

**Harness change: what a model is sent.** An A/B asked by asp67, to decide which format becomes permanent. Build 1042's match (3 Oct, 17:05) was sent the state indented; this build sends the same JSON on one line, without whitespace.
- **Why:** indented JSON measured 1.9 times the characters of the same state.
- **Applies to:** the current-state message of every turn, and the final word's state.
- **Unchanged:**
  - earlier turns in the history were already one-line recaps;
  - transcripts store the state as an object;
  - the live transcript viewer and the transcript analyzer still show it indented.

## Build 1042: a seat remembers the enemy units it has seen (3 October 2026)

**Harness and prompt change (prompt agents-rule-v103); `game.js` changed.** Build 1041 made a lost contact always said, but a CONTACT line was still a moment, gone next turn, and what it meant was the model's to carry. asp67's design: enemy units are remembered the way nodes and buildings already are.

**The state:**
- **`enemyUnits` is the seat's memory.** `visible: true` is in sight now. `visible: false` is how and where the unit was last seen, with `secondsAgo`. Each entry carries its health, and a worker carries its cargo, as seen.
- **`sightedAt`** is where this pass through sight began, when the unit moved from there: with the last-seen spot, a heading.
- **Fifty are listed:** in sight first, then the most recently seen. The rest stay remembered and move up as listed ones leave.
- **A unit leaves the list** when its last-seen spot, having been out of sight, is seen again without it.
  - A unit walking out of a view still being watched keeps its spot.
- **It is forgotten only for what the seat could know:**
  - it was seen to die;
  - the seat's own units killed it;
  - its owner is defeated.
  - One that died unseen stays remembered: its fate is unknown, and dropping it would say it died.
- **`gameStats.opponents[]` adds `seenAlive`**, for rivals already met: the rival's units seen and not seen die, by type, including ones whose whereabouts were lost. **`seenSecondsAgo`** says how old those sightings are. A 30-strong army that slipped away is no longer forgotten with its last position.
- **`recentEvents` keeps only what became of orders.** These lines went:
  - CONTACT and CONTACT LOST: now the memory;
  - UNDER ATTACK: already `threats.underAttack`, which gains `noDefenders: true` when nothing answers;
  - LOSS and KILL of buildings: in `lostBuildings`, the battles and `enemyBuildings`.

**Attack by id:**
- **`attack_target` by `targetId` names only an enemy unit in sight, or a building.** A remembered unit is refused with its last-seen spot and age, and told that `targetX`/`targetZ` there sends an attack-move.
  - New outcome code `targetOutOfSight`, classed as reference.
  - By id, an army had followed a unit through the fog to wherever it went, which no scout had told the seat.
  - A unit in sight in the state the model answered is honoured as before.
- **Answering "not found" for a remembered unit that died unseen** would have told the seat it died, so that is refused the same way.

**How it is fed:**
- **The contact scan feeds it** about once a second per seat, so a scout passing between two turns is remembered.
- **The state build refreshes it** on a copy, which the commit merges with what the scan learnt meanwhile: building a state still changes nothing.

**Readers:**
- **The analyzer** draws only `visible` units as confirmed, and dates a remembered one by `secondsAgo`.
- **The Bench's random baseline** names only units in sight.
- **The history recap** counts in-sight units only.

**Cost, measured in two 30-minute four-seat realm matches** (rule-based seats observed through the harness, pretty-printed state as sent):

| | Median | p90 | Max |
|---|---|---|---|
| Added tokens | +0 | +1.7k / +2.2k | +2.9k |

- The median is +0 because most turns have no enemy known.
- The maximum is the 50-entry cap.
- A remembered entry costs about 47 tokens, 58 with `sightedAt`. An in-sight one gains about 11 (`healthPct`, `visible`).

## Build 1041: what a seat sees and what it only remembers (3 October 2026)

**Harness and prompt change (prompt agents-rule-v102); `game.js` changed.** asp67 asked whether models mixing up what is in sight and what is only remembered was our fault.

**It largely was.** In asp67's 3 October match, space-bunny wrote "their field army is dead" on ten turns while Egypt had 9 to 17 soldiers. The trigger was ours.
- **The cause.** A "CONTACT LOST" was left out when the unit had not moved while in sight (since build 671, 21 Aug: "one fact reported twice").
- **What that did in a fight.** Enemies stand still. When the watcher died, the seat got a sighting followed by silence: the units were simply gone, which reads as dead.
- **The model's part.** The same turn's battle report showed Egypt had lost nothing, and space-bunny did not read it.

**Changes:**
- **CONTACT LOST is always reported.** A unit that had not moved is reported "…last seen at (x, z), where it was sighted": the view of it ended, not the unit.
- **Remembered enemy buildings carry what was seen** (`visible: false`): health as last seen, taken on the turn it was in sight or when it was first discovered between turns.
  - A building destroyed out of sight stays listed until its spot is seen again, as a resource node keeps its last-seen amount.
  - Before, a remembered building reported its live health and vanished the moment it fell, both things the seat had not seen.
  - A Wonder stays public: its fall is known as its standing is.
- **Battle sides always carry `lost`**, `{}` when nothing was lost. An absent key had been the only sign.
- **The prompt says:**
  - "enemyBuildings" lists every rival building found, and `visible: false` is remembered as last seen and may have changed;
  - enemy units out of sight are not remembered;
  - a CONTACT LOST "where it was sighted" says nothing about whether the unit still lives.
- **Unchanged (asp67):** after contact, a rival's `population` and building count stay public, but not its unit or building types.

## Build 1040: a fight's card no longer says "lost 3 of 0" (3 October 2026)

**No rules change; `game.js` changed, so the rules hash moves.** The chronicle's fight card says what each side lost of how many took part (asp67 saw "lost x of 0").
- **The cause.** "How many" counted only what struck or healed in the fight. A side whose buildings or unarmed units were cut down without a blow back was lost from a count of 0.
- **The fix.** The battle record now also keeps what was struck, per owner (`hit`), beside its sides. The card counts striker and struck together.
- **Models are told the same as before:** `battles` in their state still reports what each side struck with, and what it lost.

## Build 1039: chopping and mining share one gap, 0.5 s (3 October 2026)

**No rules change.** For consistency (asp67), chopping and mining now both wait 0.5 s per map cell (b1038 had 0.55 s and 0.625 s).

## Build 1038: chopping and mining sound twice as often (3 October 2026)

**No rules change.** A work sound is spaced per kind of sound per 14-unit map cell, so twenty miners on one node shared a single click every 1.25 s, which sounded odd (asp67). Chopping now waits 0.55 s (was 1.1 s) and mining 0.625 s (was 1.25 s). Farm and berry harvesting (1.6 s) and building are unchanged, and the cap of 18 world sounds a second still holds.

## Build 1037: one selection colour, pale yellow (3 October 2026)

**No rules change.** The ring under a selected unit or building was green, and green is a seat's colour (asp67). It is now the pale yellow of the resource-node ring (b1036). All three use one tint, `EngineRenderer.SELECT_TINT`.

## Build 1036: a picked resource node is ringed (3 October 2026)

**No rules change.** While a resource node's info card is up (b1034), the node is ringed on the ground. It is the same ring as a command marker, in pale yellow, which is no seat's colour (asp67), and wide enough to take in a stone or gold deposit. It goes with the card, when the node runs dry, or when a new match starts.

## Build 1035: final words are asked with the seat's memory (3 October 2026)

**No rules change; a harness change** (the final word is unscored, so no metric moves).
- **The question.** asp67 asked whether the hallucination in final words came from what the models were given.
- **The answer was yes.** The closing question went out as one message: the final state, the match in numbers (added in build 564, after three of four models wrote that they never got started) and the question, with no objective, no plan and none of the seat's own turns. The post-mortems read like it: "likely while I was still building up my economy", "must not have scouted", "looking at the numbers".
- **Now it is built like a turn** (`buildTurnRequest` with `closing`). The standing objective and plan and the rolling history of the seat's own turns come first, sized to its context budget. The present message carries the final state, the match in numbers and the question; it does not ask for a move, and it has no Wonder countdown or advice.
- **It stays one seat's own view.** Nothing it did not see is added.
- **The `final_word` record gains `context`**: messages and characters sent, so a thin answer can be told from a thin context.
- The single-message form remains only for a seat whose final state could not be built.

## Build 1034: the inspect card in broadcast mode, and for resources (3 October 2026)

**No rules change.** `game.js` changed, so the rules hash moves, but only the spectator's click picker did.
- **Broadcast mode** hid the inspect card along with the operator panels (b1011), so a click picked a unit and showed nothing (asp67). The card now shows while something is picked and goes when a click lands on nothing. There is no hint card on the picture.
- **Resources can be clicked**, in every spectator view: a tree, a stone or gold deposit, berries. The card says what it is and how much is left. A unit or building on top of a node still wins the click.

## Build 1033: a worker takes its load home after a fight (3 October 2026)

**Rules change.** asp67 saw a worker carrying stone home get attacked. It killed the attacker, went back to its stone node still carrying the stone, and stood there.
- **The cause:** after the fight the worker resumed as a gatherer at its node. But a worker starts gathering only with empty hands, so it waited at the node for good.
- **Now:** a worker still carrying a load walks to the nearest finished Town Center first. The delivery then sends it back to its node or field as usual. The load is not banked on the spot.
- Builders and scouts already went back to their site or trip; that is unchanged.

## Build 1032: the re-simulated replay shows what a live match shows (3 October 2026)

**No rules change.** asp67 found the analyzer's re-simulation missing its indicators, its daylight running backwards, and its timeline flaky.
- **Effects.** The worker runs the rules with a silent renderer, so arrows, stones, hit flashes, dust and battle rings never reached the stage. It now records those calls and sends them with each frame, and the stage replays them on its own units. A long jump shows only its last two seconds, none of what it skipped.
- **The strategic layer** draws over the replay: base and army flags with their counts, and the battle marker. The battles come from the replayed world.
- **Command markers.** The intent layer's target markers are fed with each decision's commands as it takes effect. The decision bubbles stay off (asp67): the list beside the stage reads them, and at replay speed they would only flash.
- **Age-up waves** come from the replayed seats, but not during a jump.
- **Daylight runs on the replayed world's own match clock**, as live. It used to be interpolated between the decisions' recorded times. Those are when each seat was asked, while the decisions are ordered by when the answers took effect, so a slow answer could follow a later question and the light ran backwards: night, day, night, day.
- **The timeline:**
  - A moment picked on the power or resource chart, or a chapter, now moves the replay. Before, only the list moved, and the next frame took it back.
  - A decision picked in the list stays picked when another seat's decision took effect at the same step.
  - The slider is no longer reset under the pointer while it is dragged.

Checked on a stand-in-model match re-simulated in the browser (128 world hashes certified): the daylight never ran backwards, and battle rings, the battle marker, the army flag and command markers appeared with the fight.

## Build 1031: speed labels without game.js (3 October 2026)

**No rules change.** The speed labels (b1020) read the normal pace from `Game`. A page that drives `ui.js` without loading `game.js` would have thrown there; the Platform's viewer is one. They now fall back to the normal pace, 2.

## Build 1030: "Reasoning effort", always a dropdown (3 October 2026)

**No rules change. Nothing changes on the wire.** At asp67's request:
- **The field is named "Reasoning effort"** (Denkaufwand, Esfuerzo de razonamiento, 推理强度).
- **It is a dropdown in every case.** Where the server offers no choice it is disabled and reads "Not supported", and the note refers to Extra request body (Advanced settings).
- **Anthropic's and Google's own APIs** list their budgets instead of a number box:
  - Anthropic: 1024 to 32000 tokens.
  - Google: model decides, 1024 to 24576 tokens, or off.
  - A budget typed before stays one of the choices.
- **The same protocols on another server** (vLLM, Unsloth, a gateway) do not promise to read a budget, so they are "Not supported". asp67's GLM on vLLM via Anthropic's protocol is one of these.
- **A value set before on a server now "Not supported"** is not dropped and no longer sent unseen: it moves into the extra request body in the exact form it was sent in. For example, a 4096 budget becomes `{"thinking": {"type": "enabled", "budget_tokens": 4096}}`, and "off" becomes `chat_template_kwargs.enable_thinking: false`. What the extra body already says is kept.

## Build 1029: Extended thinking moves up to Model and budgets (3 October 2026)

**No rules change.** Now that its choices come from the server (b1028), the thinking field sits directly under the model choice instead of in Advanced settings.
- **Extra request body stays in Advanced settings.** For a server that does not say how its thinking is set, the note under the field refers to it there.
- **Advanced settings no longer opens by itself** for a thinking conflict; that warning now stands beside the field.

## Build 1028: the thinking dropdown asks the server (3 October 2026)

**No rules change.** asp67 asked for the thinking choices to be read from the server. Choosing a model, or a successful Test connection, now asks the server what that model offers. The dropdown lists exactly that, and each value is sent in the one form that server reads, because a key a server does not know is ignored without a word.

| server | where it says | sent as |
|---|---|---|
| OpenRouter | its model list, `reasoning.supported_efforts` / `mandatory` / `default_effort` | `reasoning: {effort}`, off = `effort: "none"` |
| Ollama | `/api/show`: `thinking.values`, or `capabilities` on versions without it. gpt-oss gets its documented levels by family | `think: level / true / false` |
| llama.cpp | `/props`: the levels its chat template compares `reasoning_effort` against; on/off if it reads `enable_thinking` | `chat_template_kwargs` |
| Unsloth Studio | `/v1/status`: `reasoning_effort_levels`, `reasoning_style`, `reasoning_always_on` | top-level `reasoning_effort` / `enable_thinking` |
| api.openai.com | the documented efforts | `reasoning_effort` |

- **Servers that do not say** (vLLM, SGLang, other gateways) read "Not provided by this server" and point to Extra request body.
  - A value chosen before is kept, marked "set earlier", still sent as before, and can be cleared.
- **A value the newly chosen model does not offer is cleared**, so nothing is sent only to be ignored.
- **Anthropic and Gemini** keep their thinking-budget field.
- **Until the server has been asked** (an entry not tested since), the dropdown is the old one.

Checked against the real OpenRouter list (332 of 466 models state their options) and a local Ollama 0.34.2.

## Build 1027: the match header asks the server too (3 October 2026)

**No rules change.** Build 1026 fixed only one of the two places that name a seat's server. The connection test stopped reporting the protocol as the server, but the match header has a probe of its own. That probe still answered "anthropic" for any seat on Anthropic's protocol, so the live lineup and the transcript kept recording asp67's vLLM GLM as Anthropic. It now asks the server like any other seat. Only Ollama's own protocol still names its server.

## Build 1026: the protocol is not the server (3 October 2026)

**No rules change. The recorded `servedBy` changes meaning for Anthropic- and Google-protocol seats.**
- **The bug.** A seat speaking Anthropic's or Google's protocol was recorded and shown as "served by anthropic" / "served by google", whoever ran it. asp67's GLM on vLLM, spoken to in Anthropic's protocol, appeared in the lineup as served by Anthropic.
- **`servedBy` now holds only what the server reports about itself** (`owned_by` in its model list), whatever protocol it speaks. The exception is Ollama, which only Ollama speaks.
  - The real Anthropic and Google APIs report no owner, so their `servedBy` is null.
  - The protocol is recorded, as before, in `provider`.
  - Transcripts from earlier builds keep the old meaning.
- **The lineup shows the protocol as a tag of its own**, "protocol Anthropic", beside "served by vllm".

## Build 1025: a known login server fills itself in (3 October 2026)

**No rules change.**
- **The OpenRouter preset** ("＋ Add from preset…") now starts on the login button instead of an API-key field. Its notice says to log in, then test the connection.
- **OAuth2 opens with a "Login server" choice:** OpenRouter, or another login server.
  - Picking OpenRouter fills in the endpoint and the dialect, and only the button remains.
  - Picking another server clears an OpenRouter endpoint and shows the server's fields.
  - Switching ends a login, because a login belongs to its server.
- The other cloud presets (Anthropic, Gemini, OpenAI) already filled in endpoint, dialect and API key, and are unchanged.

## Build 1024: OAuth2 is a login button (3 October 2026)

**No rules change.** The OAuth2 form asked for a pasted token, or a token URL, client ID, client secret and scope. asp67 found it too much for anyone who doesn't know OAuth.
- **OpenRouter:** with an openrouter.ai endpoint, OAuth2 shows only "🔑 Log in with OpenRouter". A popup opens OpenRouter's login, and WAR receives a key of its own. There is nothing to copy.
- **Any other login server** (a company gateway, Keycloak and the like): its authorize URL, token URL and client ID, then "🔑 Log in".
  - The card shows the callback address its admin registers.
  - The browser login uses PKCE, so there is no client secret.
  - Tokens are refreshed a minute before they run out.
- **What went:** the client-credentials fetch and its client secret. A secret saved in the library is deleted when the library loads. A token pasted under the old form keeps working and shows as logged in.
- **Anthropic and Gemini** keep API keys: neither offers a login third-party apps may use.

## Build 1023: sound on by default, effects softer (1 October 2026)

**No rules change.**
- **Sound is on by default.** The browser allows sound only after a gesture, so it starts with the first click or key press. A mute set before that holds for the page and across our own scene changes. A reload starts unmuted again.
- **Effects** are at 0.336, 0.8 of b1011's 0.42. An effects level saved at either earlier default (0.6 or 0.42) is read as "default" and gets the new one.

## Build 1022: the auto camera is on by default (1 October 2026)

**No rules change.** A watched match opens with the auto camera (🎬) on. Switching it off lasts for that match.

## Build 1021: the Wonder countdown runs at the 1× pace (1 October 2026)

**Rules change.** asp67 set the Wonder hold for the new speed names:
- **The countdown unit.** The countdown still shows 600 seconds, but each is a second at the 1× pace: 2 game seconds. A Wonder must therefore stand 1200 game seconds (it was 600).
  - At 1× a seat has ten real minutes.
  - At ½× a countdown second takes two real seconds.
- **The pace while a Wonder stands.** 2× falls back to 1×, and ½× stays ½× (until build 1020 every speed fell back to the old 1×).
- **What models are told.** `secondsUntilYouWin` and `secondsUntilEnemyWins` are both real seconds now. The owner's number used to be game seconds.
- **Transcripts** record `wonderPace` (game seconds per countdown second). A transcript from before this build has none and replays with 1, as it was played.
- **The Bench and the golden traces** stay at pace 1 (`Realm` `normalSpeed`), so their Wonder is still 600 game seconds.

## Build 1020: the old 2× is the new 1× (1 October 2026)

**The default pace doubles; the speeds themselves do not change.** asp67 renamed them:
- the old 2× is now **1×** and is where a match starts;
- the old 1× is **½×**;
- the old 4× is **2×**;
- 1.5× left the menu.

Transcripts record the multiplier as before. A match at the new default records `simSpeed: 2`, so it compares with the old 2× matches, not the old default ones. A standing Wonder still holds the match at the old 1×, which is now labelled ½×. The Bench and the golden traces stay at the old default pace (`Realm` option `normalSpeed`, default 1).

## Build 1019: a harvester's close-up is filmed from a standing camera (1 October 2026)

**No rules change.** In a close-up of a harvesting worker, the camera stays where the shot began. It turns to follow the worker instead of travelling beside it. As the worker walks to its drop-off it gets smaller in the frame, as it would for a camera on a tripod. Every other close-up (scouts, the head of a march, builders, fighters) still moves with its subject. The analyzer's autocam does the same.

## Build 1018: shoulder pads at 0.8 (1 October 2026)

**No rules change.** 0.7 of the old size was too small, so every unit's shoulder pads are now 0.8 of it.

## Build 1017: smaller shoulder pads (1 October 2026)

**No rules change.** Every unit's shoulder pads, the riders' included, are 0.7 of their old size. They sit where they did.

## Build 1016: shoulder pads for the militia (1 October 2026)

**No rules change.** The militia, the first infantry tier, was the last unit with a bare sleeve top. It now wears the leather shoulder pads too.

## Build 1015: shoulder pads for workers, archers and priests (1 October 2026)

**No rules change.** Close up, the top of a bare sleeve read as a flat disc. Workers and archers of every tier now wear the leather shoulder pads the elite archer had. Priests wear them in their robe's cloth.

## Build 1014: close-ups pulled back further (1 October 2026)

**No rules change.** A close-up now frames its unit at about a quarter of the screen height (b1013: half). Both the worker and the rider framing are twice as wide as in b1013, and the aim stays at the chest.

## Build 1013: the speed control stays open, and close-ups pulled back (1 October 2026)

**No rules change.**
- **Speed control in broadcast mode.** The board was rebuilt whole every second, which took the speed control and the buttons beside the cards out and put them back. The hover dropped and an open speed menu closed under the pointer. Now only the seat cards are rebuilt; the clock text is updated and the speed control stays attached.
- **Close-ups are framed wider.** A worker filled about three quarters of the screen height; it now fills about half (rider framing widened by the same 1.5×). The aim stays at the chest.

## Build 1012: the broadcast button in the bar gets its label (1 October 2026)

**No rules change.** In analyze mode the bar's button back to broadcast mode was an icon alone. The other buttons show an icon over a label, so it stood half their height. It now reads "📺 Broadcast" (Sendung, Emisión, 直播) at their height.

## Build 1011: broadcast mode by default, and quieter effects and ambience (1 October 2026)

**No rules change.**
- **Broadcast mode is how a watched match opens.** The button on its board (now 🔍) switches to analyze mode: the decisions log, the leaderboard and the controls. The bar's 📺 switches back. Esc still leaves broadcast mode.
- **The viewer's last choice is kept** for the next match. Opening or closing the arena does not count as a choice.
- **Audio defaults:**
  - Effects are 30 % lower (0.6 to 0.42).
  - Ambience is half (0.45 to 0.225).
  - Moving any one sound slider saves all five, so a saved effects or ambience level that still sits at the old default is read as "default" and gets the new one. A level set on purpose is kept.

## Build 1010: close-ups, and the live autocam in the analyzer (1 October 2026)

**No rules change.**
- **Close-ups.** The auto camera now and then shows one unit up close: low, from in front at a three-quarter angle, aimed at its chest so the face sits in the upper third. asp67 chose the framing on a posed preview.
  - **Calm phases:** a seat's lone scout, the front of its marching army, or a worker at work, at most every 30 s.
  - **Fights:** a fighter, briefly, once the battle has been shown from its usual angle twice, and not again in that fight for 15 s.
  - **Line of sight:** a close-up is taken only with a clear view. A woodcutter faces its tree, so the strip to the camera is checked against trees, resource nodes and buildings: the front view to either side first, then a profile. A subject seen from nowhere is passed by.
  - **Timing:** a close-up holds at least 2 s against anything of the same urgency. A running close-up no longer looks "gone" to the director, which had let the fight take the camera straight back.
  - **Camera:** it can aim above the ground (`lookY`) and come closer than the user's zoom (half-height 0.8). It follows a close-up's subject tightly and returns to the ground and the normal zoom range when the shot ends.
- **The analyzer's auto camera** over a re-simulated replay is now the live director: fights, marches, scouts and close-ups, cut and composed as in a live match. It used to jump from one turn's hotspot to the next.
  - **The replay world:** the replay scene carries where units are going and what they do, and a drop in health counts as a hit.
  - **Following:** a unit picked on stage is followed, as a click follows one live.
  - **Single turns** (not a replay) keep the hotspot aim.

## Build 1009: the minimap's seat knobs in broadcast mode (1 October 2026)

**No rules change.** The knobs beside the minimap that choose whose map knowledge it shows were still hidden in broadcast mode. They now stay, with the minimap's other controls (build 1003).

## Build 1008: the battle marker lies on the ground (1 October 2026)

**No rules change.** Zoomed out, a battle was marked with a dashed disc facing the camera, unlike every other ring, which lies on the ground. It is now a circle on the ground projected through the camera: the same on-screen size as before (16 to 30 px across at any zoom), foreshortened with the view.

## Build 1007: ground clutter grows in after a cut (1 October 2026)

**No rules change.** After a cut to a wide view, the grass and rubble filled in square by square. One 16x16 tile was built per frame, at full density, and appeared at full height. A wide cut needs about 100 tiles: 109 frames, about 1.8 s at 60 fps.
- **Only what is drawn is built:** a tile starts with its base layer, and its denser layers are built only when the camera is close enough to draw them.
- **A time budget instead of one tile:** 4 ms per frame, 8 ms while more than 24 tiles are missing, which is right after a cut.
- **New tiles grow in:** they rise out of the ground over 0.35 s instead of popping up.
- **Measured** (headless, three wide cuts): from 109 frames to 33 to 40 frames to fill. Close views still build all three layers.

## Build 1006: fields grow rice and wheat (1 October 2026)

**No rules change.** A bronze-age field now carries scattered clumps of plants on soft furrowed soil. An iron-age field is evenly filled, row on row, inside its fence.
- **Yamato fields grow rice:** slender upright blades in fresh green, on darker, wetter soil.
- **Persian, Greek and Egyptian fields grow wheat:** taller straw-yellow stalks with a golden ear.
- **How it is drawn:** the plants are one mesh per field look (`EngineMesh.crops`), shared by every field of that look, so a farm costs one extra draw.
- **Unchanged:** stone-age and neolithic fields, the farm's size and the food it gives.

## Build 1005: priests heal in a fight (1 October 2026)

**A rules change.** A priest under an order is placed by that order, on a stand just inside its healing reach (9.8 of 10.5) beside its patient. The stand was kept as long as the patient had moved less than 1. A soldier shuffling in a fight moves about that much, so the priest was left on a stand 10.5 away, a hair outside its reach, healing no one while it looked to be in range. The stand is now kept only while it still reaches the patient.
- **Measured** on a board where an army fights, with the priest in the army's attack order: heal ticks rose from 50 of 400 to 389 of 400. Ordered next to the army separately: from 54 to 392. A priest with no order, which was never affected, heals 400 of 400.
- **Golden traces:** `battle-40v40` and `wonder-siege`, both with priests, were re-recorded.

## Build 1004: who is still in the game, and workers who defend themselves (1 October 2026)

**A rules change.**
- **Who is still in:** asp67's rule. A seat is out once no unit on the field can fight or build something, and no building can actively produce such a unit, because it is unfinished or cannot pay for one. It is still in with any of these:
  - a unit that can fight: anything but workers and priests;
  - a unit already paid for and in training;
  - a finished building that can produce such a unit and pay for one now: a Town Center a worker, a trainer one of its units of this age (civilization uniques included);
  - a worker that can build something: a producing building's foundation to finish, the resources for a Town Center or a trainer, or a finished Town Center to gather into.
- **What changed against the old rule:**
  - An unfinished Town Center with no worker left no longer keeps a seat in.
  - A Town Center with no worker and no food for one no longer keeps a seat in.
  - Priests and towers never counted as an army and still do not.
  - A Wonder alone does not keep a seat in.
  - A foundation now counts while the seat has any worker, not only while one is assigned to it: a builder pulled away can be sent back.
  - The defeat message says why.
- **Workers defend themselves and nothing else:**
  - A worker hit by a unit fights back against that unit only. It never attacks towers or buildings.
  - It goes back to its job when the attacker falls or is more than 30 from where the worker was hit. Its job includes gathering, farming, building and its scouting trip; building and scouting were lost before, and the worker stood idle at the fight.
  - Workers are no longer drafted into fights they are not part of. Before, every worker on the map was drafted for a Wonder raid, and workers within 28 when the seat had no army, which pulled scouts off their trips.
- **Golden trace:** `wonder-siege` was re-recorded. It had workers drafted to the Wonder.

## Build 1003: speed and minimap controls in broadcast mode (1 October 2026)

**No rules change.**
- **Speed control:** broadcast mode now has a small version of the speed control right of the clock. It is the bar's own control, moved there, so it offers the same 1x to 4x and Pause, with the same Wonder lock, and on the Platform the same speed proposal. It goes back to the bar when broadcast mode ends.
- **Minimap controls:** the minimap keeps its controls (zoom, follow and the rest) in broadcast mode instead of hiding them.

## Build 1002: armies answer towers they cannot see, and stop yo-yoing (29 September 2026)

**A rules change.** A live Platform match (Yamato attacking Egypt's town, 4x tempo, five iron-age towers) was replayed from its checkpoint with the army's orders as they stood. Two failures showed, with four causes.
- **Towers out of sight:** a tower reaches 18 and a foot soldier sees 15. The standing order answered only attackers its seat could see, so a tower firing from 15 to 18 away was ignored: the army went on with its siege, or its march, under the arrows. A unit that did turn on its shooter dropped it again as out of sight, walked back to its slot, was shot, and turned again. **Now** an attacker that hits a member is seen by the group for 3 s after each hit. A tower stays seen until it falls, because it cannot move. Nothing else is seen through the fog.
- **Groups spread wide:** a model often adds fresh troops from home to an army at the front, so one group can stretch 300 units. The chase leash was measured from the group's middle, which then lay far from the fighting. A soldier 20 from the archer shooting it was told the archer had escaped, and walked back. **Now** a soldier answering an attacker is leashed to the spot where it took up the fight: it still cannot be lured across the map, but a far-away middle no longer calls it back.
- **Far members pulled across the map:** every member, however far, was sent at an attacker, and at a tower, only to be too far from it to keep it. **Now** only members within the chase radius (64) take it up.
- **Joining a fight from anywhere:** once one member was engaging, every member could pick a target at any distance. **Now** that reaches 96 at most, except for the order's own named target, which every member is marching to anyway.
- **Measured on the replayed live match (150 s at 4x):** tower damage went from 0 to 96. Seconds spent hit with no target went from 4 to 0. Soldiers taking up the same attacker again after dropping it went from 9 (with only the first fix) to 0. The only remaining releases are legitimate: an attacker more than 60 away, taken up again 13 to 17 s later once the march had brought it within reach. (Corrected: the first write-up read the replay's 50 ms steps as the match's 4x tempo and gave these as 54 to 69 s.)
- **Golden trace:** `battle-40v40` (towers and priests) was re-recorded with this change. The other traces are unchanged.

## Build 1001: a plan sent first no longer moves the refusal marks (29 September 2026)

**No rules change.** The harness numbers a turn's answers by game command ("Command 2/3: ..."), and a plan call is not one of them. The bubbles counted every call, the plan included, so when a model sent its plan first, which is common, each bubble read the answer of the command before it. The refusal cross (✗) and the explore's aim then went to the wrong command. Commands are now counted without the plan.

## Build 1000: whole plans, a quill, clearer bubbles, calmer snow and sand (29 September 2026)

**No rules change.** Everything here is display.
- **Plans:** a plan call's bubble said only "Plan". The plan is now shown whole, the objective and every step, in a bubble on the edge of the view: the left edge first, then the right, beside any panel standing there. It stays three times as long as a turn's bubble with the same text, and outlives the seat's later turns. At most two are shown. A seat's new plan replaces its own, and a third seat's replaces the oldest, in its place.
- **The quill:** research and plans are marked with a quill (🪶) instead of the microscope and the clipboard, in the decisions log, the bubbles, the analyzer, the research card and the leaderboard flyout. The analyzer's "Copy chapters" button keeps its clipboard.
- **Bubbles on buildings and resources:** a bubble that stands on a building or a resource now stands its own height higher, so its bottom is where its top was, and the ring and what it marks stay visible. This covers training and research at their building, a site being built, a resource being gathered, and a building attacked or repaired by id. A bubble slid along a path or resting on an edge is not lifted.
- **One card for calls out of view:** when two or more of a seat's calls point out of view, they become one card on the edge, one line per call in the turn's order. A call whose point is in view keeps its own bubble there.
- **Broadcast cards:** each seat's top line ends with its population slots, the cap from houses and Town Centers (🏠). The tooltip gives slots used and the cap.
- **Snow and sand:** since bloom, lit snow and sand came out of the tone curve at 0.97 and 0.96 in their brightest channel, past the top of the bloom's knee. That meant full bloom on near-white ground and washed-out detail. Dry ground is now a touch darker: ×0.89 on winter maps, ×0.91 on desert maps, bringing noon ground to about 0.88. Water, summer maps and everything else are unchanged. Measured on a zoomed frame around a Town Center, saturated pixels went from 4.3% to 0.75% on winter and from 2.8% to 0.9% on desert.

## Build 999: an order on a Wonder goes to the Wonder (29 September 2026)

**A rules change.** An army sent at a Wonder with `attack_target` got lost on the way. The march is a standing order, and every 150 ms it gave each soldier the nearest visible enemy within 48 units, unit or building alike. The named target was just one candidate among them, so a villager or a house nearer than the Wonder won, and the army ground its way through everything on the route.
- **What happens now:** while the named target is a living Wonder, finished or under construction, the only targets the army picks are the Wonder and whatever attacks it. Retaliation still comes first, towers ahead of mobile attackers, and afterwards the army goes back to the Wonder. Anything else it held from before is dropped.
- **Once the Wonder falls:** the assault carries on around it as with any named building.
- **The model is told:** the order's answer ends with "A Wonder is their only target: on the way they fight back only against what attacks them."
- **Unaffected:** orders on any other target, attack-moves to coordinates, and the human player's orders on anything but a Wonder. A human's attack order on a Wonder follows the same rule.

## Build 998: the minimap's row numbers line up in broadcast mode (29 September 2026)

**No rules change.** The 1-7 row labels beside the minimap stopped a fixed 45 px above the panel's bottom edge, to leave room for the camera toolbar under the map. Broadcast mode hides that toolbar and the panel shrinks, so the seven numbers were squeezed into a column 20% shorter than the map: up to 38 px off their rows at every UI size. The column is now exactly the map's height, whether the toolbar is shown or not. The letters were never affected. In normal spectator mode the numbers were 1-2 px off and are now exact.

## Build 997: broken tool-call markup is refused, not run (28 September 2026)

**A harness change.** GLM-5.3 writes tool calls in its own tag format, which the server turns into JSON. When its tags came out broken, the calls were cut apart in the wrong places. In one case a reason swallowed the whole next command as text, `…flowing<tool_call>train_unit<arg_key>reason</arg_key>…`: the first call ran with that reason, and the second never ran and was never mentioned. In another a key read `archer</arg_value><arg_key>reason`. It is rare: once in 185 GLM turns of a recorded match, and never from the other models.
- **What happens now:** a call whose arguments (keys or values) contain `<tool_call>`, `<arg_key>` or `<arg_value>` is not run. It is not repaired either, since the harness does not play for the model. It is answered: its arguments contain raw tool-call markup, nothing written inside it was run, including any command after the break, and each command must be its own tool call with plain JSON arguments.
- **Outcome code:** `rawToolMarkup`, classed as a malformed call (reference).
- **Display:** the decision log and the intent bubbles show such a reason only up to the first stray tag. The transcript keeps the raw arguments.
- **Unaffected:** ordinary reasons with angle brackets ("gold <3 per trip") run as before.

## Build 996: place and colour on the broadcast cards (28 September 2026)

**No rules change.** In broadcast mode, each seat card's bottom line now starts with the leaderboard's rank medallion (gold, silver, bronze), sorted as the leaderboard sorts. The cards themselves keep seat order. The seat's colour runs down the card's left side as a bar, as on the intent bubbles.

## Build 995: the lineup at the bottom, bubbles below the top bar (28 September 2026)

**No rules change.**
- **The lineup card:** as it floats over the opening of an arena match, it now sits at the bottom centre. In broadcast mode it sits above the caption row.
- **The bubbles:** they kept a fixed 56px from the top of the view and slipped under a top bar that the UI size and its own wrapping make taller. The top margin is now measured from the bars actually there: the arena's status bar, the game's resource bar and the broadcast board.

## Build 994: every command gets its bubble (28 September 2026)

**No rules change.** A command only got an intent bubble when it pointed at a place on the map. Otherwise only the first reason of a turn that pointed nowhere was shown, over the base. Training without a rally point, research, age-ups and waits never showed.
- **How big the gap was:** in a recorded 4-seat match, 132 of 372 turns lost at least one command from the map. By command: 128 of 306 trainings, all 44 researches, all 30 waits and all 11 age-ups.
- **What changed:** every command now gets its own bubble. One that points at a place gets its ring and its bubble there. One that points nowhere gets its bubble at the building that carries it out, and no ring: the building that trains the unit, the one the tech is researched at, or else the Town Center.
- **Result:** in that match, every command with a name now has a bubble.

## Build 993: the intent bubbles name their call (28 September 2026)

**No rules change.** After the model's name, every intent bubble now shows the call it stands for. The decision log's own icon for the action comes first, then just what was called:
- the unit, the building or the research;
- the next age;
- the workers and their resource ("3 → Wood");
- the tile or the coordinates;
- the attacked target's type.

A command given without a reason is named by the call alone, instead of repeating it underneath in italics. A turn that points nowhere, such as a training or a research, keeps its call on the bubble over its base.

## Build 992: the broadcast flash follows its caption (28 September 2026)

**No rules change.** In broadcast mode, a decisive moment's caption comes with a brief band of light. The band used to cross the middle of the picture while the caption stood at the bottom left. It now runs behind the caption, brightest where the caption starts, and scales with the UI size as the caption does.

## Build 991: stone and gold follow uneven spawns (28 September 2026)

**A rules change for callers with uneven spawns; WAR's own maps are unchanged, node for node.**

- **What changed:** stone and gold are laid out in one player's wedge and rotated onto every other player. That is exact only when the Town Centers sit evenly on a circle around the map's centre. A caller that jitters its spawns on purpose, like WAR Platform, which moves the circle's centre, each seat's radius and angle, and shuffles the seats, now sets `terrain.jitteredSpawns`. Each node is then rotated about the spawns' own centre, and every seat's copy is shifted by that seat's own spawn offset. Each spawn's place on the circle is found by its angle.
- **Constraints:** every copy must clear the keep-out around every Town Center and stand on land 15 units off the shore. It may reach 25 units past the symmetric disc. A node with no spot that suits every seat would be left out for all seats alike; in 180 measured maps none was.
- **Measured on 60 Platform maps per seat count:** the nearest three stone nodes differed between seats by a median of 11 / 20 / 18 % (2 / 3 / 4 seats), up to 49 % on the worst tenth; the nearest gold by 10 / 17 / 15 %. Both are now 0. Average distances moved by 3 % at most.
- **WAR itself:** the switch is off, so the arena, the campaign and the visual showcase keep the plain rotation. The pinned map fingerprints and golden traces are unchanged.

## Build 990: move_units takes a tile (28 September 2026)

**A harness change.** `move_units` accepts a map `tile` ("C5") as well as coordinates. Coordinates win; the tile is used only when no coordinates are given, and the units go to the centre of that tile. Neither field is required by the tool schema any more; a call with neither is refused with a message naming both. On the Platform, GLM-5.3 twice sent a scout-mode march with a tile instead of coordinates, carrying `explore`'s vocabulary over, and was refused for the shape.

## Build 989: a smaller UI uses the room it frees (28 September 2026)

**No rules change.** With a smaller UI size, the leaderboard still scrolled exactly where the full-size one did. Its height limit is taken from the window and reserves room for the minimap, and under the UI zoom both were shrunk together, so the limit shrank with the panel. The window is now divided back out: the leaderboard runs down to just above the minimap at every size, and scrolls only when its cards really do not fit. The transcript viewer's limits get the same correction. The leaderboard's spectator limit lives in antiquity.css, which loads last, and is corrected there.

## Build 988: a UI size setting (28 September 2026)

**No rules change.** The graphics card at the minimap has a third setting, UI size: Regular, Medium or Small (100, 85 or 72 %).

- **What scales:** the bars, panels, menus, the minimap with its tools, the broadcast board and the captions, each as a whole piece, with type, spacing and icons together. The map keeps its full resolution.
- **Bubbles** scale around the point they stand on, so their anchoring does not move.
- **The decision log** still fills the window's height.
- **Saved** with the other view settings, so it survives a reload.

## Build 987: a bigger Wonder, and towers kept apart (28 September 2026)

**A rules and harness change.**

- **The Wonder is 1.5x its old size.**
  - The mesh is drawn 1.5x.
  - The ring units are kept out of goes from 7 to 10.5 (`Game.WONDER_CLEARANCE`, and the same in `simulation/position-rules.js`).
  - The reach needed to hit it goes from +4.6 to +6.9, so melee still reaches the bigger walls (the pyramid's faces now stand at about 7.6).
  - Its resource clearance goes from 5 to 7.5.
  - Other buildings keep 16.5 from it (was 11). A new Wonder keeps 16.5 from them.
- **Towers keep 15 from other towers** (was 9, like any building).
- **One rule for everyone:** `Game.buildingGap` applies these for the models' placement, the rule-based AI's and the human player's. Every other gap is as before.
- **Why:** Wonders were easy to hold with a ring of towers. With the old numbers, up to 13 towers could reach one attacker at a Wonder; with these, at most 5 can (three on the nearest ring). An army that commits has a chance, and the Wonder reads as the landmark it is.
- **What the data showed first:** in September's matches, 13 of 14 winning Wonders never took damage. Towers decided it in one clear case (10 towers against squads of 3–4) and one borderline one (5 towers against 32 attack orders). Most attacks never reached their Wonder in force.
- **A tower that cannot be placed** because of the spacing now says so: "Towers must stand at least 15 apart; the nearest is N away." Before, the refusal only said "occupied".
- **Golden traces:** `wonder-siege` is re-recorded; units now stand further from the Wonder. The siege plays out the same way, with the same units falling at about the same checkpoints. `opening-economy` and `battle-40v40` are unchanged.
- **Comparability:** the rules and harness hashes move. Wonder and tower results from before this build are not comparable with results after it.

## Build 986: bubbles stay clear of the panels (28 September 2026)

**No rules change.** The panels over the map are not free ground for bubbles: the AI decisions on the left, the leaderboard and the minimap on the right, the transcript and the unit card. A bubble that would sit under one is moved out beside it, toward the middle of the view. This applies before stacking and again after, since stacking can raise a bubble into a panel. Before, bubbles pinned to the left or right edge ended up under the decisions panel or the leaderboard, unreadable.

## Build 985: auto camera and intent on the broadcast bar (28 September 2026)

**No rules change.** In broadcast mode, two small icon-only buttons sit left of the broadcast button: 🎬 auto camera and 🎯 intent. They switch the same things as the spectator bar's buttons, and are green while on.

## Build 984: the auto camera holds for reading and cuts calmer (28 September 2026)

**No rules change.** The auto camera (the director):

- **Holds for reading.** While any decision bubble's point is on screen, it does not cut away, and a shot that runs out is held on. A cut moved the bubbles, and three cuts under one bubble made it unreadable. Only a battle cuts through the hold. The hold ends 20 s after the shot's planned end at the latest, so a busy base cannot keep the camera forever. A bubble pinned to the edge for a point off screen does not count.
- **Cuts calmer.** A merely better calm shot may replace the one on screen only after 5 s (it was 1.5 s), and the calm shots (establishing, economy, following, scouting, overview and the rest) run about a third longer. Battle shots keep their pace.

## Build 983: the damage wave every second (27 September 2026)

**No rules change.** The red damage wave now fires on hits, at most once per ~35-unit patch of map each second. It used to fire at most every 5 s. Every hit asks for a wave (the renderer's hit flash), and the cooldown lives in the renderer, so `game.js` and the rules hash are unchanged. The old 5-second call from `notifyCombat` passes through the same cooldown, so the two never double up. On Platform the viewer's forwarded hit flashes take the same path.

## Build 982: the damage ping is the age-up wave in red (27 September 2026)

**No rules change.** The ping that marks a hit on a unit or building, the one red ring the map drew, is now exactly the age-up wave in red: the same ring, the same 2.4-second pulse out and fade, the same reach. For a building it starts from the walls. It replaces both the flat ring and build 980's smaller glow.

## Build 981: a battle wave on a building starts at its walls (27 September 2026)

**No rules change.** A battle ping is placed at the attacked target, so for a building it sat at the centre, and the first half of the wave ran inside the walls. The wave now starts at the building's footprint and runs out from there, with its inner ring trailing it from the walls as well. Pings in the open are unchanged.

## Build 980: a red battle wave; thinking on the broadcast cards (27 September 2026)

**No rules change.**

- **Battle ping:** where fighting starts, a red wave now runs out and fades, in the style of the age-up wave: a glowing ring with a warmer one inside it. It replaces the flat textured ring. It still shows through the fog, in every lighting style, and is a still glow with reduced motion.
- **Broadcast cards:** a seat whose model is thinking shows the leaderboard's pulsing green dot at the bottom right of its card. The pulse keeps its phase across the board's once-a-second rebuild.

## Build 979: Re-Simulate follows the match; one row of results buttons (27 September 2026)

**No rules change.** The Re-Simulate mode of the transcript analyzer, and the results screen:

- **The decision follows the world.** While the replay runs, the list, the detail panel and the timeline show the latest decision played by the current step. Each recorded answer is matched to its turn by seat and turn number. Before, they stayed on the first entry.
- **One timeline.** The timeline slider moved from the settings row to its own bar above the lists, the detail and the charts it steps through. In Re-Simulate it drives the replay: picking an entry there, in the list, or with the step buttons seeks to the step where that decision was played. The replay's own slider is gone.
- **Auto camera in Re-Simulate.** The chip is in the replay's bar. It aims at each decision as it is played, as in the snapshot mode.
- **Seeking.**
  - A long seek reports how far the rebuild has got.
  - Seeking backward keeps the current picture on screen until the replay reaches the new step; it used to clear the map.
  - After a seek, the replay plays on at once. The playback target used to grow while the worker was busy, so it then asked for everything played "meanwhile", which was a second freeze.
  - Seeking backward still replays from the start, so it takes as long as the replay needs to get there.
- **Daylight.** The analyzer's light follows the match clock at the moment on screen, in both modes. Its own day clock does not run, so the stage used to keep whatever light the last match had left, often night.
- **Epochs.** Buildings and units follow the age-ups: the replay's scene carries each building's age, and the stage restyles a building when it changes, as the live game does. A unit upgraded to a new tier is rebuilt as its new type. Before, each kept the look it had when first seen, so stone- and iron-age buildings stood side by side.
- **Results screen.** Every button in the bottom row has one size and one baseline, and the captions export is framed as one control of the same height. The menu styles the buttons borrowed set a 300 px minimum width and pushed half the row 18 px lower.

## Build 978: every bubble on screen, at the edge it comes from (27 September 2026)

**No rules change.** A bubble whose point is out of view now rests on the edge of the screen in its direction: left and right as before, and now also the top and bottom. A point behind the camera goes to the bottom edge on its side. Bubbles that pile against the top edge stack downward rather than off the screen. A seat acting out of shot is still heard from.

## Build 977: longer world time per round (27 September 2026)

**No rules change.** The lockstep setting ("world time per round") offers 30, 45 and 60 seconds as well as 1 to 20. The game already accepted slices up to 60 s; only the choices were missing.

## Build 976: smaller strategic flags, softer lines (27 September 2026)

**No rules change.** The strategic map's flags are 20 % smaller again, and their lines, with their shadows and foot dots, are drawn at 50 % opacity.

## Build 975: edge bubbles, true scout targets, a bank line on the broadcast cards (27 September 2026)

**No rules change.**

- **Bubbles at the screen edge:** a bubble near an edge used to be squeezed into a column of single words. It now keeps its width, sized to its text up to 260 px, and rests against the edge.
- **Scout targets:** an explore names a tile, and the harness sends the scout to the least-seen walkable part of it. The ring was drawn at the tile's centre, so it did not match where the scout went. Once the harness has answered, the ring and its bubble move to the scout's real target. The answer names the unit it sent, and that unit carries the target. A path is drawn from the scout when the order named none. A refused explore keeps its tile.
- **Broadcast cards:** each seat card has a second line: the civilization and the resources in the bank.

## Build 974: a scout sent this turn stays sent (27 September 2026)

**A rules and harness change.** Take a worker an explore sent earlier in the same turn. A later command of that turn no longer takes it back:

- **Gathering:** `assign_workers` without `from` no longer picks it.
- **Farms:** manning farms no longer picks it.
- **Building:** a builder is no longer borrowed from it (`pickBuilder` takes a `skip` test; only the harness passes one).

**Why:** the explore had already answered "OK - Sent your worker #N". Taking that worker back one command later meant the log showed a scout that never left. Replaying the saved matches of 27 September found this once (turn 21, 20:14 match). The default triage took "1 from wood, 1 scouting", and that scout had been sent one command earlier. A second explore already refused a worker sent earlier in the turn; now every command does.

**Unchanged:** a scout sent in an earlier turn is still the last resort it was.

**A new refusal:** when only this turn's scouts are left, the refusal says so, instead of blaming builders and fighters. Its code, `noWorkersScouting`, counts as a constraint in the Bench taxonomy, like `assignIdleTaken`: the seat sent that scout itself and could have counted.

**Unaffected:** the golden traces never hit this case, so they are unchanged.

## Build 973: arrows to the end, bubbles along the path, flags that glide (27 September 2026)

**No rules change.**

- **Arrows:** the dashed path to a target is drawn to its end, however long. It stopped after 90 dashes (about 200 units), so an arrow followed by the camera ended in mid-field. Only the dashes in view are drawn.
- **Bubbles:** when a target's ring is out of view but its path is not, the bubble slides along the path to the point nearest the centre of the view. A camera following the units, or cutting to part of a long march, now shows what they were told and why. Before, the bubble waited at the destination.
- **Flags:** an army's flag on the strategic map follows its units every frame. It was placed at the group's centre, recomputed four times a second, so it jumped after a marching army.

## Build 972: bubbles no longer cover each other's reasons, and name what they show (27 September 2026)

**No rules change.** Bubbles over nearby rings were stacked only when they stood within 150 px of each other sideways, but a bubble is up to 260 px wide. Two bubbles 150 to 260 px apart overlapped, and the later one hid the earlier one's reason. Stacking now counts each bubble's full width. The page also re-stacks with the sizes the bubbles were actually drawn at, instead of the estimate.

- **Commands without a reason:** their bubble names the command the way the decisions log does, with its detail. For example "🔁 Workers reassigned (Wood)" instead of "assign workers". The log and the bubble share one function for this, so they match in every language.
- **Strategic flags:** 80 % of their previous size, at 80 % opacity.

## Build 971: green when on, and a way out of broadcast mode (27 September 2026)

**No rules change.**

- **Intent and Broadcast buttons:** they turn green while on, like Speed and Auto. Intent is no longer dimmed while off.
- **Broadcast mode:** the broadcast button sits at the right end of the top scoreboard, green, across from the clock. One click turns broadcast mode off. It replaces the faint button in the corner.
- **Scoreboard layout:** the broadcast scoreboard now uses the full width. It was capped at half the screen and wrapped early.

## Build 970: smaller, quieter flags; parchment bubbles (27 September 2026)

**No rules change.**

- **Strategic flags:**
  - The line is half as long (50 px).
  - The flag is two-thirds the size.
  - The cloth is 20 % darker, because it is unlit and outshone the lit world, and drawn at 90 % opacity.
  - An army's military icon moves to the flag's upper-left corner, so it no longer covers the seat badge.
- **Decision bubbles:**
  - Parched parchment at 80 % opacity, with black text at full opacity.
  - Instead of an outline in the seat colour, a band in the seat's badge colour marks the left edge.

## Build 969: in turn-based matches, bubbles wait for the round (27 September 2026)

**No rules change.** In a turn-based match, a seat's rings and bubbles used to appear as soon as its model answered, before the round was played. Now they appear only when every seat has answered and the round fires, together with the decisions log and the captions. An answer the round drops is never drawn. Real-time matches are unchanged.

## Build 968: flags on the strategic map (27 September 2026)

**No rules change.** At wide zoom, Town Centers and armies now carry flags instead of bare badges.

- **The marker:** a white line rises at 45° from the Town Center or the army, 100 pixels long. At its end is the seat's flag.
- **The flag:** it is the flag from the seat's flag poles: the same cloth, colour and badge, baked from the same canvas. It folds with the same wind as the cloth shader, and only when graphics quality is High, like the 3-D flags.
- **Armies:** their flag adds the military icon used everywhere else (⚔️) over the badge. The unit count sits beneath the flag.
- **One size:** every flag is the same size. The count already says how big an army is.
- **Reduced motion:** with reduced motion switched on, the flags hold still.

## Build 967: a bubble for every ring, and a tidier spectator bar (27 September 2026)

**No rules change.**

- **A bubble for every ring.** Each target ring now has its own bubble, standing on the ring. It shows the reason that command gave, or names the command if it gave none. Before, a turn had one bubble, which carried only the first reason. Bubbles over nearby rings stack instead of covering each other. A turn that gives a reason but points nowhere shows that reason once, over its Town Center.
- **One button for the story layer.** The Intent button now also switches the match captions; the separate CC button is gone.
- **Button order.** The spectator bar now reads: Help, Speed, Auto, Intent, Broadcast, Results, Quit.

## Build 966: spectator fixes from the first test round (27 September 2026)

**No rules change.** Nothing a match does or tells a model is different. This build changes only what a spectator sees.

- **Decision marks lie on the ground.** A model's target is now a ring laid on the terrain, in perspective, like a selection ring. A dashed path leads to it from the units that were ordered. A refused order is a grey ring with a cross.
- **No mark without its bubble.** A seat shows one turn at a time: a new turn replaces the old marks and bubble together. A turn that points somewhere but gives no reason gets a bubble naming its commands (in italics).
- **One fade for all bubbles.** Every bubble holds for 6 to 11 s, longer for a longer reason. Then each fades over the same last 1.2 s.
- **Strategic pips.** At wide zoom, Town Centers and armies now show each seat's real badge, the fill and rim from the leaderboard. A base sits on a dark disc.
- **Settings order.** Graphics quality now lists High first, like the lighting list.
- **Controls card.** The card now lists M (mute and unmute).

## Build 965: Fire Arrows (27 September 2026)

**A rules change.** Every civilization gets a new academy technology in the Iron Age:

- **The tech:** Fire Arrows (Feuerpfeile), costing 50 food, 100 wood, 80 stone and 100 gold, researched in 30 s.
- **What it does:** ranged units deal 30 % more damage to buildings. Their building multiplier goes from 0.5 to 0.65; damage against units is unchanged.
- **How it looks:** once it is researched, arrows shot at buildings fly with a small flame at the tip.
- **Models:** they see it in `research.available` like any other tech, with its name and effect.
- **Rule-based players:** they may research it too. It sits last in every tree, so their earlier priorities are unchanged. The golden traces are unchanged, but anchor calibrations that reach the Iron Age with an academy may shift.
- **A bonus reset:** the human player's owner-held tech bonuses are now reset at every match start. This covers Fire Arrows, and also the temple's heal bonus, which used to carry over from one Campaign match to the next in the same page.

## Build 964: sound without the freeze, and an age-up wave (27 September 2026)

No change in what happens in a match or what a model is told.

- **No freeze on unmute:** turning sound on no longer freezes the page for about 3.4 s. Previously all 116 sounds were synthesized on that click. Each is now made the first time it plays, or in idle time, from the exact random state it used to start from. Every sound is sample-identical to before, and `tests/audio-lazy.test.cjs` checks it. The wind and fire loops start a moment after the click.
- **Announcements:** they play their four variants in turn instead of always the first.
- **New sounds:**
  - an age-up stinger;
  - in Campaign, a low horn when your own units or buildings are actually hit (at most once in twenty seconds; a sighting is not an attack).
- **Footsteps habituate:** a long march grows quieter, down to half, and recovers after a few seconds of quiet. Work sounds and everything else are unaffected.
- **Volume:** work sounds and footsteps have their own sliders (default 100 %, so the mix is unchanged). The speaker shows a cross while muted, and **M** mutes and unmutes anywhere except while typing.
- **The age-up wave:** when a seat reaches a new age, a golden ring runs out from its Town Center (Atmospheric and Cinematic lighting; a still glow for reduced motion).

## Build 963: the strategic zoom layer (27 September 2026)

No change in what happens in a match or what a model is told.

In the arena, zooming far out brings up a strategic layer. It fades in between half-heights 90 and 140, and is absent up close. It shows:
- a pip on every Town Center, in its seat's badge;
- each seat's fighting units gathered into groups, drawn as the seat's badge with the number of units in it (workers are not an army);
- a marker on every battle still being fought, taken from the battle ledger and gone once the fight has been quiet for ten seconds.

It uses the seat-true colours of build 962. It only reads the match and is regrouped four times a second.

## Build 962: seat-true colours (27 September 2026)

No change in what happens in a match or what a model is told. The fingerprint's core hash moves anyway, because the minimap is drawn in `js/game.js`. Results before and after are comparable in play, but the re-simulated replay (build 954) offers itself only to recordings made under the same core hash.

A seat still wears its civilization's colour when every civilization in the match is different. Once two seats share a civilization, every seat wears its seat badge's colour instead. The badges are the one palette made to be told apart, and a civilization's own colour could otherwise sit beside a badge's, such as Persian tomato next to seat 2's red. Seat 0 wears charcoal, since its white badge reads as undyed cloth.

These places all use the same helper (`js/identity.js`), so they cannot disagree: units, buildings, the minimap, the leaderboard and its flyout, the status bar's Wonder line, the inspect card and the results. The analyzer colours a recording by that recording's own seats.

## Build 961: strike-synced combat (27 September 2026)

No change in what happens in a match or what a model is told; the rules deal damage exactly as before.

- **The swing is the damage:** a fighter in range now swings on the rules' own attack timer. It winds up slowly and strikes fast, and the blow lands at the moment the damage is dealt, once a second.
- **Cavalry** draws the spear back and thrusts home on the blow.
- **Archers and crossbowmen** hold the bow arm on the target, draw through the cycle and release on the shot.
- **Priests** raise both hands while a heal is actually running.
- **Walking:** the stride follows the ground a unit really covers, so feet no longer skate.
- **Analyzer:** the snapshot view holds a single frame; the re-simulated replay animates, with its swings synced to the replayed attack timers.

## Build 960: a Cinematic lighting style (27 September 2026)

No change in what happens in a match or what a model is told. The lighting menu (camera options) now offers three styles: **Cinematic**, **Atmospheric** (the previous default, still the default) and **Simple**. The choice is remembered.

Cinematic is Atmospheric plus:
- **A minimal bloom:** a soft halo on the brightest parts of the picture, a little stronger at night. The finished frame is copied with its antialiasing intact, its bright parts are blurred at a quarter of the resolution and added back. It comes after the fog, so hidden ground cannot glow, and before the health bars, so they never do.
- **Burning buildings:** below 70 % health a building smokes, below 45 % it burns, below 20 % it blazes, with embers. Flames sit at fixed places on the roof, on the side facing the camera, and light the walls around them. At most twelve buildings burn at once, and only where the viewer can see.
- **Rubble:** soot and stones stay where a building fell. It smoulders at first and fades over three minutes of match time.

A viewer whose system asks for reduced motion gets steady flames and no embers.

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
