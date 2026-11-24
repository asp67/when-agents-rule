'use strict';
// The comparison board (builds 1222 to 1227).
//
// asp67, 22 November 2026: "Change the lines to graphs over time. Separate it in 3 distinct
// sections per model: gameplay score, model performance and cost, score summary. Have a mini
// card on screen that is still readable and toggle a full size view when clicked." And, after
// the first build got it wrong: "I wanted graphs over time, models side by side, top section
// Gameplay, middle model performance, bottom summary." With it: "there is a visible stutter,
// 0.5 second game freeze when the bench card is reevaluated", and "scrolling is impossible
// since every refresh moves the focus to the top of the card."
//
// Held here: a column is a model; gameplay is the five scores over the match and nothing
// else; performance is drawn on one scale for all models; the summary is one table; the old
// matrix, the power graph and the share chart are not on the board; a refresh keeps the
// reader's place and never scores the match more than it must.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const WarEval = require(path.join(root, 'js/eval/ledger.js'));
const WarBench = require(path.join(root, 'js/bench-core.js'));
const WarShare = require(path.join(root, 'js/eval/share.js'));
const plain = v => JSON.parse(JSON.stringify(v));

function page() {
    const els = {}, store = {}, body = new Set(), keys = [], timers = [];
    const el = id => els[id] || (els[id] = { id, style: {}, innerHTML: '', classList: { toggle() {} }, setAttribute() {} });
    ['benchMatrix', 'benchFull', 'benchBtn'].forEach(el);
    const context = vm.createContext({ console, Date, WarEval, WarShare, t: (k, v) => k + (v ? JSON.stringify(v) : ''), getUiLang: () => 'en',
        OpenAIAIManager: { MAX_COMMANDS_PER_TURN: 3 }, setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
        localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; } },
        document: { getElementById: id => els[id] || null, addEventListener: (type, fn) => keys.push(fn),
            body: { style: { setProperty() {}, removeProperty() {} },
                classList: { toggle: (c, on) => { if (on) body.add(c); else body.delete(c); }, contains: c => body.has(c) } } } });
    for (const f of ['js/ui.js', 'js/eval/bench-view.js']) vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8') + '\nthis.UI = UIManager;', context);
    const u = Object.create(context.UI.prototype);
    u.escapeHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
    Object.assign(u, { teamDotHtml: () => '', renderTranscriptViewer() {}, updateSpectatorPlayerList() {} });
    u._benchBudget = Infinity;                          // every sample at once: a test does not wait for a graph
    const ledger = WarEval.createLedger();
    u.game = { spectatorMode: true, gameStarted: true, openAIAIManager: { transcripts: { ledger } } };
    return { u, els, store, body, keys, timers, ledger };
}
const decision = (id, sec, o = {}) => JSON.stringify({ turn: o.turn || 1, playerId: id, name: 'Seat ' + id, seat: id === 'a' ? 0 : 1, latencyMs: o.latencyMs || 4000,
    tokens: o.tokens === undefined ? { prompt: 9000, completion: 300 } : o.tokens,
    parsed: Object.assign({ commands: (o.orders || []).map(x => ({ action: x[0], params: x[1] || {} })) }, o.plan ? { objective: 'Hold the town', plan: o.plan } : null),
    outcomes: (o.orders || []).map((x, i) => ({ n: i + 1, action: x[0], code: x.length > 3 ? x[3] : 'c', verdict: x[2] || 'ok' })),
    state: { clock: { matchSeconds: sec }, population: { used: 20 }, threats: { underAttack: [], enemyWonders: [] },
        units: { trainable: { barracks: { stone: [{ id: 'militia' }] } } }, buildings: { buildable: [{ type: 'tower' }, { type: 'barracks' }] },
        friendlyBuildings: [{ type: 'barracks', x: 100, z: 100 }], gameStats: { opponents: [{ id: 'maya-2', civilization: 'maya' }] } } });
const militia = ['train_unit', { unitType: 'militia' }];
const refused = (code, action = 'train_unit') => [action, {}, 'avoidable', code];

// Seat a: ten decisions a minute apart, four seconds and 9300 tokens each; two orders refused
// for a shown reason (the second a repeat), one that cannot be called. Seat b: five decisions
// two minutes apart, each thirty seconds and 42000 tokens. Ten minutes of power readings.
function match() {
    const p = page(), { u, ledger } = p;
    for (let n = 1; n <= 10; n++) ledger.addLine(decision('a', n * 60, { turn: n, plan: n === 1 ? ['Build a tower', 'Train militia'] : undefined,
        orders: n === 5 || n === 6 ? [['train_unit', { unitType: 'militia' }, 'avoidable']] : n === 8 ? [['conjure', {}, 'invalid', 'unknown_action']] : [militia] }));
    for (let n = 1; n <= 5; n++) ledger.addLine(decision('b', n * 120, { turn: n, orders: [militia], latencyMs: 30000, tokens: { prompt: 40000, completion: 2000 } }));
    const samples = [];
    for (let t = 5; t <= 600; t += 5) samples.push({ t, p: { a: { pw: 100 + t }, b: { pw: 100 + t / 2 } } });
    u.game._timeline = { samples, ages: [] };
    u.evalLedger();                                     // the page shows the ledger the running timeline
    return p;
}
const counted = ledger => { const at = ledger.profileAt.bind(ledger), box = { n: 0 }; ledger.profileAt = sec => { box.n++; return at(sec); }; return box; };

// ---- the live history: cheap enough to ask at every refresh ------------------------------
test('the scores of a running match: a sample is scored again only when what it rests on has changed', () => {
    const { ledger } = match(), asked = counted(ledger);
    const first = ledger.liveHistory(30, Infinity);
    // Every half minute up to 9:30, then the profile as it stands at 10:00, which costs no scoring.
    assert.deepEqual([first.samples.length, first.samples[18].t, first.samples[19].t, asked.n, ledger._live.pending], [20, 570, 600, 19, 0]);
    asked.n = 0;
    const again = ledger.liveHistory(30, Infinity);
    assert.equal(asked.n, 0, 'nothing has arrived: nothing is scored');
    assert.deepEqual(plain(again.samples), plain(first.samples));
    // The kept samples are the ones a full scoring gives.
    assert.deepEqual(plain(ledger.history(30).samples.slice(0, 19)), plain(first.samples.slice(0, 19)));
    // A slow seat's decision arrives late: its state was built at 4:10. Every sample from 4:30 on rests on it; the earlier ones do not.
    asked.n = 0;
    ledger.addLine(decision('b', 250, { turn: 6, orders: [militia] }));
    const late = ledger.liveHistory(30, Infinity);
    assert.equal(asked.n, 11, '4:30 to 9:30');
    assert.deepEqual(plain(late.samples.slice(0, 8)), plain(first.samples.slice(0, 8)));
    assert.deepEqual(plain(ledger.history(30).samples.slice(0, 19)), plain(late.samples.slice(0, 19)));
    // So does a battle, which is written when it is over.
    asked.n = 0;
    ledger.addLine(JSON.stringify({ type: 'chronicle', kind: 'battle', t: 400, sides: { a: { lost: 1 }, b: { lost: 3 } } }));
    ledger.liveHistory(30, Infinity);
    assert.equal(asked.n, 6, '7:00 to 9:30');
    assert.deepEqual(plain(ledger.history(30).samples.slice(0, 19)), plain(ledger.liveHistory(30, Infinity).samples.slice(0, 19)));
});

test('the scores of a running match never hold the game up: a budget, the newest first, the rest in the next refreshes', () => {
    const { ledger } = match(), asked = counted(ledger);
    // No time at all: one sample is scored all the same, the newest, and the rest wait.
    const one = ledger.liveHistory(30, 0);
    assert.deepEqual([asked.n, ledger._live.pending, one.samples.map(s => s.t)], [1, 18, [570, 600]]);
    let calls = 0;
    while (ledger._live.pending && calls++ < 50) ledger.liveHistory(30, 0);
    assert.deepEqual([calls, asked.n, ledger.liveHistory(30, 0).samples.length], [18, 19, 20]);
    // The page asks again by itself while samples wait, a little at a time, and stops when none do.
    const p = match();
    p.u._benchBudget = 0;
    p.u.toggleBenchView(true);
    assert.deepEqual([p.timers.length, p.timers[0].ms, p.ledger._live.pending], [1, 120, 18]);
    let rounds = 0;
    while (p.timers.length && rounds++ < 50) p.timers.shift().fn();
    assert.deepEqual([rounds, p.ledger._live.pending, p.timers.length], [18, 0, 0]);
    // Scoring the match is cheap enough to do so: Scale v4.1 drops heuristic step scanning completely.
    const src = fs.readFileSync(path.join(root, 'js/eval/ledger.js'), 'utf8');
    assert.match(src, /SCALE: 'v4\.1'/);
    assert.doesNotMatch(src, /checksOf|settle = 600/);
});

test('behind the live panels nothing is scored that is not shown', () => {
    const { u, ledger } = match();
    const asked = [], html = u.benchHtml.bind(u);
    u.benchHtml = (l, o) => { asked.push(o); return html(l, o); };
    u.toggleBenchView(true);
    assert.equal(asked.length, 0, 'the live mini card renders without invoking the results matrix');
    // The matrix's trend compares with the profile ten minutes ago: a scoring of its own, only where the matrix is shown.
    ledger.addLine(decision('a', 900, { turn: 11, orders: [militia] }));
    const calls = counted(ledger);
    html(ledger, { matrix: false });
    assert.equal(calls.n, 0);
    html(ledger);
    assert.equal(calls.n, 1);
});

// ---- the rates of the performance graphs ---------------------------------------------------
test('model performance over time: the rate of the latest decisions, not a running total', () => {
    const { u } = page();
    const sc = { t: [30, 60, 90, 120, 150], decisions: [1, 2, 3, 4, 8], commands: [1, 2, 3, 4, 8], ok: [1, 2, 3, 3, 6], avoidable: [0, 0, 0, 1, 1], invalid: [0, 0, 0, 0, 1],
        promptTokens: [1000, 2000, 3000, 4000, 8000], completionTokens: [0, 0, 0, 0, 0], thinkingMs: [4000, 8000, 12000, 22000, 30000] };
    const r = u.benchRates(sc);
    // Up to 1:30 there are fewer than three decisions behind a sample: the rate is over all of them.
    // At 2:00 it is over the last three (one took ten seconds: 18 s over three); at 2:30 over the four since 2:00.
    assert.deepEqual(plain(r.sec), [4, 4, 4, 6, 2]);
    assert.deepEqual(plain(r.tok), [1000, 1000, 1000, 1000, 1000]);
    assert.deepEqual(plain(r.refused.map(v => Math.round(v * 10) / 10)), [0, 0, 0, 33.3, 25]);
    assert.deepEqual(plain(r.t), sc.t);
    // A harness that reports no tokens has no token rate, and a file without outcomes no refusals: null, never a line at zero.
    const quiet = u.benchRates(Object.assign({}, sc, { promptTokens: [0, 0, 0, 0, 0], ok: [0, 0, 0, 0, 0], avoidable: [0, 0, 0, 0, 0], invalid: [0, 0, 0, 0, 0] }));
    assert.deepEqual([plain(quiet.tok), plain(quiet.refused), plain(quiet.sec)], [[null, null, null, null, null], [null, null, null, null, null], [4, 4, 4, 6, 2]]);
    // Before a seat's first decision there is nothing to divide by.
    assert.equal(u.benchRates(Object.assign({}, sc, { decisions: [0, 2, 3, 4, 8] })).sec[0], null);
    assert.deepEqual(plain(u.benchRates(null)), { t: [], sec: [], tok: [], refused: [] });
});

// ---- the board ------------------------------------------------------------------------------
// The grid's markup taken apart: its rows, a row's cells, and the summary's figures by label.
const gridOf = html => html.slice(html.indexOf('<div class="bb'));
const rowsOf = html => gridOf(html).split('<div class="bb-row ').slice(1).map(x => ({ cls: x.slice(0, x.indexOf('"')).trim(), html: x.slice(x.indexOf('>') + 1).split('<div class="bb-sec">')[0] }));
const colsOf = row => row.split(/<div class="bb-col" style="--civ:[^"]*">/).slice(1).map(x => x.replace(/<\/div>(?:<\/div>)*$/, ''));
const figures = html => Object.fromEntries(rowsOf(html).filter(r => /^bb-fig/.test(r.cls)).map(r => [r.html.match(/<div class="bb-lab">(?:<i[^>]*><\/i>)?([^<]*)<\/div>/)[1], colsOf(r.html).map(c => c.replace(/<[^>]+>/g, ''))]));

test('at full size the models stand side by side, and the sections run gameplay, model performance, summary', () => {
    const { u, els, ledger } = match();
    u.toggleBenchFull(true);
    const html = els.benchFull.innerHTML;
    assert.match(html, /^<div class="bf-box" onclick="event\.stopPropagation\(\)"><div class="bf-head"><b>bench\.matrix<\/b><span class="bf-pill">bench\.mode\.realtime<\/span><span class="bf-pill">v4\.1<\/span><button type="button" class="bf-close" onclick="game\.ui\.toggleBenchFull\(false\)"[^>]*>✕<\/button><\/div><div class="bf-body"><div class="bb" style="--n:2">/);
    // A column a model: every row holds one cell a model, behind one label.
    const rows = rowsOf(html);
    assert.ok(rows.length >= 25, rows.length + ' rows');
    for (const r of rows) assert.deepEqual([(r.html.match(/<div class="bb-lab">/g) || []).length, colsOf(r.html).length], [1, 2], r.cls);
    assert.deepEqual(colsOf(rows[0].html).map(c => c.replace(/<[^>]+>/g, '')), ['Seat a', 'Seat b']);
    // The three sections, in asp67's order.
    assert.deepEqual([...html.matchAll(/<div class="bb-sec">([^<]*)<\/div>/g)].map(m => m[1]), ['bench.b.gameFull', 'bench.b.modelFull', 'bench.b.summaryFull']);
    const [, game, model, summary] = html.split('<div class="bb-sec">');

    // Gameplay: ONE graph a model with the 5 Scale v4 pillars + dashed WAR Score line.
    const graphs = [...game.matchAll(/<svg class="bg-chart bb-game"[^>]*>(.*?)<\/svg>/g)].map(m => m[1]);
    assert.equal(graphs.length, 2);
    const inks = g => [...g.matchAll(/stroke="(#[0-9a-f]{6})"/g)].map(m => m[1]);
    const [a, b] = ledger.profile().seats;
    const partInks = WarEval.SCORED.filter(k => a[k].score != null).map(k => ({ grounding: '#4ecdc4', macro: '#60a5fa', spatial: '#a78bfa', tactical: '#f59e0b', strategy: '#ec4899' })[k]);
    assert.deepEqual(inks(graphs[0]), partInks.concat('#ddd3b4'));
    assert.deepEqual(inks(graphs[1]), WarEval.SCORED.filter(k => b[k].score != null).map(k => ({ grounding: '#4ecdc4', macro: '#60a5fa', spatial: '#a78bfa', tactical: '#f59e0b', strategy: '#ec4899' })[k]).concat('#ddd3b4'));
    assert.match(graphs[0], /stroke="#ddd3b4" stroke-width="2\.2" stroke-dasharray="4,2"/);
    assert.match(game, /<span class="bb-keys"><span><i style="background:#ddd3b4"><\/i>eval\.index<\/span>(<span><i style="background:#[0-9a-f]{6}"><\/i>eval\.(grounding|macro|spatial|tactical|strategy)<\/span>){5}<\/span>/);
    assert.doesNotMatch(html, /bench\.b\.power|bench\.b\.rank|bench\.b\.share/);
    // The clock under it: the whole match.
    assert.match(game, /<div class="bb-row bb-axis">.*?<span>0:00<\/span><span>10:00<\/span>/s);

    // Model performance: three rates over time, each on ONE 1-2-5-10 scale for both models, with the latest value in words.
    const rates = [...model.matchAll(/<div class="bb-row bb-graph"><div class="bb-lab"><b title="bench\.b\.rateTip">([^<]*)<\/b><small>([^<]*)<\/small><\/div>(.*?)(?=<div class="bb-row)/gs)];
    assert.deepEqual(rates.map(m => m[1] + ' | ' + m[2]), ['bench.b.secPer | 0 – 50 s', 'bench.b.tokPer | 0 – 50k', 'bench.b.refusedNow | 0 – 100 %']);
    const nows = rates.map(m => [...m[3].matchAll(/<b class="bb-now">([^<]*)<\/b>/g)].map(x => x[1]));
    assert.deepEqual(nows, [['4.0 s', '30 s'], ['9k', '42k'], ['33 %', '0 %']]);
    // Four seconds on a scale to fifty (38 high: 37 - 4/50 x 36 = 34.1); thirty seconds (37 - 30/50 x 36 = 15.4).
    const secs = [...rates[0][3].matchAll(/<svg class="bg-chart bb-rate"[^>]*><path d="([^"]*)"/g)].map(m => m[1]);
    assert.match(secs[0], / 34\.1$/);
    assert.match(secs[1], / 15\.4$/);

    // Summary: one table with Scale v4 pillars, action bandwidth, duration-invariant cost, drift, and discipline.
    const fig = figures(html);
    assert.deepEqual(Object.keys(fig), ['eval.index', 'eval.grounding', 'eval.macro', 'eval.spatial', 'eval.tactical', 'eval.strategy',
        'bench.b.batchDist', 'bench.b.parallel', 'bench.b.passiveWaits',
        'bench.b.latency', 'bench.b.tokPerDec', 'bench.b.outPerOk', 'bench.b.okPerMin', 'bench.b.scorePer10k',
        'bench.b.errDrift', 'bench.b.idleDrift', 'bench.b.latRatio',
        'bench.b.hallucinations', 'bench.b.constraints', 'bench.b.recovery', 'bench.t.loops', 'bench.b.lost', 'bench.h.help']);
    assert.match(fig['eval.index'][0], new RegExp('^' + a.index.value.toFixed(1)));
    assert.match(fig['eval.tactical'][0], /^50/);                      // no combat, activityGate = 1
    assert.deepEqual([fig['bench.b.tokPerDec'], fig['bench.b.outPerOk']], [['9k (9k·300)', '42k (40k·2k)'], ['429', '2000']]);
    assert.deepEqual([fig['bench.b.hallucinations'], fig['bench.b.constraints'], fig['bench.b.recovery'], fig['bench.t.loops'], fig['bench.b.lost']],
        [['10.0 %', '0 %'], ['20.0 %', '0 %'], ['66.7 %', '–'], ['0', '0'], ['0', '0']]);
    // The better of a row stands out: lower tok/dec, fewer constraint errors. Equal loops highlight nobody.
    assert.match(summary, /bench\.b\.tokPerDec<\/div><div class="bb-col"[^>]*><span class="is-lead"/);
    assert.match(summary, /bench\.b\.constraints<\/div><div class="bb-col"[^>]*><span title="[^"]*">20\.0 %<\/span><\/div><div class="bb-col"[^>]*><span class="is-lead"/);
    assert.doesNotMatch(summary.split('bench.t.loops')[1].split('bench.b.lost')[0], /is-lead/);

    // Warmup (< 5m && < 15 rated): pill appears and .is-lead highlights are suppressed.
    const warm = page();
    warm.ledger.addLine(decision('a', 60, { turn: 1, orders: [militia] }));
    warm.ledger.addLine(decision('b', 60, { turn: 1, orders: [refused('cannotAfford')] }));
    warm.u.toggleBenchFull(true);
    assert.match(warm.els.benchFull.innerHTML, /<span class="bf-pill is-warmup">bench\.warmup<\/span>/);
    assert.doesNotMatch(warm.els.benchFull.innerHTML, /class="is-lead"/);

    // What is NOT on the board: the old matrix, the long list of the inspector, the chart to share.
    assert.doesNotMatch(html, /class="bm"|bm-cell|bench-evidence|bt-list|bf-share|<svg xmlns|bf-seat|bf-matrix/);
    // Its button closes it.
    u.toggleBenchFull(false);
    assert.deepEqual([els.benchFull.innerHTML, els.benchFull.style.display, u._benchFull], ['', 'none', false]);
    assert.match(fs.readFileSync(path.join(root, 'index.html'), 'utf8'), /<div id="benchFull" class="bench-full" style="display:none;"><\/div>/);
});

test('the mini card: the same columns without the labels, a graph a section, and a click opens the full size', () => {
    const { u, els, ledger, keys } = match();
    u.toggleBenchView(true);
    const html = els.benchMatrix.innerHTML;
    assert.match(html, /^<div class="bench-head">bench\.matrix<span>bench\.mode\.realtimeShort · bench\.b\.open<\/span><\/div><div class="bb is-mini" style="--n:2" role="button" tabindex="0" title="bench\.b\.openTip" onclick="game\.ui\.toggleBenchFull\(true\)">/);
    assert.doesNotMatch(html, /bb-lab|bb-sec/, 'no label column or section bands in the compact mini card');
    const rows = rowsOf(html);
    assert.deepEqual(rows.map(r => r.cls + ' ' + colsOf(r.html).length), ['bb-head 2', 'bb-graph 2', 'bb-eqrow 2', 'bb-index 2', 'bb-footrow 2']);
    // Gameplay: 2-line sparkline (WAR solid + Dom dashed), 5 equalizer bars per seat, WAR badge, batching footer.
    assert.equal((html.match(/<svg class="bg-chart bb-game"/g) || []).length, 2);
    assert.match(html, /stroke="#ec4899"[^>]*stroke-dasharray="3,2"/);
    assert.equal((html.match(/class="bb-eq-bar"/g) || []).length, 10);
    assert.equal((html.match(/class="bb-mini-foot"/g) || []).length, 2);
    assert.equal((html.match(/class="bb-batch is-compact"/g) || []).length, 2);
    const [a, b] = ledger.profile().seats;
    assert.deepEqual(colsOf(rows[3].html), [`<b>${Math.round(a.index.value)}</b><small>eval.indexShort</small>`, `<b>${Math.round(b.index.value)}</b><small>eval.indexShort</small>`]);
    assert.doesNotMatch(html, /bm-cell|bt-strip|bf-kind/);
    // Nothing decided yet: it says so, and there is nothing to open.
    const empty = page();
    assert.match(empty.u.benchMiniHtml(empty.ledger), /bench\.none/);
    assert.doesNotMatch(empty.u.benchMiniHtml(empty.ledger), /toggleBenchFull/);
    // Opened, the card stays where it is behind the board; Escape closes the board.
    u.toggleBenchFull(true);
    assert.equal(els.benchFull.style.display, '');
    keys[keys.length - 1]({ key: 'Escape' });
    assert.deepEqual([els.benchFull.style.display, u._benchFull], ['none', false]);
    assert.match(els.benchMatrix.innerHTML, /bb is-mini/);
});

test('a refresh keeps the reader’s place: the board is drawn again where it was scrolled to', () => {
    const { u, els, ledger } = match();
    // A stand-in for the scroll area: a new element every time the markup is set, as in a browser.
    let area = null, markup = '';
    Object.defineProperty(els.benchFull, 'innerHTML', { get: () => markup, set: v => { markup = v; area = v ? { scrollTop: 0 } : null; } });
    els.benchFull.querySelector = sel => (sel === '.bf-body' ? area : null);
    u.toggleBenchFull(true);
    const first = area;
    first.scrollTop = 240;
    ledger.addLine(decision('a', 660, { turn: 11, orders: [militia] }));
    u.updateBenchView();
    assert.notEqual(area, first, 'drawn again');
    assert.equal(area.scrollTop, 240);
    // Nothing new: nothing is drawn again at all.
    const kept = area;
    u.updateBenchView();
    assert.equal(area, kept);
});

test('what a seat’s play cost, the score for that cost, and its discipline', () => {
    const { u, ledger } = match();
    u.benchKeepThinking(u.benchSeries(ledger));
    const a = ledger.profile().seats.find(s => s.id === 'a'), b = ledger.profile().seats.find(s => s.id === 'b'), ca = u.benchCost(a), cb = u.benchCost(b);
    // Ten decisions of 9000 + 300 tokens and four seconds each; five of 40000 + 2000 and thirty seconds.
    assert.deepEqual([ca.tokens, ca.promptTokens, ca.completionTokens, ca.thinkingMs], [93000, 90000, 3000, 40000]);
    assert.deepEqual([cb.tokens, cb.thinkingMs], [210000, 150000]);
    // Duration-invariant cost metrics: tokens/decision, output tokens per valid order, effective ok/think-min, score per 10k tok/dec.
    assert.deepEqual([ca.tokPerDec, ca.promptPerDec, ca.outPerDec], [9300, 9000, 300]);
    assert.ok(Math.abs(ca.outPerOk - 3000 / 7) < 1e-9);
    assert.ok(Math.abs(ca.okPerMin - 7 / (40 / 60)) < 1e-9);
    assert.ok(Math.abs(ca.scorePer10k - a.index.value / 0.93) < 1e-9);
    assert.deepEqual([cb.tokPerDec, cb.outPerOk, cb.okPerMin], [42000, 2000, 2]);
    assert.ok(cb.scorePer10k < ca.scorePer10k && cb.okPerMin < ca.okPerMin, 'the dear and slow seat scores less for its cognitive budget');
    // Discipline: of ten judged orders one was a hallucination (reference) and two were constraint refusals; of three mistakes one repeated.
    assert.deepEqual([ca.hallucinationRate, ca.constraintRate, ca.invalidRate, ca.refusedRate], [0.1, 0.2, 0.1, 0.2]);
    assert.ok(Math.abs(ca.recovery - 2 / 3) < 1e-9);
    assert.deepEqual([cb.invalidRate, cb.refusedRate, cb.recovery, cb.lost], [0, 0, null, 0], 'no mistake: nothing to recover from');
    // A seat whose harness reports no usage has null token-derived ratios, never zero.
    const none = Object.assign({}, a, { efficiency: Object.assign({}, a.efficiency, { tokens: null }) });
    const cNone = u.benchCost(none);
    assert.deepEqual([cNone.tokens, cNone.tokPerDec, cNone.outPerOk, cNone.scorePer10k], [null, null, null, null]);
});

// ---- the decision inspector (build 1223) ---------------------------------------------------
// asp67's list: "Let users see why a model lost - highlight the exact turn where it entered
// a loop, ignored a constraint, or lost spatial/context awareness."
// Seat a: an order it cannot pay for (decision 2), a target out of sight (3), the same
// refusal four decisions in a row (5 to 8), a call that is no action (9), a refusal with no
// reason on record (10); and an attack on its barracks shown at decision 11 that it never
// answers. Seat b plays clean.
function troubled() {
    const p = page(), { ledger } = p;
    const orders = { 2: [refused('cannotAfford')], 3: [refused('targetOutOfSight', 'attack_target')],
        5: [refused('populationLimit'), refused('populationLimit')], 6: [refused('populationLimit')], 7: [refused('populationLimit'), militia], 8: [refused('populationLimit')],
        9: [['conjure', {}, 'invalid', 'notACommand']], 10: [['build_structure', {}, 'avoidable', null]] };
    for (let n = 1; n <= 14; n++) {
        const line = JSON.parse(decision('a', n * 60, { turn: n, orders: orders[n] || [militia] }));
        if (n >= 5 && n <= 8) line.state.population = { used: 10, capacityNow: 10, capacityCeiling: 100 };
        if (n >= 11 && n <= 12) line.state.threats.underAttack = [{ type: 'barracks', x: 100, z: 100, attackers: [{ type: 'militia', x: 104, z: 100, owner: 'maya-2' }] }];
        ledger.addLine(JSON.stringify(line));
    }
    for (let n = 1; n <= 5; n++) ledger.addLine(decision('b', n * 120, { turn: n, orders: [militia] }));
    return p;
}

test('the inspector: the decision a loop began at, the constraints ignored, the orders at what is not there, the threat left alone', () => {
    const { ledger } = troubled();
    const tr = ledger.trace('a', WarBench.classify);
    assert.deepEqual(plain(tr.marks.map(m => [m.kind, m.turn, m.code || null])), [
        ['constraint', 2, 'cannotAfford'], ['awareness', 3, 'targetOutOfSight'], ['loop', 5, 'populationLimit'],
        ['awareness', 9, 'notACommand'], ['refused', 10, null], ['threat', 11, null]]);
    assert.deepEqual(plain(tr.counts), { loop: 1, constraint: 1, awareness: 2, passive: 0, threat: 1, refused: 1 });
    // The loop is one mark at its first decision and carries the run: four decisions, five orders, to decision 8.
    const loop = tr.marks[2];
    assert.deepEqual([loop.of, loop.decision, loop.sec, loop.n, loop.orders, loop.upTo, loop.upToSec, loop.open], ['constraint', 5, 300, 4, 5, 8, 480, false]);
    assert.equal(tr.marks[5].threat.what[0], 'barracks');
    // Two in a row is not a loop yet; three is (WarEval.LOOP_MIN), and one still running at the last decision says so.
    const short = page().ledger;
    for (let n = 1; n <= 4; n++) short.addLine(decision('a', n * 60, { turn: n, orders: [n >= 3 ? refused('cannotAfford') : militia] }));
    assert.deepEqual(plain(short.trace('a', WarBench.classify).marks.map(m => [m.kind, m.turn])), [['constraint', 3], ['constraint', 4]]);
    short.addLine(decision('a', 300, { turn: 5, orders: [refused('cannotAfford')] }));
    assert.deepEqual(plain(short.trace('a', WarBench.classify).marks.map(m => [m.kind, m.turn, m.n, m.open])), [['loop', 3, 3, true]]);
    assert.equal(WarEval.LOOP_MIN, 3);
    // Three consecutive passive waits with idle workers emit a passive stall span mark.
    const stallPage = page(), stall = stallPage.ledger;
    for (let n = 1; n <= 3; n++) {
        const l = JSON.parse(decision('a', n * 60, { turn: n, orders: [['wait', {}, 'ok']] }));
        l.state.workers = { total: 4, idle: 2 };
        l.state.friendlyBuildings = [{ type: 'town_center', state: 'complete', x: 0, z: 0 }];
        stall.addLine(JSON.stringify(l));
    }
    const stallTrace = stall.trace('a', WarBench.classify);
    assert.deepEqual(plain(stallTrace.marks.map(m => [m.kind, m.decision, m.n, m.open, m.upToSec])), [['passive', 1, 3, true, 180]]);
    assert.equal(stallTrace.counts.passive, 1);
    stallPage.u.toggleBenchFull(true);
    assert.match(stallPage.els.benchFull.innerHTML, /<i class="is-passive" style="left:33\.3%;width:66\.7%"/);
    assert.match(stallPage.els.benchFull.innerHTML, /<span class="is-passive" title="bench\.t\.passiveTip"><i><\/i>bench\.t\.passive<\/span>/);
    // The same order refused for another reason, or another order for the same, breaks a run.
    const mixed = page().ledger;
    ['cannotAfford', 'populationLimit', 'cannotAfford'].forEach((c, i) => mixed.addLine(decision('a', (i + 1) * 60, { turn: i + 1, orders: [refused(c)] })));
    assert.equal(mixed.trace('a', WarBench.classify).counts.loop, 0);
    // A clean seat has nothing; a seat that is not in the match has no trace; without the taxonomy a refusal is only "refused".
    assert.deepEqual([ledger.trace('b', WarBench.classify).marks.length, ledger.trace('zz')], [0, null]);
    assert.deepEqual(plain(ledger.trace('a', null).marks.map(m => m.kind)), ['refused', 'refused', 'loop', 'awareness', 'refused', 'threat']);
    // What an old transcript does not record is said, not guessed.
    const old = page().ledger;
    const bare = JSON.parse(decision('a', 60, { turn: 1, orders: [militia] })); delete bare.outcomes;
    old.addLine(JSON.stringify(bare));
    assert.equal(old.trace('a').judged, false);
});

test('the inspector on the board: marks on the match’s clock under the gameplay graph, each a way into the transcript', () => {
    const { u, els } = troubled();
    const origClassOf = WarEval.classOf;
    WarEval.classOf = WarBench.classify;                // what the page has once bench-core.js is loaded
    try {
        u.toggleBenchFull(true);
        const html = els.benchFull.innerHTML, game = html.split('<div class="bb-sec">')[1];
        // The strip stands right under the graphs, a model a strip, with what the colours mean beside the clock.
        assert.match(game, /<\/svg><\/div><\/div><div class="bb-row bb-marks"><div class="bb-lab"><b title="bench\.t\.tip">bench\.t\.title<\/b><\/div>/);
        const strips = [...game.matchAll(/<div class="bt-strip[^"]*"(?: title="([^"]*)")?>(.*?)<\/div>/g)];
        assert.equal(strips.length, 2);
        // The match is 14 minutes; the loop spans decisions 5 to 8, every other mark stands at its second.
        assert.deepEqual([...strips[0][2].matchAll(/<i class="is-(\w+)" style="left:([\d.]+)%(?:;width:([\d.]+)%)?" onclick="event\.stopPropagation\(\); game\.ui\.benchOpenTurn\('a', (\d+)\)" title="#\d+ [\d:]+ · bench\.t\.\w+: [^"]*">/g)]
            .map(m => [m[1], m[2], m[3] || '', m[4]].join(' ')),
            ['constraint 14.3  2', 'awareness 21.4  3', 'loop 35.7 21.4 5', 'awareness 64.3  9', 'refused 71.4  10', 'threat 78.6  11']);
        assert.match(strips[0][2], /title="#5 5:00 · bench\.t\.loop: bench\.t\.loopLine\{&quot;order&quot;:&quot;train unit · populationLimit&quot;,&quot;n&quot;:4,&quot;upTo&quot;:8\}"/);
        assert.deepEqual([strips[1][1], strips[1][2]], ['bench.t.none', ''], 'a clean seat: an empty strip that says so');
        assert.deepEqual([...game.matchAll(/<span class="is-(\w+)" title="bench\.t\.\w+Tip"><i><\/i>bench\.t\.\w+<\/span>/g)].map(m => m[1]), ['loop', 'awareness', 'constraint', 'threat', 'refused']);
        // The count of loops is a figure of the summary.
        assert.deepEqual(figures(html)['bench.t.loops'], ['1', '0']);
        // A click on a mark closes the board and opens that decision in the transcript.
        const opened = [];
        u.openTranscriptTurn = (id, turn) => opened.push(id + ' ' + turn);
        u.benchOpenTurn('a', 5);
        assert.deepEqual([opened, u._benchFull, els.benchFull.style.display], [['a 5'], false, 'none']);
        // An old transcript: the strip says what is not recorded, and there is no count of loops.
        const old = page();
        const bare = JSON.parse(decision('a', 60, { turn: 1, orders: [militia] })); delete bare.outcomes;
        old.ledger.addLine(JSON.stringify(bare));
        old.u.toggleBenchFull(true);
        assert.match(old.els.benchFull.innerHTML, /<div class="bt-strip is-none" title="bench\.t\.unjudged"><\/div>/);
        assert.deepEqual(figures(old.els.benchFull.innerHTML)['bench.t.loops'], ['–']);
    } finally { WarEval.classOf = origClassOf; }
});

// ---- raw model or harness (build 1224) -----------------------------------------------------
// asp67's list: "Separate Raw Model vs. Harnessed results ... make it transparent what the
// base model did versus what the harness fixed."
function seated(schema = 'war-transcript/2') {
    const p = page(), { ledger } = p;
    ledger.addLine(JSON.stringify({ type: 'match', matchId: 'm1', schema, players: [
        { id: 'a', seat: 0, civ: 'roman', model: 'model-a', name: 'Seat a', settings: { provider: 'openai', toolFallback: false } },
        { id: 'b', seat: 1, civ: 'maya', model: 'model-b', name: 'Seat b', settings: { provider: 'mcp', harness: 'hermes', harnessExternal: true } }] }));
    for (let n = 1; n <= 6; n++) {
        const line = JSON.parse(decision('a', n * 60, { turn: n, orders: [militia] }));
        line.answeredVia = n === 4 ? 'content' : 'tool_call';
        ledger.addLine(JSON.stringify(line));
    }
    for (let n = 1; n <= 3; n++) ledger.addLine(decision('b', n * 120, { turn: n, orders: [militia] }));   // an MCP seat's answers carry no form
    const note = o => ledger.addLine(JSON.stringify(Object.assign({ playerId: 'a', at: 1, matchSeconds: 100 }, o)));
    note({ type: 'adaptation', kind: 'contextShrunk' }); note({ type: 'adaptation', kind: 'contextShrunk' }); note({ type: 'adaptation', kind: 'paramOmitted', params: ['reasoning'] });
    note({ type: 'intervention', kind: 'advice', human: true, text: 'build a tower' });
    return p;
}

test('raw model or harness: who plays the seat, and what the game’s own harness did for it', () => {
    const { ledger } = seated();
    const [a, b] = ledger.profile().seats;
    assert.deepEqual(plain(a.harness), { known: true, external: false, kind: null, provider: 'openai', byToolCall: 5, fromProse: 1, viaUnknown: 0,
        adaptations: [{ kind: 'contextShrunk', n: 2 }, { kind: 'paramOmitted', n: 1 }], adapted: 3, interventions: [{ kind: 'advice', n: 1 }], intervened: 1, recorded: true });
    assert.deepEqual(plain(b.harness), { known: true, external: true, kind: 'hermes', provider: 'mcp', byToolCall: 0, fromProse: 0, viaUnknown: 3,
        adaptations: [], adapted: 0, interventions: [], intervened: 0, recorded: true });
    // None of it is inside a score, and none of it is in the profile a file carries: an older file's recorded profile still compares equal.
    const plainMatch = page().ledger;
    for (let n = 1; n <= 6; n++) plainMatch.addLine(decision('a', n * 60, { turn: n, orders: [militia] }));
    const bare = plainMatch.profile().seats[0];
    assert.deepEqual([a.index.value, a.grounding.score], [bare.index.value, bare.grounding.score]);
    assert.equal('harness' in WarEval.publicProfile(ledger.profile()).seats[0], false);
    // A file with no first line says nothing of who plays; one older than schema 2 does not record what the harness did.
    assert.deepEqual([bare.harness.known, bare.harness.external, bare.harness.recorded], [false, null, false]);
    assert.equal(seated('war-transcript/1').ledger.profile().seats[0].harness.recorded, false);
    assert.equal(seated(null).ledger.profile().seats[0].harness.recorded, false);
    // The profile at an earlier moment carries the same seat facts.
    assert.equal(ledger.profileAt(120).seats[1].harness.external, true);
});

test('raw model or harness on the board: a tag beside the name, and one row of the summary', () => {
    const { u, els } = seated();
    u.toggleBenchFull(true);
    const html = els.benchFull.innerHTML;
    const heads = colsOf(rowsOf(html)[0].html);
    assert.equal(heads[0], '<span title="Seat a · model-a">Seat a</span><em class="bf-kind is-raw" title="bench.h.rawTip">bench.h.raw</em>');
    assert.equal(heads[1], '<span title="Seat b · model-b">Seat b</span><em class="bf-kind is-harness" title="bench.h.harnessTip">bench.h.harness · hermes</em>');
    // What the game's harness did, in words; nothing done is "none".
    assert.deepEqual(figures(html)['bench.h.help'], ['bench.h.sProse{&quot;n&quot;:1}, bench.h.sAdapted{&quot;n&quot;:3}, bench.h.sHuman{&quot;n&quot;:1}', 'bench.h.none']);
    assert.match(html, /bench\.h\.help<\/div><div class="bb-col"[^>]*><span title="bench\.h\.helpTip">/);
    // An older file does not record adaptations or interventions: they are left out, not shown as none.
    const old = seated('war-transcript/1');
    assert.deepEqual(old.ledger.profile().seats.map(s => old.u.benchHelpText(s)), ['bench.h.sProse{"n":1}', 'bench.h.notRecorded']);
    // No first line at all: no tag, and nothing is known of the harness.
    const bare = page();
    for (let n = 1; n <= 2; n++) bare.ledger.addLine(decision('a', n * 60, { turn: n, orders: [militia] }));
    bare.u.toggleBenchFull(true);
    assert.doesNotMatch(bare.els.benchFull.innerHTML, /bf-kind/);
    assert.equal(bare.u.benchHelpText(bare.ledger.profile().seats[0]), 'bench.h.notRecorded');
});

// ---- where the board opens, and where the chart to share stands -----------------------------
test('the board opens without the Bench panels: from the results screen and in the transcript analyzer', () => {
    const p = troubled(), { u, els, store } = p;
    const origClassOf = WarEval.classOf;
    WarEval.classOf = WarBench.classify;
    try {
        assert.equal(u.benchOn(), false);
        // The results screen: the report card carries the matrix as before, the way to the board, and the chart to share.
        const sum = { classList: { contains: c => c === 'active' }, style: {} }, card = { style: {}, innerHTML: '' };
        els.arenaSummaryScreen = sum; els.summaryProfile = card;
        u.game.openAIAIManager.transcripts.hasData = () => true;
        u.updateSummaryProfile();
        assert.match(card.innerHTML, /<table class="bm">.*<button type="button" class="summary-board-btn" onclick="game\.ui\.toggleBenchFull\(true\)">bench\.b\.fullBtn<\/button><p class="summary-profile-note">sum\.profileNote<\/p><div class="bf-share"><h4>share\.title/s);
        assert.match(card.innerHTML, /<div class="bs-pic"><svg xmlns.*<\/svg><\/div><\/div>$/s, 'the picture that sums the match up, with its buttons');
        assert.match(card.innerHTML, /class="bs-btn is-on" onclick="game\.ui\.benchShareAxis\('outPerOk'\)"/);
        assert.match(card.innerHTML, /<rect class="sweet-spot"/);
        // Another axis is drawn on the card, where the picture is.
        u.benchShareAxis('tokens');
        assert.match(card.innerHTML, /class="bs-btn is-on" onclick="game\.ui\.benchShareAxis\('tokens'\)"/);
        assert.match(card.innerHTML, />share\.xTokens<\/text>/);
        u.toggleBenchFull(true);
        assert.equal(els.benchFull.style.display, '');
        assert.match(els.benchFull.innerHTML, /<div class="bb" style="--n:2">/);
        assert.doesNotMatch(els.benchFull.innerHTML, /bf-share|<svg xmlns/, 'the chart to share is not on the board');
        assert.equal(els.benchMatrix.innerHTML, '', 'the panels stay as they were: off');
        // After the end a decision opens in the analyzer; once the transcript is gone a mark is only a mark.
        assert.match(els.benchFull.innerHTML, /<i class="is-loop" style="[^"]*" onclick="event\.stopPropagation\(\); game\.ui\.benchOpenTurn\('a', 5\)"/);
        const went = [];
        u.watchInAnalyzer = () => Promise.resolve(); u.anApplyMoment = m => went.push(m);
        return u.benchOpenTurn('a', 5).then(() => {
            assert.deepEqual([plain(went), u._benchFull, els.benchFull.innerHTML], [[{ seat: 1, turn: 5 }], false, '']);
            u.game.openAIAIManager.transcripts.hasData = () => false;
            u.toggleBenchFull(true);
            assert.match(els.benchFull.innerHTML, /<i class="is-loop" style="[^"]*" title="#5 5:00/);
            assert.doesNotMatch(els.benchFull.innerHTML, /benchOpenTurn/);
            u.toggleBenchFull(false);

            // The transcript analyzer: the board reads the loaded file's own ledger, and a decision opens there.
            delete els.arenaSummaryScreen;
            els.analyzeScreen = { classList: { contains: c => c === 'active' } };
            const file = WarEval.createLedger();
            for (let n = 1; n <= 5; n++) file.addLine(decision('b', n * 60, { turn: n, orders: [refused('cannotAfford')] }));
            u.analyzer = { ledger: file };
            assert.equal(u.benchLedger(), file);
            u.toggleBenchFull(true);
            const html = els.benchFull.innerHTML;
            assert.match(html, /<div class="bb" style="--n:1">/, 'the file holds one seat, the match behind it two');
            assert.equal((html.match(/<i class="is-loop"/g) || []).length, 1);
            went.length = 0;
            u.benchOpenTurn('b', 1);
            assert.deepEqual([plain(went), u._benchFull], [[{ seat: 2, turn: 1 }], false]);
            // The Bench panels are a match's: in the analyzer they stay away even when the view is switched on.
            store.x = 1; u.viewPreferences().bench = true;
            els.benchMatrix.innerHTML = '';
            u.updateBenchView();
            assert.equal(els.benchMatrix.innerHTML, '');
            const page_ = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
            assert.match(page_, /<button class="sb-end an-board" onclick="game\.ui\.toggleBenchFull\(true\)" data-i18n="bench\.matrix" data-i18n-title="bench\.b\.fullBtn">/);
            // The analyzer reads every line of a file into a ledger of its own.
            const an = fs.readFileSync(path.join(root, 'js/analyzer.js'), 'utf8');
            assert.match(an, /this\.ledger = WarEval\.createLedger\(\);/);
            assert.match(an, /if \(this\.ledger\) this\.ledger\.add\(o\);/);
        }).finally(() => { WarEval.classOf = origClassOf; });
    } catch (e) { WarEval.classOf = origClassOf; throw e; }
});

test('two things asp67 saw beside the board: a plan wraps inside its panel, and a seat card’s flyout lies on top', () => {
    const css = fs.readFileSync(path.join(root, 'css/styles.css'), 'utf8');
    const rule = sel => { const m = css.match(new RegExp('(?:^|\\n)' + sel.replace(/[.\-]/g, '\\$&') + ' \\{([^}]*)\\}')); return m ? m[1] : ''; };
    // A long word in a plan step (names joined by slashes) gave the plan panel a sideways scroll bar.
    assert.match(rule('.bench-panel'), /overflow-x: hidden; overflow-wrap: anywhere;/);
    // 3-digit equalizer values (e.g. 100) must not wrap under .bench-panel's overflow-wrap: anywhere.
    assert.match(rule('.bb-eq-bar b'), /white-space:\s*nowrap;[\s\S]*overflow-wrap:\s*normal;/);
    // The comparison card lay over the flyout of a model's score card.
    const z = sel => Number((rule(sel).match(/z-index: (\d+)/) || [])[1]);
    assert.ok(z('.lb-flyout') > z('.bench-panel') && z('.lb-flyout') > 1002, 'above the panels, also where they are raised on a narrow window');
    assert.ok(z('.lb-flyout') < z('.bench-full'), 'and under the board at full size');
});
