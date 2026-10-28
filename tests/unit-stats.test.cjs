'use strict';
// What a seat has at its disposal, in its state (b1136, asp67, 28 Oct): the unit catalog
// carries each type's hp, attack, reach, sight and speed as a unit trained now would have
// them; every unit, tower and trebuchet with a range carries its "reach" wherever it is
// listed. Hermes won a siege with trebuchets and quoted their reach as 80: the 50 was only
// in the system prompt.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMatch } = require('../tools/bench/realm.cjs');

test('the catalog carries the stats; ranged units, towers and trebuchet sites carry their reach', async () => {
    const m = await createMatch({ kind: 'board', seed: 'unit-stats', seats: [
        { civ: 'greek', age: 'iron', buildings: [['town_center', -250, 0], ['archery_range', -230, 30], ['barracks', -230, -30], ['tower', -200, 0], ['stable', -270, 30]],
          units: [['archer', -220, 0], ['militia', -221, 2]] },
        { civ: 'persian', age: 'iron', buildings: [['town_center', 250, 0], ['tower', -190, 10]], units: [['archer', -205, 3]] }] });
    const mgr = m.game.openAIAIManager, c = m.controllers[0];
    const st = mgr.buildGameStateJSON(c);
    const all = [].concat(...Object.values(st.units.trainable).map(a => [].concat(...Object.values(a))),
        ...Object.values(st.units.blocked).map(a => [].concat(...Object.values(a))));
    const of = id => all.find(e => e.id === id);
    assert.deepEqual([of('archer').hp, of('archer').attack, of('archer').reach, of('archer').sight, of('archer').speed], [40, 6, 12, 15, 1]);
    assert.equal(of('militia').reach, undefined, 'melee carries no reach');
    assert.ok(of('militia').hp > 0 && of('militia').attack > 0 && of('militia').sight === 15);
    assert.equal(of('scout_cavalry').sight, 22.5, 'cavalry sees farther');
    assert.equal(of('priest').reach, 10.5, 'a priest: how far it heals');
    const mine = t => st.friendlyUnits.find(u => u.type === t);
    assert.equal(mine('archer').reach, 12);
    assert.equal(mine('militia').reach, undefined);
    assert.equal(st.friendlyBuildings.find(b => b.type === 'tower').reach, 18);
    assert.equal(st.friendlyBuildings.find(b => b.type === 'town_center').reach, undefined);
    const site = t => st.buildings.buildable.concat(st.buildings.blocked).find(b => b.type === t);
    assert.deepEqual([site('trebuchet').reach, site('trebuchet').speed], [50, 0.25]);
    assert.deepEqual([site('trebuchet_advanced').reach, site('trebuchet_advanced').speed], [60, 0.5]);
    assert.equal(site('tower').reach, 18);
    // A rival's unit carries its type's reach for its civilization; its tower its reach.
    const theirs = st.enemyUnits.find(u => u.type === 'archer');
    assert.ok(theirs && theirs.reach >= 12, JSON.stringify(theirs));
    assert.equal(st.enemyBuildings.find(b => b.type === 'tower').reach, 18);
});
