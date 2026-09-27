// WAR Bench baselines (review #8 step 5): noop scores 0, scripted scores 100 %, and
// random-valid -- commands built only from what the state shows -- is refused only for
// the world's reasons, never for naming something that is not there.
const test = require('node:test'), assert = require('node:assert/strict');
const S = require('../tools/bench/scenario.cjs');
const { BASELINES, randomValidPolicy } = require('../tools/bench/baselines.cjs');
const { runSuite } = require('../tools/bench/runner.cjs');

const ALL = S.loadAll();

test('noop fails every episode and scripted solves every one', async () => {
    const noop = await runSuite(ALL, BASELINES.noop);
    const scripted = await runSuite(ALL, BASELINES.scripted);
    assert.equal(noop.length, ALL.reduce((n, s) => n + s.variants.length, 0));
    assert.ok(noop.every(r => r.outcome === 'failure'));
    assert.ok(scripted.every(r => r.outcome === 'success'));
});

test('random-valid earns constraint errors at most, never a reference error', async () => {
    const res = await runSuite(ALL, BASELINES['random-valid'], { attempts: 2 });
    const classes = {};
    for (const r of res) for (const e of r.log) for (const o of e.outcomes || []) {
        classes[o.class] = (classes[o.class] || 0) + 1;
        assert.ok(['done', 'constraint', 'contended'].includes(o.class),
            `${r.id}/${r.variant} round ${e.round}: ${o.action} -> ${o.code} (${o.class}): ${e.results}`);
    }
    // It really plays: most commands land, and the world refuses a good share.
    assert.ok(classes.done > 200 && classes.constraint > 200, JSON.stringify(classes));
});

test('random-valid is seeded: the same key gives the same commands', async () => {
    const s = ALL.find(x => x.id === 'recover-01');
    const a = await S.play(s, 'rot90', randomValidPolicy('k')), b = await S.play(s, 'rot90', randomValidPolicy('k'));
    const c = await S.play(s, 'rot90', randomValidPolicy('other'));
    assert.equal(JSON.stringify(a.log.map(e => e.commands)), JSON.stringify(b.log.map(e => e.commands)));
    assert.notEqual(JSON.stringify(a.log.map(e => e.commands)), JSON.stringify(c.log.map(e => e.commands)));
});
