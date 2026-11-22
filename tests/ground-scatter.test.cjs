// Overhaul step A6, third slice (build 1204): what grows and lies on open ground besides the
// old scatter -- flower drifts, beds of pebbles, dry tufts, fallen logs -- and reeds at the
// water. Scenery only, by the map's seed, by biome, thinned by tier.
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
    return { W: scope.window, R: vm.runInContext('window.EngineRenderer', scope), I: vm.runInContext('WarIsland', scope), T: scope.window.TexGen, scope };
}
const renderer = R => Object.assign(Object.create(R.prototype), { WHITE: [1, 1, 1], _theme: 'summer', _resEntries: new WeakMap(), _cull: () => false,
    _buf: (kind, args) => ({ kind, args }), tex: new Proxy({}, { get: (o, k) => (o[k] = o[k] || { name: k }) }), terrain: { resources: [] }, fogView: null, game: null });
// A map with woods: trees on a grid, a stone site among them.
const terrain = seed => ({ seed, resources: [...Array(180)].map((_, i) => ({ type: 'wood', amount: 100, x: -300 + (i % 15) * 42, z: -300 + Math.floor(i / 15) * 50 })).concat([{ type: 'stone', amount: 500, x: 0, z: 0 }]) });
const kindOf = p => p.parts.some(q => q.texName === 'worldBark') ? 'log'
    : p.parts.some(q => q.kind === 'sphere' && q.args[1] === 5 && q.model[5] < 0.2 && q.noCast && p.parts.some(s => s.kind === 'cylinder' && s.args[0] === 0.02)) ? 'flowers'
    : p.parts.every(q => q.kind === 'sphere') ? 'bed' : p.parts.every(q => q.kind === 'cylinder' && q.args[0] === 0) ? 'tufts' : 'other';
const count = list => list.reduce((n, p) => { const k = kindOf(p); n[k] = (n[k] || 0) + 1; return n; }, {});
const flat = list => JSON.parse(JSON.stringify(list));

test('every land has its own ground: flowers in summer, dry tufts in winter and desert, beds of pebbles and logs in all', () => {
    const { R, I } = load(), r = renderer(R);
    I.setMapSize(800);
    const S = R.SCATTER;
    assert.deepEqual(Object.keys(S), ['summer', 'winter', 'desert']);
    for (const theme of Object.keys(S)) {
        const n = count(r._groundScatter(terrain('golden-opening'), theme, 12345));
        assert.equal(n.other, undefined, theme + ': every member is one of the four kinds');
        for (const [kind, key] of [['flowers', 'flowers'], ['bed', 'beds'], ['tufts', 'tufts'], ['log', 'logs']]) {
            assert.ok((n[kind] || 0) <= S[theme][key], theme + ' ' + kind + ': ' + n[kind] + ' of at most ' + S[theme][key]);
            if (S[theme][key]) assert.ok(n[kind] >= S[theme][key] * 0.6, theme + ' ' + kind + ': most of them found a place (' + n[kind] + ')');
            else assert.equal(n[kind], undefined, theme + ' has no ' + kind);
        }
    }
    assert.equal(S.winter.flowers, 0); assert.equal(S.summer.tufts, 0);
});

test('the ground is the map\'s: the same seed lays the same, another seed another, and everything is sound and off the beach', () => {
    const { R, I, W } = load(), r = renderer(R);
    I.setMapSize(800);
    const a = r._groundScatter(terrain('a'), 'summer', 777);
    assert.deepEqual(flat(a), flat(r._groundScatter(terrain('a'), 'summer', 777)));
    assert.notDeepEqual(flat(a), flat(r._groundScatter(terrain('a'), 'summer', 778)));
    for (const theme of ['summer', 'winter', 'desert']) for (const p of r._groundScatter(terrain('a'), theme, 777)) {
        assert.ok(Math.abs(p.x) <= 340 && Math.abs(p.z) <= 340, 'off the beach ring, like the old scatter');
        assert.ok(p.parts.length >= 1 && p.parts.length <= 60, p.parts.length + ' parts');
        for (const q of p.parts) {
            assert.ok(W.EngineMesh[q.kind], q.kind);
            assert.ok(W.EngineMesh[q.kind](...q.args).positions.every(Number.isFinite));
            assert.ok(Array.from(q.model).every(Number.isFinite));
            assert.ok(q.model[13] >= 0 && q.model[13] < 1.2, 'on the ground, and low');
        }
    }
});

test('flowers grow on green ground in drifts, beds lie on dry ground, logs beside the woods and clear of every site', () => {
    const { R, I, T } = load(), r = renderer(R);
    I.setMapSize(800);
    const land = terrain('a'), cover = T.grassCoverSampler('summer', T.TERRAIN_SEED, T.TERRAIN_WORLD);
    const list = r._groundScatter(land, 'summer', 4242);
    for (const p of list) {
        const k = kindOf(p);
        if (k === 'flowers') {
            assert.ok(cover(p.x, p.z) > 0.65, 'a patch of flowers stands on green ground');
            assert.ok(R.standField(p.x + 900, p.z - 400) > 0.52, 'and in a drift');
            const heads = p.parts.filter(q => q.kind === 'sphere'), stems = p.parts.filter(q => q.kind === 'cylinder');
            assert.ok(heads.length >= 12 && heads.length <= 29 && stems.length === heads.length, 'twelve to twenty-nine flowers, each on its stem');
            assert.ok(new Set(heads.map(q => q.tint.join())).size <= 2, 'one colour leads a patch, a second mixed in');
        }
        if (k === 'bed') { assert.ok(cover(p.x, p.z) < 0.35); assert.ok(p.parts.length >= 5 && p.parts.length <= 9); }
        if (k === 'log') {
            assert.ok(land.resources.every(o => Math.hypot(o.x - p.x, o.z - p.z) >= 2.3 - 1e-9), 'clear of every tree and site');
            assert.ok(land.resources.some(o => o.type === 'wood' && Math.hypot(o.x - p.x, o.z - p.z) <= 5.8 + 1e-9), 'and beside a tree');
        }
    }
    // A map without trees has no logs, and nothing breaks.
    assert.equal(count(r._groundScatter({ seed: 'bare', resources: [] }, 'summer', 1)).log, undefined);
    assert.ok(r._groundScatter({ seed: 'bare' }, 'summer', 1).length > 0);
});

test('small things cast nothing and are tinted from the strip; a log is bark and casts; snow lies on a winter log', () => {
    const { R, I } = load(), r = renderer(R);
    I.setMapSize(800);
    for (const theme of ['summer', 'winter', 'desert']) for (const p of r._groundScatter(terrain('a'), theme, 99)) {
        const k = kindOf(p);
        if (k === 'log') {
            const bark = p.parts.filter(q => q.texName === 'worldBark');
            assert.ok(bark.length >= 1 && bark.length <= 3 && bark.every(q => !q.noCast));
            // The trunk lies: its long axis is level.
            assert.ok(Math.abs(bark[0].model[5]) < 1e-6);
            assert.equal(p.parts.some(q => q.kind === 'box' && q.texName === 'white'), theme === 'winter', theme + ': snow on the log');
            if (theme === 'desert') assert.ok(bark.every(q => q.tint[0] < 1 && q.tint[2] < q.tint[0]), 'bleached');
        } else if (!(theme === 'desert' && k === 'bed')) {
            assert.ok(p.parts.every(q => q.noCast && q.texName === 'white' && q.tint.length === 3), theme + ' ' + k);
        } else assert.ok(p.parts.every(q => q.noCast && q.texName === 'worldStone' && R.DESERT_STONE.includes(q.tint)), 'the desert\'s beds are its stone, in its two colours');
    }
});

test('a log is drawn by every tier that has scatter; of the rest every second one is High\'s alone', () => {
    const { R, I } = load(), r = renderer(R);
    I.setMapSize(800);
    for (const theme of ['summer', 'winter', 'desert']) {
        const list = r._groundScatter(terrain('a'), theme, 5);
        assert.ok(list.every(p => p.tier === 1 || p.tier === 2));
        assert.ok(list.filter(p => kindOf(p) === 'log').every(p => p.tier === 1));
        const rest = list.filter(p => kindOf(p) !== 'log'), high = rest.filter(p => p.tier === 2).length;
        assert.ok(Math.abs(high - rest.length / 2) <= 1, theme + ': half of them (' + high + ' of ' + rest.length + ')');
    }
});

test('reeds stand at the water, beyond where a unit can walk and beyond the map\'s square, in some stretches of the shore', () => {
    const { R, I, T } = load(), r = renderer(R);
    I.setMapSize(800);
    const reeds = r._shoreReeds({ seed: 'a' }, 'summer', 31337);
    assert.ok(reeds.length >= 40 && reeds.length <= 260, reeds.length + ' clumps');
    assert.deepEqual(flat(reeds), flat(r._shoreReeds({ seed: 'a' }, 'summer', 31337)));
    const edge = T.MAP_SIZE / 2;
    for (const p of reeds) {
        assert.ok(Math.max(Math.abs(p.x), Math.abs(p.z)) > edge, 'beyond the map\'s square');
        assert.ok(Math.max(Math.abs(p.x), Math.abs(p.z)) > T.TERRAIN_LAND - 4 - T.COAST_WOBBLE, 'and beyond the walkable line at its nearest');
        assert.ok(Math.abs(p.fx) <= edge - 4 && Math.abs(p.fz) <= edge - 4, 'its fog is looked up inside the map');
        const stalks = p.parts.filter(q => q.args[0] === 0.02), heads = p.parts.filter(q => q.args[0] === 0.075);
        assert.ok(stalks.length >= 10 && stalks.length <= 16 && heads.length === 3 && stalks.length + heads.length === p.parts.length);
        assert.ok(p.parts.every(q => q.noCast && q.texName === 'white' && Array.from(q.model).every(Number.isFinite)));
        assert.ok(p.tier === 1 || p.tier === 2);
    }
    // Some stretches, not all the shore round: the clumps leave long gaps.
    const angles = reeds.map(p => Math.atan2(p.z, p.x)).sort((a, b) => a - b);
    let gap = 0; for (let i = 1; i < angles.length; i++) gap = Math.max(gap, angles[i] - angles[i - 1]);
    assert.ok(gap > 0.12, 'a stretch of open shore: ' + gap.toFixed(2));
    // Dry and brown in winter; no heads in the desert.
    const winter = r._shoreReeds({ seed: 'a' }, 'winter', 31337), desert = r._shoreReeds({ seed: 'a' }, 'desert', 31337);
    assert.notDeepEqual(winter[0].parts[0].tint, reeds[0].parts[0].tint);
    assert.ok(desert.every(p => p.parts.every(q => q.args[0] === 0.02)));
});

test('a patch is one member of its chunk whatever it is made of, and its small parts stay out of the shadow', () => {
    const { R, I } = load(), r = renderer(R);
    I.setMapSize(800);
    r.gl = { ARRAY_BUFFER: 1, bindBuffer() {}, bufferSubData() {}, deleteTexture() {}, createTexture: () => ({}), bindTexture() {}, texImage2D() {}, texParameteri() {} };
    const m = R.prototype.constructor && vm.runInContext('M3D', load().scope);
    const id = m.identity();
    const props = [
        { x: 10, z: 10, tier: 2, parts: [{ kind: 'sphere', args: [1, 5, 3], texName: 'white', tint: [0.8, 0.2, 0.2], model: id, noCast: true }, { kind: 'cylinder', args: [0.02, 0.024, 1, 4], texName: 'white', tint: [0.3, 0.5, 0.2], model: id, noCast: true }] },
        { x: 20, z: 12, tier: 1, parts: [{ kind: 'cylinder', args: [0.86, 1, 1, 7], texName: 'worldBark', tint: r.WHITE, model: id }, { kind: 'box', args: [1, 1, 1], texName: 'white', tint: [0.93, 0.96, 1], model: id, noCast: true }] },
        { kind: 'sphere', args: [1, 7, 5], texName: 'worldFoliage', tint: r.WHITE, model: id, x: 30, z: 14 }      // an old bush: one part, every tier
    ];
    const chunks = r._chunkProps(props, 128);
    assert.equal(chunks.length, 1);
    const [flowers, log, bush] = chunks[0].members;
    assert.deepEqual([flowers.entries.opaque.length, log.entries.opaque.length, bush.entries.opaque.length], [2, 2, 1]);
    assert.deepEqual([flowers.tier, log.tier, bush.tier], [2, 1, 0]);
    assert.ok(flowers.entries.opaque.every(e => e.texName === '#tints' && e.noCast && e.flat > 0 && e.flat < 1));
    assert.notEqual(flowers.entries.opaque[0].flat, flowers.entries.opaque[1].flat, 'each colour its own texel of the strip');
    assert.equal(log.entries.opaque[0].texName, 'worldBark'); assert.equal(log.entries.opaque[0].noCast, false);
    r._buildResourceChunk(chunks[0]);
    const caster = chunks[0].groups.find(g => g.caster), cyl = scopeMesh => scopeMesh.positions.length / 3;
    const E = load().W.EngineMesh;
    assert.equal(caster.nv, cyl(E.cylinder(0.86, 1, 1, 7)) + cyl(E.sphere(1, 7, 5)), 'the shadow has the trunk and the bush, not the petals or the snow');
    // One draw for everything tinted from the strip, one for the bark, one for the bush.
    assert.deepEqual(chunks[0].groups.filter(g => !g.caster).map(g => g.nv).length, 3);
});

test('Low draws the scatter it always drew, Balanced half of the new, High all; and nothing shows through a building', () => {
    const { R, I, scope } = load(), r = renderer(R);
    I.setMapSize(800);
    r.gl = { ARRAY_BUFFER: 1, bindBuffer() {}, bufferSubData() {}, deleteTexture() {}, createTexture: () => ({}), bindTexture() {}, texImage2D() {}, texParameteri() {} };
    const id = scope.window.M3D.identity();
    const part = () => ({ kind: 'sphere', args: [1, 5, 3], texName: 'worldFoliage', tint: r.WHITE, model: id });
    r._props = [0, 1, 2, 1, 2, 0].map((tier, i) => ({ x: 10 + i * 12, z: 10, tier, parts: [part()] }));
    r.buildings = [];
    const shown = q => { r.graphicsQuality = q; const dl = { opaque: [], blended: [], casters: [] }; r._pushPropChunks(dl); return r._propChunks().reduce((n, c) => n + c.members.filter(mb => mb.shown).length, 0); };
    assert.equal(shown('low'), 2); assert.equal(shown('balanced'), 4); assert.equal(shown('cinematic'), 6); assert.equal(shown('low'), 2);
    // A house goes up over the third and fourth.
    let reads = 0; r.buildings.some = function (f) { reads++; return Array.prototype.some.call(this, f); };
    r.buildings.push({ health: 100, x: 40, z: 10, _grassFootprint: { ex: 8, ez: 4 } });
    assert.equal(shown('cinematic'), 4);
    const members = r._propChunks()[0].members;
    assert.deepEqual(Array.from(members, mb => !!mb.built), [false, false, true, true, false, false]);
    const after = reads; shown('cinematic'); shown('cinematic');
    assert.equal(reads, after, 'the town is looked at when it changes, not every frame');
    r.buildings[0].health = 0;
    assert.equal(shown('cinematic'), 6, 'it falls, and what lay there shows again');
});

test('the new ground is laid with the old scatter, drawn in its chunks, and no rule file knows of it', () => {
    const src = read('js/engine/gamerenderer.js');
    assert.match(src, /for \(const p of this\._groundScatter\(terrain, theme, pSeed\)\) props\.push\(p\);\s+for \(const p of this\._shoreReeds\(terrain, theme, pSeed\)\) props\.push\(p\);\s+this\._freePropChunks\(\);\s+this\._props = props;/);
    assert.match(src, /if \(!blend && !en\.noCast\) place\('caster'/);
    assert.match(src, /mb\.want = mb\.tier <= level && !mb\.built && \(!seen \|\| seen\(fow, mb\.fx, mb\.fz, 3, 3, true\) \|\| atShore\(mb\)\);/);   // atShore: build 1211
    const manifest = read('js/manifest.js');
    assert.doesNotMatch(manifest.slice(manifest.indexOf('rules'), manifest.indexOf(']', manifest.indexOf('rules'))), /gamerenderer/);
    for (const f of ['js/terrain.js', 'js/game.js', 'js/units.js', 'js/buildings.js', 'js/simulation/position-rules.js']) assert.doesNotMatch(read(f), /_groundScatter|_shoreReeds|SCATTER\b/, f);
});
