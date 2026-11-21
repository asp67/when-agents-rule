# The evaluation profile

WAR scores a model seat on how it played, not on how the match went. The profile has five
scored parts, a row of facts about the range a seat used, and the cost of a decision beside
them. Everything is read from the match transcript and nothing else, so a recorded match
can be scored again at any time and gives the numbers the page showed while it ran.

**Status: scale `v1`, provisional.** The definitions below are built and tested, and the
scores have been checked against anchor seats (see [Anchors](#anchors)). That check changed
two things, which is what `v1` is. Read the bars and what they rest on. Do not quote a
single number as a result.

## Where to read it

| Where | What |
|---|---|
| Seat cards while watching | One bar per part, and the Index. The tooltip says what each bar rests on. |
| Bench view (key **B**) | The parts by seat, with the raw measure, the trend over ten minutes and the decisions behind each cell. |
| `node tools/eval/war-eval.cjs <match.jsonl>` | The same numbers as tables. `--json` gives the full profile. |
| `game.ui.evalLedger().profile()` | The profile object in the page's console. |

The code is `js/eval/ledger.js`. It is outside both the rules hash and the harness hash:
scoring a match differently never changes what a match is.

## The parts

| Part | The question | The measure | Score |
|---|---|---|---|
| **Grounding** | Were its commands valid when it issued them? | Commands that worked, of those that worked or were refused for a reason its state had shown. A `wait` is left out. | 90 % valid is 0, 100 % is 100, straight line between. |
| **Planning** | Does it hold a live, concrete plan? | Share of decisions under a stated plan; share of plan steps that name something checkable; share of shocks (attacked, heavy losses, a rival Wonder) followed by a changed plan within three decisions. | The mean of the three. No shock: the first counts twice. Never stated a plan: 0. |
| **Follow-through** | Does it do what its plan says? | Of the new, checkable plan steps: those an order that worked carried out within ten decisions. | The share acted on. No plan: 0. |
| **Tactical** | Shown a threat, is its next order aimed at it? | Attacks on its own things and rival Wonders, from the decision whose state first showed them. An answer is an order that worked and is aimed there: an attack or march to it, the threatened units moved out, a tower or repair on the spot. | The share answered in the same or the next decision; for a rival Wonder, within three. |
| **Strategy** | Does its play turn into winning? | Placement; its share of all power over the match against an even split; the share of battle losses that were the other side's. | The mean of the three. Half again an even share is full marks. |

What each part deliberately leaves out:

- **Grounding** leaves out commands refused for something no state could have warned of
  (`contended`: a trainer that became busy in the same instant), the harness's own
  failures, and every `wait`: a wait can never be refused, so it is evidence of nothing.
  All three are counted and shown, and are in neither side of the rate.
- **Planning** counts a plan as changed only when its text changed. Saying the same plan
  again changes nothing.
- **Follow-through** counts only orders that worked. A refused order carries nothing out.
  Training more soldiers does not answer "build a tower".
- **Tactical** does not count training as an answer, and does not score whether the town
  was held: that is a matter of strength as well. What the attack cost is shown beside it.
- **Strategy** uses the game's own power score exactly as the timeline recorded it. Its
  name and formula are unchanged.

A dash means the match gave no chance: a seat that was never shown a threat has no Tactical
score. A zero is a measured zero: a seat that never stated a plan has Planning 0.

### Facts beside the scores

- **Range used.** Unit types, buildings, technologies and kinds of order a seat used with
  success. It has no score. Range for its own sake proves nothing, and nothing in the record
  yet ties a choice of unit to what the seat had seen of its rival.
- **Strategy facts.** Share of the time ahead; a clear lead (a quarter more power than the
  next seat, held five minutes) and whether it was turned into the win; when each age was
  reached; battles, with what was destroyed and lost.
- **Cost.** Median and 90th-percentile answer time, tokens in and out, completion tokens per
  order that worked, orders per decision, missed rounds. Never part of a score.

### The Index

The mean of four parts, as many as have a score: Grounding, the plan as far as it was
followed, Tactical and Strategy. The number of parts it rests on is shown with it.

"The plan as far as it was followed" is Planning times Follow-through, as one part. The two
bars stay separate on screen, because they answer different questions. In a single number
a plan that was never played must count for nothing: no plan is 0, a full plan nobody acted
on is 0, and a plan too young for its steps to have been followed or dropped is left out.

The Index is shown only with the bars. One match is one sample of one model against
particular opponents on one map: compare models on the parts, over several matches.

## How a plan step is read

Follow-through and the "checkable steps" of Planning depend on reading a plan step written
in free text: does "raise 6 archers, then take the eastern gold" commit to something an
order can confirm? The reader (`WarEval.checkable`) works from cue words and from the names
the seat's own state had shown it.

It was measured against 384 plan steps from shipped matches, read by hand. On the 192 it
was never adjusted against, 91.1 % of what it reports is in the step, and it finds 91.7 %
of what is. The steps and labels are in `tests/eval-reader-steps.json`, and a test
recomputes the rates: a change to the reader that moves them fails until the stated rates
are updated. The labels are one reader's judgement (Claude Fable 5.2, 21 November 2026) and
have not been checked by a second.

## Anchors

`tools/eval/anchors.cjs` plays seats that cannot play against the rule-based opponent
(Standard style) and scores them with the same ledger. A scorer that pays one of these
seats is paying for something other than playing.

| Anchor | What it does |
|---|---|
| do-nothing | Answers every round with no command. |
| wait-only | One `wait` a round. |
| plan-only | States one concrete five-step plan in its first round, then only waits. |
| random-valid | One to three commands a round, built only from names and places its state shows. |

Twelve matches, 40 minutes each, a decision every 30 seconds, three map seeds, core hash
`d13976c3e047f6dd`, 21 November 2026, on scale `v1`:

| Anchor | Grounding | Planning | Follow-through | Tactical | Strategy | Index |
|---|---:|---:|---:|---:|---:|---:|
| do-nothing | – | 0 | – | – | 6 | 3.3 |
| wait-only | – | 0 | 0 | – | 6 | 3.3 |
| plan-only | – | 100 | 0 | – | 6 | 3.3 |
| random-valid | 0 | 0 | 0 | 50 | 6 | 10.0 |

For comparison, the four model seats of the 5 October sample have an Index of 39.5, 63.0,
69.2 and 75.8.

What the table says:

- All four anchors sit at the floor of the Index. Random play is valid 37.0 % of the time
  and scores Grounding 0.
- Strategy is at the floor for all four: they place last and hold a tenth of the power.
- **The plan-only seat still has a Planning bar of 100.** That is by design: Planning
  measures the stated plan, Follow-through says it was never played, and the Index counts
  the two together. Read alone, the Planning bar says only that a plan was stated.
- **Tactical on one threat is chance.** The random seat was shown two threats in three
  matches and answered one, by attacking the only rival unit in sight. That one answer is
  its whole Index. A Tactical score needs the count beside it, which the Bench view and the
  scorer print.

The first three anchors were eliminated in two of three matches without their state ever
showing an attack: with a decision every 30 seconds the final rush fell between two states.
That is why their Tactical is a dash and the plan-only seat met no shock.

### What the first run changed

On scale `v0` the same twelve matches gave the wait-only seat Grounding 100 and an Index of
26.6, and the plan-only seat Grounding 100, Planning 100 and an Index of 51.6: above a
model that had played for 99 minutes. Two definitions were wrong, and `v1` changes them:

- **A `wait` was free credit.** It can never be refused, so each one counted as a valid
  command. Among shipped matches, waits were up to 27 % of a seat's judged commands. A wait
  is now counted, shown, and left out of the rate. A seat that only waits has no Grounding
  score.
- **The Index was a plain mean of five bars**, so a stated plan paid whether or not it was
  played. A plan now counts as far as it was followed.

What that did to nine reference seats. Their order within each match is unchanged:

| Seat (match) | Grounding v0 | v1 | Index v0 | v1 |
|---|---:|---:|---:|---:|
| GPT 6.1 Sol (5 Oct) | 63.0 | 61.5 | 49.8 | 39.5 |
| Claude Sonnet 5.5 (5 Oct) | 94.3 | 94.3 | 73.4 | 69.2 |
| DeepSeek V4.1 Flash (5 Oct) | 69.9 | 69.9 | 69.6 | 63.0 |
| GLM 5.3 Flash (5 Oct) | 66.9 | 66.3 | 80.1 | 75.8 |
| Qwen3.8 Flash-Next NVFP4 (17 Oct) | 47.1 | 47.1 | 61.4 | 52.9 |
| Qwen3.8 Flash-Next Q2_0 (17 Oct) | 85.6 | 85.6 | 58.9 | 49.0 |
| Gemini 4 Argon (17 Oct) | 100 | 100 | 89.3 | 86.7 |
| pi (7 Nov) | 3.2 | 0 | 48.9 | 30.8 |
| Hermes (7 Nov) | 90.8 | 90.8 | 79.5 | 74.0 |

Still open: a seat that repeats one real, safe command (assign a worker to food, every
round) is valid every time and keeps Grounding 100. Its other bars show what it is. No
anchor for it has been run.

To run the anchors again:

```
node tools/eval/anchors.cjs --minutes 40 --seeds 3
```

A run belongs to one build of the rules and prints the core hash it was played under.

## Limits

- **One match is one sample.** Scores move with the opponents, the map and the civilization.
- **Opponents are not adjusted for.** Strategy against three strong seats and against one
  weak seat are different tasks with the same scale.
- **Outcomes are recorded from build 1023 on.** An older file has no Grounding,
  Follow-through or Tactical score; the scorer says so.
- **MCP seats may plan outside the `plan` tool.** A harness that keeps its plan in its own
  notes shows Planning 0 here, even when it wins.
- **Battles with three or more sides.** A seat is credited with every other side's losses
  in a battle it took part in.
- **Workers pulled back with `assign_workers`** are not seen as protected by Tactical.
- **The anchors' Strategy has no battle part.** The chronicle is page code and does not run
  in the headless realm.

## The match heuristic

The 0-100 match heuristic on the results screen (command success 34, progression 20,
format 18, reliability 15, action diversity 13) is still there and still in the exports. It
summarizes one match and is not part of the profile. It moves into a folded Legacy block
when the profile comes to the results screen.
