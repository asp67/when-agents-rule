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
    outcomes: (o.orders || []).map((x, i) => ({ n: i + 1, action: x[0], code: x.length > 3 ? x[3] : 'c', verdict: x[2] || 'ok' })),
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

// ---- the decision inspector (build 1223) ---------------------------------------------
// asp67's list: "Let users see why a model lost - highlight the exact turn where it entered
// a loop, ignored a constraint, or lost spatial/context awareness."
const WarBench = require(path.join(root, 'js/bench-core.js'));
const refused = (code, action = 'train_unit') => [action, {}, 'avoidable', code];
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
    assert.deepEqual(plain(tr.counts), { loop: 1, constraint: 1, awareness: 2, threat: 1, refused: 1 });
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

test('the inspector at full size: the marks on the clock, the list, and a click that opens the decision', () => {
    const { u, els, ledger } = troubled();
    WarEval.classOf = WarBench.classify;                // what the page has once bench-core.js is loaded
    u.toggleBenchView(true);
    u.toggleBenchFull(true);
    const html = els.benchFull.innerHTML, a = html.split('<section class="bf-seat"')[1], b = html.split('<section class="bf-seat"')[2];
    assert.match(a, /<\/div><\/div><div class="bf-trace"><h4>bench\.t\.title<small>bench\.t\.tip<\/small><\/h4><div class="bt-chips">/, 'under the three sections');
    assert.deepEqual([...a.matchAll(/class="bt-chip is-(\w+)" title="bench\.t\.\w+Tip"><i><\/i>(\d+) bench\.t\.\w+</g)].map(m => m[1] + ' ' + m[2]),
        ['loop 1', 'constraint 1', 'awareness 2', 'threat 1', 'refused 1']);
    // On the clock: the match is 14 minutes; the loop spans decisions 5 to 8, every other mark stands at its second.
    const strip = a.match(/<div class="bt-strip">(.*?)<\/div>/s)[1];
    assert.deepEqual([...strip.matchAll(/<i class="is-(\w+)" style="left:([\d.]+)%(?:;width:([\d.]+)%)?" onclick="game\.ui\.benchOpenTurn\('a', (\d+)\)"/g)].map(m => [m[1], m[2], m[3] || '', m[4]].join(' ')),
        ['constraint 14.3  2', 'awareness 21.4  3', 'loop 35.7 21.4 5', 'awareness 64.3  9', 'refused 71.4  10', 'threat 78.6  11']);
    // The list: when, which kind, and the order with its reason in the harness's own words.
    const list = [...a.matchAll(/<li class="is-(\w+)" onclick="game\.ui\.benchOpenTurn\('a', (\d+)\)" title="bench\.open"><span class="be-when">#(\d+) ([\d:]+)<\/span><b>bench\.t\.(\w+)<\/b><span>([^<]*)<\/span><\/li>/g)];
    assert.deepEqual(list.map(m => m[3] + ' ' + m[4] + ' ' + m[5] + ' ' + m[6]), [
        '2 2:00 constraint train unit · cannotAfford', '3 3:00 awareness attack target · targetOutOfSight',
        '5 5:00 loop bench.t.loopLine{&quot;order&quot;:&quot;train unit · populationLimit&quot;,&quot;n&quot;:4,&quot;upTo&quot;:8}',
        '9 9:00 awareness conjure · notACommand', '10 10:00 refused build structure',
        '11 11:00 threat ' + u.escapeHtml(u.benchThreatLine(ledger.trace('a').marks[5].threat, ledger.profile().seats.find(s => s.id === 'a')))]);
    assert.match(b, /<div class="bf-trace"><h4>.*?<\/h4><p class="bench-none">bench\.t\.none<\/p><\/div>/);
    // A click on one closes the board and opens that decision in the transcript.
    const opened = [];
    u.openTranscriptTurn = (id, turn) => opened.push(id + ' ' + turn);
    u.benchOpenTurn('a', 5);
    assert.deepEqual([opened, u._benchFull, els.benchFull.style.display], [['a 5'], false, 'none']);
    // An old transcript: said in words.
    const old = page();
    const bare = JSON.parse(decision('a', 60, { turn: 1, orders: [militia] })); delete bare.outcomes;
    old.ledger.addLine(JSON.stringify(bare));
    assert.match(old.u.benchTraceHtml(old.ledger, old.ledger.profile().seats[0], 60), /bench\.t\.unjudged/);
    WarEval.classOf = () => null;
});

test('the board at full size opens without the Bench panels: from the results screen and in the transcript analyzer', () => {
    // The results screen: the Bench view is off; the report card carries the way in.
    const p = troubled(), { u, els, store } = p;
    WarEval.classOf = WarBench.classify;
    assert.equal(u.benchOn(), false);
    const sum = { classList: { contains: c => c === 'active' }, style: {} }, card = { style: {}, innerHTML: '' };
    els.arenaSummaryScreen = sum; els.summaryProfile = card;
    u.game.openAIAIManager.transcripts.hasData = () => true;
    u.updateSummaryProfile();
    assert.match(card.innerHTML, /<button type="button" class="summary-board-btn" onclick="game\.ui\.toggleBenchFull\(true\)">bench\.b\.fullBtn<\/button>/);
    u.toggleBenchFull(true);
    assert.equal(els.benchFull.style.display, '');
    assert.equal((els.benchFull.innerHTML.match(/<section class="bf-seat"/g) || []).length, 2);
    assert.equal(els.benchMatrix.innerHTML, '', 'the panels stay as they were: off');
    // After the end a decision opens in the analyzer, and says so; once the transcript is gone a mark is only a mark.
    assert.match(els.benchFull.innerHTML, /<li class="is-loop" onclick="game\.ui\.benchOpenTurn\('a', 5\)" title="sum\.openAnalyzer">/);
    const went = [];
    u.watchInAnalyzer = () => Promise.resolve(); u.anApplyMoment = m => went.push(m);
    return u.benchOpenTurn('a', 5).then(() => {
        assert.deepEqual([plain(went), u._benchFull, els.benchFull.innerHTML], [[{ seat: 1, turn: 5 }], false, '']);
        u.game.openAIAIManager.transcripts.hasData = () => false;
        u.toggleBenchFull(true);
        assert.match(els.benchFull.innerHTML, /<li class="is-loop"><span class="be-when">#5 5:00<\/span>/);
        assert.doesNotMatch(els.benchFull.innerHTML.split('bf-matrix')[0], /benchOpenTurn/);
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
        assert.equal((html.match(/<section class="bf-seat"/g) || []).length, 1, 'the file holds one seat, the match behind it two');
        assert.match(html, /class="bt-chip is-loop"[^>]*><i><\/i>1 bench\.t\.loop</);
        went.length = 0;
        u.benchOpenTurn('b', 1);
        assert.deepEqual([plain(went), u._benchFull], [[{ seat: 2, turn: 1 }], false]);
        // The Bench panels are a match's: in the analyzer they stay away even when the view is switched on.
        store.x = 1; u.viewPreferences().bench = true;
        els.benchMatrix.innerHTML = '';
        u.updateBenchView();
        assert.equal(els.benchMatrix.innerHTML, '');
        WarEval.classOf = () => null;
        const page_ = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
        assert.match(page_, /<button class="sb-end an-board" onclick="game\.ui\.toggleBenchFull\(true\)" data-i18n="bench\.matrix" data-i18n-title="bench\.b\.fullBtn">/);
        // The analyzer reads every line of a file into a ledger of its own.
        const an = fs.readFileSync(path.join(root, 'js/analyzer.js'), 'utf8');
        assert.match(an, /this\.ledger = WarEval\.createLedger\(\);/);
        assert.match(an, /if \(this\.ledger\) this\.ledger\.add\(o\);/);
    });
});
