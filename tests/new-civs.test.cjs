// Romans, Vikings and Maya (b1058-): each new civilization keeps the pattern the four
// originals share, and plays, trains and draws as itself.
const test = require('node:test'), assert = require('node:assert/strict');
const vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
const { createMatch } = require('../tools/bench/realm.cjs');
const root = path.resolve(__dirname, '..');
const source = f => fs.readFileSync(path.join(root, 'js', f), 'utf8');

const data = () => {
    const c = vm.createContext({ console, t: k => k, WarMath: { powInt: (b, e) => b ** e } });
    vm.runInContext(['units.js', 'civilizations.js', 'buildings.js', 'ai.js'].map(source).join('\n') +
        '\nthis.CIVS = CIVILIZATIONS; this.AIManager = AIManager; this.getTrainOptionsForBuilding = getTrainOptionsForBuilding;' +
        ' this.getUnitDefFor = getUnitDefFor; this.UNIT_DEFS = UNIT_DEFS; this.BUILDING_DEFS = BUILDING_DEFS;', c);
    return c;
};
const sum = c => (c.food || 0) + (c.wood || 0) + (c.stone || 0) + (c.gold || 0);

test('every civilization carries the shared techs, one Wonder, and units that can be trained', () => {
    const c = data();
    for (const [id, civ] of Object.entries(c.CIVS)) {
        for (const t of ['house', 'farm', 'barracks', 'longbow', 'academy', 'healing', 'fire_arrows'])   // Persia has no iron_working
            assert.ok(civ.techTree[t], `${id}: ${t}`);
        const wonders = civ.uniqueBuildings.filter(b => b.type === 'wonder');
        assert.equal(wonders.length, 1, id);
        assert.equal(wonders[0].health, 1500, id);
        assert.equal(sum(wonders[0].cost), id === 'egyptian' ? 16500 : 15500, id + ': the shared Wonder price');
        // Every tech it requires exists in its own tree.
        for (const [tid, t] of Object.entries(civ.techTree))
            for (const r of t.requires || []) assert.ok(civ.techTree[r], `${id}: ${tid} requires ${r}`);
        // Every own unit is trainable somewhere, at an age it names, or replaces a shared one.
        for (const u of civ.uniqueUnits) {
            if (u.id === 'archer_ship') continue;   // dead since before b1058 (ENHANCEMENT-REVIEW)
            if (c.UNIT_DEFS[u.id]) continue;
            assert.ok(u.trainAt && c.BUILDING_DEFS[u.trainAt], `${id}: ${u.id} has a building`);
            assert.ok(['stone', 'neolithic', 'bronze', 'iron'].includes(u.tier), `${id}: ${u.id} has an age`);
            assert.ok(c.getTrainOptionsForBuilding(u.trainAt, 'iron', id).includes(u.id), `${id}: ${u.id} at its ${u.trainAt}`);
        }
    }
});

test('Rome: the legion and the equites, trained by the rule-based AI too', () => {
    const c = data();
    const opts = (b, age) => c.getTrainOptionsForBuilding(b, age, 'roman');
    assert.ok(!opts('stable', 'bronze').includes('cavalry'), 'the equites ride in its place');
    assert.ok(opts('stable', 'bronze').includes('equites'));
    assert.ok(opts('barracks', 'bronze').includes('legionary'));
    assert.ok(!opts('barracks', 'neolithic').includes('legionary'), 'not before its age');
    const mgr = Object.create(c.AIManager.prototype);
    const rich = { food: 9999, wood: 9999, stone: 9999, gold: 9999 };
    const pick = (type, age) => mgr.getUnitToTrain({ civilization: 'roman', age, resources: rich }, { type, trainOptions: opts(type, age) });
    assert.equal(pick('barracks', 'bronze'), 'legionary');
    assert.equal(pick('stable', 'bronze'), 'equites');
    assert.equal(pick('stable', 'iron'), 'heavy_cavalry', 'the shared Iron-age line stays');
});

test('Rome builds 30% faster, from the first match second', async () => {
    const m = await createMatch({ kind: 'arena', seed: 'rome', seats: ['roman', 'greek'] });
    const [rome, greece] = m.seats;
    assert.equal(rome.workerBuildSpeedBonus, 1.3);
    assert.equal(greece.workerBuildSpeedBonus || 1, 1);
    assert.ok(rome.buildings.some(b => b.type === 'town_center'));
});

test('Rome draws as itself: its Wonder, its palette, its soldiers', () => {
    const scope = { window: {} }; vm.createContext(scope);
    for (const f of ['math3d', 'mesh', 'buildings', 'units']) vm.runInContext(source('engine/' + f + '.js'), scope);
    const { EngineBuildings, EngineUnits } = scope.window;
    const keys = parts => parts.map(p => p.key).join('|');
    assert.notEqual(keys(EngineBuildings.parts('colosseum', { civ: 'roman' })), keys(EngineBuildings.parts('wonder', { civ: 'roman' })), 'not the generic Wonder');
    const tints = civ => EngineBuildings.parts('house', { civ, age: 'bronze' }).map(p => String(p.tint)).join('|');
    assert.notEqual(tints('roman'), tints('nobody'), 'a palette of its own');
    const soldier = civ => keys(EngineUnits.parts('infantry', { civ, unit: 'legionary' }));
    assert.notEqual(soldier('roman'), soldier('nobody'), 'its own helmet');
});

test('the Vikings raid: every soldier hits buildings 25% harder, workers do not', async () => {
    const m = await createMatch({ kind: 'arena', seed: 'raid', seats: ['viking', 'greek'] });
    const g = m.game, [vik, gre] = m.seats;
    assert.equal(vik.raidBonus, 0.25);
    const house = { type: 'house' };
    const hit = (owner, unitType) => g.combatMultiplier({ owner: owner.id, unitType }, house);
    assert.equal(hit(vik, 'infantry'), 1.5 * 1.25);
    assert.equal(hit(vik, 'cavalry'), 1.25);
    assert.equal(hit(vik, 'ranged'), 0.5 * 1.25);
    assert.equal(hit(vik, 'worker'), 0.5, 'not a soldier');
    assert.equal(hit(gre, 'infantry'), 1.5, 'nobody else');
    assert.equal(g.combatMultiplier({ owner: vik.id, unitType: 'infantry' }, { unitType: 'infantry' }), 1.0, 'units as before');
});

test('the Vikings train the berserker and the axe thrower, and draw as themselves', () => {
    const c = data();
    const opts = (b, age) => c.getTrainOptionsForBuilding(b, age, 'viking');
    assert.ok(opts('barracks', 'bronze').includes('berserker'));
    assert.ok(opts('archery_range', 'neolithic').includes('axe_thrower'));
    const mgr = Object.create(c.AIManager.prototype);
    const rich = { food: 9999, wood: 9999, stone: 9999, gold: 9999 };
    const pick = (type, age) => mgr.getUnitToTrain({ civilization: 'viking', age, resources: rich }, { type, trainOptions: opts(type, age) });
    assert.equal(pick('barracks', 'bronze'), 'berserker');
    assert.equal(pick('archery_range', 'neolithic'), 'axe_thrower');
    assert.equal(pick('archery_range', 'iron'), 'elite_archer', 'the Iron-age bow outranks it');
    const scope = { window: {} }; vm.createContext(scope);
    for (const f of ['math3d', 'mesh', 'buildings', 'units']) vm.runInContext(source('engine/' + f + '.js'), scope);
    const { EngineBuildings, EngineUnits } = scope.window;
    const keys = parts => parts.map(p => p.key).join('|');
    assert.notEqual(keys(EngineBuildings.parts('longhall', {})), keys(EngineBuildings.parts('wonder', {})));
    assert.notEqual(keys(EngineUnits.parts('infantry', { civ: 'viking', unit: 'berserker' })),
        keys(EngineUnits.parts('infantry', { civ: 'nobody', unit: 'berserker' })), 'its own helmet');
});
