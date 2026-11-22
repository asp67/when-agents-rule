'use strict';
// Build 1226 (asp67, 22 November 2026): "Build shareable visual summaries: generate clean,
// high-contrast scatter plots (e.g. Intelligence/Win Rate vs. Speed, or Win Rate vs. Token
// Efficiency) and replayable state/heatmaps."
// Held here: the picture stands by itself (js/eval/share.js), a point is where its numbers
// say, a mean is never drawn without its spread, a value that is not there is named and not
// placed at zero, and the board and the Season page hand it the numbers they show.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const WarEval = require(path.join(root, 'js/eval/ledger.js'));
const WarSeason = require(path.join(root, 'js/eval/season.js'));
const WarShare = require(path.join(root, 'js/eval/share.js'));
const { loadConditions } = require(path.join(root, 'tools/eval/season.cjs'));
const plain = v => JSON.parse(JSON.stringify(v));
const t = (k, v) => k + (v ? JSON.stringify(v) : '');

test('an axis starts at zero and ends at a round number at or above the largest value', () => {
    assert.deepEqual(WarShare.axis(47), { top: 50, ticks: [0, 10, 20, 30, 40, 50] });
    assert.deepEqual(WarShare.axis(3.2), { top: 4, ticks: [0, 1, 2, 3, 4] });
    assert.deepEqual(WarShare.axis(100), { top: 100, ticks: [0, 20, 40, 60, 80, 100] });
    assert.deepEqual(WarShare.axis(1250), { top: 1500, ticks: [0, 500, 1000, 1500] });
    assert.deepEqual(WarShare.axis(0), { top: 1, ticks: [0, 1] });
    assert.deepEqual(WarShare.axis(NaN), { top: 1, ticks: [0, 1] });
});

test('a point stands where its numbers say; a mean of several matches carries a whisker from its lowest to its highest', () => {
    const box = { x0: 100, y0: 100, w: 800, h: 500, xLabel: 'seconds', yLabel: 'Index' };
    const out = WarShare.scatter([
        { name: 'Alpha', x: 10, y: 50, ink: '#ff0000' },
        { name: 'Beta', x: 20, y: 80, ink: '#00ff00', harness: true, lo: 60, hi: 90, note: '3 matches' },
        { name: 'Gamma', x: null, y: 70 }, { name: 'Delta', x: 5, y: null }], box);
    // The largest x is 20; with a little air the axis ends at 25. Alpha: 10/25 of 800 across, half of 500 up.
    assert.equal(out.xTop, 25);
    assert.match(out.svg, /<circle class="pt is-raw" cx="420\.0" cy="350\.0" r="15" fill="#ff0000"/);
    // Beta is an agent harness: a diamond about (740, 200), and its whisker runs from 60 (y 300) to 90 (y 150).
    assert.match(out.svg, /<path class="pt is-harness" d="M740\.0 182\.0L758\.0 200\.0L740\.0 218\.0L722\.0 200\.0Z" fill="#00ff00"/);
    assert.match(out.svg, /<line class="whisker" x1="740\.0" x2="740\.0" y1="300\.0" y2="150\.0" stroke="#00ff00"/);
    assert.equal((out.svg.match(/class="whisker"/g) || []).length, 1, 'one match has no whisker');
    // Its label stands left of it (the right edge is near), with the note behind the name.
    assert.match(out.svg, /<text x="714\.0" y="208\.0" text-anchor="end"[^>]*>Beta<tspan[^>]*> 3 matches<\/tspan><\/text>/);
    assert.match(out.svg, /<text x="446\.0" y="358\.0" text-anchor="start"[^>]*>Alpha<\/text>/);
    // What has no value on an axis is not drawn at zero: it is handed back to be named.
    assert.deepEqual(out.left.map(p => p.name), ['Gamma', 'Delta']);
    assert.equal((out.svg.match(/class="pt /g) || []).length, 2);
    // Two points on the same spot: their labels do not lie on each other.
    const two = WarShare.scatter([{ name: 'One', x: 10, y: 50 }, { name: 'Two', x: 10, y: 50 }], box).svg;
    assert.deepEqual([...two.matchAll(/<text x="[\d.]+" y="([\d.]+)" text-anchor="(?:start|end)" font-size="24" font-weight="600"/g)].map(m => m[1]), ['358.0', '388.0']);
});

test('the order map: a cell the brighter the more orders went there, and nothing outside the map', () => {
    // A map of side 400 around 0, four cells a side: a cell is 100 wide.
    const g = WarShare.grid([{ x: -150, z: -150 }, { x: -151, z: -149 }, { x: 150, z: 150 }, { x: 0, z: 0 }, { x: 999, z: 0 }, { x: null, z: 3 }], 400, 4);
    assert.deepEqual(plain(g), { n: 4, cells: [2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], most: 2, placed: 4 });
    assert.deepEqual(plain(WarShare.grid([{ x: 1, z: 1 }], 0, 4)).placed, 0);        // a file that does not give the map's size
    const svg = WarShare.heat([{ name: 'Alpha', ink: '#ff0000', grid: g }, { name: 'Beta', ink: '#00ff00', grid: WarShare.grid([], 400, 4) }], { x0: 0, y0: 0, w: 480, h: 640, title: 'Where', none: 'none' });
    assert.deepEqual([...svg.matchAll(/class="cell"[^>]*opacity="([\d.]+)"/g)].map(m => m[1]), ['1.00', '0.61', '0.61']);
    assert.match(svg, />none<\/text>/, 'a seat with no placed order says so');
});

test('the picture stands by itself: a size, a background, a title, a legend of what is in it, and where it is from', () => {
    const spec = { title: 'Alpha <b> · Beta', sub: 'match-1 · build 1226', x: 'seconds', y: 'Index', points: [
        { name: 'Alpha', x: 10, y: 50, ink: '#ff0000' }, { name: 'Beta', x: 20, y: 80, ink: '#00ff00', harness: true, lo: 60, hi: 90 }, { name: 'Gamma', x: null, y: 70 }],
        heat: null, legend: { raw: 'Raw model', harness: 'Agent harness', whisker: 'lowest to highest' }, notShown: 'Not placed:', foot: ['from here', 'scale v3'] };
    const svg = WarShare.card(spec);
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 1600 900" width="1600" height="900" font-family="[^"]+"><rect width="1600" height="900" fill="#0c0f14"\/>/);
    assert.match(svg, /<\/svg>$/);
    assert.doesNotMatch(svg, /<style|<image|href=|url\(|class="bf-|<script/, 'no stylesheet, nothing fetched');
    assert.match(svg, />Alpha &lt;b&gt; · Beta<\/text>/, 'a name cannot break the markup');
    for (const text of ['Raw model', 'Agent harness', 'lowest to highest', 'Not placed: Gamma', 'from here', 'scale v3', 'seconds', 'Index', 'match-1 · build 1226']) assert.ok(svg.includes('>' + text + '<'), text);
    // The legend names only what the picture holds.
    const rawOnly = WarShare.card(Object.assign({}, spec, { points: [spec.points[0]] }));
    assert.ok(rawOnly.includes('>Raw model<') && !rawOnly.includes('>Agent harness<') && !rawOnly.includes('>lowest to highest<'));
    assert.ok(!WarShare.card(Object.assign({}, spec, { points: [spec.points[1]] })).includes('>Raw model<'));
    // Nothing to place: it says so in words instead of an empty plot.
    assert.match(WarShare.card(Object.assign({}, spec, { points: [spec.points[2]], empty: 'Nothing here' })), />Nothing here<\/text>/);
    // With an order map the plot is narrower and the map stands to its right.
    const withMap = WarShare.card(Object.assign({}, spec, { heat: { title: 'Where the orders went', none: 'none', seats: [{ name: 'Alpha', ink: '#ff0000', grid: WarShare.grid([{ x: 0, z: 0 }], 400, 4) }] } }));
    assert.match(withMap, /<rect x="150" y="170" width="850" height="560"/);
    assert.match(svg, /<rect x="150" y="170" width="1370" height="560"/);
    assert.ok(withMap.includes('>Where the orders went<') && /class="cell"/.test(withMap));
});

test('a harness that ends a turn in milliseconds has no speed to show', () => {
    assert.equal(WarShare.speedOf(4500, false), 4.5);
    assert.equal(WarShare.speedOf(13, false), 0.013, 'a raw model’s time is its request’s round trip, whatever it is');
    assert.equal(WarShare.speedOf(6100, true), 6.1);
    assert.equal(WarShare.speedOf(13, true), null);
    assert.equal(WarShare.speedOf(WarShare.HARNESS_MIN_MS, true), 1);
    assert.deepEqual([WarShare.speedOf(null, false), WarShare.speedOf(0, false), WarShare.speedOf(NaN, true)], [null, null, null]);
});

// ---- the board hands it a match ---------------------------------------------------------
function board() {
    const els = {}, store = {};
    const el = id => els[id] || (els[id] = { id, style: {}, innerHTML: '', classList: { toggle() {} }, setAttribute() {} });
    ['benchLeft', 'benchMatrix', 'benchFull', 'benchBtn'].forEach(el);
    const context = vm.createContext({ console, Date, WarEval, WarShare, t, getUiLang: () => 'en', OpenAIAIManager: { MAX_COMMANDS_PER_TURN: 3 },
        localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; } },
        document: { getElementById: id => els[id] || null, addEventListener() {}, body: { style: { setProperty() {}, removeProperty() {} }, classList: { toggle() {}, contains: () => false } } } });
    for (const f of ['js/ui.js', 'js/eval/bench-view.js']) vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8') + '\nthis.UI = UIManager;', context);
    const u = Object.create(context.UI.prototype);
    u.escapeHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
    Object.assign(u, { teamDotHtml: () => '', renderTranscriptViewer() {}, updateSpectatorPlayerList() {} });
    const ledger = WarEval.createLedger();
    u.game = { spectatorMode: true, gameStarted: true, openAIAIManager: { transcripts: { ledger } } };
    return { u, els, ledger };
}
const decision = (id, sec, turn, o = {}) => JSON.stringify({ turn, playerId: id, name: 'Seat ' + id, seat: id === 'a' ? 0 : 1, latencyMs: o.latencyMs || 4000,
    tokens: o.tokens === undefined ? { prompt: 9000, completion: 1000 } : o.tokens,
    parsed: { commands: (o.orders || []).map(x => ({ action: x[0], params: x[1] || {} })) },
    outcomes: (o.orders || []).map((x, i) => ({ n: i + 1, action: x[0], code: 'c', verdict: x[2] || 'ok' })),
    state: { clock: { matchSeconds: sec }, population: { used: 20 }, threats: { underAttack: [], enemyWonders: [] } } });
function played() {
    const p = board(), { ledger } = p;
    ledger.addLine(JSON.stringify({ type: 'match', matchId: 'match-7', build: 1226, promptVersion: 'agents-rule-v113', mapSize: 800, schema: 'war-transcript/2', players: [
        { id: 'a', seat: 0, civ: 'roman', name: 'Seat a', settings: { provider: 'openai' } },
        { id: 'b', seat: 1, civ: 'maya', name: 'Seat b', settings: { provider: 'mcp', harness: 'hermes', harnessExternal: true } }] }));
    for (let n = 1; n <= 4; n++) ledger.addLine(decision('a', n * 60, n, { orders: [['move_units', { targetX: -350, targetZ: -350 }], ['build_structure', { buildingType: 'tower', targetX: 100, targetZ: 100 }, n === 4 ? 'avoidable' : 'ok'], ['train_unit', { unitType: 'militia' }]] }));
    for (let n = 1; n <= 2; n++) ledger.addLine(decision('b', n * 120, n, { latencyMs: 12, tokens: null, orders: [['move_units', { targetX: 399, targetZ: 0 }]] }));
    return p;
}

test('the ledger: where a seat sent its orders, without the refused ones and the ones that name no place', () => {
    const { ledger } = played();
    assert.equal(ledger.mapSize, 800);
    const a = ledger.orders('a');
    assert.deepEqual([a.length, a.filter(o => o.action === 'move_units').length, a.filter(o => o.action === 'build_structure').length], [7, 4, 3]);
    assert.deepEqual(plain(a[0]), { x: -350, z: -350, sec: 60, action: 'move_units' });
    assert.deepEqual([ledger.orders('b').length, ledger.orders('zz')], [2, null]);
});

test('the board: the match as a picture, against speed or tokens, with the order map and the way to save it', () => {
    const { u, els, ledger } = played();
    const speed = u.benchShareSpec(ledger, 'speed');
    assert.deepEqual([speed.title, speed.sub, speed.x, speed.y], ['Seat a · Seat b', 'match-7 · share.build{"n":1226} · 4:00 · agents-rule-v113', 'share.xSpeed', 'share.yIndex']);
    const idx = id => ledger.profile().seats.find(s => s.id === id).index.value;
    // Seat a: four seconds a decision. Seat b is a harness that ended its turns in 12 ms: no speed, so it is named under the plot.
    assert.deepEqual(plain(speed.points.map(p => [p.name, p.x, p.y, p.harness])), [['Seat a', 4, idx('a'), false], ['Seat b', null, idx('b'), true]]);
    assert.deepEqual([speed.legend.raw, speed.legend.harness, speed.foot[1]], ['bench.h.raw', 'bench.h.harness', 'share.foot{"scale":"v3"}']);
    assert.match(speed.foot[0], /^When Agents Rule · github\.com\//);
    // Against tokens: ten thousand a decision for seat a; seat b's harness reports none.
    assert.deepEqual(plain(u.benchShareSpec(ledger, 'tokens').points.map(p => p.x)), [10, null]);
    assert.equal(u.benchShareSpec(ledger, 'tokens').x, 'share.xTokens');
    // The order map: a seat a square; seat a's seven placed orders, four of them in one corner.
    assert.deepEqual(speed.heat.seats.map(s => [s.name, s.grid.placed, s.grid.most]), [['Seat a', 7, 4], ['Seat b', 2, 2]]);
    assert.equal(u.benchShareSpec(WarEval.createLedger()), null);
    // It sums a match up, so it stands on the results screen under the report card, with its buttons (build 1227:
    // "share is for the game summary, not the live comparison"). The board at full size does not carry it.
    u.toggleBenchFull(true);
    assert.doesNotMatch(els.benchFull.innerHTML, /bf-share|<svg xmlns/);
    u.toggleBenchFull(false);
    els.arenaSummaryScreen = { classList: { contains: c => c === 'active' }, style: {} };
    els.summaryProfile = { style: {}, innerHTML: '' };
    u.updateSummaryProfile();
    const html = els.summaryProfile.innerHTML;
    assert.match(html, /<p class="summary-profile-note">sum\.profileNote<\/p><div class="bf-share"><h4>share\.title<small>share\.tip<\/small><\/h4><div class="bs-bar"><button type="button" class="bs-btn is-on" onclick="game\.ui\.benchShareAxis\('speed'\)">share\.speed<\/button><button type="button" class="bs-btn" onclick="game\.ui\.benchShareAxis\('tokens'\)">share\.tokens<\/button><span><\/span><button type="button" class="bs-btn" onclick="game\.ui\.benchShareSave\('png'\)">share\.png<\/button><button type="button" class="bs-btn" onclick="game\.ui\.benchShareSave\('svg'\)">share\.svg<\/button><\/div><div class="bs-pic"><svg xmlns/);
    assert.match(html, /<\/svg><\/div><\/div>$/);
    assert.match(html, />share\.notShown Seat b<\/text>/);
    u.benchShareAxis('tokens');
    assert.match(els.summaryProfile.innerHTML, /class="bs-btn is-on" onclick="game\.ui\.benchShareAxis\('tokens'\)"/);
    assert.match(els.summaryProfile.innerHTML, />share\.xTokens<\/text>/);
    // Saved under the match's name and the axis; the SVG goes out as it is.
    const saved = [];
    u.shareSave = (svg, name, kind) => { saved.push([svg.slice(0, 4), name, kind]); return Promise.resolve(true); };
    return u.benchShareSave('svg').then(() => assert.deepEqual(saved, [['<svg', 'match-7-tokens', 'svg']]));
});

// ---- the Season page hands it a group ---------------------------------------------------
function season() {
    const store = {}, els = { seasonBody: { innerHTML: '' }, seasonScreen: { classList: { contains: () => true } } }, saved = [];
    const context = vm.createContext({ console, Date, WarSeason, WarEval, WarShare, WarConditions: loadConditions(), t,
        localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; } },
        document: { getElementById: id => els[id] || null, querySelector: () => ({ id: 'startScreen' }) }, fetch: async () => ({ ok: true, json: async () => ({ entries: [] }) }) });
    vm.runInContext(fs.readFileSync(path.join(root, 'js/season-page.js'), 'utf8') + '\nthis.Page = SeasonPage;', context);
    const ui = { escapeHtml: s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'), showScreen() {},
        shareSave: (svg, name, kind) => { saved.push([svg.slice(0, 4), name, kind]); return Promise.resolve(true); } };
    return { Page: context.Page, p: new context.Page(ui), els, saved };
}
let serial = 0;
const flat = v => ({ grounding: v, planning: v, follow: v, tactical: v, strategy: v, index: v });
const match = seats => ({ v: 1, scale: 'v3', matchId: 'm' + (++serial), at: 1795000000000 + serial * 60000, build: 1226, duration: '12:00', mapSeed: 's' + serial, layout: 'greek,persian', players: seats.length, source: 'played',
    seats: seats.map(([name, seat, rank, v, lat, via]) => ({ id: name + seat, seat, name, model: name + '-model', rank, of: seats.length, winner: rank === 1, via: via || 'raw',
        cond: 'cond-a', protocol: 'turn-based', core: 'core', scores: flat(v), latencyMs: lat })) });

test('the Season page: a group as a picture, the mean Index with its lowest and highest match, or the first places', () => {
    const { Page, p, els, saved } = season();
    for (const [a, b] of [[90, 30], [50, 40], [70, 20]]) Page.keep(match([['Alpha', 0, a > 50 ? 1 : 2, a, 4000], ['Beta', 1, a > 50 ? 2 : 1, b, 13, 'harness:pi']]));
    p.samples = [];
    const g = WarSeason.table(p.entries()).groups[0];
    assert.deepEqual(g.models.map(m => [m.name, m.latencyMs]), [['Alpha', 4000], ['Beta', 13]]);
    const spec = p.shareSpec(g, 'index');
    assert.deepEqual([spec.title, spec.sub, spec.y, spec.heat], ['share.seasonTitle', 'season.conditions cond-a · turn-based · share.matches{"n":3} · share.build{"n":"1226"}', 'share.yIndexMean', null]);
    // Alpha: four seconds, a mean of 70 between 50 and 90. Beta is a harness with a median of 13 ms: no speed.
    assert.deepEqual(plain(spec.points.map(q => [q.name, q.x, q.y, q.lo, q.hi, q.harness, q.note])), [
        ['Alpha', 4, 70, 50, 90, false, 'share.matches{"n":3}'], ['Beta', null, 30, 20, 40, true, 'share.matches{"n":3}']]);
    // By first places: two of three and one of three, and no whisker (a share has no lowest match).
    assert.deepEqual(plain(p.shareSpec(g, 'wins').points.map(q => [q.y, q.lo, q.note])), [[66.7, null, '2/3'], [33.3, null, '1/3']]);
    assert.equal(p.shareSpec(g, 'wins').y, 'share.yWins');
    // On the page it is folded away until asked for, and then carries its picture and its buttons.
    p.render();
    assert.match(els.seasonBody.innerHTML, /<details class="season-share" ontoggle="game\.ui\.seasonPage\(\)\.shareToggle\('cond-a\/v3', this\.open\)"><summary>share\.title<\/summary><\/details>/);
    p.shareToggle('cond-a/v3', true);
    assert.match(els.seasonBody.innerHTML, /<details class="season-share" open [^>]*><summary>share\.title<\/summary><div class="bs-bar"><button type="button" class="bs-btn is-on" onclick="game\.ui\.seasonPage\(\)\.setShareY\('index'\)">share\.byIndex<\/button>/);
    assert.match(els.seasonBody.innerHTML, /<div class="bs-pic"><svg xmlns.*class="whisker".*<\/svg><\/div><\/details>/s);
    p.setShareY('wins');
    assert.doesNotMatch(els.seasonBody.innerHTML, /class="whisker"/);
    // One match is "1 match", not "1 matches".
    const single = season();
    single.Page.keep(match([['Alpha', 0, 1, 90, 4000], ['Beta', 1, 2, 30, 5000]]));
    single.p.samples = [];
    const s1 = single.p.shareSpec(WarSeason.table(single.p.entries()).groups[0]);
    assert.deepEqual([s1.sub.includes('share.oneMatch'), s1.points[0].note, s1.points[0].lo], [true, 'share.oneMatch', null]);
    // One model has nothing to be compared with: no chart.
    const one = season();
    one.Page.keep(match([['Alpha', 0, 1, 90, 4000]])); one.Page.keep(match([['Alpha', 0, 1, 80, 4000]]));
    one.p.samples = []; one.p.render();
    assert.doesNotMatch(one.els.seasonBody.innerHTML, /season-share/);
    return p.shareSave('cond-a/v3', 'png').then(() => assert.deepEqual(saved, [['<svg', 'season-cond-a-wins', 'png']]));
});

test('every word of the pictures is keyed in all four languages, and the page loads the module', () => {
    const ctx = vm.createContext({ window: {}, navigator: { language: 'en' }, localStorage: { getItem: () => null, setItem() {} }, document: { documentElement: {}, querySelectorAll: () => [], addEventListener() {} } });
    vm.runInContext(fs.readFileSync(path.join(root, 'js/i18n.js'), 'utf8') + ';this.I = I18N;', ctx);
    const src = fs.readFileSync(path.join(root, 'js/eval/bench-view.js'), 'utf8') + fs.readFileSync(path.join(root, 'js/season-page.js'), 'utf8');
    const keys = new Set([...src.matchAll(/'(share\.[A-Za-z]+)'/g)].map(m => m[1]));
    assert.ok(keys.size >= 20, 'only ' + keys.size + ' keys found');
    for (const lang of ['en', 'de', 'es', 'zh']) for (const k of keys) assert.ok(k in ctx.I[lang], lang + ' lacks ' + k);
    const page = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    assert.match(page, /<script src="js\/eval\/share\.js\?v=\d+"><\/script>\s*<script src="js\/season-page\.js/);
    assert.ok(page.indexOf('js/eval/share.js') > page.indexOf('js/eval/bench-view.js') || page.indexOf('js/eval/share.js') > 0);
});
