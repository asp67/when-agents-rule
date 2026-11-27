// A server that refuses a parameter with HTTP 422 is answered as one that refuses it with
// 400 (build 1302): the parameter is dropped and the request sent again, once, and the
// change is noted in the transcript. Servers built on FastAPI (vLLM, SGLang, llama-cpp-python
// and others) validate the request body themselves and answer 422 "Extra inputs are not
// permitted"; the harness adapted to 400 alone, so a seat on such a server failed every turn.
const test = require('node:test'), assert = require('node:assert/strict');
const { stubSeat, toolReply } = require('./lib/stub-seat.cjs');

const ok = body => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => body, text: async () => JSON.stringify(body) });
const refuse = (status, text) => ({ ok: false, status, headers: { get: () => 'application/json' }, json: async () => JSON.parse(text), text: async () => text });
// What FastAPI's validation says of a field it does not know.
const FASTAPI = JSON.stringify({ detail: [{ type: 'extra_forbidden', loc: ['body', 'min_p'], msg: 'Extra inputs are not permitted', input: 0.05 }] });

for (const status of [422, 400]) {
    test(`a parameter refused with ${status} is dropped and the turn is played`, async () => {
        const s = await stubSeat({ model: { minP: 0.05 }, fetch: async (url, opts) => {
            const body = JSON.parse(opts.body);
            return 'min_p' in body ? refuse(status, FASTAPI) : ok(toolReply([['wait', { reason: 'nothing to do yet' }]]));
        } });
        await s.turn();
        assert.equal(s.requests.length, 2, 'sent, refused, sent again');
        assert.equal(s.requests[0].body.min_p, 0.05, 'the first request carried the parameter');
        assert.equal('min_p' in s.requests[1].body, false, 'the second did not');
        assert.equal(s.c.model._reqOpts.omitMinP, true, 'and it stays out for the match');
        const note = s.notes.find(n => n && n.type === 'adaptation');
        assert.ok(note, 'the change is on file: ' + JSON.stringify(s.notes));
        assert.deepEqual(Array.from(note.params), ['omitMinP']);
    });
}

test('a 422 that names nothing the harness can leave out is still an error, said once', async () => {
    const s = await stubSeat({ fetch: async () => refuse(422, JSON.stringify({ detail: 'model not loaded' })) });
    assert.equal(await s.turn(), null, 'the turn brings nothing');
    assert.equal(s.requests.length, 1, 'not sent again');
    const failed = s.notes.filter(n => n && n.type === 'request_failed');
    assert.equal(failed.length, 1);
    assert.match(failed[0].message, /^API error \(422\): .*model not loaded/);
    assert.equal(s.notes.some(n => n && n.type === 'adaptation'), false);
});

test('other refusals are not retried as a parameter', async () => {
    const s = await stubSeat({ model: { minP: 0.05 }, fetch: async () => refuse(500, FASTAPI) });
    assert.equal(await s.turn(), null);
    assert.equal(s.requests.length, 1);
    assert.match(s.notes.find(n => n && n.type === 'request_failed').message, /^API error \(500\)/);
    assert.equal(s.c.model._reqOpts.omitMinP, undefined, 'nothing was dropped');
});
