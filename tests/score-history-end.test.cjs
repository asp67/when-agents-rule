// The score history of a finished match ends on the match's final scores (b1285).
//
// Its last sample was the blend "as of the last second", computed like every sample
// before it, without the placement that only the result brings. The profile beside it had
// the placement. So every curve on the comparison board ended some three points off the
// number printed next to it, and the exported history contradicted the profile in the
// same file. The live board already ended on the profile.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const WarEval = require('../js/eval/ledger.js');

const SAMPLES = path.join(__dirname, '../samples');
const files = fs.readdirSync(SAMPLES).filter(f => f.endsWith('.jsonl')).sort().slice(-3);

function ledgerOf(file) {
    const ledger = WarEval.createLedger();
    for (const line of fs.readFileSync(path.join(SAMPLES, file), 'utf8').split('\n')) if (line.trim()) ledger.addLine(line);
    return ledger;
}

test('there are finished matches to check', () => { assert.equal(files.length, 3); });

for (const file of files) test('the last point of every curve is the final score: ' + file, () => {
    const ledger = ledgerOf(file), profile = ledger.profile(), history = ledger.history();
    const F = history.fields, last = history.samples[history.samples.length - 1];
    assert.ok(history.samples.length > 3 && profile.seats.length >= 2);
    let placed = 0;
    for (const p of profile.seats) {
        if (!p.decisions) continue;
        const row = last.v[p.id];
        assert.ok(row, 'a last sample for ' + p.name);
        const at = k => row[F.indexOf(k)];
        assert.equal(at('index'), p.index.value, p.name + ': WAR Score');
        for (const k of ['grounding', 'macro', 'spatial', 'tactical', 'strategy']) assert.equal(at(k), p[k].score, p.name + ': ' + k);
        if (p.strategy && p.strategy.final) placed++;
    }
    assert.ok(placed > 0, 'the match has a result, so the last point carries a placement');
    // The curve as the board reads it: its last value is the number beside it.
    for (const p of profile.seats) if (p.decisions) {
        const s = ledger.constructor.series(history, p.id);
        assert.equal(s.index[s.index.length - 1], p.index.value);
    }
});

test('the points before the last are the blend as of their second, as before', () => {
    const ledger = ledgerOf(files[0]), history = ledger.history();
    const F = history.fields, mid = history.samples[Math.floor(history.samples.length / 2)];
    const then = ledger.profileAt(mid.t);
    for (const p of then.seats) if (p.decisions) assert.equal(mid.v[p.id][F.indexOf('index')], p.index.value);
});
