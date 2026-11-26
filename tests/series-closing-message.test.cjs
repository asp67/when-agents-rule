// Between the matches of a series, a library seat is not told to call tools it does not
// have (b1274). The closing message of build 1236 says "share your thoughts ... via
// final_word ... and then immediately call wait_for_turn". Those are the MCP hub's tools:
// a harness that plays a seat has them and stays joined for the next match. A model
// behind an endpoint is sent the game's twelve commands and "plan", and its next match
// is a new conversation; told to call a tool it was never given, it answers with a call
// to nothing, which is filed as an empty closing statement.
const test = require('node:test'), assert = require('node:assert/strict');
const { stubSeat } = require('./lib/stub-seat.cjs');

const SAID = { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'A good fight.' } }] };
const inSeries = s => { s.m.game.seriesNextOpts = () => ({ seriesContinues: true, series: { round: 1, nextRound: 2, total: 3 } }); return s; };

test('a library seat in a series reads which match ended and the usual closing words', async () => {
    const s = inSeries(await stubSeat({ reply: SAID }));
    await s.mgr.askFinalWord(s.c, 'ended', { won: false, winner: 'seat 2' });
    const sent = s.lastSent();
    assert.match(sent, /MATCH 1 OF 3 HAS ENDED\. You did not win\./);
    assert.doesNotMatch(sent, /final_word|wait_for_turn/, 'no tool it does not have');
    assert.match(sent, /say it now, in your own words\. Answer however you like\./);
    const tools = (s.requests[s.requests.length - 1].body.tools || []).map(t => t.function.name);
    assert.ok(!tools.includes('final_word') && !tools.includes('wait_for_turn'), 'and indeed it has neither: ' + tools.join(', '));
});

test('a harness seat in a series is told to say its word and wait for the next match', async () => {
    const s = inSeries(await stubSeat({ reply: SAID, model: { provider: 'mcp', mcpToken: 'seat-test', endpoint: 'http://127.0.0.1:8765' } }));
    let heard = null;
    s.mgr.mcpLink = () => ({ finalWord: async (token, msg) => { heard = msg; return 'On to the next.'; } });
    await s.mgr.askFinalWord(s.c, 'ended', { won: true });
    assert.match(heard, /MATCH 1 OF 3 HAS ENDED\. You WON/);
    assert.match(heard, /via final_word/); assert.match(heard, /call wait_for_turn to play Match 2 of 3/);
});

test('outside a series nothing changes', async () => {
    const s = await stubSeat({ reply: SAID });
    await s.mgr.askFinalWord(s.c, 'defeated', {});
    assert.match(s.lastSent(), /THE MATCH IS OVER FOR YOU\./);
    assert.match(s.lastSent(), /This is the final message you will receive; the game is closing/);
});
