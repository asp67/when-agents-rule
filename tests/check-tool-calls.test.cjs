// "Check tool calls" sends one real request with a synthetic tool history and asks
// for one call. Each way a seat can fail must be named, not reported as a generic error.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');

function harness(reply) {
    let sent = null;
    const scope = { console: { log() {}, warn() {}, error() {} }, AbortController, setTimeout, clearTimeout, URL,
        fetch: async (url, init) => {
            sent = JSON.parse(init.body);
            if (reply instanceof Error) throw reply;
            return { ok: reply.status === 200, status: reply.status, text: async () => typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body) };
        } };
    vm.createContext(scope);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/openai-ai.js'), 'utf8'), scope);
    const M = vm.runInContext('OpenAIAIManager', scope);
    const conn = { endpoint: 'http://127.0.0.1:9/v1', model: 'm', provider: 'openai', auth: { type: 'none' }, maxTokens: 1024 };
    return { run: () => M.checkToolCalling(conn, 5000), sent: () => sent };
}
const msg = (message, finish = 'stop') => ({ status: 200, body: { choices: [{ message, finish_reason: finish }] } });

test('a returned tool call passes, and the request carries tools and a tool history', async () => {
    const h = harness(msg({ role: 'assistant', content: null, tool_calls: [{ id: 'x', type: 'function', function: { name: 'wait', arguments: '{}' } }] }));
    const r = await h.run();
    assert.equal(r.ok, true); assert.equal(r.code, 'ok'); assert.equal(r.tool, 'wait');
    const body = h.sent();
    assert.ok(Array.isArray(body.tools) && body.tools.length > 1, 'tools offered');
    assert.ok(body.messages.some(m => m.role === 'tool'), 'tool results replayed');
    assert.ok(body.messages.some(m => m.role === 'assistant' && m.tool_calls), 'past calls replayed');
});

test('each failure is named', async () => {
    const cases = [
        [msg({ role: 'assistant', content: '<tool_call>{"name":"wait"}</tool_call>' }), 'parser'],
        [msg({ role: 'assistant', content: 'I will wait.' }), 'noCall'],
        [msg({ role: 'assistant', content: '' }, 'length'), 'truncated'],
        [{ status: 400, body: 'Conversation roles must alternate user/assistant: jinja template error' }, 'template'],
        [{ status: 401, body: 'unauthorized' }, 'auth'],
        [{ status: 404, body: 'model not found' }, 'notFound'],
        [{ status: 500, body: 'boom' }, 'http'],
        [new Error('fetch failed'), 'network'],
    ];
    for (const [reply, code] of cases) {
        const r = await harness(reply).run();
        assert.equal(r.ok, false, code); assert.equal(r.code, code);
    }
});
