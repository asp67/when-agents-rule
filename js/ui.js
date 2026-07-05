// UI Manager for game menus and interfaces
class UIManager {
    constructor(game) {
        this.game = game;
        this.activeMenu = null;
        // Bump when the canonical default prompt changes. On mismatch the shared
        // template is refreshed and slots that merely carried a COPY of the old
        // template are re-derived; genuine per-slot edits are preserved.
        this.ARENA_PROMPT_VERSION = 'unified-v9';
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

    showGameModeSelection() {
        this.showScreen('gameModeScreen');
    }

    showArenaSetup() {
        this._setupMode = 'arena';
        this.showScreen('arenaSetupScreen');
        this.populateArenaSetup();
    }

    // Campaign uses the SAME setup screen as the Arena, but configured for a human
    // player: a "You" civ picker, a 1–5 opponent-count selector, and opponent slots
    // (each a civilization + a model or the rule-based AI).
    showCampaignSetup() {
        this._setupMode = 'campaign';
        this.showScreen('arenaSetupScreen');
        this.populateArenaSetup();
    }

    // Return to whichever setup screen the user came from (Arena or Campaign).
    backToSetup() {
        if (this._setupMode === 'campaign') this.showCampaignSetup();
        else this.showArenaSetup();
    }

    // Build the setup screen from the saved config(s). The model library and the
    // prompt template are shared between Arena and Campaign; only the participant
    // slots and a couple of campaign-only controls differ.
    // Config is kept in memory so navigating to/from the library page preserves edits.
    async populateArenaSetup() {
        if (!this._setupMode) this._setupMode = 'arena';
        if (!this._arenaConfig) this._arenaConfig = await this.loadArenaConfig();
        const campaign = this._setupMode === 'campaign';
        if (campaign && !this._campaignConfig) this._campaignConfig = this.loadCampaignConfig();
        this.applySetupLabels(campaign);
        this.renderSetupOptions();
        this.renderArenaSlots();
        this.updateLibrarySummary();
        const ta = document.getElementById('arenaSharedPrompt');
        if (ta) ta.value = this._arenaConfig.prompt || this.getArenaDefaultPrompt();
    }

    // Swap the screen's heading/subtitle/section-2/start-button text between the
    // Arena and Campaign wording. We move the data-i18n key (not just textContent)
    // so a later language switch re-translates to the correct mode's strings.
    applySetupLabels(campaign) {
        const set = (id, key) => { const el = document.getElementById(id); if (el) { el.setAttribute('data-i18n', key); el.textContent = t(key); } };
        set('setupTitle', campaign ? 'cmp.title' : 'ar.title');
        set('setupSubtitle', campaign ? 'cmp.subtitle' : 'ar.subtitle');
        set('setupStep2H', campaign ? 'cmp.step2.h' : 'ar.step2.h');
        set('setupStep2P', campaign ? 'cmp.step2.p' : 'ar.step2.p');
        set('setupStartBtn', campaign ? 'cmp.start' : 'ar.start');
    }

    // Render the setup options row: a participant/opponent count picker for both
    // modes (Campaign 1–5 opponents, Arena 2–4 participants) plus, in Campaign
    // only, the "You play" civ picker.
    renderSetupOptions() {
        const campaign = this._setupMode === 'campaign';
        const row = document.getElementById('campaignSetupRow');
        if (row) row.style.display = '';
        const civField = document.getElementById('playerCivField');
        if (civField) civField.style.display = campaign ? '' : 'none';
        if (campaign) {
            const civNames = { egyptian: t('civ.egyptian.name'), greek: t('civ.greek.name'), persian: t('civ.persian.name'), yamato: t('civ.yamato.name') };
            const civSel = document.getElementById('campaignPlayerCiv');
            if (civSel) civSel.innerHTML = Object.keys(civNames).map(c => `<option value="${c}" ${this._campaignConfig.playerCiv === c ? 'selected' : ''}>${civNames[c]}</option>`).join('');
        }
        // Count label text differs (Opponents vs Participants).
        const lbl = document.getElementById('setupCountLabel');
        if (lbl) { const key = campaign ? 'cmp.count' : 'ar.count'; lbl.setAttribute('data-i18n', key); lbl.textContent = t(key); }
        const opts = campaign ? [1, 2, 3, 4, 5] : [2, 3, 4];
        const cur = this.setupSlotCount();
        const cntSel = document.getElementById('setupCount');
        if (cntSel) cntSel.innerHTML = opts.map(n => `<option value="${n}" ${cur === n ? 'selected' : ''}>${n}</option>`).join('');
        // Optional map seed (per mode config): same seed => identical map, for fair
        // A/B comparisons between models. Empty = a fresh random map every game.
        const seedEl = document.getElementById('setupSeed');
        if (seedEl) seedEl.value = (campaign ? this._campaignConfig.seed : this._arenaConfig.seed) || '';
        // Map/difficulty lives on the setup screens (shared global setting).
        const diffEl = document.getElementById('setupDifficulty');
        if (diffEl && typeof getDifficulty === 'function') diffEl.value = getDifficulty();
    }

    setSetupSeed(v) {
        const cfg = this._setupMode === 'campaign' ? this._campaignConfig : this._arenaConfig;
        if (cfg) { cfg.seed = String(v || '').trim(); this.saveSetup(); }
    }

    // The active mode's map seed, or null for a random map.
    setupSeed() {
        const cfg = this._setupMode === 'campaign' ? this._campaignConfig : this._arenaConfig;
        const s = cfg && typeof cfg.seed === 'string' ? cfg.seed.trim() : '';
        return s || null;
    }

    setCampaignPlayerCiv(v) { if (this._campaignConfig) { this._campaignConfig.playerCiv = v; this.saveSetup(); } }
    // Set the participant/opponent count for the active mode (clamped per mode).
    setSetupCount(v) {
        const campaign = this._setupMode === 'campaign';
        const n = campaign
            ? Math.min(5, Math.max(1, parseInt(v, 10) || 3))
            : Math.min(4, Math.max(2, parseInt(v, 10) || 4));
        if (campaign) this._campaignConfig.count = n; else this._arenaConfig.count = n;
        const sel = document.getElementById('setupCount');
        if (sel && sel.value !== String(n)) sel.value = String(n);
        this.saveSetup();
        this.renderArenaSlots();
    }

    // Active participant-slot array for the current setup mode.
    setupSlots() { return this._setupMode === 'campaign' ? this._campaignConfig.slots : this._arenaConfig.slots; }
    // How many of those slots are actually in play (Campaign `count` opponents,
    // Arena `count` participants — defaults to 4 if unset).
    setupSlotCount() { return this._setupMode === 'campaign' ? this._campaignConfig.count : (this._arenaConfig.count || 4); }

    saveSetup() { this.saveArenaConfig(); this.saveCampaignConfig(); }

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
    // Canonical default LLM prompt: the single source of truth lives in
    // OpenAIAIManager.defaultSystemPrompt(), so the text shown and stored here is
    // exactly what the harness serves. Placeholders {{civilization}}, {{bonus}}
    // and {{players}} are resolved per match when the prompt is built.
    getArenaDefaultPrompt() {
        return OpenAIAIManager.defaultSystemPrompt();
    }

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
            // Per-model context budget in tokens. Sizes the rolling chat history sent
            // each turn (bigger budget = longer memory for big-context models) and is
            // also used as Ollama's num_ctx. '' = default (32768). Lower = much faster.
            contextSize: opts.contextSize || '',
            // false = full multi-turn rolling history (Option C, cacheable, richer).
            // true  = minimize tokens: compact one-line move history (Option A).
            minimizeTokens: opts.minimizeTokens || false,
            maxContext: opts.maxContext || null, // discovered model max (for the ↺ button/prefill)
            language: opts.language || 'en',   // language the model reasons/answers in (independent of GUI)
            availableModels: [],
            availableModelContext: {},          // model id -> context length, from the last test (runtime only)
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
        m.minimizeTokens = !!m.minimizeTokens;
        if (m.maxContext == null) m.maxContext = null;
        m.availableModelContext = {}; // runtime-only; never trust stored values
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
            // First run: start with one empty model card ready to be configured.
            // (The old models.json seeding is gone along with that legacy file.)
            const models = [this.makeArenaModel({})];
            cfg = {
                models,
                slots: ['egyptian', 'greek', 'persian', 'yamato'].map((civ, i) => ({ civ, control: models[i] ? models[i].id : 'ki' })),
                prompt: this.getArenaDefaultPrompt()
            };
        } else {
            // Re-key ids deterministically and normalize.
            cfg.models.forEach(m => { m.id = this.nextArenaModelId(); this.normalizeArenaModel(m); });
        }

        // Shared template saved under an older default: replace it with the
        // current canonical text. Keep the OLD stored template around so slot
        // prompts that are mere copies of it can be told apart from real edits.
        const oldTemplate = cfg.prompt;
        if (localStorage.getItem('arenaPromptVersion') !== this.ARENA_PROMPT_VERSION || !cfg.prompt) {
            cfg.prompt = this.getArenaDefaultPrompt();
        }

        // Always exactly 4 slots; remap controls onto valid model ids.
        const civs = ['egyptian', 'greek', 'persian', 'yamato'];
        const ids = cfg.models.map(m => m.id);
        if (!Array.isArray(cfg.slots) || cfg.slots.length !== 4) {
            cfg.slots = civs.map((civ, i) => ({ civ, control: cfg.models[i] ? cfg.models[i].id : 'ki', prompt: null }));
        } else {
            cfg.slots.forEach((s, i) => {
                if (!s.civ) s.civ = civs[i];
                // saved control ids no longer match the re-keyed ids → map by position
                if (s.control !== 'ki' && !ids.includes(s.control)) {
                    s.control = cfg.models[i] ? cfg.models[i].id : 'ki';
                }
                // DERIVE-unless-edited: null means the slot follows the shared
                // template (always the current one). A stored prompt that merely
                // equals the template — including the OLD template it was copied
                // from before a version bump — is re-derived; real edits survive.
                if (typeof s.prompt !== 'string' || !s.prompt.trim() ||
                    s.prompt === cfg.prompt || s.prompt === oldTemplate) s.prompt = null;
            });
        }
        // Number of participants actually in play (2–4; the pool is always 4 slots).
        cfg.count = Math.min(4, Math.max(2, parseInt(cfg.count, 10) || 4));
        // Optional map seed (persisted with the config).
        cfg.seed = typeof cfg.seed === 'string' ? cfg.seed : '';
        // Always start participant slots collapsed (and diff panels closed) for a
        // clean overview on load.
        cfg.slots.forEach(s => { s._collapsed = true; s._diffOpen = false; });
        return cfg;
    }

    // A clean, serialisable copy of the catalogue (drops runtime-only fields like
    // cached tokens, test status and expand state). Real secrets ARE kept.
    serializeArenaConfig() {
        const clone = JSON.parse(JSON.stringify(this._arenaConfig));
        clone.models.forEach(m => { if (m.auth) { delete m.auth._token; delete m.auth._tokenExp; } m._status = null; delete m._expanded; delete m.availableModelContext; });
        return clone;
    }

    saveArenaConfig() {
        if (!this._arenaConfig) return;
        try {
            localStorage.setItem('arenaConfigV2', JSON.stringify(this.serializeArenaConfig()));
            localStorage.setItem('arenaPromptVersion', this.ARENA_PROMPT_VERSION);
        } catch (e) {}
    }

    // Campaign config: the human's civ, opponent count (1–5) and a pool of 5
    // opponent slots (civ + control). Models and the prompt template are shared
    // with the Arena config, so only these campaign-specific fields are stored here.
    loadCampaignConfig() {
        let cc = null;
        try { const s = localStorage.getItem('campaignConfigV1'); if (s) cc = JSON.parse(s); } catch (e) {}
        const civs = ['greek', 'persian', 'yamato', 'egyptian', 'greek'];
        if (!cc || !Array.isArray(cc.slots)) {
            cc = { playerCiv: 'egyptian', count: 3, slots: civs.map(c => ({ civ: c, control: 'ki', prompt: null })) };
        }
        // Always keep a pool of exactly 5 slots so raising the count never adds blanks.
        while (cc.slots.length < 5) cc.slots.push({ civ: civs[cc.slots.length] || 'greek', control: 'ki', prompt: null });
        cc.slots = cc.slots.slice(0, 5);
        // DERIVE-unless-edited (mirrors loadArenaConfig): empty or template-equal
        // prompts become null so campaign opponents follow the current default too.
        const tmpl = (this._arenaConfig && this._arenaConfig.prompt) || this.getArenaDefaultPrompt();
        cc.slots.forEach(s => {
            if (typeof s.prompt !== 'string' || !s.prompt.trim() || s.prompt === tmpl) s.prompt = null;
            s._diffOpen = false; // diff panels always start closed
        });
        cc.playerCiv = cc.playerCiv || 'egyptian';
        cc.count = Math.min(5, Math.max(1, parseInt(cc.count, 10) || 3));
        cc.seed = typeof cc.seed === 'string' ? cc.seed : '';
        // Drop control ids that no longer match a model in the (shared) library.
        const ids = (this._arenaConfig ? this._arenaConfig.models : []).map(m => m.id);
        cc.slots.forEach(s => {
            if (!s.civ) s.civ = 'greek';
            if (s.control !== 'ki' && !ids.includes(s.control)) s.control = 'ki';
            s._collapsed = true; // start collapsed for a clean overview
        });
        return cc;
    }

    saveCampaignConfig() {
        if (!this._campaignConfig) return;
        try {
            const clone = JSON.parse(JSON.stringify(this._campaignConfig));
            clone.slots.forEach(s => { delete s._collapsed; });
            localStorage.setItem('campaignConfigV1', JSON.stringify(clone));
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
                <div class="arena-field" style="flex:0 0 210px"><label>${t('ar.fContextBudget')}</label>
                    <div class="ctx-budget-row">
                        <input type="number" min="512" step="512" value="${e(m.contextSize)}" oninput="game.ui.setModelField(${m.id},'contextSize',this.value)" placeholder="32768">
                        <button class="ctx-max-btn" title="${t('ar.ctxMaxTitle')}" onclick="game.ui.resetModelContextToMax(${m.id})">${t('ar.ctxMax')}</button>
                    </div></div>
                <div class="arena-field" style="flex:0 0 170px"><label>${t('ar.fModelLang')}</label>
                    <select onchange="game.ui.setModelField(${m.id},'language',this.value)">${langOpts}</select></div>
            </div>
            <label class="ctx-mini-toggle"><input type="checkbox" ${m.minimizeTokens ? 'checked' : ''} onchange="game.ui.setModelBool(${m.id},'minimizeTokens',this.checked)"> ${t('ar.minimizeTokens')}</label>
            <p class="auth-hint">${t('ar.maxTokensHint')}</p>
            <p class="auth-hint">${t('ar.contextBudgetHint')}</p>
            <p class="auth-hint">${t('ar.minimizeTokensHint')}</p>
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
                <input type="text" class="secret-input" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" value="${e(a.key)}" oninput="game.ui.setAuthField(${m.id},'key',this.value)" placeholder="sk-…"></div>`;
        }
        if (a.type === 'basic') {
            return `<div class="auth-grid">
                <div class="arena-field"><label>${t('ar.fUser')}</label>
                    <input type="text" value="${e(a.username)}" oninput="game.ui.setAuthField(${m.id},'username',this.value)"></div>
                <div class="arena-field"><label>${t('ar.fPass')}</label>
                    <input type="text" class="secret-input" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" value="${e(a.password)}" oninput="game.ui.setAuthField(${m.id},'password',this.value)"></div>
            </div>`;
        }
        if (a.type === 'header') {
            const rows = (a.headers.length ? a.headers : [{ name: '', value: '' }]).map((h, idx) => `
                <div class="header-row">
                    <input type="text" value="${e(h.name)}" oninput="game.ui.setAuthHeaderField(${m.id},${idx},'name',this.value)" placeholder="${t('ar.fHeaderName')}">
                    <input type="text" class="secret-input" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" value="${e(h.value)}" oninput="game.ui.setAuthHeaderField(${m.id},${idx},'value',this.value)" placeholder="${t('ar.fHeaderVal')}">
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
                    <input type="text" class="secret-input" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" value="${e(a.accessToken)}" oninput="game.ui.setAuthField(${m.id},'accessToken',this.value)" placeholder="${t('ar.fTokenPh')}"></div>
                <div class="auth-divider">${t('ar.oauthOr')}</div>
                <div class="arena-field full"><label>${t('ar.fTokenUrl')}</label>
                    <input type="text" value="${e(a.tokenUrl)}" oninput="game.ui.setAuthField(${m.id},'tokenUrl',this.value)" placeholder="https://auth.example.com/oauth/token"></div>
                <div class="arena-field"><label>${t('ar.fClientId')}</label>
                    <input type="text" value="${e(a.clientId)}" oninput="game.ui.setAuthField(${m.id},'clientId',this.value)"></div>
                <div class="arena-field"><label>${t('ar.fClientSecret')}</label>
                    <input type="text" class="secret-input" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" value="${e(a.clientSecret)}" oninput="game.ui.setAuthField(${m.id},'clientSecret',this.value)"></div>
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
        const campaign = this._setupMode === 'campaign';
        const slotTitle = (i) => campaign ? t('cmp.opp', { n: i + 1 }) : t('ar.slot', { n: i + 1 });
        list.innerHTML = this.setupSlots().slice(0, this.setupSlotCount()).map((slot, i) => {
            const civOpts = Object.keys(civNames).map(c => `<option value="${c}" ${slot.civ === c ? 'selected' : ''}>${civNames[c]}</option>`).join('');
            const modelOpts = models.map((mm, mi) => `<option value="${mm.id}" ${slot.control === mm.id ? 'selected' : ''}>${e((mm.name && mm.name.trim()) ? mm.name : (t('ar.unnamed') + ' ' + (mi + 1)))}</option>`).join('');
            const isLLM = slot.control !== 'ki';
            const promptBlock = isLLM ? `
                <div class="arena-field slot-prompt">
                    <label>${t('ar.slotPrompt')}</label>
                    <textarea id="slotPromptTa${i}" rows="6" class="arena-prompt-textarea" oninput="game.ui.setSlotPrompt(${i}, this.value)" placeholder="System prompt …">${e(slot.prompt != null ? slot.prompt : (this._arenaConfig.prompt || ''))}</textarea>
                    <div class="slot-prompt-btns">
                        <button class="hdr-add-btn" onclick="game.ui.resetSlotPrompt(${i})">${t('ar.slotPromptReset')}</button>
                        <button class="hdr-add-btn" id="slotDiffBtn${i}" style="${slot.prompt != null ? '' : 'display:none'}" onclick="game.ui.toggleSlotDiff(${i})">${slot._diffOpen ? t('ar.slotDiffHide') : t('ar.slotDiffShow')}</button>
                    </div>
                    ${(slot._diffOpen && slot.prompt != null) ? `<div class="slot-diff" id="slotDiff${i}">${this.renderSlotDiffHtml(slot)}</div>` : ''}
                </div>` : '';
            const collapsed = slot._collapsed !== false; // default collapsed
            // Compact summary shown on the collapsed header: civ + who controls it.
            const ctrlModel = isLLM ? models.find(mm => mm.id === slot.control) : null;
            const ctrlName = isLLM
                ? (ctrlModel ? ((ctrlModel.name && ctrlModel.name.trim()) ? ctrlModel.name : t('ar.unnamed')) : t('ar.controlKi'))
                : t('ar.controlKi');
            const body = `
                <div class="arena-slot-body">
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
            return `
            <div class="arena-slot ${collapsed ? 'collapsed' : 'expanded'}${isLLM ? ' has-prompt' : ''}" style="--civ:${civColor[slot.civ] || '#888'}">
                <div class="arena-slot-head" onclick="game.ui.toggleArenaSlot(${i})">
                    <span class="arena-slot-caret">▶</span>
                    <span class="arena-slot-title">${slotTitle(i)}</span>
                    <span class="arena-slot-summary">${civNames[slot.civ] || slot.civ} · ${e(ctrlName)}</span>
                    <span class="slot-prompt-badge" id="slotPromptBadge${i}" title="${t('ar.promptEditedTitle')}" style="${isLLM && slot.prompt != null ? '' : 'display:none'}">✎ ${t('ar.promptEdited')}</span>
                </div>
                ${collapsed ? '' : body}
            </div>`;
        }).join('');
    }

    toggleArenaSlot(i) {
        const s = this.setupSlots()[i];
        if (s) { s._collapsed = s._collapsed === false; this.renderArenaSlots(); }
    }

    // --- Handlers ---
    setModelField(id, field, value) { const m = this.getArenaModel(id); if (m) { m[field] = value; this.saveArenaConfig(); } }
    setModelBool(id, field, value) { const m = this.getArenaModel(id); if (m) { m[field] = !!value; this.saveArenaConfig(); } }

    // Fill the context budget with the model's maximum context window. Tries (in
    // order) the per-model context map captured during the last connection test, a
    // built-in table of known commercial-model windows, then a live Ollama /api/show.
    async resetModelContextToMax(id) {
        const m = this.getArenaModel(id);
        if (!m) return;
        const prov = (m.provider && m.provider !== 'auto') ? m.provider : OpenAIAIManager.detectProvider(m.endpoint);
        let max = (m.availableModelContext && m.availableModelContext[m.model]) ||
                  OpenAIAIManager.knownContextWindow(m.model, prov);
        if (!max && prov === 'ollama' && (m.model || '').trim()) {
            max = await OpenAIAIManager.fetchOllamaContext(m.endpoint, m.model, this.cleanAuth(m.auth));
        }
        if (max && max >= 512) {
            m.contextSize = max;
            m.maxContext = max;
            this.saveArenaConfig();
            this.renderArenaLibrary();
        } else {
            // Couldn't detect — flag it on the model's status line so the user knows.
            m._status = { cls: 'err', text: t('ar.ctxMaxUnknown') };
            this.renderArenaLibrary();
        }
    }
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
        // The model library is SHARED with Campaign — sweep its opponent slots too,
        // or they keep pointing at the deleted model until the next full reload.
        if (this._campaignConfig) {
            this._campaignConfig.slots.forEach(s => { if (s.control === id) s.control = 'ki'; });
            this.saveCampaignConfig();
        }
        this.saveArenaConfig();
        this.renderArenaLibrary();
        this.renderArenaSlots();
        this.updateLibrarySummary();
    }

    setSlotCiv(i, value) { const s = this.setupSlots()[i]; if (s) { s.civ = value; this.saveSetup(); this.renderArenaSlots(); } }
    setSlotControl(i, value) {
        const s = this.setupSlots()[i];
        if (!s) return;
        s.control = (value === 'ki') ? 'ki' : Number(value);
        // Becoming an LLM slot? make sure it has a prompt (seed from the template).
        if (s.control !== 'ki' && (typeof s.prompt !== 'string' || !s.prompt.trim())) {
            s.prompt = this._arenaConfig.prompt || this.getArenaDefaultPrompt();
        }
        this.saveSetup();
        this.renderArenaSlots(); // show/hide the per-slot prompt editor
    }
    // Line-based LCS diff (zero-dependency). Returns ops over the two texts:
    // {t:'same'|'add'|'del', s:line} — 'add' = line only in the edited text,
    // 'del' = template line the edit removed. Inputs are ~130 lines, so the
    // O(n·m) table is trivial (runs comfortably on every keystroke).
    diffLines(aText, bText) {
        const a = String(aText).split('\n'), b = String(bText).split('\n');
        const n = a.length, m = b.length;
        const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
        for (let i = n - 1; i >= 0; i--)
            for (let j = m - 1; j >= 0; j--)
                L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
        const ops = [];
        let i = 0, j = 0;
        while (i < n && j < m) {
            if (a[i] === b[j]) { ops.push({ t: 'same', s: a[i] }); i++; j++; }
            else if (L[i + 1][j] >= L[i][j + 1]) { ops.push({ t: 'del', s: a[i] }); i++; }
            else { ops.push({ t: 'add', s: b[j] }); j++; }
        }
        while (i < n) ops.push({ t: 'del', s: a[i++] });
        while (j < m) ops.push({ t: 'add', s: b[j++] });
        return ops;
    }

    // Unified-diff-style HTML for an edited slot vs. the CURRENT shared template:
    // changed lines ±2 context, hunks separated by ⋯ — so the panel answers
    // "what exactly does this opponent do differently?" without the full wall.
    renderSlotDiffHtml(slot) {
        const base = this._arenaConfig.prompt || '';
        const ops = this.diffLines(base, slot.prompt != null ? slot.prompt : base);
        if (!ops.some(o => o.t !== 'same')) return `<div class="diff-empty">${t('ar.slotDiffEmpty')}</div>`;
        const esc = (s) => this.escapeHtml(s);
        const CTX = 2;
        const show = new Array(ops.length).fill(false);
        ops.forEach((o, k) => {
            if (o.t === 'same') return;
            for (let d = -CTX; d <= CTX; d++) {
                const x = k + d;
                if (x >= 0 && x < ops.length) show[x] = true;
            }
        });
        let html = '', gap = false;
        ops.forEach((o, k) => {
            if (!show[k]) { gap = true; return; }
            if (gap) { html += `<div class="diff-sep">⋯</div>`; gap = false; }
            const cls = o.t === 'add' ? 'diff-add' : o.t === 'del' ? 'diff-del' : 'diff-ctx';
            const sign = o.t === 'add' ? '+' : o.t === 'del' ? '−' : '&nbsp;';
            html += `<div class="${cls}">${sign} ${esc(o.s) || '&nbsp;'}</div>`;
        });
        return html;
    }

    // Toggle the read-only diff panel under an edited slot's prompt. On open,
    // scroll the textarea to the first line that differs, so the user lands
    // directly on their edit.
    toggleSlotDiff(i) {
        const s = this.setupSlots()[i];
        if (!s) return;
        s._diffOpen = !s._diffOpen;
        this.renderArenaSlots();
        if (s._diffOpen && s.prompt != null) {
            const ops = this.diffLines(this._arenaConfig.prompt || '', s.prompt);
            let line = 0, first = -1;
            for (const o of ops) {
                if (o.t !== 'same' && first < 0) first = line;
                if (o.t !== 'del') line++; // 'same'/'add' advance the edited-text line counter
            }
            const ta = document.getElementById('slotPromptTa' + i);
            if (ta && first > 0) {
                const lh = parseFloat(getComputedStyle(ta).lineHeight) || 18;
                ta.scrollTop = Math.max(0, (first - 1) * lh);
            }
        }
    }

    // DERIVE-unless-edited: the slot stores a prompt ONLY while it differs from
    // the shared template. Typing the template text back (or resetting) returns
    // the slot to derived (null), so future default updates flow through. The
    // ✎ badge, the diff button and an open diff panel all track the state live
    // while typing.
    setSlotPrompt(i, value) {
        const s = this.setupSlots()[i];
        if (!s) return;
        const base = (this._arenaConfig.prompt || '').trim();
        const val = String(value);
        s.prompt = (val.trim() && val.trim() !== base) ? val : null;
        const edited = s.prompt != null;
        const badge = document.getElementById('slotPromptBadge' + i);
        if (badge) badge.style.display = edited ? '' : 'none';
        const diffBtn = document.getElementById('slotDiffBtn' + i);
        if (diffBtn) diffBtn.style.display = edited ? '' : 'none';
        const panel = document.getElementById('slotDiff' + i);
        if (panel) {
            if (edited) panel.innerHTML = this.renderSlotDiffHtml(s);
            else { panel.style.display = 'none'; s._diffOpen = false; }
        }
        this.saveSetup();
    }
    resetSlotPrompt(i) {
        const s = this.setupSlots()[i];
        if (!s) return;
        s.prompt = null; // back to derived: follows the shared template/default
        this.saveSetup();
        this.renderArenaSlots();
    }
    onTemplatePromptInput(value) { if (this._arenaConfig) { this._arenaConfig.prompt = value; this.saveArenaConfig(); } }
    applyTemplateToAllSlots() {
        const tmpl = (document.getElementById('arenaSharedPrompt') || {}).value || this._arenaConfig.prompt || '';
        this._arenaConfig.prompt = tmpl;
        this.setupSlots().forEach(s => { s.prompt = null; }); // every slot follows the template again
        this.saveSetup();
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
            // Remember each model's context window (when the endpoint reports it) for
            // the ↺ button, and prefill an empty budget with the selected model's max.
            m.availableModelContext = res.contextById || {};
            const detected = m.availableModelContext[m.model] || OpenAIAIManager.knownContextWindow(m.model, res.provider);
            if (detected) m.maxContext = detected;
            if ((m.contextSize === '' || m.contextSize == null) && detected) m.contextSize = detected;
            const n = m.availableModels.length;
            const provNote = res.provider ? ` [${res.provider}]` : '';
            m._status = { cls: 'ok', text: n ? t('ar.testOk', { prov: provNote, n }) : t('ar.testOkNoList', { prov: provNote }) };
        } else {
            // errorCode maps to a localized ar.err.* message; fall back to the raw
            // (English) error string for anything unmapped.
            const msg = res.errorCode ? t('ar.err.' + res.errorCode, { detail: res.errorDetail || '' }) : res.error;
            m._status = { cls: 'err', text: '✗ ' + msg };
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

    // Convert one participant slot into the engine's setup entry. A slot pointing
    // at the rule-based AI — or at a model with no endpoint — becomes type 'ki'.
    slotToSetupEntry(slot) {
        const cfg = this._arenaConfig;
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
                maxContext: (() => { const n = parseInt(m.maxContext, 10); return (n && n >= 512) ? n : null; })(),
                minimizeTokens: !!m.minimizeTokens,
                language: m.language || 'en',
                auth: this.cleanAuth(m.auth)
            }
        };
    }

    // Collect the setup the arena engine expects (first `count` participants, 2–4).
    collectArenaSetup() {
        const cfg = this._arenaConfig;
        const ta = document.getElementById('arenaSharedPrompt');
        if (ta) cfg.prompt = ta.value;
        this.saveArenaConfig();
        const n = Math.min(4, Math.max(2, cfg.count || 4));
        return cfg.slots.slice(0, n).map(slot => this.slotToSetupEntry(slot));
    }

    // Collect the campaign setup: the human's civ + the chosen opponents.
    collectCampaignSetup() {
        const ta = document.getElementById('arenaSharedPrompt');
        if (ta) this._arenaConfig.prompt = ta.value;
        this.saveSetup();
        const cc = this._campaignConfig;
        return {
            playerCiv: cc.playerCiv,
            opponents: cc.slots.slice(0, cc.count).map(slot => this.slotToSetupEntry(slot))
        };
    }

    // Reset the template AND every per-slot prompt to the current default
    // (slots become derived — they follow the template from here on).
    resetArenaPrompts() {
        const def = this.getArenaDefaultPrompt();
        if (this._arenaConfig) {
            this._arenaConfig.prompt = def;
            this._arenaConfig.slots.forEach(s => { s.prompt = null; });
        }
        if (this._campaignConfig) this._campaignConfig.slots.forEach(s => { s.prompt = null; });
        const ta = document.getElementById('arenaSharedPrompt');
        if (ta) ta.value = def;
        this.saveSetup();
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

    showBuildMenu() {
        this.closeMenus();
        const menu = document.getElementById('buildMenu');
        const content = document.getElementById('buildMenuContent');

        let html = '';

        // ALWAYS the full catalogue, regardless of what is selected. This used to
        // switch to a per-building subset (TC selected → no tower/town center/
        // wonder; barracks/stable selected → tower only), which read as "the build
        // list sometimes doesn't appear". Locked entries render greyed with a 🔒
        // and their unlock condition instead of being hidden.
        const buildings = this.getDefaultBuildings();

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
                    // Pass THIS building's instance id: with several Town Centers /
                    // barracks the unit must be produced (and spawn) at the one whose
                    // menu the player is using, not at the first free one found.
                    const action = `game.trainUnit('${unitId}', '${building.id}')`;
                    // Combat-relevant stats so the pick isn't blind: HP, attack,
                    // speed, range (support units heal — no attack figure shown).
                    const isSupport = unitDef.type === 'support';
                    const stats = [
                        `❤️${unitDef.health}`,
                        ...(isSupport ? [] : [`⚔️${unitDef.attack}`]),
                        `💨${unitDef.speed}`,
                        ...(unitDef.range > 1 ? [`🎯${unitDef.range}`] : [])
                    ].join('  ');
                    const statsTitle = [
                        t('ui.health'),
                        ...(isSupport ? [] : [t('ui.attack')]),
                        t('ui.speed'),
                        ...(unitDef.range > 1 ? [t('ui.range')] : [])
                    ].join(' · ');
                    html += `
                        <div class="menu-item ${canAfford ? '' : 'disabled'}" onclick="${canAfford ? action : ''}" data-locked="0" data-action="${action}" data-cost='${JSON.stringify(unitDef.cost)}'>
                            <h4>${tg(unitDef.name)}${tierLabel}</h4>
                            <p>${tg(unitDef.description)}</p>
                            <p class="unit-stats" title="${statsTitle}">${stats}</p>
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
        
        // Costs come from the shared AGE_COSTS table (civilizations.js) — this menu
        // previously showed (and gated affordability on) HIGHER numbers than the
        // engine actually charges, blocking the human while AI players advanced.
        const ages = [
            { id: 'stone', name: t('age.stone'), cost: null },
            { id: 'neolithic', name: t('age.neolithic'), cost: AGE_COSTS.neolithic },
            { id: 'bronze', name: t('age.bronze'), cost: AGE_COSTS.bronze },
            { id: 'iron', name: t('age.iron'), cost: AGE_COSTS.iron }
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
                description: wonderDef.description ? tg(wonderDef.description) : t('wonder.descFallback', { s: (this.game.wonderRequired || 600) }),
                requiredAge: wonderDef.requiredAge || 'iron'
            });
        }
        // Show the WHOLE catalogue: entries locked by age or an unresearched tech
        // stay in the list and render greyed with a 🔒 + their unlock condition
        // (the menu renderer handles that). Only buildings this civilization can
        // NEVER unlock (required tech absent from its tech tree) are dropped.
        return allBuildings.filter(b => !(b.requiresTech && !(civ?.techTree || {})[b.requiresTech]));
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
        if (!infoDiv) return;
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

    // Single-player footer: shows who controls each rival (model name or rule-based),
    // so the player knows what they're up against. Hidden in the arena (it has its
    // own spectator dashboard). Refreshed when an opponent falls back to rule-based.
    updateOpponentsPanel() {
        const el = document.getElementById('opponentsBar');
        if (!el) return;
        const ais = this.game.aiManager ? this.game.aiManager.aiPlayers : [];
        if (this.game.spectatorMode || !this.game.gameStarted || !ais.length) { el.style.display = 'none'; return; }
        const mgr = this.game.openAIAIManager;
        const civNames = { egyptian: t('civ.egyptian.name'), greek: t('civ.greek.name'), persian: t('civ.persian.name'), yamato: t('civ.yamato.name') };
        const civColor = { egyptian: '#ffd700', greek: '#4ecca3', persian: '#e94560', yamato: '#9b8cff' };
        const rows = ais.map(ai => {
            const ctrl = (mgr && mgr.aiControllers) ? mgr.aiControllers.find(c => c.id === ai.id) : null;
            const who = ctrl
                ? ((ctrl.model && ctrl.model.name && ctrl.model.name.trim()) ? ctrl.model.name : t('ar.unnamed'))
                : t('opp.ruleBased');
            const civ = civNames[ai.civilization] || ai.civilization;
            const color = civColor[ai.civilization] || '#888';
            return `<span class="opp-row"><b style="color:${color}">${this.escapeHtml(civ)}</b>: ${this.escapeHtml(who)}</span>`;
        }).join('');
        el.innerHTML = `<span class="opp-title">${t('opp.title')}</span>${rows}`;
        el.style.display = '';
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
        const holdSecs = this.game && this.game.wonderRequired ? this.game.wonderRequired : 600;
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
        // Skip dashboard DOM work while the tab is hidden — the background driver
        // keeps the SIMULATION running, but nobody is looking at the leaderboard.
        this._spectatorIntervals.push(setInterval(() => { if (!document.hidden) this.updateSpectatorPlayerList(); }, 1500));
        this._spectatorIntervals.push(setInterval(() => { if (!document.hidden) this.updateDecisionLog(); }, 1000));
        this._spectatorIntervals.push(setInterval(() => { if (!document.hidden) this.updateArenaStatus(); }, 1000));
    }

    // Stop spectator refresh timers (call when leaving the arena)
    teardownSpectatorUI() {
        document.body.classList.remove('spectator-mode');
        if (this._spectatorIntervals) this._spectatorIntervals.forEach(id => clearInterval(id));
        this._spectatorIntervals = [];
        if (this.closeLbFlyout) this.closeLbFlyout(); // no flyout floating over the summary
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
            const reqMs = (this.game.wonderRequired || 600) * 1000;
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

    // Compact token counts for the summary: 830 -> "830", 12480 -> "12.5k", 1.2M.
    fmtTokens(n) {
        n = Math.max(0, Math.round(n || 0));
        if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
        if (n >= 100000) return Math.round(n / 1000) + 'k';
        if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
        return String(n);
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
                <div class="lb-card rank-${rank}${isLeader ? ' leader' : ''}${r.alive ? '' : ' eliminated'}${r.paused ? ' paused' : ''}" style="--civ: ${this.legibleColor(r.colorHex)}" data-ai="${ai.id}" onclick="game.focusCameraOnAI('${ai.id}')" title="${t('spec.cardHint')}">
                    <div class="lb-fly-tab" title="${t('spec.flyTabTitle')}" onclick="event.stopPropagation(); game.ui.openLbFlyout('${ai.id}')">◀</div>
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

        // Keep an open achievements flyout live: refresh its content and keep it
        // anchored to its card (rank order can shuffle cards around).
        if (this._lbFlyoutAi) {
            const flyAi = this.game.aiManager.aiPlayers.find(a => a.id === this._lbFlyoutAi);
            if (flyAi) { this.renderLbFlyout(flyAi); this.positionLbFlyout(); }
            else this.closeLbFlyout();
        }
    }

    // ---- Leaderboard achievement flyout --------------------------------------
    // Click a card → flyout with that player's achievements (age, completed
    // researches, unit and building breakdown). One at a time; clicking the same
    // card toggles it, any click elsewhere closes it.
    openLbFlyout(aiId) {
        const ai = this.game.aiManager.aiPlayers.find(a => a.id === aiId);
        if (!ai) return;
        if (this._lbFlyoutAi === aiId) { this.closeLbFlyout(); return; } // toggle
        this._lbFlyoutAi = aiId;
        if (!this._lbFlyoutEl) {
            const el = document.createElement('div');
            el.className = 'lb-flyout';
            document.body.appendChild(el);
            this._lbFlyoutEl = el;
            // Auto-close on any press elsewhere. Capture phase, so it runs before
            // the pressed element's own handlers; only presses inside the flyout
            // or on a flyout TAB (whose own onclick opens/toggles) are exempt —
            // a press on the card body counts as "elsewhere" and closes it.
            document.addEventListener('mousedown', (e) => {
                if (!this._lbFlyoutAi) return;
                if (this._lbFlyoutEl && this._lbFlyoutEl.contains(e.target)) return;
                if (e.target.closest && e.target.closest('.lb-fly-tab')) return;
                this.closeLbFlyout();
            }, true);
        }
        this.renderLbFlyout(ai);
        this._lbFlyoutEl.style.display = 'block';
        this.positionLbFlyout();
    }

    renderLbFlyout(ai) {
        const el = this._lbFlyoutEl;
        if (!el) return;
        const civ = getCivilization(ai.civilization);
        const controller = (this.game.openAIAIManager && this.game.openAIAIManager.aiControllers)
            ? this.game.openAIAIManager.aiControllers.find(c => c.id === ai.id) : null;
        const model = controller ? controller.model.name : t('spec.rulebased');
        const ageNames = { stone: t('age.stone'), neolithic: t('age.neolithic'), bronze: t('age.bronze'), iron: t('age.iron') };
        const civKey = 'civ.' + ai.civilization + '.name';
        const civName = t(civKey) !== civKey ? t(civKey) : ai.civilization;
        const esc = s => this.escapeHtml(s);

        // Completed researches (display names from the civ's tech tree)
        const techs = Object.keys(ai.researchedTechs || {})
            .map(id => (civ && civ.techTree && civ.techTree[id]) ? tg(civ.techTree[id].name) : id);

        // Units grouped by class
        const unitIcons = { worker: '👷', infantry: '⚔️', ranged: '🏹', cavalry: '🐎', support: '✚' };
        const unitGroups = {};
        ai.units.forEach(u => {
            const k = u.type === 'worker' ? 'worker' : (u.unitType || 'infantry');
            unitGroups[k] = (unitGroups[k] || 0) + 1;
        });
        const unitChips = Object.entries(unitGroups)
            .map(([k, n]) => `<span class="lb-fly-chip">${unitIcons[k] || '⚔️'} ${esc(k)} ×${n}</span>`).join('');

        // Buildings grouped by type; an "uc:" key prefix separates sites still
        // under construction from finished ones (rendered with a 🏗 marker).
        const bGroups = {};
        ai.buildings.forEach(b => {
            const def = (typeof getBuildingDef === 'function') ? getBuildingDef(b.type) : null;
            const name = b.isWonder ? tg(b.name) : (def ? tg(def.name) : b.type);
            const key = (b.underConstruction ? 'uc:' : 'ok:') + name;
            bGroups[key] = (bGroups[key] || 0) + 1;
        });
        const bChips = Object.entries(bGroups)
            .map(([k, n]) => {
                const uc = k.startsWith('uc:');
                return `<span class="lb-fly-chip">${uc ? '🏗 ' : ''}${esc(k.slice(3))} ×${n}</span>`;
            }).join('');

        const colorHex = '#' + ((civ && civ.color) || 0xffffff).toString(16).padStart(6, '0');
        el.innerHTML = `
            <div class="lb-fly-head" style="--civ:${this.legibleColor(colorHex)}">
                <b>${esc(model)}</b><span>${esc(civName)} · ${ageNames[ai.age] || ai.age}</span>
            </div>
            <div class="lb-fly-sec"><div class="lb-fly-h">🔬 ${t('spec.flyResearch')}</div>
                <div class="lb-fly-body">${techs.length ? techs.map(x => `<span class="lb-fly-chip">${esc(x)}</span>`).join('') : `<i>${t('spec.flyNone')}</i>`}</div></div>
            <div class="lb-fly-sec"><div class="lb-fly-h">👥 ${t('spec.flyUnits', { n: ai.units.length })}</div>
                <div class="lb-fly-body">${unitChips || `<i>${t('spec.flyNone')}</i>`}</div></div>
            <div class="lb-fly-sec"><div class="lb-fly-h">🏛️ ${t('spec.flyBuildings', { n: ai.buildings.length })}</div>
                <div class="lb-fly-body">${bChips || `<i>${t('spec.flyNone')}</i>`}</div></div>`;
    }

    positionLbFlyout() {
        const el = this._lbFlyoutEl;
        if (!el || !this._lbFlyoutAi) return;
        const card = document.querySelector(`.lb-card[data-ai="${CSS.escape(this._lbFlyoutAi)}"]`);
        if (!card) { this.closeLbFlyout(); return; }
        const r = card.getBoundingClientRect();
        el.style.right = (window.innerWidth - r.left + 10) + 'px';
        el.style.left = 'auto';
        el.style.top = Math.max(8, Math.min(window.innerHeight - el.offsetHeight - 8, r.top)) + 'px';
    }

    closeLbFlyout() {
        this._lbFlyoutAi = null;
        if (this._lbFlyoutEl) this._lbFlyoutEl.style.display = 'none';
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

    showArenaSummary(winnerAi, reason, opts = {}) {
        const game = this.game;
        // snapshot: a LIVE look at the standings mid-match (Results button). The
        // same rendering, but no winner is declared, terminal navigation is
        // hidden and a Back button returns to the still-running game.
        const snapshot = !!opts.snapshot;
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
                // Config snapshot for the results export (self-describing runs).
                // Deliberately NO endpoint/keys — results files get shared.
                modelConfig: controller ? {
                    provider: controller.model.provider || 'auto',
                    modelId: controller.model.model || '',
                    contextBudget: controller.model.contextSize || 32768,
                    minimizeTokens: !!controller.model.minimizeTokens,
                    language: controller.model.language || 'en'
                } : null,
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
                const ctxOv = st.contextOverflows || 0;
                const responded = Math.max(0, st.requests - st.timeouts - st.networkErrors - ctxOv);
                // Context overflows are lost turns caused by the HARNESS's budgeting,
                // not the endpoint — count them visibly but keep them out of the
                // model's reliability score (both numerator and denominator).
                const reliabilityBase = Math.max(0, st.requests - ctxOv);
                rep.metrics = {
                    decisions: st.requests, responded,
                    avgLatency: avg,
                    minLatency: lat.length ? Math.min(...lat) : 0,
                    maxLatency: lat.length ? Math.max(...lat) : 0,
                    timeouts: st.timeouts, networkErrors: st.networkErrors, parseFails: st.parseFails,
                    contextOverflows: ctxOv,
                    invalidActions: st.invalidActions, rejected: st.actionsRejected,
                    promptTokens: st.promptTokens || 0, completionTokens: st.completionTokens || 0,
                    attempted: st.actionsAttempted, succeeded: st.actionsSucceeded,
                    successRate: st.actionsAttempted ? st.actionsSucceeded / st.actionsAttempted : 0,
                    formatOk: responded > 0 ? (responded - st.parseFails) / responded : 0,
                    reliability: reliabilityBase ? 1 - (st.timeouts + st.networkErrors) / reliabilityBase : 0,
                    reasonRate: st.actionsAttempted ? st.reasonsGiven / st.actionsAttempted : 0,
                    actionCounts: st.actionCounts
                };
                rep.soundness = this.computeSoundness(rep);
                rep.tags = this.computeBehaviorTags(rep);
            }
            return rep;
        });

        reports.sort((a, b) => (b.isWinner - a.isWinner) || (b.alive - a.alive) || (b.power - a.power));

        // Winner banner — or, in snapshot mode, the CURRENT leader (no crown).
        const wEl = document.getElementById('summaryWinner');
        if (snapshot) {
            const lead = reports[0];
            wEl.innerHTML = lead ? `
                <div class="winner-card snapshot" style="--civ:${lead.color}">
                    <div class="winner-crown">📊</div>
                    <div class="winner-text">
                        <div class="winner-model">${this.escapeHtml(lead.model)}</div>
                        <div class="winner-civ">${lead.civName} · ${t('sum.snapLeader')}</div>
                    </div>
                    <div class="winner-score">${lead.power}<span>${t('sum.points')}</span></div>
                </div>` : '';
        } else if (winnerAi) {
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
            const errTotal = m.timeouts + m.networkErrors + m.parseFails + m.invalidActions + m.rejected + (m.contextOverflows || 0);
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
                        <div class="sum-metric"><span>\u{1FA99} ${t('sum.mTokens')}</span><b>${this.fmtTokens(m.promptTokens + m.completionTokens)}</b><i>${(m.promptTokens + m.completionTokens) ? t('sum.mTokSplit', { p: this.fmtTokens(m.promptTokens), c: this.fmtTokens(m.completionTokens) }) : t('sum.mTokNone')}</i></div>
                        <div class="sum-metric${errTotal ? ' err' : ''}"><span>⚠️ ${t('sum.mErrors')}</span><b>${errTotal}</b><i>${t('sum.errBreak', { to: m.timeouts, parse: m.parseFails, inv: m.invalidActions, rej: m.rejected, ctx: m.contextOverflows || 0 })}</i></div>
                    </div>
                    <div class="sum-actions">${topActions || `<span class="sum-chip">${t('sum.noActions')}</span>`}</div>
                    <div class="sum-final">${r.ageName} · \u{1F477} ${r.workers} · ⚔️ ${r.military} · \u{1F3DB}️ ${r.buildings} · \u{1F356}${r.food} \u{1F332}${r.wood} \u{1FAA8}${r.stone} \u{1F947}${r.gold}</div>
                </div>`;
        });
        document.getElementById('summaryGrid').innerHTML = html;

        document.getElementById('summaryLegend').textContent = t('sum.legend');

        // Keep the computed report so the spectator can save it to a file (a
        // snapshot export is correctly labeled by its reason; a real match end
        // re-renders and overwrites this with the final report).
        this._lastSummary = {
            reports, reason, durStr, playerCount: players.length,
            mapSeed: game.mapSeed || null,
            difficulty: game.difficulty || 'easy'
        };

        // Snapshot: Back returns to the running game; hide the terminal
        // navigation so a live match can't be abandoned by accident. A real end
        // (also when it fires WHILE a snapshot is open) restores the buttons.
        const backBtn = document.getElementById('summaryBackBtn');
        const newBtn = document.getElementById('summaryNewArenaBtn');
        const menuBtn = document.getElementById('summaryMenuBtn');
        if (backBtn) backBtn.style.display = snapshot ? '' : 'none';
        if (newBtn) newBtn.style.display = snapshot ? 'none' : '';
        if (menuBtn) menuBtn.style.display = snapshot ? 'none' : '';

        // Snapshot: OVERLAY the running game — gameScreen stays active underneath
        // and the .snapshot variant has a translucent backdrop, so the live match
        // shimmering through makes it unmistakable that this is an in-game stat
        // view. A real end keeps the normal exclusive screen switch.
        const sumEl = document.getElementById('arenaSummaryScreen');
        if (snapshot) {
            sumEl.classList.add('snapshot', 'active');
        } else {
            sumEl.classList.remove('snapshot');
            this.showScreen('arenaSummaryScreen');
        }
    }

    // Back from a snapshot overlay to the (still running) match.
    closeArenaSnapshot() {
        const sumEl = document.getElementById('arenaSummaryScreen');
        if (sumEl) sumEl.classList.remove('snapshot', 'active');
        const gs = document.getElementById('gameScreen');
        if (gs && this.game && this.game.gameStarted) gs.classList.add('active');
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
        L.push(`- **Difficulty:** ${summary.difficulty || 'easy'}`);
        L.push(`- **Map seed:** ${summary.mapSeed ? `\`${summary.mapSeed}\` (reproducible)` : 'random'}`);

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
            if (r.modelConfig) {
                const mc = r.modelConfig;
                L.push(`- Model config: provider ${mc.provider} · model \`${mc.modelId || 'auto'}\` · context budget ${mc.contextBudget} · history ${mc.minimizeTokens ? 'compact (minimize tokens)' : 'multi-turn'} · language ${mc.language}`);
            }
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
                L.push(`- Errors: timeouts ${m.timeouts} · network ${m.networkErrors} · parse ${m.parseFails} · invalid ${m.invalidActions} · rejected ${m.rejected} · context-overflows ${m.contextOverflows || 0}`);
            L.push(`- Tokens: ${(m.promptTokens + m.completionTokens) ? `${m.promptTokens} prompt + ${m.completionTokens} completion = ${m.promptTokens + m.completionTokens}` : 'not reported by endpoint'}`);
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
