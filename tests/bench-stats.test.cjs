// WAR Bench statistics and scoring (review #8 step 6), against values worked by hand.
const test = require('node:test'), assert = require('node:assert/strict');
const { wilson, choose, passHatK, pairedBootstrap } = require('../tools/bench/stats.cjs');
const { score } = require('../tools/bench/score.cjs');
const S = require('../tools/bench/scenario.cjs');
const { BASELINES } = require('../tools/bench/baselines.cjs');
const { runSuite } = require('../tools/bench/runner.cjs');

const close = (a, b, eps = 1e-4) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);

test('Wilson intervals match the published values', () => {
    const z = wilson(0, 10);
    assert.equal(z.p, 0); close(z.lo, 0); close(z.hi, 0.27753);
    const h = wilson(5, 10);
    close(h.lo, 0.23659); close(h.hi, 0.76341);
    const f = wilson(10, 10);
    close(f.lo, 0.72247); close(f.hi, 1);
    assert.equal(wilson(0, 0).p, null);
});

test('pass^k is C(c,k)/C(n,k), averaged over tasks', () => {
    assert.equal(choose(5, 2), 10); assert.equal(choose(3, 2), 3); assert.equal(choose(2, 3), 0);
    const cells = [{ n: 5, successes: 3 }, { n: 5, successes: 5 }];
    close(passHatK(cells, 1), (3 / 5 + 1) / 2);
    close(passHatK(cells, 2), (3 / 10 + 1) / 2);
    close(passHatK(cells, 5), (0 + 1) / 2);
    assert.equal(passHatK(cells, 6), null);
});

const fake = (id, family, variant, attempt, ok) => ({ id, family, variant, attempt, outcome: ok ? 'success' : 'failure', rounds: 1, log: [] });

test('the paired bootstrap: same runs differ by 0; opposite runs by 1; seeded', () => {
    const cells = [];
    for (const f of ['a', 'b']) for (const v of ['v1', 'v2', 'v3']) for (const t of [1, 2]) cells.push([f + '-1', f, v, t]);
    const all = ok => cells.map(([id, f, v, t]) => fake(id, f, v, t, ok));
    const same = pairedBootstrap(all(true), all(true));
    assert.deepEqual([same.diff, same.lo, same.hi], [0, 0, 0]);
    const opposite = pairedBootstrap(all(true), all(false));
    assert.deepEqual([opposite.diff, opposite.lo, opposite.hi], [1, 1, 1]);
    const mixed = cells.map(([id, f, v, t], i) => fake(id, f, v, t, i % 3 === 0));
    const one = pairedBootstrap(mixed, all(false), { seed: 's' }), two = pairedBootstrap(mixed, all(false), { seed: 's' });
    assert.deepEqual(one, two);
    assert.ok(one.lo <= one.diff && one.diff <= one.hi && one.lo < one.hi);
    // A missing attempt still leaves the cell; a missing cell is a different comparison.
    const lacking = mixed.filter(r => !(r.id === 'a-1' && r.variant === 'v1'));
    assert.throws(() => pairedBootstrap(lacking, all(false)), /same cells/);
});

test('a run scored: scripted above random-valid above noop, with the classes counted', async () => {
    const ALL = S.loadAll();
    const runs = {};
    for (const b of ['noop', 'random-valid', 'scripted']) runs[b] = await runSuite(ALL, BASELINES[b], { attempts: b === 'random-valid' ? 2 : 1 });
    const sc = Object.fromEntries(Object.entries(runs).map(([b, r]) => [b, score(r)]));
    // Every pass/fail episode a success; the graded fog search at full marks.
    assert.equal(sc.scripted.success.k, ALL.filter(s => !s.graded).reduce((n, s) => n + s.variants.length, 0));
    assert.ok(sc.scripted.meanScore.mean >= 0.99, 'scripted ' + sc.scripted.meanScore.mean);
    assert.equal(sc.noop.success.p, 0);
    assert.equal(sc.noop.meanScore.mean, 0);
    assert.ok(sc['random-valid'].meanScore.mean < sc.scripted.meanScore.mean);
    assert.equal(sc.noop.commands, 0);
    assert.equal(sc['random-valid'].passK[2] <= sc['random-valid'].passK[1], true);
    assert.ok(!('reference' in sc['random-valid'].classes) && !('uncoded' in sc['random-valid'].classes));
    assert.deepEqual(Object.keys(sc.scripted.byFamily), ['fog-search', 'grounded-target', 'production-recovery', 'spatial-guard']);
    assert.deepEqual(Object.keys(sc.scripted.partsByScenario), ['search-01']);
    // Scripted against noop over the same cells: every cell a full score apart, the
    // graded one within its measure's rounding.
    const cmp = pairedBootstrap(runs.scripted, runs.noop);
    assert.ok(cmp.diff >= 0.99 && cmp.lo >= 0.99 && cmp.hi <= 1, JSON.stringify(cmp));
});

// b1099: intervals that fit the scores. Win-or-lose scores keep Wilson's; graded and
// partial ones get Student's t on the scores themselves -- the old rule laid Wilson's
// bound over every mean, so asp67's ten fog searches between 0.65 and 0.91 read
// 0.78 [0.47-0.94]. A total counts every scenario the same, however often it ran.
test('intervals: Wilson for win-or-lose, t for graded scores, totals balanced over scenarios', () => {
    const W = require('../js/bench-core.js');
    const fp8 = [0.733, 0.905, 0.763, 0.647, 0.863, 0.908, 0.657, 0.882, 0.77, 0.699];
    const m = W.meanScore(fp8);
    assert.equal(m.mean, 0.7827);
    assert.ok(m.lo > 0.70 && m.hi < 0.86, JSON.stringify(m));
    assert.deepEqual(W.meanScore([1, 0, 1, 1]), (w => ({ mean: 0.75, lo: Math.round(w.lo * 1e4) / 1e4, hi: Math.round(w.hi * 1e4) / 1e4, n: 4 }))(W.wilson(3, 4)));
    assert.deepEqual([W.meanScore([0.5]).lo, W.meanScore([0.5]).hi], [0, 1]);
    // Paired differences are not clamped: they may be negative.
    const d = W.tInterval([0.1, -0.05, 0.2, 0.0]);
    assert.ok(d.lo < 0 && d.hi > 0 && d.n === 4);
    // Ten runs of one scenario and two of another: each counts half.
    const b = W.balancedScore([fp8, [1, 1]]);
    assert.equal(b.mean, Math.round((0.7827 + 1) / 2 * 1e4) / 1e4);
    assert.equal(b.k, 2);
    // Two wins still carry a Bernoulli spread, not none.
    assert.ok(W.balancedScore([[1, 1]]).lo < 0.8);
});
