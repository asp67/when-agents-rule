'use strict';
// Golden-trace harness: the reference realm (tools/bench/realm.cjs) under the name the
// simulation tests know it by, plus golden-file handling. Everything that runs the
// rules lives in the realm, so the tests pin the same engine the bench scores.
const fs = require('node:fs');
const path = require('node:path');
const { Realm, FRAME_MS } = require('../../tools/bench/realm.cjs');

class GoldenMatch extends Realm {}

// Golden file handling. A trace is re-recorded only on purpose:
//   WAR_GOLDEN=update node --test tests/sim/
// and the commit that does it says which rules change made it necessary.
function checkGolden(t, assert, name, trace) {
    const file = path.join(__dirname, 'golden', name + '.json');
    if (process.env.WAR_GOLDEN === 'update') {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(trace, null, 1) + '\n');
        t.diagnostic('recorded golden trace: ' + name);
        return;
    }
    // A missing trace fails rather than being recorded, or deleting one would pass.
    if (!fs.existsSync(file)) assert.fail(`no golden trace ${name}; record it with WAR_GOLDEN=update`);
    const want = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (let i = 0; i < Math.max(want.length, trace.length); i++) {
        const a = want[i], b = trace[i];
        if (!a || !b || a.hash !== b.hash) {
            assert.deepEqual(b && b.summary, a && a.summary,
                `${name}: first divergence at checkpoint ${i} (t=${(a || b).summary.t}s)`);
            assert.fail(`${name}: diverges at checkpoint ${i} (t=${a.summary.t}s) with identical counts: positions or timers moved`);
        }
    }
}

module.exports = { GoldenMatch, checkGolden, FRAME_MS };
