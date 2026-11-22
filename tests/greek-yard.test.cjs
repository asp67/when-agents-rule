// The Greek yard (overhaul step A5, build 1199): what stands beside each kind of Greek
// building and says what it is for.
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

const YARD = ['house', 'town_center', 'barracks', 'archery_range', 'academy', 'temple', 'tower', 'farm'];
const FEET = [{ ex: 4, ez: 3.5 }, { ex: 6, ez: 5 }, { ex: 2.2, ez: 2.2 }];

test('the texture table is read: it has the names the yard is built from', () => {
    for (const name of ['bark', 'wood', 'thatch', 'awning', 'plaster', 'iron', 'white', 'rock']) assert.ok(textures.has(name), name);
    assert.ok(!textures.has('stone'), 'there is no texture called stone');
});

test('every Greek building of the yard has something standing beside it, of sound geometry', () => {
    for (const foot of FEET) for (const type of YARD) {
        const yard = B.settlement(type, 'greek', foot).parts, other = B.settlement(type, 'egyptian', foot).parts;
        assert.ok(yard.length > other.length, type + ' has a yard of its own');
        for (const p of yard) {
            assert.ok(Mesh[p.kind], type + ': ' + p.kind + ' is a shape the engine makes');
            assert.ok(Mesh[p.kind](...p.args).positions.every(Number.isFinite), type + ' ' + p.kind);
            assert.ok(Array.from(p.m).every(Number.isFinite), type + ' matrix');
            assert.ok(p.m[13] >= 0 && p.m[13] < 2.5, type + ': the yard stands on the ground and is low');
        }
    }
});

test('the yard stands at the front left corner, where the picture from the front right shows it', () => {
    for (const foot of FEET) for (const type of YARD) {
        const base = B.settlement(type, 'egyptian', foot).parts.length;
        // The yard is added before what the building had: the first parts are its own.
        const all = B.settlement(type, 'greek', foot).parts, yard = all.slice(0, all.length - base);
        for (const p of yard) {
            const x = p.m[12], z = p.m[14], d = -foot.ex - x;
            assert.ok(d > 0.2, type + ': left of the wall, clear of the door (' + x.toFixed(2) + ')');
            assert.ok(d < 5.2, type + ': within reach of the building');
            // A farm is a flat field: nothing of it hides what stands beside it.
            if (type !== 'farm') assert.ok(z > foot.ez - d - 0.75, type + ': not behind the building as the camera sees it (' + x.toFixed(2) + ', ' + z.toFixed(2) + ')');
        }
    }
});

test('the yard keeps to few materials: each is one more draw for every building in view', () => {
    const foot = FEET[0];
    for (const type of YARD) {
        const parts = B.settlement(type, 'greek', foot).parts;
        const materials = new Set(parts.map(p => JSON.stringify([p.tex, p.tint || null])));
        assert.ok(parts.length <= 45, type + ': ' + parts.length + ' parts');
        assert.ok(materials.size <= 8, type + ': ' + materials.size + ' materials');
    }
});

test('the other civilizations keep the yard they had, and a stable and a Wonder get none', () => {
    const foot = FEET[1];
    for (const civ of ['egyptian', 'persian', 'yamato', 'roman', 'maya']) {
        for (const type of ['barracks', 'archery_range', 'academy', 'temple', 'tower', 'farm', 'stable']) assert.equal(B.settlement(type, civ, foot).parts.length, 0, civ + ' ' + type);
        assert.ok(B.settlement('house', civ, foot).parts.length <= 10);
    }
    assert.equal(B.settlement('stable', 'greek', foot).parts.length, 0, 'the stable model has its own rail, hay and trough');
    assert.equal(B.settlement('wonder', 'greek', foot).parts.length, 0);
});

test('no building, yard or lamp names a texture the renderer does not make', () => {
    // A part with a texture name that does not exist is drawn with no texture bound: black.
    // Until build 1199 the hearth ring and the early lamps' bases named 'stone'.
    const missing = new Set(), foot = FEET[1];
    const check = (parts, what) => { for (const p of parts) if (p.tex && !textures.has(p.tex)) missing.add(p.tex + ' (' + what + ')'); };
    for (const civ of ['greek', 'egyptian', 'persian', 'yamato', 'roman', 'maya']) for (const age of ['stone', 'neolithic', 'bronze', 'iron']) for (const type of B.TYPES) {
        const parts = B.parts(type, { age, civ });
        check(parts, type);
        check(B.settlement(type, civ, foot).parts, type + ' yard');
        check(B.entranceLamp(type, age, civ, foot, parts).parts, type + ' lamp');
    }
    assert.deepEqual([...missing], []);
});
