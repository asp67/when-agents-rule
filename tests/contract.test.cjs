// "A result belongs to (model x stack x settings)" has to be checkable. The contract
// line fingerprints what each seat was offered; WarConditions holds the one rule for
// when two results are comparable.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path'), crypto = require('node:crypto');
// Recorded matches are not deployed everywhere (the platform server has none), so a
// test that reads them reports as skipped there rather than as a failure.
const HAS_SAMPLES = require('node:fs').existsSync(require('node:path').join(__dirname, '..', 'samples', 'index.json'));
const NEEDS_SAMPLES = { skip: !HAS_SAMPLES && 'samples/ not present' };
const root = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

function context() {
    const scope = { console, getCivilization: id => ({ name: id, color: 0xffff00, bonus: { description: 'x' } }) };
    vm.createContext(scope);
    for (const f of ['js/manifest.js', 'js/sha256.js', 'js/conditions.js', 'js/openai-ai.js']) vm.runInContext(read(f), scope);
    vm.runInContext('this.W = WarConditions; this.M = OpenAIAIManager;', scope);
    // No fetch in Node: read the same files from disk, as the page would load them.
    scope.W.source = async f => scope.W.lf(read(f));
    return scope;
}

test('the comparability rule needs all four parts equal', () => {
    const { W } = context();
    const a = { coreHash: 'c', familyHash: 'f', rulesId: 'classic@0', protocol: 'real-time' };
    assert.equal(W.comparable(a, { ...a }), true);
    for (const k of Object.keys(a)) assert.equal(W.comparable(a, { ...a, [k]: 'other' }), false, k);
    assert.equal(W.comparable(a, { ...a, coreHash: null }), false);
    assert.equal(W.id({ ...a, familyHash: null }), null);
    assert.match(W.id(a), /^[0-9a-f]{12}$/);
    assert.equal(W.canon({ b: 1, a: [2, { d: 1, c: 2 }] }), '{"a":[2,{"c":2,"d":1}],"b":1}');
});

test('coreHash is the LF-normalized simulation sources, as Node hashes them', async () => {
    const { W } = context();
    const { coreHash, harnessHash } = await W.sourceHashes();
    const lf = t => t.replace(/\r\n/g, '\n');
    assert.equal(coreHash, crypto.createHash('sha256').update(W.CORE_FILES.map(f => lf(read(f))).join('\n')).digest('hex'));
    assert.equal(harnessHash, crypto.createHash('sha256').update(lf(read('js/openai-ai.js'))).digest('hex'));
});

test('seat contracts: one family across civilizations and languages, a new one for an edited prompt, no secrets', async () => {
    const scope = context();
    const manager = new scope.M({ difficulty: 'easy', spectatorMode: true, aiManager: { aiPlayers: [{}, {}, {}] } });
    const seat = (id, civ, model) => ({ id, aiPlayer: { id, civilization: civ, seat: id.length },
        model: Object.assign({ provider: 'openai', language: 'en', endpoint: 'http://10.0.0.5:8024/v1',
                               auth: { type: 'bearer', key: 'sk-SECRET-KEY' } }, model) });
    manager.aiControllers = [seat('p1', 'greek', {}), seat('p22', 'persian', { language: 'de' }),
                             seat('p333', 'yamato', { customSystemPrompt: 'You are {{civilization}}. Win.' })];
    let written = null;
    manager.transcripts = { matchId: 'm', addHeaderLine: r => { written = r; } };
    const rec = await manager.writeContract();
    assert.equal(written, rec);
    assert.equal(rec.type, 'contract'); assert.equal(rec.rulesId, 'classic@0');
    const [a, b, c] = rec.seats;
    assert.equal(a.familyHash, b.familyHash, 'civilization and language are seat-specific');
    assert.notEqual(a.hash, b.hash);
    assert.notEqual(a.familyHash, c.familyHash, 'an edited prompt is a different contract');
    // Texts once, by hash: three seats on one tool dialect store it once.
    assert.equal(a.tools, b.tools);
    assert.equal(rec.texts[a.tools].length, scope.M.TOOLS.length);
    assert.ok(rec.texts[a.system].includes('greek'));
    const json = JSON.stringify(rec);
    for (const secret of ['sk-SECRET-KEY', '10.0.0.5', 'endpoint', 'bearer', 'auth'])
        assert.ok(!json.includes(secret), secret);
});

test('the analyzer reads the contract line and does not count it as a marker', () => {
    const scope = vm.createContext({ console });
    vm.runInContext(read('js/analyzer.js') + '\nthis.T = TranscriptAnalyzer;', scope);
    const a = new scope.T({});
    a.load([{ type: 'match', schema: 'war-transcript/2', players: [] }, { type: 'contract', seats: [] }]
        .map(x => JSON.stringify(x)).join('\n'), 'x.jsonl');
    assert.equal(a.contract.type, 'contract');
    assert.equal(a.markers.length, 0);
});

test('every action in the ACTIONS table has an executor, and every executor an entry', () => {
    const src = read('js/openai-ai.js');
    const start = src.indexOf('    executeAction(controller, actionData, validationError = null) {');
    const body = src.slice(start, src.indexOf('\n    }\n', src.indexOf('switch (action)', start)));
    const cases = new Set([...body.matchAll(/case '([a-z_]+)':/g)].map(m => m[1]));
    const { M } = context();
    const declared = new Set(M.ACTION_NAMES);
    assert.deepEqual([...declared].filter(a => !cases.has(a)), [], 'declared but never executed');
    assert.deepEqual([...cases].filter(a => !declared.has(a)), [], 'executed but never offered');
    for (const t of M.TOOLS) assert.ok(declared.has(t.function.name) || t.function.name === 'plan', t.function.name);
});

test('recorded states conform to game-state-schema.json, and unknown schema keywords fail', NEEDS_SAMPLES, () => {
    const { validate, undocumented } = require('./lib/schema-check.cjs');
    const schema = JSON.parse(read('game-state-schema.json'));
    for (const f of ['samples/2026-09-07_gemini-flash-deepseek-v4-gpt5.6-qwen3.8_89min.jsonl',
                     'samples/2026-09-09_gemini3.8-deepseek-v4-gpt5.6-qwen3.8_121min.jsonl']) {
        const states = read(f).split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(r => !r.type && r.state).map(r => r.state);
        assert.ok(states.length > 100);
        const problems = new Set();
        for (const s of states) {
            validate(schema, s).forEach(e => problems.add(e.replace(/\[\d+\]/g, '[]')));
            undocumented(schema, s).forEach(k => problems.add('undocumented ' + k));
        }
        assert.deepEqual([...problems].slice(0, 10), [], f);
    }
    assert.throws(() => validate({ type: 'object', patternProperties: {} }, {}), /not implemented/);
});

test('the fixed per-turn prompt stays under its token tripwires', () => {
    const { M } = context();
    const budget = JSON.parse(read('tests/prompt-budget.json'));
    const system = Math.ceil(M.defaultSystemPrompt().length / 4);
    const tools = Math.ceil(JSON.stringify(M.TOOLS).length / 4);
    assert.ok(system <= budget.systemPromptTokens, `system prompt ~${system} tokens > ${budget.systemPromptTokens}`);
    assert.ok(tools <= budget.toolSchemaTokens, `tool schemas ~${tools} tokens > ${budget.toolSchemaTokens}`);
});
