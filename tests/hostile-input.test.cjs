// Text that comes from outside is shown, never run (b1281).
//
// A transcript is a file somebody else may have written, a model's reply is whatever the
// model sent, and a model list is whatever an endpoint answered. The page holds every API
// key of its user in its storage, so a string from any of those that the page turned into
// markup or code had the keys. Three ways it could:
//  - the one escape function left quotes alone, and stood guard in about sixty attribute
//    values ( title="...", data-key="..." );
//  - inline handlers were assembled around a value in quotes ( onclick="f('<id>')" ),
//    where escaping for HTML is undone by the HTML parser before the code runs;
//  - a few values were written into the page with no escaping at all.
// Each test runs the real render code on hostile input and then asks what a browser would
// make of the result: no tag and no attribute of the attacker's, and no handler that runs
// the attacker's code or was broken by it.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { tags, runHandlers } = require('./lib/html-handlers.cjs');

const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

// One payload for every context: it closes a double-quoted attribute and opens a tag of
// its own, closes a single-quoted string inside a handler and calls out, and names an
// attribute of its own.
const P = n => `"><zzqtag onerror="xssFired(${n})" src=x>');xssFired(${n});('" zzqattr="${n}`;
const NUM = n => `0);xssFired(${n});//`;

function assertInert(html, where) {
    const all = tags(html);
    const foreign = all.filter(el => el.tag.startsWith('zzq') || el.attrs.some(a => a.name.startsWith('zzq')));
    assert.deepEqual(foreign.map(el => '<' + el.tag + ' ' + el.attrs.map(a => a.name).join(' ') + '>').slice(0, 5), [], where + ': the input became markup');
    const { fired, broken } = runHandlers(html);
    assert.deepEqual(fired, [], where + ': a handler ran the input as code');
    assert.deepEqual(broken.slice(0, 5), [], where + ': the input broke a handler');
}

// The page's code in a bare context with an element for every id it asks for.
function page(files, extra = {}) {
    const els = {};
    const mkEl = id => ({ id, style: {}, dataset: {}, hidden: false, innerHTML: '', textContent: '', value: '',
        classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
        setAttribute() {}, getAttribute() { return null; }, querySelector() { return null; }, querySelectorAll() { return []; },
        addEventListener() {}, focus() {}, scrollIntoView() {}, appendChild() {}, firstChild: { style: {} } });
    const document = { getElementById: id => (id === 'gameCanvas' ? null : (els[id] = els[id] || mkEl(id))),
        querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, removeEventListener() {},
        documentElement: { style: { setProperty() {} } }, body: { dataset: {}, classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } } },
        activeElement: null, visibilityState: 'visible' };
    const scope = vm.createContext(Object.assign({ console, document, window: { addEventListener() {} },
        localStorage: { getItem: () => null, setItem() {} }, location: { search: '', href: 'http://localhost/' }, navigator: {},
        URL, fetch: () => Promise.reject(new Error('no net')) }, extra));
    for (const f of files) vm.runInContext(read(f), scope, { filename: f });
    return { scope, els, html: () => Object.entries(els).map(([id, e]) => [id, String(e.innerHTML || '')]).filter(([, h]) => h) };
}

test('the escape function makes a value safe in text and in a quoted attribute', () => {
    const { scope } = page(['js/i18n.js', 'js/ui.js']);
    const u = Object.create(vm.runInContext('UIManager', scope).prototype);
    assert.equal(u.escapeHtml(`<a href="x" title='y'>&`), '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;');
    assert.equal(u.escapeHtml(null), ''); assert.equal(u.escapeHtml(0), '0');
    for (const html of [`<p title="${u.escapeHtml(P(1))}">${u.escapeHtml(P(2))}</p>`, `<p data-x='${u.escapeHtml(P(3))}'></p>`])
        assertInert(html, 'escapeHtml');
});

test('jsArg makes a value one string argument of an inline handler', () => {
    const { scope } = page(['js/i18n.js', 'js/ui.js']);
    const u = Object.create(vm.runInContext('UIManager', scope).prototype);
    for (const v of [P(4), `it's "quoted" \\ and </script> \n new line`, 'plain', '', 42]) {
        const html = `<button onclick="heard(${u.jsArg(v)})">x</button>`;
        assertInert(html, 'jsArg');
        const code = tags(html)[0].attrs[0].value;
        let heard; vm.runInNewContext(code, { heard: x => { heard = x; } });
        assert.equal(heard, String(v), 'and the handler is handed exactly the value');
    }
});

test('a hostile transcript is shown by the analyzer and runs nothing', () => {
    const { scope, html } = page(['js/i18n.js', 'js/analyzer.js', 'js/ui.js']);
    const seat = 'p1' + P(10);
    const lines = [
        { type: 'match', build: P(11), mapSeed: P(12), difficulty: P(13), promptVersion: P(14), startedAt: 0,
          players: [{ id: seat, seat: 0, civ: 'greek' + P(15), model: 'm' + P(16), name: 'A' + P(17) }, { id: 'p2', seat: 1, civ: 'persian', model: 'm2', name: 'B' }] },
        { playerId: seat, turn: 1, at: 500, state: { clock: { matchSeconds: 0 } }, parsed: { action: P(18), params: { x: P(19) } }, harnessResult: P(20), assistant: { content: P(21), reasoning: P(22) } },
        { playerId: 'p2', turn: '7' + P(23), at: 1000, state: { clock: { matchSeconds: 1 } }, parsed: { action: 'wait', reason: P(24) }, harnessResult: 'ok', assistant: { content: 'hi' } },
        { playerId: 'p2', turn: 2, at: 9000, state: { clock: { matchSeconds: 9 } }, parsed: { commands: [{ action: 'wait' }], objective: P(25), plan: [P(26)] }, harnessResult: 'ok' },
        { type: 'chronicle', kind: 'wonder-countdown', seats: [seat], seconds: P(27), t: 3, weight: 3 },
        { type: 'chronicle', kind: 'wonder-raised', seats: ['p2'], building: P(28), required: P(29), t: 4, weight: 3 },
        { type: 'chronicle', kind: 'battle', seats: [seat, 'p2'], seconds: P(30), sides: { [seat]: { lost: P(31), involved: P(32) }, p2: { lost: 1, involved: 2 } }, t: 5, weight: 3 },
        { type: 'chronicle', kind: 'age', seats: ['p2'], age: 'bronze' + P(33), t: NUM(34) + P(35), weight: 3 },
        { type: 'chronicle', kind: P(36), seats: ['p2'], t: 6, weight: 3 },
    ];
    const u = Object.create(vm.runInContext('UIManager', scope).prototype);
    u.game = { renderer: null, spectatorMode: true };
    u.renderCameraControls = () => {};
    u.analyzer = new (vm.runInContext('TranscriptAnalyzer', scope))(u).load(lines.map(l => JSON.stringify(l)).join('\n'), 'hostile' + P(37) + '.jsonl');
    u.anRender();
    const written = html();
    assert.ok(written.length >= 4, 'the analyzer drew: ' + written.map(([id]) => id).join(', '));
    assert.ok(written.some(([, h]) => h.includes('zzqtag')), 'and the hostile text is in what it drew, as text');
    for (const [id, h] of written) assertInert(h, '#' + id);
    // Every decision in turn, as a reader stepping through would see them.
    for (let i = 0; i < u.analyzer.order.length; i++) { u.analyzer.seek(i); u.anRender(); for (const [id, h] of html()) assertInert(h, `#${id} at decision ${i}`); }
});

test('a hostile transcript kept for the Season page runs nothing there', () => {
    const WarEval = require('../js/eval/ledger.js'), WarSeason = require('../js/eval/season.js');
    const { loadConditions } = require('../tools/eval/season.cjs');
    const store = {}, els = { seasonBody: { innerHTML: '' } };
    const { scope } = page(['js/i18n.js', 'js/ui.js']);
    const u = Object.create(vm.runInContext('UIManager', scope).prototype);
    const ctx = vm.createContext({ console, Date, WarSeason, WarEval, WarConditions: loadConditions(), t: k => k,
        localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; } },
        document: { getElementById: id => els[id] || null, querySelector: () => ({ id: 'startScreen' }) } });
    vm.runInContext(read('js/season-page.js') + '\nthis.Page = SeasonPage;', ctx);
    const p = new ctx.Page({ escapeHtml: s => u.escapeHtml(s), jsArg: v => u.jsArg(v), showScreen() {} });
    const name = fs.readdirSync(path.join(ROOT, 'samples')).filter(f => f.endsWith('.jsonl')).sort().pop();
    const lines = read('samples/' + name).split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l));
    for (const o of lines) {
        if (o.type === 'results') (o.ranking || []).forEach((r, i) => { r.rank = P(40 + i); });
        if (o.type === 'match') { o.matchId = 'm' + P(50); (o.players || []).forEach((pl, i) => { if (pl.model !== 'ki') { pl.model = 'evil' + P(51 + i); pl.name = 'Name' + P(55 + i); } }); }
    }
    for (const id of ['first', 'second']) {      // twice, so the seats form a group and its table is drawn
        const text = lines.map(o => JSON.stringify(o.type === 'match' ? Object.assign({}, o, { matchId: id + P(60) }) : o)).join('\n');
        const entry = ctx.WarSeason.entryOf(text, { evaluator: WarEval, conditions: ctx.WarConditions, source: 'imported', file: 'x' + P(61) + '.jsonl' });
        assert.ok(entry && ctx.Page.keep(entry), 'the entry is kept');
    }
    p.samples = [];
    const html = p.html();
    assert.ok(html.includes('zzqtag'), 'the hostile text is on the page, as text');
    assertInert(html, 'season page');
});

// No inline handler is assembled around a value any more, except through jsArg or as a
// number. The values left here are the page's own: indices, ids it mints, fixed words.
// A new handler that puts anything else between its quotes has to be added to this list by
// somebody who looked at where the value comes from.
test('inline handlers take values only through jsArg, as numbers, or from the page itself', () => {
    const OWN = new Set(['m.id', 'i', 'idx', 'k', 'key', 'v', 'action', 'group', 'call', 'clickHandler', '_setF', 'ai.seat', 'tk.idx', 'id', 'cls',
        "opt.stop ? 'event.stopPropagation(); ' : ''", "canAfford ? action : ''"]);
    const files = [];
    (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (e.name.endsWith('.js')) files.push(f); } })(path.join(ROOT, 'js'));
    const attr = /\bon[a-z]+=(\\?")/g;   // every event attribute, whatever the event
    const odd = [];
    for (const f of files) fs.readFileSync(f, 'utf8').split(/\r?\n/).forEach((line, n) => {
        let m; attr.lastIndex = 0;
        while ((m = attr.exec(line))) {
            const rest = line.slice(m.index + m[0].length), end = rest.search(/\\?"/), code = end < 0 ? rest : rest.slice(0, end);
            const where = path.relative(ROOT, f).split(path.sep).join('/') + ':' + (n + 1);
            // template interpolations
            for (const x of code.matchAll(/\$\{([^}]*)\}/g)) {
                const e = x[1].trim();
                if (/^(this\.|this\.ui\.|u\.|ui\.)?jsArg\(/.test(e) || /^Number\(/.test(e) || OWN.has(e)) continue;
                odd.push(where + '  ${' + e + '}');
            }
            // a string closed and a value added: ' + value + '
            for (const x of code.matchAll(/'\s*\+\s*([^+]+?)\s*\+\s*\\?'/g)) {
                const e = x[1].trim();
                if (/^(this\.|u\.)?jsArg\(/.test(e) || /^Number\(/.test(e) || OWN.has(e) || e === 'next' || e === 'kv[0]') continue;
                odd.push(where + "  ' + " + e + " + '");
            }
        }
    });
    assert.deepEqual(odd, [], 'handlers built around a value that is not known to be the page\'s own');
});

// The comparison board is drawn from the ledger, and in the analyzer the ledger is read
// from the file: seat ids and names, action names, outcome codes and turn numbers are all
// the file's.
test('a hostile match on the comparison board runs nothing', () => {
    const WarEval = require('../js/eval/ledger.js');
    const els = {}, store = {}, body = new Set();
    const el = id => els[id] || (els[id] = { id, style: {}, innerHTML: '', classList: { toggle() {} }, setAttribute() {} });
    ['benchMatrix', 'benchFull', 'benchBtn'].forEach(el);
    const context = vm.createContext({ console, Date, WarEval, getUiLang: () => 'en', OpenAIAIManager: { MAX_COMMANDS_PER_TURN: 3 },
        window: {}, navigator: { language: 'en' },
        localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; } },
        document: { getElementById: id => els[id] || null, addEventListener() {}, querySelectorAll: () => [], documentElement: {},
            createElement: () => { const e = { style: {}, innerHTML: '', setAttribute() {}, classList: { add() {}, remove() {}, contains: () => false }, remove() { delete els[e.id]; } }; return e; },
            body: { appendChild: e => { els[e.id] = e; }, style: { setProperty() {}, removeProperty() {} },
                classList: { toggle: (c, on) => { if (on) body.add(c); else body.delete(c); }, contains: c => body.has(c) } } } });
    for (const f of ['js/i18n.js', 'js/ui.js', 'js/eval/bench-view.js']) vm.runInContext(read(f), context, { filename: f });
    const u = Object.create(vm.runInContext('UIManager', context).prototype);
    Object.assign(u, { teamDotHtml: () => '', renderTranscriptViewer() {}, updateSpectatorPlayerList() {}, tvJumpTo() {} });
    const ledger = WarEval.createLedger();
    u.game = { spectatorMode: true, gameStarted: true, openAIAIManager: { transcripts: { ledger } } };
    const seats = ['a' + P(70), 'b' + P(71)];
    ledger.addLine(JSON.stringify({ type: 'match', build: P(72), players: seats.map((id, i) => ({ id, seat: i, civ: 'greek' + P(73), model: 'm' + P(74), name: 'Seat' + P(75) })) }));
    for (let n = 1; n <= 24; n++) for (const [i, id] of seats.entries()) ledger.addLine(JSON.stringify({ turn: n % 5 ? n : n + P(76), playerId: id, name: 'Seat' + P(77), seat: i, latencyMs: 4000,
        tokens: { prompt: 9000, completion: 300 },
        parsed: { commands: [{ action: 'train_unit' + P(78), params: { unitType: P(79) } }, { action: 'wait', params: {} }], objective: P(80), plan: [P(81), 'hold'] },
        outcomes: [{ n: 1, action: 'train_unit' + P(82), code: 'cannotAfford' + P(83), verdict: n % 2 ? 'avoidable' : 'ok' }, { n: 2, action: 'wait', code: null, verdict: 'ok' }],
        state: { clock: { matchSeconds: n * 30 }, population: { used: 20, capacityNow: 25 }, resources: { food: 100, wood: 100, stone: 0, gold: 0 },
            threats: { underAttack: n % 3 ? [] : [{ kind: 'building', type: 'barracks' + P(84), x: 100, z: 100, attackerAt: { x: 108, z: 102, owner: seats[1 - i] } }], enemyWonders: [] },
            units: { trainable: { barracks: { stone: [{ id: 'militia' }] } } }, buildings: { buildable: [{ type: 'tower' }] },
            friendlyBuildings: [{ type: 'barracks', x: 100, z: 100 }], gameStats: { opponents: [{ id: seats[1 - i], civilization: 'maya' + P(85) }] } } }));
    const drawn = [];
    const part = (label, html) => { if (html && typeof html === 'object') Object.entries(html).forEach(([k, v]) => part(label + '.' + k, v)); else if (typeof html === 'string' && html) drawn.push([label, html]); };
    part('benchHtml', u.benchHtml(ledger));
    part('benchMiniHtml', u.benchMiniHtml(ledger));
    u.toggleBenchFull(true);
    part('benchFull', els.benchFull.innerHTML); part('benchMatrix', els.benchMatrix.innerHTML);
    assert.ok(drawn.length >= 2 && drawn.some(([, h]) => h.includes('zzqtag')), 'the board drew the hostile text: ' + drawn.map(([l, h]) => l + ' ' + h.length).join(', '));
    for (const [label, h] of drawn) assertInert(h, label);
});

// The model list is whatever the endpoint answered, and the endpoint may be anybody's.
test('a hostile model list in the dropdown runs nothing', () => {
    const { scope, els } = page(['js/i18n.js', 'js/ui.js']);
    const u = Object.create(vm.runInContext('UIManager', scope).prototype);
    u._mdlSel = 0;
    u.mdlPaint(3, ['vendor/' + P(90), P(91), 'plain-model']);
    const html = els['mdlPop-3'].innerHTML;
    assert.ok(html.includes('zzqtag') && html.includes('plain-model'));
    assertInert(html, 'model dropdown');
    const picked = tags(html).filter(el => el.attrs.some(a => a.name === 'data-v')).map(el => el.attrs.find(a => a.name === 'data-v').value);
    assert.deepEqual(picked, ['vendor/' + P(90), P(91), 'plain-model'], 'and picking a row hands back exactly the name');
});
