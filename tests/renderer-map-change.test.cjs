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

