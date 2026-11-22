// Overhaul step A9, third slice (build 1208): a building that falls breaks into its own
// parts. (The birds of that build were removed in build 1209.)
const test = require('node:test'), assert = require('node:assert/strict');
const vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

function engine() {
    const scope = { window: {}, console, performance: { now: () => 1000 } }; scope.window.window = scope.window; vm.createContext(scope);
    for (const f of ['js/simulation/rng.js', 'js/simulation/math.js', 'js/simulation/island.js']) vm.runInContext(read(f), scope);
    for (const f of ['math3d', 'mesh', 'texgen', 'buildings', 'units', 'atmosphere', 'fx']) vm.runInContext(read('js/engine/' + f + '.js'), scope);
    scope.window.GLCore = { createMeshBuffers: (gl, mesh) => ({ mesh }), createShadowBuffers: (gl, mesh) => ({ mesh }), deleteMeshBuffers() {}, drawMesh() {} };
    vm.runInContext('Object.assign(globalThis, window);' + read('js/engine/gamerenderer.js'), scope);
    return { W: scope.window, R: vm.runInContext('window.EngineRenderer', scope), F: scope.window.EngineFx, M: scope.window.M3D, B: scope.window.EngineBuildings };
}

test('a fallen building\'s parts come away from each other: thrown outward, turning, landing, lying', () => {
    const { F, M, B } = engine();
    const parts = B.parts('house', { age: 'iron', civ: 'greek' });
    const pieces = F.shatter(parts, 4711);
    assert.equal(pieces.length, parts.filter(p => !p.blend && p.tex !== 'shadow').length, 'every solid part, and not the shadow under it');
    assert.ok(pieces.length >= 8);
    for (const piece of pieces) {
        // The moment it falls, every part is where the building had it.
        const start = F.shatterMatrix(piece, 0, M);
        for (let i = 0; i < 16; i++) assert.ok(Math.abs(start[i] - piece.p.m[i]) < 1e-5, 'at the first moment a part has not moved');
        assert.ok(piece.lands > 0 && piece.lands < 3 && Number.isFinite(piece.spin) && piece.delay >= 0 && piece.delay < 0.25);
        // At the end it lies near the ground, further from the middle than it began, and stays.
        const end = F.shatterMatrix(piece, F.BREAK_SECONDS, M), later = F.shatterMatrix(piece, F.BREAK_SECONDS + 1, M);
        assert.ok(Array.from(end).every(Number.isFinite));
        // Where its middle is: the matrix applied to the middle it had (the part's own origin).
        const mid = m => [m[12], m[13], m[14]];
        if (piece.lands + piece.delay <= F.BREAK_SECONDS) {
            assert.ok(Math.abs(mid(end)[1] - piece.rest) < 1e-4, 'landed: its middle at resting height (' + mid(end)[1] + ')');
            for (let i = 0; i < 16; i++) assert.ok(Math.abs(end[i] - later[i]) < 1e-6, 'what has landed lies still');
        }
        assert.ok(Math.hypot(mid(end)[0], mid(end)[2]) > Math.hypot(piece.cx, piece.cz) + 0.5, 'thrown outward');
        assert.ok(mid(end)[1] >= piece.rest - 1e-6, 'nothing sinks through the ground');
    }
    // The same building breaks the same way; another one another way.
    const again = F.shatter(parts, 4711), other = F.shatter(parts, 99);
    assert.deepEqual(pieces.map(p => [p.vx, p.vz, p.vy, p.spin]), again.map(p => [p.vx, p.vz, p.vy, p.spin]));
    assert.notDeepEqual(pieces.map(p => p.vx), other.map(p => p.vx));
    // All of it shows for two thirds of the time, then fades.
    assert.equal(F.breakFade(0), 1); assert.equal(F.breakFade(F.BREAK_SECONDS * 0.6), 1);
    assert.ok(F.breakFade(F.BREAK_SECONDS * 0.9) > 0 && F.breakFade(F.BREAK_SECONDS * 0.9) < 0.5); assert.equal(F.breakFade(F.BREAK_SECONDS), 0);
});

test('the renderer breaks a building apart where the tier has effects, and lets it sink as before where not', () => {
    const { R, M } = engine();
    const make = quality => Object.assign(Object.create(R.prototype), { WHITE: [1, 1, 1], graphicsQuality: quality, _reducedMotion: false, dust: 0,
        _buf: (kind, args) => ({ kind, args }), tex: new Proxy({}, { get: (o, k) => (o[k] = o[k] || { name: k }) }), spawnDust() { this.dust++; } });
    const building = id => ({ id, type: 'house', age: 'iron', civilization: 'greek', x: 10, z: 20, _grassFootprint: { ex: 3, ez: 3 }, _engine: { world: M.identity(), teamTint: [0.2, 0.3, 0.9] } });
    const r = make('balanced');
    assert.equal(r._breakApart(building('a')), true);
    assert.equal(r._breaks.length, 1); assert.ok(r._breaks[0].pieces.length >= 8 && r._breaks[0].t === 0);
    assert.ok(r._breaks[0].pieces.every(p => p.entry.buf && p.entry.tex && p.entry.tint.length === 3));
    assert.ok(r._breaks[0].pieces.some(p => p.p.team) ? r._breaks[0].pieces.filter(p => p.p.team).every(p => p.entry.tint[2] === 0.9) : true, 'what wore the owner\'s colour keeps it');
    assert.equal(r.dust, 2, 'dust from two corners besides the burst every fall raises');
    // Two at once at most: a third sinks.
    assert.equal(r._breakApart(building('b')), true); assert.equal(r._breakApart(building('c')), false);
    // Low, a viewer who asked for less motion, a site still being built, a building never drawn.
    assert.equal(make('low')._breakApart(building('d')), false);
    assert.equal(Object.assign(make('cinematic'), { _reducedMotion: true })._breakApart(building('e')), false);
    assert.equal(make('cinematic')._breakApart(Object.assign(building('f'), { underConstruction: true })), false);
    assert.equal(make('cinematic')._breakApart(Object.assign(building('g'), { _engine: null })), false);
    const src = read('js/engine/gamerenderer.js');
    assert.match(src, /if \(!this\._breakApart\(building\)\) this\._ghostFrom\(building, 'building'\);/);
    assert.match(src, /if \(!parts\.length \|\| parts\.length > EngineFx\.BREAK_MAX_PARTS\) return false;/);
    assert.match(src, /b\.t \+= once\(b\);\s+if \(b\.t >= EngineFx\.BREAK_SECONDS\) \{ this\._breaks\.splice\(i, 1\); continue; \}/);
    assert.match(src, /this\._ghosts = \[\];\s+this\._breaks = \[\];/);
});

test('no rule file knows of the effects', () => {
    for (const f of ['js/game.js', 'js/units.js', 'js/buildings.js', 'js/ai.js']) assert.doesNotMatch(read(f), /EngineFx\.(shatter|unitMotion|Particles)/, f);
});
