// Overhaul step A9: a building that falls. Build 1208 threw its parts outward whole, which
// looked like a kicked-over box of wooden blocks. Since build 1210 it comes down on itself:
// its large parts are cut into chunks, the walls tip inward, the roof drops onto them and
// breaks up. (The birds of build 1208 were removed in build 1209.)
const test = require('node:test'), assert = require('node:assert/strict');
const vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

function engine() {
    const scope = { window: {}, console, performance: { now: () => 1000 } }; scope.window.window = scope.window; vm.createContext(scope);
    for (const f of ['js/simulation/rng.js', 'js/simulation/math.js', 'js/simulation/island.js']) vm.runInContext(read(f), scope);
    for (const f of ['math3d', 'mesh', 'texgen', 'buildings', 'units', 'atmosphere', 'fx']) vm.runInContext(read('js/engine/' + f + '.js'), scope);
    const made = [], freed = [];
    scope.window.GLCore = { createMeshBuffers: (gl, mesh) => { const b = { mesh, count: mesh.indices.length }; made.push(b); return b; }, createShadowBuffers: (gl, mesh) => ({ mesh }),
        deleteMeshBuffers(gl, b) { freed.push(b); }, drawMesh() {} };
    vm.runInContext('Object.assign(globalThis, window);' + read('js/engine/gamerenderer.js'), scope);
    const W = scope.window;
    return { W, R: vm.runInContext('window.EngineRenderer', scope), F: W.EngineFx, M: W.M3D, B: W.EngineBuildings, E: W.EngineMesh, made, freed, meshOf: (kind, args) => W.EngineMesh[kind](...args) };
}
const ONE = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
// How many edges of a pile of loose triangles belong to one triangle only: none, if it is closed.
const openEdges = tris => {
    const seen = new Map(), key = o => [tris[o], tris[o + 1], tris[o + 2]].map(v => (Math.round(v * 1e4) / 1e4 + 0).toFixed(4)).join(',');
    for (let t = 0; t < tris.length; t += 24) for (let k = 0; k < 3; k++) { const a = key(t + k * 8), c = key(t + ((k + 1) % 3) * 8), e = a < c ? a + '|' + c : c + '|' + a; seen.set(e, (seen.get(e) || 0) + 1); }
    return [...seen.values()].filter(n => n !== 2).length;
};
// The volume a closed pile of triangles holds (signed tetrahedra from the origin).
const volume = tris => { let v = 0; for (let t = 0; t < tris.length; t += 24) { const [ax, ay, az, bx, by, bz, cx, cy, cz] = [0, 1, 2, 8, 9, 10, 16, 17, 18].map(i => tris[t + i]); v += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6; } return v; };

test('a part is cut in two along a plane, and each half is closed again where it was cut', () => {
    const { F, E } = engine();
    const box = F.looseTriangles(E.box(2, 2, 2), ONE);
    assert.equal(box.length, 12 * 24); assert.equal(openEdges(box), 0); assert.ok(Math.abs(volume(box) - 8) < 1e-6);
    const [front, back] = F.cutTriangles(box, 1, 0.3, 0.2, 0.1);
    assert.ok(front.length && back.length && front.length % 24 === 0 && back.length % 24 === 0);
    assert.equal(openEdges(front), 0, 'the half before the plane is a solid thing'); assert.equal(openEdges(back), 0);
    assert.ok(volume(front) > 1 && volume(back) > 1 && Math.abs(volume(front) + volume(back) - 8) < 1e-5, 'nothing is lost and nothing added');
    // Every corner lies on its own side of the plane, and the closing faces look away from the half they close.
    const n = [1, 0.3, 0.2], l = Math.hypot(...n);
    for (let o = 0; o < front.length; o += 8) assert.ok(front[o] * n[0] + front[o + 1] * n[1] + front[o + 2] * n[2] >= 0.1 - 1e-4);
    for (let o = 0; o < back.length; o += 8) assert.ok(back[o] * n[0] + back[o + 1] * n[1] + back[o + 2] * n[2] <= 0.1 + 1e-4);
    const caps = tris => { let c = 0; for (let t = 0; t < tris.length; t += 24) if (Math.abs(Math.abs(tris[t + 3] * n[0] + tris[t + 4] * n[1] + tris[t + 5] * n[2]) - l) < 1e-6) c++; return c; };
    assert.ok(caps(front) >= 3 && caps(back) >= 3);
    for (let o = 0; o < front.length; o += 8) assert.ok(Math.abs(Math.hypot(front[o + 3], front[o + 4], front[o + 5]) - 1) < 1e-6, 'unit normals');
    // A plane that misses the part leaves it whole on one side.
    const [all, none] = F.cutTriangles(box, 1, 0, 0, -5);
    assert.equal(all.length, box.length); assert.equal(none.length, 0);
    // A part that was moved and stretched by its matrix: its faces keep their directions.
    const wall = F.looseTriangles(E.box(1, 1, 1), [4, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0.5, 0, 10, 1, 3, 1]);
    assert.ok(Math.abs(volume(wall) - 4) < 1e-6);
    for (let o = 0; o < wall.length; o += 8) { assert.ok(wall[o] >= 8 && wall[o] <= 12 && wall[o + 1] >= 0 && wall[o + 1] <= 2); assert.ok(Math.abs(Math.hypot(wall[o + 3], wall[o + 4], wall[o + 5]) - 1) < 1e-6); }
});

test('a large part breaks into chunks: none longer than asked, no more than allowed, no two alike', () => {
    const { F, E } = engine();
    const body = F.looseTriangles(E.box(8, 3.2, 6), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1.6, 0, 1]);
    const chunks = F.chunks(body, 1.5, 40, 7);
    assert.ok(chunks.length >= 12 && chunks.length <= 40, chunks.length + ' chunks');
    let total = 0; const sizes = new Set();
    for (const c of chunks) { assert.equal(openEdges(c), 0); const v = volume(c); assert.ok(v > 0); total += v; sizes.add(v.toFixed(3)); }
    assert.ok(Math.abs(total - 8 * 3.2 * 6) < 1e-3, 'the chunks together are the part');
    assert.ok(sizes.size > chunks.length * 0.8, 'irregular: hardly two of a size');
    // The cuts stand askew: a chunk's faces are not all square to the axes, as a brick's are.
    const askew = chunks.filter(c => { for (let o = 0; o < c.length; o += 8) { const m = Math.max(Math.abs(c[o + 3]), Math.abs(c[o + 4]), Math.abs(c[o + 5])); if (m < 0.999) return true; } return false; });
    assert.equal(askew.length, chunks.length);
    // The same seed cuts the same way; another seed another way; a small part is left whole; the limit holds.
    assert.deepEqual(F.chunks(body, 1.5, 40, 7).map(c => c.length), chunks.map(c => c.length));
    assert.notDeepEqual(F.chunks(body, 1.5, 40, 8).map(c => volume(c).toFixed(3)), chunks.map(c => volume(c).toFixed(3)));
    assert.equal(F.chunks(F.looseTriangles(E.box(1, 1, 1), ONE), 1.5, 40, 7).length, 1);
    assert.equal(F.chunks(body, 1.5, 5, 7).length, 5);
    assert.equal(F.chunks(body, 1.5, 1, 7).length, 1);
});

test('a building comes down on itself: the walls tip inward, the roof drops onto them and breaks up', () => {
    const { F, B, meshOf } = engine();
    const looks = [['barracks', 'iron', 'roman'], ['house', 'iron', 'greek'], ['tower', 'bronze', 'greek'], ['town_center', 'iron', 'greek'], ['house', 'stone', 'egyptian'], ['temple', 'iron', 'egyptian']];
    for (const [type, age, civ] of looks) {
        const name = [type, age, civ].join(' '), parts = B.parts(type, { age, civ });
        const pieces = F.collapse(parts, 4711, meshOf);
        const solid = parts.filter(p => !p.blend && p.tex !== 'shadow').length;
        assert.ok(pieces.length > solid && pieces.length <= F.BREAK_MAX_PIECES, name + ': ' + pieces.length + ' pieces of ' + solid + ' parts');
        const out = new Float32Array(16);
        for (const piece of pieces) {
            const m = piece.mesh;
            assert.ok(m.indices.length >= 3 && m.positions.length === m.indices.length * 3 && m.uvs.length === m.indices.length * 2 && m.normals.length === m.positions.length);
            assert.ok(m.positions.every(Number.isFinite) && m.normals.every(Number.isFinite) && m.uvs.every(Number.isFinite), name);
            // The moment it falls every chunk is where the building had it.
            F.collapseMatrix(piece, 0, out);
            for (let i = 0; i < 16; i++) assert.ok(Math.abs(out[i] - ONE[i]) < 1e-6, name + ': at the first moment nothing has moved');
            assert.ok(piece.delay >= 0 && piece.delay < 0.6 && piece.dur >= 0.4 && piece.dur < 1.6);
            assert.ok(piece.delay + piece.dur < F.BREAK_SECONDS - F.BREAK_FADE, name + ': everything has landed before the heap fades');
            // When it has landed: its middle at its resting height, low, and it lies still.
            const end = F.collapseMatrix(piece, F.BREAK_SECONDS, new Float32Array(16)), [cx, cy, cz] = piece.c;
            const mid = [0, 1, 2].map(k => end[k] * cx + end[4 + k] * cy + end[8 + k] * cz + end[12 + k]);
            assert.ok(Math.abs(mid[1] - piece.rest) < 1e-4 && piece.rest <= cy + 1e-9 && piece.rest < 1.5, name + ': lies low (' + piece.rest + ')');
            assert.deepEqual(Array.from(F.collapseMatrix(piece, F.BREAK_SECONDS + 1, new Float32Array(16))), Array.from(end));
            // Nothing is thrown outward: it ends no further from the middle than it stood, give or take a step.
            assert.ok(Math.hypot(mid[0], mid[2]) <= Math.hypot(cx, cz) + 0.5, name + ': falls in, not out');
        }
        const walls = pieces.filter(p => !p.high), roof = pieces.filter(p => p.high);
        // The heap is low: no chunk of wall stands out of it like a tooth, however large it was cut.
        for (const w of walls) {
            const end = F.collapseMatrix(w, F.BREAK_SECONDS, new Float32Array(16)), P = w.mesh.positions;
            let high = -9; for (let i = 0; i < P.length; i += 3) high = Math.max(high, end[1] * P[i] + end[5] * P[i + 1] + end[9] * P[i + 2] + end[13]);
            assert.ok(high < 1.75, name + ": a wall chunk ends " + high.toFixed(2) + " high");
        }
        assert.ok(walls.length >= 3, name + ': walls');
        // A wall chunk away from the middle moves toward it and tips its top toward it.
        for (const w of walls.filter(p => Math.hypot(p.c[0], p.c[2]) > 0.6)) {
            const d = Math.hypot(w.c[0], w.c[2]), ix = -w.c[0] / d, iz = -w.c[2] / d;
            assert.ok(w.mx * ix + w.mz * iz > 0, name + ': a wall chunk goes inward');
            const end = F.collapseMatrix(w, F.BREAK_SECONDS, new Float32Array(16));
            assert.ok(end[4] * ix + end[6] * iz > 0.5 && w.tip >= 1.0, name + ': what was its top now points to the middle');
        }
        // The top of a wall goes before its foot.
        const upper = walls.filter(p => p.c[1] > 1.6), lower = walls.filter(p => p.c[1] < 0.8), avg = (l, f) => l.reduce((s, p) => s + f(p), 0) / l.length;
        if (upper.length > 2 && lower.length > 2) assert.ok(avg(upper, p => p.delay) < avg(lower, p => p.delay), name + ': from the top down');
        if (type !== 'house' || age !== 'stone') {
            assert.ok(roof.length >= 4, name + ': the roof is in pieces (' + roof.length + ')');
            // It starts above the walls and ends on the heap, having broken up: its chunks do not move as one.
            assert.ok(avg(roof, p => p.c[1]) > avg(walls, p => p.c[1]));
            assert.ok(avg(roof, p => p.rest) > avg(walls, p => p.rest) + 0.3, name + ": the roof lies on top of the heap");
            assert.ok(new Set(roof.map(p => p.tip.toFixed(2) + p.delay.toFixed(2))).size > roof.length * 0.8, name + ': each chunk turns its own way');
            assert.ok(roof.every(p => p.delay >= 0.1 && p.delay < 0.4), name + ': held a moment, not long');
        }
    }
    // The same building falls the same way; another one another way.
    const parts = B.parts('barracks', { age: 'iron', civ: 'roman' });
    const a = F.collapse(parts, 4711, meshOf), b = F.collapse(parts, 4711, meshOf), c = F.collapse(parts, 99, meshOf);
    assert.deepEqual(a.map(p => [p.delay, p.tip, p.mx, p.mesh.indices.length]), b.map(p => [p.delay, p.tip, p.mx, p.mesh.indices.length]));
    assert.notDeepEqual(a.map(p => p.tip), c.map(p => p.tip));
    // The barracks' roof, one prism in the model, is many chunks now.
    const tiles = a.filter(p => p.p.kind === 'prism');
    assert.ok(tiles.length >= 6 && tiles.every(p => p.high), tiles.length + ' roof chunks');
    // The heap shows whole until the end, then fades.
    assert.equal(F.breakFade(0), 1); assert.equal(F.breakFade(F.BREAK_SECONDS - F.BREAK_FADE), 1);
    assert.ok(F.breakFade(F.BREAK_SECONDS - 0.2) > 0 && F.breakFade(F.BREAK_SECONDS - 0.2) < 0.5); assert.equal(F.breakFade(F.BREAK_SECONDS), 0);
    assert.equal(F.collapse([], 1, meshOf).length, 0);
});

test('the dust of a collapse rises from inside the footprint, in three goes', () => {
    const { F } = engine(), P = new F.Particles(64);
    assert.equal(F.BREAK_DUST.length, 3);
    assert.ok(F.BREAK_DUST.every((t, i) => t > 0 && t < F.BREAK_SECONDS - F.BREAK_FADE && (!i || t > F.BREAK_DUST[i - 1])));
    F.rubbleDust(P, 10, 20, 2, 3, 9);
    assert.equal(P.n, 9); P.fill(); assert.equal(P.counts[0], 9, 'laid over, so it takes the hour\'s light');
    for (let i = 0; i < 9; i++) { const o = i * 8; assert.ok(Math.abs(P.lists[0][o] - 10) <= 2 + 1e-6 && Math.abs(P.lists[0][o + 2] - 20) <= 3 + 1e-6 && P.lists[0][o + 1] > 0); }
});

test('the renderer cuts a falling building into chunks of their own and gives them back when the heap has faded', () => {
    const { R, M, F, made, freed } = engine();
    const make = quality => Object.assign(Object.create(R.prototype), { WHITE: [1, 1, 1], graphicsQuality: quality, _reducedMotion: false, gl: {},
        tex: new Proxy({}, { get: (o, k) => (o[k] = o[k] || { name: k }) }) });
    const building = (id, type = 'house') => ({ id, type, age: 'iron', civilization: 'greek', x: 10, z: 20, _grassFootprint: { ex: 3, ez: 3 }, _engine: { world: M.identity(), teamTint: [0.2, 0.3, 0.9] } });
    const r = make('balanced');
    assert.equal(r._breakApart(building('a')), true);
    const b = r._breaks[0];
    assert.ok(b.pieces.length > 20 && b.t === 0 && b.dust === 0 && b.x === 10 && b.z === 20 && b.ex > 0 && b.ex < 3);
    assert.equal(made.length, b.pieces.length, 'a mesh a chunk');
    assert.ok(b.pieces.every(p => p.entry.buf && p.entry.tex && p.entry.tint.length === 3 && p.mesh === null && p.m.length === 16));
    assert.ok(b.pieces.filter(p => p.p.team).every(p => p.entry.tint[2] === 0.9), 'what wore the owner\'s colour keeps it');
    // Four at once at most: a fifth sinks.
    for (const id of ['b', 'c', 'd']) assert.equal(r._breakApart(building(id)), true);
    assert.equal(F.BREAK_AT_ONCE, 4); assert.equal(r._breakApart(building('e')), false);
    // Given back: one by one when a heap has faded, all of them when the effects are reset.
    r._dropBreak(b); assert.equal(freed.length, b.pieces.length); assert.ok(b.pieces.every(p => p.entry.buf === null));
    Object.assign(r, { _projectiles: [], _rings: [], _ghosts: [] }); r._breaks.shift();
    const rest = r._breaks.reduce((n, x) => n + x.pieces.length, 0);
    r.resetEffects(); assert.equal(freed.length, b.pieces.length + rest); assert.equal(r._breaks.length, 0);
    // Low, a viewer who asked for less motion, a site still being built, a building never drawn, a farm.
    assert.equal(make('low')._breakApart(building('f')), false);
    assert.equal(Object.assign(make('cinematic'), { _reducedMotion: true })._breakApart(building('g')), false);
    assert.equal(make('cinematic')._breakApart(Object.assign(building('h'), { underConstruction: true })), false);
    assert.equal(make('cinematic')._breakApart(Object.assign(building('i'), { _engine: null })), false);
    assert.equal(make('cinematic')._breakApart(building('j', 'farm')), false, 'a field does not come down');
    const src = read('js/engine/gamerenderer.js');
    assert.match(src, /if \(!this\._breakApart\(building\)\) this\._ghostFrom\(building, 'building'\);/);
    assert.match(src, /if \(!parts\.length \|\| parts\.length > EngineFx\.BREAK_MAX_PARTS\) return false;/);
    assert.match(src, /b\.t \+= once\(b\);\s+if \(b\.t >= EngineFx\.BREAK_SECONDS\) \{ this\._dropBreak\(b\); this\._breaks\.splice\(i, 1\); continue; \}/);
    assert.match(src, /while \(fxP && b\.dust < EngineFx\.BREAK_DUST\.length && b\.t >= EngineFx\.BREAK_DUST\[b\.dust\]\) \{/);
    assert.match(src, /const model = fm\.multiply\(b\.world, EngineFx\.collapseMatrix\(piece, b\.t, piece\.m\)\);/);
    assert.match(src, /if \(this\._breaks\) for \(const b of this\._breaks\) this\._dropBreak\(b\);\s+this\._breaks = \[\];/);
    assert.doesNotMatch(src + read('js/engine/fx.js'), /shatter/, 'nothing of the thrown-outward version is left');
});

test('no rule file knows of the effects', () => {
    for (const f of ['js/game.js', 'js/units.js', 'js/buildings.js', 'js/ai.js']) assert.doesNotMatch(read(f), /EngineFx\.(collapse|unitMotion|Particles)/, f);
});
