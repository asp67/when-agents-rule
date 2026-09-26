// Golden traces: WAR's rules as they run today, pinned. Each scenario records a hash
// of the whole rule state every checkpoint, plus counts a person can read. A change
// that moves any of it fails here, naming the first checkpoint that differs.
//
// Review #6 changes rules on purpose, step by step. Each such step re-records these
// with WAR_GOLDEN=update and says so in its commit; a change that was NOT meant to
// alter the rules must leave them untouched.
const test = require('node:test'), assert = require('node:assert/strict');
const { GoldenMatch, checkGolden } = require('./harness.cjs');

const trace = (m, ms, every) => {
    const out = [];
    m.run(ms, every, () => out.push({ hash: m.hash(), summary: m.summary() }));
    return out;
};

// Two rule-based seats from the ordinary arena start: town centre, three workers, a
// real map. Pins the start path, gathering, building, training, research and the
// rule-based brain's economy.
test('opening economy: two rule-based seats, six minutes', async t => {
    const m = new GoldenMatch({ seed: 11 });
    await m.startArena({ seats: ['greek', 'persian'], seed: 'golden-opening' });
    checkGolden(t, assert, 'opening-economy', trace(m, 6 * 60000, 30000));
});

// Forty a side on a flat board -- melee, archers, cavalry and priests. One side
// assaults the other's base through the models' own command path; the defenders hold
// under two towers and a town centre with no orders at all, so everything they do is
// the harness's own damage-triggered defense. Pins movement, formations, combat,
// towers, healing, retaliation and the positional pass.
test('40 v 40 with priests and towers', t => {
    const m = new GoldenMatch({ seed: 23 });
    const [a, b] = m.startFixture(['greek', 'persian']);
    const army = [['warrior', 14], ['archer', 12], ['scout_cavalry', 8], ['priest', 6]];
    m.addBuilding(a, 'town_center', -110, 0);
    const tc = m.addBuilding(b, 'town_center', 70, 0);
    m.addBuilding(b, 'tower', 45, -14);
    m.addBuilding(b, 'tower', 45, 14);
    [[a, -40, 1], [b, 52, -1]].forEach(([ai, x0, side]) => {
        let n = 0;
        army.forEach(([type, count]) => {
            for (let i = 0; i < count; i++, n++) m.addUnit(ai, type, x0 - side * (n % 5) * 2, (Math.floor(n / 5) - 4) * 2.5);
        });
    });
    const ca = m.scripted(a);
    m.scripted(b);
    const r = m.command(ca, 'attack_target', { targetId: tc.id, reason: 'golden' });
    assert.doesNotMatch(String(r), /\[ERROR\]/, 'assault order accepted');
    checkGolden(t, assert, 'battle-40v40', trace(m, 60000, 5000));
});

// A standing Wonder under siege: the defenders' all-hands draft, towers and priests
// against a mixed army. Pins the Wonder hold clock, building damage and the
// existential auto-defense.
test('wonder siege', t => {
    const m = new GoldenMatch({ seed: 37 });
    const [def, atk] = m.startFixture(['egyptian', 'yamato']);
    def.age = 'iron'; atk.age = 'iron';
    m.addBuilding(def, 'pyramid', 0, 0);
    m.addBuilding(def, 'town_center', -40, 0);
    m.addBuilding(def, 'tower', 10, 12);
    m.addBuilding(def, 'tower', 10, -12);
    for (let i = 0; i < 12; i++) m.addUnit(def, i < 8 ? 'champion' : 'priest', -12 + (i % 4) * 2, (Math.floor(i / 4) - 1) * 3);
    for (let i = 0; i < 10; i++) m.addUnit(def, 'worker', -30 + (i % 5) * 2, 10 + Math.floor(i / 5) * 2);
    m.addBuilding(atk, 'town_center', 120, 0);
    const siege = [['champion', 12], ['crossbowman', 10], ['heavy_cavalry', 8], ['priest', 4]];
    let n = 0;
    siege.forEach(([type, count]) => {
        for (let i = 0; i < count; i++, n++) m.addUnit(atk, type, 70 + (n % 5) * 2, (Math.floor(n / 5) - 3) * 2.5);
    });
    const ca = m.scripted(atk);
    m.scripted(def);   // the defenders move only by the harness's own auto-defense
    const r = m.command(ca, 'attack_target', { targetX: 0, targetZ: 0, reason: 'golden' });
    assert.doesNotMatch(String(r), /\[ERROR\]/, 'siege order accepted');
    checkGolden(t, assert, 'wonder-siege', trace(m, 70000, 5000));
});
