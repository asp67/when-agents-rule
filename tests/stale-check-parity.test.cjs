// "Was this refusal the model's, or did the world move while it thought?" is asked in two
// places: by the harness as a match runs (OpenAIAIManager.isStaleAgainstSnapshot) and by
// the ledger when it scores a transcript (js/eval/ledger.js). Each is a table of some
// twenty cases written out by hand, the second headed "mirrors" the first. A verdict the
// two read differently is a score that depends on who computed it: the live board against
// the analyzer, or this build against the next. Held together here (b1287), case by case.
const test = require('node:test'), assert = require('node:assert/strict');
const WarEval = require('../js/eval/ledger.js');
const { stubSeat } = require('./lib/stub-seat.cjs');

const base = () => ({
    clock: { matchSeconds: 300 }, population: { used: 8, capacityNow: 10, capacityCeiling: 100 },
    resources: { food: 400, wood: 400, stone: 200, gold: 200 },
    workers: { total: 10, idle: 1, food: 4, wood: 3, stone: 1, gold: 0 },
    friendlyBuildings: [{ type: 'town_center', x: 0, z: 0, state: 'complete', healthPct: 75 }, { type: 'barracks', x: 12, z: 0, state: 'complete', healthPct: 100 }],
    friendlyUnits: [{ id: 101, type: 'militia', x: 15, z: 0, healthPct: 100 }, { id: 102, type: 'worker', x: 3, z: 0, healthPct: 100 }],
    enemyUnits: [{ id: 'e-7', type: 'archer', x: 40, z: 0, visible: true }, { id: 'e-8', type: 'archer', x: 90, z: 0, visible: false }],
    enemyBuildings: [{ id: 'eb-3', type: 'tower', x: 60, z: 0 }],
    units: { trainable: { town_center: { stone: [{ id: 'worker' }] }, barracks: { stone: [{ id: 'militia' }] } }, blocked: {} },
    research: { current: null, researched: [], available: [] } });
const ok = (action, params = {}) => ({ action, params, ok: true });
const TRAIN2 = [ok('train_unit', { unitType: 'militia' }), ok('train_unit', { unitType: 'militia' })];

// [name, code, action, params, prior commands of the same reply, change to the state]
const CASES = [
    ['a free slot in the state', 'populationLimit', 'train_unit', { unitType: 'militia' }, [], null],
    ['the slots filled by the reply itself', 'populationLimit', 'train_unit', { unitType: 'militia' }, TRAIN2, null],
    ['the state was full', 'populationLimit', 'train_unit', { unitType: 'militia' }, [], s => { s.population.used = 10; }],
    ['a Town Center in the state', 'noTCTrain', 'train_unit', { unitType: 'worker' }, [], null],
    ['no Town Center in the state', 'noTCTrain', 'train_unit', { unitType: 'worker' }, [], s => { s.friendlyBuildings.shift(); }],
    ['workers: a Town Center', 'noTCWorkers', 'assign_workers', { resourceType: 'food' }, [], null],
    ['workers: one under construction', 'noTCWorkers', 'assign_workers', { resourceType: 'food' }, [], s => { s.friendlyBuildings[0].state = 'constructing'; }],
    ['its building in the state', 'unitBuildingNotBuilt', 'train_unit', { unitType: 'militia' }, [], null],
    ['its building not in the state', 'unitBuildingNotBuilt', 'train_unit', { unitType: 'militia' }, [], s => { s.friendlyBuildings.pop(); delete s.units.trainable.barracks; s.units.blocked.barracks = { stone: [{ id: 'militia' }] }; }],
    ['its building finished', 'buildingUnderConstr', 'train_unit', { unitType: 'militia' }, [], null],
    ['its building under construction', 'buildingUnderConstr', 'train_unit', { unitType: 'militia' }, [], s => { s.friendlyBuildings[1].state = 'constructing'; }],
    ['something damaged', 'nothingToRepair', 'repair_building', {}, [], null],
    ['nothing damaged', 'nothingToRepair', 'repair_building', {}, [], s => { s.friendlyBuildings[0].healthPct = 100; }],
    ['damage near the spot', 'noDamagedNear', 'repair_building', { targetX: 10, targetZ: 0 }, [], null],
    ['damage far from the spot', 'noDamagedNear', 'repair_building', { targetX: 500, targetZ: 500 }, [], null],
    ['damage, no spot given', 'noDamagedNear', 'repair_building', {}, [], null],
    ['fighters in the state', 'noMilitaryMove', 'move_units', { targetX: 5, targetZ: 5 }, [], null],
    ['no fighter in the state', 'noMilitaryMove', 'move_units', { targetX: 5, targetZ: 5 }, [], s => { s.friendlyUnits.shift(); }],
    ['attack: fighters in the state', 'noMilitaryAttack', 'attack_target', { targetId: 'e-7' }, [], null],
    ['a handle that was shown', 'moveNoMatch', 'move_units', { unitIds: [101] }, [], null],
    ['a handle written with a hash', 'moveNoMatch', 'move_units', { unitIds: ['#101'] }, [], null],
    ['a handle never shown', 'moveNoMatch', 'move_units', { unitIds: [999] }, [], null],
    ['a type that was shown', 'attackNoMatch', 'attack_target', { units: { militia: 1 } }, [], null],
    ['a type not shown', 'attackNoMatch', 'attack_target', { units: { archer: 1 } }, [], null],
    ['a class, with fighters shown', 'moveNoMatch', 'move_units', { units: { infantry: 2 } }, [], null],
    ['neither ids nor types', 'moveNoMatch', 'move_units', {}, [], null],
    ['explore: a handle shown', 'noUnitExplore', 'explore', { unitIds: [102] }, [], null],
    ['explore: a handle never shown', 'noUnitExplore', 'explore', { unitIds: [999] }, [], null],
    ['explore: a type shown', 'noUnitExplore', 'explore', { unitType: 'worker' }, [], null],
    ['explore: a type not shown', 'noUnitExplore', 'explore', { unitType: 'cavalry' }, [], null],
    ['explore: anybody', 'noUnitExplore', 'explore', { tile: 'C3' }, [], null],
    ['explore: nobody in the state', 'noUnitExplore', 'explore', { tile: 'C3' }, [], s => { s.friendlyUnits = []; }],
    ['delete: one shown', 'noUnitDelete', 'delete_unit', { unitType: 'worker' }, [], null],
    ['delete: the default type', 'noUnitDelete', 'delete_unit', {}, [], null],
    ['delete: a type not shown', 'noUnitDelete', 'delete_unit', { unitType: 'archer' }, [], null],
    ['delete: after a delete in the same reply', 'noUnitDelete', 'delete_unit', { unitType: 'worker' }, [ok('delete_unit', { unitType: 'worker' })], null],
    ['destroy: one shown', 'noBuildingDestroy', 'destroy_building', { buildingType: 'barracks' }, [], null],
    ['destroy: none shown', 'noBuildingDestroy', 'destroy_building', { buildingType: 'stable' }, [], null],
    ['destroy: after one in the same reply', 'noBuildingDestroy', 'destroy_building', { buildingType: 'barracks' }, [ok('destroy_building', { buildingType: 'barracks' })], null],
    ['workers free in the state', 'noWorkersBuild', 'build_structure', { buildingType: 'house' }, [], null],
    ['workers taken by the reply itself', 'noWorkersBuild', 'build_structure', { buildingType: 'house' }, [ok('assign_workers', { resourceType: 'wood' })], null],
    ['no worker in the state', 'noWorkersRepair', 'repair_building', {}, [], s => { s.workers = { total: 0, idle: 0, food: 0, wood: 0, stone: 0, gold: 0 }; }],
    ['reassign: workers free', 'noWorkersReassign', 'assign_workers', { resourceType: 'gold' }, [], null],
    ['farms: workers free', 'noWorkersForFarms', 'assign_workers', { resourceType: 'farm' }, [], null],
    ['a target in sight', 'targetOutOfSight', 'attack_target', { targetId: 'e-7' }, [], null],
    ['a target remembered, not in sight', 'targetOutOfSight', 'attack_target', { targetId: 'e-8' }, [], null],
    ['a building that was shown', 'targetNotFound', 'attack_target', { targetId: 'eb-3' }, [], null],
    ['a target never shown', 'targetNotFound', 'attack_target', { targetId: 'zz' }, [], null],
    ['no target named', 'targetNotFound', 'attack_target', {}, [], null],
    ['a pool with workers', 'assignFromEmpty', 'assign_workers', { resourceType: 'gold', from: 'wood' }, [], null],
    ['an empty pool', 'assignFromEmpty', 'assign_workers', { resourceType: 'wood', from: 'gold' }, [], null],
    ['a pool emptied by the reply itself', 'assignFromEmpty', 'assign_workers', { resourceType: 'gold', from: 'wood' }, [ok('assign_workers', { resourceType: 'stone', from: 'wood' })], null],
    ['no research in the state', 'alreadyResearching', 'research_tech', { techId: 'farm' }, [], null],
    ['a research in the state', 'alreadyResearching', 'research_tech', { techId: 'farm' }, [], s => { s.research.current = { techId: 'house' }; }],
    ['a research started by the reply itself', 'alreadyResearching', 'research_tech', { techId: 'farm' }, [ok('research_tech', { techId: 'house' })], null],
    ['a state that says nothing of research', 'alreadyResearching', 'research_tech', { techId: 'farm' }, [], s => { delete s.research; }],
    ['a code neither knows', 'cannotAfford', 'train_unit', { unitType: 'militia' }, [], null],
];

// The ledger's reading: the refusal as the last command of one recorded turn.
function ledgerStale(st, action, params, code, prior) {
    const cmds = prior.map(c => ({ action: c.action, params: c.params })).concat({ action, params });
    const outcomes = prior.map((c, i) => ({ n: i + 1, action: c.action, code: 'done', verdict: 'ok' })).concat({ n: prior.length + 1, action, code, verdict: 'avoidable' });
    const g = WarEval.profileOf([
        JSON.stringify({ type: 'match', matchId: 'm', players: [{ id: 'a', seat: 0, civ: 'greek', name: 'A', model: 'a' }] }),
        JSON.stringify({ turn: 1, playerId: 'a', seat: 0, civ: 'greek', name: 'A', model: 'a', state: st, parsed: { commands: cmds }, outcomes })
    ].join('\n')).seats[0].grounding;
    return g.stale === 1;
}

test('the harness and the ledger read every refusal the same way', async () => {
    const s = await stubSeat({});
    const M = s.mgr.constructor;
    const differ = [], counts = { stale: 0, own: 0 };
    for (const [name, code, action, params, prior, change] of CASES) {
        const st = base(); if (change) change(st);
        // As the harness asks it live: the unit's building is the rules' word.
        const req = (code === 'unitBuildingNotBuilt' || code === 'buildingUnderConstr') && params.unitType ? s.mgr.requiredBuildingForUnit(params.unitType, 'greek') : null;
        const live = M.isStaleAgainstSnapshot(JSON.parse(JSON.stringify(st)), action, params, code, prior, '', req);
        const scored = ledgerStale(st, action, params, code, prior);
        counts[live ? 'stale' : 'own']++;
        if (live !== scored) differ.push(`${code} (${name}): the harness says ${live ? 'the world moved' : 'the model\'s'}, the ledger ${scored ? 'the world moved' : 'the model\'s'}`);
    }
    assert.ok(counts.stale >= 20 && counts.own >= 20, 'both answers are exercised: ' + JSON.stringify(counts));
    assert.deepEqual(differ, []);
});

test('an order to units never shown is the model\'s for both, whatever was recorded', async () => {
    const s = await stubSeat({});
    const M = s.mgr.constructor;
    for (const [ids, shown] of [[[999], false], [[101], true], [['#102', 999], true]]) {
        const st = base();
        assert.equal(M.hasAnyShownFriendlyHandle(st, ids), shown);
        const g = WarEval.profileOf([
            JSON.stringify({ type: 'match', matchId: 'm', players: [{ id: 'a', seat: 0, civ: 'greek', name: 'A', model: 'a' }] }),
            JSON.stringify({ turn: 1, playerId: 'a', seat: 0, civ: 'greek', name: 'A', model: 'a', state: st,
                parsed: { commands: [{ action: 'move_units', params: { unitIds: ids, targetX: 1, targetZ: 1 } }] },
                outcomes: [{ n: 1, action: 'move_units', code: 'orderedUnitsGone', verdict: 'contended' }] })
        ].join('\n')).seats[0].grounding;
        assert.equal(g.avoidable, shown ? 0 : 1, JSON.stringify(ids));
        assert.equal(g.contended, shown ? 1 : 0, JSON.stringify(ids));
    }
});
