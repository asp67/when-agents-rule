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

// A model as a policy. `cfg` = {name, endpoint, model, provider, maxTokens, contextSize,
// language, reqOpts, auth, promptPrefix | systemPrompt}; reqOpts are the fixed request parameters (temperature,
// topP, reasoning, extraBody, ...). `fetchImpl` defaults to Node's fetch.
function modelPolicy(cfg, { fetchImpl = globalThis.fetch } = {}) {
    if (!cfg || !cfg.endpoint) throw new Error('modelPolicy: an endpoint is required');
    return async ({ round, state, episode }) => {
        const { mgr, realm, subjectController: c } = episode;
        if (round === 1) {
            const M = mgr.constructor;   // a class declaration is not a property of the VM global
            c.model = {
                name: cfg.name || cfg.model, endpoint: cfg.endpoint, model: cfg.model || 'default',
                // As the seat declares it: an unset maxTokens stays unset (the request
                // then carries none, as the arena seat's does).
                provider: cfg.provider || 'openai', maxTokens: cfg.maxTokens == null ? null : cfg.maxTokens,
                contextSize: cfg.contextSize || null, language: cfg.language || 'en',
                auth: cfg.auth || { type: 'none' },
                // The fixed parameters ride where the arena keeps learned ones, so the
                // request carries exactly them and nothing learns on top.
                _reqOpts: Object.assign({}, cfg.reqOpts || {}),
                // The seat's own prompt, as its arena seat plays it: a whole template
                // (systemPrompt) or the default with a prefix line (promptPrefix, e.g.
                // "Do not overthink."). Only the victory paragraph becomes the objective.
                customSystemPrompt: M.scenarioSystemPrompt(episode.objective,
                    cfg.systemPrompt != null ? cfg.systemPrompt
                        : cfg.promptPrefix != null ? String(cfg.promptPrefix) + '\n\n' + M.defaultSystemPrompt() : null),
            };
            c.lanes = [c];
            c._strict = true;
            // The send loop's own machinery, lent to the realm (it has no timers or
            // network of its own: nothing in the rules may use them).
            Object.assign(realm.context, { AbortController, setTimeout, clearTimeout, fetch: fetchImpl });
        }
        const envelope = await mgr.sendToOpenAI(c, state);
        return envelope && !envelope.noAction ? envelope : null;
    };
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
