'use strict';
// Two edge cases of an MCP seat (asp67, 28 Oct, the match of 14:44):
//  A. The user pauses it: its open turn is closed (it used to collect commands answered
//     "Queued" that never ran) and its hub is told, so the harness hears it is paused.
//     The results' silence leaves the pause out.
//  B. Its harness stops calling (OpenCode hit its token limit): every round waited the full
//     round for it, six times. A seat whose harness has made no call for longer than a
//     round is away: not asked, its round counted as missed, back at its next call.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { createMatch } = require('../tools/bench/realm.cjs');

async function twoMcpSeats() {
    const m = await createMatch({ kind: 'board', seed: 'mcp-pause-away', seats: [
        { civ: 'greek', age: 'bronze', buildings: [['town_center', -250, 0]], units: [['worker', -230, 0]] },
        { civ: 'persian', age: 'bronze', buildings: [['town_center', 250, 0]], units: [['worker', 230, 0]] }] });
    Object.assign(m.context, { AbortController, setTimeout, clearTimeout });
    const mgr = m.game.openAIAIManager;
    const quiet = new Map(), took = new Map(), asked = [], paused = [], open = new Map();
    const link = {
        quietMs: tok => quiet.has(tok) ? quiet.get(tok) : 0,
        tookLastTurn: tok => took.has(tok) ? took.get(tok) : false,
        setPaused: (tok, p) => paused.push([tok, p]),
        playTurn: (token, turn, text, rules, signal) => new Promise((resolve, reject) => {
            asked.push(token);
            open.set(token, resolve);
            if (signal) signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); }, { once: true });
        })
    };
    mgr._mcpLinks = new Map([['http://127.0.0.1:8765', link]]);
    m.controllers.forEach((c, i) => {
        c.model = { provider: 'mcp', endpoint: 'http://127.0.0.1:8765', mcpToken: 'seat-token-pa' + i + '00000', model: 'stand-in' };
        c.paused = false;   // the realm holds its seats paused and drives turns by hand
        // One lane, as the game builds it for a seat it creates (the realm's seats have none).
        if (!c.lanes || !c.lanes.length) {
            c.seat = c;
            const lane = Object.create(c);
            Object.assign(lane, { laneNo: 0, busy: false, pendingLog: [] });
            c.lanes = [lane];
        }
    });
    return { m, mgr, quiet, took, asked, paused, open, now: () => vm.runInContext('Date.now()', m.context) };
}
const flush = () => new Promise(r => setImmediate(r));
const settle = () => new Promise(r => setTimeout(r, 150));

const LIMIT = { timeout: 20000 };
const cleanUp = (t, mgr) => t.after(() => { try { mgr.stop(); } catch (e) { /* already stopped */ } });

test('A: pausing an MCP seat closes its open turn and tells its hub; resuming tells it again', LIMIT, async t => {
    const { m, mgr, paused, now } = await twoMcpSeats();
    cleanUp(t, mgr);
    const c = m.controllers[0];
    mgr.startTurn(c, now());                               // the turn goes out, as the game sends it
    await settle();
    assert.ok(mgr.seatBusy(c), 'a turn is out');
    mgr.setPaused(c.id, true);
    await settle();
    assert.deepEqual(paused, [[c.model.mcpToken, true]]);
    assert.ok(!mgr.seatBusy(c), 'the open turn was closed');
    mgr.setPaused(c.id, false);
    assert.deepEqual(paused[1], [c.model.mcpToken, false]);
    assert.equal(c._pauseLog.length, 1, 'the pause is on file for the silence');
});

test('A: the results leave a pause out of a seat\'s silence', () => {
    const context = vm.createContext({ console, Date, t: (k, v) => k + (v ? JSON.stringify(v) : ''),
        OpenAIAIManager: { MAX_COMMANDS_PER_TURN: 3 }, document: { getElementById: () => null } });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js/ui.js'), 'utf8') + '\nthis.UI = UIManager;', context);
    const u = Object.create(context.UI.prototype);
    const end = Date.now();
    u.game = { gameStarted: false, arenaEndedAt: end };
    const stats = { requests: 5, latencies: [5000], timeouts: 0, networkErrors: 0, parseFails: 0, noActionReturns: 0, actionsAttempted: 0,
        actionsSucceeded: 0, actionsContended: 0, reasonsGiven: 0, invalidActions: 0, actionsRejected: 0, actionCounts: {}, turnsExecuted: 0,
        lastAnswerAt: end - 600000 };
    // Answered ten minutes before the end, paused for eight of them (one pause over, one open).
    const m = u.seatMetrics({ stats, _pauseLog: [[end - 540000, end - 300000]], _pausedAt: end - 240000 });
    assert.equal(m.silentMs, 120000, 'two minutes of silence, not ten');
});

test('B: a seat whose harness has been quiet for a round is not asked, misses the round, and is back at its next call', LIMIT, async t => {
    const { m, mgr, quiet, asked, open, now } = await twoMcpSeats();
    cleanUp(t, mgr);
    mgr.turnBased = true;
    mgr._roundTimeoutMs = 120000;
    const [a, b] = m.controllers;
    quiet.set(a.model.mcpToken, 200000);                 // its harness last called 200 s ago
    mgr.updateTurnBased(now(), false);                     // a round opens
    await settle();
    assert.deepEqual(asked, [b.model.mcpToken], 'only the seat whose harness is there is asked');
    assert.equal(a.stats.roundsMissed, 1, 'the away seat misses the round');
    assert.match(a.conversationHistory[a.conversationHistory.length - 1].result, /^\[AWAY\] Your harness made no call to the game for longer than a round/);
    // The other seat answers; the round closes without waiting for the away one.
    open.get(b.model.mcpToken)([{ name: 'wait', args: {} }]);
    await settle();
    mgr.updateTurnBased(now() + 1000, false);
    assert.equal(mgr._roundPhase, 'ask', 'the round closed at once');
    // Its harness calls again: the next round asks it.
    quiet.set(a.model.mcpToken, 2000);
    mgr.updateTurnBased(now() + 60000, false);
    await settle();
    assert.ok(asked.includes(a.model.mcpToken), 'back in the next round');
    assert.equal(a.stats.roundsMissed, 1, 'and that round is not missed');
});

// asp67's match of 28 Oct, 17:31: each time-out was followed by one or two rounds "away" --
// seven in all -- while Strata and Hermes were still thinking over the turn they had taken.
test('B: a seat quiet because it is still thinking over the turn it took is asked, not away', LIMIT, async t => {
    const { m, mgr, quiet, took, asked, now } = await twoMcpSeats();
    cleanUp(t, mgr);
    mgr.turnBased = true;
    mgr._roundTimeoutMs = 120000;
    const [a, b] = m.controllers;
    quiet.set(a.model.mcpToken, 125000);                 // took its last turn 125 s ago, thinking since
    took.set(a.model.mcpToken, true);
    mgr.updateTurnBased(now(), false);
    await settle();
    assert.deepEqual(asked.slice().sort(), [a.model.mcpToken, b.model.mcpToken].sort(), 'both asked');
    assert.equal(a.stats.roundsMissed || 0, 0, 'no round missed for thinking');
    // From a hub that does not say whether the turn was taken (before 0.3.2): away, as before.
    took.set(a.model.mcpToken, null);
    assert.equal(mgr.mcpAway(Object.assign(Object.create(a), { lanes: [] })), true);
});
