'use strict';
// The WAR Bench runner (review #8 step 4): plays scenarios round by round with the
// frozen-step protocol -- observe, request, collect under the declared ceiling,
// execute, advance exactly ROUND_MS in 50 ms steps -- for any policy: a baseline, or a
// model reached over the OpenAI-compatible wire.
//
// A model seat is the ARENA's seat, not a lookalike. Its turn goes through the arena's
// own sendToOpenAI: the same request builder (buildTurnRequest), the same parser, the
// same rolling history. Three things are switched off, by the seat's strict flag, so a
// score belongs to the request that was declared and not to one the harness repaired:
// parameter adaptation after a refusal, the rate-limit retry, and context shrinking.
// Parameters an endpoint refuses belong in the run's model config, found beforehand in
// a calibration call; at run time a refusal is a failed round.
const S = require('./scenario.cjs');
const W = require('../../js/bench-core.js');

// A model as a policy (WarBench.modelPolicy), with Node's fetch and timers lent to the
// realm. `cfg` = {name, endpoint, model, provider, maxTokens, contextSize, language,
// reqOpts, auth, promptPrefix | systemPrompt}.
function modelPolicy(cfg, { fetchImpl = globalThis.fetch } = {}) {
    return W.modelPolicy(cfg, { fetchImpl, timers: { AbortController, setTimeout, clearTimeout } });
}

// Every scenario x variant x attempt, in a fixed order; one result per episode.
async function runSuite(scenarios, makePolicy, { variants = null, attempts = 1, ceilingMs = S.CEILING_MS, onEpisode = null } = {}) {
    const results = [];
    for (const s of scenarios) for (const v of (variants || s.variants)) for (let a = 1; a <= attempts; a++) {
        const r = await S.play(s, v, makePolicy(s, v, a), { ceilingMs });
        r.attempt = a;
        results.push(r);
        if (onEpisode) onEpisode(r);
    }
    return results;
}

module.exports = { modelPolicy, runSuite };
