// explore without a named unit picks the farthest-seeing IDLE soldier (b1093). A unit
// still on its way -- an earlier explore, its route -- is taken only when no soldier
// stands free. Before, the first rider was re-aimed every turn and its route cut short
// while the other riders stood at home. A named unit (unitIds) still wins outright.
const test = require('node:test'), assert = require('node:assert/strict');
const { createMatch } = require('../tools/bench/realm.cjs');

async function board() {
    const m = await createMatch({ kind: 'board', seed: 'scout-idle', seats: [
        { civ: 'greek', age: 'bronze', buildings: [['town_center', -300, -300]],
          units: [['scout_cavalry', -250, -250], ['scout_cavalry', -252, -250], ['archer', -250, -254]] },
        { civ: 'persian', age: 'bronze', buildings: [['town_center', 300, 300]] }] });
    const c = m.controllers[0], ai = m.seats[0];
    const [s1, s2] = ai.units.filter(u => u.type === 'scout_cavalry'), archer = ai.units.find(u => u.type === 'archer');
    return { m, c, s1, s2, archer };
}

test('a second explore on a later turn takes the idle rider, not the one already out', async () => {
    const { m, c, s1, s2, archer } = await board();
    c.turnCount = 1;
    assert.match(String(m.command(c, 'explore', { tile: 'G1', then: ['G4'] })), new RegExp('scout_cavalry #' + s1.handle));
    m.advance(2000);
    c.turnCount = 2;
    assert.match(String(m.command(c, 'explore', { tile: 'A7' })), new RegExp('scout_cavalry #' + s2.handle));
    assert.equal(s1._route.stops.length, 1, 'the first rider kept its route');
    // Both riders out: the idle archer goes before a rider is pulled off its way.
    m.advance(2000);
    c.turnCount = 3;
    assert.match(String(m.command(c, 'explore', { tile: 'D4' })), new RegExp('archer #' + archer.handle));
    // Nobody idle at all: a rider on its way is taken after all, as before.
    m.advance(2000);
    c.turnCount = 4;
    assert.match(String(m.command(c, 'explore', { tile: 'D5' })), /OK - Sent your scout_cavalry/);
});

test('a named unit still wins, on its way or not', async () => {
    const { m, c, s1 } = await board();
    c.turnCount = 1;
    m.command(c, 'explore', { tile: 'G1' });
    m.advance(2000);
    c.turnCount = 2;
    assert.match(String(m.command(c, 'explore', { tile: 'A7', unitIds: [s1.handle] })), new RegExp('scout_cavalry #' + s1.handle));
});
