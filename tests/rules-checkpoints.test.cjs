'use strict';
// The rule checkpoints (b1144): a match recorded under older rules is replayed with the
// files it was played with, read from GitHub at the commit rules/checkpoints.json names
// for its version. asp67, 1 Nov: "the replay feature ... stops working after every rule
// change. Might be worth saving rule checkpoints for the player to be able to replay the
// older games."
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const INDEX = JSON.parse(fs.readFileSync(path.join(ROOT, 'rules/checkpoints.json'), 'utf8'));
const HAS_GIT = (() => { try { execFileSync('git', ['rev-parse', '--git-dir'], { cwd: ROOT, stdio: 'ignore' }); return true; } catch (e) { return false; } })();
const NEEDS_GIT = { skip: !HAS_GIT && 'no git history here' };
const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 });

const warSha256 = (() => { const c = vm.createContext({}); vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/sha256.js'), 'utf8') + ';globalThis.h = warSha256;', c); return c.h; })();
const lf = s => s.replace(/\r\n/g, '\n');
const manifest = require('../js/manifest.js');
const current = {
    coreHash: warSha256(manifest.rules.map(f => lf(fs.readFileSync(path.join(ROOT, f), 'utf8'))).join('\n')),
    harnessHash: warSha256(lf(fs.readFileSync(path.join(ROOT, manifest.harness), 'utf8'))),
};
const find = c => INDEX.versions.find(v => v.coreHash === c.coreHash && v.harnessHash === c.harnessHash);

// Every shipped sample that records inputs, with its contract.
const samples = fs.readdirSync(path.join(ROOT, 'samples')).filter(f => f.endsWith('.jsonl')).map(f => {
    const head = fs.readFileSync(path.join(ROOT, 'samples', f), 'utf8').split('\n', 4).filter(Boolean).map(l => JSON.parse(l));
    return { file: f, contract: head.find(r => r.type === 'contract') || null };
}).filter(s => s.contract && s.contract.coreHash);

test('the index is well formed: one entry per version, each a full commit', () => {
    assert.equal(INDEX.schema, 'war-rules-checkpoints/1');
    assert.equal(INDEX.repo, 'asp67/when-agents-rule');
    const keys = INDEX.versions.map(v => v.coreHash + ':' + v.harnessHash);
    assert.equal(new Set(keys).size, keys.length);
    for (const v of INDEX.versions) {
        assert.match(v.commit, /^[0-9a-f]{40}$/, 'raw.githubusercontent.com needs the full hash');
        assert.match(v.coreHash, /^[0-9a-f]{64}$/);
        assert.ok(Number.isInteger(v.build));
    }
});

// The guard against a rules change stranding the examples: run
// node tools/rules-checkpoints.cjs after pushing one.
test('every sample replays: under the rules running now, or from a checkpoint', () => {
    assert.ok(samples.length >= 10);
    const stranded = samples.filter(s => !find(s.contract) && !(s.contract.coreHash === current.coreHash && s.contract.harnessHash === current.harnessHash));
    assert.deepEqual(stranded.map(s => s.file), [], 'samples with no checkpoint: run node tools/rules-checkpoints.cjs');
});

test('each sample\'s checkpoint holds the files its hashes name', NEEDS_GIT, () => {
    const { hashesAt } = require('../tools/rules-checkpoints.cjs');
    const seen = new Set();
    for (const s of samples) {
        const v = find(s.contract);
        if (!v || seen.has(v.commit)) continue;
        seen.add(v.commit);
        assert.deepEqual(hashesAt(v.commit), { coreHash: v.coreHash, harnessHash: v.harnessHash }, s.file);
    }
    assert.ok(seen.size >= 5);
});

// The worker as a browser runs it, reading the checkpoint's files "from GitHub": fetch is
// served from the git history at that commit.
function workerRealm() {
    const blobs = new Map(), out = [];
    const ctx = vm.createContext({
        console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
        setTimeout, clearTimeout, Math, Date, performance, Promise, Proxy, Uint8ClampedArray, JSON,
        Blob: class { constructor(parts) { this.text = parts.join(''); } },
        URL: { createObjectURL: b => { const k = 'blob:' + blobs.size; blobs.set(k, b.text); return k; } },
        fetch: async url => {
            const raw = String(url).match(/^https:\/\/raw\.githubusercontent\.com\/asp67\/when-agents-rule\/([0-9a-f]{40})\/(.+)$/);
            if (raw) { try { const text = git('show', raw[1] + ':' + raw[2]); return { ok: true, text: async () => text }; } catch (e) { return { ok: false }; } }
            const file = path.join(ROOT, 'js', String(url).split('?')[0]);
            return fs.existsSync(file) ? { ok: true, text: async () => fs.readFileSync(file, 'utf8') } : { ok: false };
        },
        postMessage: m => out.push(m),
        Worker: class { terminate() {} },
    });
    ctx.self = ctx;
    ctx.importScripts = (...urls) => urls.forEach(u => vm.runInContext(blobs.get(u), ctx, { filename: u }));
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/resim-worker.js'), 'utf8'), ctx, { filename: 'js/resim-worker.js' });
    const send = async data => { await ctx.onmessage({ data }); return out[out.length - 1]; };
    return { send, ctx, out };
}
const raw = commit => 'https://raw.githubusercontent.com/asp67/when-agents-rule/' + commit + '/';

test('an older match replays from its checkpoint, every hash on the way matching', NEEDS_GIT, async () => {
    const file = samples.find(s => /claude-haiku5\.5-gpt6-luna_20min/.test(s.file));
    assert.ok(file, 'the 20-minute build-1080 sample');
    const v = find(file.contract);
    const recs = fs.readFileSync(path.join(ROOT, 'samples', file.file), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(r => r.type === 'match' || r.type === 'contract' || r.type === 'input');
    const w = workerRealm();
    const ready = await w.send({ type: 'init', urls: {}, base: raw(v.commit), recs });
    assert.equal(ready.type, 'ready', ready.problem);
    const loading = w.out.filter(m => m.type === 'loading');
    assert.ok(loading.length > 10 && loading[loading.length - 1].read === loading[0].files, 'each file read is reported');
    const f = await w.send({ type: 'to', step: 6000 });   // five minutes of play
    assert.equal(f.ok, true, f.problem);
    assert.ok(f.checked > 20, 'recorded hashes checked: ' + f.checked);
});

test('files that are not the recording\'s are refused before any of them runs', NEEDS_GIT, async () => {
    const file = samples.find(s => /claude-haiku5\.5-gpt6-luna_20min/.test(s.file));
    const recs = fs.readFileSync(path.join(ROOT, 'samples', file.file), 'utf8').split('\n', 3).filter(Boolean).map(l => JSON.parse(l));
    const w = workerRealm();
    const other = INDEX.versions[0].commit;   // build 961: other rules
    const r = await w.send({ type: 'init', urls: {}, base: raw(other), recs });
    assert.equal(r.type, 'error');
    assert.equal(r.problem, 'rules changed since recording');
    assert.equal(vm.runInContext('typeof Game', w.ctx), 'undefined', 'no rule file ran');
});
