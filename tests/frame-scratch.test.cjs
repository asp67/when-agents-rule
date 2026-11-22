// The draw-call diet (overhaul step A4), seventh step: a frame's matrices come from a row
// that is used again from the start the next frame. What goes into the draw lists and is
// gone after the draw is scratch; what is kept -- where a unit stands, which its ghost
// falls from -- has storage of its own.
const test = require('node:test'), assert = require('node:assert/strict');
const vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
const src = f => fs.readFileSync(path.join(__dirname, '../js/engine/' + f + '.js'), 'utf8');

function load() {
    const scope = { window: {}, console, performance: { now: () => 1000 } }; scope.window.window = scope.window; vm.createContext(scope);
    for (const f of ['math3d', 'mesh', 'texgen', 'buildings', 'units', 'atmosphere']) vm.runInContext(src(f), scope);
    scope.window.GLCore = { createMeshBuffers: (gl, mesh) => ({ mesh }), createShadowBuffers: (gl, mesh) => ({ mesh, shadowOnly: true }), drawMesh() {} };
    vm.runInContext('Object.assign(globalThis, window);' + src('gamerenderer'), scope);
    return { W: scope.window, R: vm.runInContext('window.EngineRenderer', scope) };
}
// A scratch matrix is a window on a block; one made by the plain makers has its buffer to itself.
const isScratch = m => m.byteLength !== m.buffer.byteLength;

test('scratch makers give what the plain makers give, bit for bit', () => {
    const { W } = load(), m3 = W.M3D, s = m3.scratch();
    const same = (a, b, what) => assert.deepEqual(Array.from(a), Array.from(b), what);
    same(s.translation(1.5, -2, 3.25), m3.translation(1.5, -2, 3.25), 'translation');
    same(s.scaling(2, 0.3, -4), m3.scaling(2, 0.3, -4), 'scaling');
    for (const k of ['rotationX', 'rotationY', 'rotationZ']) same(s[k](0.731), m3[k](0.731), k);
    const a = m3.multiply(m3.translation(3, 1, -2), m3.rotationY(0.4)), b = m3.multiply(m3.rotationX(1.1), m3.scaling(1, 2, 3));
    same(s.multiply(a, b), m3.multiply(a, b), 'multiply');
    same(s.rotateAround(m3.rotationX(0.6), 0.2, 1.1, -0.3), m3.rotateAround(m3.rotationX(0.6), 0.2, 1.1, -0.3), 'rotateAround');
    const own = new Float32Array(16).fill(7);
    assert.equal(m3.multiplyInto(own, a, b), own, 'multiplyInto hands back the matrix it was given');
    same(own, m3.multiply(a, b), 'multiplyInto');
    // A matrix taken again holds what the frame before left in it: every maker writes all sixteen.
    s.reset();
    for (let i = 0; i < 12; i++) s.scaling(9, 9, 9).fill(NaN);
    s.reset();
    same(s.translation(1, 2, 3), m3.translation(1, 2, 3));
    same(s.rotationY(0.5), m3.rotationY(0.5));
    same(s.multiply(a, b), m3.multiply(a, b));
});

test('the row is used again from the start, grows to the busiest frame and then stands', () => {
    const { W } = load(), s = W.M3D.scratch(4, 2);     // blocks of four, two at most
    const first = [s.translation(0, 0, 0), s.scaling(1, 1, 1), s.rotationY(0)];
    assert.deepEqual([s.used, s.size, s.spilled], [3, 4, 0]);
    assert.ok(first.every(isScratch) && new Set(first).size === 3);
    s.reset();
    assert.deepEqual([s.used, s.peak], [0, 3]);
    assert.equal(s.translation(1, 1, 1), first[0], 'the same matrix as last frame, not a new one');
    assert.equal(s.scaling(2, 2, 2), first[1], 'and the one after it');
    s.reset();
    for (let i = 0; i < 8; i++) s.scaling(i, i, i);
    assert.deepEqual([s.used, s.size, s.spilled], [8, 8, 0], 'a second block when the first is full');
    // Past the limit a frame still gets its matrices: fresh ones, counted.
    const over = s.scaling(1, 2, 3);
    assert.ok(!isScratch(over));
    assert.deepEqual([s.used, s.size, s.spilled, Array.from(over).slice(0, 6)], [8, 8, 1, [1, 0, 0, 0, 0, 2]]);
    s.reset();
    assert.equal(s.peak, 8);
});

test('a frame: scratch in the draw lists, a unit\'s own matrix on the unit', () => {
    const { W, R } = load(), m3 = W.M3D;
    const r = Object.create(R.prototype);
    const unit = (x, z, type = 'worker') => ({ x, z, health: 3, maxHealth: 5, type, selected: true, mesh: { visible: true },
        _engine: { type: 'worker', phase: 0.3, entries: [{ buf: { id: 'body' }, tex: { name: 'skin' }, tint: [1, 1, 1], base: m3.translation(0, 1, 0) }] } });
    const a = unit(10, 20), b = unit(14, 20);
    Object.assign(r, { gl: {}, units: [a, b], buildings: [], graphicsQuality: 'cinematic', visualStyle: 'cinematic', WHITE: [1, 1, 1], tex: new Proxy({}, { get: (o, k) => (o[k] = o[k] || { name: k }) }),
        _unitDir: new WeakMap(), _unitPrev: new WeakMap(), _ghosts: [], _dustPool: [], _projectiles: [], _rubble: [], _rings: [], cameraTarget: { x: 10, z: 20 }, _theme: 'summer',
        _buf: (kind, args) => ({ kind, args }), _cull: () => false, _refreshIdentity() {}, _frameNo: 0, _dl: { opaque: [], blended: [], bars: [], casters: [] }, _halfH: 20,
        game: { _environmentSeconds: W.EngineAtmosphere.previewTime('summer', 'night') } });
    const poses = [];
    const pose = W.EngineUnits.pose; W.EngineUnits.pose = (...args) => { const p = pose(...args); poses.push({ m3: args[4].m3, mats: Object.values(p.mats) }); return p; };
    const frame = () => { if (r._fm) r._fm.reset(); r._assembleFrame(3, 0.016, m3.identity()); return r._dl; };
    const dl = frame();
    // Where the unit stands: storage of its own, and the batch points at a matrix the entry keeps.
    const ea = a._engine, body = ea.entries[0];
    assert.ok(ea.mWorld.length === 16 && ea.mFlat.length === 16 && !isScratch(ea.mWorld) && !isScratch(ea.mFlat));   // (another realm's Float32Array)
    assert.ok(!isScratch(body.model) && body.model === body.mOwn);
    assert.deepEqual(Array.from(body.model).slice(12, 15).map(v => +v.toFixed(3)), [10, +(1 + ea.mWorld[13]).toFixed(3), 20]);
    assert.notEqual(ea.mWorld, b._engine.mWorld);
    const drawn = dl.opaque.find(e => e.buf === body.buf);
    assert.equal(drawn.model, body.model);
    // What only this frame needs is scratch: health bars, rings, the lantern's glow, the pose.
    assert.ok(dl.bars.length >= 4 && dl.bars.every(e => isScratch(e.model)), 'health bars');
    const rings = dl.blended.filter(e => e.additive || e.tex.name === 'ring');
    assert.ok(rings.length >= 4 && rings.every(e => isScratch(e.model)), 'selection rings and glows');
    assert.ok(poses.length === 2 && poses.every(p => p.m3 === r._fm && p.mats.length >= 2 && p.mats.every(isScratch)), 'a pose is made of scratch');
    assert.ok(r._fm.used > 20 && r._fm.spilled === 0);
    // The next frame: the same row again, the unit's matrix still its own and moved with it.
    const used = r._fm.used, bar0 = dl.bars[0].model, world = ea.mWorld, own = body.mOwn;
    a.x = 11;
    const dl2 = frame();
    assert.equal(r._fm.used, used, 'as many as the frame before');
    assert.equal(r._fm.size, 1024, 'and no more of them made');
    assert.equal(dl2.bars[0].model, bar0, 'the very matrix of the frame before');
    assert.ok(ea.mWorld === world && body.mOwn === own && body.model[12] === 11);
    // A fallen unit's ghost holds the unit's own matrix, which no later frame writes to.
    r._ghostFrom(a, 'unit');
    r.units = [b];
    const kept = Array.from(r._ghosts[0].entries[0].model);
    frame(); frame();
    assert.equal(r._ghosts[0].entries[0].model, own);
    assert.deepEqual(Array.from(own), kept);
    const falling = r._dl.blended.find(e => e.buf === body.buf);
    assert.ok(falling && isScratch(falling.model) && falling.model !== own, 'its fall is this frame\'s');
});

test('what outlives the frame is not made of scratch', () => {
    const s = src('gamerenderer');
    const body = s.slice(s.indexOf('        _assembleFrame(tSec, dt, bb) {'), s.indexOf('        renderFrame() {'));
    assert.match(body, /const fm = this\._fm \|\| \(this\._fm = m3\.scratch\(\)\);/);
    // A flag, a rising shell and the damage rings are held past the frame (a ghost, a list).
    assert.match(body, /const flag=m3\.multiply\(eb\.flagAnchor,m3\.rotationY\(angle\)\);/);
    assert.match(body, /p\.entry\.model=m3\.multiply\(flag,p\.local\)/);
    assert.match(body, /eb\.shell\.model = m3\.multiply\(eb\.world,\s+m3\.multiply\(m3\.translation/);
    assert.match(body, /this\._ringEntries\.push\(\{[^\n]+\n\s+model: m3\.multiply\(m3\.translation/);
    assert.match(body, /EngineFx\.rubble\(r, ambientTime, \{ m3, bb/);
    // Nothing is assigned a scratch matrix: scratch only ever goes into a list being pushed or a local.
    for (const line of body.split('\n')) {
        if (!/\bfm\./.test(line)) continue;
        assert.doesNotMatch(line, /(this\.|\b[a-z]{1,3}\.)[A-Za-z_.]+\s*=\s*fm\./, line.trim());
        assert.doesNotMatch(line, /this\._[A-Za-z]+\.push\(/, line.trim());
    }
    // One row for the frame: the second picture and the main one both take from it.
    assert.match(s, /renderFrame\(\) \{\s+const now = performance\.now\(\);\s+if \(this\._fm\) this\._fm\.reset\(\);/);
    assert.equal((s.match(/_fm\.reset\(\)/g) || []).length, 1);
    // Anyone who keeps a pose gets matrices of its own.
    assert.match(src('units'), /const m3 = opts\.m3 \|\| M\(\);/);
    assert.match(s, /const rest = \{ \.\.\.EngineUnits\.pose\(engineType, 'idle', 0, 0, \{ strike: null, stride: 0 \}\)\.mats \};/);
});
