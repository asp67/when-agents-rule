// ---------------------------------------------------------------------------
// The Benchmark page (b1092): WAR Bench scenarios for a library model, in the browser.
//
// Pick a model from the library, a scenario or a whole family of them, and how many
// runs each; the runs play one by one, each in a worker of its own (js/bench-worker.js),
// with the world frozen while the model thinks -- the protocol of tools/bench, run by
// the same core (js/bench-core.js). Then a chart and the numbers.
//
// Every finished run is kept in this browser (localStorage, a summary per episode, no
// prompts or replies) so a model's results add up across sessions: the library card's
// "Benchmarks" button opens them. A run can also be saved as a file: the summary as
// JSON, which this page imports again, and the full bundle (.warbench.jsonl.gz), which
// `node tools/bench/war-bench.cjs verify` checks and replays in Node.
// ---------------------------------------------------------------------------
class BenchPage {
    constructor(ui) {
        this.ui = ui;
        this.scenarios = null;      // validated war-scenario-v1 objects, by family then id
        this.run = null;            // the run in progress
        this.last = null;           // the last finished run: {summary, lines}
    }

    static get STORE() { return 'war.bench.v1'; }
    static get SETUP_STORE() { return 'war.bench.setup'; }
    static get RESULTS_SCHEMA() { return 'war-bench-results-v1'; }
    // The reference policies, beside the library: the floor every model is read against.
    static get BASELINE_KEYS() { return ['random-valid', 'noop']; }

    esc(s) { return this.ui.escapeHtml(s == null ? '' : String(s)); }
    el(id) { return document.getElementById(id); }

    // ---- Stored results ---------------------------------------------------------
    // Browser storage can be missing or full (a private window, cleared site data); the
    // page works without it and says so when a run could not be kept.
    loadRuns() {
        try {
            const v = JSON.parse(localStorage.getItem(BenchPage.STORE) || 'null');
            return v && Array.isArray(v.runs) ? v.runs : [];
        } catch (e) { return []; }
    }
    saveRuns(runs) {
        try { localStorage.setItem(BenchPage.STORE, JSON.stringify({ schema: BenchPage.RESULTS_SCHEMA, runs })); return true; }
        catch (e) { return false; }
    }
    runsFor(key) { return this.loadRuns().filter(r => r.modelKey === String(key)); }
    countFor(key) { return this.runsFor(key).length; }

    // ---- Opening ----------------------------------------------------------------
    async open({ history = null } = {}) {
        // Back goes where the page was opened from: the menu, or the library card.
        const from = document.querySelector('.screen.active');
        if (from && from.id !== 'benchScreen') this.returnTo = from.id;
        // The library is the arena's; it is loaded once, by whichever page needs it first.
        if (!this.ui._arenaConfig) this.ui._arenaConfig = await this.ui.loadArenaConfig();
        this.ui.showScreen('benchScreen');
        if (this.run) { this.renderProgress(); return; }
        try { await this.loadScenarios(); }
        catch (e) { this.el('benchBody').innerHTML = `<p class="bench-error">${this.esc(t('bench.loadFailed', { e: e.message || String(e) }))}</p>`; return; }
        if (history != null) this.renderHistory(String(history));
        else this.renderSetup();
    }
    close() {
        if (this.run) return;   // the Stop button ends a run; leaving does not
        const to = this.returnTo || 'startScreen';
        if (to === 'modelLibraryScreen') this.ui.showModelLibrary();
        else this.ui.showScreen(to);
    }
    onLanguageChanged() {
        if (!this.el('benchScreen') || !this.el('benchScreen').classList.contains('active')) return;
        if (this.run) this.renderProgress();
        else if (this._view === 'history') this.renderHistory(this._historyKey);
        else if (this._view === 'results' && this.last) this.renderResults(this.last.summary);
        else this.renderSetup();
    }

    // The scenarios, as the repository files them (benchmarks/scenarios/index.json).
    async loadScenarios() {
        if (this.scenarios) return this.scenarios;
        const v = this.version();
        const get = async p => { const r = await fetch(p + (v ? '?v=' + v : ''), { cache: 'no-store' }); if (!r.ok) throw new Error(p + ': ' + r.status); return r.json(); };
        const index = await get('benchmarks/scenarios/index.json');
        const list = await Promise.all(index.scenarios.map(f => get('benchmarks/scenarios/' + f)));
        this.scenarios = list.map(s => WarBench.validate(s))
            .sort((a, b) => a.family.localeCompare(b.family) || a.id.localeCompare(b.id));
        return this.scenarios;
    }
    version() {
        const tag = document.querySelector('script[src^="js/game.js"]');
        return tag ? (tag.getAttribute('src').split('?v=')[1] || '') : '';
    }

    // ---- Setup ------------------------------------------------------------------
    setupDefaults() {
        let saved = {};
        try { saved = JSON.parse(localStorage.getItem(BenchPage.SETUP_STORE) || '{}') || {}; } catch (e) { saved = {}; }
        return Object.assign({ model: null, scenarios: null, runs: 4, minutes: 10, prompt: 'standard' }, saved);
    }
    rememberSetup(s) { try { localStorage.setItem(BenchPage.SETUP_STORE, JSON.stringify(s)); } catch (e) { /* a convenience only */ } }

    modelLabel(key) {
        if (String(key).startsWith('baseline:')) return t('bench.baseline.' + String(key).slice(9));
        const rows = this.ui._arenaConfig ? this.ui.orderedModels() : [];
        const row = rows.find(r => r.m.uid === String(key));
        return row ? this.ui.modelDisplayName(row.m, row.n) : null;
    }

    renderSetup() {
        this._view = 'setup';
        const d = this.setupDefaults();
        const rows = this.ui._arenaConfig ? this.ui.orderedModels() : [];
        const models = rows.map(r => {
            const n = this.countFor(r.m.uid);
            return `<option value="${this.esc(r.m.uid)}" ${String(d.model) === r.m.uid ? 'selected' : ''}>${this.esc(this.ui.modelDisplayName(r.m, r.n))}${r.m.model ? ' · ' + this.esc(r.m.model) : ''}${n ? ' · ' + this.esc(t('bench.runsSaved', { n })) : ''}</option>`;
        }).join('');
        const baselines = BenchPage.BASELINE_KEYS.map(k => `<option value="baseline:${k}" ${d.model === 'baseline:' + k ? 'selected' : ''}>${this.esc(t('bench.baseline.' + k))}</option>`).join('');
        const chosen = new Set(d.scenarios || this.scenarios.map(s => s.id));
        const families = [...new Set(this.scenarios.map(s => s.family))];
        const famHtml = families.map(f => {
            const list = this.scenarios.filter(s => s.family === f);
            const all = list.every(s => chosen.has(s.id));
            return `<fieldset class="bench-family">
                <legend><label><input type="checkbox" data-family="${this.esc(f)}" ${all ? 'checked' : ''} onchange="game.ui.benchPage().toggleFamily(this)"> ${this.esc(t('bench.family.' + f))}</label></legend>
                ${list.map(s => `<label class="bench-scn"><input type="checkbox" data-scenario="${this.esc(s.id)}" data-of="${this.esc(f)}" ${chosen.has(s.id) ? 'checked' : ''} onchange="game.ui.benchPage().syncFamily('${this.esc(f)}')">
                    <span class="bench-scn-title">${this.esc(s.title)}</span>
                    <span class="bench-scn-meta">${this.esc(s.id)} · ${this.esc(t('bench.scnRounds', { n: s.rounds, s: s.rounds * WarBench.ROUND_MS / 1000 }))}${s.partial ? ' · ' + this.esc(t('bench.scnPartial')) : ''}${s.graded ? ' · ' + this.esc(t('bench.scnGraded')) : ''}</span>
                    <span class="bench-scn-obj">${this.esc(s.objective.replace(/\{\{[^}]+\}\}/g, '…'))}</span></label>`).join('')}
            </fieldset>`;
        }).join('');
        const total = this.runsFor(d.model || '').length;
        this.el('benchBody').innerHTML = `
            <section class="arena-section bench-setup">
                <div class="arena-field"><label for="benchModel">${t('bench.model')}</label>
                    <select id="benchModel" onchange="game.ui.benchPage().onModelPicked()">
                        <option value="">${this.esc(t('bench.pickModel'))}</option>
                        ${rows.length ? `<optgroup label="${this.esc(t('bench.library'))}">${models}</optgroup>` : ''}
                        <optgroup label="${this.esc(t('bench.references'))}">${baselines}</optgroup>
                    </select>
                    <p class="arena-hint">${t('bench.modelHint')}</p>
                    <div id="benchModelHistory">${this.historyLink(d.model, total)}</div>
                </div>
                <div class="arena-field"><label>${t('bench.scenarios')}</label>
                    <p class="arena-hint">${t('bench.scenariosHint')}</p>
                    <div class="bench-families">${famHtml}</div>
                </div>
                <div class="bench-numbers">
                    <div class="arena-field"><label for="benchRuns">${t('bench.runs')}</label>
                        <input type="number" id="benchRuns" min="1" max="64" value="${Number(d.runs) || 4}">
                        <p class="arena-hint">${t('bench.runsHint')}</p></div>
                    <div class="arena-field"><label for="benchMinutes">${t('bench.minutes')}</label>
                        <input type="number" id="benchMinutes" min="0" max="240" value="${Number.isFinite(Number(d.minutes)) ? Number(d.minutes) : 10}">
                        <p class="arena-hint">${t('bench.minutesHint', { cap: Math.round(WarBench.PARTIAL_CAP * 100) })}</p></div>
                    <div class="arena-field"><label for="benchPrompt">${t('bench.prompt')}</label>
                        <select id="benchPrompt">
                            <option value="standard" ${d.prompt !== 'arena' ? 'selected' : ''}>${this.esc(t('bench.promptStandard', { v: UIManager.ARENA_PROMPT_VERSION }))}</option>
                            <option value="arena" ${d.prompt === 'arena' ? 'selected' : ''}>${this.esc(t('bench.promptArena'))}</option>
                        </select>
                        <p class="arena-hint">${t('bench.promptHint')}</p></div>
                </div>
                <p class="bench-error" id="benchSetupError" role="alert"></p>
            </section>
            <div class="arena-setup-buttons">
                <button class="menu-btn bench-start" onclick="game.ui.benchPage().start()">${t('bench.start')}</button>
                <button class="menu-btn back-btn" onclick="game.ui.benchPage().exportAll()">${t('bench.exportAll')}</button>
                <button class="menu-btn back-btn" onclick="game.ui.benchPage().importFile()">${t('bench.import')}</button>
                <button class="menu-btn back-btn" onclick="game.ui.benchPage().close()">${t('common.back')}</button>
            </div>`;
    }
    historyLink(key, n) {
        if (!key || !n) return '';
        return `<button class="lib-io-btn" onclick="game.ui.benchPage().renderHistory('${this.esc(key)}')">${this.esc(t('bench.openHistory', { n }))}</button>`;
    }
    onModelPicked() {
        const key = this.el('benchModel').value;
        this.el('benchModelHistory').innerHTML = this.historyLink(key, this.countFor(key));
    }
    toggleFamily(box) {
        document.querySelectorAll(`#benchBody input[data-of="${box.dataset.family}"]`).forEach(b => { b.checked = box.checked; });
    }
    syncFamily(f) {
        const boxes = [...document.querySelectorAll(`#benchBody input[data-of="${f}"]`)];
        const head = document.querySelector(`#benchBody input[data-family="${f}"]`);
        if (head) head.checked = boxes.every(b => b.checked);
    }

    // The seat a library entry plays as: the arena's own conversion (slotToSetupEntry),
    // then the bench's model config. maxTokens as the arena seat sends it (8192 unset).
    // `key` is the entry's uid, which outlives the list position slotToSetupEntry takes.
    seatConfig(key, promptChoice) {
        const m = (this.ui._arenaConfig.models || []).find(x => x.uid === key);
        if (!m) throw new Error(t('bench.noEndpoint'));
        const entry = this.ui.slotToSetupEntry({ control: m.id, civ: 'greek', prompt: '' });
        const c = entry && entry.connection;
        if (!c || !c.endpoint) throw new Error(t('bench.noEndpoint'));
        const reqOpts = {};
        for (const k of ['temperature', 'topP', 'topK', 'minP', 'presencePenalty', 'repetitionPenalty', 'thinkingSend', 'extraBody'])
            if (c[k] != null) reqOpts[k] = c[k];
        if (c.reasoning) reqOpts.reasoning = c.reasoning;
        const cfg = { name: c.name, endpoint: c.endpoint, model: c.model || 'default', provider: c.provider || 'auto',
            maxTokens: c.maxTokens || 8192, contextSize: c.contextSize || null, language: c.language || 'en',
            reqOpts, auth: c.auth || { type: 'none' } };
        if (promptChoice === 'arena') {
            const tpl = entry.systemPrompt || '';
            if (tpl.split(OpenAIAIManager.VICTORY_PARAGRAPH).length !== 2) throw new Error(t('bench.promptNoVictory'));
            cfg.systemPrompt = tpl;
        }
        return cfg;
    }

    // ---- Running ----------------------------------------------------------------
    async start() {
        const err = msg => { this.el('benchSetupError').textContent = msg; };
        const key = this.el('benchModel').value;
        if (!key) return err(t('bench.pickModel'));
        const ids = [...document.querySelectorAll('#benchBody input[data-scenario]')].filter(b => b.checked).map(b => b.dataset.scenario);
        if (!ids.length) return err(t('bench.pickScenario'));
        const runs = Math.max(1, Math.min(64, parseInt(this.el('benchRuns').value, 10) || 1));
        const minutes = Math.max(0, Math.min(240, Number(this.el('benchMinutes').value) || 0));
        const promptChoice = this.el('benchPrompt').value;
        this.rememberSetup({ model: key, scenarios: ids, runs, minutes, prompt: promptChoice });
        let policy;
        try {
            if (key.startsWith('baseline:')) policy = { kind: 'baseline', name: key.slice(9) };
            else policy = { kind: 'model', cfg: this.seatConfig(key, promptChoice) };
        } catch (e) { return err(e.message || String(e)); }
        let texts;
        try { texts = await this.ruleTexts(); }
        catch (e) { return err(t('bench.loadFailed', { e: e.message || String(e) })); }

        const scenarios = this.scenarios.filter(s => ids.includes(s.id));
        // Run i of a scenario turns the board to its i-th orientation, round the eight:
        // the same problem seen from another side, so repeating a scenario is not
        // repeating one board.
        const plan = [];
        for (const s of scenarios) for (let i = 1; i <= runs; i++) {
            const n = s.variants.length;
            plan.push({ scenario: s, iteration: i, variant: s.variants[(i - 1) % n], attempt: Math.floor((i - 1) / n) + 1 });
        }
        const label = this.modelLabel(key) || key;
        this.run = { key, label, policy, promptChoice, scenarios, runs, minutes, plan, texts, done: [], index: 0,
            worker: null, round: 0, rounds: 0, lastMs: null, startedAt: Date.now(), stopped: false, problem: null };
        this.renderProgress();
        // A model can think for two minutes: the wait is shown ticking, so a slow answer
        // is never mistaken for a page that stopped.
        const run = this.run;
        run.ticker = setInterval(() => { if (this.run === run && this._view === 'progress') this.renderProgress(); }, 1000);
        await this.loop();
    }

    // The texts this page loaded, ?v= included, line endings normalized: what the
    // workers run and what the bundle embeds.
    async ruleTexts() {
        const urls = {};
        document.querySelectorAll('script[src]').forEach(el => {
            const src = el.getAttribute('src') || '';
            urls[src.split('?')[0]] = new URL(src, location.href).href;
        });
        const files = ['js/bench-core.js', 'js/manifest.js', ...WarManifest.vm];
        const texts = {};
        await Promise.all(files.map(async f => {
            const r = await fetch(urls[f] || f, { cache: 'no-store' });
            if (!r.ok) throw new Error(f + ': ' + r.status);
            texts[f] = (await r.text()).split('\r\n').join('\n');
        }));
        return texts;
    }

    episode(run, step) {
        return new Promise(resolve => {
            const v = this.version();
            let worker;
            try { worker = new Worker('js/bench-worker.js' + (v ? '?v=' + v : '')); }
            catch (e) { resolve({ type: 'error', problem: e.message || String(e) }); return; }
            run.worker = worker;
            run.round = 0; run.rounds = step.scenario.rounds; run.askedAt = Date.now();
            worker.onmessage = ({ data }) => {
                if (data.type === 'round') {
                    run.round = data.round; run.lastMs = data.ms; run.lastAnswered = data.answered;
                    if (!data.answered) run.unanswered = (run.unanswered || 0) + 1;
                    run.askedAt = Date.now();
                    this.renderProgress();
                } else { worker.terminate(); run.worker = null; resolve(data); }
            };
            worker.onerror = e => { worker.terminate(); run.worker = null; resolve({ type: 'error', problem: (e && e.message) || 'worker failed' }); };
            run.cancel = () => { worker.terminate(); run.worker = null; resolve({ type: 'stopped' }); };
            worker.postMessage({ type: 'run', texts: run.texts, scenario: step.scenario, variant: step.variant, attempt: step.attempt,
                policy: run.policy, ceilingMs: WarBench.CEILING_MS,
                deadline: run.minutes > 0 ? Date.now() + run.minutes * 60000 : null });
        });
    }

    async loop() {
        const run = this.run;
        while (run.index < run.plan.length && !run.stopped) {
            const step = run.plan[run.index];
            const out = await this.episode(run, step);
            if (out.type === 'stopped') break;
            if (out.type === 'error') { run.problem = out.problem; break; }
            run.done.push({ step, out });
            run.index++;
            this.renderProgress();
        }
        this.finish(run);
    }

    stop() {
        const run = this.run;
        if (!run) return;
        run.stopped = true;
        if (run.cancel) run.cancel();
    }

    // A run, finished or stopped: scored, kept, and offered as files.
    finish(run) {
        this.run = null;
        clearInterval(run.ticker);
        const results = run.done.map(d => d.out.result);
        const summary = this.summarize(run, results);
        let lines = null;
        if (run.done.length) {
            const sources = Object.fromEntries(Object.entries(run.texts).filter(([f]) => f !== 'js/bench-core.js'));
            const chain = WarBench.bundleChain(warSha256);
            const config = run.policy.kind === 'model' ? Object.assign({}, run.policy.cfg, { auth: { type: 'none' } }) : null;
            WarBench.bundleOpen(chain, { sha: warSha256, sources, scenarios: run.scenarios,
                policy: { name: run.label, kind: run.policy.kind, config },
                coreHash: warSha256(WarManifest.rules.map(f => sources[f]).join('\n')), attempts: run.runs,
                label: 'browser', extra: { iterations: run.runs, build: summary.build, wallLimitMinutes: run.minutes || null } });
            for (const d of run.done) WarBench.bundleEpisode(chain, { id: d.step.scenario.id, variant: d.step.variant, attempt: d.step.attempt },
                d.out.rounds.map(({ type, ...r }) => r), d.out.result, d.out.snapshot);
            WarBench.bundleClose(chain, results);
            lines = chain.lines;
            summary.coreHash = JSON.parse(lines[0]).coreHash;
            summary.harnessHash = JSON.parse(lines[0]).harnessHash;
            const runs = this.loadRuns();
            runs.push(summary);
            summary.kept = this.saveRuns(runs);
            // The entry's uid is now what these results are found by: make sure the
            // library has it on disk, not only in this page.
            if (run.policy.kind === 'model') this.ui.saveArenaConfig();
        }
        this.last = { summary, lines };
        this.renderResults(summary);
    }

    // What is kept of a run: per episode its outcome, score and costs -- never the
    // prompts or the replies, which live in the bundle file.
    summarize(run, results) {
        const cfg = run.policy.kind === 'model' ? run.policy.cfg : null;
        let host = null;
        try { host = cfg ? new URL(cfg.endpoint).host : null; } catch (e) { host = null; }
        const episodes = run.done.map(({ step, out }) => {
            const classes = {};
            for (const e of out.result.log) for (const o of e.outcomes || []) classes[o.class] = (classes[o.class] || 0) + 1;
            const ms = out.ms || [];
            return { id: step.scenario.id, family: step.scenario.family, title: step.scenario.title, variant: step.variant,
                attempt: step.attempt, outcome: out.result.outcome, score: WarBench.episodeScore(out.result),
                parts: out.result.parts || null, notes: out.result.notes || null,
                rounds: out.result.rounds, maxRounds: step.scenario.rounds, stopped: out.result.stopped || null,
                unanswered: (out.rounds || []).filter(r => r.answer == null).length, seat: out.seat || null,
                ms: ms.length ? Math.round(ms.reduce((a, b) => a + b, 0) / ms.length) : null, maxMs: ms.length ? Math.round(Math.max(...ms)) : null,
                tokens: out.tokens || null, classes };
        });
        return {
            id: 'run-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e6).toString(36),
            at: new Date().toISOString(), modelKey: run.key, label: run.label,
            model: cfg ? { name: cfg.name, model: cfg.model, provider: cfg.provider, host, maxTokens: cfg.maxTokens,
                contextSize: cfg.contextSize, reqOpts: cfg.reqOpts } : { baseline: run.policy.name },
            prompt: run.policy.kind === 'model' ? run.promptChoice : null,
            promptVersion: UIManager.ARENA_PROMPT_VERSION, build: UIManager.buildVersion ? UIManager.buildVersion() : null,
            protocol: { roundMs: WarBench.ROUND_MS, ceilingMs: WarBench.CEILING_MS, wallLimitMinutes: run.minutes || null },
            runsPerScenario: run.runs, planned: run.plan.length, complete: run.done.length === run.plan.length,
            problem: run.problem || null, episodes,
        };
    }

    renderProgress() {
        const run = this.run;
        if (!run) return;
        this._view = 'progress';
        const total = run.plan.length, done = run.done.length;
        const step = run.plan[Math.min(run.index, total - 1)];
        const frac = total ? (done + (run.rounds ? Math.min(1, run.round / run.rounds) : 0)) / total : 0;
        const pct = Math.round(frac * 100);
        const mark = o => ({ success: '✓', partial: '◐', graded: '◆', failure: '✗' })[o] || '·';
        const list = run.done.slice(-12).reverse().map(d => {
            const r = d.out.result;
            return `<li class="bench-ep bench-${r.outcome}"><span class="bench-mark" aria-hidden="true">${mark(r.outcome)}</span>
                ${this.esc(d.step.scenario.title)} <span class="bench-ep-meta">${this.esc(d.step.variant)} · ${this.esc(t('bench.outcome.' + r.outcome))}${r.outcome === 'partial' || r.outcome === 'graded' ? ' ' + Math.round(r.score * 100) + ' %' : ''}${r.notes && r.notes.found != null ? ' · ' + this.esc(t('bench.foundIn', { r: r.notes.found })) : ''} · ${this.esc(t('bench.roundsOf', { n: r.rounds, of: d.step.scenario.rounds }))}${r.stopped ? ' · ' + this.esc(t('bench.timeUp')) : ''}</span></li>`;
        }).join('');
        const body = `
            <section class="arena-section bench-progress" aria-live="polite">
                <h3>${this.esc(t('bench.running', { model: run.label }))}</h3>
                <div class="bench-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><div style="width:${pct}%"></div></div>
                <p class="bench-now">${this.esc(t('bench.progressLine', { done, total, pct }))}</p>
                ${run.index < total ? `<p class="bench-now"><b>${this.esc(step.scenario.title)}</b> · ${this.esc(step.variant)} ·
                    ${this.esc(t('bench.runOf', { i: step.iteration, n: run.runs }))} ·
                    ${this.esc(t('bench.roundOf', { r: Math.min(run.round + 1, run.rounds || step.scenario.rounds), n: run.rounds || step.scenario.rounds }))}
                    ${run.lastMs != null ? ' · ' + this.esc(t(run.lastAnswered === false ? 'bench.lastNoAnswer' : 'bench.lastAnswer', { s: (run.lastMs / 1000).toFixed(1) })) : ''}</p>
                <p class="bench-now bench-wait">${this.esc(t('bench.waiting', { s: Math.max(0, Math.round((Date.now() - (run.askedAt || Date.now())) / 1000)) }))}</p>` : ''}
                ${run.unanswered ? `<p class="bench-note">${this.esc(t('bench.noAnswerLive', { n: run.unanswered }))}</p>` : ''}
                <ul class="bench-eps">${list}</ul>
            </section>
            <div class="arena-setup-buttons">
                <button class="menu-btn back-btn" onclick="game.ui.benchPage().stop()">${t('bench.stop')}</button>
            </div>`;
        this.el('benchBody').innerHTML = body;
    }

    // ---- Results ----------------------------------------------------------------
    // Per scenario (and all together): outcomes, the mean score with its interval, the
    // success rate with Wilson's, answer time, tokens and what became of the commands.
    aggregate(episodes) {
        const by = new Map();
        for (const e of episodes) {
            const g = by.get(e.id) || { id: e.id, title: e.title, family: e.family, eps: [] };
            g.eps.push(e); by.set(e.id, g);
        }
        const stat = (eps, title, id) => {
            const n = eps.length, count = o => eps.filter(e => e.outcome === o).length;
            const timed = eps.filter(e => e.ms != null);
            const rounds = eps.reduce((a, e) => a + (e.rounds || 0), 0);
            const tok = eps.reduce((a, e) => a + ((e.tokens && e.tokens.completion) || 0), 0);
            const classes = {};
            for (const e of eps) for (const [k, v] of Object.entries(e.classes || {})) classes[k] = (classes[k] || 0) + v;
            const commands = Object.values(classes).reduce((a, b) => a + b, 0);
            // A graded scenario's parts, averaged, and how often the notes came true --
            // "found" among them: recorded, never scored.
            const graded = eps.filter(e => e.parts);
            const parts = {};
            for (const e of graded) for (const [k, v] of Object.entries(e.parts)) parts[k] = (parts[k] || 0) + v / graded.length;
            const noted = eps.filter(e => e.notes && 'found' in e.notes), found = noted.filter(e => e.notes.found != null);
            return { id, title, n, success: count('success'), partial: count('partial'), failure: count('failure'), graded: count('graded'),
                parts: graded.length ? parts : null,
                found: noted.length ? { n: noted.length, k: found.length, round: found.length ? found.reduce((a, e) => a + e.notes.found, 0) / found.length : null } : null,
                score: WarBench.meanScore(eps.map(e => e.score || 0)), rate: WarBench.wilson(count('success'), n),
                ms: timed.length ? timed.reduce((a, e) => a + e.ms, 0) / timed.length : null,
                tokensPerRound: rounds && tok ? tok / rounds : null,
                refused: commands ? (classes.reference || 0) / commands : null, commands, stopped: eps.filter(e => e.stopped).length,
                rounds, unanswered: eps.reduce((a, e) => a + (e.unanswered || 0), 0) };
        };
        const rows = [...by.values()].sort((a, b) => a.family.localeCompare(b.family) || a.id.localeCompare(b.id)).map(g => stat(g.eps, g.title, g.id));
        return { all: stat(episodes, t('bench.allScenarios'), '*'), rows };
    }

    // One row per scenario: the outcome shares as a stacked bar (success, partial,
    // failure in the status colors, each with its mark in the legend and the table),
    // and the mean score at the end of the row. A graded scenario has no outcomes to
    // share out: its row is the mean score itself, as a bar, with its interval.
    chart(agg) {
        const rows = [agg.all, ...agg.rows];
        const W = 720, labelW = 210, barW = 330, rowH = 34, top = 8, x0 = labelW;
        const H = top + rows.length * rowH + 4;
        const pct = v => Math.round(v * 100);
        const seg = (x, w, cls, tip) => w > 0 ? `<rect class="bench-seg ${cls}" x="${x.toFixed(1)}" y="0" width="${Math.max(0, w).toFixed(1)}" height="16" rx="2"><title>${this.esc(tip)}</title></rect>` : '';
        const body = rows.map((r, i) => {
            const y = top + i * rowH;
            const parts = [['success', r.success], ['partial', r.partial], ['graded', r.graded], ['failure', r.failure]].filter(p => p[1] > 0);
            const gap = 2, usable = barW - gap * Math.max(0, parts.length - 1);
            let x = x0;
            const sc = r.score;
            const segs = r.graded === r.n && sc.mean != null
                ? `<rect class="bench-track" x="${x0}" y="0" width="${barW}" height="16" rx="2"></rect>`
                  + seg(x0, barW * sc.mean, 'bench-graded', `${t('bench.outcome.graded')}: ${sc.mean.toFixed(2)}`)
                  + `<line class="bench-whisker" x1="${(x0 + barW * sc.lo).toFixed(1)}" x2="${(x0 + barW * sc.hi).toFixed(1)}" y1="22" y2="22"></line>`
                : parts.map(([o, k]) => {
                    const w = usable * k / r.n;
                    const s = seg(x, w, 'bench-' + o, `${t('bench.outcome.' + o)}: ${k} / ${r.n} (${pct(k / r.n)} %)`);
                    x += w + gap;
                    return s;
                }).join('');
            const label = sc.mean == null ? '–' : `${sc.mean.toFixed(2)}  [${sc.lo.toFixed(2)}–${sc.hi.toFixed(2)}]`;
            const name = r.title.length > 30 ? r.title.slice(0, 29) + '…' : r.title;
            return `<g transform="translate(0,${y})" class="${i === 0 ? 'bench-row-all' : ''}">
                <text x="${labelW - 12}" y="12.5" text-anchor="end" class="bench-chart-label">${this.esc(name)}<title>${this.esc(r.title)}</title></text>
                <g transform="translate(0,0)">${segs}</g>
                <text x="${x0 + barW + 12}" y="12.5" class="bench-chart-value">${this.esc(label)}</text>
                <text x="${x0 + barW + 12}" y="26" class="bench-chart-n">n = ${r.n}</text>
            </g>`;
        }).join('');
        const kinds = ['success', 'partial'].concat(agg.all.graded ? ['graded'] : [], ['failure']);
        const legend = kinds.map(o => `<span class="bench-key"><i class="bench-swatch bench-${o}"></i>${({ success: '✓', partial: '◐', graded: '◆', failure: '✗' })[o]} ${this.esc(t('bench.outcome.' + o))}</span>`).join('');
        return `<div class="bench-legend">${legend}<span class="bench-key bench-key-score">${this.esc(t('bench.scoreKey'))}</span></div>
            <div class="bench-chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${this.esc(t('bench.chartLabel'))}">${body}</svg></div>`;
    }

    table(agg) {
        const pct = v => v == null ? '–' : Math.round(v * 100) + ' %';
        const ci = w => w.p == null ? '–' : `${pct(w.p)} <span class="bench-ci">[${pct(w.lo)}–${pct(w.hi)}]</span>`;
        const sc = s => s.mean == null ? '–' : `${s.mean.toFixed(2)} <span class="bench-ci">[${s.lo.toFixed(2)}–${s.hi.toFixed(2)}]</span>`;
        const graded = !!agg.all.graded;
        const row = (r, all) => `<tr class="${all ? 'bench-row-all' : ''}"><th scope="row">${this.esc(r.title)}</th><td>${r.n}</td>
            <td>${r.success}</td><td>${r.partial}</td>${graded ? `<td>${r.graded}</td>` : ''}<td>${r.failure}</td><td>${sc(r.score)}</td>
            <td>${r.graded === r.n ? '–' : ci(r.rate)}</td>
            <td>${r.ms == null ? '–' : (r.ms / 1000).toFixed(1) + ' s'}</td><td>${r.tokensPerRound == null ? '–' : Math.round(r.tokensPerRound)}</td>
            <td>${pct(r.refused)}</td><td>${r.rounds ? pct(r.unanswered / r.rounds) : '–'}</td><td>${r.stopped || 0}</td></tr>`;
        return `<div class="bench-table-wrap"><table class="bench-table">
            <thead><tr><th scope="col">${t('bench.col.scenario')}</th><th scope="col">${t('bench.col.runs')}</th>
                <th scope="col">✓ ${t('bench.outcome.success')}</th><th scope="col">◐ ${t('bench.outcome.partial')}</th>${graded ? `<th scope="col">◆ ${t('bench.outcome.graded')}</th>` : ''}<th scope="col">✗ ${t('bench.outcome.failure')}</th>
                <th scope="col">${t('bench.col.score')}</th><th scope="col">${t('bench.col.rate')}</th><th scope="col">${t('bench.col.answer')}</th>
                <th scope="col">${t('bench.col.tokens')}</th><th scope="col">${t('bench.col.refused')}</th><th scope="col">${t('bench.col.noAnswer')}</th><th scope="col">${t('bench.col.timeUp')}</th></tr></thead>
            <tbody>${row(agg.all, true)}${agg.rows.map(r => row(r, false)).join('')}</tbody></table></div>${this.gradedTable(agg)}`;
    }

    // How a graded scenario was played, part by part, and whether the thing was found --
    // which is luck, so it is shown beside the grade and never in it.
    gradedTable(agg) {
        const rows = agg.rows.filter(r => r.parts);
        if (!rows.length) return '';
        const names = [...new Set(rows.flatMap(r => Object.keys(r.parts)))];
        const label = k => { const key = 'bench.part.' + k; const v = t(key); return v === key ? k : v; };
        return `<h4>${t('bench.gradedTitle')}</h4>
            <div class="bench-table-wrap"><table class="bench-table">
            <thead><tr><th scope="col">${t('bench.col.scenario')}</th>${names.map(k => `<th scope="col">${this.esc(label(k))}</th>`).join('')}<th scope="col">${t('bench.col.found')}</th></tr></thead>
            <tbody>${rows.map(r => `<tr><th scope="row">${this.esc(r.title)}</th>${names.map(k => `<td>${r.parts[k] == null ? '–' : r.parts[k].toFixed(2)}</td>`).join('')}
                <td>${!r.found ? '–' : this.esc(r.found.k ? t('bench.foundCell', { k: r.found.k, n: r.found.n, r: r.found.round.toFixed(1) }) : t('bench.foundNone', { n: r.found.n }))}</td></tr>`).join('')}</tbody></table></div>
            <p class="arena-hint">${t('bench.gradedHint')}</p>`;
    }

    describeRun(s) {
        const bits = [new Date(s.at).toLocaleString(), t('bench.build', { b: s.build || '?' })];
        if (s.model && s.model.model) bits.push(s.model.model + (s.model.host ? ' @ ' + s.model.host : ''));
        if (s.prompt) bits.push(s.prompt === 'arena' ? t('bench.promptArenaShort') : s.promptVersion);
        const o = s.model && s.model.reqOpts;
        if (o && o.temperature != null) bits.push('T=' + o.temperature);
        if (o && o.reasoning) bits.push(t('bench.reasoning', { r: o.reasoning }));
        if (s.protocol && s.protocol.wallLimitMinutes) bits.push(t('bench.limitShort', { m: s.protocol.wallLimitMinutes }));
        return bits.map(b => this.esc(b)).join(' · ');
    }

    // Rounds the model never answered are the endpoint's story, not the model's play:
    // said first, with the reasons the seat counted.
    answerNote(episodes, agg) {
        if (!agg.all.unanswered) return null;
        const sum = k => episodes.reduce((a, e) => a + ((e.seat && e.seat[k]) || 0), 0);
        return t('bench.noAnswerNote', { n: agg.all.unanswered, of: agg.all.rounds, net: sum('networkErrors'), slow: sum('timeouts'),
            bad: sum('parseFails') + sum('noActionReturns') });
    }

    renderResults(s) {
        this._view = 'results';
        const agg = this.aggregate(s.episodes);
        const notes = [];
        if (!s.complete) notes.push(t(s.problem ? 'bench.brokeOff' : 'bench.stoppedEarly', { n: s.episodes.length, of: s.planned, e: s.problem || '' }));
        if (s.episodes.length && s.kept === false) notes.push(t('bench.notKept'));
        const silent = this.answerNote(s.episodes, agg);
        if (silent) notes.unshift(silent);
        this.el('benchBody').innerHTML = `
            <section class="arena-section bench-results">
                <h3>${this.esc(t('bench.resultsFor', { model: s.label }))}</h3>
                <p class="bench-run-meta">${this.describeRun(s)}</p>
                ${notes.map(n => `<p class="bench-note">${this.esc(n)}</p>`).join('')}
                ${s.episodes.length ? this.chart(agg) + this.table(agg) + `<p class="arena-hint">${t('bench.readHint', { cap: Math.round(WarBench.PARTIAL_CAP * 100) })}</p>` : ''}
            </section>
            <div class="arena-setup-buttons">
                ${s.episodes.length ? `<button class="menu-btn" onclick="game.ui.benchPage().saveSummary()">${t('bench.saveResults')}</button>
                <button class="menu-btn back-btn" onclick="game.ui.benchPage().saveBundle()" title="${this.esc(t('bench.saveBundleTip'))}">${t('bench.saveBundle')}</button>` : ''}
                ${this.countFor(s.modelKey) ? `<button class="menu-btn back-btn" onclick="game.ui.benchPage().renderHistory('${this.esc(s.modelKey)}')">${this.esc(t('bench.openHistory', { n: this.countFor(s.modelKey) }))}</button>` : ''}
                <button class="menu-btn back-btn" onclick="game.ui.benchPage().renderSetup()">${t('bench.newRun')}</button>
                <button class="menu-btn back-btn" onclick="game.ui.benchPage().close()">${t('common.back')}</button>
            </div>`;
    }

    // Everything a model has run here, added up per scenario, with the runs it is made of.
    renderHistory(key) {
        this._view = 'history'; this._historyKey = key;
        const runs = this.runsFor(key);
        const label = this.modelLabel(key) || (runs[0] && runs[0].label) || key;
        const episodes = runs.flatMap(r => r.episodes);
        const agg = this.aggregate(episodes);
        const builds = new Set(runs.map(r => r.coreHash || r.build)), configs = new Set(runs.map(r => JSON.stringify([r.model, r.prompt, r.promptVersion])));
        const mixed = [];
        const silent = this.answerNote(episodes, agg);
        if (silent) mixed.push(silent);
        if (builds.size > 1) mixed.push(t('bench.mixedBuilds', { n: builds.size }));
        if (configs.size > 1) mixed.push(t('bench.mixedSettings', { n: configs.size }));
        const list = runs.slice().reverse().map(r => {
            const a = this.aggregate(r.episodes).all;
            return `<tr><td>${this.describeRun(r)}</td><td>${r.episodes.length}${r.complete ? '' : ' / ' + r.planned}</td>
                <td>${a.score.mean == null ? '–' : a.score.mean.toFixed(2)}</td>
                <td><button class="hr-del" onclick="game.ui.benchPage().deleteRun('${this.esc(r.id)}','${this.esc(key)}')" title="${this.esc(t('bench.deleteRun'))}" aria-label="${this.esc(t('bench.deleteRun'))}">✕</button></td></tr>`;
        }).join('');
        this.el('benchBody').innerHTML = `
            <section class="arena-section bench-results">
                <h3>${this.esc(t('bench.historyFor', { model: label }))}</h3>
                ${runs.length ? `<p class="bench-run-meta">${this.esc(t('bench.historyLine', { runs: runs.length, eps: episodes.length }))}</p>
                ${mixed.map(m => `<p class="bench-note">${this.esc(m)}</p>`).join('')}
                ${this.chart(agg)}${this.table(agg)}
                <p class="arena-hint">${t('bench.readHint', { cap: Math.round(WarBench.PARTIAL_CAP * 100) })}</p>
                <h4>${t('bench.runsList')}</h4>
                <div class="bench-table-wrap"><table class="bench-table bench-runs"><thead><tr><th scope="col">${t('bench.col.run')}</th><th scope="col">${t('bench.col.episodes')}</th><th scope="col">${t('bench.col.score')}</th><th scope="col"></th></tr></thead><tbody>${list}</tbody></table></div>`
                : `<p class="lib-empty">${t('bench.noRuns')}</p>`}
            </section>
            <div class="arena-setup-buttons">
                ${runs.length ? `<button class="menu-btn" onclick="game.ui.benchPage().exportRuns('${this.esc(key)}')">${t('bench.saveResults')}</button>` : ''}
                <button class="menu-btn back-btn" onclick="game.ui.benchPage().renderSetup()">${t('bench.newRun')}</button>
                <button class="menu-btn back-btn" onclick="game.ui.benchPage().close()">${t('common.back')}</button>
            </div>`;
    }
    deleteRun(id, key) {
        if (!confirm(t('bench.deleteConfirm'))) return;
        this.saveRuns(this.loadRuns().filter(r => r.id !== id));
        this.renderHistory(key);
        if (this.ui.renderArenaLibrary && document.getElementById('modelLibraryList')) this.ui.renderArenaLibrary();
    }

    // ---- Files ------------------------------------------------------------------
    download(name, blob) {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = name;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    }
    stamp() { return new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-'); }
    slug(s) { return String(s || 'model').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'model'; }
    resultsFile(runs) { return new Blob([JSON.stringify({ schema: BenchPage.RESULTS_SCHEMA, exported: new Date().toISOString(), runs }, null, 1)], { type: 'application/json' }); }
    saveSummary() { if (this.last) this.download(`warbench-${this.slug(this.last.summary.label)}-${this.stamp()}.json`, this.resultsFile([this.last.summary])); }
    exportRuns(key) { const runs = this.runsFor(key); if (runs.length) this.download(`warbench-${this.slug(runs[0].label)}-all-${this.stamp()}.json`, this.resultsFile(runs)); }
    exportAll() {
        const runs = this.loadRuns();
        if (!runs.length) { this.el('benchSetupError').textContent = t('bench.noRunsAtAll'); return; }
        this.download(`warbench-results-${this.stamp()}.json`, this.resultsFile(runs));
    }
    // The whole run, replayable: gzipped where the browser can, plain JSON lines where
    // it cannot (war-bench reads both).
    async saveBundle() {
        if (!this.last || !this.last.lines) return;
        const text = this.last.lines.join('\n') + '\n';
        const base = `warbench-${this.slug(this.last.summary.label)}-${this.stamp()}.warbench.jsonl`;
        if (typeof CompressionStream === 'function') {
            const gz = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
            this.download(base + '.gz', await new Response(gz).blob());
        } else this.download(base, new Blob([text], { type: 'application/x-ndjson' }));
    }
    importFile() {
        const input = document.createElement('input');
        input.type = 'file'; input.accept = '.json,application/json';
        input.onchange = async () => {
            const f = input.files && input.files[0];
            if (!f) return;
            try {
                const data = JSON.parse(await f.text());
                if (!data || data.schema !== BenchPage.RESULTS_SCHEMA || !Array.isArray(data.runs)) throw new Error(t('bench.importWrong'));
                const runs = this.loadRuns(), have = new Set(runs.map(r => r.id));
                const fresh = data.runs.filter(r => r && r.id && Array.isArray(r.episodes) && !have.has(r.id));
                if (!this.saveRuns(runs.concat(fresh))) throw new Error(t('bench.notKept'));
                this.renderSetup();
                this.el('benchSetupError').textContent = t('bench.imported', { n: fresh.length, skipped: data.runs.length - fresh.length });
            } catch (e) { this.el('benchSetupError').textContent = e.message || String(e); }
        };
        input.click();
    }
}
