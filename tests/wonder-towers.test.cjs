'use strict';
// A bigger Wonder and spaced towers (28 Sep 2026): the Wonder is 1.5x its old size --
// footprint, clearance, reach -- and towers keep 15 apart, so at most five can reach one
// attacker at a Wonder, where thirteen could. The same gap rule for the models, the
// rule-based AI and the human player.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMatch } = require('../tools/bench/realm.cjs');

async function board() {
    const m = await createMatch({ kind: 'board', seed: 'wonder-towers', seats: [
        { civ: 'persian', age: 'iron', buildings: [['town_center', -120, 0], ['tower', -60, 0, { tag: 'tower' }]],
          units: [['worker', -100, 10], ['worker', -100, 14], ['worker', -96, 10]],
          resources: { food: 20000, wood: 20000, stone: 20000, gold: 20000 } },
        { civ: 'greek', age: 'iron', buildings: [['town_center', 200, 0]] },
    ] });
    return { m, g: m.game, Game: m.context.Game || m.game.constructor, ai: m.seats[0], c: m.controllers[0] };
}

test('one gap rule: Wonders keep 16.5, towers keep 15 from towers, the rest as before', async () => {
    const { Game } = await board();
    assert.equal(Game.WONDER_SCALE, 1.5);
    assert.equal(Game.WONDER_CLEARANCE, 10.5);
    const tower = { type: 'tower' }, house = { type: 'house' }, wonder = { type: 'firetemple', isWonder: true };
    assert.equal(Game.buildingGap(9, 'tower', false, tower), 15);
    assert.equal(Game.buildingGap(9, 'tower', false, house), 9);
    assert.equal(Game.buildingGap(9, 'house', false, tower), 9, 'only tower to tower');
    assert.equal(Game.buildingGap(11, 'house', false, wonder), 16.5);
    assert.equal(Game.buildingGap(9, 'firetemple', true, house), 16.5);
});

test('the models cannot place a tower within 15 of another; the order moves it or says why', async () => {
    const { m, g, ai, c } = await board();
    const res = m.command(c, 'build_structure', { buildingType: 'tower', targetX: -55, targetZ: 4 });
    const towers = ai.buildings.filter(b => b.type === 'tower');
    if (/^OK/.test(String(res))) {
        const [a, b] = towers;
        assert.ok(Math.hypot(a.x - b.x, a.z - b.z) >= 15, 'placed, and 15 or more apart: ' + res);
    } else {
        assert.match(String(res), /Towers must stand at least 15 apart; the nearest is \d+ away\./);
    }
    // Far enough: goes where it was asked.
    const res2 = m.command(c, 'build_structure', { buildingType: 'tower', targetX: -60, targetZ: 40 });
    assert.match(String(res2), /^OK/);
    // The rule-based AI's check follows the same rule. (The human player's is the
    // renderer's, which this realm does not draw; checked in the browser.)
    assert.equal(g.aiManager.isClearBuildSpot(ai, 'tower', false, -60, 12), false, 'a rule-based tower 12 from a tower');
    assert.equal(g.aiManager.isClearBuildSpot(ai, 'house', false, -60, 12), true, 'a house there is fine');
});

test('a Wonder still finds room in a base, and melee still reaches its bigger walls', async () => {
    const { m, g, ai, c } = await board();
    const res = m.command(c, 'build_structure', { buildingType: 'firetemple' });
    assert.match(String(res), /^OK/, res);
    const w = ai.buildings.find(b => b.isWonder);
    for (const b of ai.buildings) if (b !== w) assert.ok(Math.hypot(b.x - w.x, b.z - w.z) >= 16.5, b.type + ' too close');
    const champion = { range: 1, unitType: 'infantry' };
    assert.ok(Math.abs(g.attackRangeAgainst(champion, w) - (1.5 + 6.9)) < 1e-9, 'melee reach 8.4 from the centre');
    assert.ok(g.attackRangeAgainst(champion, w) > 7.6, 'past the pyramid faces (~7.6)');
});
