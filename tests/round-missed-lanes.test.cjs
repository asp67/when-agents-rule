// At the round deadline, only a seat that has NOT answered is recorded as missing the
// round (b1275). The test was "has a request out". With more than one lane a seat almost
// always has one out -- that is the pipeline -- so a two-lane seat that had answered was
// booked a missed round, read "[TIMEOUT] ... this round was played without you" about a
// round it had played, and had its next request cut, whenever another seat ran late.
const test = require('node:test'), assert = require('node:assert/strict');
const { stubSeat } = require('./lib/stub-seat.cjs');

async function deadline(setup) {
    const s = await stubSeat({});
    const mgr = s.mgr, a = s.c, b = s.m.scripted(s.m.seats[1]);
    for (const c of [a, b]) { c.model = Object.assign({}, s.c.model); c.paused = false; }   // a scripted seat is paused; these are asked
    mgr.aiControllers = [a, b];
    mgr.turnBased = true; mgr._roundNo = 7; mgr._roundPhase = 'wait';
    const noted = [];
    mgr.noteRoundMissed = c => noted.push(c === a ? 'a' : 'b');
    mgr.fillLanes = () => {}; mgr.flushRound = () => {};
    setup(a, b);
    const now = 1e9; mgr._roundStartedAt = now - mgr.roundTimeoutMs() - 1;
    mgr.updateTurnBased(now, false);
    return noted;
}
const lane = (busy, askedInRound) => ({ busy, askedInRound });

test('a two-lane seat that answered, with its other lane mid-pipeline, has not missed the round', async () => {
    const noted = await deadline((a, b) => {
        a.lanes = [lane(false, 7), lane(true, 7)]; a.answeredRound = 7;
        b.lanes = [lane(true, 7)]; b.answeredRound = 6;
    });
    assert.deepEqual(noted, ['b'], 'only the seat still owing an answer');
});

test('a seat that has not answered and has a request out has', async () => {
    const noted = await deadline((a, b) => {
        a.lanes = [lane(true, 7), lane(true, 6)]; a.answeredRound = 6;
        b.lanes = [lane(true, 7)]; b.answeredRound = 6;
    });
    assert.deepEqual(noted, ['a', 'b']);
});

test('a seat with nothing in the air is not noted: its failed request was counted where it failed', async () => {
    const noted = await deadline((a, b) => {
        a.lanes = [lane(false, 7)]; a.answeredRound = 6; a._kickoffBudget = 0;
        b.lanes = [lane(true, 7)]; b.answeredRound = 6;
    });
    assert.deepEqual(noted, ['b']);
});
