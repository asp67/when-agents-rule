// Lockstep, an option of turn-based play (asp67, 27.09.2026): the world stands still
// while a round's seats think, then plays exactly one slice of simulated time. Every
// round therefore spans the same world time however long the models take.
//
// The seats here are stubs that answer a fixed wall-clock delay after being asked, so
// the round machinery runs for real (asking, waiting, flushing) with no network.
const test = require('node:test'), assert = require('node:assert/strict');
const { GoldenMatch } = require('./harness.cjs');

function roundBoard({ sliceMs, answerMs, lanes = 1 }) {
    const m = new GoldenMatch({ seed: 41 });
    const [a, b] = m.startFixture(['greek', 'persian']);
    m.addBuilding(a, 'town_center', -300, -300); m.addBuilding(b, 'town_center', 300, 300);
    const g = m.game, mgr = g.openAIAIManager;
    mgr.turnBased = true;
    mgr.roundTimeoutMs = () => 180000;
    g._lockstep = sliceMs ? { sliceMs, budget: 0 } : null;
    const pending = [], flushes = [], asked = [];
    const seats = [a, b].map(ai => {
        const c = m.scripted(ai);
        c.paused = false;
        c.lanes = Array.from({ length: lanes }, () => ({ busy: false }));
        return c;
    });
    mgr.startTurn = (c, now) => {
        const lane = c.lanes.find(l => !l.busy);
        lane.busy = true;
        asked.push({ round: mgr._roundNo, sim: g.clock.simMs });
        pending.push({ c, lane, at: now + answerMs });
    };
    const update = mgr.update.bind(mgr);
    mgr.update = dt => {
        const now = m.runtime.Date.now();   // the clock startTurn was handed (epoch ms)
        for (const p of pending.splice(0)) {
            if (p.at > now) { pending.push(p); continue; }
            p.lane.busy = false;
            if (mgr._roundPhase === 'wait') { p.c.queuedAction = { commands: [] }; p.c.answeredRound = mgr._roundNo; }
        }
        return update(dt);
    };
    mgr.executeTurn = actor => flushes.push({ round: mgr._roundNo, sim: g.clock.simMs, match: g.clock.matchMs, seat: actor.id });
    return { m, g, mgr, seats, flushes, asked };
}

test('lockstep: the world stands still while seats think, then plays exactly one slice', () => {
    const { m, g, flushes, asked } = roundBoard({ sliceMs: 5000, answerMs: 7000 });
    let frozenSince = null, movedWhileWaiting = 0;
    for (let i = 0; i < 60 * 10; i++) {   // one minute of wall time, 100 ms at a time
        const before = g.clock.simMs, waiting = g.openAIAIManager._roundPhase === 'wait';
        m.run(100);
        if (waiting && g.openAIAIManager._roundPhase === 'wait' && g.clock.simMs !== before) movedWhileWaiting++;
    }
    assert.equal(movedWhileWaiting, 0, 'the world moved while a round was waiting for answers');
    const rounds = [...new Set(flushes.map(f => f.round))];
    assert.ok(rounds.length >= 4, 'rounds played: ' + rounds.length);
    // Round k's moves run at world time (k-1) x slice, exactly -- both seats together.
    for (const f of flushes) assert.equal(f.sim, (f.round - 1) * 5000, `round ${f.round} flushed at ${f.sim}`);
    // And every round is asked on the world the last slice left, never mid-slice.
    for (const q of asked) assert.equal(q.sim, (q.round - 1) * 5000, `round ${q.round} asked at ${q.sim}`);
    // The match clock stands still with the world: thinking time is no time in the game.
    const byRound = rounds.map(r => flushes.find(f => f.round === r).match);
    for (let i = 1; i < byRound.length; i++) assert.equal(byRound[i] - byRound[i - 1], 5000);
});

test('without lockstep the world runs on while seats think (the control)', () => {
    const { m, g, flushes } = roundBoard({ sliceMs: null, answerMs: 7000 });
    for (let i = 0; i < 60 * 10; i++) m.run(100);
    const rounds = [...new Set(flushes.map(f => f.round))];
    assert.ok(rounds.length >= 4);
    const gaps = rounds.slice(1).map((r, i) => flushes.find(f => f.round === r).sim - flushes.find(f => f.round === rounds[i]).sim);
    assert.ok(gaps.every(d => d >= 7000), 'the world ran through the thinking time: ' + gaps);
});

test('lockstep: slow and fast answers span the same world time per round', () => {
    const fast = roundBoard({ sliceMs: 2000, answerMs: 500 });
    const slow = roundBoard({ sliceMs: 2000, answerMs: 20000 });
    for (let i = 0; i < 90 * 10; i++) { fast.m.run(100); slow.m.run(100); }
    for (const { flushes } of [fast, slow]) for (const f of flushes) assert.equal(f.sim, (f.round - 1) * 2000);
    assert.ok(fast.flushes.length > slow.flushes.length, 'a fast seat plays more rounds per minute of wall time');
});

test('lockstep with no seat to wait for plays on, slice after slice', () => {
    const { m, g, seats } = roundBoard({ sliceMs: 5000, answerMs: 7000 });
    seats.forEach(c => { c.paused = true; });
    m.run(20000);
    assert.ok(g.clock.simMs >= 15000, 'world time ' + g.clock.simMs);
});

test('the contract names lockstep and its slice, so it never compares as plain turn-based', () => {
    const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
    const scope = vm.createContext({});
    for (const f of ['js/manifest.js', 'js/sha256.js', 'js/conditions.js'])
        vm.runInContext(fs.readFileSync(path.join(__dirname, '../..', f), 'utf8'), scope);
    const W = vm.runInContext('WarConditions', scope);
    assert.equal(W.protocolOf({ turnBased: false }), 'real-time');
    assert.equal(W.protocolOf({ turnBased: true }), 'turn-based');
    assert.equal(W.protocolOf({ turnBased: true, lockstepSliceMs: null }), 'turn-based');
    assert.equal(W.protocolOf({ turnBased: true, lockstepSliceMs: 5000 }), 'turn-based-lockstep-5000ms');
    assert.equal(W.protocolOf({ turnBased: false, lockstepSliceMs: 5000 }), 'real-time');
});
