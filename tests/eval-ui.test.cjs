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
    const context = vm.createContext(Object.assign({ console, Date, WarEval, t: (k, v) => k + (v ? JSON.stringify(v) : ''),
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

test('a seat card shows a compact horizontal 5-pillar strip, WAR badge, and agency footer', () => {
    const u = ui(), seats = (u.game = { openAIAIManager: { transcripts: { ledger: ledger() } } }, u.evalSeats());
    const html = u.seatProfileHtml(seats.a);
    assert.equal((html.match(/class="lb-dim is-/g) || []).length, 5);
    assert.match(html, /class="lb-dim is-strategy is-empty" title="eval\.strategyNone">.*eval\.short\.strategy<\/span>.*<b>–<\/b>/);
    // 39/40 ok (1 constraint error) -> Bayesian smoothed Grounding = 91.
    assert.match(html, /is-grounding" title="eval\.groundingTip\{&quot;ok&quot;:39,&quot;judged&quot;:40,&quot;pct&quot;:&quot;97\.5 %&quot;,&quot;contended&quot;:0\} eval\.mistakes\{&quot;code&quot;:&quot;cannotAfford&quot;,&quot;n&quot;:1,&quot;repeated&quot;:0\}">.*eval\.short\.grounding<\/span><span class="lb-dim-track"><i style="width:91%"><\/i><\/span><b>91<\/b>/);
    assert.match(html, /is-macro".*eval\.short\.macro<\/span>/);
    assert.match(html, /is-spatial".*eval\.short\.spatial<\/span>/);
    assert.match(html, /is-tactical" title="eval\.tacticalNone">.*eval\.short\.tactical<\/span>/);
    // WAR Score badge sits after the 5 pillar columns (no Early label once >= 15 rated commands).
    assert.match(html, /class="lb-dim lb-index" title="eval\.indexTip\{&quot;n&quot;:4,&quot;parts&quot;:5\}">.*eval\.indexShort<\/span><b>/);
    assert.doesNotMatch(html, /bench\.early/);
    assert.match(html, /class="lb-foot"><span class="bb-batch is-compact"/);
    assert.ok(html.indexOf('lb-index') > html.indexOf('eval.short.strategy<'));
});

test('the strategy bar reads the timeline as it stands, and blends placement at the end', () => {
    const l = ledger(), u = ui();
    const tick = (t, a, b) => ({ t, p: { a: { pw: a }, b: { pw: b }, c: { pw: 0 } } });
    u.game = { openAIAIManager: { transcripts: { ledger: l } }, _timeline: { samples: [tick(5, 600, 400), tick(10, 600, 400)], ages: [] } };
    let html = u.seatProfileHtml(u.evalSeats().a);
    assert.match(html, /eval\.short\.strategy<\/span><span class="lb-dim-track"><i style="width:74%"><\/i><\/span><b>74<\/b>/);
    assert.match(html, /title="eval\.strategyTip\{&quot;dom&quot;:74,&quot;share&quot;:&quot;60\.0 %&quot;,&quot;even&quot;:&quot;33\.3 %&quot;,&quot;lead&quot;:&quot;100 %&quot;,&quot;destroyed&quot;:0,&quot;lost&quot;:0\} eval\.strategyLive"/);
    // At the end the file's own lines take over, blending 75% trajDom + 25% placement (rank 2 of 3 = 50 -> 68).
    l.addLine(JSON.stringify({ type: 'results', ranking: [{ playerId: 'b', rank: 1, isWinner: true }, { playerId: 'a', rank: 2 }, { playerId: 'c', rank: 3 }] }));
    l.addLine(JSON.stringify({ type: 'timeline', samples: u.game._timeline.samples, ages: [] }));
    html = u.seatProfileHtml(u.evalSeats().a);
    assert.match(html, /title="eval\.strategyPlaced\{&quot;rank&quot;:2,&quot;of&quot;:3\} eval\.strategyTip\{[^}]*\}"/);
    assert.match(html, /eval\.short\.strategy<\/span><span class="lb-dim-track"><i style="width:68%"><\/i><\/span><b>68<\/b>/);
});

test('zero rated actions and warmup badges show clearly; no decisions shows nothing', () => {
    const u = ui(), seats = (u.game = { openAIAIManager: { transcripts: { ledger: ledger() } } }, u.evalSeats());
    const html = u.seatProfileHtml(seats.b);                 // 1 contended command -> rated=0, warmup=true
    assert.match(html, /is-grounding" title="eval\.groundingNone">.*eval\.short\.grounding<\/span><span class="lb-dim-track"><i style="width:0%"><\/i><\/span><b>0<\/b>/);
    assert.match(html, /lb-dim lb-index is-warmup"[^>]*>.*<small>bench\.early<\/small>/);
    const w = WarEval.createLedger();
    for (let i = 0; i < 3; i++) w.addLine(JSON.stringify({ turn: 1, playerId: 'w', parsed: { commands: [{ action: 'wait' }] }, outcomes: [{ n: 1, action: 'wait', code: 'waited', verdict: 'ok' }] }));
    w.addLine(JSON.stringify({ turn: 1, playerId: 'w', parsed: { commands: [{ action: 'x' }, { action: 'wait' }] },
        outcomes: [{ n: 1, action: 'x', code: 'k', verdict: 'ok' }, { n: 2, action: 'wait', code: 'waited', verdict: 'ok' }] }));
    const waited = u.seatProfileHtml(w.profile().seats[0]);
    assert.match(waited, /eval\.groundingTip\{&quot;ok&quot;:1,&quot;judged&quot;:1,&quot;pct&quot;:&quot;100 %&quot;,&quot;contended&quot;:0\} eval\.waits\{&quot;n&quot;:4\}/);
    const only = WarEval.createLedger();
    only.addLine(JSON.stringify({ turn: 1, playerId: 'w', parsed: { commands: [{ action: 'wait' }] }, outcomes: [{ n: 1, action: 'wait', code: 'waited', verdict: 'ok' }] }));
    assert.match(u.seatProfileHtml(only.profile().seats[0]), /is-grounding" title="eval\.groundingWaits\{&quot;n&quot;:1\}">.*eval\.short\.grounding<\/span>.*<b>0<\/b>/);
    assert.equal(u.seatProfileHtml(seats.c), '');
    assert.equal(u.seatProfileHtml(null), '');
});

// ---- the race chart (step D5) ------------------------------------------------------------
// A page with just enough elements for the chart to draw into, counting every redraw.
function racePage() {
    const els = {}, writes = { n: 0 }, store = {}, cls = new Set();
    const el = id => els[id] || (els[id] = { id, style: {}, classList: { toggle() {}, contains: () => false }, setAttribute() {}, textContent: '',
        _html: '', get innerHTML() { return this._html; }, set innerHTML(v) { this._html = v; if (id === 'raceChartMain') writes.n++; } });
    ['raceChart', 'raceBtn', 'raceChartBox', 'raceChartMain', 'raceTitle', 'raceModePower', 'raceModeGathered', 'raceWait'].forEach(el);
    const u = ui({ document: { getElementById: id => els[id] || null,
            body: { classList: { toggle: (c, on) => { if (on) cls.add(c); else cls.delete(c); }, contains: c => cls.has(c) } } }, getUiLang: () => 'en', tg: s => s,
        getCivilization: () => ({ name: 'Civ', color: 0x336699 }),
        localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; } } });
    u.teamDotHtml = () => '';
    const samples = n => Array.from({ length: n }, (_, i) => ({ t: i * 5, p: { a: { pw: 100 + i, al: 1 }, b: { pw: 100 + 2 * i, al: 1 } } }));
    u.game = { _timeline: { samples: samples(4), ages: [{ id: 'a', age: 'bronze', t: 10 }], wonders: [] },
        aiManager: { aiPlayers: [{ id: 'a', seat: 0, civilization: 'greek' }, { id: 'b', seat: 1, civilization: 'persian' }] },
        openAIAIManager: { transcripts: { ledger: WarEval.createLedger() } } };
    return { u, els, writes, store, samples, cls };
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

// ---- tags on the decision feed (step D6) -------------------------------------------------
// The harness's own class, so a tag is judged by the rule that judges the transcript.
function harness() {
    const scope = { console, getCivilization: () => ({ name: 'Civ', color: 0 }) };
    vm.createContext(scope);
    vm.runInContext(fs.readFileSync(path.join(root, 'js/openai-ai.js'), 'utf8'), scope);
    return vm.runInContext('OpenAIAIManager', scope);
}
const Manager = harness();
const entry = (playerId, move, result, code, extra) => Object.assign({ playerId, move, action: 'train_unit', params: {}, result,
    outcomeCode: code ? 'log.out.' + code : undefined, failed: /^\[ERROR\]/.test(result || '') }, extra);
const kinds = tags => Array.from(tags, x => x.kind + ':' + x.label);

test('a card is tagged with what became of its command, by the harness\'s own verdict', () => {
    const u = ui({ OpenAIAIManager: Manager });
    const log = [
        entry('a', 3, 'OK - trained', 'trainUnit'),
        entry('a', 3, '[ERROR] Cannot afford worker', 'cannotAfford'),
        entry('a', 3, '[ERROR] Barracks is busy', 'trainerBusy'),
        entry('a', 3, '[ERROR] Unknown action "conjure".', null),
        { playerId: 'a', move: 4, action: 'plan_only', params: {} },
        { playerId: 'a', move: 4, action: 'request_failed', params: {}, failed: true, error: 'timeout' },
        { playerId: 'a', isAdvice: true, reason: 'build towers', result: '[ERROR] not a command' },
        entry('a', 5, '[ERROR] healed', 'healDropped', { isControl: true }),
    ];
    const index = u.logMistakeIndex(log);
    assert.deepEqual(log.map(e => kinds(u.logTags(e, index))), [
        [],                                             // it worked: nothing to say
        ['mistake:cannotAfford'],                       // the state had shown the price
        ['timing:log.tagTiming'],                       // nobody could have known: not the model's doing
        ['invalid:log.tagInvalid'],
        ['plan:log.tagPlan'],
        [],                                             // a lost turn is not a judged command
        [], [],                                         // nor advice, nor the harness's own notes
    ]);
    // The verdict is the harness's, to the letter.
    for (const e of log.slice(0, 4)) assert.equal(u.logVerdict(e).verdict, Manager.verdictFor(e.result, String(e.outcomeCode || '').replace(/^log\.out\./, '')));
    // Without the harness class on the page there is nothing to judge with, and no tag.
    assert.equal(ui().logVerdict(log[1]), null);
});

test('the same mistake within two decisions is marked as made again, as the ledger counts it', () => {
    const u = ui({ OpenAIAIManager: Manager });
    const miss = (move, code, player = 'a') => entry(player, move, '[ERROR] no', code);
    // Newest first, as the log is kept.
    const log = [miss(7, 'cannotAfford'), miss(6, 'populationLimit'), miss(5, 'cannotAfford'), miss(2, 'cannotAfford'),
        miss(5, 'cannotAfford', 'b'), miss(1, 'cannotAfford'), miss(1, 'cannotAfford')];
    const index = u.logMistakeIndex(log);
    assert.deepEqual(log.map(e => kinds(u.logTags(e, index)).join(' ')), [
        'mistake:cannotAfford again:log.tagAgain',      // decision 7 after 5
        'mistake:populationLimit',                      // another mistake
        'mistake:cannotAfford',                         // 5 after 2: three decisions on
        'mistake:cannotAfford again:log.tagAgain',      // 2 after 1
        'mistake:cannotAfford',                         // seat b made it for the first time
        'mistake:cannotAfford', 'mistake:cannotAfford', // twice in one decision is not a repeat
    ]);
    // The ledger, given the same decisions, counts the same repeats.
    const l = WarEval.createLedger(), by = {};
    for (const e of log.filter(e => e.playerId === 'a')) (by[e.move] = by[e.move] || []).push(e);
    for (let move = 1; move <= 7; move++) l.addLine(line('a', (by[move] || []).map(e => ['avoidable', e.outcomeCode.replace('log.out.', '')])));
    const again = log.filter(e => e.playerId === 'a' && u.logTags(e, index).some(x => x.kind === 'again')).length;
    assert.equal(l.profile().seats.find(s => s.id === 'a').grounding.repeated, again);
});

test('tag chips filter the feed like the seat chips, and a search finds a tag', () => {
    const els = {}, el = id => els[id] || (els[id] = { id, _html: '', get innerHTML() { return this._html; }, set innerHTML(v) { this._html = v; },
        classList: { contains: () => false, toggle() {} }, children: [], scrollTop: 0, textContent: '', querySelector: () => null });
    ['aiLogEntries', 'aiLogCount', 'aiLogTags'].forEach(el);
    const u = ui({ OpenAIAIManager: Manager, document: { getElementById: id => els[id] || null }, getUiLang: () => 'en', tg: s => s, hasI18n: () => false });
    u.game = { openAIAIManager: { decisionLogRevision: 1, decisionLog: [
        entry('a', 2, '[ERROR] Cannot afford worker', 'cannotAfford', { civName: 'Greeks', color: '#fff', timestamp: 3 }),
        entry('b', 2, '[ERROR] Barracks is busy', 'trainerBusy', { civName: 'Persians', color: '#fff', timestamp: 2 }),
        entry('a', 1, 'OK - trained', 'trainUnit', { civName: 'Greeks', color: '#fff', timestamp: 1 }),
    ] }, aiManager: { aiPlayers: [] } };
    Object.assign(u, { renderLogPlayerChips() {}, logActionNames: () => ({ train_unit: 'Train' }), logDetail: () => '', teamDotHtml: () => '',
        legibleColor: c => c, logEntryLinkable: () => false, updateDecisionLogTopBtn() {} });
    const cards = () => (els.aiLogEntries.innerHTML.match(/class="ai-log-entry/g) || []).length;
    u.updateDecisionLog();
    assert.equal(cards(), 3);
    assert.match(els.aiLogTags.innerHTML, /log\.chipMistakes.*log\.chipTiming.*log\.chipPlan/s);
    assert.match(els.aiLogEntries.innerHTML, /<div class="log-tags"><span class="log-tag is-mistake" title="log\.tagMistakeTip">cannotAfford<\/span><\/div>/);
    u.setLogTagFilter('mistake');
    assert.deepEqual([cards(), els.aiLogCount.textContent], [1, '(1/3)']);
    assert.match(els.aiLogTags.innerHTML, /is-mistake is-on/);
    u.setLogTagFilter('timing');                         // two chips on: either tag
    assert.equal(cards(), 2);
    u.setLogTagFilter('mistake'); u.setLogTagFilter('timing');
    assert.equal(cards(), 3);                            // none on: no filter
    u.setLogTagFilter('plan');
    assert.equal(cards(), 0);
    u.setLogTagFilter('plan');
    u.setLogTextFilter('cannotafford');                  // the code is on the card, so it is found
    assert.equal(cards(), 1);
});

test('the saved results carry the profile as a table, and name the heuristic as what it is', () => {
    const u = ui();
    u.game = {};
    u.summaryReasonText = r => r;
    const l = ledger();
    l.addLine(JSON.stringify({ type: 'timeline', samples: [{ t: 5, p: { a: { pw: 600 }, b: { pw: 400 }, c: { pw: 0 } } }], ages: [] }));
    l.addLine(JSON.stringify({ type: 'results', ranking: [{ playerId: 'a', rank: 1, isWinner: true }, { playerId: 'b', rank: 2 }, { playerId: 'c', rank: 3 }] }));
    const profile = WarEval.publicProfile(l.profile());
    const md = u.buildResultsMarkdown({ reports: [], reason: 'timeout', durStr: '10:00', playerCount: 3, profile });
    assert.match(md, /## Evaluation profile\n\nScale v4\.1\. One match is one sample/);
    assert.match(md, /\| Seat \| Grounding \(20%\) \| Macro & Agency \(25%\) \| Spatial \(15%\) \| Tactical \(15%\) \| Dominance \(25%\) \| WAR Score \|/);
    assert.match(md, /\| Seat a \| 91 \(97\.5 % of 40\) \| 0 \(– bw, 0 passive waits\) \| 0 \(– map, 0\/0 opp\) \| 0 \(no combat\) \| 80 \(74 dom, placed 1\) \| 38\.3 \|/);
    assert.ok(md.indexOf('## Evaluation profile') < md.indexOf('## Ranking'));
    // Without a profile (no model seat, or nothing recorded) the file is what it always was.
    assert.doesNotMatch(u.buildResultsMarkdown({ reports: [], reason: 'timeout', durStr: '10:00', playerCount: 2 }), /Evaluation profile/);
    const src = fs.readFileSync(path.join(root, 'js/ui.js'), 'utf8');
    assert.match(src, /Legacy match heuristic \(not a capability score, not part of the profile\)/);
    // On the results screen the heuristic sits in a folded block, not on the seat cards.
    const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    assert.match(html, /<details class="summary-legacy" id="summaryLegacy" hidden>\s*<summary data-i18n="sum\.legacy">[^<]+<\/summary>\s*<div id="summaryLegacyRows"><\/div>\s*<p class="summary-legend" id="summaryLegend"><\/p>\s*<\/details>/);
    assert.ok(html.indexOf('id="summaryProfile"') > html.indexOf('id="summaryWinner"') && html.indexOf('id="summaryProfile"') < html.indexOf('id="summaryGrid"'));
    const card = src.slice(src.indexOf('<div class="sum-card$' + '{r.isWinner'), src.indexOf("document.getElementById('summaryGrid').innerHTML"));
    assert.doesNotMatch(card, /sum-sound/);
});

test('the race chart is an overlay of either mode: its switch works in broadcast mode and lights the icon on the board', () => {
    const { u, els, cls } = racePage();
    let drawn = 0;
    u.renderBroadcast = () => { drawn++; };
    u.toggleRaceChart();                                                // in analyze mode
    assert.deepEqual([cls.has('race-view'), els.raceChart.style.display, drawn], [true, '', 0]);
    cls.add('broadcast-mode');                                          // and it stays through the switch of mode
    u.refreshRaceChart();
    assert.deepEqual([u.raceOn(), els.raceChart.style.display], [true, '']);
    u.toggleRaceChart(false);
    assert.deepEqual([cls.has('race-view'), els.raceChart.style.display, drawn], [false, 'none', 1]);
    u.toggleRaceChart(true);
    assert.deepEqual([u.raceOn(), els.raceChart.style.display, drawn], [true, '', 2]);
    // Nothing in the stylesheet takes an overlay away in a mode, or a mode's own panels away for an overlay.
    const css = fs.readFileSync(path.join(root, 'css/styles.css'), 'utf8');
    assert.doesNotMatch(css, /body\.broadcast-mode\s+(#raceChart|\.bench-panel)\s*\{\s*display:\s*none/);
    // Nor does a small window: the chart gets narrower there and stays on screen.
    assert.doesNotMatch(css, /\.race-chart\s*\{[^}]*display:\s*none/);
    assert.match(css, /@media \(max-width: 1100px\) \{ \.race-chart \{ width: min\(300px, calc\(100vw \/ var\(--ui-scale, 1\) - /);   // the window in the card's own, scaled units (b1306)
    assert.doesNotMatch(css, /body\.bench-view[^{]*#(aiDecisionLog|spectatorLeaderboard)[^{]*\{\s*display:\s*none/);
    assert.doesNotMatch(css, /\.bench-left\b/);
    assert.match(css, /\.bench-right \{ right: 328px;/);                 // beside the leaderboard
    assert.match(css, /body\.broadcast-mode \.bench-right \{ right: 16px;/);
    // The broadcast board carries an icon for each beside its others, lit while on.
    const src = fs.readFileSync(path.join(root, 'js/ui.js'), 'utf8');
    assert.match(src, /icon\('broadcastBench'[^\n]+toggleBenchView\(\)/);
    assert.match(src, /icon\('broadcastRace'[^\n]+toggleRaceChart\(\)/);
    assert.match(src, /on\('broadcastBench', [^\n]+benchOn\(\)\);\s+on\('broadcastRace', this\.raceOn\(\)\);/);
});
