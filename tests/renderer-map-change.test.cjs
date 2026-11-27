// What a new map costs the renderer and what it leaves behind (builds 1295, 1296): the
// textures and the shore's foam of the map before go back to the graphics card, and the
// ground scatter is sown over the whole of a map of any size.
const test = require('node:test'), assert = require('node:assert/strict');
const vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

// The renderer over the real island and painters' numbers, the card stood in for.
function load() {
    const scope = { window: {}, console, performance: { now: () => 1000 } }; scope.window.window = scope.window; vm.createContext(scope);
    for (const f of ['js/simulation/rng.js', 'js/simulation/math.js', 'js/simulation/island.js']) vm.runInContext(read(f), scope);
    for (const f of ['math3d', 'mesh', 'texgen', 'buildings', 'units', 'atmosphere']) vm.runInContext(read('js/engine/' + f + '.js'), scope);
    const freed = [];
    let made = 0;
    scope.window.GLCore = { createMeshBuffers: (gl, mesh) => ({ id: ++made, mesh }), createShadowBuffers: (gl, mesh) => ({ id: ++made, mesh, shadowOnly: true }),
        deleteMeshBuffers: (gl, buf) => { if (buf) freed.push(buf); }, drawMesh() {}, createTextureFromCanvas: (gl, canvas) => ({ tex: ++made, of: canvas }) };
    vm.runInContext('Object.assign(globalThis, window);' + read('js/engine/gamerenderer.js'), scope);
    return { W: scope.window, R: vm.runInContext('window.EngineRenderer', scope), I: vm.runInContext('WarIsland', scope), T: scope.window.TexGen, freed, scope };
}
const terrain = (seed, difficulty = 'easy') => ({ seed, difficulty, size: 800, resources: [...Array(60)].map((_, i) => ({ type: i % 5 ? 'wood' : 'stone', amount: 100, x: -300 + (i % 10) * 60, z: -250 + Math.floor(i / 10) * 90 })) });

test('another theme or map size gives the old textures back, and the same one builds nothing', () => {
    const { R, T, I } = load();
    I.setMapSize(800);
    // The painters draw on canvases a test has none of: each hands back a named stand-in.
    for (const k of Object.keys(T)) if (typeof T[k] === 'function' && !/^(rng|coastSampler|coastNoise|setMapSize|grassCoverSampler|noise)/.test(k)) T[k] = (...a) => ({ painter: k });
    R._averageColor = () => [128, 128, 128];
    const deleted = [];
    const r = Object.assign(Object.create(R.prototype), { gl: { deleteTexture: t => deleted.push(t) } });
    r._buildTextures('summer');
    const first = Object.values(r.tex);
    assert.ok(first.length >= 30, first.length + ' textures a theme');
    assert.equal(new Set(first).size, first.length);
    assert.equal(deleted.length, 0, 'nothing to give back the first time');
    r._buildTextures('summer');
    assert.deepEqual(Object.values(r.tex), first, 'the same theme on the same map is the same set');
    assert.equal(deleted.length, 0);
    r._buildTextures('winter');
    const second = Object.values(r.tex);
    assert.deepEqual(new Set(deleted), new Set(first), 'every texture of the old set, once');
    assert.equal(deleted.length, first.length);
    assert.ok(second.every(t => !deleted.includes(t)), 'and none of the new');
    I.setMapSize(1200);                                    // the ground texture is the map's size
    r._buildTextures('winter');
    assert.equal(deleted.length, first.length + second.length);
    assert.ok(Object.values(r.tex).every(t => !deleted.includes(t)));
});

test('the ground scatter is sown over a map of any size, as dense on each, and on the 800 map as it was', () => {
    const { R, I } = load();
    const at800 = R.scatterReach(800), at1200 = R.scatterReach(1200);
    assert.equal(at800.half, 340);
    for (const n of [0, 1, 90, 100, 150, 180, 220, 260]) assert.equal(at800.many(n), n, 'every count of the 800 map is its own');
    assert.equal(at1200.half, 540);
    assert.equal(at1200.many(100), Math.round(100 * (540 * 540) / (340 * 340)), 'as many per area');
    assert.equal(R.scatterReach(0).half, 340, 'no size given is the 800 map');

    const r = Object.assign(Object.create(R.prototype), { WHITE: [1, 1, 1], _theme: 'summer', _resEntries: new WeakMap(), _cull: () => false,
        _buf: (kind, args) => ({ kind, args }), tex: new Proxy({}, { get: (o, k) => (o[k] = o[k] || { name: k }) }), fogView: null, game: null });
    const reach = list => Math.max(...list.map(p => Math.max(Math.abs(p.x), Math.abs(p.z))));
    I.setMapSize(800);
    const small = r._groundScatter(terrain('a'), 'summer', 777);
    assert.ok(reach(small) <= 340);
    I.setMapSize(1200);
    const large = r._groundScatter(terrain('a'), 'summer', 777);
    assert.ok(reach(large) > 400 && reach(large) <= 540, 'out to ' + reach(large).toFixed(0) + ' of 540');
    assert.ok(large.length > small.length * 1.8, large.length + ' members on the 1200 map, ' + small.length + ' on the 800');
    // Not crowded into the middle: about as many per area inside the old reach as on the 800 map.
    const inner = large.filter(p => Math.abs(p.x) <= 340 && Math.abs(p.z) <= 340).length;
    assert.ok(inner > small.length * 0.6 && inner < small.length * 1.5, inner + ' of them inside the old reach, ' + small.length + ' there on the 800 map');
    I.setMapSize(800);
});

test('a new map gives the last one\'s shore foam back, and sows its own scatter to its own edge', () => {
    const { R, I, freed } = load();
    const r = Object.assign(Object.create(R.prototype), { gl: {}, WHITE: [1, 1, 1], _resEntries: new WeakMap(), _cull: () => false, _geo: new Map(),
        _buildTextures(theme) { this._theme = theme; }, tex: new Proxy({}, { get: (o, k) => (o[k] = o[k] || { name: k }) }), fogView: null, game: null,
        units: [], buildings: [], _projectiles: [], _rings: [], _ghosts: [] });
    I.setMapSize(800);
    r.setTerrain(terrain('a'));
    const foam = r._foam.map(f => f.buf);
    assert.equal(foam.length, 1);
    assert.ok(!freed.includes(foam[0]));
    // The bushes of the scatter (the reeds and rocks of the shore are sown by the coast itself).
    const bushes = () => r._props.filter(p => p.kind === 'sphere' && p.texName === 'worldFoliage');
    const reach = () => Math.max(...bushes().map(p => Math.max(Math.abs(p.x), Math.abs(p.z))));
    assert.ok(reach() <= 345, 'on the 800 map the bushes stay inside 340: ' + reach().toFixed(0));
    const n800 = bushes().length;
    assert.ok(n800 >= 260 && n800 <= 520, n800 + ' bushes on the 800 map, as ever');
    I.setMapSize(1200);
    r.setTerrain(Object.assign(terrain('b'), { size: 1200 }));
    assert.ok(freed.includes(foam[0]), 'the foam of the map before is freed');
    assert.ok(!freed.includes(r._foam[0].buf), 'the new map\'s is not');
    assert.ok(reach() > 450 && reach() <= 545, 'the 1200 map is sown to ' + reach().toFixed(0) + ' of 540');
    assert.ok(bushes().length > n800 * 2 && bushes().length < n800 * 3, bushes().length + ' bushes, ' + n800 + ' on the 800 map');
    I.setMapSize(800);
});
