// The paired-run tool must build both arms through the real request path and prove
// they differ only in the replayed assistant text, before anything is sent.
const test = require('node:test'), assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process'), path = require('node:path');
// Recorded matches are not deployed everywhere (the platform server has none), so a
// test that reads them reports as skipped there rather than as a failure.
const HAS_SAMPLES = require('node:fs').existsSync(require('node:path').join(__dirname, '..', 'samples', 'index.json'));
const NEEDS_SAMPLES = { skip: !HAS_SAMPLES && 'samples/ not present' };
test('dry run on the Episode 7 Gemini seat builds verified pairs', NEEDS_SAMPLES, () => {
    const root = path.resolve(__dirname, '..');
    const out = execFileSync(process.execPath, ['tools/paired-history.cjs', '--file',
        'samples/2026-09-09_gemini3.8-deepseek-v4-gpt5.6-qwen3.8_121min.jsonl', '--seat', 'gemini', '--turns', '8', '--dry-run'],
        { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const r = JSON.parse(out.trim().split('\n').pop());
    assert.equal(r.dryRun, true);
    assert.ok(r.pairs >= 8, 'pairs ' + r.pairs);
});
