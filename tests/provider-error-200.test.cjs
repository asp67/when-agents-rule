// A provider error that arrives as a 200 (asp67's match of 1 Nov): OpenRouter answers
// {"error": {...}} with no choices when the model's provider fails. Nemotron's seat got six
// of them, each back in 1-2 s with no usage, and every one was filed as the MODEL's empty
// reply -- a parse failure on its record, and "You returned an EMPTY reply" in its next
// turn -- and its closing statement as text null, error null.
const test = require('node:test'), assert = require('node:assert/strict');
const { createMatch } = require('../tools/bench/realm.cjs');

const ERR = { error: { message: 'Provider returned error', code: 502, metadata: { provider_name: 'Chutes' } } };

async function seat(body) {
    const m = await createMatch({ kind: 'arena', seats: ['greek', 'persian'], seed: 'provider-error-200' });
    const mgr = m.game.openAIAIManager, c = m.scripted(m.seats[0]);
    c.model = { name: 'stub', endpoint: 'http://127.0.0.1:9/v1', model: 'stub-model', provider: 'openai',
        maxTokens: 1024, language: 'en', _reqOpts: {}, auth: { type: 'none' } };
    c.lanes = [c];
    const notes = [];
    mgr.transcripts = { matchId: 't', noteInput() {}, note: (id, n) => notes.push(n), record() {}, turnsFor: () => 0 };
    Object.assign(m.context, { AbortController, setTimeout, clearTimeout });
    m.context.fetch = async () => ({ ok: true, status: 200, headers: { get: () => 'application/json' },
        json: async () => body, text: async () => JSON.stringify(body) });
    return { m, mgr, c, notes };
}

test('a provider error in a 200 is a request failure, not the model\'s empty reply', async () => {
    const { mgr, c, notes } = await seat(ERR);
    await mgr.sendToOpenAI(c, mgr.buildGameStateJSON(c));
    assert.equal(c.stats.parseFails, 0, 'not on the model\'s record');
    assert.equal(c.stats.networkErrors, 1, 'the endpoint failed');
    assert.doesNotMatch(String(c.lastActionResult || ''), /EMPTY reply/);
    const failed = notes.find(n => n.type === 'request_failed');
    assert.ok(failed, 'on file as a failed request');
    assert.match(failed.message, /provider error in a 200 reply \(502\): Provider returned error \(Chutes\)/);
});

test('a rate limit inside a 200 is a rate limit', async () => {
    const { mgr, c } = await seat({ error: { message: 'Rate limit exceeded: free-models-per-min', code: 429 } });
    await mgr.sendToOpenAI(c, mgr.buildGameStateJSON(c));
    assert.equal(c.stats.rateLimited, 1);
    assert.equal(c.stats.parseFails, 0);
});

test('a closing statement lost to a provider error says so; an empty one says it was empty', async () => {
    let { mgr, c, notes } = await seat(ERR);
    await mgr.askFinalWord(c, 'defeated');
    let fw = notes.find(n => n.type === 'final_word');
    assert.equal(fw.text, null);
    assert.match(fw.error, /^provider error \(502\): Provider returned error/);
    ({ mgr, c, notes } = await seat({ choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'stop' }] }));
    await mgr.askFinalWord(c, 'defeated');
    fw = notes.find(n => n.type === 'final_word');
    assert.equal(fw.error, 'an empty answer (finish_reason stop)');
});

test('an ordinary reply is untouched by the check', async () => {
    const { m } = await seat({});
    const M = m.game.openAIAIManager.constructor;
    assert.equal(M.providerErrorIn({ choices: [{ message: { content: 'x' } }] }), null);
    assert.equal(M.providerErrorIn({ choices: [{ message: { content: 'x' } }], error: null }), null);
    // JSON: the object comes from the realm's own Object.
    assert.equal(JSON.stringify(M.providerErrorIn(ERR)), JSON.stringify({ code: 502, message: 'Provider returned error (Chutes)' }));
});
