// OpenAI-powered AI controller for non-human players
// Loads models from models.json, builds game state JSON, sends to LLM endpoints,
// parses tool_call responses, and executes actions in round-robin fashion.

class OpenAIAIManager {
    constructor(game) {
        this.game = game;
        this.models = [];
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
        this.pendingRequests = new Map(); // controllerId -> Promise
        this.decisionLog = []; // Array of { timestamp, playerId, civName, action, reason }
        this.maxLogEntries = 400; // keep a deep decision history for the spectator log
        this.historyLength = 20; // recent moves replayed to each model every turn, so it can
                                 // follow a multi-step plan (e.g. need gold -> train worker ->
                                 // send to gold) and not "forget" a scout it just dispatched.
                                 // Each entry is one short sentence (action + reason + outcome),
                                 // so 20 is only a few hundred tokens — cheap to raise if needed.
        this.modelsLoaded = false; // Prevent double-loading
    }

    // Per-controller behavior metrics (reset each match)
    newStats() {
        return {
            requests: 0,          // requests that returned or definitively failed
            latencies: [],        // ms per request that produced a response
            timeouts: 0,
            networkErrors: 0,
            parseFails: 0,        // response returned but no action could be extracted
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
    haveString(ai) {
        const r = ai.resources;
        return `${Math.floor(r.food)} food, ${Math.floor(r.wood)} wood, ${Math.floor(r.stone)} stone, ${Math.floor(r.gold)} gold`;
    }
    // Which building type trains a given unit (for precise "build X first" messages)
    requiredBuildingForUnit(unitType) {
        if (unitType === 'worker') return 'town_center';
        if (typeof BUILDING_TRAIN_TIERS !== 'undefined') {
            for (const bld of Object.keys(BUILDING_TRAIN_TIERS)) {
                for (const list of Object.values(BUILDING_TRAIN_TIERS[bld])) {
                    if (Array.isArray(list) && list.includes(unitType)) return bld;
                }
            }
        }
        return null;
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
    buildingTrains(b, unitType, age) {
        if (b.type === 'town_center') return unitType === 'worker';
        let opts = (typeof getTrainOptionsForBuilding === 'function') ? getTrainOptionsForBuilding(b.type, age) : null;
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
    static async testConnection(endpoint, auth, provider = 'auto', timeoutMs = 9000) {
        if (!endpoint) return { ok: false, error: 'Keine Endpoint-URL angegeben.' };
        const prov = provider === 'auto' ? OpenAIAIManager.detectProvider(endpoint) : provider;
        let headers;
        try {
            headers = await OpenAIAIManager.buildAuthHeaders(auth, prov);
        } catch (e) {
            return { ok: false, error: 'Authentifizierung fehlgeschlagen: ' + (e.message || e) };
        }
        // Each provider lists models from a different path.
        const url = prov === 'ollama'
            ? OpenAIAIManager.ollamaRoot(endpoint) + '/api/tags'
            : OpenAIAIManager.stripSlash(endpoint) + '/models';
        try {
            const resp = await OpenAIAIManager.fetchWithTimeout(url, { headers, mode: 'cors' }, timeoutMs);
            if (!resp.ok) {
                let detail = `HTTP ${resp.status} ${resp.statusText || ''}`.trim();
                if (resp.status === 401 || resp.status === 403) detail += ' — Authentifizierung abgelehnt. Prüfe Schlüssel/Header.';
                return { ok: false, error: detail, provider: prov };
            }
            const data = await resp.json();
            let models;
            if (prov === 'ollama') {
                models = (data.models || []).map(m => m.name || m.model).filter(Boolean);
            } else {
                const list = data.data || data.models || [];
                models = list.map(m => (typeof m === 'string' ? m : (m.id || m.name))).filter(Boolean)
                    .map(id => id.replace(/^models\//, '')); // strip Google's "models/" prefix
            }
            return { ok: true, models, provider: prov };
        } catch (e) {
            const msg = (e && e.name === 'AbortError') ? 'Zeitüberschreitung — Endpoint nicht erreichbar.'
                : 'Verbindung fehlgeschlagen: ' + (e.message || e) + ' (CORS? Endpoint offline?)';
            return { ok: false, error: msg, provider: prov };
        }
    }

    // ----------------------------------------------------------------
    // 1. Load models.json and fetch model names from each endpoint
    // ----------------------------------------------------------------
    async loadModels() {
        if (this.modelsLoaded) return; // Prevent double-loading
        try {
            const response = await fetch('models.json');
            const data = await response.json();
            const endpoints = data.models?.OpenAIEndpoint || [];

            this.models = [];
            for (let i = 0; i < endpoints.length; i++) {
                const url = endpoints[i];
                const modelInfo = {
                    id: `openai-ai-${i}`,
                    name: `AI Opponent ${i + 1}`,
                    endpoint: url,
                    apiKey: null,
                    model: 'default',
                    temperature: 0.7,
                    maxTokens: 2000
                };

                // Fetch model name from endpoint
                try {
                    const modelsUrl = url.replace(/\/$/, '') + '/models';
                    const modelsResp = await this.fetchWithTimeout(modelsUrl, { mode: 'cors' }, 6000);
                    if (modelsResp.ok) {
                        const modelsData = await modelsResp.json();
                        const models = modelsData.data || [];
                        if (models.length > 0) {
                            modelInfo.name = models[0].id || models[0].name || modelInfo.name;
                            modelInfo.model = models[0].id || models[0].name || 'default';
                            console.log(`[OpenAIAI] Endpoint ${i}: Model "${modelInfo.name}" found`);
                        }
                    }
                } catch (err) {
                    console.warn(`[OpenAIAI] Could not fetch models from ${url}:`, err.message);
                }

                this.models.push(modelInfo);
            }

            this.modelsLoaded = true;
            console.log(`[OpenAIAI] Loaded ${this.models.length} OpenAI endpoints`);
        } catch (err) {
            console.error('[OpenAIAI] Failed to load models.json:', err);
            this.models = [];
        }
    }

    // Wait for models to be loaded, then assign
    async initAndAssign() {
        await this.loadModels();
        this.assignModelsToAIPlayers();
    }

    // ----------------------------------------------------------------
    // 2. Assign models to AI players at game start
    // ----------------------------------------------------------------
    assignModelsToAIPlayers() {
        const aiPlayers = this.game.aiManager.aiPlayers;
        this.aiControllers = [];

        for (let i = 0; i < aiPlayers.length; i++) {
            const ai = aiPlayers[i];
            const model = this.models[i % this.models.length]; // Round-robin assignment

            const controller = {
                id: ai.id,
                aiPlayer: ai,
                model: model,
                lastTurnTime: 0,
                turnCount: 0,
                pending: false,
                paused: false, // spectator can pause a model (e.g. when it runs out of quota)
                conversationHistory: [], // Stores {action, result} for feedback loop
                lastActionResult: null, // Most recent action result for next turn
                pendingAdvice: [], // Spectator advice to inject into the next prompt
                objective: '', // Model-authored standing goal ("why"), persists until it changes it
                plan: [], // Model-authored short ordered sub-goals, persists until rewritten
                stats: this.newStats() // Behavior/performance metrics for the summary
            };

            this.aiControllers.push(controller);
            console.log(`[OpenAIAI] Assigned model "${model.name}" (${model.endpoint}) to AI "${ai.civilization}" (${ai.id})`);
        }
    }

    // ----------------------------------------------------------------
    // 2b. Initialize from Arena setup (per-player config)
    // ----------------------------------------------------------------
    async initFromSetup(setup) {
        this.aiControllers = [];

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
                contextSize: conn.contextSize || null, // Ollama num_ctx (null = default 32768)
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
                lastActionResult: null, // Most recent action result for next turn
                pendingAdvice: [], // Spectator advice to inject into the next prompt
                objective: '', // Model-authored standing goal ("why"), persists until it changes it
                plan: [], // Model-authored short ordered sub-goals, persists until rewritten
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

        // --- Epoch ---
        const ageCosts = {
            neolithic: { food: 1000, wood: 800, stone: 0, gold: 0 },
            bronze: { food: 2000, wood: 1500, stone: 400, gold: 200 },
            iron: { food: 4000, wood: 3000, stone: 1000, gold: 600 }
        };
        const nextEpoch = currentAgeIndex < ages.length - 1 ? ages[currentAgeIndex + 1] : null;

        const epochObj = {
            currentEpoch: ai.age,
            nextEpoch: nextEpoch,
            nextEpochCost: nextEpoch ? ageCosts[nextEpoch] : null,
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
            yourSpawnArea: this.getAIBuildingCenter(ai)
        };

        // --- Resources on map (only SCOUTED nodes; remembered once discovered) ---
        if (!ai._knownResIdx) ai._knownResIdx = new Set();
        const resourcesOnMap = [];
        if (game.terrain && game.terrain.resources) {
            game.terrain.resources.forEach((res, idx) => {
                const visible = !!this.isPositionVisibleToAI(ai, res.x, res.z, game);
                if (visible) ai._knownResIdx.add(idx);     // remember what we've seen
                if (!ai._knownResIdx.has(idx)) return;     // undiscovered → hidden, must scout
                if (res.amount <= 0) return;               // depleted
                resourcesOnMap.push({
                    type: res.type,
                    x: Math.round(res.x),
                    z: Math.round(res.z),
                    amount: Math.floor(res.amount),
                    visible
                });
            });
        }

        // --- Buildings (compact: friendly buildings only with essentials) ---
        const friendlyBuildings = ai.buildings.map(b => {
            const obj = {
                type: b.type,
                x: Math.round(b.x),
                z: Math.round(b.z),
                healthPct: Math.round((b.health / b.maxHealth) * 100),
                state: b.underConstruction ? 'under_construction' : 'complete',
                producing: (b.isProducing && !b.underConstruction) ? b.productionType : null
            };
            if (b.isProducing && !b.underConstruction) {
                obj.producingSecondsRemaining = this.secsLeft(b.productionProgress, b.productionDuration);
            }
            if (b.underConstruction) {
                obj.buildPct = Math.round(Math.min(1, (b.buildProgress || 0) / (b.buildTime || 10000)) * 100);
                obj.buildSecondsRemaining = this.secsLeft(b.buildProgress, b.buildTime);
            }
            if (b.isWonder) obj.wonder = true;
            if (b.type === 'farm') {
                obj.food = Math.floor(b.foodAmount || 0);
            }
            return obj;
        });

        // Enemy buildings (very compact: just type + position). A WONDER is an
        // existential threat, so it is ALWAYS revealed to everyone (ignores fog).
        const enemyBuildings = [];
        const enemyWonders = [];
        const required = (game.wonderRequired || 240);
        game.getAllBuildings().forEach(bldg => {
            if (ai.buildings.includes(bldg)) return;
            const isWonder = bldg.isWonder;
            const vis = isWonder || this.isPositionVisibleToAI(ai, bldg.x, bldg.z, game);
            if (!vis) return;
            const entry = {
                type: bldg.type,
                x: Math.round(bldg.x),
                z: Math.round(bldg.z),
                owner: bldg.owner,
                healthPct: Math.round((bldg.health / bldg.maxHealth) * 100)
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

        // Enemy units (very compact)
        const enemyUnits = [];
        game.getAllUnits().forEach(unit => {
            if (ai.units.includes(unit)) return;
            const vis = this.isPositionVisibleToAI(ai, unit.x, unit.z, game);
            if (!vis) return;
            enemyUnits.push({
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
        const unlockedContent = {
            buildings: Object.keys(ai.unlockedBuildings || {}),
            units: Object.keys(ai.unlockedUnits || {})
        };

        // --- Buildable structures for THIS civ (some civs lack e.g. the stable) ---
        // Only lists what your civilization can EVER build; if a type is missing,
        // your civ does not have it (don't waste turns trying).
        const stdBuildings = ['house', 'farm', 'barracks', 'archery_range', 'stable', 'market', 'tower', 'wall', 'temple'];
        const buildableStructures = stdBuildings.map(t => {
            const def = (typeof getBuildingDef === 'function') ? getBuildingDef(t) : null;
            if (!def) return null;
            const reqTech = def.requiresTech || null;
            const civSupports = !reqTech || !!techs[reqTech];
            if (!civSupports) return null; // civ can never build this
            const techDone = !reqTech || !!ai.researchedTechs[reqTech];
            return { type: t, requiresTech: reqTech, researched: techDone, readyToBuild: techDone };
        }).filter(Boolean);

        // --- Pending buildings ---
        const pendingBuildings = (ai.pendingBuildings || []).map(pb => pb.type);

        // --- Opponents ---
        const aiOpponents = this.aiControllers
            .filter(c => c.id !== ai.id)
            .map(c => ({
                id: c.id,
                civilization: c.aiPlayer.civilization,
                age: c.aiPlayer.age,
                units: c.aiPlayer.units.length,
                buildings: c.aiPlayer.buildings.length
            }));

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

        // --- Game stats ---
        const gameStatsObj = {
            wonderTimer: game.wonderTimer || 0,
            wonderRequired: required,
            wonderHeld: game.wonderHeld || false,
            opponents: aiOpponents
        };

        return {
            player: playerObj,
            epoch: epochObj,
            resources: resourcesObj,
            bonuses: bonusesObj,
            map: mapObj,
            resourcesOnMap: resourcesOnMap,
            friendlyBuildings: friendlyBuildings,
            enemyBuildings: enemyBuildings,
            friendlyUnits: friendlyUnits,
            enemyUnits: enemyUnits,
            research: researchObj,
            unlockedContent: unlockedContent,
            buildableStructures: buildableStructures,
            pendingBuildings: pendingBuildings,
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
        const towerVisionRange = 20;

        // Reveal around AI's units
        ai.units.forEach(unit => {
            const range = unit.unitType === 'cavalry' ? unitVisionRange * 1.2 : unitVisionRange;
            this.revealGridArea(grid, numTiles, unit.x, unit.z, range, halfSize, gridSize, 2);
        });

        // Reveal around AI's buildings
        ai.buildings.forEach(bldg => {
            const range = bldg.type === 'tower' ? towerVisionRange : buildingVisionRange;
            this.revealGridArea(grid, numTiles, bldg.x, bldg.z, range, halfSize, gridSize, 2);
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
        const unitVisionRange = 15;
        const buildingVisionRange = 12;
        const towerVisionRange = 20;

        // Check against AI units
        for (const unit of ai.units) {
            const range = unit.unitType === 'cavalry' ? unitVisionRange * 1.2 : unitVisionRange;
            const dx = unit.x - x;
            const dz = unit.z - z;
            if (Math.sqrt(dx * dx + dz * dz) <= range) return 'visible';
        }

        // Check against AI buildings
        for (const bldg of ai.buildings) {
            const range = bldg.type === 'tower' ? towerVisionRange : buildingVisionRange;
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
    // 7. Build tool_call schema
    // ----------------------------------------------------------------
    buildToolSchema() {
        return {
            type: 'function',
            function: {
                name: 'execute_action',
                description: 'Execute a single game action. Call this function to take an action this turn.',
                parameters: {
                    type: 'object',
                    properties: {
                        action: {
                            type: 'string',
                            enum: [
                                'train_worker',
                                'train_unit',
                                'research_tech',
                                'upgrade_age',
                                'build_structure',
                                'build_wonder',
                                'move_units',
                                'attack_target',
                                'harvest_resource',
                                'assign_workers',
                                'explore',
                                'delete_unit',
                                'destroy_building',
                                'wait'
                            ],
                            description: 'The action to execute this turn.'
                        },
                        params: {
                            type: 'object',
                            description: 'Parameters for the action. Include relevant fields based on the action type.',
                            properties: {
                                unitType: {
                                    type: 'string',
                                    description: 'For train_unit: unit type to train (e.g. "militia", "archer", "scout_cavalry"). For explore: OPTIONAL — name a unit type to scout with (id like "scout_cavalry" or category like "cavalry"/"worker"); omit to auto-pick the best free scout.'
                                },
                                buildingType: {
                                    type: 'string',
                                    description: 'For build_structure: building type (e.g. "house", "farm", "barracks", "market", "tower").'
                                },
                                techId: {
                                    type: 'string',
                                    description: 'For research_tech: the exact tech ID from your availableTechs list.'
                                },
                                targetX: {
                                    type: 'number',
                                    description: 'For move_units/build_structure/attack_target: X coordinate.'
                                },
                                targetZ: {
                                    type: 'number',
                                    description: 'For move_units/build_structure/attack_target: Z coordinate.'
                                },
                                targetId: {
                                    type: 'string',
                                    description: 'For attack_target: ID of the enemy unit/building to attack.'
                                },
                                resourceType: {
                                    type: 'string',
                                    enum: ['food', 'wood', 'stone', 'gold'],
                                    description: 'For harvest_resource/assign_workers: resource type to gather.'
                                },
                                count: {
                                    type: 'number',
                                    description: 'For assign_workers/delete_unit: how many units to affect.'
                                },
                                reason: {
                                    type: 'string',
                                    description: 'Brief explanation of why this action was chosen.'
                                },
                                objective: {
                                    type: 'string',
                                    description: 'OPTIONAL. Your overall standing goal and WHY (e.g. "Beat red player militarily — they are weakest"). It PERSISTS across turns until you change it, so you do not forget your plan. Include it on any action to set or update it; omit it to leave it unchanged.'
                                },
                                plan: {
                                    type: 'array',
                                    items: { type: 'string' },
                                    description: 'OPTIONAL. Up to 5 short ordered next-steps toward your objective (e.g. ["scout red base","mass 6 cavalry","attack their TC"]). It PERSISTS until you rewrite it — use it to keep sub-goals alive across turns (a scout you sent, a resource you still need). Rewrite the whole list to update; mark progress in the text ("scouting red — in progress").'
                                }
                            },
                            required: ['reason']
                        }
                    },
                    required: ['action', 'params']
                }
            }
        };
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

        // Check if this AI has a custom system prompt from Arena setup
        const controller = this.aiControllers.find(c => c.id === ai.id);
        const langDirective = this.languageDirective(controller);
        if (controller && controller.model?.customSystemPrompt) {
            // Use custom prompt, replacing placeholders
            let prompt = controller.model.customSystemPrompt;
            prompt = prompt.replace(/\{\{civilization\}\}/g, civ?.name || ai.civilization);
            prompt = prompt.replace(/\{\{bonus\}\}/g, civ?.bonus?.description || 'None');
            return prompt + langDirective;
        }

        return `You ARE ${civ?.name || ai.civilization}, a commander in the real-time strategy game "LLM Colosseum". Three rival civilizations share this map and every one is your enemy. This is a contest with a single winner. There is no human to assist or advise - YOU are playing, and you play to win.

## YOUR OBJECTIVE: WIN THE GAME
You win in one of exactly two ways:
1. Destroy the Town Centers of ALL rival civilizations, or
2. Build a Wonder and hold it for the required time (gameStats.wonderRequired seconds).
Economy, technology and population are only MEANS to that end. Endlessly optimizing your economy without ever raising an army and attacking does NOT win. Convert your economy into military power and go finish your enemies.

## DEFEND when attacked, and treat a WONDER as an emergency
- If "threats.underAttack" is non-empty, your base/units are being attacked RIGHT NOW. Defend immediately: attack_target the attacker's position (use attackerAt) with your army. If you have no army, that is an emergency — train military and/or accept that your idle units will auto-defend, but get an army fast.
- "threats.enemyWonders" lists rival Wonders (always visible, even through fog). A completed enemy Wonder WINS the game for them in "secondsUntilEnemyWins" seconds — this is an existential threat. Drop lesser plans and send every military unit to attack_target the Wonder's position and raze it (infantry are best at razing). Likewise, once YOU hold a Wonder, expect everyone to rush it — keep an army home to defend it.

## Your civilization
You play ${civ?.name || ai.civilization}. Unique bonus: ${civ?.bonus?.description || 'None'}. Play to this strength.

## How a turn works
You receive the game state as JSON and issue EXACTLY ONE command for your civilization - an actual order, not advice.

## Path to victory (don't get stuck in the early phases)
1. OPEN: train a couple of workers and send them to harvest food and wood; research and build a house early so population doesn't choke.
2. GROW: build farms for steady food, keep workers busy, advance the epoch (stone -> neolithic -> bronze -> iron) for stronger units/tech.
3. MILITARIZE: research and build a barracks, then train military units. Once the economy is stable, STOP over-investing in economy and build an army.
4. ATTACK: send your army at the weakest rival, destroy their units and Town Center, then the next - until all rivals are gone, or hold a Wonder for the required time. ALWAYS break off to defend home when "threats.underAttack" fires, and to raze any enemy Wonder.
If you have an economy but no army, your next move is military. If you have an army, use it to attack.

## Army counters (composition matters)
Cavalry beats ranged; ranged beats infantry; infantry beats cavalry. Infantry raze buildings best; archers are poor vs buildings. Counter the enemy's unit types.

## Resources
Food (deer, berries, farms) - workers and units. Wood (trees) - buildings. Stone (quarries) - advanced buildings/defenses. Gold (mines) - advanced military.

## The map is hidden — SCOUT IT
- You only see what your units/buildings are near. Resources and enemies are HIDDEN until you scout them; "resourcesOnMap" lists only what you have already discovered (remembered even after you look away).
- The whole world is "map.size" units wide, spanning "map.bounds" (minX/maxX/minZ/maxZ) centred on (0,0). Enemies can be ANYWHERE in those bounds — scout across the full map (far corners, the opposite side from your spawn), not just near home. Send explore/move targets toward unseen regions inside the bounds.
- To find more resources or the enemy, use explore (or move a unit into the dark). If you harvest_resource a type you have not discovered yet, a scout is sent automatically — try again once it appears in "resourcesOnMap".
- explore automatically uses your best available scout: an idle MILITARY unit if you have one (cavalry first — it is fast and sees farther), and only a worker if no military is free. Military scouts cost you no economy, so keeping a spare cavalry/scout_cavalry for exploration is strong; a worker sent to scout is one fewer worker gathering.

## Mechanics you MUST respect
- Your civilization can only build what is in "buildableStructures". Some civs have no stable (no cavalry) — if "stable" is absent there, rely on barracks (infantry) and archery_range (archers). Don't keep trying to build what your civ lacks.
- Research a building's tech BEFORE building it. If a type is not in "unlockedContent.buildings", research_tech it first (e.g. research_tech("barracks") -> build_structure("barracks")).
- Never research a tech already in "research.researched" (wastes the turn). Only ONE tech at a time ("research.current").
- New workers are IDLE until commanded - use harvest_resource (or assign_workers to pull busy workers onto a new job).
- You cannot exceed your population cap. Build houses when "resources.populationFree" is low — but each house only raises "maxPopulation" up to the HARD CAP "resources.populationHardCap" (100). Once maxPopulation is already at that hard cap, building more houses does NOTHING; the only way to make room is delete_unit (cull weak/idle units to free population for stronger ones).
- Only attempt actions you can afford (check "resources").
- TIME PASSES. You cannot see the screen's progress bars, so each action's result tells you how long it takes (e.g. "~5s to produce", "~30s to advance", "~12s to arrive"), and the state reports "secondsRemaining" for research ("research.current"), age-up ("epoch.upgradeInProgress"), unit production ("buildings[].producingSecondsRemaining") and construction ("buildings[].buildSecondsRemaining"). Do NOT re-issue an action that is still in progress — it wastes the turn or thrashes your units. Let scouts/armies travel and timers finish; spend in-progress turns on OTHER useful work (economy, other buildings, planning your attack).

## Stay on plan across turns (objective + plan)
- You act ONE step per turn, so a strategy spans many turns. To avoid forgetting WHY you started something, you keep a STANDING objective and plan that persist across turns until you change them — shown back to you at the top of every turn ("YOUR STANDING OBJECTIVE").
- Set/update them with the optional "objective" (one line: your overall goal + why) and "plan" (up to 5 short ordered next-steps) fields on ANY action — it does not cost an extra turn. Omit them to leave them unchanged.
- Use the plan to keep sub-goals alive: e.g. objective "Crush red player", plan ["scout red's base","mass 6 cavalry","attack red TC"] — so a scout you sent or a resource you still need is not forgotten once it scrolls out of your recent moves. Rewrite the plan as steps complete or priorities shift; note progress in the text ("scouting red — in progress").

## Actions (choose ONE per turn)
- train_worker: train a worker at your Town Center.
- train_unit: params.unitType = "militia" | "archer" | "scout_cavalry" (needs the right building).
- research_tech: params.techId = an exact id from "research.available".
- upgrade_age: advance to the next epoch.
- build_structure: params.buildingType = "house" | "farm" | "barracks" | "stable" | "archery_range" | "market" | "tower" (must be researched). Placing it pulls a worker to build a SITE over several seconds; it only works once "state":"complete".
- build_wonder: start your civ's Wonder (needs the Iron age); hold it (gameStats.wonderRequired s) after it finishes to WIN — but expect rivals to rush it.
- harvest_resource: params.resourceType = "food" | "wood" | "stone" | "gold" (sends an idle worker; auto-scouts if undiscovered).
- assign_workers: params.resourceType (+ optional count) - REASSIGN workers off their current task onto gathering that resource.
- explore: params.targetX, params.targetZ (or none) - send a scout to reveal hidden map, resources and enemies. Optional params.unitType picks which unit scouts (e.g. "scout_cavalry"); omit it to auto-pick your best free scout.
- move_units: params.targetX, params.targetZ (reposition your army).
- attack_target: params.targetX, params.targetZ (or params.targetId) - your army marches there and engages any enemy on the way, pursuing even if they move. This is how you destroy enemies and win.
- delete_unit: params.unitType (+ optional count) - remove your own units to free population.
- destroy_building: params.buildingType (+ optional targetX/targetZ) - demolish one of your own buildings (won't destroy your last Town Center).
- build_wonder: start your civ's Wonder (needs the Iron age); hold it (gameStats.wonderRequired s) after it finishes to WIN — but expect rivals to rush it.
- wait: only if nothing useful is possible.

## Response format
Return ONLY a single JSON object, no markdown, no code fences, no extra prose:
{
  "action": "<action_name>",
  "params": { "reason": "<how this moves you toward winning>", "objective": "<optional: your standing goal>", "plan": ["optional","short","next-steps"] }
}

Valid actions: train_worker, train_unit, research_tech, upgrade_age, build_structure, build_wonder, harvest_resource, assign_workers, explore, move_units, attack_target, delete_unit, destroy_building, wait${langDirective}`;
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
        const parts = [];

        // 0) The model's STANDING objective/plan first, so its own intent frames the
        //    whole turn. It persists across turns until the model changes it (via the
        //    "objective"/"plan" fields on any action), so sub-goals survive even when
        //    they fall off the move history below.
        if ((controller.objective && controller.objective.trim()) || (controller.plan && controller.plan.length)) {
            let s = `YOUR STANDING OBJECTIVE (you set this; it persists until you change it via the "objective"/"plan" fields on any action — update it as your plan evolves):`;
            if (controller.objective && controller.objective.trim()) s += `\nGoal: ${controller.objective}`;
            if (controller.plan && controller.plan.length) {
                s += `\nPlan: ` + controller.plan.map((p, i) => `(${i + 1}) ${p}`).join('  ');
            }
            parts.push(s);
        }

        // 1) Recent move history for continuity, oldest first. A long-ish window
        //    (historyLength) lets the model follow a multi-step plan across turns
        //    instead of forgetting WHY it started something (e.g. it advanced-age,
        //    found it lacked gold, trained a worker, sent it to gold). Each move is
        //    one short sentence: action ("reason") -> OK/FAILED: outcome.
        const recentHistory = controller.conversationHistory.slice(-this.historyLength);
        if (recentHistory.length) {
            const trim = (s) => { s = String(s).replace(/^\[ERROR\]\s*/, '').replace(/^OK\s*-\s*/, '').trim(); return s.length > 200 ? s.slice(0, 197) + '…' : s; };
            const lines = recentHistory
                .filter(e => e && e.action && e.result)
                .map((e, i) => {
                    const status = e.failed ? 'FAILED' : 'OK';
                    const why = e.reason ? ` ("${String(e.reason).slice(0, 120)}")` : '';
                    return `${i + 1}. ${e.action}${why} -> ${status}: ${trim(e.result)}`;
                })
                .join('\n');
            if (lines) parts.push(`Your recent moves THIS match (oldest first) — keep a consistent strategy, finish multi-step plans you started, and learn from the results:\n${lines}`);
        }

        // 2) Feedback from a previous turn that produced NO valid action (e.g. a parse
        //    failure) — that turn isn't in the history above, so surface it once.
        const lastHistResult = recentHistory.length ? String(recentHistory[recentHistory.length - 1].result) : null;
        if (controller.lastActionResult && controller.lastActionResult !== lastHistResult) {
            parts.push(`Note on your previous response: ${controller.lastActionResult}`);
        }

        // 3) The CURRENT situation — last, so the model responds to the present.
        parts.push(`Here is your CURRENT game state. Analyze it and choose the single best action for THIS turn.\n\nGame State JSON:\n${JSON.stringify(gameState, null, 2)}`);

        // 4) Spectator advice queued for this model, delivered exactly once.
        if (controller.pendingAdvice && controller.pendingAdvice.length) {
            const advice = controller.pendingAdvice.join(' ');
            controller.pendingAdvice = [];
            parts.push(`SPECTATOR ADVICE (a human observer suggests — weigh it, you still decide): ${advice}`);
        }

        const userMessage = parts.join('\n\n');

        // A single user turn keeps the request valid for every provider (OpenAI,
        // Anthropic, Ollama, Google all accept a lone user message after the system
        // prompt) and avoids role-alternation pitfalls.
        const turns = [{ role: 'user', content: userMessage }];

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
            // never gets stuck "pending" for the rest of the match.
            const controllerAbort = new AbortController();
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
            const result = this.parseResponse(norm, controller);

            // Behavior metrics: time-to-answer + parse outcome
            const s = controller.stats;
            if (s) {
                s.requests++;
                s.latencies.push(Date.now() - reqStart);
                if (!result) s.parseFails++;
            }

            // If parsing failed, store error feedback for next turn
            if (!result) {
                controller.lastActionResult = `[ERROR] Your last response could not be parsed. Please use the execute_action tool with valid JSON containing "action" and "params" fields. Example: {"action": "wait", "params": {"reason": "analyzing situation"}}`;
            }

            return result;
        } catch (err) {
            console.error(`[OpenAIAI] Request failed for ${ai.id}:`, err);
            // Behavior metrics: classify the failure
            const s = controller.stats;
            if (s) {
                s.requests++;
                if (/timed out/i.test(err.message)) s.timeouts++;
                else s.networkErrors++;
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
                action: '⚠️ request_failed',
                reason: `Request to model failed: ${err.message.substring(0, 100)}`,
                params: {}
            });
            if (this.decisionLog.length > this.maxLogEntries) {
                this.decisionLog = this.decisionLog.slice(0, this.maxLogEntries);
            }
            return null;
        }
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
                action: '⚠️ tool_call_failed',
                reason: `Tool call could not be interpreted: ${reason}`,
                params: {}
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
                    return { action: this.inferActionFromText(args), params: { reason: args.trim().slice(0, 200) } };
                }
            }

            // 3) Last resort: infer an action from free text so the player keeps
            //    moving even when the model ignored the JSON format.
            const freeText = (message.content || message.reasoning || '').toString().trim();
            if (freeText) {
                console.warn(`[OpenAIAI] Free-text response, inferring action:`, freeText.substring(0, 160));
                return { action: this.inferActionFromText(freeText), params: { reason: freeText.slice(0, 200) } };
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
            console.error('[OpenAIAI] Failed to parse response:', err, data);
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

    // Guess an action from free-text when no JSON could be parsed.
    inferActionFromText(text) {
        const lower = (text || '').toLowerCase();
        if (lower.includes('harvest') || lower.includes('gather') || lower.includes('sammel')) return 'harvest_resource';
        if (lower.includes('research') || lower.includes('forsch') || lower.includes('tech')) return 'research_tech';
        if (lower.includes('attack') || lower.includes('angri')) return 'attack_target';
        if (lower.includes('upgrade') || lower.includes('advance') || lower.includes('epoch') || lower.includes('age')) return 'upgrade_age';
        if (lower.includes('build') || lower.includes('bau')) return 'build_structure';
        if (lower.includes('move') || lower.includes('beweg')) return 'move_units';
        if (lower.includes('militia') || lower.includes('archer') || lower.includes('cavalry') || lower.includes('soldier')) return 'train_unit';
        if (lower.includes('worker') || lower.includes('train') || lower.includes('villager')) return 'train_worker';
        return 'wait';
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
        this.decisionLog.unshift(logEntry);
        // Trim log
        if (this.decisionLog.length > this.maxLogEntries) {
            this.decisionLog = this.decisionLog.slice(0, this.maxLogEntries);
        }

        // Persist the model's standing objective/plan if it set one this turn. These
        // live on the controller and are replayed at the TOP of every prompt, so a
        // multi-step intent (and its surviving sub-goals) outlasts the move history.
        // Wholesale-replace semantics: the model rewrites them when they change.
        if (params && typeof params.objective === 'string' && params.objective.trim()) {
            controller.objective = params.objective.trim().slice(0, 300);
        }
        if (params && Array.isArray(params.plan)) {
            controller.plan = params.plan
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
                    actionResult = this.executeTrainUnit(ai, game, params.unitType);
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
                    actionResult = this.executeMoveUnits(ai, game, params.unitIds || [], params.targetX, params.targetZ);
                } else {
                    actionResult = `[ERROR] move_units requires "targetX" and "targetZ" parameters.`;
                }
                break;

            case 'attack_target':
                if (params?.targetId) {
                    actionResult = this.executeAttackTarget(ai, game, params.targetId, params?.unitIds || []);
                } else if (params?.targetX !== undefined && params?.targetZ !== undefined) {
                    actionResult = this.executeAttackPosition(ai, game, params.targetX, params.targetZ, params.unitIds || []);
                } else {
                    actionResult = `[ERROR] attack_target requires "targetId" or ("targetX" and "targetZ") parameters.`;
                }
                break;

            case 'harvest_resource':
                if (params?.resourceType) {
                    actionResult = this.executeHarvestResource(ai, game, params.resourceType);
                } else {
                    actionResult = `[ERROR] harvest_resource requires "resourceType" parameter.`;
                }
                break;

            case 'build_wonder':
                actionResult = this.executeBuildWonder(ai, game);
                break;

            case 'assign_workers':
                actionResult = this.executeAssignWorkers(ai, game, params || {});
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

            default:
                actionResult = `[ERROR] Unknown action: ${action}`;
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
        // short sentence per move keeps a long history (historyLength) affordable
        // while preserving the "why" across a multi-step plan.
        if (actionResult) {
            logEntry.result = actionResult; // so the spectator log can show the outcome
            controller.conversationHistory.push({
                action: action,
                reason: (params && params.reason) ? String(params.reason) : '',
                result: actionResult,
                failed: !!logEntry.failed
            });
            // Keep history manageable
            if (controller.conversationHistory.length > this.historyLength) {
                controller.conversationHistory = controller.conversationHistory.slice(-this.historyLength);
            }
            controller.lastActionResult = actionResult;
        }
    }

    // ----------------------------------------------------------------
    // 12. Action implementations
    // ----------------------------------------------------------------
    // Advice tailored to whether houses can still help or the hard cap is reached.
    popCapAdvice(ai) {
        const cap = (typeof MAX_POPULATION_CAP !== 'undefined') ? MAX_POPULATION_CAP : 100;
        if (ai.resources.maxPopulation >= cap) {
            return `You are at the HARD population cap of ${cap} — building houses will NOT raise it. delete_unit to cull weaker/idle units and free room.`;
        }
        return `Build houses to raise maxPopulation (up to the hard cap of ${cap}), or delete_unit to free room now.`;
    }

    executeTrainWorker(ai, game, params = {}) {
        // Models sometimes call train_worker but pass a military unit type. That's a
        // tool-calling mismatch: train_worker ALWAYS makes a villager at the Town
        // Center. Tell them the right action instead of silently training a worker.
        const ut = params && params.unitType;
        if (ut && ut !== 'worker') {
            return `[ERROR] train_worker only trains a Villager (worker) at the Town Center — it ignores unitType. To train "${ut}", use action "train_unit" with params.unitType="${ut}" (military units come from a barracks/archery_range/stable, not the Town Center).`;
        }
        const townCenters = ai.buildings.filter(b => b.type === 'town_center' && !b.isProducing && !b.underConstruction);
        if (townCenters.length === 0) {
            console.log(`[OpenAIAI] ${ai.id}: No available Town Center to train worker`);
            return `[ERROR] No available Town Center to train worker (all are busy or still under construction).`;
        }

        // Check population limit before training worker
        if (ai.resources.population >= ai.resources.maxPopulation) {
            console.log(`[OpenAIAI] ${ai.id}: Population limit reached (${ai.resources.population}/${ai.resources.maxPopulation})`);
            return `[ERROR] Population limit reached (${ai.resources.population}/${ai.resources.maxPopulation}). ${this.popCapAdvice(ai)}`;
        }

        const workerDef = getUnitDef('worker');
        if (!ai.resources.hasResources(workerDef.cost)) {
            console.log(`[OpenAIAI] ${ai.id}: Cannot afford worker`);
            return `[ERROR] Cannot afford a worker (needs ${this.costString(workerDef.cost)}). You have ${this.haveString(ai)}.`;
        }

        const tc = townCenters[0];
        ai.resources.spendResources(workerDef.cost);
        tc.isProducing = true;
        tc.productionType = 'worker';
        tc.productionDuration = 5000;
        tc.productionProgress = 0;
        console.log(`[OpenAIAI] ${ai.id}: Training worker at Town Center`);
        return `OK - Training a worker at the Town Center (~5s to produce; ${Math.floor(ai.resources.food)} food left). The Town Center is busy until it finishes.`;
    }

    executeTrainUnit(ai, game, unitType) {
        if (unitType === 'worker') return this.executeTrainWorker(ai, game);

        const civ = getCivilization(ai.civilization);
        const unitDef = getUnitDef(unitType) || (civ.uniqueUnits || []).find(u => u.id === unitType);
        if (!unitDef) {
            console.log(`[OpenAIAI] ${ai.id}: Unknown unit type "${unitType}"`);
            return `[ERROR] Unknown unit type "${unitType}".`;
        }

        const ageOrder = ['stone', 'neolithic', 'bronze', 'iron'];
        const reqB = this.requiredBuildingForUnit(unitType); // 'barracks' | 'stable' | 'archery_range' | null
        const rightType = (b) => reqB ? (b.type === reqB) : false;

        // Validation follows the advancement chain so the message always points at
        // the EARLIEST unmet step: Research → Build → Advance → Population → Resources.
        if (reqB) {
            const finishedOfType = ai.buildings.filter(b => rightType(b) && !b.underConstruction);

            // 1) RESEARCH / BUILD: no finished building of the right type yet.
            if (finishedOfType.length === 0) {
                if (ai.buildings.some(b => rightType(b) && b.underConstruction)) {
                    return `[ERROR] Your ${reqB} is still under construction. Wait for it to finish, then train ${unitType}.`;
                }
                const bdef = getBuildingDef(reqB);
                const tech = bdef && bdef.requiresTech;
                const civTree = civ.techTree || {};
                if (tech && !civTree[tech]) {
                    return `[ERROR] Your civilization cannot train ${unitType} — it has no ${reqB} (no "${tech}" technology). Train a different unit class (barracks=infantry, archery_range=archers, stable=cavalry; see "buildableStructures").`;
                }
                if (tech && !ai.researchedTechs[tech]) {
                    return `[ERROR] ${unitType} is trained at a ${reqB}, which you have not unlocked. research_tech "${tech}" first, then build_structure "${reqB}", then train.`;
                }
                return `[ERROR] ${unitType} is trained at a ${reqB}, which you have not built yet. build_structure "${reqB}" and wait for it to finish, then train.`;
            }

            // 2) ADVANCE: the building exists but the unit is gated to a later epoch.
            if (!this.buildingTrains(finishedOfType[0], unitType, ai.age)) {
                const minAge = this.minAgeForUnit(unitType);
                if (minAge && ageOrder.indexOf(minAge) > ageOrder.indexOf(ai.age)) {
                    return `[ERROR] ${unitType} needs the ${minAge} age (you are in ${ai.age}). Advance your age first (upgrade_age); your ${reqB} will train it then.`;
                }
                return `[ERROR] Your ${reqB} cannot train ${unitType} at your current tier. Check what it can produce for your age.`;
            }
        }

        // From here a finished, age-capable building exists. Trainers for this unit:
        const trainers = ai.buildings.filter(b => !b.underConstruction && this.buildingTrains(b, unitType, ai.age));
        if (trainers.length === 0) {
            // Only reached for unique units with no tier mapping (reqB null).
            return `[ERROR] No finished building can train ${unitType}. Build the matching military building first (barracks=infantry, archery_range=archers, stable=cavalry).`;
        }

        // 3) POPULATION (structural train-time gate).
        if (ai.resources.population >= ai.resources.maxPopulation) {
            console.log(`[OpenAIAI] ${ai.id}: Population limit reached (${ai.resources.population}/${ai.resources.maxPopulation})`);
            return `[ERROR] Population limit reached (${ai.resources.population}/${ai.resources.maxPopulation}). ${this.popCapAdvice(ai)}`;
        }

        // 4) BUSY: a trainer exists but all are mid-production (transient).
        const free = trainers.find(b => !b.isProducing);
        if (!free) {
            const tName = trainers[0].type;
            return `[ERROR] Your ${tName} is busy producing right now. Wait for it to finish, or build another ${tName} to train in parallel.`;
        }

        // 5) RESOURCES.
        if (!ai.resources.hasResources(unitDef.cost)) {
            console.log(`[OpenAIAI] ${ai.id}: Cannot afford ${unitType}`);
            return `[ERROR] Cannot afford ${unitType} (needs ${this.costString(unitDef.cost)}). You have ${this.haveString(ai)}.`;
        }

        // TRAIN.
        ai.resources.spendResources(unitDef.cost);
        free.isProducing = true;
        free.productionType = unitType;
        free.productionDuration = 5000;
        free.productionProgress = 0;
        console.log(`[OpenAIAI] ${ai.id}: Training ${unitType} at ${free.name}`);
        return `OK - Training ${unitType} at ${free.name} (~5s to produce; that building is busy until it finishes).`;
    }

    executeResearchTech(ai, game, techId) {
        const civ = getCivilization(ai.civilization);
        const tech = civ?.techTree?.[techId];
        if (!tech) {
            console.log(`[OpenAIAI] ${ai.id}: Unknown tech "${techId}"`);
            return `[ERROR] Unknown tech "${techId}". Check "research.available" for valid tech IDs.`;
        }

        if (ai.researchedTechs[techId]) {
            console.log(`[OpenAIAI] ${ai.id}: Tech "${techId}" already researched`);
            return `[ERROR] Tech "${techId}" already researched! Check "research.researched" list before researching.`;
        }

        if (ai.currentResearch) {
            console.log(`[OpenAIAI] ${ai.id}: Already researching a tech`);
            return `[ERROR] Already researching "${ai.currentResearch.techId}". Wait for it to complete first.`;
        }

        // Check age requirement
        const ageOrder = ['stone', 'neolithic', 'bronze', 'iron'];
        if (ageOrder.indexOf(tech.requiredAge) > ageOrder.indexOf(ai.age)) {
            console.log(`[OpenAIAI] ${ai.id}: Tech "${techId}" requires ${tech.requiredAge}`);
            return `[ERROR] "${techId}" needs the ${tech.requiredAge} age, but you are in ${ai.age}. Advance your age first (upgrade_age).`;
        }

        // Check prerequisites
        if (tech.requires) {
            for (const req of tech.requires) {
                if (!ai.researchedTechs[req]) {
                    console.log(`[OpenAIAI] ${ai.id}: Missing prerequisite "${req}" for "${techId}"`);
                    return `[ERROR] Missing prerequisite "${req}" for "${techId}". Research "${req}" first.`;
                }
            }
        }

        // Check if we have the building
        if (tech.researchAt === 'town_center') {
            if (!ai.buildings.some(b => b.type === 'town_center' && !b.underConstruction)) return `[ERROR] Need a finished Town Center to research "${techId}".`;
        } else if (tech.researchAt === 'market') {
            if (!ai.buildings.some(b => b.type === 'market' && !b.underConstruction)) {
                console.log(`[OpenAIAI] ${ai.id}: Need a finished Market to research "${techId}"`);
                const hasMarketTech = !!ai.researchedTechs['marketTech'];
                const step = hasMarketTech ? 'build a Market (build_structure "market") and wait for it to finish'
                    : 'first research "marketTech", then build a Market and wait for it to finish';
                return `[ERROR] "${techId}" is researched at a Market, which you don't have. To enable it: ${step}.`;
            }
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
        return `OK - Researching "${tech.name}" (${techId}) — ~${researchSecs}s to complete. Only one tech at a time; don't re-issue until "research.current" is empty (it shows secondsRemaining).`;
    }

    executeUpgradeAge(ai, game) {
        const ages = ['stone', 'neolithic', 'bronze', 'iron'];
        const currentIdx = ages.indexOf(ai.age);
        if (currentIdx >= ages.length - 1) {
            console.log(`[OpenAIAI] ${ai.id}: Already at max age`);
            return `[ERROR] Already at max age (Iron Age).`;
        }

        if (ai.currentAgeUpgrade) {
            console.log(`[OpenAIAI] ${ai.id}: Already upgrading age`);
            return `[ERROR] Already upgrading age to "${ai.currentAgeUpgrade.targetAge}". Wait for completion.`;
        }

        const nextAge = ages[currentIdx + 1];
        const ageCosts = {
            neolithic: { food: 1000, wood: 800, stone: 0, gold: 0 },
            bronze: { food: 2000, wood: 1500, stone: 400, gold: 200 },
            iron: { food: 4000, wood: 3000, stone: 1000, gold: 600 }
        };

        const cost = ageCosts[nextAge];
        if (!ai.resources.hasResources(cost)) {
            console.log(`[OpenAIAI] ${ai.id}: Cannot afford upgrade to ${nextAge}`);
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
        return `OK - Advancing to the ${nextAge} age — ~${ageSecs}s to complete. Keep developing meanwhile; "epoch.upgradeInProgress" shows secondsRemaining, so don't re-issue upgrade_age until it is done.`;
    }

    executeBuildStructure(ai, game, buildingType, targetX, targetZ) {
        const buildingDef = getBuildingDef(buildingType);
        if (!buildingDef) {
            console.log(`[OpenAIAI] ${ai.id}: Unknown building "${buildingType}"`);
            return `[ERROR] Unknown building "${buildingType}". Check "unlockedContent.buildings" for valid types.`;
        }

        // ADVANCE first: a building gated to a later epoch can't be built yet. (Most
        // age-gated buildings also need a tech, but some — e.g. the temple — only
        // need the age, so check it before the tech/resource steps.)
        const ageOrder = ['stone', 'neolithic', 'bronze', 'iron'];
        if (buildingDef.requiredAge && ageOrder.indexOf(ai.age) < ageOrder.indexOf(buildingDef.requiredAge)) {
            console.log(`[OpenAIAI] ${ai.id}: ${buildingType} needs ${buildingDef.requiredAge}`);
            return `[ERROR] ${buildingType} needs the ${buildingDef.requiredAge} age (you are in ${ai.age}). Advance your age first (upgrade_age), then build it.`;
        }

        // RESEARCH next: the building's enabling tech.
        if (buildingDef.requiresTech && !ai.researchedTechs[buildingDef.requiresTech]) {
            console.log(`[OpenAIAI] ${ai.id}: Need tech "${buildingDef.requiresTech}" for ${buildingType}`);
            const civTree = getCivilization(ai.civilization).techTree || {};
            // Some civilizations simply do not have the tech (e.g. no stable). Say so
            // clearly so the model stops retrying and switches strategy.
            if (!civTree[buildingDef.requiresTech]) {
                return `[ERROR] Your civilization cannot build ${buildingType} — it has no "${buildingDef.requiresTech}" technology. Use a different building. See "buildableStructures" for what you CAN build (e.g. barracks for infantry, archery_range for archers).`;
            }
            const techName = civTree[buildingDef.requiresTech]?.name;
            return `[ERROR] You must research "${buildingDef.requiresTech}"${techName ? ` (${techName})` : ''} before you can build ${buildingType}. Use research_tech first (it should appear in "research.available"), then build.`;
        }

        if (!ai.resources.hasResources(buildingDef.cost)) {
            console.log(`[OpenAIAI] ${ai.id}: Cannot afford ${buildingType}`);
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
            return `[ERROR] No Town Center found for placement reference.`;
        }

        // Validate position: keep walkable gaps between buildings AND an exclusion
        // zone around resource nodes (so harvesters can still reach them).
        const reqGap = b => (b.type === 'town_center' || b.isWonder) ? 11 : 9;
        const isWonderBuild = buildingDef.type === 'wonder';
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

        if (!valid) {
            console.log(`[OpenAIAI] ${ai.id}: Could not find valid position for ${buildingType}`);
            return `[ERROR] Could not find a clear spot for ${buildingType} (too crowded by buildings or resource nodes). Try a different targetX/targetZ.`;
        }

        // Decide who will build it BEFORE spending. Only idle workers build; a busy
        // worker is borrowed (and resumes its task) only when at the population cap.
        const pick = game.pickBuilder(ai, { x, z });
        if (pick.error === 'no_workers') {
            return `[ERROR] You have no workers to build ${buildingType}. Train a worker first.`;
        }
        if (pick.error === 'no_idle') {
            return `[ERROR] No idle worker to build ${buildingType}. Train another worker or wait until one is idle (you are below your population cap).`;
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
        return pick.restore
            ? `OK - Construction of ${buildingDef.name} started at (${Math.round(x)}, ${Math.round(z)}); a worker was pulled off its task to build (~${secs}s) and will return afterwards.`
            : `OK - Construction of ${buildingDef.name} started at (${Math.round(x)}, ${Math.round(z)}); an idle worker is building it (~${secs}s).`;
    }

    // Build this civ's Wonder. Win by holding it for the required time.
    executeBuildWonder(ai, game) {
        const civ = getCivilization(ai.civilization);
        const wonderDef = (civ.uniqueBuildings || []).find(b => b.type === 'wonder');
        if (!wonderDef) return `[ERROR] Your civilization has no Wonder.`;

        const ageOrder = ['stone', 'neolithic', 'bronze', 'iron'];
        const reqAge = wonderDef.requiredAge || 'iron';
        if (ageOrder.indexOf(ai.age) < ageOrder.indexOf(reqAge)) {
            return `[ERROR] The Wonder requires the ${reqAge} age. You are in ${ai.age}. Advance your age first.`;
        }
        if (ai.buildings.some(b => b.isWonder)) {
            return `[ERROR] You are already building or holding a Wonder.`;
        }
        if (!ai.resources.hasResources(wonderDef.cost)) {
            const c = wonderDef.cost;
            return `[ERROR] Cannot afford the Wonder (needs ${this.costString(c)}). You have ${this.haveString(ai)}.`;
        }

        // Place near the town center
        const tc = ai.buildings.find(b => b.type === 'town_center');
        let x = tc ? tc.x + (Math.random() - 0.5) * 20 : 0;
        let z = tc ? tc.z + (Math.random() - 0.5) * 20 : 0;

        const pick = game.pickBuilder(ai, { x, z });
        if (pick.error === 'no_workers') return `[ERROR] You have no workers to build the Wonder.`;
        if (pick.error === 'no_idle') return `[ERROR] No idle worker to start the Wonder. Free or train a worker first.`;

        ai.resources.spendResources(wonderDef.cost);
        const wonder = createBuilding(wonderDef.id, x, z, ai.id, ai.civilization, { underConstruction: true, age: ai.age });
        ai.buildings.push(wonder);
        game.renderer.addBuilding(wonder);
        game.applyBuilder(pick, wonder);
        const secs = Math.round((wonder.buildTime || 60000) / 1000);
        return `OK - Started building the Wonder "${wonderDef.name}" (~${secs}s to build). Hold it for ${(game.wonderRequired || 240)}s after completion to WIN — defend it, rivals will rush it!`;
    }

    executeMoveUnits(ai, game, unitIds, targetX, targetZ) {
        let unitsToMove = ai.units.filter(u => u.type !== 'worker'); // Default: military units

        if (unitIds && unitIds.length > 0) {
            unitsToMove = ai.units.filter(u => unitIds.includes(u.id));
        }

        if (unitsToMove.length === 0) {
            console.log(`[OpenAIAI] ${ai.id}: No units to move`);
            return `[ERROR] No military units available to move. Train units first.`;
        }

        // Validate the destination so bad coords don't strand units at NaN.
        const mx = Number(targetX), mz = Number(targetZ);
        if (!Number.isFinite(mx) || !Number.isFinite(mz)) {
            return `[ERROR] move_units needs numeric "targetX" and "targetZ" (map coordinates inside map.bounds). Got targetX=${JSON.stringify(targetX)}, targetZ=${JSON.stringify(targetZ)}.`;
        }

        // Keep the destination on solid ground (no marching into the ocean).
        ({ x: targetX, z: targetZ } = game.clampToMap(mx, mz));

        let eta = 0;
        unitsToMove.forEach(unit => {
            eta = Math.max(eta, this.travelEtaSec(unit, targetX, targetZ));
            unit.isMoving = true;
            unit.targetX = targetX;
            unit.targetZ = targetZ;
            unit.isAttacking = false;
            unit.attackTarget = null;
            unit.attackMove = null;
            unit.task = null;
        });

        console.log(`[OpenAIAI] ${ai.id}: Moving ${unitsToMove.length} units to (${Math.round(targetX)}, ${Math.round(targetZ)})`);
        return `OK - Moving ${unitsToMove.length} unit(s) to (${Math.round(targetX)}, ${Math.round(targetZ)}) — ~${eta}s to arrive; let them march before re-issuing.`;
    }

    executeAttackTarget(ai, game, targetId, unitIds) {
        // Find target in all units and buildings
        let target = null;
        target = game.getAllUnits().find(u => (u.id || '') === targetId);
        if (!target) {
            target = game.getAllBuildings().find(b => (b.id || '') === targetId);
        }

        if (!target) {
            console.log(`[OpenAIAI] ${ai.id}: Target "${targetId}" not found`);
            return `[ERROR] Target "${targetId}" not found. ${this.attackTargetHint(ai, game)}`;
        }

        // Friendly-fire guard: a model must not attack its own units/buildings.
        if (this.isOwnedByAI(target, ai)) {
            console.log(`[OpenAIAI] ${ai.id}: Refused self-attack on "${target.name || target.type}"`);
            return `[ERROR] Target "${target.name || target.type}" is your own ${target.type}. You cannot attack your own units or buildings. ${this.attackTargetHint(ai, game)}`;
        }

        let unitsToAttack = ai.units.filter(u => u.type !== 'worker');
        if (unitIds && unitIds.length > 0) {
            unitsToAttack = ai.units.filter(u => unitIds.includes(u.id));
        }

        if (unitsToAttack.length === 0) {
            console.log(`[OpenAIAI] ${ai.id}: No units to attack with`);
            return `[ERROR] No military units available to attack. Train units first.`;
        }

        unitsToAttack.forEach(unit => {
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
        });

        console.log(`[OpenAIAI] ${ai.id}: ${unitsToAttack.length} units attacking "${target.name || target.type}"`);
        return `OK - ${unitsToAttack.length} units attacking "${target.name || target.type}".`;
    }

    executeAttackPosition(ai, game, targetX, targetZ, unitIds) {
        let unitsToAttack = ai.units.filter(u => u.type !== 'worker');
        if (unitIds && unitIds.length > 0) {
            unitsToAttack = ai.units.filter(u => unitIds.includes(u.id));
        }
        if (unitsToAttack.length === 0) {
            return `[ERROR] No military units available to attack. Train units first.`;
        }

        // Keep the attack-move objective on solid ground.
        ({ x: targetX, z: targetZ } = game.clampToMap(targetX, targetZ));

        // Seed an initial target if anything is near the spot; otherwise the units
        // attack-MOVE to the location and engage whatever they meet on the way (the
        // order never fails just because the enemy has since moved).
        let nearest = null, minDist = 40;
        for (const entity of [...game.getAllUnits(), ...game.getAllBuildings()]) {
            if (this.isOwnedByAI(entity, ai)) continue;
            if (entity.health <= 0) continue;
            const d = Math.hypot(entity.x - targetX, entity.z - targetZ);
            if (d < minDist) { minDist = d; nearest = entity; }
        }

        unitsToAttack.forEach(unit => {
            unit.isAttacking = true;
            unit.attackTarget = nearest || null;
            unit.attackMove = { x: targetX, z: targetZ };
            unit.attackTimer = 0;
            unit.isMoving = true;
            unit.targetX = (nearest ? nearest.x : targetX);
            unit.targetZ = (nearest ? nearest.z : targetZ);
            unit.task = null;
        });

        return nearest
            ? `OK - ${unitsToAttack.length} units attacking enemy near (${Math.round(targetX)}, ${Math.round(targetZ)}).`
            : `OK - ${unitsToAttack.length} units attack-moving to (${Math.round(targetX)}, ${Math.round(targetZ)}); they will engage any enemy they encounter.`;
    }

    // Resources are hidden until SCOUTED. Update the AI's discovery memory and
    // return the discovered (visible-or-remembered) nodes of a given type.
    // Short summary of what this AI has ACTUALLY discovered, by type — used to
    // ground a rejected harvest/assign so the model stops chasing a resource it
    // only imagines (it cannot see the rendered map; only "resourcesOnMap").
    discoveredResourceSummary(ai, game) {
        if (!ai._knownResIdx) ai._knownResIdx = new Set();
        const counts = {};
        const list = (game.terrain && game.terrain.resources) || [];
        list.forEach((res, idx) => {
            if (ai._knownResIdx.has(idx) && res.amount > 0) {
                counts[res.type] = (counts[res.type] || 0) + 1;
            }
        });
        const parts = ['food', 'wood', 'stone', 'gold']
            .filter(t => counts[t])
            .map(t => `${t} (${counts[t]})`);
        return parts.length ? parts.join(', ') : 'nothing yet';
    }

    discoveredNodesOfType(ai, game, resourceType) {
        if (!ai._knownResIdx) ai._knownResIdx = new Set();
        const out = [];
        const list = (game.terrain && game.terrain.resources) || [];
        list.forEach((res, idx) => {
            if (this.isPositionVisibleToAI(ai, res.x, res.z, game)) ai._knownResIdx.add(idx);
            if (ai._knownResIdx.has(idx) && res.type === resourceType && res.amount > 0) out.push(res);
        });
        return out;
    }

    // True if a unit is committed to a fight (so we must NOT pull it off to scout).
    isInCombat(u) {
        return !!(u && (u.isAttacking || u.attackTarget || u.attackMove));
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
            const matches = ai.units.filter(u => !this.isInCombat(u) &&
                ((u.type || '').toLowerCase() === pt || (u.unitType || '').toLowerCase() === pt));
            if (matches.length) {
                // Prefer a genuinely idle one (so we don't pull a working worker if a
                // free one of the same type exists), else any non-combat match.
                const idle = matches.find(u => u.type === 'worker' ? this.game.isIdleWorker(u) : !u.isMoving);
                return idle || matches[0];
            }
            // requested type isn't free → fall through to the automatic pick
        }

        const idleMilitary = ai.units.filter(u => u.type !== 'worker' && !this.isInCombat(u));
        const cav = idleMilitary.find(u => u.unitType === 'cavalry');
        if (cav) return cav;
        if (idleMilitary.length) return idleMilitary[0];

        const idleWorker = ai.units.find(u => u.type === 'worker' && this.game.isIdleWorker(u));
        if (idleWorker) return idleWorker;
        const freeWorker = ai.units.find(u => u.type === 'worker' && u.task !== 'building' && !u.isBuilding);
        if (freeWorker) return freeWorker;

        return ai.units.find(u => !this.isInCombat(u)) || ai.units.find(u => u.type !== 'worker') || null;
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
    }

    // Send a scout toward an UNEXPLORED frontier to reveal the map. This must NOT
    // peek at hidden resource positions — the AI doesn't know where undiscovered
    // nodes are. We fan out from the base in a new direction each call (golden-angle
    // sweep) with an expanding radius, so repeated scouting covers the whole map.
    dispatchScoutToward(ai, game, preferredType = null) {
        const center = this.getAIBuildingCenter(ai);
        const half = (game.terrain.size / 2) - 30;
        ai._scoutAngle = (ai._scoutAngle == null) ? 0 : ai._scoutAngle + 2.399963; // golden angle
        ai._scoutRadius = Math.min(half, (ai._scoutRadius || 45) + 30);
        // Clamp to solid ground so scouts never wander into the ocean.
        const { x: tx, z: tz } = game.clampToMap(
            center.x + Math.cos(ai._scoutAngle) * ai._scoutRadius,
            center.z + Math.sin(ai._scoutAngle) * ai._scoutRadius
        );

        const scout = this.pickScout(ai, preferredType);
        if (!scout) return `You have no unit free to scout — train a worker first.`;
        const eta = this.travelEtaSec(scout, tx, tz);
        const wasBusy = scout.type === 'worker' && !this.game.isIdleWorker(scout);
        const missedChoice = preferredType && !this.scoutMatchesChoice(scout, preferredType);
        this.releaseUnitForOrders(scout); // cleanly drop any harvest/farm/combat job
        scout.task = scout.type === 'worker' ? 'scouting' : null;
        scout.isMoving = true;
        scout.targetX = tx;
        scout.targetZ = tz;
        const choiceNote = missedChoice ? ` (no idle "${preferredType}" was free, so your ${scout.type} was used instead)` : '';
        return `Sent your ${scout.type} to explore toward (${Math.round(tx)}, ${Math.round(tz)}) (~${eta}s to arrive, revealing the map as it goes)${wasBusy ? ' — no worker was idle, so one was pulled off gathering' : ''}${choiceNote}.`;
    }

    executeHarvestResource(ai, game, resourceType) {
        resourceType = this.normalizeResourceType(resourceType);
        if (!resourceType) {
            return `[ERROR] harvest_resource needs a gatherable "resourceType": one of food, wood, stone, gold. (To construct a building, use build_structure instead.)`;
        }
        const discovered = this.discoveredNodesOfType(ai, game, resourceType);

        // Not scouted yet → nothing is harvested. Flag it as a failed action (so it
        // shows in the log and isn't counted as success) but auto-send a scout to
        // help, and tell the model exactly what to do next.
        if (discovered.length === 0) {
            const msg = this.dispatchScoutToward(ai, game);
            const have = this.discoveredResourceSummary(ai, game);
            return `[ERROR] No ${resourceType} has been discovered yet, so NOTHING was harvested. You have currently discovered: ${have}. Only resources in "resourcesOnMap" exist for you — don't assume a node is ${resourceType}. ${msg} It will appear in "resourcesOnMap" once a scout finds it — then call harvest_resource again. Spend the meantime on other useful work (don't keep re-issuing harvest).`;
        }

        const idleWorkers = ai.units.filter(u =>
            u.type === 'worker' && !u.isMoving && !u.isHarvesting && !u.carryingResource &&
            !u.isBuilding && u.task !== 'building' && !u.farmRef
        );
        if (idleWorkers.length === 0) {
            return `[ERROR] No idle workers to harvest ${resourceType}. Train a worker, or use assign_workers to pull one off its current task.`;
        }

        const worker = idleWorkers[0];
        const node = this.nearestNodeTo(worker, discovered);
        worker.task = 'harvesting';
        worker.harvestTarget = node;
        worker.isMoving = true;
        worker.targetX = node.x + (Math.random() - 0.5) * 2;
        worker.targetZ = node.z + (Math.random() - 0.5) * 2;
        worker.carryingResource = false;
        worker.harvestAmount = 0;
        return `OK - Sent worker to harvest ${resourceType} at (${Math.round(node.x)}, ${Math.round(node.z)}).`;
    }

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
    executeAssignWorkers(ai, game, params) {
        const resourceType = this.normalizeResourceType(params.resourceType);
        if (!resourceType) {
            return `[ERROR] assign_workers requires a gatherable "resourceType" (food|wood|stone|gold) — the new job for the workers. (To construct a building, use build_structure instead.)`;
        }
        const count = Math.max(1, Math.min(params.count || 3, 20));

        // Discovered nodes? If not, nothing is reassigned — flag it and auto-scout.
        const discovered = this.discoveredNodesOfType(ai, game, resourceType);
        if (discovered.length === 0) {
            const msg = this.dispatchScoutToward(ai, game);
            const have = this.discoveredResourceSummary(ai, game);
            return `[ERROR] No ${resourceType} has been discovered yet, so no workers were reassigned. You have currently discovered: ${have}. Only resources in "resourcesOnMap" exist for you — don't assume a node is ${resourceType}. ${msg} Once it appears in "resourcesOnMap", call assign_workers again. Don't keep re-issuing it meanwhile.`;
        }

        // Candidates: any worker that is not currently a builder, preferring those
        // NOT already harvesting this resource type.
        const candidates = ai.units.filter(u => u.type === 'worker' && u.task !== 'building' && !u.isBuilding);
        if (candidates.length === 0) {
            return `[ERROR] You have no workers to reassign. Train workers first.`;
        }
        candidates.sort((a, b) => {
            const aOn = (a.harvestTarget && a.harvestTarget.type === resourceType) ? 1 : 0;
            const bOn = (b.harvestTarget && b.harvestTarget.type === resourceType) ? 1 : 0;
            return aOn - bOn;
        });

        let moved = 0;
        for (const w of candidates) {
            if (moved >= count) break;
            if (w.farmRef && w.farmRef.assignedWorker === w) w.farmRef.assignedWorker = null;
            w.farmRef = null;
            w._formerTask = null;
            const node = this.nearestNodeTo(w, discovered);
            w.task = 'harvesting';
            w.harvestTarget = node;
            w.buildTarget = null;
            w.isMoving = true;
            w.targetX = node.x + (Math.random() - 0.5) * 2;
            w.targetZ = node.z + (Math.random() - 0.5) * 2;
            w.isHarvesting = false;
            w.carryingResource = false;
            w.harvestAmount = 0;
            moved++;
        }
        return `OK - Reassigned ${moved} worker(s) to harvest ${resourceType}.`;
    }

    executeExplore(ai, game, params) {
        // Optional: the model may name a unit to scout with (id like "scout_cavalry"
        // or category like "cavalry"/"worker"); omit it to auto-pick the best scout.
        const preferredType = params.unitType ? String(params.unitType).trim() : null;

        // Did the model attempt to specify a target at all?
        const gaveX = params.targetX !== undefined && params.targetX !== null && params.targetX !== '';
        const gaveZ = params.targetZ !== undefined && params.targetZ !== null && params.targetZ !== '';

        if (gaveX || gaveZ) {
            // A target was attempted — it must be BOTH coords and numeric, otherwise
            // tell the model exactly what went wrong instead of silently mis-scouting
            // or sending the scout to NaN (which strands it).
            const tx0 = Number(params.targetX);
            const tz0 = Number(params.targetZ);
            if (!gaveX || !gaveZ || !Number.isFinite(tx0) || !Number.isFinite(tz0)) {
                return `[ERROR] explore needs BOTH numeric "targetX" and "targetZ" (map coordinates inside map.bounds), or omit both to auto-scout the nearest unexplored frontier. Got targetX=${JSON.stringify(params.targetX)}, targetZ=${JSON.stringify(params.targetZ)}.`;
            }

            const scout = this.pickScout(ai, preferredType);
            if (!scout) return `[ERROR] No unit available to explore. Train a worker first.`;
            const wasBusy = scout.type === 'worker' && !this.game.isIdleWorker(scout);
            const missedChoice = preferredType && !this.scoutMatchesChoice(scout, preferredType);

            // Clamp the target so the scout stays on land (no wandering into the ocean).
            const { x: tx, z: tz } = game.clampToMap(tx0, tz0);
            const eta = this.travelEtaSec(scout, tx, tz);
            this.releaseUnitForOrders(scout); // cleanly drop any harvest/farm/combat job
            scout.task = scout.type === 'worker' ? 'scouting' : null;
            scout.isMoving = true;
            scout.targetX = tx;
            scout.targetZ = tz;

            const clamped = Math.round(tx) !== Math.round(tx0) || Math.round(tz) !== Math.round(tz0);
            const pulled = wasBusy ? ' (no worker was idle, so one was pulled off gathering — reassign it to a resource once scouting is done)' : '';
            const choiceNote = missedChoice ? ` (no idle "${preferredType}" was free, so your ${scout.type} was used instead)` : '';
            return `OK - Sent your ${scout.type} to explore (${Math.round(tx)}, ${Math.round(tz)})${clamped ? ' — your target was outside the map and was clamped to the edge' : ''}. It will take ~${eta}s to get there; let it travel before exploring again.${pulled}${choiceNote}`;
        }

        // No target → fan out toward the nearest unexplored frontier.
        const msg = this.dispatchScoutToward(ai, game, preferredType);
        return msg.startsWith('You have no') ? `[ERROR] ${msg}` : `OK - ${msg}`;
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
        return `OK - Deleted ${what}, freeing population.`;
    }

    executeDestroyBuilding(ai, game, buildingType, targetX, targetZ) {
        let pool = ai.buildings.filter(b => b.type === buildingType);
        if (pool.length === 0) return `[ERROR] You have no "${buildingType}" to destroy.`;
        let victim = pool[0];
        if (targetX !== undefined && targetZ !== undefined) {
            let bd = Infinity;
            pool.forEach(b => { const d = Math.hypot(b.x - targetX, b.z - targetZ); if (d < bd) { bd = d; victim = b; } });
        }
        const wasTC = victim.type === 'town_center';
        const remainingTC = ai.buildings.filter(b => b.type === 'town_center').length;
        if (wasTC && remainingTC <= 1) {
            return `[ERROR] Refusing to destroy your last Town Center — that would eliminate you.`;
        }
        game.destroyOwnBuilding(victim);
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

    // Shared guidance appended to attack errors so the model's next step is
    // always actionable: scout first if nothing is known, otherwise pick a real
    // target from the discovered lists.
    attackTargetHint(ai, game) {
        return this.hasVisibleEnemies(ai, game)
            ? 'Use "enemyUnits" or "enemyBuildings" from game state to find valid targets.'
            : 'No enemies have been discovered yet. Send a unit to explore/scout the map before attacking.';
    }

    // ----------------------------------------------------------------
    // 13. Independent per-model update loop
    //     Every controller runs its OWN pipeline: it fires its next request
    //     as soon as its previous one returns (plus a small breather), fully
    //     concurrent with the others. No global turn order and no concurrency
    //     cap — so a faster model genuinely takes more turns. That speed is a
    //     real, intended advantage when comparing models.
    // ----------------------------------------------------------------
    async update(deltaTime) {
        if (this.aiControllers.length === 0) return;
        const now = Date.now();

        // Continuously record what each model has discovered. Discovery used to be
        // sampled only at a model's own turn, but the fog reveals as units MOVE — so
        // a scout could sweep past a node (revealing it on the map) and move on
        // between turns, leaving the model thinking it never found it. Scan a few
        // times a second so "seen on the map" always equals "known to the model".
        this.updateResourceDiscovery(now);

        for (const controller of this.aiControllers) {
            if (controller.paused) continue;                                  // spectator paused it
            if (controller.pending) continue;                                 // own pipeline busy
            if (now - controller.lastTurnTime < this.turnInterval) continue;  // small breather
            this.startTurn(controller, now);
        }
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
        controller.lastTurnTime = now;
        controller.turnCount++;
        controller.pending = true;

        console.log(`[OpenAIAI] Turn #${controller.turnCount} for ${controller.id} (${controller.aiPlayer.civilization})`);

        const gameState = this.buildGameStateJSON(controller);

        const promise = this.sendToOpenAI(controller, gameState)
            .then(actionData => {
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


