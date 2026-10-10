// Units sent to a rally point one after the other come to rest (b1086). Each order used
// to make the point itself its lone unit's slot, so a dozen single-unit orders to one spot
// all owned the same spot, and friendly separation and the walk back to it shoved the
// crowd about for as long as it stood there -- "a moving blob" (asp67, 10 Oct 2026).
const test = require('node:test'), assert = require('node:assert/strict');
const { createMatch } = require('../tools/bench/realm.cjs');

test('a dozen single-unit orders to one rally point settle into distinct places around it', async () => {
    const units = [];
    for (let i = 0; i < 12; i++) units.push([['militia', 'archer', 'cavalry'][i % 3], -60 + (i % 4) * 3, -6 + Math.floor(i / 4) * 4]);
    const m = await createMatch({ kind: 'board', seed: 'rally', seats: [
        { civ: 'persian', age: 'bronze', buildings: [['town_center', -200, 0]], units },
        { civ: 'greek', buildings: [['town_center', 300, 200]] },
    ] });
    const [A] = m.seats, [c] = m.controllers;
    for (const u of A.units) assert.match(String(m.command(c, 'move_units', { unitIds: [u.handle], targetX: 40, targetZ: 0 })), /^OK/);
    m.advance(60000);
    const before = A.units.map(u => [u.x, u.z]);
    m.advance(10000);
    const moved = A.units.reduce((s, u, i) => s + Math.hypot(u.x - before[i][0], u.z - before[i][1]), 0);
    assert.ok(moved < 0.05, `still shuffling: ${moved.toFixed(2)} units of movement in 10 s`);
    assert.equal(A.units.filter(u => u.isMoving).length, 0);
    // Each its own place, and all of them at the rally point.
    const slots = A.units.map(u => u._standingOrder.slots.get(u));
    for (let i = 0; i < slots.length; i++) for (let j = i + 1; j < slots.length; j++)
        assert.ok(Math.hypot(slots[i].x - slots[j].x, slots[i].z - slots[j].z) >= 1.8, `slots ${i} and ${j} overlap`);
    for (const u of A.units) assert.ok(Math.hypot(u.x - 40, u.z) < 8, `${u.type} at ${u.x.toFixed(1)},${u.z.toFixed(1)}`);
});
