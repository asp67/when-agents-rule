'use strict';
// The Bench view (overhaul steps D2 to D4): js/eval/bench-view.js. Each test below is one
// of the checks the plan set for these steps.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const WarEval = require(path.join(root, 'js/eval/ledger.js'));
const { profileFile } = require(path.join(root, 'tools/eval/war-eval.cjs'));
const SAMPLE = path.join(root, 'samples/2026-10-05_gpt6.1-sol-claude-sonnet5.5-deepseek-v4.1-glm5.3_99min.jsonl');

// A page with the two panels and the button, and the UI class with the Bench view on it.
function page() {
    const els = {}, store = {}, body = new Set(), keys = [];
    const el = id => els[id] || (els[id] = { id, style: {}, innerHTML: '', classList: { toggle() {} }, setAttribute() {} });
    ['benchLeft', 'benchMatrix', 'benchBtn'].forEach(el);
    const context = vm.createContext({ console, Date, WarEval, t: (k, v) => k + (v ? JSON.stringify(v) : ''), getUiLang: () => 'en',
        OpenAIAIManager: { MAX_COMMANDS_PER_TURN: 3 },
        localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; } },
        document: { getElementById: id => els[id] || null, addEventListener: (type, fn) => keys.push(fn),
            body: { classList: { toggle: (c, on) => { if (on) body.add(c); else body.delete(c); }, contains: c => body.has(c) } } } });
    for (const f of ['js/ui.js', 'js/eval/bench-view.js']) vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8') + '\nthis.UI = UIManager;', context);
    const u = Object.create(context.UI.prototype);
    u.escapeHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
    const opened = [];
    Object.assign(u, { teamDotHtml: () => '', renderTranscriptViewer() {}, updateSpectatorPlayerList() {}, tvJumpTo: turn => opened.push(turn) });
    const ledger = WarEval.createLedger();
    u.game = { spectatorMode: true, gameStarted: true, openAIAIManager: { transcripts: { ledger } } };
    return { u, els, store, body, keys, ledger, opened };
}
// One decision of seat a or b: a plan, orders with their verdicts, and what the state showed under attack.
const decision = (id, sec, o = {}) => JSON.stringify({ turn: o.turn || 1, playerId: id, name: 'Seat ' + id, seat: id === 'a' ? 0 : 1, latencyMs: 4000,
    tokens: { prompt: 9000, completion: 300 },
    parsed: Object.assign({ commands: (o.orders || []).map(x => ({ action: x[0], params: x[1] || {} })) }, o.plan ? { objective: 'Hold the town', plan: o.plan } : null),
    outcomes: (o.orders || []).map((x, i) => ({ n: i + 1, action: x[0], code: 'c', verdict: x[2] || 'ok' })),
    state: { clock: { matchSeconds: sec }, population: { used: 20 }, threats: { underAttack: o.attack || [], enemyWonders: [] },
        units: { trainable: { barracks: { stone: [{ id: 'militia' }] } } }, buildings: { buildable: [{ type: 'tower' }, { type: 'barracks' }] },
        friendlyBuildings: [{ type: 'barracks', x: 100, z: 100 }], gameStats: { opponents: [{ id: 'maya-2', civilization: 'maya' }] } } });
const raid = [{ kind: 'building', type: 'barracks', x: 100, z: 100, attackerAt: { x: 108, z: 102, owner: 'maya-2' } }];
const cells = html => [...html.matchAll(/class="bm-cell[^"]*"[^>]*><b>([^<]*)<\/b>/g)].map(m => m[1]);

test('D2: the matrix shows the command-line scorer\'s values at match end', async () => {
    const { u, ledger } = page();
    for (const line of fs.readFileSync(SAMPLE, 'utf8').split('\n')) ledger.addLine(line);
    const scored = await profileFile(SAMPLE);                       // what tools/eval/war-eval.cjs prints
    const want = ['grounding', 'planning', 'follow', 'tactical'].flatMap(k => scored.seats.map(s => s[k].score == null ? '–' : String(Math.round(s[k].score))));
    const { right } = u.benchHtml(ledger);
    assert.deepEqual(cells(right), want);
    assert.equal(want.length, 16);
    // Under each score, the raw measure and the count it rests on.
    assert.match(right, /<small>99\.4 % · 351<\/small>/);              // Sonnet: valid commands of those judged
    assert.match(right, /<small>25\/33<\/small>/);                     // ...and plan steps acted on
    // The leader of a row is marked, and a cell says how it moved over the last ten minutes.
    assert.equal((right.match(/bm-cell is-lead/g) || []).length, 4);    // one per row: no two seats tie for a lead in this match
    assert.match(right, /class="bm-(up|down)" title="bench\.trendTip\{&quot;then&quot;:\d+\}">[▲▼]\d+</);
});

test('D2: every string of the Bench view is keyed in all four languages', () => {
    const context = vm.createContext({ window: {}, navigator: { language: 'en' }, localStorage: { getItem: () => null, setItem() {} },
        document: { documentElement: {}, querySelectorAll: () => [], addEventListener() {} } });
    vm.runInContext(fs.readFileSync(path.join(root, 'js/i18n.js'), 'utf8') + ';this.I = I18N;', context);
    const src = fs.readFileSync(path.join(root, 'js/eval/bench-view.js'), 'utf8') + fs.readFileSync(path.join(root, 'index.html'), 'utf8').split('\n').filter(l => /benchBtn/.test(l)).join('\n');
    const keys = new Set([...src.matchAll(/t\('([a-z]+\.[A-Za-z0-9.]+)'/g)].map(m => m[1]).concat([...src.matchAll(/data-i18n(?:-title)?="([^"]+)"/g)].map(m => m[1])));
    for (const state of ['acted', 'pending', 'dropped', 'late', 'uncheckable']) keys.add('bench.st.' + state);
    for (const dim of ['grounding', 'planning', 'follow', 'tactical']) keys.add('eval.' + dim);
    keys.delete('bench.st.'); keys.delete('eval.');                      // the two prefixes those are built from
    assert.ok(keys.size >= 30, 'only ' + keys.size + ' keys found: did the pattern change?');
    for (const lang of ['en', 'de', 'es', 'zh']) for (const k of keys) assert.ok(k in context.I[lang], lang + ' lacks ' + k);
    // No sentence is written into the markup itself.
    assert.doesNotMatch(fs.readFileSync(path.join(root, 'js/eval/bench-view.js'), 'utf8').replace(/\/\/.*$/gm, ''), />[A-Z][a-z]+ [a-z]+ [a-z]+</);
});

test('D3: a step never shows as done unless a recorded successful order backs it', () => {
    const tracker = lines => { const { u, ledger } = page(); lines.forEach(l => ledger.addLine(l)); return u.benchHtml(ledger).left; };
    const steps = html => [...html.matchAll(/<li class="is-(\w+)"[^>]*><i>.<\/i><span>([^<]*)<\/span>/g)].map(m => m[2] + ': ' + m[1]);
    const plan = ['Train militia', 'Build a tower', 'Stay flexible'];
    // Ordered, and refused: the step is not done.
    assert.deepEqual(steps(tracker([decision('a', 10, { plan, orders: [['train_unit', { unitType: 'militia' }, 'avoidable']] })])),
        ['Train militia: pending', 'Build a tower: pending', 'Stay flexible: uncheckable']);
    // Another unit trained: not done either.
    assert.deepEqual(steps(tracker([decision('a', 10, { plan, orders: [['train_unit', { unitType: 'archer' }]] })]))[0], 'Train militia: pending');
    // The order worked: done, and only that step.
    const done = tracker([decision('a', 10, { plan }), decision('a', 20, { turn: 2, orders: [['train_unit', { unitType: 'militia' }]] })]);
    assert.deepEqual(steps(done), ['Train militia: acted', 'Build a tower: pending', 'Stay flexible: uncheckable']);
    assert.match(done, /<small>\+1<\/small>/);                           // one decision after it was stated
    assert.match(done, /bench\.planAge\{&quot;time&quot;:&quot;0:10&quot;,&quot;n&quot;:1\}/);
    assert.match(done, /class="bp-objective">Hold the town</);
    // A file that records no outcomes cannot back anything: nothing is shown as done.
    const { u, ledger } = page();
    ledger.addLine(JSON.stringify({ turn: 1, playerId: 'a', parsed: { plan: ['Train militia'], commands: [{ action: 'train_unit', params: { unitType: 'militia' } }] },
        state: { clock: { matchSeconds: 5 }, units: { trainable: { barracks: { stone: [{ id: 'militia' }] } } } } }));
    assert.doesNotMatch(u.benchHtml(ledger).left, /is-acted/);
    // A seat without a plan says so.
    assert.match(tracker([decision('a', 10, {})]), /bench\.noPlan/);
});

test('D3: two seats\' plans side by side, and a third pin lets the oldest go', () => {
    const { u, ledger, els } = page();
    for (const id of ['a', 'b']) ledger.addLine(decision(id, 10, { plan: ['Build a tower'] }));
    ledger.addLine(JSON.stringify({ turn: 1, playerId: 'c', name: 'Seat c', seat: 2, parsed: { commands: [], plan: ['Scout'] }, state: { clock: { matchSeconds: 10 } } }));
    u.toggleBenchView(true);
    const plans = () => (els.benchLeft.innerHTML.match(/class="bp-seat"/g) || []).length;
    assert.equal(plans(), 1);                                            // the first seat with a plan, until someone picks
    u.benchPin('a'); u.benchPin('b');
    assert.equal(plans(), 2);
    u.benchPin('c');
    assert.deepEqual([plans(), u._benchSeats.join()], [2, 'b,c']);
    u.benchPin('b');
    assert.deepEqual([plans(), u._benchSeats.join()], [1, 'c']);
});

test('D4: a threat\'s clock starts when the seat was shown it, counts its decisions, and closes with the answer and the outcome', () => {
    const cards = lines => { const { u, ledger } = page(); lines.forEach(l => ledger.addLine(l)); return [...u.benchHtml(ledger).left.matchAll(/class="bc-card is-(\w+)"[^>]*><span class="bc-time">([^<]*)<\/span><span class="bc-line"><b>[^<]*<\/b> ([^<]*)</g)].map(m => [m[1], m[2], m[3].replace(/&quot;/g, '"')]); };
    const calm = (sec, turn) => decision('a', sec, { turn, orders: [['train_unit', { unitType: 'militia' }]] });
    // The fight may have begun any time before: the card carries the second of the state that first showed it.
    const shown = cards([calm(60, 1), decision('a', 100, { turn: 2, attack: raid, orders: [['train_unit', { unitType: 'militia' }]] })]);
    assert.deepEqual(shown, [['waiting', '1:40', 'barracks bench.by{"who":"maya-2"} · bench.waiting{"k":1,"n":3} · bench.ongoing']]);
    // The next decision still does not answer: the count goes on.
    assert.match(cards([calm(60, 1), decision('a', 100, { turn: 2, attack: raid }), decision('a', 130, { turn: 3, attack: raid })])[0][2], /bench\.waiting\{"k":2,"n":3\}/);
    // Answered at once, and the building held.
    assert.deepEqual(cards([calm(60, 1), decision('a', 100, { turn: 2, attack: raid, orders: [['attack_target', { targetX: 105, targetZ: 100 }]] }), calm(130, 3)])[0],
        ['answered', '1:40', 'barracks bench.by{"who":"maya-2"} · bench.answered0 · bench.held']);
    // Answered two decisions on: counted, but not "at once".
    assert.deepEqual(cards([calm(60, 1), decision('a', 100, { turn: 2, attack: raid }), calm(130, 3), decision('a', 160, { turn: 4, orders: [['attack_target', { targetX: 105, targetZ: 100 }]] })])[0].slice(0, 2), ['slow', '1:40']);
    // Three decisions without an aimed order: no answer, and what it cost.
    const lost = cards([calm(60, 1), decision('a', 100, { turn: 2, attack: raid }), JSON.stringify(Object.assign(JSON.parse(calm(130, 3)), { state: Object.assign(JSON.parse(calm(130, 3)).state, { friendlyBuildings: [] }) })), calm(160, 4), calm(190, 5)]);
    assert.deepEqual(lost[0], ['missed', '1:40', 'barracks bench.by{"who":"maya-2"} · bench.unanswered · bench.lost{"what":"barracks"}']);
    assert.match((() => { const { u, ledger } = page(); ledger.addLine(calm(60, 1)); return u.benchHtml(ledger).left; })(), /bench\.noThreat/);
});

test('the view is off until asked for, B switches it, and it redraws only when a line has arrived', () => {
    const { u, els, body, keys, store, ledger, opened } = page();
    u.refreshBenchView();
    assert.deepEqual([u.benchOn(), body.has('bench-view'), els.benchMatrix.style.display, els.benchMatrix.innerHTML], [false, false, 'none', '']);
    assert.equal(keys.length, 1);
    const press = (key, target) => keys[0]({ key, target: target || {}, preventDefault() {} });
    press('b');
    assert.deepEqual([u.benchOn(), body.has('bench-view'), els.benchMatrix.style.display, JSON.parse(store.warViewPreferencesV1).bench], [true, true, '', true]);
    assert.match(els.benchMatrix.innerHTML, /bench\.none/);              // nothing recorded yet, and it says so
    press('b', { tagName: 'INPUT' });                                   // typing a b into the advice box is not the switch
    assert.equal(u.benchOn(), true);
    ledger.addLine(decision('a', 10, { plan: ['Build a tower'], orders: [['train_unit', { unitType: 'militia' }, 'avoidable']] }));
    u.updateBenchView();
    const first = els.benchMatrix.innerHTML;
    assert.deepEqual(cells(first), ['0', '100', '–', '–']);               // one refused order of one; a plan of one checkable step; nothing closed; no threat
    els.benchMatrix.innerHTML = 'untouched';
    u.updateBenchView();
    assert.equal(els.benchMatrix.innerHTML, 'untouched');
    ledger.addLine(decision('a', 20, { turn: 2 }));
    u.updateBenchView();
    assert.notEqual(els.benchMatrix.innerHTML, 'untouched');
    // A cell opens the decisions behind it, and each of those opens in the transcript.
    u.benchShowEvidence('grounding', 'a');
    assert.match(els.benchMatrix.innerHTML, /bench-evidence.*openTranscriptTurn\('a', 1\).*#1 0:10<\/span> c</s);
    u.openTranscriptTurn('a', 1);
    assert.deepEqual([u._transcriptFor, u._tvPinned, opened.join()], ['a', 1, '1']);
    u.benchShowEvidence('grounding', 'a');                              // the same cell again closes it
    assert.doesNotMatch(els.benchMatrix.innerHTML, /bench-evidence/);
    press('B');
    assert.deepEqual([u.benchOn(), body.has('bench-view'), els.benchLeft.style.display], [false, false, 'none']);
});
