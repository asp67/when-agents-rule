'use strict';
// The analyzer's re-simulation worker (js/resim-worker.js) as a browser runs it, for the
// tests that need a recorded sample under its own rules: the worker script in a global of
// its own, with fetch serving a rule checkpoint's files from the git history at that
// commit (as raw.githubusercontent.com would) and the page's own files from js/.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 });
const hasGit = (() => { try { execFileSync('git', ['rev-parse', '--git-dir'], { cwd: ROOT, stdio: 'ignore' }); return true; } catch (e) { return false; } })();
const INDEX = JSON.parse(fs.readFileSync(path.join(ROOT, 'rules/checkpoints.json'), 'utf8'));
const raw = commit => 'https://raw.githubusercontent.com/' + INDEX.repo + '/' + commit + '/';

function workerRealm() {
    const blobs = new Map(), out = [];
    const ctx = vm.createContext({
        console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
        setTimeout, clearTimeout, Math, Date, performance, Promise, Proxy, Uint8ClampedArray, JSON,
        Blob: class { constructor(parts) { this.text = parts.join(''); } },
        URL: { createObjectURL: b => { const k = 'blob:' + blobs.size; blobs.set(k, b.text); return k; } },
        fetch: async url => {
            const r = String(url).match(/^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/([0-9a-f]{40})\/(.+)$/);
            if (r) { try { const text = git('show', r[1] + ':' + r[2]); return { ok: true, text: async () => text }; } catch (e) { return { ok: false }; } }
            const file = path.join(ROOT, 'js', String(url).split('?')[0]);
            return fs.existsSync(file) ? { ok: true, text: async () => fs.readFileSync(file, 'utf8') } : { ok: false };
        },
        postMessage: m => out.push(m),
        Worker: class { terminate() {} },
    });
    ctx.self = ctx;
    ctx.importScripts = (...urls) => urls.forEach(u => vm.runInContext(blobs.get(u), ctx, { filename: u }));
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/resim-worker.js'), 'utf8'), ctx, { filename: 'js/resim-worker.js' });
    // The reply is the last message a call posts; loading and progress notes come first.
    const send = async data => { await ctx.onmessage({ data }); return out[out.length - 1]; };
    return { send, ctx, out, run: s => vm.runInContext(s, ctx) };
}

// A shipped sample (by file-name prefix): its records, and the checkpoint its contract names.
function sample(prefix) {
    const file = fs.readdirSync(path.join(ROOT, 'samples')).find(f => f.startsWith(prefix));
    const recs = fs.readFileSync(path.join(ROOT, 'samples', file), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
        .filter(r => r.type === 'match' || r.type === 'contract' || r.type === 'input');
    const c = recs.find(r => r.type === 'contract');
    const version = INDEX.versions.find(v => v.coreHash === c.coreHash && v.harnessHash === c.harnessHash) || null;
    return { file, recs, version };
}

module.exports = { workerRealm, sample, raw, git, hasGit, INDEX, ROOT };
