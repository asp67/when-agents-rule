# Rules changes

A rules change alters what happens in a match: who wins a fight, how fast an economy grows, or what a model is told. Results from before and after such a change are not comparable. The contract fingerprint recorded in every transcript already separates them, because it hashes the simulation sources and the harness. This page says what changed, and why.

Most entries come from the determinism work: making a match replay exactly from its seed and its commands. Each step changes rules on purpose, and the golden traces in `tests/sim/` are re-recorded with it.

Newest first. The build is the `?v=` number on `js/game.js` in `index.html`.

## Build 1139: an MCP seat that is paused hears so; one whose harness stops calling no longer holds up the rounds (28 October 2026)

**Rules change.** Two edge cases from asp67's match of 28 October (14:44), both with OpenCode:

- **A seat the user pauses.** Its harness was told nothing and polled "not your turn yet". A turn open at the moment of the pause stayed open: the harness's commands were answered "Queued … runs when the round closes", and none ran, since a paused seat is not settled and its answer is cleared on resume. **Now** pausing an MCP seat closes its open turn (cancelled by the harness, not counted against the model) and its hub answers every call with "Your seat is paused by the user: the match goes on without you, and nothing you send now runs. Call wait_for_turn: it hands you the next turn once you are resumed." Hub 0.3.1.
- **A harness that stops calling** (OpenCode ran into its token limit): every round waited the full 120 s for it, six rounds in a row. **Now** an MCP seat whose harness has made no call to the hub for longer than a round is **away**: it is not asked, the round does not wait for it, and each such round counts as missed, with "[AWAY] Your harness made no call to the game for longer than a round …" on file and in its next turn. Its harness's next call brings it back for the next round. A seat with a turn still out is never away: that turn ends by its deadline as before.
- **The results** leave the time a seat was paused out of its silence: OpenCode, paused for most of its last nine minutes, was "silent for the last 9 min".
- **Tests:** `tests/mcp-pause-away.test.cjs` (fails on b1138), `tests/mcp-hub.test.cjs` (a paused seat).

## Build 1137: explore with a named unit type sends that type or nothing (28 October 2026)

**Rules change.** An `explore` naming a `unitType` with none of that type free this turn used to send whatever stood idle and say so in brackets ("no idle "scout_cavalry" was free, so your champion was used instead"). Hermes wrote it into its own playbook as "the expensive one": its champions and crossbowmen walked off the line to scout. The harness was replacing the model's choice (asp67: refuse, send nothing).

**Now** a named type that the seat has none of answers `You have no "<type>" to explore with, so nothing was sent`, and one whose units are all scouting already this turn answers `Every "<type>" you have is already scouting this turn on an earlier command, so nothing was sent`. An `explore` naming no type still sends the farthest-seeing free soldier, as before.
- **Tests:** `tests/explore-named.test.cjs` (fails on b1136).

## Build 1136: units, towers and trebuchets carry their reach; the unit catalog carries the stats (28 October 2026)

**Rules change** (what a model is told; no rule of the game changed). In asp67's match of 28 October Hermes won its siege with trebuchets and quoted their reach as 80: the state carried no range for any unit, tower or trebuchet, and the trebuchet's 50 and 60 were only in the system prompt. asp67: the model should know what it has at its disposal.

**Now:**
- **"reach"** (how far it shoots, a priest: heals; only for a range of 3 or more, so melee carries none) on every unit in `friendlyUnits` (its own, research included), on every unit in `enemyUnits` (its type's reach for its owner's civilization; the owner's research is not visible), on towers in `friendlyBuildings` and `enemyBuildings`, and on the tower and both trebuchet sites in `buildings` (the engine the site becomes).
- **The unit catalog** (`units.trainable`, `units.blocked`) carries what a unit of that type trained now would have: `hp`, `attack`, `reach`, `sight` and `speed` (a worker is 1.0, the scale the trebuchet sites already used), from the civilization's definition with the seat's researched bonuses, as a unit gets them at spawn, and the sight the game gives it.
- The system prompt names the fields (`agents-rule-v112` → `agents-rule-v113`), and `game-state-schema.json` lists them. Its `enemyUnits` description still said "units currently in your sight, old positions are not kept", wrong since the unit memory of b1068: it now describes the memory.

## Build 1135: the system prompt says exactly when a remembered unit leaves enemyUnits (28 October 2026)

**Rules change** (what a model is told; no rule of the game changed). The prompt said a remembered unit "leaves this list when you look at its spot again and it is not there". The rule (`sweepUnitMemory`, since b1068) drops it only when its spot **has been out of the seat's sight and is then seen again** without it. A unit walking out of sight leaves at the edge of the seat's vision, so its spot usually stays in view, and it stays listed where it left, by design: that and `sightedAt` are what a seat extrapolates from. The sentence promised the opposite. In asp67's match of 27 October Hermes marched onto such a spot, found nobody, saw the archers still listed there, and concluded the listed position was a projection.

**Now** the sentence states the rule: "A remembered unit leaves this list when its spot has been out of your sight and is then seen again without it." Nothing else is added: what follows from it is the model's to work out (asp67). Prompt `agents-rule-v112`.

## Build 1128: trebuchets roll at 0.25 and 0.5 (27 October 2026)

**Rules change.** asp67: the trebuchets "take too long to traverse the map in a wonder scenario". A seat can build one at a staging point instead, so the faster pace is for engines left somewhere on the field when a Wonder goes up.

**Now:**
- `simple_trebuchet` rolls at 0.25 (was 0.16) and `advanced_trebuchet` at 0.5 (was 0.32). At the game's 3 map units per second for speed 1.0, that is 0.75 and 1.5 units a second: a quarter and a half of a worker's pace. The advanced engine stays twice as fast as the simple one.
- A formation with a trebuchet marches at its pace as before, so an army with a trebuchet now moves 56% faster.
- The unit and site descriptions say the new speeds, in all four languages. The system prompt does too (`agents-rule-v111`).
- **Tests:** `tests/trebuchet.test.cjs` checks the new speeds and the march pace they set.

## Build 1113: a formation standing for its trebuchet forms up without twitching (26 October 2026)

**Rules change.** asp67, with a screen recording of a running match: "Simple trebuchet catching up to the formation leads to this" -- a wedge whose soldiers twitch on the spot.

**What happened.** Replayed in asp67's match of 26 October (13:11), 48:50: a Greek wedge standing for its simple trebuchet, 18 behind. In one second ten of its twelve soldiers flipped between the standing and the walking pose 73 times. While a body stands for a trebuchet, a member within one rank of the lead stands and one further back walks in on b1110's ramp; a member walking in stopped as it crossed that one line, and its neighbours' separation nudged it back over, so it walked again: every step or two.

**Now** the line has slack: a member walking in stands once within half a rank of the lead, and one standing walks again only from two ranks back (`FORMATION_CATCH_UP`), more than a separation nudge moves it.

- Headless, a wedge forming up with its trebuchet 12 behind: 33 pose changes by 6 soldiers in one second before; now each soldier changes once, from walking in to standing.
- **Tests:** `tests/trebuchet.test.cjs` forms a wedge, a block and a line with the trebuchet behind; no member may change pose more than twice in 8 s, and all stand at the end. Fails on b1112.

## Build 1112: a building nobody is left to build is blocked by "builder" (26 October 2026)

**Rules change** (what a model is told). asp67: "seats that do no longer have a towncenter or villagers keep trying to build structures. I am assuming that the block condition does only include the necessary material but not the worker that is needed to build one?" It did: a building was listed as buildable by age, tech and cost, never by whether anyone could build it, and the seat learned otherwise only from "You have no workers to build ..." on every try.

**Now:**
- With no living worker, every building a worker builds, the Wonder included, carries `"builder"` in its `blockedBy`. A trebuchet carries it while the seat has no living engineer (only an engineer builds one).
- `"builder"` is a structural gate, like age, tech, host and alreadyBuilt: the entry moves to `buildings.blocked`. Workers or an engineer that are only busy do not block it; the executor's reply still says when none is free.
- The system prompt names the code (`agents-rule-v110`), and `game-state-schema.json` lists and explains it.
- **Tests:** `tests/builder-block.test.cjs`: with workers a tower is buildable and the trebuchet blocked by builder (no engineer); with none left the house, Town Center, tower, temple and Wonder are blocked by builder. Fails on b1111.

## Build 1111: a builder goes round a house between it and its site (26 October 2026)

**Rules change.** asp67, during the match of 26 October (11:37), with screenshots: two, then four workers "stuck at the edge of a building", "twitching front and back".

**What happened.** Replayed to the end of the saved match: four workers (two Roman, one Greek, one Egyptian), each sent to build, stood 3.66 to 3.69 from one of their own houses, inside its 4.5 clearance ring, walking 6 to 12 units in 10 s and getting nowhere. A builder walks straight at its site (State 4 in `updateWorkerTasks`), but b1110's push round a building read the unit's `targetX` to know where it was going, and a builder's `targetX` still held an old job's destination. Pointed elsewhere, the push did not fire, and the walk at a site behind the house and the push out of the ring cancelled, as before b1110.

**Now** the push reads where a unit really walks: an attacker its target, a builder its site, a repairer the building it mends, any other unit its move target.

- Headless, a worker sent to build a site behind a house, its old `targetX` pointing elsewhere: 2 of 60 stuck at 3.73 before, none now. Walks through the gap between two houses: none of 252 stuck, as with b1110 (25 before b1110).
- **Tests:** `tests/position-rules.test.cjs` adds the builder (fails on b1110). The economy golden `opening-economy` is re-recorded: the Persians have their seventh building up by 3:30, and a little less in stock after; the combat goldens are unchanged.

## Build 1110: no towers at an enemy Town Center, the trebuchet, and construction you can see and stop (23 October 2026)

**Rules change.** asp67, on the match of 23 October (Qwen3.8 Q2 against DeepSeek V4.1, build 1109): "While this is a smart approach, it is inherently unfair."

**What happened.** The Greeks walked a chain of 19 towers across the map, each going up within the cover of the last, and raised the last two 12 and 13 from the Egyptian Town Center. Replayed exactly:
- In the last quarter Greek towers killed 28 Egyptian workers, almost all at their own Town Center.
- Units from the Egyptian archery range "spawn under tower fire and die before they can act" (DeepSeek's own words).
- Egyptian food stayed between 0 and 95 for the last 15 minutes.
- Over the match, Greek towers killed about 161 Egyptians, more than all Greek units together (about 150).

Why it was unfair rather than strong:
- A tower went up in 12 s, inside one of the defender's 31-second turns.
- It could be placed anywhere.
- A site's damage was put back by its builder's next swing.

**Now** (asp67's rules):
- **No tower within 200 of an enemy Town Center, on that Town Center's side of the map.**
  - "Its side" means the spot is nearer that Town Center than any of the builder's own. A forward Town Center therefore cannot be planted to deny the other side towers at home.
  - The model is told why ("No tower may stand within 200 of an enemy Town Center on its side of the map."), and nothing is spent.
  - The rule applies to every seat: model, human and rule-based.
- **A tower takes 20 s to build** (it was 12).
- **A building still being built shows it.** Enemy buildings in the state carry `"state": "under_construction"` and `"buildPct"`, as last seen. Before, only Wonders did.
- **Damage to a site stays.**
  - A site's health now grows with the work, from 20% to full. It used to be lifted onto that curve every step, so a site with a worker on it could not be damaged at all.
  - A site finishes with the damage it took; an undamaged one finishes at full health, as before.
- **The trebuchet.** Siege Engineering is researched at the academy in the Bronze Age (150 wood, 100 gold; every civilization). It unlocks the trebuchet, a building a worker builds in 20 s.

  | | Simple (`trebuchet`) | Advanced (`trebuchet_advanced`, from the Iron Age) |
  |---|---|---|
  | Cost | 100 food, 200 wood, 100 stone, 50 gold | +20% (120, 240, 120, 60) |
  | Health (flat, no age or civilization multiplier) | 200 | 400 (both doubled from 100 / 200 by asp67) |
  | Range | 50 (a tower: 18; 27 until asp67 widened it, see below) | 60 (32.4, then 70, before) |
  | Damage | 150 every 6 s | 200 every 6 s |
  | Watch | 120 | 144 |

  - It throws only at the nearest enemy tower or tower site in reach: never a unit, never another building, never the worker building a site.
  - A loaded engine waits loaded, so a tower begun in its reach is hit at once.
  - It sees 20 around itself, and 20 around each enemy tower within its watch, and nothing else of what lies between.
  - It is never upgraded on age-up.
  - A hit on a tower is the tower owner's alarm like any other, so local soldiers ride out at the engine. Units are its counter; towers cannot reach it.
- **Trebuchets roll, and engineers build them.**
  - asp67: "The later variant has wheels, let's make it movable."
  - Then, after seats kept waiting for a standing engine to move: "add wheels to the simple trebuchet and let it move at the speed of the advanced trebuchet and double the speed of the advanced trebuchet."
  - A finished trebuchet site rolls off, where it stood and with the damage the site took, as a unit on wheels:
    - `simple_trebuchet` at 0.16, a fifth of the slowest unit;
    - or `advanced_trebuchet` at 0.32, from a `trebuchet_advanced` site.
    - asp67 doubled both speeds after testing (from 0.08 and 0.16).
  - In the Iron Age the seat chooses per build (asp67: "a basic trebuchet is cheaper and might be the better choice in some occasions"). The site's type decides the engine, never the age, and Siege Engineering unlocks both. The advanced site needs no research of its own.
  - Both join move orders and formations, taking a ranged slot. They throw only while they stand, and stay loaded while they move.
  - They have no attack of their own, so they never fight, and auto-defense never drafts them.
  - They take no population (decided by asp67). Engineers and workers repair them; priests do not heal them.
  - No tech reaches them, and they keep no seat alive. Their watch rides with them.
  - A move or attack order that names no units leaves them behind, as it leaves workers: at 0.16 they would hold any army they were swept into to a crawl. Named by id or type, they go.
  - attack_target naming only trebuchets is refused with what a trebuchet does instead.
  - The speeds are in the prompt, in the unit descriptions, and in the buildable entry (`becomesUnit`, `speed`).
- **The engineer** (asp67: "a weak melee fighting class but can build trebuchets ... a part of the natural formation").
  - Siege Engineering's description now says it "allows training engineers, who can build trebuchets".
  - The engineer: 50 food and 20 wood, a militia's price; 1 population; 50 health, attack 4, speed 1.0. It cost 50 food, 30 wood and 20 stone until asp67 cut it ("since so many engineers die to towers since seats need to learn how to build the trebuchet building site somewhere with a safe approach, let's remove the stone cost from the engineer and make him the same price as a militia").
  - It is infantry, so it fights, takes infantry techs and counts as military, and marches in the rear ranks with the priests.
  - It is the only builder of a trebuchet ("can build and repair trebuchets on site": its description, its prompt line, and a `role` in the model's trainable entry).
  - build_structure sends the nearest free engineer. It leaves its formation, builds, and walks back to its slot; while away, its formation neither fights with it nor waits for it.
  - Without one: "only an engineer builds a trebuchet ... Train one at the academy". A villager never builds a trebuchet, nor takes one up as an orphaned site.
  - Engineers and villagers both mend trebuchets.
  - Its model: a team tabard under a leather apron, a mallet in hand, a beam on the back.
- **A formation besieging a tower with a trebuchet does not charge it** (asp67: "make sure that until the trebuchet is destroyed, the formation does not charge into the tower to be annihilated"; "the soldiers need to stand at the trebuchet to defend it").
  - While an attack order's target is a standing tower and a trebuchet of the group lives, the group forms up around its trebuchets. That is at least 6 beyond the tower's reach, on the line from where the order started. Each trebuchet takes a slot 2 inside its own reach.
  - No member takes a tower as its target, and a tower's arrows send nobody at it. Mobile attackers are answered as ever, and the trebuchet is a member, so attacks on it are answered by the soldiers around it.
  - With the trebuchets gone, the order is the tower again, and the group goes in from the stand-off.
  - A tower target is now followed whether seen or not: it stands still, and it shoots farther (18) than a soldier sees (15).
  - The prompt says so.
- **A trebuchet site no one has worked on is unseen by the enemy** (asp67, watching one seat destroy the other's sites again and again, a 20-health site dying before its builder arrived).
  - Until the first swing it is in no other seat's state, so it cannot be named for attack_target, even by a guessed id.
  - It is not picked by their soldiers or their attack orders passing by ("make sure that an attack order in the vicinity does not attack the building site coincidentally").
  - It is not in their contacts, and not in the human player's fog.
  - From the first swing it is a site like any other, and can be fought.
  - Spectators see it throughout.
- **A stone does its damage where it lands** (asp67: "the tower registers the damage at the moment the boulder leaves the trebuchet not at the moment it hits the tower ... the trebuchet could be destroyed in between so it still needs to register").
  - A throw puts a stone in the air.
    - It leaves the sling 0.38 s into the swing.
    - It flies max(0.6, distance/24) s at the normal speed. That is 1.5 times the first boulder's pace, as asp67 asked.
  - The stone's damage, the tower owner's alarm and any kill credit all come when it lands.
  - It lands even if its trebuchet was destroyed meanwhile, credited to that engine. On a tower already fallen it lands on nothing.
  - The drawn boulder flies on the same simulation clock, so it touches down on the damage's tick and stops when the game is paused.
- **The throw is drawn** (presentation only; asp67: "Trebuchet is shooting an arrow, not a stone ... The arm of the trebuchet is not moving"). A trebuchet rests cocked: counterweight up front, the arm down and back, the stone in its sling on the ground behind. When it throws, the arm swings up and over the axle; the stone leaves the sling near the top as a round boulder on a high arc, and the arm sinks back to reload, with the stone back in the sling once it is down.
- **Both engines turn to their target as units do.** The rules record what each aims at; the renderer turns it with the units' steering rule. Each carries its flag on the front-left of its frame, so the flag turns and travels with it. The axle is in the owner's colour, and the ground runner other buildings carry is gone.
- **Info cards.** A clicked building now shows:
  - for a site, how far along it is;
  - for a tower, its volley and range;
  - for either trebuchet, its engine, throw, range and watch.

  Before, every building card showed only a name and health.
- **Defenders go home** (asp67: "retaliating units need to return to their origin from where they started the retaliation after eliminating the threats, except if an order has changed their target location").
  - A soldier drafted by auto-defense remembers where it stood, or where it was walking to.
  - When the threats are gone it walks back there. It used to march on to the rally point at the attacker's position and stay.
  - A new order in between (a standing order, or any order that re-tokens it) cancels the return.
  - Workers already went back to their jobs; formation members already go back to their slots.
  - An engineer attacked at its trebuchet goes back to the job instead (asp67: "after retaliation, the engineer needs to return to building the trebuchet"). The draft used to clear its job, so after the fight it stood idle by an unfinished site. One marching in a formation already took its job up again.
  - An engineer is no longer flagged as building while it fights or once it is off the job (asp67: "it is literally standing in the open still showing the building animation 60 units away from the build site"). The flag drives the building pose, and nothing cleared it.
- **Formations catch up the right way round** (asp67: "unit approaching formation ---> <--- Formation: neither should slow down; only when <--- moving formation <--- unit approaching formation, the formation needs to be slower than the approaching unit").
  - A member already past its own slot, walking back to meet the body, was taken for the formation's lead. It was held to 60% of the pace while the whole body was released to its members' own speeds, out of step.
  - Now it walks at its own speed and slows nobody.
  - A member catching up from behind finds the body at 60% of the slower of the march's pace and its own speed. One slower than the pace (it joined later) never closed the gap before.
- The rule-based seats do not research Siege Engineering (they build no trebuchets), and they obey the tower rule.
- "Explore Civilizations" shows the simple engine on wheels in the Bronze Age, and both side by side in the Iron Age, plus the engineer in the roster.
- **From asp67's 4-seat match of 23 October (22:12, Egypt's Wonder at 93 min):**
  - **A trebuchet site is never left without an engineer.** A Viking site stood at 86% for the last 45 minutes after its engineer fell, showing 1 s to go, while a newly trained engineer idled 25 away.
- **Battles and lost buildings stay in the state for two minutes of match time** (asp67's match of 24 October). The window was counted on the simulation's clock, which runs ahead of the match's: about 3.7x at 2x speed there, so a fight was dropped 33 s after its last blow. Replayed exactly, the Greek simple trebuchet killed by a Maya tower and the Viking one killed by Greek militia were both recorded, and both dropped before their owners' next turn, 50 s later; neither owner was ever told. Any fight that ended early in the gap between two turns went the same way, trebuchet or not. `recentLosses` (lost buildings) had the same fault. Both now count match time. With entries living as much again longer at speed, the cap on battles held at once goes from 8 to 16.
- **Any formation with a trebuchet leaves towers to it** (asp67, on the match of 24 October, 23:14: "formations charging the tower when the treb is ordered to attack"). The stand-off held only an attack aimed at a tower by its id. An attack-move to a point 25 from a Greek tower, three advanced trebuchets in the group, was shot at, and the whole group charged the tower and died at its foot. Now, while a trebuchet of the group lives, no member takes a tower as its target or answers one, whatever the order; members in a tower's reach take its arrows. With the trebuchets gone, towers are fought as before.
  - The reply to attack_target on a tower with trebuchets in the order said "engaging ... they are already in contact range" while the army stood off. It now says they stand off out of its reach while the trebuchets throw, and attack it once the trebuchets have fallen.
- **Trebuchets reach 50 and 70** (asp67: "the defence draft allows for 50 unit range of a simple trebuchet, and 70 for an advanced trebuchet. that should give some room to fight around the trebuchet and reduce the chaos significantly"). They reached 27 and 32.4: a simple trebuchet stood at 25 from a tower that reaches 18, its soldiers at no less than 24 -- a band of 1 for a formation four ranks deep, against engagement ranges of 48 and 64. Now the engines stand at 48 and 68, the soldiers beside them, with 30 to 50 of room outside the tower's reach; the automatic defence still drafts from 90 round a hit unit. The prompt's siege paragraph gives the new reaches.
- **The advanced trebuchet reaches 60, and a guard defends what is yours round its post** (asp67: "I want units on hold to stay on hold, but units on guard to guard units and buildings. So if we change the range of an advanced trebuchet to 60 it would hold at 58 and be inside the new guards range which I would set to 60. What iron age price buys then is a faster sturdier trebuchet with more time on target until the enemy can retaliate.")
  - Measured headless before the change: four champions on guard or hold beside a tower never answered a trebuchet throwing at it, the simple one at 48 or the advanced one at 68, with targets any or military. Nothing of theirs was hit; a trebuchet has no attack, so it is not military; the automatic defence drafts only units without an order.
  - Now a group on guard, at its post, goes after any enemy unit that has damaged one of its owner's units or buildings within 60 of the post, from within 60 of what it hit, whatever its targets setting. A hit counts for 7 s, longer than a trebuchet's 6 s reload, and the attacker is seen meanwhile. Members answer it from any slot, then return to the post.
  - The distance to the attacker is measured from what it hit, not from the post: a post is seldom on the tower's spot, and an advanced trebuchet 58 from a tower stood 62 from the guards 4 beside it.
  - Hold is unchanged: each unit answers only within 19 of its own spot.
  - The move_units mode description says so for guard. The prompt's siege paragraph gives reach 60.
  - Headless: the guards set off about 8 s after the engine rolls off its site (its first stone lands), kill either engine and are back at the post 30 s later; the tower stands. On hold nobody moves.
  - **Tests:** `tests/trebuchet.test.cjs` adds both engines against guard and hold; without the rule the guard watched the simple trebuchet unharmed (fails). The advanced engine's range assertions are 60.
- **A unit pressed against a building on its way past goes round it, the short way on its own side** (asp67: "did you fix the path quirk?", then on the match of 25 October, 22:00, at 62:16: "a greek Phalanx and Crossbowman get stuck at a tower. One tries to round the tower to the left and one to the right each nudging each other back again in an endless stalemate, preventing the formation from advancing").
  - Building clearance pushes a unit straight out from the building's centre. A unit walking into the ring slid round only by the sideways part of its own step: none for one walking dead at the centre, which stood about 3 from it for good (found in the guard probe: a guard on the far side of its tower never left), and the wrong way for one aimed a few degrees across the line.
  - Traced step by step in the 62:16 replay: both units 3.8 from their own tower, inside its 4.5 ring, each step's walk cancelled exactly by the push. The phalanx aimed 5 degrees to one side of the tower's centre, the crossbowman (on its formation lane) 12 degrees to the other, so each slid toward the other, and their separation held them there for the rest of the order.
  - Now a unit inside the ring, walking into it toward a point beyond the building, is also pushed round it as hard as it is pushed out: on its own side of the line from the building to where it is going, the short way. No unit on the other side of that line takes it, so none cross into each other. Exactly on the line, a fixed side.
  - Only on the way past a building: a unit headed for the building itself (a worker bringing its load to the Town Center) still stops at its edge.
  - The first draft (b1110, the same day) slid only units within about 3 degrees of the centre line; it fixed the dead-centre case and not the pair.
  - Measured: a champion marching through a tower got past after 8.3 s to 5 s from 0.001 to 0.1 off the line, never exactly on it; now in 2.5 s in every case. A guard body of ten around its own tower sent to a post past it: 17 of 36 (12 seeds, three shapes) left a unit at the tower's back with the first draft; none now.
  - **Tests:** `tests/position-rules.test.cjs` marches a champion dead-centre through a tower and 0.3 off it, and sends ten guard bodies past their tower (fails on the first draft). The three combat and economy goldens are re-recorded. The 40-v-40 ends as before. The siege still ends with Egypt out at 70 s, the attackers with one crossbowman and three heavy cavalry fewer. In the economy the Persians have one more research done at 6:00, and a little more in stock.
- **A trebuchet besieges a tower it meets on any move, also on the way to besiege another** (asp67, on the match of 25 October, 22:00, at 72:10: "trebuchet did not stop to attack a tower. I think we should change it so that the attack order mechanic works for move unit orders as well, since a trebuchet cannot really retaliate against a tower", and "If it only stops on towers it already knows when it starts moving, a trebuchet is a waste of resources").
  - Replayed: two Roman advanced trebuchets on an attack_target had taken up the siege of a Greek tower on their way, and marching to its stand-off they rolled past a second Greek tower at 4.7. Once a tower was the order's target, no other was looked for, until it fell.
  - The search was never limited to towers known at the start: it runs every scan, and a tower counts when discovered or in sight, the trebuchet's own tower watch included.
  - Now, on the way to besiege a tower, one nearer the engines that comes within SIEGE_NOTICE (6) beyond a trebuchet's reach is besieged first; the order goes back to the first after it falls, and then to its point (a stack of where to go back to). Once the engines are throwing at their tower, nothing draws them off it.
  - On every move but a scout's: march as before, and guard, hold and patrol while they travel; a guard or hold at its post keeps it. Scout starts no fight.
  - The move_units and attack_target descriptions say so.
  - **Tests:** `tests/trebuchet.test.cjs` adds an attack on a far tower with a second on the way (the second becomes the target and falls first, the trebuchet never in its reach, then the first falls) and a guard move past a tower (besieged, then the order is its post again and the group marches there); both fail on the old rules. The test of a formation that leaves a tower shooting it to its trebuchet now uses a scout order: guard, which it used to escape the siege, now besieges.
- **Formation members catch up on a ramp, not a switch** (asp67, on the match of 25 October, 20:37: "a formation forming close to a trebuchet turns into a jitter dance until they form and stand to wait for the trebuchet").
  - Traced step by step in the replay: a Persian archer marched beside its trebuchet in a body held to 0.096 (60% of the trebuchet's pace, the engine 3.1-3.5 behind, under the 4 that makes a body stand). It stood at the edge of "in place", 1.0 behind the lead; its neighbours' separation shoved it across that line, and it ran one step at its own 1.1 -- eleven times the body's pace -- and was in place again. Every 6 steps (0.3 s), and so did every member near the line.
  - Now a member behind the lead runs at the body's pace plus a share of the difference to its own speed, in proportion to how far behind it is: none at the lead, all of it 2 behind (`Game.FORMATION_CATCH_UP`) and further. While the body stands for a trebuchet, a member within a rank stands with it (a ramp toward a lead that does not move would inch it on for ever); one further back closes on the ramp.
  - Headless, fourteen soldiers marching in a block with a simple trebuchet: 2,983 lurching steps (a step over four times the body's) in 200 s before, none now; the body arrives a little further on. A line had 3, none now.
  - **Tests:** `tests/trebuchet.test.cjs` adds the march (1,244 lurching steps on the old code in 80 s; under 20 required, none now). `tests/standing-orders.test.cjs`: a member 0.02 behind the lead now runs a hair over the march pace (1.006 for one of speed 1.5), not exactly at it. The combat goldens are unchanged.
- **An attack on a tower moves on to the next** (asp67: "a trebuchet with an attack order and more than one tower in sight stops after destroying the first target ... if a tower is destroyed and another is within viewing distance, switch to that tower next"). When the tower an attack_target named falls, a formation with a trebuchet takes up the nearest enemy tower in sight within its trebuchets' watch (120 / 144), as soldiers go on to the next building.
- **A formation with a trebuchet besieges the towers in its way** (asp67, with a screenshot: forty soldiers attack-moved to buildings, "the trebuchet following them even driving through the firing range of the tower. All units kept attacking buildings while being decimated by the tower until finally they turned on the tower"; and "that should also be true when on march, the trebuchet picks up a tower in reach on route ... translating the order to a siege situation until the threat is dealt with and then returning to the regular attack order").
  - On a march (move_units march or any attack_target) with a living trebuchet, a known enemy tower (discovered or in sight) that covers an attack-move's point within a trebuchet's reach, or comes within SIEGE_NOTICE (6) beyond a trebuchet's reach of where it rolls, turns the order into a siege of that tower: the stand-off of an attack on the tower by id, from where the group stands. Once the tower falls the order goes back to its point, or the target it was attacking, and takes up the next tower the same way. Scout, guard, hold and patrol keep to their own rules.
  - While besieging, nothing inside the tower's reach draws a soldier in but what attacks it: in the test the house beside the tower had.
  - The attack-move reply names the tower when it is known at once; ordersInProgress carries "besieging" and "then" while a siege taken up on the way lasts; both tool descriptions say so.
- **Formations with trebuchets march as formations** (asp67: "currently they look like a flock of hooligans not a formation"). Measured headless with nine soldiers and two simple trebuchets:
  - Every trebuchet of a tower siege got the same slot, at its reach minus 2 on the line of approach, which was also the middle of the soldiers' formation: the engines stacked on one spot and shoved the soldiers about. In a plain march they were packed into the archers' ranks at a soldier's spacing of 2, though an engine is several times a soldier's width.
  - The body stopped for a trebuchet the moment it fell half a unit behind its place and set off again a moment later: twelve stops and starts on one approach to a tower.
  - Trebuchets alone in a screen got no slots at all (the 4-seat match of 25 October, 15:44): the screen shape returned early for a body without both melee and shot, before the trebuchets' row was placed, and told the seat "no ranged units, so it is a single rank". It now notes that and goes on, and says nothing when the body is engines only.
  - Now a formation's trebuchets march in a row of their own, SIEGE_SPACING (7) apart, SIEGE_GAP (5) behind its last rank, for all four shapes. At a tower they stand side by side on an arc just inside their reach, and the soldiers form up beside them, level with them and out of the tower's reach plus 6, on the side they already are: the infantry and the engines march abreast and neither passes through the other. The body waits for a trebuchet only once it is FORMATION_SIEGE_WAIT (4) behind, until it is back in place.
- **Replays run at the match's own normal pace** (no rules change). Exact replays of both b1110 matches of 24 October drifted, at steps 117000 and 138400. The live game's normal pace (`Game.NORMAL_SIM_SPEED`) is 2 since build 1020, and the bench realm builds its world at 1. This build added the first rule that reads the constant, the flight time of a trebuchet's stone, so in the replay every stone landed in half its live time and the defenders reacted early. Replayed at 2, every input of both matches re-simulates with every hash matching. `WarResim.spec` now takes the pace from the header (`normalSimSpeed`, recorded from this build on; before it, the Wonder pace, which starts equal to it), and `transcript-replay.cjs` builds its realm at that pace. The in-browser re-simulation was not affected: it loads the game as the page does.
- **A formation waits standing for its trebuchet** (asp67: "the formation walks so slow that it looks comical since they walk even slower than the trebuchet ... would it not be smarter to have the army just stand still until it caught up and then move along with the treb instead?"). The formed-up part of a body eases to 60% of the slower of its pace and its stragglers' speed so they can close up; behind a trebuchet at 0.16 that was 0.1, slower than the engine, and the gap closed at 0.064. With a trebuchet among the stragglers the body now stands until it is in place, closing the gap at its full speed, and then marches on with it at the shared pace. The waiting units are drawn standing, not walking on the spot. Other stragglers are waited for as before.
  - The replies to move_units and attack_target say so (asp67: "make sure the model facing tool reply reflects this"): a paced order with a trebuchet behind the rest adds "The others stand until simple_trebuchet #N has caught up, then march at its pace." Its "~Ns to arrive" was already the whole march, set by the trebuchet as the slowest member.
- **A formation spread over the map fights where its members are** (asp67, the same match, Greek move 136: "only one phalanx was at site and attacked the treb ... While the Maya warrior was standing idle the entire time. Only once the treb was destroyed, it joined the fight").
  - What happened: a Maya champion held at its post 13.5 from a Greek phalanx attacking the trebuchet beside it. Its hold order covered three more units still walking from home, ~700 away. A formation judged "near" from its centre: the centre lay far from the fight, so the phalanx was out of the leash. In the one scan the champion did take it on, the fight's anchor was set to that same centre, the leash measured from there released the phalanx, and the champion stood idle until the trebuchet fell.
  - asp67's guess was close: a hit on any unit, the trebuchet included, is answered by that unit's own formation, by the automatic defence for units on no order, and otherwise only by what another formation's own scan finds near it. That scan was what failed here.
  - Now "near the group" means within reach of its nearest member, and a fight is anchored at the middle of the members near it. For a group standing together both are the same as before: every recorded battle trace is unchanged.
- **Engineers ignore towers** (asp67: "engineers ignoring the towers sounds reasonable" ... "an engineer approaching a formation and taking tower damage must then also not trigger the formation's retaliation. Else the entire formation leaves the build site and charges the tower to get wiped"). Replayed exactly, asp67's match of 24 October (17:24): an engineer with its trebuchet 52% built was hit by a Greek tower, dropped the site, attacked the tower and died; another, its trebuchet done, did the same.
  - A tower's arrows on an engineer, or on the trebuchet site it is building, now start nothing: the engineer does not turn on the tower and keeps building, its formation is not set on the tower, and the automatic defence drafts nobody against it. Hits from units are answered as before.
  - The site is included because towers shoot sites since this build: their arrows on one drafted the idle soldiers nearby against the tower.
  - Not changed (asp67): a marching trebuchet does not stop for a tower in its reach, and nothing else steers it.
  - The prompt's siege paragraph now ends "An engineer finishes its trebuchet before following orders, unless a unit hits it." (asp67; it said "unless it is hit itself").
- **The context a seat is given is the context it gets** (asp67's match of 24 October, 21:12: both seats set to 32,768, prompts up to 32,959 tokens; it only worked because both servers have larger windows. On a real 32k server the request is refused, the turn is lost, and the budget shrinks to 70% for the rest of the match).
  - The estimate missed two things: the tool schemas sent with every request to a seat that calls tools (about 3k tokens), and the replayed tool calls of past turns with their per-call answers (a past turn really costs about 650-850 tokens, against the ~450 counted). Both are counted now.
  - No fixed characters-per-token figure is right for every tokenizer, chat template and the four languages a seat can play in (asp67). Every reply reports the prompt tokens the request took; the ratio to our estimate of that request scales every later estimate for that seat. It rises at once when we underestimated, so the next request fits, and eases down slowly.
- **Fewer history jumps, with a floor** (asp67: optimizations that help every user's endpoint, not ours). The rolling history keeps its start so a server can reuse its cache, and when it outgrows its budget it jumps forward once, which recomputes the whole prompt. Across four matches of 24 October a jump turn took a median 5-22 s longer than its neighbours for DeepSeek V4.1 and 2-16 s for Qwen3.8 (the very slowest turns, 80-105 s, were long reasoning, not jumps).
  - A jump now leaves the window 40% full instead of 60%: room for half as many turns again before the next one, about a third fewer jumps.
  - It never keeps fewer than the newest three past turns, or as many of the newest as fit (asp67: a small context, or a token limit far under it, must still leave 2-4 former turns). Before, the only floor was one turn.
  - Where the budget holds no more than about three turns, the window moves every turn, as it did; nothing can keep both the turns and a fixed start there.
- **Two refusals say what happened** (asp67's match of 24 October, 17:24). An attack naming two archers and a trebuchet, the archers dead by the time it landed, was refused with "A trebuchet does not attack" alone; it now adds "(no longer yours or already dead: 53, 56)". A seat with no engineer left was told "no engineer is free ... all fighting or on a trebuchet already" when it sent build_structure or repair_building to its unfinished site; it is now told it has none and to train one at the academy.
- **An engineer on a trebuchet job shows it in friendlyUnits, in a formation too** (asp67's match of 24 October, 15:14). Members of a standing group carry no "action" (the group reports once in ordersInProgress), so a Viking engineer walking from its formation to its site looked like any member. The seat took the site for unattended and sent a second engineer from its academy 700 away; the first was shot by the Greek tower beside the site on arrival. A building or mending engineer now always carries "action": "building" or "repairing".
- **A built trebuchet behaves like a unit in formations** (asp67: "A built trebuchet needs to behave like a unit, so it needs to be added to formation ... The two main issues are the seat moving the trebuchet as a single unit leaving it unprotected and engineers walking alone not being able to defend the trebuchet once a tower takes damage and the entire town charges the trebuchet").
  - A whole-army order (move_units or attack_target with "units" omitted) takes the trebuchets along like any unit; they were left home and moved only when named, so seats moved them alone. A category still takes only its own category ({"siege": N} takes trebuchets).
  - A trebuchet built by an engineer from a formation joins that formation when it rolls off its site, with a slot of its own; a formation held to its slowest member is then held to the trebuchet's pace. Built by an engineer on no order, it stands alone as before.
  - The prompt's siege paragraph is asp67's own text: it "moves when you name it or as part of a formation", and "Damaged trebuchets are repaired by engineers and villagers"; the "20% dearer" and the crossbowman's speed are dropped. The "units" parameter now reads "Omit for the whole army, trebuchets included; workers are left out", and build_structure adds that the finished trebuchet joins the engineer's formation.
  - Both trebuchets have twice the health: 200 and 400.
- **What engineers are told, from asp67's match of 24 October (12:18, Vikings against Greeks)** ("It shows the problems with the engineer"). The Vikings lost six of seven engineers. Their trebuchets now threw: two Greek towers fell to them.
  - The prompt said "a trebuchet site nobody is building takes your closest free engineer within 40". The seat read it as "build_structure needs an engineer within 40", and walked each engineer from its academy to the front alone (about 700, 140 s) before placing the site; two died on the way. The sentence now reads: build_structure sends your nearest free engineer from any distance; a free engineer within 40 takes over a site whose engineer fell.
  - The build_structure reply said "leaves its formation to build it ... and returns to its place after" for every engineer. One trained at the academy has no formation and simply stayed by its finished trebuchet, 20 from a Greek tower, until it was shot. Now an engineer on no order is told "walks there from (x, z) to build it ... and stays by the trebuchet after". The tool description says the same.
  - The engineer clause in the prompt now says the job is interrupted only when the engineer is hit itself.
- **train_unit for a trebuchet points to build_structure** (asp67's match of 24 October, 13:31: a seat asked train_unit for "trebuchet" and got only the training list). A building id now adds `"trebuchet" is a building: place it with build_structure, and your nearest free engineer builds it` (any building gets the first half). simple_trebuchet and advanced_trebuchet get `is not trained: it is what a finished "trebuchet" site becomes ...` instead of "no finished building can train it", whose list of training buildings also gains the academy (engineer).
- **No more trebuchet-site deadlock** (asp67: "Many times, while the trebuchet site is set, the enemy builds a tower right next to it. Creating a deadlock situation"). Towers could not touch a site, and the engineer could not build under the tower, so neither side could resolve it.
  - Towers shoot trebuchet sites in their reach, begun or not. A tower sees an unstarted site, which stays hidden from everything else.
  - A trebuchet site starts at 0 HP (0.01, shown as 0%) instead of 20%, and grows to full health with the work.
  - A site destroyed before its engineer adds the first hit point costs nothing: it is paid on placing, as every building is, and paid back in full if it falls before work begins; recentEvents says so. A first draft took the cost only when work began. The seat saw its resources untouched, spent them, and the site was given up at the engineer's first stroke (asp67: "the first stroke with his hammer did not build but destroy his civilization's trebuchet building site").
  - The build_structure reply and tool description say an enemy tower in reach destroys the site and that an unstarted one is paid back. Your own placement works the same way.
- **Engineers finish trebuchet sites first** (asp67, with a screenshot: "Engineer is not leaving formation to build the trebuchet"; then: "Engineers should always finish build sites in their vicinity first before anything else, except retaliation", "not build sites already being built ... The closest engineer not already building starts to build. No extra order needed. But an engineer can be sent to a trebuchet build site with a repair or build order").
  - What happened: the army's next order (bare, or `{"infantry": N}`) swept the engineer back into the formation as an infantryman, dropped its job without a word, and the site was never begun. Headless, every bare or category order did it, in the same turn or the next.
  - An order that takes an engineer on a trebuchet job (bare, by category, or by id) now leaves it on the job: it joins the order's group and takes its slot when the trebuchet stands. The reply says so: "engineer #7 finishes its trebuchet first, then joins this order".
  - A site no engineer is working, or coming back to after a fight, takes the closest free engineer (not building or mending, not fighting, not walking home from a defence) within 40, whatever its order. This covers the orphaned Viking site. An earlier draft also sent an idle engineer at any distance; in asp67's match of 24 October every engineer the Vikings trained then walked from their academy to their site in the Greek base, 550 away, and died there, four in a row and none of them ordered. From further than 40 an engineer goes only when ordered.
  - A site already being built gets no second engineer unasked. build_structure at your own unfinished trebuchet sends one more engineer and places and pays nothing; repair_building at a trebuchet site's coordinates sends free engineers to build it. Both tool descriptions say so.
  - Only a hit on the engineer itself interrupts the job, and it goes back to the site afterwards (asp67: "An engineer actively building a trebuchet while not taking direct damage should finish the build first, before joining the tower retaliation event"). Headless, a tower that shot the soldiers beside a building engineer pulled it off the site and onto the tower, where it died: on its own through the auto-defense draft, in a formation through the group's retaliation, which (unlike the group's follow-up scan) never skipped a busy engineer. Both now pass over an engineer that is building and has not been hit in the last 4 s, the window auto-defense itself uses.
  - The prompt's siege paragraph adds one sentence on this.
  - Who works on what is unchanged and was checked again (asp67: "engineers only build trebuchets, nothing else, villagers build everything except trebuchets. Engineers and villagers can repair trebuchets, buildings can only be repaired by villagers, that includes towers"). repair_building on a building with only engineers free now adds "Only villagers repair buildings; engineers mend trebuchets only." to its refusal, which said only "all are constructing".
  - **An attack to a point paces itself to the trebuchets it names.** The Vikings named their advanced trebuchet in an attack_target to the Egyptian Wonder with matchSpeed; the reply said "all marching at 1 (engineer pace)", and the army arrived with the trebuchet 150 behind. That branch shaped and paced only the fighters; it now shapes and paces fighters, priests and trebuchets as one body, as the attack-by-id branch already did.
  - **The replies say which trebuchets go along.** Neither attack reply counted or named them; each now ends with e.g. "advanced_trebuchet #92 goes with them; a trebuchet throws only at towers."
- **The prompt keeps the world; the tools keep their own behaviour** (asp67: "Is there anything in there that is actually part of the tool description?").
  - What an action does now lives in that action's tool description: the engineer sent by build_structure, the reason text never choosing assign_workers' resource, a new move_units order replacing the old one only for the units it names, the siege stand-off of attack_target, and what "units" and "unitIds" take.
  - The system prompt's "VALID ACTIONS & PARAMETERS" and "PARAMETER CONSTRAINTS" blocks are gone for seats that call tools: their schemas already say all of it, and the copy was paid on every turn.
  - A seat answering in raw JSON gets no schemas, so its prompt carries the full action reference instead, generated from the same action table as the schemas (about 1,500 tokens), so the two cannot drift apart.
- **The broadcast Wonder countdown stays under the seat cards at Medium and Small UI size** (asp67). Its position is measured from the scoreboard in screen pixels but applied to a panel the UI size zooms, so it was shrunk a second time and rose over the cards. The measured offset is now divided by the UI size. The chronicle caption under the status bar had the same fault and gets the same fix.

**Tests:**
- `tests/trebuchet.test.cjs` adds the orphaned site (an idle engineer finishes it; one on a guard order is left alone) and the paced attack to a point. Both fail on the old code, the second with the match's own "all marching at 1".
- `tests/trebuchet.test.cjs` adds two trebuchets alone in each of the four shapes: two places at least 6.5 apart, and no single-rank note.
- `tests/trebuchet.test.cjs` adds two towers 45 apart: the attack on the first moves on to the second, both fall, no soldier enters either reach (without the rule it stops after the first); the data tests read 50 and 70.
- `tests/trebuchet.test.cjs` adds an attack-move to a house 10 from a known tower (named in the reply, besieged, no soldier in its reach, then on to the house; an undiscovered tower is not besieged) and a march passing 25 from a known tower (besieged, "besieging" and "then" in ordersInProgress, no soldier in its reach, then on; without a trebuchet nothing changes).
- `tests/trebuchet.test.cjs` adds a line formation with two trebuchets, marching and besieging a tower: two places 7 apart, the row behind the last rank, one start and no stop-and-go (without the row both engines got places 2 apart; without the margin the body stopped and started 12 times); the stand-off test now checks the soldiers stand beside the trebuchet, the nearest within 8 but none in its place.
- `tests/transcript-replay.test.cjs` adds the replay's pace from a header: recorded, from the Wonder pace, and 1 before build 1020.
- `tests/trebuchet.test.cjs` adds a line formation with a trebuchet starting 30 behind it: the reply says the others stand until it has caught up, and its time is the trebuchet's own; the body stands while the trebuchet closes, then marches on with it (on the old code it crept forward).
- `tests/trebuchet.test.cjs` adds the champion holding at its post beside a trebuchet, its three group-mates still at home: it fights the attacker (it stood idle on the old code).
- `tests/trebuchet.test.cjs` adds an attack-move with an advanced trebuchet to a point inside a tower's reach: shot at, nobody goes for the tower while the trebuchet lives (the old rule charged it 44 s in), and the group fights the tower once the trebuchet is gone; the stand-off test checks the new reply.
- `tests/trebuchet.test.cjs` adds a tower shooting a formation's engineer while its soldiers guard outside its reach (neither the engineer nor the formation goes for the tower; without the rule the engineer does), and one shooting an engineer building beside idle soldiers (it builds on, nobody is drafted).
- `tests/history-window.test.cjs` adds a 32k seat with 200 past turns answered with tool calls: the whole request, schemas included, fits the budget; told by its server that it takes 1.6 tokens per estimated token, the next request fits in real tokens with fewer past turns (fails with the old counting), and one lighter reply eases the ratio down, not at once.
- `tests/history-window.test.cjs` adds budgets holding about 3, 2 and 17 turns: never fewer than 3, 2 and 3 past turns once there are that many (fails with a floor of one turn); the jump test now expects the 40% refill.
- `tests/trebuchet.test.cjs` adds the attack refusal naming a dead archer, and the two "no engineer" replies.
- `tests/trebuchet.test.cjs` adds an engineer walking from its formation to its site, shown as building (its soldiers still carry no action).
- `tests/trebuchet.test.cjs` adds a trebuchet built from a formation joining it at the formation's held pace, and a following bare order taking it along; the health checks read 200 / 400.
- `tests/trebuchet.test.cjs` adds train_unit for trebuchet, house, simple_trebuchet and advanced_trebuchet.
- `tests/trebuchet.test.cjs` adds the reply for an engineer on no order sent from 300 away, and the prompt's new sentence.
- `tests/trebuchet.test.cjs` adds: a site at 0 HP, paid once on placing, built at full health; a site still built after its owner spent everything meanwhile; and an enemy tower destroying an unstarted site (paid back, with the event) and a begun one (not). The tower test fails without towers shooting sites.
- `tests/trebuchet.test.cjs` adds a tower shooting the soldiers beside a building engineer, on its own and in a formation: the engineer never joins and the trebuchet gets built (both fail on the old code: it walked to the tower and died).
- `tests/enemy-building-memory.test.cjs` adds a battle at 2x speed: still reported a minute of match time on (fails on the old clock), gone after two.
- `tests/trebuchet.test.cjs` adds an idle engineer 320 from an unworked site, which stays home (it fails with the any-distance draft).
- `tests/trebuchet.test.cjs` adds: an order of each kind (bare, infantry, ids, attack) taking an engineer on its job, which builds the trebuchet and then stands in the order's place; engineers marching past a site 30 off (the closest one builds it, alone), 60 off (nobody), and past a site already being built (nobody); and build_structure and repair_building each sending a second engineer, with no second site and nothing paid.
- `tests/trebuchet.test.cjs` also covers the engines rolling off as `simple_trebuchet` (0.16) and `advanced_trebuchet` (0.32).
- It also covers the engineer: academy training only after Siege Engineering; refused without an engineer, with no villager sent; the engineer's rear slot; leaving to build, the site built, and back in its slot; engineers and villagers repairing together.
- `tests/trebuchet.test.cjs` also covers the advanced trebuchet: the conversion (place, damage, facing, no population); no throw while it moves and a stone the moment it stands; a bare order taking it along (it used to leave it home); a named order taking it into a formation as ranged at its pace; the attack_target refusal; repair; no healing; no tech; no auto-defense draft; no seat kept alive; and its watch.
- `tests/trebuchet.test.cjs` also checks the unstarted site: an attack order sweeping past leaves it at full health (on the old code it was destroyed); it is not acquired, not known, and its id names nothing; and after the first swing it can be found.
- `tests/trebuchet.test.cjs` adds an engineer attacked at its site, once on its own and once from a formation: it fights back and the trebuchet still gets built. Without the fix, the one on its own never returns to the site.
- `tests/trebuchet.test.cjs` adds a siege, with each engine. Four warriors and a trebuchet are ordered at a tower. No warrior ever enters the tower's reach or targets it; the trebuchet stands within its own reach; its stones land; the soldiers stand at the trebuchet; once it is destroyed, they go for the tower. Without the stand-off they charged to 3.8 from the tower.
- `tests/trebuchet.test.cjs` adds a stone in flight: the tower is untouched until it lands; the trebuchet destroyed mid-flight; the damage still lands, credited to it. The older throw tests now wait for the landing.
- `tests/sim/behaviours.test.cjs` adds a soldier drafted to a raided house 60 away: it walks back once the raider falls, or goes where a later order sends it. Without the return it stays at the house. The golden `battle-40v40` is re-recorded: same counts, health and buildings at every checkpoint; only positions moved from 25 s on, as the defenders walk home.
- `tests/standing-orders.test.cjs` adds the two formation cases. Both fail on the old code: the joiner was held back, and the body walked at 1.08 against a straggler at 1.0.
- `tests/trebuchet.test.cjs` covers:
  - the tech in every civilization;
  - flat health, the tiers and the +20% cost;
  - no age-up morph;
  - one stone every 6 s at the nearest tower in reach, with units, other buildings and out-of-reach towers untouched;
  - a tower site hit at once, its builder not, and the damage still standing after 3 s more building;
  - the tower owner's soldier answering the engine;
  - the watch (the tower and 20 around it seen, nothing between, a tower beyond the watch not);
  - the tower rule (refused, allowed when nearer home or beyond 200, and a forward Town Center denying nothing);
  - the model's error with nothing spent;
  - construction progress in the state.
- `tests/vision-index.test.cjs` now includes trebuchets and enemy towers, so the vision index, `isVisibleTo` and `isPositionVisibleToAI` must agree on the watch circles.
- The golden `opening-economy` is re-recorded. Its summaries are identical to the last resource; only the state hashes moved, with the construction health.

**Prompt.** The system prompt and the tool descriptions changed (the siege paragraph, the engineer, guard, and the siege on the way), so `ARENA_PROMPT_VERSION` is `agents-rule-v109`. The tool-schema tripwire in `tests/prompt-budget.json` rises from 2660 to 3390 tokens (measured about 3230). README: the tower creep of 23 October and the trebuchet, with two pictures (`Screenshots/TowerCreep.jpg`, `Screenshots/Trebuchet.jpg`).

## Build 1104: a defence's priests come only from near the fight, and stand behind what they defend (17 October 2026)

**Rules change (auto-defense).** asp67: "At one point, two priests still walk over the entire map into a tower even though the healing target is long dead. Was that an order which would be legitimate or did they pick a healing target half a map away and started walking into doom?"

**Neither.** In asp67's match of 17 October (b1103), replayed exactly, with every change of the two priests' destination recorded:
- Rome's priests #26 and #29 stood idle at their temple, with no order.
- A Greek tower shot a Roman scout deep in Greek land, and the scout fought back.
- Auto-defense counted that as a defence on site. It sent every idle priest Rome had to the attacker's position, which was the tower's own coordinates. The two walked about 750 units across the map and died under the tower.
- Gemini saw them go and ordered them home "so they do not wander into enemy territory alone". The order landed after they had died.
- They never had a patient. Patient picks in that match were short: 102 of 111 within 24. The longest were 97, by a formation's priests during an assault on a tower their group was fighting.

**Before.** Auto-defense limits which soldiers answer a hit, by what was hit:
- a unit: the battle radius (90);
- a building: 1.5 times that;
- a Town Center: 2 times;
- a Wonder: the whole map.

The priest escort beside it had no limit, and it sent the priests to the attacker.

**Now:**
- Only priests within that same reach of what was hit are sent.
- They rally 6 behind what is defended, on the side away from the attacker, moved onto legal ground (clear of building rings). That is within healing reach of it, not at the attacker.
- A Wonder raid still calls every priest, as it calls every soldier.

**Tests:** `tests/sim/behaviours.test.cjs` adds a scout shot by a tower 15 off, with one priest 55 away and one at home about 180 away. The near priest is sent to a point behind the scout and outside the tower's range; the one at home stays.
- On b1103 the near priest's rally point is the tower itself.
- On b1103 the home priest walks out too.

The combat goldens `battle-40v40` and `wonder-siege` are re-recorded and end as before. The 40-v-40 changes only in positions. In the siege Egypt still falls at 70 s, and the attackers keep two more heavy cavalry.

## Build 1103: a tower that attacks a group is fought by the whole group; priests stop when their patient dies (17 October 2026)

**Rules change (standing orders).** asp67: "There is still some jojoing when a large group of units passes a tower and some get dragged into the fight." And: "Priests do not stop when their healing target died thus charging into towers all the time."

**What happened with the towers.** Since b1101 only the members inside a tower's firing range answered it; the rest kept to their order. But one member fighting is enough to halt the whole group. So a big army stood at the tower's edge, waiting. The few inside the range fought the tower alone, and the rest were drawn in one volley at a time.

A test case on the real engine: 34 units on an attack-move to a Town Center pass an enemy tower 12 off their route. The tower shot the three lead riders. The army stood at the tower for over 80 s and lost 18 of 34; the tower survived at 452 of 3050.

**Now** (asp67: "If a group gets attacked by a tower, the whole group retaliates. Only if units outside the tower's reach take damage from other units, they retaliate against the damage dealers first and when they are not taking any more damage, the first part of the rule takes hold again and they join the tower fight."):
- A member inside the tower's range fights the tower.
- A member outside it fights a mobile attacker of the group within chase reach first. With none, it joins the tower fight. Members farther than chase reach (64) are not pulled across the map.
- A tower stays the group's fight while it shoots, while a member stands in its range, or while a member is on its way to it. Once none of that holds for 4.5 s, it is let go (b1101).
- An attack order still does not seek out a tower that has not shot at it (b1102).
- The same test case: all 30 fighters take the tower, it falls in about 12 s with no losses, and the army marches on and razes the Town Center.

**Priests.**
- A priest without an order walks to the nearest wounded within 24. It used to walk on to where the patient had stood, even after the patient died, often under the tower that had killed it. In asp67's match of 16 October (b1100), four priests did this at 12408 s. Now the walk ends when the patient dies, is whole again or is within reach.
- A priest no longer walks to a patient who stands in an enemy tower's range. With an order, it does once its group is fighting that tower. It still heals anyone it reaches from where it stands. In asp67's match of 15 October, priests went from a dead patient to the next wounded under the tower.

**asp67's match of 16 October (b1102): Rome's Wonder run on the Egyptian pyramid.** Replayed exactly on its own build:
- Rome's 23-unit group, sent at the pyramid, passed a tower.
- The tower took them one to three at a time. Never more than three were on it at once, and the group's fighting flag flipped 16 times.
- All four priests followed a patient under the tower and died there.
- 26 Romans died in about 55 s, and the tower stood.

The same scene on this build, from the same match (on the new rules, so it drifts; Rome arrives with 13 units, not 23):
- All 11 fighters take the tower at once, and it falls in 10 s.
- 5 die to it.
- The rest march on to the pyramid, where Egypt's archers and champions stop them.

**Tests:** `tests/standing-orders.test.cjs`:
- The volley test, the beyond-sight test and the b1085 test get back their whole-group expectations from before b1101.
- The b1101 test now checks that a member 32 off, outside the range, joins the tower fight and stays in it while on its way.
- A new test checks that a tower nobody fights any more leaves the group's threats.
- Two new priest tests: an idle priest stops when its patient dies and does not walk under a tower; a formation priest does not follow a patient under a tower its group is not fighting.
- Each of these fails on b1102.

The combat goldens `battle-40v40` and `wonder-siege` are re-recorded. Both end as before. The siege army keeps one more heavy cavalryman; the 40-v-40 assault is wiped out sooner.

## Build 1102: an attack order leaves towers beside its route alone (16 October 2026)

**Rules change (standing orders).** asp67: "a tower is a purely defensive building not a productive one, a group passing a tower that is out of range and attacking barracks, or a town center is much more productive."

**Before.** An attack order engages enemy buildings within 48 of its route. Towers counted as such buildings, so a passing army turned on a tower that had never shot at it and lost time and men there. In asp67's match of 16 October, 15 of the tower pulls from outside the tower's range came from this rule.

**Now** a tower is no longer one of the buildings an attack order engages on its way. A tower is still fought:
- as the order's own target: an army sent at a tower attacks it;
- by the members standing in its range once it shoots them (a threat, b1101). An army that attacks buildings next to a tower still brawls with it.

**The same match replayed on this build** (on the new rules, so it drifts from the original once the first decision changes): 2 tower pulls from outside the range instead of 121 on its own build, b1100. Both are members of an order sent at that very tower, walking up to it.

**Tests:** `tests/standing-orders.test.cjs` adds an attack order passing a tower 28 off (outside its range of 18) with a Town Center 33 off. Before the fix the group went for the nearer tower; now it takes the Town Center. With the Town Center gone it leaves the tower alone, and sent at the tower it attacks it. The combat golden `wonder-siege` is re-recorded. It ends as before: Egypt falls at 70 s, the siege army one cavalryman fewer. Its buildings fall in a different order, as the attackers no longer open on the tower.

## Build 1101: a tower is fought only from inside its range, and every Wonder countdown is on screen (16 October 2026)

**Rules change (standing orders).** asp67: units still attacked towers they passed outside the towers' range, when members of their formation had been killed at that tower before, even after the fight there was over. It happened most in the Wonder phase.

**What happened.** A tower that shot a member joined the group's threats and never left them: it stayed marked "seen" for good, and the clean-up kept towers on purpose. Two things then pulled members onto it from outside its range:
- **The fallback.** With no mobile attacker near, b1085's `threatFor` sent a member to the tower ("join the target list again").
- **The eligibility check.** It took any threat with no distance limit. On a Wonder run, where threats are the only targets allowed, a member up to the chase limit away (~96) took the tower.

In asp67's match of 15 October (b1100), replayed on its own build: **47 times** a member took a tower from outside its range, all on attack orders, none with the tower as the order's target, every one with the tower in the group's threats, at 18–88 units.

**Now** (asp67: "join the target list of the formation again" means the formation's order, never the tower):
- A tower is a member's fight only inside its firing range (18), the test the tower shoots by. That holds in `threatFor` and in the scan's eligibility check alike. The order's own target is unaffected: an army sent at a tower still attacks it.
- Outside the range a member answers a mobile attacker, or with none carries on with the order.
- A tower drops out of the group's threats once it has not shot any member for 4.5 s (three volleys) and no member stands in its range. It stays known, seen or not, while a member stands in its range.
- The same match replayed on this build: 10 such cases instead of 47.
  - 6 are members a step outside the range in the very second the tower shot them.
  - 4 are an attack order engaging enemy buildings within 48 of its route, which attack orders do with any building.

**Tests:** `tests/standing-orders.test.cjs` adds a member marching past a tower that had shot its group, outside its range, after the fight. Before the fix it turned on the tower in 70 of 120 scans; now it never does and marches on. The b1085 test and five older tower tests are updated; their "towers" had a range of 1, so they only ever passed through the old fallback. The combat goldens `battle-40v40` and `wonder-siege` are re-recorded. Both battles end as before: the siege still falls, with one cavalryman fewer and slightly more health left.

**Every Wonder countdown on screen.** In the same match (15 October) Egypt and Rome raised Wonders 17 s apart, and both counted down. The status bar, the broadcast countdown and the analyzer's header each showed only the leader's, so the second was invisible. Now each shows one countdown per seat holding a Wonder, closest to winning first, in the seat's colour.
- The hold is the seat's own, so a civilization with two Wonders is one countdown, as asp67 asked.
- `UIManager.wonderHolds()` lists them; `TranscriptAnalyzer.wonderStatuses()` does the same from each seat's snapshots.

## Build 1100: benchmark results go by model name and the checkpoint actually served (14 October 2026)

**No match rules change.** asp67: the Benchmark page is for people running their own endpoints, where one address serving different models over time is normal. Results were grouped by the library entry's internal id. The DGX's FP8 and NVFP4, both served as `Qwen3.8` on port 8024 under one library entry, would have shared one row.

**Now a result belongs to the model name it ran under plus the checkpoint the endpoint served:**
- At the start of every benchmark the page asks the endpoint which checkpoint it serves, the way "Test connection" asks: the same address handling, authentication and /v1 fallback, waiting at most 6 s.
  - vLLM names the checkpoint behind its alias (`root`: `nvidia/Qwen3.8-Flash-Next-NVFP4`).
  - Ollama is identified by name and digest.
  - Others, Strata included, by their model id.
- The answer is recorded with the run and in its replay bundle (`served`).
- Results, comparisons and head-to-heads show "*name* · *checkpoint*" and split by themselves when a different model sits behind the same address and name.
- Under the model dropdown the page shows what the endpoint serves now. If it differs from the checkpoint the entry was last benchmarked with, it says so: "Serves X now; last benchmarked with Y. Its results get a row of their own."
- A run recorded before this build, or from a server that would not say, goes by its name alone and is marked "checkpoint unknown". Its model's history offers "Which model?" to set the checkpoint by hand (suggesting the one its entry ran with); the run then moves to that model's row.
- A library card's "📊 Benchmarks" opens the row of the entry's latest run. A model's history lists the same name's other checkpoints as links.
- Every key in the page's buttons now travels in a data attribute, so a model name with a quote in it can no longer break one.

## Build 1099: benchmark statistics that fit the scores, and a build filter (13 October 2026)

**No match rules change.**

**Intervals.** Until now every mean score got Wilson's bound laid over it, as if every run were win or lose. asp67's ten fog searches by the FP8 (scores 0.65–0.91) read 0.78 [0.47–0.94]. Now:
- Win-or-lose scores keep Wilson's interval.
- Graded and partial scores get Student's t on the scores themselves, clamped to [0, 1]: the same run now reads 0.78 [0.71–0.85].
- A single graded run reads [0, 1].

**Totals.** "All scenarios" was a pooled mean over runs, so whichever scenario ran most decided it. The 0.13 gap asp67 saw between the FP8 and Q2 totals was mostly that: different mixes of scenarios. Now:
- Every scenario counts the same, and the interval comes from the scenarios' standard errors.
- Win-or-lose scenarios carry a Bernoulli spread (Agresti), so two wins do not read as certainty.
- In **Models compared** the total covers only the scenarios every model shown has run ("All shared scenarios (k)").

**Head to head.** Each model is compared against the best, on runs matched by scenario and board orientation in the order they were run, so both faced the same boards. The table shows the mean difference with Student's t interval, plus how many runs each was ahead, behind and even. asp67's fog searches: Q2 against FP8, +0.05 [−0.02, +0.11] over 10 matched runs, ahead 7 / behind 3. Not yet a difference.

**Build filter.** Results and a model's history can be limited to runs from a chosen build on, so runs from before a fix (b1097) stay out of a comparison without being deleted. The choice is remembered in the browser.

`WarBench.meanScore`, `tInterval` and `balancedScore` are covered by `tests/bench-stats.test.cjs`.

## Build 1098: the model library from the Benchmark page, and back to where it was opened (13 October 2026)

**No match rules change.** Agreed with asp67: the library belongs where a model is picked, not on the landing page.
- The Benchmark page has "Manage library →" under its model dropdown, beside the saved-results link.
- What is filled in on the page (model, scenarios, runs, time limit, prompt) is kept for the return, and the dropdown then lists the library as it was left.
- The library's back button returns to the page that opened it, and says where: "← Back to the benchmark" or "← Back to arena configuration" (campaign setup as before).
- Coming back into the library from the Benchmark page (opened from a card's "📊 Benchmarks") keeps the library's own way back.

## Build 1097: two WAR Bench bugs found in the first real model runs (13 October 2026)

**No match rules change; benchmark results before this build are biased.** asp67's first real benchmarks (Qwen3.8 FP8 twice, the Q2 Strata once) exposed two bugs in the bench, neither in the arena.

**1. A unit explored once was refused for the rest of the scenario.** The executor's "already sent this turn" check (`_exploreTurn` against the seat's `turnCount`) relies on the turn count advancing, which the arena does per request (`startTurn`). Scenario episodes never advanced it, so every turn was turn 0:
- a named unit (`unitIds`) explored in an earlier round was refused with "already scouting this turn";
- the auto-pick never chose it again.

It cost the FP8 runs 2 and 10 commands and the Q2 run 7. Both models explore in scenarios to find things, and in "Hold the ford" they did it with archers from the hold. Now each round is a new turn for both seats. `tests/bench-scenarios.test.cjs` sends a scout again two rounds later; the test fails on the old code.

**2. A failed request left no trace in the bundle, so the replay fell out of step.** The recording fetch kept only requests that got a reply. A dropped connection or the ceiling's abort (the FP8's first run had two, in "Hold the ford") was missing, and `war-bench verify` then served every later reply one round early and reported the run as different. Failed requests are now recorded with their error (Node's `recordingFetch`, the browser worker's), and the replay fails them again at the same point.

**Bundles now carry the bench core.** Each bundle embeds `js/bench-core.js` (not part of the core hash, which stays the game's rules), and `verify` replays on that core in a context of its own (`Realm` takes a `core`). A later fix to the bench, like this one, can no longer make an honest old run look forged. Bundles from before this build have no core; verify replays them on today's and adds a note saying a difference may be the bench's rather than the run's.

## Build 1096: benchmark results you can browse, compare and open from a file (13 October 2026)

**No match rules change.** asp67 found no way to look at earlier results except through one model, and no way to load a saved file and look at it.

**The Benchmark page now has three views:**
- **New benchmark.** The Start button names the model it will run ("▶ Benchmark *model*"). The dropdown opens on the model benchmarked last, and asp67's second run, meant for the Q2 seat, ran on the FP8: every recorded request went to the FP8 endpoint.
- **Results.** Every model with saved runs, sorted by mean score, with model and endpoint, number of benchmarks and runs, and the last run. "Open" shows a model's totals per scenario and its runs. With two or more models, **Models compared** draws one bar per model for each scenario and for all scenarios together, up to six models. The bars use the dark categorical order (validated against the panel surface), with a legend and a value on every bar; hovering a bar shows its interval. A scenario a model has not run says so. The page opens on this view when anything is saved.
- **Open a file.** It takes a results file (`.json`, as "Save results" writes it) or a replay bundle (`.warbench.jsonl.gz`, unpacked in the browser, or `.jsonl`).
  - A bundle, or a results file with one run, is **shown** without being stored, and "Keep in this browser" stores it.
  - A results file with several runs adds the ones this browser lacks.
  - A bundle is read back into the same per-episode summary as a run made here: outcomes, scores, parts, notes, answer times, tokens from the recorded replies, and unanswered rounds. It is matched to the library entry with the same name, endpoint and model.
- Bundles recorded from now on carry the run's date and prompt version.

## Build 1095: the fog search grades how far the search went (13 October 2026)

**No match rules change.** asp67: a model that searches a confined area should score less than one that actually goes places. Measured on b1094, it did not. Four scouts on routes that never left the tiles around home scored 0.74–0.87, above scouts sent far without routes (0.51–0.58), because routes counted fully however short they were.

**Now the grade has four parts:**
- **Right units:** unchanged.
- **New ground** (was "spread"): unchanged.
- **Reach** (new): map tiles the search came to see at least 10 % of, beyond those seen at the start, per round, against 2 per round.
- **Waypoints:** the share of explore orders with a route, multiplied by Reach, so a route counts only as far as the search went.

| Played as (min–max over 8 orientations) | Grade |
|---|---|
| Four scouts on four separate routes (the reference) | 0.96–1.00 |
| Scouts sent far, no routes | 0.61–0.64 |
| One `explore` a turn, unit left to the harness | 0.50–0.58 |
| Scouts on routes, all within two tiles of home | 0.45–0.47 |
| All four scouts marched to one spot | 0.40–0.41 |
| Random valid moves | 0.25–0.42 |
| The whole army marched to one spot | 0.27 |

**Supporting changes:**
- Measures `tilesReached` and `times` (a product).
- `WarBench.tileFor(variant, label)` turns a tile with the board.
- The test policies are turned with each orientation, as the reference is; b1094's comparison policies were written for one orientation only.
- The page's "How it searched" table shows the four parts.

## Build 1094: a benchmark scenario graded on how the model searches the fog (13 October 2026)

**No match rules change.** This adds a new WAR Bench scenario family, `fog-search`, with `search-01` "Find the hidden camp". It is asp67's idea: finding something in the fog, the task most models struggle with. Whether the camp is found is luck, so it is never the score. **How the search was run** is.

**The board.** On the 800 map, 4 scouts, 4 archers, 4 militia and 4 warriors stand by the Town Center in one corner. An enemy barracks with a house (the camp) is hidden in the fog on the far side. The run has 12 rounds of 10 s and ends early at the round the camp is first seen.

**The grade** is the mean of three parts, each from 0 to 1, kept per run:
- **Right units:** the scouts' share of all the ground the army covered.
- **Spread:** new ground uncovered per round, against 1.7 % of the map per round, the pace of four scouts on four separate routes.
- **Waypoints:** the share of carried-out `explore` orders that had a route (`then`).

| Played as (mean over 8 orientations) | Grade |
|---|---|
| Four scouts on four separate routes (the reference) | 0.98–1.0 |
| Scouts spread out, no routes | ~0.53 |
| One `explore` a turn, unit left to the harness | ~0.42 |
| All four scouts marched to one spot | ~0.39 |
| Random valid moves | ~0.31 |
| The whole army marched to one spot (even onto the camp's own tile) | ~0.16 |
| Doing nothing | 0 |

**What the scenario language gained** (`js/bench-core.js`):
- `graded`, a measure scored however the run ends, giving outcome "graded".
- `until`, a predicate that ends the run.
- `notes`, predicates recorded, never scored ("found" and its round).
- The predicate `seen`, read from the player's exploration bitmap.
- The measures `travelShare`, `exploredRate`, `orderShare` and `parts`.
- Explore tile labels and routes now turn with the board's eight orientations.
- Each round's outcomes carry their command position `n`.
- Scores gain `partsByScenario`. The paired bootstrap compares mean scores, not success rates, because a graded scenario has no successes.

**The page** shows a graded scenario as a bar of its mean score with the 95 % interval, adds a Graded column, and adds a "How it searched" table: the three parts, and how often the camp was found and in which round, marked as luck and not scored. `war-bench` prints and reports the mean score too.

## Build 1093: explore without a named unit takes an idle one (13 October 2026)

**Harness change.** `explore` with no `unitIds` and no `unitType` picks the unit itself: the farthest-seeing soldier. Its comment said "idle", but the code never checked. So a scout already on its way was picked again whenever it saw farthest. A seat that sent `explore` each turn without naming a unit re-aimed the same first rider every time and cut its route short, while the other riders stood at home.

**Now** the farthest-seeing soldier that is standing still goes first. A unit on its way (an earlier explore, its route, a march) is taken only when no soldier stands free.
- Named units (`unitIds`) and a named type (`unitType`) win outright, as before.
- The reply still names which unit went.
- Found while building the fog-search benchmark scenario, which would otherwise have scored this as the model's poor spreading.
- `tests/scout-idle-first.test.cjs` covers it; it fails on the old pick.

## Build 1092: the Benchmark page (13 October 2026)

**No match rules change.** A main-menu entry, "Benchmark a model", runs the WAR Bench scenarios against a library model in the browser (asp67's request).

**Setup:**
- Pick a model from the library, or one of two reference players: random valid moves, or doing nothing.
- Tick single scenarios or a whole family.
- Choose the runs per scenario. Run *i* turns the board to its *i*-th of eight orientations, so repeated runs are not one board replayed.
- Set a wall-clock limit per run (default 10 minutes, 0 for none). A run still going at the limit scores the advantage it built (b1091).
- Choose the system prompt: standard (pinned to the prompt version, comparable between models) or the arena prompt as edited. Either way only the victory paragraph becomes the scenario's objective.
- The seat plays exactly as the library entry is set up, through the arena's own conversion (`slotToSetupEntry`): endpoint, sampling, reasoning, extra body, maximum tokens (8192 when unset, as in the arena). It is strict, with no adaptation and no retry, as in Node.

**Running:**
- Each run plays in a worker of its own (`js/bench-worker.js`), and the world stands still while the model thinks.
- A progress bar shows the run, scenario, orientation, round, the last answer time and a ticking wait for the current answer. Stop ends the benchmark and keeps what finished.
- Rounds the model never answered are counted with their reasons (network errors, timeouts, unusable replies). The results say so first, so a dead endpoint never reads as a weak model.

**Results:**
- One row per scenario plus an all-scenarios row, as a stacked bar of success, partial and failure in the status colours, each with its mark (✓ ◐ ✗) and label.
- The mean score with its 95 % interval sits at the end of each bar.
- The table adds counts, success rate (Wilson interval), answer time, tokens per round, invalid commands (reference errors), unanswered rounds and time-limit stops.
- Saved automatically in this browser as a per-episode summary, without prompts or replies.
- "Save results" writes a JSON file that the page imports again.
- "Save replay bundle" writes the full `.warbench.jsonl.gz` (plain `.jsonl` without CompressionStream). `war-bench verify` checks and replays it in Node; `readLines` now reads both forms.

**Model library:**
- Every card gets a "📊 Benchmarks (n)" button, enabled once the model has results. It opens everything that model has run, added up per scenario, with the list of runs (deletable).
- A note appears when those runs span different builds or different settings.
- Library entries carry a permanent `uid`, because `id` is a list position re-keyed on every load. Results are found by the `uid`, which survives reordering and a catalogue export.

## Build 1091: WAR Bench runs in the browser too, and a scenario out of time scores its advantage (13 October 2026)

**No match rules change.** This build prepares the Benchmark page.

**One bench core.** `js/bench-core.js` now holds everything a benchmark scenario is made of: the scenario language (war-scenario-v1), its variants, predicates and measures; the frozen stage (seeded runtime, inert page, board setup, snapshot); the round loop; the model seat; the baselines; the outcome taxonomy; scoring; statistics; and the bundle format. Node's `tools/bench/*.cjs` and the browser load this same file, so both score a run with the same code.

**A browser worker.** `js/bench-worker.js` plays one episode per worker, in a fresh global, exactly as the Node realm does. `tests/bench-worker.test.cjs` runs it as a page would and checks every round's state hash and world hash against Node. A run the browser records verifies with `war-bench verify`, for baselines and for a model on the wire.

**Out of time** (asp67): a scenario that runs out of rounds, or out of a run's wall-clock limit, without winning and without failing explicitly, no longer counts as a plain loss. It scores the advantage it built: the scenario's new `partial` measure, capped at 0.9, so it is never a win.
- An explicit failure scores 0: losing the whole army, a broken hold, or the end judgement failing.
- Doing nothing still scores 0.
- `strike-01` measures the damage done to the target.
- `recover-01` measures the soldiers standing against the three required, while the Town Center stands.
- `ford-01` has no measure: a hold cut short has proven nothing.
- Measures are data, like predicates: `damage`, `share`, `gate`, `mean`.
- Scores gain `meanScore` (overall, by family, by scenario, with a 95 % interval) and an outcome tally (success, partial, failure).
- Bundles record an episode's partial score and `stopped: 'time'`. Verify replays a stopped episode to the same round.

## Build 1090: lockstep caps how old a state can get (11 October 2026)

**Lockstep changes; nothing else does.** asp67 set up a turn-based match with a 120 s answer time and 30 s lockstep. The world stood still while the models thought. After the moves, it played the 30 s slice, and only then was the next round asked. On screen every round took the thinking time *plus* the slice: impossible to play.

asp67's definition: lockstep exists so that no model ever answers a game state older than the setting.

**Now:**
- A round is asked on the world as it stands, and the slice starts over from there. The world plays on while the seats think.
- When every move is in, the round ends at once: the moves run and the next round is asked on the current world, with the slice restarted. That happens even if the slice is not used up.
- If the seats are still thinking at the slice's end, the world halts and waits for them, or for the answer deadline.
- So a state a model answers is never more than one slice old, and a round takes as long as its thinking, never longer.
- Fast rounds span less world time than the slice; slow ones span exactly the slice.
- In the test, with 7 s answers and a 5 s slice, a round took 8.5 s on screen instead of 13.5 s (the 1.5 s breather included).
- The setup field is now "Most world time per round (lockstep)", and its hint describes the new order in all four languages.

**Records and comparability:**
- The transcript header carries `lockstepMode: 'max-age'`.
- The contract protocol is `turn-based-lockstep-max-age-<slice>ms`, so these matches never compare with the earlier lockstep (`turn-based-lockstep-<slice>ms`).
- Nothing in the prompt changes. The state's `clock.worldSecondsPerRound` carries the same number, now an upper bound.
- `tests/sim/lockstep.test.cjs` covers the new order.

## Build 1089: prompt version v108, and the prompt pinned to its version (10 October 2026)

**No rules change; the prompt version.** asp67's arena of 10 October 18:08 ran on the old system prompt, with `agents-rule-v107` recorded.

The system prompt's command list is generated from the tool definitions. Since b1084 its explore line reads `explore: tile, then?, unitType?, unitIds?`. The version was not bumped with that change. A saved arena prompt is replaced by the default only when the version changes, so saved prompts kept the old line, `explore: tile, unitType?, unitIds?`. Those were the only seven characters that differed. The models still had `then` in their tool definitions and used it, but the prompt's own list did not show it.

**Now:**
- `UIManager.ARENA_PROMPT_VERSION` is **agents-rule-v108**. A saved prompt, and any slot prompt that was a plain copy of it, is replaced by the current default on the next load. Real edits are kept, as before.
- `tests/prompt-version.test.cjs` pins the default prompt's sha256 to the version (`tests/prompt-version.json`). Any change to the prompt text fails it until the version is bumped and both are recorded, including one that arrives through a tool parameter, as this one did.

## Build 1088: a chin and a smile (10 October 2026)

**No rules change; the unit faces.** asp67: the clean-shaven faces' chins were as wide as the whole head.

**The chin.** The Romans and the Maya had a jaw two thirds the width of the head, a shelf across the lower face. It is now a small rounded chin under the mouth, inside the head's outline.

**The mouth**, on every civilization:
- It was a flat dark slit the width of the lips, set in a raised skin lip, and read as a frown or a pout. It is now a short line with its two corners turned up.
- The lip surround is smaller, and drawn only where there is a beard, where it keeps the mouth legible against dark hair.

Checked in close-up and at play distance, clean-shaven (Maya, Romans) and bearded (Greek, Viking, Persian).

## Build 1087: the Viking hof's upper storey sits on its roof (10 October 2026)

**No rules change; a model fix.** asp67 saw the upper part of the Viking temple hovering. Its upper storey was a box whose walls ended at height 3.9. The lower roof slopes away from its ridge, and under those walls it stands at only 3.5, which left a gap along both long sides. The box now reaches down to 3.4, into the slope, and keeps its top at 4.9 under the upper roof.

## Build 1086: a rally point fills up instead of churning (10 October 2026)

**Rules change: where a standing order's units stand.** asp67 saw troops sent to a rally point one after the other, with no formation, shove each other about in a moving blob.

**The cause.** Each `move_units` order lays out slots for its own units. One unit's slot is the target point itself. So twelve single-unit orders to one spot all owned the same spot, and friendly separation pushed them off it while their orders walked them back. Measured on a board: twenty single-unit orders to one point still had about twelve units moving at any moment ninety seconds later. A single order for all twenty settled in two seconds.

**Now** a new order's slots avoid the places the same owner's other groups already hold (`StandingOrders.reservedSlots`): the slots of their members still on that order, kept 1.8 apart as slots within one order already were. A whole shape is moved onto open ground when it can be, and otherwise each unit takes the nearest free place. The rally point fills up as a cluster around the point and stands still.

Only the owner's own groups are counted. A unit that has been given a new order no longer holds its old slot.

**Tests.** `tests/rally-point.test.cjs`: twelve single-unit orders to one point. They must move less than 0.05 in ten seconds after arriving, hold distinct places, and stand within 8 of the point. On the old rule they moved 16.8 in those ten seconds.

## Build 1085: towers first only for those the tower can hit (10 October 2026)

**Rules change: retaliation under a standing order.** asp67 watched it happen. An army was sent at a tower. The head of the column walked into the tower's range and was shot, and from then on the whole group answered the tower: a tower always took the front of the group's shared threat queue. The rear, still forty units out, was shot by enemy archers. It walked on toward the tower without answering and was picked off before it arrived.

**Now a hit starts the decision for every member of the group, each from where it stands** (`StandingOrders.threatFor`):
- **Inside a tower's firing range:** the member stays on the tower. That is the same test the tower shoots by: `tower.range`, or 6 when it has none.
- **Outside it:** the member answers a mobile attacker of the group within chase reach (64). It takes the first one in the queue, so alternating hits still do not pull it to and fro.
- **Neither:** with no mobile attacker in reach, it joins the group's target list again, which is the tower.

The periodic scan asks the same question, so a member keeps its own answer instead of being pulled back to one shared focus. Every live threat counts as the group's own fight for leash and release purposes, not only the head of the queue. A mobile threat no member still pursues is dropped from the queue, wherever it stands in it.

Reproduced in the real rules (two militia at the tower, three archers 40 out under archer fire):
- **Before:** the archers died walking on, without a shot; the enemy archers lost nothing.
- **Now:** the militia stay on the tower and the archers turn on their attackers within one scan.

**Tests.**
- `tests/standing-orders.test.cjs` gains the head/tail case: the head stays on the tower, the tail answers the raider and then rejoins the tower. It fails on the old rule.
- The existing siege test now gives its stub tower a real range (18), which its units stand inside.

**Prompt.** Unchanged. "prioritizing towers until destroyed" still holds for the members a tower can hit.

## Build 1084: a scout takes a route of up to three tiles (10 October 2026)

**Command change: `explore` takes `"then"`.** Besides `"tile"`, a model may name up to two more tiles, visited in order: `{"tile":"C5","then":["D5","E6"]}`.

**Why.** On the large map a scout reached its tile and then stood still until its seat's next turn, often 15 to 60 seconds later. Each tile also cost a command slot.

**How a route runs.**
- Any unit may take a route, a worker too. asp67's ruling: the model decides; a worker sent on a three-tile loop goes.
- Each next tile is aimed when the unit reaches the one before it, at the darkest part of that tile for its owner. That is the same aim a fresh explore of the tile gets, so it heads for what is still unseen *then*.
- This runs in the simulation step (`Game.continueRoute`, called where workers and other units arrive), so Playback walks the same route.
- The last arrival ends exactly as a plain explore does: the unit stops there, and a worker is no longer counted as scouting.

**How a route ends early.** A route is held against the point its order aimed at. If the unit arrives anywhere else (a new order, a build it was pulled to, a node), the route is over. A new explore always replaces an old route.

**What the model is told.**
- The reply names the route: "…to scout tile C5 (~12s to arrive), then D5, then E6."
- `ordersInProgress` carries `{"order":"explore","unitIds":[…],"to":[x,z],"route":["D5","E6"],"secondsRemaining":…}` while tiles remain after the leg in progress. The last leg is a plain explore and is not listed.
- `game-state-schema.json` declares `route` and widens the `unitIds` and `order` wording.

**Refusals.** Nothing is sent when either applies:
- more than three tiles in all: new outcome code `exploreRouteTooLong`, classed *reference*;
- a bad label in `"then"`: `exploreBadTile`.

A list written as one string ("D5, E6") is read as the same list.

**Prompt.** The system prompt is unchanged. The tool definitions grow by about 35 tokens to about 2,630, so the tool-schema tripwire in `tests/prompt-budget.json` is raised from 2,600 to 2,660, recorded there.

**Tests.** `tests/explore-route.test.cjs`:
- a worker walks three tiles in order and ends as a plain explore does;
- a later order ends the route;
- too many tiles or a bad tile sends nothing;
- a soldier walks a route too.

## Build 1083: a second match plays like the first, and Playback (10 October 2026)

**No rules change; a determinism fix.** The transcript of the match played at 00:24 on 10 October stopped in the analyzer at step 34,137 (input 409): "diverged". So did the one from 11:35. The match before them, played first after a page load, replayed to the end.

**The cause.** Two game-level clocks were never reset between matches:
- the auto-defense reflex runs every 600 ms on `game._autoDefTimer`;
- the contact scan takes the seats in turn by `game._contactTurnIdx`.

A second match in the same page started both part-way through the last match's beat. A re-simulation is always a fresh page and starts them at zero.

In the 00:24 match the defense beat started 300 ms in. A Maya scout picked a fight with a Roman militia at the edge of the Roman base, and the Roman army answered it six steps earlier than the replay's did. Replayed with the beat started at 300 ms, the match passes the point where it stopped; every other phase stops there.

**The fix.** `resetTimeline()` resets both, as it already did the brain's discovery beat for the same reason. Matches recorded before this build that were not the first in their page may still stop at their first fight.

**Tests.** `tests/match-carryover.test.cjs` starts a match, plays an odd number of steps, then starts a second match in the same page. Every number the game, the brain and the harness keep must equal a fresh page's, and the two must play the same match. It names any field that carries over, not just these two.

**Playback.** The analyzer's "Re-simulate" is now **Playback** (Wiedergabe, Reproducción, 回放), in its chip, its mode label and its "unavailable" message.

**Tool.** `tools/bench/transcript-replay.cjs` passes the transcript's map size to the rebuilt match. It rebuilt every large-map transcript at 800 and diverged at step 0.

## Build 1082: the whole late-game map in a third of the frame (10 October 2026)

**No rules change; drawing only.** A late game on the large map, with most of it explored and the camera pulled back to show all of it, stuttered. Measured on the same scene: 65 % of the map explored along scout trails, 416 units, 76 buildings, four towns. Before, a frame was about 17,600 draw calls and 27 ms. Now it is about 4,200 draw calls and 7 ms. The fog, its texture and the minimap together cost under 4 ms twice a second, so they were not the cause.

**Resource nodes are drawn in chunks.**
- Every node in a 64-unit square is merged into one mesh per material.
- A tree was five draw calls: shadow, trunk, two branches and crown. The explored forests alone came to about 8,000 draw calls.
- A chunk is built the first time it has something to show.
- A node that is depleted, or still under fog, is not rebuilt out. Its vertices are collapsed to a point in place and restored when it shows again, so felling a tree costs one small buffer write.

**A unit seen from far away is one still mesh per material.**
- Past zoom 150 (the shadows are gone by 160), a unit's bone-groups are merged at their rest pose.
- Its small plain textures (skin, hair, leather, iron, feathers) are merged too, each painted its texture's average colour from a 64×1 palette.
- The seat colour, the badge and the shadow keep their own draws.
- About 4 draw calls a unit instead of 11 to 17. At that zoom a unit is two or three pixels tall.
- A unit still turns, bobs, flashes and fades. A death ghost snapshots whichever model was drawn.

**The draw loop sets only what changed** from the draw before: texture, tint, alpha, material and the rest.

Covered by `tests/resource-chunks.test.cjs`:
- the merge matches the existing one;
- a forest is a few draws;
- a felled or fogged tree collapses in place and comes back;
- a far unit keeps every vertex in at most five meshes.

## Build 1081: the patrol's start declared, and five tests from a contributor (8 October 2026)

**No rules change; a contract fix and tests.** From pull request #3 by baristahaus, written against build 1054 and brought onto this build by hand: the parts that still apply, with two tests adjusted to later decisions.

**The contract.**
- `ordersInProgress[].from` is declared in `game-state-schema.json`. The rules have put a patrol's origin there all along (`js/standing-orders.js`, patrol mode only), so a model can read the whole route. A reader built from the contract would never have learned it exists.
- `to` and `from` both say they hold exactly two numbers (`minItems`/`maxItems` 2). `items: integer` alone accepts a one-number array and leaves a missing z.
- `tests/lib/schema-check.cjs` checks the two length keywords, and `tests/contract.test.cjs` asserts they bite.

**New tests:**
- `host-classifier.test.cjs`: which hosts count as private, the check in `js/boot.js` that hides the API-key screens on a public copy. It covers the lookalikes, such as `127.0.0.1.attacker.example` and `172.32.x`, and the `?full=1` opt-out.
- `state-contract.test.cjs`: the newest shipped sample emits every field the schema requires, and nothing it does not declare.
- `shipped-files.test.cjs`: every script `index.html` loads exists, carries a version tag and is loaded once, and no `js/` file goes unused.
- `roster-advancement.test.cjs`: the unit upgrade paths and the training tables agree. Two of its tests were adjusted here:
  - the scout cavalry is excepted, because it stays a scout by design (b1055);
  - the advancement table covers all seven civilizations.

**Not taken:**
- `match-determinism.test.cjs` duplicates `tests/rng.test.cjs`.
- The pull request's changelog entry and build number referred to build 1054.

## Build 1080: the large map by default (7 October 2026)

**Default change.** asp67: "it works very well".
- A new arena or campaign is played on the 1200 map unless a size was chosen and saved. The picker lists Large first.
- A replay still rebuilds the size its transcript names, and one that names none was played on 800.
- The Bench realm stays on 800, so its baselines and golden traces keep their meaning. The showcase stays on 800 too.

**One more refusal coded.** `move_units` with neither coordinates nor a tile now reports `moveNeedsCoords`, as the same mistake already did elsewhere. Seen on 7 October, a model wrote its coordinates into the reason and sent none. The Bench could not tell that from a harness fault.

## Build 1079: a formation faces its front at rest (7 October 2026)

**Look only.** Found by asp67: a standing formation and the way its men face fell apart.

A formation is laid out along its line of march, but a unit kept facing its last step once it stopped. Forming up close by, those last steps are sideways shuffles into the slots. Now a unit remembers its formation's front while it marches in formation, turns to it in place once it stands, and forgets it when a plain move order takes it elsewhere. A fight still turns it to its enemy.

**Measured** in the browser, an arena seat forming a line six units off: the six faced 18-157 degrees off the front before, and 0 after. On a long march they already arrived facing the front.

## Build 1078: buildings drawn in batches (7 October 2026)

**Performance only; nothing changes on screen.** Found by asp67: some of the new buildings caused lag.

**The cause:** every part of a building was its own draw call, and twice a frame with the shadow pass. Most models have 5-59 parts, but the Colosseum has 225, so one of them cost as much as a small town.

**The fix:** a finished building is now drawn the way units already were, as one merged mesh per material (texture, owner colour, authored tint, blending). Each model is built once and cached. Sites under construction keep their parts, because the growing shell needs its own.

**Measured** in a headless browser:

| Scene | Draw entries for buildings | Renderer time per frame |
|---|---|---|
| Roman Iron-age showcase | 619 → 137 | |
| Same, plus 16 Colosseums in view | 4251 → 281 | 6.84 → 2.68 ms |

A GPU pays driver time per draw call on top of that. A pixel diff of the showcase, old against new, shows the same picture.

## Build 1077: the Maya scout, and what scouts are for (7 October 2026)

**Prompt change (agents-rule-v107) and a unit rename.** asp67's question: how does a model know that scouts and cavalry are faster and see farther? It did not. The state lists a unit only by its id and cost, and the prompt said nothing about speed or sight.

- **The prompt now says so**, as asp67 worded it: "Cavalry and scouts see further than other units (22.5 against 15); scouts and cavalry are also the fastest units." It is one fact of the world among the others. The system prompt's tripwire went from 2450 to 2480 tokens for it.
- **The Maya's walking scout is `scout`**, shown as "Scout" (German "Kundschafter"). It was `spotter`. Its id now names its job, as `scout_cavalry`'s does. Its research is still `scouting`, now described as "Unlocks the scout at the barracks".
- **Older transcripts** that name a `spotter` still draw it with its parrot.

## Build 1076: jittered spawns, identical homes (7 October 2026)

**Rules change (the arena's map layout).** asp67's aims, on both map sizes:
- The WAR Platform's spawn layout, so no model can work out where its rivals start.
- Every seat starting from the same ground.

**The layout** is ported from the Platform (`platform/server/spawns.cjs` → `TerrainManager.arenaSpawns`):
- The whole layout turns by a random angle, and its centre moves up to 25 off the map's.
- Each seat's angle moves up to 4 degrees, and its distance (290-320) up to 12.
- Which seat gets which place is shuffled.
- A layout where one seat's rivals are more than 12% nearer, rank for rank, than another's is drawn again.
- Everything scales with the map, and it is drawn from the map seed on its own stream, so a replay rebuilds it.

**Every seat's home is identical to the pixel.** A disc around each Town Center, with the area of one map tile (radius about 58), takes in the Town Center's whole sight (40).
- The scatter that falls inside it is left out; its draws are still taken, so the rest of the map lands where it always did.
- One tile's normal count of food and wood is laid out instead, at one shared set of offsets turned with each seat's bearing to the map centre. Each copy must stand on land, or no seat gets it.
- Stone and gold already kept 95 away from every Town Center, and now follow each seat's offset (the Platform's shifted rotation), so they too are identical.

**Measured** over 25 seeds × 4 seats, as food bushes within Town Center sight at the start, gap between seats in one match:

| Setting | Before | After |
|---|---|---|
| Summer | 2.4 | 0 |
| Winter | 1.2 | 0 |
| Desert | 0.9 | 0 |

The amounts are unchanged, as asp67 asked: in the desert about half of all starts still see no food, but then every seat in that match sees none.

**Not changed:** the campaign keeps its even circle. Transcripts record `spawnLayout`, so the analyzer rebuilds older matches on their circle and new ones on their layout.

**Golden trace:** opening-economy was re-recorded (its map moved).

## Build 1075: the Vikings in brown-grey (7 October 2026)

**Look only.** At asp67's request, the Vikings' colour is a dark brown-grey (0x5e5248), like weathered wool and iron, instead of cyan. Tunics, shields, the Royal hall's shield row, the lineup chips and the buildings' accent all follow it.

## Build 1074: academy doors (7 October 2026)

**Look only.** Found by asp67: the academies' doors had the same fault as the Maya house's. The door trim measures from the ground, but the academy doors stand on a plinth, so every culture's trim lay across the doorway: pediments, lintels, torii beams, arches, posts.

- **Iron age:** the trim now sits over the door, on top of the 0.8-high stylobate.
  - On a door this wide the Roman arch springs a little lower, so its crown stays under the eaves.
  - The Roman houses' arches are unchanged.
- **Bronze age:** no trim. The columned porch is that academy's entrance, and under the porch roof there is no room for a trim over the door. Set over the door, pediments, arches and posts went through the porch roof.

## Build 1073: Maya stairs and the Iron-age house door (7 October 2026)

**Look only.** Found by asp67:

**Stairs instead of ramps.** The Maya Town Centers and temple had a ramp up the front, laid at the wrong angle. All of them, El Castillo included, now have a flight of real steps. Each step is a solid block from the ground to its tread.
- Each flight stands out in front of the terraces, as the Maya built them. A flight laid against the base would have had the stepped terraces poking through it.
- El Castillo keeps its balustrades along the same line.

**The Iron-age Maya house door.** The house stands on a platform in the Iron age, but its lintel was placed for a door on the ground, so it lay across the doorway. It now sits over the door.

## Build 1072: horses of many coats (7 October 2026)

**Look only.** asp67: every horse wore the same tan.

Horses now wear one of five coats from the beards' palette: the old tan, bay, black, grey-white and chestnut.
- The coat is picked per rider, like hair, from its stable identity, so a horse keeps its coat through redraws, age-ups and replays.
- A black horse has a black mane and tail, and a grey one a white mane and tail.
- Egypt's chariot horse is included.

## Build 1071: the Persian Town Center's roof (7 October 2026)

**Look only.** Found by asp67: the Bronze-age Persian Town Center's red roof sat low on its box, and the gold finial floated 0.8 above its tip. The roof now stands on a short drum, and its tip meets the finial. The Iron-age Town Center and the temple were already built this way.

## Build 1070: Rome in red, behind the scutum (7 October 2026)

**Look only; no rules change.** asp67: make the Romans more obviously Roman.

- **Colour:** the civilization's colour is a deep Roman red (0x8b1e1e) instead of Tyrian purple. It is less than half as bright as Persia's tomato red, so the two stay apart. Tunics, crests, the lineup chips and the buildings' accent follow it.
- **Shield:** Roman soldiers carry the scutum, a tall curved rectangle in the owner's colour with a gold edge, a gold boss, and gold wings above and below it. Everyone else keeps the round shield.

## Build 1069: houses of their own for the four originals (7 October 2026)

**Look only; no rules change.** Greece, Egypt, Persia and Yamato built the shared timber hut in the Bronze age and the shared plaster box in the Iron age. Only the palette and the door trim told them apart. Each now has its own pair:
- **Greeks:** a whitewashed house on a stone footing under a low tiled gable, with a columned porch and an amphora. Then a Cycladic white cube with a flat roof, a smaller cube on top, an outside stair, and door and shutters in the owner's colour.
- **Egyptians:** battered mudbrick with a reed sun shelter on the flat roof. Then two storeys with a roof-terrace parapet, a gold band, and a date palm by the door.
- **Persians:** a mudbrick cube under a dome with a glazed band. Then a house with a badgir (a windcatcher tower) and a glazed dome.
- **Yamato:** a minka on posts with a veranda, a paper door, and a steep thatched hip-and-gable roof with crossed finials. Then a machiya of dark timber with paper screens, two tiled roofs, and the noren in the owner's colour.

## Build 1068: a scarlet macaw, and Maya plumes in colour (7 October 2026)

**Look only.** asp67's notes, with a photo of a scarlet macaw for the parrot:

**The parrot is a scarlet macaw:**
- Each wing is three flat triangles: red coverts at the shoulder, a yellow band, then long blue flight feathers.
- The tail is a long red point over broader blue outer feathers.
- The team-coloured tail is gone, so the bird is all macaw.

**Maya plumes in colour:**
- A worker wears one bright green plume.
- A single-plumed soldier (militia and the other first-rank units, the spotter among them) wears one red plume.
- The many-plumed (soldiers of rank and the priest) wear a fan of red, green, yellow and blue.

## Build 1067: the parrot flies beside its spotter (7 October 2026)

**Look only.** asp67's notes on b1066:
- **The wings are flat triangles,** smaller than b1066's ovals: a broad one at the shoulder and a narrow, pointed one behind it for the tip.
- **No more circling.** When the spotter walks, the parrot lifts off and keeps pace beside it: 1.1 out on its left, at the same height as before (about 4.6), facing the way it walks, its wings beating. It lands back on the shoulder when the spotter stands.

## Build 1066: the parrot's wings (7 October 2026)

**Look only.** asp67's notes on b1065:
- **A quarter smaller in flight:** drawn 1.275 times its size instead of 1.7. Perched, it keeps its size.
- **Two real wings, bright green, one on each side.** Each is a broad inner wing with swept-back primaries. Folded, they lie flat along the body; in flight they swing out about 70 degrees and beat. b1065 had one small gold wing.

## Build 1065: the spotter's parrot takes flight (7 October 2026)

**Look only; no rules change.** asp67's idea: the parrot marks the spotter from afar.

- **While the spotter walks,** the macaw rises off its shoulder over about a second. It circles 1.8 out and about 4.6 up, banked along its path, wing beating, and is drawn 1.7 times larger so it reads at a playing zoom.
- **When the spotter stops,** the parrot glides back down to the shoulder.
- **How it works:** the bird has two bones of its own, the body and the wing. The renderer eases the lift per unit, and the replay's still frames keep it perched.

## Build 1064: the Maya grow maize (7 October 2026)

**Look only; no rules change.** asp67's suggestion: the Maya's fields grew wheat, as everyone's but Yamato's did.

They now grow maize. Each plant is a tall stalk with broad leaves arching out, a cob on its side and a tassel on top. The stalk and leaves are green, and the cob and tassel are the yellow tips.
- The plants stand taller and further apart than the grains: 7 rows of 8 in the Iron age, small clumps in the Bronze age.
- Romans and Vikings keep wheat, and Yamato keeps rice.

## Build 1063: temples of their own (7 October 2026)

**Look only; no rules change.** Found by asp67: the new civilizations' temples fell through to the generic sanctuary. That is a columned portico, which reads as a copy of the Greek temple.

- **Romans:** a round temple of Vesta. A podium with steps carries a ring of twelve columns around the round cella, under a conical tiled roof with a gold finial.
- **Vikings:** a hof. A stave-built hall with stacked shingle roofs and dragon heads, the sacred ash beside it, and an altar stone before it.
- **Maya:** a temple pyramid in the Tikal manner. Five narrow, steep terraces, a stair, the shrine and its high roof comb, so it stays distinct from the Maya's wide, low Town Center platform.

## Build 1062: the Roman door (7 October 2026)

**Look only; no rules change.** Found by asp67 in the showcase.

The Roman door trim of b1061 set a solid white disc on the lintel. It covered the doorway and reached up into the roof.
- It is now a real arch: two pilasters carry seven stones, with a keystone, over a round-topped opening.
- The arch is sized from the door, so it fits the house, the insula and the academy alike.
- The Roman house door now stands on the ground, under the arch, in both ages.

## Build 1061: the new civilizations look like themselves (7 October 2026)

**Look only; no rules change.** Found by asp67 in the civilization showcase.

**The Colosseum had its floor on the roof.** It was built from solid drums with the sand laid on top. It is now a ring of arcaded wall segments, with seating stepping down to an arena floor at ground level.

**The showcase showed the Maya with riders and a stable.**
- It built a fixed list of buildings and paraded a fixed list of shared units.
- Now it builds only what the civilization can build: the Maya have no stable.
- It shows every unit the civilization fields at that age, its own included. That is new for all seven: hoplites, samurai, legionaries, spotters.

**Town Centers, houses and academies were plain copies** with a different palette. In the Bronze and Iron ages, each new civilization now has its own:
- **Romans:**
  - Town Center: a domus around an atrium in the Bronze age, a castrum with gate towers and a domed principia in the Iron age.
  - House: a tiled cottage, then a two-storey insula.
  - Academy: a basilica library with an apse.
  - Door: an arch.
- **Vikings:**
  - Town Center: a turf longhouse with crossed gables, then a ring fort with a palisade around the hall.
  - House: a turf house.
  - Academy: a steep rune-masters' hall inside a ring of runestones.
  - Door: carved crossing posts.
- **Maya:**
  - Town Center: a council house on a stepped platform, then a palace with a corbel vault and a roof comb.
  - House: a stucco na under a tall thatch.
  - Academy: an observatory dome.
  - Door: a corbel lintel.
- **Stone and Neolithic:** the huts stay shared, as for the originals. Each civilization has a small marker: a standard, a shield or a stela.

## Build 1060: the Maya (7 October 2026)

**A seventh civilization, with no horses at all.** The Maya cannot train scout cavalry, cavalry or heavy cavalry, and have no horseback research, so they cannot build a stable.

**Their first scout walks** (asp67's design):
- **The spotter** is trained at the barracks from the Neolithic: 60 HP, 3 attack, speed 1.9, for 130 food.
- It sees 22.5, as far as a rider, and carries a parrot on its shoulder to show it.
- **It sits behind its own research, Scout trails:** 150 food / 100 wood / 50 gold at the Town Center, in the Neolithic. That is horseback's price plus the 50 gold the others pay for their stable. The Maya build no stable, so the gold is paid here.

**Bonus, Maize farming:** farms give 30% more food. The farm depletes by the base amount; the extra is food it did not have to give, so a field lasts just as long. Every civilization without the bonus multiplies by exactly 1.

**Own units:**
- **Jaguar warrior** (barracks, Bronze): 110 HP, 14 attack, speed 1.2, for 90 food / 20 wood / 40 gold.
- **Plumed archer** (archery range, Bronze): 60 HP, 9 attack, range 13, speed 1.2, for 80 food / 40 wood / 30 gold.

**Own techs:**
- Obsidian blades (Stone age, Town Center, needs barracks): infantry +3 attack.
- Scout trails: the spotter's gate, above.
- Maya calendar (Neolithic, academy): Town Center +25% training speed.
- Cotton armour (Bronze, academy): all military +15 HP. Iron working requires it.

**Wonder:** El Castillo, nine terraces with a stair up the front and the temple on top.

**A unit can now sit behind a research of its own** (`requiresTech` on the unit). Every path that trains reads it:
- The model's train command answers `[ERROR] spotter needs the research "scouting" first` and names the call. The outcome code is `unitNeedsTech`, classed as a constraint.
- The model's unit list shows the spotter under `units.blocked` with `blockedBy: ["tech"]` and `requiresTech`. No other unit's entry changes.
- The player's train menu shows it locked, naming the research.
- The rule-based AI skips it.

**Explore's automatic pick** is now the farthest-seeing idle soldier, taking the first of equals. It was "the first rider, else the first soldier": the same pick while only riders saw farther. Now the spotter is chosen too.

**Look:**
- Feathers instead of iron: soldiers wear a fan of plumes on a gold band and no helmet. Everyone else wears one plume on a cloth band, and priests wear a tall headdress.
- The Maya are clean-shaven.
- Buildings are white stucco under palm thatch, and the civilization's colour is jade green.

**The rule-based AI trains** jaguar warriors and plumed archers. It never fills a barracks with spotters, because a scout is not a soldier.

## Build 1059: the Vikings (7 October 2026)

**A sixth civilization, on the same pattern as the others.**

**Bonus, Raid:** every soldier (infantry, cavalry and ranged) does 25% more damage to buildings. It stacks with Fire Arrows. Workers and priests do not get it. The multiplier is new rule code, and every civilization without the bonus multiplies by exactly 1, as before.

**Own units:**
- **Berserker** (barracks, Bronze age): 90 HP, 15 attack, speed 1.3, for 70 food / 20 wood / 30 gold. The hardest blow of its age for its price, on the thinnest hide.
- **Axe thrower** (archery range, Neolithic): 60 HP, 9 attack, range 6, for 60 food / 40 wood. Half the archer's reach for half again its blow.

**Own techs:**
- Mead hall (Stone age, Town Center, needs barracks): infantry +3 attack.
- Runestones (Neolithic, academy): all units +20% sight.
- Shield wall (Bronze, academy): infantry +20 HP.
- Chain mail (Bronze, academy): all military +15 HP. Iron working requires it.

**Wonder:** the Royal hall, a long turf-roofed hall with dragon-head gables and a row of shields in the owner's colour.

**Look:**
- Soldiers wear an iron cap with a nose guard, and no horns. Everyone else wears a wool cap.
- Hair is blond or brown.
- Buildings are tarred timber under turf, and the civilization's colour is cyan.

**The rule-based AI trains** berserkers, and axe throwers until the Iron-age bows outrank them.

## Build 1058: the Romans (7 October 2026)

**A fifth civilization, playable in every arena seat.** Built on the pattern the four originals share: one bonus, two own units, four own techs (one of them +15 HP for all military), iron working, and the shared 15,500 Wonder.

**Bonus, Engineering:** villagers build 30% faster.

**Own units:**
- **Legionary** (barracks, Bronze age): 150 HP, 12 attack, speed 1.0, for 90 food / 30 stone / 40 gold. A warrior with 30 more health for 30 more resources.
- **Equites** (stable, Bronze age): 130 HP, 12 attack, speed 2.1, for 110 food / 45 gold. They take the shared cavalry's place: a little lighter, quicker and cheaper. The Iron-age heavy cavalry stays shared.

**Own techs:**
- Aqueduct (Stone age, Town Center, needs farm): villagers gather +15%.
- Roman roads (Neolithic, academy): all military +10% speed.
- Testudo (Bronze, academy): infantry +20 HP.
- Lorica segmentata (Bronze, academy): all military +15 HP. Iron working requires it.

**Wonder:** the Colosseum, three arcaded tiers around an open arena floor.

**Look:** soldiers wear the galea's crest across the helmet, and everyone else a laurel band. Romans are clean-shaven. Buildings are travertine under terracotta, and the civilization's colour is Tyrian purple.

**The rule-based AI trains** legionaries and equites.

**The four originals are unchanged,** and they stay the default arena lineup.

## Build 1057: a large map, as a match option (7 October 2026)

**New option; the 800 map is unchanged.** The setup screen has a map size beside the difficulty:
- **Standard:** 800 × 800 in 7 × 7 tiles, the map every match so far was played on.
- **Large:** 1200 × 1200 in 11 × 11 tiles.

**The large map has more tiles of the same size.** A tile is still about 114 units across, and an exploration cell about 18. Labels run A–K and 1–11.

**What grows with it:**
- The island: shore at 617 instead of 417. The coast keeps its wobble, and the ground's patches keep their size.
- The spawn circle: 476 from the centre instead of 306. Two seats start 952 apart instead of 612, four about 673 instead of 433, so marches take about 1.5 times as long.
- Food and wood: the same count per tile, so the map has 121/49 times as many.
- Stone and gold: scaled by the same factor, so they stay as dense (stone 40 → 99, gold 18 → 44 on easy). Each seat's share is still identical.
- The camera's zoom-out limit (520 → 780), so the whole island still fits.

**What a model is told:**
- The prompt says "a square {{mapSize}}x{{mapSize}} map", so 800x800 or 1200x1200 (prompt version agents-rule-v106).
- The explore tool no longer names "A-G, row 1-7"; it says a column letter, then a row number.
- Errors and the state already took the grid from the match.

**Transcripts** record `exploreTiles` next to `mapSize`. The analyzer and the replay rebuild the size a transcript names; older transcripts are all 800.

**Measured** in the browser with four rule-based seats on the large map: about 72 frames a second. The ground texture is 2048 instead of 1024, because WebGL1 cannot mipmap any size that is not a power of two; at 1536 the whole ground drew black.

## Build 1056: ready for more civilizations (7 October 2026)

**Rule-based AI change; no rules change for models.** Five places knew only the four civilizations by name. Each would have broken quietly once a fifth arrives.

**The rule-based AI now trains a civilization's own units.**
- Its picks named shared units only. Greece never trained a hoplite or a phalanx, Yamato never a samurai, and Egypt's stable chose the scout over its chariot.
- A civilization's own unit now wins when it belongs to at least the same age as the shared pick, and only when it can be paid for at once. A barracks waiting for a hoplite's stone and gold would otherwise train nothing.
- Persia is unchanged: its own units replace shared ones and were already picked.
- This changes how the Greek, Yamato and Egyptian baselines play.

**Egypt's and Greece's building HP bonus is read from data.** `buildingMaxHealth` matched the bonus by its name ("Pyramide", "Akropolis"). The bonus now carries `buildingHealth` (1.5 and 1.3); the values are unchanged.

**An unknown civilization's academy is no longer Yamato's.** The Iron academy's last branch was Yamato's torii and lantern, so any other civilization would have built them. Yamato now has its own branch; the fallback is a plain portico with a band in the player's colour.

**The UI takes its civilizations from the data.**
- Names, colours, the default arena slots, the showcase list and the analyzer's building test no longer list the four by hand.
- The Wonder check uses each Wonder's `isWonder` flag instead of a list of four types.
- **Visible change:** the lineup chips now wear the colour the army wears on the map. Greece's chips were green against blue units, Yamato's purple against pink, Persia's crimson against tomato red.

**Two tests could not see what they checked.** The hold-mode test read the keys of the unique-unit array (`0`, `1`, ...), so it never checked a unique unit. The Wonder text test asserted exactly four.

## Build 1055: the scout costs no gold, and stays a scout (7 October 2026)

**Rules change; `units.js` and `buildings.js` changed.** asp67's design: the scout cavalry is every civilization's first scout. It is cheap, weak and far-seeing, and meant to find gold and stone before a seat has mined any. Egypt has it too, beside its chariot, which is the fighter.

**The price was 100 food and 30 gold; it is now 150 food and 80 wood.**
- Every seat starts with 50 gold, and the stable costs exactly 50 (horseback costs none).
- With a 30-gold scout, the intended opening needed 80 gold: a seat had to mine gold before it could ride out to find it.

**The scout no longer becomes cavalry at the Iron age.**
- It stays a scout all match.
- Egypt and Greece cannot train cavalry, but their scouts became cavalry anyway.

**Its vision is unchanged:** 22.5, as for all cavalry, against 15 for everything else. That is what makes the later horseback units worth their price.

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
