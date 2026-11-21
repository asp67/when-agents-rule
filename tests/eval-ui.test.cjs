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
