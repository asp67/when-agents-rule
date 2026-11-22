'use strict';
// Build 1222 (asp67, 22 November 2026): "Change the lines to graphs over time. Separate it in
// 3 distinct sections per model: gameplay score, model performance and cost, score summary.
// Have a mini card on screen that is still readable and toggle a full size view when clicked."
// Also from that list: the score for what it cost (tokens, wall-clock time) beside the
// score, and the discipline of a model (orders that cannot be called, mistakes repeated).
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const WarEval = require(path.join(root, 'js/eval/ledger.js'));
const plain = v => JSON.parse(JSON.stringify(v));

function page() {
    const els = {}, store = {}, body = new Set(), keys = [], vars = {};
    const el = id => els[id] || (els[id] = { id, style: {}, innerHTML: '', classList: { toggle() {} }, setAttribute() {} });
    ['benchLeft', 'benchMatrix', 'benchFull', 'benchBtn'].forEach(el);
    const context = vm.createContext({ console, Date, WarEval, t: (k, v) => k + (v ? JSON.stringify(v) : ''), getUiLang: () => 'en',
        OpenAIAIManager: { MAX_COMMANDS_PER_TURN: 3 },
        localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; } },
        document: { getElementById: id => els[id] || null, addEventListener: (type, fn) => keys.push(fn),
            body: { style: { setProperty: (k, v) => { vars[k] = v; }, removeProperty: k => { delete vars[k]; } },
                classList: { toggle: (c, on) => { if (on) body.add(c); else body.delete(c); }, contains: c => body.has(c) } } } });
    for (const f of ['js/ui.js', 'js/eval/bench-view.js']) vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8') + '\nthis.UI = UIManager;', context);
    const u = Object.create(context.UI.prototype);
    u.escapeHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
    Object.assign(u, { teamDotHtml: () => '', renderTranscriptViewer() {}, updateSpectatorPlayerList() {} });
    const ledger = WarEval.createLedger();
    u.game = { spectatorMode: true, gameStarted: true, openAIAIManager: { transcripts: { ledger } } };
    return { u, els, store, body, keys, ledger };
}
const decision = (id, sec, o = {}) => JSON.stringify({ turn: o.turn || 1, playerId: id, name: 'Seat ' + id, seat: id === 'a' ? 0 : 1, latencyMs: o.latencyMs || 4000,
    tokens: o.tokens || { prompt: 9000, completion: 300 },
    parsed: Object.assign({ commands: (o.orders || []).map(x => ({ action: x[0], params: x[1] || {} })) }, o.plan ? { objective: 'Hold the town', plan: o.plan } : null),
    outcomes: (o.orders || []).map((x, i) => ({ n: i + 1, action: x[0], code: x[3] || 'c', verdict: x[2] || 'ok' })),
    state: { clock: { matchSeconds: sec }, population: { used: 20 }, threats: { underAttack: [], enemyWonders: [] },
        units: { trainable: { barracks: { stone: [{ id: 'militia' }] } } }, buildings: { buildable: [{ type: 'tower' }, { type: 'barracks' }] },
        friendlyBuildings: [{ type: 'barracks', x: 100, z: 100 }], gameStats: { opponents: [{ id: 'maya-2', civilization: 'maya' }] } } });
const cells = html => [...html.matchAll(/class="bm-cell[^"]*"[^>]*><b>([^<]*)<\/b>/g)].map(m => m[1]);
const militia = ['train_unit', { unitType: 'militia' }];

// Seat a: ten decisions a minute apart, two orders refused for a shown reason (the second a
// repeat), one that cannot be called. Seat b: five decisions, each far dearer and slower.
function match() {
    const p = page(), { u, ledger } = p;
    for (let n = 1; n <= 10; n++) ledger.addLine(decision('a', n * 60, { turn: n, plan: n === 1 ? ['Build a tower', 'Train militia'] : undefined,
        orders: n === 5 || n === 6 ? [['train_unit', { unitType: 'militia' }, 'avoidable']] : n === 8 ? [['conjure', {}, 'invalid', 'unknown_action']] : [militia] }));
    for (let n = 1; n <= 5; n++) ledger.addLine(decision('b', n * 120, { turn: n, orders: [militia], latencyMs: 30000, tokens: { prompt: 40000, completion: 2000 } }));
    const samples = [];
    for (let t = 5; t <= 600; t += 5) samples.push({ t, p: { a: { pw: 100 + t }, b: { pw: 100 + t / 2 } } });
    u.game._timeline = { samples, ages: [] };
    return p;
}

test('the scores over a match still being played are kept, and only the newest are worked out again', () => {
    const { u, ledger } = match();
    u.evalLedger();                                    // the page shows the ledger the running timeline
    assert.equal(ledger.power().length, 120);
    let asked = 0;
    const at = ledger.profileAt.bind(ledger);
    ledger.profileAt = sec => { asked++; return at(sec); };
    const first = ledger.liveHistory(30, 120);
    assert.deepEqual([first.samples.length, asked], [20, 20]);
    asked = 0;
    const again = ledger.liveHistory(30, 120);
    assert.equal(asked, 5, 'the samples of the last two minutes, the one at the end among them');
    assert.deepEqual(plain(again.samples), plain(first.samples));
    assert.deepEqual(plain(ledger.history(30).samples), plain(first.samples), 'and they are the rows the file would carry');
});

test('the mini card: a row a model, three sections each, and a click opens the full size', () => {
    const { u, els, ledger } = match();
    u.toggleBenchView(true);
    const html = els.benchMatrix.innerHTML;
    assert.match(html, /^<div class="bench-head">bench\.matrix<span>bench\.b\.open<\/span><\/div><div class="bc-list" role="button" tabindex="0" title="bench\.b\.openTip" onclick="game\.ui\.toggleBenchFull\(true\)">/);
    assert.equal((html.match(/class="bc-seat"/g) || []).length, 2);
    for (const k of ['bench.b.game', 'bench.b.model', 'bench.b.summary']) assert.equal(html.split('>' + k + '<').length - 1, 2, k + ': once a model');
    assert.equal((html.match(/<svg class="bg-chart/g) || []).length, 4, 'two graphs a model: its power and its Index');
    // Gameplay: its own line over the other seat's faint one; the power now, the rank by it, the share of all power.
    assert.match(html, /bench\.b\.game<\/span><svg[^>]*>(<path[^>]*opacity="0\.3"[^>]*\/>)(<path[^>]*opacity="1"[^>]*\/>)<\/svg><b>700<\/b><small>#1 · 63\.6 %<\/small>/);
    // Model and cost: tokens and thinking time so far, and the Index a million tokens.
    assert.match(html, /bench\.b\.model<\/span><svg[^>]*>.*?<\/svg><b>93k tok<\/b><small>40 s · [\d.]+\/M<\/small>/s);
    // Score: the Index large, the five parts by their letters.
    const a = ledger.profile().seats.find(s => s.id === 'a');
    assert.match(html, new RegExp('bc-index">' + Math.round(a.index.value) + '</b><small class="bc-parts">(<i title="eval\\.\\w+">bench\\.b\\.\\w+ [\\d–]+</i>){5}</small>'));
    // The matrix is not on screen any more; it lives at full size.
    assert.equal(cells(html).length, 0);
    // Nothing decided yet: it says so, and there is nothing to open.
    const empty = page();
    assert.match(empty.u.benchMiniHtml(empty.ledger), /bench\.none/);
    assert.doesNotMatch(empty.u.benchMiniHtml(empty.ledger), /toggleBenchFull/);
});

test('what a seat’s play cost, the score for that cost, and its discipline', () => {
    const { u, ledger } = match();
    u.evalLedger();
    u.benchKeepThinking(u.benchSeries(ledger));
    const a = ledger.profile().seats.find(s => s.id === 'a'), b = ledger.profile().seats.find(s => s.id === 'b'), ca = u.benchCost(a), cb = u.benchCost(b);
    // Ten decisions of 9000 + 300 tokens and four seconds each; five of 40000 + 2000 and thirty seconds.
    assert.deepEqual([ca.tokens, ca.promptTokens, ca.completionTokens, ca.thinkingMs], [93000, 90000, 3000, 40000]);
    assert.deepEqual([cb.tokens, cb.thinkingMs], [210000, 150000]);
    // The score for what it cost: Index points a million tokens, and a minute of thinking.
    assert.ok(Math.abs(ca.perMTok - a.index.value / 0.093) < 1e-9 && Math.abs(ca.perMin - a.index.value / (40 / 60)) < 1e-9);
    assert.ok(cb.perMTok < ca.perMTok && cb.perMin < ca.perMin, 'the dear and slow seat scores less for its cost');
    // Discipline: of ten judged orders one could not be called and two were refused for a shown reason; of three mistakes one was made again.
    assert.deepEqual([ca.invalidRate, ca.refusedRate], [0.1, 0.2]);
    assert.ok(Math.abs(ca.recovery - 2 / 3) < 1e-9);
    assert.deepEqual([cb.invalidRate, cb.refusedRate, cb.recovery, cb.lost], [0, 0, null, 0], 'no mistake: nothing to recover from');
    // A seat whose harness reports no usage has no tokens and no score for them, which is not a zero.
    const none = Object.assign({}, a, { efficiency: Object.assign({}, a.efficiency, { tokens: null }) });
    assert.deepEqual([u.benchCost(none).tokens, u.benchCost(none).perMTok], [null, null]);
});

test('at full size: three sections a model with their graphs, cost and discipline in numbers, and the matrix under them', () => {
    const { u, els, keys } = match();
    u.toggleBenchView(true);
    u.toggleBenchFull(true);
    const html = els.benchFull.innerHTML;
    assert.equal(els.benchFull.style.display, '');
    assert.equal((html.match(/<section class="bf-seat"/g) || []).length, 2);
    for (const k of ['bench.b.gameFull', 'bench.b.modelFull', 'bench.b.summaryFull']) assert.equal(html.split('<h4>' + k + '</h4>').length - 1, 2, k);
    assert.equal((html.match(/<svg class="bg-chart/g) || []).length, 6, 'three graphs a model: power, the Index with its parts, the cost');
    // The performance graph: lines for the parts and the Index over them, drawn heavier; nothing past the end of the match.
    const perf = html.split('<h4>bench.b.modelFull</h4>')[1].match(/<svg[^>]*>(.*?)<\/svg>/s)[1];
    assert.ok((perf.match(/<path/g) || []).length >= 3);
    assert.match(perf, /stroke="#ddd3b4" stroke-width="2\.4"/);
    for (const m of html.matchAll(/ d="([^"]+)"/g)) for (const p of m[1].match(/[ML]([\d.]+) /g)) assert.ok(parseFloat(p.slice(1)) <= 300.05);
    assert.match(html, /<div class="bf-axis"><span>0:00<\/span><span>10:00<\/span><\/div>/);
    // The numbers of the middle section, each with what it means on hover.
    for (const k of ['tokens', 'thinking', 'perMTok', 'perMin', 'invalid', 'refused', 'recovery', 'lost']) assert.match(html, new RegExp('<dt>bench\\.b\\.' + k + '</dt><dd>[^<]+</dd>'), k);
    assert.match(html, /title="bench\.b\.invalidTip"><dt>bench\.b\.invalid<\/dt><dd>10.0 %<\/dd>/);
    assert.match(html, /<dt>bench\.b\.recovery<\/dt><dd>66\.7 %<\/dd>/);
    assert.match(html, /<dt>bench\.b\.tokens<\/dt><dd>93k \(90k \+ 3k\)<\/dd>/);
    assert.match(html, /title="bench\.b\.lostTip\{&quot;failed&quot;:0,&quot;cancelled&quot;:0,&quot;missed&quot;:0\}"/);
    // The summary: the Index and every part with what it rests on. Then the matrix as it was, with its cells to open.
    assert.match(html, /<div class="bf-index"><b>\d+<\/b><span>eval\.index<\/span><\/div><table>(<tr><th scope="row"><i style="background:#[0-9a-f]{6}"><\/i>eval\.\w+<\/th><td>[\d–]+<\/td><td>[^<]*<\/td><\/tr>){5}<\/table>/);
    assert.match(html, /<div class="bf-matrix"><div class="bench-head">bench\.matrix.*<table class="bm">/s);
    assert.equal(cells(html).length, 10);
    // A click inside does not close it; its button and Escape do.
    assert.match(html, /^<div class="bf-box" onclick="event\.stopPropagation\(\)"><div class="bf-head">.*onclick="game\.ui\.toggleBenchFull\(false\)"/s);
    keys[keys.length - 1]({ key: 'Escape' });
    assert.deepEqual([els.benchFull.innerHTML, els.benchFull.style.display, u._benchFull], ['', 'none', false]);
    assert.match(els.benchMatrix.innerHTML, /bc-seat/, 'the mini card stays');
    assert.match(fs.readFileSync(path.join(root, 'index.html'), 'utf8'), /<div id="benchFull" class="bench-full" style="display:none;"><\/div>/);
});
