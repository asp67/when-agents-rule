// A defeated seat leaves the board (asp67, b1053), as in Age of Empires. Elimination used
// to set a flag and nothing else: a seat out at 85 minutes still stood on the map at 193,
// listed in the other seats' states and attacked, its workers fighting on a standing order.
const test = require('node:test'), assert = require('node:assert/strict');
const { createMatch } = require('../tools/bench/realm.cjs');

test('on elimination everything the seat has leaves the board, quietly', async () => {
    const m = await createMatch({ kind: 'arena', seed: 'clear-eliminated', seats: [
        { civ: 'greek', type: 'ki' }, { civ: 'persian', type: 'ki' }, { civ: 'egyptian', type: 'ki' }] });
    const g = m.game, [a, b, c] = m.seats;
    m.run(3000);
    const units = b.units.slice(), buildings = b.buildings.slice();
    assert.ok(units.length && buildings.length, 'it has something to lose');
    const battlesBefore = JSON.stringify(g._battles || []);
    b._eliminated = true;
    m.advance(50);
    assert.equal(b.units.length, 0);
    assert.equal(b.buildings.length, 0);
    assert.ok(units.every(u => u.health <= 0 && !g.getAllUnits().includes(u)), 'its units are gone from the world');
    assert.ok(buildings.every(x => x.health <= 0 && !g.getAllBuildings().includes(x)), 'and its buildings');
    assert.equal(JSON.stringify(g._battles || []), battlesBefore, 'no battle losses written: nobody destroyed them');
    assert.ok(a.units.length && c.units.length, 'the others untouched');
    assert.equal(b._cleared, true);
    m.advance(50);   // once only
    assert.equal(b.units.length, 0);
});

test('a seat that remembered the defeated seat\'s buildings stops listing them', async () => {
    const m = await createMatch({ kind: 'board', seed: 'clear-memory', seats: [
        { civ: 'greek', age: 'bronze', buildings: [['town_center', -250, 0]], units: [['warrior', 0, 0, { tag: 'eye' }]] },
        { civ: 'persian', age: 'bronze', buildings: [['town_center', 250, 0], ['house', 12, 0, { tag: 'house' }]] },
        { civ: 'egyptian', age: 'bronze', buildings: [['town_center', 0, 250]] }] });
    const mgr = m.game.openAIAIManager, c = m.controllers[0];
    const listed = () => mgr.buildGameStateJSON(c).enemyBuildings.filter(x => x.owner === m.game.seatLabel(m.seats[1]));
    assert.equal(listed().length, 1, 'the house is seen');
    m.tags.eye.x = -200;
    assert.equal(listed().length, 1, 'and remembered out of sight');
    m.seats[1]._eliminated = true;
    m.game.clearEliminatedSeat(m.seats[1]);
    assert.equal(listed().length, 0, 'its owner is out: forgotten');
});
