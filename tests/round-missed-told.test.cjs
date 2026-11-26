// A seat that missed a round is told so on its next turn, in every history mode (b1273).
//
// "The model is TOLD. It reads this on its next turn" -- the comment above
// noteRoundMissed, since the round deadline exists. The note went into the move history,
// and only the token-saving mode (one user message with the history embedded) reads that.
// The default mode, a rolling conversation, never showed it: a model there missed round
// after round and was not once told that the limit existed or that it had run past it.
// An MCP seat plays through the same conversation and never read "[AWAY]" either.
const test = require('node:test'), assert = require('node:assert/strict');
const { stubSeat, toolReply } = require('./lib/stub-seat.cjs');

const WAIT = toolReply([['wait', { reason: 'look around' }]]);
async function seat(model = {}) {
    const s = await stubSeat({ reply: WAIT, model });
    s.mgr.turnBased = true;
    return s;
}

test('the rolling conversation carries the note once, on the turn after the miss', async () => {
    const s = await seat();
    await s.turn();
    assert.doesNotMatch(s.lastSent(), /\[TIMEOUT\]/);
    s.mgr.noteRoundMissed(s.c);
    await s.turn();
    assert.match(s.lastSent(), /\[TIMEOUT\] Your answer did not arrive within \d+s of the state being sent, so this round was played without you\./);
    await s.turn();
    assert.doesNotMatch(s.lastSent(), /\[TIMEOUT\]/, 'said once, not on every turn after');
});

test('a note whose request never came back is said again', async () => {
    const s = await seat();
    s.mgr.noteRoundMissed(s.c);
    const answer = s.m.context.fetch;
    s.m.context.fetch = async (url, opts) => { await answer(url, opts); throw new TypeError('Failed to fetch'); };
    await s.turn();
    assert.match(s.lastSent(), /\[TIMEOUT\]/);
    s.m.context.fetch = answer;
    await s.turn();
    assert.match(s.lastSent(), /\[TIMEOUT\]/, 'the model never read the first one');
    await s.turn();
    assert.doesNotMatch(s.lastSent(), /\[TIMEOUT\]/);
});

test('an away seat reads that it was away', async () => {
    const s = await seat();
    s.mgr.noteRoundMissed(s.c, true);
    await s.turn();
    assert.match(s.lastSent(), /\[AWAY\] Your harness made no call to the game for longer than a round/);
});

test('the token-saving mode still reads it in its move history, and only there', async () => {
    const s = await seat({ minimizeTokens: true });
    s.mgr.noteRoundMissed(s.c);
    await s.turn();
    assert.equal(s.lastSent().split('[TIMEOUT]').length - 1, 1, 'once in the one message');
});
