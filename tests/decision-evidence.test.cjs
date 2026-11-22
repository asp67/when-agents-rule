'use strict';
// Build 1215, the open halves of overhaul steps D6 and D1.
//   D6: a decision card says which step of the plan its order carried out and whether it
//       answered a threat, and both filter the feed like the other tags.
//   D1: the seat card shows the standing plan as a line of segments, and the cards can be
//       ordered by the Index instead of by power.
// Both read what the ledger already found. No score reads the new lists.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const WarEval = require(path.join(root, 'js/eval/ledger.js'));
const plain = v => JSON.parse(JSON.stringify(v));

// One decision of seat a: a plan, orders as [action, params, verdict], and what its state showed under attack.
const decision = (n, o = {}) => JSON.stringify({ turn: n, playerId: 'a', name: 'Seat a', seat: 0,
    parsed: Object.assign({ commands: (o.orders || []).map(x => ({ action: x[0], params: x[1] || {} })) }, o.plan ? { plan: o.plan } : null),
    outcomes: (o.orders || []).map((x, i) => ({ n: i + 1, action: x[0], code: 'c', verdict: x[2] || 'ok' })),
    state: { clock: { matchSeconds: n * 30 }, population: { used: 20 }, threats: { underAttack: o.attack || [], enemyWonders: [] },
        units: { trainable: { barracks: { stone: [{ id: 'militia' }] } } }, buildings: { buildable: [{ type: 'tower' }, { type: 'barracks' }] },
        friendlyBuildings: [{ type: 'barracks', x: 100, z: 100 }], gameStats: { opponents: [{ id: 'maya-2', civilization: 'maya' }] } } });
const raid = [{ kind: 'building', type: 'barracks', x: 100, z: 100, attackerAt: { x: 108, z: 102, owner: 'maya-2' } }];
const militia = ['train_unit', { unitType: 'militia' }], tower = ['build_structure', { buildingType: 'tower', targetX: 124, targetZ: 82 }];
function match() {
    const l = WarEval.createLedger();
    [decision(1, { plan: ['Build a tower by the gate', 'Train militia'], orders: [['assign_workers']] }),
     decision(2, { orders: [militia, militia] }),
     decision(3, { orders: [['assign_workers'], tower] }),
     decision(4, { attack: raid, orders: [['assign_workers'], ['attack_target', { targetX: 105, targetZ: 100 }]] }),
     decision(5, { orders: [['train_unit', { unitType: 'militia' }, 'avoidable'], militia] })].forEach(x => l.addLine(x));
    return l;
}

test('the ledger lists every order that carried out a step of the standing plan, and which of its turn it was', () => {
    const f = match().profile().seats[0].follow;
    assert.deepEqual(plain(f.serving), [
        { decision: 2, turn: 2, n: 1, k: 1, action: 'train_unit', step: 2, of: 2 },
        { decision: 2, turn: 2, n: 2, k: 2, action: 'train_unit', step: 2, of: 2 },      // a second one serves the step as well
        { decision: 3, turn: 3, n: 2, k: 1, action: 'build_structure', step: 1, of: 2 }, // the turn's second order, its first build
        { decision: 5, turn: 5, n: 2, k: 2, action: 'train_unit', step: 2, of: 2 }]);    // the refused one before it carried nothing out
    assert.equal(f.ordersServing, f.serving.length, 'the list is the count, one by one');
    // The answer to the raid says the same about itself.
    const answer = match().profile().seats[0].tactical.list[0].answer;
    assert.deepEqual([answer.decision, answer.n, answer.k, answer.action], [4, 2, 1, 'attack_target']);
    // Evidence for the page: an exported profile carries the numbers and not the list, and is otherwise as it was.
    const out = WarEval.publicProfile(match().profile()).seats[0];
    assert.equal(out.follow.serving, undefined); assert.equal(out.follow.ordersServing, 4);
    assert.match(fs.readFileSync(path.join(root, 'js/eval/ledger.js'), 'utf8'), /follow: \['standing', 'done', 'serving'\]/);
});

function harness() {
    const scope = { console, getCivilization: () => ({ name: 'Civ', color: 0 }) };
    vm.createContext(scope);
    vm.runInContext(fs.readFileSync(path.join(root, 'js/openai-ai.js'), 'utf8'), scope);
    return vm.runInContext('OpenAIAIManager', scope);
}
const Manager = harness();
function ui(extra) {
    const context = vm.createContext(Object.assign({ console, Date, WarEval, t: (k, v) => k + (v ? JSON.stringify(v) : ''), OpenAIAIManager: Manager,
        document: { getElementById: () => null }, getUiLang: () => 'en' }, extra));
    vm.runInContext(fs.readFileSync(path.join(root, 'js/ui.js'), 'utf8') + '\nthis.UI = UIManager;', context);
    const u = Object.create(context.UI.prototype);
    u.escapeHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
    return u;
}
const card = (move, action, ok = true, extra) => Object.assign({ playerId: 'a', move, action, params: {}, result: ok ? 'OK - done' : '[ERROR] Cannot afford militia',
    outcomeCode: ok ? 'log.out.done' : 'log.out.cannotAfford', failed: !ok }, extra);
const kinds = tags => Array.from(tags, x => x.kind + ':' + x.label).join(' ');

test('a decision card says which plan step its order carried out and that it answered a threat', () => {
    const u = ui();
    u.game = { openAIAIManager: { transcripts: { ledger: match() } } };
    // Newest first, as the log is kept; with a plan card, advice and a note of the harness in between.
    const log = [
        card(5, 'train_unit'), card(5, 'train_unit', false),
        card(4, 'attack_target'), card(4, 'assign_workers'),
        { playerId: 'a', isAdvice: true, reason: 'hold the gate', result: 'x' },
        card(3, 'build_structure'), card(3, 'assign_workers'),
        card(2, 'train_unit'), card(2, 'train_unit'), card(2, 'lane_answer_dropped', true, { isControl: true }),
        { playerId: 'a', move: 1, action: 'plan_only', params: {} }, card(1, 'assign_workers')];
    const tags = e => kinds(u.logTags(e, u.logMistakeIndex(log), u.logEvidenceIndex(log)));
    assert.deepEqual(log.map(tags), [
        'serves:log.tagServes{"n":2}',                   // the second militia order of decision 5 worked
        'mistake:cannotAfford',                          // the first was refused: a mistake, and no step carried out
        'answers:log.tagAnswers',                        // aimed at the raid
        '',                                              // sending workers answers nothing and is no step
        '',
        'serves:log.tagServes{"n":1}',                   // the tower
        '',
        'serves:log.tagServes{"n":2}', 'serves:log.tagServes{"n":2}',
        '',                                              // the harness's own note is not an order
        'plan:log.tagPlan', '']);
    // What the tag says when hovered: the step of how many, and how soon the answer came.
    const tip = e => Array.from(u.logTags(e, u.logMistakeIndex(log), u.logEvidenceIndex(log)), x => x.tip).join(' ');
    assert.equal(tip(log[5]), 'log.tagServesTip{"n":1,"of":2}');
    assert.equal(tip(log[2]), 'log.tagAnswersTip{"n":1}');
    // Without a ledger (a rule-based match, the script not loaded) the cards are tagged as before.
    u.game = { openAIAIManager: { transcripts: { ledger: null } } };
    assert.equal(u.logEvidenceIndex(log).size, 0);
    assert.equal(kinds(u.logTags(log[1], u.logMistakeIndex(log), u.logEvidenceIndex(log))), 'mistake:cannotAfford');
    assert.equal(kinds(u.logTags(log[1], u.logMistakeIndex(log))), 'mistake:cannotAfford', 'and a caller that passes no evidence gets the old tags');
});

test('the two new tags filter the feed like the others', () => {
    const els = {}, el = id => els[id] || (els[id] = { id, _html: '', get innerHTML() { return this._html; }, set innerHTML(v) { this._html = v; },
        classList: { contains: () => false, toggle() {} }, children: [], scrollTop: 0, textContent: '', querySelector: () => null });
    ['aiLogEntries', 'aiLogCount', 'aiLogTags'].forEach(el);
    const u = ui({ document: { getElementById: id => els[id] || null }, tg: s => s, hasI18n: () => false });
    const c = (move, action, ok, ts) => card(move, action, ok, { civName: 'Greeks', color: '#fff', timestamp: ts });
    u.game = { openAIAIManager: { decisionLogRevision: 1, transcripts: { ledger: match() }, decisionLog: [
        c(4, 'attack_target', true, 6), c(4, 'assign_workers', true, 5), c(3, 'build_structure', true, 4), c(3, 'assign_workers', true, 3),
        c(2, 'train_unit', true, 2), c(2, 'train_unit', true, 1)] }, aiManager: { aiPlayers: [] } };
    Object.assign(u, { renderLogPlayerChips() {}, logActionNames: () => ({}), logDetail: () => '', teamDotHtml: () => '',
        legibleColor: x => x, logEntryLinkable: () => false, updateDecisionLogTopBtn() {} });
    const cards = () => (els.aiLogEntries.innerHTML.match(/class="ai-log-entry/g) || []).length;
    u.updateDecisionLog();
    assert.equal(cards(), 6);
    assert.match(els.aiLogTags.innerHTML, /log\.chipPlan.*log\.chipServes.*log\.chipAnswers/s);
    assert.match(els.aiLogEntries.innerHTML, /<span class="log-tag is-serves" title="log\.tagServesTip\{&quot;n&quot;:1,&quot;of&quot;:2\}">log\.tagServes\{&quot;n&quot;:1\}<\/span>/);
    assert.match(els.aiLogEntries.innerHTML, /<span class="log-tag is-answers" title="log\.tagAnswersTip\{&quot;n&quot;:1\}">log\.tagAnswers<\/span>/);
    u.setLogTagFilter('serves');
    assert.deepEqual([cards(), els.aiLogCount.textContent], [3, '(3/6)']);
    u.setLogTagFilter('answers');                        // both on: either
    assert.equal(cards(), 4);
    u.setLogTagFilter('serves');
    assert.equal(cards(), 1);
    u.setLogTagFilter('answers');
    assert.equal(cards(), 6);
});

test('the seat card shows the standing plan as a line of segments, a step each, with the count', () => {
    const u = ui();
    const p = match().profile().seats[0];
    const html = u.planProgressHtml(p);
    assert.equal((html.match(/class="lb-plan-seg/g) || []).length, 2, 'two steps, two segments');
    assert.equal((html.match(/lb-plan-seg is-acted/g) || []).length, 2);
    assert.match(html, /<b>2\/2<\/b><\/div>$/);
    assert.match(html, /title="eval\.planStepTip\{&quot;n&quot;:1,&quot;text&quot;:&quot;Build a tower by the gate&quot;,&quot;state&quot;:&quot;eval\.planState\.acted&quot;,&quot;met&quot;:1,&quot;of&quot;:1\}"/);
    // A plan under way: one step carried out, one open, one that names nothing checkable.
    const l = WarEval.createLedger();
    l.addLine(decision(1, { plan: ['Build a tower by the gate', 'Train militia', 'Stay flexible'], orders: [tower] }));
    const q = l.profile().seats[0], line = u.planProgressHtml(q);
    assert.deepEqual((line.match(/lb-plan-seg is-\w+/g) || []).map(s => s.split('is-')[1]), ['acted', 'pending', 'uncheckable']);
    assert.match(line, /<b>1\/2<\/b>/, 'counted over the steps that can be checked');
    // It sits under the bars, and nowhere when there is no plan.
    assert.ok(u.seatProfileHtml(q).endsWith(line));
    const none = WarEval.createLedger(); none.addLine(decision(1, { orders: [['assign_workers']] }));
    assert.equal(u.planProgressHtml(none.profile().seats[0]), '');
    assert.equal(u.planProgressHtml(null), '');
});

test('the seat cards can be ordered by the Index, and the choice is kept', () => {
    const saved = {}, els = { lbSort: { style: {}, innerHTML: '' } };
    const u = ui({ localStorage: { getItem: k => saved[k] || null, setItem: (k, v) => { saved[k] = v; } }, document: { getElementById: id => els[id] || null } });
    let drawn = 0; u.updateSpectatorPlayerList = () => { drawn++; };
    assert.equal(u.lbSort(), 'power', 'by power, as always, until asked');
    u.renderLbSort(true);
    assert.match(els.lbSort.innerHTML, /lb-sort-btn is-on" aria-pressed="true"[^>]*setLbSort\('power'\)[^>]*>spec\.sortPower<.*setLbSort\('index'\)[^>]*>spec\.sortIndex</s);
    assert.match(els.lbSort.innerHTML, /event\.stopPropagation\(\)/, 'a press on it does not fold the list');
    u.setLbSort('index');
    assert.deepEqual([u.lbSort(), drawn, JSON.parse(saved.warViewPreferencesV1).lbSort], ['index', 1, 'index']);
    u.renderLbSort(true);
    assert.match(els.lbSort.innerHTML, /lb-sort-btn is-on" aria-pressed="true"[^>]*setLbSort\('index'\)/);
    // Drawn again only when something changed; hidden where no seat has an Index.
    const before = els.lbSort.innerHTML; els.lbSort.innerHTML = 'kept'; u.renderLbSort(true); assert.equal(els.lbSort.innerHTML, 'kept'); els.lbSort.innerHTML = before;
    u.renderLbSort(false); assert.equal(els.lbSort.style.display, 'none');
    u.setLbSort('nonsense'); assert.equal(u.lbSort(), 'power');
    // The order itself: alive first, then the Index where asked, a seat without one after those with one.
    const src = fs.readFileSync(path.join(root, 'js/ui.js'), 'utf8');
    assert.match(src, /rows\.sort\(\(a, b\) => \(b\.alive - a\.alive\) \|\| \(byIndex \? indexOf\(b\) - indexOf\(a\) : 0\) \|\| \(b\.score - a\.score\)\);/);
    assert.match(src, /const indexOf = r => \(r\.profile && r\.profile\.index && r\.profile\.index\.value != null \? r\.profile\.index\.value : -1\);/);
    assert.match(fs.readFileSync(path.join(root, 'index.html'), 'utf8'), /<span id="lbSort" class="lb-sort" style="display:none;"><\/span><span id="lbCount">/);
    // Every string exists in all four languages.
    const i18n = fs.readFileSync(path.join(root, 'js/i18n.js'), 'utf8');
    for (const key of ['log.tagServes', 'log.tagServesTip', 'log.tagAnswers', 'log.tagAnswersTip', 'log.tagAnswersWonderTip', 'log.chipServes', 'log.chipAnswers',
        'spec.sortPower', 'spec.sortIndex', 'spec.sortTip', 'eval.planLine', 'eval.planLineTip', 'eval.planStepTip',
        'eval.planState.acted', 'eval.planState.begun', 'eval.planState.part', 'eval.planState.pending', 'eval.planState.dropped', 'eval.planState.uncheckable'])
        assert.equal(i18n.split('"' + key + '":').length - 1, 4, key);
});

// Build 1221 (asp67): "Scoring needs to be part of the transcript, so that the score history
// is saved over the entire match and can be analyzed later."
test('the scores over the match are a line of the transcript, and a reader arrives at the same rows', () => {
    const lines = [];
    for (let n = 1; n <= 9; n++) lines.push(decision(n, n === 1 ? { plan: ['Build a tower by the gate', 'Train militia'], orders: [['assign_workers']] }
        : n === 4 ? { attack: raid, orders: [['attack_target', { targetX: 105, targetZ: 100 }]] } : n % 2 ? { orders: [militia] } : { orders: [tower, ['train_unit', { unitType: 'militia' }, 'avoidable']] }));
    const l = WarEval.createLedger(); lines.forEach(x => l.addLine(x));
    const h = l.history();
    assert.deepEqual([h.type, h.scale, h.everySec, h.kind], ['scores', WarEval.SCALE, 30, 'war-eval/' + WarEval.VERSION]);
    assert.deepEqual(plain(h.fields), plain(WarEval.HISTORY_FIELDS)); assert.equal(h.fields.length, 15);
    assert.deepEqual(plain(h.seats), [{ id: 'a', seat: 0, civ: null, name: 'Seat a', model: null }]);
    // Decisions fall every 30 s from 0:30 to 4:30: a sample at each, the last at the last decision.
    assert.deepEqual(h.samples.map(s => s.t), [30, 60, 90, 120, 150, 180, 210, 240, 270]);
    // Every row is the profile as it stood at that second, and what it was counted from.
    for (const s of h.samples) {
        const p = l.profileAt(s.t).seats[0], row = s.v.a, at = f => row[h.fields.indexOf(f)];
        assert.deepEqual([at('decisions'), at('index'), at('grounding'), at('planning'), at('follow'), at('tactical'), at('strategy')],
            [p.decisions, p.index.value, p.grounding.score, p.planning.score, p.follow.score, p.tactical.score, p.strategy.score], 'at ' + s.t);
        assert.deepEqual([at('ok'), at('avoidable'), at('invalid'), at('repeated')], [p.grounding.ok, p.grounding.avoidable, p.grounding.invalid, p.grounding.repeated]);
        assert.equal(at('decisions'), s.t / 30);
    }
    // They grow: a decision more each sample, never fewer commands or mistakes.
    const col = f => h.samples.map(s => s.v.a[h.fields.indexOf(f)]);
    for (const f of ['decisions', 'commands', 'ok', 'avoidable']) assert.ok(col(f).every((v, i, a) => !i || v >= a[i - 1]), f);
    assert.equal(col('avoidable')[8], 3); assert.equal(col('commands')[8], 12);   // three refused orders among twelve
    // As lists a field, for a graph.
    const series = WarEval.Ledger.series(h, 'a');
    assert.deepEqual([series.t.length, series.index.length, series.decisions[8]], [9, 9, 9]);
    assert.equal(WarEval.Ledger.series(h, 'nobody'), null); assert.equal(WarEval.Ledger.series(null, 'a'), null);
    // Written into the file and read again: the line changes no number, and the rows worked out from the file are the rows in it.
    const again = WarEval.createLedger();
    lines.concat([JSON.stringify(h)]).forEach(x => again.addLine(x));
    assert.deepEqual(plain(again.history().samples), plain(h.samples));
    assert.ok(WarEval.sameProfile(WarEval.publicProfile(again.profile()), WarEval.publicProfile(l.profile())));
    // A seat that never decided is in no row; an empty match has no rows.
    assert.equal(WarEval.createLedger().history().samples.length, 0);
    // The page writes it with the results and the timeline, and the analyzer keeps it apart from the markers.
    const ui = fs.readFileSync(path.join(root, 'js/ui.js'), 'utf8'), an = fs.readFileSync(path.join(root, 'js/analyzer.js'), 'utf8');
    assert.match(ui, /rec\.finish\(\[results, timeline, scores\]\);/);
    assert.match(an, /if \(o\.type === 'scores'\) \{ this\.scores = o; continue; \}/);
    assert.ok(an.indexOf("o.type === 'scores'") < an.indexOf('if (o.type) { this.markers.push(o); continue; }'));
});
