// A turn answered with tool calls replays only its visible text, never its hidden
// reasoning (decided by the paired run of 26 Sep 2026; see the comment in
// sendToOpenAI). Driven through the real sendToOpenAI with a stubbed network.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
// Recorded matches are not deployed everywhere (the platform server has none), so a
// test that reads them reports as skipped there rather than as a failure.
const HAS_SAMPLES = require('node:fs').existsSync(require('node:path').join(__dirname, '..', 'samples', 'index.json'));
const NEEDS_SAMPLES = { skip: !HAS_SAMPLES && 'samples/ not present' };
const root = path.resolve(__dirname, '..');

function harness(reply) {
    const scope = { console: { log() {}, warn() {}, error() {} }, Response, Headers, AbortController, setTimeout, clearTimeout, URL,
        fetch: async () => new Response(JSON.stringify({ choices: [{ message: reply, finish_reason: 'stop' }], usage: {} }),
            { status: 200, headers: { 'content-type': 'application/json' } }) };
    vm.createContext(scope);
    for (const f of ['js/civilizations.js', 'js/buildings.js', 'js/units.js', 'js/openai-ai.js'])
        vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), scope);
    const M = vm.runInContext('OpenAIAIManager', scope);
    const m = new M({ difficulty: 'easy', spectatorMode: true, aiManager: { aiPlayers: [{}, {}] } });
    const c = { id: 'p1', aiPlayer: { id: 'p1', civilization: 'greek', seat: 0 }, stats: m.newStats(), turnLog: [],
        conversationHistory: [], objective: '', plan: [],
        model: { endpoint: 'http://127.0.0.1:9/v1', model: 'x', provider: 'openai', maxTokens: 1024, language: 'en', _reqOpts: {}, auth: { type: 'none' } } };
    c.seat = c; c.lanes = [c]; m.aiControllers = [c];
    return { m, c };
}
const state = () => fs.readFileSync(path.join(root, 'samples/2026-09-09_gemini3.8-deepseek-v4-gpt5.6-qwen3.8_121min.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map(l => JSON.parse(l)).find(r => !r.type && r.state).state;

test('a tool-call turn with empty content replays no reasoning', NEEDS_SAMPLES, async () => {
    const { m, c } = harness({ role: 'assistant', content: null, reasoning: 'PRIVATE THOUGHTS about the enemy',
        tool_calls: [{ id: 'a', type: 'function', function: { name: 'wait', arguments: '{}' } }] });
    await m.sendToOpenAI(c, state());
    const last = c.turnLog[c.turnLog.length - 1];
    assert.equal(last.toolCalls.length, 1);
    assert.equal(last.assistant, '');
});

test('visible text alongside tool calls is still replayed', NEEDS_SAMPLES, async () => {
    const { m, c } = harness({ role: 'assistant', content: 'Hold the line.', reasoning: 'PRIVATE',
        tool_calls: [{ id: 'a', type: 'function', function: { name: 'wait', arguments: '{}' } }] });
    await m.sendToOpenAI(c, state());
    assert.equal(c.turnLog[c.turnLog.length - 1].assistant, 'Hold the line.');
});
