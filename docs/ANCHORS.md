# Anchor styles

An anchor is a fixed opponent to measure a model against. WAR's rule-based AI plays in four styles, chosen per rule-based seat in the arena setup (**Style**). The numbers behind each style are in `AI_PROFILES` in `js/ai.js`.

| Style | Plays like |
|---|---|
| Standard | The classic rule-based AI. |
| Turtle | Big economy, up to three towers. Raises an army of 20, then saves for the next age. Attacks with 20 or more. |
| Legion | Trains the unit class that beats the army it has seen most of. Attacks with 12. |
| Raider | Thinks every second instead of every two. Trains soldiers early, attacks with 4, and goes for workers it can see first. |

Every style plays under the same fog as a model. It acts only on what its own units and buildings have seen, and it searches the map by the same exploration summary a model is shown.

## An anchor belongs to one build of the rules

A rules change can move any style. So a result against an anchor is keyed to the core hash of the rules it ran under. That is the `coreHash` in the transcript's contract line, where rule-based seats are listed under `anchors` with `contractIdentical: false`. Results against the same style under different core hashes are not comparable.

The styles are ordered by calibration, not by their names.

## Calibration

`tools/anchor-calibration.cjs` plays every pair of styles on the same maps as seat-swapped pairs. Each pairing is played twice per map seed: same two civilizations in the same two seats, with only the styles trading places. Whatever a seat, a spawn or a civilization is worth then falls on both styles alike.

A match ends when the game ends it, or at 45 simulated minutes. A match reaching the limit is decided by the arena's power score, and within 5% it is a draw.

```
node tools/anchor-calibration.cjs --minutes 45 --seeds 8 --jobs 12 --out calibration.json
```

### Build 944, core `a3a843cc9bdcb857…`

The run: 96 matches (8 map seeds × 6 pairings × both seatings), Greeks against Persians.

- **How matches ended:** 83 ended by elimination, at a median of 24 minutes. 13 went to the time limit.
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

The full record, with every match, is in [`anchors/calibration-944.json`](anchors/calibration-944.json).
