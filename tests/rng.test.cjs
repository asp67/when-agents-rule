// The game's one random-number source (js/simulation/rng.js, review #6 step 4).
// Three promises: rule code draws only through it; consolidating the two old copies
// changed no map and no texture; and a keyed draw depends on who drew and what for,
// never on what else was drawn first.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path'), crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

function load(files) {
    const ctx = vm.createContext({ Math, console });
    vm.runInContext('globalThis.window = globalThis', ctx);
    for (const f of files) vm.runInContext(read(f), ctx, { filename: f });
    return ctx;
}

// Every file whose code decides what happens, as the contract counts them, plus the
// harness, which chooses build sites and scouting targets for the models.
test('rule code draws no Math.random outside its named exemptions', () => {
    const ctx = load(['js/manifest.js', 'js/sha256.js', 'js/conditions.js']);
    const files = vm.runInContext('WarConditions.CORE_FILES.concat(WarConditions.HARNESS_FILE)', ctx);
    const found = [];
    for (const f of files) read(f).split(/\r?\n/).forEach((line, i) => {
        const code = line.replace(/\/\/.*$/, '');
        if (/Math\.random/.test(code) && !/rng-exempt:/.test(line)) found.push(`${f}:${i + 1}: ${line.trim()}`);
    });
    assert.deepEqual(found, [], 'use game.rand(who, purpose), or mark the line "// rng-exempt: <why>"');
});

test('the consolidated generator reproduces both old copies exactly', () => {
    // The two copies as they were, kept here as the reference.
    const oldTex = seed => { let s = (seed >>> 0) || 1; return () => { s |= 0; s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
    const oldHash = seed => { let h = 1779033703 ^ String(seed).length; for (const ch of String(seed)) { h = Math.imul(h ^ ch.charCodeAt(0), 3432918353); h = (h << 13) | (h >>> 19); } return h >>> 0; };
    const R = load(['js/simulation/rng.js']).WarRng;
    for (const seed of [0, 1, 7, 12345, 4294967295, -5]) {
        const a = oldTex(seed), b = R.stream(seed, 1);
        for (let i = 0; i < 50; i++) assert.equal(b(), a(), `texture stream ${seed}`);
    }
    for (const seed of ['golden-opening', 'a', '', '🙂seed', 'x'.repeat(40)]) {
        assert.equal(R.hashSeed(seed), oldHash(seed), `seed hash ${seed}`);
        const a = oldTex(oldHash(seed) || 42), b = R.stream(R.hashSeed(seed), 42);
        for (let i = 0; i < 50; i++) assert.equal(b(), a(), `map stream ${seed}`);
    }
});

test('maps and textures from existing seeds are unchanged', () => {
    const ctx = load(['js/simulation/rng.js', 'js/simulation/math.js', 'js/engine/texgen.js', 'js/terrain.js']);
    const map = (seed, difficulty, n) => {
        const t = new (vm.runInContext('TerrainManager', ctx))(null, 800);
        t.seed = seed; t.difficulty = difficulty;
        t.spawns = Array.from({ length: n }, (_, i) => { const a = i / n * Math.PI * 2 - Math.PI / 2; return { x: Math.cos(a) * 306, z: Math.sin(a) * 306 }; });
        t.generateTerrain();
        return crypto.createHash('sha256').update(JSON.stringify(t.resources.map(r => [r.type, r.x, r.z, r.amount]))).digest('hex').slice(0, 16);
    };
    // Recorded with the generators as they were before consolidation.
    assert.equal(map('golden-opening', 'easy', 2), '30bc62bb0108d179');
    assert.equal(map('greek-coast-01', 'medium', 4), '1ed855f7a67f5ede');
    assert.equal(map('🙂seed', 'hard', 3), '3b6547aff12fc8c7');
    const tex = s => { const r = vm.runInContext('window.TexGen', ctx).rng(s); return Array.from({ length: 5 }, () => r()).join(','); };
    assert.equal(tex(0), '0.6270739405881613,0.002735721180215478,0.5274470399599522,0.9810509674716741,0.9683778982143849');
    assert.equal(tex(12345), '0.9797282677609473,0.3067522644996643,0.484205421525985,0.817934412509203,0.5094283693470061');
});

test('a keyed draw depends on seed, key and count, never on other keys', () => {
    const R = load(['js/simulation/rng.js']).WarRng;
    const seq = (state, key, n) => Array.from({ length: n }, () => R.draw(state, key));
    const alone = seq(R.keyed('m1'), 's0:farm-spot', 20);
    const busy = R.keyed('m1'), mixed = [];
    for (let i = 0; i < 20; i++) { R.draw(busy, 's1:farm-spot'); R.draw(busy, 's0:build-site'); mixed.push(R.draw(busy, 's0:farm-spot')); }
    assert.deepEqual(mixed, alone, 'draws for other seats and purposes change nothing');
    assert.notDeepEqual(seq(R.keyed('m2'), 's0:farm-spot', 20), alone, 'another match, other draws');
    assert.ok(alone.every(v => v >= 0 && v < 1));
    // Plain data: a checkpoint stores it, and the sequence resumes where it stopped.
    const st = R.keyed('m1'); seq(st, 's0:farm-spot', 7);
    const resumed = JSON.parse(JSON.stringify(st));
    assert.deepEqual(seq(resumed, 's0:farm-spot', 13), alone.slice(7));
    // Roughly uniform: a draw that clumped would bunch workers on one side of a node.
    const many = seq(R.keyed('u'), 'k', 20000), bins = [0, 0, 0, 0];
    many.forEach(v => bins[Math.floor(v * 4)]++);
    bins.forEach(b => assert.ok(Math.abs(b - 5000) < 250, 'quarter holds ' + b));
});
