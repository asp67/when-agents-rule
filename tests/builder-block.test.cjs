// asp67 (b1111): "seats that do no longer have a towncenter or villagers keep trying to build
// structures". The state listed every building as buildable by age, tech and cost, never by
// whether anyone was left to build it, and the seat learned it only from "You have no workers
// to build ..." on every try. A building nobody can build is blocked by "builder" now.
const test = require('node:test'), assert = require('node:assert/strict');
const { createMatch } = require('../tools/bench/realm.cjs');

test('with no worker left, every building is blocked by "builder"; a trebuchet needs an engineer', async () => {
    const m = await createMatch({ kind: 'board', seed: 'builder-block', seats: [
        { civ: 'greek', age: 'iron', buildings: [['town_center', -250, 0]], units: [['worker', -230, 0], ['worker', -230, 4]] },
        { civ: 'persian', age: 'iron', buildings: [['town_center', 250, 0]] }] });
    const mgr = m.game.openAIAIManager, c = m.controllers[0], ai = c.aiPlayer;
    ai.researchedTechs = Object.assign(ai.researchedTechs || {}, { siege_engineering: true });
    const look = () => mgr.buildGameStateJSON(c).buildings;
    const where = (b, type) => b.buildable.find(e => e.type === type) ? 'buildable'
        : (b.blocked.find(e => e.type === type) ? 'blocked' : 'absent');
    const reasons = (b, type) => (b.buildable.concat(b.blocked).find(e => e.type === type) || {}).blockedBy || [];

    // Workers alive, no engineer: a tower is open, the trebuchet waits for an engineer.
    assert.ok(ai.units.some(u => u.type === 'worker' && u.health > 0), 'the board starts with workers');
    let b = look();
    assert.equal(where(b, 'tower'), 'buildable');
    assert.ok(!reasons(b, 'tower').includes('builder'));
    assert.equal(where(b, 'trebuchet'), 'blocked');
    assert.ok(reasons(b, 'trebuchet').includes('builder'), 'no engineer: ' + JSON.stringify(reasons(b, 'trebuchet')));

    // No worker at all: everything a worker builds is blocked, the Wonder too.
    for (const u of ai.units.filter(u => u.type === 'worker')) u.health = 0;
    b = look();
    for (const type of ['house', 'town_center', 'tower', 'temple', 'wonder'])
        assert.ok(where(b, type) === 'blocked' && reasons(b, type).includes('builder'), type + ': ' + where(b, type) + ' ' + JSON.stringify(reasons(b, type)));
});
