'use strict';
// WAR Bench bundles (review #8 step 7): a run recorded so anyone can check it later
// without calling a model and without the WAR that made it.
//
// A bundle is gzipped JSON lines (*.warbench.jsonl.gz), hash-chained: every record
// carries `prev`, the SHA-256 of the line before it, so no line can be changed, dropped
// or reordered without breaking the chain from there on. It holds, in order:
//
//   header      schema, protocol (round length, ceiling), policy, core and harness
//               hashes, the path -> blob map of every rule file and scenario used, and
//               since b1097 of js/bench-core.js: the scenario code the run was played by
//   blob        a file's text, content-addressed by its SHA-256: every rule file (the
//               manifest's own vm list) and every scenario, so verify replays on the
//               rules the run had -- a GitHub Pages copy of WAR is only ever the latest
//   episode     scenario, variant, attempt
//   round       the state's hash (what the seat was sent), the policy's answer, the
//               wire exchange for a model (request hash, response body), the
//               executor's results and outcome codes, and the world's hash after the step
//   end         outcome, rounds, and the world's full snapshot at the episode's end;
//               since b1091 also the partial score of an episode that ran out of time,
//               and `stopped: 'time'` when a run's wall-clock limit cut it short
//   close       the score of the whole run
//
// verify(bundle) checks the chain and the blobs, builds a realm from the EMBEDDED rules,
// and replays every episode: baselines from their recorded answers, models by serving
// their recorded response back through the arena's own send path once the request
// matches byte for byte. Every state, result and world hash must come out the same.
// A bundle that carries its bench core is replayed by that core, so a later fix to the
// bench cannot make an honest old run look forged; one recorded before b1097 has none
// and is replayed by today's, and verify says so beside any difference it finds.
// Requests that failed (a dropped connection, the ceiling's abort) are recorded too,
// and fail again at the same point of the replay: without them every later reply was
// served one round early.
const zlib = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const vm = require('node:vm');
const S = require('./scenario.cjs');
const { RULE_FILES, ROOT, Realm } = require('./realm.cjs');
const { modelPolicy } = require('./runner.cjs');
const { score } = require('./score.cjs');

const W = require('../../js/bench-core.js');
const SCHEMA = W.BUNDLE_SCHEMA;
const sha = s => createHash('sha256').update(s).digest('hex');
const lf = s => s.split('\r\n').join('\n');

// The rule sources a run is made of, as the page would load them, and the bench core
// that plays the scenarios (not part of the core hash, which is the game's rules).
function ruleSources() {
    return Object.fromEntries(RULE_FILES.concat(CORE_FILE).map(f => [f, lf(fs.readFileSync(path.join(ROOT, f), 'utf8'))]));
}
const CORE_FILE = 'js/bench-core.js';
// A bench core from its text, in a context of its own.
function loadCore(text) {
    const ctx = vm.createContext({});
    vm.runInContext(text + '\n;globalThis.__core = WarBench;', ctx, { filename: CORE_FILE });
    return ctx.__core;
}
// The fingerprint WarConditions computes in the page: its core files, joined.
function coreHashOf(sources) {
    const vm = require('node:vm'), ctx = vm.createContext({});
    vm.runInContext(sources['js/manifest.js'] + '\n;globalThis.__m = WarManifest;', ctx);
    return sha(Array.from(ctx.__m.rules).map(f => sources[f]).join('\n'));
}

// A fetch that records every exchange of one episode (for a model policy).
function recordingFetch(inner, sink) {
    return async (url, init) => {
        const request = String(init && init.body);
        let res;
        try { res = await inner(url, init); }
        catch (e) { sink.push({ requestHash: sha(request), error: { name: (e && e.name) || 'Error', message: (e && e.message) || String(e) } }); throw e; }
        const text = await res.text();
        sink.push({ requestHash: sha(request), status: res.status, response: text });
        return { ok: res.ok, status: res.status, headers: res.headers || { get: () => null },
                 text: async () => text, json: async () => JSON.parse(text) };
    };
}
// ...and one that plays a recorded episode back: it refuses any request that differs
// from the one recorded, which is what proves the request builder unchanged.
function replayFetch(exchanges) {
    let i = 0;
    return async (url, init) => {
        const x = exchanges[i++];
        if (!x) throw new Error('replay: the replay asked for more requests than were recorded');
        if (sha(String(init && init.body)) !== x.requestHash) throw new Error('replay: request ' + i + ' differs from the one recorded');
        if (x.error) { const err = new Error(x.error.message); err.name = x.error.name; throw err; }
        return { ok: x.status >= 200 && x.status < 300, status: x.status, headers: { get: () => 'application/json' },
                 text: async () => x.response, json: async () => JSON.parse(x.response) };
    };
}

// Play one episode with recording hooks: each round's state hash, answer and results,
// and the world hash after the step.
async function recordEpisode(s, variant, policy, options, wire) {
    const rounds = [];
    const answers = [];
    const tapped = async turn => {
        const before = wire ? wire.length : 0;
        const answer = await policy(turn);
        answers.push({ round: turn.round, stateHash: sha(JSON.stringify(turn.state)), answer: answer == null ? null : JSON.parse(JSON.stringify(answer)),
                       wire: wire ? wire.slice(before) : undefined });
        return answer;
    };
    let realmRef = null;
    const r = await S.play(s, variant, async turn => { realmRef = turn.episode.realm; return tapped(turn); },
        Object.assign({}, options, { onRoundEnd: (entry, ep) => rounds.push({ entry, worldHash: ep.realm.hash() }) }));
    rounds.forEach((x, i) => Object.assign(x, answers[i]));
    return { result: r, rounds, snapshot: realmRef ? realmRef.snapshot() : null };
}

// Record a run as bundle lines. `policy` = {name, kind: 'baseline' | 'model', make(s,
// v, a, wire) -> policy}; a model's make receives the wire sink to record into.
// `onLine(line)` receives every line as it is made (a long model run streams its bundle
// to disk, so an interruption still leaves everything recorded so far);
// `onEpisode(result, index, total)` reports progress.
async function record({ scenarios, policy, variants = null, attempts = 1, ceilingMs = S.CEILING_MS, sources = ruleSources(),
                        label = null, onLine = null, onEpisode = null }) {
    const chain = W.bundleChain(sha, onLine);
    W.bundleOpen(chain, { sha, sources, scenarios, policy, label, ceilingMs, variants, attempts, coreHash: coreHashOf(sources) });
    const results = [];
    const total = scenarios.reduce((n, s) => n + (variants || s.variants).length * attempts, 0);
    for (const s of scenarios) for (const v of (variants || s.variants)) for (let a = 1; a <= attempts; a++) {
        const wire = policy.kind === 'model' ? [] : null;
        const ep = await recordEpisode(s, v, policy.make(s, v, a, wire), { ceilingMs, sources }, wire);
        ep.result.attempt = a;
        W.bundleEpisode(chain, { id: s.id, variant: v, attempt: a }, ep.rounds.map(x => ({ round: x.round, stateHash: x.stateHash,
            answer: x.answer, wire: x.wire, results: x.entry.results, outcomes: x.entry.outcomes || [], rival: x.entry.rival,
            worldHash: x.worldHash, after: x.entry.after })), ep.result, ep.snapshot);
        results.push(ep.result);
        if (onEpisode) onEpisode(ep.result, results.length, total);
    }
    W.bundleClose(chain, results);
    return chain.lines;
}

function write(lines, file) { fs.writeFileSync(file, zlib.gzipSync(lines.join('\n') + '\n')); return file; }
// Gzipped as war-bench writes it, or plain JSON lines as a browser without
// CompressionStream saves it (js/bench-page.js).
function readLines(file) {
    const raw = fs.readFileSync(file);
    const gz = raw.length > 1 && raw[0] === 0x1f && raw[1] === 0x8b;
    return (gz ? zlib.gunzipSync(raw) : raw).toString('utf8').split('\n').filter(Boolean);
}

// Check a bundle: the chain, the blobs, and a full replay on the embedded rules.
async function verify(lines) {
    const problems = [];
    const say = m => { problems.push(m); };
    let prev = null;
    const recs = [];
    lines.forEach((line, i) => {
        let r;
        try { r = JSON.parse(line); } catch (e) { say(`line ${i + 1}: not JSON`); return; }
        if (r.prev !== prev) say(`line ${i + 1}: hash chain broken`);
        prev = sha(line);
        recs.push(r);
    });
    const head = recs[0];
    if (!head || head.type !== 'header' || head.schema !== SCHEMA) return { ok: false, problems: ['no ' + SCHEMA + ' header'].concat(problems) };
    const blobs = new Map();
    for (const r of recs) if (r.type === 'blob') {
        if (sha(r.text) !== r.sha256) say('a blob does not match its hash: ' + r.sha256.slice(0, 12));
        blobs.set(r.sha256, r.text);
    }
    const sources = {}, scenarios = new Map();
    for (const [p, h] of Object.entries(head.files)) {
        if (!blobs.has(h)) { say('missing blob for ' + p); continue; }
        if (p.startsWith('scenario:')) scenarios.set(p.slice(9), JSON.parse(blobs.get(h)));
        else sources[p] = blobs.get(h);
    }
    if (coreHashOf(sources) !== head.coreHash) say('the embedded rules do not hash to the recorded core hash');
    if (problems.length) return { ok: false, problems };
    // The bench core the run was played by, when the bundle carries it.
    const Wv = sources[CORE_FILE] ? loadCore(sources[CORE_FILE]) : W;
    const makeRealm = () => new Realm({ seed: 1, sources, core: Wv });
    // Replay every episode on the embedded rules.
    const results = [];
    for (let i = 0; i < recs.length; i++) {
        const e = recs[i];
        if (e.type !== 'episode') continue;
        const rounds = [];
        let j = i + 1;
        for (; recs[j] && recs[j].type === 'round'; j++) rounds.push(recs[j]);
        const end = recs[j];
        const s = scenarios.get(e.id);
        const label = `${e.id}/${e.variant}/${e.attempt}`;
        const answers = new Map(rounds.map(r => [r.round, r]));
        let policy;
        if (head.policy.kind === 'model') {
            const exchanges = rounds.flatMap(r => r.wire || []);
            policy = Wv.modelPolicy(head.policy.config, { fetchImpl: replayFetch(exchanges), timers: { AbortController, setTimeout, clearTimeout } });
        } else policy = ({ round }) => { const r = answers.get(round); return r ? r.answer : null; };
        let k = 0;
        const checkState = async turn => {
            const want = answers.get(turn.round);
            if (want && sha(JSON.stringify(turn.state)) !== want.stateHash) say(`${label} round ${turn.round}: the state differs from the one recorded`);
            return policy(turn);
        };
        let r;
        try {
            // An episode the run's clock stopped is replayed to the same round.
            const stopAfter = end && end.type === 'end' && end.stopped ? end.rounds : null;
            r = await Wv.play(s, e.variant, checkState, { ceilingMs: head.protocol.ceilingMs, makeRealm, stopAfter,
                onRoundEnd: (entry, ep) => {
                    const want = rounds[k++];
                    if (!want) { say(`${label}: more rounds than recorded`); return; }
                    if (entry.results !== want.results) say(`${label} round ${entry.round}: results differ`);
                    if (ep.realm.hash() !== want.worldHash) say(`${label} round ${entry.round}: the world differs after the step`);
                } });
        } catch (err) { say(`${label}: replay failed: ${err.message}`); continue; }
        if (k !== rounds.length) say(`${label}: ${rounds.length} rounds recorded, ${k} replayed`);
        if (!end || end.type !== 'end' || r.outcome !== end.outcome) say(`${label}: outcome ${r.outcome}, recorded ${end && end.outcome}`);
        else if ((r.score == null ? null : r.score) !== (end.score == null ? null : end.score)) say(`${label}: score ${r.score}, recorded ${end.score}`);
        r.attempt = e.attempt;
        results.push(r);
    }
    const close = recs[recs.length - 1];
    if (!close || close.type !== 'close') say('no closing record');
    else if (JSON.stringify(Wv.score(results)) !== JSON.stringify(close.score)) say('the replayed score differs from the recorded one');
    if (problems.length && Wv === W) problems.push('note: this bundle predates b1097 and carries no bench core, so it was replayed by today\'s; a difference may be a later fix to the bench rather than a change to the run');
    return { ok: !problems.length, problems, episodes: results.length, coreHash: head.coreHash, policy: head.policy.name,
             score: close && close.score };
}

module.exports = { SCHEMA, record, verify, write, readLines, ruleSources, coreHashOf, recordingFetch, replayFetch, sha, loadCore, CORE_FILE };
