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
    // About 17 turns fit; a jump leaves 40% (7 turns, b1110; 60% before), so the start holds
    // for the 10 or so turns it takes to fill again. A slide changes it on every turn once
    // full: 43 times.
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

// asp67 (b1110): "if a user chooses a token limit that is only 50% of the context or a context
// that is very small, the jumps could not be able to save a % amount and still have at least
// 2 to 4 former turns in the session." A jump keeps at least the newest three turns, or as
// many of the newest as fit.
test('a jump keeps at least the newest three turns, or as many as fit', async () => {
    const m = await createMatch({ kind: 'board', seed: 'history-window-c', seats: [
        { civ: 'greek', age: 'bronze', buildings: [['town_center', -250, 0]] },
        { civ: 'persian', age: 'bronze', buildings: [['town_center', 250, 0]] }] });
    const mgr = m.game.openAIAIManager, c = m.controllers[0];
    const est = s => String(s || '').length;
    const turn = i => ({ user: 'state ' + i + ' ' + 'x'.repeat(80), assistant: 'reply ' + i, outcome: 'ok' });
    const pastTurns = turns => turns.filter(t => t.role === 'user').length;
    for (const [budget, least] of [[450, 3], [260, 2], [2000, 3]]) {   // about 3, 2 and 17 turns fit
        c.turnLog = []; c._histAnchor = null;
        let fewest = Infinity;
        for (let i = 0; i < 40; i++) {
            c.turnLog.push(turn(i));
            const n = pastTurns(mgr.buildRollingTurns(c, budget, est));
            if (i >= least) fewest = Math.min(fewest, n);
        }
        assert.ok(fewest >= least, budget + ': never fewer than ' + least + ' past turns after the first few: ' + fewest);
    }
});

// asp67's match of 24 October (21:12): seats set to a 32k context sent prompts of up to 33k
// tokens. The estimate missed the tool schemas and the replayed calls, and no fixed figure of
// characters per token holds across tokenizers and the four languages a seat can play in
// (asp67). The seat's server reports what each prompt took; the ratio scales later estimates.
test('the history is sized by what the seat\'s server reports, and the tool schemas count', async () => {
    const m = await createMatch({ kind: 'board', seed: 'history-window-d', seats: [
        { civ: 'greek', age: 'bronze', buildings: [['town_center', -250, 0]] },
        { civ: 'persian', age: 'bronze', buildings: [['town_center', 250, 0]] }] });
    const mgr = m.game.openAIAIManager, c = m.controllers[0];
    Object.assign(c.model, { contextSize: 32768, maxTokens: null, provider: 'openai', endpoint: 'http://localhost:1/v1' });
    const call = i => [{ id: 'call_' + i, name: 'train_unit', args: JSON.stringify({ unitType: 'militia', reason: 'more spears for the front, turn ' + i }) }];
    c.turnLog = Array.from({ length: 200 }, (_, i) => ({ user: 'state ' + i + ' ' + 'x'.repeat(1100), assistant: 'thinking about turn ' + i + ' '.repeat(10) + 'y'.repeat(300), outcome: 'OK - Training militia at barracks (~3s)', toolCalls: call(i) }));
    c._histAnchor = null;
    const gs = mgr.buildGameStateJSON(c);
    const pastTurns = r => r.turns.filter(t => t.role === 'user').length - 1;
    const first = mgr.buildTurnRequest(c, gs, { withRequest: false });
    // The tool schemas are in the budget: without them the request at 3 chars a token would
    // still be inside 80% of the window; with them, so is everything.
    const window = (32768 - (8192 + 1500)) * 0.8;
    assert.ok(first.rawEst <= window + 50, 'the whole request, schemas and replayed calls included, within the budget: ' + Math.round(first.rawEst) + ' of ' + Math.round(window));
    // The server reports 1.6 tokens for every one we estimated: the next request is sized to that.
    mgr.calibrateTokens(c, Math.round(first.rawEst * 1.6), first.rawEst);
    assert.ok(Math.abs(c._tokRatio - 1.6) < 1e-3, 'up at once: ' + c._tokRatio);
    c._histAnchor = null;
    const second = mgr.buildTurnRequest(c, gs, { withRequest: false });
    assert.ok(second.rawEst * 1.6 <= window + 80, 'in real tokens, within the budget: ' + Math.round(second.rawEst * 1.6));
    assert.ok(pastTurns(second) < pastTurns(first), 'fewer past turns: ' + pastTurns(second) + ' < ' + pastTurns(first));
    // One turn the server reports fewer tokens (a short state): the ratio eases down, not at once.
    mgr.calibrateTokens(c, Math.round(second.rawEst * 1.0), second.rawEst);
    assert.ok(c._tokRatio < 1.6 && c._tokRatio > 1.4, 'down slowly: ' + c._tokRatio);
});
