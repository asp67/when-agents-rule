# Arena action camera

The director keeps its cinematic shots, but live action now has explicit priority:
decisive combat, other combat, imminent attacks, then ambient scenes.

- First damage wakes the director for its next rendered frame. Subsequent damage
  is aggregated independently of battle-ring and minimap throttles.
- Threats are checked every 100 ms. Actual attack targets and nearby enemies on
  attack-move routes qualify when the estimated time to attack range is at most
  two real seconds. Prediction accounts for range, building radius, march speed,
  target movement, and effective simulation speed. Distant orders and fleeing
  targets do not qualify just because an attack was ordered.
- Encounters keep an identity from approach to contact. Prediction and combat
  bypass the ambient contact-shot cooldowns, including repeat encounters between
  the same players. Combat frames include both sides.
- Fresh action interrupts ambient shots immediately. Competing live fights use
  a hold of 800 ms at 1x, reduced with simulation speed to a 300 ms minimum.
  Wonders and Town Centers near destruction can interrupt that hold.
- The current scene is rescored alongside challengers. Recent damage has a
  1.5 simulation-second window; surviving engaged opponents keep a fight live
  between hits. Finished encounters stop offering combat shots. A quiet ending
  can linger for at most its remaining shot hold, and fresh action interrupts it.
- Army size, recent hit activity, important targets and damage relative to
  remaining health affect priority. The near-destruction heuristic uses damage
  in the recent window; it is not an exact prediction of a kill.
- Manual follow remains authoritative. Cinematic timelapse settings retain
  ambient pacing but do not multiply urgent combat delays.

## Diagnostics

Open the arena with `?dir=1` (or append `&dir=1`) to see shot candidates and
finished-encounter coverage totals. In the browser console,
`game._director.coverage` holds the most recent 200 finished encounters:

| Field | Meaning |
| --- | --- |
| `firstHit`, `lastHit` | Wall-clock timestamps of damage notifications |
| `firstCovered` | First rendered frame with a live attacking pair inside the central 90% of the viewport; null when missed |
| `latencyMs` | First coverage minus first damage, clamped to zero for advance coverage; null when missed |
| `visibleMs` | Sampled visible combat time, with per-frame gaps capped at 250 ms |

`game._director.staleCombatCuts` counts combat cuts whose first measured frame
contains no visible live attacking pair. `encounters` contains current records.
Metrics are reset with the director; no match transcript or remote logging is changed.

Projection checks verify framing, not occlusion by buildings or HUD panels.
Coverage is aggregate per encounter: one visible attacking pair does not mean
every participant is visible. A single camera still cannot cover every simultaneous
fight. The next-frame latency target assumes an actively rendering browser tab.

## Validation

Run `node --test tests/*.test.cjs`. The director tests cover urgent interruptions,
advance coverage, rejected false predictions, attack-move, 4x simulation,
timelapse, simultaneous fights, repeated encounters, decisive sieges, stale
damage, manual follow, and coverage retention.

For visual tuning, watch a live arena with `?dir=1` at 1x and 4x and inspect
coverage alongside short skirmishes and simultaneous assaults. Browser rendering
and real model matches remain necessary to tune the prediction horizon and framing;
the deterministic tests validate decisions rather than the cinematic appearance.
