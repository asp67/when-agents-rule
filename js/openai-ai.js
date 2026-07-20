// LLM harness for non-human players: builds each model's per-turn game-state JSON,
// shapes provider-specific requests (OpenAI / Anthropic / Ollama / Google), parses
// the ONE action per reply, executes it, and feeds the outcome back next turn.
// Controllers come from the setup screen via initFromSetup (Arena and Campaign).

class OpenAIAIManager {
    constructor(game) {
        this.game = game;
        this.aiControllers = []; // One per AI player
        this.currentControllerIndex = 0;
        this.turnInterval = 1500; // Small breather between a model's own turns. The real
                                  // limiter is each model's own latency, so a fast model
                                  // naturally takes more turns — its speed is an intended
                                  // advantage. Each model runs its own pipeline (see update()).
        this.requestTimeout = 180000; // Abort a model request after this many ms. Generous so
                                      // slower local models (Ollama) get a chance; very large or
                                      // reasoning models on modest hardware may still exceed it —
                                      // use a smaller/faster model for the real-time arena.
        // Turn-based mode (see updateTurnBased). Off = independent pipelines, latency
        // is a real advantage. On = every seat decides the same frozen state, so the
        // decision budget is identical and only judgement varies.
        this.turnBased = false;
        this._roundPhase = 'ask';   // 'ask' -> 'wait' -> 'advance' -> 'ask'
        this._roundBudget = 0;      // sim ms still owed to the round being played out
        this._roundStartedAt = 0;
        this.pendingRequests = new Map(); // controllerId -> Promise
        this._orderSeq = 0; // monotonic token stamped on a unit each time it gets a new
                            // move/attack order, so a deferred attack-arrival report can
                            // tell which units are still on that order vs reassigned.
        this._stopped = false; // set true when the match ends/restarts: aborts in-flight
                               // requests and makes any late resolution a no-op, so the
                               // previous match's models can't mutate the next one.
        this.decisionLog = []; // Array of { timestamp, playerId, civName, action, reason }
        this.maxLogEntries = 400; // keep a deep decision history for the spectator log
        this.maxHistoryEntries = 400; // how many past moves we RETAIN in memory; how
                                 // many are actually SENT is chosen per turn by budget.
    }

    // Per-controller behavior metrics (reset each match)
    // How many food/wood nodes each Town Center contributes to "nearestNodes".
    // Stone and gold ignore it — they are scarce enough to list whole.
    static get NEAREST_PER_ANCHOR() { return 10; }

    newStats() {
        return {
            requests: 0,          // requests that returned or definitively failed
            latencies: [],        // ms per request that produced a response
            timeouts: 0,
            networkErrors: 0,
            contextOverflows: 0,  // request too big for the model's context (lost turn; endpoint fine)
            promptTokens: 0,      // cumulative token usage as reported by the provider
            completionTokens: 0,  // (0/0 when the endpoint doesn't report usage)
            parseFails: 0,        // response unusable: empty, truncated, or parser crashed
            truncatedReplies: 0,  // ...of those, cut off mid-JSON by the output-token cap
            noActionReturns: 0,   // model answered in prose with NO JSON action — nothing executed
            actionsAttempted: 0,  // actions handed to executeAction
            actionsSucceeded: 0,  // executed OK
            actionsRejected: 0,   // understood but failed (cost, pop, duplicate, ...)
            invalidActions: 0,    // unknown action name
            reasonsGiven: 0,      // decisions that included a non-empty reason
            actionCounts: {}      // attempted action name -> count
        };
    }

    // ---- Helpers for clear, complete error feedback to the model ----
    costString(cost) {
        const parts = [];
        ['food', 'wood', 'stone', 'gold'].forEach(r => { if (cost && cost[r]) parts.push(`${cost[r]} ${r}`); });
        return parts.length ? parts.join(', ') : 'nothing';
    }
    // Record a structured, localizable version of the outcome the decision log will
    // show in the MODEL's language. The English string the caller RETURNS is
    // unchanged and still goes to the model verbatim — this is display-only
    // metadata, read once per action in executeAction. Covered outcomes call this
    // right before returning; uncovered ones don't, and the log falls back to the
    // English text. See ui.renderOutcome / I18N_OUTCOMES.
    outcome(code, params) { this._pendingOutcome = { code, params: params || {} }; return true; }
    haveString(ai) {
        const r = ai.resources;
        return `${Math.floor(r.food)} food, ${Math.floor(r.wood)} wood, ${Math.floor(r.stone)} stone, ${Math.floor(r.gold)} gold`;
    }
    // Stock as a {food,wood,stone,gold} object — the localized log renders it as
    // language-neutral emoji, so no resource words to translate.
    haveObj(ai) {
        const r = ai.resources;
        return { food: Math.floor(r.food), wood: Math.floor(r.wood), stone: Math.floor(r.stone), gold: Math.floor(r.gold) };
    }
    // Convert a worker "pulledFrom" label map (idle / scouting / repairing / farming
    // / spare / "from wood") into the {idle,scout,repair,farm,spare,<resource>} shape
    // the log localizes (resource keys → the resource word, the rest → a pull label).
    pulledCounts(pulledFrom) {
        const out = {};
        Object.keys(pulledFrom || {}).forEach(k => {
            const key = k === 'scouting' ? 'scout' : k === 'repairing' ? 'repair' : k === 'farming' ? 'farm'
                : k.startsWith('from ') ? k.slice(5) : k;
            out[key] = (out[key] || 0) + pulledFrom[k];
        });
        return out;
    }
    // Which building type trains a given unit (for precise "build X first" messages)
    requiredBuildingForUnit(unitType, civilization = null) {
        if (unitType === 'worker') return 'town_center';
        if (typeof BUILDING_TRAIN_TIERS !== 'undefined') {
            for (const bld of Object.keys(BUILDING_TRAIN_TIERS)) {
                for (const list of Object.values(BUILDING_TRAIN_TIERS[bld])) {
                    if (Array.isArray(list) && list.includes(unitType)) return bld;
                }
            }
        }
        // Civ-unique units (Greek hoplite, Egypt's horse carriage) are NOT in the
        // shared tier table — they carry their own trainAt. Without this the staged
        // research→build→advance error chain was skipped for exactly the units a
        // model is least likely to understand, and they fell through to a bare
        // "no building available" instead.
        if (civilization && typeof getCivilization === 'function') {
            const u = ((getCivilization(civilization) || {}).uniqueUnits || [])
                .find(x => x.id === unitType);
            if (u && u.trainAt) return u.trainAt;
        }
        // Priests and workers come from buildings with a static trainOptions list
        // rather than an age-tiered one.
        if (typeof BUILDING_DEFS !== 'undefined') {
            for (const bld of Object.keys(BUILDING_DEFS)) {
                const def = getBuildingDef(bld);
                if (def && Array.isArray(def.trainOptions) && def.trainOptions.includes(unitType)) return bld;
            }
        }
        return null;
    }

    // ---- Map grid ("A1".."G7") -------------------------------------------------
    // Columns A..G run west→east (x), rows 1..7 north→south (z). One label instead
    // of a (row, col) pair or a pair of coordinate arrays: every intermediate form
    // we tried invited a transposition that was legal, silent and wrong — a mirrored
    // target is still a valid map position, so nothing could ever report it.
    tileLabel(row, col) {
        return String.fromCharCode(65 + col) + (row + 1);
    }

    // "c5" / "C5" → {row, col}, or null. Deliberately strict about SHAPE (letter then
    // digit) so "5C" fails loudly rather than being quietly reinterpreted.
    parseTile(label, T) {
        const m = /^\s*([A-Za-z])\s*(\d+)\s*$/.exec(String(label || ''));
        if (!m) return null;
        const col = m[1].toUpperCase().charCodeAt(0) - 65;
        const row = parseInt(m[2], 10) - 1;
        if (!(col >= 0 && col < T && row >= 0 && row < T)) return null;
        return { row, col };
    }

    // Which tile is this world position in?
    tileAt(game, x, z) {
        return game.tileLabelAt(x, z);
    }

    // The tiles this player actually holds, busiest first, for error messages that
    // want to anchor the model ("your bases are in D1, G7"). Never a centroid: with
    // two bases that averages to a tile it owns nothing in.
    baseTilesString(ai, game) {
        const counts = {};
        (ai.buildings || []).forEach(b => {
            const k = this.tileAt(game, b.x, b.z);
            counts[k] = (counts[k] || 0) + 1;
        });
        const tiles = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
        return tiles.length ? tiles.join(', ') : '(you hold no tiles — you have no buildings left)';
    }

    // A point inside tile {row,col}, inset so the scout sits well within the tile
    // rather than straddling its border. Random rather than the centre on purpose:
    // one stop reveals only a few percent of a 114-unit tile, so repeated explores
    // of the same tile need to land in different parts of it to fill it in.
    pointInTile(game, row, col, inset) {
        const T = game.EXPLORE_TILES || 7;
        const size = (game.terrain && game.terrain.size) || 800;
        const cell = size / T, half = size / 2;
        const pad = Math.min(inset || 0, cell / 2 - 1);
        const x0 = col * cell - half + pad, x1 = (col + 1) * cell - half - pad;
        const z0 = row * cell - half + pad, z1 = (row + 1) * cell - half - pad;
        return game.clampToMap(x0 + Math.random() * (x1 - x0), z0 + Math.random() * (z1 - z0));
    }

    // Every unit this civilization can EVER train: the id, the building that makes
    // it, and the earliest age it appears. Mirrors buildingTrains() deliberately —
    // per-age tier options first, static trainOptions as the fallback — so the
    // vocabulary we ADVERTISE cannot drift from the one the executor ACCEPTS.
    // Civ uniques and exclusions come along for free, because
    // getTrainOptionsForBuilding already resolves both (Egypt fields horse
    // carriages and NO generic cavalry; a model could not have known that).
    trainableUnitsFor(civilization) {
        const ageOrder = ['stone', 'neolithic', 'bronze', 'iron'];
        const hosts = ['barracks', 'archery_range', 'stable', 'temple'];
        const seen = new Map();
        hosts.forEach(bt => {
            const def = (typeof getBuildingDef === 'function') ? getBuildingDef(bt) : null;
            const floor = (def && def.requiredAge) || 'stone';
            ageOrder.forEach(age => {
                // A unit can't predate the building that trains it: the temple is a
                // bronze-age structure, so its priest is bronze, not stone.
                if (ageOrder.indexOf(age) < ageOrder.indexOf(floor)) return;
                let opts = (typeof getTrainOptionsForBuilding === 'function')
                    ? getTrainOptionsForBuilding(bt, age, civilization) : null;
                if (!opts || !opts.length) opts = (def && def.trainOptions) || [];
                opts.forEach(id => { if (!seen.has(id)) seen.set(id, { id, at: bt, age }); });
            });
        });
        return [...seen.values()];
    }

    // The trainable vocabulary as one line, grouped by the building that makes it.
    // This is what an [ERROR] owes the model when it guesses a unit name wrong.
    trainableListString(ai) {
        const list = this.trainableUnitsFor(ai.civilization);
        if (!list.length) return 'Your civilization trains no military units.';
        const byHost = {};
        list.forEach(u => { (byHost[u.at] = byHost[u.at] || []).push(u.id); });
        const parts = Object.entries(byHost).map(([host, ids]) => `at ${host} — ${ids.join(', ')}`);
        return `Your civilization can train: ${parts.join('; ')}.`;
    }

    // Earliest age at which a unit can be trained (scans the train tiers). Lets us
    // tell the model to ADVANCE when a unit is gated to a later epoch.
    minAgeForUnit(unitType) {
        if (typeof BUILDING_TRAIN_TIERS === 'undefined') return null;
        const order = ['stone', 'neolithic', 'bronze', 'iron'];
        for (const bld of Object.keys(BUILDING_TRAIN_TIERS)) {
            const tiers = BUILDING_TRAIN_TIERS[bld];
            for (const age of order) {
                if (tiers[age] && tiers[age].includes(unitType)) return age;
            }
        }
        return null;
    }

    // True if a finished building of the right type/age can produce this unit.
    buildingTrains(b, unitType, age, civilization) {
        if (b.type === 'town_center') return unitType === 'worker';
        let opts = (typeof getTrainOptionsForBuilding === 'function') ? getTrainOptionsForBuilding(b.type, age, civilization || b.civilization) : null;
        if (!opts || !opts.length) opts = b.trainOptions || [];
        return opts.includes(unitType);
    }

    // --- Timing helpers: the model can't see the on-screen progress bars, so we
    // tell it how long timed actions take and how much is left. ---
    secsLeft(progress, duration) {
        return Math.max(0, Math.ceil(((duration || 0) - (progress || 0)) / 1000));
    }
    // Seconds for a unit to walk to (tx,tz). Matches the game loop's speed*3 u/s.
    travelEtaSec(unit, tx, tz) {
        const sp = (((unit && unit.speed) || 1.0) * 3) || 3;
        const d = Math.hypot(((unit && unit.x) || 0) - tx, ((unit && unit.z) || 0) - tz);
        return Math.max(1, Math.round(d / sp));
    }

    // fetch() with an abort timeout so unreachable endpoints fail fast
    async fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
        return OpenAIAIManager.fetchWithTimeout(url, options, timeoutMs);
    }

    static async fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
            return await fetch(url, { ...options, signal: ctrl.signal });
        } finally {
            clearTimeout(t);
        }
    }

    // ----------------------------------------------------------------
    // Flexible authentication for any OpenAI-compatible endpoint.
    // auth = { type: 'none'|'bearer'|'header'|'basic'|'oauth', ...creds }
    // ----------------------------------------------------------------
    static async buildAuthHeaders(auth, provider = 'openai') {
        const headers = { 'Content-Type': 'application/json' };
        const a = auth || { type: 'none' };

        // Resolve a single primary credential string from the common auth types.
        const primaryKey = async () => {
            if (a.type === 'bearer') return (a.key || '').trim();
            if (a.type === 'oauth') {
                let token = (a.accessToken || '').trim();
                if (!token && a.tokenUrl && a.clientId) token = await OpenAIAIManager.fetchOAuthToken(a);
                return token;
            }
            return '';
        };
        const applyCustomHeaders = () => {
            if (a.type === 'header') (a.headers || []).forEach(h => { if (h && h.name) headers[h.name] = h.value || ''; });
        };

        // Anthropic Messages API: key goes in x-api-key, plus version + browser-access.
        if (provider === 'anthropic') {
            headers['anthropic-version'] = '2023-06-01';
            headers['anthropic-dangerous-direct-browser-access'] = 'true';
            const key = await primaryKey();
            if (key) headers['x-api-key'] = key;
            applyCustomHeaders();
            return headers;
        }

        // Google Gemini: key in x-goog-api-key header (works on generativelanguage API).
        if (provider === 'google') {
            const key = await primaryKey();
            if (key) headers['x-goog-api-key'] = key;
            applyCustomHeaders();
            return headers;
        }

        // OpenAI-compatible (OpenAI, vLLM, LM Studio, LiteLLM, Together, Groq,
        // OpenRouter, DeepSeek, …) and Ollama: standard bearer/basic/header/oauth.
        if (!a.type || a.type === 'none') return headers;
        if (a.type === 'bearer') {
            if (a.key) headers['Authorization'] = `Bearer ${a.key}`;
        } else if (a.type === 'basic') {
            const raw = `${a.username || ''}:${a.password || ''}`;
            headers['Authorization'] = 'Basic ' + (typeof btoa === 'function' ? btoa(raw) : raw);
        } else if (a.type === 'header') {
            applyCustomHeaders();
        } else if (a.type === 'oauth') {
            const token = await primaryKey();
            if (token) headers['Authorization'] = `Bearer ${token}`;
        }
        return headers;
    }

    // ----------------------------------------------------------------
    // Provider adapters — speak OpenAI, Anthropic, Ollama, and Google
    // natively so any major inference endpoint works without a proxy.
    // ----------------------------------------------------------------
    static stripSlash(u) { return (u || '').replace(/\/+$/, ''); }
    static ollamaRoot(endpoint) {
        return OpenAIAIManager.stripSlash(OpenAIAIManager.stripSlash(endpoint).replace(/\/(v1|api)$/i, ''));
    }
    static detectProvider(endpoint = '') {
        const e = endpoint.toLowerCase();
        if (e.includes('anthropic.com')) return 'anthropic';
        if (e.includes('generativelanguage.googleapis') || e.includes('/v1beta')) return 'google';
        if (/:11434(\/|$)/.test(e) || e.includes('/api/chat') || e.includes('ollama')) return 'ollama';
        return 'openai';
    }
    static resolveProvider(model) {
        const p = (model && model.provider) || 'auto';
        return p === 'auto' ? OpenAIAIManager.detectProvider((model && model.endpoint) || '') : p;
    }

    // Build {url, body} for one chat turn. `turns` is the user/assistant history
    // (no system message); the system prompt is passed separately.
    static buildChatRequest(provider, endpoint, modelId, systemPrompt, turns, opts = {}) {
        const temperature = opts.temperature != null ? opts.temperature : 0.7;
        const maxTokens = opts.maxTokens != null ? opts.maxTokens : 2000;
        const model = modelId || 'default';

        if (provider === 'anthropic') {
            return {
                url: OpenAIAIManager.stripSlash(endpoint) + '/messages',
                body: {
                    model, max_tokens: maxTokens, temperature,
                    system: systemPrompt,
                    messages: turns.map(t => ({ role: t.role === 'assistant' ? 'assistant' : 'user', content: String(t.content) }))
                }
            };
        }
        if (provider === 'ollama') {
            return {
                url: OpenAIAIManager.ollamaRoot(endpoint) + '/api/chat',
                body: {
                    model, stream: false,
                    keep_alive: -1, // never auto-unload: the arena drives the model continuously
                    // Cap the context to a user-configurable size (default 32768).
                    // Ollama otherwise loads the model's FULL context (e.g. 128k for
                    // llama3.2), whose KV cache bloats VRAM and spills the model onto
                    // the CPU — making every turn crawl and time out. Lower this on
                    // smaller GPUs; raise it if your game state is large and you have
                    // the VRAM.
                    options: { temperature, num_predict: maxTokens, num_ctx: (opts.numCtx && opts.numCtx > 0) ? opts.numCtx : 32768 },
                    messages: [{ role: 'system', content: systemPrompt }, ...turns]
                }
            };
        }
        if (provider === 'google') {
            return {
                url: OpenAIAIManager.stripSlash(endpoint) + `/models/${encodeURIComponent(model)}:generateContent`,
                body: {
                    systemInstruction: { parts: [{ text: systemPrompt }] },
                    contents: turns.map(t => ({ role: t.role === 'assistant' ? 'model' : 'user', parts: [{ text: String(t.content) }] })),
                    generationConfig: { temperature, maxOutputTokens: maxTokens }
                }
            };
        }
        // openai-compatible (default)
        const body = {
            model, temperature, max_tokens: maxTokens,
            messages: [{ role: 'system', content: systemPrompt }, ...turns]
        };
        // If this "OpenAI-compatible" endpoint is actually an Ollama server (user
        // pointed at :11434 / picked OpenAI-compat), ask it to keep the model
        // resident so it isn't unloaded between turns. Only do this for detected
        // Ollama hosts — real OpenAI (and stricter gateways) reject unknown params.
        if (OpenAIAIManager.detectProvider(endpoint) === 'ollama') body.keep_alive = -1;
        return {
            url: OpenAIAIManager.stripSlash(endpoint) + '/chat/completions',
            body
        };
    }

    // Normalize any provider's response to { content, reasoning, tool_calls, finish_reason }.
    static normalizeResponse(provider, data) {
        if (provider === 'anthropic') {
            const blocks = Array.isArray(data.content) ? data.content : [];
            return {
                content: blocks.filter(b => b.type === 'text').map(b => b.text).join('\n'),
                reasoning: blocks.filter(b => b.type === 'thinking').map(b => b.thinking || '').join('\n'),
                tool_calls: null,
                finish_reason: data.stop_reason
            };
        }
        if (provider === 'ollama') {
            const msg = data.message || {};
            return { content: msg.content, reasoning: msg.thinking, tool_calls: msg.tool_calls, finish_reason: data.done_reason };
        }
        if (provider === 'google') {
            const cand = (data.candidates || [])[0];
            const parts = (cand && cand.content && cand.content.parts) || [];
            return { content: parts.map(p => p.text || '').join(''), reasoning: null, tool_calls: null, finish_reason: cand && cand.finishReason };
        }
        const message = (data.choices && data.choices[0] && data.choices[0].message) || {};
        return { content: message.content, reasoning: message.reasoning, tool_calls: message.tool_calls, finish_reason: data.choices && data.choices[0] && data.choices[0].finish_reason };
    }

    // "The reply hit the output cap", spelled differently by every provider:
    // OpenAI and Ollama say "length", Anthropic "max_tokens", Google "MAX_TOKENS".
    // Matching only "length" (as the first cut of this check did) silently misses
    // two of the four and reports their truncations as ordinary malformed JSON.
    static hitTokenCap(finishReason) {
        return /^(length|max_tokens)$/i.test(String(finishReason || ''));
    }

    // The provider's OWN usage object, verbatim. extractUsage reduces it to a
    // prompt/completion pair, which drops reasoning-token accounting and anything
    // provider-specific — exactly the fields wanted when a reply stops far short of
    // the cap that was asked for.
    static rawUsage(provider, data) {
        if (!data) return null;
        if (provider === 'ollama') {
            const { prompt_eval_count, eval_count, done_reason } = data;
            return (prompt_eval_count != null || eval_count != null)
                ? { prompt_eval_count, eval_count, done_reason } : null;
        }
        return data.usage || data.usageMetadata || null;
    }

    // Pull token usage out of a provider response (field names differ everywhere).
    // Returns { prompt, completion } or null when the provider didn't report usage.
    static extractUsage(provider, data) {
        try {
            if (provider === 'anthropic' && data.usage) {
                return { prompt: data.usage.input_tokens || 0, completion: data.usage.output_tokens || 0 };
            }
            if (provider === 'ollama') {
                if (data.prompt_eval_count != null || data.eval_count != null) {
                    return { prompt: data.prompt_eval_count || 0, completion: data.eval_count || 0 };
                }
                return null;
            }
            if (provider === 'google' && data.usageMetadata) {
                return { prompt: data.usageMetadata.promptTokenCount || 0, completion: data.usageMetadata.candidatesTokenCount || 0 };
            }
            if (data.usage) { // openai-compatible
                return { prompt: data.usage.prompt_tokens || 0, completion: data.usage.completion_tokens || 0 };
            }
        } catch (e) {}
        return null;
    }

    // OAuth2 client-credentials grant. Token is cached on the auth object.
    static async fetchOAuthToken(auth) {
        const now = Date.now();
        if (auth._token && auth._tokenExp && now < auth._tokenExp) return auth._token;
        const body = new URLSearchParams();
        body.set('grant_type', 'client_credentials');
        body.set('client_id', auth.clientId || '');
        if (auth.clientSecret) body.set('client_secret', auth.clientSecret);
        if (auth.scope) body.set('scope', auth.scope);
        const resp = await OpenAIAIManager.fetchWithTimeout(auth.tokenUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body
        }, 8000);
        if (!resp.ok) throw new Error(`OAuth token request failed (HTTP ${resp.status})`);
        const data = await resp.json();
        if (!data.access_token) throw new Error('OAuth response had no access_token');
        auth._token = data.access_token;
        auth._tokenExp = now + ((data.expires_in || 3600) - 60) * 1000;
        return auth._token;
    }

    // Probe an endpoint: returns { ok, models:[], error }. Used by the setup UI's
    // "Test connection" button so beginners can verify auth and pick a model.
    // Failures return { ok:false, errorCode, errorDetail?, error } — errorCode maps
    // to an ar.err.* i18n key so the UI shows the message in the active GUI language
    // (these used to be hardcoded German regardless of language); `error` stays an
    // English fallback for logs/non-UI callers.
    static async testConnection(endpoint, auth, provider = 'auto', timeoutMs = 9000) {
        if (!endpoint) return { ok: false, errorCode: 'noEndpoint', error: 'No endpoint URL set.' };
        const prov = provider === 'auto' ? OpenAIAIManager.detectProvider(endpoint) : provider;
        let headers;
        try {
            headers = await OpenAIAIManager.buildAuthHeaders(auth, prov);
        } catch (e) {
            const detail = (e && e.message) || String(e);
            return { ok: false, errorCode: 'authFailed', errorDetail: detail, error: 'Authentication failed: ' + detail };
        }
        // Each provider lists models from a different path.
        const url = prov === 'ollama'
            ? OpenAIAIManager.ollamaRoot(endpoint) + '/api/tags'
            : OpenAIAIManager.stripSlash(endpoint) + '/models';
        try {
            const resp = await OpenAIAIManager.fetchWithTimeout(url, { headers, mode: 'cors' }, timeoutMs);
            if (!resp.ok) {
                const detail = `${resp.status} ${resp.statusText || ''}`.trim();
                const code = (resp.status === 401 || resp.status === 403) ? 'httpAuth' : 'http';
                return { ok: false, errorCode: code, errorDetail: detail, error: 'HTTP ' + detail, provider: prov };
            }
            const data = await resp.json();
            let models;
            const contextById = {};
            if (prov === 'ollama') {
                models = (data.models || []).map(m => m.name || m.model).filter(Boolean);
                // /api/tags doesn't carry context length; the ↺ button does /api/show.
            } else {
                const list = data.data || data.models || [];
                models = list.map(m => (typeof m === 'string' ? m : (m.id || m.name))).filter(Boolean)
                    .map(id => id.replace(/^models\//, '')); // strip Google's "models/" prefix
                // Capture each model's context window when the endpoint reports it
                // (field name varies: OpenRouter/vLLM/LM Studio/Google all differ).
                list.forEach(m => {
                    if (!m || typeof m !== 'object') return;
                    const id = String(m.id || m.name || '').replace(/^models\//, '');
                    const ctx = m.context_length || m.max_model_len || m.context_window ||
                                m.max_context_length || m.n_ctx || m.inputTokenLimit ||
                                (m.limits && (m.limits.context_length || m.limits.max_context_tokens));
                    if (id && ctx && Number(ctx) >= 512) contextById[id] = Number(ctx);
                });
            }
            return { ok: true, models, provider: prov, contextById };
        } catch (e) {
            if (e && e.name === 'AbortError') {
                return { ok: false, errorCode: 'timeout', error: 'Timed out — endpoint unreachable.', provider: prov };
            }
            const detail = (e && e.message) || String(e);
            // fetch() reports CORS rejection, connection refused, DNS failure and a
            // dropped tunnel as the SAME opaque "Failed to fetch" — deliberately, so
            // a page cannot probe the network by reading error types. That left this
            // message guessing out loud ("CORS? Endpoint offline?") and sent people
            // hunting for CORS problems they did not have.
            //
            // A no-cors request cannot be rejected BY cors: the browser returns an
            // opaque response instead. So if this second attempt resolves, the server
            // answered and the first failure was the CORS policy; if it throws too,
            // nothing is listening. It is a simple GET with no custom headers, so it
            // says nothing about whether the KEY is right — only whether the host is
            // there.
            let reachable = false;
            try {
                await OpenAIAIManager.fetchWithTimeout(url, { mode: 'no-cors' }, 4000);
                reachable = true;
            } catch (_) { /* genuinely unreachable */ }
            return reachable
                ? { ok: false, errorCode: 'cors', errorDetail: detail, provider: prov,
                    error: 'The endpoint answered but the browser blocked the response (CORS).' }
                : { ok: false, errorCode: 'offline', errorDetail: detail, provider: prov,
                    error: 'No response from the endpoint — it is not reachable.' };
        }
    }

    // Best-effort fallback table of known context windows, keyed by id substring.
    // Used when an endpoint doesn't report a model's context length.
    static knownContextWindow(modelId, provider) {
        const id = (modelId || '').toLowerCase();
        const tbl = [
            [/claude/, 200000],
            [/gpt-4o|gpt-4\.1|gpt-4-turbo|gpt-4-(?:1106|0125|0613-preview)|o1|o3|o4/, 128000],
            [/gpt-4/, 8192],
            [/gpt-3\.5/, 16385],
            [/gemini-1\.5|gemini-2|gemini-exp/, 1000000],
            [/gemini/, 32768],
            [/llama-?3|llama3/, 8192],
            [/mixtral|mistral/, 32768],
            [/qwen/, 32768],
            [/phi/, 16384],
            [/deepseek/, 65536]
        ];
        for (const [re, v] of tbl) if (re.test(id)) return v;
        if (provider === 'anthropic') return 200000; // all current Claude models
        return null;
    }

    // Ask an Ollama server for a model's trained context length (/api/show).
    static async fetchOllamaContext(endpoint, model, auth) {
        try {
            const headers = await OpenAIAIManager.buildAuthHeaders(auth || { type: 'none' }, 'ollama');
            const resp = await OpenAIAIManager.fetchWithTimeout(
                OpenAIAIManager.ollamaRoot(endpoint) + '/api/show',
                { method: 'POST', headers, mode: 'cors', body: JSON.stringify({ name: model }) }, 8000);
            if (!resp.ok) return null;
            const d = await resp.json();
            const mi = d.model_info || {};
            for (const k in mi) { if (/\.context_length$/.test(k) && Number(mi[k]) >= 512) return Number(mi[k]); }
            return null;
        } catch (e) { return null; }
    }

    // ----------------------------------------------------------------
    // 2. Initialize from setup (per-player config; used by Arena AND Campaign)
    // ----------------------------------------------------------------
    // (The legacy models.json round-robin path — loadModels/initAndAssign/
    //  assignModelsToAIPlayers — became unreachable once Campaign switched to
    //  explicit per-opponent configs and was removed.)
    async initFromSetup(setup) {
        this.aiControllers = [];

        // Read the round mode from the saved arena config. A manager is built fresh per
        // match, so the flag has to be pulled in here or every new match silently
        // reverts to independent pipelines — which is a different benchmark.
        this.turnBased = !!(this.game && this.game.ui && this.game.ui.turnBasedEnabled
            && this.game.ui.turnBasedEnabled());
        this._roundPhase = 'ask';
        this._roundBudget = 0;
        this._roundStartedAt = 0;

        // Transcript recording, always on. begin() purges whatever the previous match
        // left behind, so a crash or a "Hauptmenü" reload (which cannot be relied on to
        // finish an async delete during unload) still yields a clean slate here.
        if (typeof TranscriptRecorder !== 'undefined') {
            this.transcripts = this.transcripts || new TranscriptRecorder();
            const stamp = new Date();
            const pad = n => String(n).padStart(2, '0');
            const matchId = `match-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}`
                + `-${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}`;
            await this.transcripts.begin(matchId, setup.map((s, i) => {
                const ai = this.game.aiManager.aiPlayers[i];
                return {
                    id: ai && ai.id, civilization: s.civ, seat: ai && ai.seat,
                    model: s.connection ? (s.connection.model || s.connection.name) : 'ki',
                    name: s.connection ? s.connection.name : null
                };
            }), {
                // The conditions a result has to be read against. Two runs with
                // different values here are not comparable, and six months from now
                // this line is the only thing that will say which was which.
                mapSeed: (this.game.terrain && this.game.terrain.seed) || null,
                difficulty: this.game.difficulty || null,
                mapSize: (this.game.terrain && this.game.terrain.size) || null,
                turnBased: !!this.turnBased,
                roundQuantumMs: this.turnBased ? OpenAIAIManager.ROUND_QUANTUM_MS : null,
                simSpeed: this.game.simSpeed || 1,
                wonderRequired: this.game.wonderRequired || null,
                promptVersion: (this.game.ui && this.game.ui.ARENA_PROMPT_VERSION) || null
            });
        }

        for (let i = 0; i < setup.length; i++) {
            const ai = this.game.aiManager.aiPlayers[i];
            const playerSetup = setup[i];

            if (playerSetup.type === 'ki') {
                // Rule-based AI, no LLM controller needed
                console.log(`[OpenAIAI] Player ${i + 1} (${ai.civilization}): Using rule-based AI`);
                continue;
            }

            // LLM player. New setup carries a `connection` (endpoint + auth + model);
            // fall back to the legacy flat fields for safety.
            const conn = playerSetup.connection || {
                name: playerSetup.name,
                endpoint: playerSetup.endpoint,
                model: playerSetup.model,
                provider: playerSetup.provider,
                auth: playerSetup.apiKey ? { type: 'bearer', key: playerSetup.apiKey } : { type: 'none' }
            };

            const modelInfo = {
                id: `openai-ai-${i}`,
                name: conn.name || conn.model || `Player ${i + 1}`,
                endpoint: conn.endpoint,
                provider: conn.provider || 'auto',
                auth: conn.auth || { type: 'none' },
                model: conn.model || 'default',
                temperature: 0.7,
                maxTokens: conn.maxTokens || 2000, // per-model cap on reply length (default 2000)
                contextSize: conn.contextSize || null, // context budget (tokens); also Ollama num_ctx (null = 32768)
                maxContext: conn.maxContext || null, // model's real max context — hard ceiling for the budget
                minimizeTokens: !!conn.minimizeTokens, // true = compact one-line history (Option A)
                language: conn.language || 'en', // language the model reasons/answers in (independent of GUI)
                customSystemPrompt: playerSetup.systemPrompt || null
            };

            // If no explicit model was chosen, discover one from the endpoint
            // (provider-aware: OpenAI /models, Anthropic /models, Ollama /api/tags).
            if (!conn.model || conn.model === 'default') {
                try {
                    const probe = await OpenAIAIManager.testConnection(conn.endpoint, modelInfo.auth, modelInfo.provider, 6000);
                    if (probe.ok && probe.models && probe.models.length) {
                        modelInfo.model = probe.models[0];
                        if (!conn.name) modelInfo.name = probe.models[0];
                    }
                } catch (err) {
                    console.warn(`[OpenAIAI] Could not discover models from ${conn.endpoint}:`, err.message);
                }
            }

            const controller = {
                id: ai.id,
                aiPlayer: ai,
                model: modelInfo,
                lastTurnTime: 0,
                turnCount: 0,
                pending: false,
                paused: false, // spectator can pause a model (e.g. when it runs out of quota)
                conversationHistory: [], // Stores {action, result} for feedback loop
                turnLog: [], // Rolling multi-turn pairs {user, assistant} for Option C
                _pendingTurnUser: null, // compact state for THIS turn, stored after the reply
                lastActionResult: null, // Most recent action result for next turn
                pendingAdvice: [], // Spectator advice to inject into the next prompt
                objective: '', // Model-authored standing goal ("why"), persists until it changes it
                plan: [], // Model-authored short ordered sub-goals, persists until rewritten
                pendingArrivalMessages: [], // deferred attack outcomes, delivered on arrival
                pendingAttackReports: [], // open attack-move orders awaiting an arrival verdict
                stats: this.newStats() // Behavior/performance metrics for the summary
            };

            this.aiControllers.push(controller);
            console.log(`[OpenAIAI] Assigned model "${modelInfo.name}" (${modelInfo.endpoint}) to AI "${ai.civilization}" (${ai.id})`);
        }

        console.log(`[OpenAIAI] Initialized ${this.aiControllers.length} LLM controllers from Arena setup`);
    }

    // ----------------------------------------------------------------
    // 3. Build COMPACT game state JSON for a specific AI player
    //    Target: < 25,000 tokens (server limit: 32,000)
    // ----------------------------------------------------------------
    buildGameStateJSON(controller) {
        const ai = controller.aiPlayer;
        const game = this.game;
        const civ = getCivilization(ai.civilization);
        const ages = ['stone', 'neolithic', 'bronze', 'iron'];
        const ageOrder = ages;
        const currentAgeIndex = ageOrder.indexOf(ai.age);

        // --- Player identity ---
        const playerObj = {
            id: ai.id,
            civilization: ai.civilization,
            civilizationName: civ?.name || ai.civilization,
            isHuman: false
        };

        // --- Epoch --- (costs come from the shared AGE_COSTS table in civilizations.js)
        const nextEpoch = currentAgeIndex < ages.length - 1 ? ages[currentAgeIndex + 1] : null;

        const epochObj = {
            currentEpoch: ai.age,
            nextEpoch: nextEpoch,
            nextEpochCost: nextEpoch ? AGE_COSTS[nextEpoch] : null,
            upgradeInProgress: ai.currentAgeUpgrade ? {
                targetEpoch: ai.currentAgeUpgrade.targetAge,
                progressPercent: Math.round((ai.currentAgeUpgrade.progress / ai.currentAgeUpgrade.duration) * 100),
                secondsRemaining: this.secsLeft(ai.currentAgeUpgrade.progress, ai.currentAgeUpgrade.duration)
            } : null
        };

        // --- Resources ---
        const resourcesObj = {
            food: Math.floor(ai.resources.food),
            wood: Math.floor(ai.resources.wood),
            stone: Math.floor(ai.resources.stone),
            gold: Math.floor(ai.resources.gold),
            population: ai.resources.population,
            maxPopulation: ai.resources.maxPopulation,
            populationFree: ai.resources.maxPopulation - ai.resources.population,
            // Hard ceiling — houses raise maxPopulation only up to this value.
            populationHardCap: (typeof MAX_POPULATION_CAP !== 'undefined') ? MAX_POPULATION_CAP : 100
        };

        // --- Battle report: losses, kills and raids since a while back ---
        // (game.logPlayerEvent feeds this; without it deaths between turns were
        // completely invisible to the model.)
        const recentEvents = (ai.events || []).slice(-8).map(e =>
            `${Math.max(0, Math.round((Date.now() - e.at) / 1000))}s ago: ${e.text}`);

        // --- Battles: what actually happened in the fighting ---
        // A model cannot watch a fight — it decides between snapshots. Each entry is
        // ONE engagement (clustered by location), CUMULATIVE since it began, so the
        // same battle grows turn over turn instead of arriving as fragments. Only
        // engagements this player took part in; the numbers are stated and never
        // interpreted — "their 2 heavy cavalry dealt 1800 to my 3 archers" IS the
        // counter lesson, and drawing it is the model's job, not the harness's.
        const battleNow = Date.now();
        const sideJson = (side) => {
            const involved = {};
            Object.entries(side.involved).forEach(([type, e]) => {
                const o = { n: e.ids.size };
                if (e.dmgUnits > 0) o.dmgUnits = Math.round(e.dmgUnits);
                if (e.dmgBuildings > 0) o.dmgBuildings = Math.round(e.dmgBuildings);
                if (e.healed > 0) o.healed = Math.round(e.healed);
                involved[type] = o;
            });
            const out = { involved };
            if (Object.keys(side.lost).length) out.lost = side.lost;
            return out;
        };
        const battles = (game._battles || [])
            .filter(b => b.sides[ai.id])
            .slice(-3)
            .map(b => {
                const enemy = Object.keys(b.sides)
                    .filter(oid => oid !== ai.id)
                    .map(oid => {
                        const foe = (game.aiManager && game.aiManager.aiPlayers.find(a => a.id === oid)) ||
                                    (oid === 'player' ? game.player : null);
                        return Object.assign({ owner: foe ? game.ownerName(foe) : String(oid) }, sideJson(b.sides[oid]));
                    });
                const quiet = battleNow - b.lastAt;
                const ongoing = quiet < Game.BATTLE_QUIET_MS;
                return {
                    at: [Math.round(b.x), Math.round(b.z)],
                    ongoing,
                    // Entries are held for two minutes so a slow model still gets a
                    // turn to read them — far too long for "not ongoing" to carry it
                    // alone, since that says the same at 11 seconds and at 110. Only
                    // present once the fight has ended, so a live one pays nothing.
                    ...(ongoing ? {} : { endedSecondsAgo: Math.round(quiet / 1000) }),
                    secondsElapsed: Math.max(0, Math.round((b.lastAt - b.startedAt) / 1000)),
                    you: sideJson(b.sides[ai.id]),
                    enemy
                };
            });

        // --- Bonuses (only non-default) ---
        const bonusesObj = {};
        if (ai.workerHarvestBonus !== 1.0) bonusesObj.harvest = ai.workerHarvestBonus;
        if (ai.attackBonus !== 1.0) bonusesObj.attack = ai.attackBonus;
        if (ai.healthBonus !== 1.0) bonusesObj.health = ai.healthBonus;
        if (ai.miningBonus !== 1.0) bonusesObj.mining = ai.miningBonus;
        if (ai.techCostMultiplier !== 1.0) bonusesObj.techCostMult = ai.techCostMultiplier;

        // --- Map summary (NO fog grid - too large) ---
        // The world is a square centred on (0,0). Coordinates run from -size/2 to
        // +size/2 on both axes; the model needs this to scout the whole map for
        // enemies rather than only its own corner.
        const halfMap = Math.round(game.terrain.size / 2);
        const mapObj = {
            size: game.terrain.size,
            bounds: { minX: -halfMap, maxX: halfMap, minZ: -halfMap, maxZ: halfMap },
            yourSpawnArea: this.getAIBuildingCenter(ai),
            // Which tiles you occupy, and how many buildings sit in each. Was a single
            // yourBaseTile derived from getAIBuildingCenter — a CENTROID, so a player
            // holding D1 and G7 was told "E4", a tile it has nothing in. Averaging
            // positions only names a real place when there is exactly one cluster;
            // with a second base, or a base rebuilt after the first fell, it points
            // at empty ground between them.
            // How many nodes of each type are STILL on the map, right now. Compare
            // against "discoveredNodesOnMap" (what you have found) to judge whether more
            // scouting is worth it — and watch it fall to see the world running dry.
            //
            // This replaces the prose biome brief the prompt used to carry. That line
            // said "food is scarce"; the difficulty preset it described is literally a
            // multiplier on these counts — 98 food instead of 392 on a winter map, 49
            // and half the stone on a desert one. The number says the same thing, and
            // unlike the sentence it keeps saying it as the match wears on.
            nodesLeftOnMap: Object.assign({}, (game.terrain && game.terrain.nodesLeftOnMap) ? game.terrain.nodesLeftOnMap() : {}),
            yourBaseTiles: (() => {
                const out = {};
                ai.buildings.forEach(b => {
                    const k = this.tileAt(game, b.x, b.z);
                    out[k] = (out[k] || 0) + 1;
                });
                return out;
            })(),
            // Percent of each tile this player has ever seen, keyed by the same label
            // explore() takes: column A..G west→east, row 1..7 north→south.
            //
            // Was a 7x7 matrix plus two coordinate-edge arrays. That asked the model
            // to find a cell by position, pair [row][col] with the right axis array,
            // and do the arithmetic — and a transposition produced a mirrored target
            // that was still a legal map position, so it returned OK and the scout
            // walked somewhere pointless. Nothing could report it. One label per tile
            // removes the pairing, the arithmetic and the silent failure together.
            exploration: (() => {
                const seen = game.explorationSummary(ai);
                const T = seen.length || 1;
                const out = {};
                for (let r = 0; r < T; r++) {
                    for (let c = 0; c < T; c++) out[this.tileLabel(r, c)] = seen[r][c];
                }
                return out;
            })()
        };

        // --- Resources: what you know exists, and the nodes worth walking to ---
        //
        // This was one array of every node ever scouted. On a fully explored map that
        // is 1231 entries and 18,900 tokens — 95% of the whole state, re-sent every
        // turn forever, and 300 copies alive in the transcript ring. Two questions
        // were being asked of it and only two: "is more scouting worth it", which a
        // COUNT answers, and "where do I send this worker", which only the near ones
        // answer. The rest was paid for and never used.
        //
        // Nothing is taken away: assign_workers still resolves any discovered node by
        // coordinate (discoveredNodesOfType sees them all), so a remembered far node
        // stays targetable — it just is not recited every turn.
        if (!ai._knownResIdx) ai._knownResIdx = new Set();
        const discoveredNodesOnMap = { food: 0, wood: 0, stone: 0, gold: 0 };
        const byType = { food: [], wood: [], stone: [], gold: [] };
        if (game.terrain && game.terrain.resources) {
            game.terrain.resources.forEach((res, idx) => {
                const k = this.knownAmount(ai, res, idx, game);
                if (!k.known) return;        // undiscovered → hidden, must scout
                // Depleted as far as THIS player knows. A node it watched run dry
                // drops out; one a rival emptied out of sight stays listed at its
                // last-seen amount until someone looks again — the disappearance
                // would otherwise report enemy activity through fog.
                if (k.amount <= 0 || !byType[res.type]) return;
                discoveredNodesOnMap[res.type]++;
                byType[res.type].push({
                    type: res.type,
                    x: Math.round(res.x),
                    z: Math.round(res.z),
                    amount: k.amount
                });
            });
        }
        // Nearest per TOWN CENTER, not globally nearest: with two bases the ten
        // closest overall can all sit around one of them and leave the other blind.
        // Anchored on Town Centers because that is exactly what assign_workers picks
        // when given no coordinates — so this lists the nodes the harness would
        // choose anyway, instead of the 1231 it would not.
        const tcAnchors = ai.buildings.filter(b => b.type === 'town_center' && !b.underConstruction);
        const anchors = tcAnchors.length ? tcAnchors
            : (ai.buildings.length ? [ai.buildings[0]] : (ai.units.length ? [ai.units[0]] : []));
        const nearby = new Map();
        // Stone and gold in FULL: 58 nodes between them on a whole map, and they are
        // the scarce ones — "where is the gold" is the question least worth truncating.
        byType.stone.concat(byType.gold).forEach(n => nearby.set(n.x + ',' + n.z, n));
        anchors.forEach(a => ['food', 'wood'].forEach(ty => {
            byType[ty]
                .map(n => ({ n, d: Math.hypot(a.x - n.x, a.z - n.z) }))
                .sort((p, q) => p.d - q.d)
                .slice(0, OpenAIAIManager.NEAREST_PER_ANCHOR)
                .forEach(({ n }) => nearby.set(n.x + ',' + n.z, n));
        }));
        const nearestNodes = [...nearby.values()];

        // --- Buildings (compact: friendly buildings with essentials + busy/idle) ---
        // Research and age-up are player-level in the engine (ai.currentResearch /
        // ai.currentAgeUpgrade) — attribute each to ONE finished host building so a
        // researching/advancing structure reads as busy. A building is BUSY when it
        // is producing a unit, still under construction, or hosting research/age-up;
        // otherwise it is idle (free to take a new order).
        let researchHostType = null;
        if (ai.currentResearch) {
            const rt = (civ?.techTree || {})[ai.currentResearch.techId];
            researchHostType = (rt && rt.researchAt) || 'town_center';
        }
        const ageUpActive = !!ai.currentAgeUpgrade; // hosted at a Town Center
        let researchAssigned = false, ageAssigned = false;

        const bSummary = { total: 0, idle: 0, busy: 0, underConstruction: 0, producing: 0, researching: 0, advancingAge: 0, farmsUnmanned: 0, byType: {} };

        // Seconds a finished Wonder must be held. Needed by BOTH the owner's view of
        // its own wonder and every rival's view of it — one definition, because the
        // two countdowns are the same clock read from opposite sides.
        const required = (game.wonderRequired || 600);
        const friendlyBuildings = ai.buildings.map(b => {
            const constructing = !!b.underConstruction;
            const producing = !!b.isProducing && !constructing;
            // Age-up and tech research are DIFFERENT tasks that can run AT THE SAME
            // TIME (executeResearchTech only guards on currentResearch, executeUpgradeAge
            // only on currentAgeUpgrade). They used to share the "researching" label, so
            // a Town Center advancing an epoch reported activity "researching" while
            // research.current was null — models read that as a contradiction and sat
            // waiting for a research that did not exist. Kept apart now, each bound to
            // ONE host building, each carrying its own countdown below.
            let researching = false, advancing = false;
            if (!constructing) {
                if (ageUpActive && !ageAssigned && b.type === 'town_center') { advancing = true; ageAssigned = true; }
                else if (researchHostType && !researchAssigned && b.type === researchHostType) { researching = true; researchAssigned = true; }
            }
            const busy = constructing || producing || researching || advancing;
            const activity = constructing ? 'under_construction'
                : producing ? 'producing'
                : advancing ? 'advancing_age'
                : researching ? 'researching' : 'idle';

            const obj = {
                type: b.type,
                x: Math.round(b.x),
                z: Math.round(b.z),
                healthPct: Math.round((b.health / b.maxHealth) * 100),
                state: constructing ? 'under_construction' : 'complete',
                busy: busy,
                activity: activity,
                producing: producing ? b.productionType : null
            };
            if (producing) {
                obj.producingSecondsRemaining = this.secsLeft(b.productionProgress, b.productionDuration);
            }
            if (constructing) {
                obj.buildPct = Math.round(Math.min(1, (b.buildProgress || 0) / (b.buildTime || 10000)) * 100);
                obj.buildSecondsRemaining = this.secsLeft(b.buildProgress, b.buildTime);
            }
            // Say WHAT the host is busy with and WHEN it frees up, right here — a
            // model asking "when can this Town Center train again" should not have to
            // cross-reference research.current / epoch.upgradeInProgress to find out.
            if (researching && ai.currentResearch) {
                obj.researchingTech = ai.currentResearch.techId;
                obj.researchSecondsRemaining = this.secsLeft(ai.currentResearch.progress, ai.currentResearch.duration);
            }
            if (advancing && ai.currentAgeUpgrade) {
                obj.advancingTo = ai.currentAgeUpgrade.targetAge;
                obj.ageSecondsRemaining = this.secsLeft(ai.currentAgeUpgrade.progress, ai.currentAgeUpgrade.duration);
            }
            if (b.isWonder) {
                obj.wonder = true;
                // The owner used to get this boolean and nothing else, while every
                // rival was handed secondsUntilEnemyWins — the same clock, ticking on
                // ai._wonderHold, read only for the other side. So the one player whose
                // victory was running was the only one who could not see it.
                const held = constructing ? 0 : Math.round((ai._wonderHold || 0) / 1000);
                obj.secondsUntilYouWin = constructing ? null : Math.max(0, required - held);
                // And they were not told the rule that makes them a target. Every OTHER
                // building they own is fog-protected, so a model may reasonably infer
                // its Wonder is hidden too, tuck it in a corner, and be punished for a
                // belief the state invited. Stating the fact is not advice: what to do
                // about being visible is still entirely theirs to work out.
                obj.revealedToAll = true;
            }
            if (b.type === 'farm') {
                obj.food = Math.floor(b.foodAmount || 0);
                // A farm grows food ONLY while a worker mans it. "busy"/"activity"
                // above describe production and research, which a farm never does —
                // so they always read "idle" and say NOTHING about whether it works.
                // This flag is the farm's real status, straight from the same
                // predicate the simulation gates regrowth on.
                obj.farmed = !!game.farmFarmer(b);
            }

            // accumulate the aggregate
            bSummary.total++;
            bSummary.byType[b.type] = (bSummary.byType[b.type] || 0) + 1;
            if (constructing) bSummary.underConstruction++;
            if (producing) bSummary.producing++;
            if (researching) bSummary.researching++;
            if (advancing) bSummary.advancingAge++;
            if (busy) bSummary.busy++; else bSummary.idle++;
            // Standing idle costs nothing; a farm standing UNMANNED costs food every
            // second, and nothing else in this summary would ever say so.
            if (b.type === 'farm' && !constructing && !game.farmFarmer(b)) bSummary.farmsUnmanned++;

            return obj;
        });

        // Enemy buildings (compact: type + position). Buildings are static, so once
        // DISCOVERED they are remembered (ai._knownEnemyBuildings) and stay listed
        // even after your units look away — with "visible:false" marking a remembered
        // (last-seen) one vs a currently-in-sight "visible:true". A WONDER is an
        // existential threat and is ALWAYS revealed to everyone (ignores fog).
        if (!ai._knownEnemyBuildings) ai._knownEnemyBuildings = new Set();
        const enemyBuildings = [];
        const enemyWonders = [];
        game.getAllBuildings().forEach(bldg => {
            if (ai.buildings.includes(bldg)) return;
            if (bldg.health <= 0) { ai._knownEnemyBuildings.delete(bldg); return; } // destroyed
            const isWonder = bldg.isWonder;
            const seenNow = isWonder || this.isPositionVisibleToAI(ai, bldg.x, bldg.z, game);
            if (seenNow) ai._knownEnemyBuildings.add(bldg);          // discover/refresh
            if (!seenNow && !ai._knownEnemyBuildings.has(bldg)) return; // never discovered → hidden
            const entry = {
                id: bldg.id, // stable target handle for attack_target(params.targetId)
                type: bldg.type,
                x: Math.round(bldg.x),
                z: Math.round(bldg.z),
                owner: bldg.owner,
                healthPct: Math.round((bldg.health / bldg.maxHealth) * 100),
                visible: !!seenNow
            };
            if (isWonder) {
                entry.isWonder = true;
                const ownerAi = game.aiManager.aiPlayers.find(a => a.buildings.includes(bldg));
                const held = bldg.underConstruction ? 0 : Math.round(((ownerAi && ownerAi._wonderHold) || 0) / 1000);
                entry.state = bldg.underConstruction ? 'under_construction' : 'complete';
                entry.secondsUntilEnemyWins = bldg.underConstruction ? null : Math.max(0, required - held);
                enemyWonders.push(entry);
            }
            enemyBuildings.push(entry);
        });

        // --- Units (compact: friendly units with type + position + action) ---
        const friendlyUnits = ai.units.map(u => {
            let action = 'idle';
            if (u.isAttacking) action = 'attacking';
            else if (u.task === 'harvesting') action = 'harvesting';
            else if (u.task === 'carrying' || u.carryingResource) action = 'returning';
            else if (u.task === 'building') action = 'building';
            else if (u.task === 'farm_work') action = 'farm_work';
            else if (u.isMoving) action = 'moving';

            return {
                type: u.type,
                x: Math.round(u.x),
                z: Math.round(u.z),
                healthPct: Math.round((u.health / u.maxHealth) * 100),
                action: action
            };
        });

        // --- Worker breakdown: a live tally of what your villagers are doing, so the
        //     model can rebalance the economy at a glance (counts workers only). ---
        //     "onX" counts EVERY worker whose job is X, at any point in the gather
        //     cycle — walking out, at the node, or carrying a load home. It used to
        //     count only those standing on a node, with the whole return leg dumped
        //     into an unattributed "returning" bucket, so three workers all on wood
        //     read as harvestingWood 1 / returning 2. The staffing figure a model
        //     rebalances from was understating itself by however long the walk is.
        //
        //     There was a "carryingX" here too — how many of each were holding a load
        //     — so a model could work out how many moved for free. It was removed
        //     because it cannot survive the trip: a gather round trip runs 12-32s and
        //     a reply takes 1.6-36s, so by the time the action lands the figure is a
        //     whole cycle old and describes different workers. Spilling is decided at
        //     EXECUTION now, via assign_workers' allowSpill, where the truth is known.
        const wk = {
            total: 0, idle: 0, building: 0, onFarms: 0, scouting: 0, moving: 0,
            onFood: 0, onWood: 0, onStone: 0, onGold: 0
        };
        const CAP = { food: 'Food', wood: 'Wood', stone: 'Stone', gold: 'Gold' };
        ai.units.forEach(u => {
            if (u.type !== 'worker') return;
            wk.total++;
            if (u.task === 'building' || u.isBuilding) { wk.building++; return; }
            if (u.task === 'scouting') { wk.scouting++; return; }
            if (u.task === 'farm_work') { wk.onFarms++; return; }
            const carrying = !!(u.carryingResource || u.task === 'carrying');
            if (carrying || u.task === 'harvesting' || u.isHarvesting || u.harvestTarget) {
                const rt = (u.harvestTarget && u.harvestTarget.type) || u.carryingResourceType;
                const k = CAP[rt];
                if (!k) { wk.moving++; return; }   // job not resolved yet (in transit)
                wk['on' + k]++;
                return;
            }
            if (this.game.isIdleWorker(u)) { wk.idle++; return; }
            wk.moving++; // in transit with no recognized job
        });

        // Enemy units (very compact)
        const enemyUnits = [];
        game.getAllUnits().forEach(unit => {
            if (ai.units.includes(unit)) return;
            const vis = this.isPositionVisibleToAI(ai, unit.x, unit.z, game);
            if (!vis) return;
            enemyUnits.push({
                id: unit.id, // target handle for attack_target(params.targetId); units move, so prefer this over stale coordinates
                type: unit.type,
                x: Math.round(unit.x),
                z: Math.round(unit.z),
                owner: unit.owner
            });
        });

        // --- Research (compact) ---
        const techs = civ?.techTree || {};

        // Researched tech IDs only
        const researchedTechIds = Object.keys(techs).filter(tid => ai.researchedTechs[tid]);

        // Current research
        const currentResearch = ai.currentResearch ? {
            techId: ai.currentResearch.techId,
            progressPercent: Math.round((ai.currentResearch.progress / ai.currentResearch.duration) * 100),
            secondsRemaining: this.secsLeft(ai.currentResearch.progress, ai.currentResearch.duration)
        } : null;

        // Available techs (compact: id, cost, canAfford)
        const availableTechs = Object.keys(techs)
            .filter(tid => {
                const t = techs[tid];
                if (ai.researchedTechs[tid]) return false;
                if (ageOrder.indexOf(t.requiredAge) > currentAgeIndex) return false;
                if (t.requires) {
                    for (const req of t.requires) {
                        if (!ai.researchedTechs[req]) return false;
                    }
                }
                return true;
            })
            .map(tid => {
                const t = techs[tid];
                const costMult = ai.techCostMultiplier || 1;
                const cost = {
                    food: Math.floor((t.cost.food || 0) * costMult),
                    wood: Math.floor((t.cost.wood || 0) * costMult),
                    stone: Math.floor((t.cost.stone || 0) * costMult),
                    gold: Math.floor((t.cost.gold || 0) * costMult)
                };
                return {
                    id: tid,
                    cost,
                    researchAt: t.researchAt,
                    canAfford: ai.resources.food >= cost.food &&
                               ai.resources.wood >= cost.wood &&
                               ai.resources.stone >= cost.stone &&
                               ai.resources.gold >= cost.gold
                };
            });

        const researchObj = {
            researched: researchedTechIds,
            current: currentResearch,
            available: availableTechs
        };

        // --- Unlocked content ---
        // `units` used to be Object.keys(ai.unlockedUnits) and was structurally
        // always empty: exactly one tech in the whole game declares a unit unlock,
        // so for three civs out of four the field could never populate. It was the
        // only thing resembling a vocabulary for train_unit, and it never had one.
        // trainableUnits (below) replaces it with the real per-civ list.
        const unlockedContent = {
            buildings: Object.keys(ai.unlockedBuildings || {})
        };

        // --- Trainable units: the vocabulary for train_unit's "unitType" ---
        // Nested building → age → [ids], so every LEAF is a bare id the model can
        // copy straight into unitType. The first version wrote "militia(stone)" as
        // one string to save a nesting level, and models duly passed that whole
        // string as the unitType — the harness had invented a token that looked
        // copyable and wasn't. Structure it instead of warning about it.
        const trainableUnits = {};
        this.trainableUnitsFor(ai.civilization).forEach(u => {
            const host = (trainableUnits[u.at] = trainableUnits[u.at] || {});
            (host[u.age] = host[u.age] || []).push(u.id);
        });

        // --- Buildable structures for THIS civ (some civs lack e.g. the stable) ---
        // Only lists what your civilization can EVER build; if a type is missing,
        // your civ does not have it (don't waste turns trying).
        const stdBuildings = ['town_center', 'house', 'farm', 'barracks', 'archery_range', 'stable', 'market', 'tower', 'temple'];
        const buildableStructures = stdBuildings.map(t => {
            const def = (typeof getBuildingDef === 'function') ? getBuildingDef(t) : null;
            if (!def) return null;
            const reqTech = def.requiresTech || null;
            const civSupports = !reqTech || !!techs[reqTech];
            if (!civSupports) return null; // civ can never build this
            const techDone = !reqTech || !!ai.researchedTechs[reqTech];
            // requiredAge is the CIV-effective age (unlock tech may come later
            // than the def's own age — Egypt's stable is bronze, not neolithic).
            const reqAge = (typeof effectiveBuildingAge === 'function') ? effectiveBuildingAge(ai.civilization, def) : (def.requiredAge || 'stone');
            return { type: t, requiredAge: reqAge, requiresTech: reqTech, researched: techDone, readyToBuild: techDone };
        }).filter(Boolean);

        // --- Buildings you have LOST recently ---
        //
        // Replaces "pendingBuildings", which read ai.pendingBuildings — a field only
        // ever populated on the HUMAN player's two-step place-a-building flow. Models
        // call createBuilding directly, so it was [] for every model on every turn,
        // and a model hunting for a Wonder it had started reasoned its way through
        // that empty array before giving up.
        //
        // What it was actually looking for is this: a building it was told it started
        // had been destroyed, and destruction leaves no trace in a snapshot. Held for
        // the same window as the battle ledger — one constant, because it is the same
        // question ("what did I miss between turns?") — and filtered by age HERE so a
        // quiet map cannot serve a stale entry.
        const recentLosses = (ai._lostBuildings || [])
            .filter(l => battleNow - l.at <= Game.BATTLE_KEEP_MS)
            .map(l => Object.assign(
                { type: l.type },
                l.wonder ? { wonder: true } : {},
                { x: l.x, z: l.z, secondsAgo: Math.round((battleNow - l.at) / 1000) },
                l.to ? { to: l.to } : {}
            ));

        // --- Opponents: ALL rivals — rule-based ones and, in campaign, the human
        // too (the old list was built from LLM controllers only, leaving blind
        // spots for everyone else). Epochs are PUBLIC: heralds announce age-ups.
        // Army/building counts are scouting rewards — they appear only after
        // FIRST CONTACT (this player has seen any unit or building of that
        // rival; see game.updateRivalContacts).
        const met = ai._metRivals || new Set();
        const aiOpponents = [];
        const pushRival = (o, key) => {
            const entry = { id: key, civilization: o.civilization, age: o.age, discovered: met.has(key) };
            if (entry.discovered) {
                entry.units = o.units.length;
                entry.buildings = o.buildings.length;
            }
            aiOpponents.push(entry);
        };
        game.aiManager.aiPlayers.forEach(o => { if (o !== ai) pushRival(o, o.id); });
        if (!game.spectatorMode && game.player) pushRival(game.player, 'player');

        // --- Threats (what is attacking YOU right now — go defend!) ---
        const nowMs = Date.now();
        const underAttack = [];
        const scanHit = (ent, kind) => {
            if (!ent || ent.health <= 0) return;
            if (!ent._lastDamageTime || nowMs - ent._lastDamageTime > 6000) return;
            const atk = ent._lastAttacker;
            underAttack.push({
                kind, type: ent.type, x: Math.round(ent.x), z: Math.round(ent.z),
                healthPct: Math.round((ent.health / ent.maxHealth) * 100),
                attackerAt: atk ? { x: Math.round(atk.x), z: Math.round(atk.z), owner: atk.owner } : null
            });
        };
        ai.buildings.forEach(b => scanHit(b, 'building'));
        ai.units.forEach(u => scanHit(u, 'unit'));
        const threatsObj = {
            underAttack: underAttack,                       // your stuff currently taking fire — defend it
            enemyWonders: enemyWonders                       // existential: destroy these or you lose
        };

        // --- Clock ---
        //
        // The prompt tells a model "TIME PASSES between turns" and the state is full
        // of seconds — buildSecondsRemaining, secondsUntilEnemyWins, secondsAgo — but
        // nothing said how long a turn IS, so none of them could be converted into
        // decisions. A 40s build is thirteen turns for a 3s seat and one turn for a
        // 37s seat; both were told "40". That is not strategy separating them.
        //
        // An AVERAGE rather than the last gap: one retry or one long reasoning burst
        // makes a single sample useless to plan on. And no derived "turnsRemaining" —
        // that is the model's arithmetic to do, and it would bake in an assumption
        // that cadence holds when a slowing endpoint is exactly when it does not.
        const clockObj = {
            matchSeconds: Math.max(0, Math.round(
                (battleNow - ((game._timeline && game._timeline.t0) || battleNow)) / 1000))
        };
        const gaps = (controller && controller.turnGaps) || [];
        // Omitted on the first turn: no interval has been observed yet, and seeding it
        // from the configured breather would be a guess wearing a measurement's clothes.
        if (gaps.length) {
            clockObj.averageSecondsBetweenTurns =
                Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length / 1000);
        }

        // --- Game stats ---
        const gameStatsObj = {
            // wonderTimer/wonderHeld were dropped: they read game.wonderTimer and
            // game.wonderHeld, which belong to the HUMAN player's wonder — and
            // checkWinConditions returns early in spectator mode, so in an arena they
            // were permanently 0 and false for every seat. Tokens spent every turn to
            // imply a clock that never moved. The owner's real clock now rides on its
            // own wonder as secondsUntilYouWin.
            wonderRequired: required,
            opponents: aiOpponents
        };

        return {
            player: playerObj,
            clock: clockObj,
            epoch: epochObj,
            resources: resourcesObj,
            recentEvents: recentEvents,
            // Omitted entirely in peacetime — this rides the per-turn channel, so a
            // quiet game should pay nothing for it.
            ...(battles.length ? { battles } : {}),
            bonuses: bonusesObj,
            map: mapObj,
            discoveredNodesOnMap: discoveredNodesOnMap,
            nearestNodes: nearestNodes,
            friendlyBuildings: friendlyBuildings,
            buildings: bSummary,
            enemyBuildings: enemyBuildings,
            friendlyUnits: friendlyUnits,
            workers: wk,
            enemyUnits: enemyUnits,
            research: researchObj,
            unlockedContent: unlockedContent,
            trainableUnits: trainableUnits,
            buildableStructures: buildableStructures,
            // Omitted in peacetime, like "battles": a match where nothing has been
            // destroyed should pay nothing for the field.
            ...(recentLosses.length ? { recentLosses } : {}),
            threats: threatsObj,
            gameStats: gameStatsObj
        };
    }

    // Helper: get center position of AI's buildings
    getAIBuildingCenter(ai) {
        if (ai.buildings.length === 0) return { x: 0, z: 0 };
        let sx = 0, sz = 0;
        ai.buildings.forEach(b => { sx += b.x; sz += b.z; });
        return { x: Math.round(sx / ai.buildings.length), z: Math.round(sz / ai.buildings.length) };
    }

    // ----------------------------------------------------------------
    // 4. Helper: Compute fog grid for AI
    // ----------------------------------------------------------------
    computeAIFogGrid(ai, game, numTiles) {
        const mapSize = game.terrain.size;
        const gridSize = 2;
        const halfSize = mapSize / 2;
        const grid = new Uint8Array(numTiles * numTiles); // 0=hidden, 1=explored, 2=visible

        // Vision ranges
        const unitVisionRange = 15;
        const buildingVisionRange = 12;
        const towerVisionRange = 60;

        // Reveal around AI's units
        ai.units.forEach(unit => {
            const range = unit.unitType === 'cavalry' ? unitVisionRange * 1.2 : unitVisionRange;
            this.revealGridArea(grid, numTiles, unit.x, unit.z, range, halfSize, gridSize, 2);
        });

        // Reveal around AI's buildings — FINISHED ones only. A construction plot
        // grants no vision (same rule as the human fog): a tower's 60-radius
        // sweep is the reward for completing it, not for placing the stakes.
        ai.buildings.forEach(bldg => {
            if (bldg.underConstruction) return;
            this.revealGridArea(grid, numTiles, bldg.x, bldg.z, game.buildingVision(bldg), halfSize, gridSize, 2);
        });

        // Mark visible as explored (simplified - in real game this decays)
        // For AI we keep visible tiles as 2, rest as 0

        return grid;
    }

    revealGridArea(grid, numTiles, x, z, range, halfSize, gridSize, value) {
        const gx = Math.floor((x + halfSize) / gridSize);
        const gz = Math.floor((z + halfSize) / gridSize);
        const gridRange = Math.ceil(range / gridSize);

        for (let dx = -gridRange; dx <= gridRange; dx++) {
            for (let dz = -gridRange; dz <= gridRange; dz++) {
                const nx = gx + dx;
                const nz = gz + dz;
                if (nx < 0 || nx >= numTiles || nz < 0 || nz >= numTiles) continue;
                const dist = Math.sqrt(dx * dx + dz * dz) * gridSize;
                if (dist > range) continue;
                const idx = nz * numTiles + nx;
                if (grid[idx] < value) grid[idx] = value;
            }
        }
    }

    // ----------------------------------------------------------------
    // 5. Helper: Check if position is visible to AI
    // ----------------------------------------------------------------
    isPositionVisibleToAI(ai, x, z, game) {
        const buildingVisionRange = 12;
        const towerVisionRange = 60;

        // Check against AI units
        for (const unit of ai.units) {
            const range = game.unitVision(unit); // cavalry sees 50% farther
            const dx = unit.x - x;
            const dz = unit.z - z;
            if (Math.sqrt(dx * dx + dz * dz) <= range) return 'visible';
        }

        // Check against AI buildings (finished only — plots don't see)
        for (const bldg of ai.buildings) {
            if (bldg.underConstruction) continue;
            const range = game.buildingVision(bldg);
            const dx = bldg.x - x;
            const dz = bldg.z - z;
            if (Math.sqrt(dx * dx + dz * dz) <= range) return 'visible';
        }

        return null;
    }

    isAIOwned(building, ai) {
        return ai.buildings.includes(building);
    }

    isAIUnitOwned(unit, ai) {
        return ai.units.includes(unit);
    }

    // ----------------------------------------------------------------
    // 6. Helper: Get unit action JSON
    // ----------------------------------------------------------------
    getUnitActionJSON(unit) {
        let actionType = 'idle';
        const target = null;
        const targetPosition = null;
        const harvestInfo = null;
        const buildInfo = null;

        if (unit.isAttacking) {
            actionType = 'attacking';
        } else if (unit.task === 'harvesting') {
            actionType = unit.isMoving ? 'moving' : 'harvesting';
        } else if (unit.task === 'carrying' || unit.carryingResource) {
            actionType = 'returning_resources';
        } else if (unit.task === 'building') {
            actionType = 'building';
        } else if (unit.task === 'farm_work') {
            actionType = 'farm_work';
        } else if (unit.isMoving) {
            actionType = 'moving';
        }

        return {
            type: actionType,
            target: target,
            targetPosition: unit.isMoving ? {
                x: Math.round(unit.targetX * 10) / 10,
                z: Math.round(unit.targetZ * 10) / 10
            } : null,
            harvestInfo: unit.carryingResource || unit.task === 'harvesting' ? {
                resourceType: unit.carryingResourceType || (unit.harvestTarget ? unit.harvestTarget.type : 'food'),
                carriedAmount: unit.harvestAmount || 0,
                maxCarry: unit.maxHarvest || 15
            } : null,
            buildInfo: unit.task === 'building' && unit.buildTarget ? {
                buildingType: unit.buildTarget.type,
                progress: unit.buildProgress || 0,
                duration: 5000,
                progressPercent: Math.round(((unit.buildProgress || 0) / 5000) * 100)
            } : null
        };
    }

    // ----------------------------------------------------------------
    // 7. Canonical system prompt (SINGLE SOURCE OF TRUTH)
    // ----------------------------------------------------------------
    // The one and only default prompt text. The Arena/Campaign setup UI shows and
    // stores THIS text (ui.getArenaDefaultPrompt delegates here), per-slot edits
    // override it, and buildSystemPrompt() falls back to it — so the prompt the
    // user reads in the textarea is exactly the prompt the harness serves.
    // Placeholders resolved at match time: {{civilization}}, {{bonus}}, {{players}}.
    // {{terrain}} (the preset's summer/winter/desert brief) is still SUBSTITUTED, so a
    // hand-edited prompt may use it, but the default no longer spends tokens on it.
    //
    // Design: rules of the WORLD, not a strategy recipe. The prompt states what
    // exists, what things do and how they interact; the live state JSON says what
    // is possible right now; action results correct mistakes. Strategy (build
    // orders, target priority, timing) is deliberately left to the model — that
    // is what the benchmark measures.
    static defaultSystemPrompt() {
        return `You ARE {{civilization}}, one of {{players}} rival commanders in a real-time strategy game on a square 800x800 map. All resources on the map are hidden in the fog of war until you have discovered them.
Every other player is your enemy. No human plays for you: you command by issuing actions. Your unique bonus: {{bonus}}.

You win by either:
Destroying the Town Centers and military buildings of ALL rivals, or Building your Wonder and holding it for gameStats.wonderRequired seconds.

The LAST message carries your CURRENT state as JSON; decide from it and issue EXACTLY ONE action. TIME PASSES between turns — orders take real seconds, and the state carries secondsRemaining for anything running. Work already under way continues on its own and does not occupy your turn; re-issuing it wastes the turn.

- You never SEE a fight; it happens between your turns. "battles" reports each engagement, cumulative: both sides' composition, damage dealt to units and to buildings, priests' healing, and losses. Losing produces no error, so this is the only place you learn what beat you.
- Priests never fight. They march with an attack and heal wounded units from the back on their own.
- Idle military auto-defend your home between turns, so you need not micro every raid. Auto-defense only repels; it never wins the game.
- "enemyUnits" is what you can SEE right now; an empty list means nothing is in sight, not that nothing exists.

OUTPUT EXACTLY ONE RAW JSON OBJECT
Format: {"action": "<ActionName>", "params": { "<key>": <value>, "reason": "<1-line explanation>" }, "objective": "<1 line>", "plan": ["<step>", "<step>"]}

OPTIONAL TOP-LEVEL FIELDS (beside "action", not inside "params"):
objective: String (1 line). Persists across turns; omit to keep current.
plan: Array of up to 5 short strings. Persists across turns; omit to keep current.

VALID ACTIONS & PARAMETERS (? = optional)
Note: targetX and targetZ must ALWAYS be provided together.

train_worker: (None)
train_unit: unitType (from trainableUnits), targetX?, targetZ?
research_tech: techId (from research.available)
upgrade_age: (None)
build_structure: buildingType (from buildableStructures), targetX?, targetZ?
build_wonder: (None)
assign_workers: resourceType (food|wood|stone|gold|farm), count? (def:3, max:20), from? (food|wood|stone|gold|farm|idle — where to TAKE them; default: idle first, then your largest stockpile), allowSpill? (def:true; false takes only workers not carrying a load right now, and takes fewer if that is all there are), targetX?, targetZ?
repair_building: count? (def:1, max:5), targetX?, targetZ? (omitted = most damaged)
explore: tile (a label from map.exploration, e.g. "C5" — column A-G, row 1-7; map.yourBaseTiles says which you hold), unitType?
move_units: targetX, targetZ, units?
attack_target: targetId (from enemyUnits/enemyBuildings) OR targetX, targetZ. Optional: units?. (Coords trigger attack-move; do not reissue while marching)
delete_unit: unitType? (from friendlyUnits, def: worker), count? (def:1, max:20)
destroy_building: buildingType (from friendlyBuildings), targetX?, targetZ?
wait: (None)

PARAMETER CONSTRAINTS:
units: An OBJECT of {"type": count}. Valid types: unit IDs (e.g., {"champion":3}) OR categories ({"infantry":5}). Categories work ONLY here, never in train_unit. Omit for whole army. Never an array. move_units also accepts {"worker":N} when named explicitly — that is how you place a unit on an exact spot; attack_target never takes workers.`;
    }

    // ----------------------------------------------------------------
    // 8. Build system prompt
    // ----------------------------------------------------------------
    // A directive appended to the system prompt telling the model which language
    // to think/answer in. The action JSON (keys, action names, enums) must stay
    // English so parsing still works. Empty for English (the default).
    languageDirective(controller) {
        const lang = (controller && controller.model && controller.model.language) || 'en';
        if (lang === 'en') return '';
        const names = { de: 'German (Deutsch)', es: 'Spanish (Español)', zh: 'Simplified Chinese (简体中文)' };
        const name = names[lang];
        if (!name) return '';
        return `\n\n## Language\nThink and write ALL natural-language text — especially every "reason" field — in ${name}. BUT keep the response a valid JSON object and keep all JSON keys, action names and enum values EXACTLY as specified (in English). Only the free-text values are translated.`;
    }

    buildSystemPrompt(ai) {
        const civ = getCivilization(ai.civilization);
        const controller = this.aiControllers.find(c => c.id === ai.id);
        const langDirective = this.languageDirective(controller);

        // The setup UI always passes a prompt (the canonical default, or the
        // user's per-slot edit); the static default is the safety net. Either
        // way the SAME placeholder resolution applies, so custom prompts can
        // use {{civilization}}/{{bonus}}/{{players}}/{{terrain}} too.
        const base = (controller && controller.model?.customSystemPrompt)
            ? controller.model.customSystemPrompt
            : OpenAIAIManager.defaultSystemPrompt();

        // The map's character, per difficulty preset. Same principle as the rest of
        // the prompt: state what the world IS, never what to do about it. The food
        // presets differ by 8x between Summer and Desert, and bushes alone cannot
        // reach the Iron age on Desert — noticing that and reaching for farms is
        // precisely the adaptation the arena is meant to measure, so it is not
        // spelled out here.
        const TERRAIN_BRIEF = {
            easy:   'The playing field is a summer valley: food and wood are both abundant.',
            medium: 'The playing field is a winter valley: food is scarce; wood and stone are normal.',
            hard:   'The playing field is a desert valley: food and wood are both extremely scarce, and stone is half as common.'
        };
        const terrain = TERRAIN_BRIEF[(this.game && this.game.difficulty)] || TERRAIN_BRIEF.easy;

        // Players in THIS match: all AI players, plus the human in campaign mode.
        const players = ((this.game && this.game.aiManager && this.game.aiManager.aiPlayers.length) || 0)
            + ((this.game && !this.game.spectatorMode) ? 1 : 0);

        return base
            .replace(/\{\{civilization\}\}/g, civ?.name || ai.civilization)
            .replace(/\{\{bonus\}\}/g, civ?.bonus?.description || 'None')
            .replace(/\{\{players\}\}/g, String(players || 2))
            .replace(/\{\{terrain\}\}/g, terrain)
            + langDirective;
    }


    // A compact but FAITHFUL summary of a turn's state, kept for Option C's replayed
    // history. The CURRENT turn always sends the full state JSON — this is only the
    // memory of PAST turns, so we distil the high-signal fields (resources, economy,
    // army, research, known nodes, enemy presence, and threats) rather than blindly
    // truncating the JSON (which dropped exactly the important late sections like
    // threats and enemy wonders). Bounded so many turns fit the budget.
    buildCompactState(gs) {
        if (!gs || typeof gs !== 'object') {
            try { return JSON.stringify({ pastTurnRecap: true, raw: String(gs).slice(0, 160) }); } catch (e) { return '{"pastTurnRecap":true}'; }
        }
        const r = gs.resources || {}, ep = gs.epoch || {}, wk = gs.workers || {}, b = gs.buildings || {}, th = gs.threats || {};
        const fu = Array.isArray(gs.friendlyUnits) ? gs.friendlyUnits : [];
        // Already counts. This used to tally a 1231-entry array on every recap.
        const dn = gs.discoveredNodesOnMap;
        const nodes = Object.assign({ food: 0, wood: 0, stone: 0, gold: 0 },
            (dn && typeof dn === 'object' && !Array.isArray(dn)) ? dn : {});
        // The keys mirror the FULL state schema (resources / workers / buildings /
        // research / threats), so the model reads this past-turn recap exactly like
        // the live state it already knows — no new shorthand to learn. "pastTurnRecap"
        // flags it as condensed memory; counts replace the long per-entity arrays.
        const recap = {
            pastTurnRecap: true,
            epoch: {
                currentEpoch: ep.currentEpoch || (gs.player && gs.player.age) || 'unknown',
                advancingTo: ep.upgradeInProgress ? ep.upgradeInProgress.targetEpoch : null
            },
            resources: { food: r.food, wood: r.wood, stone: r.stone, gold: r.gold, population: r.population, maxPopulation: r.maxPopulation },
            // Mirrors the live state's key names. The recap kept reading the old
            // harvesting* keys after the split and would have replayed four
            // undefineds into every past turn.
            workers: {
                total: wk.total, onFood: wk.onFood, onWood: wk.onWood,
                onStone: wk.onStone, onGold: wk.onGold,
                onFarms: wk.onFarms, building: wk.building, idle: wk.idle, scouting: wk.scouting
            },
            militaryUnitCount: fu.filter(u => u.type !== 'worker').length,
            buildingsByType: b.byType || {},
            buildingsUnderConstruction: b.underConstruction || 0,
            currentResearch: gs.research && gs.research.current ? gs.research.current.techId : null,
            discoveredResourceNodeCounts: nodes,
            enemySeen: {
                units: Array.isArray(gs.enemyUnits) ? gs.enemyUnits.length : 0,
                buildings: Array.isArray(gs.enemyBuildings) ? gs.enemyBuildings.length : 0
            },
            threats: {
                underAttack: Array.isArray(th.underAttack) ? th.underAttack.length : 0,
                enemyWonders: (Array.isArray(th.enemyWonders) ? th.enemyWonders : []).map(w => ({ state: w.state, secondsUntilEnemyWins: w.secondsUntilEnemyWins }))
            }
        };
        let s;
        try { s = JSON.stringify(recap); } catch (e) { s = '{"pastTurnRecap":true}'; }
        const MAX = 1200;
        return s.length > MAX ? s.slice(0, MAX - 1) + '…' : s;
    }

    // OPTION A: compressed one-line move history, newest kept, filled to `budget`
    // tokens, then rendered oldest-first. Returns '' when there's nothing to show.
    buildMoveHistoryText(controller, budget, est) {
        const hist = (controller.conversationHistory || []).filter(e => e && e.action && e.result);
        if (!hist.length || budget < 80) return '';
        const trim = (s) => { s = String(s).replace(/^\[ERROR\]\s*/, '').replace(/^OK\s*-\s*/, '').trim(); return s.length > 200 ? s.slice(0, 197) + '…' : s; };
        const header = `Your recent moves THIS match (oldest first) — keep a consistent strategy, finish multi-step plans you started, and learn from the results:\n`;
        let used = est(header);
        const picked = [];
        for (let i = hist.length - 1; i >= 0; i--) {
            const e = hist[i];
            const status = e.failed ? 'FAILED' : 'OK';
            const why = e.reason ? ` ("${String(e.reason).slice(0, 120)}")` : '';
            const line = `${e.action}${why} -> ${status}: ${trim(e.result)}`;
            const cost = est(line) + 1;
            if (used + cost > budget && picked.length) break; // always keep at least one
            used += cost; picked.push(line);
        }
        picked.reverse();
        return header + picked.map((l, i) => `${i + 1}. ${l}`).join('\n');
    }

    // OPTION C: rolling user/assistant pairs from the turn log, newest kept, filled to
    // `budget` tokens, returned oldest-first and flattened into chat turns.
    buildRollingTurns(controller, budget, est) {
        const log = controller.turnLog || [];
        if (!log.length || budget < 80) return [];
        const picked = [];
        let used = 0;
        for (let i = log.length - 1; i >= 0; i--) {
            const p = log[i];
            const cost = est(p.user) + est(p.assistant) + est(p.outcome || '') + 16;
            if (used + cost > budget && picked.length) break;
            used += cost; picked.push(p);
        }
        picked.reverse();
        const turns = [];
        picked.forEach((p, j) => {
            // The OUTCOME of the previous turn's action is observed right before this
            // turn's state — thread it in so the model sees the consequence of each
            // decision (e.g. "REJECTED: no idle worker"), not just the decisions. This
            // is what stops it repeating a rejected command once the window fills.
            const prevOutcome = j > 0 ? picked[j - 1].outcome : null;
            const userContent = (prevOutcome ? `RESULT of your previous action: ${prevOutcome}\n\n` : '') + p.user;
            turns.push({ role: 'user', content: userContent });
            turns.push({ role: 'assistant', content: p.assistant || '(no reply)' });
        });
        return turns;
    }

    // ----------------------------------------------------------------
    // 9. Send request to OpenAI endpoint
    // ----------------------------------------------------------------
    async sendToOpenAI(controller, gameState) {
        const model = controller.model;
        const ai = controller.aiPlayer;

        const systemPrompt = this.buildSystemPrompt(ai);

        // Assemble ONE coherent, chronological user message per turn. We rebuild the
        // model's context from scratch each turn (the providers here are stateless),
        // so the ordering must read as a single continuous session:
        //   recent moves (oldest -> newest)  ->  current state (LAST)  ->  advice.
        // (Previously the current state was placed FIRST and the history AFTER it,
        // which scrambled past/present and made the model answer a stale old result.)
        // ---- Rolling context sized to the model's context budget ----------------
        // The history window now scales with each model's context budget instead of a
        // fixed 20 moves, so big-context models actually remember more of the match.
        // Clamp the configured budget to the model's REAL max context if we discovered
        // it, so a too-high setting can't overflow.
        const hardMax = (model.maxContext && model.maxContext >= 512) ? model.maxContext : Infinity;
        const budget = Math.min(hardMax, (model.contextSize && model.contextSize >= 512) ? model.contextSize : 32768);
        const reserve = (model.maxTokens || 2000) + 1500;        // leave room for the reply + margin
        // Only use a conservative SLICE of the window for the prompt. We can't run the
        // model's tokenizer client-side, and dense JSON / non-English text tokenizes well
        // under 3.5 chars/token — overestimating capacity overflows the real limit and the
        // provider returns a 400 ("maximum context length …"), losing the turn. So we
        // estimate at a pessimistic ~3 chars/token AND keep a big headroom. `_ctxShrink`
        // ratchets this down further if an overflow ever still happens (self-healing).
        const shrink = controller._ctxShrink || 1;
        const inputBudget = Math.max(2000, Math.floor((budget - reserve) * 0.8 * shrink));
        const est = (s) => Math.ceil(String(s || '').length / 3); // conservative ~3 chars/token

        // (0) Standing objective/plan — frames every turn (sent in the present message).
        const head = [];
        if ((controller.objective && controller.objective.trim()) || (controller.plan && controller.plan.length)) {
            let s = `YOUR STANDING OBJECTIVE (you set this; it persists until you change it via the "objective"/"plan" fields on any action — update it as your plan evolves):`;
            if (controller.objective && controller.objective.trim()) s += `\nGoal: ${controller.objective}`;
            if (controller.plan && controller.plan.length) {
                s += `\nPlan: ` + controller.plan.map((p, i) => `(${i + 1}) ${p}`).join('  ');
            }
            head.push(s);
        }

        // (tail) Everything framing the PRESENT turn: deferred attack outcomes, a note
        // on an unparseable previous reply, the current state JSON, and spectator advice.
        const tailNow = [];
        if (controller.pendingArrivalMessages && controller.pendingArrivalMessages.length) {
            const msgs = controller.pendingArrivalMessages;
            controller.pendingArrivalMessages = [];
            tailNow.push(`RESULTS OF YOUR EARLIER ATTACK ORDER(S) — your units have now arrived:\n` + msgs.map(m => `- ${m}`).join('\n'));
        }
        // A completed rival Wonder is a live loss timer, restated beside the state each
        // turn because a reply can take ~30s and the number moves the whole time.
        //
        // It used to shout — "⚠️ URGENT — YOU LOSE IN Ns … Send your ENTIRE army to
        // attack_target it THIS turn and keep them on it until it falls." That was the
        // harness playing the decisive turn of the match, every turn, on the one
        // decision that ends games. The countdown, the position, the targetId and the
        // HP are facts and stay; what to do about them is the whole thing being
        // measured. The consequence is stated as the RULE it is, not as a command.
        const enemyWonders = (gameState.threats && gameState.threats.enemyWonders) || [];
        const liveWonders = enemyWonders.filter(w => w.state === 'complete' && w.secondsUntilEnemyWins != null);
        if (liveWonders.length) {
            const worst = liveWonders.reduce((a, b) => (a.secondsUntilEnemyWins <= b.secondsUntilEnemyWins ? a : b));
            // The seat id, not the civ: a controlled benchmark runs four seats on the
            // SAME civ, so "greek has completed a Wonder" would name three rivals at
            // once. This is the id already carried by threats.enemyWonders[].owner and
            // gameStats.opponents[].id, so it can be joined with everything else.
            const who = worst.owner || 'a rival';
            tailNow.push(`${who} has completed a Wonder at (${worst.x}, ${worst.z}) [targetId "${worst.id}", ${worst.healthPct}% HP]. If it still stands in ${worst.secondsUntilEnemyWins}s, ${who} wins the match.`);
        }
        const lastHistResult = controller.conversationHistory.length ? String(controller.conversationHistory[controller.conversationHistory.length - 1].result) : null;
        tailNow.push(`Here is your CURRENT game state. Analyze it and choose the single best action for THIS turn.\n\nGame State JSON:\n${JSON.stringify(gameState, null, 2)}`);
        if (controller.pendingAdvice && controller.pendingAdvice.length) {
            const advice = controller.pendingAdvice.join(' ');
            controller.pendingAdvice = [];
            tailNow.push(`SPECTATOR ADVICE (a human observer suggests — weigh it, you still decide): ${advice}`);
        }

        // Remember a compact snapshot of THIS turn; after the reply it becomes one
        // rolling history pair (Option C) so the next turn can replay it cheaply.
        controller._pendingTurnUser = this.buildCompactState(gameState);

        // ...and the FULL state for the transcript. Stored as the object rather than
        // the assembled prompt text on purpose: replayed history means the message
        // sent on turn N contains turns 1..N-1, so recording the whole payload every
        // turn would be quadratic — by turn 200 you would have written turn 1 two
        // hundred times. Keeping the per-turn delta lets any turn's full context be
        // reconstructed on demand instead.
        controller._transcriptState = gameState;

        // The result of the immediately previous action (rejection reason, parse error,
        // or OK + detail). The model MUST see this every turn or it will happily repeat
        // a rejected command forever.
        const prevResult = controller.lastActionResult || null;

        let turns;
        if (model.minimizeTokens) {
            // OPTION A — minimize tokens: a single user message whose embedded move
            // history is compressed to one line each, filled to the remaining budget.
            const fixed = [...head, ...tailNow].join('\n\n');
            const histBudget = inputBudget - est(systemPrompt) - est(fixed);
            const histText = this.buildMoveHistoryText(controller, histBudget, est);
            const parts = [...head];
            if (histText) parts.push(histText);
            // The move history already carries action outcomes; only surface a separate
            // note for a previous reply that isn't in it (e.g. an unparseable response).
            if (prevResult && prevResult !== lastHistResult) {
                parts.push(`Note on your previous response: ${prevResult}`);
            }
            parts.push(...tailNow);
            turns = [{ role: 'user', content: parts.join('\n\n') }];
        } else {
            // OPTION C — full multi-turn rolling conversation. Past pairs carry their
            // OUTCOMES (threaded in buildRollingTurns), and the present turn always
            // states the result of the previous action so a rejected command is never
            // silently repeated. The stable system-prompt prefix stays cacheable.
            const preface = [...head];
            if (prevResult) {
                preface.push(`RESULT of your PREVIOUS action — learn from it; do NOT repeat a rejected action, fix the cause first: ${prevResult}`);
            }
            const currentUser = [...preface, ...tailNow].join('\n\n');
            const pairBudget = inputBudget - est(systemPrompt) - est(currentUser);
            const pastTurns = this.buildRollingTurns(controller, pairBudget, est);
            turns = [...pastTurns, { role: 'user', content: currentUser }];
        }

        // Which protocol does this endpoint speak? (auto-detected when set to 'auto')
        const provider = OpenAIAIManager.resolveProvider(model);
        console.log(`[OpenAIAI] ${ai.id}: provider=${provider}, turns=${turns.length}`);

        try {
            // Build provider-specific auth headers + request (url, body).
            const auth = model.auth || (model.apiKey ? { type: 'bearer', key: model.apiKey } : { type: 'none' });
            let headers;
            try {
                headers = await OpenAIAIManager.buildAuthHeaders(auth, provider);
            } catch (authErr) {
                console.error(`[OpenAIAI] Auth failed for ${ai.id}:`, authErr);
                headers = { 'Content-Type': 'application/json' };
            }

            const req = OpenAIAIManager.buildChatRequest(
                provider, model.endpoint, model.model || 'default', systemPrompt, turns,
                { temperature: model.temperature, maxTokens: model.maxTokens, numCtx: model.contextSize }
            );
            const apiUrl = req.url;
            const body = req.body;
            console.log(`[OpenAIAI] Sending ${provider} request to ${apiUrl} for ${ai.id}`);

            const reqStart = Date.now();

            // Abort the request if the endpoint is slow/dead so the controller
            // never gets stuck "pending" for the rest of the match. The handle is
            // stored on the controller so stop() can abort it when the match ends.
            const controllerAbort = new AbortController();
            controller._abort = controllerAbort;
            const timeoutId = setTimeout(() => controllerAbort.abort(), this.requestTimeout);
            let response;
            try {
                response = await fetch(apiUrl, {
                    method: 'POST',
                    headers: headers,
                    mode: 'cors',
                    body: JSON.stringify(body),
                    signal: controllerAbort.signal
                });
            } catch (fetchErr) {
                if (fetchErr.name === 'AbortError') {
                    throw new Error(`timed out after ${Math.round(this.requestTimeout / 1000)}s`);
                }
                throw fetchErr;
            } finally {
                clearTimeout(timeoutId);
            }

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`API error (${response.status}): ${errorText}`);
            }

            const data = await response.json();
            const norm = OpenAIAIManager.normalizeResponse(provider, data);
            // Token accounting: latency tells you speed, this tells you COST.
            const usage = OpenAIAIManager.extractUsage(provider, data);
            if (usage && controller.stats) {
                controller.stats.promptTokens += usage.prompt;
                controller.stats.completionTokens += usage.completion;
            }
            // A reply cut short is worth saying out loud, with the numbers needed to
            // tell WHOSE limit did it. If the provider reports far fewer completion
            // tokens than we asked for, the cap was applied upstream (a proxy or a
            // server-side default), not by us — and if the JSON is cut while the
            // finish reason is NOT the cap, nothing capped it and the transport
            // truncated the body. Those need opposite fixes, so don't guess.
            const askedMax = model.maxTokens || 2000;
            if (OpenAIAIManager.hitTokenCap(norm && norm.finish_reason)) {
                console.warn(`[OpenAIAI] ${ai.id}: reply stopped at a token cap — we asked max_tokens=${askedMax}, ` +
                    `provider reported completion=${usage ? usage.completion : 'n/a'}, content=${((norm && norm.content) || '').length} chars. ` +
                    `A completion far below the ask means the cap came from the endpoint, not from here.`);
            }
            const result = this.parseResponse(norm, controller);

            // Transcript: the exchange VERBATIM, for after-the-fact analysis. Separate
            // from turnLog below, which trims the reply to 600 chars, keeps content or
            // reasoning but never both, and stores the compact state rather than the
            // full one the model actually received. A pure observer — wrapped so a
            // recording fault can never cost a model its move.
            try {
                if (this.transcripts && controller._transcriptState != null) {
                    this.transcripts.record(controller.aiPlayer && controller.aiPlayer.id, {
                        at: Date.now(),
                        latencyMs: Date.now() - reqStart,
                        state: controller._transcriptState,
                        assistant: {
                            content: norm ? norm.content : null,
                            reasoning: norm ? norm.reasoning : null,
                            tool_calls: norm ? norm.tool_calls : null,
                            finish_reason: norm ? norm.finish_reason : null
                        },
                        parsed: result || null,
                        tokens: usage ? { prompt: usage.prompt, completion: usage.completion } : null,
                        // What we ASKED for, beside what came back. A truncation is
                        // only diagnosable as a pair: the cap we set is upstream of
                        // every explanation for why the reply stopped.
                        request: { maxTokens: askedMax, provider, model: model.model || 'default' },
                        usageRaw: OpenAIAIManager.rawUsage(provider, data),
                        contentChars: ((norm && norm.content) || '').length
                    });
                }
                controller._transcriptState = null;
            } catch (e) { console.warn('[transcript] capture failed', e); }

            // Record this exchange for the rolling multi-turn history (Option C):
            // the compact state we showed + the model's (trimmed) reply.
            if (controller._pendingTurnUser != null) {
                const replyText = (norm && (norm.content || norm.reasoning)) ? String(norm.content || norm.reasoning) : '';
                controller.turnLog.push({
                    user: controller._pendingTurnUser,
                    assistant: replyText.replace(/\s+/g, ' ').trim().slice(0, 600),
                    outcome: null // filled by recordAction once this turn's action resolves
                });
                controller._pendingTurnUser = null;
                if (controller.turnLog.length > 400) controller.turnLog = controller.turnLog.slice(-400);
            }

            // Behavior metrics: time-to-answer + parse outcome
            const s = controller.stats;
            if (s) {
                s.requests++;
                s.latencies.push(Date.now() - reqStart);
            }

            // Stamp the harness's answer onto the transcript. executeAction does this
            // for every turn that RUNS — but a reply that never parsed never reaches
            // it, so the turns whose failure most needs explaining were the only ones
            // showing a blank where the answer goes. Every early return below routes
            // through here so none can forget.
            const stampResult = (msg) => {
                try {
                    if (this.transcripts) {
                        this.transcripts.noteResult(controller.aiPlayer && controller.aiPlayer.id, msg);
                    }
                } catch (e) { /* recording must never break a turn */ }
                return null;
            };

            // The model ANSWERED, but with prose and no JSON action anywhere.
            // Fair-eval rule: nothing is executed and nothing is guessed (the old
            // keyword inference laundered format failures into valid-looking
            // moves). Counted separately from parse failures — the endpoint and
            // the reply are fine, the model just didn't issue an action.
            if (result && result.noAction) {
                this.registerNoActionReturn(controller);
                controller._failStreak = 0;
                return stampResult(controller.lastActionResult);
            }

            // The model DID issue an action and the JSON carrying it broke. That is a
            // format fault it can fix, so unlike a prose reply it gets told — and it
            // counts as a parse failure, which formatOk already subtracts.
            if (result && result.malformed) {
                if (s) {
                    s.parseFails++;
                    if (result.truncated) s.truncatedReplies = (s.truncatedReplies || 0) + 1;
                }
                controller.lastActionResult = result.truncated
                    ? `[ERROR] Your reply was CUT OFF before the JSON closed — you ran out of output tokens, so nothing was executed. Keep "reason", "objective" and "plan" to one short sentence each and always close the JSON.`
                    : `[ERROR] Your reply contained an "action" but was not valid JSON, so nothing was executed.${result.why ? ` The JSON parser reported: ${result.why}.` : ''} Reply with ONLY the JSON object: {"action":"...","params":{...}} — straight double quotes, and any quote INSIDE a string value must be escaped as \\" or left out.`;
                const lastMalformed = controller.turnLog[controller.turnLog.length - 1];
                if (lastMalformed && lastMalformed.outcome == null) lastMalformed.outcome = controller.lastActionResult;
                controller._failStreak = 0;
                return stampResult(controller.lastActionResult);
            }

            if (s && !result) s.parseFails++;

            // If parsing failed, store error feedback for next turn — and stamp it as
            // the OUTCOME of the turn pair we just pushed, so the rolling multi-turn
            // history (Option C) replays the failure too instead of a blind null.
            if (!result) {
                controller.lastActionResult = `[ERROR] Your last response could not be parsed. Please use the execute_action tool with valid JSON containing "action" and "params" fields. Example: {"action": "wait", "params": {"reason": "analyzing situation"}}`;
                const lastTurn = controller.turnLog[controller.turnLog.length - 1];
                if (lastTurn && lastTurn.outcome == null) lastTurn.outcome = controller.lastActionResult;
                stampResult(controller.lastActionResult);
            }

            controller._failStreak = 0; // endpoint reachable (parse problems aside)
            return result;
        } catch (err) {
            console.error(`[OpenAIAI] Request failed for ${ai.id}:`, err);
            // Context-length overflow (provider 400). The endpoint is FINE — our prompt
            // was just too big for this model. Ratchet the budget down so subsequent
            // turns fit, and DON'T count it as an endpoint failure (no demotion).
            if (/context length|context window|maximum context|too many tokens|reduce the length/i.test(err.message || '')) {
                controller._ctxShrink = Math.max(0.25, (controller._ctxShrink || 1) * 0.7);
                console.warn(`[OpenAIAI] ${ai.id}: context overflow — shrinking budget to ${Math.round(controller._ctxShrink * 100)}% and retrying next turn.`);
                controller.lastActionResult = `[ERROR] Your previous request was too large for the model's context and was dropped; the history window has been trimmed. Continue normally.`;
                // Count it — a lost turn is a lost turn. Tracked separately from
                // network errors (the endpoint is fine, our prompt was too big) so
                // the reliability metric stays honest without demoting the model.
                if (controller.stats) {
                    controller.stats.requests++;
                    controller.stats.contextOverflows = (controller.stats.contextOverflows || 0) + 1;
                }
                return null;
            }
            // Behavior metrics: classify the failure
            const s = controller.stats;
            if (s) {
                s.requests++;
                if (/timed out/i.test(err.message)) s.timeouts++;
                else s.networkErrors++;
            }
            // In a PLAYER game (not the arena benchmark), an unreachable endpoint
            // hands this opponent to the rule-based AI so the player still faces a
            // real opponent. The arena keeps failures as-is (they're part of the eval).
            controller._failStreak = (controller._failStreak || 0) + 1;
            if (!this.game.spectatorMode && controller._failStreak >= 2) {
                this.demoteToRuleBased(controller);
                return null;
            }
            // Log network failures to decision log
            const civ = getCivilization(ai.civilization);
            const civName = civ?.name || ai.civilization;
            const colorHex = '#' + (civ?.color || 0xffffff).toString(16).padStart(6, '0');
            this.decisionLog.unshift({
                timestamp: Date.now(),
                playerId: ai.id,
                civName: civName,
                color: colorHex,
                action: 'request_failed',
                reason: `Request to model failed: ${err.message.substring(0, 100)}`,
                params: {}, failed: true
            });
            if (this.decisionLog.length > this.maxLogEntries) {
                this.decisionLog = this.decisionLog.slice(0, this.maxLogEntries);
            }
            return null;
        }
    }

    // A reply arrived but carried no JSON action: count it as its own outcome
    // (a valid RETURN — it keeps its latency — but a wasted turn) and tell the
    // model unambiguously that nothing was done.
    registerNoActionReturn(controller) {
        const s = controller.stats;
        if (s) s.noActionReturns = (s.noActionReturns || 0) + 1;
        controller.lastActionResult = `[ERROR] NO ACTION was taken this turn: your reply contained no valid JSON action object. Reply with EXACTLY ONE JSON object, e.g. {"action":"wait","params":{"reason":"..."}} — plain prose wastes the turn.`;
        const lastTurn = controller.turnLog[controller.turnLog.length - 1];
        if (lastTurn && lastTurn.outcome == null) lastTurn.outcome = controller.lastActionResult;
    }

    // ----------------------------------------------------------------
    // 10. Parse LLM response (primary: plain JSON, fallback: tool_calls)
    // ----------------------------------------------------------------
    // `norm` is the provider-normalized shape: { content, reasoning, tool_calls, finish_reason }
    parseResponse(norm, controller) {
        const ai = controller.aiPlayer;
        const civ = getCivilization(ai.civilization);
        const civName = civ?.name || ai.civilization;
        const colorHex = '#' + (civ?.color || 0xffffff).toString(16).padStart(6, '0');

        const logFailure = (reason) => {
            this.decisionLog.unshift({
                timestamp: Date.now(),
                playerId: ai.id,
                civName: civName,
                color: colorHex,
                action: 'tool_call_failed',
                reason: `Tool call could not be interpreted: ${reason}`,
                params: {}, failed: true
            });
            if (this.decisionLog.length > this.maxLogEntries) {
                this.decisionLog = this.decisionLog.slice(0, this.maxLogEntries);
            }
        };

        // The model replied in prose without any JSON action: the decision log
        // shows the model's OWN words under a no-action tag — not a guessed move,
        // not a parse error.
        const logNoAction = (text) => {
            this.decisionLog.unshift({
                timestamp: Date.now(),
                playerId: ai.id,
                civName: civName,
                color: colorHex,
                action: 'no_action_provided',
                reason: String(text).replace(/\s+/g, ' ').trim().slice(0, 220),
                params: {}, failed: true
            });
            if (this.decisionLog.length > this.maxLogEntries) {
                this.decisionLog = this.decisionLog.slice(0, this.maxLogEntries);
            }
        };

        // A reply that CONTAINS an action but would not parse is a MALFORMED action,
        // not prose — the model decided, and the JSON carrying the decision broke.
        // Logged under its own tag because "no action provided" was simply untrue,
        // and an untrue log entry is worse than none.
        const logMalformed = (text, cut) => {
            this.decisionLog.unshift({
                timestamp: Date.now(),
                playerId: ai.id,
                civName: civName,
                color: colorHex,
                action: cut ? 'reply_truncated' : 'malformed_action',
                reason: String(text).replace(/\s+/g, ' ').trim().slice(0, 220),
                params: {}, failed: true
            });
            if (this.decisionLog.length > this.maxLogEntries) {
                this.decisionLog = this.decisionLog.slice(0, this.maxLogEntries);
            }
        };

        try {
            const message = norm || {};
            if (message.content == null && message.reasoning == null && !message.tool_calls) {
                console.warn(`[OpenAIAI] No message content in response`);
                logFailure('No message content in response');
                return null;
            }

            console.log(`[OpenAIAI] Response for ${ai.civilization}:`, {
                has_content: !!message.content,
                has_reasoning: !!message.reasoning,
                finish_reason: message.finish_reason,
                content_preview: (message.content || '').substring(0, 200)
            });

            // 1) Structured JSON in content; then in reasoning. Reasoning models
            //    (e.g. Qwen3) leave content empty and put the answer in
            //    message.reasoning, so we must look there too.
            let parsed = this.extractActionFromText(message.content);
            if (!parsed) parsed = this.extractActionFromText(message.reasoning);
            if (parsed && parsed.action) {
                console.log(`[OpenAIAI] Parsed action:`, parsed);
                return parsed;
            }

            // 2) tool_calls (some models still emit these)
            const toolCalls = message.tool_calls;
            if (toolCalls && toolCalls.length > 0) {
                const args = toolCalls[0].function?.arguments;
                console.log(`[OpenAIAI] Tool call fallback:`, args);
                const fromTool = this.extractActionFromText(args);
                if (fromTool && fromTool.action) return fromTool;
                if (typeof args === 'string' && args.trim()) {
                    // A tool call whose arguments carry no parseable action is
                    // still no action — we don't guess one from the text.
                    logNoAction(args);
                    return { noAction: true };
                }
            }

            // 3) Prose with NO JSON action anywhere. The old harness guessed an
            //    action from keywords here — charitable, but unfair: other
            //    agentic harnesses aren't that forgiving, and acting on inferred
            //    intent laundered format failures into valid-looking moves. Now:
            //    log the model's own words, execute nothing, report a no-action
            //    turn (counted separately in the results).
            const freeText = (message.content || message.reasoning || '').toString().trim();
            if (freeText) {
                // Split BEFORE the prose verdict. Silence is the right answer to a
                // model that chose not to act; it is the wrong answer to one whose
                // JSON broke, which then repeats the same fault every turn with
                // nothing to correct. Saying "your JSON was malformed" is the error
                // channel doing its job, not a crutch — the same call as the
                // bracket-stripping hint executeAction already gives.
                // An opening brace AND an "action" key: that is a JSON attempt, not
                // prose. The quote class has to include CURLY quotes — a model that
                // smart-quotes its keys is the commonest way to produce unparseable
                // JSON, and matching only straight quotes sent exactly that case
                // down the prose path, which is the bug this split exists to fix.
                const looksLikeAction = freeText.includes('{') &&
                    /["'“”‘’]?\s*action\s*["'“”‘’]?\s*:/i.test(freeText);
                if (looksLikeAction) {
                    const cut = OpenAIAIManager.hitTokenCap(message.finish_reason);
                    // Hand back the parser's OWN complaint. "Not valid JSON" invites a
                    // model to rewrite a shape it already had right; the position and
                    // the token it choked on point at the one character to fix. A
                    // stray unescaped quote inside "plan" is the common case and looks
                    // nothing like a shape error from the inside.
                    let why = '';
                    if (!cut) {
                        const cands = this.findJsonObjects(freeText);
                        const raw = cands.length ? cands[cands.length - 1] : freeText;
                        try { JSON.parse(raw); } catch (e) { why = String((e && e.message) || e).slice(0, 160); }
                    }
                    console.warn(`[OpenAIAI] Malformed action JSON${cut ? ' — reply hit the output-token cap' : ''}, nothing executed:`,
                        freeText.slice(0, 160));
                    logMalformed(freeText, cut);
                    return { malformed: true, truncated: cut, why };
                }
                console.warn(`[OpenAIAI] Reply without JSON action — nothing executed:`, freeText.substring(0, 160));
                logNoAction(freeText);
                return { noAction: true };
            }

            // Truncated reasoning model with no usable output (OpenAI 'length',
            // Anthropic 'max_tokens', Google 'MAX_TOKENS').
            if (['length', 'max_tokens', 'MAX_TOKENS'].includes(message.finish_reason)) {
                logFailure('Response truncated (token limit) before an action was produced');
                return null;
            }

            console.warn(`[OpenAIAI] Could not extract action from response`);
            logFailure('No valid JSON found in response');
            return null;
        } catch (err) {
            // NOTE: log only what's in scope. Referencing an undefined identifier here
            // used to throw a ReferenceError INSIDE this catch, which escaped into
            // sendToOpenAI's catch and was miscounted as an endpoint failure — enough
            // of those could demote a perfectly healthy model to rule-based.
            console.error('[OpenAIAI] Failed to parse response:', err, norm);
            logFailure('Unexpected error parsing response');
            return null;
        }
    }

    // ----------------------------------------------------------------
    // 10a. Helper: Extract a valid action object from arbitrary model text
    //      Handles plain JSON, markdown fences, and JSON embedded anywhere
    //      in prose / chain-of-thought (picks the LAST valid action object).
    // ----------------------------------------------------------------
    extractActionFromText(text) {
        if (!text || typeof text !== 'string') return null;
        const t = text.trim();
        if (!t) return null;

        // Direct parse
        try {
            const p = JSON.parse(t);
            if (p && p.action) return p;
        } catch (e) { /* fall through */ }

        // Balanced-brace scan: collect every top-level {...} and prefer the
        // last one that actually contains an "action" field.
        const objs = this.findJsonObjects(t);
        for (let i = objs.length - 1; i >= 0; i--) {
            const raw = objs[i];
            if (!/["']?action["']?\s*:/.test(raw)) continue;
            try {
                const p = JSON.parse(raw);
                if (p && p.action) return p;
            } catch (e) { /* try repaired */ }
            try {
                const p = JSON.parse(this.fixJsonString(raw));
                if (p && p.action) return p;
            } catch (e) { /* next candidate */ }
        }

        // Markdown code fence
        const fence = t.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
        if (fence && fence[1]) {
            const inner = this.extractActionFromText(fence[1]);
            if (inner) return inner;
        }
        return null;
    }

    // Return every balanced top-level { ... } substring (string-aware).
    findJsonObjects(text) {
        const objs = [];
        let depth = 0, start = -1, inStr = false, esc = false;
        for (let i = 0; i < text.length; i++) {
            const ch = text[i];
            if (inStr) {
                if (esc) esc = false;
                else if (ch === '\\') esc = true;
                else if (ch === '"') inStr = false;
                continue;
            }
            if (ch === '"') { inStr = true; continue; }
            if (ch === '{') { if (depth === 0) start = i; depth++; }
            else if (ch === '}') {
                if (depth > 0) {
                    depth--;
                    if (depth === 0 && start >= 0) { objs.push(text.slice(start, i + 1)); start = -1; }
                }
            }
        }
        return objs;
    }

    // ----------------------------------------------------------------
    // 10b. Helper: Fix common JSON issues
    // ----------------------------------------------------------------
    fixJsonString(jsonStr) {
        let fixed = jsonStr;
        // Remove trailing commas before } or ]
        fixed = fixed.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');
        // Fix unquoted keys: "key": -> "key": (already quoted) or key: -> "key":
        fixed = fixed.replace(/(\w+)\s*:/g, '"$1":');
        // Remove single-line comments
        fixed = fixed.replace(/\/\/.*$/gm, '');
        // Remove multi-line comments
        fixed = fixed.replace(/\/\*[\s\S]*?\*\//g, '');
        return fixed;
    }

    // ----------------------------------------------------------------
    // 11. Execute the parsed action for the AI player
    // ----------------------------------------------------------------
    executeAction(controller, actionData) {
        const ai = controller.aiPlayer;
        const game = this.game;

        if (!actionData || !actionData.action) {
            console.warn(`[OpenAIAI] No action data for ${ai.id}`);
            controller.lastActionResult = `[ERROR] No valid action data received.`;
            return;
        }

        const { action, params } = actionData;
        const civ = getCivilization(ai.civilization);
        const civName = civ?.name || ai.civilization;
        const colorHex = '#' + (civ?.color || 0xffffff).toString(16).padStart(6, '0');
        console.log(`[OpenAIAI] ${ai.id} (${ai.civilization}) executing: ${action}`, params?.reason || '');
        
        // Track action result for feedback
        let actionResult = null;

        // Log the decision (kept as a reference so we can flag it if it fails)
        const logEntry = {
            timestamp: Date.now(),
            playerId: ai.id,
            civName: civName,
            color: colorHex,
            action: action,
            reason: params?.reason || '',
            params: params || {},
            failed: false,
            error: null
        };
        // The log renders this entry's outcome body in the MODEL's language; record
        // which language, and clear any structured outcome from the previous action.
        logEntry.lang = (controller && controller.model && controller.model.language) || 'en';
        this._pendingOutcome = null;
        this.decisionLog.unshift(logEntry);
        // Trim log
        if (this.decisionLog.length > this.maxLogEntries) {
            this.decisionLog = this.decisionLog.slice(0, this.maxLogEntries);
        }

        // Persist the model's standing objective/plan if it set one this turn. These
        // live on the controller and are replayed at the TOP of every prompt, so a
        // multi-step intent (and its surviving sub-goals) outlasts the move history.
        // Wholesale-replace semantics: the model rewrites them when they change.
        //
        // Read from BOTH placements. The prompt called these "params" while its Format
        // line showed only action/params — so models put them beside "action", which is
        // the more natural JSON shape and what every reply in testing did. Reading
        // params.* alone discarded them in silence: no error, no log, the objective
        // simply never existed. This feature had never once fired for those models.
        const src = actionData || {};
        const objRaw = (params && params.objective !== undefined) ? params.objective : src.objective;
        const planRaw = (params && params.plan !== undefined) ? params.plan : src.plan;
        if (typeof objRaw === 'string' && objRaw.trim()) {
            controller.objective = objRaw.trim().slice(0, 300);
        }
        // A plan sent as one string is kept as a single step rather than dropped. Its
        // intent is unambiguous; splitting "[1] a, [2] b" into steps would be the
        // harness inventing structure the model did not commit to.
        const planArr = Array.isArray(planRaw) ? planRaw
            : (typeof planRaw === 'string' && planRaw.trim()) ? [planRaw] : null;
        if (planArr) {
            controller.plan = planArr
                .filter(s => typeof s === 'string' && s.trim())
                .slice(0, 5)
                .map(s => s.trim().slice(0, 120));
        }

        // Behavior metrics: count the attempted action
        if (controller.stats) {
            const st = controller.stats;
            st.actionsAttempted++;
            st.actionCounts[action] = (st.actionCounts[action] || 0) + 1;
            if (params && typeof params.reason === 'string' && params.reason.trim()) st.reasonsGiven++;
        }

        switch (action) {
            case 'train_worker':
                actionResult = this.executeTrainWorker(ai, game, params || {});
                break;

            case 'train_unit':
                if (params?.unitType) {
                    actionResult = this.executeTrainUnit(ai, game, params.unitType, params || {});
                } else {
                    actionResult = `[ERROR] train_unit requires "unitType" parameter.`;
                }
                break;

            case 'research_tech':
                if (params?.techId) {
                    actionResult = this.executeResearchTech(ai, game, params.techId);
                } else {
                    actionResult = `[ERROR] research_tech requires "techId" parameter.`;
                }
                break;

            case 'upgrade_age':
                actionResult = this.executeUpgradeAge(ai, game);
                break;

            case 'build_structure':
                if (params?.buildingType) {
                    actionResult = this.executeBuildStructure(ai, game, params.buildingType, params?.targetX, params?.targetZ);
                } else {
                    actionResult = `[ERROR] build_structure requires "buildingType" parameter.`;
                }
                break;

            case 'move_units':
                if (params?.targetX !== undefined && params?.targetZ !== undefined) {
                    actionResult = this.executeMoveUnits(ai, game, params.units, params.targetX, params.targetZ);
                } else {
                    actionResult = `[ERROR] move_units requires "targetX" and "targetZ" parameters.`;
                }
                break;

            case 'attack_target':
                if (params?.targetId) {
                    actionResult = this.executeAttackTarget(ai, game, params.targetId, params.units);
                } else if (params?.targetX !== undefined && params?.targetZ !== undefined) {
                    actionResult = this.executeAttackPosition(ai, game, params.targetX, params.targetZ, params.units);
                } else {
                    actionResult = `[ERROR] attack_target requires "targetId" or ("targetX" and "targetZ") parameters.`;
                }
                break;

            case 'build_wonder':
                actionResult = this.executeBuildWonder(ai, game);
                break;

            case 'assign_workers':
                actionResult = this.executeAssignWorkers(ai, game, params || {});
                break;

            case 'repair_building':
                actionResult = this.executeRepairBuilding(ai, game, params || {});
                break;

            case 'explore':
                actionResult = this.executeExplore(ai, game, params || {});
                break;

            case 'delete_unit':
                actionResult = this.executeDeleteUnit(ai, game, params || {});
                break;

            case 'destroy_building':
                if (params?.buildingType) {
                    actionResult = this.executeDestroyBuilding(ai, game, params.buildingType, params?.targetX, params?.targetZ);
                } else {
                    actionResult = `[ERROR] destroy_building requires "buildingType" parameter.`;
                }
                break;

            case 'wait':
                actionResult = `OK - Waited this turn.`;
                break;

            default: {
                // The commonest miss by far: the model copies the action list's
                // notation into the JSON — "wait()" rather than "wait". The name is
                // right and only the punctuation is wrong, so say exactly that
                // instead of a flat "unknown", which reads as "that action does not
                // exist" and sends a model hunting for a different one.
                const bare = String(action).replace(/\s*\(.*\)\s*$/, '').trim();
                const KNOWN = ['train_worker', 'train_unit', 'research_tech', 'upgrade_age',
                    'build_structure', 'build_wonder', 'assign_workers',
                    'repair_building', 'explore', 'move_units', 'attack_target',
                    'delete_unit', 'destroy_building', 'wait'];
                actionResult = (bare !== action && KNOWN.includes(bare))
                    ? `[ERROR] Unknown action "${action}". You meant "${bare}" — the "action" value is the bare name with NO brackets or parameter list. Send {"action":"${bare}","params":{...}} and put the parameters in "params".`
                    : `[ERROR] Unknown action: ${action}. Valid actions: ${KNOWN.join(', ')}.`;
                break;
            }
        }

        // Safety net: EVERY action must yield a feedback string so the model always
        // learns the outcome and can't silently repeat a no-op. If a handler ever
        // returns nothing, synthesize a result instead of dropping it (which would
        // leave the model with no idea its command did anything).
        if (actionResult == null || actionResult === '') {
            actionResult = `[ERROR] Action "${action}" produced no result. Pick a different action.`;
        }

        // Behavior metrics + flag the log entry if the action was rejected
        if (actionResult) {
            const rejected = actionResult.startsWith('[ERROR]');
            if (controller.stats) {
                const st = controller.stats;
                if (rejected) {
                    if (/Unknown action/i.test(actionResult)) st.invalidActions++;
                    else st.actionsRejected++;
                } else {
                    st.actionsSucceeded++;
                }
            }
            if (rejected) {
                logEntry.failed = true;
                logEntry.error = actionResult.replace(/^\[ERROR\]\s*/, '');
            }
        }

        // Store a COMPACT, human-readable record of this decision for the feedback
        // loop: the action, the model's own stated reason, and the outcome. One
        // short sentence per move keeps a long history affordable
        // while preserving the "why" across a multi-step plan.
        if (actionResult) {
            logEntry.result = actionResult; // so the spectator log can show the outcome
            // Attach the structured outcome a covered handler recorded, for the log's
            // model-language rendering (the English `result`/`error` remain the fallback).
            if (this._pendingOutcome) {
                logEntry.outcomeCode = this._pendingOutcome.code;
                logEntry.outcomeParams = this._pendingOutcome.params;
                this._pendingOutcome = null;
            }
            controller.conversationHistory.push({
                action: action,
                reason: (params && params.reason) ? String(params.reason) : '',
                result: actionResult,
                failed: !!logEntry.failed
            });
            // Retain a deep history (bounded for memory). How MUCH of it is actually
            // sent each turn is decided at request time by the model's context budget
            // (buildMoveHistoryText), not by this cap.
            if (controller.conversationHistory.length > this.maxHistoryEntries) {
                controller.conversationHistory = controller.conversationHistory.slice(-this.maxHistoryEntries);
            }
            controller.lastActionResult = actionResult;
            // Attach this outcome to the matching rolling-history turn (Option C) so the
            // multi-turn replay shows the result of each past decision, not just the
            // decision — otherwise the model can't tell a command keeps being rejected.
            if (controller.turnLog && controller.turnLog.length) {
                const lastTurn = controller.turnLog[controller.turnLog.length - 1];
                if (lastTurn && lastTurn.outcome == null) lastTurn.outcome = actionResult;
            }
            // Same for the transcript: the harness's answer is the other half of the
            // exchange, and it arrives after the reply was recorded.
            try {
                if (this.transcripts) this.transcripts.noteResult(
                    controller.aiPlayer && controller.aiPlayer.id, actionResult);
            } catch (e) { /* recording must never break a turn */ }
        }
    }

    // ----------------------------------------------------------------
    // 12. Action implementations
    // ----------------------------------------------------------------
    // Advice tailored to whether houses can still help or the hard cap is reached.
    popCapAdvice(ai) {
        const cap = (typeof MAX_POPULATION_CAP !== 'undefined') ? MAX_POPULATION_CAP : 100;
        if (ai.resources.maxPopulation >= cap) {
            return `You are at the HARD population cap of ${cap} — houses and Town Centers can NOT raise it any further. The only way to free a slot is delete_unit: remove a worker if you need more military units or a military unit if you need more workers.`;
        }
        return `Build houses (+5 each) or a Town Center (+10) to raise maxPopulation (up to the hard cap of ${cap}), or delete_unit to free room now.`;
    }

    // Log the population rejection with the RIGHT advice: at the hard cap, houses
    // and Town Centers are useless and only delete_unit frees a slot. Mirrors the
    // branch in popCapAdvice above so the log never contradicts what the model was
    // told. (The localized log line used to flatten both cases into "build houses",
    // which read as bad advice at 100/100 even though the model's English text was
    // correct.)
    popCapOutcome(ai) {
        const cap = (typeof MAX_POPULATION_CAP !== 'undefined') ? MAX_POPULATION_CAP : 100;
        const hard = ai.resources.maxPopulation >= cap;
        this.outcome(hard ? 'log.out.populationHardCap' : 'log.out.populationLimit',
            { pop: Math.floor(ai.resources.population), max: ai.resources.maxPopulation, cap });
    }

    // Pick which finished, non-busy building actually trains the unit. If the model
    // gave params.targetX/targetZ, prefer the FREE trainer nearest that spot — so it
    // can direct production to a specific structure (a 2nd Town Center by a far
    // resource, a particular barracks…). If the structure nearest those coords is
    // busy, fall back to the next free one and say so. No coords → first free.
    chooseTrainer(freeList, finishedOfType, params) {
        const tx = Number(params && params.targetX), tz = Number(params && params.targetZ);
        if (!Number.isFinite(tx) || !Number.isFinite(tz)) return { b: freeList[0], note: '' };
        const nearestIn = (list) => list.reduce((best, b) => {
            const d = Math.hypot(b.x - tx, b.z - tz);
            return (!best || d < best.d) ? { b, d } : best;
        }, null);
        const chosen = nearestIn(freeList);
        const requested = nearestIn(finishedOfType);
        const redirected = requested && chosen && requested.b !== chosen.b && requested.b.isProducing;
        return { b: chosen.b, note: redirected ? ' (the structure nearest your coordinates was busy, so the next free one was used)' : '' };
    }

    executeTrainWorker(ai, game, params = {}) {
        // Models sometimes call train_worker but pass a military unit type. That's a
        // tool-calling mismatch: train_worker ALWAYS makes a villager at the Town
        // Center. Tell them the right action instead of silently training a worker.
        const ut = params && params.unitType;
        if (ut && ut !== 'worker') {
            this.outcome('log.out.trainWorkerNotUnit', { unitType: ut });
            return `[ERROR] train_worker only trains a Villager (worker) at the Town Center — it ignores unitType. To train "${ut}", use action "train_unit" with params.unitType="${ut}" (military units come from a barracks/archery_range/stable, not the Town Center).`;
        }
        const allTCs = ai.buildings.filter(b => b.type === 'town_center');
        if (allTCs.length === 0) {
            console.log(`[OpenAIAI] ${ai.id}: No Town Center at all to train worker`);
            const tcDef = (typeof getBuildingDef === 'function') ? getBuildingDef('town_center') : null;
            const costStr = tcDef ? this.costString(tcDef.cost) : '100 food, 100 wood, 100 stone, 100 gold';
            this.outcome('log.out.noTCTrain', {});
            return `[ERROR] You have NO Town Center, so you cannot train workers. Rebuild one: build_structure with buildingType="town_center" and a targetX/targetZ on open ground (costs ${costStr}; one of your existing workers constructs it). Until a Town Center stands you cannot make new workers.`;
        }
        const townCenters = allTCs.filter(b => !b.isProducing && !b.underConstruction);
        if (townCenters.length === 0) {
            console.log(`[OpenAIAI] ${ai.id}: Town Center busy/under construction`);
            this.outcome('log.out.tcBusy', {});
            return `[ERROR] Your Town Center is busy producing or still under construction — wait for it to finish, then train the worker.`;
        }

        // Check population limit before training worker
        if (ai.resources.population >= ai.resources.maxPopulation) {
            console.log(`[OpenAIAI] ${ai.id}: Population limit reached (${ai.resources.population}/${ai.resources.maxPopulation})`);
            this.popCapOutcome(ai);
            return `[ERROR] Population limit reached (${ai.resources.population}/${ai.resources.maxPopulation}). ${this.popCapAdvice(ai)}`;
        }

        const workerDef = getUnitDef('worker');
        if (!ai.resources.hasResources(workerDef.cost)) {
            console.log(`[OpenAIAI] ${ai.id}: Cannot afford worker`);
            this.outcome('log.out.cannotAfford', { whatName: 'Dorfbewohner', need: workerDef.cost, have: this.haveObj(ai) });
            return `[ERROR] Cannot afford a worker (needs ${this.costString(workerDef.cost)}). You have ${this.haveString(ai)}.`;
        }

        const { b: tc, note } = this.chooseTrainer(townCenters, allTCs.filter(b => !b.underConstruction), params);
        ai.resources.spendResources(workerDef.cost);
        tc.isProducing = true;
        tc.productionType = 'worker';
        tc.productionDuration = 5000;
        tc.productionProgress = 0;
        console.log(`[OpenAIAI] ${ai.id}: Training worker at Town Center (${Math.round(tc.x)}, ${Math.round(tc.z)})`);
        this.outcome('log.out.trainWorker', { x: Math.round(tc.x), z: Math.round(tc.z), food: Math.floor(ai.resources.food) });
        return `OK - Training a worker at the Town Center (${Math.round(tc.x)}, ${Math.round(tc.z)}) (~5s to produce; ${Math.floor(ai.resources.food)} food left). That Town Center is busy until it finishes.${note}`;
    }

    executeTrainUnit(ai, game, unitType, params = {}) {
        if (unitType === 'worker') return this.executeTrainWorker(ai, game, params);

        const civ = getCivilization(ai.civilization);
        const unitDef = getUnitDefFor(ai.civilization, unitType);
        if (!unitDef) {
            console.log(`[OpenAIAI] ${ai.id}: Unknown unit type "${unitType}"`);
            this.outcome('log.out.unknownUnit', { unitType });
            // Categories are legal in the "units" parameter of move_units/attack_target
            // but never here, and only "cavalry" happens to also be a real id — so a
            // model that generalised from {"cavalry":5} lands on "infantry" and used to
            // get back nothing at all. Name the whole vocabulary instead.
            const cats = ['infantry', 'ranged', 'cavalry', 'support'];
            const catNote = cats.includes(String(unitType).toLowerCase())
                ? ` "${unitType}" is a unit CATEGORY: those work only in the "units" parameter of move_units/attack_target, never in train_unit, which needs one exact unit id.`
                : '';
            // "militia(stone)" — the age carried along from the state listing. Name
            // the bare id rather than making the model work it out.
            const stripped = String(unitType).replace(/\s*\(.*\)\s*$/, '').trim();
            const parenNote = (stripped !== String(unitType) && getUnitDefFor(ai.civilization, stripped))
                ? ` Pass just "${stripped}" — "trainableUnits" groups ids under the age they need, and the age is not part of the id.`
                : '';
            return `[ERROR] Unknown unit type "${unitType}".${catNote}${parenNote} ${this.trainableListString(ai)} See "trainableUnits" in the state for the age each one needs.`;
        }

        const ageOrder = ['stone', 'neolithic', 'bronze', 'iron'];
        const reqB = this.requiredBuildingForUnit(unitType, ai.civilization); // 'barracks' | 'stable' | 'archery_range' | 'temple' | null
        const rightType = (b) => reqB ? (b.type === reqB) : false;

        // Validation follows the advancement chain so the message always points at
        // the EARLIEST unmet step: Research → Build → Advance → Population → Resources.
        if (reqB) {
            const finishedOfType = ai.buildings.filter(b => rightType(b) && !b.underConstruction);

            // 1) RESEARCH / BUILD: no finished building of the right type yet.
            if (finishedOfType.length === 0) {
                if (ai.buildings.some(b => rightType(b) && b.underConstruction)) {
                    this.outcome('log.out.buildingUnderConstr', { building: reqB, unitType });
                    return `[ERROR] Your ${reqB} is still under construction. Wait for it to finish, then train ${unitType}.`;
                }
                const bdef = getBuildingDef(reqB);
                const tech = bdef && bdef.requiresTech;
                const civTree = civ.techTree || {};
                if (tech && !civTree[tech]) {
                    this.outcome('log.out.civCannotTrain', { unitType, building: reqB });
                    return `[ERROR] Your civilization cannot train ${unitType} — it has no ${reqB} (no "${tech}" technology). Train a different unit class (barracks=infantry, archery_range=archers, stable=cavalry; see "buildableStructures").`;
                }
                if (tech && !ai.researchedTechs[tech]) {
                    this.outcome('log.out.unitBuildingNotUnlocked', { unitType, building: reqB, tech });
                    return `[ERROR] ${unitType} is trained at a ${reqB}, which you have not unlocked. research_tech "${tech}" first, then build_structure "${reqB}", then train.`;
                }
                this.outcome('log.out.unitBuildingNotBuilt', { unitType, building: reqB });
                return `[ERROR] ${unitType} is trained at a ${reqB}, which you have not built yet. build_structure "${reqB}" and wait for it to finish, then train.`;
            }

            // 2) ADVANCE: the building exists but the unit is gated to a later epoch.
            if (!this.buildingTrains(finishedOfType[0], unitType, ai.age, ai.civilization)) {
                const minAge = this.minAgeForUnit(unitType);
                if (minAge && ageOrder.indexOf(minAge) > ageOrder.indexOf(ai.age)) {
                    this.outcome('log.out.unitNeedsAge', { unitType, minAge, age: ai.age });
                    return `[ERROR] ${unitType} needs the ${minAge} age (you are in ${ai.age}). Advance your age first (upgrade_age); your ${reqB} will train it then.`;
                }
                this.outcome('log.out.buildingCannotTrainTier', { building: reqB, unitType });
                return `[ERROR] Your ${reqB} cannot train ${unitType} at your current tier. Check what it can produce for your age.`;
            }
        }

        // From here a finished, age-capable building exists. Trainers for this unit:
        const trainers = ai.buildings.filter(b => !b.underConstruction && this.buildingTrains(b, unitType, ai.age, ai.civilization));
        if (trainers.length === 0) {
            // Only reached for unique units with no tier mapping (reqB null).
            this.outcome('log.out.noBuildingTrains', { unitType });
            return `[ERROR] No finished building can train ${unitType}. Build the matching military building first (barracks=infantry, archery_range=archers, stable=cavalry).`;
        }

        // 3) POPULATION (structural train-time gate).
        if (ai.resources.population >= ai.resources.maxPopulation) {
            console.log(`[OpenAIAI] ${ai.id}: Population limit reached (${ai.resources.population}/${ai.resources.maxPopulation})`);
            this.popCapOutcome(ai);
            return `[ERROR] Population limit reached (${ai.resources.population}/${ai.resources.maxPopulation}). ${this.popCapAdvice(ai)}`;
        }

        // 4) BUSY: a trainer exists but all are mid-production (transient).
        const freeTrainers = trainers.filter(b => !b.isProducing);
        if (freeTrainers.length === 0) {
            const tName = trainers[0].type;
            this.outcome('log.out.trainerBusy', { building: tName });
            return `[ERROR] Your ${tName} is busy producing right now. Wait for it to finish, or build another ${tName} to train in parallel.`;
        }

        // 5) RESOURCES.
        if (!ai.resources.hasResources(unitDef.cost)) {
            console.log(`[OpenAIAI] ${ai.id}: Cannot afford ${unitType}`);
            this.outcome('log.out.cannotAfford', { whatName: unitDef.name, need: unitDef.cost, have: this.haveObj(ai) });
            return `[ERROR] Cannot afford ${unitType} (needs ${this.costString(unitDef.cost)}). You have ${this.haveString(ai)}.`;
        }

        // TRAIN — at the structure the model targeted (params.targetX/Z), else the
        // first free one; a busy targeted structure falls back to the next free.
        const { b: free, note } = this.chooseTrainer(freeTrainers, trainers, params);
        ai.resources.spendResources(unitDef.cost);
        free.isProducing = true;
        free.productionType = unitType;
        free.productionDuration = 5000;
        free.productionProgress = 0;
        console.log(`[OpenAIAI] ${ai.id}: Training ${unitType} at ${free.name} (${Math.round(free.x)}, ${Math.round(free.z)})`);
        this.outcome('log.out.trainUnit', { unitName: unitDef.name, x: Math.round(free.x), z: Math.round(free.z) });
        return `OK - Training ${unitType} at ${free.name} (${Math.round(free.x)}, ${Math.round(free.z)}) (~5s to produce; that building is busy until it finishes).${note}`;
    }

    executeResearchTech(ai, game, techId) {
        const civ = getCivilization(ai.civilization);
        const tech = civ?.techTree?.[techId];
        if (!tech) {
            console.log(`[OpenAIAI] ${ai.id}: Unknown tech "${techId}"`);
            const ageOrder = ['stone', 'neolithic', 'bronze', 'iron'];
            const nextAge = ageOrder[ageOrder.indexOf(ai.age) + 1] || null;
            const ageNote = nextAge
                ? ` To advance to the next age use upgrade_age (NOT research_tech) — your next epoch is "${nextAge}" (see "epoch.nextEpoch"/"epoch.nextEpochCost").`
                : ` You are already in the final age ("${ai.age}").`;
            // Age transitions ("NeolithicToBronze", "advance_to_bronze", …) are not
            // techs. No word boundaries — they don't fire inside camelCase or across "_".
            const ageLike = /age|epoch|advance|stone|neolithic|bronze|iron/i.test(String(techId));
            if (ageLike) {
                this.outcome('log.out.notAResearchTech', { techId });
                return `[ERROR] "${techId}" is not a research tech — advancing AGES is a separate action.${ageNote} For actual technologies, use an exact ID from "research.available".`;
            }
            // Building names are the other near-miss. Several unlock techs ARE named
            // after their building (house, farm, barracks, market), which teaches the
            // pattern — so a model reaches for "stable" or "temple" too, where the
            // tech is called something else entirely or does not exist. The age branch
            // above has caught its own near-miss for a while; this is the same idea.
            const asBuilding = (typeof getBuildingDef === 'function') ? getBuildingDef(String(techId)) : null;
            if (asBuilding) {
                const need = asBuilding.requiresTech;
                const how = need
                    ? (civ?.techTree?.[need]
                        ? `Its unlock tech is "${need}" — research that, then build_structure "${techId}".`
                        : `Your civilization has no tech for it, so it cannot build a ${techId}.`)
                    : `It needs no tech — build_structure "${techId}" directly (check its age in "buildableStructures").`;
                this.outcome('log.out.techIsBuilding', { techId, need: need || '-' });
                return `[ERROR] "${techId}" is a BUILDING, not a technology. ${how} See "buildableStructures" for the age and unlock tech of every structure.`;
            }
            this.outcome('log.out.unknownTech', { techId });
            return `[ERROR] Unknown tech "${techId}". Use an exact tech ID from "research.available".${ageNote}`;
        }

        if (ai.researchedTechs[techId]) {
            console.log(`[OpenAIAI] ${ai.id}: Tech "${techId}" already researched`);
            this.outcome('log.out.alreadyResearched', { techId });
            return `[ERROR] Tech "${techId}" already researched! Check "research.researched" list before researching.`;
        }

        if (ai.currentResearch) {
            console.log(`[OpenAIAI] ${ai.id}: Already researching a tech`);
            this.outcome('log.out.alreadyResearching', { techId: ai.currentResearch.techId });
            return `[ERROR] Already researching "${ai.currentResearch.techId}". Wait for it to complete first.`;
        }

        // Check age requirement
        const ageOrder = ['stone', 'neolithic', 'bronze', 'iron'];
        if (ageOrder.indexOf(tech.requiredAge) > ageOrder.indexOf(ai.age)) {
            console.log(`[OpenAIAI] ${ai.id}: Tech "${techId}" requires ${tech.requiredAge}`);
            this.outcome('log.out.techNeedsAge', { techId, reqAge: tech.requiredAge, age: ai.age });
            return `[ERROR] "${techId}" needs the ${tech.requiredAge} age, but you are in ${ai.age}. Advance your age first (upgrade_age).`;
        }

        // Check prerequisites
        if (tech.requires) {
            for (const req of tech.requires) {
                if (!ai.researchedTechs[req]) {
                    console.log(`[OpenAIAI] ${ai.id}: Missing prerequisite "${req}" for "${techId}"`);
                    this.outcome('log.out.missingPrereq', { req, techId });
                    return `[ERROR] Missing prerequisite "${req}" for "${techId}". Research "${req}" first.`;
                }
            }
        }

        // Check we have the FINISHED building this tech is researched at —
        // generic, so temple research works like town_center and market.
        const hostType = tech.researchAt || 'town_center';
        if (!ai.buildings.some(b => b.type === hostType && !b.underConstruction)) {
            console.log(`[OpenAIAI] ${ai.id}: Need a finished ${hostType} to research "${techId}"`);
            if (hostType === 'market') {
                const hasMarketTech = !!ai.researchedTechs['market'];
                const step = hasMarketTech ? 'build a Market (build_structure "market") and wait for it to finish'
                    : 'first research "market", then build a Market and wait for it to finish';
                this.outcome('log.out.researchedElsewhere', { techName: tech.name, hostName: (getBuildingDef(hostType) || {}).name || hostType });
                return `[ERROR] "${techId}" is researched at a Market, which you don't have. To enable it: ${step}.`;
            }
            this.outcome('log.out.researchedElsewhere', { techName: tech.name, hostName: (getBuildingDef(hostType) || {}).name || hostType });
            return `[ERROR] "${techId}" is researched at a finished ${hostType}, which you don't have. Build it first (build_structure "${hostType}"), then research again.`;
        }

        const costMultiplier = ai.techCostMultiplier || 1;
        const adjustedCost = {
            food: Math.floor((tech.cost.food || 0) * costMultiplier),
            wood: Math.floor((tech.cost.wood || 0) * costMultiplier),
            stone: Math.floor((tech.cost.stone || 0) * costMultiplier),
            gold: Math.floor((tech.cost.gold || 0) * costMultiplier)
        };

        if (!ai.resources.hasResources(adjustedCost)) {
            console.log(`[OpenAIAI] ${ai.id}: Cannot afford tech "${techId}"`);
            this.outcome('log.out.cannotAfford', { whatName: tech.name, need: adjustedCost, have: this.haveObj(ai) });
            return `[ERROR] Cannot afford tech "${techId}" (needs ${this.costString(adjustedCost)}). You have ${this.haveString(ai)}.`;
        }

        ai.resources.spendResources(adjustedCost);
        ai.currentResearch = {
            techId: techId,
            progress: 0,
            duration: tech.researchTime || 15000
        };
        console.log(`[OpenAIAI] ${ai.id}: Researching "${tech.name}" (${techId})`);
        const researchSecs = Math.round((tech.researchTime || 15000) / 1000);
        this.outcome('log.out.researchStarted', { techName: tech.name, secs: researchSecs });
        return `OK - Researching "${techId}" — ~${researchSecs}s to complete. Only one tech at a time; don't re-issue until "research.current" is empty (it shows secondsRemaining).`;
    }

    executeUpgradeAge(ai, game) {
        const ages = ['stone', 'neolithic', 'bronze', 'iron'];
        const currentIdx = ages.indexOf(ai.age);
        if (currentIdx >= ages.length - 1) {
            console.log(`[OpenAIAI] ${ai.id}: Already at max age`);
            this.outcome('log.out.maxAge', {});
            return `[ERROR] Already at max age (Iron Age).`;
        }

        if (ai.currentAgeUpgrade) {
            console.log(`[OpenAIAI] ${ai.id}: Already upgrading age`);
            this.outcome('log.out.alreadyUpgrading', { age: ai.currentAgeUpgrade.targetAge });
            return `[ERROR] Already upgrading age to "${ai.currentAgeUpgrade.targetAge}". Wait for completion.`;
        }

        const nextAge = ages[currentIdx + 1];
        // Shared cost table (civilizations.js) — identical for every player type.
        const cost = AGE_COSTS[nextAge];
        if (!ai.resources.hasResources(cost)) {
            console.log(`[OpenAIAI] ${ai.id}: Cannot afford upgrade to ${nextAge}`);
            this.outcome('log.out.cannotAfford', { age: nextAge, need: cost, have: this.haveObj(ai) });
            return `[ERROR] Cannot afford the upgrade to ${nextAge} (needs ${this.costString(cost)}). You have ${this.haveString(ai)}.`;
        }

        ai.resources.spendResources(cost);
        ai.currentAgeUpgrade = {
            targetAge: nextAge,
            progress: 0,
            duration: 30000
        };
        console.log(`[OpenAIAI] ${ai.id}: Upgrading to ${nextAge}`);
        const ageSecs = Math.round((ai.currentAgeUpgrade.duration || 30000) / 1000);
        this.outcome('log.out.ageUpStarted', { age: nextAge, secs: ageSecs });
        return `OK - Advancing to the ${nextAge} age — ~${ageSecs}s to complete. Keep developing meanwhile; "epoch.upgradeInProgress" shows secondsRemaining, so don't re-issue upgrade_age until it is done.`;
    }

    executeBuildStructure(ai, game, buildingType, targetX, targetZ) {
        const buildingDef = getBuildingDef(buildingType);
        if (!buildingDef) {
            console.log(`[OpenAIAI] ${ai.id}: Unknown building "${buildingType}"`);
            this.outcome('log.out.unknownBuilding', { buildingType });
            // NOT unlockedContent.buildings: that lists only what you have ALREADY
            // unlocked and is empty on turn 1, so the old message sent the model to
            // an empty array. buildableStructures is the complete list, with each
            // type's required age and unlock tech.
            return `[ERROR] Unknown building "${buildingType}". Use a "type" from "buildableStructures" — it lists every structure your civilization can build, with the age and unlock tech each needs.`;
        }

        // ADVANCE first: a building gated to a later epoch can't be built yet. (Most
        // age-gated buildings also need a tech, but some — e.g. the temple — only
        // need the age, so check it before the tech/resource steps.)
        const ageOrder = ['stone', 'neolithic', 'bronze', 'iron'];
        const effAge = (typeof effectiveBuildingAge === 'function') ? effectiveBuildingAge(ai.civilization, buildingDef) : buildingDef.requiredAge;
        if (effAge && ageOrder.indexOf(ai.age) < ageOrder.indexOf(effAge)) {
            console.log(`[OpenAIAI] ${ai.id}: ${buildingType} needs ${effAge}`);
            this.outcome('log.out.buildingNeedsAge', { buildingType, effAge, age: ai.age });
            return `[ERROR] ${buildingType} needs the ${effAge} age (you are in ${ai.age}). Advance your age first (upgrade_age), then build it.`;
        }

        // RESEARCH next: the building's enabling tech.
        if (buildingDef.requiresTech && !ai.researchedTechs[buildingDef.requiresTech]) {
            console.log(`[OpenAIAI] ${ai.id}: Need tech "${buildingDef.requiresTech}" for ${buildingType}`);
            const civTree = getCivilization(ai.civilization).techTree || {};
            // Some civilizations simply do not have the tech (e.g. no stable). Say so
            // clearly so the model stops retrying and switches strategy.
            if (!civTree[buildingDef.requiresTech]) {
                this.outcome('log.out.civCannotBuild', { buildingType, tech: buildingDef.requiresTech });
                return `[ERROR] Your civilization cannot build ${buildingType} — it has no "${buildingDef.requiresTech}" technology. Use a different building. See "buildableStructures" for what you CAN build (e.g. barracks for infantry, archery_range for archers).`;
            }
            this.outcome('log.out.buildNeedsTech', { tech: buildingDef.requiresTech, buildingType });
            return `[ERROR] You must research "${buildingDef.requiresTech}" before you can build ${buildingType}. Use research_tech first (it should appear in "research.available"), then build.`;
        }

        if (!ai.resources.hasResources(buildingDef.cost)) {
            console.log(`[OpenAIAI] ${ai.id}: Cannot afford ${buildingType}`);
            this.outcome('log.out.cannotAfford', { whatName: buildingDef.name, need: buildingDef.cost, have: this.haveObj(ai) });
            return `[ERROR] Cannot afford ${buildingType} (needs ${this.costString(buildingDef.cost)}). You have ${this.haveString(ai)}.`;
        }

        // Find placement position
        let x, z;
        const townCenters = ai.buildings.filter(b => b.type === 'town_center');
        const tc = townCenters[0] || null;
        if (targetX !== undefined && targetZ !== undefined) {
            x = targetX;
            z = targetZ;
        } else if (tc) {
            // Default: a ring around the town centre, so buildings spread out.
            // Roughly double the old radius so bases occupy a larger footprint.
            const ang = Math.random() * Math.PI * 2;
            const rad = 18 + Math.random() * 28;
            x = tc.x + Math.cos(ang) * rad;
            z = tc.z + Math.sin(ang) * rad;
        } else {
            this.outcome('log.out.noTCPlacement', {});
            return `[ERROR] No Town Center found for placement reference.`;
        }

        // Validate position: keep walkable gaps between buildings AND an exclusion
        // zone around resource nodes (so harvesters can still reach them).
        const spot = this.findClearSpot(ai, game, buildingType, buildingDef.type === 'wonder', x, z);
        if (!spot) {
            console.log(`[OpenAIAI] ${ai.id}: Could not find valid position for ${buildingType}`);
            this.outcome('log.out.noClearSpot', { buildingType });
            return `[ERROR] Could not find a clear spot for ${buildingType} (too crowded by buildings or resource nodes). Try a different targetX/targetZ.`;
        }
        ({ x, z } = spot);

        // Decide who will build it BEFORE spending. Only idle workers build; a busy
        // worker is borrowed (and resumes its task) only when at the population cap.
        // forceBorrow: like the rule-based AI, a busy harvester is pulled to build
        // and returns to its old task afterwards. Without it, LLM players whose
        // workers were all gathering had their builds rejected while rule-based
        // rivals borrowed freely — an unfair asymmetry between controller types.
        const pick = game.pickBuilder(ai, { x, z }, { forceBorrow: true });
        if (pick.error === 'no_workers') {
            this.outcome('log.out.noWorkersBuild', { buildingType });
            return `[ERROR] You have no workers to build ${buildingType}.`;
        }
        if (pick.error === 'no_idle') {
            this.outcome('log.out.noWorkerIdleBuild', { buildingType });
            return `[ERROR] No worker available to build ${buildingType} — all your workers are constructing other sites or fighting (neither is ever pulled). Wait for one to finish.`;
        }

        ai.resources.spendResources(buildingDef.cost);
        // Place a construction site and send the chosen worker to build it (pop bonus
        // is granted on completion via game.completeConstruction).
        const building = createBuilding(buildingType, x, z, ai.id, ai.civilization, { underConstruction: true, age: ai.age });
        ai.buildings.push(building);
        game.renderer.addBuilding(building);
        game.applyBuilder(pick, building);

        console.log(`[OpenAIAI] ${ai.id}: Started ${buildingDef.name} at (${Math.round(x)}, ${Math.round(z)})`);
        const secs = Math.round((building.buildTime || 10000) / 1000);
        this.outcome('log.out.buildStarted', { buildingName: buildingDef.name, x: Math.round(x), z: Math.round(z), secs });
        return pick.restore
            ? `OK - Construction of "${buildingType}" started at (${Math.round(x)}, ${Math.round(z)}); a worker was pulled off its task to build (~${secs}s) and will return afterwards.`
            : `OK - Construction of "${buildingType}" started at (${Math.round(x)}, ${Math.round(z)}); an idle worker is building it (~${secs}s).`;
    }

    // Build this civ's Wonder. Win by holding it for the required time.
    // Shared placement validation: nudge (x, z) until it keeps a walkable gap to
    // EVERY existing building (11 to Town Centers/Wonders, 9 otherwise) and stays
    // outside every live resource node's clearance ring. Up to 40 nudge attempts;
    // returns {x, z} or null. Used by build_structure AND build_wonder — the
    // Wonder used to skip validation entirely and could land on top of the base.
    findClearSpot(ai, game, buildingType, isWonderBuild, x, z) {
        const reqGap = b => (b.type === 'town_center' || b.isWonder) ? 11 : 9;
        const resClr = game.resourceClearance(buildingType, isWonderBuild);
        let valid = false;
        let attempts = 0;
        while (!valid && attempts < 40) {
            valid = true;
            const allBuildings = [...ai.buildings, ...game.player.buildings, ...game.aiManager.aiPlayers.flatMap(a => a.buildings)];
            for (const b of allBuildings) {
                const dx = x - b.x;
                const dz = z - b.z;
                const need = reqGap(b);
                const d = Math.sqrt(dx * dx + dz * dz);
                if (d < need) {
                    valid = false;
                    const dd = d || 1;
                    x = b.x + (dx / dd) * (need + 1) + (Math.random() - 0.5) * 3;
                    z = b.z + (dz / dd) * (need + 1) + (Math.random() - 0.5) * 3;
                    break;
                }
            }
            if (!valid) { attempts++; continue; }
            // Resource exclusion: shove the candidate out of any node's clearance ring.
            const nodes = (game.terrain && game.terrain.resources) || [];
            for (const r of nodes) {
                if (r.amount !== undefined && r.amount <= 0) continue;
                const dx = x - r.x;
                const dz = z - r.z;
                const d = Math.sqrt(dx * dx + dz * dz);
                if (d < resClr) {
                    valid = false;
                    const dd = d || 1;
                    x = r.x + (dx / dd) * (resClr + 1) + (Math.random() - 0.5) * 3;
                    z = r.z + (dz / dd) * (resClr + 1) + (Math.random() - 0.5) * 3;
                    break;
                }
            }
            attempts++;
        }
        return valid ? { x, z } : null;
    }

    // One candidate, judged in place (no nudging): far enough from every building,
    // outside every live node's clearance ring, and on solid map ground.
    // Constants mirror findClearSpot — keep the two in sync.
    isSpotClear(ai, game, buildingType, isWonderBuild, x, z) {
        if (game.clampToMap) {
            const c = game.clampToMap(x, z);
            if (Math.abs(c.x - x) > 0.5 || Math.abs(c.z - z) > 0.5) return false; // off-map
        }
        const reqGap = b => (b.type === 'town_center' || b.isWonder) ? 11 : 9;
        const allBuildings = [...ai.buildings, ...game.player.buildings, ...game.aiManager.aiPlayers.flatMap(a => a.buildings)];
        for (const b of allBuildings) {
            if (Math.hypot(x - b.x, z - b.z) < reqGap(b)) return false;
        }
        const resClr = game.resourceClearance(buildingType, isWonderBuild);
        for (const r of (game.terrain && game.terrain.resources) || []) {
            if (r.amount !== undefined && r.amount <= 0) continue;
            if (Math.hypot(x - r.x, z - r.z) < resClr) return false;
        }
        return true;
    }

    executeBuildWonder(ai, game) {
        const civ = getCivilization(ai.civilization);
        const wonderDef = (civ.uniqueBuildings || []).find(b => b.type === 'wonder');
        if (!wonderDef) { this.outcome('log.out.noWonder', {}); return `[ERROR] Your civilization has no Wonder.`; }

        const ageOrder = ['stone', 'neolithic', 'bronze', 'iron'];
        const reqAge = wonderDef.requiredAge || 'iron';
        if (ageOrder.indexOf(ai.age) < ageOrder.indexOf(reqAge)) {
            this.outcome('log.out.wonderNeedsAge', { reqAge, age: ai.age });
            return `[ERROR] The Wonder requires the ${reqAge} age. You are in ${ai.age}. Advance your age first.`;
        }
        if (ai.buildings.some(b => b.isWonder)) {
            this.outcome('log.out.alreadyWonder', {});
            return `[ERROR] You are already building or holding a Wonder.`;
        }
        if (!ai.resources.hasResources(wonderDef.cost)) {
            const c = wonderDef.cost;
            this.outcome('log.out.cannotAfford', { whatName: wonderDef.name, need: c, have: this.haveObj(ai) });
            return `[ERROR] Cannot afford the Wonder (needs ${this.costString(c)}). You have ${this.haveString(ai)}.`;
        }

        // Place near the town center — through the SAME placement validation as
        // build_structure (building gaps + resource clearance). The Wonder used to
        // be dropped blindly at TC ± 10 and could overlap whatever stood there.
        const tc = ai.buildings.find(b => b.type === 'town_center');
        const seedX = tc ? tc.x + (Math.random() - 0.5) * 20 : 0;
        const seedZ = tc ? tc.z + (Math.random() - 0.5) * 20 : 0;
        let spot = this.findClearSpot(ai, game, wonderDef.id, true, seedX, seedZ);
        // Late game means a full base: when the nudge search finds no room in the
        // center, sweep expanding rings around the TC (out to ~90 units) and take
        // the first clear spot — the Wonder gets a suburb before it gets refused.
        if (!spot && tc) {
            outer:
            for (let radius = 14; radius <= 90; radius += 8) {
                const steps = Math.max(8, Math.round((2 * Math.PI * radius) / 12));
                const a0 = Math.random() * Math.PI * 2;
                for (let s = 0; s < steps; s++) {
                    const ang = a0 + (s / steps) * 2 * Math.PI;
                    const cx = tc.x + Math.cos(ang) * radius;
                    const cz = tc.z + Math.sin(ang) * radius;
                    if (this.isSpotClear(ai, game, wonderDef.id, true, cx, cz)) { spot = { x: cx, z: cz }; break outer; }
                }
            }
        }
        if (!spot) {
            this.outcome('log.out.noClearSpotWonder', {});
            return `[ERROR] No clear spot for the Wonder within ~90 units of your Town Center — even the outskirts are packed. destroy_building an old structure to make room, then build_wonder again.`;
        }
        const { x, z } = spot;

        // forceBorrow: parity with the rule-based AI (see executeBuildStructure).
        // This exact rejection blocked a Persian Iron-age player from starting an
        // affordable Wonder because all its workers were out gathering.
        const pick = game.pickBuilder(ai, { x, z }, { forceBorrow: true });
        if (pick.error === 'no_workers') { this.outcome('log.out.noWorkersWonder', {}); return `[ERROR] You have no workers to build the Wonder.`; }
        if (pick.error === 'no_idle') { this.outcome('log.out.noWorkerIdleWonder', {}); return `[ERROR] No worker available to start the Wonder — all your workers are constructing other sites or fighting (neither is ever pulled). Wait for one to finish.`; }

        ai.resources.spendResources(wonderDef.cost);
        const wonder = createBuilding(wonderDef.id, x, z, ai.id, ai.civilization, { underConstruction: true, age: ai.age });
        ai.buildings.push(wonder);
        game.renderer.addBuilding(wonder);
        game.applyBuilder(pick, wonder);
        const secs = Math.round((wonder.buildTime || 60000) / 1000);
        this.outcome('log.out.wonderStarted', { secs, hold: (game.wonderRequired || 600) });
        return `OK - Started building the Wonder (~${secs}s to build). Hold it for ${(game.wonderRequired || 600)}s after completion to WIN — defend it, rivals will rush it!`;
    }

    // Resolve an optional { type: count } selection into concrete units for a
    // move/attack order. No map → the WHOLE army (all non-worker units). With a
    // map, take the `count` units of each named type CLOSEST to (dx,dz) — clamp
    // to what the player actually owns and skip types it doesn't, reporting the
    // delta in `note`; never hard-fail on a too-big count or an unowned type.
    // Types match a unit's specific id-type ("champion") OR its category
    // ("cavalry"), like delete_unit. Support units (priests) are split out so
    // callers escort them rather than send them to fight. Because the no-map
    // case returns every priest in `support`, escortSupportUnits(sel.support,…)
    // escorts the whole clergy on a full-army order and only the named priests
    // on a detachment — no special-casing needed.
    selectOrderedUnits(ai, unitsMap, dx, dz) {
        // Workers are a THIRD bucket, not combat: move_units takes them along, attack
        // never does. Naming "worker" explicitly is how a model puts a unit on an
        // exact spot now that explore works in whole tiles — but omitting "units"
        // still means the army alone, so a bare move order never drags the economy
        // across the map.
        const split = (arr) => ({
            combat: arr.filter(u => u.type !== 'worker' && u.unitType !== 'support'),
            support: arr.filter(u => u.type !== 'worker' && u.unitType === 'support'),
            workers: arr.filter(u => u.type === 'worker')
        });
        const hasMap = unitsMap && typeof unitsMap === 'object' && !Array.isArray(unitsMap) && Object.keys(unitsMap).length > 0;
        if (!hasMap) return Object.assign(split(ai.units.filter(u => u.type !== 'worker' && u.health > 0)), { note: '' });
        const live = ai.units.filter(u => u.health > 0);

        const chosen = new Set();
        const clamped = [], skipped = [];
        for (const rawType of Object.keys(unitsMap)) {
            const type = String(rawType).trim().toLowerCase();
            const want = Math.floor(Number(unitsMap[rawType]));
            if (!Number.isFinite(want) || want <= 0) { skipped.push(`${rawType} (bad count)`); continue; }
            const pool = live.filter(u => !chosen.has(u) &&
                ((u.type || '').toLowerCase() === type || (u.unitType || '').toLowerCase() === type));
            if (!pool.length) { skipped.push(`${rawType} (own none)`); continue; }
            pool.sort((a, b) => Math.hypot(a.x - dx, a.z - dz) - Math.hypot(b.x - dx, b.z - dz));
            const take = Math.min(want, pool.length);
            if (want > pool.length) clamped.push(`${rawType} ${want}->${pool.length}`);
            for (let i = 0; i < take; i++) chosen.add(pool[i]);
        }
        let note = '';
        if (clamped.length) note += ` (clamped to what you own: ${clamped.join(', ')})`;
        if (skipped.length) note += ` (skipped: ${skipped.join(', ')})`;
        return Object.assign(split([...chosen]), { note });
    }

    // Human-readable tally of a player's non-worker force, for mismatch feedback.
    forceComposition(ai) {
        const counts = {};
        ai.units.forEach(u => { if (u.type !== 'worker' && u.health > 0) counts[u.type] = (counts[u.type] || 0) + 1; });
        const parts = Object.entries(counts).map(([t, n]) => `${t}×${n}`);
        return parts.length ? parts.join(', ') : '(no military)';
    }

    executeMoveUnits(ai, game, unitsMap, targetX, targetZ) {
        // Validate the destination first so bad coords never strand units at NaN.
        const mx = Number(targetX), mz = Number(targetZ);
        if (!Number.isFinite(mx) || !Number.isFinite(mz)) {
            this.outcome('log.out.moveNeedsCoords', {});
            return `[ERROR] move_units needs numeric "targetX" and "targetZ" (map coordinates inside map.bounds). Got targetX=${JSON.stringify(targetX)}, targetZ=${JSON.stringify(targetZ)}.`;
        }
        // Keep the destination on solid ground (no marching into the ocean).
        ({ x: targetX, z: targetZ } = game.clampToMap(mx, mz));

        // Optional {type:count} detachment; a move order repositions the whole
        // named force, priests included (they come along on a move as always).
        const sel = this.selectOrderedUnits(ai, unitsMap, targetX, targetZ);
        const unitsToMove = [...sel.combat, ...sel.support, ...sel.workers];
        if (unitsToMove.length === 0) {
            const ownsMilitary = ai.units.some(u => u.type !== 'worker' && u.health > 0);
            if (ownsMilitary) {
                this.outcome('log.out.moveNoMatch', {});
                return `[ERROR] move_units matched none of your units${sel.note}. Name unit types you actually own (e.g. {"champion":3}, or {"worker":1} to place a worker exactly), or omit "units" to move your whole army. Your military: ${this.forceComposition(ai)}.`;
            }
            this.outcome('log.out.noMilitaryMove', {});
            return `[ERROR] You have no military units to move. Omitting "units" moves your army, and you have none yet — name {"worker":1} to reposition a worker instead, or train military units first.`;
        }

        let eta = 0;
        unitsToMove.forEach(unit => {
            game.clearRetaliation(unit);
            // A worker may be carrying, mid-harvest, or standing on a farm. Setting
            // task=null alone would leave the farm's assignedWorker pointing at a unit
            // that has walked away, so the farm would look manned and grow nothing.
            if (unit.type === 'worker') this.releaseUnitForOrders(unit);
            eta = Math.max(eta, this.travelEtaSec(unit, targetX, targetZ));
            unit.isMoving = true;
            unit.targetX = targetX;
            unit.targetZ = targetZ;
            unit.isAttacking = false;
            unit.attackTarget = null;
            unit.attackMove = null;
            unit.task = null;
            unit._orderToken = ++this._orderSeq; // new order → leaves any prior attack report
        });

        console.log(`[OpenAIAI] ${ai.id}: Moving ${unitsToMove.length} units to (${Math.round(targetX)}, ${Math.round(targetZ)})`);
        this.outcome('log.out.moveUnits', { count: unitsToMove.length, x: Math.round(targetX), z: Math.round(targetZ), eta });
        return `OK - Moving ${unitsToMove.length} unit(s) to (${Math.round(targetX)}, ${Math.round(targetZ)})${sel.note} — ~${eta}s to arrive; let them march before re-issuing.`;
    }

    executeAttackTarget(ai, game, targetId, unitsMap) {
        // Find target in all units and buildings
        let target = null;
        target = game.getAllUnits().find(u => (u.id || '') === targetId);
        if (!target) {
            target = game.getAllBuildings().find(b => (b.id || '') === targetId);
        }

        if (!target) {
            console.log(`[OpenAIAI] ${ai.id}: Target "${targetId}" not found`);
            this.outcome('log.out.targetNotFound', { targetId });
            return `[ERROR] Target "${targetId}" not found. ${this.attackTargetHint(ai, game)}`;
        }

        // Friendly-fire guard: a model must not attack its own units/buildings.
        if (this.isOwnedByAI(target, ai)) {
            console.log(`[OpenAIAI] ${ai.id}: Refused self-attack on "${target.name || target.type}"`);
            this.outcome('log.out.targetIsOwn', { target: target.name || target.type });
            return `[ERROR] Target "${target.name || target.type}" is your own ${target.type}. You cannot attack your own units or buildings. ${this.attackTargetHint(ai, game)}`;
        }

        // Optional {type:count} detachment closest to the target; no map → the
        // whole combat force. Support units are split out to escort, not fight.
        const sel = this.selectOrderedUnits(ai, unitsMap, target.x, target.z);
        const unitsToAttack = sel.combat;

        if (unitsToAttack.length === 0) {
            console.log(`[OpenAIAI] ${ai.id}: No units to attack with`);
            const ownsCombat = ai.units.some(u => u.type !== 'worker' && u.unitType !== 'support' && u.health > 0);
            if (ownsCombat) {
                this.outcome('log.out.attackNoMatch', {});
                return `[ERROR] attack matched none of your COMBAT units${sel.note}. Name types you own (e.g. {"champion":3}) or omit "units" to send your whole army. Your military: ${this.forceComposition(ai)}. ${this.attackTargetHint(ai, game)}`;
            }
            const priestNote = ai.units.some(u => u.unitType === 'support')
                ? ' Priests never fight — on an attack they escort your army and heal, but you have no COMBAT units to send.' : '';
            this.outcome('log.out.noMilitaryAttack', {});
            return `[ERROR] No military units available to attack. Train units first.${priestNote} ${this.attackTargetHint(ai, game)}`;
        }

        unitsToAttack.forEach(unit => {
            game.clearRetaliation(unit); // a fresh model order overrides the reflex
            unit.isAttacking = true;
            unit.attackTarget = target;
            // attack-move: if the target dies or slips away, keep pushing to its
            // last position and aggro whatever's nearby (enemies move).
            unit.attackMove = { x: target.x, z: target.z };
            unit.attackTimer = 0;
            unit.isMoving = true;
            unit.targetX = target.x;
            unit.targetZ = target.z;
            unit.task = null;
            unit._orderToken = ++this._orderSeq; // new order → leaves any prior attack report
        });
        // Priests march along as healers (never engage) — the whole clergy on a
        // full-army order, only the named priests on a detachment.
        const escorted = game.escortSupportUnits(sel.support, target.x, target.z);
        const escortNote = escorted ? ` ${escorted} priest(s) escort to heal (they stand back, never engage).` : '';

        console.log(`[OpenAIAI] ${ai.id}: ${unitsToAttack.length} units attacking "${target.name || target.type}"`);
        this.outcome('log.out.attackDispatched', { count: unitsToAttack.length, target: target.name || target.type });
        return `OK - ${unitsToAttack.length} units attacking "${target.name || target.type}".${sel.note}${escortNote}`;
    }

    executeAttackPosition(ai, game, targetX, targetZ, unitsMap) {
        const controller = this.aiControllers.find(c => c.aiPlayer === ai);

        const mx = Number(targetX), mz = Number(targetZ);
        if (!Number.isFinite(mx) || !Number.isFinite(mz)) {
            this.outcome('log.out.attackNeedsCoords', {});
            return `[ERROR] attack needs numeric "targetX"/"targetZ" (or a "targetId"). Got targetX=${JSON.stringify(targetX)}, targetZ=${JSON.stringify(targetZ)}. ${this.attackTargetHint(ai, game)}`;
        }
        // Keep the attack-move objective on solid ground.
        ({ x: targetX, z: targetZ } = game.clampToMap(mx, mz));

        // Optional {type:count} detachment closest to the destination; no map →
        // the whole combat force. Support units split out to escort, not fight.
        const sel = this.selectOrderedUnits(ai, unitsMap, targetX, targetZ);
        const unitsToAttack = sel.combat;
        if (unitsToAttack.length === 0) {
            const ownsCombat = ai.units.some(u => u.type !== 'worker' && u.unitType !== 'support' && u.health > 0);
            if (ownsCombat) {
                this.outcome('log.out.attackNoMatch', {});
                return `[ERROR] attack matched none of your COMBAT units${sel.note}. Name types you own (e.g. {"champion":3}) or omit "units" to send your whole army. Your military: ${this.forceComposition(ai)}. ${this.attackTargetHint(ai, game)}`;
            }
            const priestNote = ai.units.some(u => u.unitType === 'support')
                ? ' Priests never fight — on an attack they escort your army and heal, but you have no COMBAT units to send.' : '';
            this.outcome('log.out.noMilitaryAttack', {});
            return `[ERROR] No military units available to attack. Train units first.${priestNote} ${this.attackTargetHint(ai, game)}`;
        }

        // INSTANT checks on what sits AT the designated coordinates. Friendly target
        // and resource node are rejected immediately (no move). Empty space and a
        // valid enemy both dispatch the army and report the verdict ON ARRIVAL.
        const HIT = 8, RES = 5;
        let atSpot = null, nd = HIT;
        for (const e of [...game.getAllUnits(), ...game.getAllBuildings()]) {
            if (e.health <= 0) continue;
            const d = Math.hypot(e.x - targetX, e.z - targetZ);
            if (d <= nd) { nd = d; atSpot = e; }
        }
        if (atSpot && this.isOwnedByAI(atSpot, ai)) {
            this.outcome('log.out.attackOwnGround', { x: Math.round(targetX), z: Math.round(targetZ), type: atSpot.type });
            return `[ERROR] (${Math.round(targetX)}, ${Math.round(targetZ)}) is on your own ${atSpot.type}. You cannot attack your own units/buildings. ${this.attackTargetHint(ai, game)}`;
        }
        if (!atSpot) {
            const res = (game.terrain && game.terrain.resources) || [];
            const node = res.find(r => r.amount > 0 && Math.hypot(r.x - targetX, r.z - targetZ) <= RES);
            if (node) {
                this.outcome('log.out.attackResourceNode', { x: Math.round(targetX), z: Math.round(targetZ), res: node.type });
                return `[ERROR] (${Math.round(targetX)}, ${Math.round(targetZ)}) is a ${node.type} resource node, not an attack target. Workers gather it with assign_workers. ${this.attackTargetHint(ai, game)}`;
            }
        }

        // Seed an initial target if an enemy is already near the spot; either way the
        // units attack-MOVE to the location and engage whatever they meet on the way.
        const token = ++this._orderSeq;
        let nearest = null, minDist = 40;
        for (const entity of [...game.getAllUnits(), ...game.getAllBuildings()]) {
            if (this.isOwnedByAI(entity, ai) || entity.health <= 0) continue;
            const d = Math.hypot(entity.x - targetX, entity.z - targetZ);
            if (d < minDist) { minDist = d; nearest = entity; }
        }
        unitsToAttack.forEach(unit => {
            game.clearRetaliation(unit); // a fresh model order overrides the reflex
            unit.isAttacking = true;
            unit.attackTarget = nearest || null;
            unit.attackMove = { x: targetX, z: targetZ };
            unit.attackTimer = 0;
            unit.isMoving = true;
            unit.targetX = (nearest ? nearest.x : targetX);
            unit.targetZ = (nearest ? nearest.z : targetZ);
            unit.task = null;
            unit._orderToken = token;
        });
        if (controller) {
            controller.pendingAttackReports = controller.pendingAttackReports || [];
            controller.pendingAttackReports.push({ token, tx: targetX, tz: targetZ, units: unitsToAttack.slice(), startTime: Date.now() });
        }
        // Priests march along as healers (never engage) — the whole clergy on a
        // full-army order, only the named priests on a detachment.
        const escorted = game.escortSupportUnits(sel.support, targetX, targetZ);
        const escortNote = escorted ? ` ${escorted} priest(s) escort to heal (they stand back, never engage).` : '';

        const eta = this.travelEtaSec(unitsToAttack[0], targetX, targetZ);
        this.outcome('log.out.attackMoving', { count: unitsToAttack.length, x: Math.round(targetX), z: Math.round(targetZ), eta });
        return `OK - ${unitsToAttack.length} unit(s) attack-moving to (${Math.round(targetX)}, ${Math.round(targetZ)}) (~${eta}s).${sel.note}${escortNote} You will be told on arrival whether they engaged an enemy or found no valid target there — don't re-issue this attack meanwhile.`;
    }

    // Each frame, resolve open attack-move orders once the units arrive/engage and
    // queue the verdict for the model's NEXT prompt (and the spectator log).
    updateAttackReports(now) {
        const ARRIVE = 7, ENGAGE = 30, MAXWAIT = 120000;
        for (const controller of this.aiControllers) {
            const reports = controller.pendingAttackReports;
            if (!reports || !reports.length) continue;
            const ai = controller.aiPlayer;
            for (let i = reports.length - 1; i >= 0; i--) {
                const r = reports[i];
                // The verdict already reaches the MODEL synchronously — it is drained
                // into the next prompt as "RESULTS OF YOUR EARLIER ATTACK ORDER(S)".
                // The code/params here are for the spectator LOG, which could not use
                // the executeAction outcome side-channel because this resolves on a
                // later tick; without them the arrival line was the last one stuck in
                // English while the rest of the log spoke the model's language.
                const resolve = (msg, failed, code, params) => {
                    controller.pendingArrivalMessages = controller.pendingArrivalMessages || [];
                    controller.pendingArrivalMessages.push(msg);
                    this.logArrival(ai, msg, failed, {
                        lang: (controller.model && controller.model.language) || 'en', code, params
                    });
                    reports.splice(i, 1);
                };
                const onOrder = r.units.filter(u => u.health > 0 && ai.units.includes(u) && u._orderToken === r.token);
                if (onOrder.length === 0) {
                    if (r.units.every(u => u.health <= 0)) {
                        resolve(`Your attack force sent to (${Math.round(r.tx)}, ${Math.round(r.tz)}) was destroyed before arriving.`, true,
                            'log.out.attackDestroyedEnRoute', { x: Math.round(r.tx), z: Math.round(r.tz) });
                    } else {
                        reports.splice(i, 1); // those units got a new order — report superseded
                    }
                    continue;
                }
                const eng = onOrder.find(u => u.isAttacking && u.attackTarget && u.attackTarget.health > 0);
                if (eng) {
                    const tg = eng.attackTarget;
                    resolve(`Your attack force reached (${Math.round(r.tx)}, ${Math.round(r.tz)}) and ENGAGED an enemy ${tg.type}${tg.owner ? ` (${tg.owner})` : ''}.`, false,
                        'log.out.attackEngaged', { x: Math.round(r.tx), z: Math.round(r.tz), target: tg.type });
                    continue;
                }
                const arrived = onOrder.some(u => Math.hypot(u.x - r.tx, u.z - r.tz) <= ARRIVE) || onOrder.every(u => !u.isMoving);
                if (arrived) {
                    const enemyNear = [...this.game.getAllUnits(), ...this.game.getAllBuildings()]
                        .some(e => e.health > 0 && !this.isOwnedByAI(e, ai) && Math.hypot(e.x - r.tx, e.z - r.tz) <= ENGAGE);
                    if (enemyNear) resolve(`Your attack force reached (${Math.round(r.tx)}, ${Math.round(r.tz)}); an enemy is there and they are engaging.`, false,
                        'log.out.attackContact', { x: Math.round(r.tx), z: Math.round(r.tz) });
                    else resolve(`[ERROR] Your attack force reached (${Math.round(r.tx)}, ${Math.round(r.tz)}) but found NO valid target — the spot is empty (the enemy moved or was already destroyed). ${this.attackTargetHint(ai, this.game)}`, true,
                        'log.out.attackEmpty', { x: Math.round(r.tx), z: Math.round(r.tz) });
                    continue;
                }
                if (now - r.startTime > MAXWAIT) {
                    resolve(`Your attack force did not reach (${Math.round(r.tx)}, ${Math.round(r.tz)}) in time (blocked or fighting along the way).`, true,
                        'log.out.attackTooSlow', { x: Math.round(r.tx), z: Math.round(r.tz) });
                }
            }
        }
    }

    // Add a deferred attack outcome to the spectator decision log.
    logArrival(ai, msg, failed, extra = {}) {
        const civ = getCivilization(ai.civilization);
        const entry = {
            timestamp: Date.now(), playerId: ai.id,
            civName: civ?.name || ai.civilization,
            color: '#' + ((civ?.color ?? 0xffffff)).toString(16).padStart(6, '0'),
            action: 'attack_target', reason: '', result: msg, params: {},
            failed: !!failed, error: failed ? msg.replace(/^\[ERROR\]\s*/, '') : null,
            lang: extra.lang || 'en'
        };
        if (extra.code) { entry.outcomeCode = extra.code; entry.outcomeParams = extra.params || {}; }
        this.decisionLog.unshift(entry);
        if (this.decisionLog.length > this.maxLogEntries) this.decisionLog = this.decisionLog.slice(0, this.maxLogEntries);
    }

    // Resources are hidden until SCOUTED. Update the AI's discovery memory and
    // return the discovered (visible-or-remembered) nodes of a given type.
    // Short summary of what this AI has ACTUALLY discovered, by type — used to
    // ground a rejected harvest/assign so the model stops chasing a resource it
    // only imagines (it cannot see the rendered map; only "discoveredNodesOnMap").
    discoveredResourceSummary(ai, game) {
        const counts = {};
        const list = (game.terrain && game.terrain.resources) || [];
        list.forEach((res, idx) => {
            // Believed amount, so this summary agrees with discoveredNodesOnMap rather than
            // naming a type the state does not list (or omitting one it does).
            const k = this.knownAmount(ai, res, idx, game);
            if (k.known && k.amount > 0) {
                counts[res.type] = (counts[res.type] || 0) + 1;
            }
        });
        const parts = ['food', 'wood', 'stone', 'gold']
            .filter(t => counts[t])
            .map(t => `${t} (${counts[t]})`);
        return parts.length ? parts.join(', ') : 'nothing yet';
    }

    // How much this player BELIEVES is in a node. Live while the node is in sight,
    // otherwise the amount as last seen.
    //
    // Reading the live amount for a node out of sight leaked: a rival draining a
    // remembered node showed up as the number ticking down, and emptying it made the
    // node vanish from the list — enemy activity, in a place the player cannot see,
    // for free. Fog has to mean the contents are stale too, not just the position.
    knownAmount(ai, res, idx, game) {
        if (!ai._knownResIdx) ai._knownResIdx = new Set();
        if (!ai._knownResAmt) ai._knownResAmt = Object.create(null);
        if (this.isPositionVisibleToAI(ai, res.x, res.z, game)) {
            ai._knownResIdx.add(idx);
            ai._knownResAmt[idx] = Math.floor(res.amount);   // refresh what we can see
            return { amount: Math.floor(res.amount), visible: true, known: true };
        }
        const known = ai._knownResIdx.has(idx);
        return {
            amount: known ? (ai._knownResAmt[idx] != null ? ai._knownResAmt[idx] : Math.floor(res.amount)) : 0,
            visible: false, known
        };
    }

    discoveredNodesOfType(ai, game, resourceType) {
        const out = [];
        const list = (game.terrain && game.terrain.resources) || [];
        list.forEach((res, idx) => {
            const k = this.knownAmount(ai, res, idx, game);
            // BELIEVED amount, not the live one: otherwise a node the state still
            // lists (because the player last saw it full) would be refused here as
            // "not discovered", and the model gets two contradictory answers.
            if (k.known && res.type === resourceType && k.amount > 0) out.push(res);
        });
        return out;
    }

    // True only if a unit is ACTIVELY fighting a live target (so we must not pull it
    // off to scout). A unit merely marching to a stale attack-move objective — no
    // living target — is NOT fighting and may be redirected; otherwise a cavalry
    // with a leftover attack flag was skipped and explore silently picked a worker,
    // leaving the cavalry standing still while move_units (no such filter) worked.
    isInCombat(u) {
        return !!(u && u.isAttacking && u.attackTarget && u.attackTarget.health > 0);
    }

    // Pick the best scout. A free MILITARY unit is the right scout — it doesn't cost
    // you economy and (cavalry especially) is fast with extra vision. So:
    //   1) an idle cavalry unit (fastest + widest sight),
    //   2) any other idle military unit (not in combat),
    //   3) an idle worker, 4) a non-building worker,
    //   5) last resort: any non-combat unit, then anything at all.
    // Workers are only used when no military is free — and military that is busy
    // fighting is never pulled.
    //
    // If `preferredType` is given (a unit id like "scout_cavalry" OR a category
    // like "cavalry"), an idle unit of that type is chosen when one exists; if
    // none is free we fall back to the automatic logic below.
    pickScout(ai, preferredType = null) {
        if (preferredType) {
            const pt = String(preferredType).trim().toLowerCase();
            const ofType = ai.units.filter(u =>
                (u.type || '').toLowerCase() === pt || (u.unitType || '').toLowerCase() === pt);
            if (ofType.length) {
                // The model explicitly named this unit, so honor it even if it is
                // fighting — but still prefer a non-fighting one of that type first.
                const free = ofType.filter(u => !this.isInCombat(u));
                const pool = free.length ? free : ofType;
                const idle = pool.find(u => u.type === 'worker' ? this.game.isIdleWorker(u) : !u.isMoving);
                return idle || pool[0];
            }
            // requested type isn't present → fall through to the automatic pick
        }

        // Priests are excluded from the auto-pick: a healer wandering the dark
        // alone is a wasted (and soon dead) medic. Explicit unitType still wins.
        const idleMilitary = ai.units.filter(u => u.type !== 'worker' && u.unitType !== 'support' && !this.isInCombat(u));
        const cav = idleMilitary.find(u => u.unitType === 'cavalry');
        if (cav) return cav;
        if (idleMilitary.length) return idleMilitary[0];

        const idleWorker = ai.units.find(u => u.type === 'worker' && this.game.isIdleWorker(u));
        if (idleWorker) return idleWorker;
        const freeWorker = ai.units.find(u => u.type === 'worker' && u.task !== 'building' && !u.isBuilding);
        if (freeWorker) return freeWorker;

        return ai.units.find(u => u.unitType !== 'support' && !this.isInCombat(u)) ||
               ai.units.find(u => u.type !== 'worker' && u.unitType !== 'support') || null;
    }

    // Did `scout` satisfy the model's explicit unit choice? (id or category match)
    scoutMatchesChoice(scout, preferredType) {
        if (!preferredType || !scout) return true; // no choice made → nothing to satisfy
        const pt = String(preferredType).trim().toLowerCase();
        return (scout.type || '').toLowerCase() === pt || (scout.unitType || '').toLowerCase() === pt;
    }

    // Strip a unit of its current job (harvesting/farm/combat) so it can cleanly
    // take a new order. Critically clears isHarvesting + harvest timers — leaving
    // those set made a pulled worker keep "harvesting" instead of scouting/moving.
    releaseUnitForOrders(u) {
        if (!u) return;
        if (u.farmRef && u.farmRef.assignedWorker === u) u.farmRef.assignedWorker = null;
        u.farmRef = null;
        u.harvestTarget = null;
        u.isHarvesting = false;
        u.harvestTimer = 0;
        u.harvestAmount = 0;
        u.carryingResource = false;
        u.isAttacking = false;
        u.attackTarget = null;
        u.attackMove = null;
        u._origTarget = null;  // retaliation ladder ends with the combat job
        u._retalQueue = null;
        u._orderToken = ++this._orderSeq; // reassigned → drops out of any prior attack report
    }

    // dispatchScoutToward lived here: it auto-picked a frontier tile and sent a scout
    // when the model called explore() bare, or named a resource it had never found.
    // Removed — map.exploration gives the model the same grid this used, so choosing
    // where to look is its job. game.leastExploredSection() survives for the
    // rule-based AI, which still scouts on its own.

    // Without a finished Town Center gathered goods can never be delivered —
    // say so instead of letting the model burn turns on pointless harvesting.
    noTownCenterAdvice(ai) {
        if (ai.buildings.some(b => b.type === 'town_center' && !b.underConstruction)) return null;
        const tcDef = (typeof getBuildingDef === 'function') ? getBuildingDef('town_center') : null;
        const costStr = tcDef ? Object.entries(tcDef.cost || {}).filter(([, v]) => v > 0).map(([k, v]) => `${v} ${k}`).join(', ') : 'its cost';
        this.outcome('log.out.noTCWorkers', {});
        return `[ERROR] You have NO finished Town Center, so workers have nowhere to DELIVER what they gather — harvesting is pointless right now. FIRST rebuild one: build_structure with buildingType="town_center" and targetX/targetZ on open ground (costs ${costStr}). Once it stands, reassign your workers to resources.`;
    }

    // executeHarvestResource lived here. Removed: it was assign_workers with the
    // options taken away — one worker, no count, and the targetX/targetZ the prompt
    // advertised were never even passed to it, so a model aiming at a chosen node
    // silently got the one nearest its worker. assign_workers already prefers idle
    // workers (workerPullRank scores idle 0), so nothing it guaranteed was lost.

    // Normalize/validate a gatherable resource type. Returns the canonical lower-
    // case type ('food'|'wood'|'stone'|'gold') or null if it isn't a real resource
    // — so a stray "house"/"barracks" is rejected instead of triggering a pointless
    // "no house discovered, scouting…" reply.
    normalizeResourceType(resourceType) {
        const rt = (resourceType || '').toString().trim().toLowerCase();
        return ['food', 'wood', 'stone', 'gold'].includes(rt) ? rt : null;
    }

    nearestNodeTo(unit, nodes) {
        let best = null, bd = Infinity;
        nodes.forEach(n => { const d = Math.hypot(n.x - unit.x, n.z - unit.z); if (d < bd) { bd = d; best = n; } });
        return best || nodes[0];
    }

    // Reassign workers OFF their current tasks onto a new job (harvest a type).
    // assign_workers {"resourceType":"farm"} — put workers back on UNMANNED farms.
    // A farm regrows food only while a hand stands on it, and pulling every worker
    // onto one resource is a legitimate call that silently darkens every farm you
    // own. Before this there was no way to SEE that (a farm's "activity" always
    // reads "idle") and no way to undo it: farms were only ever staffed by the
    // worker who built one, or by the idle-worker sweep — which never fires while
    // every hand is busy. Same pull triage as the resource path, so a rescue
    // disturbs the economy exactly as predictably as any other reassignment.
    executeAssignFarmers(ai, game, params) {
        const noTC = this.noTownCenterAdvice(ai);
        if (noTC) return noTC;

        const farms = ai.buildings.filter(b => b.type === 'farm' && !b.underConstruction && b.health > 0);
        if (farms.length === 0) {
            const site = ai.buildings.some(b => b.type === 'farm' && b.underConstruction);
            this.outcome(site ? 'log.out.farmUnderConstr' : 'log.out.noFinishedFarms', {});
            return site
                ? `[ERROR] Your farm is still under construction — the worker building it stays on as its farmer once it finishes. Nothing to staff yet.`
                : `[ERROR] You own no finished farms. Build one with build_structure {"buildingType":"farm"} (needs the "farm" research); its builder stays on as the farmer. Farms regrow food indefinitely — berry bushes do not.`;
        }
        const open = farms.filter(f => !game.farmFarmer(f));
        if (open.length === 0) {
            this.outcome('log.out.farmAllManned', { count: farms.length });
            return `OK - All ${farms.length} of your farm(s) are already manned; nothing to do. A farm only regrows food while its worker stands on it.`;
        }

        // Which farm first? An explicit target picks one; otherwise the shortest
        // delivery loop wins — same rule as the resource path.
        const gaveX = params.targetX !== undefined && params.targetX !== null && params.targetX !== '';
        const gaveZ = params.targetZ !== undefined && params.targetZ !== null && params.targetZ !== '';
        if (gaveX || gaveZ) {
            const tx = Number(params.targetX), tz = Number(params.targetZ);
            if (!gaveX || !gaveZ || !Number.isFinite(tx) || !Number.isFinite(tz)) {
                this.outcome('log.out.farmNeedsCoords', {});
                return `[ERROR] assign_workers to "farm" takes BOTH numeric "targetX" and "targetZ" (one of your farms in "buildings"), or neither — then your unmanned farms are staffed nearest-Town-Center first.`;
            }
            open.sort((a, b) => Math.hypot(a.x - tx, a.z - tz) - Math.hypot(b.x - tx, b.z - tz));
        } else {
            const tcs = ai.buildings.filter(b => b.type === 'town_center' && !b.underConstruction);
            const dTC = f => tcs.reduce((m, tc) => Math.min(m, Math.hypot(f.x - tc.x, f.z - tc.z)), Infinity);
            open.sort((a, b) => dTC(a) - dTC(b));
        }
        const want = Math.max(1, Math.min(params.count || open.length, open.length));

        // Never cannibalize a farm to feed a farm, and never take a builder or a
        // fighter — the same exclusions the resource path applies.
        const isFighting = u => u.isAttacking || u.attackTarget || u.attackMove;
        const candidates = ai.units.filter(u =>
            u.type === 'worker' && u.health > 0 &&
            u.task !== 'building' && !u.isBuilding && !isFighting(u) && !u.farmRef);
        if (candidates.length === 0) {
            const building = ai.units.filter(u => u.type === 'worker' && (u.task === 'building' || u.isBuilding)).length;
            const fighting = ai.units.filter(u => u.type === 'worker' && isFighting(u)).length;
            this.outcome('log.out.noWorkersForFarms', { open: open.length });
            return `[ERROR] No workers can be spared for your ${open.length} unmanned farm(s): ${building} are constructing, ${fighting} are fighting (neither is ever pulled), and the rest already man farms.`;
        }
        const rank = u => game.workerPullRank(ai, u);
        candidates.sort((a, b) => rank(a) - rank(b));

        let manned = 0;
        const pulledFrom = {};
        for (const f of open.slice(0, want)) {
            const w = candidates[manned];
            if (!w) break;
            const r = rank(w);
            const label = r === 0 ? 'idle' : r === 5 ? 'scouting' : r === 6 ? 'repairing'
                : (w.harvestTarget ? `from ${w.harvestTarget.type}` : 'spare');
            pulledFrom[label] = (pulledFrom[label] || 0) + 1;
            w._formerTask = null;
            w.task = 'farm_work';
            w.farmRef = f;
            f.assignedWorker = w;
            w.harvestTarget = null;
            w.buildTarget = null;
            w.repairTarget = null;
            w.isHarvesting = false;
            w.carryingResource = false;
            w.harvestAmount = 0;
            w.isMoving = true;
            w.targetX = f.x + (Math.random() - 0.5) * 3;
            w.targetZ = f.z + (Math.random() - 0.5) * 3;
            manned++;
        }
        const src = Object.entries(pulledFrom).map(([k, n]) => `${n} ${k}`).join(', ');
        const left = open.length - manned;
        const short = left > 0 ? ` ${left} farm(s) still stand unmanned — you ran out of spare workers.` : '';
        this.outcome('log.out.farmManned', { count: manned, pulled: this.pulledCounts(pulledFrom), left: Math.max(0, open.length - manned) });
        return `OK - Sent ${manned} worker(s) to man ${manned} farm(s) — pulled: ${src}. Each regrows food only while its worker stays on it.${short}`;
    }

    executeAssignWorkers(ai, game, params) {
        // "farm" is a JOB, not a node type: it staffs your own farms rather than
        // sending workers to a spot on the map. Routed before normalizeResourceType
        // so the gatherable vocabulary stays
        // exactly food|wood|stone|gold.
        const raw = String(params.resourceType || '').toLowerCase().trim();
        if (raw === 'farm' || raw === 'farms') return this.executeAssignFarmers(ai, game, params);

        const resourceType = this.normalizeResourceType(params.resourceType);
        if (!resourceType) {
            this.outcome('log.out.assignNeedsResource', {});
            return `[ERROR] assign_workers requires a "resourceType": food|wood|stone|gold to gather, or "farm" to man your own farms. (To construct a building, use build_structure instead.)`;
        }
        const noTC = this.noTownCenterAdvice(ai);
        if (noTC) return noTC;
        const count = Math.max(1, Math.min(params.count || 3, 20));

        // Discovered nodes? If not, nothing is reassigned — and no scout goes out on
        // the model's behalf: a failed action must not quietly play a turn for it.
        const discovered = this.discoveredNodesOfType(ai, game, resourceType);
        if (discovered.length === 0) {
            const have = this.discoveredResourceSummary(ai, game);
            this.outcome('log.out.notDiscovered', { res: resourceType });
            return `[ERROR] No ${resourceType} has been discovered yet, so no workers were reassigned. You have currently discovered: ${have}. Only resources you have scouted exist for you — "discoveredNodesOnMap" counts them per type and "nearestNodes" gives the coordinates of the ones near your bases. Send a scout yourself with explore and a tile picked from "map.exploration"; once ${resourceType} shows a count above 0, call assign_workers again.`;
        }

        // Which node? Explicit targetX/targetZ picks the discovered node nearest
        // that point; otherwise the node nearest ANY finished Town Center wins —
        // the shortest delivery loop is the fastest economy.
        const gaveX = params.targetX !== undefined && params.targetX !== null && params.targetX !== '';
        const gaveZ = params.targetZ !== undefined && params.targetZ !== null && params.targetZ !== '';
        let node;
        let nodeNote;
        if (gaveX || gaveZ) {
            const tx = Number(params.targetX), tz = Number(params.targetZ);
            if (!gaveX || !gaveZ || !Number.isFinite(tx) || !Number.isFinite(tz)) {
                this.outcome('log.out.assignNeedsCoords', { res: resourceType });
                return `[ERROR] assign_workers takes BOTH numeric "targetX" and "targetZ" (a ${resourceType} node from "nearestNodes", or any other you have scouted), or neither — then the node nearest your Town Center is used.`;
            }
            node = this.nearestNodeTo({ x: tx, z: tz }, discovered);
            nodeNote = 'nearest your target';
        } else {
            const tcs = ai.buildings.filter(b => b.type === 'town_center' && !b.underConstruction);
            let bd = Infinity;
            node = discovered[0];
            for (const n of discovered) {
                for (const tc of tcs) {
                    const d = Math.hypot(n.x - tc.x, n.z - tc.z);
                    if (d < bd) { bd = d; node = n; }
                }
            }
            nodeNote = 'nearest your Town Center';
        }

        // Pull order, cheapest disruption first: idle hands, then gatherers from
        // the fattest stockpile down to the leanest (surplus labor is the most
        // expendable), then scouts, then repairers, then farmers — steady food is
        // the last thing to cannibalize. Builders and fighting workers (also by
        // auto-retaliation) are never pulled, nor are workers already on the
        // requested resource: assign_workers ADDS to it.
        const isFighting = u => u.isAttacking || u.attackTarget || u.attackMove;
        let candidates = ai.units.filter(u =>
            u.type === 'worker' && u.health > 0 &&
            u.task !== 'building' && !u.isBuilding && !isFighting(u) &&
            !((u.task === 'harvesting' || u.task === 'carrying') && u.harvestTarget && u.harvestTarget.type === resourceType));
        if (candidates.length === 0) {
            const already = ai.units.filter(u => u.type === 'worker' && (u.task === 'harvesting' || u.task === 'carrying') && u.harvestTarget && u.harvestTarget.type === resourceType).length;
            const building = ai.units.filter(u => u.type === 'worker' && (u.task === 'building' || u.isBuilding)).length;
            const fighting = ai.units.filter(u => u.type === 'worker' && isFighting(u)).length;
            this.outcome('log.out.noWorkersReassign', { already, res: resourceType, building, fighting });
            return `[ERROR] No workers could be reassigned: ${already} already harvest ${resourceType}, ${building} are constructing, ${fighting} are fighting (builders and fighting workers are never pulled).`;
        }

        // Optional SOURCE. Omitted, the triage below picks as it always has (idle
        // first, then the fattest stockpile down). Given, the MODEL chooses where the
        // workers come from — which is what makes workers.onX worth reading at all:
        // deciding to thin out food is worth nothing if the pick then takes them
        // off gold.
        const whereFrom = u => {
            if (u.task === 'farm_work' || u.farmRef) return 'farm';
            const rt = (u.harvestTarget && u.harvestTarget.type) || u.carryingResourceType;
            if (rt) return rt;
            return game.isIdleWorker(u) ? 'idle' : null;
        };
        const FROMS = ['food', 'wood', 'stone', 'gold', 'farm', 'idle'];
        const rawFrom = (params.from === undefined || params.from === null || params.from === '')
            ? null : String(params.from).toLowerCase().trim();
        const from = rawFrom === 'farms' ? 'farm' : rawFrom;
        if (from !== null && !FROMS.includes(from)) {
            this.outcome('log.out.assignBadFrom', {});
            return `[ERROR] assign_workers "from" is where workers are TAKEN FROM and must be one of ${FROMS.join('|')} — omit it to use ingame worker selection, which takes idle workers first, then your largest stockpile. Got ${JSON.stringify(params.from)}.`;
        }
        if (from !== null && from === resourceType) {
            this.outcome('log.out.assignFromSame', { res: resourceType });
            return `[ERROR] "from" and "resourceType" are both "${resourceType}", which would move workers onto the job they already have. Choose a different source or omit "from".`;
        }
        if (from !== null) {
            const pool = candidates.filter(u => whereFrom(u) === from);
            if (!pool.length) {
                const onIt = ai.units.filter(u => u.type === 'worker' && whereFrom(u) === from).length;
                // Name the field that ACTUALLY exists. This was built as
                // "workers.on" + capitalise(from), which is right for the four
                // resources and wrong for the other two: it produced workers.onIdle
                // and workers.onFarm, neither of which is in the state. A model sent
                // to check a field that does not exist has nowhere to go.
                const FIELD = { food: 'onFood', wood: 'onWood', stone: 'onStone',
                                gold: 'onGold', farm: 'onFarms', idle: 'idle' };
                // And say which of the two situations it is. "0 are on it, and none of
                // those can be pulled" read as two separate reasons and left the real
                // one — that there is simply nobody there — impossible to pick out.
                const why = onIt === 0
                    ? `you have no workers on "${from}" (workers.${FIELD[from]} is 0)`
                    : `all ${onIt} of them are constructing or fighting, and those are never pulled`;
                this.outcome('log.out.assignFromEmpty', { from, res: resourceType });
                return `[ERROR] No workers could be taken from "${from}": ${why}. Choose a source that has workers assigned to it, or omit "from" to use ingame worker selection.`;
            }
            candidates = pool;   // STRICT: an explicit source is not quietly widened
        }

        // Spilling is a POLICY the model states and the harness applies here, where
        // the truth is known. It cannot be planned from the state: a gather round trip
        // runs 12-32s and a reply takes 1.6-36s, so any count of who is carrying is a
        // whole cycle stale by the time the order arrives, describing different
        // workers. What the model CAN say is what it wants done when the moment comes.
        const carrying = u => !!(u.carryingResource || u.task === 'carrying');
        let allowSpill = true;
        if (params.allowSpill !== undefined && params.allowSpill !== null && params.allowSpill !== '') {
            const v = params.allowSpill;
            if (v === true || v === 'true') allowSpill = true;
            else if (v === false || v === 'false') allowSpill = false;
            else {
                this.outcome('log.out.assignBadSpill', {});
                return `[ERROR] assign_workers "allowSpill" must be true or false. true (the default) moves the workers you asked for even if some are carrying a load, which is lost. false moves only workers not carrying anything right now, and moves fewer if that is all there are. Got ${JSON.stringify(params.allowSpill)}.`;
            }
        }
        if (!allowSpill) {
            const free = candidates.filter(u => !carrying(u));
            if (!free.length) {
                const held = candidates.length;
                this.outcome('log.out.assignAllCarrying', { n: held, res: resourceType });
                return `[ERROR] Nobody could be moved without losing a load: all ${held} available worker(s) are carrying one right now. "allowSpill": true takes them anyway and loses what they hold.`;
            }
            candidates = free;
        }

        // Tier policy lives in game.workerPullRank — the same triage that picks
        // builders, so every kind of pull disturbs the economy the same way. Within a
        // tier, take the ones NOT carrying first: reassigning destroys a full load, and
        // an empty-handed worker at the same node costs nothing to move. The tiers
        // used to rank a loaded worker and an empty one identically, so a request for
        // three could destroy three loads while three empty ones stood beside them.
        // This runs on LIVE state, which is why it works where a state count could not.
        const rank = u => game.workerPullRank(ai, u);
        const loaded = u => carrying(u) ? 1 : 0;
        candidates.sort((a, b) => (rank(a) - rank(b)) || (loaded(a) - loaded(b)));

        let moved = 0;
        const pulledFrom = {};
        const spilled = {};      // resource -> amount destroyed by pulling a loaded worker
        for (const w of candidates) {
            if (moved >= count) break;
            const r = rank(w);
            const label = r === 0 ? 'idle' : r === 5 ? 'scouting' : r === 6 ? 'repairing' : r === 7 ? 'farming' : `from ${w.harvestTarget.type}`;
            pulledFrom[label] = (pulledFrom[label] || 0) + 1;
            // A carried load is destroyed by the reassignment. Sorted last, so this
            // only happens once the free workers run out — but it is a real cost and
            // the model can only learn it from being told.
            if ((w.carryingResource || w.task === 'carrying') && w.harvestAmount > 0) {
                const rt = w.carryingResourceType || (w.harvestTarget && w.harvestTarget.type) || 'resources';
                spilled[rt] = (spilled[rt] || 0) + w.harvestAmount;
            }
            if (w.farmRef && w.farmRef.assignedWorker === w) w.farmRef.assignedWorker = null;
            w.farmRef = null;
            w._formerTask = null;
            w.task = 'harvesting';
            w.harvestTarget = node;
            w.buildTarget = null;
            w.repairTarget = null;
            w.isMoving = true;
            w.targetX = node.x + (Math.random() - 0.5) * 2;
            w.targetZ = node.z + (Math.random() - 0.5) * 2;
            w.isHarvesting = false;
            w.carryingResource = false;
            w.harvestAmount = 0;
            moved++;
        }
        const src = Object.entries(pulledFrom).map(([k, n]) => `${n} ${k}`).join(', ');
        const short = moved < count
            ? (!allowSpill
                ? ` Fewer than requested: only ${moved} were empty-handed at that moment, and "allowSpill": false left the rest gathering.`
                : from !== null
                    ? ` Fewer than requested: only ${moved} could be taken from "${from}".`
                    : ` Fewer than requested: the others are constructing or fighting (never pulled), already on ${resourceType}, or you don't have that many workers.`)
            : '';
        // What the reassignment actually COST. Workers carrying a load drop it, and
        // the free ones are taken first — so this only appears when more were asked
        // for than were empty-handed, with allowSpill left at its default. The amount
        // is the fact; noticing that allowSpill:false would have avoided it is the
        // play, and that is the model's to make.
        // "Dropped" was wrong and teachable-wrong: it implies the load is lying on the
        // ground and could be fetched. It is destroyed (harvestAmount = 0), and a model
        // reading "dropped" could reasonably send someone back for it.
        const spillTxt = Object.keys(spilled).length
            ? ` Returning workers spilled ${Object.entries(spilled).map(([r, n]) => `${n} ${r}`).join(', ')} they were carrying.`
            : '';
        // Gathering is a ROUND TRIP: walk out, gather, carry it back to a Town Center.
        // The state gives node coordinates and nothing about what distance costs, and
        // models were picking far nodes as if delivery were free. Report the haul on
        // the turn the choice is made — cheaper than an eta on every node every turn,
        // and it lands exactly where the decision happens.
        const tcs = ai.buildings.filter(b => b.type === 'town_center' && !b.underConstruction);
        const nearTC = tcs.reduce((best, b) => {
            const d = Math.hypot(b.x - node.x, b.z - node.z);
            return (!best || d < best.d) ? { b, d } : best;
        }, null);
        const haul = nearTC ? ` Each load is a ~${Math.max(1, Math.round(nearTC.d / (3 * 1.0)))}s walk back to your nearest Town Center.` : '';
        this.outcome('log.out.reassigned', { count: moved, res: resourceType, x: Math.round(node.x), z: Math.round(node.z), near: (gaveX || gaveZ) ? 'target' : 'tc', pulled: this.pulledCounts(pulledFrom) });
        return `OK - Reassigned ${moved} worker(s) to harvest ${resourceType} at (${Math.round(node.x)}, ${Math.round(node.z)}) — the node ${nodeNote} — pulled: ${src}.${spillTxt}${haul}${short}`;
    }

    // Put workers on fixing a damaged own building (free; uses the build task's
    // machinery — game.assignWorkersToBuilding routes to task 'repairing').
    executeRepairBuilding(ai, game, params) {
        const damaged = ai.buildings.filter(b => !b.underConstruction && b.health > 0 && b.health < b.maxHealth);
        if (damaged.length === 0) {
            this.outcome('log.out.nothingToRepair', {});
            return `[ERROR] None of your buildings are damaged — nothing to repair. (Construction SITES are finished automatically by the worker build_structure assigned.)`;
        }
        let target;
        const gaveX = params.targetX !== undefined && params.targetX !== null && params.targetX !== '';
        const gaveZ = params.targetZ !== undefined && params.targetZ !== null && params.targetZ !== '';
        if (gaveX || gaveZ) {
            const tx = Number(params.targetX), tz = Number(params.targetZ);
            if (!gaveX || !gaveZ || !Number.isFinite(tx) || !Number.isFinite(tz)) {
                this.outcome('log.out.repairNeedsCoords', {});
                return `[ERROR] repair_building needs BOTH numeric "targetX" and "targetZ" (of YOUR damaged building), or omit both to repair your most damaged one.`;
            }
            let best = null, bd = Infinity;
            damaged.forEach(b => {
                const d = Math.hypot(b.x - tx, b.z - tz);
                if (d < bd) { bd = d; best = b; }
            });
            if (!best || bd > 12) {
                const list = damaged.map(b => `${b.type} at (${Math.round(b.x)}, ${Math.round(b.z)}) ${Math.round(b.health / b.maxHealth * 100)}% HP`).join('; ');
                this.outcome('log.out.noDamagedNear', { x: Math.round(tx), z: Math.round(tz) });
                return `[ERROR] No damaged building of yours near (${Math.round(tx)}, ${Math.round(tz)}). Damaged now: ${list}.`;
            }
            target = best;
        } else {
            target = damaged.reduce((a, b) => (a.health / a.maxHealth <= b.health / b.maxHealth ? a : b));
        }
        const count = Math.max(1, Math.min(params.count || 1, 5));
        const workers = ai.units
            .filter(u => u.type === 'worker' && u.health > 0 && u.task !== 'building' && !u.isBuilding)
            .sort((a, b) => Math.hypot(a.x - target.x, a.z - target.z) - Math.hypot(b.x - target.x, b.z - target.z))
            .slice(0, count);
        if (workers.length === 0) {
            this.outcome('log.out.noWorkersRepair', {});
            return `[ERROR] No workers available to repair (all are constructing).`;
        }
        workers.forEach(w => {
            if (w.farmRef && w.farmRef.assignedWorker === w) w.farmRef.assignedWorker = null;
            w.farmRef = null;
        });
        const mode = game.assignWorkersToBuilding(workers, target);
        if (!mode) { this.outcome('log.out.repairFailed', {}); return `[ERROR] Could not start the repair (the building may have just been destroyed).`; }
        const pct = Math.round(target.health / target.maxHealth * 100);
        const barrier = game.repairBarrierMsLeft ? game.repairBarrierMsLeft(target) : 0;
        const barrierNote = barrier > 0
            ? ` NOTE: it is still under fire — repairs are locked until 10s after the LAST hit; the workers wait on site and start automatically.`
            : '';
        this.outcome('log.out.repairStarted', { count: workers.length, type: target.type, x: Math.round(target.x), z: Math.round(target.z), pct });
        return `OK - ${workers.length} worker(s) repairing your ${target.type} at (${Math.round(target.x)}, ${Math.round(target.z)}), currently ${pct}% HP.${barrierNote} They idle when it is fully repaired — reassign them to resources afterwards.`;
    }

    executeExplore(ai, game, params) {
        const T = game.EXPLORE_TILES || 7;
        const lastCol = String.fromCharCode(64 + T);
        // Optional: name a unit to scout with (id like "scout_cavalry" or a category
        // like "cavalry"/"worker"); omit it to auto-pick the best scout.
        const preferredType = params.unitType ? String(params.unitType).trim() : null;
        const raw = params.tile;
        const gave = raw !== undefined && raw !== null && String(raw).trim() !== '';

        // Coordinates used to be the input here. Catch them by name: a model that
        // sends targetX/targetZ has the right intent and the wrong shape, and saying
        // so beats a generic "tile required".
        if (!gave && (params.targetX !== undefined || params.targetZ !== undefined)) {
            this.outcome('log.out.exploreNeedsTile', {});
            return `[ERROR] explore takes a map "tile", not coordinates. Pass one label from "map.exploration" — column A-${lastCol} then row 1-${T}, e.g. "tile":"C5". Your tiles: ${this.baseTilesString(ai, game)}.`;
        }
        if (!gave) {
            this.outcome('log.out.exploreNeedsTile', {});
            return `[ERROR] explore needs a "tile": one label from "map.exploration" — column A-${lastCol} then row 1-${T}, e.g. "tile":"C5". "map.exploration" gives the percent of each tile you have already seen. Your tiles: ${this.baseTilesString(ai, game)}.`;
        }

        const t = this.parseTile(raw, T);
        if (!t) {
            this.outcome('log.out.exploreBadTile', { tile: String(raw) });
            return `[ERROR] "${raw}" is not a map tile. Use a COLUMN LETTER then a ROW NUMBER: A-${lastCol} and 1-${T}, e.g. "C5" (not "5C", and not coordinates). The tiles and how much of each you have seen are in "map.exploration".`;
        }

        const scout = this.pickScout(ai, preferredType);
        if (!scout) { this.outcome('log.out.noUnitExplore', {}); return `[ERROR] No unit available to explore.`; }
        const wasBusy = scout.type === 'worker' && !this.game.isIdleWorker(scout);
        const missedChoice = preferredType && !this.scoutMatchesChoice(scout, preferredType);

        // Aim somewhere inside the tile, inset by the scout's own sight radius so it
        // reveals ground rather than hugging the border.
        const vision = game.unitVision ? game.unitVision(scout) : 15;
        const { x: tx, z: tz } = this.pointInTile(game, t.row, t.col, vision);
        const eta = this.travelEtaSec(scout, tx, tz);
        this.releaseUnitForOrders(scout); // cleanly drop any harvest/farm/combat job
        scout.task = scout.type === 'worker' ? 'scouting' : null;
        scout.isMoving = true;
        scout.targetX = tx;
        scout.targetZ = tz;

        // Report what the tile is at NOW. A tile is ~114 units across and a scout
        // sees ~15, so one pass moves it a few percent: without this the model sends
        // a scout, sees the number barely move, and concludes explore did nothing.
        const sum = game.explorationSummary ? game.explorationSummary(ai) : null;
        const pct = (sum && sum[t.row] && sum[t.row][t.col]) | 0;
        const label = this.tileLabel(t.row, t.col);
        const pulled = wasBusy ? ' (no worker was idle, so one was pulled off gathering — give it a job again once it arrives)' : '';
        const choiceNote = missedChoice ? ` (no idle "${preferredType}" was free, so your ${scout.type} was used instead)` : '';
        this.outcome('log.out.exploreSent', { tile: label, pct, eta });
        return `OK - Sent your ${scout.type} to scout tile ${label} (~${eta}s to arrive). ${label} is ${pct}% explored so far; one pass uncovers only part of a tile, so expect to send scouts there again.${pulled}${choiceNote}`;
    }

    executeDeleteUnit(ai, game, params) {
        const raw = (params.unitType || 'worker').toString().trim();
        const type = raw.toLowerCase();
        const count = Math.max(1, Math.min(params.count || 1, 20));

        // Match on either the unit id ("militia") OR its category ("infantry"),
        // case-insensitively — the model often passes the category or a label it
        // saw rather than the exact id.
        let pool = ai.units.filter(u =>
            (u.type || '').toLowerCase() === type ||
            (u.unitType || '').toLowerCase() === type);

        if (pool.length === 0) {
            // Honest, actionable feedback: tell the model exactly what it owns.
            const counts = {};
            ai.units.forEach(u => { counts[u.type] = (counts[u.type] || 0) + 1; });
            const have = Object.entries(counts).map(([t, n]) => `${t}×${n}`).join(', ') || '(no units)';
            this.outcome('log.out.noUnitDelete', { raw, have });
            return `[ERROR] You have no "${raw}" unit to delete. Your units: ${have}. Pass one of those "type" values (the "type" field shown for each unit in "friendlyUnits").`;
        }

        // Cull the least valuable first: idle workers before working ones, and
        // otherwise the weakest unit (lowest attack + HP) so you keep your best.
        pool.sort((a, b) => {
            if (a.type === 'worker' && b.type === 'worker') {
                return (this.game.isIdleWorker(a) ? 0 : 1) - (this.game.isIdleWorker(b) ? 0 : 1);
            }
            const sa = (a.attack || 0) + (a.maxHealth || 0);
            const sb = (b.attack || 0) + (b.maxHealth || 0);
            return sa - sb;
        });

        let removed = 0;
        const removedTypes = {};
        for (let i = 0; i < pool.length && removed < count; i++) {
            removedTypes[pool[i].type] = (removedTypes[pool[i].type] || 0) + 1;
            game.deleteOwnUnit(pool[i]);
            removed++;
        }
        const what = Object.entries(removedTypes).map(([t, n]) => `${n} ${t}`).join(', ');
        this.outcome('log.out.deleted', { what });
        return `OK - Deleted ${what}, freeing population.`;
    }

    executeDestroyBuilding(ai, game, buildingType, targetX, targetZ) {
        let pool = ai.buildings.filter(b => b.type === buildingType);
        if (pool.length === 0) {
            this.outcome('log.out.noBuildingDestroy', { buildingType });
            // Say what you DO own, the way delete_unit does — destroy_building acts on
            // your OWN structures, so the answer is always in friendlyBuildings.
            const counts = {};
            ai.buildings.forEach(b => { counts[b.type] = (counts[b.type] || 0) + 1; });
            const have = Object.entries(counts).map(([t, n]) => `${t}×${n}`).join(', ') || '(none)';
            return `[ERROR] You have no "${buildingType}" to destroy. Your buildings: ${have}. Pass one of those "type" values (the "type" field shown for each entry in "friendlyBuildings"). To attack an ENEMY building use attack_target instead.`;
        }
        let victim = pool[0];
        if (targetX !== undefined && targetZ !== undefined) {
            let bd = Infinity;
            pool.forEach(b => { const d = Math.hypot(b.x - targetX, b.z - targetZ); if (d < bd) { bd = d; victim = b; } });
        }
        const wasTC = victim.type === 'town_center';
        const remainingTC = ai.buildings.filter(b => b.type === 'town_center').length;
        if (wasTC && remainingTC <= 1) {
            this.outcome('log.out.refuseDestroyLastTC', {});
            return `[ERROR] Refusing to destroy your last Town Center — that would eliminate you.`;
        }
        game.destroyOwnBuilding(victim);
        this.outcome('log.out.destroyed', { buildingType, x: Math.round(victim.x), z: Math.round(victim.z) });
        return `OK - Destroyed your ${buildingType} at (${Math.round(victim.x)}, ${Math.round(victim.z)}).`;
    }

    isOwnedByAI(entity, ai) {
        return entity.owner === ai.id ||
               ai.units.includes(entity) ||
               ai.buildings.includes(entity);
    }

    // Has this AI actually discovered any enemy worth attacking? Mirrors the
    // fog-of-war filtering used to build the game state: an enemy counts only if
    // it is currently visible — EXCEPT enemy wonders, which are always revealed
    // to everyone, so a known wonder counts even with zero scouting.
    hasVisibleEnemies(ai, game) {
        // Remembered enemy buildings (discovered earlier, still alive) are valid
        // targets even when not currently in sight.
        if (ai._knownEnemyBuildings) {
            for (const b of ai._knownEnemyBuildings) {
                if (b && b.health > 0 && !this.isOwnedByAI(b, ai)) return true;
            }
        }
        for (const b of game.getAllBuildings()) {
            if (this.isOwnedByAI(b, ai)) continue;
            if (b.health <= 0) continue;
            if (b.isWonder || this.isPositionVisibleToAI(ai, b.x, b.z, game)) return true;
        }
        for (const u of game.getAllUnits()) {
            if (this.isOwnedByAI(u, ai)) continue;
            if (u.health <= 0) continue;
            if (this.isPositionVisibleToAI(ai, u.x, u.z, game)) return true;
        }
        return false;
    }

    // Shared guidance appended to attack errors so the model's next step is always
    // actionable: how to LIST the valid, already-discovered targets — or scout if
    // none are known yet. "enemyUnits"/"enemyBuildings" only ever contain enemies
    // you have already discovered (fog hides the rest).
    attackTargetHint(ai, game) {
        return this.hasVisibleEnemies(ai, game)
            ? 'To list valid targets, read "enemyUnits" and "enemyBuildings" in the game state — those are the enemies you have DISCOVERED (each with an "id", its x,z and owner). Attack one of those coordinates, or pass its exact "id" as params.targetId.'
            : 'You have not discovered any enemies yet, so "enemyUnits" and "enemyBuildings" are empty. Scout first (explore); enemies appear in those lists once one of your units sees them, then you can attack them.';
    }

    // ----------------------------------------------------------------
    // 13. Independent per-model update loop
    //     Every controller runs its OWN pipeline: it fires its next request
    //     as soon as its previous one returns (plus a small breather), fully
    //     concurrent with the others. No global turn order and no concurrency
    //     cap — so a faster model genuinely takes more turns. That speed is a
    //     real, intended advantage when comparing models.
    // ----------------------------------------------------------------
    // ---- Turn-based rounds -----------------------------------------------------
    // Off, seats run independent pipelines and a faster model genuinely takes more
    // turns — a real advantage, and an intended one when the question is "which model
    // plays this better in real time".
    //
    // On, the match becomes a board game. Every live seat is handed the SAME frozen
    // state, they think in parallel, all answers are applied together, and only then
    // does the sim advance one fixed quantum. Decisions-per-game-second becomes
    // identical for every seat, so a 36s model and a 3s model get the same number of
    // moves and latency stops being the variable. A round costs the SLOWEST seat's
    // reply, not the sum of all of them.
    static get ROUND_QUANTUM_MS() { return 5000; }   // game-ms released per round
    static get ROUND_TIMEOUT_MS() { return 90000; }  // a silent seat forfeits its turn

    // How much simulation the game may run right now. Zero while a round is still
    // being decided, so the board is frozen for everyone who is thinking about it.
    consumeRoundBudget(ms) {
        if (this._roundBudget <= 0) return 0;
        const take = Math.min(ms, this._roundBudget);
        this._roundBudget -= take;
        return take;
    }

    updateTurnBased(now) {
        const live = this.aiControllers.filter(c => {
            if (this.isControllerDefeated(c)) { if (!c.defeated) this.markDefeated(c); return false; }
            return !c.paused;
        });
        if (!live.length) return;

        if (this._roundPhase === 'advance') {
            if (this._roundBudget > 0) return;      // sim still working through the quantum
            this._roundPhase = 'ask';
        }
        if (this._roundPhase === 'wait') {
            if (live.some(c => c.pending)) {
                if (now - this._roundStartedAt <= OpenAIAIManager.ROUND_TIMEOUT_MS) return;
                // One unreachable endpoint must not freeze the other three: release
                // them, let the round resolve, and the slow seat simply misses it.
                live.forEach(c => { c.pending = false; });
            }
            this._roundBudget = OpenAIAIManager.ROUND_QUANTUM_MS;
            this._roundPhase = 'advance';
            return;
        }
        this._roundStartedAt = now;
        this._roundPhase = 'wait';
        live.forEach(c => this.startTurn(c, now));
    }

    async update(deltaTime) {
        if (this.aiControllers.length === 0) return;
        const now = Date.now();

        // Continuously record what each model has discovered. Discovery used to be
        // sampled only at a model's own turn, but the fog reveals as units MOVE — so
        // a scout could sweep past a node (revealing it on the map) and move on
        // between turns, leaving the model thinking it never found it. Scan a few
        // times a second so "seen on the map" always equals "known to the model".
        if (this._stopped) return; // match ended/restarted — issue no more turns

        this.updateResourceDiscovery(now);
        this.updateEnemyBuildingDiscovery();
        this.updateAttackReports(now);

        if (this.turnBased) { this.updateTurnBased(now); return; }

        for (const controller of this.aiControllers) {
            if (this.isControllerDefeated(controller)) {                       // lost its last Town Center
                if (!controller.defeated) this.markDefeated(controller);       // stop it (once)
                continue;
            }
            if (controller.paused) continue;                                  // spectator paused it
            if (controller.pending) continue;                                 // own pipeline busy
            if (now - controller.lastTurnTime < this.turnInterval) continue;  // small breather
            this.startTurn(controller, now);
        }
    }

    // A defeated model must stop sending requests. "Defeated" uses the SAME rule as
    // arena win detection (game.isPlayerEliminated): no army, no military building it
    // can afford to produce from, and no Town Center nor the means to rebuild one — so
    // controller-stop and the last-player-standing check never disagree.
    isControllerDefeated(controller) {
        const ai = controller && controller.aiPlayer;
        if (!ai) return true;
        if (this.game && typeof this.game.isPlayerEliminated === 'function') {
            return this.game.isPlayerEliminated(ai);
        }
        return ai.units.length === 0 && ai.buildings.length === 0; // fallback
    }

    // Player game only: an LLM opponent whose endpoint is unreachable is handed to
    // the rule-based AI so the human still has a real opponent. Removes the LLM
    // controller and lets aiManager drive that player from now on.
    demoteToRuleBased(controller) {
        if (controller._demoted) return;
        controller._demoted = true;
        const ai = controller.aiPlayer;
        this.aiControllers = this.aiControllers.filter(c => c !== controller);
        try { if (controller._abort) controller._abort.abort(); } catch (e) { /* settled */ }
        controller.pending = false;
        if (ai) {
            this.game.aiManager.openAIControlled.delete(ai.id); // rule-based brain takes over
            const civ = getCivilization(ai.civilization);
            this.decisionLog.unshift({
                timestamp: Date.now(), playerId: ai.id,
                civName: civ?.name || ai.civilization,
                color: '#' + ((civ?.color ?? 0xffffff)).toString(16).padStart(6, '0'),
                action: 'fallback_rule_based', reason: '', params: {}, failed: true, error: null, isControl: true
            });
            if (this.decisionLog.length > this.maxLogEntries) this.decisionLog = this.decisionLog.slice(0, this.maxLogEntries);
        }
        if (this.game.ui && this.game.ui.updateOpponentsPanel) this.game.ui.updateOpponentsPanel();
        console.log(`[OpenAIAI] ${ai && ai.id}: endpoint unreachable — handed to the rule-based AI.`);
    }

    // Permanently retire a defeated controller: abort its in-flight request, mark it
    // so any late resolution is dropped, and note it once in the spectator log.
    markDefeated(controller) {
        controller.defeated = true;
        try { if (controller._abort) controller._abort.abort(); } catch (e) { /* already settled */ }
        controller.pending = false;
        controller.pendingAttackReports = [];
        controller.pendingArrivalMessages = [];
        const ai = controller.aiPlayer;
        if (ai) {
            const civ = getCivilization(ai.civilization);
            this.decisionLog.unshift({
                timestamp: Date.now(), playerId: ai.id,
                civName: civ?.name || ai.civilization,
                color: '#' + ((civ?.color ?? 0xffffff)).toString(16).padStart(6, '0'),
                action: 'defeated', reason: '', params: {}, failed: true, error: null, isControl: true
            });
            if (this.decisionLog.length > this.maxLogEntries) this.decisionLog = this.decisionLog.slice(0, this.maxLogEntries);
        }
        console.log(`[OpenAIAI] ${controller.id} defeated — controller stopped.`);
    }

    // Halt this manager for good: abort in-flight requests and make any late
    // resolution a no-op. Called when a match ends or a new one starts, so the
    // previous match's slow requests can't spend more quota or spawn stray units
    // into the next match's shared scene.
    stop() {
        this._stopped = true;
        for (const c of this.aiControllers) {
            try { if (c._abort) c._abort.abort(); } catch (e) { /* already settled */ }
            c.pending = false;
            c.pendingAttackReports = [];     // drop unresolved arrival reports
            c.pendingArrivalMessages = [];   // and any undelivered verdicts
        }
        this.pendingRequests.clear();
    }

    // Persistently remember every resource node any of a model's units/buildings
    // has had within vision range (matches the fog-of-war the spectator sees).
    // Runs EVERY frame, in lockstep with the fog reveal — a 500ms sample used to
    // miss a fast unit that only grazed a node's vision radius for a moment, so
    // the node showed on the map (fog reveals per-frame) but never entered the
    // model's known set. The `.has(idx)` skip keeps this cheap: each node is
    // distance-checked only until it is first discovered, then skipped forever.
    updateResourceDiscovery(now) {
        const resources = (this.game.terrain && this.game.terrain.resources) || [];
        if (!resources.length) return;
        for (const controller of this.aiControllers) {
            const ai = controller.aiPlayer;
            if (!ai) continue;
            if (!ai._knownResIdx) ai._knownResIdx = new Set();
            for (let idx = 0; idx < resources.length; idx++) {
                if (ai._knownResIdx.has(idx)) continue;        // already known — skip
                const r = resources[idx];
                if (this.isPositionVisibleToAI(ai, r.x, r.z, this.game)) ai._knownResIdx.add(idx);
            }
        }
    }

    // Persistently remember every ENEMY BUILDING a model has seen (buildings are
    // static, so a discovered base should stay known even after your units look
    // away — just like resources). Enemy UNITS are deliberately NOT remembered:
    // they move, so a stale position would mislead. Runs every frame; drops a
    // remembered building once it is destroyed/removed.
    updateEnemyBuildingDiscovery() {
        const all = this.game.getAllBuildings();
        for (const controller of this.aiControllers) {
            const ai = controller.aiPlayer;
            if (!ai) continue;
            if (!ai._knownEnemyBuildings) ai._knownEnemyBuildings = new Set();
            for (const b of all) {
                if (ai.buildings.includes(b)) continue;            // own building
                if (b.health <= 0) { ai._knownEnemyBuildings.delete(b); continue; } // gone
                if (ai._knownEnemyBuildings.has(b)) continue;      // already known
                if (b.isWonder || this.isPositionVisibleToAI(ai, b.x, b.z, this.game)) {
                    ai._knownEnemyBuildings.add(b);
                }
            }
        }
    }

    // Spectator pause/resume: a paused model issues no more requests (useful when a
    // model has exhausted its API quota). Returns the new paused state.
    setPaused(aiId, paused) {
        const controller = this.aiControllers.find(c => c.id === aiId);
        if (!controller) return null;
        controller.paused = !!paused;
        const ai = controller.aiPlayer;
        const civ = ai ? getCivilization(ai.civilization) : null;
        this.decisionLog.unshift({
            timestamp: Date.now(),
            playerId: aiId,
            civName: civ?.name || (ai ? ai.civilization : aiId),
            color: '#' + ((civ?.color ?? 0xffffff)).toString(16).padStart(6, '0'),
            action: paused ? 'paused' : 'resumed',
            reason: '',
            params: {},
            failed: false,
            error: null,
            isControl: true
        });
        if (this.decisionLog.length > this.maxLogEntries) this.decisionLog = this.decisionLog.slice(0, this.maxLogEntries);
        console.log(`[OpenAIAI] ${aiId} ${paused ? 'paused' : 'resumed'} by spectator`);
        return controller.paused;
    }

    isPaused(aiId) {
        const controller = this.aiControllers.find(c => c.id === aiId);
        return !!(controller && controller.paused);
    }

    // Queue spectator advice for a model; injected into its next prompt.
    addAdvice(aiId, text) {
        const controller = this.aiControllers.find(c => c.id === aiId);
        if (!controller) return false;
        const t = String(text || '').trim();
        if (!t) return false;
        if (!controller.pendingAdvice) controller.pendingAdvice = [];
        const advice = t.slice(0, 400);
        controller.pendingAdvice.push(advice);
        console.log(`[OpenAIAI] Advice queued for ${aiId}: ${advice}`);

        // Surface it in the decision log so the spectator can SEE that their advice
        // was queued (it is attached to this model's next prompt).
        const ai = controller.aiPlayer;
        const civ = ai ? getCivilization(ai.civilization) : null;
        this.decisionLog.unshift({
            timestamp: Date.now(),
            playerId: aiId,
            civName: civ?.name || (ai ? ai.civilization : aiId),
            color: '#' + ((civ?.color ?? 0xffffff)).toString(16).padStart(6, '0'),
            action: 'advice',
            reason: advice,
            params: {},
            failed: false,
            error: null,
            isAdvice: true
        });
        if (this.decisionLog.length > this.maxLogEntries) {
            this.decisionLog = this.decisionLog.slice(0, this.maxLogEntries);
        }
        return true;
    }

    // Fire a single turn for one controller on its own independent pipeline.
    startTurn(controller, now = Date.now()) {
        // Real turn-to-turn cadence, MEASURED before lastTurnTime is overwritten.
        // This is the model's own thinking time plus the breather plus any scheduling
        // delay it met — the only number that converts the state's seconds into
        // decisions, and it differs ~12x between a 1.6s seat and a 36s one. Kept as a
        // short rolling window rather than a lifetime mean: a cadence that degrades
        // (a slowing endpoint, a growing context) should be reflected, not averaged
        // away against turns from ten minutes ago.
        if (controller.lastTurnTime) {
            const gaps = controller.turnGaps || (controller.turnGaps = []);
            gaps.push(now - controller.lastTurnTime);
            if (gaps.length > 10) gaps.shift();
        }
        controller.lastTurnTime = now;
        controller.turnCount++;
        controller.pending = true;

        console.log(`[OpenAIAI] Turn #${controller.turnCount} for ${controller.id} (${controller.aiPlayer.civilization})`);

        const gameState = this.buildGameStateJSON(controller);

        const promise = this.sendToOpenAI(controller, gameState)
            .then(actionData => {
                if (this._stopped || controller.defeated) return; // ended or defeated mid-flight — drop it
                if (actionData) {
                    this.executeAction(controller, actionData);
                } else {
                    console.warn(`[OpenAIAI] No action returned for ${controller.id}`);
                }
            })
            .catch(err => {
                console.error(`[OpenAIAI] Turn failed for ${controller.id}:`, err);
            })
            .finally(() => {
                controller.pending = false;
                this.pendingRequests.delete(controller.id);
            });

        this.pendingRequests.set(controller.id, promise);
    }
}


