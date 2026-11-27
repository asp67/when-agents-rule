// The reach of an inspected tower or trebuchet is drawn around it (build 1293). It was not:
// the frame read a selection of its own that nothing set, a `attackRange` no building has,
// and a unit type 'trebuchet' that is the site's name, not the engine's. The test that
// claimed to cover it built an object with exactly those fields.
// Also here: a hit flashed before the first frame (build 1294).
const test = require('node:test'), assert = require('node:assert/strict');
const vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

function load() {
    const ctx = vm.createContext({ console, Math, Date, Map, Set, WeakMap, Float32Array, Uint8Array, Array, Object, String, Number,
        performance: { now: () => 5000 },
        document: { addEventListener() {}, createElement: () => ({ width: 64, height: 64, getContext: () => ({}) }) },
        GLCore: { createMeshBuffers: () => ({}), drawMesh() {}, instancingOf: () => false },
        TexGen: { TERRAIN_SEED: 1, TERRAIN_WORLD: 1000, TERRAIN_LAND: 400, MAP_SIZE: 800 } });
    ctx.window = ctx;
    for (const f of ['math3d', 'mesh', 'units', 'atmosphere', 'fx', 'gamerenderer']) vm.runInContext(read('js/engine/' + f + '.js'), ctx);
    return ctx;
}
// The rules' own numbers, from the rules' own files.
function rules() {
    const ctx = vm.createContext({ console, Math });
    vm.runInContext(read('js/buildings.js') + '\n' + read('js/units.js') + '\nthis.B = BUILDING_DEFS; this.unitDef = getUnitDef; this.tiers = TREBUCHET_TIERS;', ctx);
    return { tower: ctx.B.tower.range, simple: ctx.unitDef('simple_trebuchet').range, advanced: ctx.unitDef('advanced_trebuchet').range, tiers: ctx.tiers };
}
function frame(ctx, { game = {}, selectedUnits = [], buildings = [], units = [] }) {
    const r = Object.create(ctx.EngineRenderer.prototype);
    Object.assign(r, { gl: {}, graphicsQuality: 'balanced', visualStyle: 'cinematic', _reducedMotion: true, cloudShadows: false, weatherMotes: false,
        _theme: 'summer', _nightFactor: 0, _halfH: 34, cameraTarget: { x: 0, y: 0, z: 0 },
        _dl: { opaque: [], blended: [], bars: [], casters: [] }, _geo: new Map(), _projectiles: [], _rings: [], _ghosts: [], _rubble: [], _breaks: [],
        tex: { white: {}, mote: {}, ring: {}, shadow: {}, rock: {} }, WHITE: [1, 1, 1], units, buildings, selectedUnits,
        selectedBuilding: null,                      // as the constructor leaves it, and nothing sets it
        entityHidden: () => false, _cull: () => false, _fow: () => null, _buf: (kind, args) => ({ kind, args }),
        game: Object.assign({ spectatorMode: true, aiManager: { aiPlayers: [] }, openAIAIManager: { aiControllers: [] } }, game) });
    r._assembleFrame(12.5, 0.05, ctx.M3D.identity());
    // The reach ring: the dashed hairline of 64 or 96 segments (the dashed one of 72 is the order's).
    return r._dl.blended.filter(e => e.buf && e.buf.kind === 'thinRing' && e.buf.args[3] === true && (e.buf.args[2] === 64 || e.buf.args[2] === 96))
        .map(e => ({ r: Math.round(e.model[0] * 100) / 100, x: e.model[12], z: e.model[14] }));
}

test('an inspected tower or trebuchet shows its reach, the rules\' own, and nothing else shows one', () => {
    const ctx = load(), R = rules();
    assert.deepEqual([R.tower, R.simple, R.advanced], [18, R.tiers.simple.range, R.tiers.advanced.range]);
    const tower = { id: 'b1', type: 'tower', owner: 'p2', x: 25, z: -4, health: 200, maxHealth: 200, range: R.tower };
    const barracks = { id: 'b2', type: 'barracks', owner: 'p2', x: -30, z: 8, health: 300, maxHealth: 300 };
    const treb = (type, range, x) => ({ id: 'u' + x, type, owner: 'p1', x, z: 12, health: 100, maxHealth: 100, range, selected: true });
    const none = { buildings: [tower, barracks] };

    assert.deepEqual(frame(ctx, none), [], 'nothing inspected, no ring');
    // A building picked by a player or by a spectator is the game's selectedBuilding.
    assert.deepEqual(frame(ctx, { ...none, game: { selectedBuilding: tower } }), [{ r: R.tower, x: 25, z: -4 }]);
    assert.deepEqual(frame(ctx, { ...none, game: { selectedBuilding: barracks } }), [], 'a barracks reaches nothing');
    assert.deepEqual(frame(ctx, { ...none, game: { selectedBuilding: Object.assign({}, tower, { underConstruction: true }) } }), [], 'a site does not shoot');
    // A unit picked by a spectator is the one the camera follows; by a player, the renderer's selection.
    const simple = treb('simple_trebuchet', R.simple, -10), heavy = treb('advanced_trebuchet', R.advanced, 40);
    assert.deepEqual(frame(ctx, { ...none, game: { _camFollow: { kind: 'units', units: [simple] } } }), [{ r: R.simple, x: -10, z: 12 }]);
    assert.deepEqual(frame(ctx, { ...none, selectedUnits: [heavy] }), [{ r: R.advanced, x: 40, z: 12 }]);
    // Not an army, and not a unit that merely is followed without being picked.
    assert.deepEqual(frame(ctx, { ...none, selectedUnits: [simple, heavy] }), []);
    assert.deepEqual(frame(ctx, { ...none, game: { _camFollow: { kind: 'units', units: [Object.assign({}, simple, { selected: false })] } } }), []);
    assert.deepEqual(frame(ctx, { ...none, selectedUnits: [treb('archer', 12, 3)] }), [], 'an archer gets none');
    assert.deepEqual(frame(ctx, { ...none, selectedUnits: [Object.assign({}, simple, { health: 0 })] }), []);
});

