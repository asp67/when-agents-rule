// The map size is a match option (b1057): 800 (7x7 tiles), as every match so far, or
// 1200 (11x11). The tile and the exploration cell keep their size; the island, the
// spawns' circle and the node counts grow with the map.
const test = require('node:test'), assert = require('node:assert/strict');
const { createMatch } = require('../tools/bench/realm.cjs');

const start = (mapSize, seats = ['greek', 'persian']) =>
    createMatch({ kind: 'arena', seed: 'map-size', seats, mapSize });

test('a large map is 1200 across, in 11x11 tiles of the same size', async () => {
    const m = await start(1200);
    const g = m.game;
    assert.equal(g.terrain.size, 1200);
    assert.equal(g.EXPLORE_TILES, 11);
    assert.equal(g.EXPLORE_GRID, 66);
    assert.equal(g.EXPLORE_GRID / g.EXPLORE_TILES, 6, 'six cells a tile, as on the 800 map');
    assert.equal(g.fogOfWar.mapSize, 1200);
    assert.equal(g.arenaSpec.mapSize, 1200, 'a rematch plays the same size');
    // The spawns' circle grows with the map: 85 % of (half - 40).
    const tcs = m.seats.map(ai => ai.buildings.find(b => b.type === 'town_center'));
    for (const tc of tcs) assert.ok(Math.abs(Math.hypot(tc.x, tc.z) - 476) < 1e-6, `${tc.x},${tc.z}`);
});

test('the whole large square is land, and every node stands on it', async () => {
    const m = await start(1200);
    const t = m.game.terrain;
    for (let i = -600; i <= 600; i += 10)
        for (const [x, z] of [[i, -600], [i, 600], [-600, i], [600, i]])
            assert.ok(t.isWalkable(x, z), `${x},${z} is sea`);
    assert.ok(!t.isWalkable(660, 0), 'and the sea starts past it');
    for (const r of t.resources) assert.ok(t.isWalkable(r.x, r.z), `${r.type} at ${r.x},${r.z}`);
    // The 800 map's coast is where it was.
    const s = await start(800);
    assert.ok(s.game.terrain.isWalkable(400, 400) && !s.game.terrain.isWalkable(440, 0));
});

test('nodes are as dense as on the 800 map', async () => {
    const count = (m, type) => m.game.terrain.resources.filter(r => r.type === type).length;
    const small = await start(800), large = await start(1200);
    const k = 121 / 49;
    for (const type of ['food', 'wood', 'stone', 'gold']) {
        const ratio = count(large, type) / count(small, type);
        assert.ok(Math.abs(ratio - k) / k < 0.12, `${type}: ${count(small, type)} -> ${count(large, type)} (x${ratio.toFixed(2)})`);
    }
});

test('the model is told the size, and its tiles run to K11', async () => {
    for (const [size, last, keys] of [[800, 'G7', 49], [1200, 'K11', 121]]) {
        const m = await start(size);
        const g = m.game, mgr = g.openAIAIManager, ai = m.seats[0], c = m.scripted(ai);
        assert.match(mgr.buildSystemPrompt(ai), new RegExp(`on a square ${size}x${size} map`));
        const state = mgr.buildGameStateJSON(c);
        assert.equal(state.map.size, size);
        assert.equal(Object.keys(state.map.exploration).length, keys);
        assert.ok(last in state.map.exploration, last);
        const res = m.command(c, 'explore', { tile: last, unitType: 'worker' });
        assert.match(String(res), /^OK/, res);
        const bad = m.command(c, 'explore', { tile: size === 800 ? 'H8' : 'L12', unitType: 'worker' });
        assert.match(String(bad), new RegExp(`A-${last[0]} and 1-${last.slice(1)}`), bad);
    }
});

test('a replay rebuilds the map size its transcript names', () => {
    const vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
    const context = vm.createContext({});
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/resim.js'), 'utf8') + '\nthis.WarResim = WarResim;', context);
    assert.equal(context.WarResim.spec({ players: [], mapSize: 1200 }).mapSize, 1200);
    assert.equal(context.WarResim.spec({ players: [] }).mapSize, 800, 'older transcripts were all 800');
});
