// A seat's final word is asked on the same context as its turns (asp67, b1035): its
// objective and plan and the rolling history of its own moves, then the final state, the
// match in numbers and the closing question. It used to be the final state alone, and the
// post-mortems were reconstructed from a summary: "likely", "must not have".
const test = require('node:test'), assert = require('node:assert/strict');
const { createMatch } = require('../tools/bench/realm.cjs');

async function played() {
    const m = await createMatch({ kind: 'arena', seats: ['greek', { civ: 'persian', type: 'ki' }], seed: 'final-word' });
    const g = m.game, mgr = g.openAIAIManager, c = m.scripted(m.seats[0]);
    mgr.transcripts = { matchId: 't', noteInput() {}, note() {}, record() {} };
    const answers = [
        { commands: [{ action: 'assign_workers', params: { resourceType: 'wood', count: 2, from: 'idle', reason: 'Timber for houses.' } }],
          objective: 'Boom, then wall the river crossing', plan: ['Six on wood', 'Two houses', 'Barracks by the ford'] },
        { commands: [{ action: 'train_unit', params: { unitType: 'worker', reason: 'One more woodcutter.' } }] },
        { commands: [{ action: 'explore', params: { reason: 'Find their town.' } }] },
    ];
    // Each turn recorded as a model's reply records it (sendToOpenAI): the state it saw,
    // what it answered, and the outcome.
    for (const a of answers) {
        m.run(4000); c.turnCount++;
        const user = mgr.buildCompactState(mgr.buildGameStateJSON(c));
        mgr.executeTurn(c, a);
        c.turnLog.push({ user, assistant: a.commands.map(x => x.params.reason).join(' '), toolCalls: null, outcome: c.lastActionResult });
    }
    m.run(2000);
    c.model = Object.assign({}, c.model, { endpoint: 'http://stub.test/v1', provider: 'openai', maxTokens: 2000, contextSize: 65536 });
    const sent = [];
    // The request path needs what a browser has; the realm is rules only.
    Object.assign(m.context, { AbortController, setTimeout, clearTimeout });
    m.context.fetch = async (url, opts) => { sent.push({ url, body: JSON.parse(opts.body) }); return { ok: true, status: 200,
        json: async () => ({ choices: [{ message: { role: 'assistant', content: 'I meant to wall the ford.' }, finish_reason: 'stop' }] }) }; };
    return { m, mgr, c, sent };
}

test('the final word carries the objective, the plan and the seat\'s own turns, then the end', async () => {
    const { mgr, c, sent } = await played();
    const text = await mgr.askFinalWord(c, 'defeated');
    assert.equal(text, 'I meant to wall the ford.');
    assert.equal(sent.length, 1);
    const msgs = sent[0].body.messages, all = JSON.stringify(msgs);
    assert.ok(msgs.length > 2, 'a conversation, not one message: ' + msgs.length);
    assert.match(all, /Boom, then wall the river crossing/, 'its objective');
    assert.match(all, /Barracks by the ford/, 'its plan');
    assert.match(all, /One more woodcutter|Find their town/, 'its earlier turns');
    const last = String(msgs[msgs.length - 1].content);
    assert.match(last, /FINAL game state/);
    assert.match(last, /YOUR MATCH IN NUMBERS/);
    assert.match(last, /THE MATCH IS OVER FOR YOU/, 'and the closing question last');
    assert.doesNotMatch(last, /Decide what to do on THIS turn/, 'not asked for a move');
    assert.equal(await mgr.askFinalWord(c, 'defeated'), null, 'asked once');
    assert.equal(sent.length, 1);
});

test('a seat whose final state cannot be built still gets its question', async () => {
    const { mgr, c, sent } = await played();
    mgr.buildGameStateJSON = () => { throw new Error('no board'); };
    await mgr.askFinalWord(c, 'ended', { won: false, winner: 'persian-2' });
    assert.equal(sent.length, 1);
    const msgs = sent[0].body.messages;
    assert.match(String(msgs[msgs.length - 1].content), /THE MATCH HAS ENDED/);
});
