// UI Manager for game menus and interfaces
class UIManager {
    constructor(game) {
        this.game = game;
        this.activeMenu = null;
        // Bump when getArenaDefaultPrompt() changes so stale saved prompts are dropped.
        this.ARENA_PROMPT_VERSION = 'win-v8';
    }

    showScreen(screenId) {
        document.querySelectorAll('.screen').forEach(screen => {
            screen.classList.remove('active');
        });
        document.getElementById(screenId).classList.add('active');
    }

    // Called by setUiLang() after static [data-i18n] elements are re-translated.
    // Re-render the dynamic (JS-built) content that data-i18n can't reach.
    onLanguageChanged() {
        // Re-open the currently active action menu so its labels refresh.
        const am = this.activeMenu;
        if (am === 'build') this.showBuildMenu();
        else if (am === 'train') this.showTrainMenu();
        else if (am === 'research') this.showResearchMenu();
        else if (am === 'upgrade') this.showUpgradeMenu();

        const active = (id) => { const el = document.getElementById(id); return el && el.classList.contains('active'); };
        if (this._arenaConfig && active('modelLibraryScreen')) this.renderArenaLibrary();
        if (this._arenaConfig && active('arenaSetupScreen')) { this.renderArenaSlots(); this.updateLibrarySummary(); }

        // Refresh live HUD bits immediately (they also refresh each tick).
        try {
            if (this.game && this.game.player) {
                this.updateResources(this.game.player.resources);
                this.updateAge(this.game.player.age);
            }
        } catch (e) {}
        // Force the spectator panels to rebuild on next update.
        this._lastLogSig = null;
    }

    // Reusable confirmation dialog. Calls onConfirm() if the user confirms.
    showConfirm(message, onConfirm, opts = {}) {
        const old = document.getElementById('confirmOverlay');
        if (old) old.remove();

        const overlay = document.createElement('div');
        overlay.id = 'confirmOverlay';
        overlay.className = 'confirm-overlay';
        overlay.innerHTML = `
            <div class="confirm-dialog" role="dialog" aria-modal="true">
                <h3 class="confirm-title">${opts.title || t('dlg.quitTitle')}</h3>
                <p class="confirm-message">${message}</p>
                <div class="confirm-actions">
                    <button class="menu-btn confirm-cancel">${opts.cancelLabel || t('dlg.keepPlaying')}</button>
                    <button class="menu-btn confirm-ok">${opts.confirmLabel || t('dlg.quitConfirm')}</button>
                </div>
            </div>`;
        document.body.appendChild(overlay);

        const close = () => {
            document.removeEventListener('keydown', onKey);
            overlay.remove();
        };
        const onKey = (e) => {
            if (e.key === 'Escape') close();
            else if (e.key === 'Enter') { close(); if (onConfirm) onConfirm(); }
        };
        document.addEventListener('keydown', onKey);
        overlay.querySelector('.confirm-cancel').onclick = close;
        overlay.querySelector('.confirm-ok').onclick = () => { close(); if (onConfirm) onConfirm(); };
        // Click on the dimmed backdrop cancels.
        overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
    }

    showStartScreen() {
        this.showScreen('startScreen');
    }

    showCampaignSelection() {
        this.showScreen('civilizationScreen');
    }

    showGameModeSelection() {
        this.showScreen('gameModeScreen');
    }

    showArenaSetup() {
        this.showScreen('arenaSetupScreen');
        this.populateArenaSetup();
    }

    // Build the Arena setup screen from the saved model-library config.
    // Config is kept in memory so navigating to/from the library page preserves edits.
    async populateArenaSetup() {
        if (!this._arenaConfig) this._arenaConfig = await this.loadArenaConfig();
        this.renderArenaSlots();
        this.updateLibrarySummary();
        const ta = document.getElementById('arenaSharedPrompt');
        if (ta) ta.value = this._arenaConfig.prompt || this.getArenaDefaultPrompt();
    }

    // Open the dedicated model-library page.
    async showModelLibrary() {
        if (!this._arenaConfig) this._arenaConfig = await this.loadArenaConfig();
        this.showScreen('modelLibraryScreen');
        this.renderArenaLibrary();
    }

    // Reflect the model count on the arena setup screen's library summary.
    updateLibrarySummary() {
        const el = document.getElementById('libSummaryCount');
        if (!el || !this._arenaConfig) return;
        const n = this._arenaConfig.models.length;
        el.textContent = t('ar.libCount', { n });
    }

    // Get default system prompt for Arena players
    getArenaDefaultPrompt() {
        return `You ARE {{civilization}}, a commander in the real-time strategy game "LLM Colosseum". Three rival civilizations share this map with you and every one of them is your enemy. This is a contest with a single winner. There is no human to assist or advise — YOU are playing, and you are playing to win.

## YOUR OBJECTIVE: WIN THE GAME
You win in one of exactly two ways:
1. Destroy the Town Centers of ALL rival civilizations, or
2. Reach the Iron age, then build_wonder and hold it for the required time (gameStats.wonderRequired seconds) without it being destroyed.
Economy, technology and population are only MEANS to that end. A civilization that endlessly optimizes its economy but never raises an army and never attacks will NOT win. You must convert your economy into military power and go finish your enemies.

## DEFEND when attacked, and treat any WONDER as an emergency
- "threats.underAttack" lists your buildings/units taking fire RIGHT NOW. Defend at once: attack_target the attacker's position (attackerAt) with your army. If you have none, that is an emergency — your idle units will auto-defend, but build an army immediately.
- "threats.enemyWonders" lists rival Wonders — ALWAYS visible, even through fog, because a finished one WINS for that rival in "secondsUntilEnemyWins" seconds. This is existential: send your whole army to attack_target the Wonder's position and raze it (infantry raze best). When YOU hold a Wonder, keep an army home — everyone will rush it.

## Your civilization
You play {{civilization}}. Unique bonus: {{bonus}}. Play to this strength.

## How a turn works
Each turn you receive the current game state as JSON and you issue EXACTLY ONE command for your own civilization. Pick the single action that most advances you toward victory right now — not generic advice, an actual order.

## Path to victory (don't get stuck in the early phases)
1. OPEN: train a couple of workers and send them to harvest food and wood. Research and build a house early so your population cap doesn't choke you.
2. GROW: build farms for steady food, keep every worker busy, and advance the epoch (stone -> neolithic -> bronze -> iron) to unlock stronger units and technology.
3. MILITARIZE: research and build a barracks, then train military units (militia, archer, scout_cavalry). Once your economy is stable, STOP pouring everything into economy and start producing an army.
4. ATTACK: send your army at the weakest rival, destroy their units and their Town Center, then move on to the next. Keep up the pressure until every rival is gone — or instead commit to a Wonder and defend it. ALWAYS break off to defend home when "threats.underAttack" fires, and to raze any rival's Wonder.
If you already have an economy and no army, your next move should be military. If you already have an army, use it to attack.

## Army counters (composition matters)
- Cavalry beats ranged (archers). Ranged beats infantry. Infantry beats cavalry. (rock-paper-scissors)
- Infantry are best at razing buildings; archers are poor against buildings.
Scout the enemy's units (in enemyUnits) and train the type that counters theirs.

## Resources
Food (deer, berries, farms) - workers and many units. Wood (trees) - buildings. Stone (quarries) - advanced buildings and defenses. Gold (mines) - advanced military.

## The map is hidden — SCOUT IT
The map starts dark. Resources and enemies are HIDDEN until one of your units reveals them. "resourcesOnMap" lists only what you have already discovered (it is remembered after you look away). To find more food/wood/stone/gold or to locate the enemy, send a scout with the explore action (or move a unit into the dark). If you harvest_resource a type you have not discovered yet, a worker is sent to scout it automatically — try again once it shows up in "resourcesOnMap".

## Mechanics you MUST respect
- Your civilization can only build what is listed in "buildableStructures". Some civilizations have no stable (no cavalry). If "stable" is not listed, do NOT keep trying to build it — win with infantry (barracks) and archers (archery_range).
- Research a building's tech BEFORE you can build it. If a type is not in "unlockedContent.buildings", research_tech it first (e.g. research_tech("barracks") then build_structure("barracks")).
- Never research a tech already listed in "research.researched" (it wastes the turn). You can research only ONE tech at a time ("research.current").
- Newly trained workers are IDLE until you command them: use harvest_resource (or assign_workers to move busy workers onto a new job).
- You cannot exceed your population cap. Build houses when "resources.populationFree" is low; delete_unit can free population if you are stuck at the cap.
- Only attempt actions you can afford (check "resources").

## Available actions (choose ONE per turn)
- train_worker: train a worker at your Town Center.
- train_unit: params.unitType = "militia" | "archer" | "scout_cavalry" (needs the right building).
- research_tech: params.techId = an exact id from "research.available".
- upgrade_age: advance to the next epoch.
- build_structure: params.buildingType = "house" | "farm" | "barracks" | "stable" | "archery_range" | "market" | "tower" (must be researched first; must be in buildableStructures).
- build_wonder: start your civilization's Wonder (requires the Iron age). Hold it (gameStats.wonderRequired s) after it finishes to WIN — rivals will rush to raze it, so defend it.
- harvest_resource: params.resourceType = "food" | "wood" | "stone" | "gold" (sends an idle worker; auto-scouts if undiscovered).
- assign_workers: params.resourceType (+ optional count) - pull workers off their current task onto gathering that resource.
- explore: params.targetX, params.targetZ (or none) - send a scout to reveal hidden map, resources and enemies.
- move_units: params.targetX, params.targetZ (reposition your army).
- attack_target: params.targetX, params.targetZ (or params.targetId) - your army marches there and engages any enemy it meets, pursuing them even as they move. This is how you destroy enemies and win.
- delete_unit: params.unitType (+ optional count) - remove your own units to free population.
- destroy_building: params.buildingType (+ optional targetX/targetZ) - demolish one of your own buildings (never your last Town Center).
- wait: only if there is genuinely nothing useful to do.

## Construction takes time
Buildings are NOT instant. build_structure places a construction SITE and pulls one of your workers to build it over several seconds; it cannot train, research or give population until it is finished. In your state a building shows "state":"under_construction" with a "buildPct" until it becomes "complete". Don't re-order the same building while a site is still going up.

## Response format
Respond with ONLY a single JSON object - no markdown, no code fences, no commentary:
{"action": "<action>", "params": { ...action params..., "reason": "<how this moves you toward winning>" }}`;
    }

    // Legacy no-op kept so the (now-hidden) old grid's inline handlers never throw.
    updateArenaPlayerFields() {}

    // ----------------------------------------------------------------
    // Arena model-library config
    // ----------------------------------------------------------------
    nextArenaModelId() { this._arenaModelSeq = (this._arenaModelSeq || 0) + 1; return this._arenaModelSeq; }

    makeArenaModel(opts = {}) {
        return {
            id: this.nextArenaModelId(),
            name: opts.name || '',
            endpoint: opts.endpoint || '',
            model: opts.model || '',
            provider: opts.provider || 'auto', // auto | openai | anthropic | ollama | google
            maxTokens: opts.maxTokens || '',   // '' = use the default (2000)
            contextSize: opts.contextSize || '', // Ollama only: num_ctx. '' = default (32768)
            language: opts.language || 'en',   // language the model reasons/answers in (independent of GUI)
            availableModels: [],
            _status: null,
            _expanded: false,
            auth: { type: 'none', key: '', username: '', password: '', headers: [], accessToken: '', tokenUrl: '', clientId: '', clientSecret: '', scope: '' }
        };
    }

    normalizeArenaModel(m) {
        const def = this.makeArenaModel();
        m.availableModels = Array.isArray(m.availableModels) ? m.availableModels : [];
        m.provider = m.provider || 'auto';
        m.language = (m.language && I18N[m.language]) ? m.language : 'en';
        // Older configs baked the auto "Unnamed model N" into the stored name in
        // whatever language was active. Strip those so the name is shown live in the
        // current GUI language (custom user names are kept).
        if (typeof m.name === 'string' && m.name.trim()) {
            const prefixes = Object.keys(I18N).map(l => I18N[l] && I18N[l]['ar.unnamed']).filter(Boolean);
            const baked = prefixes.some(p => new RegExp('^' + p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\d*$').test(m.name.trim()));
            if (baked) m.name = '';
        }
        if (m.maxTokens == null) m.maxTokens = '';
        if (m.contextSize == null) m.contextSize = '';
        m.auth = Object.assign({}, def.auth, m.auth || {});
        if (!Array.isArray(m.auth.headers)) m.auth.headers = [];
        // Runtime-only fields must never be restored from storage: a connection's
        // test result (the green ✓ / red ✗ badge) is meaningless across reloads, so
        // always start with a clean, untested status.
        m._status = null;
        m._expanded = false; // always start collapsed for a clean overview
        return m;
    }

    async loadArenaConfig() {
        this._arenaModelSeq = 0;
        let cfg = null;
        try {
            const s = localStorage.getItem('arenaConfigV2');
            if (s) cfg = JSON.parse(s);
        } catch (e) {}

        if (!cfg || !Array.isArray(cfg.models)) {
            // First run: seed the library from models.json endpoints if available.
            const endpoints = [];
            try {
                const resp = await fetch('models.json');
                const data = await resp.json();
                (data.models?.OpenAIEndpoint || []).forEach(u => { if (u) endpoints.push(u); });
            } catch (e) {}
            // Leave names empty — the UI shows a live translated "Unnamed model N".
            const models = endpoints.map((u) => this.makeArenaModel({ endpoint: u }));
            if (models.length === 0) models.push(this.makeArenaModel({}));
            cfg = {
                models,
                slots: ['egyptian', 'greek', 'persian', 'yamato'].map((civ, i) => ({ civ, control: models[i] ? models[i].id : 'ki' })),
                prompt: this.getArenaDefaultPrompt()
            };
        } else {
            // Re-key ids deterministically and normalize.
            cfg.models.forEach(m => { m.id = this.nextArenaModelId(); this.normalizeArenaModel(m); });
        }

        // Drop a prompt saved under an older version.
        if (localStorage.getItem('arenaPromptVersion') !== this.ARENA_PROMPT_VERSION || !cfg.prompt) {
            cfg.prompt = this.getArenaDefaultPrompt();
        }

        // Always exactly 4 slots; remap controls onto valid model ids.
        const civs = ['egyptian', 'greek', 'persian', 'yamato'];
        const ids = cfg.models.map(m => m.id);
        if (!Array.isArray(cfg.slots) || cfg.slots.length !== 4) {
            cfg.slots = civs.map((civ, i) => ({ civ, control: cfg.models[i] ? cfg.models[i].id : 'ki', prompt: cfg.prompt }));
        } else {
            cfg.slots.forEach((s, i) => {
                if (!s.civ) s.civ = civs[i];
                // saved control ids no longer match the re-keyed ids → map by position
                if (s.control !== 'ki' && !ids.includes(s.control)) {
                    s.control = cfg.models[i] ? cfg.models[i].id : 'ki';
                }
                // each slot carries its OWN system prompt (defaults to the template)
                if (typeof s.prompt !== 'string' || !s.prompt.trim()) s.prompt = cfg.prompt;
            });
        }
        return cfg;
    }

    // A clean, serialisable copy of the catalogue (drops runtime-only fields like
    // cached tokens, test status and expand state). Real secrets ARE kept.
    serializeArenaConfig() {
        const clone = JSON.parse(JSON.stringify(this._arenaConfig));
        clone.models.forEach(m => { if (m.auth) { delete m.auth._token; delete m.auth._tokenExp; } m._status = null; delete m._expanded; });
        return clone;
    }

    saveArenaConfig() {
        if (!this._arenaConfig) return;
        try {
            localStorage.setItem('arenaConfigV2', JSON.stringify(this.serializeArenaConfig()));
            localStorage.setItem('arenaPromptVersion', this.ARENA_PROMPT_VERSION);
        } catch (e) {}
    }

    // True if any model carries a secret (key/password/token/client secret/header value).
    configHasSecrets() {
        const models = (this._arenaConfig && this._arenaConfig.models) || [];
        return models.some(m => {
            const a = m.auth || {};
            if ((a.key || a.password || a.accessToken || a.clientSecret || '').trim && (a.key || a.password || a.accessToken || a.clientSecret || '').trim()) return true;
            return Array.isArray(a.headers) && a.headers.some(h => h && (h.value || '').trim());
        });
    }

    // Export the whole catalogue (models + slots + prompt) to a downloaded JSON
    // file. The file contains API keys/passwords in plain text, so we warn first.
    exportModelCatalog() {
        if (!this._arenaConfig) return;
        const doExport = () => this._downloadCatalog();
        if (this.configHasSecrets()) {
            this.showConfirm(
                t('dlg.exportSecretsBody'),
                doExport,
                { title: t('dlg.exportTitle'), confirmLabel: t('dlg.exportConfirm'), cancelLabel: t('dlg.cancel') }
            );
        } else {
            doExport();
        }
    }

    _downloadCatalog() {
        try {
            const payload = Object.assign({ app: 'LLM Colosseum', kind: 'model-catalog', version: 2 }, this.serializeArenaConfig());
            const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'llm-colosseum-models.json';
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            this.showInfoMessage(t('ar.exportDone'));
        } catch (e) {
            this.showErrorMessage(t('ar.exportFailed'));
        }
    }

    // Open a file picker and load a catalogue JSON, replacing the current one.
    importModelCatalog() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'application/json,.json';
        input.onchange = () => {
            const file = input.files && input.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = () => this._applyImportedCatalog(reader.result);
            reader.onerror = () => this.showErrorMessage(t('ar.importFailed'));
            reader.readAsText(file);
        };
        input.click();
    }

    _applyImportedCatalog(text) {
        let data;
        try { data = JSON.parse(text); } catch (e) { this.showErrorMessage(t('ar.importFailed')); return; }
        if (!data || !Array.isArray(data.models)) { this.showErrorMessage(t('ar.importInvalid')); return; }

        const apply = () => {
            // Re-key ids and normalise the imported models, then rebuild a valid config.
            this._arenaModelSeq = 0;
            const cfg = { models: data.models, slots: data.slots, prompt: data.prompt };
            cfg.models.forEach(m => { m.id = this.nextArenaModelId(); this.normalizeArenaModel(m); });
            if (typeof cfg.prompt !== 'string' || !cfg.prompt.trim()) cfg.prompt = this.getArenaDefaultPrompt();
            const civs = ['egyptian', 'greek', 'persian', 'yamato'];
            const ids = cfg.models.map(m => m.id);
            if (!Array.isArray(cfg.slots) || cfg.slots.length !== 4) {
                cfg.slots = civs.map((civ, i) => ({ civ, control: cfg.models[i] ? cfg.models[i].id : 'ki', prompt: cfg.prompt }));
            } else {
                cfg.slots.forEach((s, i) => {
                    if (!s.civ) s.civ = civs[i];
                    if (s.control !== 'ki' && !ids.includes(s.control)) s.control = cfg.models[i] ? cfg.models[i].id : 'ki';
                    if (typeof s.prompt !== 'string' || !s.prompt.trim()) s.prompt = cfg.prompt;
                });
            }
            this._arenaConfig = cfg;
            this.saveArenaConfig();
            this.renderArenaLibrary();
            this.renderArenaSlots();
            this.updateLibrarySummary();
            this.showInfoMessage(t('ar.importDone', { n: cfg.models.length }));
        };

        // Importing replaces the existing catalogue — confirm if there's anything to lose.
        const existing = (this._arenaConfig && this._arenaConfig.models) || [];
        if (existing.length) {
            this.showConfirm(
                t('dlg.importBody', { n: data.models.length }),
                apply,
                { title: t('dlg.importTitle'), confirmLabel: t('dlg.importConfirm'), cancelLabel: t('dlg.cancel') }
            );
        } else {
            apply();
        }
    }

    getArenaModel(id) { return (this._arenaConfig?.models || []).find(m => m.id === id); }

    // --- Rendering ---
    renderArenaLibrary() {
        const list = document.getElementById('modelLibraryList');
        if (!list) return;
        const models = this._arenaConfig.models;
        list.innerHTML = models.length
            ? models.map((m, i) => this.renderModelCard(m, i + 1)).join('')
            : `<p class="lib-empty">${t('ar.libEmpty')}</p>`;
    }

    renderModelCard(m, n) {
        const e = (s) => this.escapeHtml(s == null ? '' : String(s));
        // Default (unnamed) models show a LIVE translated fallback, never a baked-in
        // name, so the label follows the current GUI language.
        const displayName = (m.name && m.name.trim()) ? m.name : `${t('ar.unnamed')} ${n || m.id}`;
        const sel = (v) => m.auth.type === v ? 'selected' : '';
        const status = m._status ? `<span class="test-status ${m._status.cls}" id="modelStatus-${m.id}">${e(m._status.text)}</span>`
                                 : `<span class="test-status" id="modelStatus-${m.id}"></span>`;
        let modelOpts = `<option value="">${t('ar.modelLoadHint')}</option>`;
        if (m.availableModels.length) {
            modelOpts = m.availableModels.map(id => `<option value="${e(id)}" ${m.model === id ? 'selected' : ''}>${e(id)}</option>`).join('');
            if (m.model && !m.availableModels.includes(m.model)) modelOpts += `<option value="${e(m.model)}" selected>${e(m.model)} (manual)</option>`;
        }
        const langOpts = (window.I18N_LANGS || []).map(l => `<option value="${l.code}" ${(m.language || 'en') === l.code ? 'selected' : ''}>${e((window.I18N_MODEL_LANG_NAME || {})[l.code] || l.label)}</option>`).join('');
        const expanded = !!m._expanded;
        const badge = m._status ? `<span class="mc-status ${m._status.cls}" title="${e(m._status.text)}">${m._status.cls === 'ok' ? '✓' : (m._status.cls === 'err' ? '✗' : '⏳')}</span>` : '';
        const authLabels = { none: t('ar.authNone'), bearer: 'API key', header: 'Header', basic: 'Basic', oauth: 'OAuth2' };
        const provLabels = { auto: t('ar.provAuto'), openai: 'OpenAI', anthropic: 'Anthropic', ollama: 'Ollama', google: 'Google' };
        const provPlaceholders = {
            auto: 'https://api.example.com/v1',
            openai: 'https://api.openai.com/v1',
            anthropic: 'https://api.anthropic.com/v1',
            ollama: 'http://localhost:11434',
            google: 'https://generativelanguage.googleapis.com/v1beta'
        };
        const provSel = (v) => (m.provider || 'auto') === v ? 'selected' : '';
        // Show Ollama-specific server advice when this model talks to Ollama.
        const isOllama = (typeof OpenAIAIManager !== 'undefined') && OpenAIAIManager.resolveProvider(m) === 'ollama';
        const epPlaceholder = provPlaceholders[m.provider || 'auto'] || provPlaceholders.auto;
        const sub = e(m.model || m.endpoint || t('ar.notConfigured'));
        return `
        <div class="model-card ${expanded ? 'expanded' : 'collapsed'}">
            <div class="model-card-header" onclick="game.ui.toggleArenaModel(${m.id})">
                <span class="mc-toggle">▶</span>
                <span class="mc-name">${e(displayName)}</span>
                <span class="mc-sub">${sub}</span>
                <span class="mc-auth">${provLabels[m.provider || 'auto']}</span>
                <span class="mc-auth">${authLabels[m.auth.type] || ''}</span>
                ${badge}
                <button class="model-remove" title="${t('ar.removeModel')}" onclick="event.stopPropagation(); game.ui.removeArenaModel(${m.id})">✕</button>
            </div>
            <div class="model-card-body">
            <div class="model-card-top">
                <div class="arena-field"><label>${t('ar.fName')}</label>
                    <input type="text" value="${e(m.name)}" oninput="game.ui.setModelField(${m.id},'name',this.value)" placeholder="${t('ar.fNamePh')}"></div>
                <div class="arena-field" style="flex:2"><label>${t('ar.fEndpoint')}</label>
                    <input type="text" value="${e(m.endpoint)}" oninput="game.ui.setModelField(${m.id},'endpoint',this.value)" placeholder="${epPlaceholder}"></div>
            </div>
            <div class="arena-field"><label>${t('ar.fProvider')}</label>
                <select onchange="game.ui.setModelProvider(${m.id}, this.value)">
                    <option value="auto" ${provSel('auto')}>${t('ar.provAuto')}</option>
                    <option value="openai" ${provSel('openai')}>OpenAI-compatible (OpenAI, vLLM, LM Studio, LiteLLM, Groq, OpenRouter …)</option>
                    <option value="anthropic" ${provSel('anthropic')}>Anthropic (Claude)</option>
                    <option value="ollama" ${provSel('ollama')}>Ollama</option>
                    <option value="google" ${provSel('google')}>Google (Gemini)</option>
                </select>
            </div>
            <div class="arena-field"><label>${t('ar.fAuth')}</label>
                <select onchange="game.ui.setAuthType(${m.id}, this.value)">
                    <option value="none" ${sel('none')}>${t('ar.authNone')}</option>
                    <option value="bearer" ${sel('bearer')}>${t('ar.authBearer')}</option>
                    <option value="header" ${sel('header')}>${t('ar.authHeader')}</option>
                    <option value="basic" ${sel('basic')}>${t('ar.authBasic')}</option>
                    <option value="oauth" ${sel('oauth')}>${t('ar.authOauth')}</option>
                </select>
            </div>
            ${this.renderAuthFields(m)}
            <div class="model-test-row">
                <button class="test-btn" onclick="game.ui.testArenaModel(${m.id})">${t('ar.test')}</button>
                ${status}
            </div>
            <div class="model-select-row">
                <div class="arena-field"><label>${t('ar.fModelSelect')}</label>
                    <select onchange="game.ui.chooseArenaModel(${m.id}, this.value)">${modelOpts}</select></div>
                <div class="arena-field"><label>${t('ar.fModelManual')}</label>
                    <input type="text" value="${e(m.model)}" oninput="game.ui.setModelField(${m.id},'model',this.value)" placeholder="model-id"></div>
                <div class="arena-field" style="flex:0 0 150px"><label>${t('ar.fMaxTokens')}</label>
                    <input type="number" min="64" step="64" value="${e(m.maxTokens)}" oninput="game.ui.setModelField(${m.id},'maxTokens',this.value)" placeholder="2000"></div>
                ${isOllama ? `<div class="arena-field" style="flex:0 0 160px"><label>${t('ar.fContextSize')}</label>
                    <input type="number" min="512" step="512" value="${e(m.contextSize)}" oninput="game.ui.setModelField(${m.id},'contextSize',this.value)" placeholder="32768"></div>` : ''}
                <div class="arena-field" style="flex:0 0 170px"><label>${t('ar.fModelLang')}</label>
                    <select onchange="game.ui.setModelField(${m.id},'language',this.value)">${langOpts}</select></div>
            </div>
            <p class="auth-hint">${t('ar.maxTokensHint')}</p>
            ${isOllama ? `<p class="auth-hint">${t('ar.contextSizeHint')}</p>` : ''}
            <p class="auth-hint">${t('ar.modelLangHint')}</p>
            ${isOllama ? `<p class="auth-hint ollama-hint">${t('ar.ollamaHint')}</p>` : ''}
            </div>
        </div>`;
    }

    renderAuthFields(m) {
        const e = (s) => this.escapeHtml(s == null ? '' : String(s));
        const a = m.auth;
        if (a.type === 'none') return `<p class="auth-hint">${t('ar.authNoneHint')}</p>`;
        if (a.type === 'bearer') {
            return `<div class="arena-field"><label>${t('ar.fKey')}</label>
                <input type="password" autocomplete="off" value="${e(a.key)}" oninput="game.ui.setAuthField(${m.id},'key',this.value)" placeholder="sk-…"></div>`;
        }
        if (a.type === 'basic') {
            return `<div class="auth-grid">
                <div class="arena-field"><label>${t('ar.fUser')}</label>
                    <input type="text" value="${e(a.username)}" oninput="game.ui.setAuthField(${m.id},'username',this.value)"></div>
                <div class="arena-field"><label>${t('ar.fPass')}</label>
                    <input type="password" autocomplete="off" value="${e(a.password)}" oninput="game.ui.setAuthField(${m.id},'password',this.value)"></div>
            </div>`;
        }
        if (a.type === 'header') {
            const rows = (a.headers.length ? a.headers : [{ name: '', value: '' }]).map((h, idx) => `
                <div class="header-row">
                    <input type="text" value="${e(h.name)}" oninput="game.ui.setAuthHeaderField(${m.id},${idx},'name',this.value)" placeholder="${t('ar.fHeaderName')}">
                    <input type="password" autocomplete="off" value="${e(h.value)}" oninput="game.ui.setAuthHeaderField(${m.id},${idx},'value',this.value)" placeholder="${t('ar.fHeaderVal')}">
                    <button class="hr-del" title="${t('ar.removeModel')}" onclick="game.ui.removeAuthHeader(${m.id},${idx})">✕</button>
                </div>`).join('');
            return `<div class="arena-field"><label>${t('ar.fHeaders')}</label>
                <div class="header-rows">${rows}</div>
                <button class="hdr-add-btn" onclick="game.ui.addAuthHeader(${m.id})" style="margin-top:8px">${t('ar.addHeader')}</button>
            </div>`;
        }
        if (a.type === 'oauth') {
            return `<div class="auth-grid">
                <div class="arena-field full"><label>${t('ar.fToken')}</label>
                    <input type="password" autocomplete="off" value="${e(a.accessToken)}" oninput="game.ui.setAuthField(${m.id},'accessToken',this.value)" placeholder="${t('ar.fTokenPh')}"></div>
                <div class="auth-divider">${t('ar.oauthOr')}</div>
                <div class="arena-field full"><label>${t('ar.fTokenUrl')}</label>
                    <input type="text" value="${e(a.tokenUrl)}" oninput="game.ui.setAuthField(${m.id},'tokenUrl',this.value)" placeholder="https://auth.example.com/oauth/token"></div>
                <div class="arena-field"><label>${t('ar.fClientId')}</label>
                    <input type="text" value="${e(a.clientId)}" oninput="game.ui.setAuthField(${m.id},'clientId',this.value)"></div>
                <div class="arena-field"><label>${t('ar.fClientSecret')}</label>
                    <input type="password" autocomplete="off" value="${e(a.clientSecret)}" oninput="game.ui.setAuthField(${m.id},'clientSecret',this.value)"></div>
                <div class="arena-field full"><label>${t('ar.fScope')}</label>
                    <input type="text" value="${e(a.scope)}" oninput="game.ui.setAuthField(${m.id},'scope',this.value)"></div>
            </div>`;
        }
        return '';
    }

    renderArenaSlots() {
        const list = document.getElementById('arenaSlotsList');
        if (!list) return;
        const civNames = { egyptian: t('civ.egyptian.name'), greek: t('civ.greek.name'), persian: t('civ.persian.name'), yamato: t('civ.yamato.name') };
        const civColor = { egyptian: '#ffd700', greek: '#4ecca3', persian: '#e94560', yamato: '#9b8cff' };
        const e = (s) => this.escapeHtml(s == null ? '' : String(s));
        const models = this._arenaConfig.models;
        list.innerHTML = this._arenaConfig.slots.map((slot, i) => {
            const civOpts = Object.keys(civNames).map(c => `<option value="${c}" ${slot.civ === c ? 'selected' : ''}>${civNames[c]}</option>`).join('');
            const modelOpts = models.map((mm, mi) => `<option value="${mm.id}" ${slot.control === mm.id ? 'selected' : ''}>${e((mm.name && mm.name.trim()) ? mm.name : (t('ar.unnamed') + ' ' + (mi + 1)))}</option>`).join('');
            const isLLM = slot.control !== 'ki';
            const promptBlock = isLLM ? `
                <div class="arena-field slot-prompt">
                    <label>${t('ar.slotPrompt')}</label>
                    <textarea rows="6" class="arena-prompt-textarea" oninput="game.ui.setSlotPrompt(${i}, this.value)" placeholder="System prompt …">${e(slot.prompt || this._arenaConfig.prompt || '')}</textarea>
                    <button class="hdr-add-btn" style="margin-top:8px" onclick="game.ui.resetSlotPrompt(${i})">${t('ar.slotPromptReset')}</button>
                </div>` : '';
            return `
            <div class="arena-slot${isLLM ? ' has-prompt' : ''}" style="--civ:${civColor[slot.civ] || '#888'}">
                <div class="arena-slot-title">${t('ar.slot', { n: i + 1 })}</div>
                <div class="arena-field-row">
                    <div class="arena-field"><label>${t('ar.fCiv')}</label>
                        <select onchange="game.ui.setSlotCiv(${i}, this.value)">${civOpts}</select></div>
                    <div class="arena-field"><label>${t('ar.fControl')}</label>
                        <select onchange="game.ui.setSlotControl(${i}, this.value)">
                            <option value="ki" ${slot.control === 'ki' ? 'selected' : ''}>${t('ar.controlKi')}</option>
                            ${modelOpts}
                        </select></div>
                </div>
                ${promptBlock}
            </div>`;
        }).join('');
    }

    // --- Handlers ---
    setModelField(id, field, value) { const m = this.getArenaModel(id); if (m) { m[field] = value; this.saveArenaConfig(); } }
    setAuthField(id, field, value) { const m = this.getArenaModel(id); if (m) { m.auth[field] = value; this.saveArenaConfig(); } }
    setAuthHeaderField(id, idx, field, value) {
        const m = this.getArenaModel(id); if (!m) return;
        if (!m.auth.headers[idx]) m.auth.headers[idx] = { name: '', value: '' };
        m.auth.headers[idx][field] = value; this.saveArenaConfig();
    }
    setAuthType(id, type) { const m = this.getArenaModel(id); if (m) { m.auth.type = type; if (type === 'header' && !m.auth.headers.length) m.auth.headers.push({ name: '', value: '' }); this.saveArenaConfig(); this.renderArenaLibrary(); } }
    addAuthHeader(id) { const m = this.getArenaModel(id); if (m) { m.auth.headers.push({ name: '', value: '' }); this.saveArenaConfig(); this.renderArenaLibrary(); } }
    removeAuthHeader(id, idx) { const m = this.getArenaModel(id); if (m) { m.auth.headers.splice(idx, 1); this.saveArenaConfig(); this.renderArenaLibrary(); } }
    chooseArenaModel(id, value) { const m = this.getArenaModel(id); if (m) { m.model = value; this.saveArenaConfig(); this.renderArenaLibrary(); } }
    setModelProvider(id, value) { const m = this.getArenaModel(id); if (m) { m.provider = value; this.saveArenaConfig(); this.renderArenaLibrary(); } }

    toggleArenaModel(id) {
        const m = this.getArenaModel(id);
        if (m) { m._expanded = !m._expanded; this.renderArenaLibrary(); }
    }

    addArenaModel() {
        const m = this.makeArenaModel({});
        m._expanded = true; // open the new one so it can be configured right away
        this._arenaConfig.models.push(m);
        this.saveArenaConfig();
        this.renderArenaLibrary();
        this.renderArenaSlots();
        this.updateLibrarySummary();
    }

    // Ask before deleting a model (guards against an accidental ✕ misclick).
    removeArenaModel(id) {
        const m = this.getArenaModel(id);
        if (!m) return;
        const name = (m.name && m.name.trim()) ? m.name : t('ar.unnamed');
        this.showConfirm(
            t('dlg.deleteModelBody', { name: this.escapeHtml(name) }),
            () => this.doRemoveArenaModel(id),
            { title: t('dlg.deleteModelTitle'), confirmLabel: t('dlg.deleteModelConfirm'), cancelLabel: t('dlg.cancel') }
        );
    }

    doRemoveArenaModel(id) {
        const cfg = this._arenaConfig;
        cfg.models = cfg.models.filter(m => m.id !== id);
        cfg.slots.forEach(s => { if (s.control === id) s.control = 'ki'; });
        this.saveArenaConfig();
        this.renderArenaLibrary();
        this.renderArenaSlots();
        this.updateLibrarySummary();
    }

    setSlotCiv(i, value) { const s = this._arenaConfig.slots[i]; if (s) { s.civ = value; this.saveArenaConfig(); this.renderArenaSlots(); } }
    setSlotControl(i, value) {
        const s = this._arenaConfig.slots[i];
        if (!s) return;
        s.control = (value === 'ki') ? 'ki' : Number(value);
        // Becoming an LLM slot? make sure it has a prompt (seed from the template).
        if (s.control !== 'ki' && (typeof s.prompt !== 'string' || !s.prompt.trim())) {
            s.prompt = this._arenaConfig.prompt || this.getArenaDefaultPrompt();
        }
        this.saveArenaConfig();
        this.renderArenaSlots(); // show/hide the per-slot prompt editor
    }
    setSlotPrompt(i, value) { const s = this._arenaConfig.slots[i]; if (s) { s.prompt = value; this.saveArenaConfig(); } }
    resetSlotPrompt(i) {
        const s = this._arenaConfig.slots[i];
        if (!s) return;
        s.prompt = this._arenaConfig.prompt || this.getArenaDefaultPrompt();
        this.saveArenaConfig();
        this.renderArenaSlots();
    }
    onTemplatePromptInput(value) { if (this._arenaConfig) { this._arenaConfig.prompt = value; this.saveArenaConfig(); } }
    applyTemplateToAllSlots() {
        const tmpl = (document.getElementById('arenaSharedPrompt') || {}).value || this._arenaConfig.prompt || '';
        this._arenaConfig.prompt = tmpl;
        this._arenaConfig.slots.forEach(s => { s.prompt = tmpl; });
        this.saveArenaConfig();
        this.renderArenaSlots();
    }

    async testArenaModel(id) {
        const m = this.getArenaModel(id);
        if (!m) return;
        const statusEl = document.getElementById('modelStatus-' + id);
        m._status = { cls: 'pending', text: t('ar.testing') };
        if (statusEl) { statusEl.className = 'test-status pending'; statusEl.textContent = t('ar.testing'); }
        const res = await OpenAIAIManager.testConnection((m.endpoint || '').trim(), this.cleanAuth(m.auth), m.provider || 'auto');
        if (res.ok) {
            m.availableModels = res.models || [];
            if ((!m.model || !m.availableModels.includes(m.model)) && m.availableModels.length) m.model = m.availableModels[0];
            const n = m.availableModels.length;
            const provNote = res.provider ? ` [${res.provider}]` : '';
            m._status = { cls: 'ok', text: n ? t('ar.testOk', { prov: provNote, n }) : t('ar.testOkNoList', { prov: provNote }) };
        } else {
            m._status = { cls: 'err', text: '✗ ' + res.error };
        }
        this.saveArenaConfig();
        this.renderArenaLibrary();
    }

    // Strip a model's auth object down to the fields its type needs.
    cleanAuth(auth) {
        if (!auth || !auth.type || auth.type === 'none') return { type: 'none' };
        if (auth.type === 'bearer') return { type: 'bearer', key: (auth.key || '').trim() };
        if (auth.type === 'basic') return { type: 'basic', username: auth.username || '', password: auth.password || '' };
        if (auth.type === 'header') return { type: 'header', headers: (auth.headers || []).filter(h => h && h.name).map(h => ({ name: h.name.trim(), value: (h.value || '').trim() })) };
        if (auth.type === 'oauth') return { type: 'oauth', accessToken: (auth.accessToken || '').trim(), tokenUrl: (auth.tokenUrl || '').trim(), clientId: (auth.clientId || '').trim(), clientSecret: auth.clientSecret || '', scope: (auth.scope || '').trim() };
        return { type: 'none' };
    }

    // Collect the 4-slot setup the arena engine expects.
    collectArenaSetup() {
        const cfg = this._arenaConfig;
        const ta = document.getElementById('arenaSharedPrompt');
        if (ta) cfg.prompt = ta.value;
        this.saveArenaConfig();

        return cfg.slots.map(slot => {
            if (slot.control === 'ki') return { civ: slot.civ, type: 'ki' };
            const m = cfg.models.find(mm => mm.id === slot.control);
            if (!m || !(m.endpoint || '').trim()) return { civ: slot.civ, type: 'ki' };
            return {
                civ: slot.civ,
                type: 'llm',
                systemPrompt: ((slot.prompt && slot.prompt.trim()) ? slot.prompt : (cfg.prompt || '')).trim(),
                connection: {
                    name: (m.name || m.model || m.endpoint).trim(),
                    endpoint: m.endpoint.trim(),
                    model: (m.model || '').trim(),
                    provider: m.provider || 'auto',
                    maxTokens: (() => { const n = parseInt(m.maxTokens, 10); return (n && n >= 64) ? n : null; })(),
                    contextSize: (() => { const n = parseInt(m.contextSize, 10); return (n && n >= 512) ? n : null; })(),
                    language: m.language || 'en',
                    auth: this.cleanAuth(m.auth)
                }
            };
        });
    }

    // Reset the template AND every per-slot prompt to the current default.
    resetArenaPrompts() {
        const def = this.getArenaDefaultPrompt();
        if (this._arenaConfig) {
            this._arenaConfig.prompt = def;
            this._arenaConfig.slots.forEach(s => { s.prompt = def; });
        }
        const ta = document.getElementById('arenaSharedPrompt');
        if (ta) ta.value = def;
        this.saveArenaConfig();
        this.renderArenaSlots();
    }

    showTutorial() {
        this.showScreen('tutorialScreen');
    }

    updateResources(resources) {
        document.getElementById('foodRes').textContent = `${t('res.food')}: ${Math.floor(resources.food)}`;
        document.getElementById('woodRes').textContent = `${t('res.wood')}: ${Math.floor(resources.wood)}`;
        document.getElementById('stoneRes').textContent = `${t('res.stone')}: ${Math.floor(resources.stone)}`;
        document.getElementById('goldRes').textContent = `${t('res.gold')}: ${Math.floor(resources.gold)}`;
        document.getElementById('popRes').textContent = `${t('res.pop')}: ${resources.population}/${resources.maxPopulation}`;
    }

    updateAge(age) {
        const key = 'age.' + age;
        document.getElementById('currentAge').textContent = t(key) !== key ? t(key) : age;
    }

    updateUnitInfo(unit, building) {
        const infoDiv = document.getElementById('unitInfo');
        
        if (unit) {
            let html = `<strong>${tg(unit.name)}</strong><br>`;
            html += `❤️ ${t('ui.health')}: ${Math.floor(unit.health)}/${unit.maxHealth}<br>`;
            html += `⚔️ ${t('ui.attack')}: ${unit.attack}<br>`;
            html += `💨 ${t('ui.speed')}: ${unit.speed}<br>`;
            if (unit.range > 1) {
                html += `🎯 ${t('ui.range')}: ${unit.range}<br>`;
            }
            html += `<em>${this.getUnitTypeDescription(unit.unitType)}</em>`;
            infoDiv.innerHTML = html;
        } else if (building) {
            let html = `<strong>${tg(building.name)}</strong><br>`;
            html += `❤️ ${t('ui.health')}: ${Math.floor(building.health)}/${building.maxHealth}<br>`;
            html += `<em>${this.getBuildingTypeDescription(building.type)}</em>`;
            infoDiv.innerHTML = html;
        } else {
            infoDiv.innerHTML = `<p>${t('hud.selectHint')}</p>`;
        }
    }

    getUnitTypeDescription(type) {
        const key = 'utype.' + type;
        return t(key) !== key ? t(key) : '';
    }

    getBuildingTypeDescription(type) {
        const key = 'btype.' + type;
        return t(key) !== key ? t(key) : '';
    }

    showBuildMenu(buildingType = null) {
        this.closeMenus();
        const menu = document.getElementById('buildMenu');
        const content = document.getElementById('buildMenuContent');
        
        let html = '';
        
        // Get available buildings based on selected building or default
        const buildings = buildingType ? 
            this.getBuildingsForBuilding(buildingType) : 
            this.getDefaultBuildings();

        buildings.forEach(b => {
            const canAfford = this.game.player.resources.hasResources(b.cost);
            const ageOrder = ['stone', 'neolithic', 'bronze', 'iron'];
            const isLocked = b.requiredAge && ageOrder.indexOf(b.requiredAge) > ageOrder.indexOf(this.game.player.age);
            const ageLabel = b.requiredAge ? ` (${this.getAgeName(b.requiredAge)})` : '';
            
            // Check if building requires a tech
            let techLocked = false;
            let techName = '';
            if (b.requiresTech) {
                const civ = getCivilization(this.game.player.civilization);
                const tech = civ.techTree[b.requiresTech];
                techLocked = !this.game.player.researchedTechs[b.requiresTech];
                techName = tech ? tech.name : b.requiresTech;
            }
            
            const hardLocked = isLocked || techLocked;            // not resource-related
            const disabledClass = (!canAfford || hardLocked) ? 'disabled' : '';
            const action = `game.buildStructure('${b.id}')`;
            const clickHandler = canAfford && !hardLocked ? action : '';
            const lockIcon = hardLocked ? '🔒 ' : '';
            const techLabel = techLocked ? ` (${t('menu.needTech', { tech: tg(techName) })})` : '';

            html += `
                <div class="menu-item ${disabledClass}" onclick="${clickHandler}" data-locked="${hardLocked ? 1 : 0}" data-action="${action}" data-cost='${JSON.stringify(b.cost)}'>
                    <h4>${lockIcon}${tg(b.name)}${ageLabel}${techLabel}</h4>
                    <p>${tg(b.description)}</p>
                    <p class="cost">🍖${b.cost.food} 🌲${b.cost.wood} 🪨${b.cost.stone} 🥇${b.cost.gold}</p>
                </div>
            `;
        });

        content.innerHTML = html;
        menu.classList.remove('hidden');
        this.activeMenu = 'build';
    }

    showTrainMenu(building = null) {
        this.closeMenus();
        const menu = document.getElementById('trainMenu');
        const content = document.getElementById('trainMenuContent');
        
        let html = '';
        
        if (!building) {
            building = this.game.player.buildings.find(b => b.selected) || null;
        }

        if (building && building.canTrain) {
            const civ = getCivilization(this.game.player.civilization);
            // Use dynamic train options based on current age for military buildings
            let trainOptions = building.trainOptions || [];
            
            // For barracks, stable, archery_range - get options based on current age
            if (['barracks', 'stable', 'archery_range'].includes(building.type)) {
                trainOptions = getTrainOptionsForBuilding(building.type, this.game.player.age);
                // Sync the building's trainOptions
                building.trainOptions = trainOptions;
            }
            
            trainOptions.forEach(unitId => {
                const unitDef = getUnitDef(unitId) || civ.uniqueUnits.find(u => u.id === unitId);
                if (unitDef) {
                    const canAfford = this.game.player.resources.hasResources(unitDef.cost);
                    const tierLabel = unitDef.tier ? ` (${this.getAgeName(unitDef.tier)})` : '';
                    const action = `game.trainUnit('${unitId}')`;
                    html += `
                        <div class="menu-item ${canAfford ? '' : 'disabled'}" onclick="${canAfford ? action : ''}" data-locked="0" data-action="${action}" data-cost='${JSON.stringify(unitDef.cost)}'>
                            <h4>${tg(unitDef.name)}${tierLabel}</h4>
                            <p>${tg(unitDef.description)}</p>
                            <p class="cost">🍖${unitDef.cost.food} 🌲${unitDef.cost.wood} 🪨${unitDef.cost.stone} 🥇${unitDef.cost.gold}</p>
                        </div>
                    `;
                }
            });
        } else {
            html = `<p>${t('menu.trainHint')}</p>`;
        }

        content.innerHTML = html;
        menu.classList.remove('hidden');
        this.activeMenu = 'train';
    }

    showResearchMenu(building = null) {
        this.closeMenus();
        const menu = document.getElementById('researchMenu');
        const content = document.getElementById('researchMenuContent');
        
        let html = '';
        
        if (!building) {
            building = this.game.player.buildings.find(b => b.selected) || null;
        }

        if (building && building.canResearch) {
            const civ = getCivilization(this.game.player.civilization);
            const techs = civ.techTree || {};
            
            // Get techs that can be researched at this building
            const buildingType = building.type;
            const currentAge = this.game.player.age;
            const ageOrder = ['stone', 'neolithic', 'bronze', 'iron'];
            const currentAgeIndex = ageOrder.indexOf(currentAge);
            
            // Check if currently researching at this building
            const currentResearch = this.game.player.currentResearch;
            const isResearching = currentResearch && currentResearch.building === building;
            
            if (isResearching) {
                const tech = civ.techTree[currentResearch.techId];
                const percentage = Math.min(100, Math.floor((currentResearch.progress / currentResearch.duration) * 100));
                html += `
                    <div class="menu-item" style="background: rgba(78, 204, 163, 0.2); border: 2px solid #4ecca3;">
                        <h4>🔬 ${tech ? tg(tech.name) : t('ui.researching')} (${this.getAgeName(tech?.requiredAge || '')})</h4>
                        <p>${tech ? tg(tech.description) : ''}</p>
                        <div class="progress-bar" style="width: 100%; height: 20px; background: #1a1a2e; border: 2px solid #0f3460; border-radius: 10px; overflow: hidden; margin-top: 10px;">
                            <div class="progress-fill" style="height: 100%; width: ${percentage}%; background: linear-gradient(90deg, #4ecca3, #0f3460); border-radius: 8px;"></div>
                        </div>
                        <p style="color: #4ecca3; font-weight: bold; margin-top: 5px;">${percentage}% ${t('ui.complete')}</p>
                    </div>
                `;
            }
            
            Object.keys(techs).forEach(techId => {
                const tech = techs[techId];
                
                // Skip if currently researching this tech
                if (currentResearch && currentResearch.techId === techId) return;
                
                // Only show techs that can be researched at this building
                if (tech.researchAt !== buildingType) return;
                
                // Check if tech requires a higher age than current
                if (tech.requiredAge) {
                    const requiredAgeIndex = ageOrder.indexOf(tech.requiredAge);
                    if (requiredAgeIndex > currentAgeIndex) return; // Tech locked - player hasn't reached this age yet
                }
                
                // Check if already researched (one-time purchase - gray out)
                const alreadyResearched = this.game.player.researchedTechs[techId];
                
                // Check prerequisites
                let prereqMet = true;
                let missingPrereq = '';
                if (tech.requires && tech.requires.length > 0) {
                    for (const req of tech.requires) {
                        if (!this.game.player.researchedTechs[req]) {
                            prereqMet = false;
                            const reqTech = techs[req];
                            missingPrereq = reqTech ? tg(reqTech.name) : req;
                            break;
                        }
                    }
                }
                
                const costMultiplier = this.game.player.techCostMultiplier || 1;
                const adjustedCost = {
                    food: Math.floor((tech.cost.food || 0) * costMultiplier),
                    wood: Math.floor((tech.cost.wood || 0) * costMultiplier),
                    stone: Math.floor((tech.cost.stone || 0) * costMultiplier),
                    gold: Math.floor((tech.cost.gold || 0) * costMultiplier)
                };
                const canAfford = this.game.player.resources.hasResources(adjustedCost);
                
                const ageLabel = tech.requiredAge ? ` (${this.getAgeName(tech.requiredAge)})` : '';
                const prereqLabel = tech.requires && tech.requires.length > 0 ? ` (${t('menu.needTech', { tech: missingPrereq })})` : '';
                const timeLabel = tech.researchTime ? ` (${Math.floor(tech.researchTime / 1000)}s)` : '';
                
                // Determine disabled state
                const isDisabled = alreadyResearched || !canAfford || !prereqMet || isResearching;
                const disabledClass = isDisabled ? 'disabled' : '';
                
                // Research button text
                let statusText = '';
                if (alreadyResearched) {
                    statusText = t('menu.researched');
                } else if (!prereqMet) {
                    statusText = t('menu.prereqMissing');
                } else if (!canAfford) {
                    statusText = t('menu.notAfford');
                } else if (isResearching) {
                    statusText = t('menu.inProgress');
                }
                
                const action = `game.researchTech('${techId}', game.player.buildings.find(b => b.selected))`;
                const clickHandler = !isDisabled ? action : '';
                const hardLocked = !!(alreadyResearched || !prereqMet || isResearching); // not resource-related

                html += `
                    <div class="menu-item ${disabledClass}" onclick="${clickHandler}" data-locked="${hardLocked ? 1 : 0}" data-action="${action}" data-cost='${JSON.stringify(adjustedCost)}'>
                        <h4>${tg(tech.name)}${ageLabel}${timeLabel}</h4>
                        <p>${tg(tech.description || tech.effect)}</p>
                        <p class="cost">🍖${adjustedCost.food} 🌲${adjustedCost.wood} 🪨${adjustedCost.stone} 🥇${adjustedCost.gold}</p>
                        ${statusText ? `<p style="color: ${alreadyResearched ? '#4ecca3' : '#e94560'}; font-size: 0.85em;">${statusText}</p>` : ''}
                        ${prereqLabel && !alreadyResearched ? `<p style="color: #ffa500; font-size: 0.8em;">${prereqLabel}</p>` : ''}
                    </div>
                `;
            });
            
            if (!html) {
                html = `<p>${t('menu.noResearchAvail')}</p>`;
            }
        } else {
            // No building selected - show hint
            html = `<p>${t('menu.researchHint')}</p>`;
        }

        content.innerHTML = html;
        menu.classList.remove('hidden');
        this.activeMenu = 'research';
    }

    showUpgradeMenu() {
        this.closeMenus();
        const menu = document.getElementById('upgradeMenu');
        const content = document.getElementById('upgradeMenuContent');
        
        // IMPROVEMENT 4: Upgrading age unlocks better enhancements
        const ages = [
            { id: 'stone', name: t('age.stone'), cost: null },
            { id: 'neolithic', name: t('age.neolithic'), cost: { food: 1000, wood: 1000, stone: 0, gold: 0 } },
            { id: 'bronze', name: t('age.bronze'), cost: { food: 2500, wood: 2500, stone: 1000, gold: 500 } },
            { id: 'iron', name: t('age.iron'), cost: { food: 4000, wood: 4000, stone: 2000, gold: 1000 } }
        ];

        let html = '';
        const currentAgeIndex = ages.findIndex(a => a.id === this.game.player.age);
        
        // Check if currently upgrading age
        if (this.game.player.currentAgeUpgrade) {
            const upgrade = this.game.player.currentAgeUpgrade;
            const percentage = Math.min(100, Math.floor((upgrade.progress / upgrade.duration) * 100));
            const targetAge = ages.find(a => a.id === upgrade.targetAge);
            html += `
                <div class="menu-item" style="background: rgba(255, 215, 0, 0.2); border: 2px solid #ffd700;">
                    <h4>${t('menu.upgradeInProgress')}</h4>
                    <p>${targetAge?.name || '...'}</p>
                    <div class="progress-bar" style="width: 100%; height: 20px; background: #1a1a2e; border: 2px solid #0f3460; border-radius: 10px; overflow: hidden; margin-top: 10px;">
                        <div class="progress-fill" style="height: 100%; width: ${percentage}%; background: linear-gradient(90deg, #ffd700, #ff8c00); border-radius: 8px;"></div>
                    </div>
                    <p style="color: #ffd700; font-weight: bold; margin-top: 5px;">${percentage}% ${t('ui.complete')}</p>
                </div>
            `;
        }
        
        ages.forEach((age, index) => {
            if (index > currentAgeIndex && age.cost) {
                const canAfford = this.game.player.resources.hasResources(age.cost);
                const isUpgrading = this.game.player.currentAgeUpgrade;
                const disabledClass = (!canAfford || isUpgrading) ? 'disabled' : '';
                const action = `game.upgradeAge('${age.id}')`;
                const clickHandler = canAfford && !isUpgrading ? action : '';
                const statusText = isUpgrading ? t('menu.upgradeInProgress') : (!canAfford ? t('menu.notAfford') : '');

                html += `
                    <div class="menu-item ${disabledClass}" onclick="${clickHandler}" data-locked="${isUpgrading ? 1 : 0}" data-action="${action}" data-cost='${JSON.stringify(age.cost)}'>
                        <h4>${age.name}</h4>
                        <p class="cost">🍖${age.cost.food} 🌲${age.cost.wood} 🪨${age.cost.stone} 🥇${age.cost.gold}</p>
                        ${statusText ? `<p style="color: ${isUpgrading ? '#ffd700' : '#e94560'}; font-size: 0.85em;">${statusText}</p>` : ''}
                    </div>
                `;
            }
        });

        content.innerHTML = html;
        menu.classList.remove('hidden');
        this.activeMenu = 'upgrade';
    }

    getAgeName(ageId) {
        const key = 'ageName.' + ageId;
        return t(key) !== key ? t(key) : ageId;
    }

    closeMenus() {
        document.querySelectorAll('.menu-panel').forEach(menu => {
            menu.classList.add('hidden');
        });
        this.activeMenu = null;
    }
    
    // Update each open menu item's affordability (enabled/disabled + click) WITHOUT
    // rebuilding the DOM — so an item you're hovering flips to enabled the instant you
    // can afford it, with no flicker. Items locked for non-resource reasons (tech, age,
    // prereq, already-researched, in-progress) carry data-locked="1" and stay disabled.
    refreshMenuAffordability() {
        const panel = document.querySelector('.menu-panel:not(.hidden)');
        if (!panel) return;
        const res = this.game.player.resources;
        panel.querySelectorAll('.menu-item[data-cost]').forEach(item => {
            if (item.dataset.locked === '1') return;
            let cost; try { cost = JSON.parse(item.dataset.cost); } catch (e) { return; }
            const afford = res.hasResources(cost);
            const action = item.dataset.action || '';
            if (afford) {
                item.classList.remove('disabled');
                if (action) item.setAttribute('onclick', action);
            } else {
                item.classList.add('disabled');
                item.setAttribute('onclick', '');
            }
        });
    }

    refreshActiveMenu() {
        if (!this.activeMenu) return;

        // 1) Always keep affordability live in-place (cheap, no flicker, works while
        //    hovering) — so a user waiting for resources sees the item enable itself.
        this.refreshMenuAffordability();

        // 2) A FULL rebuild is only needed when the item SET changes (e.g. a new tech
        //    or age unlocks something). Rebuilding replaces the DOM, so never do it
        //    while the cursor is over the menu (flicker/false clicks), and throttle it.
        const panel = document.querySelector('.menu-panel:not(.hidden)');
        if (panel && panel.matches(':hover')) return;
        const now = Date.now();
        if (this._lastMenuRefresh && (now - this._lastMenuRefresh) < 250) return;
        this._lastMenuRefresh = now;

        switch(this.activeMenu) {
            case 'build':
                this.showBuildMenu();
                break;
            case 'train':
                this.showTrainMenu();
                break;
            case 'research':
                this.showResearchMenu();
                break;
            case 'upgrade':
                this.showUpgradeMenu();
                break;
        }
    }

    getDefaultBuildings() {
        const age = this.game.player.age;
        const allBuildings = [
            BUILDING_DEFS.town_center,
            BUILDING_DEFS.house,
            BUILDING_DEFS.barracks,
            BUILDING_DEFS.archery_range,
            BUILDING_DEFS.stable,
            BUILDING_DEFS.farm,
            BUILDING_DEFS.tower,
            BUILDING_DEFS.market,
            BUILDING_DEFS.temple
        ];
        // Your civilization's Wonder (Iron age). Hidden once one already exists.
        const civ = getCivilization(this.game.player.civilization);
        const wonderDef = (civ?.uniqueBuildings || []).find(b => b.type === 'wonder');
        const hasWonder = this.game.player.buildings.some(b => b.isWonder);
        if (wonderDef && !hasWonder) {
            allBuildings.push({
                id: wonderDef.id,
                name: '🏛️ ' + tg(wonderDef.name),
                cost: wonderDef.cost,
                description: wonderDef.description ? tg(wonderDef.description) : t('wonder.descFallback', { s: (this.game.wonderRequired || 240) }),
                requiredAge: wonderDef.requiredAge || 'iron'
            });
        }
        // Filter by age requirement AND tech requirements
        return allBuildings.filter(b => {
            if (!b.requiredAge) return true;
            const ageOrder = ['stone', 'neolithic', 'bronze', 'iron'];
            if (ageOrder.indexOf(b.requiredAge) > ageOrder.indexOf(age)) return false;
            
            // Check if building requires a tech
            if (b.requiresTech) {
                return this.game.player.researchedTechs[b.requiresTech];
            }
            return true;
        });
    }

    getBuildingsForBuilding(type) {
        const age = this.game.player.age;
        const ageOrder = ['stone', 'neolithic', 'bronze', 'iron'];
        const filterByAge = (buildings) => buildings.filter(b => {
            if (!b.requiredAge) return true;
            if (ageOrder.indexOf(b.requiredAge) > ageOrder.indexOf(age)) return false;
            
            // Check if building requires a tech
            if (b.requiresTech) {
                return this.game.player.researchedTechs[b.requiresTech];
            }
            return true;
        });
        
        switch(type) {
            case 'town_center':
                return filterByAge([BUILDING_DEFS.barracks, BUILDING_DEFS.archery_range, BUILDING_DEFS.farm, BUILDING_DEFS.house, BUILDING_DEFS.temple, BUILDING_DEFS.market]);
            case 'barracks':
            case 'stable':
                return filterByAge([BUILDING_DEFS.tower]);
            default:
                return this.getDefaultBuildings();
        }
    }

    showVictory() {
        document.getElementById('endTitle').textContent = t('end.victory');
        document.getElementById('endTitle').className = 'victory';
        document.getElementById('endMessage').textContent = t('end.victoryMsg');
        this.showScreen('endScreen');
    }

    showDefeat() {
        document.getElementById('endTitle').textContent = t('end.defeat');
        document.getElementById('endTitle').className = 'defeat';
        document.getElementById('endMessage').textContent = t('end.defeatMsg');
        this.showScreen('endScreen');
    }

    showBuildingPlacementHint(buildingName) {
        const infoDiv = document.getElementById('unitInfo');
        infoDiv.innerHTML = `<p style="color: #4ecca3; font-weight: bold;">${t('msg.buildHint', { name: tg(buildingName) })}</p>`;
    }

    hideBuildingPlacementHint() {
        const infoDiv = document.getElementById('unitInfo');
        infoDiv.innerHTML = `<p>${t('hud.selectHint')}</p>`;
    }

    showErrorMessage(message) {
        const infoDiv = document.getElementById('unitInfo');
        const original = infoDiv.innerHTML;
        infoDiv.innerHTML = `<p style="color: #e94560; font-weight: bold;">⚠️ ${message}</p>`;
        setTimeout(() => {
            infoDiv.innerHTML = original;
        }, 3000);
    }

    showInfoMessage(message) {
        const infoDiv = document.getElementById('unitInfo');
        if (!infoDiv) return;
        const original = infoDiv.innerHTML;
        infoDiv.innerHTML = `<p style="color: #4ecca3; font-weight: bold;">✅ ${message}</p>`;
        setTimeout(() => {
            infoDiv.innerHTML = original;
        }, 2500);
    }

    // --- Wonder victory countdown ---
    showWonderTimer(remainingMs, requiredMs) {
        const el = document.getElementById('wonderTimer');
        if (!el) return;
        el.classList.remove('hidden');
        const secs = Math.ceil(remainingMs / 1000);
        const sEl = document.getElementById('wonderSeconds');
        if (sEl) sEl.textContent = secs;
        const fill = document.getElementById('wonderFill');
        if (fill) fill.style.width = Math.max(0, Math.min(100, (1 - remainingMs / requiredMs) * 100)) + '%';
        el.classList.toggle('wt-urgent', secs <= 10); // red, faster pulse in the final stretch
    }

    hideWonderTimer() {
        const el = document.getElementById('wonderTimer');
        if (el) { el.classList.add('hidden'); el.classList.remove('wt-urgent'); }
    }

    // Big one-time "Wonder built!" flash — it's a momentous event.
    announceWonder(wonder) {
        const name = (wonder && wonder.name) ? tg(wonder.name) : t('wonder.generic');
        const holdSecs = this.game && this.game.wonderRequired ? this.game.wonderRequired : 240;
        const div = document.createElement('div');
        div.className = 'wonder-announce';
        div.innerHTML = `
            <div class="wa-inner">
                <div class="wa-emoji">🏛️</div>
                <div class="wa-title">${t('wonder.built', { name: this.escapeHtml(name) })}</div>
                <div class="wa-sub">${t('wonder.holdMsg', { s: holdSecs })}</div>
            </div>`;
        document.body.appendChild(div);
        setTimeout(() => div.classList.add('wa-out'), 3200);
        setTimeout(() => div.remove(), 4100);
    }

    // ----------------------------------------------------------------
    // Spectator mode UI
    // ----------------------------------------------------------------
    setupSpectatorUI() {
        // Spectator layout tweaks (lower minimap, taller leaderboard) live in CSS.
        document.body.classList.add('spectator-mode');

        // Hide normal HUD elements
        const topHUD = document.getElementById('topHUD');
        const bottomHUD = document.getElementById('bottomHUD');
        if (topHUD) topHUD.style.display = 'none';
        if (bottomHUD) bottomHUD.style.display = 'none';

        const actionBar = document.getElementById('actionBar');
        if (actionBar) actionBar.style.display = 'none';

        const progressBar = document.getElementById('productionProgressBar');
        if (progressBar) progressBar.style.display = 'none';

        // Show spectator dashboard pieces
        const spectatorHUD = document.getElementById('spectatorHUD');
        if (spectatorHUD) spectatorHUD.style.display = 'block';
        const leaderboard = document.getElementById('spectatorLeaderboard');
        if (leaderboard) leaderboard.style.display = 'flex';
        const aiDecisionLog = document.getElementById('aiDecisionLog');
        if (aiDecisionLog) aiDecisionLog.style.display = 'flex';

        const infoDiv = document.getElementById('unitInfo');
        if (infoDiv) {
            infoDiv.innerHTML = `<p style="color: #4ecca3; font-weight: bold;">${t('spec.hint')}</p>`;
        }

        // Wire the decision-log scroll → toggle the "to top" arrow (once).
        const entriesEl = document.getElementById('aiLogEntries');
        if (entriesEl && !entriesEl._topBtnWired) {
            entriesEl.addEventListener('scroll', () => this.updateDecisionLogTopBtn());
            entriesEl._topBtnWired = true;
        }

        // Mark arena start for the clock
        this.arenaStartTime = Date.now();
        this._lastLogSig = null;

        // Clear any intervals from a previous arena run so they don't stack up
        if (this._spectatorIntervals) this._spectatorIntervals.forEach(id => clearInterval(id));
        this._spectatorIntervals = [];

        // Initial paint
        this.updateSpectatorPlayerList();
        this.updateDecisionLog();
        this.updateArenaStatus();

        // Periodic refresh
        this._spectatorIntervals.push(setInterval(() => this.updateSpectatorPlayerList(), 1500));
        this._spectatorIntervals.push(setInterval(() => this.updateDecisionLog(), 1000));
        this._spectatorIntervals.push(setInterval(() => this.updateArenaStatus(), 1000));
    }

    // Stop spectator refresh timers (call when leaving the arena)
    teardownSpectatorUI() {
        document.body.classList.remove('spectator-mode');
        if (this._spectatorIntervals) this._spectatorIntervals.forEach(id => clearInterval(id));
        this._spectatorIntervals = [];
    }

    toggleDecisionLog() {
        const entries = document.getElementById('aiLogEntries');
        const toggle = document.getElementById('aiLogToggle');
        if (entries) {
            entries.classList.toggle('collapsed');
            if (toggle) toggle.textContent = entries.classList.contains('collapsed') ? '▶' : '▼';
        }
    }

    // Composite "power" rating used to rank players on the leaderboard
    spectatorPowerScore(ai) {
        const ageIdx = { stone: 0, neolithic: 1, bronze: 2, iron: 3 }[ai.age] || 0;
        const hasTC = ai.buildings.some(b => b.type === 'town_center');
        const military = ai.units.filter(u => u.type !== 'worker').length;
        const workers = ai.units.filter(u => u.type === 'worker').length;
        const res = ai.resources.food + ai.resources.wood + ai.resources.stone + ai.resources.gold;
        let score = ageIdx * 220 + military * 45 + workers * 16 + ai.buildings.length * 32 + res * 0.04;
        if (!hasTC) score *= 0.15; // heavily demote players who lost their town center
        return Math.round(score);
    }

    updateArenaStatus() {
        // Clock
        const clockEl = document.getElementById('arenaClock');
        if (clockEl && this.arenaStartTime) {
            const t = Math.max(0, Math.floor((Date.now() - this.arenaStartTime) / 1000));
            const mm = String(Math.floor(t / 60)).padStart(2, '0');
            const ss = String(t % 60).padStart(2, '0');
            clockEl.textContent = `${mm}:${ss}`;
        }

        const players = this.game.aiManager ? this.game.aiManager.aiPlayers : [];
        const alive = players.filter(ai => !this.game.isPlayerEliminated(ai)).length;
        const aliveEl = document.getElementById('arenaAlive');
        if (aliveEl) aliveEl.innerHTML = `<b>${alive}</b> / ${players.length} ${t('spec.alive')}`;

        // Wonder progress: show the furthest-along held Wonder among the AIs.
        const wEl = document.getElementById('arenaWonder');
        if (wEl) {
            const reqMs = (this.game.wonderRequired || 240) * 1000;
            let lead = null, leadHold = 0;
            players.forEach(ai => {
                const holding = ai.buildings.some(b => b.isWonder && !b.underConstruction);
                if (holding && (ai._wonderHold || 0) > leadHold) { leadHold = ai._wonderHold || 0; lead = ai; }
            });
            if (lead) {
                const pct = Math.min(100, Math.round((leadHold / reqMs) * 100));
                const civ = getCivilization(lead.civilization);
                const col = this.legibleColor('#' + (civ?.color || 0xffffff).toString(16).padStart(6, '0'));
                wEl.style.display = 'flex';
                wEl.innerHTML = `<span class="sb-sep"></span>\u{1F3DB}️ <span style="color:${col};font-weight:700">${civ ? tg(civ.name) : lead.civilization}</span> ${t('wonder.generic')} <span class="sb-wonder-track"><span class="sb-wonder-fill" style="width:${pct}%"></span></span> ${Math.floor(leadHold / 1000)}/${Math.round(reqMs / 1000)}s`;
            } else {
                wEl.style.display = 'none';
            }
        }
    }

    updateDecisionLog() {
        const entriesEl = document.getElementById('aiLogEntries');
        const countEl = document.getElementById('aiLogCount');
        if (!entriesEl || !this.game.openAIAIManager) return;

        const log = this.game.openAIAIManager.decisionLog;
        if (countEl) countEl.textContent = log.length ? `(${log.length})` : '';

        if (log.length === 0) {
            if (this._lastLogSig !== 'empty:' + getUiLang()) {
                entriesEl.innerHTML = `<div class="ai-log-empty" style="color:#6b7488;font-size:0.8em;padding:14px 8px;text-align:center;">${t('log.empty')}</div>`;
                this._lastLogSig = 'empty:' + getUiLang();
            }
            return;
        }

        // Only rebuild when the log actually changed (avoids re-triggering the
        // entry animation every second, which looks like flicker).
        const sig = getUiLang() + ':' + log.length + ':' + (log[0] ? log[0].timestamp : 0);
        if (sig === this._lastLogSig) return;
        this._lastLogSig = sig;

        const actionNames = {
            train_worker: t('log.train_worker'),
            train_unit: t('log.train_unit'),
            research_tech: t('log.research_tech'),
            upgrade_age: t('log.upgrade_age'),
            build_structure: t('log.build_structure'),
            move_units: t('log.move_units'),
            attack_target: t('log.attack_target'),
            harvest_resource: t('log.harvest_resource'),
            wait: t('log.wait'),
            paused: t('log.paused'),
            resumed: t('log.resumed'),
            defeated: t('log.defeated'),
            explore: t('log.explore'),
            build_wonder: t('log.build_wonder'),
            assign_workers: t('log.assign_workers'),
            delete_unit: t('log.delete_unit'),
            destroy_building: t('log.destroy_building')
        };

        let html = '';
        const now = Date.now();
        log.slice(0, 160).forEach((entry, idx) => {
            const secondsAgo = Math.floor((now - entry.timestamp) / 1000);
            const timeStr = secondsAgo < 5 ? t('log.now') : `${secondsAgo}s`;
            const civColor = this.legibleColor(entry.color);
            const newCls = idx === 0 ? ' is-new' : '';
            // Stable per-entry id so we can pin the reader's scroll to one entry.
            if (entry._uid == null) entry._uid = (this._logUid = (this._logUid || 0) + 1);
            const key = entry._uid;

            // Spectator advice gets its own highlighted entry style.
            if (entry.isAdvice) {
                html += `
                    <div class="ai-log-entry is-advice${newCls}" data-key="${key}" style="border-left-color: ${civColor}">
                        <div class="log-line1">
                            <span class="log-time">${timeStr}</span>
                            <span class="log-civ" style="color: ${civColor}">${this.escapeHtml(entry.civName)}</span>
                            <span class="log-action">${t('log.advice')}</span>
                        </div>
                        <span class="log-reason">“${this.escapeHtml(entry.reason)}”</span>
                    </div>
                `;
                return;
            }

            const actionLabel = actionNames[entry.action] || this.escapeHtml(entry.action);
            const p = entry.params || {};
            const hasTarget = p.targetX !== undefined && p.targetZ !== undefined;
            const detail = p.unitType ? ` (${p.unitType})`
                : p.buildingType ? ` (${p.buildingType})`
                : p.techId ? ` (${p.techId})`
                : p.resourceType ? ` (${p.resourceType})`
                : hasTarget ? ` (→ ${Math.round(p.targetX)}, ${Math.round(p.targetZ)})`
                : '';
            const isError = entry.failed || (typeof entry.action === 'string' && (entry.action.includes('failed') || entry.action.includes('⚠')));

            html += `
                <div class="ai-log-entry${isError ? ' is-error' : ''}${newCls}" data-key="${key}" style="border-left-color: ${civColor}">
                    <div class="log-line1">
                        <span class="log-time">${timeStr}</span>
                        <span class="log-civ" style="color: ${civColor}">${this.escapeHtml(entry.civName)}</span>
                        <span class="log-action">${actionLabel}${this.escapeHtml(detail)}${entry.failed ? ` <span class="log-x">✗ ${t('log.rejected')}</span>` : ''}</span>
                    </div>
                    ${entry.reason ? `<span class="log-reason">“${this.escapeHtml(entry.reason)}”</span>` : ''}
                    ${entry.failed && entry.error ? `<span class="log-error">⚠ ${this.escapeHtml(entry.error)}</span>` : ''}
                    ${!entry.failed && !entry.reason && entry.result ? `<span class="log-outcome">${this.escapeHtml(entry.result.replace(/^OK\s*-\s*/, ''))}</span>` : ''}
                </div>
            `;
        });

        // Scroll anchoring: if the reader has scrolled into the history, pin the
        // entry they're looking at so the list stays put as new entries arrive at
        // the top (and old ones drop off the cap). Only at the very top do we keep
        // following the newest decisions. A raw pixel-delta is unreliable once the
        // 40-cap starts dropping entries from the bottom, so we anchor on an entry.
        const atTop = entriesEl.scrollTop <= 4;
        const prevTop = entriesEl.scrollTop;
        let anchorKey = null, anchorOffset = 0;
        if (!atTop) {
            const kids = entriesEl.children;
            for (let i = 0; i < kids.length; i++) {
                const el = kids[i];
                if (el.offsetTop + el.offsetHeight > prevTop) { // first (partly) visible entry
                    anchorKey = el.getAttribute('data-key');
                    anchorOffset = el.offsetTop - prevTop;
                    break;
                }
            }
        }

        entriesEl.innerHTML = html;

        if (atTop) {
            entriesEl.scrollTop = 0;
        } else if (anchorKey != null) {
            const el = entriesEl.querySelector(`[data-key="${anchorKey}"]`);
            // Anchor still present → restore its exact position; otherwise it fell
            // off the bottom of the cap, so keep the previous offset as a fallback.
            entriesEl.scrollTop = el ? (el.offsetTop - anchorOffset) : prevTop;
        } else {
            entriesEl.scrollTop = prevTop;
        }
        this.updateDecisionLogTopBtn();
    }

    // Show/hide the "scroll to top" arrow based on the log's scroll position.
    updateDecisionLogTopBtn() {
        const entriesEl = document.getElementById('aiLogEntries');
        const btn = document.getElementById('aiLogTopBtn');
        if (!entriesEl || !btn) return;
        btn.classList.toggle('visible', entriesEl.scrollTop > 24);
    }

    scrollDecisionLogTop() {
        const entriesEl = document.getElementById('aiLogEntries');
        if (entriesEl) entriesEl.scrollTo({ top: 0, behavior: 'smooth' });
    }

    escapeHtml(str) {
        if (str === null || str === undefined) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    // Lighten very dark civ colors (e.g. Yamato navy) so text/accents stay
    // legible on the dark dashboard background.
    legibleColor(hex) {
        if (!hex) return '#cdd6e8';
        let h = String(hex).replace('#', '');
        if (h.length === 3) h = h.split('').map(c => c + c).join('');
        if (h.length !== 6) return '#cdd6e8';
        const r = parseInt(h.slice(0, 2), 16);
        const g = parseInt(h.slice(2, 4), 16);
        const b = parseInt(h.slice(4, 6), 16);
        const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
        if (lum >= 0.42) return '#' + h;
        const f = 0.55; // blend toward white
        const to2 = v => Math.round(v).toString(16).padStart(2, '0');
        return '#' + to2(r + (255 - r) * f) + to2(g + (255 - g) * f) + to2(b + (255 - b) * f);
    }

    updateSpectatorPlayerList() {
        const listEl = document.getElementById('spectatorPlayerList');
        if (!listEl || !this.game.aiManager) return;

        // Don't rebuild the list while the user is typing advice into a card —
        // re-rendering innerHTML would wipe the input and drop focus.
        this._adviceDrafts = this._adviceDrafts || {};
        const ae = document.activeElement;
        if (ae && ae.classList && ae.classList.contains('lb-advice-input')) return;

        const ageNames = {
            stone: t('age.stone'),
            neolithic: t('age.neolithic'),
            bronze: t('age.bronze'),
            iron: t('age.iron')
        };
        const civNames = {
            egyptian: t('civ.egyptian.name'),
            greek: t('civ.greek.name'),
            persian: t('civ.persian.name'),
            yamato: t('civ.yamato.name')
        };

        // Build a ranked snapshot
        const rows = this.game.aiManager.aiPlayers.map(ai => {
            const civ = getCivilization(ai.civilization);
            const colorHex = '#' + (civ?.color || 0xffffff).toString(16).padStart(6, '0');
            const workers = ai.units.filter(u => u.type === 'worker').length;
            const military = ai.units.filter(u => u.type !== 'worker').length;
            const alive = !this.game.isPlayerEliminated(ai);

            let modelName = t('spec.rulebased');
            let thinking = false;
            let isLLM = false;
            let adviceCount = 0;
            let paused = false;
            if (this.game.openAIAIManager && this.game.openAIAIManager.aiControllers) {
                const controller = this.game.openAIAIManager.aiControllers.find(c => c.id === ai.id);
                if (controller && controller.model) {
                    modelName = controller.model.name;
                    thinking = !!controller.pending;
                    isLLM = true;
                    adviceCount = (controller.pendingAdvice && controller.pendingAdvice.length) || 0;
                    paused = !!controller.paused;
                }
            }

            return { ai, civ, colorHex, workers, military, alive, modelName, thinking, isLLM, adviceCount, paused, score: this.spectatorPowerScore(ai) };
        });

        // Sort: alive first, then by score desc
        rows.sort((a, b) => (b.alive - a.alive) || (b.score - a.score));
        const maxScore = Math.max(1, ...rows.filter(r => r.alive).map(r => r.score));

        const countEl = document.getElementById('lbCount');
        if (countEl) {
            const aliveN = rows.filter(r => r.alive).length;
            countEl.textContent = `${aliveN}/${rows.length}`;
        }

        let html = '';
        rows.forEach((r, idx) => {
            const rank = idx + 1;
            const ai = r.ai;
            const isLeader = r.alive && rank === 1 && rows.filter(x => x.alive).length > 1;
            const pct = r.alive ? Math.round((r.score / maxScore) * 100) : 0;

            html += `
                <div class="lb-card rank-${rank}${isLeader ? ' leader' : ''}${r.alive ? '' : ' eliminated'}${r.paused ? ' paused' : ''}" style="--civ: ${this.legibleColor(r.colorHex)}" onclick="game.focusCameraOnAI('${ai.id}')" title="${t('spec.cardHint')}">
                    <div class="lb-model-banner" title="${this.escapeHtml(r.modelName)}">
                        <span class="lb-model-name">${this.escapeHtml(r.modelName)}</span>
                        ${(r.isLLM && r.alive) ? `<button class="lb-pause${r.paused ? ' is-paused' : ''}" onclick="event.stopPropagation(); game.ui.togglePauseModel('${ai.id}')" title="${r.paused ? t('spec.resume') : t('spec.pause')}">${r.paused ? '▶' : '⏸'}</button>` : ''}
                    </div>
                    <div class="lb-card-top">
                        <span class="lb-rank">${rank}</span>
                        <span class="lb-civ">${civNames[ai.civilization] || ai.civilization}</span>
                        <span class="lb-age">${ageNames[ai.age] || ai.age}</span>
                        ${!r.alive ? `<span class="lb-tag-elim">${t('spec.defeated')}</span>`
                            : (r.paused ? `<span class="lb-tag-paused">${t('spec.paused')}</span>`
                            : (r.thinking ? `<span class="lb-think"><span class="dot"></span>${t('spec.thinking')}</span>` : ''))}
                    </div>
                    <div class="lb-stats">
                        <span class="lb-stat">\u{1F465} ${ai.resources.population}/${ai.resources.maxPopulation}</span>
                        <span class="lb-stat">\u{1F477} ${r.workers}</span>
                        <span class="lb-stat">⚔️ ${r.military}</span>
                        <span class="lb-stat">\u{1F3DB}️ ${ai.buildings.length}</span>
                    </div>
                    <div class="lb-stats">
                        <span class="lb-stat">\u{1F356} ${Math.floor(ai.resources.food)}</span>
                        <span class="lb-stat">\u{1F332} ${Math.floor(ai.resources.wood)}</span>
                        <span class="lb-stat">\u{1FAA8} ${Math.floor(ai.resources.stone)}</span>
                        <span class="lb-stat">\u{1F947} ${Math.floor(ai.resources.gold)}</span>
                    </div>
                    <div class="lb-power">
                        <div class="lb-power-track"><div class="lb-power-fill" style="width: ${pct}%"></div></div>
                        <span class="lb-power-val">${r.alive ? r.score : '—'}</span>
                    </div>
                    ${(r.isLLM && r.alive) ? `
                    <div class="lb-advice" onclick="event.stopPropagation()">
                        <input class="lb-advice-input" type="text" maxlength="400"
                            data-ai="${ai.id}"
                            placeholder="${t('spec.advicePlaceholder')}"
                            value="${this.escapeHtml(this._adviceDrafts[ai.id] || '')}"
                            oninput="game.ui.onAdviceInput('${ai.id}', this.value)"
                            onkeydown="if(event.key==='Enter'){event.preventDefault();game.ui.sendAdvice('${ai.id}');}">
                        <button class="lb-advice-send" title="${t('spec.adviceSend')}" onclick="game.ui.sendAdvice('${ai.id}')">➤</button>
                        ${r.adviceCount ? `<span class="lb-advice-badge" title="${t('spec.advicePending')}">✎ ${r.adviceCount}</span>` : ''}
                    </div>` : ''}
                </div>
            `;
        });

        listEl.innerHTML = html;
    }

    onAdviceInput(aiId, value) {
        this._adviceDrafts = this._adviceDrafts || {};
        this._adviceDrafts[aiId] = value;
    }

    sendAdvice(aiId) {
        this._adviceDrafts = this._adviceDrafts || {};
        // Exact-match the card's input (data-ai) — never a substring query, so
        // advice can't be read from or routed to the wrong model's card.
        const input = document.querySelector(`.lb-advice-input[data-ai="${CSS.escape(aiId)}"]`);
        // The draft is the source of truth (kept in sync on every keystroke); fall
        // back to the live input value only if no draft exists yet.
        const text = (this._adviceDrafts[aiId] || (input ? input.value : '') || '').trim();
        if (!text) return;
        const ok = this.game.openAIAIManager && this.game.openAIAIManager.addAdvice(aiId, text);
        this._adviceDrafts[aiId] = '';
        if (input) { input.value = ''; input.blur(); }
        if (ok) this.updateSpectatorPlayerList();
    }

    // Spectator play/pause for a model. Resuming is instant; pausing asks first,
    // since a paused model skips its turns and falls behind (a real disadvantage).
    togglePauseModel(aiId) {
        const mgr = this.game.openAIAIManager;
        if (!mgr) return;
        if (mgr.isPaused(aiId)) {
            mgr.setPaused(aiId, false);
            this.updateSpectatorPlayerList();
            return;
        }
        const ctrl = mgr.aiControllers.find(c => c.id === aiId);
        const name = ctrl && ctrl.model ? ctrl.model.name : '';
        this.showConfirm(
            t('dlg.pauseBody', { name: this.escapeHtml(name) }),
            () => { mgr.setPaused(aiId, true); this.updateSpectatorPlayerList(); },
            { title: t('dlg.pauseTitle'), confirmLabel: t('dlg.pauseConfirm'), cancelLabel: t('dlg.cancel') }
        );
    }

    // ----------------------------------------------------------------
    // Arena benchmark summary
    // ----------------------------------------------------------------
    summaryReasonText(reason) {
        const key = 'sum.reason.' + reason;
        return t(key) !== key ? t(key) : t('sum.reason.gameover');
    }

    // Transparent 0-100 strategical-soundness composite (see legend on screen).
    computeSoundness(rep) {
        const m = rep.metrics;
        if (!m) return 0;
        const distinct = Object.keys(m.actionCounts).length;
        const diversity = Math.min(distinct / 6, 1);
        const progression = Math.min(1,
            (rep.ageIdx / 3) * 0.5 +
            Math.min(Math.max(rep.buildings - 1, 0), 5) / 5 * 0.3 +
            Math.min(rep.military, 10) / 10 * 0.2);
        const score = 100 * (
            0.34 * m.successRate +
            0.20 * progression +
            0.18 * m.formatOk +
            0.15 * m.reliability +
            0.13 * diversity);
        return Math.round(Math.max(0, Math.min(100, score)));
    }

    computeBehaviorTags(rep) {
        const m = rep.metrics;
        const tags = [];
        const avgS = m.avgLatency / 1000;
        if (avgS > 0 && avgS < 8) tags.push({ t: t('tag.fast'), cls: 'good' });
        else if (avgS >= 30) tags.push({ t: t('tag.slow'), cls: 'warn' });
        if (m.timeouts >= 2) tags.push({ t: t('tag.timeouts'), cls: 'bad' });
        if (m.responded > 0 && m.formatOk >= 0.95) tags.push({ t: t('tag.formatLoyal'), cls: 'good' });
        else if (m.responded > 0 && m.formatOk < 0.7) tags.push({ t: t('tag.formatIssues'), cls: 'bad' });
        if (m.invalidActions >= 2) tags.push({ t: t('tag.inventsActions'), cls: 'bad' });
        if (m.attempted >= 3 && m.successRate >= 0.8) tags.push({ t: t('tag.efficient'), cls: 'good' });
        else if (m.attempted >= 3 && m.successRate < 0.5) tags.push({ t: t('tag.manyFails'), cls: 'warn' });
        const distinct = Object.keys(m.actionCounts).length;
        if (distinct >= 5) tags.push({ t: t('tag.versatile'), cls: 'good' });
        else if (m.attempted >= 4 && distinct <= 2) tags.push({ t: t('tag.monotonous'), cls: 'warn' });
        const ac = m.actionCounts;
        const mil = (ac.train_unit || 0) + (ac.attack_target || 0) + (ac.move_units || 0);
        const eco = (ac.train_worker || 0) + (ac.harvest_resource || 0) + (ac.build_structure || 0);
        if (mil > eco && mil > 0) tags.push({ t: t('tag.aggressive'), cls: 'neutral' });
        else if (eco > mil && eco > 0) tags.push({ t: t('tag.ecoFocus'), cls: 'neutral' });
        if (!tags.length) tags.push({ t: '—', cls: 'neutral' });
        return tags;
    }

    showArenaSummary(winnerAi, reason) {
        const game = this.game;
        const players = game.aiManager ? game.aiManager.aiPlayers : [];

        const durationMs = this.arenaStartTime ? (Date.now() - this.arenaStartTime) : 0;
        const dmin = Math.floor(durationMs / 60000);
        const dsec = Math.floor((durationMs % 60000) / 1000);
        const durStr = `${String(dmin).padStart(2, '0')}:${String(dsec).padStart(2, '0')}`;

        const civNames = {
            egyptian: t('civ.egyptian.name'), greek: t('civ.greek.name'),
            persian: t('civ.persian.name'), yamato: t('civ.yamato.name')
        };
        const ageNames = { stone: t('ageName.stone'), neolithic: t('ageName.neolithic'), bronze: t('ageName.bronze'), iron: t('ageName.iron') };

        const reports = players.map(ai => {
            const civ = getCivilization(ai.civilization);
            const colorHex = '#' + (civ?.color || 0xffffff).toString(16).padStart(6, '0');
            const controller = (game.openAIAIManager && game.openAIAIManager.aiControllers)
                ? game.openAIAIManager.aiControllers.find(c => c.id === ai.id) : null;
            const alive = !game.isPlayerEliminated(ai);
            const rep = {
                ai, isWinner: ai === winnerAi, alive,
                ageIdx: { stone: 0, neolithic: 1, bronze: 2, iron: 3 }[ai.age] || 0,
                civName: civNames[ai.civilization] || ai.civilization,
                ageName: ageNames[ai.age] || ai.age,
                color: this.legibleColor(colorHex),
                isLLM: !!controller,
                model: controller ? controller.model.name : t('spec.rulebased'),
                workers: ai.units.filter(u => u.type === 'worker').length,
                military: ai.units.filter(u => u.type !== 'worker').length,
                buildings: ai.buildings.length,
                food: Math.floor(ai.resources.food), wood: Math.floor(ai.resources.wood),
                stone: Math.floor(ai.resources.stone), gold: Math.floor(ai.resources.gold),
                power: this.spectatorPowerScore(ai)
            };
            if (controller && controller.stats) {
                const st = controller.stats;
                const lat = st.latencies;
                const avg = lat.length ? lat.reduce((a, b) => a + b, 0) / lat.length : 0;
                const responded = Math.max(0, st.requests - st.timeouts - st.networkErrors);
                rep.metrics = {
                    decisions: st.requests, responded,
                    avgLatency: avg,
                    minLatency: lat.length ? Math.min(...lat) : 0,
                    maxLatency: lat.length ? Math.max(...lat) : 0,
                    timeouts: st.timeouts, networkErrors: st.networkErrors, parseFails: st.parseFails,
                    invalidActions: st.invalidActions, rejected: st.actionsRejected,
                    attempted: st.actionsAttempted, succeeded: st.actionsSucceeded,
                    successRate: st.actionsAttempted ? st.actionsSucceeded / st.actionsAttempted : 0,
                    formatOk: responded > 0 ? (responded - st.parseFails) / responded : 0,
                    reliability: st.requests ? 1 - (st.timeouts + st.networkErrors) / st.requests : 0,
                    reasonRate: st.actionsAttempted ? st.reasonsGiven / st.actionsAttempted : 0,
                    actionCounts: st.actionCounts
                };
                rep.soundness = this.computeSoundness(rep);
                rep.tags = this.computeBehaviorTags(rep);
            }
            return rep;
        });

        reports.sort((a, b) => (b.isWinner - a.isWinner) || (b.alive - a.alive) || (b.power - a.power));

        // Winner banner
        const wEl = document.getElementById('summaryWinner');
        if (winnerAi) {
            const wr = reports.find(r => r.ai === winnerAi);
            wEl.innerHTML = `
                <div class="winner-card" style="--civ:${wr.color}">
                    <div class="winner-crown">\u{1F451}</div>
                    <div class="winner-text">
                        <div class="winner-model">${this.escapeHtml(wr.model)}</div>
                        <div class="winner-civ">${wr.civName} · ${wr.isLLM ? 'LLM' : t('spec.rulebased')}</div>
                    </div>
                    <div class="winner-score">${wr.power}<span>${t('sum.points')}</span></div>
                </div>`;
        } else {
            wEl.innerHTML = `<div class="winner-card draw"><div class="winner-text"><div class="winner-model">${t('sum.noWinner')}</div><div class="winner-civ">${t('sum.reason.mutual_destruction')}</div></div></div>`;
        }

        document.getElementById('summarySub').innerHTML =
            `${this.summaryReasonText(reason)} &nbsp;·&nbsp; ${t('sum.duration')} ${durStr} &nbsp;·&nbsp; ${t('sum.models', { n: players.length })}`;

        let html = '';
        reports.forEach((r, idx) => {
            const rank = idx + 1;
            const m = r.metrics;
            if (!r.isLLM || !m) {
                html += `
                    <div class="sum-card${r.isWinner ? ' winner' : ''}${r.alive ? '' : ' dead'}" style="--civ:${r.color}">
                        <div class="sum-card-head">
                            <span class="sum-rank">${rank}</span>
                            <div class="sum-id"><div class="sum-model">${this.escapeHtml(r.model)}</div><div class="sum-civ">${r.civName}</div></div>
                            <span class="sum-power">${r.power}</span>
                        </div>
                        <div class="sum-note">${t('sum.ruleNote')}</div>
                        <div class="sum-final">${r.ageName} · \u{1F477} ${r.workers} · ⚔️ ${r.military} · \u{1F3DB}️ ${r.buildings}${r.alive ? '' : ` · <b style="color:#ff6b81">${t('spec.defeated')}</b>`}</div>
                    </div>`;
                return;
            }
            const avgS = m.avgLatency / 1000;
            const errTotal = m.timeouts + m.networkErrors + m.parseFails + m.invalidActions + m.rejected;
            const tagsHtml = r.tags.map(t => `<span class="sum-tag ${t.cls}">${t.t}</span>`).join('');
            const topActions = Object.entries(m.actionCounts).sort((a, b) => b[1] - a[1]).slice(0, 6)
                .map(([k, v]) => `<span class="sum-chip">${k.replace(/_/g, ' ')}·${v}</span>`).join('');
            html += `
                <div class="sum-card${r.isWinner ? ' winner' : ''}${r.alive ? '' : ' dead'}" style="--civ:${r.color}">
                    <div class="sum-card-head">
                        <span class="sum-rank">${rank}</span>
                        <div class="sum-id"><div class="sum-model">${this.escapeHtml(r.model)}</div><div class="sum-civ">${r.civName}${r.alive ? '' : ` · <b style="color:#ff6b81">${t('spec.defeated')}</b>`}</div></div>
                        <span class="sum-power" title="${t('sum.endScore')}">${r.power}</span>
                    </div>
                    <div class="sum-sound">
                        <div class="sum-sound-bar"><div class="sum-sound-fill" style="width:${r.soundness}%"></div></div>
                        <div class="sum-sound-val">${r.soundness}<span>${t('sum.strategySuffix')}</span></div>
                    </div>
                    <div class="sum-tags">${tagsHtml}</div>
                    <div class="sum-metrics">
                        <div class="sum-metric"><span>⏱ ${t('sum.mResponse')}</span><b>${avgS.toFixed(1)}s</b><i>${(m.minLatency / 1000).toFixed(1)}–${(m.maxLatency / 1000).toFixed(1)}s</i></div>
                        <div class="sum-metric"><span>\u{1F9E0} ${t('sum.mDecisions')}</span><b>${m.decisions}</b><i>${t('sum.mAnswered', { n: m.responded })}</i></div>
                        <div class="sum-metric"><span>✅ ${t('sum.mSuccess')}</span><b>${Math.round(m.successRate * 100)}%</b><i>${m.succeeded}/${m.attempted}</i></div>
                        <div class="sum-metric"><span>\u{1F4CB} ${t('sum.mFormat')}</span><b>${Math.round(m.formatOk * 100)}%</b><i>${t('sum.mJsonOk')}</i></div>
                        <div class="sum-metric"><span>\u{1F4AC} ${t('sum.mReasons')}</span><b>${Math.round(m.reasonRate * 100)}%</b><i>${t('sum.mOfMoves')}</i></div>
                        <div class="sum-metric${errTotal ? ' err' : ''}"><span>⚠️ ${t('sum.mErrors')}</span><b>${errTotal}</b><i>${t('sum.errBreak', { to: m.timeouts, parse: m.parseFails, inv: m.invalidActions, rej: m.rejected })}</i></div>
                    </div>
                    <div class="sum-actions">${topActions || `<span class="sum-chip">${t('sum.noActions')}</span>`}</div>
                    <div class="sum-final">${r.ageName} · \u{1F477} ${r.workers} · ⚔️ ${r.military} · \u{1F3DB}️ ${r.buildings} · \u{1F356}${r.food} \u{1F332}${r.wood} \u{1FAA8}${r.stone} \u{1F947}${r.gold}</div>
                </div>`;
        });
        document.getElementById('summaryGrid').innerHTML = html;

        document.getElementById('summaryLegend').textContent = t('sum.legend');

        // Keep the computed report so the spectator can save it to a file.
        this._lastSummary = { reports, reason, durStr, playerCount: players.length };

        this.showScreen('arenaSummaryScreen');
    }

    // Build a human-readable Markdown report of the last match.
    buildResultsMarkdown(summary) {
        const { reports, reason, durStr, playerCount } = summary;
        const d = new Date();
        const pad = n => String(n).padStart(2, '0');
        const human = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

        const L = [];
        L.push(`# LLM Colosseum — Arena Results`);
        L.push('');
        L.push(`- **Date:** ${human}`);
        L.push(`- **Outcome:** ${this.summaryReasonText(reason)}`);
        L.push(`- **Duration:** ${durStr}`);
        L.push(`- **Players:** ${playerCount}`);

        const winner = reports.find(r => r.isWinner);
        L.push(`- **Winner:** ${winner ? `${winner.model} (${winner.civName}, ${winner.isLLM ? 'LLM' : 'rule-based'}) — ${winner.power} pts` : 'none (draw)'}`);
        L.push('');

        L.push(`## Ranking`);
        L.push('');
        reports.forEach((r, idx) => {
            const rank = idx + 1;
            const flags = [r.isWinner ? '🏆 winner' : null, r.alive ? null : 'defeated'].filter(Boolean);
            L.push(`### ${rank}. ${r.model} — ${r.civName}${flags.length ? ` _(${flags.join(', ')})_` : ''}`);
            L.push('');
            L.push(`- Controller: ${r.isLLM ? 'LLM' : 'rule-based AI'}`);
            L.push(`- End power score: ${r.power}`);
            L.push(`- Final state: ${r.ageName} age · ${r.workers} workers · ${r.military} military · ${r.buildings} buildings`);
            L.push(`- Resources: ${r.food} food · ${r.wood} wood · ${r.stone} stone · ${r.gold} gold`);
            const m = r.metrics;
            if (r.isLLM && m) {
                L.push(`- Strategy score: ${r.soundness}/100`);
                L.push(`- Decisions: ${m.decisions} (answered ${m.responded})`);
                L.push(`- Success rate: ${Math.round(m.successRate * 100)}% (${m.succeeded}/${m.attempted})`);
                L.push(`- Format fidelity: ${Math.round(m.formatOk * 100)}%`);
                L.push(`- Reasoning rate: ${Math.round(m.reasonRate * 100)}%`);
                L.push(`- Reliability: ${Math.round(m.reliability * 100)}%`);
                L.push(`- Latency: avg ${(m.avgLatency / 1000).toFixed(1)}s (min ${(m.minLatency / 1000).toFixed(1)}s, max ${(m.maxLatency / 1000).toFixed(1)}s)`);
                L.push(`- Errors: timeouts ${m.timeouts} · network ${m.networkErrors} · parse ${m.parseFails} · invalid ${m.invalidActions} · rejected ${m.rejected}`);
                if (r.tags && r.tags.length) L.push(`- Behavior: ${r.tags.map(x => x.t).join(', ')}`);
                const actions = Object.entries(m.actionCounts || {}).sort((a, b) => b[1] - a[1])
                    .map(([k, v]) => `${k}·${v}`).join(', ');
                if (actions) L.push(`- Actions used: ${actions}`);
            }
            L.push('');
        });

        L.push('---');
        L.push(`_Generated by LLM Colosseum. Non-scientific testbed — tempo, map and sample size all affect outcomes._`);
        L.push('');
        return L.join('\n');
    }

    // Save the last match's results as results_<dateTime>.md (client-side download).
    downloadArenaResults() {
        if (!this._lastSummary) { this.showErrorMessage(t('sum.saveNoData')); return; }
        try {
            const md = this.buildResultsMarkdown(this._lastSummary);
            const d = new Date();
            const pad = n => String(n).padStart(2, '0');
            const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
            const blob = new Blob([md], { type: 'text/markdown' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `results_${stamp}.md`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            this.showInfoMessage(t('sum.saveDone'));
        } catch (e) {
            this.showErrorMessage(t('sum.saveFailed'));
        }
    }
}
