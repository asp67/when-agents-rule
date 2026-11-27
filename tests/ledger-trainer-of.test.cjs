// Which building trains a unit is read off the state the seat was shown (b1287). The
// ledger kept a table of its own for it, written by hand beside the rules: eight units of
// the civilizations were missing from it (slinger, samurai, legionary, equites,
// axe_thrower, scout, jaguar_warrior, plumed_archer) and three in it exist nowhere. For a
// missing unit a refusal "its building is still under construction" could never be read as
// stale, though the state showed that very building finished. The state's own unit list is
// keyed by the building, for this match's rules and no others.
const test = require('node:test'), assert = require('node:assert/strict');
const WarEval = require('../js/eval/ledger.js');

const state = (catalogue) => Object.assign({
    clock: { matchSeconds: 300 }, population: { used: 10, capacityNow: 20, capacityCeiling: 100 },
    resources: { food: 500, wood: 500, stone: 200, gold: 200 }, workers: { total: 8, idle: 1, food: 3, wood: 2, stone: 1, gold: 1 },
    friendlyBuildings: [{ type: 'town_center', x: 0, z: 0, state: 'complete', healthPct: 100 }, { type: 'barracks', x: 12, z: 0, state: 'complete', healthPct: 100 }],
    friendlyUnits: [{ id: 1, type: 'worker', x: 3, z: 0, healthPct: 100 }], enemyUnits: [], enemyBuildings: [],
    research: { current: null, researched: [], available: [] } }, catalogue);
const refusal = (st, unitType, code) => WarEval.profileOf([
    JSON.stringify({ type: 'match', matchId: 'm', players: [{ id: 'a', seat: 0, civ: 'yamato', name: 'A', model: 'a' }] }),
    JSON.stringify({ turn: 1, playerId: 'a', seat: 0, civ: 'yamato', name: 'A', model: 'a', state: st,
        parsed: { commands: [{ action: 'train_unit', params: { unitType } }] }, outcomes: [{ n: 1, action: 'train_unit', code, verdict: 'avoidable' }] })
].join('\n')).seats[0].grounding;

// The unit list as the harness writes it: building, then age, then the units.
const units = { units: { trainable: { town_center: { stone: [{ id: 'worker' }] } }, blocked: { barracks: { bronze: [{ id: 'samurai', blockedBy: ['age'] }] } } } };

test('a unit the old table did not know: its building is the one the state lists it under', () => {
    const g = refusal(state(units), 'samurai', 'buildingUnderConstr');
    assert.equal(g.stale, 1, 'the barracks stood finished in the state: the world moved, not the model');
    assert.equal(g.avoidable, 0);
});

test('the same refusal with that building not in the state stays the model\'s', () => {
    const st = state(units); st.friendlyBuildings = st.friendlyBuildings.filter(b => b.type !== 'barracks');
    const g = refusal(st, 'samurai', 'buildingUnderConstr');
    assert.equal(g.stale, 0); assert.equal(g.avoidable, 1);
});

test('a transcript from before the unit list was split reads the same', () => {
    const old = { trainableUnits: { barracks: { bronze: [{ id: 'samurai' }] } } };
    assert.equal(refusal(state(old), 'samurai', 'buildingUnderConstr').stale, 1);
});

test('a state with no unit list falls back to the table, as before', () => {
    assert.equal(refusal(state({}), 'militia', 'buildingUnderConstr').stale, 1);
    assert.equal(refusal(state({}), 'samurai', 'buildingUnderConstr').stale, 0, 'unknown to both: left as recorded');
});
