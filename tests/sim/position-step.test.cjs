// Separation, building clearance and model discovery run in the simulation step
// (review #6 step 2). In the renderer they depended on the tab: a hidden tab draws
// nothing, so its units never separated; a slow frame separated less; a pause did not
// stop them; and discovery sampled once per drawn frame. These pin the new behaviour
// in exactly the conditions the 60 fps golden traces never see.
const test = require('node:test'), assert = require('node:assert/strict');
const { GoldenMatch } = require('./harness.cjs');

function stacked(opts) {
    const m = new GoldenMatch(Object.assign({ seed: 3 }, opts));
    const [a, b] = m.startFixture(['greek', 'persian']);
    m.addBuilding(a, 'town_center', -120, 0);
    m.addBuilding(b, 'town_center', 120, 0);
    m.scripted(a); m.scripted(b);
    // Eight soldiers in a clump a third of a unit across (a sunflower spiral, so it is
    // two-dimensional: a straight line spreads only along itself, and slowly), and one
    // standing inside a barracks' footprint.
    const pile = Array.from({ length: 8 }, (_, i) =>
        m.addUnit(a, 'warrior', 0.12 * Math.sqrt(i) * Math.cos(i * 2.4), 0.12 * Math.sqrt(i) * Math.sin(i * 2.4)));
    const barracks = m.addBuilding(a, 'barracks', 40, 0);
    const inside = m.addUnit(a, 'warrior', 41, 0);
    return { m, pile, barracks, inside };
}
const spread = pile => {
    let min = Infinity;
    for (let i = 0; i < pile.length; i++) for (let j = i + 1; j < pile.length; j++)
        min = Math.min(min, Math.hypot(pile[i].x - pile[j].x, pile[i].z - pile[j].z));
    return min;
};

test('a hidden tab separates and clears buildings like a visible one', () => {
    const vis = stacked({}), hid = stacked({ frameMs: 250, hidden: true });
    vis.m.run(4000); hid.m.run(4000);
    for (const s of [vis, hid]) {
        assert.ok(spread(s.pile) > 0.5, 'the pile has spread out: ' + spread(s.pile));
        assert.ok(Math.hypot(s.inside.x - s.barracks.x, s.inside.z - s.barracks.z) > 4, 'pushed out of the barracks');
    }
    assert.ok(Math.abs(spread(vis.pile) - spread(hid.pile)) < 0.15, 'about the same spread at 16 ms and 250 ms ticks');
});

test('the same time separates the same whatever the frame length', () => {
    const at = ms => { const s = stacked({ frameMs: ms }); s.m.run(1000); return spread(s.pile); };
    const base = at(16);
    for (const ms of [33, 50, 100, 250]) assert.ok(Math.abs(at(ms) - base) < 0.1, `${ms} ms frames: ${at(ms)} vs ${base}`);
});

test('a pause freezes separation with the rest of the world', () => {
    const s = stacked({});
    s.m.game.pauseState = 'paused';
    const before = s.pile.map(u => [u.x, u.z]);
    s.m.run(2000);
    assert.deepEqual(s.pile.map(u => [u.x, u.z]), before, 'nothing moved while paused');
    s.m.game.pauseState = 'running';
    s.m.run(2000);
    assert.ok(spread(s.pile) > 0.5, 'and it resumes after: ' + spread(s.pile));
});

test('model discovery samples every sub-step, not every frame', () => {
    const s = stacked({ frameMs: 250, hidden: true });
    const mgr = s.m.game.openAIAIManager;
    let calls = 0;
    const real = mgr.observeStep.bind(mgr);
    mgr.observeStep = () => { calls++; real(); };
    s.m.run(1000);
    assert.equal(calls, 20, 'four 250 ms ticks of five 50 ms steps each');
});
