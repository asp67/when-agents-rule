'use strict';
// The live seat-health strip (review #11): the leaderboard card reads the same
// seatMetrics() the results screen does, and shows only what has happened.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');

function ui() {
    const context = vm.createContext({ console, Date, t: (k, v) => k + (v ? JSON.stringify(v) : ''),
        OpenAIAIManager: { MAX_COMMANDS_PER_TURN: 3 }, document: { getElementById: () => null } });
    vm.runInContext(fs.readFileSync(path.join(root, 'js/ui.js'), 'utf8') + '\nthis.UI = UIManager;', context);
    return Object.create(context.UI.prototype);
}
const stats = over => Object.assign({ requests: 0, latencies: [], timeouts: 0, networkErrors: 0, parseFails: 0, noActionReturns: 0,
    actionsAttempted: 0, actionsSucceeded: 0, actionsContended: 0, reasonsGiven: 0, invalidActions: 0, actionsRejected: 0,
    actionCounts: {}, turnsExecuted: 0 }, over);

test('nothing is shown before the seat has done anything', () => {
    const u = ui();
    const m = u.seatMetrics({ stats: stats({}) });
    assert.equal(u.seatHealthHtml(m), '');
});

test('the strip shows answer time, success, missed rounds, errors, overflows and silence -- each only once it happened', () => {
    const u = ui();
    const m = u.seatMetrics({ stats: stats({ requests: 10, latencies: [4000, 5000, 6000, 30000, 31000, 32000], actionsAttempted: 8, actionsSucceeded: 4,
        actionsContended: 2, roundsMissed: 2, timeouts: 1, contextOverflows: 1, lastAnswerAt: Date.now() - 90000 }) });
    // One function for both surfaces: the strip's numbers are the results screen's.
    assert.equal(m.latLate, 31000, 'median of the last three');
    assert.equal(m.successRate, 4 / 6, 'contended attempts leave the denominator');
    const html = u.seatHealthHtml(m);
    assert.match(html, /31\.0s/);
    assert.match(html, /warn[^>]*>[^<]*31/, 'a slow answer is marked');
    assert.match(html, /67%/);
    assert.match(html, /sh\.missed\{"n":2\}/);
    assert.match(html, /sh\.errors\{"n":1\}/);
    assert.match(html, /sh\.overflow\{"n":1\}/);
    assert.match(html, /sh\.silent\{"n":90\}/);
    // A seat a spectator paused is silent on purpose.
    assert.doesNotMatch(u.seatHealthHtml(m, true), /sh\.silent/);
});
