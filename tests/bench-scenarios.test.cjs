// WAR Bench scenarios (war-scenario-v1, review #8 step 3). Every scenario must be
// solvable -- its reference solution succeeds in every variant -- and must not be
// solvable by standing still; the format is validated, the variants move everything
// consistently, and an episode is the same every time it is played.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const S = require('../tools/bench/scenario.cjs');

const ALL = S.loadAll();

test('the scenario set: three smoke families, unique ids, filed under their family', () => {
    assert.deepEqual([...new Set(ALL.map(s => s.family))].sort(), ['grounded-target', 'production-recovery', 'spatial-guard']);
    assert.equal(new Set(ALL.map(s => s.id)).size, ALL.length);
    const dir = path.join(__dirname, '../benchmarks/scenarios');
    for (const s of ALL) assert.ok(fs.existsSync(path.join(dir, s.family, s.id + '.json')), s.id);
});

for (const s of ALL) {
    test(`${s.id}: the reference solves every variant, and doing nothing solves none`, async () => {
        for (const v of s.variants) {
            const ref = await S.play(s, v, S.referencePolicy());
            assert.equal(ref.outcome, 'success', `${s.id}/${v}: reference ${ref.outcome} after ${ref.rounds} rounds`);
            for (const e of ref.log) if (e.results) assert.doesNotMatch(e.results, /\[ERROR\]/, `${s.id}/${v} round ${e.round}: ${e.results}`);
            const noop = await S.play(s, v, S.noopPolicy());
            assert.equal(noop.outcome, 'failure', `${s.id}/${v}: standing still ${noop.outcome}`);
        }
    });
}

test('an episode is the same every time it is played', async () => {
    const s = ALL.find(x => x.id === 'ford-01');
    const a = await S.play(s, 'rot90', S.referencePolicy()), b = await S.play(s, 'rot90', S.referencePolicy());
    assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test('a variant moves the board, the orders, the predicates and the objective together', async () => {
    const s = ALL.find(x => x.id === 'strike-01');
    for (const v of Object.keys(S.VARIANTS)) {
        const ep = await S.begin(s, v);
        const t = ep.realm.tags.target;
        const [x, z] = S.VARIANTS[v](40, 20);
        assert.deepEqual([t.x, t.z], [x, z], v);
        assert.ok(ep.objective.includes(`(${x}, ${z})`), v + ': ' + ep.objective);
        const ref = ep.inst.reference[0].commands[0].params;
        assert.deepEqual([ref.targetX, ref.targetZ], [x, z], v);
    }
});

test('validation refuses what the format does not allow', () => {
    const base = JSON.parse(JSON.stringify(ALL.find(x => x.id === 'strike-01')));
    const bad = mutate => { const c = JSON.parse(JSON.stringify(base)); mutate(c); return () => S.validate(c); };
    assert.throws(bad(c => { c.schema = 'war-scenario-v0'; }), /schema/);
    assert.throws(bad(c => { c.success.predicate = { destroyed: 'nothing-tagged-so' }; }), /unknown tag/);
    assert.throws(bad(c => { c.success.predicate = { count: { owner: 'subject', kind: 'unit' }, op: '~', value: 1 }; }), /op/);
    assert.throws(bad(c => { c.success.predicate = { eval: 'true' }; }), /unknown operator/);
    assert.throws(bad(c => { c.variants = ['sideways']; }), /unknown variant/);
    assert.throws(bad(c => { c.reference = []; }), /reference/);
    assert.throws(bad(c => { c.reference[0].round = 99; }), /round/);
    assert.throws(bad(c => { c.objective = 'Go to ({{point:nowhere.x}}, 0)'; }), /unknown point/);
});

test('a scenario prompt replaces the victory paragraph and nothing else', () => {
    const scope = vm.createContext({ console });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/openai-ai.js'), 'utf8') + ';globalThis.M = OpenAIAIManager;', scope);
    const M = scope.M, base = M.defaultSystemPrompt(), obj = 'Destroy the barracks at (40, 20).';
    const sp = M.scenarioSystemPrompt(obj);
    assert.ok(base.includes(M.VICTORY_PARAGRAPH));
    assert.ok(!sp.includes(M.VICTORY_PARAGRAPH));
    assert.equal(sp.replace('Your objective in this scenario:\n' + obj, M.VICTORY_PARAGRAPH), base);
});
