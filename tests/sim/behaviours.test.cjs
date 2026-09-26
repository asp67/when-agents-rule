// Three rules that look like bugs and are not. Each has been "fixed" or nearly fixed
// before, and each is confirmed intended. They are asserted here by name, in the real
// loop, so a later change that removes one fails a test that says what was lost,
// rather than moving a hash nobody reads.
const test = require('node:test'), assert = require('node:assert/strict');
const { GoldenMatch } = require('./harness.cjs');

function board(seed = 5) {
    const m = new GoldenMatch({ seed });
    const [a, b] = m.startFixture(['greek', 'persian']);
    m.addBuilding(a, 'town_center', -120, 0);
    m.addBuilding(b, 'town_center', 120, 0);
    return { m, a, b, ca: m.scripted(a), cb: m.scripted(b) };
}

// Auto-defense wakes on DAMAGE, never on proximity (game.js updateAutoDefense). Two
// armies can stand toe to toe and wait; the stand-off is the feature, and a model has
// already won with it. Confirmed intended by asp67, 2026-07-21.
test('auto-defense: armies side by side wait, and the first blow starts the fight', () => {
    const { m, a, b, ca } = board();
    const ours = [], theirs = [];
    for (let i = 0; i < 6; i++) {
        ours.push(m.addUnit(a, 'warrior', -2, (i - 3) * 2));
        theirs.push(m.addUnit(b, 'warrior', 2, (i - 3) * 2));
    }
    const hp = () => ours.concat(theirs).map(u => u.health);
    const before = hp();
    m.run(20000);
    assert.deepEqual(hp(), before, 'no blow is struck by standing close');
    assert.ok(ours.concat(theirs).every(u => !u.isAttacking), 'nobody engages on proximity');

    const r = m.command(ca, 'attack_target', { targetId: theirs[0].id, unitIds: [ours[0].handle], reason: 'first blow' });
    assert.doesNotMatch(String(r), /\[ERROR\]/);
    m.run(3000);
    assert.ok(theirs[0].health < before[6], 'the ordered blow landed');
    assert.ok(theirs.filter(u => u.health > 0 && u.isAttacking).length >= 2, 'the struck side answers');
});

// A priest never heals itself, does heal another priest, and two wounded priests heal
// each other at once (game.js updateHealing: the `o === u` exclusion is the only
// one). Field medics patching each other up; confirmed intended by asp67.
test('healing: no self-heal, colleagues heal, two wounded priests heal each other', () => {
    const { m, a } = board();
    const alone = m.addUnit(a, 'priest', -60, 40);
    alone.health = alone.maxHealth / 2;
    const p1 = m.addUnit(a, 'priest', -60, -40), p2 = m.addUnit(a, 'priest', -59, -40);
    p1.health = p1.maxHealth / 2; p2.health = p2.maxHealth / 2;
    const soldier = m.addUnit(a, 'warrior', -20, 40), medic = m.addUnit(a, 'priest', -19, 40);
    soldier.health = soldier.maxHealth / 2;
    const start = [alone.health, p1.health, p2.health, soldier.health];
    m.run(5000);
    assert.equal(alone.health, start[0], 'a lone priest does not heal itself');
    assert.ok(p1.health > start[1] && p2.health > start[2], 'two wounded priests heal each other');
    assert.ok(soldier.health > start[3], 'a priest heals a wounded soldier');
    assert.equal(medic.health, medic.maxHealth);
});

// Separation pushes apart units of the SAME owner only (gamerenderer.js positional
// pass). Enemies interpenetrate, so melee always connects; all-pairs separation once
// let six defenders repel a charging unit forever.
test('positional pass: friends are pushed apart, enemies are not', () => {
    const { m, a, b } = board();
    const f1 = m.addUnit(a, 'warrior', -40, 0), f2 = m.addUnit(a, 'warrior', -39.6, 0);
    const e1 = m.addUnit(a, 'warrior', 40, 0), e2 = m.addUnit(b, 'warrior', 40.4, 0);
    const gap = (u, v) => Math.hypot(u.x - v.x, u.z - v.z);
    m.run(2000);
    assert.ok(gap(f1, f2) > 1, 'same owner: separated to about 1.2');
    assert.ok(Math.abs(gap(e1, e2) - 0.4) < 1e-9, 'different owners: left where they stand');
    assert.equal(e1.health, e1.maxHealth, 'and, standing idle, neither strikes');
});
