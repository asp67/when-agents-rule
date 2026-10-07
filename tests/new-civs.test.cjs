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

test('the Maya: no horses, and the spotter waits behind its own research', async () => {
    const c = data();
    for (const age of ['neolithic', 'bronze', 'iron'])
        assert.equal(c.getTrainOptionsForBuilding('stable', age, 'maya').length, 0, 'nothing to ride');
    assert.ok(!c.CIVS.maya.techTree.horseback, 'so no stable to build');
    assert.ok(c.getTrainOptionsForBuilding('barracks', 'neolithic', 'maya').includes('spotter'));
    // The scouting research costs horseback's price plus the stable's 50 gold.
    assert.deepEqual({ ...c.CIVS.maya.techTree.scouting.cost }, { food: 150, wood: 100, stone: 0, gold: 50 });
    assert.deepEqual({ ...c.getUnitDefFor('maya', 'spotter').cost }, { food: 130, wood: 0, stone: 0, gold: 0 }, 'paid in food');
    const m = await createMatch({ kind: 'board', seed: 'spotter', seats: [
        { civ: 'maya', age: 'neolithic', buildings: [['town_center', -200, 0], ['barracks', -170, 20]], resources: { food: 2000, wood: 2000, stone: 0, gold: 200 } },
        { civ: 'greek', age: 'neolithic', buildings: [['town_center', 200, 0]] }] });
    const ai = m.seats[0], ctl = m.controllers[0], g = m.game;
    const before = m.command(ctl, 'train_unit', { unitType: 'spotter' });
    assert.match(String(before), /needs the research "scouting" first/, before);
    const state = g.openAIAIManager.buildGameStateJSON(ctl);
    const listed = state.units.blocked.barracks.neolithic.find(u => u.id === 'spotter');
    assert.deepEqual([...listed.blockedBy], ['tech'], 'the model sees why');
    assert.equal(listed.requiresTech, 'scouting');
    ai.researchedTechs.scouting = true;
    const after = m.command(ctl, 'train_unit', { unitType: 'spotter' });
    assert.doesNotMatch(String(after), /ERROR/, after);
    // As far-sighted as a rider; and explore sends it before a slower soldier.
    const spotter = createUnitIn(m, ai, 'spotter');
    const militia = createUnitIn(m, ai, 'militia');
    assert.equal(g.unitVision(spotter), 22.5);
    assert.equal(g.unitVision(militia), 15);
    assert.equal(g.openAIAIManager.pickScout(ai), spotter);
    // The rule-based AI does not fill its barracks with scouts.
    const mgr = Object.create(c.AIManager.prototype);
    const opts = c.getTrainOptionsForBuilding('barracks', 'neolithic', 'maya');
    const rich = { food: 9999, wood: 9999, stone: 9999, gold: 9999 };
    assert.equal(mgr.getUnitToTrain({ civilization: 'maya', age: 'neolithic', resources: rich, researchedTechs: { scouting: true } }, { type: 'barracks', trainOptions: opts }), 'militia');
    assert.equal(mgr.getUnitToTrain({ civilization: 'maya', age: 'bronze', resources: rich, researchedTechs: {} },
        { type: 'barracks', trainOptions: c.getTrainOptionsForBuilding('barracks', 'bronze', 'maya') }), 'jaguar_warrior');
});
function createUnitIn(m, ai, type) {
    const vmc = m.context;
    const u = vm.runInContext(`createUnit(${JSON.stringify(type)}, ${-190}, ${30}, ${JSON.stringify(ai.id)}, ${JSON.stringify(ai.civilization)}, 'neolithic')`, vmc);
    ai.units.push(u);
    return u;
}

test('the Maya\'s maize: a farm gives 30% more food, and lasts as long', async () => {
    const run = async civ => {
        const m = await createMatch({ kind: 'board', seed: 'maize', seats: [
            { civ, age: 'neolithic', buildings: [['town_center', -200, 0], ['farm', -185, 0, { tag: 'farm' }]], units: [['worker', -186, 1, { tag: 'w' }]] },
            { civ: 'persian', age: 'neolithic', buildings: [['town_center', 200, 0]] }] });
        const ai = m.seats[0], farm = m.tags.farm, w = m.tags.w;
        const bonus = m.context.getCivilization(civ).bonus;   // a board applies no civ bonus; the arena does
        if (bonus && bonus.effect) bonus.effect(ai);
        farm.assignedWorker = w; w.task = 'farm_work'; w.farmRef = farm;
        const food0 = ai.resources.food, farm0 = farm.foodAmount;
        m.run(60000);
        return { food: ai.resources.food - food0, farm: farm0 - farm.foodAmount };
    };
    const maya = await run('maya'), greek = await run('greek');
    assert.ok(greek.food > 0, 'the farm was worked');
    assert.ok(Math.abs(maya.food / greek.food - 1.3) < 0.02, `food ${maya.food} vs ${greek.food}`);
    assert.equal(maya.farm, greek.farm, 'the field depletes as fast');
});

test('the Maya draw as themselves: El Castillo, feathers, the spotter\'s parrot', () => {
    const scope = { window: {} }; vm.createContext(scope);
    for (const f of ['math3d', 'mesh', 'buildings', 'units']) vm.runInContext(source('engine/' + f + '.js'), scope);
    const { EngineBuildings, EngineUnits } = scope.window;
    const keys = parts => parts.map(p => p.key).join('|');
    assert.notEqual(keys(EngineBuildings.parts('el_castillo', {})), keys(EngineBuildings.parts('pyramid', {})), 'not Egypt\'s pyramid');
    assert.notEqual(keys(EngineUnits.parts('infantry', { civ: 'maya', unit: 'jaguar_warrior' })),
        keys(EngineUnits.parts('infantry', { civ: 'nobody', unit: 'jaguar_warrior' })));
    const spotter = EngineUnits.parts('infantry', { civ: 'maya', unit: 'spotter' }).length;
    const plain = EngineUnits.parts('infantry', { civ: 'maya', unit: 'militia' }).length;
    assert.equal(spotter - plain, 11, 'the parrot: body, head, beak, a tail of two and two wings of three triangles (b1068)');
});

test('the new civilizations\' Town Centers, houses and academies are their own (b1061)', () => {
    const scope = { window: {} }; vm.createContext(scope);
    for (const f of ['math3d', 'mesh', 'buildings']) vm.runInContext(source('engine/' + f + '.js'), scope);
    const { EngineBuildings } = scope.window;
    const shape = (type, civ, age) => EngineBuildings.parts(type, { civ, age }).map(p => p.key).join('|');
    for (const civ of ['roman', 'viking', 'maya'])
        for (const [type, ages] of [['town_center', ['bronze', 'iron']], ['house', ['bronze', 'iron']], ['academy', ['iron']], ['temple', ['bronze', 'iron']]])
            for (const age of ages) {
                assert.notEqual(shape(type, civ, age), shape(type, 'nobody', age), `${civ} ${type} ${age}: the generic one`);
                for (const other of ['roman', 'viking', 'maya', 'greek', 'egyptian', 'persian', 'yamato'].filter(o => o !== civ))
                    assert.notEqual(shape(type, civ, age), shape(type, other, age), `${civ} ${type} ${age}: ${other}'s`);
            }
    // The Colosseum's arena floor lies on the ground, inside the ring -- not on its roof.
    const sand = EngineBuildings.parts('colosseum', {}).filter(p => p.tint && p.kind === 'cylinder');
    assert.equal(sand.length, 1);
    assert.ok(sand[0].m[13] < 0.5, 'the floor at y ' + sand[0].m[13]);
});

test('the Roman door is an arch of stones under the eaves, not a disc over the door (b1062)', () => {
    const scope = { window: {} }; vm.createContext(scope);
    for (const f of ['math3d', 'mesh', 'buildings']) vm.runInContext(source('engine/' + f + '.js'), scope);
    const parts = scope.window.EngineBuildings.parts('house', { civ: 'roman', age: 'bronze' });
    const discs = parts.filter(p => p.kind === 'cylinder' && p.tex === 'plaster');
    assert.equal(discs.length, 0, 'b1061 laid a white disc over the doorway');
    const arch = parts.filter(p => p.kind === 'box' && p.tex === 'plaster' && p.args[0] === 0.24);
    assert.equal(arch.length, 7);
    for (const s of arch) assert.ok(s.m[13] + s.args[1] / 2 <= 2.3, 'below the eaves (2.3): ' + (s.m[13] + s.args[1] / 2));
});

test('the spotter\'s parrot sits on its shoulder at rest and flies beside it, high up, while it walks (b1065, b1067)', () => {
    const scope = { window: {} }; vm.createContext(scope);
    for (const f of ['math3d', 'mesh', 'buildings', 'units']) vm.runInContext(source('engine/' + f + '.js'), scope);
    const { EngineUnits } = scope.window;
    const bones = EngineUnits.parts('infantry', { civ: 'maya', unit: 'spotter' }).map(p => p.bone);
    assert.equal(bones.filter(b => b === 'parrot').length, 5);
    assert.equal(bones.filter(b => b === 'parrotWing').length, 3, 'a wing on each side (b1066): red, yellow, blue (b1068)');
    assert.equal(bones.filter(b => b === 'parrotWingR').length, 3);
    const [sx, sy, sz] = EngineUnits.PARROT_SEAT;
    const at = (m) => [m[0] * sx + m[4] * sy + m[8] * sz + m[12], m[1] * sx + m[5] * sy + m[9] * sz + m[13], m[2] * sx + m[6] * sy + m[10] * sz + m[14]];
    for (const t of [0, 1.7, 9.3]) {
        const rest = at(EngineUnits.parrotPose(0, t, 0.4).parrot);
        assert.ok(Math.hypot(rest[0] - sx, rest[1] - sy, rest[2] - sz) < 1e-4, 'on the shoulder');
        const fly = at(EngineUnits.parrotPose(1, t, 0.4).parrot);
        assert.ok(fly[1] > 4.2 && fly[1] < 5.0, 'high above: ' + fly[1]);
        const [fx, , fz] = EngineUnits.PARROT_FLIGHT;
        assert.ok(Math.hypot(fly[0] - fx, fly[2] - fz) < 1e-4, 'beside its spotter, not circling (b1067)');   // Float32 matrices
    }
});

test('the Maya plumes: green for a worker, red for one plume, red-green-yellow-blue for a fan (b1068)', () => {
    const scope = { window: {} }; vm.createContext(scope);
    for (const f of ['math3d', 'mesh', 'buildings', 'units']) vm.runInContext(source('engine/' + f + '.js'), scope);
    const { EngineUnits } = scope.window;
    const plumes = (type, unit) => EngineUnits.parts(type, { civ: 'maya', unit }).filter(p => p.tex.startsWith('feather') && p.kind === 'box' && !p.bone).map(p => p.tex);
    assert.deepEqual([...plumes('worker', 'worker')], ['featherGreen']);
    assert.deepEqual([...plumes('infantry', 'militia')], ['feather']);
    assert.deepEqual([...plumes('infantry', 'jaguar_warrior')], ['feather', 'featherGreen', 'featherYellow', 'featherBlue']);
    assert.deepEqual([...plumes('priest', 'priest')], ['feather', 'featherGreen', 'featherYellow', 'featherBlue']);
});

test('the four original civilizations\' houses are their own too (b1069)', () => {
    const scope = { window: {} }; vm.createContext(scope);
    for (const f of ['math3d', 'mesh', 'buildings']) vm.runInContext(source('engine/' + f + '.js'), scope);
    const shape = (civ, age) => scope.window.EngineBuildings.parts('house', { civ, age }).map(p => p.key).join('|');
    const all = ['greek', 'egyptian', 'persian', 'yamato', 'roman', 'viking', 'maya'];
    for (const age of ['bronze', 'iron'])
        for (const civ of ['greek', 'egyptian', 'persian', 'yamato']) {
            assert.notEqual(shape(civ, age), shape('nobody', age), `${civ} ${age}: the shared house`);
            for (const other of all.filter(o => o !== civ)) assert.notEqual(shape(civ, age), shape(other, age), `${civ} ${age}: ${other}'s`);
        }
});

test('Rome in deep red, under a rectangular scutum (b1070)', () => {
    const c = data();
    const rgb = n => [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    const [rr, rg, rb] = rgb(c.CIVS.roman.color), [pr, pg, pb] = rgb(c.CIVS.persian.color);
    assert.ok(rr > rg * 2 && rr > rb * 2, 'red');
    assert.ok(rr + rg + rb < (pr + pg + pb) * 0.5, 'well darker than Persia\'s red');
    const scope = { window: {} }; vm.createContext(scope);
    for (const f of ['math3d', 'mesh', 'buildings', 'units']) vm.runInContext(source('engine/' + f + '.js'), scope);
    const shield = civ => scope.window.EngineUnits.parts('infantry', { civ, unit: 'warrior' }).filter(p => p.bone === 'armL' && p.team);
    assert.ok(shield('roman').every(p => p.kind === 'box') && shield('roman').length === 3, 'a curved rectangle of three panels');
    assert.ok(shield('greek').every(p => p.kind === 'sphere'), 'everyone else keeps the round shield');
});

test('the Persian Bronze-age Town Center\'s finial sits on its roof (b1071)', () => {
    const scope = { window: {} }; vm.createContext(scope);
    for (const f of ['math3d', 'mesh', 'buildings']) vm.runInContext(source('engine/' + f + '.js'), scope);
    const parts = scope.window.EngineBuildings.parts('town_center', { civ: 'persian', age: 'bronze' });
    const cone = parts.find(p => p.kind === 'cylinder' && p.team && p.args[0] === 0);
    const ball = parts.find(p => p.kind === 'sphere' && p.tex === 'gold');
    const tip = cone.m[13] + cone.args[2] / 2, bottom = ball.m[13] - 0.2;   // centre-anchored; the ball is 0.2 across each way
    assert.ok(Math.abs(bottom - tip) < 0.05, `the ball's foot ${bottom} at the cone's tip ${tip}`);
});
