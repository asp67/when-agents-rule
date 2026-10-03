// The lineup card shows, before the first turn, the facts that decide how a result may
// be read. Built from the setup, then from the transcript header -- so once the header
// exists, the card must show what the header says, not what the setup screen said.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');

function ui() {
    const scope = { console, t: k => k, document: { getElementById: () => null } };
    vm.createContext(scope);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/ui.js'), 'utf8') + '\nthis.UI = UIManager;', scope);
    return Object.create(scope.UI.prototype);
}
const setup = [
    { civ: 'greek', type: 'llm', connection: { name: 'GLM', model: 'GLM5.3', contextSize: 65536, reasoning: 'high',
        toolFallback: true, preflight: { ok: true, code: 'ok' }, lanes: 1 } },
    { civ: 'persian', type: 'ki' }
];

test('before the header: setup values, and the server not yet asked', () => {
    const [m, k] = ui().lineupRows(setup, null);
    assert.equal(m.servedBy, undefined);
    assert.equal(m.context, 65536); assert.equal(m.reasoning, 'high'); assert.equal(m.soft, true);
    assert.equal(m.preflight.ok, true); assert.equal(m.name, 'GLM');
    assert.equal(k.rule, true); assert.equal(k.civ, 'persian');
});

test('after the header: what the record says wins, including a missing check', () => {
    const header = { players: [
        { name: 'GLM #1', model: 'GLM5.3', settings: { servedBy: 'vllm', contextBudget: 32768, toolFallback: false, preflight: null } },
        { name: null, model: 'ki', settings: null } ] };
    const [m] = ui().lineupRows(setup, header);
    assert.equal(m.servedBy, 'vllm'); assert.equal(m.name, 'GLM #1');
    assert.equal(m.protocol, null, 'a header without a protocol says none');
    // GLM on vLLM, spoken to in Anthropic's protocol (asp67): the protocol is Anthropic,
    // the server is vLLM, and the card says both apart.
    const [g] = ui().lineupRows(setup, { players: [{ settings: { provider: 'anthropic', servedBy: 'vllm' } }, {}] });
    assert.equal(g.protocol, 'anthropic'); assert.equal(g.servedBy, 'vllm');
    assert.equal(m.context, 32768); assert.equal(m.soft, false);
    assert.equal(m.preflight, null, 'the header had no check, so the card shows none');
    assert.equal(m.reasoning, null);
});

test('a server that did not name itself is null, not "still asking"', () => {
    const [m] = ui().lineupRows(setup, { players: [{ settings: { servedBy: null } }, {}] });
    assert.equal(m.servedBy, null);
});

test('a local model path shows as its file name before the header exists, never the user folder', () => {
    const scope = { console, t: k => k, document: { getElementById: () => null } };
    vm.createContext(scope);
    for (const f of ['../js/openai-ai.js', '../js/ui.js'])
        vm.runInContext(fs.readFileSync(path.join(__dirname, f), 'utf8'), scope);
    const u = Object.create(vm.runInContext('UIManager', scope).prototype);
    const [m] = u.lineupRows([{ civ: 'greek', type: 'llm', connection: { name: 'O', model: String.raw`C:\Users\someone\ggufmodels\ornith-9b.gguf` } }], null);
    assert.doesNotMatch(m.model, /someone|Users/);
    assert.match(m.model, /ornith-9b/);
});
