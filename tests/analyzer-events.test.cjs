'use strict';
// The analyzer's event list (b1146). asp67, 1 Nov: "The event section under the Standing
// over time graph needs some love." It was guessed from the snapshots: 81 of 98 lines in
// one match read "X in combat", once per seat, with no rival, place or result. A recording
// with a chronicle now lists what it says, with filters; an older one keeps the guess,
// merged.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const root = path.resolve(__dirname, '..');

function setup(extra = []) {
    const context = vm.createContext({ console, URL, t: (k, v) => k + (v ? JSON.stringify(v) : ''), location: { href: 'http://localhost/' },
        document: { getElementById: () => null, querySelector: () => null } });
    vm.runInContext(fs.readFileSync(path.join(root, 'js/analyzer.js'), 'utf8') + '\nthis.TA = TranscriptAnalyzer;', context);
    vm.runInContext(fs.readFileSync(path.join(root, 'js/ui.js'), 'utf8') + '\nthis.UI = UIManager;', context);
    const ui = Object.create(context.UI.prototype);
    ui.anRender = () => {};
    // As the real one: a mark with a label for screen readers inside it.
    ui.teamDotHtml = seat => '<i class="dot" data-seat="' + seat + '"><span class="sr">Team badge</span></i>';
    ui.getAgeName = a => a;
    ui.analyzer = new context.TA(ui);
    const lines = [{ type: 'match', matchId: 'm', players: [{ id: 'p1', seat: 0, civ: 'greek', model: 'Alpha' }, { id: 'p2', seat: 1, civ: 'persian', model: 'Beta' }] }];
    for (let k = 0; k < 6; k++) {
        lines.push({ playerId: 'p1', at: 1000 * (60 * k), state: { clock: { matchSeconds: 60 * k }, battles: k >= 3 ? [{}] : [] }, harnessResult: 'OK' });
        lines.push({ playerId: 'p2', at: 1000 * (60 * k), state: { clock: { matchSeconds: 60 * k }, battles: k >= 3 ? [{}] : [] }, harnessResult: 'OK' });
    }
    ui.analyzer.load(lines.concat(extra).map(l => JSON.stringify(l)).join('\n'), 'x.jsonl');
    return { ui, a: ui.analyzer };
}
const C = (kind, t, more) => Object.assign({ type: 'chronicle', kind, t, weight: 1, seats: ['p1', 'p2'] }, more);

test('a chronicle is the list: a fight at its start, with both sides\' losses; clashes left out', () => {
    const { ui, a } = setup([
        C('contact', 100, { weight: 2 }),
        C('clash', 200),
        C('battle', 230, { weight: 3, seconds: 30, sides: { p1: { involved: 12, lost: 3 }, p2: { involved: 27, lost: 27 } } }),
        C('building-lost', 240, { seats: ['p2', 'p1'], building: 'barracks', by: 'p1' }),
        C('town-center-lost', 250, { weight: 3, seats: ['p2', 'p1'], building: 'town_center', by: 'p1' }),
        C('elimination', 300, { weight: 3, seats: ['p2'] }),
    ]);
    const kinds = a.chapters.map(c => c.kind + '@' + c.t);
    assert.deepEqual(Array.from(kinds), ['contact@100', 'battle@200', 'building-lost@240', 'town-center-lost@250', 'elimination@300']);
    const fight = a.chapters.find(c => c.kind === 'battle');
    assert.equal(fight.text, 'Fight, 30 s: Alpha lost 3 of 12 · Beta lost 27 of 27');
    assert.ok(!a.chapters.some(c => /in combat/.test(c.text)), 'no guessed combat lines beside the record');
    // The page's line: the chronicle's own words, the analyzer's seat names and team marks.
    const html = ui.anChapterHtml(fight);
    assert.match(html, /an\.chFight/);
    assert.match(html, /data-seat=\W*0\W.*Alpha.*data-seat=\W*1\W.*Beta/s);
    assert.match(ui.anChapterHtml(a.chapters.find(c => c.kind === 'town-center-lost')), /chr\.lostBy.*Beta.*Alpha/s);
});

test('filters: highlights, fights, buildings, all; and the seat picked', () => {
    const { ui, a } = setup([
        C('battle', 130, { weight: 1, seconds: 5, sides: { p1: { involved: 1, lost: 1 }, p2: { involved: 2, lost: 0 } } }),
        C('battle', 330, { weight: 3, seconds: 30, sides: { p1: { involved: 9, lost: 9 }, p2: { involved: 9, lost: 2 } } }),
        C('building-lost', 240, { seats: ['p2', 'p1'], building: 'house', by: 'p1' }),
        C('age', 50, { weight: 2, seats: ['p1'], age: 'bronze' }),
        C('wonder-raised', 400, { weight: 3, seats: ['p2'], building: 'akropolis', required: 600 }),
    ]);
    const n = f => a.chapters.filter(c => ui.anChapterShown(c, f)).length;
    assert.deepEqual([n('key'), n('fights'), n('buildings'), n('all')], [3, 2, 2, 5]);
    a.seatFilter = 'p1';
    assert.equal(n('all'), 4, 'the Wonder was p2\'s alone');
});

test('copied chapters are the highlights, in plain words', () => {
    const { ui, a } = setup([
        C('battle', 130, { weight: 1, seconds: 5, sides: { p1: { involved: 1, lost: 1 }, p2: { involved: 2, lost: 0 } } }),
        C('town-center-lost', 250, { weight: 3, seats: ['p2', 'p1'], building: 'town_center', by: 'p1' }),
    ]);
    const lines = ui.anChaptersText(0).split('\n');
    assert.equal(lines.length, 2, 'the start, and the Town Center; not the skirmish: ' + lines.join(' | '));
    assert.ok(!/[<>]/.test(lines[1]), 'no markup in a YouTube description: ' + lines[1]);
    assert.ok(!/Team badge/.test(lines[1]), 'nor the label of a team mark: ' + lines[1]);
    assert.match(lines[1], /^4:10 🔥 chr\.lostBy.*Beta.*Alpha/);
});

test('a file with no chronicle keeps the guess, one line per moment rather than per seat', () => {
    const { a } = setup();
    const fights = a.chapters.filter(c => c.kind === 'battle');
    // Both seats in combat at 3:00, 4:00 and 5:00: three lines, where there were six.
    assert.equal(JSON.stringify(fights.map(f => f.t + ' ' + f.text)), JSON.stringify(['180 In combat: Alpha, Beta', '240 In combat: Alpha, Beta', '300 In combat: Alpha, Beta']));
    assert.equal(JSON.stringify(fights[0].ids), JSON.stringify(['p1', 'p2']));
});

// Issue #4 (b1147): "35:13 wonder lost" opened the decision at 34:31, whose header still
// read "wonder holds -- 9:40 to win", with nothing saying why.
function withInputs() {
    // Each seat asked every 60 s; at 40 steps a second (build 1054's normal speed 2).
    const extra = [];
    for (let k = 0; k < 6; k++) for (const p of ['p1', 'p2']) extra.push({ type: 'input', kind: 'observe', playerId: p, turnCount: k + 1, step: 2400 * k, seq: extra.length + 1 });
    const s = setup(extra);
    s.a.header.build = 1054;
    s.a.order.filter(r => !r.type).forEach(r => { r.turn = Math.round(r._sec / 60) + 1; });
    return s;
}

test('a match second is a step, from the moments each seat was asked', () => {
    const { ui } = withInputs();
    assert.equal(ui.anResimStepAtSec(0), 0);
    assert.equal(ui.anResimStepAtSec(60), 2400);
    assert.equal(ui.anResimStepAtSec(90), 3600, 'between two asks, evenly');
    assert.equal(ui.anResimStepAtSec(330), 13200, 'past the last, at the header\'s speed');
});

test('in the snapshots, a jump to an event says what it shows and offers the next decision', () => {
    const { ui, a } = withInputs();
    ui.anResimCheck = async () => 'rulesChanged';
    ui.anJumpEvent(130);   // between the asks at 120 and 180
    const cur = a.current();
    assert.equal(cur._sec, 120);
    const note = ui.anEventNoteHtml(cur);
    assert.match(note, /an\.evNote\{"t":"2:10","d":"2:00"\}/);
    assert.match(note, /an\.evNext\{"d":"3:00"\}/);
    assert.match(note, /game\.ui\.anSeek\(\d+\)/);
    assert.doesNotMatch(note, /evPlay/, 'no replay offered where there is none');
    a.seek(a.cursor + 1);
    assert.equal(ui.anEventNoteHtml(a.current()), '', 'gone once the reader moves on');
});

test('in a replay, a jump to an event goes to its second, a few seconds early', () => {
    const { ui } = withInputs();
    const asked = [];
    ui._anResim = { status: 'running' };
    ui.anResimSeek = step => asked.push(step);
    ui.anJumpEvent(130);
    assert.equal(JSON.stringify(asked), JSON.stringify([ui.anResimStepAtSec(125)]));
    assert.equal(ui._anEvent, null, 'no note: the world is at the event');
});
