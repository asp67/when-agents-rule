// Lockstep, an option of turn-based play (asp67, 27.09.2026). Since b1090 the slice is the
// most world time that passes while a round's seats think (asp67, 11.10.2026: no model may
// answer a state older than the setting). The slice starts over when a round is asked;
// the world plays on, a round ends as soon as every move is in, and the world halts at
// the slice's end if not. Until b1089 the world stood still through the thinking and
// played the whole slice after the moves, so a round took the thinking time plus the
// slice on screen: "impossible to play".
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
    mgr.executeTurn = actor => flushes.push({ round: mgr._roundNo, sim: g.clock.simMs, match: g.clock.matchMs, wall: m.runtime.Date.now(), seat: actor.id });
    return { m, g, mgr, seats, flushes, asked };
}

test('without lockstep the world runs on while seats think (the control)', () => {
    const { m, g, flushes } = roundBoard({ sliceMs: null, answerMs: 7000 });
    for (let i = 0; i < 60 * 10; i++) m.run(100);
    const rounds = [...new Set(flushes.map(f => f.round))];
    assert.ok(rounds.length >= 4);
    const gaps = rounds.slice(1).map((r, i) => flushes.find(f => f.round === r).sim - flushes.find(f => f.round === rounds[i]).sim);
    assert.ok(gaps.every(d => d >= 7000), 'the world ran through the thinking time: ' + gaps);
});

// The world never runs more than one slice past the state the current round was asked on.
function watch(board, wallMs) {
    const { m, g, mgr, asked } = board;
    let worst = 0, movedWhileWaiting = 0;
    for (let i = 0; i < wallMs / 100; i++) {
        const before = g.clock.simMs, waiting = mgr._roundPhase === 'wait';
        m.run(100);
        if (waiting && mgr._roundPhase === 'wait' && g.clock.simMs !== before) movedWhileWaiting++;
        if (asked.length) worst = Math.max(worst, g.clock.simMs - asked[asked.length - 1].sim);
    }
    return { worst, movedWhileWaiting };
}

test('lockstep: slow seats -- the world halts at the slice end, so no state is older than a slice', () => {
    const board = roundBoard({ sliceMs: 5000, answerMs: 7000 }), { flushes, asked, g } = board;
    const { worst, movedWhileWaiting } = watch(board, 60000);
    assert.ok(movedWhileWaiting > 0, 'the world stood still while the seats thought');
    assert.ok(worst <= 5000, 'the world ran ' + worst + ' ms past the state the seats were sent');
    const rounds = [...new Set(flushes.map(f => f.round))];
    assert.ok(rounds.length >= 4, 'rounds played: ' + rounds.length);
    // Thinking longer than the slice: each round spans exactly the slice.
    for (const q of asked) assert.equal(q.sim, (q.round - 1) * 5000, `round ${q.round} asked at ${q.sim}`);
    for (const f of flushes) assert.equal(f.sim, f.round * 5000, `round ${f.round} flushed at ${f.sim}`);
    // The match clock counts the slice and stands still past it.
    const byRound = rounds.map(r => flushes.find(f => f.round === r).match);
    for (let i = 1; i < byRound.length; i++) assert.equal(byRound[i] - byRound[i - 1], 5000);
    // On screen a round takes the longer of thinking and slice, not both: 7 s, not 12.
    const walls = rounds.map(r => flushes.find(f => f.round === r).wall);
    const gap = (walls[walls.length - 1] - walls[0]) / (walls.length - 1);
    assert.ok(gap < 7000 + 5000, 'wall time per round ' + gap);
});

test('lockstep: fast seats -- the round ends when the moves are in, and the slice starts over', () => {
    const board = roundBoard({ sliceMs: 20000, answerMs: 1000 }), { flushes, asked } = board;
    const { worst } = watch(board, 60000);
    assert.ok(worst <= 20000, 'the world ran ' + worst + ' ms past the state the seats were sent');
    const rounds = [...new Set(flushes.map(f => f.round))];
    assert.ok(rounds.length >= 10, 'rounds played: ' + rounds.length);
    // Every round's moves run before its slice is spent: nobody waits for the clock.
    for (const r of rounds) {
        const q = asked.find(a => a.round === r), f = flushes.find(x => x.round === r);
        assert.ok(f.sim > q.sim && f.sim - q.sim < 20000, `round ${r}: asked at ${q.sim}, moves at ${f.sim}`);
    }
    // And the next round is asked on the world as it stands, not at a slice boundary.
    assert.ok(asked.some(q => q.sim % 20000 !== 0), 'rounds asked only at slice boundaries');
});

test('lockstep: slow seats play the slice through, fast ones less of it', () => {
    const fast = roundBoard({ sliceMs: 2000, answerMs: 300 });
    const slow = roundBoard({ sliceMs: 2000, answerMs: 20000 });
    for (let i = 0; i < 90 * 10; i++) { fast.m.run(100); slow.m.run(100); }
    for (const f of slow.flushes) assert.equal(f.sim, f.round * 2000);
    const per = b => b.flushes[b.flushes.length - 1].sim / b.flushes[b.flushes.length - 1].round;
    assert.ok(per(fast) < 2000, 'fast rounds span ' + per(fast) + ' ms of world time');
    assert.ok(fast.flushes.length > slow.flushes.length, 'a fast seat plays more rounds per minute of wall time');
});

test('lockstep with no seat to wait for plays on, slice after slice', () => {
    const { m, g, seats } = roundBoard({ sliceMs: 5000, answerMs: 7000 });
    seats.forEach(c => { c.paused = true; });
    m.run(20000);
    assert.ok(g.clock.simMs >= 15000, 'world time ' + g.clock.simMs);
});

test('the contract names lockstep, its slice and its mode, so it never compares as plain turn-based', () => {
    const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
    const scope = vm.createContext({});
    for (const f of ['js/manifest.js', 'js/sha256.js', 'js/conditions.js'])
        vm.runInContext(fs.readFileSync(path.join(__dirname, '../..', f), 'utf8'), scope);
    const W = vm.runInContext('WarConditions', scope);
    assert.equal(W.protocolOf({ turnBased: false }), 'real-time');
    assert.equal(W.protocolOf({ turnBased: true }), 'turn-based');
    assert.equal(W.protocolOf({ turnBased: true, lockstepSliceMs: null }), 'turn-based');
    assert.equal(W.protocolOf({ turnBased: true, lockstepSliceMs: 5000 }), 'turn-based-lockstep-5000ms');
    // b1090: the slice caps how old a state gets -- not comparable with the frozen kind above.
    assert.equal(W.protocolOf({ turnBased: true, lockstepSliceMs: 5000, lockstepMode: 'max-age' }), 'turn-based-lockstep-max-age-5000ms');
    assert.equal(W.protocolOf({ turnBased: false, lockstepSliceMs: 5000 }), 'real-time');
});
