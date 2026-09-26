// A batched turn answers "Command i/n: ..." per command, so an error can sit on any
// line. The analyzer used to ask only whether the whole answer STARTED with [ERROR],
// which flagged 4 of Episode 7's 78 failed turns. And every turn without a game
// command was labelled "(malformed)", though most were plan saves.
const test = require('node:test'), assert = require('node:assert/strict');
const vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
// Recorded matches are not deployed everywhere (the platform server has none), so a
// test that reads them reports as skipped there rather than as a failure.
const HAS_SAMPLES = require('node:fs').existsSync(require('node:path').join(__dirname, '..', 'samples', 'index.json'));
const NEEDS_SAMPLES = { skip: !HAS_SAMPLES && 'samples/ not present' };
const root = path.resolve(__dirname, '..');

function analyzer() {
    const context = vm.createContext({ console });
    const src = fs.readFileSync(path.join(root, 'js/analyzer.js'), 'utf8').replace(new RegExp("^" + String.fromCharCode(0xFEFF)), '');
    vm.runInContext(src + '\nthis.TranscriptAnalyzer = TranscriptAnalyzer;', context);
    return context.TranscriptAnalyzer;
}

test('a failure on any command of a batch marks the turn', () => {
    const TA = analyzer();
    assert.equal(TA.failed('Command 1/2: OK - done\nCommand 2/2: [ERROR] no clear spot'), true);
    assert.equal(TA.failed('[ERROR] Cannot afford house.'), true);
    assert.equal(TA.failed('Command 1/2: OK - done\nCommand 2/2: OK - done'), false);
    assert.equal(TA.failed('OK - Plan saved.'), false);
    assert.equal(TA.failed(null), false);
});

test('Episode 7: the rejected filter and stats count every failed turn', NEEDS_SAMPLES, () => {
    const TA = analyzer();
    const file = path.join(root, 'samples/2026-09-09_gemini3.8-deepseek-v4-gpt5.6-qwen3.8_121min.jsonl');
    const text = fs.readFileSync(file, 'utf8');
    const a = new TA({});
    a.load(text, 'ep7.jsonl');
    // Independent count straight from the file: any [ERROR] anywhere in the answer.
    const expected = text.split('\n').filter(Boolean).map(l => JSON.parse(l))
        .filter(r => !r.type && typeof r.harnessResult === 'string' && r.harnessResult.includes('[ERROR]')).length;
    assert.ok(expected >= 70, 'the fixture should hold dozens of failed turns, got ' + expected);
    a.filter = 'rejected';
    assert.equal(a.visible().length, expected);
    const rejected = a.stats().perSeat.reduce((n, s) => n + s.rejected, 0);
    assert.equal(rejected, expected);
});

test('command-less turns are named for what they were', () => {
    const TA = analyzer();
    const a = new TA({});
    assert.equal(a.turnKind({ parsed: { commands: [], objective: 'x', plan: ['a'] } }), 'plan');
    assert.equal(a.turnKind({ parsed: { noAction: true } }), 'noAction');
    assert.equal(a.turnKind({ parsed: null }), 'empty');
    assert.equal(a.turnKind({ parsed: { malformed: true, truncated: true } }), 'malformed');
    assert.equal(a.turnKind({ parsed: { action: 'wait', params: {} } }), 'commands');
    assert.equal(a.turnKind({ parsed: { commands: [{ action: 'wait' }] } }), 'commands');
    assert.equal(a.turnKind({ type: 'request_cancelled' }), 'cancelled');
    assert.equal(a.turnKind({ type: 'request_failed' }), 'requestFailed');
});
