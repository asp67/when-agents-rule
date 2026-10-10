// The whole-map view of a late game (b1082): resource nodes drawn in chunks, a unit seen
// from far away drawn as one still mesh per material, and the draw loop setting only what
// changed. With most of the large map explored, 416 units and 76 buildings, a frame was
// 17,500 draw calls -- 8,000 of them trees, 7,300 unit bone-groups.
const test = require('node:test'), assert = require('node:assert/strict');
const vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
const src = f => fs.readFileSync(path.join(__dirname, '../js/engine/' + f + '.js'), 'utf8');

function load() {
    const scope = { window: {}, console }; scope.window.window = scope.window; vm.createContext(scope);
    for (const f of ['math3d', 'mesh', 'texgen', 'buildings', 'units']) vm.runInContext(src(f), scope);
    // A buffer is its own data, so writes into it can be read back.
    scope.window.GLCore = { createMeshBuffers: (gl, mesh) => ({ mesh, position: { data: Float32Array.from(mesh.positions) } }) };
    vm.runInContext('Object.assign(globalThis, window);' + src('gamerenderer'), scope);
    return { scope, R: vm.runInContext('window.EngineRenderer', scope), W: scope.window };
}

function fakeGl(log) {
    let cur = null;
    return {
        ARRAY_BUFFER: 1, TEXTURE_2D: 2, RGBA: 3, UNSIGNED_BYTE: 4, TEXTURE_MIN_FILTER: 5, TEXTURE_MAG_FILTER: 6,
        NEAREST: 7, TEXTURE_WRAP_S: 8, TEXTURE_WRAP_T: 9, CLAMP_TO_EDGE: 10,
        bindBuffer: (t, b) => { cur = b; },
        bufferSubData: (t, off, d) => { cur.data.set(d, off / 4); log.push({ off, n: d.length }); },
        deleteBuffer: () => {}, createTexture: () => ({}), bindTexture: () => {}, texImage2D: () => {}, texParameteri: () => {},
    };
}

test('mergeMeshes bakes exactly what mergeParts bakes', () => {
    const { W } = load();
    const M = W.M3D;
    const parts = [
        { kind: 'cylinder', args: [0.24, 0.4, 2.4, 7], m: M.multiply(M.translation(3, 1, -2), M.scaling(1.2, 0.8, 1.5)) },
        { kind: 'sphere', args: [1, 9, 6], m: M.multiply(M.rotationY(0.7), M.scaling(2, 1, 1)) },
    ];
    const a = W.EngineMesh.mergeParts(parts);
    const b = W.EngineMesh.mergeMeshes(parts.map(p => ({ mesh: W.EngineMesh[p.kind](...p.args), m: p.m })));
    for (const k of ['positions', 'normals', 'uvs', 'indices']) {
        assert.equal(b[k].length, a[k].length, k);
        for (let i = 0; i < a[k].length; i++) assert.ok(Math.abs(a[k][i] - b[k][i]) < 1e-4, `${k}[${i}] ${a[k][i]} vs ${b[k][i]}`);
    }
});

test('a forest is a few draws, and a felled or fogged tree collapses in place', () => {
    const { R, scope } = load();
    const log = [];
    const r = Object.create(R.prototype);
    Object.assign(r, { gl: fakeGl(log), _resEntries: new WeakMap(), _theme: 'summer', _geo: new Map(), _cull: () => false });
    r._buf = (kind, args) => ({ kind, args });
    r.tex = new Proxy({}, { get: (o, k) => (o[k] = o[k] || { name: k }) });
    const node = (x, z, type = 'wood') => ({ type, x, z, amount: 100, mesh: type === 'wood' ? { trunk: { visible: false }, leaves: { visible: false } } : { visible: false } });
    const rs = [];
    for (let i = 0; i < 40; i++) rs.push(node(5 + (i % 8) * 4, 5 + Math.floor(i / 8) * 4));
    rs.push(node(20, 20, 'gold'));
    r.terrain = { resources: rs };
    const frame = () => { const dl = { opaque: [], blended: [] }; r._pushResourceChunks(dl); return dl; };

    assert.equal(frame().opaque.length, 0, 'under fog: nothing drawn');
    assert.ok(r._resChunks.list.every(c => !c.groups), 'and nothing built');

    const show = res => { if (res.mesh.trunk) res.mesh.trunk.visible = res.mesh.leaves.visible = true; else res.mesh.visible = true; };
    rs.slice(0, 30).forEach(show);
    let dl = frame();
    assert.ok(dl.opaque.length <= 4, `${dl.opaque.length} opaque draws for 30 trees`);   // bark, crown (and the gold, unseen)
    assert.ok(dl.blended.length <= 1, 'their shadows in one');
    const chunk = r._resChunks.list[0];
    const shown = chunk.members.filter(m => m.shown).length;
    assert.equal(shown, 30, 'the ten still fogged are collapsed');
    const zeroWrites = log.length;
    assert.ok(zeroWrites > 0);

    // A woodcutter fells one: its ranges are written as a point, nothing is rebuilt.
    const groups = chunk.groups;
    log.length = 0;
    rs[3].amount = 0; rs[3].mesh = null;
    dl = frame();
    assert.equal(chunk.groups, groups, 'not rebuilt');
    const mb = chunk.members.find(m => m.i === 3);
    assert.equal(log.length, mb.ranges.length, 'one write per material it had');
    for (const rg of mb.ranges) {
        const d = rg.g.buf.position.data.subarray(rg.start * 3, (rg.start + rg.count) * 3);
        assert.ok(d.every(v => v === 0), 'collapsed to a point');
    }
    // Its neighbour is untouched, and a fogged tree that is found comes back as it was.
    const back = chunk.members.find(m => m.i === 35);
    rs.slice(30).forEach(show);
    frame();
    for (const rg of back.ranges) {
        const d = rg.g.buf.position.data.subarray(rg.start * 3, (rg.start + rg.count) * 3);
        assert.deepEqual([...d], [...rg.g.pos.subarray(rg.start * 3, (rg.start + rg.count) * 3)], 'restored');
    }
    // A theme change re-dresses every node, so the chunks are built again.
    r._resEntries = new WeakMap();
    frame();
    assert.notEqual(r._resChunks.list[0].groups, groups);
});

test('a unit seen from far away is one still mesh per material, with every vertex', () => {
    const { R, W } = load();
    const r = Object.create(R.prototype);
    Object.assign(r, { gl: fakeGl([]) });
    r.tex = new Proxy({}, { get: (o, k) => (o[k] = o[k] || { name: k, _avg: [120, 90, 60] }) });
    const batches = W.EngineUnits.batches(W.EngineUnits.parts('infantry', { civ: 'greek', unit: 'hoplite', badge: null, variant: 0, coat: 0 }));
    r._unitModels = new Map([['k', batches.map(p => ({ mesh: p.mesh, texName: p.tex, team: p.team, accent: p.accent, bone: p.bone, blend: p.blend, badgePaint: p.badgePaint }))]]);
    const far = r._unitFarModel('k', 'infantry');
    assert.ok(batches.length >= 8, `${batches.length} near`);
    assert.ok(far.length <= 5, `${far.length} far: ${far.map(f => f.palette ? 'palette' : f.texName)}`);
    const verts = list => list.reduce((n, p) => n + (p.mesh || p.buf.mesh).positions.length, 0);
    assert.equal(verts(far), verts(batches), 'nothing dropped');
    const pal = far.find(f => f.palette);
    assert.ok(pal, 'the plain parts share the palette');
    assert.ok(!far.some(f => f.palette && (f.team || f.blend)), 'the seat colour and the shadow keep their own');
    assert.equal(r._unitFarModel('k', 'infantry'), far, 'built once per model');
});
