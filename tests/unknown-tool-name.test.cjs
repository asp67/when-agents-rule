// A call to a tool that does not exist is answered as that: an unknown action, by name
// (b1277). It was counted with the calls whose arguments would not parse, and the seat
// read "No valid action data received." or "One of your calls could not be parsed ...
// Send complete arguments per call." -- about arguments that were complete, and without
// the one word that was wrong.
const test = require('node:test'), assert = require('node:assert/strict');
const { stubSeat, toolReply } = require('./lib/stub-seat.cjs');

// The calls of one reply, read and run as the harness does once the reply is in.
async function play(reply) {
    const s = await stubSeat({});
    const env = s.mgr.constructor.envelopeFromToolCalls(reply.choices[0].message.tool_calls);
    s.c.turnLog = [];
    s.mgr.executeTurn(s.c, env.envelope);
    return s.c;
}

test('alone, it is named and the seat reads the names that exist', async () => {
    const c = await play(toolReply([['gather_resources', { resourceType: 'wood', reason: 'need wood' }]]));
    assert.match(c.lastActionResult, /\[ERROR\] Unknown action: gather_resources\. Valid actions: /);
    assert.doesNotMatch(c.lastActionResult, /No valid action data|could not be parsed/);
    assert.equal(c._lastOutcome.verdict, 'invalid');
});

test('in a batch, the others run and the wrong name is still named', async () => {
    const c = await play(toolReply([['gather_resources', { resourceType: 'wood' }], ['wait', { reason: 'hold' }]]));
    assert.match(c.lastActionResult, /Unknown action: gather_resources/);
    assert.doesNotMatch(c.lastActionResult, /could not be parsed/);
});

test('arguments that will not parse are still answered as that', async () => {
    const reply = toolReply([['wait', { reason: 'hold' }]]);
    reply.choices[0].message.tool_calls.push({ id: 'call_2', type: 'function', function: { name: 'train_unit', arguments: '{"unitType":"wor' } });
    const c = await play(reply);
    assert.match(c.lastActionResult, /could not be parsed/);
});
