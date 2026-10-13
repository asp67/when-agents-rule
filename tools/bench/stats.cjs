'use strict';
// WAR Bench statistics (review #8 step 6). Small, exact where it can be, and seeded
// where it cannot: a report must come out the same every time it is computed.
// wilson, choose, passHatK and cellsOf live in js/bench-core.js (b1091), shared with the
// browser's Benchmark page; the paired bootstrap, which compares two whole runs, is Node's.
const { wilson, choose, passHatK, cellsOf, rngFor } = require('../../js/bench-core.js');

// Stratified paired block bootstrap of the difference in mean score between two runs
// over the SAME cells (A - B). The score is the success rate where a scenario is pass or
// fail, and carries partial and graded credit where it has them (b1094): a graded
// scenario has no successes at all, so a success rate would read every run as equal. A block is one cell with all its attempts; blocks are
// resampled with replacement within their family, so every family keeps its weight.
// Returns the observed difference and a percentile interval from `reps` resamples.
function pairedBootstrap(resultsA, resultsB, { reps = 2000, level = 0.95, seed = 'bench' } = {}) {
    const A = new Map(cellsOf(resultsA).map(c => [c.key, c])), B = new Map(cellsOf(resultsB).map(c => [c.key, c]));
    const keys = [...A.keys()].filter(k => B.has(k)).sort();
    if (keys.length !== A.size || keys.length !== B.size) throw new Error('pairedBootstrap: the two runs must cover the same cells');
    const strata = new Map();
    for (const k of keys) {
        const fam = A.get(k).family;
        const diff = A.get(k).scoreSum / A.get(k).n - B.get(k).scoreSum / B.get(k).n;
        (strata.get(fam) || strata.set(fam, []).get(fam)).push(diff);
    }
    const fams = [...strata.keys()].sort();
    const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
    // The statistic: the mean over families of each family's mean difference, so a
    // family with more cells does not outweigh the others.
    const stat = pick => mean(fams.map(f => mean(pick(strata.get(f)))));
    const observed = stat(xs => xs);
    const r = rngFor('bootstrap:' + seed);
    const draws = [];
    for (let i = 0; i < reps; i++) draws.push(stat(xs => xs.map(() => xs[Math.floor(r() * xs.length)])));
    draws.sort((a, b) => a - b);
    const q = p => draws[Math.min(reps - 1, Math.max(0, Math.round(p * (reps - 1))))];
    const tail = (1 - level) / 2;
    return { diff: observed, lo: q(tail), hi: q(1 - tail), reps, level, cells: keys.length, families: fams.length };
}

module.exports = { wilson, choose, passHatK, cellsOf, pairedBootstrap, meanScore: require('../../js/bench-core.js').meanScore };
