// Overhaul step A5, second slice (build 1196): three kinds of tree a land, standing in
// stands, with undergrowth at the foot of some. Presentation only: which kind a wood node
// is drawn as follows from where it stands and its number in the list, and no rule knows.
const test = require('node:test'), assert = require('node:assert/strict');
const vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

function load() {
    const scope = { window: {}, console, performance: { now: () => 1000 } }; scope.window.window = scope.window; vm.createContext(scope);
    vm.runInContext(read('js/simulation/island.js'), scope);
    for (const f of ['math3d', 'mesh', 'texgen', 'buildings', 'units', 'atmosphere']) vm.runInContext(read('js/engine/' + f + '.js'), scope);
    scope.window.GLCore = { createMeshBuffers: (gl, mesh) => ({ mesh }), createShadowBuffers: (gl, mesh) => ({ mesh }), drawMesh() {} };
    vm.runInContext('Object.assign(globalThis, window);' + read('js/engine/gamerenderer.js'), scope);
    return { W: scope.window, R: vm.runInContext('window.EngineRenderer', scope) };
}
// A wood as a map has it: some eight hundred trees scattered over the play square.
const wood = n => { let s = 12345; const rnd = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
    return Array.from({ length: n }, () => ({ type: 'wood', x: (rnd() * 2 - 1) * 380, z: (rnd() * 2 - 1) * 380, amount: 300, health: 300 })); };
const renderer = (R, theme) => Object.assign(Object.create(R.prototype), { _theme: theme, _resEntries: new WeakMap(), _buf: (kind, args) => ({ kind, args }),
    tex: new Proxy({}, { get: (o, k) => (o[k] = o[k] || { name: k }) }) });

test('each land has three kinds of tree, all of them on a map, the first the most common', () => {
    const { R } = load(), trees = wood(800);
    assert.deepEqual(Object.keys(R.TREES).sort(), ['desert', 'summer', 'winter']);
    for (const land of Object.keys(R.TREES)) {
        const kinds = R.TREES[land], r = renderer(R, land), count = {};
        assert.equal(new Set(kinds).size, 3, land);
        for (const k of kinds) assert.ok(R.TREE_LOOK[k], k + ' has a look');
        trees.forEach((t, i) => { const k = r._treeSpecies(t, i); assert.ok(kinds.includes(k), k); count[k] = (count[k] || 0) + 1; });
        const share = kinds.map(k => (count[k] || 0) / trees.length);
        assert.ok(share[0] > 0.35 && share[0] === Math.max(...share), land + ': ' + share.map(v => v.toFixed(2)));
        assert.ok(share.every(v => v > 0.08), land + ': every kind is seen, ' + share.map(v => v.toFixed(2)));
        // The same map draws the same trees.
        assert.deepEqual(trees.map((t, i) => r._treeSpecies(t, i)), trees.map((t, i) => r._treeSpecies(t, i)));
    }
    // A land the renderer does not know by name is the summer land, as everywhere else.
    assert.ok(R.TREES.summer.includes(renderer(R, undefined)._treeSpecies(trees[0], 0)));
    // A fifth of a winter wood is bare, scattered by the tree's number as it was before there were kinds.
    const w = renderer(R, 'winter');
    assert.equal(trees.slice(0, 20).filter((t, i) => w._treeSpecies(t, i) === 'bare').length, 4);
});

test('trees of a kind stand together: a neighbour is the same kind far more often than a tree across the map', () => {
    const { R } = load(), trees = wood(800), r = renderer(R, 'summer');
    const kind = trees.map((t, i) => r._treeSpecies(t, i));
    let near = 0, nearSame = 0, far = 0, farSame = 0;
    for (let a = 0; a < trees.length; a++) for (let b = a + 1; b < trees.length; b++) {
        const d = Math.hypot(trees[a].x - trees[b].x, trees[a].z - trees[b].z);
        if (d < 25) { near++; if (kind[a] === kind[b]) nearSame++; }
        else if (d > 300) { far++; if (kind[a] === kind[b]) farSame++; }
    }
    assert.ok(near > 300 && far > 1000);
    assert.ok(nearSame / near > farSame / far + 0.15, (nearSame / near).toFixed(2) + ' beside, ' + (farSame / far).toFixed(2) + ' across the map');
    assert.ok(nearSame / near < 0.95, 'and one in seven strays, so a stand is not a block');
    // The field is slow, stays within 0 and 1, and is the same for the same place.
    for (let i = 0; i < 200; i++) { const f = R.standField(i * 7.3 - 700, i * -3.1 + 200); assert.ok(f >= 0 && f <= 1); }
    assert.equal(R.standField(12.5, -80), R.standField(12.5, -80));
    assert.ok(Math.abs(R.standField(100, 100) - R.standField(102, 100)) < 0.06);
});

test('every kind is drawn as itself: its style, its tint, snow where it lies, a shadow as wide as the tree', () => {
    const { W, R } = load();
    for (const land of Object.keys(R.TREES)) for (const kind of R.TREES[land]) {
        const r = renderer(R, land), look = R.TREE_LOOK[kind];
        r._treeSpecies = () => kind;
        const res = { type: 'wood', x: 40, z: -25, amount: 300, health: 300 }, before = { ...res };
        const e = r._resourceEntries(res, 2);            // number 2: a tree without undergrowth
        assert.deepEqual(res, before, 'the node is not touched');
        const s = 0.85 + ((2 * 37) % 100) / 200;
        assert.equal(e.blended.length, 1);
        assert.ok(Math.abs(e.blended[0].model[0] - s * look.shade) < 1e-6, kind + ': the soft shadow at its foot');
        const parts = e.opaque.filter(p => p.kind === 'seasonalTree');
        if (kind === 'oak') {
            assert.equal(parts.length, 0);
            assert.deepEqual(Array.from(e.opaque, p => p.kind), ['cylinder', 'cylinder', 'cylinder', 'canopy']);
            assert.deepEqual(Array.from(e.opaque[3].args), [2], 'the one fine crown, as it was');
            continue;
        }
        assert.deepEqual(Array.from(parts, p => p.args[0]), Array.from(parts, () => look.style));
        assert.deepEqual(Array.from(parts, p => p.args[2]), ['bark'].concat(look.foliage ? ['foliage'] : [], look.snow ? ['snow'] : []), kind);
        if (look.foliage) assert.deepEqual(parts[1].tint ? Array.from(parts[1].tint) : true, look.foliage === true ? true : Array.from(look.foliage));
        // Built, sound, and no heavier than the acacia that was there before.
        let corners = 0;
        for (const mat of ['bark', 'foliage', 'snow']) {
            const mesh = W.EngineMesh.seasonalTree(look.style, 2, mat);
            assert.ok(mesh.positions.every(Number.isFinite) && mesh.normals.every(Number.isFinite), kind);
            assert.equal(W.EngineMesh.auditWinding(mesh), 0, kind + '/' + mat);
            corners += mesh.positions.length / 3;
        }
        assert.ok(corners > 100 && corners <= 2600, kind + ': ' + corners + ' corners');
    }
    // The kinds can be told apart by their outline: the cypress is the tall narrow one, the tall pine a pine that is taller.
    const top = (style, mat = 'foliage') => { const m = W.EngineMesh.seasonalTree(style, 1, mat); let y = 0, reach = 0;
        for (let i = 0; i < m.positions.length; i += 3) { y = Math.max(y, m.positions[i + 1]); reach = Math.max(reach, Math.hypot(m.positions[i], m.positions[i + 2])); } return [y, reach]; };
    const [cy, cr] = top('cypress'), [oy, or] = top('olive'), [fy, fr] = top('tallpine'), [py, pr] = top('pine'), [ty, tr] = top('thorn'), [ay] = top('desert'), [ly, lr] = top('palm');
    assert.ok(cy > 6 && cr < 1 && oy < 3.6 && or > 1.6, 'cypress tall and slim, olive low and broad');
    assert.ok(fy > py + 0.8 && fr < pr * 0.9 && fr > pr * 0.7, 'the tall pine taller and a little slimmer than the pine, not a pole');
    // ...and straight: its skirts sit almost square on the trunk. (The thin fir that stood here first looked crooked.)
    for (let v = 0; v < 4; v++) {
        const m = W.EngineMesh.seasonalTree('tallpine', v, 'foliage'), n = m.positions.length / 3 / 5;
        for (let tier = 0; tier < 5; tier++) {
            let sx = 0, sz = 0;
            for (let i = tier * n; i < (tier + 1) * n; i++) { sx += m.positions[i * 3]; sz += m.positions[i * 3 + 2]; }
            assert.ok(Math.hypot(sx / n, sz / n) < 0.07, 'variant ' + v + ', skirt ' + tier + ': ' + Math.hypot(sx / n, sz / n).toFixed(3) + ' off the trunk');
        }
    }
    assert.ok(ty < ay && ly > ay && lr > 2.5 && tr > 1.5, 'the thorn low and flat, the palm tall with long fronds');
    // The coarse crown is the same shape with a third of the corners; the fine one is as it was.
    assert.equal(W.EngineMesh.canopy(1).positions.length / 3, 25 * 17);
    assert.equal(W.EngineMesh.canopy(1, false).positions.length / 3, 15 * 10);
    assert.equal(W.EngineMesh.auditWinding(W.EngineMesh.spindle(2)), 0);
});

test('undergrowth: a shrub or two at the foot of some trees, in the land\'s colour, and the tree\'s own', () => {
    const { R } = load(), trees = wood(400);
    for (const land of Object.keys(R.TREES)) {
        const r = renderer(R, land), U = R.UNDERGROWTH[land];
        let withShrubs = 0;
        trees.forEach((t, i) => {
            const e = r._resourceEntries(t, i);
            const shrubs = e.opaque.filter(p => p.kind === 'sphere' && p.texName === 'worldFoliage');
            if (!shrubs.length) return;
            withShrubs++;
            assert.ok(shrubs.length <= 2);
            for (const p of shrubs) {
                assert.deepEqual(p.tint ? Array.from(p.tint) : null, U.tint ? Array.from(U.tint) : null);
                const d = Math.hypot(p.model[12] - t.x, p.model[14] - t.z);
                assert.ok(d > 0.8 && d < 2.6 && p.model[13] < 0.4, 'beside the trunk, low: ' + d.toFixed(2));
            }
            assert.equal(e.opaque.filter(p => p.kind === 'sphere' && p.texName === 'white').length, U.snow ? shrubs.length : 0, 'snow on a winter shrub');
        });
        assert.ok(Math.abs(withShrubs / trees.length - U.share) < 0.06, land + ': ' + (withShrubs / trees.length).toFixed(2) + ' of ' + U.share);
    }
    // Its tint is one the land's trees have, so it adds no draw to a chunk of forest.
    const tintOf = k => { const t = R.TREE_LOOK[k].foliage; return t && t !== true ? Array.from(t).join() : 'none'; };
    const tints = land => R.TREES[land].map(tintOf);
    // A chunk of forest is a draw per tint: at most two foliage tints a land, where there was one.
    for (const land of Object.keys(R.TREES)) assert.ok(new Set(R.TREES[land].filter(k => R.TREE_LOOK[k].foliage).map(tintOf)).size <= 2, land);
    assert.equal(new Set(R.TREES.winter.filter(k => R.TREE_LOOK[k].foliage).map(tintOf)).size, 1, 'winter: none more');
    for (const land of Object.keys(R.TREES)) { const t = R.UNDERGROWTH[land].tint; assert.ok(tints(land).includes(t ? Array.from(t).join() : 'none'), land); }
    // It is among the tree's parts, so the chunk that fells the tree takes it along.
    assert.match(read('js/engine/gamerenderer.js'), /It is the tree's,\s+\/\/ and goes when the tree is felled\./);
});
