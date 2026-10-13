// ---------------------------------------------------------------------------
// One WAR Bench episode, in a worker (b1091): the browser's host for js/bench-core.js.
//
// Each episode gets a worker of its own, as each gets a VM context of its own in Node
// (tools/bench/realm.cjs): a fresh global, the rules loaded from scratch, nothing left
// over from the last episode. The stage is built exactly as the Node realm builds it --
// the seeded Math.random, the stepped clock, the inert page -- by the same functions
// (WarBench.stageGlobals, makeGame, setupBoard), so an episode played here is the episode
// `war-bench verify` replays in Node, round for round and hash for hash.
//
// The page sends the texts it loaded (the manifest's vm list, js/bench-core.js) rather
// than URLs: one fetch per run instead of one per episode, and the texts the bundle
// embeds are the texts that ran.
//
// Messages in:  {type:'run', texts:{file:text}, scenario, variant, attempt,
//                policy:{kind:'baseline', name} | {kind:'model', cfg},
//                ceilingMs, deadline (real ms since the epoch, or null)}
// Messages out: {type:'round', round, rounds, ms, outcomes}     after each round
//               {type:'done', result, rounds:[...bundle round records], snapshot,
//                tokens:{prompt, completion}, ms:[real ms per answer]}
//               {type:'error', problem}
// ---------------------------------------------------------------------------
'use strict';
// The real clock, kept before the stage replaces it: answers are timed in real
// milliseconds, and the run's wall-clock limit is real time.
const RealDate = Date;
const realNow = () => RealDate.now();
const realFetch = self.fetch.bind(self);
const quiet = console.log.bind(console);

function load(name, text) {
    importScripts(URL.createObjectURL(new Blob([text], { type: 'text/javascript' })));
}

// A fetch that records every exchange, as tools/bench/bundle.cjs's recordingFetch does,
// so the bundle can serve them back to `war-bench verify`.
function recordingFetch(sink, sha) {
    return async (url, init) => {
        const request = String(init && init.body);
        const res = await realFetch(url, init);
        const text = await res.text();
        sink.push({ requestHash: sha(request), status: res.status, response: text });
        return { ok: res.ok, status: res.status, headers: res.headers || { get: () => null },
                 text: async () => text, json: async () => JSON.parse(text) };
    };
}

async function run({ texts, scenario, variant, attempt, policy, ceilingMs, deadline }) {
    // The core first: it builds the runtime from the real Math and Date, before the
    // stage puts the seeded ones in their place.
    load('js/bench-core.js', texts['js/bench-core.js']);
    const W = self.WarBench;
    const realm = { seed: 1, presentation: {}, rafQueue: [],
        exec: code => (0, eval)(code),
        lend: values => Object.assign(self, values) };
    realm.runtime = W.createRuntime(realm.seed);
    for (const [k, v] of Object.entries(W.stageGlobals(realm, { hidden: false })))
        Object.defineProperty(self, k, { value: v, writable: true, configurable: true });
    self.window = self;
    load('js/manifest.js', texts['js/manifest.js']);
    for (const f of self.WarManifest.vm) load(f, texts[f]);
    realm.game = W.makeGame(realm, 1);
    // Nothing may move this world but the episode. A hidden page's game ticks itself
    // from a timer worker (Game.initBackgroundDriver); it is marked as already tried.
    realm.game._bgDriverTried = true;
    let made = false;
    const makeRealm = () => { if (made) throw new Error('one realm per worker'); made = true; return realm; };

    const sha = self.warSha256;
    const wire = policy.kind === 'model' ? [] : null;
    let inner;
    if (policy.kind === 'model') inner = W.modelPolicy(policy.cfg, { fetchImpl: recordingFetch(wire, sha) });
    else if (W.BASELINES[policy.name]) inner = W.BASELINES[policy.name](scenario, variant, attempt);
    else throw new Error('unknown policy ' + policy.name);

    const rounds = [], ms = [];
    let pending = null;
    const tapped = async turn => {
        const before = wire ? wire.length : 0;
        const t0 = realNow();
        const answer = await inner(turn);
        ms.push(realNow() - t0);
        pending = { round: turn.round, stateHash: sha(JSON.stringify(turn.state)),
                    answer: answer == null ? null : JSON.parse(JSON.stringify(answer)),
                    wire: wire ? wire.slice(before) : undefined, ms: ms[ms.length - 1] };
        return answer;
    };
    const result = await W.play(scenario, variant, tapped, {
        makeRealm, ceilingMs,
        shouldStop: () => deadline != null && realNow() > deadline,
        onRoundEnd: (entry, ep) => {
            const x = pending; pending = null;
            rounds.push({ type: 'round', round: x.round, stateHash: x.stateHash, answer: x.answer, wire: x.wire,
                results: entry.results, outcomes: entry.outcomes || [], rival: entry.rival,
                worldHash: sha(JSON.stringify(W.snapshot(realm))).slice(0, 16), after: entry.after, ms: x.ms });
            self.postMessage({ type: 'round', round: entry.round, rounds: ep.inst.rounds, ms: x.ms, outcomes: entry.outcomes || [] });
        },
    });
    result.attempt = attempt;
    const stats = (realm.controllers && realm.controllers[0] && realm.controllers[0].stats) || {};
    return { type: 'done', result, rounds, snapshot: W.snapshot(realm),
             tokens: { prompt: stats.promptTokens || 0, completion: stats.completionTokens || 0 }, ms };
}

self.onmessage = async ({ data }) => {
    if (!data || data.type !== 'run') return;
    try { self.postMessage(await run(data)); }
    catch (e) {
        self.postMessage({ type: 'error', problem: (e && e.message) || String(e) });
        quiet('[bench]', e);
    }
};
