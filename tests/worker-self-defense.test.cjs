'use strict';
// Workers defend themselves and nothing else (1 Oct 2026). A worker hit by a unit fights
// back against that unit and goes back to its job -- scouting and building included --
// when the attacker falls or is out of reach. Workers are no longer drafted into fights
// they are not part of: not as a Wonder's "all hands", not as a seat's last resort.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMatch } = require('../tools/bench/realm.cjs');

async function board(extra = {}) {
    const m = await createMatch({ kind: 'board', seed: 'self-defense', seats: [
        { civ: 'greek', age: 'bronze', buildings: [['town_center', -150, 0]].concat(extra.ownBuildings || []),
          units: [['worker', -40, 0, { tag: 'scout' }], ['worker', -36, 6, { tag: 'bystander' }]].concat(extra.ownUnits || []) },
        { civ: 'persian', age: 'bronze', buildings: [['town_center', 200, 0]].concat(extra.foeBuildings || []),
          units: [['warrior', -30, 0, { tag: 'raider', health: 12 }]] },
    ] });
    return m;
}
// As a blow lands: what updateCombat and the tower do. Not at time 0: a board starts its
// clock at 0, and a hit stamped 0 reads as never hit (`!ent._lastDamageTime`).
const hit = (m, attacker, victim) => {
    if (!(m.game.simNow() > 0)) m.advance(50);
    victim._lastAttacker = attacker; victim._lastDamageTime = m.game.simNow(); m.game.noteRetaliation(victim, attacker);
};

test('a scouting worker that is hit fights back, then picks its trip up again', async () => {
    const m = await board(), g = m.game, scout = m.tags.scout, raider = m.tags.raider;
    scout.task = 'scouting'; scout.isMoving = true; scout.targetX = 60; scout.targetZ = 40;
    hit(m, raider, scout);
    assert.equal(scout.attackTarget, raider, 'it answers its attacker');
    assert.equal(scout.isAttacking, true);
    for (let i = 0; i < 400 && raider.health > 0; i++) m.advance(50);
    assert.ok(raider.health <= 0, 'the raider fell');
    m.advance(100);
    assert.equal(scout.isAttacking, false);
    assert.equal(scout.task, 'scouting', 'back on its trip');
    assert.deepEqual([scout.targetX, scout.targetZ], [60, 40], 'to the same place');
    assert.equal(scout.isMoving, true);
});

test('a worker does not join a fight it is not part of, with or without an army, even for a Wonder', async () => {
    for (const wonder of [false, true]) {
        const m = await board(wonder ? { ownBuildings: [['akropolis', -30, 30, { tag: 'wonder' }]] } : {});
        const g = m.game, by = m.tags.bystander, raider = m.tags.raider;
        const victim = wonder ? m.tags.wonder : m.tags.scout;
        if (!wonder) victim.task = 'scouting';
        hit(m, raider, victim);
        g.updateAutoDefense(1000);
        assert.equal(by.isAttacking, false, 'the bystander keeps working' + (wonder ? ' through a Wonder raid' : ''));
        assert.equal(by.attackTarget == null, true);
    }
});

test('a worker hit by a tower does not walk up to it; one hit under a standing order is left to the order', async () => {
    const m = await board({ foeBuildings: [['tower', -30, 10, { tag: 'tower' }]] }), w = m.tags.scout;
    w.task = 'harvesting';
    hit(m, m.tags.tower, w);
    assert.equal(w.isAttacking, false);
    assert.equal(w.task, 'harvesting');
});

test('self-defense ends when the attacker is out of reach of where the worker was hit', async () => {
    const m = await board(), w = m.tags.scout, raider = m.tags.raider;
    w.task = 'scouting'; w.isMoving = true; w.targetX = -80; w.targetZ = -60;
    hit(m, raider, w);
    raider.x = w.x + 45; raider.speed = 0;   // gone beyond the 30 leash
    m.advance(100);
    assert.equal(w.isAttacking, false);
    assert.equal(w.task, 'scouting');
    assert.deepEqual([w.targetX, w.targetZ], [-80, -60]);
});

// asp67, 3 Oct 2026: a worker carrying stone home was attacked, killed its attacker, went
// back to its node still carrying the stone and stood there. A full worker does not
// gather, so the load goes home first, and the worker returns to its node from there.
test('a worker hit on its way home with a load delivers it, then goes back to its node', async () => {
    const m = await board({ ownBuildings: [['town_center', -60, 0, { tag: 'home' }]] });
    const g = m.game, w = m.tags.scout, raider = m.tags.raider, owner = m.seats[0];
    raider.speed = 0;
    const node = { type: 'stone', x: -38, z: 2, amount: 400, id: 'stone-1' };
    g.terrain.resources.push(node);
    w.task = 'carrying'; w.harvestTarget = node; w.carryingResource = true; w.carryingResourceType = 'stone'; w.harvestAmount = 10;
    w.isMoving = true; w.targetX = -60; w.targetZ = 0;
    const stone = owner.resources.stone;
    hit(m, raider, w);
    for (let i = 0; i < 600 && raider.health > 0; i++) m.advance(50);
    assert.ok(raider.health <= 0, 'the raider fell');
    m.advance(100);
    assert.equal(w.task, 'carrying', 'home with the load first');
    assert.equal(owner.resources.stone, stone, 'not banked on the spot');
    for (let i = 0; i < 400 && owner.resources.stone === stone; i++) m.advance(50);
    assert.equal(owner.resources.stone, stone + 10, 'delivered at the Town Center');
    for (let i = 0; i < 400 && !w.isHarvesting; i++) m.advance(50);
    assert.equal(w.harvestTarget, node);
    assert.equal(w.isHarvesting, true, 'and gathering at its node again');
});
