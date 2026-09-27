// One request builder (review #8 step 2): buildTurnRequest builds a seat's turn from
// the seat and the state alone, and sendToOpenAI sends exactly that. The bench calls
// the same builder, so a request it sends is the request the arena would have sent.
const test = require('node:test'), assert = require('node:assert/strict');
const { createMatch } = require('../tools/bench/realm.cjs');

const REPLY = { choices: [{ message: { role: 'assistant', content: null,
    tool_calls: [{ id: 'a', type: 'function', function: { name: 'wait', arguments: '{}' } }] }, finish_reason: 'stop' }], usage: {} };

async function modelSeat() {
    const m = await createMatch({ kind: 'arena', seats: ['greek', 'persian'], seed: 'bench-request' });
    const mgr = m.game.openAIAIManager, c = m.scripted(m.seats[0]);
    c.model = { name: 'stub', endpoint: 'http://127.0.0.1:9/v1', model: 'stub-model', provider: 'openai',
        maxTokens: 1024, language: 'en', _reqOpts: {}, auth: { type: 'none' } };
    c.lanes = [c];
    const sent = [];
    // The send loop's own machinery (an abort handle and its timeout). The realm has no
    // timers on purpose -- nothing in the rules may use them -- so the test lends them.
    Object.assign(m.context, { AbortController, setTimeout, clearTimeout });
    // The network, as the page's fetch: every request recorded, every answer a wait.
    m.context.fetch = async (url, init) => {
        sent.push({ url, body: init.body });
        return { ok: true, status: 200, headers: { get: () => 'application/json' },
                 json: async () => REPLY, text: async () => JSON.stringify(REPLY) };
    };
    return { m, mgr, c, sent };
}

test('the arena sends exactly the request buildTurnRequest builds, turn after turn', async () => {
    const { m, mgr, c, sent } = await modelSeat();
    for (let turn = 1; turn <= 4; turn++) {
        if (turn === 2) { c.objective = 'Hold the river'; c.plan = ['scout east', 'wall the ford']; }
        if (turn === 3) c.pendingAdvice = ['Mind the flank.'];
        const state = mgr.buildGameStateJSON(c);
        const built = mgr.buildTurnRequest(c, state);
        await mgr.sendToOpenAI(c, state);
        const got = sent[sent.length - 1];
        assert.equal(got.url, built.request.url, 'turn ' + turn);
        assert.equal(got.body, JSON.stringify(built.request.body), 'turn ' + turn + ': the body sent is the body built');
        if (turn === 3) {
            assert.equal(built.advice, 'Mind the flank.');
            assert.deepEqual(Array.from(c.pendingAdvice), [], 'the send, not the build, consumed the advice');
        }
        m.advance(5000);
    }
    // The history really grew: the last request replays the earlier turns.
    const last = JSON.parse(sent[3].body);
    assert.ok(last.messages.length > JSON.parse(sent[0].body).messages.length);
});

test('buildTurnRequest changes nothing and gives the same request twice', async () => {
    const { mgr, c } = await modelSeat();
    c.pendingAdvice = ['Advice kept for the send.'];
    const state = mgr.buildGameStateJSON(c);
    const seen = () => JSON.stringify({ advice: c.pendingAdvice, pending: c._pendingTurnUser, transcript: c._transcriptState,
        history: c.conversationHistory, log: c.turnLog.length, reqOpts: c.model._reqOpts, shrink: c._ctxShrink });
    const before = seen();
    const a = mgr.buildTurnRequest(c, state), b = mgr.buildTurnRequest(c, state);
    assert.equal(seen(), before);
    assert.equal(JSON.stringify(a.request), JSON.stringify(b.request));
    // Shrink and parameters are the caller's: the bench fixes both.
    const fixed = mgr.buildTurnRequest(c, state, { shrink: 1, reqOpts: { temperature: 0.6, maxTokens: 777 } });
    assert.equal(fixed.request.body.temperature, 0.6);
    assert.equal(fixed.request.body.max_tokens, 777);
});
