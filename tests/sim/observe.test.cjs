// Observation without side effects (review #6 step 7). observe() must leave the whole
// world exactly as it found it: everything reachable from the game -- units, buildings,
// players, the harness, every controller, their Maps and Sets -- is fingerprinted
// before and after, and must match. A turn still commits what it was shown, so
// buildGameStateJSON is observe() plus commitObservation(), with the same result as
// before the split.
const test = require('node:test'), assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { GoldenMatch } = require('./harness.cjs');

// Canonical walk of an object graph: insertion order kept, cycles by visit number,
// functions skipped (they are code, not state).
function fingerprint(root) {
    const h = crypto.createHash('sha256'), seen = new Map();
    const walk = v => {
        if (v === null || typeof v !== 'object') {
            if (typeof v === 'function') return h.update('f');
            if (typeof v === 'number') return h.update('n' + (Object.is(v, -0) ? '-0' : String(v)));
            return h.update(typeof v + ':' + String(v));
        }
        if (seen.has(v)) return h.update('@' + seen.get(v));
        seen.set(v, seen.size);
        if (ArrayBuffer.isView(v)) return h.update(Buffer.from(v.buffer, v.byteOffset, v.byteLength));
        if (v instanceof Map || Object.prototype.toString.call(v) === '[object Map]') {
            h.update('M' + v.size); for (const [k, x] of v) { walk(k); walk(x); } return;
        }
        if (v instanceof Set || Object.prototype.toString.call(v) === '[object Set]') {
            h.update('S' + v.size); for (const x of v) walk(x); return;
        }
        const keys = Object.keys(v);
        h.update('{' + keys.length);
        for (const k of keys) {
            // Accessors are skipped: reading one may itself count (the harness's frame counter).
            const d = Object.getOwnPropertyDescriptor(v, k);
            if (d && d.get) continue;
            h.update(k); walk(v[k]);
        }
    };
    walk(root);
    return h.digest('hex');
}

async function economy() {
    const m = new GoldenMatch({ seed: 21 });
    await m.startArena({ seats: ['greek', 'persian'], seed: 'observe-check' });
    m.run(240000);
    const controllers = m.game.aiManager.aiPlayers.map(ai => m.scripted(ai));
    m.run(2000);
    return { m, controllers };
}
function battle() {
    const m = new GoldenMatch({ seed: 22 });
    const [a, b] = m.startFixture(['greek', 'persian']);
    m.addBuilding(a, 'town_center', -60, 0); m.addBuilding(b, 'town_center', 60, 0);
    m.addBuilding(b, 'tower', 20, 10);
    for (let i = 0; i < 6; i++) { m.addUnit(a, 'warrior', -10 + i, 2); m.addUnit(b, 'archer', 8 + i, -2); }
    const controllers = [m.scripted(a), m.scripted(b)];
    m.run(3000);
    return { m, controllers };
}

for (const [name, setUp] of [['an economy', economy], ['a battle', battle]]) {
    test(`observing ${name} changes nothing, and gives the same state twice`, async () => {
        const { m, controllers } = await setUp();
        const mgr = m.game.openAIAIManager;
        for (const c of controllers) {
            const before = fingerprint(m.game);
            const first = JSON.stringify(mgr.observe(c).state);
            assert.equal(fingerprint(m.game), before, 'the world after observe() is the world before it');
            assert.equal(JSON.stringify(mgr.observe(c).state), first, 'a second look sees the same');
        }
    });

    test(`a turn's state in ${name} equals observe(), and the commit is what changes`, async () => {
        const { m, controllers } = await setUp();
        const mgr = m.game.openAIAIManager;
        for (const c of controllers) {
            const looked = JSON.stringify(mgr.observe(c).state);
            const before = fingerprint(m.game), seq = c.aiPlayer._turnSeq || 0;
            assert.equal(JSON.stringify(mgr.buildGameStateJSON(c)), looked, 'the turn is sent what observe() saw');
            assert.notEqual(fingerprint(m.game), before, 'and committing it records something');
            assert.equal(c.aiPlayer._turnSeq, seq + 1, 'one committed turn advances the turn counter by one');
            assert.ok(c._shownWorkerPools instanceof Map || Object.prototype.toString.call(c._shownWorkerPools) === '[object Map]', 'the worker snapshot is recorded');
        }
    });
}
