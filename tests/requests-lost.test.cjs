// A request the game cut off itself is not a request the seat lost (build 1305). When a
// match ends, each seat is asked for its closing words and the turn request it still had
// out is aborted; the harness files that as `request_cancelled` (category
// harness_cancelled), and it files the same for a seat that is eliminated mid-request.
// The comparison board's "Requests lost" added those to the failed requests and the missed
// rounds, so a seat that happened to be thinking when the match ended showed one lost
// request more than a seat that had just answered -- the winner as often as not.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

const WarEval = require(path.join(root, 'js/eval/ledger.js'));

function page() {
    const context = vm.createContext({ console, Date, Math, Map, Set, WarEval, t: (k, v) => k + (v ? JSON.stringify(v) : ''),
        localStorage: { getItem: () => null, setItem() {} },
        document: { getElementById: () => null, querySelector: () => null, body: { classList: { contains: () => false, toggle() {} } } }, location: { search: '' } });
    for (const f of ['js/ui.js', 'js/eval/bench-view.js']) vm.runInContext(read(f) + '\nthis.UI = UIManager;', context);
    return { UI: context.UI, u: Object.create(context.UI.prototype) };
}

test('lost is what failed and what was missed; what the game cut off is told apart and not counted', () => {
    const { UI, u } = page();
    assert.deepEqual({ ...UI.requestsLost({ failedRequests: 2, missedRounds: 3, cancelledRequests: 1 }) }, { lost: 5, failed: 2, cancelled: 1, missed: 3 });
    assert.deepEqual({ ...UI.requestsLost({ cancelledRequests: 1 }) }, { lost: 0, failed: 0, cancelled: 1, missed: 0 }, 'a seat cut off as the match ended lost nothing');
    assert.deepEqual({ ...UI.requestsLost(null) }, { lost: 0, failed: 0, cancelled: 0, missed: 0 });
    // The board's own figures for a seat, from a profile as the ledger gives it.
    const seat = (failed, missed, cancelled) => ({ id: 'a', grounding: {}, strategy: {}, efficiency: { failedRequests: failed, missedRounds: missed, cancelledRequests: cancelled } });
    const thinking = u.benchCost(seat(0, 0, 1)), answered = u.benchCost(seat(0, 0, 0));
    assert.equal(thinking.lost, 0, 'thinking when the match ended');
    assert.equal(thinking.lost, answered.lost, 'two seats that differ only in that show the same');
    assert.equal(thinking.cancelled, 1, 'the cut-off request is still on show, as what it is');
    assert.deepEqual([u.benchCost(seat(2, 3, 1)).lost, u.benchCost(seat(2, 3, 1)).failed, u.benchCost(seat(2, 3, 1)).missed], [5, 2, 3]);
});

test('the same transcript through the ledger: a cancellation at the end adds no lost request', () => {
    const { u } = page();
    const header = { type: 'match', matchId: 'm', startedAt: 1000, players: [{ id: 'a', seat: 0, civilization: 'greek', model: 'x' }, { id: 'b', seat: 1, civilization: 'persian', model: 'y' }] };
    const turn = (id, at) => ({ playerId: id, at, parsed: { commands: [{ action: 'wait', params: {} }] }, harnessResult: 'Waited.', state: { you: { id } } });
    const feed = extra => {
        const ledger = WarEval.createLedger();
        for (const r of [header, turn('a', 2000), turn('b', 2100), { type: 'request_failed', playerId: 'a', at: 3000 }, { type: 'round_missed', playerId: 'a', at: 4000 }].concat(extra)) ledger.add(r);
        return ledger.profile().seats.find(s => s.id === 'a');
    };
    const plain = feed([]), cut = feed([{ type: 'request_cancelled', playerId: 'a', at: 5000, category: 'harness_cancelled' }]);
    assert.equal(cut.efficiency.cancelledRequests, 1, 'the record is counted as what it is');
    assert.equal(u.benchCost(plain).lost, 2);
    assert.equal(u.benchCost(cut).lost, 2, 'and adds nothing to what the seat lost');
    // Nothing else of the profile moves with it.
    const strip = s => JSON.stringify(Object.assign({}, s, { efficiency: Object.assign({}, s.efficiency, { cancelledRequests: 0 }) }));
    assert.equal(strip(cut), strip(plain), 'no score, rate or count of the seat differs but the cancellation count itself');
});

test('both boards take the figure from the one rule, and the tip says what is not counted', () => {
    const ui = read('js/ui.js'), view = read('js/eval/bench-view.js');
    assert.equal((ui + view).match(/cancelledRequests \|\| 0\) \+/g), null, 'no sum of its own that adds the cancelled');
    assert.equal((ui.match(/UIManager\.requestsLost\(e\)/g) || []).length, 1);
    assert.equal((view.match(/UIManager\.requestsLost\(e\)/g) || []).length, 1);
    const ctx = vm.createContext({ console, localStorage: { getItem: () => null, setItem() {} }, navigator: { language: 'en' }, window: {},
        document: { documentElement: {}, querySelectorAll: () => [], addEventListener() {} } });
    vm.runInContext(read('js/i18n.js') + '\nthis.I = I18N;', ctx);
    for (const lang of ['en', 'de', 'es', 'zh']) {
        const tip = ctx.I[lang]['bench.b.lostTip'];
        for (const k of ['{failed}', '{missed}', '{cancelled}']) assert.ok(tip.includes(k), lang + ' names ' + k);
        assert.ok(tip.indexOf('{cancelled}') > tip.indexOf('{missed}'), lang + ': the cancelled come after, as what is not counted');
    }
    assert.match(ctx.I.en['bench.b.lostTip'], /not counted/i);
});
