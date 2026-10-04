// The rolling history keeps its start while it fits, so a server's prefix cache can reuse
// the conversation (asp67, b1052). Taking the newest turns that fit dropped the oldest on
// every turn once the budget was full: GLM's turns went from ~18 s to ~100 s for the last
// two hours of a 197-minute match, every one a full recompute of a 110k-token prompt.
const test = require('node:test'), assert = require('node:assert/strict');
const { createMatch } = require('../tools/bench/realm.cjs');

test('the window keeps its first turn while it fits, and jumps once when it does not', async () => {
    const m = await createMatch({ kind: 'board', seed: 'history-window', seats: [
        { civ: 'greek', age: 'bronze', buildings: [['town_center', -250, 0]] },
        { civ: 'persian', age: 'bronze', buildings: [['town_center', 250, 0]] }] });
    const mgr = m.game.openAIAIManager, c = m.controllers[0];
    const est = s => String(s || '').length;            // one "token" per character
    const turn = i => ({ user: 'state ' + i + ' ' + 'x'.repeat(80), assistant: 'reply ' + i, outcome: 'ok' });
    c.turnLog = [];
    const firsts = [];
    for (let i = 0; i < 60; i++) {
        c.turnLog.push(turn(i));
        const turns = mgr.buildRollingTurns(c, 2000, est);
        firsts.push(Number(/state (\d+)/.exec(turns[0].content)[1]));
    }
    // About 17 turns fit; a jump leaves 60% (10 turns), so the start holds for the 7 or so
    // turns it takes to fill again. A slide changes it on every turn once full: 43 times.
    const at = firsts.map((f, i) => i && f !== firsts[i - 1] ? i : -1).filter(i => i > 0);
    assert.ok(at.length >= 3 && at.length <= 8, 'jumps, not a slide: ' + at.length + ' (' + [...new Set(firsts)].join(',') + ')');
    for (let k = 1; k < at.length; k++) assert.ok(at[k] - at[k - 1] >= 5, 'the start holds between jumps: ' + at.join(','));
    // After a jump the window sits well under the budget, and it never overflows it.
    const cost = p => est(p.user) + est(p.assistant) + est(p.outcome) + 16;
    const used = c.turnLog.slice(c.turnLog.indexOf(c._histAnchor)).reduce((a, p) => a + cost(p), 0);
    assert.ok(used <= 2000, 'within the budget: ' + used);
});

test('a lost anchor (a cleared log) starts over from the newest turns that fit', async () => {
    const m = await createMatch({ kind: 'board', seed: 'history-window-b', seats: [
        { civ: 'greek', age: 'bronze', buildings: [['town_center', -250, 0]] },
        { civ: 'persian', age: 'bronze', buildings: [['town_center', 250, 0]] }] });
    const mgr = m.game.openAIAIManager, c = m.controllers[0];
    const est = s => String(s || '').length;
    c.turnLog = Array.from({ length: 40 }, (_, i) => ({ user: 'state ' + i + ' ' + 'x'.repeat(80), assistant: 'r', outcome: 'ok' }));
    c._histAnchor = { user: 'not in the log' };
    const turns = mgr.buildRollingTurns(c, 2000, est);
    assert.ok(turns.length > 0 && /state 39/.test(turns[turns.length - 2].content || turns[turns.length - 1].content || ''), 'ends with the newest turn');
});
