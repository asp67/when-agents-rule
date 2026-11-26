'use strict';
// A model's seat in a real arena match whose endpoint is a function of the test's: the
// harness builds its request, sends it, reads the reply and runs it exactly as in a
// match; only the network is the test's. For the tests of what a seat is sent and of
// what the harness does with what comes back.
//
//   const { m, mgr, c, requests } = await stubSeat({ reply: body })   // a fixed JSON reply
//   const s = await stubSeat({ fetch: async (url, opts) => response })  // or the whole exchange
const path = require('node:path');
const { createMatch } = require(path.join(__dirname, '../../tools/bench/realm.cjs'));

async function stubSeat({ reply = null, fetch = null, seed = 'stub-seat', seats = ['greek', 'persian'], model = {} } = {}) {
    const m = await createMatch({ kind: 'arena', seats, seed });
    const mgr = m.game.openAIAIManager, c = m.scripted(m.seats[0]);
    c.model = Object.assign({ name: 'stub', endpoint: 'http://127.0.0.1:9/v1', model: 'stub-model', provider: 'openai',
        maxTokens: 1024, language: 'en', _reqOpts: {}, auth: { type: 'none' } }, model);
    c.lanes = [c];
    const notes = [], requests = [];
    mgr.transcripts = { matchId: 't', noteInput() {}, note: (id, n) => notes.push(n), record() {}, turnsFor: () => 0, noteResult() {} };
    Object.assign(m.context, { AbortController, setTimeout, clearTimeout });
    m.context.fetch = async (url, opts) => {
        let body = null;
        try { body = JSON.parse(opts.body); } catch (e) { /* not a JSON request */ }
        requests.push({ url: String(url), body, signal: opts && opts.signal });
        if (fetch) return fetch(url, opts);
        return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => reply, text: async () => JSON.stringify(reply) };
    };
    // One turn as a match asks for it: the state, the request, the reply, its execution.
    const turn = () => mgr.sendToOpenAI(c, mgr.buildGameStateJSON(c));
    // The text of the last message the seat was sent.
    const lastSent = () => {
        const r = requests[requests.length - 1], msgs = (r && r.body && r.body.messages) || [];
        const last = msgs[msgs.length - 1];
        return last ? (typeof last.content === 'string' ? last.content : JSON.stringify(last.content)) : '';
    };
    return { m, mgr, c, notes, requests, turn, lastSent };
}

// A reply an OpenAI-compatible endpoint would send for these tool calls.
function toolReply(calls, extra = {}) {
    return { choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
        tool_calls: calls.map(([name, args], i) => ({ id: 'call_' + (i + 1), type: 'function', function: { name, arguments: JSON.stringify(args) } })) } }],
        usage: { prompt_tokens: 100, completion_tokens: 20 }, ...extra };
}

module.exports = { stubSeat, toolReply };
