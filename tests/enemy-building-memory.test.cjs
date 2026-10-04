// A rival building out of sight is remembered as it was last seen (asp67, b1041), as a
// resource node is: its health then, and standing until its spot is seen again. It used
// to report its live health, and one destroyed out of sight simply vanished -- both
// things the seat had not seen.
const test = require('node:test'), assert = require('node:assert/strict');
const { createMatch } = require('../tools/bench/realm.cjs');

async function board() {
    const m = await createMatch({ kind: 'board', seed: 'building-memory', seats: [
        { civ: 'greek', age: 'bronze', buildings: [['town_center', -250, 0]], units: [['warrior', 0, 0, { tag: 'eye' }]] },
        { civ: 'persian', age: 'bronze', buildings: [['town_center', 250, 0], ['house', 12, 0, { tag: 'house' }]] },
    ] });
    const mgr = m.game.openAIAIManager, c = m.controllers[0];
    const look = () => mgr.buildGameStateJSON(c).enemyBuildings.find(b => b.type === 'house') || null;
    return { m, mgr, c, look, eye: m.tags.eye, house: m.tags.house };
}

test('out of sight, a building keeps the health it was seen with', async () => {
    const { look, eye, house } = await board();
    house.health = house.maxHealth * 0.8;
    assert.deepEqual([look().visible, look().healthPct], [true, 80]);
    eye.x = -200;                                    // looks away
    house.health = house.maxHealth * 0.3;            // burned while nobody watched
    const seen = look();
    assert.equal(seen.visible, false);
    assert.equal(seen.healthPct, 80, 'as last seen, not the live 30');
    eye.x = 0;
    assert.deepEqual([look().visible, look().healthPct], [true, 30], 'seen again: the truth');
});

test('destroyed out of sight, it stays listed until its spot is seen', async () => {
    const { m, look, eye, house } = await board();
    look();
    eye.x = -200;
    house.health = 0;
    const p = m.seats[1]; p.buildings.splice(p.buildings.indexOf(house), 1);
    m.game.renderer.removeBuilding(house);
    const still = look();
    assert.ok(still, 'not seen to fall, so still known');
    assert.deepEqual([still.visible, still.healthPct], [false, 100]);
    eye.x = 0;
    assert.equal(look(), null, 'its spot seen empty: gone');
});

test('a battle side always says what it lost, {} when nothing', async () => {
    const { m, mgr, c } = await board();
    const b = { x: 0, z: 0, startedAt: 0, lastAt: m.game.simNow(), sides: {
        [m.seats[0].id]: { involved: {}, lost: { warrior: 1 } },
        [m.seats[1].id]: { involved: { archer: { ids: new Set(['a1']), dmgUnits: 40, dmgBuildings: 0, healed: 0 } }, lost: {} } } };
    m.game._battles = [b];
    const battle = mgr.buildGameStateJSON(c).battles[0];
    assert.deepEqual(JSON.parse(JSON.stringify(battle.enemy[0].lost)), {}, 'an explicit nothing');
});

// asp67, 4 Oct 2026 (b1052): GLM razed a Town Center and moved on before its next turn; its
// state listed that Town Center as standing, at 100%, for ten minutes, and its attack on it
// by id was told the target "died in the seconds between the state you read and this command".
test('a building the seat\'s own units destroyed is forgotten, even out of sight', async () => {
    const { m, look, eye, house } = await board();
    look();
    eye.x = -200;
    house.health = 0; house._lastAttacker = { owner: m.seats[0].id };
    const p = m.seats[1]; p.buildings.splice(p.buildings.indexOf(house), 1);
    m.game.renderer.removeBuilding(house);
    assert.equal(look(), null, 'it fell to its own army: no memory of it standing');
});

test('attacking a remembered building that has fallen is told so, not "it died while you thought"', async () => {
    const { m, c, look, eye, house } = await board();
    look();
    eye.x = -200;
    assert.equal(look().visible, false);
    house.health = 0;
    const p = m.seats[1]; p.buildings.splice(p.buildings.indexOf(house), 1);
    m.game.renderer.removeBuilding(house);
    const res = String(m.command(c, 'attack_target', { targetId: house.id }));
    assert.match(res, /no longer there: you remembered it, out of sight/);
    assert.doesNotMatch(res, /in the seconds between/);
});
