// On a plain-http LAN host there is no origin-private storage. The recorder keeps
// every line in memory there, but the export used to try the missing directory,
// fail, and fall back to the 300-turn display ring: long matches lost their
// opening, every marker and the results tail.
const test = require('node:test'), assert = require('node:assert/strict');
const vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
const root = path.resolve(__dirname, '..');

test('without storage the export still holds every turn, marker and the tail', async () => {
    class Blob { constructor(parts) { this.text = parts.join(''); } }
    const context = vm.createContext({ console, navigator: {}, Blob, Date });
    vm.runInContext(fs.readFileSync(path.join(root, 'js/transcript.js'), 'utf8') + '\nthis.T = TranscriptRecorder;', context);
    const rec = new context.T();
    assert.equal(rec.available, false);
    await rec.begin('match-x', [{ id: 'p1', civilization: 'greek', seat: 0 }], { seed: 's' });
    for (let i = 0; i < 400; i++) {
        rec.record('p1', { parsed: { action: 'wait' } });
        rec.noteResult('p1', 'OK');
    }
    rec.note('p1', { type: 'round_missed', round: 7 });
    rec.finish({ type: 'results', outcome: 'last_standing' });
    const blob = await rec.exportBlob();
    const lines = blob.text.split('\n').filter(Boolean).map(l => JSON.parse(l));
    assert.equal(lines[0].type, 'match');
    assert.equal(lines.filter(l => !l.type).length, 400);
    assert.equal(lines.filter(l => l.type === 'round_missed').length, 1);
    assert.equal(lines[lines.length - 1].type, 'results');
});
