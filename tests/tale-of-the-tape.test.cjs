'use strict';
// The tale of the tape (review #11): the seats side by side from the header, with how
// often each was helped counted from the notes, and how it finished.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');

function load(lines) {
    const context = vm.createContext({ console, t: (k, v) => k + (v ? JSON.stringify(v) : ''), document: { getElementById: () => null } });
    vm.runInContext(fs.readFileSync(path.join(root, 'js/analyzer.js'), 'utf8') + '\nthis.TA = TranscriptAnalyzer;', context);
    vm.runInContext(fs.readFileSync(path.join(root, 'js/ui.js'), 'utf8') + '\nthis.UI = UIManager;', context);
    const ui = Object.create(context.UI.prototype);
    ui.teamDotHtml = () => '';
    ui.analyzer = new context.TA(ui);
    ui.analyzer.load(lines.map(l => JSON.stringify(l)).join('\n'), 'x.jsonl');
    return { ui, a: ui.analyzer };
}

const match = [
    { type: 'match', players: [
        { id: 'p1', seat: 0, civ: 'greek', model: 'glm-5.3', name: 'GLM', settings: { provider: 'openai', servedBy: 'vllm', contextBudget: 131072, maxTokens: 8192, reasoning: 'low' } },
        { id: 'p2', seat: 1, civ: 'persian', model: 'ki', profile: 'turtle' },
    ] },
    { playerId: 'p1', at: 1000, state: { clock: { matchSeconds: 1 } }, harnessResult: 'OK' },
    { playerId: 'p1', at: 2000, state: { clock: { matchSeconds: 2 } }, harnessResult: 'OK' },
    { type: 'intervention', kind: 'advice', human: true, playerId: 'p1', at: 1500, matchSeconds: 1, text: 'build walls' },
    { type: 'intervention', kind: 'advice', human: true, playerId: 'p1', at: 1600, matchSeconds: 1, text: 'again' },
    { type: 'intervention', kind: 'seatPaused', human: true, playerId: 'p1', at: 1700, matchSeconds: 1 },
    { type: 'adaptation', kind: 'contextShrunk', playerId: 'p1', at: 1800, matchSeconds: 1 },
    { type: 'round_missed', playerId: 'p1', at: 1900, matchSeconds: 1 },
    { type: 'results', ranking: [{ rank: 1, playerId: 'p2', isWinner: true, alive: true }, { rank: 2, playerId: 'p1', isWinner: false, alive: false }] },
];

test('each seat as declared, and every time it was helped, counted from the notes', () => {
    const { a } = load(match);
    const [glm, house] = a.taleOfTheTape();
    assert.equal(glm.model, 'glm-5.3');
    assert.equal(glm.context, 131072);
    assert.equal(glm.reasoning, 'low');
    assert.equal(glm.turns, 2);
    assert.equal(glm.advised, 2);
    assert.equal(glm.paused, 1);
    assert.deepEqual({ ...glm.adaptations }, { contextShrunk: 1 });
    assert.equal(glm.missed, 1);
    assert.equal(glm.rank, 2);
    assert.equal(glm.alive, false);
    assert.equal(house.rule, true);
    assert.equal(house.profile, 'turtle');
    assert.equal(house.winner, true);
    assert.equal(house.advised, 0);
});

test('the card shows a row only where some seat has something to say', () => {
    const { ui } = load(match);
    const html = ui.anTaleHtml();
    for (const k of ['tt.model', 'tt.context', 'tt.reasoning', 'tt.advised', 'tt.paused', 'tt.adaptations', 'tt.missed', 'tt.result'])
        assert.ok(html.includes(k), k);
    for (const k of ['tt.temperature', 'tt.lanes', 'tt.toolFallback', 'tt.ownPrompt']) assert.ok(!html.includes(k), k);
    assert.ok(html.includes('contextShrunk ×1'));
    // One seat alone has nothing to compare against.
    const solo = load([match[0], match[1]].map((l, i) => i === 0 ? { ...l, players: [l.players[0]] } : l));
    assert.equal(solo.ui.anTaleHtml(), '');
});
