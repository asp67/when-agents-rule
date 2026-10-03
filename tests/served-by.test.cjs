// Who serves a seat is what the server says about itself, not the protocol it speaks
// (asp67, b1026): GLM on vLLM spoken to in Anthropic's protocol is served by vLLM,
// and the real Anthropic API, which names no owner, is served by nobody named.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');

function manager(models) {
    const scope = vm.createContext({ URL, URLSearchParams, console, document: { getElementById: () => null }, t: k => k });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/openai-ai.js'), 'utf8') + '\nthis.Manager=OpenAIAIManager;', scope);
    const m = scope.Manager;
    m.buildAuthHeaders = async () => ({});
    m.fetchWithTimeout = async () => ({ ok: true, status: 200, json: async () => ({ data: models }) });
    return m;
}

test('a server speaking Anthropic\'s protocol is named by what it reports', async () => {
    const r = await manager([{ id: 'glm-5.3', owned_by: 'vllm' }]).testConnection('http://localhost:8024/v1', {}, 'anthropic');
    assert.equal(r.ok, true);
    assert.equal(r.provider, 'anthropic', 'the protocol');
    assert.equal(r.servedBy, 'vllm', 'the server');
});

test('an endpoint that names no owner is served by nobody named, whatever its protocol', async () => {
    for (const prov of ['anthropic', 'openai']) {
        const r = await manager([{ id: 'claude-x', type: 'model' }]).testConnection('https://api.example.com/v1', {}, prov);
        assert.equal(r.servedBy, null, prov);
    }
});

test("the header asks the server too: a vLLM seat on Anthropic's protocol is recorded as vllm", async () => {
    const m = manager([{ id: 'glm-5.3', owned_by: 'vllm' }]);
    assert.equal(await m.probeServedBy({ endpoint: 'http://localhost:8024/v1', provider: 'anthropic', model: 'glm-5.3' }), 'vllm');
    assert.equal(await manager([{ id: 'claude-x' }]).probeServedBy({ endpoint: 'https://api.anthropic.com/v1', provider: 'anthropic', model: 'claude-x' }), null);
    assert.equal(await m.probeServedBy({ endpoint: 'http://localhost:11434', provider: 'ollama', model: 'x' }), 'ollama');
});
