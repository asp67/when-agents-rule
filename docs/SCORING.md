# The evaluation profile (`Scale v4.1`)

WAR scores a model seat on how it played across five orthogonal RTS dimensions, measured deterministically from the recorded match transcript (`js/eval/ledger.js`) and nothing else. Live on-screen panels and post-match exports read the exact same ledger, so numbers shown during a match never diverge from exported reports or season tables.

**Status: Scale `v4.1`.** Builds on `v4` (`20 / 25 / 15 / 15 / 25` fixed weights, situational `3/turn` command batching, passive-vs-justified waits, home-asset raid filtering, Bradley-Terry dominance trajectories, long-horizon context drift, and duration-invariant cognitive efficiency) with three deterministic fairness improvements:
1. **Snapshot-grounded stale-state reconciliation:** Rejections whose preconditions were valid in the exact `o.state` snapshot the model received (after subtracting earlier commands in the same reply) are classified as `contended` (stale world drift), not penalized as model errors — while intra-turn self-conflicts and hallucinated handles (`orderedUnitsGone` for IDs not in `o.state`) remain `avoidable`.
2. **Remnant-mode survival & post-elimination Dominance cap:** Cornered seats without a Town Center or production buildings that hide surviving units and call `wait` are not penalized as passive waiters or stranded idle workers, and post-elimination `pw = 0` ticks in Dominance are capped at `POST_ELIM_CAP_SEC = 300` seconds so dying early no longer depends on how long survivors stalemate afterward.
3. **Fixed-seed rotating Arena Series:** Supports multi-match series (`2–4` matches) on a locked map seed with rotating spawn seats and civilizations, pooled sufficient-statistic pillar aggregation, and deterministic regularized Plackett-Luce ratings (`WarSeason.poolSeries` / `WarSeason.plackettLuce`).

> Always inspect the five pillar bars and their underlying raw facts beside `WAR Score`. One match is one sample against specific opponents on one map; cross-match comparisons belong in the Season Table under matching conditions (`WarConditions`).

---

## Where to read it

| Surface | What it shows |
|---|---|
| Spectator seat cards | Compact 5-column horizontal strip (`Grd · Mac · Spa · Tac · Dom`), `WAR` badge (`Early` in warmup), and batching/cost footer. |
| Live mini card (**B** key / Bench) | Execution mode / warmup badge, 2-line sparkline (`WAR Score` solid + `Dominance` dashed), 5 vertical `G M S T D` equalizer bars, `WAR Score`, and batching footer. |
| Full Comparison Board | Header pills (`LOCKSTEP · Capability` vs `REAL-TIME · Deployment`, `v4`, `WARMUP`), 5 pillar + `WAR Score` curves, Decision Inspector (`Loop`, `Awareness`, `Constraint`, `Passive wait`, `Home raid`, `Refused`), rolling cost/error sparklines, and a 5-part diagnostic summary table. |
| Left Bench Drawer | **Plan Tracker (Qualitative · Unscored)** showing raw `objective`, plain `steps`, and revision ticks, plus the **Home Threat Clock**. |
| Broadcast Lower-Third (**C** key) | Cycles through all 5 pillars plus two spotlight slides (**Action bandwidth** and **Long-horizon drift**). |
| Results Screen & Markdown (`.md`) | Interactive 5-pillar matrix with turn-level evidence drilldowns and shareable `1600 × 900` Pareto scatter SVG (`WAR Score` vs `Output tok / valid order`, `Speed`, or `Tokens / dec`). |
| CLI (`node tools/eval/war-eval.cjs <match.jsonl>`) | Prints all 5 pillar tables, batching & waits, cognitive cost & drift, versatility facts, and `WAR Score` (`--json` emits the full profile object). |

`js/eval/ledger.js` sits outside both `WarManifest.rules` and the harness hash (`coreHash` in `js/manifest.js`).

---

## The five scored pillars (`WAR Score`)

Every scored pillar outputs `0..100` (or `null` only when unrecorded in legacy pre-build-1023 files lacking command outcomes). **WAR Score (`index.value`)** is the fixed weighted average over `WarEval.SCORED`:

| Pillar | Weight | What it measures |
|---|---|---|
| **Grounding** | `20%` | Severity-weighted command validity (`reference`/`invalid` errors penalized 2.5×, `constraint` 1.0×, repeats 1.5×) with Bayesian smoothing `K = 8`. |
| **Macro & Agency** | `25%` | Economic growth vs time targets (`40%`), operational discipline (`30%` gated), and situational parallel batching vs passive waits (`30%` gated). |
| **Spatial & Fog** | `15%` | Map exploration vs time targets (`55%`), rival discovery ramped after minute 4 (`25%`), and spatial command grounding (`20%`). |
| **Tactical & Combat** | `15%` | Value-weighted battle & building exchange (`65%`) blended with home-asset raid & rival Wonder response (`35%`). |
| **Dominance** | `25%` | Time-weighted Bradley-Terry power dominance trajectory (`75%` at match end, `100%` live) + final rank placement (`25%`). |

**Warmup guard:** While a seat has `< WarEval.WARMUP_SEC` (`300` seconds) elapsed AND `< WarEval.WARMUP_RATED` (`15` rated commands), `warmup: true` is set: `WAR Score` still renders smoothly, gold `.is-lead` leader highlights are suppressed, and boards display a `WARMUP` / `Early` badge.

---

### 1. Grounding (`20%`)

- **Rated denominator:** `rated = ok + avoidable + invalid - waits`. Waits can never fail, so they leave `rated` and `rate = (ok - waits) / rated`. Contended (`contended`) and harness faults (`harnessFault`) leave both sides.
- **Severity & repeat weighting:** Mistakes are classified via `WarEval.classOf(o)` (matching `WarBench.CLASSES` in both browser and Node CLI):
  - `reference` (includes `verdict === 'invalid'` and reference hallucinations such as `targetOutOfSight`, `unknownUnit`, `offMap`, `unparsedCall`): weight **2.5**
  - `constraint` (visible resource, pop cap, age, or building prerequisite limits): weight **1.0**
  - `repeated` (same `code` refused again within `WarEval.REPEAT_WINDOW = 2` decisions): additional weight **1.5**
- **Formula:**
  $$\text{Grounding} = 100 \cdot \exp\left(-4.5 \cdot \frac{1.0 \cdot \text{constraint} + 2.5 \cdot \text{reference} + 1.5 \cdot \text{repeated}}{\text{rated} + 8}\right)$$
  When outcomes are recorded (`judged > 0` or `unjudged === 0`) and `rated === 0` (`do-nothing`, `wait-only`, `plan-only`), Grounding is **`0`** (not `null`). Pre-build-1023 unjudged transcripts yield `null`, and weights re-normalize cleanly over the remaining four pillars.

---

### 2. Macro & Agency (`25%`) — Situational Batching & Passive Waits

Measures both economic fundamentals and executive agency — solving why rigid 1-command models and passive wait-spammers lose to proactive opponents even at high grounding validity:

1. **Development vs smooth time targets (`devScore`, 40%):** Compares peak `workers - 3`, `population.used - 3`, `friendlyBuildings - 1`, researched techs, and age advancements against smooth time curves (`workerTarget = min(20, 4 + 0.6*t)`, `popTarget = min(45, 5 + 1.3*t)`, `bldTarget = min(14, 2 + 0.35*t)`, `techTarget = min(12, 0.35*t)`, `ageTarget = min(3, t/12)` with `t = max(1, min)`). Subtracting starting Town Center + 3 workers ensures idle or `assign_workers`-only seats stay at `devScore = 0`.
2. **Activity gate:** `activityGate = clamp01(devScore / 25)`. Passive operational metrics and agency bonuses cannot score for a seat that never grows past the starting baseline.
3. **Operational hygiene (`opsScore`, 30% × `activityGate`):** Combines idle worker ratio (`50%`, `100 * exp(-4.5 * avgIdle)`), non-population-capped rate (`25%`), and resource float control (`25%`, allowing banking headroom up to `min(4500, nextEpochCost)` while saving to advance an age).
4. **Situational command batching & passive waits (`agencyScore`, 30% × `activityGate`):** Each decision computes `openFronts` (`0..maxCommands`, default `3`) from visible state alone:
   - idle workers (`+1`), near pop cap with `>= 50` wood (`+1`), home threat (`+1`), affordable epoch advance (`+1`), affordable non-banking tech (`+1`), idle military/TC trainers with headroom and `>= 120` resources (`+1`, or `+2` when `2+` trainers, `2+` headroom, and `>= 350` resources).
   - Valid non-wait orders deduct at most **one** `assign_workers` per turn (`productiveOk`), preventing safe worker micro-spam from inflating bandwidth.
   - Turns with `0` non-wait commands split cleanly into **Justified waits** (`openFronts === 0`) vs **Passive waits** (`openFronts >= 1`), exposed directly on every card via the `[3 | 2 | 1 | J | P]` stacked bar (`bwUtil` + `parallelRate` at `2+` fronts + `exp(-3.5 * passiveWaitRate)`).

---

### 3. Spatial & Fog (`15%`)

- **Exploration (`55%`):** Peak map exploration mean (`maxExplored`, excluding a `2%` baseline) scaled toward `expTarget = min(55, 6 + 1.1 * activeMin)`.
- **Discovery (`25%`):** Share of map rivals discovered, smoothly ramped from `0` to `1` between minute `4` and minute `16` (blended with exploration early on).
- **Spatial Grounding (`20%`):** `100 * exp(-5 * spatialErrors / (spatialOrders + 6))` over spatial actions (`attack_target`, `move_units`, `explore`, `build_structure`, `repair_building`) and spatial refusal codes (`targetOutOfSight`, `offMap`, `exploreBadTile`, `notDiscovered`, etc.).

---

### 4. Tactical & Combat (`15%`)

- **Home-Asset Threat Filter (`WarEval.HOME_RADIUS = 110`):** `underAttack` entries count as raids only when attacking friendly buildings, workers, or friendly units within `110` world units of any friendly building (plus revealed rival Wonders). Offensive units fighting inside an enemy base do not trigger false unanswered-threat penalties.
- **Raid Defense (`homeDefScore`, 35%):** An answer is a successful command within `WarEval.RESPONSE_WINDOW = 3` decisions (`<= 1` is "at once") aimed within `WarEval.RESPONSE_RADIUS = 50` (`attack_target`, non-scouting `move_units`, `build_structure(tower)`, `repair_building`, or `assign_workers` when workers are threatened). Uses empirical Bayes smoothing `(atOnce + wonderAnswered + 1.5*g) / (episodes + wonders + 3)` where `g = activityGate`.
- **Value-Weighted Combat Exchange (`exchangeScore`, 65%):** When chronicle `battle` events include `lostValue` (`js/chronicle.js`, outside rules hash), losses weight by full unit resource cost and razings (`building-lost = 150`, `town-center-lost = 600`, `wonder-lost = 1000`); legacy transcripts fall back cleanly to headcounts (`1 / 4 / 6`). Multi-party battles (`> 2` sides) split opposing losses fairly by `1 / otherSides`.

---

### 5. Strategic Dominance (`25%`)

- **Time-weighted Bradley-Terry trajectory (`trajDom`):** Over 5-second `timeline.samples` weighed by `w = 1 + t / 300`:
  $$\text{ref} = 0.5 \cdot \max(\text{others}) + 0.5 \cdot \text{mean}(\text{others}), \qquad \text{dom}(t) = \frac{1}{1 + (\text{ref} / \text{mine})^{1.5}}$$
  Returns exact **`50.0`** at an even tie, stays immune to 4-player early eliminations inflating survivors to `100`, and prevents endgame placement cliffs.
- **Blend:** Live (`until != null` or no `results` line): `100% * trajDom`. Final (`results` present): `0.75 * trajDom + 0.25 * placement`. A clear lead requires `WarEval.LEAD_FACTOR = 1.25` for `WarEval.LEAD_SECONDS = 300`.

---

## Qualitative Plan Tracker (Unscored)

Programmatic regex step-grading (`planning` and `follow`) was removed completely: keyword rules misclassified non-English plans, status summaries, valid defensive pivots, and paraphrases. Left panel (`#benchLeft`) now serves solely as an **unscored qualitative plan viewer** displaying each seat's standing `objective`, plain bulleted `steps`, and revision clock ticks (`plan.history` also marks plan revisions on the Race chart).

---

## Duration-Invariant Cost & Long-Horizon Drift

Cumulative ratios (`Index / totalTokens`) previously rewarded weak models that died in 8 minutes over models that fought for 90 minutes. `v4` reports **strictly duration-invariant metrics beside the profile (never mixed into `WAR Score`)**:

- `tokensPerDecision`, `promptPerDecision`, `completionPerDecision`
- `outputPerValidOrder` (`completionTotal / okNonWait`) — verbosity per executed action (default Share X-axis)
- `effectiveOrdersPerMin` (`okNonWait / (thinkingMsTotal / 60000)`) — thinking throughput
- `scorePer10kTokPerDec` (`WAR Score / (tokensPerDecision / 10000)`) — Pareto value efficiency
- `drift` (enabled at `WarEval.DRIFT_MIN_DECISIONS = 16`): splits turns into first half vs second half to surface context rot directly — `errDeltaPp` (rated error delta in percentage points), `idleDeltaPp` (idle worker delta in pp), and `latencyRatio` (late / early median latency).
- `WarShare.HARNESS_MIN_MS = 1000`: harnessed seats reporting `< 1s` inter-turn wall time are omitted from the speed scatter axis (`share.js`).

---

## Anchors

`tools/eval/anchors.cjs` runs five deterministic baseline policies against the standard rule-based AI in headless simulation and scores their transcripts through the exact production `WarEval` ledger:

| Anchor | What it does |
|---|---|
| `do-nothing` | Sends `commands: []` every round |
| `wait-only` | Sends one `wait` every round |
| `plan-only` | States a 5-step plan on round 1, then sends `wait` forever |
| `safe-spam` | Cycles `assign_workers` food ↔ wood every round (100% valid, zero growth) |
| `random-valid` | Sends 1–3 randomly sampled visible actions per round (`WarBench.randomValidPolicy`) |

Measured calibration (`node tools/eval/anchors.cjs --minutes 10 --seeds 1`, `core d0304003cd0c489c`, `Scale v4`):

| Anchor | Rated valid | Grounding | Macro | Spatial | Tactical | Dominance | WAR Score |
|---|---:|---:|---:|---:|---:|---:|---:|
| `do-nothing` | `–` | `0` | `0` | `12` | `0` | `3` | **`2.5`** |
| `wait-only` | `–` | `0` | `0` | `12` | `0` | `3` | **`2.5`** |
| `plan-only` | `–` | `0` | `0` | `12` | `0` | `3` | **`2.5`** |
| `safe-spam` | `100.0 %` | `100` | `0` | `12` | `0` | `4` | **`22.8`** |
| `random-valid` | `33.3 %` | `3` | `25` | `42` | `29` | `4` | **`18.4`** |

Zero-growth seats (`do-nothing`, `wait-only`, `plan-only`) sit at the floor (`2.5`); pure safe worker shuffling (`safe-spam`) gets `0` Macro and `0` Tactical (`22.8` WAR Score total); and uncoordinated random commands (`random-valid`) collapse on Grounding (`3`) for `18.4` WAR Score — far below real playing models (`47.5 – 90.5` across shipped samples).
