// Overhaul step A5, third slice (build 1198): rocks along the shore and headlands of crags
// at the waterline. Scenery only: every rock stands beyond the line a unit can walk to and
// beyond the map's square, and no rule file knows about them.
const test = require('node:test'), assert = require('node:assert/strict');
const vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

function load() {
    const scope = { window: {}, console, performance: { now: () => 1000 } }; scope.window.window = scope.window; vm.createContext(scope);
    for (const f of ['js/simulation/rng.js', 'js/simulation/math.js', 'js/simulation/island.js']) vm.runInContext(read(f), scope);
    for (const f of ['math3d', 'mesh', 'texgen', 'buildings', 'units', 'atmosphere']) vm.runInContext(read('js/engine/' + f + '.js'), scope);
    scope.window.GLCore = { createMeshBuffers: (gl, mesh) => ({ mesh, position: { data: Float32Array.from(mesh.positions) } }),
        createShadowBuffers: (gl, mesh) => ({ mesh, shadowOnly: true, position: { data: Float32Array.from(mesh.positions) } }), deleteMeshBuffers() {}, drawMesh() {} };
    vm.runInContext('Object.assign(globalThis, window);' + read('js/engine/gamerenderer.js'), scope);
    return { W: scope.window, R: vm.runInContext('window.EngineRenderer', scope), I: vm.runInContext('WarIsland', scope), scope };
}
const renderer = R => Object.assign(Object.create(R.prototype), { WHITE: [1, 1, 1], _theme: 'summer', _resEntries: new WeakMap(), _cull: () => false,
    _buf: (kind, args) => ({ kind, args }), tex: new Proxy({}, { get: (o, k) => (o[k] = o[k] || { name: k }) }), terrain: { resources: [] }, fogView: null, game: null });

test('a rock of the shore has flat faces, sits on its cut underside, and comes in four shapes', () => {
    const { W } = load(), E = W.EngineMesh;
    const shapes = [0, 1, 2, 3].map(v => E.crag(v));
    for (const m of shapes) {
        assert.equal(E.auditWinding(m), 0);
        assert.ok(m.positions.every(Number.isFinite) && m.normals.every(Number.isFinite));
        assert.equal(m.positions.length / 3, m.indices.length, 'three corners of its own for every face');
        for (let f = 0; f < m.indices.length; f += 3) {
            const n = [0, 1, 2].map(k => Array.from(m.normals.slice((f + k) * 3, (f + k) * 3 + 3)).join());
            assert.ok(n[0] === n[1] && n[1] === n[2], 'one plane, one normal');
            assert.ok(Math.abs(Math.hypot(...m.normals.slice(f * 3, f * 3 + 3)) - 1) < 1e-9);
        }
        const ys = m.positions.filter((v, i) => i % 3 === 1);
        assert.equal(Math.min(...ys), -0.42);
        assert.ok(ys.filter(y => y === -0.42).length >= 9 && Math.max(...ys) > 0.7, 'a flat underside and a top');
        assert.ok(m.indices.length / 3 <= 56, 'a few dozen faces');
    }
    assert.notDeepEqual(shapes[0].positions, shapes[1].positions);
    assert.deepEqual(E.crag(2), E.crag(2), 'the same shape every time');
});

test('the rocks lie along the shore, beyond where a unit can walk and beyond the map, by the map\'s seed', () => {
    const { R, I, W } = load(), r = renderer(R);
    for (const size of [800, 1200]) {
        I.setMapSize(size);
        const rocks = r._coastRocks({ seed: 'golden-opening' });
        const wob = I.coastSampler(I.TERRAIN_SEED), world = I.TERRAIN_WORLD, LAND = I.TERRAIN_LAND;
        // How far out a point is, as the terrain's rules measure it: chebyshev distance plus the coast's wobble.
        const out = (x, z) => Math.max(Math.abs(x), Math.abs(z)) + wob(x / world + 0.5, z / world + 0.5);
        assert.ok(rocks.length > 400 * size / 800 && rocks.length < 900 * size / 800, size + ': ' + rocks.length + ' rocks');
        for (const k of rocks) {
            assert.deepEqual([k.kind, k.texName, k.tint === r.WHITE], ['crag', 'worldStone', true], 'one material: a chunk of shore is one draw');
            const reach = k.size / 2 * 1.24;                                 // the widest a crag gets
            assert.ok(out(k.x, k.z) - reach > LAND - 4, 'inside the walk line at ' + [k.x, k.z].map(Math.round) + ': ' + (out(k.x, k.z) - reach - LAND).toFixed(2));
            assert.ok(out(k.x, k.z) < LAND + 13, 'not out in the open sea');
            assert.ok(Math.max(Math.abs(k.x), Math.abs(k.z)) - reach > size / 2, 'beyond the map\'s square');
            assert.ok(Math.abs(k.fx) <= size / 2 - 4 && Math.abs(k.fz) <= size / 2 - 4, 'its fog is looked up inside the map');
            assert.ok(k.model[13] < k.size && Array.from(k.model).every(Number.isFinite));
        }
        // Headlands of crags, and plain rocks between them.
        const crags = rocks.filter(k => k.size >= 3).length;
        assert.ok(crags > rocks.length * 0.15 && crags < rocks.length * 0.7, size + ': ' + crags + ' crags of ' + rocks.length);
        assert.ok(rocks.some(k => k.size < 1));
        // The same map has the same rocks; another map has others; all four sides have some.
        const again = r._coastRocks({ seed: 'golden-opening' }), other = r._coastRocks({ seed: 'another' });
        assert.deepEqual(rocks.map(k => [k.x, k.z, k.size]), again.map(k => [k.x, k.z, k.size]));
        assert.notDeepEqual(rocks.slice(0, 20).map(k => k.size), other.slice(0, 20).map(k => k.size));
        for (const side of [k => k.x > size / 2, k => k.x < -size / 2, k => k.z > size / 2, k => k.z < -size / 2]) assert.ok(rocks.filter(side).length > 40);
    }
    I.setMapSize(800);
    assert.equal(r._coastRocks({}).length > 0, true, 'a map without a seed has rocks too');
});

test('drawn in chunks at every height, one draw and one shadow shape a chunk, and hidden while the map\'s edge beside them is unexplored', () => {
    const { R, I, scope } = load(), r = renderer(R);
    const writes = [];
    let cur = null;
    r.gl = { ARRAY_BUFFER: 1, bindBuffer: (t, b) => { cur = b; }, bufferSubData: (t, off, d) => { cur.data.set(d, off / 4); writes.push(cur); }, deleteTexture() {} };
    I.setMapSize(800);
    r._coast = r._coastRocks({ seed: 'golden-opening' });
    const frame = () => { const dl = { opaque: [], blended: [], casters: [] }; r._pushCoastChunks(dl); return dl; };
    const dl = frame();
    const chunks = r._coastChunkList;
    assert.ok(chunks.length >= 8 && chunks.length <= 20, chunks.length + ' chunks round the island');
    assert.equal(dl.opaque.length, chunks.length, 'one draw a chunk');
    assert.equal(dl.casters.length, chunks.length, 'and one shadow shape');
    assert.equal(chunks.reduce((n, c) => n + c.members.length, 0), r._coast.length);
    assert.ok(dl.opaque.every(e => e.tex.name === 'worldStone' && e.tint === undefined && e.noShadow === true));
    // The fog is asked about a place inside the map, never about the rock's own (it stands outside the fog's grid).
    const asked = [];
    let explored = false;
    scope.EngineGrass = { visibleRect: (fow, x, z, ex, ez, all) => { asked.push([x, z]); return explored; } };
    writes.length = 0;
    const dark = frame();
    assert.deepEqual([dark.opaque.length, dark.casters.length], [0, 0], 'unexplored: nothing of the shore is drawn');
    assert.ok(asked.length === r._coast.length && asked.every(([x, z]) => Math.abs(x) <= 396 && Math.abs(z) <= 396));
    assert.ok(writes.length >= r._coast.length * 2, 'each rock collapsed in its batch and in the caster');
    explored = true;
    assert.equal(frame().opaque.length, chunks.length, 'explored: back again');
    // Not under the scatter's height limit: a crag is as large as a house.
    const src = read('js/engine/gamerenderer.js');
    assert.match(src, /if \(this\._props && this\._halfH < 90\) this\._pushPropChunks\(dl\);\s+\/\/ The shore's rocks, at every height: a crag is as large as a house\.\s+if \(this\._coast && this\._coast\.length\) this\._pushCoastChunks\(dl\);/);
    assert.match(src, /this\._props = props;\s+this\._coast = this\._coastRocks\(terrain\);/);
    // A new map frees the old shore with the old scatter.
    let freed = 0;
    scope.window.GLCore.deleteMeshBuffers = () => { freed++; };
    vm.runInContext('GLCore.deleteMeshBuffers = window.GLCore.deleteMeshBuffers', scope);
    r._freePropChunks();
    assert.deepEqual([freed, r._coastChunkList, r._propChunkList], [chunks.length * 2, null, null]);
});
