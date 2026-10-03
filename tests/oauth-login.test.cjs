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
