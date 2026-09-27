'use strict';
// Moment links and chapters (review #11): ?match=&t=&seat=&turn= opens a published match
// at a moment, at or before the time named; a link is offered only where it would open;
// chapters copy in YouTube's format with the video's own offset.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');

function setup(href = 'http://192.168.1.20:8088/index.html?full=1') {
    const context = vm.createContext({ console, URL, t: (k, v) => k + (v ? JSON.stringify(v) : ''), location: { href },
        document: { getElementById: () => null, querySelector: () => null } });
    vm.runInContext(fs.readFileSync(path.join(root, 'js/analyzer.js'), 'utf8') + '\nthis.TA = TranscriptAnalyzer;', context);
    vm.runInContext(fs.readFileSync(path.join(root, 'js/ui.js'), 'utf8') + '\nthis.UI = UIManager;', context);
    const ui = Object.create(context.UI.prototype);
    ui.anRender = () => {};
    ui.analyzer = new context.TA(ui);
    // Two seats, a turn every 20 s each, offset by 10 s.
    const lines = [{ type: 'match', matchId: 'match-20260927-120000', players: [{ id: 'p1', seat: 0, civ: 'greek', model: 'a' }, { id: 'p2', seat: 1, civ: 'persian', model: 'b' }] }];
    for (let k = 0; k < 10; k++) {
        lines.push({ playerId: 'p1', at: 1000 * (20 * k), state: { clock: { matchSeconds: 20 * k } }, harnessResult: 'OK' });
        lines.push({ playerId: 'p2', at: 1000 * (20 * k + 10), state: { clock: { matchSeconds: 20 * k + 10 } }, harnessResult: 'OK' });
    }
    ui.analyzer.load(lines.map(l => JSON.stringify(l)).join('\n'), 'x.jsonl');
    return { ui, a: ui.analyzer, UI: context.UI };
}

test('a moment time reads as h:mm:ss, m:ss or seconds, and nothing else', () => {
    const { UI } = setup();
    assert.equal(UI.parseMomentTime('1:04:30'), 3870);
    assert.equal(UI.parseMomentTime('64:30'), 3870);
    assert.equal(UI.parseMomentTime('3870'), 3870);
    assert.equal(UI.parseMomentTime('3870s'), 3870);
    for (const bad of ['', 'abc', '1:2:3:4', '1:x', '../etc', null]) assert.equal(UI.parseMomentTime(bad), null, String(bad));
    assert.equal(UI.formatMomentTime(3870), '1:04:30');
    assert.equal(UI.formatMomentTime(59), '0:59');
});

test('a link opens at or before its time, in the seat and turn it names', () => {
    const { ui, a } = setup();
    ui.anApplyMoment({ t: '1:05' });                 // 65 s: the record AT 60, not the one at 70
    assert.equal(a.current()._sec, 60);
    assert.equal(a.seatFilter, null);
    ui.anApplyMoment({ seat: '2', t: '0:45' });      // seat 2's view, last record at or before 45
    assert.equal(a.seatFilter, 'p2');
    assert.equal(a.current()._sec, 30);
    ui.anApplyMoment({ seat: '1', turn: '4' });      // seat 1's fourth turn
    assert.equal(a.current().playerId, 'p1');
    assert.equal(a.current()._sec, 60);
    ui.anApplyMoment({ seat: '9', t: '0:05' });      // no such seat: the whole match, at the time
    assert.equal(a.seatFilter, null);
    assert.equal(a.current()._sec, 0);
});

test('a link is offered only for a published match, and names the moment on screen', () => {
    const { ui, a } = setup();
    assert.equal(ui.anMomentLink(), null, 'not in the sample catalogue: the link would open nowhere else');
    ui._sampleIndex = [{ matchId: 'match-20260927-120000', file: 'x.jsonl' }];
    ui.anApplyMoment({ seat: '2', turn: '3' });
    const u = new URL(ui.anMomentLink());
    assert.equal(u.host, '192.168.1.20:8088', 'a plain-http LAN host keeps working');
    assert.equal(u.searchParams.get('match'), 'match-20260927-120000');
    assert.equal(u.searchParams.get('t'), '0:50');
    assert.equal(u.searchParams.get('seat'), '2');
    assert.equal(u.searchParams.get('turn'), '3');
    assert.equal(u.searchParams.get('full'), '1', 'the full-app switch travels with it');
    // And opening that link lands on the same moment.
    ui.anApplyMoment({ seat: '1', t: '0:00' });
    ui.anApplyMoment({ t: u.searchParams.get('t'), seat: u.searchParams.get('seat'), turn: u.searchParams.get('turn') });
    assert.equal(a.current()._sec, 50);
    assert.equal(a.seatFilter, 'p2');
});

test('chapters copy in YouTube\'s format: 0:00 first, 10 s apart, shifted by the video offset', () => {
    const { ui, a } = setup();
    a.chapters = [{ t: 3, icon: '⚔️', text: 'first fight' }, { t: 8, icon: '⚔️', text: 'too close' },
        { t: 40, icon: '⏫', text: 'Greeks → bronze' }, { t: 3700, icon: '🏛', text: 'Wonder raised' }];
    assert.deepEqual(ui.anChaptersText(0).split('\n'), ['0:00 ⚔️ first fight', '0:40 ⏫ Greeks → bronze', '1:01:40 🏛 Wonder raised'],
        'a chapter under 10 s in counts as the start; one too close to the last is dropped');
    assert.deepEqual(ui.anChaptersText(30).split('\n'), ['0:00 an.chStart', '0:33 ⚔️ first fight', '1:10 ⏫ Greeks → bronze', '1:02:10 🏛 Wonder raised']);
});

test('turn numbers count turns, not the markers filed with a seat', () => {
    const { ui, a } = setup();
    // A missed round for seat 1 between its turns 2 and 3.
    const lines = [a.header];
    for (const r of a.order) lines.push(r);
    lines.splice(5, 0, { type: 'round_missed', playerId: 'p1', at: 25000, matchSeconds: 25 });
    a.load(lines.map(l => JSON.stringify(l)).join('\n'), 'x.jsonl');
    ui._sampleIndex = [{ matchId: 'match-20260927-120000', file: 'x.jsonl' }];
    ui.anApplyMoment({ seat: '1', turn: '3' });
    assert.equal(a.current()._sec, 40, 'the third turn, past the missed-round marker');
    assert.equal(new URL(ui.anMomentLink()).searchParams.get('turn'), '3');
});
