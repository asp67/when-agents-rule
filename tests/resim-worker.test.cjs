'use strict';
// The analyzer's re-simulation worker (review #9), run as it runs in a browser: the
// worker script in a global of its own, which fetches the page's rule files, runs them
// from blob URLs and hashes those very texts. importScripts, fetch and blob URLs are
// stood in for; everything else is the worker's own code.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createMatch, Realm } = require('../tools/bench/realm.cjs');

const ROOT = path.resolve(__dirname, '..');

function workerRealm() {
    const blobs = new Map(), out = [], spawned = [];
    const ctx = vm.createContext({
        console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
        setTimeout, clearTimeout, Math, Date, performance, Promise, Proxy, Uint8ClampedArray, JSON,
        Blob: class { constructor(parts) { this.text = parts.join(''); } },
        URL: { createObjectURL: b => { const k = 'blob:' + blobs.size; blobs.set(k, b.text); return k; } },
        fetch: async url => {
            // Relative URLs resolve against the worker's own, js/resim-worker.js.
            const u = String(url).split('?')[0];
            const file = /^https?:/.test(u) ? path.join(ROOT, u.replace(/^https?:\/\/[^/]+\//, '')) : path.join(ROOT, 'js', u);
            return fs.existsSync(file) ? { ok: true, text: async () => fs.readFileSync(file, 'utf8') } : { ok: false };
        },
        postMessage: m => out.push(m),
        // A browser worker may start workers of its own; one that ticked the game
        // would move the world between messages.
        Worker: class { constructor(url) { spawned.push(url); } terminate() {} },
    });
    ctx.self = ctx;
    ctx.importScripts = (...urls) => urls.forEach(u => vm.runInContext(blobs.get(u), ctx, { filename: u }));
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/resim-worker.js'), 'utf8'), ctx, { filename: 'js/resim-worker.js' });
    const send = async data => { const n = out.length; await ctx.onmessage({ data }); return out[n]; };
    return { send, spawned };
}

const warSha256 = (() => { const c = vm.createContext({}); vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/sha256.js'), 'utf8') + ';globalThis.h = warSha256;', c); return c.h; })();
const lf = s => s.replace(/\r\n/g, '\n');
const manifest = require('../js/manifest.js');
const hashes = () => ({
    coreHash: warSha256(manifest.rules.map(f => lf(fs.readFileSync(path.join(ROOT, f), 'utf8'))).join('\n')),
    harnessHash: warSha256(lf(fs.readFileSync(path.join(ROOT, manifest.harness), 'utf8'))),
});

// A recording with one model seat, answered by a script.
async function recording() {
    const m = await createMatch({ kind: 'arena', seats: ['greek', { civ: 'persian', type: 'ki', profile: 'rusher' }], seed: 'worker-a' });
    const g = m.game, mgr = g.openAIAIManager, lines = [];
    mgr.transcripts = { matchId: 'w', noteInput: e => lines.push(e) };
    const c = m.scripted(m.seats[0]);
    for (const a of [[['assign_workers', { resourceType: 'wood', count: 2, from: 'idle' }]], [['train_unit', { unitType: 'worker' }]]]) {
        m.advance(10000); c.turnCount++; mgr.buildGameStateJSON(c); m.advance(1000);
        mgr.executeTurn(c, { commands: a.map(([action, params]) => ({ action, params })) });
    }
    const header = { type: 'match', mode: 'arena', mapSeed: g.mapSeed, difficulty: g.difficulty,
        players: m.seats.map((p, i) => ({ id: p.id, seat: i, civ: p.civilization, model: i ? 'ki' : 'x', ...(i ? { profile: p.profile } : {}) })) };
    return { recs: [header, { type: 'contract', ...hashes() }, ...lines], final: g.stateHash(), step: g.clock.stepNo };
}

test('the worker certifies a recording made under the rules it runs, and draws the world', async () => {
    const { recs, step } = await recording();
    const w = workerRealm();
    const ready = await w.send({ type: 'init', urls: {}, recs });
    assert.equal(ready.type, 'ready', ready.problem);
    assert.deepEqual({ coreHash: ready.coreHash, harnessHash: ready.harnessHash }, hashes(), 'it hashes the texts it runs');
    assert.equal(ready.inputs, recs.length - 2);
    assert.deepEqual(w.spawned, [], 'no timer drives the world');
    const mid = await w.send({ type: 'to', step: 150 });
    assert.equal(mid.step, 150);
    assert.equal(mid.ok, true);
    const end = await w.send({ type: 'to', step: ready.lastInputStep });
    assert.equal(end.ok, true, end.problem);
    assert.equal(end.complete, true);
    assert.equal(end.checked, recs.length - 2);
    assert.equal(end.step, step);
    const own = end.scene.seats[0];
    assert.ok(own.units.length >= 3 && own.buildings.some(b => b.type === 'town_center'));
    // Each building carries its own epoch, so the stage can restyle it at an age-up as the
    // live game does, instead of freezing it at the age it had when first seen.
    assert.ok(own.buildings.every(b => typeof b.age === 'string' && b.age.length), JSON.stringify(own.buildings.map(b => b.age)));
    assert.ok(own.units.every(u => typeof u.id === 'string' && typeof u.x === 'number' && u.type));
    assert.ok(end.scene.nodes.length > 10);
});

test('the worker refuses a recording made under other rules, and names a divergence', async () => {
    const { recs } = await recording();
    const other = recs.map(r => (r.type === 'contract' ? { ...r, coreHash: '0'.repeat(64) } : r));
    const refused = await workerRealm().send({ type: 'init', urls: {}, recs: other });
    assert.equal(refused.type, 'error');
    assert.equal(refused.problem, 'rules changed since recording');

    const target = recs.filter(r => r.kind === 'batch')[0];
    const forged = recs.map(r => (r === target ? { ...r, envelope: { commands: [] } } : r));
    const w = workerRealm();
    const ready = await w.send({ type: 'init', urls: {}, recs: forged });
    assert.equal(ready.type, 'ready');
    const f = await w.send({ type: 'to', step: ready.lastInputStep });
    assert.equal(f.ok, false);
    assert.equal(f.divergedAt, target.step);
    assert.equal(f.divergedSeq, target.seq);
});

test('the worker is not in the rule manifest: presentation of a match, never part of one', () => {
    assert.ok(!manifest.vm.includes('js/resim-worker.js') && !manifest.rules.includes('js/resim.js'));
    assert.ok(Realm);
});

// The analyzer draws on a map it regenerates from the header, and stone and gold are
// laid out around the spawns. Its spawns used a radius of 85 % of the half-size where
// the arena uses 85 % of (half-size - 40), so every rotated stone and gold node stood
// where the match never had one: 11 of 31 in one shipped sample.
test('the analyzer regenerates the arena\'s own map, spawns and nodes alike', async () => {
    for (const seats of [['greek', 'persian'], ['greek', 'persian', 'egyptian'], ['greek', 'persian', 'egyptian', 'babylonian']]) {
        const m = await createMatch({ kind: 'arena', seats, seed: 'analyzer-map-' + seats.length });
        vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/ui.js'), 'utf8') + '\n;globalThis.__UI = UIManager;', m.context);
        const ui = Object.create(m.context.__UI.prototype);
        ui.analyzer = { header: { mapSeed: m.game.mapSeed, difficulty: m.game.difficulty, players: m.seats.map(p => ({ id: p.id })) } };
        const t = ui.anTerrain();
        assert.deepEqual(Array.from(t.spawns, s => [s.x, s.z]), Array.from(m.game.terrain.spawns, s => [s.x, s.z]));
        const key = n => n.type + '@' + Math.round(n.x) + ',' + Math.round(n.z);
        const drawn = new Set(t.resources.map(key));
        const missing = m.game.terrain.resources.filter(n => !drawn.has(key(n)));
        assert.deepEqual(Array.from(missing, key), [], 'every node the match has is on the analyzer map');
        assert.ok(m.game.terrain.resources.length > 100);
    }
});
