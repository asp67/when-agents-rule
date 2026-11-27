// The whole-map view of a late game (b1082): resource nodes drawn in chunks, a unit seen
// from far away drawn as one still mesh per material, and the draw loop setting only what
// changed. With most of the large map explored, 416 units and 76 buildings, a frame was
// 17,500 draw calls -- 8,000 of them trees, 7,300 unit bone-groups.
const test = require('node:test'), assert = require('node:assert/strict');
const vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
const src = f => fs.readFileSync(path.join(__dirname, '../js/engine/' + f + '.js'), 'utf8');

function load() {
    const scope = { window: {}, console }; scope.window.window = scope.window; vm.createContext(scope);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/simulation/island.js'), 'utf8'), scope);   // the island the painters read (build 1188)
    for (const f of ['math3d', 'mesh', 'texgen', 'buildings', 'units']) vm.runInContext(src(f), scope);
    // A buffer is its own data, so writes into it can be read back.
    // The engine's own mesh helpers, with only the upload stood in for.
    vm.runInContext(src('glcore'), scope);
    scope.window.GLCore.createMeshBuffers = (gl, mesh) => ({ mesh, position: { data: Float32Array.from(mesh.positions) } });
    scope.window.GLCore.createShadowBuffers = (gl, mesh) => ({ mesh, shadowOnly: true, position: { data: Float32Array.from(mesh.positions) } });
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
    // bark, the crowns, the cypresses' darker green (build 1196: three kinds a land), and the gold, unseen
    assert.ok(dl.opaque.length <= 4, `${dl.opaque.length} opaque draws for 30 trees`);
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

// Ghost nodes (build 1311), in the model's view only. asp67, 27 November 2026: "there is visual
// nodes and last known state nodes. Since an opponent might have emptied that node inbetween when
// the seat saw it last and now, it stands to reason to draw them as ghosts".
test('in the model\'s view a node out of the seat\'s sight is a ghost: translucent, shadowless, as the seat last saw it', () => {
    const { R, W } = load();
    const log = [], deleted = [];
    const gl = Object.assign(fakeGl(log), { DYNAMIC_DRAW: 11, createBuffer: () => ({ data: null }), deleteBuffer: b => deleted.push(b) });
    let bound = null;
    gl.bindBuffer = (t, b) => { bound = b; };
    gl.bufferData = (t, d) => { bound.data = Float32Array.from(d); };
    gl.bufferSubData = (t, off, d) => { bound.data.set(d, off / 4); log.push({ off, n: d.length }); };
    // A mesh on the card with all its parts, so that sharing them can be told from copying them.
    W.GLCore.createMeshBuffers = (g, mesh) => ({ mesh, position: { data: Float32Array.from(mesh.positions) }, normal: {}, uv: {}, index: {}, count: mesh.indices.length });
    const r = Object.create(R.prototype);
    Object.assign(r, { gl, _resEntries: new WeakMap(), _theme: 'summer', _geo: new Map(), _cull: () => false });
    r._buf = (kind, args) => ({ kind, args });
    r.tex = new Proxy({}, { get: (o, k) => (o[k] = o[k] || { name: k }) });
    // Twenty trees and a gold site in one chunk. Every flag is down: the spectator's fog has opened nothing.
    const rs = [];
    for (let i = 0; i < 20; i++) rs.push({ type: 'wood', x: 5 + (i % 5) * 4, z: 5 + Math.floor(i / 5) * 4, amount: 100, mesh: { trunk: { visible: false }, leaves: { visible: false } } });
    rs.push({ type: 'gold', x: 30, z: 30, amount: 800, health: 800, mesh: { visible: false } });
    const GOLD = 20;
    r.terrain = { resources: rs };
    const known = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, GOLD]), inSight = new Set([0, 1, 2, 3, 4]), believed = {};
    const viewOn = () => { r.nodeHidden = (res, i) => !known.has(i); r.nodeMemory = (res, i) => inSight.has(i) ? null : (believed[i] != null ? believed[i] : res.amount); };
    const frame = () => { const dl = { opaque: [], blended: [], casters: [] }; r._pushResourceChunks(dl); return dl; };
    const chunk = () => r._resChunks.list[0], member = i => chunk().members.find(m => m.i === i);
    const at = (buf, rg) => buf.position.data.subarray(rg.start * 3, (rg.start + rg.count) * 3);
    const where = i => {
        const mb = member(i), drawn = d => d.some(v => v !== 0);
        const solid = mb.ranges.some(rg => drawn(at(rg.g.buf, rg))), ghost = mb.ranges.some(rg => rg.g.ghostBuf && drawn(at(rg.g.ghostBuf, rg)));
        return solid && ghost ? 'both' : solid ? 'solid' : ghost ? 'ghost' : 'none';
    };

    // No view: the flags decide, nothing is drawn, and no second set of corners is made.
    assert.deepEqual([frame().opaque.length, r._resChunks.list.every(c => !c.groups)], [0, true]);

    viewOn();
    let dl = frame();
    // The five in sight are solid, the six known but out of sight are ghosts, the ten never found are not there.
    assert.deepEqual([0, 4, 5, 9, GOLD, 10, 19].map(where), ['solid', 'solid', 'ghost', 'ghost', 'ghost', 'none', 'none']);
    assert.deepEqual([chunk().shown, chunk().members.filter(m => m.ghost).length], [11, 6]);
    // A ghost is drawn in the blended pass at NODE_GHOST, from a second set of corners that shares
    // the rest of the mesh; the solid ones stay where they were, and only they cast a shadow.
    assert.equal(R.NODE_GHOST, 0.8);
    const ghosts = dl.blended.filter(e => e.buf.twin);
    assert.ok(ghosts.length >= 2 && ghosts.every(e => e.alpha === 0.8), `${ghosts.length} ghost draws`);
    assert.ok(dl.opaque.length >= 1 && dl.opaque.every(e => !e.buf.twin && e.alpha == null));
    assert.equal(dl.casters.length, 1);
    const caster = chunk().groups.find(g => g.caster);
    assert.equal(caster.ghostBuf, undefined, 'a shadow has no ghost');
    for (const rg of member(5).ranges.filter(x => x.g === caster)) assert.ok(at(caster.buf, rg).every(v => v === 0), 'a ghost casts nothing');
    for (const g of chunk().groups.filter(x => !x.caster)) {
        assert.ok(g.ghostBuf.twin && g.ghostBuf.position !== g.buf.position, 'its own corners');
        assert.deepEqual([g.ghostBuf.index === g.buf.index, g.ghostBuf.normal === g.buf.normal, g.ghostBuf.uv === g.buf.uv, g.ghostBuf.count], [true, true, true, g.buf.count]);
    }
    // A frame in which nothing changed writes nothing.
    log.length = 0; frame();
    assert.equal(log.length, 0);

    // A rival fells a tree the seat remembers: the ghost stands on. One it can see is gone at once.
    believed[7] = 100; believed[9] = 100;
    rs[7].amount = 0; rs[7].mesh = null;
    rs[2].amount = 0; rs[2].mesh = null;
    frame();
    assert.deepEqual([where(7), where(2), member(7).ghost], ['ghost', 'none', true]);
    // What it last saw of the gold was a quarter of it: the ghost is that size, the site itself untouched.
    believed[GOLD] = 200;
    frame();
    assert.deepEqual([where(GOLD), member(GOLD).scale, rs[GOLD].amount], ['ghost', 0.72, 800]);
    // It walks back: the gold is drawn as it is, the felled tree's place is seen empty.
    inSight.add(GOLD); inSight.add(7);
    frame();
    assert.deepEqual([where(GOLD), member(GOLD).scale, where(7)], ['solid', 1, 'none']);
    // The seat's own harvest emptied a node it remembers: it believes nothing is left, nothing is drawn.
    believed[8] = 0;
    frame();
    assert.equal(where(8), 'none');

    // The chunk is built again (a theme change): a felled tree the seat still believes in is in it.
    inSight.delete(7);
    rs[9].amount = 0; rs[9].mesh = null;
    frame();
    assert.equal(where(9), 'ghost');
    r._resEntries = new WeakMap();
    frame();
    assert.deepEqual([where(9), where(5), where(0)], ['ghost', 'ghost', 'solid']);

    // A chunk with nothing in sight: ghosts only, no solid draw and no shadow.
    inSight.clear();
    dl = frame();
    assert.deepEqual([dl.opaque.length, dl.casters.length, dl.blended.length > 0 && dl.blended.every(e => e.buf.twin)], [0, 0, true]);

    // View off: the flags decide again and nothing is a ghost.
    r.nodeHidden = null; r.nodeMemory = null;
    rs.forEach(n => { if (!n.mesh) return; if (n.mesh.trunk) n.mesh.trunk.visible = n.mesh.leaves.visible = true; else n.mesh.visible = true; });
    dl = frame();
    assert.deepEqual([dl.blended.some(e => e.buf.twin), chunk().members.some(m => m.ghost), where(5), where(15), where(9)], [false, false, 'solid', 'solid', 'none']);

    // Giving the chunks back gives back the second corners, and only those: the rest belongs to the mesh.
    const g0 = chunk().groups.find(g => !g.caster), twinPos = g0.ghostBuf.position, shared = g0.buf.index;
    deleted.length = 0;
    W.GLCore.deleteMeshBuffers(gl, g0.ghostBuf);
    assert.deepEqual([deleted.includes(twinPos), deleted.includes(shared), deleted.length], [true, false, 1]);
});

test('a unit seen from far away is one still mesh per material, with every vertex', () => {
    const { R, W } = load();
    const r = Object.create(R.prototype);
    Object.assign(r, { gl: fakeGl([]) });
    r.tex = new Proxy({}, { get: (o, k) => (o[k] = o[k] || { name: k, _avg: [120, 90, 60] }) });
    const batches = W.EngineUnits.batches(W.EngineUnits.parts('infantry', { civ: 'greek', unit: 'hoplite', badge: null, variant: 0, coat: 0 }));
    // A unit model keeps its parts batched per bone in memory for this (build 1182): what is drawn near is skinned.
    r._unitModels = new Map([['k', { cpu: batches.map(p => ({ mesh: p.mesh, texName: p.tex, team: p.team, accent: p.accent, bone: p.bone, blend: p.blend, badgePaint: p.badgePaint })) }]]);
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
