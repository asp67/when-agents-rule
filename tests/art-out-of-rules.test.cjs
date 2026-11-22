// Overhaul step A0 (build 1188): the art is out of the rule files. The texture painters
// (js/engine/texgen.js) and the fog's picture (js/fog-display.js) are presentation; what
// the rules took from the painters -- where the island's shore runs -- is a rule file of
// its own (js/simulation/island.js). The rules hash moved once for it, and nothing a
// match does changed: the maps and the coast below were recorded with the files as they
// were before the split, and tests/sim/golden.test.cjs was not re-recorded.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path'), crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const M = require('../js/manifest.js');

function load(files, globals = {}) {
    const ctx = vm.createContext(Object.assign({ Math, console }, globals));
    vm.runInContext('globalThis.window = globalThis', ctx);
    for (const f of files) vm.runInContext(read(f), ctx, { filename: f });
    return ctx;
}
const RULES_ONLY = ['js/simulation/rng.js', 'js/simulation/math.js', 'js/simulation/island.js', 'js/terrain.js'];
const sha = v => crypto.createHash('sha256').update(typeof v === 'string' ? v : Buffer.from(v.buffer, v.byteOffset, v.byteLength)).digest('hex').slice(0, 16);

test('the painters and the fog\'s picture are not rule files; the island is', () => {
    for (const list of [M.rules, M.vm]) {
        assert.ok(!list.includes('js/engine/texgen.js') && !list.includes('js/fog-display.js'), 'presentation is not in the list');
        assert.ok(list.includes('js/simulation/island.js') && list.includes('js/fogofwar.js'));
        assert.ok(list.indexOf('js/simulation/rng.js') < list.indexOf('js/simulation/island.js'), 'the island draws from the generator');
        assert.ok(list.indexOf('js/simulation/island.js') < list.indexOf('js/terrain.js'), 'and the terrain reads the island');
    }
    assert.ok(!M.rules.some(f => f.startsWith('js/engine/')), 'nothing of the engine decides what happens in a match');
    // No rule file and not the harness asks the painters for anything, or draws.
    const code = f => read(f).split(/\r?\n/).map(l => l.replace(/\/\/.*$/, '')).join('\n');
    for (const f of M.rules.concat(M.harness)) assert.doesNotMatch(code(f), /\bTexGen\b/, f + ' reads the painters');
    for (const f of ['js/simulation/island.js', 'js/fogofwar.js', 'js/terrain.js'])
        assert.doesNotMatch(code(f), /\bdocument\b|getContext|createImageData|drawImage|rgba\(/, f + ' draws');
    // The page loads the island before the painters, and the fog's picture after the fog.
    const order = [...read('index.html').matchAll(/<script src="([^"?]+)/g)].map(m => m[1]);
    const pos = f => { assert.ok(order.includes(f), f + ' is loaded by index.html'); return order.indexOf(f); };
    assert.ok(pos('js/simulation/island.js') < pos('js/engine/texgen.js'));
    assert.ok(pos('js/fogofwar.js') < pos('js/fog-display.js') && pos('js/fog-display.js') < pos('js/game.js'));
});

test('the island and its maps are what they were before the split', () => {
    const ctx = load(RULES_ONLY), I = vm.runInContext('WarIsland', ctx);
    const got = {};
    for (const size of [800, 1200]) {
        I.setMapSize(size);
        got['island ' + size] = [I.MAP_SIZE, I.TERRAIN_WORLD, I.TERRAIN_LAND, I.COAST_CELLS, I.COAST_WOBBLE, I.TERRAIN_SEED].join('/');
        const wob = I.coastSampler(I.TERRAIN_SEED), s = new Float64Array(4096);
        for (let i = 0; i < s.length; i++) s[i] = wob((i * 0.6180339887) % 1, (i * 0.7548776662) % 1);
        got['coast ' + size] = sha(s);
        got['limit ' + size] = sha(vm.runInContext('coastLimitTable()', ctx));
        for (const [seed, difficulty, n] of [['golden-opening', 'easy', 2], ['a0-check', 'easy', 6], [12345, 'medium', 8]]) {
            const t = new (vm.runInContext('TerrainManager', ctx))(null, size);
            t.seed = seed; t.difficulty = difficulty;
            const r = size * 0.3825;
            t.spawns = Array.from({ length: n }, (_, i) => { const a = i / n * Math.PI * 2 - Math.PI / 2; return { x: Math.cos(a) * r, z: Math.sin(a) * r }; });
            t.generateTerrain();
            got['map ' + size + ' ' + seed] = sha(JSON.stringify(t.resources.map(q => [q.type, q.x, q.z, q.amount])));
        }
    }
    // Recorded on build 1187, where js/engine/texgen.js held the island.
    assert.deepEqual(got, {
        'island 800': '800/1000/417/24/26/12345', 'coast 800': '1107bd002faf12cd', 'limit 800': '3d53a832955cee22',
        'map 800 golden-opening': '30bc62bb0108d179', 'map 800 a0-check': '814b46709e0969ec', 'map 800 12345': '9e25346c9820c6bf',
        'island 1200': '1200/1500/617/36/26/12345', 'coast 1200': '3bce798069676dd4', 'limit 1200': '39c335a82159e186',
        'map 1200 golden-opening': 'f8fb6adb32085d80', 'map 1200 a0-check': '63d22693f2b3afdb', 'map 1200 12345': '959cd09120e01813'
    });
});

test('what draws still reads one island: the painters\' names are the island\'s', () => {
    const ctx = load(RULES_ONLY.concat('js/engine/texgen.js')), I = vm.runInContext('WarIsland', ctx), T = ctx.TexGen;
    const names = ['COAST_CELLS', 'COAST_WOBBLE', 'TERRAIN_SEED', 'TERRAIN_WORLD', 'TERRAIN_LAND', 'MAP_SIZE'];
    T.setMapSize(1200);
    assert.deepEqual(names.map(k => T[k]), names.map(k => I[k]));
    assert.deepEqual([I.MAP_SIZE, T.TERRAIN_WORLD, T.TERRAIN_LAND, T.COAST_CELLS], [1200, 1500, 617, 36], 'set through the painters, the island is sized');
    I.setMapSize(800);
    assert.deepEqual([T.MAP_SIZE, T.TERRAIN_WORLD, T.TERRAIN_LAND, T.COAST_CELLS], [800, 1000, 417, 24], 'sized by the game, the painters follow');
    T.COAST_WOBBLE = 30; assert.equal(I.COAST_WOBBLE, 30); T.COAST_WOBBLE = 26;
    // The coast that is painted and the coast a unit stops at are the same samples.
    const a = T.coastSampler(T.TERRAIN_SEED), b = I.coastSampler(I.TERRAIN_SEED);
    for (let i = 0; i < 200; i++) assert.equal(a(i * 0.0137, i * 0.0291), b(i * 0.0137, i * 0.0291));
    const n1 = T.noiseSampler(8, T.rng(5)), n2 = I.noiseSampler(8, T.rng(5));
    for (let i = 0; i < 50; i++) assert.equal(n1(i * 0.07, i * 0.03), n2(i * 0.07, i * 0.03));
    // The painters keep nothing of the island's for themselves.
    const src = read('js/engine/texgen.js');
    assert.doesNotMatch(src, /TexGen\.(TERRAIN_WORLD|TERRAIN_LAND|COAST_CELLS|MAP_SIZE)\s*=\s*[\d(s]/);
    assert.doesNotMatch(src, /const lat = new Float32Array\(cells \* cells\);[\s\S]{0,200}return \(u, v\) =>/);
});

test('the fog keeps its grid without its picture, and draws it where the picture is loaded', () => {
    const N = 20;
    const game = () => ({ renderer: { units: [], buildings: [] }, terrain: { size: 40, resources: [{ x: -15, z: 0, mesh: { visible: true } }, { x: 15, z: 0, mesh: { visible: true } }] },
        player: { units: [{ x: -15, z: 0 }], buildings: [] }, unitVision: () => 6, spectatorMode: false });
    // A bare realm: no document at all.
    const bare = load(['js/fogofwar.js']), Fog = vm.runInContext('FogOfWarManager', bare);
    const f = new Fog(game());
    assert.deepEqual([f.numTiles, f.fogGrid.length, f.fogDirty, f.fogCanvas, f.fogDisplayCanvas, f.displayWorldSize], [N, N * N, false, undefined, undefined, undefined]);
    assert.equal(f.visibilityVersion, 1);
    f.updateFog();
    assert.equal(f.visibilityVersion, 2);
    assert.ok(f.isPositionCurrentlyVisible(-15, 0) && !f.isPositionVisible(15, 0));
    assert.deepEqual(f.game.terrain.resources.map(r => r.mesh.visible), [true, false], 'what the fog hides does not wait for a picture');
    f.destroy();
    assert.equal(Fog.FEATHER_WORLD, undefined, 'how soft its edge is drawn is not a rule');
    // The same with the picture loaded: the same grid, and now drawn.
    let images = 0, canvases = 0;
    const ctx2d = () => ({ createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData() { images++; }, drawImage() {}, save() {}, restore() {},
        clearRect() {}, fillRect() {}, createLinearGradient: () => ({ addColorStop() {} }), set filter(v) {}, set fillStyle(v) {} });
    const page = load(['js/fogofwar.js', 'js/fog-display.js'], { document: { createElement: () => { canvases++; return { width: 0, height: 0, getContext: ctx2d }; } }, Uint8ClampedArray });
    const Fog2 = vm.runInContext('FogOfWarManager', page), g = new Fog2(game());
    assert.deepEqual([Fog2.FEATHER_WORLD, Fog2.EDGE_MARGIN_WORLD, canvases, images, g.fogDirty], [5, 60, 3, 1, true]);
    assert.deepEqual([g._marginCells, g.displayWorldSize, g.fogDisplayCanvas.width], [30, 160, (N + 60) * 4]);
    g.updateFog();
    assert.deepEqual([images, g.visibilityVersion], [2, 2]);
    assert.deepEqual(Array.from(g.fogGrid), Array.from(f.fogGrid), 'the picture changes nothing in the grid');
    g.destroy();
    assert.deepEqual([g.fogDisplayCanvas, g.fogCanvas, g._scratchCanvas, g.fogDirty], [null, null, null, false]);
});
