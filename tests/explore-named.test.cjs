'use strict';
// explore with a named unitType sends that type or nothing (asp67, 28 Oct). With none of it
// free it used to send whatever stood idle and say so in brackets: Hermes's champions and
// crossbowmen walked off the line to scout. The automatic pick stays for an explore that
// names no type.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMatch } = require('../tools/bench/realm.cjs');

async function setup() {
    const m = await createMatch({ kind: 'board', seed: 'explore-named', seats: [
        { civ: 'greek', age: 'bronze', buildings: [['town_center', -100, 0]],
          units: [['scout_cavalry', -90, 0, { tag: 'scout' }], ['warrior', -92, 5, { tag: 'warrior' }]] },
        { civ: 'persian', age: 'bronze', buildings: [['town_center', 300, -300]] },
    ] });
    const mgr = m.game.openAIAIManager, c = m.controllers[0];
    const turn = commands => {
        c.turnCount++;
        mgr.executeTurn(c, { commands: commands.map(([action, params]) => ({ action, params })) });
        return String(c.seat.lastActionResult || '').split(/\n(?=Command \d+\/\d+: )/);
    };
    return { m, turn };
}

test('a named type with none of it free sends nothing; a named type that is free goes; no type picks one', async () => {
    const { m, turn } = await setup();
    const r = turn([['explore', { tile: 'D4', unitType: 'scout_cavalry' }], ['explore', { tile: 'E4', unitType: 'scout_cavalry' }],
        ['explore', { tile: 'F4', unitType: 'champion' }]]);
    assert.match(r[0], /OK - Sent your scout_cavalry/);
    assert.match(r[1], /\[ERROR\] Every "scout_cavalry" you have is already scouting this turn on an earlier command, so nothing was sent\./);
    assert.match(r[2], /\[ERROR\] You have no "champion" to explore with, so nothing was sent\./);
    assert.ok(!m.tags.warrior.isMoving, 'the warrior stayed where it was');
    const r2 = turn([['explore', { tile: 'D5' }]]);
    assert.match(r2[0], /OK - Sent your (scout_cavalry|warrior)/, 'an explore naming no type still picks a free soldier');
});
