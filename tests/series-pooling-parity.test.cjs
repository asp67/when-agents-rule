// A series of one match is that match (b1286). The pooled scores of an Arena Series are
// computed in js/eval/season.js from each seat's counts, by formulas that repeat the
// ledger's. One of them had drifted: pooled Spatial left out the ramp that lets the
// "rivals discovered" part count in only as a match gets long (it is exploration's own
// score in the first minutes). A seat that found its rival early in a short round was
// paid the full discovery share: 31.9 became 50.8 on a shipped six-minute match, and its
// pooled WAR Score 55.2 against 52.4. Held here for every pillar on every shipped match,
// so the next formula that changes in one place and not the other is seen.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const WarEval = require('../js/eval/ledger.js'), WarSeason = require('../js/eval/season.js');
const { loadConditions } = require('../tools/eval/season.cjs');

const SAMPLES = path.join(__dirname, '../samples');
const files = fs.readdirSync(SAMPLES).filter(f => f.endsWith('.jsonl')).sort();
const conditions = loadConditions();
const PARTS = ['grounding', 'macro', 'spatial', 'tactical', 'strategy'];

test('every shipped match, pooled as a series of one, has the scores of the match', () => {
    const off = [];
    let seats = 0;
    for (const f of files) {
        const entry = WarSeason.entryOf(fs.readFileSync(path.join(SAMPLES, f), 'utf8'), { evaluator: WarEval, conditions, source: 'sample', file: f });
        if (!entry) continue;
        const pooled = WarSeason.poolSeries([entry]);
        for (const s of entry.seats) {
            const m = pooled.models.find(x => x.name === s.name && x.model === s.model && x.seats.includes(s.seat)) || pooled.models.find(x => x.name === s.name && x.model === s.model);
            if (!m || !s.decisions) continue;
            seats++;
            for (const p of PARTS) {
                const a = s.scores[p], b = m.pooled[p];
                if (a == null && b == null) continue;
                if (a == null || b == null || Math.abs(a - b) > 0.15) off.push(`${f.slice(0, 40)} ${s.name}: ${p} ${a} in the match, ${b} pooled`);
            }
        }
    }
    assert.ok(seats >= 40, 'seats compared: ' + seats);
    assert.deepEqual(off.slice(0, 12), [], off.length + ' pooled scores differ from their match');
});
