// engine-test.html is the engine's own page: a village drawn by a subset of the engine,
// with nothing of the game around it. It loads its scripts by hand, so what those scripts
// need must be on its own list. From 26 September to 27 November 2026 it was not: the
// painters had begun to draw their numbers from the simulation's generator, the page did
// not load it, and the first texture threw. tests/shipped-files only asked whether the
// files it names exist.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const page = fs.readFileSync(path.join(root, 'engine-test.html'), 'utf8');
const scripts = [...page.matchAll(/<script src="([^"?]+)/g)].map(m => m[1]);

// The page's scripts, in the page's order, with a canvas that takes any drawing.
function load() {
    const pixels = n => ({ data: new Uint8ClampedArray(n * 4), width: 1, height: 1 });
    const ctx2d = () => new Proxy({}, { get: (o, k) => k in o ? o[k]
        : k === 'createImageData' || k === 'getImageData' ? (a, b, c, d) => pixels((c || a) * (d || b))
        : k === 'createLinearGradient' || k === 'createRadialGradient' || k === 'createPattern' ? () => ({ addColorStop() {} })
        : k === 'measureText' ? () => ({ width: 10 }) : () => {}, set: (o, k, v) => { o[k] = v; return true; } });
    const canvas = () => ({ width: 64, height: 64, getContext: ctx2d });
    const scope = { console, performance: { now: () => 0 }, document: { createElement: canvas, getElementById: () => canvas() } };
    scope.window = scope; vm.createContext(scope);
    for (const f of scripts) vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), scope, { filename: f });
    return scope;
}

test('the scripts the page lists are enough for the painters it calls', () => {
    assert.ok(scripts.length >= 6, 'the page lists its scripts: ' + scripts.join(', '));
    const s = load();
    assert.equal(typeof s.TexGen.rng(7)(), 'number', 'the generator the painters draw from');
    assert.equal(typeof s.TexGen.coastSampler(1), 'function', 'the island the ground is painted to');
    // Every painter the page calls, by the name it calls it under and with a seed: none throws.
    const painters = [...new Set([...page.matchAll(/TexGen\.([A-Za-z]\w*)\(/g)].map(m => m[1]))].filter(k => k !== 'rng');
    assert.ok(painters.length >= 12, painters.length + ' painters called: ' + painters.join(', '));
    for (const k of painters) {
        assert.equal(typeof s.TexGen[k], 'function', 'TexGen.' + k + ' exists');
        assert.doesNotThrow(() => (k === 'terrain' ? s.TexGen.terrain('summer', 20250627, 64) /* a small ground: the test is of the wiring */ : k === 'solid' ? s.TexGen.solid(1, 2, 3) : s.TexGen[k](5)), 'TexGen.' + k);
    }
});

test('every building and unit the page places finds its texture in the page\'s table', () => {
    const s = load();
    const table = new Set([...page.matchAll(/^\s+(\w+): GLCore\.createTextureFromCanvas\(/gm)].map(m => m[1]));
    assert.ok(table.has('terrain') && table.has('white') && table.size >= 20, [...table].join(' '));
    const placed = [...new Set([...page.matchAll(/placeBuilding\('([a-z_]+)'/g)].map(m => m[1]))].filter(t => t !== '__site');
    assert.ok(placed.length >= 9, placed.join(' '));
    const missing = new Set();
    for (const type of placed) for (const p of s.EngineBuildings.parts(type)) if (!table.has(p.tex)) missing.add(type + ': ' + p.tex);
    for (const p of s.EngineBuildings.site(8, 6)) if (!table.has(p.tex)) missing.add('site: ' + p.tex);
    for (const type of s.EngineUnits.TYPES) for (const p of s.EngineUnits.parts(type)) if (!table.has(p.tex)) missing.add(type + ': ' + p.tex);
    assert.deepEqual([...missing], [], 'a part whose texture the page does not make is drawn black');
});
