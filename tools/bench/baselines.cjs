'use strict';
// WAR Bench baselines (review #8 step 5): the floor and the ceiling every model result
// is read between.
//
//   noop          answers nothing, every round
//   random-valid  one to three commands a round, each built only from names and places
//                 the state shows: unit types it owns or can train, buildings it can
//                 build, techs on offer, enemies in sight, tiles on the map. It may be
//                 refused for the world's reasons (cannot afford, busy, nobody free) --
//                 constraint errors -- but must never earn a reference error: it never
//                 names anything that is not there. tests/bench-baselines.test.cjs holds
//                 it to that across every scenario and variant.
//   scripted      the scenario's reference solution, which must score 100 %
//
// Seeded: the same scenario, variant and attempt give the same commands every time.
// The policies themselves live in js/bench-core.js (b1091), shared with the browser.
const { BASELINES, randomValidPolicy, rngFor } = require('../../js/bench-core.js');

module.exports = { BASELINES, randomValidPolicy, rngFor };
