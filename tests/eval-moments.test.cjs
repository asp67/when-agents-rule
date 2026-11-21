// Moments (overhaul step B2): js/eval/moments.js picks the heaviest events of a match and
// the decision behind each; js/moments-view.js draws the reel on the results screen.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const WarEval = require(path.join(root, 'js/eval/ledger.js'));
const WarMoments = require(path.join(root, 'js/eval/moments.js'));
const HAS_SAMPLES = fs.existsSync(path.join(root, 'samples', 'index.json'));

const battle = (t, lostA, lostB, o = {}) => Object.assign({ type: 'chronicle', kind: 'battle', t, seconds: 10, x: 100, z: 100, weight: 2, seats: ['a', 'b'],
    sides: { a: { involved: 6, lost: lostA }, b: { involved: 6, lost: lostB } } }, o);
const ev = (kind, t, o = {}) => Object.assign({ type: 'chronicle', kind, t, weight: 3, seats: ['a'] }, o);
// A seat's decisions for the ledger: [seconds, action, params, verdict].
const turns = (id, list) => list.map(([sec, action, params, verdict], i) => JSON.stringify({ turn: i + 1, playerId: id, state: { clock: { matchSeconds: sec } },
    parsed: { commands: [{ action, params: params || {} }] }, outcomes: [{ n: 1, action, code: 'c', verdict: verdict || 'ok' }] }));
const seatsOf = lines => { const l = WarEval.createLedger(); lines.forEach(x => l.addLine(x)); return l.seats; };
const kinds = list => list.map(m => m.kind + '@' + m.start);

test('the heaviest moments are picked by what happened, kept apart in time, and told in order', () => {
    // A fight weighs by what fell in it; a skirmish nobody fell in, a contact and a clash are not moments.
    assert.deepEqual([battle(0, 1, 2), battle(0, 10, 20), battle(0, 0, 0), ev('contact', 0), ev('clash', 0), ev('wonder-countdown', 0)].map(WarMoments.weightOf), [19, 100, 0, 0, 0, 0]);
    assert.deepEqual(['elimination', 'wonder-lost', 'town-center-lost', 'wonder-raised', 'building-lost', 'age'].map(k => WarMoments.weightOf(ev(k, 0))), [90, 80, 60, 55, 12, 10]);
    // A battle is reported at its end: it began its length earlier.
    assert.deepEqual([WarMoments.startOf(battle(300, 1, 1, { seconds: 40 })), WarMoments.startOf(ev('age', 300)), WarMoments.lostIn(battle(0, 3, 4))], [260, 300, 7]);
    const events = [ev('age', 100), battle(510, 2, 9), battle(520, 0, 1), ev('town-center-lost', 900), battle(1210, 9, 9), battle(1510, 8, 8), battle(1810, 7, 7), battle(2110, 6, 6),
        ev('elimination', 2500), ev('building-lost', 2600), { type: 'chronicle', kind: 'clash', t: 50 }];
    // Five of them: three fights at most, the heaviest; the fight ten seconds after another is the same moment.
    assert.deepEqual(kinds(WarMoments.pick(events, 5)), ['town-center-lost@900', 'battle@1200', 'battle@1500', 'battle@1800', 'elimination@2500']);
    assert.deepEqual(kinds(WarMoments.pick(events, 2)), ['battle@1200', 'elimination@2500']);
    assert.deepEqual(WarMoments.pick([], 5), []);
    assert.deepEqual(kinds(WarMoments.pick([battle(510, 2, 9), battle(525, 5, 9)], 5)), ['battle@515']);       // the heavier of two that overlap
});

test('the decision behind a fight is the last order that worked and pointed there before the first blow', () => {
    const fight = WarMoments.pick([battle(610, 4, 6)], 1)[0];                          // began at 600
    const cause = lines => { const c = WarMoments.causeOf(fight, seatsOf(lines)); return c && [c.id, c.turn, c.sec, c.action]; };
    // b attacked there 40 s before, a marched there 90 s before: b's order is the one.
    assert.deepEqual(cause(turns('a', [[510, 'move_units', { targetX: 110, targetZ: 95 }]]).concat(turns('b', [[400, 'train_unit'], [560, 'attack_target', { targetX: 100, targetZ: 100 }]]))), ['b', 2, 560, 'attack_target']);
    // An order that was refused, one that pointed elsewhere, a scouting move, one given after the fight began, one long before: none of these.
    assert.equal(cause(turns('b', [[560, 'attack_target', { targetX: 100, targetZ: 100 }, 'avoidable']])), null);
    assert.equal(cause(turns('b', [[560, 'attack_target', { targetX: 400, targetZ: 400 }]])), null);
    assert.equal(cause(turns('b', [[560, 'move_units', { targetX: 100, targetZ: 100, mode: 'scout' }]])), null);
    assert.equal(cause(turns('b', [[605, 'attack_target', { targetX: 100, targetZ: 100 }]])), null);
    assert.equal(cause(turns('b', [[300, 'attack_target', { targetX: 100, targetZ: 100 }]])), null);
    // An attack that named no place (the whole army, by target id) still counts: it is the seat's order to fight.
    assert.deepEqual(cause(turns('b', [[590, 'attack_target', {}]])), ['b', 1, 590, 'attack_target']);
    // A seat that was not in the fight did not cause it.
    assert.equal(cause(turns('c', [[590, 'attack_target', { targetX: 100, targetZ: 100 }]])), null);
});

test('a fallen building, a seat put out, an age and a Wonder each have their own order behind them', () => {
    const seats = seatsOf(turns('a', [[100, 'upgrade_age'], [700, 'attack_target', { targetX: 50, targetZ: 60 }], [1500, 'build_structure', { buildingType: 'wonder' }]])
        .concat(turns('b', [[100, 'train_unit']])));
    const of = (e, events) => { const m = WarMoments.pick([e], 1)[0], c = WarMoments.causeOf(m, seats, events || [e]); return c && [c.id, c.turn, c.action, c.name]; };
    const fall = ev('town-center-lost', 800, { seats: ['b', 'a'], by: 'a', x: 50, z: 60, building: 'town_center' });
    assert.deepEqual(of(fall), ['a', 2, 'attack_target', null]);
    assert.deepEqual(of(ev('age', 160, { seats: ['a'], age: 'neolithic' })), ['a', 1, 'upgrade_age', null]);
    assert.deepEqual(of(ev('wonder-raised', 2000, { seats: ['a'], building: 'akropolis' })), ['a', 3, 'build_structure', 'wonder']);
    // A seat is put out by whoever took its last building just before; with no such record, nobody is named.
    assert.deepEqual(of(ev('elimination', 830, { seats: ['b'] }), [fall]), ['a', 2, 'attack_target', null]);
    assert.equal(of(ev('elimination', 830, { seats: ['b'] }), []), null);
    assert.equal(of(ev('town-center-lost', 800, { seats: ['b'], x: 50, z: 60 })), null);          // nobody is recorded as having taken it
});

test('the 5 October match in five moments, each with the decision the transcript holds', { skip: !HAS_SAMPLES }, () => {
    const text = read('samples/2026-10-05_gpt6.1-sol-claude-sonnet5.5-deepseek-v4.1-glm5.3_99min.jsonl');
    const ledger = WarEval.createLedger(), events = [];
    for (const l of text.split('\n')) { ledger.addLine(l); if (l.startsWith('{"type":"chronicle"')) events.push(JSON.parse(l)); }
    const name = id => { const s = ledger.seats.get(id); return s.name || s.model; };
    const got = WarMoments.pick(events, 5).map(m => { const c = WarMoments.causeOf(m, ledger.seats, events); return [m.start, m.kind, m.weight, c ? name(c.id) + ' #' + c.turn + ' ' + c.action : null]; });
    assert.deepEqual(got, [
        [2090, 'battle', 100, 'O deepseek-v4.1-flash #54 attack_target'],
        [2150, 'town-center-lost', 60, 'O deepseek-v4.1-flash #54 attack_target'],
        [2787, 'battle', 100, 'O deepseek-v4.1-flash #63 attack_target'],
        [3158, 'battle', 100, 'O deepseek-v4.1-flash #70 attack_target'],
        [3922, 'elimination', 90, null]]);
});

// ---- the page ---------------------------------------------------------------------
function page() {
    const els = {}, store = {}, cls = new Set();
    els.arenaSummaryScreen = { classList: { contains: c => cls.has(c) } };
    els.summaryReel = { style: {}, innerHTML: '' };
    const context = vm.createContext({ console, Date, Math, WarEval, WarMoments,
        t: (k, v) => k + (v ? JSON.stringify(v) : ''), tg: s => s, OpenAIAIManager: { MAX_COMMANDS_PER_TURN: 3 },
        localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; } },
        document: { getElementById: id => els[id] || null, body: { classList: { contains: () => false } } } });
    for (const f of ['js/ui.js', 'js/moments-view.js']) vm.runInContext(read(f) + '\nthis.UI = UIManager;', context);
    const u = Object.create(context.UI.prototype);
    u.escapeHtml = s => String(s); u.chronicleText = e => 'text:' + e.kind;
    return { u, els, cls };
}

test('the results screen lists the moments with the decision behind each, and opens one in the analyzer', async () => {
    const { u, els, cls } = page();
    const ledger = WarEval.createLedger();
    turns('b', [[560, 'attack_target', { targetX: 100, targetZ: 100 }]]).forEach(l => ledger.addLine(JSON.stringify(Object.assign(JSON.parse(l), { name: 'Model B' }))));
    u.evalLedger = () => ledger;
    u.chronicle = { entries: [battle(610, 4, 6), ev('age', 100, { seats: ['a'] })] };
    let held = true;
    u.summaryCanOpen = () => held;
    cls.add('active');
    u.updateSummaryReel();
    const html = els.summaryReel.innerHTML;
    assert.equal(els.summaryReel.style.display, '');
    assert.match(html, /^<div class="bench-head">reel\.title<span>reel\.sub<\/span><\/div><ol class="reel-list">/);
    assert.match(html, /<li><span class="reel-time">1:40<\/span><span class="reel-what">text:age<\/span><span class="reel-why is-none">reel\.noCause<\/span><button class="test-btn" onclick="game\.ui\.watchMoment\(0\)"/);
    assert.match(html, /<span class="reel-time">10:00<\/span><span class="reel-what">text:battle<\/span><span class="reel-why">reel\.cause\{"who":"Model B","turn":1,"time":"9:20","order":"attack target"\}<\/span><button class="test-btn" onclick="game\.ui\.watchMoment\(1\)"/);
    // Watching leaves for the analyzer five seconds before the moment; a match with inputs plays it again from that step.
    const calls = [];
    u.watchInAnalyzer = async () => { calls.push('analyzer'); };
    u.anApplyMoment = m => calls.push('moment ' + m.t);
    u.anResimStepAtSec = sec => sec * 40;
    u.anResimStart = step => calls.push('playback ' + step);
    let can = null;                                                                  // the analyzer's own check: null, the rules running here
    u.anResimCheck = async () => can;
    u.analyzer = { header: {}, inputs: [{ step: 1 }] };
    await u.watchMoment(1);
    assert.deepEqual(calls, ['analyzer', 'moment 595', 'playback 23800']);
    can = 'rulesChanged';                                                            // it cannot be played again: the decisions at that time, no playback
    calls.length = 0;
    await u.watchMoment(1);
    assert.deepEqual(calls, ['analyzer', 'moment 595']);
    can = null;
    u.analyzer = { header: {}, inputs: [] };                                          // recorded before inputs were: the same
    calls.length = 0;
    await u.watchMoment(1);
    assert.deepEqual(calls, ['analyzer', 'moment 595']);
    // Once the transcript is gone there is nothing to watch, and no button offers it; mid-match there is no reel.
    held = false;
    u.updateSummaryReel();
    assert.doesNotMatch(els.summaryReel.innerHTML, /watchMoment/);
    calls.length = 0;
    await u.watchMoment(1);
    assert.deepEqual(calls, []);
    cls.add('snapshot');
    u.updateSummaryReel();
    assert.deepEqual([els.summaryReel.style.display, els.summaryReel.innerHTML], ['none', '']);
});

test('the reel is wired and keyed in four languages; nothing of the corner replay is left', () => {
    const ui = read('js/ui.js'), html = read('index.html'), view = read('js/moments-view.js');
    assert.match(ui, /if \(this\.updateSummaryReel\) this\.updateSummaryReel\(\);/);
    assert.ok(html.indexOf('id="summaryReel"') > html.indexOf('id="summaryProfile"') && html.indexOf('id="summaryReel"') < html.indexOf('id="summaryGrid"'));
    // The top-down corner replay of build 1168 was taken out in build 1172: no button, no key,
    // no tape, no string. A real one needs a second renderer.
    const left = /replayBtn|toggleReplays|replaysOn|tapeFights|replayBattle|drawReplay|broadcastReplay|replay-corner|saved\.replays|key === 'p'|"spec\.replay|"replay\./;
    for (const f of ['js/ui.js', 'js/moments-view.js', 'js/eval/bench-view.js', 'js/i18n.js', 'css/styles.css', 'index.html']) assert.doesNotMatch(read(f), left, f);
    const context = vm.createContext({ window: {}, navigator: { language: 'en' }, localStorage: { getItem: () => null, setItem() {} },
        document: { documentElement: {}, querySelectorAll: () => [], addEventListener() {} } });
    vm.runInContext(read('js/i18n.js') + ';this.I = I18N;', context);
    const keys = [...view.matchAll(/t\('([a-z]+\.[A-Za-z0-9.]+)'/g)].map(m => m[1]);
    assert.ok(keys.length >= 6);
    for (const lang of ['en', 'de', 'es', 'zh']) for (const k of keys) assert.ok(k in context.I[lang], lang + ' lacks ' + k);
});
