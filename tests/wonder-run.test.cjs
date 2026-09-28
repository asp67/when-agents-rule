'use strict';
// An order on a Wonder outranks everything but retaliation (29 Sep 2026). The march itself
// is covered in standing-orders.test.cjs; here the model is told so, on a real board.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMatch } = require('../tools/bench/realm.cjs');

test('attack_target on a Wonder says the Wonder is the only target; an ordinary target does not', async () => {
    const m = await createMatch({ kind: 'board', seed: 'wonder-run', seats: [
        { civ: 'greek', age: 'iron', buildings: [['town_center', -150, 0]],
          units: [['warrior', -120, 0], ['warrior', -120, 4]] },
        { civ: 'persian', age: 'iron', buildings: [['town_center', 150, 60], ['firetemple', 120, -40]] },
    ] });
    const c = m.controllers[0], enemy = m.seats[1];
    const wonder = enemy.buildings.find(b => b.isWonder), tc = enemy.buildings.find(b => b.type === 'town_center');
    assert.ok(wonder, 'the board has a Wonder');
    const onWonder = String(m.command(c, 'attack_target', { targetId: wonder.id }));
    assert.match(onWonder, /^OK .*A Wonder is their only target: on the way they fight back only against what attacks them\./);
    const onTc = String(m.command(c, 'attack_target', { targetId: tc.id }));
    assert.match(onTc, /^OK /);
    assert.doesNotMatch(onTc, /only target/);
});
