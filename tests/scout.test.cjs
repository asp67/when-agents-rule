// The scout cavalry is the first scout (asp67, b1055): the starting 50 gold pays for the
// stable and the scout costs none, so a seat can ride out to find gold and stone before
// mining any. It stays a scout all match; at the Iron age it used to become cavalry.
const test = require('node:test'), assert = require('node:assert/strict');
const { createMatch } = require('../tools/bench/realm.cjs');

test('the opening fits the starting gold: stable 50, scout none', async () => {
    const m = await createMatch({ kind: 'arena', seed: 'scout-price', seats: ['greek', { civ: 'persian', type: 'ki' }] });
    const ai = m.seats[0];
    assert.equal(ai.resources.gold, 50, 'every seat starts with 50 gold');
    const stable = m.context.getBuildingDef('stable').cost, horseback = m.context.getCivilization('greek').techTree.horseback.cost;
    for (const civ of ['egyptian', 'greek', 'persian', 'yamato']) {
        const scout = m.context.getUnitDefFor(civ, 'scout_cavalry');
        assert.deepEqual({ ...scout.cost }, { food: 150, wood: 80, stone: 0, gold: 0 }, civ);
        assert.ok((stable.gold || 0) + (horseback.gold || 0) + (scout.cost.gold || 0) <= 50, civ + ': no gold to mine first');
    }
});

test('a scout stays a scout through the Iron age', async () => {
    for (const civ of ['egyptian', 'greek', 'persian', 'yamato']) {
        const m = await createMatch({ kind: 'board', seed: 'scout-stays', seats: [
            { civ, age: 'bronze', buildings: [['town_center', -250, 0]], units: [['scout_cavalry', 0, 0, { tag: 'scout' }]] },
            { civ: civ === 'greek' ? 'persian' : 'greek', age: 'bronze', buildings: [['town_center', 250, 0]] }] });
        m.game.completeAgeUpgrade('iron', m.seats[0]);
        assert.equal(m.tags.scout.type, 'scout_cavalry', civ);
        assert.equal(m.tags.scout.health, 100, civ + ': not healed into a new unit either');
    }
});
