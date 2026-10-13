// WAR Bench bundles (review #8 step 7): a recorded run verifies by replay on the rules
// it embeds, with no model called -- and tampering is caught even by a forger who
// re-computes the whole hash chain.
const test = require('node:test'), assert = require('node:assert/strict');
const B = require('../tools/bench/bundle.cjs');
const S = require('../tools/bench/scenario.cjs');
const { BASELINES } = require('../tools/bench/baselines.cjs');
const { modelPolicy } = require('../tools/bench/runner.cjs');

const ALL = S.loadAll();
const small = { scenarios: ALL, variants: ['identity', 'mirrorX'] };

// Rebuild the chain after changing one record: the forger's move.
function forge(lines, change) {
    let prev = null;
    return lines.map((line, i) => {
        const r = JSON.parse(line);
        change(r, i);
        r.prev = prev;
        const out = JSON.stringify(r);
        prev = B.sha(out);
        return out;
    });
}

let baseline;
test.before(async () => {
    baseline = await B.record(Object.assign({ policy: { name: 'random-valid', kind: 'baseline', make: BASELINES['random-valid'] } }, small));
});

test('a baseline bundle verifies, and round-trips through gzip', async () => {
    const file = B.write(baseline, require('node:path').join(require('node:os').tmpdir(), 'war-bench-test.warbench.jsonl.gz'));
    const v = await B.verify(B.readLines(file));
    assert.deepEqual(v.problems, []);
    assert.equal(v.ok, true);
    assert.equal(v.episodes, ALL.length * 2);
    const head = JSON.parse(baseline[0]);
    assert.equal(head.schema, 'war-bench-bundle-v1');
    assert.equal(head.coreHash, B.coreHashOf(B.ruleSources()));
});

test('an edited line breaks the chain', async () => {
    const lines = baseline.slice();
    const i = lines.findIndex(l => JSON.parse(l).type === 'round');
    lines[i] = lines[i].replace('"round":1', '"round":1 ');
    const v = await B.verify(lines);
    assert.equal(v.ok, false);
    assert.ok(v.problems.some(p => /chain broken/.test(p)), v.problems.join('; '));
});

test('a re-chained forgery is caught by the replay: a changed answer, a changed result', async () => {
    const firstAnswered = baseline.findIndex(l => { const r = JSON.parse(l); return r.type === 'round' && Array.isArray(r.answer) && r.answer.length; });
    const changedAnswer = forge(baseline, (r, i) => { if (i === firstAnswered) r.answer = [{ action: 'wait', params: {} }]; });
    let v = await B.verify(changedAnswer);
    assert.equal(v.ok, false);
    assert.ok(v.problems.some(p => /results differ|world differs|state differs|outcome|score/.test(p)), v.problems.join('; '));
    const changedResult = forge(baseline, (r, i) => { if (i === firstAnswered) r.results = 'OK - everything went perfectly.'; });
    v = await B.verify(changedResult);
    assert.equal(v.ok, false);
    assert.ok(v.problems.some(p => /results differ/.test(p)));
});

test('a swapped rule file is caught, even with its blob and the chain rebuilt', async () => {
    const units = JSON.parse(baseline[0]).files['js/units.js'];
    const text = JSON.parse(baseline.find(l => { const r = JSON.parse(l); return r.type === 'blob' && r.sha256 === units; })).text;
    const swapped = text.replace('health: 40,', 'health: 41,'), h = B.sha(swapped);
    const lines = forge(baseline, r => {
        if (r.type === 'header') r.files['js/units.js'] = h;
        if (r.type === 'blob' && r.sha256 === units) { r.sha256 = h; r.text = swapped; }
    });
    const v = await B.verify(lines);
    assert.equal(v.ok, false);
    assert.ok(v.problems.some(p => /core hash/.test(p)), v.problems.join('; '));
});

test('a model run verifies with no model reachable, and a forged response is caught', async () => {
    const CFG = { name: 'stub', endpoint: 'http://127.0.0.1:9/v1', model: 'stub-model', maxTokens: 512, reqOpts: { temperature: 0.4 } };
    // A stub "model" that plays each scenario's reference as tool calls.
    const make = (s, v, a, wire) => {
        const inst = S.instantiate(s, v);
        let round = 0;
        const answer = async () => {
            round++;
            const r = inst.reference.find(x => x.round === round);
            const calls = (r ? r.commands : [{ action: 'wait', params: {} }]).map((c, i) =>
                ({ id: 'c' + i, type: 'function', function: { name: c.action, arguments: JSON.stringify(c.params) } }));
            const body = JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: calls }, finish_reason: 'tool_calls' }], usage: {} });
            return { ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => body };
        };
        return modelPolicy(CFG, { fetchImpl: B.recordingFetch(answer, wire) });
    };
    const lines = await B.record({ scenarios: ALL, variants: ['identity'], policy: { name: 'stub', kind: 'model', config: CFG, make } });
    const close = JSON.parse(lines[lines.length - 1]);
    assert.equal(close.score.success.k, ALL.filter(s => !s.graded).length, 'the stub plays the reference');
    assert.ok(close.score.meanScore.mean >= 0.99, 'the graded search too: ' + close.score.meanScore.mean);
    const v = await B.verify(lines);   // the replay's fetch never reaches a network
    assert.deepEqual(v.problems, []);
    // Forge the first response: the replay executes different commands from it.
    const i = lines.findIndex(l => { const r = JSON.parse(l); return r.type === 'round' && r.wire && r.wire.length; });
    const forged = forge(lines, (r, k) => {
        if (k === i) r.wire[0].response = JSON.stringify({ choices: [{ message: { role: 'assistant', content: null,
            tool_calls: [{ id: 'x', type: 'function', function: { name: 'wait', arguments: '{}' } }] }, finish_reason: 'tool_calls' }], usage: {} });
    });
    const w = await B.verify(forged);
    assert.equal(w.ok, false);
    assert.ok(w.problems.length > 0);
});

// b1097: a request that fails -- a dropped connection, the ceiling's abort -- is recorded
// and fails again at the same point of the replay. Before, it left no trace, so the
// replay served every later reply one round early (asp67's first FP8 run: round 2 went
// unanswered, and verify reported round 3 onwards as different).
test('a failed request is recorded and replayed as a failure, keeping the rounds in step', async () => {
    const CFG = { name: 'stub', endpoint: 'http://127.0.0.1:9/v1', model: 'stub-model', maxTokens: 512 };
    const s = ALL.find(x => x.id === 'strike-01');
    const make = (sc, v, a, wire) => {
        const inst = S.instantiate(sc, v);
        let n = 0;
        const answer = async () => {
            n++;
            if (n === 2) throw new TypeError('fetch failed');
            const r = inst.reference.find(x => x.round === n);
            const calls = (r ? r.commands : [{ action: 'wait', params: {} }]).map((c, i) =>
                ({ id: 'c' + i, type: 'function', function: { name: c.action, arguments: JSON.stringify(c.params) } }));
            const body = JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: calls }, finish_reason: 'tool_calls' }], usage: {} });
            return { ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => body };
        };
        return modelPolicy(CFG, { fetchImpl: B.recordingFetch(answer, wire) });
    };
    const lines = await B.record({ scenarios: [s], variants: ['identity'], policy: { name: 'stub', kind: 'model', config: CFG, make } });
    const rounds = lines.map(l => JSON.parse(l)).filter(r => r.type === 'round');
    assert.equal(rounds[1].answer, null, 'round 2 went unanswered');
    assert.deepEqual(rounds[1].wire.map(w => w.error && w.error.message), ['fetch failed']);
    const v = await B.verify(lines);
    assert.deepEqual(v.problems, []);
});

// b1097: the bundle carries the bench core that played it, and verify replays on that
// core -- a later change to the bench cannot make an honest old run look forged.
test('verify replays on the bench core the bundle recorded', async () => {
    const lines = await B.record({ scenarios: [ALL.find(x => x.id === 'ford-01')], variants: ['identity'], policy: { name: 'scripted', kind: 'baseline', make: () => S.referencePolicy() } });
    const head = JSON.parse(lines[0]);
    assert.ok(head.files[B.CORE_FILE], 'the core is embedded');
    // Today's core on disk could change tomorrow; the replay must not read it. A core
    // that differs in one comment hashes differently and is still the one replayed.
    const blob = lines.map(l => JSON.parse(l)).find(r => r.type === 'blob' && r.sha256 === head.files[B.CORE_FILE]);
    assert.equal(typeof B.loadCore(blob.text).play, 'function');
    assert.deepEqual((await B.verify(lines)).problems, []);
});
