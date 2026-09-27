// The match clock a model reads (state.clock.matchSeconds). From build 934 to 949 it
// was 0 on every turn: the state subtracted the timeline's wall-clock origin from the
// simulation clock. Found while building WAR Bench; one recorded match showed 314 turns
// out of 314 at 0 s, and the analyzer stacked all of them at the start of its timeline.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const { createMatch } = require('../tools/bench/realm.cjs');

test('the state tells a model the match time, and it runs with the match', async () => {
    const m = await createMatch({ kind: 'arena', seats: ['greek', 'persian'], seed: 'match-clock' });
    const c = m.scripted(m.seats[0]), mgr = m.game.openAIAIManager;
    assert.equal(mgr.buildGameStateJSON(c).clock.matchSeconds, 0);
    m.advance(20000);
    assert.equal(mgr.buildGameStateJSON(c).clock.matchSeconds, 20);
    m.advance(45000);
    assert.equal(mgr.buildGameStateJSON(c).clock.matchSeconds, 65);
});

function analyzer(lines) {
    const scope = vm.createContext({ console });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/analyzer.js'), 'utf8') + ';this.T = TranscriptAnalyzer;', scope);
    const a = new scope.T({});
    a.load(lines.map(l => JSON.stringify(l)).join('\n'), 'x.jsonl');
    return a;
}
const T0 = 1790000000000;
const turn = (n, sec, atSec) => ({ turn: n, playerId: 'p1', civ: 'greek', seat: 0, at: T0 + atSec * 1000, state: { clock: { matchSeconds: sec } } });

test('the analyzer places the turns of a file with the stuck clock by their own stamps', () => {
    const a = analyzer([{ type: 'match', startedAt: T0, players: [] },
        turn(1, 0, 12), turn(2, 0, 40), { type: 'match_event', kind: 'paused', at: T0 + 30000, matchSeconds: 30 }, turn(3, 0, 75)]);
    assert.equal(a.clockStuck, true);
    assert.deepEqual(Array.from(a.order, r => r._sec), [12, 30, 40, 75]);
    assert.deepEqual(Array.from(a.order, r => (r.turn != null ? 'T' : 'M')), ['T', 'M', 'T', 'T']);
});

test('a healthy file keeps its own clock, and a lone turn at 0 is not "stuck"', () => {
    const healthy = analyzer([{ type: 'match', startedAt: T0, players: [] }, turn(1, 0, 3), turn(2, 25, 30), turn(3, 50, 55)]);
    assert.equal(healthy.clockStuck, false);
    assert.deepEqual(Array.from(healthy.order, r => r._sec), [0, 25, 50]);
    const lone = analyzer([{ type: 'match', startedAt: T0, players: [] }, turn(1, 0, 90)]);
    assert.equal(lone.clockStuck, false);
    assert.equal(lone.order[0]._sec, 0);
});
