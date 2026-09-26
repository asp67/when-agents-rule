// samples/index.json is what the sample picker and the README describe. It is
// written by hand, and one entry had drifted from its file: it called a
// turn-based match real time and counted 484 turns where the file has 471.
// The file's own header and records are the authority.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
// Recorded matches are not deployed everywhere (the platform server has none), so a
// test that reads them reports as skipped there rather than as a failure.
const HAS_SAMPLES = require('node:fs').existsSync(require('node:path').join(__dirname, '..', 'samples', 'index.json'));
const NEEDS_SAMPLES = { skip: !HAS_SAMPLES && 'samples/ not present' };
if (!HAS_SAMPLES) { require('node:test')('recorded match checks', NEEDS_SAMPLES, () => {}); return; }
const root = path.resolve(__dirname, '..');
const index = JSON.parse(fs.readFileSync(path.join(root, 'samples/index.json'), 'utf8'));

for (const m of index.matches) {
    test('catalogue entry agrees with its transcript: ' + m.file, () => {
        const rows = fs.readFileSync(path.join(root, 'samples', m.file), 'utf8')
            .split('\n').filter(Boolean).map(l => JSON.parse(l));
        const header = rows[0];
        assert.equal(header.type, 'match');
        assert.equal(m.matchId, header.matchId);
        assert.equal(m.seed, header.mapSeed);
        assert.equal(m.difficulty, header.difficulty);
        assert.equal(!!m.turnBased, !!header.turnBased);
        assert.equal(m.promptVersion, header.promptVersion);
        assert.equal(m.turns, rows.filter(r => !r.type).length);
        const results = rows.find(r => r.type === 'results');
        if (results) assert.equal(m.outcome, results.outcome);
    });
}
