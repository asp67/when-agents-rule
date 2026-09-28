'use strict';
// Stone and gold under deliberately uneven spawns (WAR Platform moves the spawn circle's
// centre, each seat's radius and angle, and shuffles which seat gets which spawn). With
// terrain.jitteredSpawns every seat's copy of a node sits at the same distance from its own
// Town Center; WAR's symmetric maps (and the showcase, which does not set the switch) keep
// the plain rotation, node for node.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path'), crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const ctx = vm.createContext({ Math, console });
vm.runInContext('globalThis.window = globalThis', ctx);
for (const f of ['js/simulation/rng.js', 'js/simulation/math.js', 'js/engine/texgen.js', 'js/terrain.js'])
    vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), ctx, { filename: f });
const Terrain = vm.runInContext('TerrainManager', ctx);

function map(seed, spawns, jittered) {
    const t = new Terrain(null, 800);
    t.seed = seed; t.difficulty = 'easy'; t.spawns = spawns; t.jitteredSpawns = jittered;
    t.generateTerrain();
    return t;
}
const hash = t => crypto.createHash('sha256').update(JSON.stringify(t.resources.map(r => [r.type, r.x, r.z, r.amount]))).digest('hex').slice(0, 16);
const symmetric = n => Array.from({ length: n }, (_, i) => { const a = i / n * Math.PI * 2 - Math.PI / 2; return { x: Math.cos(a) * 306, z: Math.sin(a) * 306 }; });
// Uneven like the Platform's: shifted centre, per-seat radius and angle, shuffled order.
const jittered = {
    2: [{ x: -281.4, z: 131.9 }, { x: 287.6, z: -95.2 }],
    3: [{ x: 216.3, z: 221.1 }, { x: 66.2, z: -317.4 }, { x: -311.0, z: 98.4 }],
    4: [{ x: -24.5, z: 303.3 }, { x: 318.8, z: 12.6 }, { x: -296.1, z: -9.7 }, { x: 13.9, z: -289.2 }],
};

for (const n of [2, 3, 4]) test(`${n} seats: every seat gets its stone and gold at the same distances`, () => {
    const spawns = jittered[n], t = map('jitter-' + n, spawns, true);
    for (const [type, total] of [['stone', 40], ['gold', 18]]) {
        const nodes = t.resources.filter(r => r.type === type), per = Math.max(1, Math.round(total / n));
        assert.equal(nodes.length, per * n, type + ': every node placed, for every seat');
        for (let i = 0; i < per; i++) {
            const d = spawns.map((s, p) => Math.hypot(nodes[i * n + p].x - s.x, nodes[i * n + p].z - s.z));
            assert.ok(Math.max(...d) - Math.min(...d) < 1e-6, `${type} node ${i}: ${d.map(x => x.toFixed(3)).join(' / ')}`);
        }
        for (const q of nodes) {
            assert.ok(spawns.every(s => Math.hypot(q.x - s.x, q.z - s.z) >= 95), 'clear of every Town Center');
            assert.ok(Math.max(Math.abs(q.x), Math.abs(q.z)) <= t.landLimit(q.x, q.z) - 15, 'on land, off the shore');
        }
    }
});

test('the switch changes nothing on symmetric spawns', () => {
    assert.equal(hash(map('golden-opening', symmetric(2), true)), hash(map('golden-opening', symmetric(2), false)));
    assert.equal(hash(map('greek-coast-01', symmetric(4), true)), hash(map('greek-coast-01', symmetric(4), false)));
});

test('without the switch, uneven spawns keep the plain rotation (WAR\'s showcase moves its Town Center)', () => {
    const spawns = jittered[3], t = map('jitter-3', spawns, false);
    const stone = t.resources.filter(r => r.type === 'stone');
    const d = spawns.map((s, p) => Math.hypot(stone[p].x - s.x, stone[p].z - s.z));
    assert.ok(Math.max(...d) - Math.min(...d) > 1, 'the rotation about the map centre does not follow the offsets');
});
