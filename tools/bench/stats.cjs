'use strict';
// WAR Bench statistics (review #8 step 6). Small, exact where it can be, and seeded
// where it cannot: a report must come out the same every time it is computed.
const { rngFor } = require('./baselines.cjs');

// Wilson score interval for k successes in n trials (95 % by default). Well behaved at
// 0 and n, where the normal approximation collapses to a zero-width interval.
function wilson(k, n, z = 1.959963984540054) {
    if (!n) return { p: null, lo: null, hi: null, k, n };
    const p = k / n, z2 = z * z, den = 1 + z2 / n;
    const mid = (p + z2 / (2 * n)) / den;
    const half = (z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n))) / den;
    return { p, lo: Math.max(0, mid - half), hi: Math.min(1, mid + half), k, n };
}

// C(n, k) as a float, exact for the small numbers a bench uses.
function choose(n, k) {
    if (k < 0 || k > n) return 0;
    let r = 1;
    for (let i = 1; i <= k; i++) r = r * (n - k + i) / i;
    return r;
}

// pass^k: the chance that k independent attempts at the same task ALL succeed, estimated
// without bias from c successes in n attempts as C(c, k) / C(n, k), then averaged over
// tasks. pass^1 is the plain success rate; pass^k falls as k grows unless a policy is
// reliable, which is the point of reporting it. null when no task has k attempts.
function passHatK(cells, k) {
    const usable = cells.filter(c => c.n >= k);
    if (!usable.length) return null;
    return usable.reduce((s, c) => s + choose(c.successes, k) / choose(c.n, k), 0) / usable.length;
}

// Group results into cells (one scenario x variant, all its attempts).
function cellsOf(results) {
    const map = new Map();
    for (const r of results) {
        const key = r.id + '/' + r.variant;
        const c = map.get(key) || { key, id: r.id, family: r.family, variant: r.variant, n: 0, successes: 0 };
        c.n++; if (r.outcome === 'success') c.successes++;
        map.set(key, c);
    }
    return [...map.values()].sort((a, b) => a.key.localeCompare(b.key));
}

// Stratified paired block bootstrap of the difference in success rate between two runs
// over the SAME cells (A - B). A block is one cell with all its attempts; blocks are
// resampled with replacement within their family, so every family keeps its weight.
// Returns the observed difference and a percentile interval from `reps` resamples.
function pairedBootstrap(resultsA, resultsB, { reps = 2000, level = 0.95, seed = 'bench' } = {}) {
    const A = new Map(cellsOf(resultsA).map(c => [c.key, c])), B = new Map(cellsOf(resultsB).map(c => [c.key, c]));
    const keys = [...A.keys()].filter(k => B.has(k)).sort();
    if (keys.length !== A.size || keys.length !== B.size) throw new Error('pairedBootstrap: the two runs must cover the same cells');
    const strata = new Map();
    for (const k of keys) {
        const fam = A.get(k).family;
        const diff = A.get(k).successes / A.get(k).n - B.get(k).successes / B.get(k).n;
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

module.exports = { wilson, choose, passHatK, cellsOf, pairedBootstrap };
