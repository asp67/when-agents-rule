// The arena's starting layout (b1076): WAR Platform's jittered spawns, and a home
// around every Town Center laid out the same for every seat to the pixel -- so no seat
// starts with food in sight while another has none.
const test = require('node:test'), assert = require('node:assert/strict');
const { createMatch } = require('../tools/bench/realm.cjs');

const start = (seed, opts = {}) => createMatch(Object.assign({ kind: 'arena', seed, seats: ['greek', 'persian', 'yamato', 'egyptian'] }, opts));
const tcOf = ai => ai.buildings.find(b => b.type === 'town_center');

test('spawns are jittered off the even circle, fairly, and the same for the same seed', async () => {
    const a = await start('layout-1'), b = await start('layout-1'), c = await start('layout-2');
    const at = m => m.seats.map(ai => { const t = tcOf(ai); return [t.x, t.z]; });
    assert.deepEqual(at(a), at(b), 'a replay rebuilds it');
    assert.notDeepEqual(at(a), at(c), 'another seed, another layout');
    const radii = at(a).map(([x, z]) => Math.hypot(x, z));
    assert.ok(Math.max(...radii) - Math.min(...radii) > 0.5, 'not the even circle: ' + radii.map(r => r.toFixed(1)));
    // Rank for rank, no seat's rivals more than 12% nearer than another's.
    const TM = a.context.TerrainManager || require('node:vm').runInContext('TerrainManager', a.context);
    for (let s = 0; s < 30; s++) for (const n of [2, 3, 4]) for (const size of [800, 1200]) {
        const pts = TM.arenaSpawns('fair-' + s, n, size);
        const rows = pts.map((p, i) => pts.filter((_, j) => i !== j).map(q => Math.hypot(p.x - q.x, p.z - q.z)).sort((x, y) => x - y));
        for (let r = 0; r < n - 1; r++) {
            const col = rows.map(row => row[r]);
            assert.ok(Math.max(...col) / Math.min(...col) <= 1.12 + 1e-9, `seed ${s}, ${n} seats, ${size}`);
        }
        assert.ok(pts.every(p => Math.max(Math.abs(p.x), Math.abs(p.z)) <= size / 2 - 40 * size / 800), 'off the coast');
    }
});

test('every seat\'s home is the same to the pixel, turned with its bearing', async () => {
    for (const [difficulty, mapSize] of [['easy', 800], ['hard', 800], ['medium', 1200]]) {
        const m = await start('home-' + difficulty + mapSize, { difficulty, mapSize });
        const homes = m.seats.map(ai => {
            const t = tcOf(ai), a = Math.atan2(t.z, t.x);
            // Each node near home, in the seat's own frame: rotated back by its bearing.
            return m.game.terrain.resources.filter(r => (r.type === 'food' || r.type === 'wood') && Math.hypot(r.x - t.x, r.z - t.z) < 55)
                .map(r => { const dx = r.x - t.x, dz = r.z - t.z; return [r.type, dx * Math.cos(a) + dz * Math.sin(a), -dx * Math.sin(a) + dz * Math.cos(a)]; })
                .map(([type, x, z]) => `${type}:${x.toFixed(3)}:${z.toFixed(3)}`).sort();
        });
        for (const h of homes.slice(1)) assert.deepEqual(h, homes[0], `${difficulty} ${mapSize}: the same home`);
        assert.ok(homes[0].length > 0, 'and not empty');
        // Stone and gold: the same distances from every Town Center.
        for (const type of ['stone', 'gold']) {
            const near = m.seats.map(ai => { const t = tcOf(ai); return m.game.terrain.resources.filter(r => r.type === type).map(r => Math.hypot(r.x - t.x, r.z - t.z)).sort((x, y) => x - y).slice(0, 3).map(d => d.toFixed(2)); });
            for (const n of near.slice(1)) assert.deepEqual(n, near[0], `${type} ${difficulty} ${mapSize}`);
        }
    }
});

test('the map keeps its totals, to within a home\'s worth', async () => {
    for (const difficulty of ['easy', 'hard']) {
        const m = await start('totals-' + difficulty, { difficulty });
        const count = type => m.game.terrain.resources.filter(r => r.type === type).length;
        const per = { easy: { food: 8, wood: 16 }, hard: { food: 1, wood: 4 } }[difficulty];
        for (const type of ['food', 'wood']) {
            const want = per[type] * 49;
            // The four Town Centers clear their own spot either way; a home is one tile's area.
            assert.ok(Math.abs(count(type) - want) <= per[type] * 4 + 4, `${difficulty} ${type}: ${count(type)} against ${want}`);
        }
    }
});
