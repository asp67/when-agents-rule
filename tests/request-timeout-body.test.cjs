// The request's time limit covers the answer's body, not only its headers (b1272).
//
// The timer was cleared the moment fetch() resolved, which is when the headers arrive.
// The body was read afterwards with nothing watching: an endpoint that answers 200 at
// once and then stalls -- an aggregator whose upstream died -- held the seat's lane busy
// for the rest of a real-time match, where this limit is the only guard there is.
const test = require('node:test'), assert = require('node:assert/strict');
const { stubSeat, toolReply } = require('./lib/stub-seat.cjs');

// A body that never arrives unless the request is aborted.
const stalled = signal => new Promise((resolve, reject) =>
    signal.addEventListener('abort', () => reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }))));
const within = (promise, ms) => Promise.race([promise.then(() => 'settled'), new Promise(r => setTimeout(() => r('still waiting'), ms))]);

test('a reply whose body never completes ends at the time limit, as a timeout', async () => {
    const s = await stubSeat({ fetch: async (url, opts) => ({ ok: true, status: 200, headers: { get: () => null },
        json: () => stalled(opts.signal), text: () => stalled(opts.signal) }) });
    s.mgr.turnBased = false; s.mgr.requestTimeout = 200;
    assert.equal(await within(s.turn(), 3000), 'settled');
    assert.equal(s.c.stats.timeouts, 1, 'counted as a timeout');
    assert.equal(s.requests[0].signal.aborted, true, 'and the connection is let go');
});

test('an error reply whose body never completes ends there too', async () => {
    const s = await stubSeat({ fetch: async (url, opts) => ({ ok: false, status: 500, headers: { get: () => null },
        json: () => stalled(opts.signal), text: () => stalled(opts.signal) }) });
    s.mgr.turnBased = false; s.mgr.requestTimeout = 200;
    assert.equal(await within(s.turn(), 3000), 'settled');
    assert.equal(s.c.stats.timeouts, 1);
});

test('a reply that arrives in time is played, and its request is not aborted afterwards', async () => {
    const s = await stubSeat({ reply: toolReply([['wait', { reason: 'look around' }]]) });
    s.mgr.turnBased = false; s.mgr.requestTimeout = 200;
    assert.equal(await within(s.turn(), 3000), 'settled');
    assert.equal(s.c.stats.timeouts, 0);
    await new Promise(r => setTimeout(r, 400));   // past the limit
    assert.equal(s.requests[0].signal.aborted, false, 'the timer went with the reply');
});

test('the probe fetch keeps its limit until the body is read', async () => {
    const s = await stubSeat({});
    const M = s.mgr.constructor;
    s.m.context.fetch = async (url, opts) => ({ ok: true, status: 200, json: () => stalled(opts.signal), text: () => stalled(opts.signal) });
    const res = await M.fetchWithTimeout('http://127.0.0.1:9/v1/models', {}, 150);
    assert.equal(await within(res.json().catch(e => { assert.equal(e.name, 'AbortError'); }), 2000), 'settled');
});
