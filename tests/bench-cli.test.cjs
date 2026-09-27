// The war-bench command line: run records a verifiable bundle, verify says so with its
// exit code, and report writes a static page that states the verdict.
const test = require('node:test'), assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');

const CLI = path.join(__dirname, '../tools/bench/war-bench.cjs');

test('run, verify and report, end to end', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'war-bench-cli-'));
    try {
        const out = path.join(dir, 'scripted.warbench.jsonl.gz');
        const run = execFileSync(process.execPath, [CLI, 'run', '--policy', 'scripted', '--variants', 'identity', '--out', out], { encoding: 'utf8' });
        assert.match(run, /scripted: 3 episodes, success 100\.0%/);
        assert.match(execFileSync(process.execPath, [CLI, 'verify', out], { encoding: 'utf8' }), /verified: 3 episodes replay identically/);
        execFileSync(process.execPath, [CLI, 'report', out, '--out', path.join(dir, 'r.html')]);
        const html = fs.readFileSync(path.join(dir, 'r.html'), 'utf8');
        assert.match(html, /Verified: every episode replays identically/);
        assert.doesNotMatch(html, /<script/i, 'a static page');
        // A damaged bundle fails verify with a non-zero exit.
        const zlib = require('node:zlib');
        const lines = zlib.gunzipSync(fs.readFileSync(out)).toString('utf8').split('\n');
        lines[3] = lines[3].replace('"type":"blob"', '"type":"blob","x":1');
        fs.writeFileSync(out, zlib.gzipSync(lines.join('\n')));
        assert.throws(() => execFileSync(process.execPath, [CLI, 'verify', out], { encoding: 'utf8', stdio: 'pipe' }), e => e.status === 1);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an unknown policy is refused: a baseline by name, or a model by --model config', () => {
    assert.throws(() => execFileSync(process.execPath, [CLI, 'run', '--policy', 'gpt'], { stdio: 'pipe' }), e => /or give --model/.test(String(e.stderr)));
});
