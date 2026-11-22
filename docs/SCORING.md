# The evaluation profile

WAR scores a model seat on how it played, not on how the match went. The profile has five
scored parts, a row of facts about the range a seat used, and the cost of a decision beside
them. Everything is read from the match transcript and nothing else, so a recorded match
can be scored again at any time and gives the numbers the page showed while it ran.

**Status: scale `v3`, provisional.** The definitions below are built and tested, and the
scores have been checked against anchor seats (see [Anchors](#anchors)). That check changed
two things (`v1`); the first real match watched with the Bench view changed a third (`v2`),
and a match watched on 22 November a fourth (`v3`).
Read the bars and what they rest on. Do not quote a single number as a result.

## Where to read it

| Where | What |
|---|---|
| Seat cards while watching | One bar per part, and the Index. The tooltip says what each bar rests on. |
| Bench panels (key **B**) | The parts by seat, with the raw measure, the trend over ten minutes and the decisions behind each cell. An overlay: it adds to analyze mode or to broadcast mode and replaces nothing of either. |
| Broadcast lower third (key **C**, broadcast mode) | One part at a time, every model seat side by side, changing every nine seconds and stepping aside for captions. A part is shown only when every model seat has had at least five opportunities for it (five rated commands, five decisions, five closed plan steps, five threats, five minutes of power readings). |
| Results screen | The same matrix, at the end of a match and in the Results card during one. A decision in a cell's list opens in the analyzer. |
| Saved results (`.md`) | A table of the parts and the Index per model seat. |
| The transcript's `results` line | `profile`: every number of the profile, without the long lists behind them. |
| `node tools/eval/war-eval.cjs <match.jsonl>` | The same numbers as tables. `--json` gives the full profile. |
| `game.ui.evalLedger().profile()` | The profile object in the page's console. |

The code is `js/eval/ledger.js`. It is outside both the rules hash and the harness hash:
scoring a match differently never changes what a match is.

## The parts

| Part | The question | The measure | Score |
|---|---|---|---|
| **Grounding** | Were its commands valid when it issued them? | Commands that worked, of those that worked or were refused for a reason its state had shown. A `wait` is left out. | 90 % valid is 0, 100 % is 100, straight line between. |
| **Planning** | Does it hold a live, concrete plan? | Share of decisions under a stated plan; share of plan steps that name something checkable; share of shocks (attacked, heavy losses, a rival Wonder) followed by a changed plan within three decisions. | The mean of the three. No shock: the first counts twice. Never stated a plan: 0. |
| **Follow-through** | Does it do what its plan says? | Of the new, checkable plan steps that are settled: those whose every commitment an order that worked carried out, within ten decisions of being stated or later while the step still stood in the plan. A step can commit to several things ("find and destroy their Town Center": to look, and to attack). | The share carried out; a settled step with only part of it done counts for that part. No plan: 0. |
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
  Training more soldiers does not answer "build a tower". A step is settled when it was
  carried out, when the seat took it out of its plan with no order behind it, or when the
  match ended with it undone. Until then it is open and counts for neither side: an age-up
  or a raid "once an army exists" takes as long as it takes.
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
`d13976c3e047f6dd`, 21 November 2026, on scale `v2` (the same as on `v1` and on `v3`: no
anchor carries a plan step out):

| Anchor | Grounding | Planning | Follow-through | Tactical | Strategy | Index |
|---|---:|---:|---:|---:|---:|---:|
| do-nothing | – | 0 | – | – | 6 | 3.3 |
| wait-only | – | 0 | 0 | – | 6 | 3.3 |
| plan-only | – | 100 | 0 | – | 6 | 3.3 |
| random-valid | 0 | 0 | 0 | 50 | 6 | 10.0 |

For comparison, the four model seats of the 5 October sample have an Index of 43.8, 63.0,
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

### What the first real match changed

On `v1` a plan step was called dropped ten decisions after it was stated. In a match where
a model decides every twenty seconds that is three minutes: "upgrade to the next age" and
"raid once an army exists" were struck out long before either was possible. On `v2` a step
stays open while it stands in the plan, and one carried out late is carried out (the
scorer still says how many were late). It is dropped when the seat takes it out of its plan
with no order behind it, or when the match ends with it undone.

| Seat (match) | Follow-through v1 | v2 | Index v1 | v2 |
|---|---:|---:|---:|---:|
| GPT 6.1 Sol (5 Oct) | 42.9 | 64.3 | 39.5 | 43.8 |
| Claude Sonnet 5.5 (5 Oct) | 75.8 | 75.8 | 69.2 | 69.2 |
| DeepSeek V4.1 Flash (5 Oct) | 75.6 | 75.7 | 63.0 | 63.0 |
| GLM 5.3 Flash (5 Oct) | 89.1 | 89.1 | 75.8 | 75.8 |
| Qwen3.8 Flash-Next NVFP4 (17 Oct) | 73.6 | 72.0 | 52.9 | 52.6 |
| Qwen3.8 Flash-Next Q2_0 (17 Oct) | 87.5 | 76.2 | 49.0 | 46.5 |
| Gemini 4 Argon (17 Oct) | 92.2 | 94.1 | 86.7 | 87.2 |
| pi (7 Nov) | 66.7 | 66.7 | 30.8 | 30.8 |
| Hermes (7 Nov) | 50.0 | 100 | 74.0 | 89.3 |

A score goes up where steps were carried out late (GPT 6.1, Hermes) and down where steps
were still open when the match ended and now count as undone (the two Qwen seats).

### What a match on 22 November changed

Until `v3` a plan step counted as carried out with the first thing it commits to. Three
minutes into a match of 22 November a seat in the Stone Age was shown four of four steps
carried out, among them "Find and destroy the Egyptian rival's town center and military
buildings": it had sent one scout. "Advance to neolithic age, then build barracks/archery
range and train an army" was ticked for the barracks. On `v3` a step is carried out when
everything it commits to is. Until then it is **begun**, and open. A step that is settled
with only part of it done, because the seat took it out of its plan or the match ended, is
carried out **in part** and counts for that part: one of three commitments is a third. The
plan panel shows a begun step with how much of it is done, the marks in the world tick a
step only when it is whole, and "decisions until carried out" now counts to the last
commitment, not the first.

What a commitment needs is unchanged: an order of the right kind that worked. "Destroy
their Town Center" is carried out by an attack order, not by the Town Center falling. The
part measures whether a seat does what it says, and what came of it is Strategy.

| Seat (match) | Follow-through v2 | v3 | Index v2 | v3 |
|---|---:|---:|---:|---:|
| GPT 6.1 Sol (5 Oct) | 64.3 | 53.6 | 43.8 | 41.7 |
| Claude Sonnet 5.5 (5 Oct) | 75.8 | 75.8 | 69.2 | 69.2 |
| DeepSeek V4.1 Flash (5 Oct) | 75.7 | 68.2 | 63.0 | 61.5 |
| GLM 5.3 Flash (5 Oct) | 89.1 | 83.9 | 75.8 | 75.0 |
| Qwen3.8 Flash-Next NVFP4 (17 Oct) | 72.0 | 67.6 | 52.6 | 51.7 |
| Qwen3.8 Flash-Next Q2_0 (17 Oct) | 76.2 | 64.3 | 46.5 | 43.9 |
| Gemini 4 Argon (17 Oct) | 94.1 | 91.8 | 87.2 | 86.7 |
| pi (7 Nov) | 66.7 | 54.2 | 30.8 | 26.7 |
| Hermes (7 Nov) | 100 | 100 | 89.3 | 89.3 |

Over the 38 seats of the shipped matches that stated checkable steps, Follow-through goes
down by 4.8 points at the median and by 12.9 at most; four seats are unchanged. The Index
goes down by 0.9 at the median and 4.1 at most. No score goes up: the rule only takes
away credit for steps that were begun and not finished.

Still open: a seat that repeats one real, safe command (assign a worker to food, every
round) is valid every time and keeps Grounding 100. Its other bars show what it is. No
anchor for it has been run.

To run the anchors again:

```
node tools/eval/anchors.cjs --minutes 40 --seeds 3
```

A run belongs to one build of the rules and prints the core hash it was played under.

## Across matches: the season table

One match is one sample. The Season page (main menu) and `node tools/eval/season.cjs`
add a model's profiles up over matches, under three rules.

**Only the same conditions are added together.** A seat's result joins the results of
other seats with the same conditions id: the same rules code, the same contract family
(prompt, tools, limits, history mode, harness), the same ruleset and protocol. That is
`WarConditions`, the rule the results screen already uses. A different scoring scale is a
different group too. Seats whose conditions were not recorded are listed and compared with
nothing. Two seats of one match can have different contracts, and then each belongs to its
own group: sitting at the same table does not make two results comparable.

**A mean says how sure it is.** From two matches on, every mean has a 95 % interval
(Student's t over matches, cut to the 0-100 scale). One match has a number and no
interval.

**Nothing is called ahead unless it is apart.** A model is marked ahead on a part only if
it and every other model in the group have at least two matches and its interval touches
none of theirs. Otherwise the table says "not separated yet". A single match never makes
a leader.

**A mean is never shown without its spread** (build 1225). Under the interval stand the
lowest, the median and the highest match, every match is a tick on the cell's track, and a
column lists the model's place in every match, oldest first. Nothing is picked: a mean of
60 made of 40, 45 and 95 shows as exactly that.

**Who played is said** (build 1225). A row is tagged *Raw model* (the model's own answers
through the game's request loop) or *Agent harness* (an agent framework over MCP with the
model inside it), from the `settings` of the match's first line. A table that holds both
says so: a harness brings its own memory, tool loop and retries, which no transcript sees.

Beside the means:

- **Head to head.** How often two models met, and who placed above whom.
- **Seat-swapped rematches.** Two matches on the same map seed with the same civilization
  in every seat, in which two models traded seats. The mean of their difference over the
  pair no longer contains what the seat, the spawn or the civilization was worth. The
  results screen has a button for it: "Rematch, seats swapped". One pair is one sample;
  from two pairs on the difference has an interval, and it is apart only if the interval
  excludes zero.

Where the matches come from: the samples that ship with WAR (`samples/season.json`), every
arena match that ends in the browser (a small entry is kept: scores and who sat where, no
prompts or replies; it can be forgotten on the page), and transcript files added on the
page, which are scored on the spot.

What the shipped matches say, 21 November 2026: of 20 matches, ten sets of conditions hold
more than one result. Only one of them compares two models over more than one match:
Hermes and pi met three times, Hermes placed first three times, and is ahead on Strategy
(86.0, between 75.7 and 96.3, against 23.5) and on Follow-through (every step carried out in
all three, against 65.5). On the Index, 79.5 against 28.6, it is not: three matches leave
the intervals touching. Fourteen seats stand alone under their
conditions, and 26 are from matches before conditions were recorded.

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

## The profile in an exported match

From build 1162 on, the `results` line of a transcript carries the profile the match was
shown with. Scoring the file again gives the same numbers: the scorer checks this and says
so in its first lines, or says that they differ, which means the scoring has changed since
the file was written. The scale label travels with the profile for that reason.

The carried profile depends on the placement and the timeline, which are written in the
same breath. It is therefore worked out as it will stand once those lines are in the file,
not as it stood a moment before.

## The scores over the match

From build 1221 on, a transcript also carries a `scores` line, written with the results and
the timeline: the profile as it stood every 30 seconds of the match and at its end. It is
there so the history can be read later without the scorer.

```json
{"type":"scores","kind":"war-eval/1","scale":"v3","everySec":30,
 "fields":["decisions","index","grounding","planning","follow","tactical","strategy",
           "commands","ok","avoidable","invalid","repeated","promptTokens","completionTokens","thinkingMs"],
 "seats":[{"id":"ai_1","seat":0,"civ":"greek","name":"...","model":"..."}],
 "samples":[{"t":30,"v":{"ai_1":[1,null,100,0,null,null,50,2,2,0,0,0,5210,340,4100]}}]}
```

A sample holds one row of numbers a seat, in the order `fields` gives. The seven scores come
first, as the profile had them at that second (`null` where a part could not be scored yet);
then what they were counted from so far (commands given, how many worked, how many were
refused for a reason the state had shown, how many could not be called, how many repeated a
mistake); then what it cost so far (tokens in and out, and the time spent waiting for answers).
Token counts are 0 for a seat whose harness reports no usage, as an MCP seat's does not.

Nothing in the line is new knowledge. It is `profileAt()` asked once a sample, so scoring the
file again gives the same rows, and for a file from before build 1221 the rows are worked out
on reading (`ledger.history()`). The last sample is the profile as it stood at the last
second, before the placement was known; the final profile, which knows the placement, is
the one in the `results` line. The two can differ in Strategy and so in the Index.

## The comparison board

The Bench view's panel shows a mini card, and a click opens the board at full size (builds
1222 to 1227). The full size also opens from the results screen (the button under the
report card) and in the transcript analyzer (*Comparison*, in its bar), where it reads the
loaded file. Nothing on the board is a new score. It lays out what the ledger already holds.

**One grid: a column a model, so the models stand side by side.** Three sections from top
to bottom, in the mini card and at full size alike (the layout of build 1227; the first one,
which stacked the models and put the power graph under gameplay, was thrown out):

- *Gameplay*: Grounding, Planning, Follow-through, Tactical and Strategy over the match, in
  one graph a model (the `scores` line above). Under it a strip of the decisions that went
  wrong (the decision inspector, below).
- *Model performance*: three graphs over the match, each on ONE scale for all models:
  seconds a decision, tokens a decision, and the share of orders refused. Each is the rate
  of the seat's latest decisions (its last three or more), not a running total, so a
  slowdown, a growing prompt or a run of refusals shows as a slope.
- *Summary*: one table, a row a figure: the Index and its five parts, cost, discipline, and
  what the game's harness did for the seat. The better value of a row stands out.

Not on the board: the power graph (the Race chart has it), the matrix with the decisions
behind every cell (the report card on the results screen has it), and the chart to share.

**It must not hold the game up.** While a match runs the board is drawn again whenever a
decision arrives. A sample of the history is scored again only when the decisions, battles
or power readings it rests on have changed in number (`Ledger.liveHistory`), within a
budget of 8 ms a refresh; what does not fit follows in the next refreshes. A refresh keeps
the place the reader had scrolled to.

**Cost and time per task.** Beside the Index stand what it cost: all tokens (prompt plus
completion), the time spent waiting for answers, and two ratios, Index points a million
tokens and Index points a minute of thinking. A seat whose harness reports no usage has no
tokens and no ratio, which is not a zero.

**Discipline.**

| Figure | What it is |
| --- | --- |
| Orders that could not be called | judged orders with the verdict `invalid`, as a share |
| Orders refused for a shown reason | judged orders with the verdict `avoidable`, as a share |
| Mistakes not made again | 1 minus the share of mistakes repeated within the next two decisions |
| Requests lost | requests that failed or were cancelled, and rounds missed |

**The decision inspector** (`Ledger.trace`). Under a model's gameplay graph a strip marks
the decisions to go and read, on the match's clock; a mark says what it is on hover, and a
click opens that decision in the transcript. The number of loops is a figure of the
summary. Five kinds:

| Kind | What the record shows |
| --- | --- |
| Loop | the same order refused for the same reason in three or more decisions in a row; one mark at the first, carrying the run |
| Constraint ignored | an order refused on a limit the state had shown: the price, the population limit, a building not built |
| Lost awareness | an order at something that is not there or cannot be meant: a target out of sight, a tile off the map, a name that does not exist |
| Threat unanswered | an attack on its own town, or a rival Wonder, shown to it and not answered inside the response window |
| Refused | an order refused with no reason code on record |

Which refusal is a constraint and which a reference to something that is not there is the
Bench's own taxonomy (`WarBench.classify` in js/bench-core.js), which a test keeps complete
against the harness's codes. Three decisions is `WarEval.LOOP_MIN`: among the shipped
samples such runs are 3, 4, 4, 6, 19 and 20 decisions long. The inspector scores nothing.

**Raw model or harness** (`harness` in a seat's profile, not in the profile a file
carries). Beside a seat's name stands who plays it, and one row of the summary says what
the game's own harness did for it, from lines the transcript already writes:

- answers with no tool call, whose orders the harness read out of the text (`answeredVia`);
- requests the harness adapted (`adaptation` lines, by kind: a parameter or the tools left
  out after the endpoint refused them, the context shrunk, earlier turns dropped);
- a human's interventions (`intervention` lines: advice, a seat paused and resumed).

A file older than transcript schema 2 does not record the last two, and the board leaves
them out rather than showing 0. What an agent framework does inside itself is in no transcript.

**Charts to share** (js/eval/share.js). One SVG of 1600 x 900 that stands by itself, saved
as it is or as a PNG. A chart sums a match up, so it stands on the results screen under the
report card, not on the live board. For a match: the Index against speed or against tokens
a decision, a point a model, and beside it where on the map each seat sent its orders. For a season group
(Season page): the mean Index with a whisker from the lowest match to the highest, or the
share of matches placed first, against the median time a decision took. A round point is a
raw model, a diamond an agent harness. A seat with no value on an axis is named under the
plot and not placed at zero.

One rule of its own: an agent harness whose median turn ends in under a second has no
speed on the chart (`WarShare.HARNESS_MIN_MS`). The game can only time "state handed over"
to "turn ended" for a harness, and one that keeps working between its turns ends them in
milliseconds: in the shipped samples one has a median of 13 ms beside answers of 100 s.
That is not a thinking time, and it must not read as the fastest model.

## The match heuristic

The 0-100 match heuristic (command success 34, progression 20, format 18, reliability 15,
action diversity 13) summarizes one match and is not part of the profile. On the results
screen it sits in a folded block, "Legacy: match heuristic", under the seat cards. It is
still in every export, named as what it is.
