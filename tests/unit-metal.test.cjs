// Build 1213 (asp67): a unit's metal tells its age. A unit of the ages before iron wears
// and carries bronze wherever its model says metal, a unit of the Iron Age iron. The
// shapes are untouched: an earlier attempt at telling the tiers apart by new shapes (a
// horse cloth, a board on the back, a ring round the neck) was thrown out as ugly.
const test = require('node:test'), assert = require('node:assert/strict');
const vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

function units() {
    const scope = { window: {}, console }; scope.window.window = scope.window; vm.createContext(scope);
    for (const f of ['js/simulation/rng.js', 'js/simulation/math.js']) vm.runInContext(read(f), scope);
    for (const f of ['math3d', 'mesh', 'units']) vm.runInContext(read('js/engine/' + f + '.js'), scope);
    return scope.window.EngineUnits;
}

test('bronze changes the metal and nothing else: the same parts in the same places', () => {
    const U = units();
    const looks = [['infantry', 'warrior'], ['infantry', 'champion'], ['infantry', 'militia'], ['ranged', 'crossbowman'], ['ranged', 'archer'],
        ['cavalry', 'cavalry'], ['cavalry', 'heavy_cavalry'], ['cavalry', 'scout_cavalry'], ['priest', 'priest'], ['worker', 'worker']];
    for (const civ of ['greek', 'roman', 'yamato', 'egyptian', 'persian', 'viking', 'maya']) for (const [type, unit] of looks) {
        const name = [civ, unit].join(' ');
        const iron = U.parts(type, { civ, unit }), same = U.parts(type, { civ, unit, metal: 'iron' }), bronze = U.parts(type, { civ, unit, metal: 'bronze' });
        const shape = parts => parts.map(p => [p.kind, p.args.join(','), Array.from(p.m).map(v => v.toFixed(5)).join(','), p.bone, p.team, p.blend, p.accent].join('|'));
        assert.deepEqual(shape(bronze), shape(iron), name + ': not one part moved, grew or was added');
        assert.deepEqual(same.map(p => p.tex), iron.map(p => p.tex), name + ': iron is what it always was');
        assert.equal(bronze.some(p => p.tex === 'iron'), false, name + ': no iron left on a bronze unit');
        for (let i = 0; i < iron.length; i++) assert.equal(bronze[i].tex, iron[i].tex === 'iron' ? 'bronze' : iron[i].tex, name + ': only the metal changed');
        assert.equal(iron.some(p => p.tex === 'bronze'), false);
    }
    // The line trooper has plenty of metal to show it: helmet, breastplate, shoulders, shield rim, blade.
    const warrior = U.parts('infantry', { civ: 'greek', unit: 'warrior', metal: 'bronze' });
    assert.ok(warrior.filter(p => p.tex === 'bronze').length >= 8);
    // A unit that skins as iron skins as bronze: one material for another.
    assert.ok(U.skinned(warrior));
});

test('the renderer asks the rules which age a unit is of, and gives the ages before iron bronze', () => {
    const r = read('js/engine/gamerenderer.js');
    assert.match(r, /const def = unit\.type !== 'worker' && typeof getUnitDefFor === 'function' \? getUnitDefFor\(unit\.civilization, unit\.type\) : null;/);
    assert.match(r, /const metal = def && def\.tier && def\.tier !== 'iron' \? 'bronze' : 'iron';/);
    assert.match(r, /const options=\{civ:unit\.civilization,unit:unit\.type,metal,badge:/);
    assert.match(r, /options\.variant,options\.coat,metal\]\);/, 'two units that differ in their metal do not share a model');
    assert.match(r, /bronze: T\(TexGen\.bronze\(189\)\),/);
    assert.match(r, /const metal = obj\.tex === this\.tex\.gold \|\| obj\.tex === this\.tex\.iron \|\| obj\.tex === this\.tex\.bronze;/, 'it shines as metal does');
    // The sheet is the iron sheet in a bronze's colour: warm, and well away from the iron's grey.
    const t = read('js/engine/texgen.js');
    assert.match(t, /TexGen\.bronze = \(seed = 17, size = 64\) => \{[\s\S]{0,200}noisyFill\(ctx, size, \[196, 140, 66\]/);
    assert.match(t, /TexGen\.iron = \(seed = 16, size = 64\) => \{[\s\S]{0,200}noisyFill\(ctx, size, \[168, 172, 182\]/);
});

test('the ages are the rules\' own: the line is of the Bronze Age, the elite of the Iron Age', () => {
    const scope = { console }; vm.createContext(scope);
    vm.runInContext(read('js/units.js') + '\nthis.TYPES = UNIT_DEFS;', scope);
    const tier = id => { const d = Object.values(scope.TYPES).find(u => u.id === id); return d && d.tier; };
    const metal = id => (tier(id) && tier(id) !== 'iron' ? 'bronze' : 'iron');
    assert.deepEqual(['warrior', 'champion', 'cavalry', 'heavy_cavalry'].map(metal), ['bronze', 'iron', 'bronze', 'iron']);
    assert.deepEqual(['crossbowman', 'elite_archer'].map(metal), ['iron', 'iron'], 'both of the Iron Age: these two are not told apart by their metal');
    // Reading it changes no rule file, and the unit models are not among them.
    const manifest = require(path.join(__dirname, '..', 'js/manifest.js'));
    assert.equal(manifest.rules.concat(manifest.harness).some(f => /engine\//.test(f)), false);
    for (const f of manifest.rules) assert.doesNotMatch(read(f), /TexGen\.bronze|metal: ?'bronze'/, f);
});
