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
    const els = {}, store = {}, body = new Set(), keys = [], vars = {};
    const el = id => els[id] || (els[id] = { id, style: {}, innerHTML: '', classList: { toggle() {} }, setAttribute() {} });
    ['benchMatrix', 'benchFull', 'benchBtn'].forEach(el);
    const context = vm.createContext({ console, Date, WarEval, t: (k, v) => k + (v ? JSON.stringify(v) : ''), getUiLang: () => 'en',
        OpenAIAIManager: { MAX_COMMANDS_PER_TURN: 3 },
        localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; } },
        document: { getElementById: id => els[id] || null, addEventListener: (type, fn) => keys.push(fn),
            // An element made by the page: it is in the document once appended, and gone once removed.
            createElement: () => { const cls = new Set(); const e = { style: {}, innerHTML: '', writes: 0, setAttribute() {},
                classList: { add: c => cls.add(c), remove: c => cls.delete(c), contains: c => cls.has(c) }, remove() { delete els[e.id]; } };
                let html = ''; Object.defineProperty(e, 'innerHTML', { get: () => html, set: v => { html = v; e.writes++; } }); return e; },
            body: { appendChild: e => { els[e.id] = e; }, style: { setProperty: (k, v) => { vars[k] = v; }, removeProperty: k => { delete vars[k]; } },
                classList: { toggle: (c, on) => { if (on) body.add(c); else body.delete(c); }, contains: c => body.has(c) } } } });
    for (const f of ['js/ui.js', 'js/eval/bench-view.js']) vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8') + '\nthis.UI = UIManager;', context);
    const u = Object.create(context.UI.prototype);
    u.escapeHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
    const opened = [];
    Object.assign(u, { teamDotHtml: () => '', renderTranscriptViewer() {}, updateSpectatorPlayerList() {}, tvJumpTo: turn => opened.push(turn) });
    const ledger = WarEval.createLedger();
    u.game = { spectatorMode: true, gameStarted: true, openAIAIManager: { transcripts: { ledger } } };
    return { u, els, store, body, keys, ledger, opened, vars };
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
const cells = html => [...html.matchAll(/class="bm-cell[^"]*"[^>]*><div class="bm-top"><b>([^<]*)<\/b>/g)].map(m => m[1]);

test('D2: the matrix shows the command-line scorer\'s values at match end', async () => {
    const { u, ledger } = page();
    for (const line of fs.readFileSync(SAMPLE, 'utf8').split('\n')) ledger.addLine(line);
    const scored = await profileFile(SAMPLE);                       // what tools/eval/war-eval.cjs prints
    const want = WarEval.SCORED.flatMap(k => scored.seats.map(s => s[k].score == null ? '–' : String(Math.round(s[k].score))));
    const { right } = u.benchHtml(ledger);
    assert.deepEqual(cells(right), want);
    assert.equal(want.length, 20);
    // Under each score, the raw measure and the count it rests on.
    assert.match(right, /<small>99\.7 % · 349<\/small>/);              // Sonnet: valid commands of those rated (one wait + stale drift left out)
    assert.match(right, /<small>90\.6 % bw · 0 pw<\/small>/);         // Sonnet: situational batching bandwidth & zero passive waits
    assert.match(right, /<small>46% · 3\/3<\/small>/);                 // Sonnet: map explored & all 3 rivals discovered
    // The leader of a row is marked, and a cell says how it moved over the last ten minutes.
    assert.equal((right.match(/bm-cell is-lead/g) || []).length, 5);    // one per row: no two seats tie for a lead in this match
    // Strategy: trajectory dominance and final placement; at match end placement is blended, so no trend arrow.
    assert.match(right, /<small>48 · #1<\/small>/);                    // GLM, the winner
    assert.doesNotMatch(right.split('eval.strategy<')[1].split('bm-indexrow')[0], /bm-(up|down)/);
    // Under the scored rows: WAR Score, action batching bar, range used, and duration-invariant cost.
    const index = [...right.matchAll(/class="bm-index[^"]*"[^>]*><b>([^<]*)<\/b><small>bench\.indexOf\{&quot;n&quot;:(\d)\}/g)].map(m => m[1] + '/' + m[2]);
    assert.deepEqual(index, scored.seats.map(s => Math.round(s.index.value) + '/' + s.index.of));
    assert.deepEqual(index, ['50/5', '78/5', '72/5', '76/5']);
    assert.match(right, /bench\.range<small>bench\.rangeUnit<\/small><\/th>.*<b>11 · 10 · 13<\/b><\/td>/s);
    assert.match(right, /bench\.rangeTip\{&quot;units&quot;:&quot;archer, cavalry, champion/);
    assert.ok(right.indexOf('bm-indexrow') < right.indexOf('bench.b.batchShort<')
        && right.indexOf('bench.b.batchShort<') < right.indexOf('bench.range<')
        && right.indexOf('bench.range<') < right.indexOf('bench.eff<'));
    // The strategy cell opens what the match recorded: the ages, the lead, the battles.
    u.benchShowEvidence('strategy', scored.seats[1].id);                // Sonnet: led clearly from 58:13 and came second
    const ev = u.benchHtml(ledger).right.split('bench-evidence')[1];
    assert.match(ev, /6:52<\/span> age\.neolithic.*13:32<\/span> age\.bronze.*22:22<\/span> age\.iron.*58:13<\/span> bench\.lead · bench\.leadLost.*bench\.battles\{&quot;n&quot;:36,&quot;destroyed&quot;:127,&quot;lost&quot;:144\}/s);
    assert.doesNotMatch(ev, /benchOpenTurn/);
    u.benchShowEvidence('strategy', scored.seats[1].id);
    assert.match(right, /class="bm-(up|down)" title="bench\.trendTip\{&quot;then&quot;:\d+\}">[▲▼]\d+</);
});

test('D2: every string of the Bench view is keyed in all four languages', () => {
    const context = vm.createContext({ window: {}, navigator: { language: 'en' }, localStorage: { getItem: () => null, setItem() {} },
        document: { documentElement: {}, querySelectorAll: () => [], addEventListener() {} } });
    vm.runInContext(fs.readFileSync(path.join(root, 'js/i18n.js'), 'utf8') + ';this.I = I18N;', context);
    const src = fs.readFileSync(path.join(root, 'js/eval/bench-view.js'), 'utf8') + fs.readFileSync(path.join(root, 'index.html'), 'utf8').split('\n').filter(l => /benchBtn/.test(l)).join('\n');
    const keys = new Set([...src.matchAll(/t\('([a-z]+\.[A-Za-z0-9.]+)'/g)].map(m => m[1]).concat([...src.matchAll(/data-i18n(?:-title)?="([^"]+)"/g)].map(m => m[1])));
    for (const dim of WarEval.SCORED) {
        keys.add('eval.' + dim);
        keys.add('eval.glyph.' + dim);
        keys.add('bench.cmp.' + dim);
    }
    for (const k of ['bandwidth', 'drift']) keys.add('bench.cmp.' + k);
    for (const kind of ['loop', 'awareness', 'constraint', 'passive', 'threat', 'refused']) {
        keys.add('bench.t.' + kind);
        keys.add('bench.t.' + kind + 'Tip');
    }
    for (const k of ['bench.mode.lockstep', 'bench.mode.realtime', 'bench.mode.lockstepShort', 'bench.mode.realtimeShort',
        'bench.warmup', 'bench.warmupShort', 'bench.early', 'bench.leadWon', 'bench.leadLost',
        'eval.index', 'eval.indexTip', 'eval.indexShort', 'sum.openAnalyzer', 'sum.legacy',
        'age.neolithic', 'age.bronze', 'age.iron', 'spec.compareTitle']) keys.add(k);
    for (const prefix of ['eval.', 'eval.glyph.', 'bench.cmp.', 'bench.t.', 'age.']) keys.delete(prefix);
    assert.ok(keys.size >= 40, 'only ' + keys.size + ' keys found: did the pattern change?');
    for (const lang of ['en', 'de', 'es', 'zh']) for (const k of keys) assert.ok(k in context.I[lang], lang + ' lacks ' + k);
    // No sentence is written into the markup itself.
    assert.doesNotMatch(fs.readFileSync(path.join(root, 'js/eval/bench-view.js'), 'utf8').replace(/\/\/.*$/gm, ''), />[A-Z][a-z]+ [a-z]+ [a-z]+</);
});

test('D3: the left Plan & Threat drawer is removed so Bench shows only the right Comparison card', () => {
    const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    const view = fs.readFileSync(path.join(root, 'js/eval/bench-view.js'), 'utf8');
    const css = fs.readFileSync(path.join(root, 'css/styles.css'), 'utf8');
    assert.doesNotMatch(html, /benchLeft|bench-left/);
    assert.doesNotMatch(view, /benchLeft|bp-grid|bp-seat|bench-clockhead|bc-card/);
    assert.doesNotMatch(css, /\.bench-left\b|\.bp-grid\b|\.bc-card\b/);
    // Toggling Bench shows only #benchMatrix with the mini card even when a seat stated a plan.
    const { u, els, ledger } = page();
    ledger.addLine(decision('a', 10, { plan: ['Build a tower'] }));
    u.toggleBenchView(true);
    assert.equal(els.benchMatrix.style.display, '');
    assert.match(els.benchMatrix.innerHTML, /class="bb is-mini"/);
    assert.equal(u.benchHtml(ledger).left, undefined);
});

test('D4: a threat\'s clock starts when the seat was shown it, counts its decisions, and closes with the answer and the outcome in tactical evidence', () => {
    const cards = lines => {
        const { u, ledger } = page();
        lines.forEach(l => ledger.addLine(l));
        u.benchShowEvidence('tactical', 'a');
        const ev = (u.benchHtml(ledger).right.split('bench-evidence')[1]) || '';
        return [...ev.matchAll(/<span class="be-when">#\d+ ([^<]*)<\/span> ([^<]*)<\/li>/g)].map(m => [m[1], m[2].replace(/&quot;/g, '"')]);
    };
    const calm = (sec, turn) => decision('a', sec, { turn, orders: [['train_unit', { unitType: 'militia' }]] });
    // The fight may have begun any time before: tactical evidence carries the second of the state that first showed it.
    const shown = cards([calm(60, 1), decision('a', 100, { turn: 2, attack: raid, orders: [['train_unit', { unitType: 'militia' }]] })]);
    assert.deepEqual(shown, [['1:40', 'barracks bench.by{"who":"maya-2"} · bench.waiting{"k":1,"n":3} · bench.ongoing']]);
    // The next decision still does not answer: the count goes on.
    assert.match(cards([calm(60, 1), decision('a', 100, { turn: 2, attack: raid }), decision('a', 130, { turn: 3, attack: raid })])[0][1], /bench\.waiting\{"k":2,"n":3\}/);
    // Answered at once, and the building held.
    assert.deepEqual(cards([calm(60, 1), decision('a', 100, { turn: 2, attack: raid, orders: [['attack_target', { targetX: 105, targetZ: 100 }]] }), calm(130, 3)])[0],
        ['1:40', 'barracks bench.by{"who":"maya-2"} · bench.answered0 · bench.held']);
    // Answered two decisions on: counted, and marked slow (answered2).
    assert.deepEqual(cards([calm(60, 1), decision('a', 100, { turn: 2, attack: raid }), calm(130, 3), decision('a', 160, { turn: 4, orders: [['attack_target', { targetX: 105, targetZ: 100 }]] })])[0],
        ['1:40', 'barracks bench.by{"who":"maya-2"} · bench.answered2 · bench.held']);
    // Three decisions without an aimed order: no answer, and what it cost.
    const lost = cards([calm(60, 1), decision('a', 100, { turn: 2, attack: raid }), JSON.stringify(Object.assign(JSON.parse(calm(130, 3)), { state: Object.assign(JSON.parse(calm(130, 3)).state, { friendlyBuildings: [] }) })), calm(160, 4), calm(190, 5)]);
    assert.deepEqual(lost[0], ['1:40', 'barracks bench.by{"who":"maya-2"} · bench.unanswered · bench.lost{"what":"barracks"}']);
    const none = page(); none.ledger.addLine(calm(60, 1)); none.u.benchShowEvidence('tactical', 'a');
    assert.match(none.u.benchHtml(none.ledger).right, /bench-evidence.*bench\.nothing/s);
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
    // On screen is the mini card: the comparison board, a column a model (builds 1222 and 1227). A click opens it at
    // full size. The matrix is the report card's on the results screen: the same markup from the same ledger.
    assert.match(els.benchMatrix.innerHTML, /<div class="bb is-mini" style="--n:1"[^>]*onclick="game\.ui\.toggleBenchFull\(true\)"/);
    assert.deepEqual([cells(els.benchMatrix.innerHTML).length, els.benchFull.innerHTML, els.benchFull.style.display], [0, '', 'none']);
    const matrix = () => u.benchHtml(ledger).right;
    const expectedCells = () => {
        const s = ledger.profile().seats[0];
        return WarEval.SCORED.map(k => s[k].score == null ? '–' : String(Math.round(s[k].score)));
    };
    assert.deepEqual(cells(matrix()), ['61', '52', '0', '50', '–']);     // Bayesian K=8 grounding, pop-20 macro dev, 0 spatial, peaceful tactical prior (50*activityGate), no power reading yet
    assert.deepEqual(cells(matrix()), expectedCells());
    // A new reading on the timeline redraws the panels too: even power -> Bradley-Terry tie = 50.
    u.game._timeline = { samples: [{ t: 5, p: { a: { pw: 300 }, b: { pw: 300 } } }], ages: [] };
    u.updateBenchView();
    assert.deepEqual(cells(matrix()), ['61', '52', '0', '50', '50']);
    assert.deepEqual(cells(matrix()), expectedCells());
    els.benchMatrix.innerHTML = 'untouched';
    u.updateBenchView();
    assert.equal(els.benchMatrix.innerHTML, 'untouched');
    ledger.addLine(decision('a', 20, { turn: 2 }));
    u.updateBenchView();
    assert.notEqual(els.benchMatrix.innerHTML, 'untouched');
    // A cell opens the decisions behind it, and each of those opens in the transcript.
    u.benchShowEvidence('grounding', 'a');
    assert.match(matrix(), /bench-evidence.*benchOpenTurn\('a', 1\)" title="bench\.open".*#1 0:10<\/span> c · bench\.b\.constraints<\/li>/s);
    u.benchOpenTurn('a', 1);
    assert.deepEqual([u._transcriptFor, u._tvPinned, opened.join()], ['a', 1, '1']);
    u.benchShowEvidence('macro', 'a');
    assert.match(matrix(), /bench-evidence.*bench\.evMacro/s);
    u.benchShowEvidence('spatial', 'a');
    assert.match(matrix(), /bench-evidence.*bench\.evSpatial/s);
    u.benchShowEvidence('spatial', 'a');                               // the same cell again closes it
    assert.doesNotMatch(matrix(), /bench-evidence/);
    // The board at full size holds the grid and no matrix; Escape, or its button, closes it, and the mini card stays.
    u.toggleBenchFull(true);
    assert.equal(els.benchFull.style.display, '');
    assert.match(els.benchFull.innerHTML, /<div class="bb" style="--n:1">/);
    assert.equal(cells(els.benchFull.innerHTML).length, 0);
    assert.equal(keys.length, 2);
    keys[1]({ key: 'Escape' });
    assert.deepEqual([u._benchFull, els.benchFull.style.display, els.benchFull.innerHTML], [false, 'none', '']);
    assert.match(els.benchMatrix.innerHTML, /bb is-mini/);
    press('B');
    assert.deepEqual([u.benchOn(), body.has('bench-view'), els.benchMatrix.style.display], [false, false, 'none']);
});

test('D8: the results screen shows the same matrix, and a decision opens where it can be read', async () => {
    const { u, els, ledger, opened } = page();
    const cls = new Set(), calls = [];
    els.arenaSummaryScreen = { classList: { contains: c => cls.has(c) } };
    els.summaryProfile = { style: {}, innerHTML: '' };
    // No model seat has decided anything: there is no card.
    u.updateSummaryProfile();
    assert.deepEqual([els.summaryProfile.style.display, els.summaryProfile.innerHTML], ['none', '']);
    ledger.addLine(decision('a', 10, { plan: ['Build a tower'], orders: [['train_unit', { unitType: 'militia' }, 'avoidable']] }));
    // The Results card over a running match: the Bench view's own matrix, and a note under it.
    cls.add('active'); cls.add('snapshot');
    u.benchShowEvidence('grounding', 'a');
    assert.equal(els.summaryProfile.style.display, '');
    const card = els.summaryProfile.innerHTML;
    assert.ok(card.startsWith(u.benchHtml(ledger).right), 'the card is the matrix the Bench view draws');
    assert.match(card, /<p class="summary-profile-note">sum\.profileNote<\/p>$/);
    assert.match(card, /benchOpenTurn\('a', 1\)" title="bench\.open"/);
    // The card is redrawn every second while it is up; nothing is rebuilt unless something changed.
    els.summaryProfile.innerHTML = 'untouched';
    u.updateSummaryProfile();
    assert.equal(els.summaryProfile.innerHTML, 'untouched');
    // A decision clicked there: the card closes and the transcript panel opens at it.
    u.closeArenaSnapshot = () => { calls.push('close'); cls.clear(); };
    u.benchOpenTurn('a', 1);
    assert.deepEqual([calls.join(), u._transcriptFor, opened.join()], ['close', 'a', '1']);
    // After the end the match is read in the analyzer: at that seat (counted from 1, as a
    // moment link does) and that decision. The tooltip says the click leaves the screen.
    cls.add('active');
    let held = true;
    u.game.openAIAIManager.transcripts.hasData = () => held;
    u.watchInAnalyzer = async () => { calls.push('analyzer'); };
    u.anApplyMoment = m => { calls.push('moment ' + m.seat + '/' + m.turn); };
    u.updateSummaryProfile();
    assert.match(els.summaryProfile.innerHTML, /benchOpenTurn\('a', 1\)" title="sum\.openAnalyzer"/);
    await u.benchOpenTurn('a', 1);
    assert.deepEqual(calls.slice(1), ['analyzer', 'moment 1/1']);
    // Once the transcript is gone there is nothing to open, and nothing offers to.
    held = false;
    u.updateSummaryProfile();
    assert.doesNotMatch(els.summaryProfile.innerHTML, /benchOpenTurn/);
    assert.match(els.summaryProfile.innerHTML, /#1 0:10<\/span> c · bench\.b\.constraints<\/li>/); // the list is still there to read
    assert.equal(u.benchOpenTurn('a', 1), undefined);
    assert.equal(calls.length, 3);
});

test('the panels are an overlay of either mode: under the mode\'s own top strip, switched by B, and R for the race chart', () => {
    const { u, els, body, keys, vars } = page();
    els.spectatorHUD = { getBoundingClientRect: () => ({ bottom: 81, height: 67 }) };
    els.broadcastBoard = { getBoundingClientRect: () => ({ bottom: 122, height: 110 }) };    // many seats: wrapped to two rows
    let race = 0, board = 0;
    u.toggleRaceChart = () => { race++; };
    u.renderBroadcast = () => { board++; };
    const press = key => keys[0]({ key, target: {}, preventDefault() {} });
    u.refreshBenchView();
    press('r');                                                         // no race chart on this page yet: nothing to switch
    assert.equal(race, 0);
    els.raceChart = { style: {} };
    // Analyze mode: on, under the bar, and the bar's own panels are not touched.
    press('b');
    assert.deepEqual([u.benchOn(), vars['--bench-top'], body.has('tv-open'), board], [true, '91px', false, 0]);
    assert.equal(els.benchMatrix.style.display, '');
    // Into broadcast mode: still on, now under the scoreboard, however tall it is.
    body.add('broadcast-mode');
    u.updateBenchView();
    assert.deepEqual([u.benchOn(), vars['--bench-top']], [true, '132px']);
    // There the bar is gone: B and the icon on the board are the switch, and the icon is redrawn.
    press('B');
    assert.deepEqual([u.benchOn(), els.benchMatrix.style.display, board], [false, 'none', 1]);
    press('b');
    assert.deepEqual([u.benchOn(), els.benchMatrix.style.display, board], [true, '', 2]);
    press('r'); press('R');
    assert.equal(race, 2);
    press('r', { tagName: 'INPUT' });
    // A smaller UI size zooms the panels, so the measured offset is divided back out.
    u.viewPreferences().uiScale = 'medium';
    u.updateBenchView();
    assert.equal(vars['--bench-top'], Math.round(132 / 0.85) + 'px');
    // The transcript panel shares the slot beside the leaderboard: the stylesheet is told when it is up.
    u._transcriptFor = 'a';
    u.updateBenchView();
    assert.equal(body.has('tv-open'), true);
    u._transcriptFor = null;
    u.updateBenchView();
    assert.equal(body.has('tv-open'), false);
});

// ---- broadcast comparisons (step D7) -------------------------------------------------
const seatsOf = list => Array.from(list, x => x.key + ':' + Array.from(x.seats, s => s.name + '=' + Math.round(s.score) + '/' + s.n).join(','));
const keysOf = list => Array.from(list, x => x.key);

test('D7: a part is broadcast only when every model seat has had a handful of opportunities', async () => {
    const { u, ledger } = page();
    const work = (id, n, o = {}) => Array.from({ length: n }, (_, i) => decision(id, 10 + i * 10, Object.assign({ turn: i + 1, orders: [['train_unit', { unitType: 'militia' }, i % 4 ? 'ok' : 'avoidable']] }, i ? null : o)));
    // One model seat: nothing to compare, whatever it has done.
    work('a', 8).forEach(l => ledger.addLine(l));
    assert.deepEqual(keysOf(u.compareList(ledger.profile())), []);
    // Two seats, eight commands and eight decisions each: Grounding, Macro, Spatial, and Bandwidth.
    // No threat or battle occurred and no power reading exists: Tactical and Strategy stay off air.
    work('b', 8, { plan: ['Build a tower'] }).forEach(l => ledger.addLine(l));
    const two = u.compareList(ledger.profile());
    assert.deepEqual(keysOf(two), ['grounding', 'macro', 'spatial', 'bandwidth']);
    for (const item of two) for (const s of item.seats) assert.equal(typeof s.n, 'number', item.key);
    assert.deepEqual(seatsOf(two), [
        'grounding:Seat a=57/8,Seat b=57/8',
        'macro:Seat a=52/8,Seat b=52/8',
        'spatial:Seat a=0/8,Seat b=0/8',
        'bandwidth:Seat a=52/8,Seat b=52/8'
    ]);
    // Four of something is not a handful: with seat c in the match, only four commands in, everything stays off air.
    const few = WarEval.createLedger();
    work('a', 8).concat(work('b', 4)).forEach(l => few.addLine(l));
    assert.deepEqual(keysOf(u.compareList(few.profile())), []);
    // Five minutes of power readings bring Strategy on.
    ledger.preview({ samples: Array.from({ length: 60 }, (_, i) => ({ t: i * 5, p: { a: { pw: 300 }, b: { pw: 500 } } })), ages: [] });
    assert.deepEqual(keysOf(u.compareList(ledger.profile())), ['grounding', 'macro', 'spatial', 'strategy', 'bandwidth']);
    ledger.preview({ samples: [{ t: 0, p: { a: { pw: 300 }, b: { pw: 500 } } }], ages: [] });
    // The 5 October match at its end: all 7 Scale v4 slides qualify (all 4 seats >= 5 rated/battles/60pw/16dec).
    const full = WarEval.createLedger();
    for (const line of fs.readFileSync(SAMPLE, 'utf8').split('\n')) full.addLine(line);
    const list = u.compareList(full.profile());
    assert.deepEqual(keysOf(list), ['grounding', 'macro', 'spatial', 'tactical', 'strategy', 'bandwidth', 'drift']);
    // What is shown is the scorer's number with the count it rests on, and the best seat is marked unless two tie or warmup holds.
    const scored = await profileFile(SAMPLE);
    assert.deepEqual(Array.from(list[0].seats, s => s.name + ' ' + s.score + ' ' + s.n), scored.seats.map(s => s.name + ' ' + s.grounding.score + ' ' + s.grounding.rated));
    const html = u.compareHtml(list[0]);
    assert.match(html, /^<div class="bcmp-head"><b>eval\.grounding<\/b><span>bench\.cmp\.grounding<\/span><em>eval\.provisional<\/em><\/div>/);
    assert.equal((html.match(/class="bcmp-seat/g) || []).length, 4);
    assert.match(html, /class="bcmp-seat is-lead"[^>]*><span class="bcmp-name">O claude-sonnet-5\.5<\/span><span class="bcmp-val"><b>99<\/b><i class="bcmp-bar"><u style="width:99%"><\/u><\/i><small>99\.7 % · 349<\/small>/);
    assert.equal((html.match(/is-lead/g) || []).length, 1);
    assert.doesNotMatch(u.compareHtml({ key: 'macro', seats: [{ id: 'a', name: 'A', score: 50, raw: '' }, { id: 'b', name: 'B', score: 50, raw: '' }] }), /is-lead/);
    // Warmup suppresses the lead highlight and labels the badge accordingly.
    const warmHtml = u.compareHtml({ key: 'macro', warmup: true, seats: [{ id: 'a', name: 'A', score: 80, raw: '' }, { id: 'b', name: 'B', score: 40, raw: '' }] });
    assert.doesNotMatch(warmHtml, /is-lead/);
    assert.match(warmHtml, /<em>bench\.warmupShort<\/em>/);
});

test('D7: one comparison at a time, in broadcast mode only, and never while a caption is up', () => {
    const { u, els, body, keys, store, ledger } = page();
    let board = 0;
    u.renderBroadcast = () => { board++; };
    const press = key => keys[0]({ key, target: {}, preventDefault() {} });
    const work = (id, o) => Array.from({ length: 8 }, (_, i) => decision(id, 10 + i * 10, Object.assign({ turn: i + 1, orders: [['train_unit', { unitType: 'militia' }, 'ok']] }, i ? null : o)));
    work('a', { plan: ['Build a tower'] }).concat(work('b')).forEach(l => ledger.addLine(l));
    u.refreshBenchView();
    const strip = () => els.compareStrip, shown = () => !!strip() && strip().classList.contains('is-in');
    const part = () => {
        const h = strip().innerHTML;
        const m = /<b>(?:eval\.(\w+)|bench\.b\.(batchDist|driftTitle))<\/b>/.exec(h);
        return m && (m[1] || (m[2] === 'batchDist' ? 'bandwidth' : 'drift'));
    };
    // Off until asked for, and C means nothing outside broadcast mode.
    u.updateCompare(1000);
    press('c');
    assert.deepEqual([u.compareOn(), strip()], [false, undefined]);
    body.add('broadcast-mode');
    u.updateCompare(1000);
    assert.equal(strip(), undefined);
    press('c');
    assert.deepEqual([u.compareOn(), JSON.parse(store.warViewPreferencesV1).compare, board], [true, true, 1]);
    // The first part, then the next after nine seconds, round and round. (The switch drew it once
    // on the real clock; from here the test's own clock runs.)
    u._cmp = null;
    u.updateCompare(1000);
    assert.deepEqual([shown(), part()], [true, 'grounding']);
    const writes = strip().writes;
    u.updateCompare(5000);
    assert.deepEqual([part(), strip().writes], ['grounding', writes]);              // nothing is redrawn while it stands
    u.updateCompare(10000);
    assert.equal(part(), 'macro');
    u.updateCompare(19000);
    assert.equal(part(), 'spatial');
    u.updateCompare(28000);
    assert.equal(part(), 'bandwidth');
    u.updateCompare(37000);
    assert.equal(part(), 'grounding');
    // A caption comes up: the strip steps aside, stays away three seconds after it, and returns with the next part.
    u._chronicleTimer = 7;
    u.updateCompare(39000);
    assert.equal(shown(), false);
    u._chronicleTimer = null;
    u.updateCompare(41000);
    assert.equal(shown(), false);
    u.updateCompare(42100);
    assert.deepEqual([shown(), part()], [true, 'macro']);
    // Leaving broadcast mode takes the strip along; the choice is kept for the next time.
    body.delete('broadcast-mode');
    u.updateCompare(43000);
    assert.deepEqual([strip(), u.compareOn()], [undefined, true]);
    body.add('broadcast-mode');
    u.updateCompare(44000);
    assert.equal(shown(), true);
    press('C');
    assert.deepEqual([u.compareOn(), strip(), board], [false, undefined, 2]);
    // With nothing fit to show, nothing is shown.
    const { u: v, els: e2, body: b2 } = page();
    b2.add('broadcast-mode');
    v.viewPreferences().compare = true;
    v.updateCompare(1000);
    assert.equal(e2.compareStrip, undefined);
    // The board carries its icon, lit while on, and the strip is cleared with the caption at the end of a match.
    const src = fs.readFileSync(path.join(root, 'js/ui.js'), 'utf8');
    assert.match(src, /icon\('broadcastCompare'[^\n]+toggleCompare\(\)/);
    assert.match(src, /on\('broadcastCompare', [^\n]+compareOn\(\)\);/);
    assert.match(src, /getElementById\('chronicleCaption'\)\?\.remove\(\);\r?\n\s+document\.getElementById\('compareStrip'\)\?\.remove\(\);/);
});
