// The yards (overhaul step A5, builds 1199 and 1200): what stands beside each kind of
// building and says what it is for, and whose it is.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const root = path.join(__dirname, '..');
const scope = { window: {} }; vm.createContext(scope);
for (const file of ['math3d', 'mesh', 'buildings']) vm.runInContext(fs.readFileSync(path.join(root, 'js/engine/' + file + '.js'), 'utf8'), scope);
const B = scope.window.EngineBuildings, Mesh = scope.window.EngineMesh;

// The names of the textures the renderer makes: the keys of its `this.tex = { ... }`.
const textures = (() => {
    const src = fs.readFileSync(path.join(root, 'js/engine/gamerenderer.js'), 'utf8');
    const from = src.indexOf('this.tex = {'), to = src.indexOf('};', from);
    assert.ok(from > 0 && to > from, 'the texture table was found');
    return new Set([...src.slice(from, to).matchAll(/^\s*(\w+):\s*T\(/gm)].map(m => m[1]));
})();

const CIVS = ['greek', 'egyptian', 'persian', 'yamato', 'roman', 'maya', 'viking'];
const YARD = ['house', 'town_center', 'barracks', 'archery_range', 'academy', 'temple', 'tower', 'farm'];
const FEET = [{ ex: 4, ez: 3.5 }, { ex: 6, ez: 5 }, { ex: 2.2, ez: 2.2 }];
const NONE = 'no-such-civilization';
// The yard is added before what the building had: the first parts are its own.
const yardOf = (type, civ, foot) => { const all = B.settlement(type, civ, foot).parts; return all.slice(0, all.length - B.settlement(type, NONE, foot).parts.length); };
const sign = parts => parts.map(p => p.kind + '|' + p.args.join(',') + '|' + p.tex + '|' + (p.tint || '') + '|' + Array.from(p.m).map(v => v.toFixed(3)).join(',')).sort().join(';');

test('the texture table is read: it has the names the yards are built from', () => {
    for (const name of ['bark', 'wood', 'thatch', 'awning', 'plaster', 'iron', 'white', 'rock', 'leather', 'cloth', 'limestone', 'foliage', 'feather', 'featherGreen']) assert.ok(textures.has(name), name);
    assert.ok(!textures.has('stone'), 'there is no texture called stone');
});

test('every civilization has a yard', () => {
    assert.deepEqual(Array.from(B.YARD_CIVS).sort(), [...CIVS].sort());
});

test('every building of every yard has something standing beside it, of sound geometry', () => {
    for (const civ of CIVS) for (const foot of FEET) for (const type of YARD) {
        const yard = yardOf(type, civ, foot);
        assert.ok(yard.length >= 2, civ + ' ' + type + ' has a yard of its own');
        for (const p of yard) {
            assert.ok(Mesh[p.kind], civ + ' ' + type + ': ' + p.kind + ' is a shape the engine makes');
            assert.ok(Mesh[p.kind](...p.args).positions.every(Number.isFinite), civ + ' ' + type + ' ' + p.kind + ' ' + p.args);
            assert.ok(Array.from(p.m).every(Number.isFinite), civ + ' ' + type + ' matrix');
            assert.ok(p.m[13] >= 0 && p.m[13] < 2.5, civ + ' ' + type + ': the yard stands on the ground and is low (' + p.m[13] + ')');
        }
    }
});

test('a yard stands at the front left corner, where the picture from the front right shows it', () => {
    for (const civ of CIVS) for (const foot of FEET) for (const type of YARD) for (const p of yardOf(type, civ, foot)) {
        const x = p.m[12], z = p.m[14], d = -foot.ex - x, where = civ + ' ' + type + ' (' + x.toFixed(2) + ', ' + z.toFixed(2) + ')';
        assert.ok(d < 5.2, where + ': within reach of the building');
        // A farm is a flat field: nothing of it hides what stands beside it, and the
        // Egyptian water lift reaches over it.
        if (type === 'farm') { assert.ok(d > -1, where + ': at the field\'s edge'); continue; }
        assert.ok(d > 0.2, where + ': left of the wall, clear of the door');
        assert.ok(z > foot.ez - d - 0.75, where + ': not behind the building as the camera sees it');
    }
});

test('a yard keeps to few materials: each is one more draw for every building in view', () => {
    const foot = FEET[0];
    for (const civ of CIVS) for (const type of YARD) {
        const parts = B.settlement(type, civ, foot).parts;
        const materials = new Set(parts.map(p => JSON.stringify([p.tex, p.tint || null])));
        assert.ok(parts.length <= 45, civ + ' ' + type + ': ' + parts.length + ' parts');
        assert.ok(materials.size <= 8, civ + ' ' + type + ': ' + materials.size + ' materials');
    }
});

test('the yards are different: no two civilizations share one, but for the watch\'s wood and stones', () => {
    const foot = FEET[1];
    for (const type of YARD) {
        if (type === 'tower') continue;   // firewood and a heap of stones, with an addition in some
        const seen = new Map();
        for (const civ of CIVS) { const s = sign(yardOf(type, civ, foot)); assert.ok(!seen.has(s), type + ': ' + civ + ' and ' + seen.get(s) + ' have the same yard'); seen.set(s, civ); }
    }
});

test('the Greek yard is the one of build 1199', () => {
    const counts = Object.fromEntries(YARD.map(type => [type, B.settlement(type, 'greek', FEET[0]).parts.length]));
    assert.deepEqual(counts, { house: 16, town_center: 31, barracks: 19, archery_range: 12, academy: 8, temple: 10, tower: 11, farm: 2 });
});

test('the Persian temple has its fire, on the altar, and no other yard has one', () => {
    const foot = FEET[1];
    const fire = B.settlement('temple', 'persian', foot).fire;
    assert.ok(Array.isArray(fire) && fire.length === 3 && fire.every(Number.isFinite));
    assert.ok(fire[1] > 0.8 && fire[1] < 1.1, 'the flame stands in the bowl, not on the ground');
    const bowl = yardOf('temple', 'persian', foot).find(p => p.tex === 'iron');
    assert.ok(bowl && Math.abs(bowl.m[12] - fire[0]) < 1e-6 && Math.abs(bowl.m[14] - fire[2]) < 1e-6, 'the fire is where the bowl is');
    for (const civ of CIVS) for (const type of YARD) {
        const has = !!B.settlement(type, civ, foot).fire;
        // A house and a Town Center have their hearth, as before.
        assert.equal(has, type === 'house' || type === 'town_center' || (civ === 'persian' && type === 'temple'), civ + ' ' + type);
    }
});

test('a building of no civilization has no yard, and a stable and a Wonder get none', () => {
    const foot = FEET[1];
    for (const type of ['barracks', 'archery_range', 'academy', 'temple', 'tower', 'farm', 'stable', 'wonder']) {
        assert.equal(B.settlement(type, NONE, foot).parts.length, 0, type);
        assert.equal(B.settlement(type, undefined, foot).parts.length, 0, type);
        assert.equal(B.settlement(type, null, foot).parts.length, 0, type);
    }
    assert.equal(B.settlement('house', NONE, foot).parts.length, 10);
    for (const civ of CIVS) {
        assert.equal(B.settlement('stable', civ, foot).parts.length, 0, civ + ': the stable model has its own rail, hay and trough');
        assert.equal(B.settlement('wonder', civ, foot).parts.length, 0, civ);
    }
});

test('no building, yard or lamp names a texture the renderer does not make', () => {
    // A part with a texture name that does not exist is drawn with no texture bound: black.
    // Until build 1199 the hearth ring and the early lamps' bases named 'stone'.
    const missing = new Set(), foot = FEET[1];
    const check = (parts, what) => { for (const p of parts) if (p.tex && !textures.has(p.tex)) missing.add(p.tex + ' (' + what + ')'); };
    for (const civ of CIVS) for (const age of ['stone', 'neolithic', 'bronze', 'iron']) for (const type of B.TYPES) {
        const parts = B.parts(type, { age, civ });
        check(parts, civ + ' ' + type);
        check(B.settlement(type, civ, foot).parts, civ + ' ' + type + ' yard');
        check(B.entranceLamp(type, age, civ, foot, parts).parts, civ + ' ' + type + ' lamp');
        for (let v = 1; v < (B.YARD_VARIANTS[type] || 1); v++) check(B.settlement(type, civ, foot, v).parts, civ + ' ' + type + ' yard ' + v);
    }
    assert.deepEqual([...missing], []);
});

// --- layouts (build 1201): a house, a tower and a farm are built many times over, and their
// yards come in several layouts, the same things standing elsewhere.
const VARIED = Object.entries(B.YARD_VARIANTS);

test('a house has six layouts of yard, a tower and a farm four, and no other building more than one', () => {
    assert.deepEqual(Object.assign({}, B.YARD_VARIANTS), { house: 6, tower: 4, farm: 4 });
    const foot = FEET[1];
    for (const civ of CIVS) for (const type of B.TYPES) {
        const plain = sign(B.settlement(type, civ, foot).parts);
        assert.equal(sign(B.settlement(type, civ, foot, 0).parts), plain, civ + ' ' + type + ': layout 0 is the one without a number');
        if (!B.YARD_VARIANTS[type]) for (const v of [1, 2, 5]) assert.equal(sign(B.settlement(type, civ, foot, v).parts), plain, civ + ' ' + type + ' has one layout');
    }
});

test('the layouts of a building are all different, of the same things', () => {
    const foot = FEET[0];
    const things = parts => parts.map(p => p.kind + '|' + p.args.join(',') + '|' + p.tex + '|' + (p.tint || '')).sort().join(';');
    for (const civ of CIVS) for (const [type, n] of VARIED) {
        const seen = new Set(), first = things(B.settlement(type, civ, foot, 0).parts);
        for (let v = 0; v < n; v++) {
            const parts = B.settlement(type, civ, foot, v).parts;
            seen.add(sign(parts));
            // The same things, so the same materials: a layout costs no draw more than another.
            assert.equal(things(parts), first, civ + ' ' + type + ' layout ' + v + ' is made of the same things');
        }
        assert.equal(seen.size, n, civ + ' ' + type + ': ' + seen.size + ' different layouts of ' + n);
    }
});

test('in every layout the yard stands where the camera sees it, clear of the walls, the door and the flag', () => {
    for (const civ of CIVS) for (const foot of FEET) for (const [type, n] of VARIED) for (let v = 0; v < n; v++) {
        const all = B.settlement(type, civ, foot, v);
        for (const p of all.parts) {
            const x = p.m[12], z = p.m[14], where = civ + ' ' + type + ' layout ' + v + ' (' + x.toFixed(2) + ', ' + z.toFixed(2) + ')';
            assert.ok(Mesh[p.kind](...p.args).positions.every(Number.isFinite) && Array.from(p.m).every(Number.isFinite), where + ' is sound');
            assert.ok(p.m[13] >= 0 && p.m[13] < 2.5, where + ' is low');
            if (type === 'farm') { assert.ok(Math.abs(x) > foot.ex - 1 && Math.abs(x) < foot.ex + 3.2, where + ': at one of the field\'s side edges'); continue; }
            assert.ok(Math.abs(x) > foot.ex + 0.2, where + ': beside the building, not in it and not before the door');
            assert.ok(Math.abs(x) < foot.ex + 6.5, where + ': within reach');
            // On the right everything shows, and keeps behind the flag at the front corner.
            if (x > 0) assert.ok(Math.hypot(x - foot.ex - 0.55, z - foot.ez - 0.55) > 0.9, where + ': clear of the flag');
        }
        // What the yard adds (the first parts) stands forward enough on the left to show.
        const base = B.settlement(type, NONE, foot, v).parts.length;
        for (const p of all.parts.slice(0, all.parts.length - base)) {
            const x = p.m[12], z = p.m[14], d = -foot.ex - x;
            if (type !== 'farm' && x < 0) assert.ok(z > foot.ez - d - 0.75, civ + ' ' + type + ' layout ' + v + ': not behind the building (' + x.toFixed(2) + ', ' + z.toFixed(2) + ')');
        }
    }
});

test('the hearth burns on the left in every layout of a house, while its jars or its yard stand on the right in some', () => {
    // On the right its light falls on the wall the camera sees and paints it orange at noon.
    const foot = FEET[0];
    for (const civ of CIVS) {
        const sides = new Set();
        for (let v = 0; v < B.YARD_VARIANTS.house; v++) {
            const r = B.settlement('house', civ, foot, v);
            assert.ok(r.fire && r.fire[0] < -foot.ex - 1, civ + ' house layout ' + v + ': the hearth is left of the house');
            sides.add(r.parts.some(p => p.m[12] > foot.ex) ? 'right' : 'left');
        }
        assert.deepEqual([...sides].sort(), ['left', 'right'], civ + ': some layouts use the right side, some do not');
    }
});

test('a building\'s layout follows from its place: always the same there, spread evenly over the map', () => {
    for (const [type, n] of VARIED) {
        const count = new Array(n).fill(0);
        for (let x = -400; x < 400; x += 20) for (let z = -400; z < 400; z += 20) {
            const v = B.yardVariant(type, x, z);
            assert.ok(Number.isInteger(v) && v >= 0 && v < n);
            assert.equal(B.yardVariant(type, x, z), v);
            assert.equal(B.yardVariant(type, x + 0.2, z - 0.3), v, 'a place is a whole unit: the layout does not flicker with a fraction');
            count[v]++;
        }
        for (const c of count) assert.ok(c > 1600 / n * 0.7 && c < 1600 / n * 1.3, type + ': ' + count.join(' '));
        // Neighbours are different more often than not.
        let same = 0, pairs = 0;
        for (let x = -400; x < 400; x += 4) for (let z = -400; z < 400; z += 4) { pairs++; if (B.yardVariant(type, x, z) === B.yardVariant(type, x + 4, z)) same++; }
        assert.ok(same / pairs < 1.5 / n, type + ': ' + same + ' of ' + pairs + ' neighbours share a layout');
    }
    for (const type of ['town_center', 'barracks', 'archery_range', 'academy', 'temple', 'stable', 'wonder']) assert.equal(B.yardVariant(type, 12, 34), 0, type);
});

test('the renderer asks for the layout of the building\'s place and keeps one model a layout', () => {
    const src = fs.readFileSync(path.join(root, 'js/engine/gamerenderer.js'), 'utf8');
    assert.ok(src.includes('const variant=EngineBuildings.yardVariant(building.type,building.x,building.z);'));
    assert.ok(src.includes('EngineBuildings.settlement(building.type,building.civilization,fp,variant)'));
    // Two layouts under one key would share the first one's mesh.
    assert.ok(src.includes("this._buildingBatches(modelKey+'|dressing|'+!!building.isWonder+'|'+variant,dressed)"));
    assert.ok(src.includes("this._buildingCaster(modelKey+'|dressing|'+!!building.isWonder+'|'+variant,dressed)"));
});
