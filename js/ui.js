// UI Manager for game menus and interfaces
class UIManager {
    // EINE Literalstelle fuer die Prompt-Version. Die Instanz kopiert sie sich,
    // und die Startseite kommt ohne Instanz an sie heran -- der UIManager
    // entsteht erst beim window-load-Ereignis, lange nachdem der Startbildschirm
    // steht. Beim Hochzaehlen also nur hier anfassen.
    static get ARENA_PROMPT_VERSION() { return 'agents-rule-v90'; }

    constructor(game) {
        this.game = game;
        this.activeMenu = null;
        // Bump when the canonical default prompt changes. On mismatch the shared
        // template is refreshed and slots that merely carried a COPY of the old
        // template are re-derived; genuine per-slot edits are preserved.
        this.ARENA_PROMPT_VERSION = UIManager.ARENA_PROMPT_VERSION;
        // Last resort only: the match a hosted copy opens with is the one flagged
        // default in samples/index.json, and this is what it falls back to if that
        // index cannot be read at all. Kept in step with that flag, so the two can
        // never name different matches. samples/ holds several now; the full set and
        // its metadata are in that index, which is what a picker has to read because
        // GitHub Pages cannot list a directory.
        this.SAMPLE_MATCH = '2026-08-17_qwen3.8-opus4.6-qwen3.6-muse-glimmer_125min.jsonl';
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
        // renderSetupOptions too, not just the slots. It builds the difficulty table and
        // the campaign civ picker by writing t() straight into innerHTML, which no
        // data-i18n attribute can reach — so those two were the only things on the setup
        // screen that stayed in the previous language until the page was reloaded.
        // Calling the parent rather than renderDifficultyTable covers the civ names as
        // well, and covers whatever dynamic control is added there next.
        if (this._arenaConfig && active('arenaSetupScreen')) {
            this.renderSetupOptions();
            this.renderArenaSlots();
            this.updateLibrarySummary();
            // The diff button's label and the panel's empty-message are written by JS,
            // so they are the same kind of thing renderSetupOptions was missing.
            this.renderTemplateDiff();
        }

        // Refresh live HUD bits immediately (they also refresh each tick).
        try {
            if (this.game && this.game.player) {
                this.updateResources(this.game.player.resources);
                this.updateAge(this.game.player.age);
            }
        } catch (e) {}
        // The Town Center banners are TEXTURES with the civ name painted into them, so
        // they are the one piece of text on screen that no DOM pass can reach. The
        // renderer re-bakes them once its cache is empty.
        try {
            const rnd = this.game && this.game.renderer;
            if (rnd && rnd.invalidateBanners) rnd.invalidateBanners();
        } catch (e) {}

        // Force the spectator panels to rebuild on next update.
        this._lastLogSig = null;
        // The fog knobs' tooltips name a seat, so data-i18n-title cannot reach them.
        this.refreshMinimapFogKnobs();
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
        this.renderTemplateDiff();
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
            // The human is seat 0 — show their team badge next to "You play".
            const dot = document.getElementById('playerCivDot');
            if (dot) dot.innerHTML = this.teamDotHtml(0, 12);
        }
        // Count label text differs (Opponents vs Participants).
        const lbl = document.getElementById('setupCountLabel');
        if (lbl) { const key = campaign ? 'cmp.count' : 'ar.count'; lbl.setAttribute('data-i18n', key); lbl.textContent = t(key); }
        // The description swaps with it — "how many seats" and "how many rivals" are not
        // the same sentence, and a hint left describing the other mode is worse than none.
        const cHint = document.getElementById('setupCountHint');
        if (cHint) { const k = campaign ? 'cmp.countHint' : 'ar.countHint'; cHint.setAttribute('data-i18n', k); cHint.textContent = t(k); }
        this.renderDifficultyTable();
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
        // Turn-based is an ARENA setting: it only means anything when seats are
        // competing for turns, so the campaign screen hides it entirely.
        const tbWrap = document.getElementById('setupTurnBased');
        if (tbWrap) {
            tbWrap.checked = !!(this._arenaConfig && this._arenaConfig.turnBased);
            const field = tbWrap.closest('.arena-field');
            if (field) field.style.display = campaign ? 'none' : '';
        }
        const rt = document.getElementById('setupRoundTimeout');
        if (rt) rt.value = this.roundTimeoutSeconds();
        this.syncRoundTimeoutEnabled();
    }

    setTurnBased(on) {
        if (this._arenaConfig) { this._arenaConfig.turnBased = !!on; this.saveSetup(); }
        this.syncRoundTimeoutEnabled();
    }

    turnBasedEnabled() { return !!(this._arenaConfig && this._arenaConfig.turnBased); }

    // The deadline is only meaningful in turn-based mode, so the input follows the
    // checkbox rather than sitting there implying it does something in real time.
    syncRoundTimeoutEnabled() {
        const rt = document.getElementById('setupRoundTimeout');
        if (!rt) return;
        const on = this.turnBasedEnabled();
        rt.disabled = !on;
        const wrap = rt.closest('.arena-subfield');
        if (wrap) wrap.classList.toggle('is-off', !on);
    }

    // Seconds a seat gets to answer before the round resolves without it. Stored in
    // seconds because that is the unit on screen and in clock.secondsToAnswer; the one
    // conversion to ms lives in roundTimeoutMs() so the number the model is told and
    // the number that is enforced cannot drift apart.
    roundTimeoutSeconds() {
        const def = OpenAIAIManager.ROUND_TIMEOUT_DEFAULT_MS / 1000;
        const n = parseInt(this._arenaConfig && this._arenaConfig.roundTimeoutSec, 10);
        return (n && n > 0) ? n : def;
    }

    roundTimeoutMs() { return this.roundTimeoutSeconds() * 1000; }

    setRoundTimeout(v) {
        if (!this._arenaConfig) return;
        const lo = OpenAIAIManager.ROUND_TIMEOUT_MIN_MS / 1000;
        const hi = OpenAIAIManager.ROUND_TIMEOUT_MAX_MS / 1000;
        const n = parseInt(v, 10);
        // Clamp rather than reject: a typed "5" should become the floor, not silently
        // fall back to 90 and leave the field showing something it is not using.
        this._arenaConfig.roundTimeoutSec = isFinite(n) && n > 0
            ? Math.min(hi, Math.max(lo, n))
            : OpenAIAIManager.ROUND_TIMEOUT_DEFAULT_MS / 1000;
        this.saveSetup();
    }

    commitRoundTimeout(el) {
        this.setRoundTimeout(el && el.value);
        if (el) el.value = this.roundTimeoutSeconds();   // show what was actually stored
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
    // exactly what the harness serves. Placeholders {{civilization}}, {{bonus}},
    // {{players}} and {{terrain}} are resolved per match when the prompt is built.
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
            // Sampling knobs. '' means "don't send it", so the provider's own default for
            // that model applies — which is NOT the same as sending a number that happens
            // to match it today. All three are left blank by default.
            // Parameters this endpoint has been observed to refuse (see noteModelRejection).
            rejectedParams: opts.rejectedParams || {},
            // Extended thinking. One field, read against the resolved provider: an effort
            // word for OpenAI, a token budget for Anthropic and Google, on/off for Ollama.
            // '' = don't ask for it at all.
            reasoning: opts.reasoning != null ? opts.reasoning : '',
            // Raw JSON merged into the request body. The escape hatch for whatever this
            // harness does not model — kept as the typed TEXT so an unfinished edit is
            // still there when you come back to it, and parsed on the way out.
            extraBody: opts.extraBody != null ? opts.extraBody : '',
            temperature: opts.temperature != null ? opts.temperature : '',
            topP: opts.topP != null ? opts.topP : '',
            topK: opts.topK != null ? opts.topK : '',
            // Extensions, not OpenAI parameters. Empty stays empty on purpose: an
            // endpoint that does not know them rejects the whole request, so they
            // travel only when someone deliberately fills them in.
            minP: opts.minP != null ? opts.minP : '',
            presencePenalty: opts.presencePenalty != null ? opts.presencePenalty : '',
            repetitionPenalty: opts.repetitionPenalty != null ? opts.repetitionPenalty : '',
            // Per-model context budget in tokens. Sizes the rolling chat history sent
            // each turn (bigger budget = longer memory for big-context models) and is
            // also used as Ollama's num_ctx. '' = default (32768). Lower = much faster.
            contextSize: opts.contextSize || '',
            // false = full multi-turn rolling history (Option C, cacheable, richer).
            // true  = minimize tokens: compact one-line move history (Option A).
            minimizeTokens: opts.minimizeTokens || false,
            toolFallback: opts.toolFallback || false,
            maxContext: opts.maxContext || null, // discovered model max (for the ↺ button/prefill)
            language: opts.language || 'en',   // language the model reasons/answers in (independent of GUI)
            availableModels: [],
            availableModelContext: {},          // model id -> context length, from the last test (runtime only)
            _status: null,
            _expanded: false,
            auth: { type: 'none', key: '', username: '', password: '', headers: [], accessToken: '', tokenUrl: '', clientId: '', clientSecret: '', scope: '' }
        };
    }

    // A blank field means "do not send this parameter", which is different from sending
    // a number that matches the provider's current default. parseFloat rather than a
    // truthiness test because 0 is a legitimate value for temperature and top_p — "|| null"
    // would silently discard the most deliberate setting a user can pick. Out-of-range is
    // clamped, not dropped, so a typed 5 becomes the ceiling instead of vanishing.
    // What each difficulty actually changes, READ OFF the generator's own table rather
    // than restated here — a summary that is maintained by hand is a summary that ends up
    // lying, and this one would lie quietly. Ratios are against easy because that is what
    // a player compares; the scatter base cancels out, so only the multipliers are needed.
    // A resource with no entry (gold) is unchanged, which the row then says.
    // Parse the passthrough. Returns { value, error } — an object or null, plus a message
    // when the text is present and unusable, so the card can say so instead of the request
    // failing later for a reason that looks like the endpoint's fault.
    parseExtraBody(text) {
        const s = String(text == null ? '' : text).trim();
        if (!s) return { value: null, error: null };
        let v;
        try { v = JSON.parse(s); }
        catch (e) { return { value: null, error: t('ar.extraBodyBad') }; }
        if (!v || typeof v !== 'object' || Array.isArray(v)) return { value: null, error: t('ar.extraBodyNotObject') };
        const blocked = Object.keys(v).filter(k =>
            typeof OpenAIAIManager !== 'undefined' && OpenAIAIManager.EXTRA_BODY_PROTECTED.includes(k));
        if (blocked.length) return { value: null, error: t('ar.extraBodyProtected', { keys: blocked.join(', ') }) };
        return { value: v, error: null };
    }

    difficultyRows() {
        if (typeof DIFFICULTY_MODS === 'undefined') return [];
        const KEYS = ['food', 'wood', 'stone', 'gold'];
        const easy = DIFFICULTY_MODS.easy || {};
        const num = n => (Math.round(n * 1000) / 1000);
        return ['easy', 'medium', 'hard'].map(id => {
            const m = DIFFICULTY_MODS[id] || {};
            const parts = KEYS.map(k => {
                const base = easy[k] == null ? 1 : easy[k];
                const mine = m[k] == null ? 1 : m[k];
                const r = base ? mine / base : 1;
                return r === 1 ? null : `${t('resPlain.' + k)} ×${num(r)}`;
            }).filter(Boolean);
            return { id, name: t('ar.diffShort.' + id), parts };
        });
    }

    renderDifficultyTable() {
        const host = document.getElementById('setupDifficultyTable');
        if (!host) return;
        const cur = (typeof getDifficulty === 'function') ? getDifficulty() : 'easy';
        const rows = this.difficultyRows();
        if (!rows.length) { host.textContent = ''; return; }
        host.innerHTML = rows.map(r => {
            const what = r.parts.length ? r.parts.join(', ') : t('ar.diffBaseline');
            return `<div class="diff-row${r.id === cur ? ' is-current' : ''}">`
                 + `<b>${this.escapeHtml(r.name)}</b><span>${this.escapeHtml(what)}</span></div>`;
        }).join('') + `<div class="diff-note">${this.escapeHtml(t('ar.diffNote'))}</div>`;
    }

    numOrNull(v, lo, hi, intOnly) {
        if (v === '' || v == null) return null;
        let n = intOnly ? parseInt(v, 10) : parseFloat(v);
        if (!isFinite(n)) return null;
        n = Math.min(hi, Math.max(lo, n));
        return intOnly ? n : Math.round(n * 100) / 100;
    }

    // Called by the arena when an endpoint refuses a parameter mid-match. Stored on the
    // library entry so the card can say so, and so a later match does not spend a request
    // rediscovering it. Observed behaviour, not a guess from the model id — which is the
    // only sort of capability claim this file is willing to make.
    // What an endpoint told us about itself, kept on the library entry beside the
    // parameters it has refused. Same reasoning as noteModelRejection: an observation
    // that cost a round trip is worth more than the round trip, and rediscovering it
    // every match is how a cheap probe becomes an expensive one.
    //
    // Overwrites rather than merges. A rejection accumulates -- an endpoint that refused
    // top_k still refuses it -- but a capability report describes the server as it is
    // NOW, and a server whose model or flags changed must not carry its old answer
    // forward under a new configuration.
    noteModelCapabilities(libraryId, caps) {
        if (libraryId == null || !caps) return;
        // A probe that identified nothing is not a finding, it is a failed probe -- the
        // endpoint was down, or is a stack we do not know. Storing it would erase a good
        // answer from last week because the server happens to be off this minute.
        if (!caps.stack) return;
        const cfg = this._arenaConfig;
        const m = cfg && (cfg.models || []).find(x => x.id === libraryId);
        if (!m) return;
        m.capabilities = caps;
        this.saveArenaConfig();
        if (document.getElementById('modelLibraryList')) this.renderArenaLibrary();
    }

    // One line for the card: what this endpoint is, and the two things that decide
    // whether a seat will work at all -- can it call tools, and can its thinking be
    // steered. Silent when nothing was learned, so an unprobed or unknown endpoint
    // shows no worse than it did before there was a probe.
    capabilitySummary(m) {
        const c = m && m.capabilities;
        if (!c || !c.stack) return '';
        const bits = [c.stack];
        if (c.tools === false) bits.push('NO TOOL SUPPORT');
        else if (c.tools === true) bits.push('tools' + (c.parallelTools ? ' (parallel)' : ''));
        if (c.toolParser) bits.push(c.toolParser);
        if (c.reasoningControl === 'reasoning_effort') bits.push('thinking: graded');
        else if (c.reasoningControl === 'enable_thinking') bits.push('thinking: on/off only');
        else if (c.reasoningControl === 'think') bits.push('thinking: on/off only');
        if (c.contextLength) bits.push((c.contextLength / 1024).toFixed(0) + 'k ctx');
        return bits.join(' · ') + (c.note ? ' — ' + c.note : '');
    }

    noteModelRejection(libraryId, flags) {
        if (libraryId == null || !flags) return;
        const cfg = this._arenaConfig;
        const m = cfg && (cfg.models || []).find(x => x.id === libraryId);
        if (!m) return;
        m.rejectedParams = Object.assign({}, m.rejectedParams);
        let changed = false;
        Object.keys(flags).forEach(k => { if (!m.rejectedParams[k]) { m.rejectedParams[k] = true; changed = true; } });
        if (!changed) return;
        this.saveArenaConfig();
        if (document.getElementById('modelLibraryList')) this.renderArenaLibrary();
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
        ['temperature', 'topP', 'topK', 'minP', 'presencePenalty', 'repetitionPenalty',
         'reasoning', 'extraBody'].forEach(k => { if (m[k] == null) m[k] = ''; });
        if (!m.rejectedParams || typeof m.rejectedParams !== 'object') m.rejectedParams = {};
        if (m.contextSize == null) m.contextSize = '';
        m.minimizeTokens = !!m.minimizeTokens;
        m.toolFallback = !!m.toolFallback;
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
            const cfg = this.serializeArenaConfig();
            // rejectedParams is kept in localStorage on purpose — it saves a wasted
            // request every match — but it must NOT travel. It is an observation about
            // one endpoint on one machine, and "http://localhost:11434" in this catalogue
            // is a different server on yours. Shipping it would silently suppress
            // parameters that the recipient's endpoint accepts perfectly well, with only
            // a small tag to explain why. The settings a user CHOSE are exported; what
            // the harness merely learned is not.
            (cfg.models || []).forEach(m => { delete m.rejectedParams; });
            const payload = Object.assign({ app: 'When Agents Rule', kind: 'model-catalog', version: 2 }, cfg);
            const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'when-agents-rule-models.json';
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
                cfg.slots = civs.map((civ, i) => ({ civ, control: cfg.models[i] ? cfg.models[i].id : 'ki', prompt: null }));
            } else {
                cfg.slots.forEach((s, i) => {
                    if (!s.civ) s.civ = civs[i];
                    if (s.control !== 'ki' && !ids.includes(s.control)) s.control = cfg.models[i] ? cfg.models[i].id : 'ki';
                    // DERIVE-unless-edited (mirrors loadArenaConfig): catalogues
                    // exported under the old copy-in model carry template copies —
                    // re-derive those; only genuine per-slot edits stay stored.
                    if (typeof s.prompt !== 'string' || !s.prompt.trim() ||
                        s.prompt === cfg.prompt || s.prompt === this.getArenaDefaultPrompt()) s.prompt = null;
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

    // The label a model wears in the list. Shared with the sort, so the order you
    // see is the order of the text you see — deriving it twice is how a list ends
    // up sorted by something the reader cannot see.
    modelDisplayName(m, n) {
        return (m.name && m.name.trim()) ? m.name : `${t('ar.unnamed')} ${n || m.id}`;
    }

    // A VIEW setting, not a property of the catalog. It lives in its own storage key
    // rather than in _arenaConfig because the config is what export writes to a file:
    // a colleague importing your catalog should get your models, not your sort order.
    libSortMode() {
        try { return localStorage.getItem('libSort') === 'name' ? 'name' : 'added'; }
        catch (e) { return 'added'; }
    }

    setLibSort(mode) {
        try { localStorage.setItem('libSort', mode === 'name' ? 'name' : 'added'); }
        catch (e) { /* private browsing: the choice still applies to this session */ }
        this.renderArenaLibrary();
        this.renderArenaSlots();   // the seat pickers follow the same order
    }

    // Hidden below two models: there is no order to choose between, and a control
    // that cannot change anything still asks to be understood.
    renderLibSortBar(count) {
        if (count < 2) return '';
        const mode = this.libSortMode();
        const btn = (key, label) => `<button class="lib-sort-btn${mode === key ? ' on' : ''}" `
            + `onclick="game.ui.setLibSort('${key}')">${this.escapeHtml(label)}</button>`;
        return `<span class="lib-sort-label">${this.escapeHtml(t('ar.sortBy'))}</span>`
             + btn('added', t('ar.sortAdded')) + btn('name', t('ar.sortName'));
    }

    // Every model, in the order the user has asked to see models in, each carrying
    // the ordinal it was created with.
    //
    // The ordinal is taken BEFORE sorting and carried alongside. "Unnamed 3" is the
    // third model this catalog ever gained, not the third row on screen — otherwise
    // switching the sort would rename the very models that have no name to keep, and
    // two of them would swap identities in front of the user.
    //
    // ONE list for the library and for the seat pickers in arena setup. They used to
    // order themselves independently, so a model added while the library was sorted by
    // name sat in one place there and somewhere else in the dropdown that actually
    // assigns it to a seat — and the list you pick a seat from is the one where being
    // wrong costs something.
    orderedModels() {
        const rows = (this._arenaConfig.models || []).map((m, i) => ({ m, n: i + 1 }));
        if (this.libSortMode() === 'name') {
            // numeric, so "Unnamed 9" precedes "Unnamed 10" rather than following it.
            rows.sort((a, b) => this.modelDisplayName(a.m, a.n).localeCompare(
                this.modelDisplayName(b.m, b.n), undefined, { sensitivity: 'base', numeric: true }));
        }
        return rows;
    }

    // --- Rendering ---
    renderArenaLibrary() {
        const list = document.getElementById('modelLibraryList');
        if (!list) return;
        const models = this._arenaConfig.models;
        const rows = this.orderedModels();
        const bar = document.getElementById('libSortBar');
        if (bar) bar.innerHTML = this.renderLibSortBar(models.length);
        list.innerHTML = rows.length
            ? rows.map(r => this.renderModelCard(r.m, r.n)).join('')
            : `<p class="lib-empty">${t('ar.libEmpty')}</p>`;
    }

    renderModelCard(m, n) {
        const e = (s) => this.escapeHtml(s == null ? '' : String(s));
        // Default (unnamed) models show a LIVE translated fallback, never a baked-in
        // name, so the label follows the current GUI language.
        const displayName = this.modelDisplayName(m, n);
        const sel = (v) => m.auth.type === v ? 'selected' : '';
        const status = m._status ? `<span class="test-status ${m._status.cls}" id="modelStatus-${m.id}">${e(m._status.text)}</span>`
                                 : `<span class="test-status" id="modelStatus-${m.id}"></span>`;
        // What the endpoint said about itself when it was last tested. Empty until a
        // probe has run and empty for a stack we do not recognise, so a card is never
        // worse off than it was before this line existed. The two facts that earn the
        // space: whether tool calls work at all, and whether this model's thinking can
        // be dialled or only switched -- the second is the difference between tuning a
        // seat and discovering, slowly, that it has no knob.
        const capText = this.capabilitySummary(m);
        const capLine = capText ? `<div class="model-caps">${e(capText)}</div>` : '';
        // ONE control, not two. A <select> listing everything the endpoint returned
        // sat next to a free-text box for the same value -- and against OpenRouter that
        // select is several hundred entries, in whatever order the API answered, with no
        // way to filter and no way to type. Picking a model meant scrolling a wall of
        // ids looking for one you already knew the name of.
        //
        // A text input backed by a <datalist> does the whole job: typing filters on
        // SUBSTRING, so "qwen" finds "qwen/qwen3-max" where a native select's type-ahead
        // only ever matches from the first character -- which is useless when every id
        // begins with a vendor. Any id can still be typed by hand, which is what the
        // manual box was for, so nothing is lost by removing it.
        //
        // Stateless on purpose. renderModelCard rebuilds this HTML on every change, so a
        // custom dropdown widget would have its open state wiped mid-interaction; the
        // browser owns the popup here and survives the re-render.
        const modelIds = [...new Set(m.availableModels || [])]
            .sort((a, b) => String(a).localeCompare(String(b), undefined, { sensitivity: 'base' }));
        // Held for the filter, so typing never re-reads the DOM or the config.
        (this._mdlIds || (this._mdlIds = {}))[m.id] = modelIds;
        // Say which of three situations this is: nothing discovered yet, a value that
        // came from the list, or one that did not. The last case used to be a "(manual)"
        // option appended to the select, and it is the one worth keeping -- a typo and a
        // deliberate Ollama tag look identical otherwise.
        const modelNote = !modelIds.length
            ? `<span class="mdl-note">${e(t('ar.modelLoadHint'))}</span>`
            : (m.model && !modelIds.includes(m.model)
                ? `<span class="mdl-note warn">${e(t('ar.modelNotListed'))}</span>`
                : `<span class="mdl-note">${e(t('ar.modelPickHint', { n: modelIds.length }))}</span>`);
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
        // Show the value the endpoint would actually apply, per provider, instead of the
        // word "provider's". Where there is no single honest number (real OpenAI has no
        // top_k, Anthropic applies no top_p unless asked, Google's topK varies by model)
        // samplingDefaults returns null and the generic wording stands.
        const _defs = (typeof OpenAIAIManager !== 'undefined')
            ? OpenAIAIManager.samplingDefaults(OpenAIAIManager.resolveProvider(m))
            : { temperature: null, topP: null, topK: null };
        const defPh = {
            temperature: _defs.temperature != null ? _defs.temperature : t('ar.samplingDefault'),
            topP: _defs.topP != null ? _defs.topP : t('ar.samplingDefault'),
            topK: _defs.topK != null ? _defs.topK : t('ar.samplingDefault')
        };
        // What this endpoint has actually REFUSED in a past match. Observed, never
        // guessed from the model name — the only kind of capability claim worth showing.
        const rejected = (m.rejectedParams && typeof m.rejectedParams === 'object') ? m.rejectedParams : {};
        const REJ_LABEL = { omitTemperature: t('ar.fTemperature'), omitTopP: t('ar.fTopP'),
                            omitTopK: t('ar.fTopK'), omitReasoning: t('ar.fReasoning') };
        const rejectedTag = (flag) => rejected[flag]
            ? ` <span class="param-rejected" title="${this.escapeHtml(t('ar.paramRejectedTitle'))}">${t('ar.paramRejected')}</span>` : '';
        // Extended thinking looks different on every provider, so the control does too:
        // an effort word for OpenAI, a token budget for Anthropic and Google, on/off for
        // Ollama. Rendering the wrong one would invite a value the endpoint cannot use.
        const _prov = (typeof OpenAIAIManager !== 'undefined') ? OpenAIAIManager.resolveProvider(m) : 'openai';
        const _setF = `game.ui.setModelField(${m.id},'reasoning',this.value)`;
        const _opt = (v, label, sel) => `<option value="${v}" ${String(sel) === String(v) ? 'selected' : ''}>${label}</option>`;
        let reasoningControl, reasoningHintKey;
        if (_prov === 'openai') {
            reasoningHintKey = 'ar.reasoningHintOpenai';
            // Both dialects on one control: the effort words reach OpenAI's own reasoning
            // models, on/off reaches a Qwen behind vLLM or SGLang. Which one is sent
            // follows from which value is picked.
            reasoningControl = `<select onchange="${_setF}">${_opt('', t('ar.reasoningOff'), m.reasoning)}${
                OpenAIAIManager.REASONING_EFFORTS.map(v => _opt(v, v, m.reasoning)).join('')}${
                _opt('on', t('ar.thinkOn'), m.reasoning)}${_opt('off', t('ar.thinkOff'), m.reasoning)}</select>`;
        } else if (_prov === 'ollama') {
            reasoningHintKey = 'ar.reasoningHintOllama';
            reasoningControl = `<select onchange="${_setF}">${_opt('', t('ar.reasoningOff'), m.reasoning)}${
                _opt('on', t('ar.reasoningOn'), m.reasoning)}${_opt('off', t('ar.reasoningNo'), m.reasoning)}</select>`;
        } else {
            reasoningHintKey = _prov === 'google' ? 'ar.reasoningHintGoogle' : 'ar.reasoningHintAnthropic';
            reasoningControl = `<input type="number" step="256" min="${_prov === 'google' ? -1 : 1024}" value="${e(m.reasoning)}" oninput="${_setF}" placeholder="${t('ar.reasoningOff')}">`;
        }
        // Two Anthropic rules that a request cannot satisfy silently. Said here, on the
        // card, rather than discovered as a 400 mid-match — or worse, as a temperature
        // that appears to be set and is not.
        const extraBodyErr = this.parseExtraBody(m.extraBody).error;
        const _cap = parseInt(m.maxTokens, 10) || 2000;
        const _budget = parseInt(m.reasoning, 10);
        const _warn = [];
        if (_prov === 'anthropic' && isFinite(_budget) && _budget > 0) {
            if (typeof OpenAIAIManager !== 'undefined'
                && OpenAIAIManager.anthropicThinkingBudget(Math.max(1024, _budget), _cap) == null) {
                _warn.push(t('ar.thinkNeedsHeadroom', { cap: _cap, min: 1024 }));
            } else if (m.temperature !== '' || m.topP !== '' || m.topK !== '') {
                _warn.push(t('ar.thinkOverridesSampling'));
            }
        }
        const thinkingConflicts = _warn.length
            ? `<p class="auth-hint think-conflict">${_warn.map(w => this.escapeHtml(w)).join(' ')}</p>` : '';
        const rejectedNames = Object.keys(rejected).filter(k => REJ_LABEL[k]).map(k => REJ_LABEL[k]);
        const rejectedNote = rejectedNames.length
            ? `<p class="auth-hint param-rejected-note">${this.escapeHtml(t('ar.paramRejectedNote', { list: rejectedNames.join(', ') }))}</p>`
            : '';
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
            ${capLine}
            <div class="model-select-row">
                <div class="arena-field" style="flex:1 1 340px"><label>${t('ar.fModelSelect')}${modelNote}</label>
                    <div class="mdl-combo">
                        <input type="text" class="mdl-input" id="mdlIn-${m.id}" value="${e(m.model)}"
                            placeholder="model-id" autocomplete="off" spellcheck="false"
                            oninput="game.ui.mdlType(${m.id}, this.value)"
                            onfocus="game.ui.mdlShow(${m.id})"
                            onkeydown="game.ui.mdlKey(event, ${m.id})">
                        <button type="button" class="mdl-caret" tabindex="-1"
                            onclick="game.ui.mdlToggle(${m.id})">▾</button>
                        <div class="mdl-pop" id="mdlPop-${m.id}" hidden></div>
                    </div></div>
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
            <div class="model-select-row sampling-row">
                <div class="arena-field" style="flex:0 0 150px"><label>${t('ar.fTemperature')}${rejectedTag('omitTemperature')}</label>
                    <input type="number" min="0" max="2" step="0.05" value="${e(m.temperature)}" oninput="game.ui.setModelField(${m.id},'temperature',this.value)" placeholder="${e(defPh.temperature)}"></div>
                <div class="arena-field" style="flex:0 0 150px"><label>${t('ar.fTopP')}${rejectedTag('omitTopP')}</label>
                    <input type="number" min="0" max="1" step="0.05" value="${e(m.topP)}" oninput="game.ui.setModelField(${m.id},'topP',this.value)" placeholder="${e(defPh.topP)}"></div>
                <div class="arena-field" style="flex:0 0 150px"><label>${t('ar.fTopK')}${rejectedTag('omitTopK')}</label>
                    <input type="number" min="1" step="1" value="${e(m.topK)}" oninput="game.ui.setModelField(${m.id},'topK',this.value)" placeholder="${e(defPh.topK)}"></div>
            </div>
            <div class="model-select-row sampling-row">
                <div class="arena-field" style="flex:0 0 150px"><label>${t('ar.fMinP')}${rejectedTag('omitMinP')}</label>
                    <input type="number" min="0" max="1" step="0.01" value="${e(m.minP)}" oninput="game.ui.setModelField(${m.id},'minP',this.value)" placeholder="${e(t('ar.samplingDefault'))}"></div>
                <div class="arena-field" style="flex:0 0 150px"><label>${t('ar.fPresencePenalty')}${rejectedTag('omitPresencePenalty')}</label>
                    <input type="number" min="-2" max="2" step="0.1" value="${e(m.presencePenalty)}" oninput="game.ui.setModelField(${m.id},'presencePenalty',this.value)" placeholder="${e(t('ar.samplingDefault'))}"></div>
                <div class="arena-field" style="flex:0 0 150px"><label>${t('ar.fRepetitionPenalty')}${rejectedTag('omitRepetitionPenalty')}</label>
                    <input type="number" min="0" max="2" step="0.05" value="${e(m.repetitionPenalty)}" oninput="game.ui.setModelField(${m.id},'repetitionPenalty',this.value)" placeholder="${e(t('ar.samplingDefault'))}"></div>
            </div>
            <p class="auth-hint">${t('ar.samplingHint')}</p>
            <p class="auth-hint">${t('ar.samplingExtraHint')}</p>
            ${rejectedNote}
            <div class="model-select-row sampling-row">
                <div class="arena-field" style="flex:0 0 230px"><label>${t('ar.fReasoning')}${rejectedTag('omitReasoning')}</label>
                    ${reasoningControl}</div>
            </div>
            <p class="auth-hint">${t(reasoningHintKey)}</p>
            ${thinkingConflicts}
            <div class="model-select-row"><div class="arena-field">
                <label>${t('ar.fExtraBody')}</label>
                <textarea class="extra-body${extraBodyErr ? ' is-bad' : ''}" rows="2" spellcheck="false"
                    oninput="game.ui.setModelField(${m.id},'extraBody',this.value)"
                    placeholder='{"chat_template_kwargs": {"enable_thinking": true}}'>${e(m.extraBody)}</textarea>
            </div></div>
            <p class="auth-hint${extraBodyErr ? ' extra-body-err' : ''}">${extraBodyErr ? this.escapeHtml(extraBodyErr) : t('ar.extraBodyHint')}</p>
            <label class="ctx-mini-toggle"><input type="checkbox" ${m.minimizeTokens ? 'checked' : ''} onchange="game.ui.setModelBool(${m.id},'minimizeTokens',this.checked)"> ${t('ar.minimizeTokens')}</label>
            <p class="auth-hint">${t('ar.maxTokensHint')}</p>
            <p class="auth-hint">${t('ar.contextBudgetHint')}</p>
            <p class="auth-hint">${t('ar.minimizeTokensHint')}</p>
            <label class="ctx-mini-toggle"><input type="checkbox" ${m.toolFallback ? 'checked' : ''} onchange="game.ui.setModelBool(${m.id},'toolFallback',this.checked)"> ${t('ar.toolFallback')}</label>
            <p class="auth-hint">${t('ar.toolFallbackHint')}</p>
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
        // Same order as the library, and the same labels: modelDisplayName was the
        // third copy of "name, or 'Unnamed N'" in this file, and three copies of one
        // rule is how two of them come to disagree.
        const modelRows = this.orderedModels();
        const campaign = this._setupMode === 'campaign';
        const slotTitle = (i) => campaign ? t('cmp.opp', { n: i + 1 }) : t('ar.slot', { n: i + 1 });
        list.innerHTML = this.setupSlots().slice(0, this.setupSlotCount()).map((slot, i) => {
            const civOpts = Object.keys(civNames).map(c => `<option value="${c}" ${slot.civ === c ? 'selected' : ''}>${civNames[c]}</option>`).join('');
            const modelOpts = modelRows.map(({ m: mm, n: mn }) => `<option value="${mm.id}" ${slot.control === mm.id ? 'selected' : ''}>${e(this.modelDisplayName(mm, mn))}</option>`).join('');
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
            // modelDisplayName, so the collapsed seat header carries the SAME label as
            // the dropdown below it and the library behind it. It used to print a bare
            // "Unnamed model" with no ordinal, which meant three seats driven by three
            // different unconfigured models all read identically — on the one screen
            // whose job is to tell you who is playing what.
            const ctrlRow = isLLM ? modelRows.find(r => r.m.id === slot.control) : null;
            const ctrlName = ctrlRow ? this.modelDisplayName(ctrlRow.m, ctrlRow.n) : t('ar.controlKi');
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
            // Seat → team badge: arena slots are seats 0-3; campaign opponents
            // start at seat 1 (the human is seat 0, shown next to the civ picker).
            const seat = campaign ? i + 1 : i;
            return `
            <div class="arena-slot ${collapsed ? 'collapsed' : 'expanded'}${isLLM ? ' has-prompt' : ''}" style="--civ:${civColor[slot.civ] || '#888'}">
                <div class="arena-slot-head" onclick="game.ui.toggleArenaSlot(${i})">
                    <span class="arena-slot-caret">▶</span>
                    ${this.teamDotHtml(seat, 12)}
                    <span class="arena-slot-title">${slotTitle(i)}</span>
                    <span class="arena-slot-summary">${civNames[slot.civ] || slot.civ} · ${e(ctrlName)}</span>
                    <span class="slot-prompt-badge" id="slotPromptBadge${i}" title="${t('ar.promptEditedTitle')}" style="${isLLM && slot.prompt != null ? '' : 'display:none'}">✎ ${t('ar.promptEdited')}</span>
                </div>
                ${collapsed ? '' : body}
            </div>`;
        }).join('');
        this._afterSlotsRendered();
    }

    // Slot markup is built with the slot's OWN state; the derived case depends on the
    // template as well, so it is stamped on afterwards by the one function that knows.
    _afterSlotsRendered() { this.refreshDerivedSlotBadges(); }

    toggleArenaSlot(i) {
        const s = this.setupSlots()[i];
        if (s) { s._collapsed = s._collapsed === false; this.renderArenaSlots(); }
    }

    // --- Handlers ---
    setModelField(id, field, value) { const m = this.getArenaModel(id); if (m) { m[field] = value; this.saveArenaConfig(); } }
    setModelBool(id, field, value) { const m = this.getArenaModel(id); if (m) { m[field] = !!value; this.saveArenaConfig(); } }

    // Fill the context budget with the model's maximum context window. The
    // endpoint's own answers win: first the per-model context map captured during
    // the last connection test, then a live Ollama /api/show — authoritative for
    // local models, and tried under 'auto' too, because the URL heuristic misses
    // Ollama servers on custom ports/proxies (a non-Ollama server just 404s and
    // we fall through). The built-in table of known commercial windows is the
    // last resort, so a table guess can never mask the real loaded context.
    async resetModelContextToMax(id) {
        const m = this.getArenaModel(id);
        if (!m) return;
        const explicit = m.provider && m.provider !== 'auto';
        const prov = explicit ? m.provider : OpenAIAIManager.detectProvider(m.endpoint);
        let max = (m.availableModelContext && m.availableModelContext[m.model]) || null;
        if (!max && (m.model || '').trim() && (prov === 'ollama' || !explicit)) {
            max = await OpenAIAIManager.fetchOllamaContext(m.endpoint, m.model, this.cleanAuth(m.auth));
        }
        if (!max) max = OpenAIAIManager.knownContextWindow(m.model, prov);
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
    // ---- model combobox ---------------------------------------------------
    // A native <datalist> was tried first and is the wrong tool at this size: the
    // browser owns the popup's position and height, and with 405 ids it rendered
    // detached from the field, the full height of the page, over the hint line. None
    // of that is reachable from CSS. So the popup is ours.
    //
    // Safe to own, because nothing re-renders while it is open: setModelField saves
    // without redrawing, and only picking a value calls chooseArenaModel. That was
    // the objection to a custom widget, and it does not apply here.
    mdlIds(id) { return (this._mdlIds && this._mdlIds[id]) || []; }

    // Every term must appear, in any order, anywhere. "qwen 27" finds
    // qwen/qwen3.5-27b; "claude" finds anthropic/claude-opus-4, which no prefix match
    // ever will, because every id on OpenRouter starts with a vendor nobody searches
    // by. Ranked so a hit on the MODEL name outranks one on the vendor -- typing
    // "gemma" should not bury google/gemma-3 under everything google ships.
    mdlMatch(id, q) {
        const ids = this.mdlIds(id);
        const terms = String(q || '').toLowerCase().split(/[\s\/]+/).filter(Boolean);
        if (!terms.length) return ids.slice(0, 400);
        const hits = [];
        for (const one of ids) {
            const low = one.toLowerCase();
            const slash = low.indexOf('/');
            const tail = slash >= 0 ? low.slice(slash + 1) : low;
            if (!terms.every(term => low.includes(term))) continue;
            hits.push([tail.startsWith(terms[0]) ? 0 : (low.startsWith(terms[0]) ? 1 : 2), one]);
        }
        hits.sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1]));
        return hits.map(h => h[1]).slice(0, 400);
    }

    mdlShow(id) {
        const pop = document.getElementById('mdlPop-' + id);
        const inp = document.getElementById('mdlIn-' + id);
        if (!pop || !inp) return;
        // An open box starts unfiltered even when the field holds a value: the value
        // is what you picked last time, not what you are looking for now.
        this._mdlQ = (this._mdlQ || {});
        const list = this.mdlMatch(id, this._mdlQ[id] || '');
        this._mdlOpen = id;
        this._mdlSel = Math.max(0, list.indexOf(inp.value));
        this.mdlPaint(id, list);
        pop.hidden = false;
        if (!this._mdlAway) {
            this._mdlAway = (ev) => {
                if (this._mdlOpen == null) return;
                const box = document.getElementById('mdlPop-' + this._mdlOpen);
                const field = document.getElementById('mdlIn-' + this._mdlOpen);
                if (box && !box.contains(ev.target) && ev.target !== field
                    && !(ev.target.classList && ev.target.classList.contains('mdl-caret'))) {
                    this.mdlClose();
                }
            };
            document.addEventListener('mousedown', this._mdlAway, true);
        }
    }

    mdlPaint(id, list) {
        const pop = document.getElementById('mdlPop-' + id);
        if (!pop) return;
        const e = (x) => this.escapeHtml(String(x == null ? '' : x));
        if (!list.length) { pop.innerHTML = `<div class="mdl-none">${e(t('ar.modelNoMatch'))}</div>`; return; }
        // The vendor greyed and the model name bright: on a list where every line
        // starts with the same eleven characters, that is the difference between
        // scanning and reading.
        pop.innerHTML = list.map((one, i) => {
            const cut = one.indexOf('/');
            const head = cut >= 0 ? one.slice(0, cut + 1) : '';
            const tail = cut >= 0 ? one.slice(cut + 1) : one;
            return `<div class="mdl-row${i === this._mdlSel ? ' on' : ''}" data-v="${e(one)}"
                onmousedown="game.ui.mdlPick(${id}, this.getAttribute('data-v'))"
                >${head ? `<span class="mdl-v">${e(head)}</span>` : ''}${e(tail)}</div>`;
        }).join('');
        const on = pop.querySelector('.mdl-row.on');
        if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest' });
    }

    mdlType(id, value) {
        this.setModelField(id, 'model', value);
        (this._mdlQ || (this._mdlQ = {}))[id] = value;
        this._mdlSel = 0;
        const list = this.mdlMatch(id, value);
        const pop = document.getElementById('mdlPop-' + id);
        if (pop) { pop.hidden = false; this._mdlOpen = id; this.mdlPaint(id, list); }
    }

    mdlToggle(id) {
        const pop = document.getElementById('mdlPop-' + id);
        if (pop && !pop.hidden) { this.mdlClose(); return; }
        const inp = document.getElementById('mdlIn-' + id);
        if (inp) inp.focus();
        this.mdlShow(id);
    }

    mdlClose() {
        if (this._mdlOpen == null) return;
        const pop = document.getElementById('mdlPop-' + this._mdlOpen);
        if (pop) pop.hidden = true;
        this._mdlOpen = null;
    }

    mdlKey(ev, id) {
        const pop = document.getElementById('mdlPop-' + id);
        const open = pop && !pop.hidden;
        const list = this.mdlMatch(id, (this._mdlQ && this._mdlQ[id]) || '');
        if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
            ev.preventDefault();
            if (!open) { this.mdlShow(id); return; }
            const step = ev.key === 'ArrowDown' ? 1 : -1;
            this._mdlSel = Math.min(list.length - 1, Math.max(0, (this._mdlSel || 0) + step));
            this.mdlPaint(id, list);
        } else if (ev.key === 'Enter') {
            if (open && list[this._mdlSel || 0]) { ev.preventDefault(); this.mdlPick(id, list[this._mdlSel || 0]); }
        } else if (ev.key === 'Escape') {
            if (open) { ev.preventDefault(); this.mdlClose(); }
        }
    }

    mdlPick(id, value) {
        if (this._mdlQ) this._mdlQ[id] = '';
        this.mdlClose();
        const inp = document.getElementById('mdlIn-' + id);
        if (inp) inp.value = value;
        this.chooseArenaModel(id, value);   // saves and redraws, which is fine once closed
    }

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
        // DERIVE-unless-edited: switching the controlling model never touches the
        // slot's prompt. A derived slot (null) keeps following the template — the
        // old behavior seeded a full template COPY here, which lit the ✎ edited
        // badge although nothing was edited. A real edit survives model changes.
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
        return this.renderPromptDiffHtml(base, slot.prompt != null ? slot.prompt : base, 'ar.slotDiffEmpty');
    }

    // The same diff, against whichever pair of texts. Written for slot-vs-template
    // and now also used for template-vs-default: an edited shared prompt is the one
    // every seat inherits, so if any text on this screen deserves a visible diff it
    // is that one, and it was the only one without.
    renderPromptDiffHtml(baseText, editedText, emptyKey) {
        const ops = this.diffLines(baseText || '', editedText || '');
        if (!ops.some(o => o.t !== 'same')) return `<div class="diff-empty">${t(emptyKey)}</div>`;
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
    // Does the shared template still say what the build shipped? Trimmed, because a
    // trailing newline is not an edit anybody meant to make.
    templateEdited() {
        const cur = ((this._arenaConfig && this._arenaConfig.prompt) || '').trim();
        return !!cur && cur !== this.getArenaDefaultPrompt().trim();
    }

    // Badge, diff button, reset button and an open diff panel, all from one state.
    // Mirrors what setSlotPrompt does for a slot, so the template behaves like the
    // thing it is: another editable prompt, with the same tells.
    renderTemplateDiff() {
        const edited = this.templateEdited();
        const badge = document.getElementById('tmplPromptBadge');
        const btn = document.getElementById('tmplDiffBtn');
        const reset = document.getElementById('tmplResetBtn');
        const panel = document.getElementById('tmplDiff');
        if (badge) badge.style.display = edited ? '' : 'none';
        if (reset) reset.style.display = edited ? '' : 'none';
        if (btn) {
            btn.style.display = edited ? '' : 'none';
            btn.textContent = this._tmplDiffOpen ? t('ar.slotDiffHide') : t('ar.slotDiffShow');
        }
        if (panel) {
            const open = edited && this._tmplDiffOpen;
            panel.style.display = open ? '' : 'none';
            if (open) {
                panel.innerHTML = this.renderPromptDiffHtml(
                    this.getArenaDefaultPrompt(), (this._arenaConfig && this._arenaConfig.prompt) || '',
                    'ar.tmplDiffEmpty');
            }
        }
        this.refreshDerivedSlotBadges();
    }

    toggleTemplateDiff() { this._tmplDiffOpen = !this._tmplDiffOpen; this.renderTemplateDiff(); }

    // The template alone. resetArenaPrompts also clears every per-slot prompt, which
    // is the right button when you want a clean slate and the wrong one when you only
    // want the default text back under the per-seat edits you meant to keep.
    resetTemplatePrompt() {
        if (!this._arenaConfig) return;
        this._arenaConfig.prompt = this.getArenaDefaultPrompt();
        const ta = document.getElementById('arenaSharedPrompt');
        if (ta) ta.value = this._arenaConfig.prompt;
        this._tmplDiffOpen = false;
        this.saveSetup();
        this.renderArenaSlots();
        this.renderTemplateDiff();
    }

    // A slot that follows the template inherits whatever the template says, so when
    // the template is edited those slots are running non-default text without having
    // been touched. They said nothing at all before, which is how a line nobody
    // remembered adding rode into a benchmark on every seat at once.
    //
    // Badges only -- no innerHTML rebuild. This runs on every keystroke in the
    // template, and redrawing the slot list under the cursor would be its own bug.
    refreshDerivedSlotBadges() {
        const tmplEdited = this.templateEdited();
        (this.setupSlots() || []).forEach((s, i) => {
            const badge = document.getElementById('slotPromptBadge' + i);
            if (!badge) return;
            const own = s.prompt != null;
            const derived = !own && tmplEdited && s.control && s.control !== 'ki';
            badge.style.display = (own || derived) ? '' : 'none';
            badge.textContent = '\u270e ' + t(own ? 'ar.promptEdited' : 'ar.slotFollowsEdited');
            badge.title = t(own ? 'ar.promptEditedTitle' : 'ar.slotFollowsEditedTitle');
            badge.classList.toggle('is-derived', derived);
        });
    }

    onTemplatePromptInput(value) {
        if (!this._arenaConfig) return;
        this._arenaConfig.prompt = value;
        this.saveArenaConfig();
        this.renderTemplateDiff();
    }
    applyTemplateToAllSlots() {
        const tmpl = (document.getElementById('arenaSharedPrompt') || {}).value || this._arenaConfig.prompt || '';
        this._arenaConfig.prompt = tmpl;
        this.setupSlots().forEach(s => { s.prompt = null; }); // every slot follows the template again
        this.saveSetup();
        this.renderArenaSlots();
        this.renderTemplateDiff();
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
            // Ask the endpoint what it can do, now that we know it answers at all. It is
            // a handful of GETs against routes that either exist or 404 -- measured at 6
            // to 33ms across llama.cpp, SGLang and vLLM -- and it never throws, so the
            // worst case is the blank card this button already produced. Deliberately
            // AFTER the status is set: the connection test is what the user pressed, and
            // its result must not wait on an extra.
            try {
                const caps = await OpenAIAIManager.probeCapabilities(
                    { endpoint: (m.endpoint || '').trim(), auth: this.cleanAuth(m.auth), model: m.model });
                if (caps && caps.stack) this.noteModelCapabilities(id, caps);
            } catch (e) { /* a probe that fails leaves the card as it was */ }
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
                // null = omit. parseFloat so 0 survives: temperature 0 is a real, useful
                // setting and "|| null" would have thrown it away as falsy.
                temperature: this.numOrNull(m.temperature, 0, 2),
                topP: this.numOrNull(m.topP, 0, 1),
                topK: this.numOrNull(m.topK, 1, 1000, true),
                minP: this.numOrNull(m.minP, 0, 1),
                presencePenalty: this.numOrNull(m.presencePenalty, -2, 2),
                repetitionPenalty: this.numOrNull(m.repetitionPenalty, 0, 2),
                reasoning: m.reasoning == null ? '' : String(m.reasoning),
                extraBody: this.parseExtraBody(m.extraBody).value,
                contextSize: (() => { const n = parseInt(m.contextSize, 10); return (n && n >= 512) ? n : null; })(),
                maxContext: (() => { const n = parseInt(m.maxContext, 10); return (n && n >= 512) ? n : null; })(),
                minimizeTokens: !!m.minimizeTokens,
                toolFallback: !!m.toolFallback,
                language: m.language || 'en',
                // So a parameter the endpoint refuses mid-match can be recorded against
                // the entry it came from rather than being relearned every match.
                libraryId: m.id,
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
        this._tmplDiffOpen = false;
        this.saveSetup();
        this.renderArenaSlots();
        this.renderTemplateDiff();
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

    // Re-render whatever the info card is currently showing.
    //
    // updateUnitInfo only ever ran on a selection EVENT, so the card was a snapshot
    // taken the moment you clicked: watch a building being attacked and its health
    // never moved. Called from the game tick now, throttled.
    //
    // Two things it must not trample. showErrorMessage/showInfoMessage borrow this
    // same element for a few seconds and restore what was there — refreshing during
    // that window would cut the message short AND make it restore stale markup. And
    // a subject that has died should release the card rather than freeze on a
    // corpse's last numbers.
    refreshUnitInfo() {
        if (this._infoBorrowed) return;
        const s = this._infoSubject;
        if (!s || (!s.unit && !s.building)) return;
        const ent = s.unit || s.building;
        if (ent.health <= 0) { this.updateUnitInfo(null, null); return; }
        this.updateUnitInfo(s.unit, s.building);
    }

    updateUnitInfo(unit, building) {
        this._infoSubject = { unit: unit || null, building: building || null };
        const infoDiv = document.getElementById('unitInfo');
        const spectator = this.game && this.game.spectatorMode;
        // In spectator every entity belongs to a rival civ — lead with the SEAT
        // BADGE (the same mark worn on flags and shown in the leaderboard) plus the
        // civ name in the civ colour, so the card says WHOSE unit/building this is
        // even when two seats share a civ. The old plain "●" only carried colour,
        // which is identical across same-civ seats — you had to zoom to the flag.
        const ownerLine = (ent) => {
            if (!spectator || !ent || typeof getCivilization !== 'function') return '';
            const civ = getCivilization(ent.civilization);
            if (!civ) return '';
            const col = '#' + ((civ.color != null ? civ.color : 0xffffff)).toString(16).padStart(6, '0');
            const badge = (ent.seat != null && this.teamDotHtml) ? this.teamDotHtml(ent.seat, 9) : '●';
            return `<span style="color:${col};font-weight:bold;">${badge} ${tg(civ.name)}</span><br>`;
        };
        if (unit) {
            let html = ownerLine(unit);
            html += `<strong>${tg(unit.name)}</strong><br>`;
            html += `❤️ ${t('ui.health')}: ${Math.floor(unit.health)}/${unit.maxHealth}<br>`;
            html += `⚔️ ${t('ui.attack')}: ${unit.attack}<br>`;
            html += `💨 ${t('ui.speed')}: ${unit.speed}<br>`;
            if (unit.range > 1) {
                html += `🎯 ${t('ui.range')}: ${unit.range}<br>`;
            }
            html += `<em>${this.getUnitTypeDescription(unit.unitType)}</em>`;
            infoDiv.innerHTML = html;
        } else if (building) {
            let html = ownerLine(building);
            html += `<strong>${tg(building.name)}</strong><br>`;
            html += `❤️ ${t('ui.health')}: ${Math.floor(building.health)}/${building.maxHealth}<br>`;
            html += `<em>${this.getBuildingTypeDescription(building.type)}</em>`;
            infoDiv.innerHTML = html;
        } else {
            infoDiv.innerHTML = spectator
                ? `<p style="color:#4ecca3;font-weight:bold;">${t('spec.hint')}</p>`
                : `<p>${t('hud.selectHint')}</p>`;
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
            // Per-civ EFFECTIVE age: Egypt's stable unlocks with a bronze tech,
            // so its card must say Bronze even though the def says neolithic.
            const effAge = (typeof effectiveBuildingAge === 'function')
                ? effectiveBuildingAge(this.game.player.civilization, b) : b.requiredAge;
            const isLocked = effAge && ageOrder.indexOf(effAge) > ageOrder.indexOf(this.game.player.age);
            const ageLabel = effAge ? ` (${this.getAgeName(effAge)})` : '';
            
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
                trainOptions = getTrainOptionsForBuilding(building.type, this.game.player.age, this.game.player.civilization);
                // Sync the building's trainOptions
                building.trainOptions = trainOptions;
            }
            
            trainOptions.forEach(unitId => {
                const unitDef = getUnitDefFor(this.game.player.civilization, unitId);
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

    // force=true: a discrete user action changed what the menu should show (e.g.
    // selecting a building), so rebuild NOW — skip the anti-flicker throttle and
    // the hover guard. Periodic/economy-driven calls pass no force and stay lazy.
    refreshActiveMenu(force) {
        if (!this.activeMenu) return;

        // 1) Always keep affordability live in-place (cheap, no flicker, works while
        //    hovering) — so a user waiting for resources sees the item enable itself.
        this.refreshMenuAffordability();

        // 2) A FULL rebuild is only needed when the item SET changes (e.g. a new tech
        //    or age unlocks something, or the selected building changed). Rebuilding
        //    replaces the DOM, so outside a forced refresh never do it while the
        //    cursor is over the menu (flicker/false clicks), and throttle it.
        if (!force) {
            const panel = document.querySelector('.menu-panel:not(.hidden)');
            if (panel && panel.matches(':hover')) return;
            const now = Date.now();
            if (this._lastMenuRefresh && (now - this._lastMenuRefresh) < 250) return;
            this._lastMenuRefresh = now;
        }

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
            BUILDING_DEFS.academy,
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
        this._infoBorrowed = true;   // held until the placement is finished or cancelled
        infoDiv.innerHTML = `<p style="color: #4ecca3; font-weight: bold;">${t('msg.buildHint', { name: tg(buildingName) })}</p>`;
    }

    hideBuildingPlacementHint() {
        const infoDiv = document.getElementById('unitInfo');
        this._infoBorrowed = false;
        infoDiv.innerHTML = `<p>${t('hud.selectHint')}</p>`;
    }

    showErrorMessage(message) {
        const infoDiv = document.getElementById('unitInfo');
        if (!infoDiv) return;
        // Borrowed: hold the periodic refresh off until we hand the card back, and
        // re-render on release rather than restoring the markup we captured — by
        // then it is seconds stale.
        this._infoBorrowed = true;
        infoDiv.innerHTML = `<p style="color: #e94560; font-weight: bold;">⚠️ ${message}</p>`;
        clearTimeout(this._infoBorrowTimer);
        this._infoBorrowTimer = setTimeout(() => {
            this._infoBorrowed = false;
            this.refreshUnitInfo();
            if (!this._infoSubject || (!this._infoSubject.unit && !this._infoSubject.building)) {
                this.updateUnitInfo(null, null);
            }
        }, 3000);
    }

    showInfoMessage(message) {
        const infoDiv = document.getElementById('unitInfo');
        if (!infoDiv) return;
        this._infoBorrowed = true;
        infoDiv.innerHTML = `<p style="color: #4ecca3; font-weight: bold;">✅ ${message}</p>`;
        clearTimeout(this._infoBorrowTimer);
        this._infoBorrowTimer = setTimeout(() => {
            this._infoBorrowed = false;
            this.refreshUnitInfo();
            if (!this._infoSubject || (!this._infoSubject.unit && !this._infoSubject.building)) {
                this.updateUnitInfo(null, null);
            }
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
        const ageNames = { stone: t('age.stone'), neolithic: t('age.neolithic'), bronze: t('age.bronze'), iron: t('age.iron') };
        const met = (this.game.player && this.game.player._metRivals) || new Set();
        const rows = ais.map(ai => {
            const ctrl = (mgr && mgr.aiControllers) ? mgr.aiControllers.find(c => c.id === ai.id) : null;
            const who = ctrl
                ? ((ctrl.model && ctrl.model.name && ctrl.model.name.trim()) ? ctrl.model.name : t('ar.unnamed'))
                : t('opp.ruleBased');
            const civ = civNames[ai.civilization] || ai.civilization;
            const color = civColor[ai.civilization] || '#888';
            // Same intel rule as the models get: the rival's EPOCH is public
            // (heralds announce age-ups), army/building counts only appear once
            // the player has actually seen one of its units or buildings.
            const intel = met.has(ai.id)
                ? `⚔️ ${ai.units.filter(u => u.type !== 'worker').length} · 👷 ${ai.units.filter(u => u.type === 'worker').length} · 🏛️ ${ai.buildings.length}`
                : `<i class="opp-unscouted">${t('opp.unscouted')}</i>`;
            return `<span class="opp-row"><b style="color:${color}">${this.escapeHtml(civ)}</b>: ${this.escapeHtml(who)} · ${ageNames[ai.age] || ai.age} · ${intel}</span>`;
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

        // #unitInfo lives inside the now-hidden bottomHUD, and a child of a
        // display:none parent never renders — the click-to-inspect card was
        // invisible. Float it out to the body as a bottom-centre spectator card.
        const infoDiv = document.getElementById('unitInfo');
        if (infoDiv) {
            infoDiv.classList.add('spectator-card');
            document.body.appendChild(infoDiv);
            infoDiv.innerHTML = `<p style="color: #4ecca3; font-weight: bold;">${t('spec.hint')}</p>`;
        }

        // Wire the decision-log scroll → toggle the "to top" arrow (once).
        const entriesEl = document.getElementById('aiLogEntries');
        if (entriesEl && !entriesEl._topBtnWired) {
            entriesEl.addEventListener('scroll', () => this.updateDecisionLogTopBtn());
            entriesEl._topBtnWired = true;
        }

        // Per-seat fog knobs beside the minimap.
        this.buildMinimapFogKnobs();

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
        // The viewer follows the match live; renderTranscriptViewer no-ops unless a
        // model is actually being watched and its turn count has moved.
        this._spectatorIntervals.push(setInterval(() => { if (!document.hidden) this.renderTranscriptViewer(); }, 1000));
        // Live graph while the Results card is open over a running match. Polled at
        // 1s but rebuilt only when a new sample landed — samples arrive every 5s, so
        // a faster poll would redraw identical data. Costs ~2ms when it does fire,
        // which is an eighth of a frame and invisible against the 3D scene still
        // rendering underneath.
        this._spectatorIntervals.push(setInterval(() => {
            if (document.hidden) return;
            const el = document.getElementById('arenaSummaryScreen');
            if (el && el.classList.contains('snapshot') && el.classList.contains('active')) {
                // Re-render the card itself, not just the graph: duration, the
                // leader banner, scores, ages and unit counts all move underneath.
                // The grid holds no inputs, so rebuilding it costs nothing a reader
                // would notice — and the chart's own guard keeps the expensive half
                // from redoing work when no sample has landed.
                this.showArenaSummary(null, 'snapshot', { snapshot: true });
            }
        }, 1000));
        this._spectatorIntervals.push(setInterval(() => { if (!document.hidden) this.updateArenaStatus(); }, 1000));
    }

    // ---- Per-seat minimap fog knobs (spectator) ------------------------------
    // One knob per seat in the gutter left of the minimap, wearing that seat's own
    // team badge so the knob and the leaderboard row name the same player. Press
    // one: the minimap draws ONLY what that model has discovered. Press it again:
    // back to every seat at once, which is the default and what the panel showed
    // before this existed.
    //
    // A viewing aid, and only that. It sets one number on the game object that
    // nothing but updateMinimap reads -- no seat's state changes, no request is
    // made, no transcript records that anybody looked. Which model the spectator
    // is squinting at is not part of the match.
    buildMinimapFogKnobs() {
        const host = document.getElementById('mmFog');
        if (!host) return;
        const ais = (this.game.aiManager && this.game.aiManager.aiPlayers) || [];
        this.game.minimapFogSeat = null;                 // every new match starts open
        host.innerHTML = ais.map(ai =>
            `<button type="button" class="mm-fog-knob" data-seat="${ai.seat}" aria-pressed="false"
                onclick="game.ui.toggleMinimapFogSeat(${ai.seat})">${this.teamDotHtml(ai.seat, 8)}</button>`
        ).join('');
        this.refreshMinimapFogKnobs();
    }

    toggleMinimapFogSeat(seat) {
        const g = this.game;
        // A click is the viewer taking the wheel. While the director is driving it sets
        // the fog itself on every cut, so without this the knob would appear to work and
        // then snap back at the next shot -- which reads as a broken knob rather than as
        // a camera doing its job. Released when auto-camera is toggled.
        g._minimapFogManual = true;
        g.minimapFogSeat = (g.minimapFogSeat === seat) ? null : seat;
        this.refreshMinimapFogKnobs();
        // Repaint now rather than at the next 500ms tick -- a knob that answers half
        // a second late reads as a knob that did not take.
        if (g.updateMinimap) g.updateMinimap();
    }

    // Pressed state and tooltips. Separate from the builder because the titles name
    // the seat (its model, or its civilization for a rule-based one) and so cannot be
    // a static data-i18n-title -- onLanguageChanged calls this to re-render them.
    refreshMinimapFogKnobs() {
        const host = document.getElementById('mmFog');
        if (!host) return;
        const g = this.game;
        const ais = (g.aiManager && g.aiManager.aiPlayers) || [];
        const ctrls = (g.openAIAIManager && g.openAIAIManager.aiControllers) || [];
        host.setAttribute('aria-label', t('mm.fogGroup'));
        // What to call a seat: its model, or its civilization when a rule-based one
        // has no model to name. Two seats can end up with the SAME name -- four
        // Egypts, or one model in two chairs, which is exactly the match you would
        // run to compare two prompts -- and then the name alone does not say which
        // knob is which. Number those, and only those.
        const nameOf = ai => {
            const ctrl = ai && ctrls.find(c => c.id === ai.id);
            return (ctrl && ctrl.model && ctrl.model.name) || this.anCivName(ai && ai.civilization);
        };
        const tally = {};
        ais.forEach(a => { const n = nameOf(a); tally[n] = (tally[n] || 0) + 1; });

        host.querySelectorAll('.mm-fog-knob').forEach(btn => {
            const seat = Number(btn.dataset.seat);
            const on = (g.minimapFogSeat === seat);
            btn.classList.toggle('on', on);
            btn.setAttribute('aria-pressed', on ? 'true' : 'false');
            const ai = ais.find(a => a.seat === seat);
            const n = nameOf(ai);
            const who = (tally[n] > 1) ? `${n} #${seat + 1}` : n;
            btn.title = on ? t('mm.fogAll') : t('mm.fogSolo', { who: who });
        });
    }

    // Stop spectator refresh timers (call when leaving the arena)
    teardownSpectatorUI() {
        document.body.classList.remove('spectator-mode');
        // Leave the arena with the minimap open again, so a campaign started next
        // does not inherit a seat number from a match that is over.
        this.game.minimapFogSeat = null;
        if (this._spectatorIntervals) this._spectatorIntervals.forEach(id => clearInterval(id));
        this._spectatorIntervals = [];
        if (this.closeLbFlyout) this.closeLbFlyout(); // no flyout floating over the summary
    }


    // Collapse the leaderboard to its first two lines per seat: the model banner and
    // the rank line. What goes is the detail you can re-open for — the two stat rows,
    // the power bar and the advice box — so at four seats the panel gives back most of
    // its height without losing who is winning or what they are called.
    //
    // The class lives on the LIST, not on the cards, because updateSpectatorPlayerList
    // replaces the cards' innerHTML every 1.5s and anything set on them would be gone
    // by the next tick. Same arrangement as the decision log.
    toggleLeaderboard() {
        const list = document.getElementById('spectatorPlayerList');
        const toggle = document.getElementById('lbToggle');
        if (!list) return;
        list.classList.toggle('collapsed');
        const off = list.classList.contains('collapsed');
        if (toggle) toggle.textContent = off ? '▶' : '▼';
    }
    toggleDecisionLog() {
        const entries = document.getElementById('aiLogEntries');
        const toggle = document.getElementById('aiLogToggle');
        const filter = document.getElementById('aiLogFilter');
        if (entries) {
            entries.classList.toggle('collapsed');
            const off = entries.classList.contains('collapsed');
            if (toggle) toggle.textContent = off ? '▶' : '▼';
            if (filter) filter.classList.toggle('collapsed', off);
        }
    }

    // ---- KI-Log filtering ---------------------------------------------------
    // Two independent filters that AND together: a player and a free-text term.
    // Both narrow the SOURCE list before the 160-entry render cap, so filtering
    // reaches back through the whole history rather than only the visible slice.
    logFilter() {
        if (!this._logFilter) this._logFilter = { players: new Set(), text: '' };
        return this._logFilter;
    }

    // Independent on/off toggles rather than a radio group: watching two rivals at
    // once is the point during a fight, and switching back and forth loses the
    // interleaving that makes a conflict readable. No selection means no filter,
    // so turning the last one off returns to showing everyone.
    setLogPlayerFilter(playerId) {
        const f = this.logFilter();
        if (f.players.has(playerId)) f.players.delete(playerId);
        else f.players.add(playerId);
        this._lastLogSig = null;   // filter changed → force a rebuild
        this.renderLogPlayerChips();
        this.updateDecisionLog();
    }

    setLogTextFilter(text) {
        this.logFilter().text = String(text || '').trim().toLowerCase();
        this._lastLogSig = null;
        this.updateDecisionLog();
    }

    // One chip per seat, badge + civ name, so the picker reads the same way the
    // entries do. Rebuilt only when the roster changes — otherwise every 1s tick
    // would blow away the focus/active state.
    renderLogPlayerChips() {
        const el = document.getElementById('aiLogPlayers');
        if (!el) return;
        const players = (this.game.aiManager && this.game.aiManager.aiPlayers) || [];
        const on = this.logFilter().players;
        // Player ids are per-match. A selection carried into the NEXT match would
        // match nobody and silently hide the whole log, so drop anything that is not
        // on the current roster.
        if (on.size && players.length) {
            const live = new Set(players.map(p => p.id));
            [...on].forEach(id => { if (!live.has(id)) on.delete(id); });
        }
        const sig = players.map(p => `${p.id}:${p.seat}`).join('|')
            + '#' + [...on].sort().join(',') + '#' + getUiLang();
        if (sig === this._logChipSig) return;
        this._logChipSig = sig;
        el.innerHTML = players.map(p => {
            const isOn = on.has(p.id);
            const civ = this.escapeHtml(tg((getCivilization(p.civilization) || {}).name || p.civilization));
            // Badge + civ ICON only: the names wrapped the row onto two lines for no
            // information gain, since the badge already identifies the seat. The full
            // name stays as the tooltip.
            const icon = this.civIcon(p.civilization);
            // aria-pressed, not aria-checked: these are independent toggles, not a
            // radio group, and a screen reader should say so.
            return `<button class="ai-log-chip${isOn ? ' is-on' : ''}" data-player="${this.escapeHtml(p.id)}"
                        onclick="game.ui.setLogPlayerFilter('${this.escapeHtml(p.id)}')"
                        aria-pressed="${isOn}" aria-label="${civ}" title="${civ}">${this.teamDotHtml(p.seat, 9)}<span class="ai-log-chip-icon">${icon || civ}</span></button>`;
        }).join('');
    }

    // The civ's emoji, taken from the localized display name ("⚔️ Greeks" -> "⚔️"),
    // which is where this project already keeps them. Falls back to '' if a
    // translation ever drops the prefix, and callers then show the name instead.
    civIcon(civKey) {
        const full = (t(`civ.${civKey}.name`) || '').trim();
        const first = full.split(/\s+/)[0] || '';
        return (first && !/[\p{L}\p{N}]/u.test(first)) ? first : '';
    }

    // Everything the reader can SEE for an entry, lowercased — so searching matches
    // the words on screen (localized action label, detail, reason, outcome) rather
    // than the internal codes behind them.
    logHaystack(entry, actionLabel, detail) {
        const parts = [
            actionLabel, detail, entry.civName && tg(entry.civName), entry.action,
            entry.reason, this.renderOutcome(entry), entry.error, entry.result,
            // The "✗ rejected" marker is rendered from the UI language but was not
            // searchable, so searching "abgelehnt" in a German UI matched only the
            // few entries whose outcome text happened to contain the word — never
            // the category itself. It is on screen, so it belongs in the haystack.
            entry.failed ? t('log.rejected') : '',
            entry.isAdvice ? t('log.advice') : ''
        ];
        const p = entry.params || {};
        Object.keys(p).forEach(k => {
            const v = p[k];
            if (v !== null && typeof v === 'object') return;
            parts.push(`${k} ${v}`);
        });
        return parts.filter(Boolean).join(' ').toLowerCase();
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
        // The Wonder lock engages and releases DURING a match, not on a click, so the
        // button has to be repainted on the same beat as the clock.
        this.updateSimSpeedButton();
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

    // Localized display name for a decision-log id (techId 'stable', unitType
    // 'warrior', …) — the same names the menus show via tg(). Tech and
    // unique-unit defs are per-civ, so resolve through the acting player's civ
    // first, then any civ that defines the id; unknown ids stay raw.
    logDetailName(kind, id, playerId) {
        const aiPlayers = (this.game.aiManager && this.game.aiManager.aiPlayers) || [];
        const ai = aiPlayers.find(a => a.id === playerId);
        const civ = ai ? getCivilization(ai.civilization) : null;
        if (kind === 'tech') {
            let def = (civ && civ.techTree) ? civ.techTree[id] : null;
            if (!def) {
                for (const key of Object.keys(CIVILIZATIONS)) {
                    const tree = CIVILIZATIONS[key].techTree;
                    if (tree && tree[id]) { def = tree[id]; break; }
                }
            }
            return def ? tg(def.name) : id;
        }
        if (kind === 'unit') {
            const def = ai ? getUnitDefFor(ai.civilization, id) : getUnitDef(id);
            return def ? tg(def.name) : id;
        }
        if (kind === 'building') {
            const def = getBuildingDef(id);
            return def ? tg(def.name) : id;
        }
        if (kind === 'resource') {
            const label = t('res.' + id);
            // res.* labels carry a leading emoji ('🍖 Food'); the log action
            // has its own icon already, so show only the word.
            return label === 'res.' + id ? id : label.replace(/^[^ ]+ /, '');
        }
        return id;
    }

    // A quick controls reference, opened by the "?" button in either HUD. Content
    // is mode-aware: the same mouse buttons do different things in the arena (watch
    // + inspect) versus a player match (select + command), so each gets its own
    // rows; the camera controls are shared. Verified against input.js and the
    // renderer's key/mouse handlers.
    // The gap between "the match is decided" and the summary. Every seat is being
    // asked for a closing statement and each one is an endpoint round trip, so this can
    // run to a minute. A board that has stopped moving with nothing said reads as a
    // hang -- especially with the wonder timer sitting at zero -- so name what is being
    // waited for and count the answers as they land.
    //
    // Doubles as the show: the first call builds it. total 0 means nobody is being
    // asked (an all-rule-based match), and then there is nothing honest to display.
    finalWordsProgress(done, total) {
        if (!total) { this.hideFinalWordsWait(); return; }
        let el = document.getElementById('finalWordsWait');
        if (!el) {
            el = document.createElement('div');
            el.id = 'finalWordsWait';
            el.className = 'fw-wait';
            document.body.appendChild(el);
        }
        el.innerHTML = '<div class="fw-card"><div class="fw-title">'
            + this.escapeHtml(t('arena.finalWords')) + '</div><div class="fw-count">'
            + this.escapeHtml(t('arena.finalWordsCount', { done: done, n: total }))
            // Falls back to simply closing the card. The hook is null once the ending
            // has run, and `null && null()` is a button that is visibly there and does
            // nothing -- which is how this became an undismissable screen rather than a
            // stray overlay. A control the user can see must always do something, even
            // if by then all that is left to do is get out of the way.
            + '</div><button class="fw-skip" onclick="game._skipFinalWords ? game._skipFinalWords() : game.ui.hideFinalWordsWait()">'
            + this.escapeHtml(t('arena.finalWordsSkip')) + '</button></div>';
    }

    hideFinalWordsWait() {
        const el = document.getElementById('finalWordsWait');
        if (el && el.parentNode) el.parentNode.removeChild(el);
    }

    showControlsCard(mode) {
        this.hideControlsCard();
        const row = (k, v) => `<div class="ck">${k}</div><div class="cv">${v}</div>`;
        // A card listing mouse buttons is no help on a device that cannot produce one.
        // Coarse pointer -> show the gestures. Only the arena has a touch reading: the
        // campaign needs box-select and right-click commands, which is not a tablet.
        const touch = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
        const specific = (mode === 'arena')
            ? (touch ? [
                ['👆 ' + t('help.tap'), t('help.act.inspect')],
                ['👆 ' + t('help.dragTouch'), t('help.act.pan')],
                ['👆 ' + t('help.holdTouch'), t('help.act.coord')]
              ] : [
                ['🖱️ ' + t('help.lmb'), t('help.act.inspect')],
                ['🖱️ ' + t('help.lmbDrag'), t('help.act.pan')],
                ['🖱️ ' + t('help.rmbHold'), t('help.act.coord')]
              ])
            : [
                ['🖱️ ' + t('help.lmb'), t('help.act.select')],
                ['🖱️ ' + t('help.lmbDrag'), t('help.act.box')],
                ['🖱️ ' + t('help.rmb'), t('help.act.command')]
              ];
        const camera = (touch && mode === 'arena')
            ? [
                ['🤏 ' + t('help.pinch'), t('help.act.zoom')],
                ['🤏 ' + t('help.twist'), t('help.act.rotate')]
              ]
            : [
                ['⌨️ W A S D / ↑ ↓ ← →', t('help.act.pan')],
                ['🖱️ ' + t('help.mmb'), t('help.act.rotate')],
                ['🖱️ ' + t('help.wheel'), t('help.act.zoom')]
              ];
        const grid = specific.map(([k, v]) => row(k, v)).join('')
            + `<div class="controls-sub">${t('help.camera')}</div>`
            + camera.map(([k, v]) => row(k, v)).join('');
        const el = document.createElement('div');
        el.className = 'controls-overlay';
        el.id = 'controlsOverlay';
        el.onclick = (e) => { if (e.target === el) this.hideControlsCard(); };
        el.innerHTML = `<div class="controls-card">
                <div class="controls-head"><span>${t('help.title')}</span><button class="controls-close" onclick="game.ui.hideControlsCard()" aria-label="${t('help.close')}">✕</button></div>
                <div class="controls-grid">${grid}</div>
            </div>`;
        document.body.appendChild(el);
        this._controlsEsc = (e) => { if (e.key === 'Escape') this.hideControlsCard(); };
        document.addEventListener('keydown', this._controlsEsc);
    }
    hideControlsCard() {
        const el = document.getElementById('controlsOverlay');
        if (el) el.remove();
        if (this._controlsEsc) { document.removeEventListener('keydown', this._controlsEsc); this._controlsEsc = null; }
    }

    // Localize a harness action outcome into the ENTRY'S MODEL language for the log
    // (the "Reassigned…", "Cannot afford…" bodies). Returns null when it can't —
    // English model, no structured code, or that code not translated yet — so the
    // caller shows the raw English body. This is the "game's voice in the model's
    // language" half; the reason (the model's own words) is already in that language,
    // and the headline stays in the UI language as chrome.
    renderOutcome(entry) {
        const lang = entry && entry.lang;
        const code = entry && entry.outcomeCode;
        if (!lang || lang === 'en' || !code) return null;
        if (typeof hasI18n !== 'function' || !hasI18n(lang, code)) return null;
        const p = entry.outcomeParams || {};
        const v = Object.assign({}, p);
        const EMO = { food: '🍖', wood: '🌲', stone: '🪨', gold: '🥇' };
        // resPlain.*, NOT res.*: the UI's res.* carry an emoji for the HUD, and these
        // words go inside a sentence. They used to be the same key, so whichever i18n
        // block merged last won — which silently stripped the emoji off the German,
        // Spanish and Chinese resource bar while English kept it.
        const resName = r => (hasI18n(lang, 'resPlain.' + r) ? tIn(lang, 'resPlain.' + r) : r);
        // Generic localization for the common primitive params, so the ~60 terse
        // rejection codes need no per-code case: any age id → the localized age
        // name, and a bare resource id → the resource word.
        const AGES = ['stone', 'neolithic', 'bronze', 'iron'];
        ['age', 'reqAge', 'minAge', 'effAge', 'targetAge', 'curAge'].forEach(k => {
            if (AGES.includes(v[k])) v[k] = tIn(lang, 'age.' + v[k]);
        });
        if (AGES.includes(v.res) === false && hasI18n(lang, 'resPlain.' + v.res)) v.res = tIn(lang, 'resPlain.' + v.res);
        // "from" used to be localized here — resPlain, then pull, then the raw token —
        // because it sat inside a German sentence ("Aus Leerlauf konnten keine Arbeiter
        // abgezogen werden") where an English word would have looked dropped in.
        // Those sentences are gone. What replaced them quotes "from" as what it is, the
        // API value the model typed, beside the state field that reports it — and there
        // the translation actively lied: „Leerlauf": leer (workers.idle ist 0) names the
        // same field twice, once in a word the model cannot send. An identifier stays an
        // identifier in every language.
        // Pull breakdown {idle:3, wood:2}: resource keys get the resource word, the
        // rest (idle/scout/repair/farm) their own label; unknown keys pass through.
        const pulledClause = obj => Object.keys(obj || {}).map(k =>
            `${obj[k]} ${EMO[k] ? resName(k) : (hasI18n(lang, 'pull.' + k) ? tIn(lang, 'pull.' + k) : k)}`
        ).join(', ') || '—';
        switch (code) {
            case 'log.out.reassigned':
                v.res = resName(p.res); v.near = tIn(lang, 'log.near.' + (p.near || 'tc')); v.pulled = pulledClause(p.pulled); break;
            case 'log.out.notDiscovered':
                v.res = resName(p.res); break;
            case 'log.out.farmManned':
                v.pulled = pulledClause(p.pulled);
                v.remaining = (p.left > 0) ? tIn(lang, 'log.out.farmLeft', { left: p.left }) : ''; break;
            case 'log.out.cannotAfford':
                v.what = p.age ? tIn(lang, 'age.' + p.age) : tgIn(lang, p.whatName || '');
                break;
            case 'log.out.trainUnit':
                v.unit = tgIn(lang, p.unitName || ''); break;
            case 'log.out.buildStarted':
                v.building = tgIn(lang, p.buildingName || ''); break;
            case 'log.out.researchStarted':
                v.tech = tgIn(lang, p.techName || ''); break;
            case 'log.out.researchedElsewhere':
                v.tech = tgIn(lang, p.techName || ''); v.host = tgIn(lang, p.hostName || ''); break;
            case 'log.out.ageUpStarted':
                v.age = tIn(lang, 'age.' + p.age); break;
            // farmAllManned / populationLimit: params already primitive
        }
        return tIn(lang, code, v);
    }

    updateDecisionLog() {
        const entriesEl = document.getElementById('aiLogEntries');
        const countEl = document.getElementById('aiLogCount');
        if (!entriesEl || !this.game.openAIAIManager) return;

        const log = this.game.openAIAIManager.decisionLog;
        this.renderLogPlayerChips();
        const f = this.logFilter();
        const filtering = !!(f.players.size || f.text);

        if (log.length === 0) {
            if (countEl) countEl.textContent = '';
            if (this._lastLogSig !== 'empty:' + getUiLang()) {
                entriesEl.innerHTML = `<div class="ai-log-empty" style="color:#6b7488;font-size:0.8em;padding:14px 8px;text-align:center;">${t('log.empty')}</div>`;
                this._lastLogSig = 'empty:' + getUiLang();
            }
            return;
        }

        // Only rebuild when the log actually changed (avoids re-triggering the
        // entry animation every second, which looks like flicker). The active
        // filter is part of the signature: without it, typing in the search box
        // would not repaint until the next decision arrived.
        const sig = [getUiLang(), log.length, (log[0] ? log[0].timestamp : 0),
                     [...f.players].sort().join(','), f.text].join(':');
        if (sig === this._lastLogSig) return;
        this._lastLogSig = sig;

        const actionNames = {
            train_unit: t('log.train_unit'),
            research_tech: t('log.research_tech'),
            upgrade_age: t('log.upgrade_age'),
            build_structure: t('log.build_structure'),
            move_units: t('log.move_units'),
            attack_target: t('log.attack_target'),
            wait: t('log.wait'),
            self_heal: t('log.self_heal'),
            paused: t('log.paused'),
            resumed: t('log.resumed'),
            defeated: t('log.defeated'),
            explore: t('log.explore'),
            round_missed: t('log.round_missed'),
            assign_workers: t('log.assign_workers'),
            delete_unit: t('log.delete_unit'),
            destroy_building: t('log.destroy_building'),
            // Failure tags. These render in the log exactly like an action does, so
            // they belong in the same table — they were emitted as pre-baked English
            // strings and stayed English in every language.
            no_action_provided: t('log.no_action_provided'),
            malformed_action: t('log.malformed_action'),
            reply_truncated: t('log.reply_truncated'),
            tool_call_failed: t('log.tool_call_failed'),
            request_failed: t('log.request_failed'),
            fallback_rule_based: t('log.fallback_rule_based')
        };

        // playerId → seat for the team-badge chip on each entry: entries only
        // carry the civ name, which is ambiguous once two seats play the same civ.
        const seatOf = {};
        ((this.game.aiManager && this.game.aiManager.aiPlayers) || []).forEach(a => { seatOf[a.id] = a.seat; });

        // Decorate + filter in one pass over the WHOLE log, capping only after the
        // filters have run — so a search reaches the entire history, not just the
        // 160 entries that would have been rendered anyway.
        const view = [];
        for (const entry of log) {
            if (f.players.size && !f.players.has(entry.playerId)) continue;
            const pp = entry.params || {};
            const hasT = pp.targetX !== undefined && pp.targetZ !== undefined;
            const actionLabel = entry.isAdvice ? t('log.advice')
                : (actionNames[entry.action] || this.escapeHtml(entry.action));
            const detail = pp.unitType ? ` (${this.logDetailName('unit', pp.unitType, entry.playerId)})`
                : pp.buildingType ? ` (${this.logDetailName('building', pp.buildingType, entry.playerId)})`
                : pp.techId ? ` (${this.logDetailName('tech', pp.techId, entry.playerId)})`
                : pp.resourceType ? ` (${this.logDetailName('resource', pp.resourceType, entry.playerId)})`
                : hasT ? ` (→ ${Math.round(pp.targetX)}, ${Math.round(pp.targetZ)})`
                : '';
            if (f.text && !this.logHaystack(entry, actionLabel, detail).includes(f.text)) continue;
            view.push({ entry, actionLabel, detail });
            if (view.length >= 160) break;
        }

        if (countEl) countEl.textContent = filtering ? `(${view.length}/${log.length})` : `(${log.length})`;

        if (view.length === 0) {
            entriesEl.innerHTML = `<div class="ai-log-empty" style="color:#6b7488;font-size:0.8em;padding:14px 8px;text-align:center;">${t('log.noMatches')}</div>`;
            entriesEl.scrollTop = 0;
            this.updateDecisionLogTopBtn();
            return;
        }

        let html = '';
        const now = Date.now();
        view.forEach(({ entry, actionLabel, detail }, idx) => {
            // The head used to say how long ago the move was taken. Two things wrong
            // with that: the panel already carries the match clock, so "when" was
            // answered above -- and the number did not actually tick. This list only
            // repaints when the log CHANGES, so a card sat there reading "5s" for as
            // long as the seat took to move again.
            //
            // Move number and answer time do not age, and they are the two things a
            // reader wants from a card: which turn to open in the transcript, and how
            // long the seat thought about it. Entries that are not a model's move --
            // a pause, a piece of advice, an attack landing -- have neither, so those
            // keep the relative time and the tooltip says which of the two it is.
            const secondsAgo = Math.floor((now - entry.timestamp) / 1000);
            let timeStr;
            if (entry.move) {
                // One decimal below ten seconds. The quick seats answer in 1.6s and the
                // slow ones in 118s; rounding the fast end to whole seconds would flatten
                // the only part of the range where a tenth still means something.
                const secs = entry.latencyMs != null ? entry.latencyMs / 1000 : null;
                const ms = secs == null ? '' : (secs < 10 ? secs.toFixed(1) : Math.round(secs)) + 's';
                timeStr = `<b class="log-move">#${entry.move}</b>${ms ? ' ' + ms : ''}`;
                timeStr = `<span class="log-time" title="${t('log.headTip', { n: entry.move })}">${timeStr}</span>`;
            } else {
                timeStr = `<span class="log-time" title="${t('log.agoTip')}">`
                    + `${secondsAgo < 5 ? t('log.now') : secondsAgo + 's'}</span>`;
            }
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
                            ${timeStr}
                            ${this.teamDotHtml(seatOf[entry.playerId], 9)}
                            <span class="log-civ" style="color: ${civColor}">${this.escapeHtml(tg(entry.civName))}</span>
                            <span class="log-action">${t('log.advice')}</span>
                        </div>
                        <span class="log-reason">“${this.escapeHtml(entry.reason)}”</span>
                    </div>
                `;
                return;
            }

            // actionLabel/detail were computed during the filter pass above.
            // The entry's own flag, nothing else. This used to also sniff the action
            // NAME for "failed" or a warning emoji — so a lost turn was styled red only
            // if its tag happened to be spelled a certain way. Localising the tags
            // stripped the emoji out of malformed_action / reply_truncated /
            // no_action_provided and they silently went black, while tool_call_failed
            // and request_failed kept their red purely because the word "failed" is in
            // them. Every one of those is a turn the model lost; they all set failed
            // now, and styling reads the fact instead of guessing from the label.
            const isError = !!entry.failed;
            // The outcome body in the model's language (null → raw English fallback).
            const locOutcome = this.renderOutcome(entry);

            const linked = this.logEntryLinkable(entry);
            html += `
                <div class="ai-log-entry${isError ? ' is-error' : ''}${newCls}${linked ? ' is-linked' : ''}" data-key="${key}"${
                    linked ? ` onclick="game.ui.openTranscriptAt(${key})" title="${t('log.openTranscript')}"` : ''
                } style="border-left-color: ${civColor}">
                    <div class="log-line1">
                        ${timeStr}
                        ${this.teamDotHtml(seatOf[entry.playerId], 9)}
                        <span class="log-civ" style="color: ${civColor}">${this.escapeHtml(tg(entry.civName))}</span>
                        <span class="log-action">${actionLabel}${this.escapeHtml(detail)}${entry.failed ? ` <span class="log-x">✗ ${t('log.rejected')}</span>` : ''}</span>
                    </div>
                    ${entry.reason ? `<span class="log-reason">“${this.escapeHtml(entry.reason)}”</span>` : ''}
                    ${entry.failed && (locOutcome || entry.error) ? `<span class="log-error">⚠ ${this.escapeHtml(locOutcome || entry.error)}</span>` : ''}
                    ${!entry.failed && (!entry.reason || f.text) && (locOutcome || entry.result) ? `<span class="log-outcome">${this.escapeHtml(locOutcome || entry.result.replace(/^OK\s*-\s*/, ''))}</span>` : ''}
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

    // Team-badge chip: the UI twin of the ownership mark worn on building
    // flags and unit chests — same per-seat fill, SHAPE and contrast rim,
    // drawn as a tiny inline SVG. Returns '' when the seat is unknown so
    // callers can inline it unconditionally.
    //
    // Every caller passes the size it wants for its row; BADGE_UI_SCALE then
    // multiplies them ALL in one place, so the whole UI's badges resize together
    // without touching ten call sites. Bumped to 2 because at the base 9–12px the
    // shapes were hard to tell apart in a same-civ match (e.g. 4× Egypt), where
    // the seat badge is the ONLY thing distinguishing players. The in-world flags
    // and unit chests are a separate engine path (EngineUnits.badgeParts) and are
    // unaffected.
    teamDotHtml(seat, px = 11) {
        const BADGE_UI_SCALE = 2;
        px = Math.round(px * BADGE_UI_SCALE);
        const b = (typeof getTeamBadge === 'function') ? getTeamBadge(seat) : null;
        if (!b) return '';
        // Rim lifted to ~66% gray on the dark dashboard (near-black #222222 sinks
        // in); shape paths both come from the shared TEAM_BADGE_SHAPES so the DOM
        // chip and the world banner can never disagree. See civilizations.js.
        const rim = (typeof teamBadgeRimOnDark === 'function') ? teamBadgeRimOnDark(b) : b.rim;
        const d = (typeof TEAM_BADGE_SHAPES !== 'undefined' && TEAM_BADGE_SHAPES[b.shape])
            || (typeof TEAM_BADGE_SHAPES !== 'undefined' ? TEAM_BADGE_SHAPES.circle : '');
        return `<svg class="team-dot" style="width:${px}px;height:${px}px" viewBox="0 0 24 24" fill="${b.fill}" stroke="${rim}" stroke-width="2.4" stroke-linejoin="round"><title>${t('ui.teamColor')}</title><path d="${d}"/></svg>`;
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
                        ${r.isLLM ? `<button class="lb-spy${this._transcriptFor === ai.id ? ' is-on' : ''}" onclick="event.stopPropagation(); game.ui.toggleTranscriptViewer('${ai.id}')" title="${t('spec.transcript')}">🔎</button>` : ''}
                        <span class="lb-model-name">${this.escapeHtml(r.modelName)}</span>
                        ${(r.isLLM && r.alive) ? `<button class="lb-pause${r.paused ? ' is-paused' : ''}" onclick="event.stopPropagation(); game.ui.togglePauseModel('${ai.id}')" title="${r.paused ? t('spec.resume') : t('spec.pause')}">${r.paused ? '▶' : '⏸'}</button>` : ''}
                    </div>
                    <div class="lb-card-top">
                        <span class="lb-rank">${rank}</span>
                        ${this.teamDotHtml(ai.seat, 10)}
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

        // Completed researches — each chip carries the tech's own description as a
        // hover tip, mirroring the build-menu cards in player mode.
        const techs = Object.keys(ai.researchedTechs || {}).map(id => {
            const def = civ && civ.techTree && civ.techTree[id];
            return { name: def ? tg(def.name) : id, desc: def ? tg(def.description || '') : '' };
        });

        // Units grouped by class; the tip describes the class (utype.* strings,
        // the same short descriptions used on selected-unit cards).
        const unitIcons = { worker: '👷', infantry: '⚔️', ranged: '🏹', cavalry: '🐎', support: '✚' };
        const unitGroups = {};
        ai.units.forEach(u => {
            const k = u.type === 'worker' ? 'worker' : (u.unitType || 'infantry');
            unitGroups[k] = (unitGroups[k] || 0) + 1;
        });
        // The chip's LABEL, not only its tip. Techs and buildings on this panel go
        // through tg() and the resource rows through resPlain.*, so the unit column was
        // the only one still showing a raw English key while everything around it
        // changed language. tg() cannot help here: these are unit CLASSES, not unit
        // defs, and the class exists only as this grouping. uclass.* is the head half of
        // the utype.* line the tooltip already carries, so chip and tip name the same
        // thing in the same words.
        const uclass = k => { const key = 'uclass.' + k; return t(key) !== key ? t(key) : k; };
        const unitChips = Object.entries(unitGroups)
            .map(([k, n]) => `<span class="lb-fly-chip" title="${esc(this.getUnitTypeDescription(k))}">${unitIcons[k] || '⚔️'} ${esc(uclass(k))} ×${n}</span>`).join('');

        // Buildings grouped by type; an "uc:" key prefix separates sites still
        // under construction from finished ones (rendered with a 🏗 marker). Each
        // chip's tip is the building's description, like the build menu.
        const bGroups = {};
        ai.buildings.forEach(b => {
            const def = (typeof getBuildingDef === 'function') ? getBuildingDef(b.type) : null;
            const name = b.isWonder ? tg(b.name) : (def ? tg(def.name) : b.type);
            const key = (b.underConstruction ? 'uc:' : 'ok:') + name;
            if (!bGroups[key]) bGroups[key] = { n: 0, desc: def ? tg(def.description || '') : (b.isWonder ? tg(b.description || '') : '') };
            bGroups[key].n++;
        });
        const bChips = Object.entries(bGroups)
            .map(([k, g]) => {
                const uc = k.startsWith('uc:');
                return `<span class="lb-fly-chip" title="${esc(g.desc)}">${uc ? '🏗 ' : ''}${esc(k.slice(3))} ×${g.n}</span>`;
            }).join('');

        // Resource nodes as THIS SEAT understands them. Read from _lastNodeCounts — the
        // copy buildGameStateJSON keeps of the very number the model was handed — and not
        // recomputed here. Two reasons, both load-bearing:
        //
        // knownAmount() ADDS to _knownResIdx whenever a node is currently visible. Calling
        // it from a render tick would teach the seat a node it was never told about, and a
        // node learned because a human opened a panel is the harness playing the game.
        //
        // And a freshly computed count would not be what the seat read. "Known" is a fact
        // about the seat, so it updates when the seat takes its turn, not when we redraw.
        //
        // Deliberately NOT game.discoveredNodeCounts(), which counts LIVE amounts for the
        // results graph: a node a rival drains out of this seat's sight still counts here
        // at its last-seen amount, which is exactly the belief the model is acting on.
        // Zeros are shown rather than omitted — "this seat has found no gold" is the whole
        // point of the panel, and an absent row would read as "not applicable".
        // Always four chips, zeros included. "This seat has found no gold" is the most
        // telling reading the panel offers, and a sentence in place of the row said less
        // than a 0 while breaking the format around it.
        //
        // WHICH number counts as "known" depends on the kind of seat, because the two
        // kinds do not know things the same way — one source each, chosen to match how
        // that seat actually decides:
        //
        // A model seat reasons from a snapshot it was handed, so its knowledge is
        // _lastNodeCounts, the copy buildGameStateJSON keeps of the very number it read.
        // Before its first turn it has been told nothing, and four zeros say precisely
        // that. It is NOT recomputed here: knownAmount() ADDS to _knownResIdx whenever a
        // node is visible, so calling it from a render tick would teach a seat about a
        // node because a human opened a panel.
        //
        // A rule-based seat is never handed a state; it queries the world each tick, so
        // discoveredNodeCounts — its own scouted set, live amounts — IS its knowledge.
        // Showing it zeros for a tidy layout would have printed a plain falsehood about a
        // seat that had scouted half the map.
        //
        // And deliberately NOT discoveredNodeCounts for MODEL seats: that reads live
        // amounts, while a node a rival drains out of a model's sight has to keep
        // counting at its last-seen value, because that is the belief it still acts on.
        const known = controller
            ? (ai._lastNodeCounts || { food: 0, wood: 0, stone: 0, gold: 0 })
            : this.game.discoveredNodeCounts(ai);
        const nodeChips = ['food', 'wood', 'stone', 'gold'].map(k =>
            `<span class="lb-fly-chip">${esc(t('res.' + k))} ×${known[k] || 0}</span>`).join('');

        const colorHex = '#' + ((civ && civ.color) || 0xffffff).toString(16).padStart(6, '0');
        el.innerHTML = `
            <div class="lb-fly-head" style="--civ:${this.legibleColor(colorHex)}">
                <b>${esc(model)}</b><span>${esc(civName)} · ${ageNames[ai.age] || ai.age}</span>
            </div>
            <div class="lb-fly-sec"><div class="lb-fly-h">🔬 ${t('spec.flyResearch')}</div>
                <div class="lb-fly-body">${techs.length ? techs.map(x => `<span class="lb-fly-chip" title="${esc(x.desc)}">${esc(x.name)}</span>`).join('') : `<i>${t('spec.flyNone')}</i>`}</div></div>
            <div class="lb-fly-sec"><div class="lb-fly-h">👥 ${t('spec.flyUnits', { n: ai.units.length })}</div>
                <div class="lb-fly-body">${unitChips || `<i>${t('spec.flyNone')}</i>`}</div></div>
            <div class="lb-fly-sec"><div class="lb-fly-h">🏛️ ${t('spec.flyBuildings', { n: ai.buildings.length })}</div>
                <div class="lb-fly-body">${bChips || `<i>${t('spec.flyNone')}</i>`}</div></div>
            <div class="lb-fly-sec"><div class="lb-fly-h" title="${esc(t('spec.flyNodesTip'))}">⛏️ ${t('spec.flyNodes')}</div>
                <div class="lb-fly-body">${nodeChips}</div></div>`;
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
        // Loud, because it changes what every other number on the card MEANS. A seat
        // that answered a third of its rounds did not play a third as well -- it played
        // a different match from the one the ranking describes.
        const missedShare = m.decisions ? (m.roundsMissed || 0) / m.decisions : 0;
        if ((m.roundsMissed || 0) >= 3 && missedShare >= 0.1) {
            tags.push({ t: t('tag.roundsMissed', { n: m.roundsMissed,
                                                   pct: Math.round(missedShare * 100) }), cls: 'bad' });
        }
        if (m.silentMs >= 120000) {
            tags.push({ t: t('tag.wentSilent', { m: Math.round(m.silentMs / 60000) }), cls: 'bad' });
        }
        const distinct = Object.keys(m.actionCounts).length;
        if (distinct >= 5) tags.push({ t: t('tag.versatile'), cls: 'good' });
        else if (m.attempted >= 4 && distinct <= 2) tags.push({ t: t('tag.monotonous'), cls: 'warn' });
        const ac = m.actionCounts;
        // Villagers are train_unit calls now, so they have to be subtracted out of the
        // military side and added to the economic one. Left alone, every worker a model
        // trained would have scored as aggression and flipped this tag for exactly the
        // players it describes worst.
        const workers = m.workersTrained || 0;
        const mil = Math.max(0, (ac.train_unit || 0) - workers) + (ac.attack_target || 0) + (ac.move_units || 0);
        const eco = workers + (ac.assign_workers || 0) + (ac.build_structure || 0);
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
                    modelId: OpenAIAIManager.publicModelId(controller.model.model) || '',
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
                // Rounds the seat was asked but did not answer inside the deadline. The
                // counter existed and was never read, so the fair number was collected
                // and thrown away while an unfair one (see the deadline-abort branch in
                // sendToOpenAI) was displayed in its place.
                const missed = st.roundsMissed || 0;
                // Turns lost to a rate limit the retry could not clear. Same standing as
                // a context overflow or a missed round: really lost, so not "answered" —
                // but caused by how fast the ACCOUNT is being driven, not by the model,
                // so it must not read as the endpoint being unreachable.
                const rlLost = st.rateLimitLost || 0;
                const responded = Math.max(0, st.requests - st.timeouts - st.networkErrors - ctxOv - missed - rlLost);
                // Context overflows are lost turns caused by the HARNESS's budgeting,
                // not the endpoint — count them visibly but keep them out of the
                // model's reliability score (both numerator and denominator).
                // Missed rounds leave BOTH sides, exactly like context overflows: the
                // harness cut the request, so it is neither evidence for nor against the
                // endpoint. Latency is reported as latency — that is what the mode is for.
                const reliabilityBase = Math.max(0, st.requests - ctxOv - missed - rlLost);
                // An outage, described rather than judged. A seat can lead a match on
                // tech, have its endpoint go from 8s to 58s and stop, be dismantled over
                // a stretch where it answers four rounds to the others' thirteen -- and
                // the card will say "defeated" with no hint that it went quiet.
                //
                // The numbers only. Whether it would have survived is not the harness's
                // to say: it may have had thirty workers and nothing to fight with, and
                // deciding that is picking the winner of an argument the summary cannot
                // see.
                const lats = (lat || []).slice();
                const med = (arr) => arr.length ? arr.slice().sort((a, b) => a - b)[arr.length >> 1] : 0;
                const silentMs = st.lastAnswerAt ? Math.max(0, Date.now() - st.lastAnswerAt) : 0;
                rep.metrics = {
                    decisions: st.requests, responded,
                    // Split late from early, so a degrading endpoint reads as a CHANGE
                    // rather than as a wide min-max range that could be a single blip.
                    latEarly: lats.length >= 6 ? med(lats.slice(0, -3)) : 0,
                    latLate: lats.length >= 6 ? med(lats.slice(-3)) : 0,
                    silentMs,
                    avgLatency: avg,
                    minLatency: lat.length ? Math.min(...lat) : 0,
                    maxLatency: lat.length ? Math.max(...lat) : 0,
                    timeouts: st.timeouts, networkErrors: st.networkErrors, parseFails: st.parseFails,
                    networkAtMs: st.networkAtMs || [],
                    // Subset of parseFails: replies cut off mid-JSON by the model's
                    // output-token cap. Broken out because it has a fix the others
                    // don't — raise maxTokens for that model.
                    truncated: st.truncatedReplies || 0,
                    noAction: st.noActionReturns || 0,
                    contextOverflows: ctxOv, roundsMissed: missed,
                    rateLimited: st.rateLimited || 0, rateLimitLost: rlLost,
                    invalidActions: st.invalidActions, rejected: st.actionsRejected,
                    contended: st.actionsContended || 0,
                    // How much each turn carried. Reported BESIDE the success rate and
                    // never inside it: scoring per command already means a seat sending
                    // three and getting two right reads 67% while a seat sending one
                    // safe command reads 100%. Without this figure the second looks
                    // simply better, when what it did was less.
                    commandsPerTurn: (st.turnsExecuted || 0)
                        ? st.actionsAttempted / st.turnsExecuted : 0,
                    maxCommands: OpenAIAIManager.MAX_COMMANDS_PER_TURN,
                    finalWord: controller._finalWord || null,
                    promptTokens: st.promptTokens || 0, completionTokens: st.completionTokens || 0,
                    attempted: st.actionsAttempted, succeeded: st.actionsSucceeded,
                    // Contended attempts leave the DENOMINATOR, not just the numerator.
                    // A model whose only failures were a busy barracks made no mistake,
                    // so it should read 1.0 — docking it would score tempo as error, and
                    // the models that contend with themselves most are the busy ones.
                    successRate: (() => {
                        const judged = st.actionsAttempted - (st.actionsContended || 0);
                        return judged > 0 ? st.actionsSucceeded / judged : 0;
                    })(),
                    // Format fidelity: prose-only replies (no JSON action) are format
                    // failures too — they just get their own counter.
                    formatOk: responded > 0 ? (responded - st.parseFails - (st.noActionReturns || 0)) / responded : 0,
                    reliability: reliabilityBase ? 1 - (st.timeouts + st.networkErrors) / reliabilityBase : 0,
                    reasonRate: st.actionsAttempted ? st.reasonsGiven / st.actionsAttempted : 0,
                    actionCounts: st.actionCounts,
                    workersTrained: st.workersTrained || 0
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
                        <div class="winner-civ">${this.teamDotHtml(lead.ai.seat, 10)}${lead.civName} · ${t('sum.snapLeader')}</div>
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
                        <div class="winner-civ">${this.teamDotHtml(wr.ai.seat, 10)}${wr.civName} · ${wr.isLLM ? 'LLM' : t('spec.rulebased')}</div>
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
                            <div class="sum-id"><div class="sum-model">${this.escapeHtml(r.model)}</div><div class="sum-civ">${this.teamDotHtml(r.ai.seat, 9)}${r.civName}</div></div>
                            <span class="sum-power">${r.power}</span>
                        </div>
                        <div class="sum-note">${t('sum.ruleNote')}</div>
                        <div class="sum-final">${r.ageName} · \u{1F477} ${r.workers} · ⚔️ ${r.military} · \u{1F3DB}️ ${r.buildings}${r.alive ? '' : ` · <b style="color:#ff6b81">${t('spec.defeated')}</b>`}</div>
                    </div>`;
                return;
            }
            const avgS = m.avgLatency / 1000;
            const errTotal = m.timeouts + m.networkErrors + m.parseFails + (m.noAction || 0) + m.invalidActions + m.rejected + (m.contextOverflows || 0);
            const tagsHtml = r.tags.map(t => `<span class="sum-tag ${t.cls}">${t.t}</span>`).join('');
            const topActions = Object.entries(m.actionCounts).sort((a, b) => b[1] - a[1]).slice(0, 6)
                .map(([k, v]) => `<span class="sum-chip">${k.replace(/_/g, ' ')}·${v}</span>`).join('');
            html += `
                <div class="sum-card${r.isWinner ? ' winner' : ''}${r.alive ? '' : ' dead'}" style="--civ:${r.color}">
                    <div class="sum-card-head">
                        <span class="sum-rank">${rank}</span>
                        <div class="sum-id"><div class="sum-model">${this.escapeHtml(r.model)}</div><div class="sum-civ">${this.teamDotHtml(r.ai.seat, 9)}${r.civName}${r.alive ? '' : ` · <b style="color:#ff6b81">${t('spec.defeated')}</b>`}</div></div>
                        <span class="sum-power" title="${t('sum.endScore')}">${r.power}</span>
                    </div>
                    <div class="sum-sound">
                        <div class="sum-sound-bar"><div class="sum-sound-fill" style="width:${r.soundness}%"></div></div>
                        <div class="sum-sound-val">${r.soundness}<span>${t('sum.strategySuffix')}</span></div>
                    </div>
                    <div class="sum-tags">${tagsHtml}</div>
                    <div class="sum-metrics">
                        <div class="sum-metric"><span>⏱ ${t('sum.mResponse')}</span><b>${avgS.toFixed(1)}s</b><i>${(m.minLatency / 1000).toFixed(1)}–${(m.maxLatency / 1000).toFixed(1)}s</i></div>
                        ${(m.latLate && m.latEarly && m.latLate >= m.latEarly * 3)
                            ? `<div class="sum-metric bad"><span>\u{1F4C9} ${t('sum.slowdown')}</span><b>${(m.latEarly / 1000).toFixed(1)}s \u2192 ${(m.latLate / 1000).toFixed(1)}s</b><i>${t('sum.slowdownHint')}</i></div>`
                            : ''}
                        <div class="sum-metric"><span>\u{1F9E0} ${t('sum.mDecisions')}</span><b>${m.decisions}</b><i>${t('sum.mAnswered', { n: m.responded })}${(m.roundsMissed || 0) ? ` · ${t('sum.missedRounds', { n: m.roundsMissed })}` : ''} · ${t('sum.perTurn', { n: (m.commandsPerTurn || 0).toFixed(1), max: m.maxCommands || 3 })}</i></div>
                        <div class="sum-metric"><span>✅ ${t('sum.mSuccess')}</span><b>${Math.round(m.successRate * 100)}%</b><i>${m.succeeded}/${m.attempted - (m.contended || 0)}${(m.contended || 0) ? ` · ${t('sum.contended', { n: m.contended })}` : ''}</i></div>
                        <div class="sum-metric"><span>\u{1F4CB} ${t('sum.mFormat')}</span><b>${Math.round(m.formatOk * 100)}%</b><i>${t('sum.mJsonOk')}</i></div>
                        <div class="sum-metric"><span>\u{1F4AC} ${t('sum.mReasons')}</span><b>${Math.round(m.reasonRate * 100)}%</b><i>${t('sum.mOfMoves')}</i></div>
                        <div class="sum-metric"><span>\u{1FA99} ${t('sum.mTokens')}</span><b>${this.fmtTokens(m.promptTokens + m.completionTokens)}</b><i>${(m.promptTokens + m.completionTokens) ? t('sum.mTokSplit', { p: this.fmtTokens(m.promptTokens), c: this.fmtTokens(m.completionTokens) }) : t('sum.mTokNone')}</i></div>
                        <div class="sum-metric${errTotal ? ' err' : ''}"><span>⚠️ ${t('sum.mErrors')}</span><b>${errTotal}</b><i>${t('sum.errBreak', { to: m.timeouts, net: this.netErrLabel(m), parse: m.parseFails, cut: m.truncated || 0, na: m.noAction || 0, inv: m.invalidActions, rej: m.rejected, ctx: m.contextOverflows || 0 })}</i></div>
                    </div>
                    <div class="sum-actions">${topActions || `<span class="sum-chip">${t('sum.noActions')}</span>`}</div>
                    ${m.finalWord ? `<div class="sum-word"><span class="sum-word-h">\u{1F5E3}\uFE0F ${t('sum.finalWord')}</span><p>${this.escapeHtml(m.finalWord.text || m.finalWord.error || t('sum.finalWordNone'))}</p></div>` : ''}
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

        // Append the outcome and the curve to the transcript, so one file carries the
        // conditions, every exchange, the result and the graph — a match can be handed
        // on and read end to end without a second download. The markdown export stays
        // exactly as it was for anyone who wants only that.
        //
        // Guarded on !snapshot: the Results button opens this mid-match with numbers
        // that are not final, and a second results line would leave a reader guessing
        // which one counts.
        if (!snapshot) {
            const rec = this.game.openAIAIManager && this.game.openAIAIManager.transcripts;
            if (rec && rec.hasData && rec.hasData()) {
                try { rec.finish([this.publicResults(this._lastSummary), this.publicTimeline()]); }
                catch (e) { console.warn('[transcript] summary tail failed', e); }
            }
        }

        // Snapshot: Back returns to the running game; hide the terminal
        // navigation so a live match can't be abandoned by accident. A real end
        // (also when it fires WHILE a snapshot is open) restores the buttons.
        // A snapshot carries NO buttons at all: the Results toggle that opened it
        // closes it, and saving mid-match saves a partial run nobody wants — that
        // belongs at the end, where the numbers are final.
        const newBtn = document.getElementById('summaryNewArenaBtn');
        const menuBtn = document.getElementById('summaryMenuBtn');
        const saveBtn = document.getElementById('summarySaveBtn');
        if (newBtn) newBtn.style.display = snapshot ? 'none' : '';
        if (menuBtn) menuBtn.style.display = snapshot ? 'none' : '';
        if (saveBtn) saveBtn.style.display = snapshot ? 'none' : '';

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
        this.updateSnapshotBtn();
        // Get the tail of the match onto disk before the download button can be
        // pressed, or the last few turns of each player would be missing from it.
        const rec = this.game.openAIAIManager && this.game.openAIAIManager.transcripts;
        if (rec && !snapshot) { try { rec.flushAll(); } catch (e) {} }
        this.updateTranscriptOffer(snapshot);
        this.renderSummaryChart();
    }

    // ---- In-match transcript viewer ------------------------------------------
    // One panel, re-targeted rather than one per model: the spyglass on another
    // card swaps whose exchange is shown instead of stacking a second window over
    // the match. Reads the recorder's in-memory ring (last 300 turns), so opening
    // it costs nothing and it follows the match live.
    // Which log entries have an exchange behind them. Spectator advice and the
    // harness's own pause/resume/defeat notices are written without a model turn,
    // so there is nothing to open.
    // ---- Simulation speed -------------------------------------------------------
    // The button shows what is running and opens a small menu of all three speeds. It
    // used to cycle, which meant 1x -> 2x could only be reached THROUGH 1.5x — the
    // match actually simulated at a speed nobody asked for on the way past.
    //
    // Hover opens it; a click pins it open, which is the only route on a touch screen.
    simSpeedLabel(v) { return Number(v).toLocaleString(typeof getUiLang === 'function' ? getUiLang() : 'en'); }

    toggleSimSpeedMenu() {
        const wrap = document.getElementById('simSpeedWrap');
        if (!wrap) return;
        wrap.classList.toggle('is-open');
        if (!this._simSpeedOutside) {
            this._simSpeedOutside = (e) => {
                if (!wrap.contains(e.target)) wrap.classList.remove('is-open');
            };
            document.addEventListener('click', this._simSpeedOutside);
        }
    }

    // Confirmed ONCE per match on the first speed-up, not on every pick. Speeding up
    // changes what a result means, so it deserves a warning — but a dialog on every
    // press is friction, and slowing back down never needs one.
    pickSimSpeed(mult) {
        const wrap = document.getElementById('simSpeedWrap');
        if (wrap) wrap.classList.remove('is-open');
        // 0 is not a speed, it is the pause request. Kept on this control because that
        // is where a spectator looks for "how fast is this going", and stopped is a
        // point on that scale — but it never touches simSpeed, so the speed the match
        // was running at is still there when it resumes.
        if (mult === 0) { this.game.requestPause(); this.updateSimSpeedButton(); return; }
        const wasPaused = this.game.pauseState !== 'running';
        if (wasPaused) this.game.resumeSim();
        const cur = this.game.simSpeed || 1;
        // Resuming at the speed it was already set to is a real change (paused -> that
        // speed), so the early-out only applies when nothing at all would happen.
        if (mult === cur && !wasPaused) return;
        const apply = () => { this.game.setSimSpeed(mult); this.updateSimSpeedButton(); };
        if (mult > cur && !this._simSpeedWarned) {
            this._simSpeedWarned = true;
            this.showConfirm(t('spec.simSpeedWarn'), apply, {
                title: t('spec.simSpeedWarnTitle'),
                confirmLabel: t('spec.simSpeedGo'),
                cancelLabel: t('dlg.keepPlaying')
            });
            return;
        }
        apply();
    }

    updateSimSpeedButton() {
        const btn = document.getElementById('simSpeedBtn');
        if (!btn || !this.game) return;
        const set = this.game.simSpeed || 1;
        const eff = this.game.effectiveSimSpeed ? this.game.effectiveSimSpeed() : set;
        const locked = eff !== set;   // showing a speed that is NOT the one running
        // Whether a Wonder is holding the tempo at all — which is a different question
        // from whether the DISPLAYED number is wrong. At 2x or 4x the two coincide and
        // the struck button said so, but at 1x "chosen" and "running" agree, so every
        // signal went quiet: the control looked entirely normal while three of its five
        // options were unreachable. The state has to be readable at 1x too.
        const heldByWonder = (typeof this.game.anyWonderStanding === 'function')
            ? this.game.anyWonderStanding() : locked;
        const pstate = this.game.pauseState || 'running';
        // "Pausing" is its own face, not a spinner for politeness: between the press and
        // the stop the match really is still running, and saying "paused" then would be
        // the button lying about the world for as long as a slow endpoint takes.
        if (pstate === 'paused')       btn.textContent = `⏸ ${t('spec.simPaused')}`;
        else if (pstate === 'pausing') btn.textContent = `⏳ ${t('spec.simPausing')}`;
        // Locked: lead with the speed that is RUNNING and keep the choice beside it,
        // struck through. The class alone said "not this" without ever saying what
        // instead, so the control answered "what did I pick" while the only question
        // being asked of it was "how fast is this going".
        else if (locked)               btn.innerHTML = `⏱ ${this.simSpeedLabel(eff)}×`
                                           + `<span class="sb-speed-set">${this.simSpeedLabel(set)}×</span>`;
        else                           btn.textContent = `⏱ ${this.simSpeedLabel(set)}×`;
        btn.classList.toggle('sb-on', set !== 1 || pstate !== 'running');
        btn.classList.toggle('is-paused', pstate !== 'running');
        // Say WHY it is not running at the chosen speed, rather than silently lying.
        btn.classList.toggle('is-locked', locked && pstate === 'running');
        btn.title = pstate === 'pausing' ? t('spec.simPausingTitle')
            : pstate === 'paused' ? t('spec.simPausedTitle')
            // Two different sentences, because "returns to 1x once it falls" is not a
            // thing to tell someone already running at 1x.
            : locked ? t('spec.simSpeedLocked', { s: String(set) })
            : heldByWonder ? t('spec.simSpeedHeld')
            : t('spec.simSpeedTitle');
        // Repainted on the arena clock's beat, so the decimal separator follows a
        // language switch mid-match without its own hook.
        document.querySelectorAll('#simSpeedMenu .sb-speed-opt').forEach(o => {
            const v = parseFloat(o.dataset.speed);
            if (v === 0) {
                o.textContent = `⏸ ${t('spec.simPause')}`;
                o.classList.toggle('is-active', pstate !== 'running');
                return;
            }
            o.textContent = `${this.simSpeedLabel(v)}×`;
            // While paused, no SPEED is the active one — the match is stopped, and
            // highlighting 4x there would say it is running at 4x.
            o.classList.toggle('is-active', v === set && pstate === 'running');
            // Anything above 1x is out of reach while a Wonder stands. The menu offered
            // all four as though the choice were open, which is where the control was
            // least honest: this is the exact moment a spectator opens it to speed
            // through a hold. Still clickable — the pick is remembered for when the
            // Wonder falls — but no longer pretending to be available now.
            const held = heldByWonder && v > 1;
            o.classList.toggle('is-held', held);
            o.title = held ? t('spec.simSpeedHeldOpt') : '';
        });
    }

    logEntryLinkable(entry) {
        if (!entry || entry.isAdvice) return false;
        if (['advice', 'paused', 'resumed', 'defeated'].includes(entry.action)) return false;
        const rec = this.game.openAIAIManager && this.game.openAIAIManager.transcripts;
        return !!(rec && rec.turnsFor(entry.playerId) > 0);
    }

    // Jump from a decision-log entry to the exchange that produced it.
    //
    // The two records are matched on TIME rather than a shared id, because no single
    // counter is correct for both: the log entry for a failed parse is written inside
    // parseResponse, BEFORE the transcript turn exists, and the entry for an executed
    // action just after it. Turns are seconds apart while those two writes are
    // milliseconds apart, so nearest-in-time is unambiguous — and it stays correct if
    // either side is reordered later, which a stamped counter would not.
    openTranscriptAt(key) {
        const mgr = this.game.openAIAIManager;
        const entry = ((mgr && mgr.decisionLog) || []).find(e => e._uid === Number(key));
        if (!entry) return;
        this._transcriptFor = entry.playerId;
        this._tvRendered = null;              // may be a different model → full rebuild
        this.renderTranscriptViewer();
        this.updateSpectatorPlayerList();     // repaint the spyglass active states

        const turns = (mgr && mgr.transcripts) ? mgr.transcripts.recent(entry.playerId) : [];
        let best = null, bestD = Infinity;
        turns.forEach(x => {
            const d = Math.abs((x.at || 0) - entry.timestamp);
            if (d < bestD) { bestD = d; best = x; }
        });
        // Older turns fall off the recorder's 300-turn ring; the viewer cannot show
        // what it no longer holds, so open it and leave the reader at the top.
        //
        // Clicking a decision says which turn is wanted, so that turn is PINNED: the
        // incremental render anchors on it instead of following the newest arrival.
        // Without this, asking for the turn that happens to be newest left the reader
        // at scrollTop 0 — indistinguishable from following live — and the next answer
        // to land pushed the requested turn straight out of view.
        if (best) { this._tvPinned = best.turn; this.tvJumpTo(best.turn); }
    }

    // Stop holding the requested turn. Called whenever the reader says, by some other
    // action, that they are done with it.
    tvUnpin() { this._tvPinned = null; }

    // Scroll a turn into view and flash it: in a list where every entry looks alike,
    // landing near the right one is not the same as finding it.
    tvJumpTo(turn) {
        const body = document.getElementById('tvBody');
        if (!body) return;
        const el = body.querySelector(`.tv-turn[data-key="${turn}"]`);
        if (!el) return;
        // Same measure the section-mirroring uses: rects, not offsetTop, which is
        // relative to whichever ancestor happens to be positioned.
        const gap = el.getBoundingClientRect().top - body.getBoundingClientRect().top;
        body.scrollTop = Math.max(0, body.scrollTop + gap - 8);
        el.classList.remove('tv-jumped');
        void el.offsetWidth;                  // restart the flash when re-clicked
        el.classList.add('tv-jumped');
        this.updateTranscriptTopBtn();
    }

    toggleTranscriptViewer(aiId) {
        // A different seat, or none: whatever turn was being held belonged to the old one.
        this.tvUnpin();
        this._transcriptFor = (this._transcriptFor === aiId) ? null : aiId;
        this._tvRendered = null;            // different model → full rebuild
        this.renderTranscriptViewer();
        this.updateSpectatorPlayerList();   // repaint the spyglass active states
    }

    // Mirrors the decision log's arrow: the viewer is a deep scroller once a match
    // runs long, and having anchored the scroll there must be a fast way back to the
    // newest turn.
    updateTranscriptTopBtn() {
        const body = document.getElementById('tvBody');
        const btn = document.getElementById('tvTopBtn');
        if (!body || !btn) return;
        btn.classList.toggle('visible', body.scrollTop > 24);
    }

    scrollTranscriptTop() {
        // The arrow means "back to the newest", which is the opposite of holding a turn.
        this.tvUnpin();
        // Same call the decision log's arrow uses. A rAF tween was tried here after
        // smooth-scroll appeared dead in testing; that turned out to be the preview
        // tab being hidden (visibilityState 'hidden', zero rAF frames), which stops a
        // hand-rolled animation just as dead. Nothing was wrong with the platform API.
        const body = document.getElementById('tvBody');
        if (body) body.scrollTo({ top: 0, behavior: 'smooth' });
    }

    // Fill a state section's <pre> on first open, from the ring. The JSON never sits
    // in the document until someone asks for it.
    tvFillState(d) {
        const pre = d && d.querySelector('pre');
        if (!pre || pre.dataset.filled) return;
        const r = this.game.openAIAIManager && this.game.openAIAIManager.transcripts;
        let entry = (r ? r.recent(this._transcriptFor) : [])
            .find(x => String(x.turn) === d.dataset.turn);
        // The ring above belongs to the LIVE recorder. The analyzer has no live match
        // behind it -- it is reading a file -- so that lookup found nothing and this
        // section sat empty for every transcript ever opened here, which reads as a
        // broken panel rather than as a panel with nothing to say. The record on screen
        // carries its own state; anDetailHtml is already drawing numbers out of it.
        if (!entry && this.analyzer && this.analyzer.order) {
            const c = this.analyzer.order[this.analyzer.cursor];
            if (c && String(c.turn) === d.dataset.turn) entry = c;
        }
        if (!entry || !entry.state) return;
        pre.textContent = JSON.stringify(entry.state, null, 1);
        pre.dataset.filled = '1';
    }

    closeTranscriptViewer() {
        this._transcriptFor = null;
        this.renderTranscriptViewer();
        this.updateSpectatorPlayerList();
    }

    // One turn's markup. The state's <pre> is left EMPTY and filled on first open:
    // a match-long transcript holds hundreds of 4KB JSON blobs, and putting them all
    // in the document is what made a rebuild cost seconds. Nobody reads more than a
    // couple of them.
    // Which section TYPES are open, not which instances. Collapsing "Reply" once
    // means every reply is collapsed, including on turns that have not arrived yet —
    // a reader who does not care about a section does not care about it four turns
    // from now either, and having new entries always arrive fully expanded both
    // surprised the reader and made every insert the tallest it could be.

    // Walk a seat's turns oldest-first, carrying the standing objective and plan onto
    // each. Idempotent: called on every render over the same ring, and re-stamping a
    // record with the same values costs nothing.
    tvCarryPlan(turns) {
        if (!Array.isArray(turns) || !turns.length) return;
        const ordered = turns.slice().sort((a, b) => (a.turn || 0) - (b.turn || 0));
        let obj = null, plan = null;
        ordered.forEach(e => {
            const p = e.parsed || {};
            const hadObj = typeof p.objective === 'string' && p.objective.trim();
            const rawPlan = Array.isArray(p.plan) ? p.plan
                : (typeof p.plan === 'string' && p.plan.trim() ? [p.plan] : null);
            if (hadObj) obj = p.objective.trim();
            if (rawPlan && rawPlan.length) plan = rawPlan.slice();
            e._objective = obj;
            e._plan = plan;
            e._objectiveNew = !!hadObj;
            e._planNew = !!(rawPlan && rawPlan.length);
        });
    }
    tvSectionPrefs() {
        if (!this._tvSecOpen) {
            this._tvSecOpen = { 'tv-reason': true, 'tv-reply': true, 'tv-result': true, 'tv-state': false };
        }
        return this._tvSecOpen;
    }

    // Remember an open/closed section so the next repaint honours it.
    tvSecSet(cls, open) {
        this.tvSectionPrefs()[cls] = !!open;
    }

    // The plan a turn was working to, as text for a tv-sec. Reads the CARRIED-FORWARD
    // values when a caller has resolved them (_objective/_plan) and the turn's own
    // fields otherwise: objective and plan persist across turns — "omit to keep current"
    // — so about nine turns in ten restate neither while very much having both, and
    // reading only the line would show a blank plan that is not blank.
    tvPlanText(e) {
        const obj = (e._objective != null) ? e._objective : (e.parsed && e.parsed.objective);
        const raw = (e._plan != null) ? e._plan : (e.parsed && e.parsed.plan);
        const steps = Array.isArray(raw) ? raw : (typeof raw === 'string' && raw.trim() ? [raw] : []);
        if (!obj && !steps.length) return '';
        const lines = [];
        if (obj) lines.push('\uD83C\uDFAF ' + obj);
        steps.forEach((x, i) => lines.push((i + 1) + '. ' + x));
        // Said only when true, and it is the one thing worth noticing: the turn the
        // model changed its mind is the turn to read.
        if (e._planNew || e._objectiveNew) lines.push('(' + t('an.rewritten') + ')');
        return lines.join('\n');
    }

    // opts.skipPlan: the analyzer renders its own richer plan card above this block and
    // must not print it twice.
    tvTurnHtml(e, opts) {
        const esc = s => this.escapeHtml(String(s == null ? '' : s));
        const pref = this.tvSectionPrefs();
        // ontoggle writes the choice back. Without it _tvSecOpen was read but never
        // written, so opening Reasoning by hand lasted until the next repaint — which
        // during playback is one second. The preference is per SECTION KIND and lives on
        // the UI, so it holds across turns, across seats and across transcripts: open
        // Reasoning once and you can follow reasoning all the way through a match.
        const keep = cls => ` ontoggle="game.ui.tvSecSet('${cls}', this.open)"`;
        const sec = (cls, label, text) => text
            ? `<details class="tv-sec ${cls}"${pref[cls] ? ' open' : ''}${keep(cls)}><summary>${label}</summary><pre>${esc(text)}</pre></details>`
            : '';
        // A section with nothing in it used to render as nothing at all, so a turn where
        // the model answered with pure reasoning and no reply simply lost its Reply block
        // — and a run of those reads as the viewer being broken rather than as the model
        // having said nothing. An empty answer is the single most useful thing to know
        // about such a turn, so it is stated.
        const emptySec = (cls, label, note) =>
            `<details class="tv-sec ${cls} is-empty"${pref[cls] ? ' open' : ''}${keep(cls)}><summary>${label}</summary><pre>${esc(note)}</pre></details>`;
        // With tool calls the whole answer arrives in tool_calls and content is empty,
        // so a turn that acted perfectly rendered as "the model returned nothing here"
        // while the Harness block below carried every word of substance. The calls ARE
        // the reply — reading them as an absence made the viewer look broken on exactly
        // the turns that went best.
        // BOTH when both arrived. Letting content win hid the calls of any model that
        // writes a sentence beside them — and a model narrating what it is about to do
        // is exactly the kind that a reader wants to watch, so hiding half of it there
        // would be the worst place to hide anything.
        const toolText = this.toolCallsAsText(e.assistant && e.assistant.tool_calls);
        const replyText = [(e.assistant && e.assistant.content) || '', toolText]
            .filter(x => x && String(x).trim()).join('\n\n');
        const hadReasoning = !!(e.assistant && e.assistant.reasoning);
        const replySec = replyText
            ? sec('tv-reply', t('spec.tvReply'), replyText)
            : (e.assistant ? emptySec('tv-reply', t('spec.tvReply'),
                 hadReasoning ? t('spec.tvReplyEmptyThought') : t('spec.tvReplyEmpty')) : '');
        const tok = e.tokens ? `${e.tokens.prompt}→${e.tokens.completion} tok` : '';
        const ms = e.latencyMs != null ? `${(e.latencyMs / 1000).toFixed(1)}s` : '';
        const act = e.parsed && e.parsed.action ? e.parsed.action : null;
        const failed = typeof e.harnessResult === 'string' && e.harnessResult.startsWith('[ERROR]');
        const state = e.state
            ? `<details class="tv-sec tv-state"${pref['tv-state'] ? ' open' : ''}${keep('tv-state')} data-turn="${esc(e.turn)}"><summary>${t('spec.tvState')}</summary><pre></pre></details>`
            : '';
        return `
            <div class="tv-turn${failed ? ' is-error' : ''}" data-key="${esc(e.turn)}">
                <div class="tv-turn-head">
                    <span class="tv-n">#${esc(e.turn)}</span>
                    ${act ? `<span class="tv-act">${esc(act)}</span>` : ''}
                    <span class="tv-meta">${esc(ms)}${ms && tok ? ' · ' : ''}${esc(tok)}</span>
                </div>
                ${sec('tv-reason', t('spec.tvReasoning'), e.assistant && e.assistant.reasoning)}
                ${(opts && opts.skipPlan) ? '' : sec('tv-plan', t('spec.tvPlan'), this.tvPlanText(e))}
                ${replySec}
                ${sec('tv-result', t('spec.tvResult'), e.harnessResult)}
                ${state}
            </div>`;
    }

    renderTranscriptViewer() {
        const el = document.getElementById('transcriptViewer');
        if (!el) return;
        const id = this._transcriptFor;
        if (!id) { el.style.display = 'none'; this._tvRendered = null; return; }

        const rec = this.game.openAIAIManager && this.game.openAIAIManager.transcripts;
        const ai = ((this.game.aiManager && this.game.aiManager.aiPlayers) || []).find(a => a.id === id);
        const turns = rec ? rec.recent(id) : [];
        // Resolve objective/plan across the whole ring before anything is rendered.
        // Stamped onto the records, not the DOM, so the incremental path below still
        // only touches the turns that are new — and every turn then knows the plan it
        // was working to, not just the one in ten that restated it. Entries older than
        // the ring's first restatement show none, exactly as a truncated file does in
        // the analyzer.
        this.tvCarryPlan(turns);
        el.style.display = '';

        const head = document.getElementById('tvTitle');
        const cnt = document.getElementById('tvCount');
        if (head) head.innerHTML = `${this.teamDotHtml(ai && ai.seat, 11)}<span>${this.escapeHtml(
            (turns.length && turns[turns.length - 1].name) || (ai && ai.civilization) || id)}</span>`;
        if (cnt) cnt.textContent = turns.length ? `${turns.length}` : '';

        const body = document.getElementById('tvBody');
        if (!body) return;
        if (!body._tvBound) {
            body.addEventListener('scroll', () => {
                // Scrolling above the pinned turn means the reader has gone looking at
                // newer answers, so the hold is released and the viewer follows the top
                // again. Scrolling BELOW it, into older history, is still reading around
                // the thing they asked for — the pin stays.
                if (this._tvPinned != null) {
                    const el = body.querySelector(`.tv-turn[data-key="${this._tvPinned}"]`);
                    if (!el || body.scrollTop < el.offsetTop - 12) this.tvUnpin();
                }
                this.updateTranscriptTopBtn();
            });
            // 'toggle' does not bubble, so capture it. Fills a state section the first
            // time it is opened, from the ring — the JSON never sits in the document
            // until someone actually asks for it.
            body.addEventListener('toggle', (ev) => {
                const d = ev.target;
                if (!d || !d.classList || !d.classList.contains('tv-sec')) return;
                const cls = [...d.classList].find(c => c !== 'tv-sec');
                if (!cls) return;
                if (d.classList.contains('tv-state') && d.open) this.tvFillState(d);

                // Echo check, NOT a re-entrancy flag: 'toggle' fires asynchronously, so
                // a flag set and cleared around the cascade is already false by the time
                // the cascade's own events land. Each then re-entered as if the reader
                // had clicked it — one click produced 153 events and nudged the scroll
                // 51 times, which is where the drift came from. If this section already
                // matches the stored preference it IS one of those echoes.
                const pref = this.tvSectionPrefs();
                if (pref[cls] === d.open) return;
                pref[cls] = d.open;

                // Mirror across every turn, holding the clicked section still: the
                // others change height around it, and the reader is looking at THIS one.
                const gap = d.getBoundingClientRect().top - body.getBoundingClientRect().top;
                body.querySelectorAll(`.${cls}`).forEach(o => {
                    if (o === d || o.open === d.open) return;
                    o.open = d.open;
                    if (d.open && o.classList.contains('tv-state')) this.tvFillState(o);
                });
                const moved = (d.getBoundingClientRect().top - body.getBoundingClientRect().top) - gap;
                if (moved) body.scrollTop += moved;
            }, true);
            body._tvBound = true;
        }

        if (!turns.length) {
            body.innerHTML = `<div class="tv-empty">${t('spec.tvEmpty')}</div>`;
            this._tvRendered = { id, keys: [] };
            return;
        }

        // Rebuilding the whole list on every turn was the freeze: 251ms at 25 turns,
        // 5.7s at the 300 cap, and it grew as a match ran. The list only ever changes
        // by gaining turns at the top and shedding them off the bottom, so do exactly
        // that. It also removes the need to save and restore scroll position, open
        // sections and their inner scroll — untouched nodes simply keep all three.
        const keys = turns.map(e => e.turn);
        const prev = (this._tvRendered && this._tvRendered.id === id) ? this._tvRendered.keys : null;
        if (!prev) {
            body.innerHTML = turns.slice().reverse().map(e => this.tvTurnHtml(e)).join('');
            body.scrollTop = 0;
            this._tvRendered = { id, keys };
            this.updateTranscriptTopBtn();
            return;
        }
        if (prev.length === keys.length && prev[prev.length - 1] === keys[keys.length - 1]) {
            this.updateTranscriptTopBtn();
            return;                       // nothing new
        }

        const prevSet = new Set(prev);
        const fresh = turns.filter(e => !prevSet.has(e.turn));
        const gone = prev.filter(k => !keys.includes(k));
        gone.forEach(k => {
            const n = body.querySelector(`[data-key="${k}"]`);
            if (n) n.remove();            // fell off the ring
        });

        // Insert ascending at the top so the newest ends up first, then put the
        // reader back on the entry they were looking at.
        //
        // NOT a scrollHeight delta: that assumes insertion is the only thing that
        // changed height, and it is not — collapsing a section or lazily filling a
        // state JSON changes it too, and the correction was then wrong by a constant
        // ~940px no matter where the collapse happened. Anchoring on an ELEMENT is
        // exact whatever else moved.
        // A turn the reader ASKED for outranks following the live top. It is checked
        // first and independently of scrollTop, because a pinned turn that happens to be
        // the newest one sits AT the top, where the follow-the-top rule would otherwise
        // claim it.
        const pinned = (this._tvPinned != null)
            ? body.querySelector(`.tv-turn[data-key="${this._tvPinned}"]`) : null;
        // Pinned to a turn the ring has since dropped: nothing left to hold on to.
        if (this._tvPinned != null && !pinned) this.tvUnpin();
        const atTop = !pinned && body.scrollTop <= 4;
        let anchorEl = pinned, anchorGap = pinned ? (pinned.offsetTop - body.scrollTop) : 0;
        if (!atTop && !anchorEl) {
            for (const el of body.children) {
                if (el.offsetTop + el.offsetHeight > body.scrollTop) {  // first visible turn
                    anchorEl = el;
                    anchorGap = el.offsetTop - body.scrollTop;
                    break;
                }
            }
        }
        fresh.forEach(e => body.insertAdjacentHTML('afterbegin', this.tvTurnHtml(e)));
        if (atTop) body.scrollTop = 0;
        else if (anchorEl && anchorEl.isConnected) body.scrollTop = Math.max(0, anchorEl.offsetTop - anchorGap);

        this._tvRendered = { id, keys };
        this.updateTranscriptTopBtn();
    }

    // ---- Match transcripts ---------------------------------------------------
    // Recorded for every player of every match, offered here, and deleted when this
    // screen is left. The point of the short life is that nothing accumulates on
    // disk unasked — and that the offer appears at the one moment it is relevant,
    // so it needs no separate management screen to discover or clean up.
    updateTranscriptOffer(snapshot) {
        const btn = document.getElementById('summaryTranscriptBtn');
        const note = document.getElementById('summaryTranscriptNote');
        const rec = this.game.openAIAIManager && this.game.openAIAIManager.transcripts;
        // A snapshot is a mid-match peek: the match continues and so does recording,
        // so nothing is offered or deleted here.
        const show = !!(rec && rec.hasData() && !snapshot);
        if (btn) btn.style.display = show ? '' : 'none';
        if (note) {
            note.style.display = show ? '' : 'none';
            if (show) note.textContent = t('sum.transcriptNote', { turns: rec.turnsRecorded() });
        }
    }

    async downloadTranscripts() {
        const rec = this.game.openAIAIManager && this.game.openAIAIManager.transcripts;
        if (!rec || !rec.hasData()) return;
        try {
            const blob = await rec.exportBlob();
            const a = document.createElement('a');
            const url = URL.createObjectURL(blob);
            a.href = url;
            a.download = `${rec.matchId || 'match'}-transcripts.jsonl`;
            document.body.appendChild(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 4000);
        } catch (e) {
            console.warn('[transcript] download failed', e);
        }
    }

    // Leaving the results screen for good: the transcripts go with it, exactly as
    // the notice said. Awaited BEFORE a reload, because an async delete started
    // during unload is not reliably finished — and begin() purges again next match
    // as the backstop for the paths that never reach here at all (a crash, a tab
    // closed outright).
    async leaveArenaSummary(toMainMenu) {
        const rec = this.game.openAIAIManager && this.game.openAIAIManager.transcripts;
        try { if (rec) await rec.purge(); } catch (e) { /* leaving anyway */ }
        if (toMainMenu) location.reload();
        else this.game.showArenaSetup();
    }

    // Back from a snapshot overlay to the (still running) match.
    closeArenaSnapshot() {
        const sumEl = document.getElementById('arenaSummaryScreen');
        if (sumEl) sumEl.classList.remove('snapshot', 'active');
        const gs = document.getElementById('gameScreen');
        if (gs && this.game && this.game.gameStarted) gs.classList.add('active');
        this.updateSnapshotBtn();
    }

    // Light the Results button while its card is up, the way Auto lights while the
    // director camera runs — the toggle has to show which way it is currently set.
    // Called when the Results card is opened, so the chart rebuilds once on entry
    // and then only when new samples land.
    // Clears EVERY target's cached signature. It was one field, and when the chart
    // gained a second target the reset kept clearing a name nothing read any more — a
    // forced redraw that silently stopped forcing anything.
    resetChartCache() { this._chartSigs = {}; }

    updateSnapshotBtn() {
        const btn = document.getElementById('arenaSnapshotBtn');
        const el = document.getElementById('arenaSummaryScreen');
        if (!btn) return;
        btn.classList.toggle('sb-on', !!(el && el.classList.contains('snapshot')
            && el.classList.contains('active')));
    }

    // ---- End-of-match graph --------------------------------------------------
    // Hand-rolled SVG. A chart library would be the single largest dependency in a
    // project whose README leads with a zero-dependency badge — and a line chart
    // with axes is under a hundred lines of path building.
    //
    // Two views over the same samples:
    //   gathered — cumulative resources DELIVERED, summed. Monotonic, so growth is
    //              growth. Held stockpiles would measure hoarding instead: a player
    //              turning resources into army shows a FALLING balance, and the
    //              winner often ends poorest.
    //   power    — the leaderboard's composite. "Who was winning", against "who
    //              built the bigger economy". The gap between one player's two
    //              curves is itself worth seeing.
    setChartMode(mode) {
        this._chartMode = mode;
        this.renderSummaryChart();
    }

    // A player's line colour: the SEAT badge, not the civilization.
    //
    // A proper model comparison gives every seat the same civ so balance cannot
    // explain the result — and civ colours would then paint all four lines
    // identically, exactly when the graph matters most. The seat badge is already
    // the thing that distinguishes players everywhere else in this UI for the same
    // reason (see the note on teamDotHtml about 4×Egypt), so the line now wears the
    // badge you are reading beside it.
    //
    // Through legibleColor because seat 0's charcoal #222222 would vanish against
    // the dark chart — the same reason teamBadgeRimOnDark exists. Falls back to the
    // civ colour if a seat is somehow unknown.
    // legibleColor is tuned for TEXT: it blends 55% toward white below 0.42
    // luminance, which small type needs. A 2.2px stroke does not — it stays
    // readable far darker, and washing it out costs the saturation that tells four
    // lines apart. Seat 2's emerald (#009E60, luminance 0.406) landed just under
    // that threshold and came out a pale mint. This rescues only genuinely dark
    // fills, and blends less when it does.
    chartInk(hex) {
        const h = String(hex || '').replace('#', '');
        if (h.length !== 6) return this.legibleColor(hex);
        const [r, g, b] = [0, 2, 4].map(i => parseInt(h.substr(i, 2), 16));
        const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
        if (lum >= 0.28) return '#' + h;                 // already carries on dark
        const f = 0.45;
        const to2 = v => Math.round(v).toString(16).padStart(2, '0');
        return '#' + to2(r + (255 - r) * f) + to2(g + (255 - g) * f) + to2(b + (255 - b) * f);
    }

    chartColor(ai) {
        const b = (typeof getTeamBadge === 'function') ? getTeamBadge(ai && ai.seat) : null;
        if (b && b.fill) return this.chartInk(b.fill);
        const civ = (typeof getCivilization === 'function') ? getCivilization(ai.civilization) : null;
        return this.legibleColor('#' + ((civ && civ.color) || 0xffffff).toString(16).padStart(6, '0'));
    }

    chartValue(row, id, mode) {
        const p = row.p && row.p[id];
        if (!p) return 0;
        return mode === 'power' ? (p.pw || 0) : (p.f || 0) + (p.w || 0) + (p.s || 0) + (p.o || 0);
    }

    // Drawn for the results screen and, with a `src`, for a transcript loaded off disk.
    // Parameterised rather than copied: a second chart implementation would be a second
    // place for the age markers, the ran-dry ticks and the dead-player scrim to drift,
    // and this file has been fixing exactly that class of bug all week.
    //
    // src (all optional): { timeline, players, mode, el, playheadSeconds, sigKey }.
    // Omitted, it reads the live match and the summary screen's boxes.
    renderSummaryChart(src) {
        const S = src || {};
        const el = S.el || {
            box: 'summaryChart', main: 'chartMain', strips: 'chartStrips', legend: 'chartLegend',
            title: 'chartTitle', gathered: 'chartModeGathered', power: 'chartModePower'
        };
        const box = document.getElementById(el.box);
        if (!box) return;
        const tl = S.timeline || (this.game && this.game._timeline);
        const all = (tl && tl.samples) || [];
        if (all.length < 2) { box.style.display = 'none'; return; }  // a dot says nothing
        // The plot is ~900px wide, so anything past a few hundred points lands
        // inside the same pixel. Without this a 100-minute match built 477KB of SVG
        // and took 7ms a redraw; thinned it is ~2ms and flat no matter how long the
        // match runs — which is what makes a live refresh free.
        const CAP = 300;
        const stride = Math.max(1, Math.ceil(all.length / CAP));
        const samples = stride === 1 ? all : all.filter((_, i) => i % stride === 0 || i === all.length - 1);
        // Only {id, seat, civilization} is ever read, so a transcript header's player
        // list stands in for live aiPlayers without adapting anything.
        const players = (S.players || (this.game.aiManager && this.game.aiManager.aiPlayers) || [])
            .filter(a => samples.some(r => r.p && r.p[a.id]));
        if (!players.length) { box.style.display = 'none'; return; }
        box.style.display = '';

        const mode = (S.mode != null ? S.mode : this._chartMode) || 'gathered';
        // Cheap guard so the live refresh can poll every second and pay for itself
        // only when a sample actually landed (they arrive every 5s). Also stops the
        // rebuild from wiping the reader's mode selection mid-glance.
        // The playhead moves without the data changing, so it belongs in the signature
        // or a scrub would repaint nothing. Cached per target box: two charts on two
        // screens sharing one signature would each suppress the other's redraw.
        const sig = all.length + ':' + mode + ':' + players.length + ':' + getUiLang()
            + ':' + (S.playheadSeconds == null ? '-' : S.playheadSeconds)
            + ':' + (S.sigKey || 'live');
        this._chartSigs = this._chartSigs || {};
        if (sig === this._chartSigs[el.box]) return;
        this._chartSigs[el.box] = sig;
        const gBtn = document.getElementById(el.gathered);
        const pBtn = document.getElementById(el.power);
        if (gBtn && pBtn) {
            gBtn.textContent = t('sum.chartGathered'); pBtn.textContent = t('sum.chartPower');
            gBtn.classList.toggle('is-on', mode === 'gathered');
            pBtn.classList.toggle('is-on', mode === 'power');
        }
        const titleEl = document.getElementById(el.title);
        if (titleEl) titleEl.textContent =
            t(mode === 'power' ? 'sum.chartTitlePower' : 'sum.chartTitleGathered');

        const W = 900, H = 300, ML = 62, MR = 14, MT = 12, MB = 26;
        const tMax = samples[samples.length - 1].t || 1;
        let vMax = 0;
        samples.forEach(r => players.forEach(pl => {
            vMax = Math.max(vMax, this.chartValue(r, pl.id, mode));
        }));
        if (vMax <= 0) vMax = 1;
        const X = s => ML + (s / tMax) * (W - ML - MR);
        const Y = v => H - MB - (v / vMax) * (H - MT - MB);
        const esc = v => this.escapeHtml(String(v));
        const mmss = s => Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
        const nice = v => v >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : v >= 1000 ? Math.round(v / 1000) + 'k' : String(Math.round(v));
        // res.* carries an emoji for the HUD; the chart wants the bare word.
        const resWord = k => String(t('res.' + k)).replace(/^\S+\s*/, '');

        let svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" class="chart-svg" preserveAspectRatio="none" role="img">';
        for (let i = 0; i <= 4; i++) {
            const v = (vMax / 4) * i, y = Y(v).toFixed(1);
            svg += '<line class="c-grid" x1="' + ML + '" y1="' + y + '" x2="' + (W - MR) + '" y2="' + y + '"/>';
            svg += '<text class="c-ylab" x="' + (ML - 8) + '" y="' + (Y(v) + 3.5).toFixed(1) + '" text-anchor="end">' + esc(nice(v)) + '</text>';
        }
        for (let i = 0; i <= 4; i++) {
            const s = Math.round((tMax / 4) * i);
            svg += '<text class="c-xlab" x="' + X(s).toFixed(1) + '" y="' + (H - 8) + '" text-anchor="middle">' + esc(mmss(s)) + '</text>';
        }
        // Age advances go BEHIND the lines, in the advancing player's colour — the
        // thing that turns the graph from a description into an explanation. Each
        // carries the age's own icon so "they advanced" also says WHICH age, and the
        // icons stagger by seat: simultaneous advances would otherwise stack on top
        // of one another exactly when the race is closest and you most want to read
        // the order.
        ((tl && tl.ages) || []).forEach(a => {
            const pl = players.find(p => p.id === a.id);
            if (!pl) return;
            const x = X(a.t).toFixed(1);
            const lane = MT + 9 + ((pl.seat || 0) % 4) * 11;
            svg += '<line class="c-age" x1="' + x + '" y1="' + (lane + 3) + '" x2="' + x + '" y2="' + (H - MB)
                + '" stroke="' + esc(this.chartColor(pl)) + '"/>';
            // t('age.x') reads "🏺 Stone Age"; the marker wants only the glyph.
            const icon = String(t('age.' + a.age) || '').trim().split(/\s+/)[0];
            svg += '<text class="c-ageicon" x="' + x + '" y="' + lane + '" text-anchor="middle">'
                + esc(icon) + '</text>';
        });
        // Wonders get a SOLID line and their own band along the bottom — the win
        // condition starting and stopping deserves to outrank an age advance, and
        // keeping the two glyph bands apart means neither can land on the other.
        ((tl && tl.wonders) || []).forEach(w => {
            const pl = players.find(p => p.id === w.id);
            if (!pl) return;
            const x = X(w.t).toFixed(1);
            const lost = w.event === 'lost';
            svg += '<line class="c-wonder' + (lost ? ' is-lost' : '') + '" x1="' + x + '" y1="' + MT
                + '" x2="' + x + '" y2="' + (H - MB - 13) + '" stroke="' + esc(this.chartColor(pl)) + '"/>';
            svg += '<text class="c-wondericon" x="' + x + '" y="' + (H - MB - 3)
                + '" text-anchor="middle">' + (lost ? '💥' : '🏛️') + '</text>';
        });
        players.forEach(pl => {
            const pts = samples.map(r => X(r.t).toFixed(1) + ',' + Y(this.chartValue(r, pl.id, mode)).toFixed(1)).join(' ');
            svg += '<polyline class="c-line" points="' + pts + '" stroke="' + esc(this.chartColor(pl)) + '"/>';
        });
        // Where the reader is standing. Last, so it draws over the plot rather than
        // under it, and clamped into the axis so a snapshot a second past the final
        // sample cannot park it off the edge.
        if (S.playheadSeconds != null) {
            const px = X(Math.max(0, Math.min(tMax, S.playheadSeconds))).toFixed(1);
            svg += '<line class="c-playhead" x1="' + px + '" y1="' + MT + '" x2="' + px + '" y2="' + (H - MB) + '"/>'
                + '<circle class="c-playhead-dot" cx="' + px + '" cy="' + MT + '" r="3.5"/>';
        }
        document.getElementById(el.main).innerHTML = svg + '</svg>';

        // Composition strips: one per player, each band a resource's SHARE of that
        // player's cumulative haul. Normalised to 100% because the magnitude is
        // already plotted above, and because a shortage should read the same whether
        // a player gathered 10k or 100k. Cumulative never falls, so running dry shows
        // as a band being squeezed while the others keep growing.
        const RES = [['f', 'food'], ['w', 'wood'], ['s', 'stone'], ['o', 'gold']];
        const SW = 900, SH = 46;
        let strips = '';
        players.forEach(pl => {
            let bands = '';
            const below = samples.map(() => 0);
            RES.forEach(([k, name]) => {
                const top = [], bot = [];
                samples.forEach((r, i) => {
                    const p = r.p[pl.id] || {};
                    const tot = (p.f || 0) + (p.w || 0) + (p.s || 0) + (p.o || 0);
                    const share = tot > 0 ? (p[k] || 0) / tot : 0;
                    const x = (ML + (r.t / tMax) * (SW - ML - MR)).toFixed(1);
                    const y0 = (SH - below[i] * SH).toFixed(1);
                    below[i] += share;
                    top.push(x + ',' + (SH - below[i] * SH).toFixed(1));
                    bot.push(x + ',' + y0);
                });
                bands += '<polygon class="c-band c-' + name + '" points="' + top.join(' ') + ' ' + bot.reverse().join(' ') + '"/>';
            });
            ((tl && tl.exhausted) || []).filter(e => e.id === pl.id).forEach(e => {
                const x = (ML + (e.t / tMax) * (SW - ML - MR)).toFixed(1);
                bands += '<line class="c-dry" x1="' + x + '" y1="0" x2="' + x + '" y2="' + SH + '"/>';
            });
            // A cumulative haul can only freeze, so an eliminated player's bands go
            // perfectly horizontal — indistinguishable from a beautifully steady
            // economy. Scrim the dead stretch so a corpse reads as one, keeping the
            // final mix faintly visible rather than cutting the strip short.
            const gone = samples.find(r => r.p[pl.id] && r.p[pl.id].al === 0);
            if (gone) {
                const gx = ML + (gone.t / tMax) * (SW - ML - MR);
                bands += '<rect class="c-dead" x="' + gx.toFixed(1) + '" y="0" width="'
                    + Math.max(0, SW - MR - gx).toFixed(1) + '" height="' + SH + '"/>'
                    + '<line class="c-gone" x1="' + gx.toFixed(1) + '" y1="0" x2="'
                    + gx.toFixed(1) + '" y2="' + SH + '"/>';
            }
            strips += '<div class="chart-strip"><span class="strip-name">'
                + '<i class="strip-swatch" style="background:' + esc(this.chartColor(pl)) + '"></i>'
                + this.teamDotHtml(pl.seat, 10) + '<span>'
                + esc(tg((getCivilization(pl.civilization) || {}).name || pl.civilization))
                + '</span></span><svg viewBox="0 0 ' + SW + ' ' + SH + '" class="strip-svg" preserveAspectRatio="none">'
                + bands + '</svg></div>';
        });
        const stripsEl = document.getElementById(el.strips);
        if (stripsEl) stripsEl.innerHTML = strips;

        const legendEl = document.getElementById(el.legend);
        if (legendEl) legendEl.innerHTML =
            RES.map(([, name]) => '<span class="c-key"><i class="c-sw c-' + name + '"></i>' + esc(resWord(name)) + '</span>').join('')
            + '<span class="c-key"><i class="c-sw c-agekey"></i>' + esc(t('sum.chartAge')) + '</span>'
            + '<span class="c-key">🏛️ ' + esc(t('sum.chartWonder')) + '</span>'
            + '<span class="c-key">💥 ' + esc(t('sum.chartWonderLost')) + '</span>'
            + '<span class="c-key"><i class="c-sw c-drykey"></i>' + esc(t('sum.chartDry')) + '</span>'
            + '<span class="c-key"><i class="c-sw c-deadkey"></i>' + esc(t('sum.chartDead')) + '</span>';
    }

    // Build a human-readable Markdown report of the last match.
    // The results, as data rather than prose, for the transcript tail.
    //
    // A WHITELIST, and not for tidiness: a report object carries `ai`, the live
    // aiPlayer, whose units and buildings hold references back into the game.
    // JSON.stringify on one would either hit a circular reference or quietly embed a
    // slice of the running match in a file meant to be handed to someone else. Every
    // field here is named on purpose, so a field added to reports later is missing from
    // the record rather than leaking into it — the same rule the per-seat settings block
    // already follows (see OpenAIAIManager.publicModelSettings).
    // ---- Transcript analyzer -------------------------------------------------
    // The reading end of the round trip: a match is recorded, downloaded, handed on,
    // and opened here. Nothing in it touches the live game — it renders a file.

    AN_EL() {
        return { box: 'anChartBox', main: 'anChartMain', strips: 'anChartStrips',
                 legend: 'anChartLegend', title: 'anChartTitle',
                 gathered: 'anModeGathered', power: 'anModePower' };
    }

    anOpen() {
        this.anLoadSampleIndex();
        this.analyzer = this.analyzer || new TranscriptAnalyzer(this);
        this.showScreen('analyzeScreen');
        this.anRender();
    }

    anClose() {
        // In showcase mode there is nowhere to go back TO -- the analyzer is the whole
        // app -- so this is the one exit and it stays shut.
        if (typeof WAR_DEMO_ONLY !== 'undefined' && WAR_DEMO_ONLY) return;
        this.anStopPlay(); this.anUnmountStage(); this.showScreen('gameModeScreen');
    }

    anLoadFile(input) {
        const f = input && input.files && input.files[0];
        if (!f) return;
        const fr = new FileReader();
        fr.onload = () => {
            this.anStopPlay();   // a new file starts stopped, wherever the old one was
            this.analyzer = this.analyzer || new TranscriptAnalyzer(this);
            try { this.analyzer.load(String(fr.result || ''), f.name); }
            catch (e) { console.warn('[analyzer] load failed', e); this.showErrorMessage(t('an.badFile')); return; }
            this._anFramed = false;  // a new match gets its own opening shot
            this.resetChartCache();
            this.anRender();
        };
        fr.onerror = () => this.showErrorMessage(t('an.badFile'));
        fr.readAsText(f);
    }

    // Loads the match that ships in samples/. Called by the showcase boot, and only
    // there: anyone running a clone has that file on disk and opens it with the picker
    // like any other transcript, so a button for it was an action with nothing to do
    // that the ordinary one did not already do.
    //
    // Deliberately the SAME load path as a hand-picked file. No special-casing, so the
    // bundled match exercises exactly what a visitor's own match would.
    //
    // fetch() needs an http(s) origin. Opened straight off disk as file:// this throws,
    // which is the one failure someone poking at a clone is actually likely to hit, so
    // it is reported with the fix rather than swallowed into the console.
    // The samples/ folder is listed by samples/index.json, because GitHub Pages
    // cannot enumerate a directory and a hosted copy has no other way to learn what is
    // there. Read once per session; the picker only appears when there is a choice to
    // make, so a checkout carrying a single match shows no control at all and one
    // carrying five needs no code change.
    anLoadSampleIndex() {
        if (this._sampleIndex) return Promise.resolve(this._sampleIndex);
        return fetch('samples/index.json')
            .then(r => (r.ok ? r.json() : null))
            .then(ix => {
                const list = (ix && Array.isArray(ix.matches)) ? ix.matches : [];
                this._sampleIndex = list;
                this.anFillSamplePicker(list);
                return list;
            })
            .catch(e => { console.warn('[analyzer] sample index unavailable', e); return []; });
    }

    // One line per match, from the metadata already in the index: nothing here is
    // derived from the transcript, so adding a match is an index entry and a file.
    anFillSamplePicker(list) {
        const sel = document.getElementById('anSampleSel');
        if (!sel) return;
        if (!list || list.length < 2) { sel.style.display = 'none'; return; }
        const esc = v => this.escapeHtml(String(v == null ? '' : v));
        // A menu of things to DO, not a label for what is loaded. The first entry is a
        // permanent placeholder and the control returns to it after every pick, which
        // settles two complaints at once. It used to open already showing a match it had
        // not loaded -- and picking that same one did nothing, because a select only
        // fires change when the value actually changes. And once you loaded your own
        // file it carried on naming an example in the middle of the header, as if that
        // were what you were looking at.
        //
        // Nothing is lost by not showing the loaded match here: anRender already puts
        // the file name first in anMeta, right beside this control.
        sel.innerHTML = `<option value="">${esc(t('an.samplesPick'))}</option>`
            + list.map(m => {
                const day = m.date ? new Date(m.date).toISOString().slice(0, 10) : '';
                const tempo = m.turnBased ? t('an.turnBased') : t('an.realTime');
                const bits = [day, m.duration, tempo, m.winner].filter(Boolean);
                return `<option value="${esc(m.file)}">${esc(bits.join(' \u00b7 '))}</option>`;
              }).join('');
        sel.value = '';
        sel.style.display = '';
    }

    // Back to the placeholder straight away, before the load even starts. The value
    // has to CHANGE for a change event to fire, so without this, picking the match you
    // just picked is silence -- which is exactly what it was.
    anPickSample(sel) {
        if (!sel) return;
        const file = sel.value;
        sel.value = '';
        if (file) this.anLoadSample(file);
    }

    anLoadSample(file0) {
        // A call with no file of its own means "open the default", and the default is a
        // flag in the index -- so this has to WAIT for the index. It did not: anOpen()
        // starts that fetch without awaiting it and the hosted auto-open called this on
        // the next line, every time finding _sampleIndex still unset and falling through
        // to SAMPLE_MATCH. The flag decided nothing on the one path that reads it, and
        // the bug was invisible while the constant and the flag happened to agree.
        // Resolving to an explicit file rather than calling back in with none keeps a
        // failed fetch from recursing: on a network error _sampleIndex stays unset.
        if (!file0 && !this._sampleIndex) {
            return this.anLoadSampleIndex().then(list => this.anLoadSample(
                (list.find(m => m.default) || list[0] || {}).file || this.SAMPLE_MATCH));
        }
        // Say what is happening while it happens. The placeholder underneath reads "load
        // a .jsonl file the Arena saved", which is right for someone who opened an empty
        // analyzer -- and exactly wrong for the seconds a hosted copy spends fetching
        // four megabytes on its own. A visitor's entire first impression was the page
        // announcing it was empty and implying that fixing it was their job.
        const empty = document.getElementById('anEmpty');
        if (empty) empty.textContent = t('an.loadingSample');
        // Put the placeholder back either way, so a file loaded later that turns out to
        // be unreadable shows its own message rather than this one, frozen mid-load.
        const restore = () => { if (empty) empty.textContent = t('an.empty'); };
        // samples/ now holds more than one match, so the name lives in one place. The
        // set and its metadata are listed in samples/index.json, which is what a picker
        // has to read: GitHub Pages cannot list a directory.
        const list = this._sampleIndex || [];
        const file = file0
            || (list.find(m => m.default) || list[0] || {}).file
            || this.SAMPLE_MATCH;
        this._sampleFile = file;
        fetch('samples/' + file)
            .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
            .then(text => {
                this.anStopPlay();   // a fresh load starts stopped, as a file load does
                this.analyzer = this.analyzer || new TranscriptAnalyzer(this);
                this.analyzer.load(text, file);
                this._anFramed = false;
                this.resetChartCache();
                this.anRender();
                restore();
            })
            .catch(e => {
                console.warn('[analyzer] sample load failed', e);
                restore();
                this.showErrorMessage(t('an.sampleFail'));
            });
    }


    // Play: one filtered step a second. It walks anStep(1), so it follows whatever
    // filter and seat are set — playing the Combat filter jumps fight to fight rather
    // than crawling through every worker reassignment in between.
    //
    // Stops itself at the end. anStep clamps at the last visible record, so without
    // that check it would sit there re-rendering the same turn once a second forever.
    anTogglePlay() {
        if (this._anPlayTimer) { this.anStopPlay(); this.anRender(); return; }
        const a = this.analyzer;
        if (!a || !a.order || !a.order.length) return;
        this._anPlayTimer = setInterval(() => {
            // Nobody watches a hidden tab, and setInterval does not care that nobody is
            // looking -- unlike rAF it keeps firing at full rate in the background. Left
            // alone, tabbing away runs a whole stage rebuild, a fog pass and a detail
            // re-render once a second for no one, and the match plays itself to the end
            // while the reader is elsewhere. Two of these in a background tab were enough
            // to be felt in a game running in another one: separate origins get separate
            // renderer processes, but they share the GPU.
            //
            // Checked here rather than on a visibilitychange listener because this also
            // covers a timer that was already running when the tab went away, and needs
            // no teardown of its own.
            if (document.visibilityState === 'hidden') {
                this.anStopPlay();
                this.anRender();   // so the button reads as stopped when they come back
                return;
            }
            const before = this.analyzer ? this.analyzer.cursor : -1;
            this.anStep(1);
            if (!this.analyzer || this.analyzer.cursor === before) {
                this.anStopPlay();
                this.anRender();   // repaint the button as stopped
            }
        }, 1000);
        this.anRender();
    }

    anStopPlay() {
        if (this._anPlayTimer) { clearInterval(this._anPlayTimer); this._anPlayTimer = null; }
    }
    anSetMode(mode) {
        if (!this.analyzer) return;
        this.analyzer.mode = mode;
        this.resetChartCache();
        this.anRender();
    }

    anSetFilter(kind) { if (this.analyzer) { this.analyzer.filter = kind; this.anRender(); } }
    anSetSeat(id) {
        if (!this.analyzer) return;
        this.analyzer.seatFilter = (id === '*' || !id) ? null : id;
        // Picking is the menu's whole job, so it closes on the way out — including its
        // outside-click listener, which would otherwise sit armed for a stale menu.
        if (this._anSeatMenuAway) { document.removeEventListener('click', this._anSeatMenuAway); this._anSeatMenuAway = null; }
        if (this._anSeatMenuKeys) { document.removeEventListener('keydown', this._anSeatMenuKeys, true); this._anSeatMenuKeys = null; }
        this._anSeatMenuOpen = false;
        this.anRender();
    }
    // A deliberate jump takes over from playback rather than fighting it.
    // Focus follows the click, so arrows continue where the reader just was rather than
    // going back to panning the map.
    anSeek(i) {
        this.anStopPlay();
        if (this.analyzer) { this.analyzer.seek(i); this.anRender(); }
        const list = document.getElementById('anList');
        if (list && list.focus) list.focus({ preventScroll: true });
    }
    anStep(d) { if (this.analyzer) { this.analyzer.step(d); this.anRender(); } }

    // Free-text search over the turn list. Steps and playback both walk visible(),
    // so narrowing here narrows those too — which is the point: type "wonder", then
    // step through every turn that mentions it.
    anSetSearch(v) {
        if (!this.analyzer) return;
        const q = String(v || '').trim().toLowerCase();
        this._anSearchPending = q;
        clearTimeout(this._anSearchTimer);
        // One render per pause, not per keystroke. The list is every turn in the file —
        // 1116 of them in a real match, ~54ms to lay out — so a six-letter word cost six
        // full rebuilds and typing dragged behind the keys. The filtering itself is not
        // the expense (0.34ms a pass, warm); the rebuild is.
        this._anSearchTimer = setTimeout(() => {
            this._anSearchTimer = null;
            if (!this.analyzer || this.analyzer.textFilter === this._anSearchPending) return;
            this.analyzer.textFilter = this._anSearchPending;
            this.anRender();
        }, 120);
    }


    // One 24x24 box for every control icon, so a row of them cannot drift.
    anIcon(name) {
        const P = {
            prev: '<path d="M15 5l-7 7 7 7"/>',
            next: '<path d="M9 5l7 7-7 7"/>',
            chev: '<path d="M6 9.5l6 6 6-6"/>',
            play: '<path d="M8 5.2l11 6.8-11 6.8z" fill="currentColor" stroke="none"/>',
            pause: '<path d="M9 5h3.1v14H9zM16 5h3.1v14H16z" fill="currentColor" stroke="none"/>'
        };
        return '<svg class="an-svg" viewBox="0 0 24 24" aria-hidden="true" fill="none"'
            + ' stroke="currentColor" stroke-width="2.4" stroke-linecap="round"'
            + ' stroke-linejoin="round">' + (P[name] || '') + '</svg>';
    }

    // The seat menu. Open state lives on the instance rather than in the DOM because
    // the whole bar is rebuilt on every render — including once a second while playing
    // — and a class set on the old node would vanish with it.
    anSeatMenuToggle(ev) {
        if (ev) ev.stopPropagation();
        // Closing goes through the same door as every other close, so the outside-click
        // and key listeners come down rather than staying armed for a menu that is gone.
        if (this._anSeatMenuOpen) { this.anSeatMenuClose(); return; }
        this._anSeatMenuOpen = true;
        this.anRender();
        if (this._anSeatMenuOpen) {
            // Close on the next click anywhere else. Bound per opening and removed on
            // close, so it never accumulates.
            this._anSeatMenuAway = () => this.anSeatMenuClose();
            setTimeout(() => document.addEventListener('click', this._anSeatMenuAway, { once: true }), 0);
            // On the document, not on the bar: the filter bar sits outside .an-lower,
            // so the analyzer's own arrow handler never sees these keys — and without
            // this the arrows would fall through to the renderer and pan the camera
            // while the reader is choosing a seat.
            this._anSeatMenuKeys = (ev) => {
                const k = String(ev.key || '').toLowerCase();
                const opts = [...document.querySelectorAll('#analyzeScreen .an-seat-opt')];
                if (!opts.length) return;
                if (k === 'escape') {
                    ev.preventDefault(); ev.stopPropagation();
                    const btn = document.querySelector('#analyzeScreen .an-seat-btn');
                    this.anSeatMenuClose();
                    if (btn) btn.focus();
                    return;
                }
                if (k === 'arrowdown' || k === 'arrowup' || k === 'home' || k === 'end') {
                    ev.preventDefault(); ev.stopPropagation();
                    const at = opts.indexOf(document.activeElement);
                    let to;
                    if (k === 'home') to = 0;
                    else if (k === 'end') to = opts.length - 1;
                    else if (at < 0) to = 0;
                    else to = (at + (k === 'arrowdown' ? 1 : -1) + opts.length) % opts.length;
                    if (opts[to]) opts[to].focus();
                } else if (k === 'arrowleft' || k === 'arrowright') {
                    // Swallowed rather than acted on: stepping the transcript under an
                    // open menu moves the very thing being chosen for.
                    ev.preventDefault(); ev.stopPropagation();
                }
            };
            document.addEventListener('keydown', this._anSeatMenuKeys, true);
            const first = document.querySelector('#analyzeScreen .an-seat-opt.is-on')
                || document.querySelector('#analyzeScreen .an-seat-opt');
            if (first) first.focus();
        }
    }
    anSeatMenuClose() {
        if (this._anSeatMenuAway) { document.removeEventListener('click', this._anSeatMenuAway); this._anSeatMenuAway = null; }
        if (this._anSeatMenuKeys) { document.removeEventListener('keydown', this._anSeatMenuKeys, true); this._anSeatMenuKeys = null; }
        if (!this._anSeatMenuOpen) return;
        this._anSeatMenuOpen = false;
        this.anRender();
    }

    anJumpSec(sec) { this.anStopPlay(); if (this.analyzer) { this.analyzer.seekSeconds(sec); this.anRender(); } }

    // A click on the plot becomes a moment. The SVG is a fixed 900x300 viewBox stretched
    // to whatever width the pane has, so the pixel is converted back through the same
    // margins the renderer used — otherwise the playhead lands where the reader did not
    // point, which is worse than not being clickable at all.
    anChartClick(ev) {
        const a = this.analyzer; if (!a || !a.timeline) return;
        const host = document.getElementById('anChartMain');
        const svg = host && host.querySelector('svg');
        if (!svg) return;
        const r = svg.getBoundingClientRect();
        if (!r.width) return;
        const ML = 62, MR = 14, W = 900;
        const vx = ((ev.clientX - r.left) / r.width) * W;
        const frac = Math.max(0, Math.min(1, (vx - ML) / (W - ML - MR)));
        const samples = a.timeline.samples || [];
        const tMax = samples.length ? (samples[samples.length - 1].t || 1) : a.durationSec();
        a.seekSeconds(Math.round(frac * tMax));
        this.anRender();
    }


    // Arrow keys belong to whatever the reader is pointing at. The renderer binds keydown
    // on DOCUMENT — which is right for a game where the map is the only thing there — so
    // in the analyzer the camera panned no matter where focus was, and pressing Down in
    // the turn list scrolled the map instead of the list. Worse, it did BOTH at once.
    //
    // Fixed by owning the keys in the lower deck rather than by touching the engine: a
    // CAPTURE listener on the reading half sees the event before it can bubble to
    // document, acts on it, and stops it there. Focus in the stage is untouched, so the
    // map keeps the full arena camera.
    anBindKeys() {
        const lower = document.querySelector('#analyzeScreen .an-lower');
        if (!lower || this._anKeysBound) return;
        this._anKeysBound = true;
        lower.addEventListener('keydown', (ev) => {
            const k = String(ev.key || '').toLowerCase();
            const arrows = ['arrowup', 'arrowdown', 'arrowleft', 'arrowright'];
            // An open seat menu owns the keyboard — but it is not bound HERE. The filter
            // bar sits outside .an-lower, so this listener never sees the menu's keys at
            // all; the real handling is a document-level one armed while it is open (see
            // anSeatMenuToggle). This is only the guard: never step the transcript underneath
            // an open menu, since that moves the very thing being chosen for.
            if (this._anSeatMenuOpen) return;
            if (arrows.indexOf(k) === -1) return;
            // Typing in a control is not navigating: a select needs its own arrows.
            const tag = (ev.target && ev.target.tagName) || '';
            if (tag === 'SELECT' || tag === 'INPUT' || tag === 'TEXTAREA') return;
            ev.preventDefault();
            ev.stopPropagation();   // ...and never reaches the renderer's document handler
            // A key already held when focus moved in would otherwise pan forever, since
            // its keyup is about to be swallowed too.
            const r = this.game.renderer;
            if (r && r.keysPressed) arrows.forEach(a2 => { r.keysPressed[a2] = false; });
            if (k === 'arrowdown' || k === 'arrowright') this.anStep(1);
            else this.anStep(-1);
        }, true);
    }
    anRender() {
        const a = this.analyzer;
        const body = document.getElementById('anBody');
        const empty = document.getElementById('anEmpty');
        const meta = document.getElementById('anMeta');
        if (!body || !empty) return;
        const has = !!(a && a.order && a.order.length);
        body.style.display = has ? '' : 'none';
        empty.style.display = has ? 'none' : '';
        if (meta) meta.innerHTML = '';
        if (!has) {
            // A file with a header but no turns is a match that recorded nothing, not a
            // broken file — say which it is rather than showing empty furniture.
            if (meta && a && a.fileName) meta.textContent = t('an.noTurns', { f: a.fileName, e: a.parseErrors });
            return;
        }
        const esc = s => this.escapeHtml(String(s == null ? '' : s));
        const mmss = s => Math.floor(s / 60) + ':' + String(Math.round(s % 60)).padStart(2, '0');
        const st = a.stats();
        const h = a.header || {};

        const bits = [esc(a.fileName || ''), t('an.turns', { n: st.total })];
        if (st.markers) bits.push(t('an.missed', { n: st.markers }));
        if (h.mapSeed) bits.push('seed ' + esc(h.mapSeed));
        if (h.difficulty) bits.push(esc(h.difficulty));
        if (h.turnBased != null) bits.push(h.turnBased ? t('an.turnBased') : t('an.realTime'));
        if (h.simSpeed) bits.push(h.simSpeed + '×');
        if (h.promptVersion) bits.push(esc(h.promptVersion));
        if (a.results && a.results.build) bits.push('build ' + a.results.build);
        bits.push(mmss(st.duration));
        if (st.parseErrors) bits.push(t('an.parseErrors', { n: st.parseErrors }));
        // An interrupted match has turns but no tail. Better to say so than to leave a
        // reader wondering why there is no graph.
        if (!a.results || !a.timeline) bits.push(t('an.partial'));
        if (meta) meta.innerHTML = bits.join(' · ');

        const cur = a.current();
        this.anRenderWonder(cur);

        const chartBox = document.getElementById('anChartBox');
        if (a.timeline) {
            chartBox.style.display = '';
            this.renderSummaryChart({
                timeline: a.timeline, players: a.chartPlayers(), mode: a.mode,
                el: this.AN_EL(), sigKey: 'an', playheadSeconds: cur ? cur._sec : null
            });
        } else {
            chartBox.style.display = 'none';
        }

        const F = [['all', t('an.fAll')], ['battles', t('an.fBattles')],
                   ['rejected', t('an.fRejected')], ['planned', t('an.fPlanned')],
                   ['missed', t('an.fMissed')]];
        let bar = F.map(function (kv) {
            return '<button class="an-chip' + (a.filter === kv[0] ? ' is-on' : '')
                + '" onclick="game.ui.anSetFilter(\'' + kv[0] + '\')">' + esc(kv[1]) + '</button>';
        }).join('');
        // The seat picker carries each seat's BADGE, not just its name. A native
        // <select> cannot hold one — options take text only — so two seats running the
        // same model read as one row repeated, and picking between them was guesswork.
        // The badge is the same mark the board and every other panel use, so the choice
        // is made on the thing the reader is already tracking rather than on a name.
        const seatRows = [...a.seats.values()].sort((x, y) => (x.seat || 0) - (y.seat || 0));
        const seatLabel = sm => esc(sm.name || sm.model || this.anCivName(sm.civ));
        const sel = (a.seatFilter && a.seatFilter !== '*') ? a.seats.get(a.seatFilter) : null;
        const face = sel
            ? this.teamDotHtml(sel.seat, 8) + '<span class="an-seat-label">' + seatLabel(sel) + '</span>'
            // No badge on 'All seats': it is the ABSENCE of a seat choice, and a row of
            // every mark reads as one seat that somehow owns all four.
            : '<span class="an-seat-label">' + esc(t('an.allSeats')) + '</span>';
        let menu = '<button type="button" role="option" aria-selected="' + (!sel)
            + '" class="an-seat-opt' + (sel ? '' : ' is-on')
            + '" onclick="game.ui.anSetSeat(\'*\')">'
            + '<span class="an-seat-label">' + esc(t('an.allSeats')) + '</span></button>';
        menu += seatRows.map(sm => {
            const on = a.seatFilter === sm.id;
            return '<button type="button" role="option" aria-selected="' + on
                + '" class="an-seat-opt' + (on ? ' is-on' : '')
                + '" onclick="game.ui.anSetSeat(\'' + esc(sm.id) + '\')">'
                + this.teamDotHtml(sm.seat, 8)
                + '<span class="an-seat-label">' + seatLabel(sm) + '</span>'
                // The civ is what tells two seats on one model apart on the board.
                + '<i class="an-seat-civ">' + esc(this.anCivName(sm.civ)) + '</i></button>';
        }).join('');
        bar += '<span class="an-seat' + (this._anSeatMenuOpen ? ' is-open' : '') + '">'
            + '<button type="button" class="an-seat-btn" aria-haspopup="listbox"'
            + ' aria-expanded="' + (!!this._anSeatMenuOpen) + '"'
            + ' onclick="game.ui.anSeatMenuToggle(event)">'
            + face + this.anIcon('chev') + '</button>'
            + '<span class="an-seat-menu" role="listbox">' + menu + '</span></span>';
        const playing = !!this._anPlayTimer;
        // Icons, not glyphs: ‹ ▶ › are three different type designs and measured 19.7 /
        // 25.7 / 19.7px wide, so the row of them sat unequal and a pixel off the picker.
        // Drawn shapes in equal square buttons line up because they are the same box.
        bar += '<span class="an-nav">'
            + '<button class="an-chip an-ico" title="' + esc(t('an.prevStep'))
            + '" aria-label="' + esc(t('an.prevStep')) + '" onclick="game.ui.anStep(-1)">'
            + this.anIcon('prev') + '</button>'
            + '<button class="an-chip an-ico' + (playing ? ' is-on' : '') + '" title="'
            + esc(t(playing ? 'an.pause' : 'an.play')) + '" aria-label="'
            + esc(t(playing ? 'an.pause' : 'an.play')) + '" onclick="game.ui.anTogglePlay()">'
            + this.anIcon(playing ? 'pause' : 'play') + '</button>'
            + '<button class="an-chip an-ico" title="' + esc(t('an.nextStep'))
            + '" aria-label="' + esc(t('an.nextStep')) + '" onclick="game.ui.anStep(1)">'
            + this.anIcon('next') + '</button></span>';
        // Search, next to the step buttons and behaving like the arena's log search:
        // it narrows the list the steppers walk, so typing and then stepping moves
        // between matches. Rebuilt with the bar each render, so the value and the
        // caret are restored below rather than trusted to survive.
        const q = a.textFilter || '';
        // Search and its match count are ONE group, so a narrow panel wraps them
        // together. Loose in the bar the count orphaned onto a row of its own, reading
        // like a stray number with nothing to do with the box above it.
        bar += '<span class="an-find">'
            + '<input id="anSearch" class="an-search" type="search" autocomplete="off"'
            + ' value="' + esc(q) + '"'
            + ' data-i18n-ph="log.search" placeholder="' + esc(t('log.search')) + '"'
            + ' oninput="game.ui.anSetSearch(this.value)">'
            + (q ? '<span class="an-count">' + a.visible().length + '/' + a.order.length + '</span>' : '')
            + '</span>';
        // Focus and caret first, because setting innerHTML destroyed the input the
        // reader is typing into. Without this every keystroke lost focus after one
        // character — the search would look broken while working perfectly.
        const prevBox = document.getElementById('anSearch');
        const hadFocus = prevBox && document.activeElement === prevBox;
        const caret = hadFocus ? prevBox.selectionStart : null;
        document.getElementById('anFilters').innerHTML = bar;
        if (hadFocus) {
            const box = document.getElementById('anSearch');
            if (box) { box.focus(); try { box.setSelectionRange(caret, caret); } catch (e) {} }
        }

        const vis = a.visible();
        const rows = vis.map(r => {
            const i = a.order.indexOf(r);
            const sm = a.seats.get(r.playerId) || {};
            const on = r === cur ? ' is-cur' : '';
            if (r.type === 'round_missed') {
                return '<div class="an-row is-missed' + on + '" onclick="game.ui.anSeek(' + i + ')">'
                    + '<span class="an-t">' + esc(mmss(r._sec)) + '</span>'
                    + this.teamDotHtml(sm.seat, 8)
                    + '<span class="an-act">⏱ ' + esc(t('an.rowMissed')) + '</span></div>';
            }
            // A closing statement has no "parsed", so the ordinary label read it as
            // (malformed) — which is the one thing it is not. Its own row, like a missed
            // round: this is not a move and must not be dressed as one.
            if (r.type === 'final_word') {
                return '<div class="an-row is-final' + on + '" onclick="game.ui.anSeek(' + i + ')">'
                    + '<span class="an-t">' + esc(mmss(r._sec)) + '</span>'
                    + this.teamDotHtml(sm.seat, 8)
                    + '<span class="an-act">\uD83D\uDCAC ' + esc(t('an.rowFinal')) + '</span></div>';
            }
            // A batched turn is labelled by its first command with a count beside it —
            // three rows all reading "train unit" would say less than one saying +2.
            const cmds = a.commandsOf ? a.commandsOf(r) : [];
            const act = cmds.length ? cmds[0].action : (r.parsed && r.parsed.action);
            const more = cmds.length > 1 ? cmds.length - 1 : 0;
            const bad = typeof r.harnessResult === 'string' && r.harnessResult.indexOf('[ERROR]') === 0;
            const fight = !!(r.state && r.state.battles && r.state.battles.length);
            return '<div class="an-row' + on + (bad ? ' is-bad' : '') + '" onclick="game.ui.anSeek(' + i + ')">'
                + '<span class="an-t">' + esc(mmss(r._sec)) + '</span>'
                + this.teamDotHtml(sm.seat, 8)
                + '<span class="an-act">' + esc(typeof act === 'string' ? act.replace(/_/g, ' ') : '(malformed)') + '</span>'
                + (more ? '<span class="an-more" title="' + esc(t('an.plusMore', { n: more })) + '">+' + more + '</span>' : '')
                + (fight ? '<span class="an-flag">⚔️</span>' : '')
                + (r._planNew ? '<span class="an-flag">📋</span>' : '')
                + (bad ? '<span class="an-flag">✕</span>' : '') + '</div>';
        }).join('');
        document.getElementById('anList').innerHTML = rows
            || '<div class="an-none">' + esc(t('an.noneMatch')) + '</div>';
        const curEl = document.querySelector('#anList .is-cur');
        if (curEl && curEl.scrollIntoView) curEl.scrollIntoView({ block: 'nearest' });

        document.getElementById('anDetail').innerHTML = this.anDetailHtml(cur);
        this.anBindDetail();

        // The board, plus a caption naming whose view it is. A single seat is what that
        // model could see; the union is an overview no player ever had. Those are
        // different claims and the label says which is on screen.
        // The stage: the engine's own canvas, showing this moment.
        this.anMountStage();
        this.anBuildStage(cur);
        const hud = document.getElementById('anStageHud');
        if (hud) {
            const sn = a.seats.get(cur && cur.playerId) || {};
            hud.innerHTML = '<button class="an-chip' + (a.union ? ' is-on' : '')
                + '" onclick="game.ui.anToggleUnion()">' + esc(t('an.union')) + '</button>'
                + '<button class="an-chip' + (a.autoCam ? ' is-on' : '')
                + '" onclick="game.ui.anToggleAutoCam()">' + esc(t('an.autoCam')) + '</button>'
                + '<span class="an-cap-txt">' + esc(a.union ? t('an.viewAll')
                    : t('an.viewSeat', { s: sn.name || sn.model || sn.civ || '?' })) + '</span>';
        }

        const ch = a.chapters.map(c => '<button class="an-chapter" onclick="game.ui.anJumpSec(' + c.t + ')">'
            + '<span class="an-t">' + esc(mmss(c.t)) + '</span>' + esc(c.icon) + ' ' + esc(c.text)
            + '</button>').join('');
        document.getElementById('anChapters').innerHTML = ch
            ? '<div class="an-ch-title">' + esc(t('an.chapters')) + '</div>' + ch : '';
    }

    // ---- the stage: the real engine, showing a finished match -----------------
    // Not a second renderer and not a flat substitute. The engine's canvas is MOVED
    // here and moved back on the way out, so the analyzer inherits the arena's camera
    // wholesale — pan, rotate, zoom, edge-scroll — because the renderer binds those to
    // its own canvas rather than depending on the game loop. A 2D board stood here
    // first and told you nothing: positions without terrain, scale or elevation are
    // numbers, not a situation.

    // The arena's viewer binds this on its own scroll body; the analyzer reuses
    // tvTurnHtml but never wired the other half, so a State section here opened onto an
    // empty <pre> for every transcript ever loaded -- a panel that looks broken rather
    // than one with nothing to say.
    //
    // 'toggle' does not bubble, hence capture. No mirroring pass: the analyzer shows one
    // turn at a time, so there is exactly one section of each kind on screen. Bound once
    // -- #anDetail outlives the innerHTML rewrite anRender does on every step.
    anBindDetail() {
        const box = document.getElementById('anDetail');
        if (!box || box._anBound) return;
        box.addEventListener('toggle', (ev) => {
            const d = ev.target;
            if (d && d.classList && d.classList.contains('tv-state') && d.open) this.tvFillState(d);
        }, true);
        box._anBound = true;
    }

    anMountStage() {
        const cv = document.getElementById('gameCanvas');
        const host = document.getElementById('anViewport');
        if (!cv || !host) return;
        if (cv.parentElement !== host) {
            // Remember where it came from so the arena gets it back in the same slot.
            if (!this._anCanvasHome) {
                this._anCanvasHome = { parent: cv.parentElement, next: cv.nextSibling };
            }
            host.appendChild(cv);
        }
        // Spectator input: no orders to give in a recording.
        this._anPrevSpectator = this.game.spectatorMode;
        this.game.spectatorMode = true;
        if (this.game.renderer && this.game.renderer.onWindowResize) this.game.renderer.onWindowResize();
        this.anBindPick();
        this.anBindKeys();
    }

    anUnmountStage() {
        const cv = document.getElementById('gameCanvas');
        const home = this._anCanvasHome;
        if (cv && home && home.parent) {
            home.parent.insertBefore(cv, home.next || null);
            this._anCanvasHome = null;
        }
        if (this._anPrevSpectator !== undefined) {
            this.game.spectatorMode = this._anPrevSpectator;
            this._anPrevSpectator = undefined;
        }
        // The arena builds its own fog at match start, but leaving ours installed
        // means a stale grid is on screen for the first frames of the next match.
        if (this.game.fogOfWar === this._anFog) this.game.fogOfWar = null;
        // Drop the cache as well. The guard in anApplyFog handles a manager that was
        // destroyed behind our back, but keeping no reference at all past the close is
        // what stops that situation existing: the next open builds a fresh one, which
        // costs a Float32Array and two canvases once per open and removes a whole class
        // of stale-object bug in exchange.
        this._anFog = null;
        const r = this.game.renderer;
        if (r) {
            if (r.clearScene) r.clearScene();
            if (r.onWindowResize) r.onWindowResize();
        }
    }


    // Click to inspect, as in the arena. input.js cannot serve this: it returns early on
    // spectatorMode, and its picker filters to owner 'player', which nothing in a
    // recorded match is. So the analyzer picks for itself — any owner, nearest first,
    // units before buildings because a unit standing on a plinth is the smaller target.
    //
    // Bound on the viewport rather than the canvas so the renderer keeps its own drag
    // handling untouched, and ignored after a drag so panning never selects.
    anBindPick() {
        const host = document.getElementById('anViewport');
        if (!host || this._anPickBound) return;
        this._anPickBound = true;
        let downAt = null;
        host.addEventListener('mousedown', (e) => { downAt = { x: e.clientX, y: e.clientY }; }, true);
        host.addEventListener('mouseup', (e) => {
            if (!downAt) return;
            const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
            downAt = null;
            if (moved > 4 || e.button !== 0) return;   // that was a pan, not a pick
            this.anPickAt(e.clientX, e.clientY);
        }, true);
    }

    anPickAt(cx, cy) {
        const r = this.game.renderer;
        if (!r || !r.getWorldPositionFromScreen) return;
        const w = r.getWorldPositionFromScreen(cx, cy);
        if (!w) return;
        // Aim in PIXELS, not world units. Both hit tests below measure in world
        // units, which means the target shrinks on screen every time you zoom out --
        // and the analyzer opens on the whole island. On a tablet's stage that is 1.8
        // world units per pixel, so a unit's entire click radius came to about a pixel
        // and a half. A mouse on a tall desktop stage could just about land it, which
        // is why this looked like it worked; a fingertip never could, and picking was
        // the one gesture that did not survive the move to touch.
        //
        // Converted at the current zoom, so the tolerance is the same distance on
        // screen wherever the camera is. Never tighter than the old numbers.
        const perPx = (2 * r._halfH) / ((r.canvas && r.canvas.clientHeight) || r.H || 1);
        const coarse = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
        const grab = (coarse ? 22 : 11) * perPx;      // a fingertip is not a cursor
        const u = r.pickUnitAt ? r.pickUnitAt(w.x, w.z, null, grab) : null;
        let pick = u, kind = 'unit';
        if (!pick && r.getBuildingsAtPosition) {
            const bs = r.getBuildingsAtPosition(w.x, w.z, Math.max(7, grab));
            pick = bs && bs[0]; kind = 'building';
        }
        r.deselectAll && r.deselectAll();
        this.game.selectedBuilding = null;
        if (!pick) { this._anPicked = null; this.anRenderPick(); return; }
        if (kind === 'unit' && r.selectUnit) r.selectUnit(pick);
        else { pick.selected = true; this.game.selectedBuilding = pick; }
        this._anPicked = { kind, ent: pick };
        this.anRenderPick();
    }


    // Age and civ ids are protocol values in the transcript; a human reading it wants
    // words. t('age.x') carries a leading glyph for the HUD, which these compact chips
    // have no room for, so it is stripped the way the results chart already does.

    // Split an '🍖 Food' style label into its icon and its word. Both already live
    // in i18n for every resource, the population and each age — the HUD prints them
    // whole — so the analyzer takes its icons from there rather than keeping a second
    // copy that can drift. The icon must be a PICTOGRAPH: a language whose label has no
    // icon would otherwise donate its first word as one ('Âge' for the French age).
    anSplitLabel(key) {
        if (typeof hasI18n !== 'function' || !hasI18n(getUiLang(), key)) return { icon: '', text: '' };
        const raw = String(t(key)).trim();
        const m = raw.match(/^(\p{Extended_Pictographic}[\p{Extended_Pictographic}\uFE0F\u200D]*)\s+([\s\S]+)$/u);
        return m ? { icon: m[1], text: m[2] } : { icon: '', text: raw };
    }
    anAgeName(id) {
        // hasI18n, not a truthiness check on t(): a missing key comes BACK as the key
        // itself, so `t(k) || id` would have shown "age.zzz" and looked deliberate.
        if (!id) return '';
        if (typeof hasI18n !== 'function' || !hasI18n(getUiLang(), 'age.' + id)) return String(id);
        return String(t('age.' + id)).trim().replace(/^\S+\s+/, '') || String(id);
    }

    anCivName(id) {
        if (!id) return '';
        // getCivilization falls back to a generic civ named "Völker" for an id it does
        // not know, so trusting its return would print a plausible civilization for a
        // typo or a transcript from a future build. Check the table itself first.
        const known = (typeof CIVILIZATIONS === 'object' && CIVILIZATIONS) ? !!CIVILIZATIONS[id] : false;
        if (!known) return String(id);
        const civ = getCivilization(id);
        return (civ && civ.name) ? tg(civ.name) : String(id);
    }

    // The wonder clock, in the header, because it is the one number that decides the
    // match and it appeared nowhere on this screen. Hidden until a wonder exists, so it
    // never takes up space claiming nothing.
    anRenderWonder(rec) {
        const box = document.getElementById('anWonder');
        if (!box) return;
        const a = this.analyzer;
        const w = (a && rec) ? a.wonderStatus(rec) : null;
        if (!w) { box.style.display = 'none'; box.innerHTML = ''; return; }
        const esc = x => this.escapeHtml(String(x == null ? '' : x));
        const mmss = n => Math.floor(n / 60) + ':' + String(Math.round(n % 60)).padStart(2, '0');
        const who = (w.owner && (w.owner.name || w.owner.model)) || this.anCivName(w.owner && w.owner.civ);
        let label, cls = '';
        if (w.building) {
            label = t('an.wonderBuilding', { s: w.buildSecs != null ? w.buildSecs : '?' });
        } else if (w.secs != null) {
            label = t('an.wonderHold', { t: mmss(w.secs) });
            // Under two minutes is the stretch people reopen a transcript to watch.
            if (w.secs <= 120) cls = ' is-urgent';
        } else {
            label = t('an.wonderStands');
        }
        box.style.display = '';
        box.className = 'an-wonder' + cls;
        box.innerHTML = '\uD83C\uDFDB\uFE0F ' + this.teamDotHtml(w.seat, 9) + ' '
            + '<b>' + esc(who) + '</b> ' + esc(label)
            // A stale reading says so: this seat was last heard from N seconds ago, so
            // its countdown is that old too.
            + (w.ageSec > 0 ? ' <i>' + esc(t('an.agoS', { n: w.ageSec })) + '</i>' : '');
    }
    anRenderPick() {
        const box = document.getElementById('anPick');
        if (!box) return;
        const p = this._anPicked;
        if (!p || !p.ent) { box.innerHTML = ''; box.style.display = 'none'; return; }
        const e = p.ent, esc = x => this.escapeHtml(String(x == null ? '' : x));
        const a = this.analyzer;
        const owner = (a && a.seats.get(e.owner)) || {};
        const hp = (e.maxHealth ? Math.round(100 * e.health / e.maxHealth) : null);
        const bits = [];
        if (e.age) bits.push(esc(this.anAgeName(e.age)));
        if (hp != null) bits.push(hp + '% hp');
        if (e.attack) bits.push('atk ' + e.attack);
        if (e.range) bits.push('rng ' + e.range);
        bits.push(Math.round(e.x) + ', ' + Math.round(e.z));
        // A remembered position says so, and when it was last seen — otherwise the card
        // would present a stale claim with the same confidence as a live one.
        const stale = e._anStale
            ? '<div class="an-pick-stale">' + esc(t('an.staleAt', { n: e._anLastSeen != null ? e._anLastSeen : '?' })) + '</div>'
            : '';
        box.style.display = '';
        // tg(), not the raw field. Unit and building names live in the data files as
        // GERMAN source strings — the live game's own info card has always run them
        // through tg(); this card was reading them straight, so every English, Spanish
        // and Chinese user got "Dorfbewohner".
        box.innerHTML = '<div class="an-pick-h">' + this.teamDotHtml(e.seat, 10) + ' '
            + esc(tg(e.name) || e.type) + '</div>'
            // The seat's own label is a user-typed nickname and must NOT be translated;
            // only the civ fallback is game content.
            + '<div class="an-pick-o">' + esc(owner.name || owner.model || this.anCivName(owner.civ)) + '</div>'
            + stale
            + '<div class="an-pick-n">' + bits.map(b => '<span>' + esc(b) + '</span>').join('') + '</div>';
    }
    // The map, rebuilt exactly. mapSeed + difficulty + player count is enough:
    // TerrainManager is pure data (its scene argument is ignored) and spawn positions
    // are plain trigonometry, so the island and every node land where they did.
    anTerrain() {
        const a = this.analyzer, h = (a && a.header) || {};
        const size = h.mapSize || 800;
        const key = [h.mapSeed, h.difficulty, (h.players || []).length, size].join('|');
        if (this._anTerrain && this._anTerrainKey === key) return this._anTerrain;
        const t = new TerrainManager(null, size);
        t.difficulty = h.difficulty || 'easy';
        t.seed = h.mapSeed || null;
        const n = Math.max(1, (h.players || []).length), half = size / 2;
        t.spawns = [];
        for (let i = 0; i < n; i++) {
            const ang = (i / n) * Math.PI * 2 - Math.PI / 2, rad = half * 0.85;
            t.spawns.push({ x: Math.cos(ang) * rad, z: Math.sin(ang) * rad });
        }
        t.generateTerrain();   // spawns must be set first: stone and gold rotate onto them
        this._anTerrain = t; this._anTerrainKey = key;
        return t;
    }


    // Construction progress for a recorded building, 0..1.
    //
    // The engine grows a scaffold from buildProgress/buildTime while underConstruction,
    // and draws a health bar only once that clears. Forcing every building to 'complete'
    // therefore did two wrong things at once: it skipped the scaffold, and it fed the
    // bar a health value that is not damage at all. A site's HP tracks its progress by
    // health = maxHealth * (0.2 + 0.8 * pct), so a Wonder at 0% built sits at 20% HP —
    // and rendered as a FINISHED wonder about to collapse, in red, for the whole minute
    // it was going up. The most conspicuous building in the game, wearing the one status
    // that would make a reader reach for the replay.
    //
    // buildPct is authoritative and the owner's own snapshot carries it. A rival's does
    // not, so it is inverted out of healthPct through the same formula — exact for an
    // undamaged site, which a half-built one nearly always is.
    anBuildProgress(b) {
        if (typeof b.buildPct === 'number') return Math.max(0, Math.min(1, b.buildPct / 100));
        if (typeof b.healthPct === 'number') {
            return Math.max(0, Math.min(1, (b.healthPct / 100 - 0.2) / 0.8));
        }
        return 0;
    }

    // Apply a recorded building's condition to a freshly created entity: still going up,
    // or standing and damaged.
    anApplyBuildState(ent, b) {
        const rising = b.state === 'under_construction';
        ent.underConstruction = rising;
        if (rising) {
            const pct = this.anBuildProgress(b);
            ent.buildProgress = pct * (ent.buildTime || 10000);
            // The same curve the game uses while building, so the scaffold and the
            // entity's health agree with each other.
            ent.health = Math.max(1, (ent.maxHealth || 100) * (0.2 + 0.8 * pct));
        } else if (b.healthPct != null) {
            ent.health = Math.max(1, (ent.maxHealth || 100) * b.healthPct / 100);
        }
    }
    // Everything the reader is allowed to see at this moment, put into the engine.
    // Rebuilt per seek rather than diffed: a snapshot is a whole world, and matching
    // entities across an 8-to-900-second gap would be inventing continuity the file
    // does not claim.
    anBuildStage(rec) {
        const a = this.analyzer, r = this.game.renderer;
        if (!a || !r || !rec) return;
        const sc = a.scene(rec, a.union);
        if (!sc) return;

        // The picked entity belonged to the previous scene and has just been thrown
        // away, so the card must not keep describing it.
        this._anPicked = null;
        r.clearScene();
        const terrain = this.anTerrain();
        this.game.terrain = terrain;          // the renderer reads it for ground + nodes
        r.setTerrain(terrain);

        // Nodes: only the ones somebody had found by now. The engine already carries a
        // visibility handle per resource because fog toggles it, so this is the same
        // mechanism rather than a second one.
        const known = new Set(sc.nodes.map(n => n.type + '@' + Math.round(n.x) + ',' + Math.round(n.z)));
        (terrain.resources || []).forEach(res => {
            const seen = known.has(res.type + '@' + Math.round(res.x) + ',' + Math.round(res.z));
            if (!res.mesh) return;
            if (res.mesh.trunk) { res.mesh.trunk.visible = seen; res.mesh.leaves.visible = seen; }
            else res.mesh.visible = seen;
        });

        // Units and buildings, built through the game's own factories so they get the
        // right civ mesh, colour and stats instead of a hand-rolled lookalike.
        sc.seats.forEach(s => {
            // The epoch decides how a building LOOKS, and createBuilding defaults it to
            // 'stone' when nobody says otherwise — which is why an Iron-Age wonder stood
            // in a field of stone-age tents. Each seat carries its own epoch at this
            // moment, and they differ: one match had gpt-oss in iron while ornith was
            // still bronze.
            const age = s.epoch || 'stone';
            s.buildings.forEach(b => {
                const rising = b.state === 'under_construction';
                // Told at CREATION, because _composeBuilding builds the scaffold from
                // this flag when the entity is added — setting it afterwards is too late.
                const ent = (typeof createBuilding === 'function')
                    ? createBuilding(b.type, b.x, b.z, s.id, s.civilization,
                        { instant: true, age, underConstruction: rising }) : null;
                if (!ent) return;
                ent.seat = s.seat;
                this.anApplyBuildState(ent, b);
                r.addBuilding(ent);
            });
            s.units.forEach(u => {
                const ent = (typeof createUnit === 'function')
                    ? createUnit(u.type, u.x, u.z, s.id, s.civilization, age) : null;
                if (!ent) return;
                // createUnit resolves the seat from the LIVE game, which has no idea
                // about a recorded match — so the badge is set from the transcript.
                ent.seat = s.seat;
                if (u.healthPct != null) ent.health = Math.max(1, (ent.maxHealth || 100) * u.healthPct / 100);
                ent.isAttacking = u.action === 'attacking';
                r.addUnit(ent);
            });
        });

        // Enemies, single-seat view only. Both kinds are drawn — a remembered position is
        // information the model had and acted on, so leaving it out shows less than the
        // model knew. What separates them is the FOG: only confirmed sightings get their
        // surroundings revealed below, so a remembered one stays in the dim explored tier
        // and reads as the stale claim it is. That is the game's own convention for
        // "I remember this", rather than a second fading mechanism beside it.
        if (!a.union) {
            sc.enemies.forEach(e => {
                const owner = a.seats.get(e.owner) || {};
                // The seats MAP has no epoch — only the scene's seat objects do — so this
                // read undefined and every rival building came out a stone-age hut, then
                // stayed one when it was seen again. The sighting now carries the age its
                // owner was in at the moment it was seen: current for something in view,
                // the age at last contact for something merely remembered.
                const oage = e.epochWhenSeen || 'stone';
                const isB = e.isBuilding || (e.healthPct !== undefined &&
                    /town_center|barracks|temple|academy|market|house|farm|pyramid|akropolis|firetemple|shrine|range|stable|tower|wonder/i.test(e.type || ''));
                // Translucent when the position is only remembered — for units as well as
                // buildings, which is what was missing: a stale unit stood there at full
                // strength looking like a live sighting.
                const fade = e.confirmed ? null : 0.4;
                if (isB) {
                    const rising = e.state === 'under_construction';
                    const ent = (typeof createBuilding === 'function')
                        ? createBuilding(e.type, e.x, e.z, e.owner, owner.civilization,
                            { instant: true, age: oage, underConstruction: rising }) : null;
                    if (ent) { ent.seat = owner.seat;
                              this.anApplyBuildState(ent, e);
                              ent._fade = fade; ent._anStale = !e.confirmed; r.addBuilding(ent); }
                } else {
                    const ent = (typeof createUnit === 'function')
                        ? createUnit(e.type, e.x, e.z, e.owner, owner.civilization, oage) : null;
                    if (ent) { ent.seat = owner.seat; ent._fade = fade;
                              ent._anStale = !e.confirmed; ent._anLastSeen = e.lastSeenSec; r.addUnit(ent); }
                }
            });
        }

        this.anApplyFog(sc, terrain);
        this.anRenderPick();

        // One framing per file, before anything else touches the camera. Auto camera is
        // off by default now, which means nothing else would ever point it anywhere: the
        // analyzer used to open on the map origin while the match happened three hundred
        // units away, staring at empty sea. Showing the whole board instead needs no
        // aiming at all -- the action is already in frame, wherever it is.
        //
        // Guarded on `rec` because anOpen renders once before any transcript exists, and
        // spending the one framing on that empty frame would leave the real one unframed.
        if (rec && !this._anFramed) {
            const rend = this.game.renderer;
            if (rend && rend.frameWholeMap) rend.frameWholeMap();
            this._anFramed = true;
        }
        if (a.autoCam) this.anAimCamera(rec, sc);
    }


    // Fog, per seat, for the moment being read. Without this the stage showed the whole
    // island lit — which is not what any model saw, and quietly turns the honest view
    // into an omniscient one.
    //
    // Two tiers, because the transcript records two different things. EXPLORED comes
    // from map.exploration, the seat's own 7x7 record of where it has been — coarse, but
    // it is the seat's record rather than a guess. VISIBLE is revealed around what it
    // owns right now, which is what its vision actually covers at this instant.
    anApplyFog(sc, terrain) {
        const a = this.analyzer;
        if (!a || !sc) return;
        let fow = this._anFog;
        // A destroyed manager is not a reusable one. destroy() drops fogDisplayCanvas,
        // fogCanvas and the scratch canvas — and startArenaFromSetup calls destroy() on
        // whatever fog happens to be installed, which is OURS whenever a match is
        // started while this screen's fog is the one in place. Reusing the corpse threw
        // inside updateFogTexture on a null canvas, and because that throw came from
        // anApplyFog inside anBuildStage inside anRender, it took the whole analyzer
        // render with it: reopen the screen and the fog was missing for good. Checking
        // mapSize alone could not see it, since the corpse keeps its numbers.
        const alive = !!(fow && fow.fogDisplayCanvas && fow.fogCanvas);
        if (!alive || fow.mapSize !== terrain.size) {
            if (typeof FogOfWarManager !== 'function') return;
            // It reads game.terrain and game.renderer off the game, both of which are
            // pointed at the rebuilt map by the caller before this runs.
            fow = this._anFog = new FogOfWarManager(this.game);
        }
        this.game.fogOfWar = fow;
        // Opacity scales with how much of a tile the seat uncovered. The transcript only
        // ever knows the PERCENTAGE per tile — never which cells inside it — so a hard
        // explored/unexplored edge would be inventing detail the file does not have. A
        // graded veil says exactly what is known: this much of here has been seen.
        fow.gradedFog = true;
        fow.fogGrid.fill(0);

        {
            const half = terrain.size / 2, N = fow.numTiles, cell = fow.gridSize;
            // ONE seat's record, or every seat's added together. The union view used to
            // lift the fog outright, which threw away the most interesting thing on the
            // map: ground nobody ever walked. Cumulating instead matches what the arena
            // spectator shows — everything anyone found is lit, and what nobody found
            // stays dark, which for four models over an hour is a real answer about how
            // much of the island the match actually used.
            const rec = a.current();
            const grids = a.union
                ? (sc.seats || []).map(x => x.exploration).filter(Boolean)
                : [(rec && rec.state && rec.state.map && rec.state.map.exploration) || null].filter(Boolean);
            // Keys are A1..G7: letter is the column, digit the row, over a 7x7 grid.
            const SPAN = 7, tile = terrain.size / SPAN;
            grids.forEach(exp => {
                Object.keys(exp).forEach(k => {
                    if (!(exp[k] > 0)) return;
                    const col = k.charCodeAt(0) - 65, row = parseInt(k.slice(1), 10) - 1;
                    if (col < 0 || col >= SPAN || !(row >= 0) || row >= SPAN) return;
                    const x0 = -half + col * tile, z0 = -half + row * tile;
                    const gx0 = Math.max(0, Math.floor((x0 + half) / cell));
                    const gz0 = Math.max(0, Math.floor((z0 + half) / cell));
                    const gx1 = Math.min(N - 1, Math.floor((x0 + tile + half) / cell));
                    const gz1 = Math.min(N - 1, Math.floor((z0 + tile + half) / cell));
                    // The fraction itself, not a flag. Clamped just under 1 so a fully
                    // swept tile still reads as explored-and-remembered rather than as
                    // being watched right now, which is what tier 2 means. Taken as a MAX
                    // across seats: two players who each swept half of a tile have not
                    // jointly swept all of it, and adding the percentages would claim so.
                    const frac = Math.min(0.97, Math.max(0, exp[k] / 100));
                    for (let gz = gz0; gz <= gz1; gz++) {
                        for (let gx = gx0; gx <= gx1; gx++) {
                            const i = gz * N + gx;
                            if (fow.fogGrid[i] < frac) fow.fogGrid[i] = frac;
                        }
                    }
                });
            });
            // A node it has found was seen, whatever the tile grid rounds to.
            sc.nodes.forEach(n => fow.reveal(n.x, n.z, 10));
            // ...and what it owns now is in sight now.
            (sc.seats || []).forEach(s => {
                s.units.forEach(u => fow.reveal(u.x, u.z, fow.unitVisionRange));
                s.buildings.forEach(b => fow.reveal(b.x, b.z, fow.buildingVisionRange));
            });
            // So is anything it can currently SEE of somebody else's — but not a
            // remembered one, whose whole point is that it sits in the dark.
            (sc.enemies || []).forEach(e => { if (e.confirmed) fow.reveal(e.x, e.z, 8); });
        }
        fow.updateFogTexture();
        fow.fogDirty = true;
    }
    // Auto mode points the camera at whatever the turn is ABOUT: a fight if there is
    // one, else the place the order names, else that seat's Town Center, else the
    // middle of its forces. Manual mode never moves it — the reader is steering.
    anAimCamera(rec, sc) {
        const r = this.game.renderer;
        if (!r || !r.moveCameraTo) return;
        const p = this.analyzer.cameraInterest(rec, sc);
        if (p) r.moveCameraTo(p.x, p.z);
    }

    anToggleAutoCam() {
        if (!this.analyzer) return;
        this.analyzer.autoCam = !this.analyzer.autoCam;
        if (this.analyzer.autoCam) this.anAimCamera(this.analyzer.current(),
            this.analyzer.scene(this.analyzer.current(), this.analyzer.union));
        this.anRender();
    }

    anToggleUnion() {
        if (!this.analyzer) return;
        this.analyzer.union = !this.analyzer.union;
        this.anRender();
    }

    // Drag the seam to decide how much room the action gets versus the reading.
    anSplitStart(ev) {
        const body = document.getElementById('anBody');
        if (!body) return;
        ev.preventDefault();
        const move = (e) => {
            const r = body.getBoundingClientRect();
            const y = (e.touches ? e.touches[0].clientY : e.clientY) - r.top;
            const pct = Math.max(20, Math.min(80, (y / r.height) * 100));
            body.style.gridTemplateRows = pct + '% 6px 1fr';
            if (this.game.renderer && this.game.renderer.onWindowResize) this.game.renderer.onWindowResize();
        };
        const up = () => {
            window.removeEventListener('mousemove', move);
            window.removeEventListener('mouseup', up);
            window.removeEventListener('touchmove', move);
            window.removeEventListener('touchend', up);
        };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
        window.addEventListener('touchmove', move, { passive: false });
        window.addEventListener('touchend', up);
    }


    anDetailHtml(r) {
        if (!r) return '';
        const a = this.analyzer;
        const esc = s => this.escapeHtml(String(s == null ? '' : s));
        const mmss = s => Math.floor(s / 60) + ':' + String(Math.round(s % 60)).padStart(2, '0');
        const s = a.seats.get(r.playerId) || {};
        const who = esc(s.name || s.model || s.civ || r.playerId);
        const head = '<div class="an-d-head">' + this.teamDotHtml(s.seat, 12) + ' ' + who
            + '<span class="an-d-t">' + esc(mmss(r._sec)) + '</span></div>';

        if (r.type === 'round_missed') {
            return head + '<div class="an-d-missed">⏱ ' + esc(r.note || t('an.rowMissed')) + '</div>';
        }
        // The last thing a model said. Shown whole and unstyled beyond a label, because
        // this is the one record in the file that is not data about play — it is the
        // model's own account of it, and it is worth reading as written. An action sent
        // here was never executed and is displayed as the text it is.
        if (r.type === 'final_word') {
            const oc = r.outcome === 'won' ? t('an.fwWon')
                : (r.outcome === 'defeated' ? t('an.fwDefeated') : t('an.fwLost'));
            return head
                + '<div class="an-d-sec"><span class="an-d-tag">' + esc(t('an.rowFinal')) + '</span>'
                + '<span class="an-d-cmd">' + esc(oc) + '</span></div>'
                + (r.text ? '<pre class="an-d-final">' + esc(r.text) + '</pre>'
                          : '<div class="an-d-missed">' + esc(r.error || t('an.fwSilent')) + '</div>')
                + (r.tokens ? '<div class="an-d-nums"><span>' + esc((r.tokens.prompt || 0) + '/'
                    + (r.tokens.completion || 0) + ' tok') + '</span></div>' : '');
        }

        // Standing objective and plan, CARRIED FORWARD. They persist across turns — "omit
        // to keep current" — so reading only this turn's record would blank them on the
        // ~11% of turns that simply did not restate them, showing an empty plan where
        // there is a plan. Flagged when THIS turn is the one that rewrote it, so a model
        // changing its mind is visible rather than just having a plan.
        let plan = '';
        if (r._objective || (r._plan && r._plan.length)) {
            plan = '<div class="an-d-plan">'
                + '<span class="an-d-tag">' + esc(t('an.planTag')) + '</span>'
                + (r._objective ? '<div class="an-d-obj">🎯 ' + esc(r._objective) + '</div>' : '')
                + ((r._plan && r._plan.length)
                    ? '<ol class="an-d-steps">' + r._plan.map(x => '<li>' + esc(x) + '</li>').join('') + '</ol>'
                    : '')
                + ((r._planNew || r._objectiveNew)
                    ? '<span class="an-d-newtag">' + esc(t('an.rewritten')) + '</span>' : '')
                + '</div>';
        }

        const p = r.parsed || {};
        const act = typeof p.action === 'string' ? p.action : '(malformed)';
        const params = Object.assign({}, p.params || {});
        const reason = params.reason; delete params.reason;
        const bad = typeof r.harnessResult === 'string' && r.harnessResult.indexOf('[ERROR]') === 0;

        const stt = r.state || {};
        const res = stt.resources || {};
        const wk = stt.workers || {};
        // The same icons the in-game HUD uses, so a figure here and a figure on the HUD
        // are recognised as the same thing. Only the workers had one, which made every
        // other number a letter to decode: F/W/S/G read as labels, not as food and wood
        // and stone and gold. Each carries its word as a tooltip, so an icon never has
        // to be guessed at.
        const num = [];
        const push = (txt, title) => num.push({ txt: String(txt), title: title || '' });
        const withIcon = (key, val) => {
            const L = this.anSplitLabel(key);
            push(L.icon ? L.icon + ' ' + val : L.text + ' ' + val, L.text);
        };
        if (stt.epoch && stt.epoch.currentEpoch) {
            const g = this.anSplitLabel('age.' + stt.epoch.currentEpoch);
            push(g.icon ? g.icon + ' ' + this.anAgeName(stt.epoch.currentEpoch)
                        : this.anAgeName(stt.epoch.currentEpoch), '');
        }
        if (res.population != null) {
            withIcon('res.pop', res.population + '/' + (res.maxPopulation != null ? res.maxPopulation : '?'));
        }
        ['food', 'wood', 'stone', 'gold'].forEach(k => {
            if (res[k] != null) withIcon('res.' + k, Math.round(res[k]));
        });
        if (wk.total != null) withIcon('res.workers', wk.total);
        if (Array.isArray(stt.friendlyUnits)) {
            // The MILITARY, not every unit. friendlyUnits counts workers too, so a sword
            // showing its length printed the headcount a second time — 3 workers beside
            // 3 "units" while the population read 3, which says six people. Population IS
            // workers plus military, so counting the non-workers makes the row add up.
            const mil = stt.friendlyUnits.filter(u => u.type !== 'worker').length;
            const L = this.anSplitLabel('res.military');
            push(L.icon ? L.icon + ' ' + mil : t('an.units', { n: mil }), L.text);
        }
        if (r.latencyMs) push(Math.round(r.latencyMs / 1000) + 's', '');
        if (r.tokens) push((r.tokens.prompt || 0) + '/' + (r.tokens.completion || 0) + ' tok', '');

        // Who else was on the board here, and how stale their picture is. The honest
        // answer to "what did this moment look like": one seat is current and the rest
        // were last heard from some seconds ago. That skew is a fact about the match —
        // seats snapshot on their own turns — not a gap to paper over, and it is the
        // reason nothing here is interpolated.
        const stale = a.staleness(r).map(x => {
            if (x.isCurrent) return '<span class="an-st is-cur">' + this.teamDotHtml(x.seat.seat, 8) + esc(t('an.now')) + '</span>';
            if (!x.last) return '<span class="an-st is-none">' + this.teamDotHtml(x.seat.seat, 8) + '—</span>';
            return '<span class="an-st">' + this.teamDotHtml(x.seat.seat, 8) + esc(t('an.agoS', { n: x.ageSec })) + '</span>';
        }).join('');

        // One block per command. A turn may carry up to MAX_COMMANDS_PER_TURN of them and
        // each is judged on its own, so each is shown with its OWN answer rather than
        // hidden behind the first one's.
        const cmdList = a.commandsOf ? a.commandsOf(r) : [];
        const cmdResults = a.resultsOf ? a.resultsOf(r) : [];
        const cmdBlocks = (cmdList.length ? cmdList : [p]).map((c, i) => {
            const nm = (c && typeof c.action === 'string') ? c.action : '(malformed)';
            const ps = Object.assign({}, (c && c.params) || {});
            const why = ps.reason; delete ps.reason;
            const res = cmdResults.length > 1 ? cmdResults[i] : (i === 0 ? cmdResults[0] : null);
            const isBad = typeof res === 'string' && res.indexOf('[ERROR]') === 0;
            const tag = cmdList.length > 1
                ? t('an.sentN', { i: i + 1, n: cmdList.length }) : t('an.sent');
            return '<div class="an-d-sec' + (isBad ? ' is-bad' : '') + '">'
                + '<span class="an-d-tag">' + esc(tag) + '</span>'
                + '<span class="an-d-cmd">' + esc(String(nm).replace(/_/g, ' ')) + '</span>'
                + (Object.keys(ps).length ? ' <code>' + esc(JSON.stringify(ps)) + '</code>' : '')
                + '</div>'
                + (why ? '<div class="an-d-reason">“' + esc(why) + '”</div>' : '');
        }).join('');

        // The numbers go DIRECTLY under the name, above everything variable. They used to
        // sit below the command, where the block above them changes height turn by turn —
        // so during playback the one row you want to watch was the one that moved most.
        // Pinned here it stays put and can be read while the rest scrolls beneath it.
        return head
            + '<div class="an-d-nums">' + num.map(x => '<span'
                + (x.title ? ' title="' + esc(x.title) + '"' : '') + '>' + esc(x.txt) + '</span>').join('')
            + '</div>'
            + '<div class="an-d-stale">' + stale + '</div>'
            + plan
            // Both blocks are labelled now. A target glyph suggests a plan; it does not
            // say so, and the command sat as a bare word with no clue what it was.
            + cmdBlocks
            + this.tvTurnHtml(r, { skipPlan: true });
    }

    publicResults(summary) {
        if (!summary) return null;
        const s = summary;
        return {
            type: 'results',
            at: Date.now(),
            outcome: s.reason || null,
            duration: s.durStr || null,
            playerCount: s.playerCount || 0,
            mapSeed: s.mapSeed || null,
            difficulty: s.difficulty || null,
            // Which build produced these numbers. The metrics below are what THIS
            // version reported; if a definition changes later a recomputation will
            // disagree, and that is correct — but only if the reader can tell which
            // rules were in force.
            build: UIManager.buildVersion(),
            promptVersion: this.ARENA_PROMPT_VERSION || null,
            ranking: (s.reports || []).map((r, i) => ({
                rank: i + 1,
                playerId: (r.ai && r.ai.id) || null,   // the id, never the object
                civ: (r.ai && r.ai.civilization) || null,
                civName: r.civName || null,
                model: r.model || null,
                isLLM: !!r.isLLM,
                isWinner: !!r.isWinner,
                alive: !!r.alive,
                power: r.power || 0,
                soundness: r.soundness || 0,
                age: r.ageName || null,
                workers: r.workers || 0, military: r.military || 0, buildings: r.buildings || 0,
                resources: { food: r.food || 0, wood: r.wood || 0, stone: r.stone || 0, gold: r.gold || 0 },
                modelConfig: r.modelConfig || null,     // already endpoint/key-free by design
                tags: (r.tags || []).map(x => x && x.t).filter(Boolean),
                metrics: r.metrics ? Object.assign({}, r.metrics, {
                    // Drop the raw latency array: hundreds of numbers per seat that the
                    // min/avg/max beside them already summarise.
                    latencies: undefined
                }) : null
            }))
        };
    }

    // The curve behind the result. Plain numbers already — samples every 5s plus the
    // three event arrays (age advances, exhausted node types, wonder events) that turn
    // the graph from a description into an explanation. Its "t" is seconds from the same
    // origin as every snapshot's clock.matchSeconds, so a replay can put a playhead on
    // the graph with no conversion and no drift.
    publicTimeline() {
        const tl = this.game && this.game._timeline;
        if (!tl) return null;
        return {
            type: 'timeline', t0: tl.t0 || null, intervalMs: Game.TIMELINE_MS,
            samples: tl.samples || [], ages: tl.ages || [],
            exhausted: tl.exhausted || [], wonders: tl.wonders || []
        };
    }

    // Which build is running, read off a loaded script rather than kept as a constant —
    // a constant is a second place to bump and would drift from the files it names.
    // A model's tool calls as the reply they are: one line per call, the tool it
    // reached for, then the arguments exactly as they arrived. Not prettified — a
    // reader hunting a malformed argument wants what came in, not a tidied version.
    toolCallsAsText(calls) {
        if (!Array.isArray(calls) || !calls.length) return '';
        return calls.map(c => {
            const f = (c && c.function) || {};
            let a = f.arguments;
            if (typeof a !== 'string') { try { a = JSON.stringify(a); } catch (err) { a = String(a); } }
            return (f.name || '?') + '  ' + (a || '');
        }).join('\n');
    }

    // Network failures, and WHEN they died. The count alone cannot tell a proxy
    // cutting every request at the same second from a flaky line, and those have
    // completely different fixes — one is a setting somebody owns, the other is not.
    // Shown as "4@101s" when they cluster, plain "4" when they scatter.
    netErrLabel(m) {
        const n = m.networkErrors || 0;
        const at = (m.networkAtMs || []).slice().sort((a, b) => a - b);
        if (!n || at.length < 2) return String(n);
        const med = at[Math.floor(at.length / 2)];
        const spread = at[at.length - 1] - at[0];
        // Within 20 % of the median is a cluster, not a coincidence.
        return (spread <= med * 0.2) ? `${n}@${Math.round(med / 1000)}s` : String(n);
    }

    static buildVersion() {
        try {
            const el = document.querySelector('script[src*="js/game.js"]');
            const m = el && String(el.getAttribute('src') || '').match(/[?&]v=(\d+)/);
            return m ? Number(m[1]) : null;
        } catch (e) { return null; }
    }

    buildResultsMarkdown(summary) {
        const { reports, reason, durStr, playerCount } = summary;
        const d = new Date();
        const pad = n => String(n).padStart(2, '0');
        const human = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

        const L = [];
        L.push(`# When Agents Rule — Arena Results`);
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
                L.push(`- Decisions: ${m.decisions} (answered ${m.responded}${(m.roundsMissed || 0) ? ` · ${m.roundsMissed} missed the round deadline` : ''})`);
                // Only when it says something: a match where every reply carried one
                // command prints exactly what it always did.
                if ((m.commandsPerTurn || 0) > 1.05) L.push(`- Commands per turn: ${m.commandsPerTurn.toFixed(2)} (${m.attempted} commands over ${Math.round(m.attempted / m.commandsPerTurn)} turns)`);
                // Denominator MUST match the percentage, which excludes contended
                // attempts (see the successRate definition — a busy barracks is not the
                // model's mistake). Printing raw m.attempted here made "95% (374/402)"
                // where 374/402 is 93%: the fraction contradicted its own percentage
                // whenever contended > 0. Mirror the in-app summary (sum-metric) exactly.
                L.push(`- Success rate: ${Math.round(m.successRate * 100)}% (${m.succeeded}/${m.attempted - (m.contended || 0)}${(m.contended || 0) ? ` · ${m.contended} not scored (timing)` : ''})`);
                L.push(`- Format fidelity: ${Math.round(m.formatOk * 100)}%`);
                L.push(`- Reasoning rate: ${Math.round(m.reasonRate * 100)}%`);
                L.push(`- Reliability: ${Math.round(m.reliability * 100)}%`);
                L.push(`- Latency: avg ${(m.avgLatency / 1000).toFixed(1)}s (min ${(m.minLatency / 1000).toFixed(1)}s, max ${(m.maxLatency / 1000).toFixed(1)}s)`);
                L.push(`- Errors: timeouts ${m.timeouts} · network ${m.networkErrors} · parse ${m.parseFails} (of which truncated ${m.truncated || 0}) · no-action ${m.noAction || 0} · invalid ${m.invalidActions} · rejected ${m.rejected} · contended ${m.contended || 0} · context-overflows ${m.contextOverflows || 0} · rate-limited ${m.rateLimited || 0} (of which cost a turn ${m.rateLimitLost || 0})`);
            L.push(`- Tokens: ${(m.promptTokens + m.completionTokens) ? `${m.promptTokens} prompt + ${m.completionTokens} completion = ${m.promptTokens + m.completionTokens}` : 'not reported by endpoint'}`);
                if (r.tags && r.tags.length) L.push(`- Behavior: ${r.tags.map(x => x.t).join(', ')}`);
                const actions = Object.entries(m.actionCounts || {}).sort((a, b) => b[1] - a[1])
                    .map(([k, v]) => `${k}·${v}`).join(', ');
                if (actions) L.push(`- Actions used: ${actions}`);
            }
            L.push('');
        });

        L.push('---');
        L.push(`_Generated by When Agents Rule. Non-scientific testbed — tempo, map and sample size all affect outcomes._`);
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

// Die Startseite ist der einzige Ort, an dem ein Zuschauer sieht, welchen Stand
// er vor sich hat. Gefuellt aus denselben zwei Quellen, die auch ins Transkript
// gehen (build und promptVersion), damit die Anzeige nicht davon abweichen kann,
// was tatsaechlich gelaufen ist. Kein data-i18n auf den Werten: applyI18n
// ueberschreibt textContent, ein Sprachwechsel wuerde sie sonst leeren.
(function stampVersions() {
    const fill = () => {
        const b = document.getElementById('stampBuild');
        const p = document.getElementById('stampPrompt');
        if (b) b.textContent = UIManager.buildVersion() || '?';
        if (p) p.textContent = UIManager.ARENA_PROMPT_VERSION;
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fill);
    else fill();
})();
