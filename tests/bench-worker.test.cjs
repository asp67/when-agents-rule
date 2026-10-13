'use strict';
// The browser's benchmark worker (js/bench-worker.js, b1091), run as it runs in a page:
// the worker script in a global of its own, loading the texts it is sent from blob URLs.
// importScripts, blob URLs and the network are stood in for; everything else is the
// worker's own code. The test that matters: a run the browser records is a bundle the
// Node verifier accepts -- the same states, the same worlds, the same score.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const W = require('../js/bench-core.js');
const S = require('../tools/bench/scenario.cjs');
const B = require('../tools/bench/bundle.cjs');

const ROOT = path.resolve(__dirname, '..');
const lf = s => s.split('\r\n').join('\n');
const manifest = require('../js/manifest.js');
// What the page sends: the texts it loaded, line endings normalized.
const TEXTS = Object.fromEntries(['js/bench-core.js', 'js/manifest.js', ...manifest.vm]
    .map(f => [f, lf(fs.readFileSync(path.join(ROOT, f), 'utf8'))]));

function worker(fetchImpl = async () => { throw new Error('no network here'); }) {
    const blobs = new Map(), out = [];
    const ctx = vm.createContext({
        console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
        setTimeout, clearTimeout, AbortController, Math, Date, performance, Promise, Proxy, Uint8ClampedArray, JSON,
        Blob: class { constructor(parts) { this.text = parts.join(''); } },
        URL: { createObjectURL: b => { const k = 'blob:' + blobs.size; blobs.set(k, b.text); return k; } },
        fetch: fetchImpl,
        // As a page receives it: a structured clone, made in this realm.
        postMessage: m => out.push(structuredClone(m)),
    });
    ctx.self = ctx;
    ctx.importScripts = (...urls) => urls.forEach(u => vm.runInContext(blobs.get(u), ctx, { filename: u }));
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/bench-worker.js'), 'utf8'), ctx, { filename: 'js/bench-worker.js' });
    return async data => { await ctx.onmessage({ data }); return out; };
}

// A run as the page records it: the worker plays each episode, the core writes the bundle.
async function browserRun(scenarios, policy, makeFetch, iterations = 1) {
    const sources = Object.fromEntries(Object.entries(TEXTS).filter(([f]) => f !== 'js/bench-core.js'));
    const chain = W.bundleChain(B.sha);
    W.bundleOpen(chain, { sha: B.sha, sources, scenarios, policy: { name: policy.name || policy.cfg.name, kind: policy.kind, config: policy.cfg || null },
        coreHash: B.coreHashOf(sources), attempts: iterations });
    const results = [], messages = [];
    for (const s of scenarios) for (let i = 1; i <= iterations; i++) {
        const variant = s.variants[(i - 1) % s.variants.length];
        const out = await worker(makeFetch ? makeFetch(s, variant) : undefined)({ type: 'run', texts: TEXTS, scenario: s, variant, attempt: i,
            policy, ceilingMs: W.CEILING_MS, deadline: null });
        messages.push(...out);
        const done = out.find(m => m.type === 'done');
        assert.ok(done, 'the worker finished: ' + JSON.stringify(out.find(m => m.type === 'error')));
        W.bundleEpisode(chain, { id: s.id, variant, attempt: i }, done.rounds.map(({ type, ...r }) => r), done.result, done.snapshot);
        results.push(done.result);
    }
    W.bundleClose(chain, results);
    return { lines: chain.lines, results, messages };
}

const ALL = S.loadAll();

test('the worker plays an episode exactly as the Node realm does', async () => {
    const s = ALL.find(x => x.id === 'strike-01');
    const node = await B.record({ scenarios: [s], variants: ['rot90'], policy: { name: 'scripted', kind: 'baseline', make: () => S.referencePolicy() } });
    const out = await worker()({ type: 'run', texts: TEXTS, scenario: s, variant: 'rot90', attempt: 1,
        policy: { kind: 'baseline', name: 'scripted' }, ceilingMs: W.CEILING_MS, deadline: null });
    const done = out.find(m => m.type === 'done');
    assert.ok(done, JSON.stringify(out));
    const nodeRounds = node.map(l => JSON.parse(l)).filter(r => r.type === 'round');
    assert.equal(done.rounds.length, nodeRounds.length);
    done.rounds.forEach((r, i) => {
        assert.equal(r.stateHash, nodeRounds[i].stateHash, `round ${r.round}: the state sent`);
        assert.equal(r.worldHash, nodeRounds[i].worldHash, `round ${r.round}: the world after the step`);
        assert.equal(r.results, nodeRounds[i].results);
    });
    assert.equal(done.result.outcome, 'success');
    // A progress message per round, for the page's bar.
    assert.deepEqual(out.filter(m => m.type === 'round').map(m => m.round), done.rounds.map(r => r.round));
});

test('a browser-recorded run verifies in Node: baselines and a model on the wire', async () => {
    const base = await browserRun(ALL, { kind: 'baseline', name: 'random-valid' }, null, 2);
    const v1 = await B.verify(base.lines);
    assert.equal(v1.ok, true, v1.problems.join('\n'));
    assert.equal(v1.episodes, ALL.length * 2);

    // A model that answers with the reference, as tool calls.
    const cfg = { name: 'stub', endpoint: 'http://127.0.0.1:9/v1', model: 'stub-model', maxTokens: 512, reqOpts: { temperature: 0.4 } };
    const makeFetch = (s, variant) => {
        const inst = W.instantiate(s, variant);
        let round = 0;
        return async (url, init) => {
            round++;
            const r = inst.reference.find(x => x.round === round);
            const calls = (r ? r.commands : [{ action: 'wait', params: {} }]).map((c, i) =>
                ({ id: 'c' + i, type: 'function', function: { name: c.action, arguments: JSON.stringify(c.params) } }));
            const body = JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: calls }, finish_reason: 'tool_calls' }],
                usage: { prompt_tokens: 100, completion_tokens: 10 } });
            return { ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => body, json: async () => JSON.parse(body) };
        };
    };
    const model = await browserRun(ALL, { kind: 'model', cfg }, makeFetch);
    assert.deepEqual(model.results.map(r => r.outcome === 'graded' ? (r.score >= 0.95 ? 'full marks' : r.score) : r.outcome),
        ALL.map(s => s.graded ? 'full marks' : 'success'));
    const v2 = await B.verify(model.lines);
    assert.equal(v2.ok, true, v2.problems.join('\n'));
    // The wire is in the bundle, and the answers were timed.
    const rounds = model.lines.map(l => JSON.parse(l)).filter(r => r.type === 'round');
    assert.ok(rounds.every(r => r.wire && r.wire.length === 1 && Number.isFinite(r.ms)));
});

test('the wall-clock limit stops an episode, and the verifier replays it to the same round', async () => {
    const s = ALL.find(x => x.id === 'strike-01');
    const sources = Object.fromEntries(Object.entries(TEXTS).filter(([f]) => f !== 'js/bench-core.js'));
    // A deadline already behind us: the episode is stopped before its first round.
    const out = await worker()({ type: 'run', texts: TEXTS, scenario: s, variant: 'identity', attempt: 1,
        policy: { kind: 'baseline', name: 'scripted' }, ceilingMs: W.CEILING_MS, deadline: Date.now() - 1 });
    const done = out.find(m => m.type === 'done');
    assert.deepEqual([done.result.outcome, done.result.stopped, done.result.rounds], ['failure', 'time', 0]);
    const chain = W.bundleChain(B.sha);
    W.bundleOpen(chain, { sha: B.sha, sources, scenarios: [s], policy: { name: 'scripted', kind: 'baseline' }, coreHash: B.coreHashOf(sources) });
    W.bundleEpisode(chain, { id: s.id, variant: 'identity', attempt: 1 }, [], done.result, done.snapshot);
    W.bundleClose(chain, [done.result]);
    const v = await B.verify(chain.lines);
    assert.equal(v.ok, true, v.problems.join('\n'));
});
