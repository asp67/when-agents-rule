// b1142: four refusals for a command sent without its one required argument carried no
// outcome code, so the Bench counted them as uncoded. Seen in asp67's match of 1 Nov
// (Strata sent a train_unit with no arguments). Each is now missingParam.
const test = require('node:test'), assert = require('node:assert/strict');
const { createMatch } = require('../tools/bench/realm.cjs');

test('a command missing its required argument is refused as missingParam', async () => {
    const m = await createMatch({ kind: 'board', seed: 'missing-param', seats: [
        { civ: 'greek', age: 'bronze', buildings: [['town_center', -250, 0]], units: [['worker', -240, 0]] },
        { civ: 'persian', age: 'bronze', buildings: [['town_center', 250, 0]] }] });
    const c = m.controllers[0], mgr = m.game.openAIAIManager;
    for (const [action, param] of [['train_unit', 'unitType'], ['research_tech', 'techId'],
        ['build_structure', 'buildingType'], ['destroy_building', 'buildingType']]) {
        mgr.executeTurn(c, { commands: [{ action, params: { reason: 'nothing else' } }] });
        const o = c._lastOutcome;
        assert.deepEqual([o.code, o.verdict], ['missingParam', 'avoidable'], action);
        assert.equal(String(c.seat.lastActionResult).includes(`${action} requires "${param}" parameter.`), true, action);
    }
});
