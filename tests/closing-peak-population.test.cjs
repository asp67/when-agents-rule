// The closing message's "Peak" line names the population (b1278). The high-water mark was
// read off resources.population, where the count stood until population became a block
// of its own; since then it was always undefined, the mark never rose, and the clause
// "population N/M" was never written.
const test = require('node:test'), assert = require('node:assert/strict');
const { stubSeat, toolReply } = require('./lib/stub-seat.cjs');

test('a seat that had three people reads so in its closing message', async () => {
    const s = await stubSeat({ reply: toolReply([['wait', { reason: 'look around' }]]) });
    await s.turn();
    assert.equal(s.c.seat._peak.pop, 3, 'the mark rose with the state it was shown');
    assert.equal(s.c.seat._peak.maxPop, 10);
    s.m.context.fetch = async () => ({ ok: true, status: 200, headers: { get: () => null },
        json: async () => ({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'gg' } }] }), text: async () => '' });
    let sent = '';
    const answer = s.m.context.fetch;
    s.m.context.fetch = async (url, opts) => { sent = opts.body; return answer(url, opts); };
    await s.mgr.askFinalWord(s.c, 'ended', { won: false });
    assert.match(sent, /population 3\/10/);
});
