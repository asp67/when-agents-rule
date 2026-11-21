'use strict';
// The evaluation profile in the spectator screen (overhaul steps D1, D5, D6): what the
// page draws from the ledger. The numbers themselves are tests/eval-ledger.test.cjs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const WarEval = require(path.join(root, 'js/eval/ledger.js'));

function ui(extra) {
    const context = vm.createContext(Object.assign({ console, Date, t: (k, v) => k + (v ? JSON.stringify(v) : ''),
        OpenAIAIManager: { MAX_COMMANDS_PER_TURN: 3 }, document: { getElementById: () => null } }, extra));
    vm.runInContext(fs.readFileSync(path.join(root, 'js/ui.js'), 'utf8') + '\nthis.UI = UIManager;', context);
    const u = Object.create(context.UI.prototype);
    u.escapeHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
    return u;
}
const line = (playerId, outcomes, parsed) => JSON.stringify({ turn: 1, playerId, name: 'Seat ' + playerId,
    state: { clock: { matchSeconds: 75 }, buildings: { buildable: [{ type: 'tower' }] } },
    parsed: Object.assign({ commands: outcomes.map(() => ({ action: 'x' })) }, parsed),
    outcomes: outcomes.map(([verdict, code], i) => ({ n: i + 1, action: 'x', code, verdict })) });
function ledger() {
    const l = WarEval.createLedger();
    l.addLine(JSON.stringify({ type: 'match', players: [{ id: 'a', seat: 0 }, { id: 'b', seat: 1 }, { id: 'c', seat: 2 }] }));
    l.addLine(line('a', [['ok', 'k'], ['ok', 'k'], ['avoidable', 'cannotAfford']], { objective: 'Hold', plan: ['Build a tower', 'Stay flexible'] }));
    for (let i = 0; i < 37; i++) l.addLine(line('a', [['ok', 'k']]));
    l.addLine(line('b', [['contended', 'trainerBusy']]));
    return l;
}

test('the card reads the ledger of the match being recorded, by seat', () => {
    const u = ui();
    u.game = { openAIAIManager: null };
    assert.equal(u.evalSeats(), null);
    u.game = { openAIAIManager: { transcripts: { ledger: null } } };
    assert.equal(u.evalSeats(), null);                       // the ledger script is not loaded
    u.game = { openAIAIManager: { transcripts: { ledger: ledger() } } };
    const seats = u.evalSeats();
    assert.deepEqual(Object.keys(seats).sort(), ['a', 'b', 'c']);
    assert.equal(seats.a.grounding.ok, 39);
});

test('a seat card shows one bar per part of the profile, with what it rests on', () => {
    const u = ui(), seats = (u.game = { openAIAIManager: { transcripts: { ledger: ledger() } } }, u.evalSeats());
    const html = u.seatProfileHtml(seats.a);
    assert.equal((html.match(/class="lb-dim"/g) || []).length, 2);
    // 39 of 40 valid is 97.5 %: a quarter of the way to zero on the v0 scale, so 75.
    assert.match(html, /eval\.grounding<\/span><span class="lb-dim-track"><i style="width:75%"><\/i><\/span><b>75<\/b>/);
    assert.match(html, /eval\.groundingTip\{&quot;ok&quot;:39,&quot;judged&quot;:40,&quot;pct&quot;:&quot;97\.5 %&quot;,&quot;contended&quot;:0\}/);
    assert.match(html, /eval\.mistakes\{&quot;code&quot;:&quot;cannotAfford&quot;,&quot;n&quot;:1,&quot;repeated&quot;:0\}/);
    // One plan from the first decision, one of its two steps checkable, no shock: (1 + 0.5 + 1) / 3.
    assert.match(html, /eval\.planning<\/span><span class="lb-dim-track"><i style="width:83%"><\/i><\/span><b>83<\/b>/);
    assert.match(html, /eval\.planningTip\{&quot;statements&quot;:1,&quot;revisions&quot;:1,&quot;first&quot;:&quot;1:15&quot;/);
    assert.equal((html.match(/eval\.provisional/g) || []).length, 2);
});

test('nothing judged is a dash and no plan is a zero, and neither is hidden', () => {
    const u = ui(), seats = (u.game = { openAIAIManager: { transcripts: { ledger: ledger() } } }, u.evalSeats());
    const html = u.seatProfileHtml(seats.b);                 // one contended command, no plan
    assert.match(html, /lb-dim is-empty" title="eval\.groundingNone eval\.provisional"/);
    assert.match(html, /eval\.grounding<\/span><span class="lb-dim-track"><i style="width:0%"><\/i><\/span><b>–<\/b>/);
    assert.match(html, /title="eval\.planningNone\{&quot;n&quot;:1\} eval\.provisional"/);
    assert.match(html, /eval\.planning<\/span><span class="lb-dim-track"><i style="width:0%"><\/i><\/span><b>0<\/b>/);
    // A seat that has not decided anything yet gets no bars at all.
    assert.equal(u.seatProfileHtml(seats.c), '');
    assert.equal(u.seatProfileHtml(null), '');
});

// ---- the race chart (step D5) ------------------------------------------------------------
// A page with just enough elements for the chart to draw into, counting every redraw.
function racePage() {
    const els = {}, writes = { n: 0 }, store = {};
    const el = id => els[id] || (els[id] = { id, style: {}, classList: { toggle() {}, contains: () => false }, setAttribute() {}, textContent: '',
        _html: '', get innerHTML() { return this._html; }, set innerHTML(v) { this._html = v; if (id === 'raceChartMain') writes.n++; } });
    ['raceChart', 'raceBtn', 'raceChartBox', 'raceChartMain', 'raceTitle', 'raceModePower', 'raceModeGathered', 'raceWait'].forEach(el);
    const u = ui({ document: { getElementById: id => els[id] || null }, getUiLang: () => 'en', tg: s => s,
        getCivilization: () => ({ name: 'Civ', color: 0x336699 }),
        localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; } } });
    u.teamDotHtml = () => '';
    const samples = n => Array.from({ length: n }, (_, i) => ({ t: i * 5, p: { a: { pw: 100 + i, al: 1 }, b: { pw: 100 + 2 * i, al: 1 } } }));
    u.game = { _timeline: { samples: samples(4), ages: [{ id: 'a', age: 'bronze', t: 10 }], wonders: [] },
        aiManager: { aiPlayers: [{ id: 'a', seat: 0, civilization: 'greek' }, { id: 'b', seat: 1, civilization: 'persian' }] },
        openAIAIManager: { transcripts: { ledger: WarEval.createLedger() } } };
    return { u, els, writes, store, samples };
}
const planLine = (playerId, sec, steps) => JSON.stringify({ turn: 1, playerId, state: { clock: { matchSeconds: sec } }, parsed: { commands: [], plan: steps } });

test('the race chart is off until asked for, and remembers being switched on', () => {
    const { u, els, writes, store } = racePage();
    assert.equal(u.raceOn(), false);
    u.refreshRaceChart();
    assert.deepEqual([els.raceChart.style.display, writes.n], ['none', 0]);
    u.toggleRaceChart();
    assert.equal(u.raceOn(), true);
    assert.equal(JSON.parse(store.warViewPreferencesV1).race, true);
    assert.deepEqual([els.raceChart.style.display, writes.n, els.raceWait.style.display], ['', 1, 'none']);
    u.toggleRaceChart(false);
    assert.equal(els.raceChart.style.display, 'none');
});

test('it draws a line per seat with a tick for every changed plan, and only when something arrived', () => {
    const { u, els, writes, samples } = racePage(), ledger = u.game.openAIAIManager.transcripts.ledger;
    ledger.addLine(planLine('a', 5, ['Build a tower']));
    ledger.addLine(planLine('a', 12, ['Build a tower']));          // said again: not a change, no tick
    u.toggleRaceChart(true);
    const svg = () => els.raceChartMain.innerHTML, count = cls => (svg().match(new RegExp('class="' + cls + '"', 'g')) || []).length;
    assert.deepEqual([count('c-line'), count('c-mark'), count('c-age'), writes.n], [2, 1, 1, 1]);
    assert.deepEqual(JSON.parse(JSON.stringify(u.racePlanMarks())), [{ id: 'a', t: 5 }]);   // by value: the page's realm made it
    // Asked again a second later with nothing new: not redrawn.
    u.updateRaceChart(); u.updateRaceChart();
    assert.equal(writes.n, 1);
    // A changed plan redraws it, and so does a new sample.
    ledger.addLine(planLine('b', 14, ['Train militia']));
    u.updateRaceChart();
    assert.deepEqual([writes.n, count('c-mark')], [2, 2]);
    u.game._timeline.samples = samples(5);
    u.updateRaceChart();
    assert.equal(writes.n, 3);
    // The other curve, on request.
    u.setRaceMode('gathered');
    assert.equal(writes.n, 4);
    // A long match is thinned to about 300 points a line, as on the results screen.
    u.game._timeline.samples = samples(2000);
    u.updateRaceChart();
    const points = svg().match(/<polyline class="c-line" points="([^"]*)"/)[1].split(' ').length;
    assert.ok(points <= 302 && points >= 280, points + ' points');
    // A mark past the last sample, or for a seat that is not on the chart, is left out.
    u.game._timeline.samples = samples(3);
    ledger.addLine(planLine('zz', 3, ['Scout']));
    u.updateRaceChart();
    assert.equal(count('c-mark'), 1);                               // a at 5 s; b's 14 s is past 10 s
});

test('with fewer than two samples it says so instead of drawing a dot', () => {
    const { u, els, writes, samples } = racePage();
    u.game._timeline.samples = samples(1);
    u.toggleRaceChart(true);
    assert.deepEqual([writes.n, els.raceChartBox.style.display, els.raceWait.style.display], [0, 'none', '']);
});
