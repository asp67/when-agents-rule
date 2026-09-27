// A rejected purchase says what it is short of, counted after the turn's earlier
// commands. GLM-5.3 as Yamato built a temple and then asked for Sword Armor from the
// same stone and gold, read a bare "Cannot afford tech", and asked again for four turns.
const test = require('node:test'), assert = require('node:assert/strict');
const { GoldenMatch } = require('./harness.cjs');

test('cannot-afford errors name the shortfall after earlier spending', () => {
    const m = new GoldenMatch({ seed: 21 });
    const [me, foe] = m.startFixture(['greek', 'persian']);
    const c = m.scripted(me); m.scripted(foe);
    m.addBuilding(me, 'town_center', -300, -300); m.addBuilding(foe, 'town_center', 300, 300);
    m.addUnit(me, 'worker', -280, -280);
    me.researchedTechs.house = true;   // a fixture seat starts with nothing unlocked
    // Exactly one house's worth, and two houses in one turn: the second is short by
    // exactly what the first spent.
    const cost = m.context.getBuildingDef('house').cost;
    Object.assign(me.resources, { food: cost.food || 0, wood: cost.wood || 0, stone: cost.stone || 0, gold: cost.gold || 0 });
    const first = m.command(c, 'build_structure', { buildingType: 'house', targetX: -260, targetZ: -300 });
    assert.ok(first.startsWith('OK'), first);
    const second = m.command(c, 'build_structure', { buildingType: 'house', targetX: -240, targetZ: -300 });
    const paid = ['food', 'wood', 'stone', 'gold'].filter(k => cost[k]);
    assert.equal(second, `[ERROR] Cannot afford house - short of ${paid.map(k => cost[k] + ' ' + k).join(', ')}` +
        ` (you have ${paid.map(k => '0 ' + k).join(', ')} after this turn's earlier commands).`);
});
