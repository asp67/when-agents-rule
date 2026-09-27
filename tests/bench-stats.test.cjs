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
    assert.equal(sc.scripted.success.p, 1);
    assert.equal(sc.noop.success.p, 0);
    assert.ok(sc['random-valid'].success.p < sc.scripted.success.p);
    assert.equal(sc.noop.commands, 0);
    assert.equal(sc['random-valid'].passK[2] <= sc['random-valid'].passK[1], true);
    assert.ok(!('reference' in sc['random-valid'].classes) && !('uncoded' in sc['random-valid'].classes));
    assert.deepEqual(Object.keys(sc.scripted.byFamily), ['grounded-target', 'production-recovery', 'spatial-guard']);
    // Scripted against noop over the same cells: every cell one success apart.
    const cmp = pairedBootstrap(runs.scripted, runs.noop);
    assert.deepEqual([cmp.diff, cmp.lo, cmp.hi], [1, 1, 1]);
});
