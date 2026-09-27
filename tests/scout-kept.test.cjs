'use strict';
// A worker an explore sent earlier in the same turn is not taken back by a later command
// of that turn: not to gather (assign_workers without "from"), not to build. Measured on
// 27 Sep 2026: explore, explore, then assign_workers -- the default triage took the scout
// sent one command earlier, and it never left the base while the log said it had.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMatch } = require('../tools/bench/realm.cjs');

async function setup() {
    const m = await createMatch({ kind: 'board', seed: 'scout-kept', seats: [
        { civ: 'greek', age: 'neolithic', buildings: [['town_center', -100, 0]],
          units: [['worker', -92, 0, { tag: 'idle' }], ['worker', 240, 240, { tag: 'w2' }], ['worker', 245, 240, { tag: 'w3' }]],
          resources: { food: 500, wood: 500, stone: 500, gold: 500 } },
        { civ: 'persian', age: 'neolithic', buildings: [['town_center', 300, -300]] },
    ] });
    const g = m.game, mgr = g.openAIAIManager, ai = m.seats[0], c = m.controllers[0];
    const wood = { type: 'wood', x: 250, z: 250, amount: 500 }, food = { type: 'food', x: 250, z: -250, amount: 500 };
    g.terrain.resources.push(wood, food);
    mgr.discoveredNodesOfType = (_ai, _g, type) => [wood, food].filter(n => n.type === type);
    for (const w of [m.tags.w2, m.tags.w3]) { w.task = 'harvesting'; w.harvestTarget = wood; }
    ai.researchedTechs = Object.assign(ai.researchedTechs || {}, { house: true });   // houses need their tech
    const turn = commands => {
        c.turnCount++;
        mgr.executeTurn(c, { commands: commands.map(([action, params]) => ({ action, params })) });
        return String(c.seat.lastActionResult || '').split(/\n(?=Command \d+\/\d+: )/);
    };
    return { m, g, ai, c, turn, wood, food };
}

test('a scout sent this turn is not taken by a later assign_workers of the same turn', async () => {
    const { m, turn } = await setup();
    const res = turn([['explore', { tile: 'D4', unitType: 'worker' }], ['assign_workers', { resourceType: 'food', count: 3 }]]);
    const scout = m.tags.idle;
    assert.match(res[0], /^Command 1\/2: OK - Sent your worker #\d+/);
    assert.equal(scout.task, 'scouting', 'the scout keeps going: ' + res[1]);
    assert.match(res[1], /Reassigned 2 worker/);
    assert.doesNotMatch(res[1], /scouting/);
});

test('a scout sent this turn is not borrowed to build, even when it is the cheapest', async () => {
    const { m, turn } = await setup();
    const res = turn([['explore', { tile: 'D4', unitType: 'worker' }], ['build_structure', { buildingType: 'house', targetX: -80, targetZ: 20 }]]);
    const scout = m.tags.idle;
    assert.match(res[1], /OK - Construction of "house" started/);
    assert.equal(scout.task, 'scouting', res[1]);
    assert.ok([m.tags.w2, m.tags.w3].some(w => w.task === 'building' || w.buildTarget), 'a gatherer builds it instead');
});

test('when only this turn\'s scouts are left, the refusal says so', async () => {
    const { m, g, ai, turn } = await setup();
    // Only the one worker, and the explore takes it.
    for (const w of [m.tags.w2, m.tags.w3]) { ai.units.splice(ai.units.indexOf(w), 1); g.renderer.removeUnit && g.renderer.removeUnit(w); }
    const res = turn([['explore', { tile: 'D4', unitType: 'worker' }], ['build_structure', { buildingType: 'house', targetX: -80, targetZ: 20 }],
        ['assign_workers', { resourceType: 'food', count: 1 }]]);
    assert.match(res[1], /\[ERROR\] house: no worker available\. 1 was sent to scout earlier this turn and is not pulled back/);
    assert.match(res[2], /\[ERROR\] No workers could be reassigned: 1 was sent to scout earlier this turn/);
    assert.equal(m.tags.idle.task, 'scouting');
});

test('a scout sent in an earlier turn stays the last resort it was', async () => {
    const { m, turn } = await setup();
    turn([['explore', { tile: 'D4', unitType: 'worker' }]]);
    const res = turn([['assign_workers', { resourceType: 'food', count: 3 }]]);
    assert.match(res[0], /Reassigned 3 worker.*1 scouting/);
    assert.equal(m.tags.idle.task, 'harvesting');
});
