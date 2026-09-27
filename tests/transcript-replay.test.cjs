'use strict';
// Re-simulation from a transcript (review #9, WAR side): an arena match recorded as
// step-stamped inputs, rebuilt from its header and replayed input by input, reaches every
// recorded state hash -- and a tampered input is caught at the step it changed.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMatch, Realm } = require('../tools/bench/realm.cjs');
const { replayTranscript } = require('../tools/bench/transcript-replay.cjs');

// A match with one model seat, answered by a script: every 10 s it is shown the board
// and replies. The recorder is a stub that keeps the lines a transcript would.
async function record(seed) {
    const m = await createMatch({ kind: 'arena', seats: ['greek', { civ: 'persian', type: 'ki', profile: 'rusher' }], seed });
    const g = m.game, mgr = g.openAIAIManager;
    const lines = [];
    mgr.transcripts = { matchId: 'test', noteInput: e => lines.push(e) };
    const c = m.scripted(m.seats[0]);
    const answers = [
        { commands: [{ action: 'assign_workers', params: { resourceType: 'wood', count: 2, from: 'idle' } }] },
        { commands: [{ action: 'train_unit', params: { unitType: 'worker' } }, { action: 'explore', params: {} }] },
        { commands: [{ action: 'assign_workers', params: { resourceType: 'food', count: 2, from: 'wood' } }], objective: 'boom' },
        { commands: [{ action: 'explore', params: {} }] },
    ];
    for (const a of answers) {
        m.run(10000);
        c.turnCount++;
        mgr.buildGameStateJSON(c);
        m.run(1500);                // the seat thinks; the world runs on, frame by frame
        mgr.executeTurn(c, a);
    }
    g.setSimSpeed(2);
    m.run(5000);
    const header = { type: 'match', mode: 'arena', mapSeed: g.mapSeed, difficulty: g.difficulty,
        players: m.seats.map((p, i) => ({ id: p.id, seat: i, civ: p.civilization, model: i === 0 ? 'scripted' : 'ki', ...(i ? { profile: p.profile } : {}) })) };
    return { recs: [header, ...lines], final: g.stateHash(), steps: g.clock.stepNo };
}

test('a recorded arena match re-simulates to every recorded state hash', async () => {
    const { recs, final } = await record('replay-a');
    const inputs = recs.filter(r => r.type === 'input');
    assert.deepEqual([...new Set(inputs.map(r => r.kind))].sort(), ['batch', 'observe', 'speed']);
    assert.ok(inputs.every(r => typeof r.stateHash === 'string' && r.stateHash.length === 16));
    const v = await replayTranscript(recs);
    assert.equal(v.ok, true, v.problem);
    assert.equal(v.checked, inputs.length);
    // Order-free: the replay sorts by step and sequence, as a flushed file may not.
    const shuffled = [recs[0], ...recs.slice(1).reverse()];
    assert.equal((await replayTranscript(shuffled)).ok, true);
    assert.ok(final);
});

test('a changed answer diverges at the step it was given', async () => {
    const { recs } = await record('replay-b');
    const batches = recs.filter(r => r.kind === 'batch');
    const target = batches[1];
    const forged = recs.map(r => r === target ? { ...r, envelope: { commands: [{ action: 'assign_workers', params: { resourceType: 'gold', count: 3, from: 'idle' } }] } } : r);
    const v = await replayTranscript(forged);
    assert.equal(v.ok, false);
    assert.equal(v.divergedAt, target.step, v.problem);
    // The inputs before it were all reached.
    assert.equal(v.checked, recs.filter(r => r.type === 'input' && (r.step < target.step || (r.step === target.step && r.seq < target.seq))).length);
});

test('every observation carries the seat\'s turn counter', async () => {
    const { recs } = await record('replay-c');
    const obs = recs.filter(r => r.kind === 'observe');
    assert.deepEqual(obs.map(r => r.turnCount), [1, 2, 3, 4]);
});

test('a transcript without inputs, or of another mode, says so', async () => {
    assert.match((await replayTranscript([{ type: 'match', players: [] }])).problem, /records no inputs/);
    assert.match((await replayTranscript([{ type: 'match', mode: 'campaign', players: [] }])).problem, /only arena/);
    assert.match((await replayTranscript([])).problem, /no match header/);
});

// The live path, not direct calls: a model seat started by the arena itself, asked by
// the harness on frames, answered with tool calls by a stub endpoint -- lockstep
// turn-based, the path with the most machinery between an answer and the world.
test('a match played through the live turn path re-simulates, and a dropped answer diverges', async () => {
    const answers = [
        [['assign_workers', { resourceType: 'wood', count: 2, from: 'idle' }]],
        [['train_unit', { unitType: 'worker' }], ['explore', {}]],
        [['assign_workers', { resourceType: 'food', count: 2, from: 'wood' }], ['explore', {}]],
    ];
    let n = 0;
    const json = body => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    const stubFetch = async url => {
        if (String(url).includes('/models')) return json({ data: [{ id: 'stub' }] });
        const a = answers[n++ % answers.length];
        return json({ id: 'x', object: 'chat.completion', model: 'stub', usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
            choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
                tool_calls: a.map(([name, params], i) => ({ id: `c${n}_${i}`, type: 'function', function: { name, arguments: JSON.stringify(params) } })) } }] });
    };
    // A Math.random seed the replay does not share: a browser's is unseeded, so the world
    // must not draw from it.
    const realm = new Realm({ seed: 987654321 });
    Object.assign(realm.context, { AbortController, setTimeout, clearTimeout, fetch: stubFetch, Response });
    const lines = [];
    const recorder = new Proxy({ matchId: 'live', noteInput: e => lines.push(e) }, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : () => {}) });
    realm.context.TranscriptRecorder = function () { return recorder; };
    const g = realm.game;
    const started = g._startArenaFromSetup({ seed: 'live-path', difficulty: 'easy', turnBased: true, lockstepSliceMs: 2000,
        setup: [{ civ: 'greek', type: 'llm', connection: { endpoint: 'http://stub.test/v1', model: 'stub', name: 'Stub' } }, { civ: 'persian', type: 'ki', profile: 'standard' }] });
    let done = false; started.then(() => { done = true; }, () => { done = true; });
    for (let i = 0; !done && i < 2000; i++) { realm.rafQueue.splice(0).forEach(cb => cb()); await new Promise(r => setImmediate(r)); }
    assert.ok(g.gameStarted);
    g.openAIAIManager.transcripts = recorder;
    for (let i = 0; i < 1500; i++) { realm.frame(); if (i === 600) g.setSimSpeed(2); await new Promise(r => setImmediate(r)); }
    const batches = lines.filter(l => l.kind === 'batch');
    assert.ok(batches.length >= 5 && lines.some(l => l.kind === 'speed'), `recorded ${batches.length} answers`);
    const header = { type: 'match', mode: 'arena', mapSeed: g.mapSeed, difficulty: g.difficulty,
        players: g.aiManager.aiPlayers.map((p, i) => ({ id: p.id, civ: p.civilization, model: i ? 'ki' : 'stub', ...(i ? { profile: p.profile } : {}) })) };
    const v = await replayTranscript([header, ...lines]);
    assert.equal(v.ok, true, v.problem);
    assert.equal(v.checked, lines.length);
    // An answer that changed the world, dropped: caught at its own step.
    const i = lines.findIndex((l, k) => l.kind === 'batch' && k > 0 && lines[k - 1].stateHash !== l.stateHash);
    assert.ok(i > 0, 'some answer changed the world');
    const forged = lines.map((l, k) => (k === i ? { ...l, envelope: { commands: [] } } : l));
    const f = await replayTranscript([header, ...forged]);
    assert.equal(f.ok, false);
    assert.equal(f.divergedAt, lines[i].step);
});
