// The thinking dropdown filled from what the server says about the chosen model
// (asp67, b1028), and each value sent in the one form that server reads -- a key it
// does not know is ignored without a word, so nothing here is guessed.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');

function manager(routes) {
    const scope = vm.createContext({ URL, URLSearchParams, console, document: { getElementById: () => null }, t: k => k });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/openai-ai.js'), 'utf8') + '\nthis.Manager=OpenAIAIManager;', scope);
    const m = scope.Manager, asked = [];
    m.buildAuthHeaders = async () => ({});
    m.fetchWithTimeout = async (url, opts) => {
        asked.push(url);
        const hit = Object.keys(routes).find(k => url.endsWith(k));
        if (!hit) return { ok: false, status: 404, json: async () => ({}) };
        const body = typeof routes[hit] === 'function' ? routes[hit](opts) : routes[hit];
        return { ok: true, status: 200, json: async () => body };
    };
    m.asked = asked;
    return m;
}
const body = (m, provider, value, send) =>
    m._buildChatRequest(provider, 'http://x/v1', 'm', 'sys', [{ role: 'user', content: 'hi' }], { reasoning: value, thinkingSend: send, omitTools: true }).body;

test('OpenRouter: the efforts its model list names, off unless mandatory, sent as reasoning.effort', async () => {
    const m = manager({ '/models': { data: [
        { id: 'deepseek/r1', reasoning: { supported_efforts: ['high', 'medium', 'low', 'none'], default_effort: 'medium', mandatory: false } },
        { id: 'o-must', reasoning: { supported_efforts: ['high', 'low'], mandatory: true } },
        { id: 'plain/chat' } ] } });
    const conn = model => ({ endpoint: 'https://openrouter.ai/api/v1', provider: 'openai', model });
    const r1 = await m.discoverThinking(conn('deepseek/r1'));
    assert.deepEqual([r1.source, r1.send, [...r1.levels], r1.canOff, r1.canOn, r1.def], ['OpenRouter', 'openrouter', ['high', 'medium', 'low'], true, false, 'medium']);
    assert.equal((await m.discoverThinking(conn('o-must'))).canOff, false, 'mandatory reasoning cannot be switched off');
    assert.equal((await m.discoverThinking(conn('plain/chat'))).unsupported, true);
    assert.equal((await m.discoverThinking(conn('not/listed'))).source, null);
    assert.deepEqual(JSON.parse(JSON.stringify(body(m, 'openai', 'low', 'openrouter').reasoning)), { effort: 'low' });
    assert.deepEqual(JSON.parse(JSON.stringify(body(m, 'openai', 'off', 'openrouter').reasoning)), { effort: 'none' });
    assert.equal(body(m, 'openai', 'low', 'openrouter').reasoning_effort, undefined, 'not the OpenAI key');
});

test('Ollama: the values /api/show lists, sent as think (a level, or true/false)', async () => {
    const m = manager({ '/api/show': o => JSON.parse(o.body).model === 'gpt-oss:20b'
        ? { thinking: { values: ['low', 'medium', 'high'], default: 'medium' } }
        : JSON.parse(o.body).model === 'qwen3:8b' ? { capabilities: ['completion', 'tools', 'thinking'] }
        : JSON.parse(o.body).model === 'gpt-oss:120b-cloud' ? { capabilities: ['completion', 'tools', 'thinking'], details: { family: 'gptoss' } }
        : { capabilities: ['completion'] } });
    const conn = model => ({ endpoint: 'http://localhost:11434', provider: 'ollama', model });
    const oss = await m.discoverThinking(conn('gpt-oss:20b'));
    assert.deepEqual([[...oss.levels], oss.canOff, oss.def], [['low', 'medium', 'high'], false, 'medium']);
    const qwen = await m.discoverThinking(conn('qwen3:8b'));
    assert.deepEqual([[...qwen.levels], qwen.canOn, qwen.canOff], [[], true, true]);
    assert.equal((await m.discoverThinking(conn('llama3:8b'))).unsupported, true);
    // An Ollama that does not send thinking.values yet (0.34, measured): gpt-oss by its family.
    const old = await m.discoverThinking(conn('gpt-oss:120b-cloud'));
    assert.deepEqual([[...old.levels], old.canOn, old.canOff], [['low', 'medium', 'high'], false, false]);
    const req = (v) => m._buildChatRequest('ollama', 'http://localhost:11434', 'gpt-oss:20b', 's', [{ role: 'user', content: 'hi' }], { reasoning: v, thinkingSend: 'ollama', omitTools: true }).body;
    assert.equal(req('high').think, 'high');
    assert.equal(req('off').think, false);
});

test('llama.cpp: the levels its chat template compares against, sent in chat_template_kwargs', async () => {
    const tpl = "{%- set reasoning_effort = reasoning_effort | default('xhigh') %}{% if reasoning_effort == 'low' %}brief{% elif reasoning_effort in ['medium', 'xhigh'] %}x{% endif %}{% if enable_thinking is false %}{% endif %}";
    const m = manager({ '/props': { chat_template: tpl, chat_template_caps: {} } });
    const th = await m.discoverThinking({ endpoint: 'http://dgx:8080/v1', provider: 'openai', model: 'qwen3.5' });
    assert.deepEqual([th.source, [...th.levels].sort(), th.def, th.canOff], ['llama.cpp', ['low', 'medium', 'xhigh'], 'xhigh', true]);
    assert.deepEqual(JSON.parse(JSON.stringify(body(m, 'openai', 'low', 'llamacpp').chat_template_kwargs)), { reasoning_effort: 'low' });
    assert.deepEqual(JSON.parse(JSON.stringify(body(m, 'openai', 'off', 'llamacpp').chat_template_kwargs)), { enable_thinking: false });
    assert.equal(body(m, 'openai', 'low', 'llamacpp').reasoning_effort, undefined);
    const plain = manager({ '/props': { chat_template: '{{ messages }}' } });
    assert.equal((await plain.discoverThinking({ endpoint: 'http://dgx:8080/v1', provider: 'openai', model: 'x' })).unsupported, true);
});

test('Unsloth Studio: /v1/status, sent at the top level where its API reads it', async () => {
    const m = manager({ '/v1/status': { supports_reasoning: true, reasoning_style: 'enable_thinking', reasoning_effort_levels: [], reasoning_always_on: false } });
    const th = await m.discoverThinking({ endpoint: 'http://laptop:8888/v1', provider: 'openai', model: 'gemma' });
    assert.deepEqual([th.source, th.canOn, th.canOff, [...th.levels]], ['Unsloth Studio', true, true, []]);
    const b = body(m, 'openai', 'off', 'unsloth');
    assert.equal(b.enable_thinking, false); assert.equal(b.chat_template_kwargs, undefined, 'that API has no chat_template_kwargs');
});

test('a server that does not say -- vLLM, SGLang, a gateway -- is "not provided", and the old mapping stays for an unasked entry', async () => {
    const m = manager({ '/version': { version: '0.27' }, '/v1/models': { data: [{ id: 'glm' }] } });
    assert.equal((await m.discoverThinking({ endpoint: 'http://dgx:8024/v1', provider: 'openai', model: 'glm' })).source, null);
    assert.equal((await m.discoverThinking({ endpoint: 'https://api.anthropic.com/v1', provider: 'anthropic', model: 'c' })).source, null, 'budget field, not a list');
    const official = await manager({}).discoverThinking({ endpoint: 'https://api.openai.com/v1', provider: 'openai', model: 'gpt-5' });
    assert.deepEqual([official.source, [...official.levels]], ['OpenAI', ['minimal', 'low', 'medium', 'high']]);
    // Without a family the value is mapped as before.
    assert.equal(body(m, 'openai', 'low', null).reasoning_effort, 'low');
    assert.deepEqual(JSON.parse(JSON.stringify(body(m, 'openai', 'off', null).chat_template_kwargs)), { enable_thinking: false });
});

test('the card: options for the current model only, and a value the model does not offer is cleared', async () => {
    const scope = vm.createContext({ console, t: (k, p) => k + (p ? JSON.stringify(p) : ''), document: { getElementById: () => null } });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/ui.js'), 'utf8') + '\nthis.UI = UIManager;', scope);
    const u = Object.create(scope.UI.prototype);
    const entry = { id: 1, model: 'gpt-oss:20b', endpoint: 'http://localhost:11434', provider: 'ollama', reasoning: 'on', auth: { type: 'none' } };
    u._arenaConfig = { models: [entry] };
    u.saveArenaConfig = () => {};
    scope.OpenAIAIManager = { discoverThinking: async () => ({ source: 'Ollama', send: 'ollama', levels: ['low', 'high'], canOn: false, canOff: false }) };
    vm.runInContext('globalThis.OpenAIAIManager = this.OpenAIAIManager', scope);
    await u.discoverArenaThinking(1);
    assert.equal(u.thinkingFor(entry).send, 'ollama');
    assert.equal(entry.reasoning, '', '"on" is not an option of this model');
    entry.model = 'other';
    assert.equal(u.thinkingFor(entry), null, 'another model has not been asked');
});
