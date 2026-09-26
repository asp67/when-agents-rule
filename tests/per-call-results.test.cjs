// Each tool call is answered with its own result. The combined outcome used to be
// replayed as the result of the FIRST call; when that call was the plan (28% of
// multi-call turns in the samples), the plan "returned" the commands' results.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
// Recorded matches are not deployed everywhere (the platform server has none), so a
// test that reads them reports as skipped there rather than as a failure.
const HAS_SAMPLES = require('node:fs').existsSync(require('node:path').join(__dirname, '..', 'samples', 'index.json'));
const NEEDS_SAMPLES = { skip: !HAS_SAMPLES && 'samples/ not present' };
const root = path.resolve(__dirname, '..');

function manager() {
    const scope = { console: { log() {}, warn() {}, error() {} } };
    vm.createContext(scope);
    vm.runInContext(fs.readFileSync(path.join(root, 'js/openai-ai.js'), 'utf8'), scope);
    return vm.runInContext('OpenAIAIManager', scope);
}
const call = (name, args, raw) => ({ id: name + Math.random(), name, args: raw || JSON.stringify(args) });

test('plan first: the plan is answered as saved and each command gets its own result', () => {
    const M = manager();
    const per = M.resultsPerCall([call('plan', { objective: 'Expand' }), call('train_unit', { unitType: 'worker' }),
        call('build_structure', { buildingType: 'house' })],
        'Command 1/2: OK - Training worker.\nCommand 2/2: [ERROR] Cannot afford house.');
    assert.deepEqual([...per], ['OK - Plan saved.', 'OK - Training worker.', '[ERROR] Cannot afford house.']);
});

test('a single command without numbering, and an excess command, map in order', () => {
    const M = manager();
    assert.deepEqual([...M.resultsPerCall([call('wait', {}), call('plan', { plan: ['a'] })], 'OK - Waited.')],
        ['OK - Waited.', 'OK - Plan saved.']);
    const four = ['wait', 'wait', 'wait', 'wait'].map(n => call(n, {}));
    const out = 'Command 1/4: OK - a\nCommand 2/4: OK - b\nCommand 3/4: OK - c\nCommand 4/4: [ERROR] Command 4 was not executed';
    assert.equal(M.resultsPerCall(four, out)[3], '[ERROR] Command 4 was not executed');
});

test('unusable calls take the results after the commands, as the envelope orders them', () => {
    const M = manager();
    const per = M.resultsPerCall([call('fly', { x: 1 }), call('wait', {})],
        'Command 1/2: OK - Waited.\nCommand 2/2: [ERROR] One of your calls could not be parsed');
    assert.deepEqual([...per], ['[ERROR] One of your calls could not be parsed', 'OK - Waited.']);
});

test('plan-only, a repeated plan call and an empty plan call are answered for what happened', () => {
    const M = manager();
    const per = M.resultsPerCall([call('plan', { objective: 'A' }), call('plan', { objective: 'B' }), call('plan', {})],
        'OK - Plan saved. No game commands were issued.');
    assert.equal(per[0], 'OK - Plan saved. No game commands were issued.');
    assert.match(per[1], /^Not applied: an earlier plan call/);
    assert.match(per[2], /^Not applied: a plan call needs/);
});

test('counts that do not line up keep the combined answer on the first call', () => {
    const M = manager();
    const calls = [call('wait', {}), call('wait', {})];
    assert.equal(M.resultsPerCall(calls, 'Command 1/3: a\nCommand 2/3: b\nCommand 3/3: c'), null);
    const answers = M.answerCalls(calls, 'Command 1/3: a\nCommand 2/3: b\nCommand 3/3: c');
    assert.match(answers[1].content, /covered by the result of/);
    // An unresolved turn says so on every call.
    assert.ok(M.answerCalls(calls, 'not resolved', true).every(a => a.content === 'not resolved'));
});

test('every multi-call turn in the shipped samples maps, apart from builds before excess results', NEEDS_SAMPLES, () => {
    const M = manager();
    let multi = 0, mapped = 0;
    for (const f of fs.readdirSync(path.join(root, 'samples')).filter(f => f.endsWith('.jsonl'))) {
        for (const line of fs.readFileSync(path.join(root, 'samples', f), 'utf8').split('\n')) {
            if (!line) continue;
            const r = JSON.parse(line);
            const tc = r.assistant && r.assistant.tool_calls;
            if (r.type || !Array.isArray(tc) || tc.length < 2 || typeof r.harnessResult !== 'string') continue;
            const calls = tc.map((c, i) => ({ id: i, name: (c.function || {}).name,
                args: typeof (c.function || {}).arguments === 'string' ? c.function.arguments : JSON.stringify((c.function || {}).arguments || {}) }));
            multi++;
            const per = M.resultsPerCall(calls, r.harnessResult);
            if (!per) continue;
            mapped++;
            calls.forEach((c, i) => { if (c.name !== 'plan') assert.ok(!/^OK - Plan saved\.$/.test(per[i]), 'a command answered as a plan'); });
        }
    }
    assert.ok(multi > 1000, 'fixture size ' + multi);
    assert.ok(mapped / multi > 0.99, mapped + ' of ' + multi);
});
