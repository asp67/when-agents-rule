// Anchor tiers (review #7): the rule-based brain in named styles (AI_PROFILES). The
// classic style must stay the brain it always was -- it is the baseline every earlier
// result was measured against -- and each other style must differ ONLY in the ways its
// table row says, with no more sight than any seat has.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const { GoldenMatch } = require('./harness.cjs');

const plain = v => JSON.parse(JSON.stringify(v));

test('the standard style is the brain as it always was', () => {
    const m = new GoldenMatch({ seed: 1 });
    const P = plain(vm.runInContext('AI_PROFILES', m.context));
    // The literals runTurn, ensureMilitaryBuildings and commandArmy used before the
    // table existed. Changing one is a rules change for every rule-based seat ever run.
    assert.deepEqual(P.standard, { thinkMs: 2000, workers: 14, farms: 4, houses: 6, militaryAt: 8, attackAt: 8,
        wonderArmy: 6, towers: 1, towerStone: 120, reserve: false, pick: 'ladder', prey: 'nearest' });
    assert.deepEqual(Object.keys(P), ['standard', 'turtle', 'legion', 'raider']);
    for (const [id, p] of Object.entries(P)) assert.deepEqual(Object.keys(p), Object.keys(P.standard), id + ' names every knob');
    const [a] = m.startFixture(['greek']);
    assert.equal(a.profile, 'standard', 'a seat plays standard unless told otherwise');
    assert.equal(m.game.aiManager.addAIPlayer('greek', 'medium', 'no-such-style').profile, 'standard');
});

test('each seat thinks on its own clock: a raider twice as often', async () => {
    const m = new GoldenMatch({ seed: 2, hidden: true });
    await m.startArena({ seats: [{ civ: 'greek', type: 'ki' }, { civ: 'persian', type: 'ki', profile: 'raider' }], seed: 'anchor-clock' });
    const mgr = m.game.aiManager, turns = {};
    const run = mgr.runTurn.bind(mgr);
    mgr.runTurn = ai => { turns[ai.profile] = (turns[ai.profile] || 0) + 1; return run(ai); };
    m.run(20000);
    assert.deepEqual(turns, { standard: 10, raider: 20 });
});

// The manager lives as long as the page. Its think timer used to be one field on it, so
// a Rematch inherited the last match's beat, and so did its discovery timer.
test('a Rematch in the same page plays the match it repeats', async () => {
    const seats = ['greek', 'persian'], seed = 'anchor-rematch';
    const strip = s => { const { clock, ...rest } = s; return rest; };
    const fresh = new GoldenMatch({ seed: 3 });
    await fresh.startArena({ seats, seed });
    fresh.run(90000);
    const again = new GoldenMatch({ seed: 3 });
    await again.startArena({ seats, seed });
    again.run(3300);                         // mid-period for both beats: 3300 % 250, 3300 % 2000
    assert.ok(again.game.aiManager.discoveryTimer > 0, 'the restart must find the discovery beat mid-period');
    await again.startArena({ seats, seed });  // ...and Rematch
    for (const ai of again.game.aiManager.aiPlayers) assert.equal(ai.thinkTimer, 0);
    assert.equal(again.game.aiManager.discoveryTimer, 0);
    again.run(90000);
    assert.deepEqual(strip(again.snapshot()), strip(fresh.snapshot()));
});

// A small board: `me` with a finished barracks, archery range and stable, and money.
// Train options as a finished building gets them (Game.completeConstruction).
function barracksBoard(profile, age = 'bronze') {
    const m = new GoldenMatch({ seed: 4 });
    const [me, foe] = m.startFixture(['greek', 'persian']);
    me.profile = profile;
    me.age = age;
    ['barracks', 'archery_range', 'stable'].forEach((t, i) => {
        const b = m.addBuilding(me, t, -60 + 20 * i, 0);
        b.trainOptions = m.context.getTrainOptionsForBuilding(t, me.age, me.civilization);
    });
    m.addBuilding(me, 'town_center', -40, 30);
    for (let i = 0; i < 6; i++) m.addUnit(me, 'worker', -40 + i * 2, 40);
    for (let i = 0; i < 6; i++) m.addBuilding(me, 'house', -80 + i * 10, -40);
    Object.assign(me.resources, { food: 5000, wood: 5000, stone: 5000, gold: 5000 });
    me.resources.updatePopulation(me.units.length);
    return { m, me, foe, mgr: m.game.aiManager };
}
const producing = me => Array.from(me.buildings.filter(b => b.isProducing), b => b.type).sort();   // a local array: the list lives in the vm realm

test('legion trains what beats the army it has seen, and only what it has seen', () => {
    const { m, me, foe, mgr } = barracksBoard('legion');
    // Nothing seen yet: it trains like everyone else.
    mgr.trainMilitary(me);
    assert.deepEqual(producing(me), ['archery_range', 'barracks', 'stable']);
    me.buildings.forEach(b => { b.isProducing = false; });
    // Cavalry far off in the dark tells it nothing.
    for (let i = 0; i < 5; i++) m.addUnit(foe, 'scout_cavalry', 300, i * 3);
    mgr.trainMilitary(me);
    assert.deepEqual(producing(me), ['archery_range', 'barracks', 'stable'], 'unseen units are not known');
    me.buildings.forEach(b => { b.isProducing = false; });
    // In sight of its own buildings: infantry beats cavalry, so only the barracks trains.
    foe.units.forEach(u => { u.x = -40; u.z = -10; });
    mgr.trainMilitary(me);
    assert.deepEqual(producing(me), ['barracks']);
    me.buildings.forEach(b => { b.isProducing = false; });
    // Gone from sight, but remembered.
    foe.units.forEach(u => { u.x = 300; });
    mgr.trainMilitary(me);
    assert.deepEqual(producing(me), ['barracks']);
    // The standard style, shown the same army, ignores it.
    const std = barracksBoard('standard');
    for (let i = 0; i < 5; i++) m.addUnit(std.foe, 'scout_cavalry', -40, -10 + i);
    std.mgr.trainMilitary(std.me);
    assert.deepEqual(producing(std.me), ['archery_range', 'barracks', 'stable']);
});

test('a raider goes for the workers it can see; standard takes the nearest target', () => {
    for (const [profile, expect] of [['raider', 'worker'], ['standard', 'warrior']]) {
        const m = new GoldenMatch({ seed: 5 });
        const [me, foe] = m.startFixture(['greek', 'persian']);
        me.profile = profile;
        const army = [];
        for (let i = 0; i < 8; i++) army.push(m.addUnit(me, 'warrior', 0, i * 2));
        m.addUnit(foe, 'warrior', 5, 6);    // nearer...
        m.addUnit(foe, 'worker', 11, 6);    // ...but both inside a warrior's sight (15)
        m.game.aiManager.commandArmy(me, army, null);
        assert.equal(army[0].attackTarget && army[0].attackTarget.type, expect, profile);
    }
});

test('turtle raises its army, then saves for the next age; standard spends', () => {
    for (const [profile, army, food, trains] of [['turtle', 20, 1200, true], ['turtle', 20, 1010, false],
                                                 ['turtle', 19, 1010, true], ['standard', 20, 1010, true]]) {
        const { m, me, mgr } = barracksBoard(profile, 'stone');   // saving for neolithic: 1000 food, 800 wood
        for (let i = 0; i < army; i++) m.addUnit(me, 'militia', 40, i * 2);
        for (let i = 0; i < 4; i++) m.addBuilding(me, 'house', -80 + i * 10, -60);
        Object.assign(me.resources, { food, wood: 900, stone: 0, gold: 0 });
        me.buildings = me.buildings.filter(b => b.type !== 'archery_range' && b.type !== 'stable');
        mgr.trainMilitary(me);
        assert.equal(producing(me).length > 0, trains, `${profile}, ${army} soldiers, ${food} food`);
    }
});

test('the contract line lists rule-based seats as anchors keyed to the core hash', async () => {
    const read = f => fs.readFileSync(path.join(__dirname, '../..', f), 'utf8');
    const scope = { console, getCivilization: id => ({ name: id, color: 0, bonus: { description: 'x' } }) };
    vm.createContext(scope);
    for (const f of ['js/manifest.js', 'js/sha256.js', 'js/conditions.js', 'js/openai-ai.js']) vm.runInContext(read(f), scope);
    vm.runInContext('this.W = WarConditions; this.M = OpenAIAIManager;', scope);
    scope.W.source = async f => scope.W.lf(read(f));
    const model = { id: 'p1', civilization: 'greek', seat: 0 }, house = { id: 'p2', civilization: 'persian', seat: 1, profile: 'turtle' };
    const manager = new scope.M({ difficulty: 'easy', spectatorMode: true, aiManager: { aiPlayers: [model, house] } });
    manager.aiControllers = [{ id: 'p1', aiPlayer: model, model: { provider: 'openai', language: 'en' } }];
    manager.transcripts = { matchId: 'm', addHeaderLine() {} };
    const rec = await manager.writeContract();
    assert.deepEqual(plain(rec.anchors), [{ playerId: 'p2', seat: 1, profile: 'turtle', coreHash: rec.coreHash, contractIdentical: false }]);
    assert.deepEqual(rec.seats.map(s => s.playerId), ['p1']);
});

// Calibration found this: the brain gave up every march leg after 24 s, about 85 units
// of walking, and capped legs at half the map from its own base. Two rule-based seats
// then played 45 minutes without meeting. Its army must find a base across the map.
test('a rule-based army finds a rival base across the map', () => {
    const m = new GoldenMatch({ seed: 6, hidden: true });
    const [me, foe] = m.startFixture(['greek', 'persian']);
    m.scripted(foe);                          // the rival only stands there
    // The arena's own two-seat spawns. Found at about 10 minutes; never, before.
    m.addBuilding(me, 'town_center', 0, -306);
    const tc = m.addBuilding(foe, 'town_center', 0, 306);
    for (let i = 0; i < 8; i++) m.addUnit(me, 'warrior', 20 + (i % 4) * 2, -286 + Math.floor(i / 4) * 2);
    let found = null;
    for (let s = 1; s <= 15 * 60 && found == null; s++) {
        m.run(1000);
        if (me._knownEnemyBuildings.has(tc)) found = s;
    }
    assert.ok(found != null, 'it never saw the rival town centre in fifteen minutes');
});
