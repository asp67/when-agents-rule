// OAuth as a login button (b1024): PKCE in the browser, no client secret. OpenRouter
// needs nothing configured and trades the code for a lasting key; any other server
// takes the authorize URL, token URL and client ID, and its tokens are refreshed as
// they run out.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const nodeCrypto = require('node:crypto');
const root = path.resolve(__dirname, '..');

function setup() {
    const scope = vm.createContext({ URL, URLSearchParams, TextEncoder, btoa, crypto: globalThis.crypto, console,
        location: { href: 'http://localhost:8099/index.html?lang=de#arena', origin: 'http://localhost:8099' },
        document: { getElementById: () => null }, t: k => k });
    vm.runInContext(fs.readFileSync(path.join(root, 'js/openai-ai.js'), 'utf8') + '\nthis.Manager=OpenAIAIManager;', scope);
    const m = scope.Manager, calls = [];
    m.fetchWithTimeout = async (url, opts) => {
        calls.push({ url, opts });
        const reply = m._reply(url, opts);
        return { ok: true, status: 200, json: async () => reply };
    };
    return { m, calls };
}
const sha = v => nodeCrypto.createHash('sha256').update(v).digest('base64url');

test('OpenRouter: one button, a PKCE login, and the key it hands back goes out as a bearer token', async () => {
    const { m, calls } = setup();
    const endpoint = 'https://openrouter.ai/api/v1';
    assert.equal(m.isOpenRouter(endpoint), true);
    assert.equal(m.isOpenRouter('https://notopenrouter.ai/api'), false);
    const pkce = await m.oauthPkce();
    assert.equal(pkce.challenge, sha(pkce.verifier), 'S256 of the verifier');
    const u = new URL(m.oauthAuthorizeUrl({}, endpoint, pkce));
    assert.equal(u.origin + u.pathname, 'https://openrouter.ai/auth');
    assert.equal(u.searchParams.get('callback_url'), 'http://localhost:8099/oauth-callback.html', 'the page beside index.html, without its query');
    assert.equal(u.searchParams.get('code_challenge'), pkce.challenge);
    assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
    m._reply = () => ({ key: 'sk-or-v1-from-login' });
    const auth = { type: 'oauth' };
    Object.assign(auth, await m.oauthExchange(auth, endpoint, 'the-code', pkce));
    assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/auth/keys');
    assert.deepEqual(JSON.parse(calls[0].opts.body), { code: 'the-code', code_verifier: pkce.verifier, code_challenge_method: 'S256' });
    assert.equal(auth.accessToken, 'sk-or-v1-from-login');
    const headers = await m.buildAuthHeaders(auth, 'openai');
    assert.equal(headers.Authorization, 'Bearer sk-or-v1-from-login');
    assert.equal(calls.length, 1, 'a lasting key: nothing to refresh');
});

test('another OAuth server: authorize with PKCE, trade the code without a secret, refresh once as it runs out', async () => {
    const { m, calls } = setup();
    const auth = { type: 'oauth', authorizeUrl: 'https://login.example.com/authorize?tenant=x', tokenUrl: 'https://login.example.com/token', clientId: 'war-app', scope: 'llm.use' };
    const pkce = await m.oauthPkce();
    const u = new URL(m.oauthAuthorizeUrl(auth, 'https://llm.example.com/v1', pkce));
    for (const [k, v] of Object.entries({ tenant: 'x', response_type: 'code', client_id: 'war-app', scope: 'llm.use',
        redirect_uri: 'http://localhost:8099/oauth-callback.html', code_challenge: pkce.challenge, code_challenge_method: 'S256', state: pkce.state }))
        assert.equal(u.searchParams.get(k), v, k);
    m._reply = () => ({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 });
    Object.assign(auth, await m.oauthExchange(auth, 'https://llm.example.com/v1', 'code-1', pkce));
    const sent = new URLSearchParams(calls[0].opts.body);
    assert.equal(calls[0].url, auth.tokenUrl);
    assert.deepEqual(Object.fromEntries(sent), { client_id: 'war-app', grant_type: 'authorization_code', code: 'code-1',
        redirect_uri: 'http://localhost:8099/oauth-callback.html', code_verifier: pkce.verifier });
    assert.equal(sent.has('client_secret'), false, 'no secret anywhere');
    assert.equal((await m.buildAuthHeaders(auth, 'openai')).Authorization, 'Bearer at-1');
    assert.equal(calls.length, 1, 'a live token is used as it is');
    auth.tokenExp = Date.now() + 30000;   // inside the last minute
    m._reply = () => ({ access_token: 'at-2', expires_in: 3600 });
    const [h1, h2] = await Promise.all([m.buildAuthHeaders(auth, 'openai'), m.buildAuthHeaders(auth, 'anthropic')]);
    assert.equal(calls.length, 2, 'one refresh for two requests');
    assert.deepEqual(Object.fromEntries(new URLSearchParams(calls[1].opts.body)), { client_id: 'war-app', grant_type: 'refresh_token', refresh_token: 'rt-1' });
    assert.equal(h1.Authorization, 'Bearer at-2');
    assert.equal(h2['x-api-key'], 'at-2');
    assert.equal(auth.refreshToken, 'rt-1', 'kept when the server sends no new one');
});

// ---- the answer the login popup sends back (b1303) -------------------------------------
// A code is taken only with the state this login sent. It was also taken with none.
function page() {
    const listeners = [];
    const channel = { onmessage: null, close() {} };
    const exchanged = [];
    const scope = vm.createContext({ console, t: (k, v) => k + (v ? JSON.stringify(v) : ''), setTimeout: () => 1, clearTimeout() {},
        location: { origin: 'http://localhost:8099', search: '' }, document: { getElementById: () => null },
        BroadcastChannel: function () { return channel; },
        OpenAIAIManager: { isOpenRouter: e => /openrouter\.ai/.test(e), oauthPkce: async () => ({ verifier: 'v', challenge: 'c', state: 'state-of-this-login' }),
            oauthAuthorizeUrl: () => 'https://login.example.com/authorize', oauthExchange: async (a, e, code) => { exchanged.push(code); return { accessToken: 'at' }; } } });
    scope.window = { open: () => ({ location: {}, close() {} }), addEventListener: (k, f) => listeners.push(f), removeEventListener() {} };
    vm.runInContext(fs.readFileSync(path.join(root, 'js/ui.js'), 'utf8') + '\nthis.UI = UIManager;', scope);
    const model = endpoint => ({ endpoint, auth: { type: 'oauth', authorizeUrl: 'https://login.example.com/authorize', tokenUrl: 'https://login.example.com/token', clientId: 'war-app' } });
    const login = endpoint => {
        const u = Object.create(scope.UI.prototype), m = model(endpoint);
        Object.assign(u, { getArenaModel: () => m, renderArenaLibrary() {}, saveArenaConfig() {} });
        const done = u.oauthLogin('m1');
        // The popup's answer, as oauth-callback.html posts it on the channel.
        const answer = async d => { for (let i = 0; i < 5 && !channel.onmessage; i++) await new Promise(r => setImmediate(r)); channel.onmessage({ data: d }); };
        return { m, done, answer };
    };
    return { scope, login, exchanged };
}

test('the popup\'s answer: for this login only with its state, and never a code without one', () => {
    const { scope } = page(), A = (d, openRouter = false) => scope.UI.oauthAnswer(d, { state: 'S' }, openRouter);
    assert.equal(A(null), null);
    assert.equal(A({ type: 'something-else', code: 'c', state: 'S' }), null, 'not an answer of ours');
    assert.equal(A({ type: 'war-oauth', code: 'c', state: 'OTHER' }), null, 'another login\'s answer is left for that login');
    assert.equal(A({ type: 'war-oauth', code: 'c', state: 'S' }).code, 'c', 'the right state');
    assert.equal(A({ type: 'war-oauth', code: 'c', state: null }).error, 'noState', 'a code without a state is refused');
    assert.equal(A({ type: 'war-oauth', code: 'c' }).error, 'noState');
    assert.equal(A({ type: 'war-oauth', code: null, state: null, error: 'access_denied' }).error, 'access_denied', 'a refusal by the server ends the wait as before');
    // OpenRouter's own flow is as it was: bound by PKCE, state not required of it.
    assert.equal(A({ type: 'war-oauth', code: 'c', state: null }, true).code, 'c');
    assert.equal(A({ type: 'war-oauth', code: 'c', state: 'OTHER' }, true), null);
});

test('a login waits past another login\'s answer, refuses a code without a state, and trades one that has it', async () => {
    // The right state: the code is traded.
    let p = page(), l = p.login('https://llm.example.com/v1');
    await l.answer({ type: 'war-oauth', code: 'stale', state: 'another-login' });   // ignored
    await l.answer({ type: 'war-oauth', code: 'good', state: 'state-of-this-login' });
    await l.done;
    assert.deepEqual(p.exchanged, ['good']);
    assert.equal(l.m._status, null, 'logged in');
    // No state: nothing is traded, and the card says why.
    p = page(); l = p.login('https://llm.example.com/v1');
    await l.answer({ type: 'war-oauth', code: 'injected', state: null });
    await l.done;
    assert.deepEqual(p.exchanged, [], 'the code is not traded');
    assert.equal(l.m._status.cls, 'err');
    assert.match(l.m._status.text, /ar\.oauthNoState/);
    // OpenRouter, as before.
    p = page(); l = p.login('https://openrouter.ai/api/v1');
    await l.answer({ type: 'war-oauth', code: 'or-code', state: null });
    await l.done;
    assert.deepEqual(p.exchanged, ['or-code']);
});

test('the refusal has its words in every language', () => {
    const ctx = vm.createContext({ console, localStorage: { getItem: () => null, setItem() {} }, navigator: { language: 'en' }, window: {},
        document: { documentElement: {}, querySelectorAll: () => [], addEventListener() {} } });
    vm.runInContext(fs.readFileSync(path.join(root, 'js/i18n.js'), 'utf8') + '\nthis.I = I18N;', ctx);
    for (const lang of ['en', 'de', 'es', 'zh']) assert.ok(ctx.I[lang]['ar.oauthNoState'] && ctx.I[lang]['ar.oauthNoState'].length > 10, lang);
});
