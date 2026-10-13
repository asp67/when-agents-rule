'use strict';
// A WAR Bench run, scored (review #8 step 6): success rates with Wilson intervals --
// overall, per family, per scenario -- the mean score with partial credit (b1091),
// pass^k for every k the attempts allow, and what became of every command, by outcome
// class. The scoring itself lives in js/bench-core.js, so the browser's Benchmark page
// and Node score a run with the same code.
const { score, rate } = require('../../js/bench-core.js');

module.exports = { score, rate };
