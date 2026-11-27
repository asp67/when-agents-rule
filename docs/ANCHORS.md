# Anchor styles

An anchor is a fixed opponent to measure a model against. WAR's rule-based AI plays in four styles, chosen per rule-based seat in the arena setup (**Style**). The numbers behind each style are in `AI_PROFILES` in `js/ai.js`.

| Style | Plays like |
|---|---|
| Standard | The classic rule-based AI. |
| Turtle | Big economy, up to three towers. Raises an army of 20, then saves for the next age. Attacks with 20 or more. |
| Legion | Trains the unit class that beats the army it has seen most of. Attacks with 12. |
| Raider | Thinks every second instead of every two. Trains soldiers early, attacks with 4, and goes for workers it can see first. |

Every style plays under the same fog as a model, and since build 1271 inside the same research and age gates: it builds a farm, a barracks or an archery range only once it has researched what unlocks it and reached its age. It acts only on what its own units and buildings have seen, and it searches the map by the same exploration summary a model is shown.

## An anchor belongs to one build of the rules

A rules change can move any style. So a result against an anchor is keyed to the core hash of the rules it ran under. That is the `coreHash` in the transcript's contract line, where rule-based seats are listed under `anchors` with `contractIdentical: false`. Results against the same style under different core hashes are not comparable.

The styles are ordered by calibration, not by their names.

## Calibration

`tools/anchor-calibration.cjs` plays every pair of styles on the same maps as seat-swapped pairs. Each pairing is played twice per map seed: same two civilizations in the same two seats, with only the styles trading places. Whatever a seat, a spawn or a civilization is worth then falls on both styles alike.

A match ends when the game ends it, or after 45 minutes at the arena's default pace, which is 90 minutes of game time (since the run of build 1287; the run of build 944 stopped at 45 minutes of game time). A match reaching the limit is decided by the arena's power score, and within 5% it is a draw.

```
node tools/anchor-calibration.cjs --minutes 45 --seeds 8 --jobs 12 --out calibration.json
```

### Build 1287, core `400df7d1e3af1b7d…`

The first run of the styles that build inside the gates. 96 matches (8 map seeds × 6 pairings × both seatings), Greeks against Persians, 27 November 2026.

- **How matches ended:** 82 ended by elimination, at a median of 15 minutes at the arena's pace (30 of game time). 14 went to the time limit and were decided by the power score; none was a draw.
- **Seat effect:** seat 0 won 36 of the 82 eliminations (41 of all 96). The run below had it at 56 of 83; every pairing is still played both ways.

| Style | Points | Share | Elo-scale fit (Standard = 0) |
|---|---|---|---|
| Legion | 38 / 48 | 79% | +132 |
| Standard | 29 / 48 | 60% | 0 |
| Turtle | 27 / 48 | 56% | −29 |
| Raider | 2 / 48 | 4% | −522 |

Head to head (wins of the row over the column, over 16 games):

| | Standard | Turtle | Legion | Raider |
|---|---|---|---|---|
| **Standard** | | 8 | 6 | 15 |
| **Turtle** | 8 | | 3 | 16 |
| **Legion** | 10 | 13 | | 15 |
| **Raider** | 1 | 0 | 1 | |

How to read it:

- **Legion** leads: it beats Turtle 13 to 3. Its 10 to 6 over Standard is, at 16 games per pairing, not a reliable separation.
- **Standard and Turtle** are level (8 to 8 with each other).
- **Raider** remains the weakest by far, 2 points of 48.
- **Tiers:** Raider at the bottom is clear, as before. Above it the order is Legion, then Standard and Turtle together, and only Legion over Turtle is a clear step.
- **Why it moved:** the run does not say. The gates are one change of many between the two builds.

The Elo-scale column is a Bradley-Terry fit of the head-to-head record, a draw counted as half a win to each, set so that Standard is 0.

The full record, with every match, is in [`anchors/calibration-1287.json`](anchors/calibration-1287.json). Its minutes are not those of the run below: a minute here is two of game time, a minute there is one.

### Build 944, core `a3a843cc9bdcb857…`

The run: 96 matches (8 map seeds × 6 pairings × both seatings), Greeks against Persians.

- **How matches ended:** 83 ended by elimination, at a median of 22 minutes (24 over all 96). 13 went to the time limit.
- **Seat effect:** seat 0 won 56 of the 83 decisive games. This is why every pairing is played both ways.

| Style | Points | Share | Elo-scale fit (Standard = 0) |
|---|---|---|---|
| Turtle | 32 / 48 | 67% | +51 |
| Legion | 32 / 48 | 67% | +51 |
| Standard | 28 / 48 | 58% | 0 |
| Raider | 4 / 48 | 8% | −368 |

Head to head (wins over 16 games):

| | Standard | Turtle | Legion | Raider |
|---|---|---|---|---|
| **Standard** | | 7 | 8 | 13 |
| **Turtle** | 9 | | 8 | 15 |
| **Legion** | 8 | 8 | | 16 |
| **Raider** | 3 | 1 | 0 | |

How to read it:

- **Raider** is clearly the weakest style. It feeds small groups into larger armies.
- **Turtle and Legion** edge Standard by about 50 Elo points. At 16 games per pairing, that is not a reliable separation, and Turtle and Legion are tied with each other.
- **Tiers:** this build gives two clear tiers (Raider, and the other three) and a hint of a third.

The full record, with every match, is in [`anchors/calibration-944.json`](anchors/calibration-944.json). Fitted from that record the way the column of build 1287 is, the Elo-scale values come to +53, +53 and −383; the ones printed above are as published at the time.
