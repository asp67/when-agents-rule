// The Agent Arena's screens (docs/MCP-ARENA.md): the model library's MCP entry, and the
// arena setup's readiness dots with the start gate. Methods of UIManager, kept in their
// own file so the feature can be read in one place; ui.js only calls into them.
//
// An MCP entry is a seat an agent harness plays over the local WAR MCP hub
// (tools/mcp/war-mcp-hub.cjs) on its own subscription. The entry hands the user three
// things: how to start the hub, how to connect their harness (or a prompt that lets the
// harness do it itself), and how to start playing.
(function () {
    if (typeof UIManager !== 'function') return;
    const HUB_DEFAULT = 'http://127.0.0.1:8765';
    const ROUND_SEC = 180;   // asp67, 26 Oct: the longest turn that still makes sense; to be measured

    // The harnesses with a known way in. `prompts`: it shows MCP prompts as commands.
    const HARNESSES = [
        { id: 'claude-code', name: 'Claude Code', prompts: true },
        { id: 'chatgpt', name: 'ChatGPT' },
        { id: 'codex', name: 'Codex CLI' },
        { id: 'antigravity', name: 'Google Antigravity' },
        { id: 'zcode', name: 'ZCode' },
        { id: 'dsh', name: 'DeepSeek Harness' },
        { id: 'hermes', name: 'Hermes Agent' },
        { id: 'openclaw', name: 'OpenClaw' },
        { id: 'opencode', name: 'OpenCode' },
        { id: 'other', name: null }
    ];

    Object.assign(UIManager.prototype, {
        mcpHarnesses() { return HARNESSES; },
        mcpHarnessName(id) { const h = HARNESSES.find(x => x.id === id); return h && h.name ? h.name : t('mcp.otherHarness'); },
        mcpServerName(m) { return 'war_seat_' + m.id; },
        mcpHub(m) { return String((m && m.endpoint) || HUB_DEFAULT).trim().replace(/\/+$/, '') || HUB_DEFAULT; },
        mcpSeatUrl(m) { return this.mcpHub(m) + '/mcp/' + m.mcpToken; },
        mcpNewToken() {
            const a = new Uint8Array(15);
            (window.crypto || crypto).getRandomValues(a);
            return 'seat-' + [...a].map(b => 'abcdefghijkmnpqrstuvwxyz23456789'[b & 31]).join('');
        },
        // The hub's two files as this page serves them: the public site, or a local server.
        mcpFilesBase() {
            try { return new URL('tools/mcp/', location.href).href; } catch (e) { return 'https://asp67.github.io/when-agents-rule/tools/mcp/'; }
        },

        // Called by setModelProvider before the provider changes.
        mcpProviderSwitched(m, value) {
            if (value === 'mcp') {
                if (m.provider !== 'mcp') m._endpointBefore = m.endpoint;
                m.endpoint = HUB_DEFAULT;
                if (!m.mcpToken) m.mcpToken = this.mcpNewToken();
                if (!m.harness) m.harness = 'claude-code';
                m._expanded = true;
            } else if (m.provider === 'mcp') {
                m.endpoint = m._endpointBefore || '';
                delete m._endpointBefore;
            }
        },
        mcpSetField(id, field, value) {
            const m = this.getArenaModel(id);
            if (!m) return;
            m[field] = value;
            this.saveArenaConfig();
            if (field === 'harness' || field === 'endpoint') this.renderArenaLibrary();
        },
        mcpRenewToken(id) {
            const m = this.getArenaModel(id);
            if (!m) return;
            m.mcpToken = this.mcpNewToken();
            this.saveArenaConfig();
            this.renderArenaLibrary();
        },
        mcpSetShell(shell) { this._mcpShell = shell; try { localStorage.setItem('war.mcpShell', shell); } catch (e) { /* private window */ } this.renderArenaLibrary(); },
        mcpShell() {
            if (this._mcpShell) return this._mcpShell;
            let s = null; try { s = localStorage.getItem('war.mcpShell'); } catch (e) { /* private window */ }
            return s || (/Win/.test(navigator.platform || '') ? 'ps' : 'sh');
        },

        // Step 1: fetch the hub's two files and start it. Node 18 or newer.
        mcpStartCommand(shell) {
            const base = this.mcpFilesBase();
            if (shell === 'ps') return [
                'New-Item -ItemType Directory -Force "$HOME\\war-mcp" | Out-Null; Set-Location "$HOME\\war-mcp"',
                `Invoke-WebRequest "${base}war-mcp-hub.cjs" -OutFile war-mcp-hub.cjs`,
                `Invoke-WebRequest "${base}war-tools.json" -OutFile war-tools.json`,
                'node war-mcp-hub.cjs'].join('\n');
            return [
                'mkdir -p ~/war-mcp && cd ~/war-mcp',
                `curl -fsSLO "${base}war-mcp-hub.cjs"`,
                `curl -fsSLO "${base}war-tools.json"`,
                'node war-mcp-hub.cjs'].join('\n');
        },
        // Step 2: the harness's own way to add the server. `how` is a translated line.
        mcpConnect(m) {
            const name = this.mcpServerName(m), url = this.mcpSeatUrl(m);
            const C = {
                'claude-code': `claude mcp add --transport http ${name} ${url}`,
                chatgpt: `Name: ${name}\nType: Streamable HTTP\nURL: ${url}`,
                codex: `[mcp_servers.${name}]\nurl = "${url}"`,
                antigravity: `"${name}": { "serverUrl": "${url}" }`,
                zcode: `"mcp": { "servers": { "${name}": { "type": "http", "url": "${url}", "enabled": true } } }`,
                dsh: `- insert:\n    - id: ${name.replace(/_/g, '-')}\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: ${name}\n        transport: streamable-http\n        url: ${url}`,
                hermes: `hermes mcp add ${name} --url ${url}`,
                openclaw: `Name: ${name}\nTransport: streamable-http\nURL: ${url}`,
                opencode: `"mcp": { "${name}": { "type": "remote", "url": "${url}", "enabled": true } }`,
                other: `Name: ${name}\nType: Streamable HTTP\nURL: ${url}\n\nstdio instead: node war-mcp-hub.cjs --stdio --token ${m.mcpToken}`
            };
            const id = C[m.harness] ? m.harness : 'other';
            return { how: t('mcp.h.' + id), code: C[id] };
        },
        // Step 2, the other way: the harness adds the server itself.
        mcpSelfSetup(m) {
            return `Please add an MCP server to your own configuration so that you can use its tools:\n`
                + `- name: ${this.mcpServerName(m)}\n- transport: Streamable HTTP (remote)\n- URL: ${this.mcpSeatUrl(m)}\n`
                + `Allow all of its tools without asking me each time. Then check that its tools appear `
                + `(join, wait_for_turn, end_turn, train_unit, ...), and tell me whether I need to reload or restart you.`;
        },
        // Step 3: what starts the harness playing.
        mcpKickoff(m) {
            const n = this.mcpServerName(m);
            return `You are playing a seat in the strategy game WAR through the MCP server ${n}. You decide every move yourself.
`
                + `First call its join tool. Then play this loop until wait_for_turn reports that the match is over:
`
                + `1. Call wait_for_turn. When it is your turn it returns the game state (the first time also the rules). While it answers "waiting", call it again at once.
`
                + `2. Give up to 3 game commands with its game tools (train_unit, build_structure, assign_workers, move_units, attack_target, ...). The plan tool is free.
`
                + `3. Call end_turn. Then go back to step 1.
`
                + `Do not stop to explain or to ask me anything: keep calling the tools until the match is over.`;
        },
        mcpStartLine(m) {
            const h = HARNESSES.find(x => x.id === m.harness);
            return h && h.prompts ? `/mcp__${this.mcpServerName(m)}__play` : this.mcpKickoff(m);
        },

        // Copy buttons: the text lives here, not in the markup, so nothing needs escaping twice.
        mcpCopyBtn(text) {
            const k = (this._mcpCopyN = (this._mcpCopyN || 0) + 1);
            (this._mcpCopy || (this._mcpCopy = new Map())).set(k, text);
            return `<button type="button" class="mcp-copy" onclick="game.ui.mcpCopy(${k}, this)">⧉ ${t('mcp.copy')}</button>`;
        },
        mcpCopy(k, btn) {
            const text = this._mcpCopy && this._mcpCopy.get(k);
            if (text == null) return;
            const done = () => { if (btn) { btn.textContent = '✓ ' + t('mcp.copied'); btn.classList.add('done'); setTimeout(() => { btn.textContent = '⧉ ' + t('mcp.copy'); btn.classList.remove('done'); }, 1500); } };
            if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, () => this.mcpCopyFallback(text, done));
            else this.mcpCopyFallback(text, done);
        },
        mcpCopyFallback(text, done) {
            const ta = document.createElement('textarea');
            ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
            document.body.appendChild(ta); ta.select();
            try { document.execCommand('copy'); done(); } catch (e) { /* the user copies by hand */ }
            ta.remove();
        },
        mcpCode(text) {
            const e = s => this.escapeHtml(String(s));
            return `<div class="mcp-code"><pre>${e(text)}</pre>${this.mcpCopyBtn(text)}</div>`;
        },

        async mcpCheckHub(id) {
            const m = this.getArenaModel(id);
            if (!m) return;
            const el = document.getElementById('mcpHubStatus-' + id);
            const show = (cls, text) => { if (el) { el.className = 'test-status ' + cls; el.textContent = text; } };
            show('pending', t('mcp.hubChecking'));
            try {
                const r = await fetch(this.mcpHub(m) + '/status', { cache: 'no-store' });
                const s = await r.json();
                show('ok', t('mcp.hubOk', { v: s.version || '?' }));
                if (typeof WarMcpLink === 'function') WarMcpLink.shared(this.mcpHub(m));
            } catch (e) {
                show('err', t('mcp.hubDown', { url: this.mcpHub(m) }));
            }
        },

        // The library card of an MCP entry: its own body, the same header as every card.
        renderMcpCard(m, n) {
            const e = s => this.escapeHtml(s == null ? '' : String(s));
            const expanded = !!m._expanded;
            const shell = this.mcpShell();
            const conn = this.mcpConnect(m);
            const harnessOpts = HARNESSES.map(h => `<option value="${h.id}" ${m.harness === h.id ? 'selected' : ''}>${e(h.name || t('mcp.otherHarness'))}</option>`).join('');
            const tab = (v, label) => `<button type="button" class="mcp-shell ${shell === v ? 'on' : ''}" onclick="game.ui.mcpSetShell('${v}')">${label}</button>`;
            return `
        <div class="model-card mcp-card ${expanded ? 'expanded' : 'collapsed'}">
            <div class="model-card-header">
                <button type="button" class="model-card-toggle" id="modelToggle-${m.id}"
                    aria-expanded="${expanded}" aria-controls="modelBody-${m.id}"
                    onclick="game.ui.toggleArenaModel(${m.id})">
                <span class="mc-toggle">▶</span>
                <span class="mc-name">${e(this.modelDisplayName(m, n))}</span>
                <span class="mc-sub">${e(this.mcpHarnessName(m.harness))}${m.model ? ' · ' + e(m.model) : ''}</span>
                <span class="mc-auth">MCP</span>
                </button>
                <button class="model-remove" title="${t('ar.removeModel')}" onclick="event.stopPropagation(); game.ui.removeArenaModel(${m.id})">✕</button>
            </div>
            <div class="model-card-body" id="modelBody-${m.id}">
            <section class="model-section">
            <h3>${t('mcp.title')}</h3>
            <p class="arena-hint">${e(t('mcp.intro'))}</p>
            <div class="model-card-top">
                <div class="arena-field"><label>${t('ar.fName')}</label>
                    <input type="text" value="${e(m.name)}" oninput="game.ui.setModelField(${m.id},'name',this.value)" placeholder="${e(this.mcpHarnessName(m.harness))}"></div>
                <div class="arena-field"><label>${t('ar.fProvider')}</label>
                    <select onchange="game.ui.setModelProvider(${m.id}, this.value)">${this.providerOptionsHtml(m)}</select></div>
            </div>
            <div class="model-card-top">
                <div class="arena-field"><label>${t('mcp.fHarness')}</label>
                    <select onchange="game.ui.mcpSetField(${m.id},'harness',this.value)">${harnessOpts}</select></div>
                <div class="arena-field" style="flex:2"><label>${t('mcp.fModel')}</label>
                    <input type="text" value="${e(m.model)}" oninput="game.ui.mcpSetField(${m.id},'model',this.value)" placeholder="${e(t('mcp.fModelPh'))}"></div>
            </div>
            <div class="model-card-top">
                <div class="arena-field"><label>${t('mcp.fHub')}</label>
                    <input type="text" value="${e(this.mcpHub(m))}" onchange="game.ui.mcpSetField(${m.id},'endpoint',this.value)"></div>
                <div class="arena-field" style="flex:2"><label>${t('mcp.fSeat')}</label>
                    <div class="mcp-seat-url"><code>${e(this.mcpSeatUrl(m))}</code>
                    <button type="button" class="hdr-add-btn" title="${e(t('mcp.newTokenTip'))}" onclick="game.ui.mcpRenewToken(${m.id})">${t('mcp.newToken')}</button></div></div>
            </div>
            </section>
            <section class="model-section">
            <h3>${t('mcp.step1')}</h3>
            <p class="arena-hint">${e(t('mcp.step1Hint'))}</p>
            <div class="mcp-shells">${tab('ps', 'PowerShell')}${tab('sh', 'bash')}</div>
            ${this.mcpCode(this.mcpStartCommand(shell))}
            <p class="arena-hint">${e(t('mcp.chromeNote'))}</p>
            <div class="model-test-row">
                <button class="test-btn" onclick="game.ui.mcpCheckHub(${m.id})">${t('mcp.checkHub')}</button>
                <span class="test-status" id="mcpHubStatus-${m.id}"></span>
            </div>
            </section>
            <section class="model-section">
            <h3>${t('mcp.step2')}</h3>
            <p class="arena-hint">${e(conn.how)}</p>
            ${this.mcpCode(conn.code)}
            <p class="arena-hint">${e(t('mcp.step2Self'))}</p>
            ${this.mcpCode(this.mcpSelfSetup(m))}
            </section>
            <section class="model-section">
            <h3>${t('mcp.step3')}</h3>
            <p class="arena-hint">${e(t('mcp.step3Hint'))}</p>
            ${this.mcpCode(this.mcpStartLine(m))}
            </section>
            </div>
        </div>`;
        },

        // ---- the arena setup: one readiness dot per seat, and the start gate ----------
        // grey: not checked yet; yellow: checking / harness connecting; green: ready; red: not.
        seatReadiness(slot) {
            if (!slot || slot.control === 'ki') return { cls: 'ok', text: t('seat.ready') };
            const m = (this._arenaConfig.models || []).find(x => x.id === slot.control);
            if (!m) return { cls: 'err', text: t('seat.noModel') };
            if (m.provider === 'mcp') {
                if (typeof WarMcpLink !== 'function' || !m.mcpToken) return { cls: 'err', text: t('seat.hubDown') };
                const st = WarMcpLink.shared(this.mcpHub(m)).status(m.mcpToken);
                if (!st.hub) return { cls: 'err', text: t('seat.hubDown') };
                if (st.joined) return { cls: 'ok', text: t('seat.ready') };
                if (st.harness) return { cls: 'pending', text: t('seat.harnessIn') };
                return { cls: 'err', text: t('seat.waitHarness') };
            }
            const c = this._seatChecks && this._seatChecks.get(this.seatCheckKey(m));
            if (!c) return { cls: 'idle', text: t('seat.unchecked') };
            if (c.state === 'checking') return { cls: 'pending', text: t('seat.checking') };
            return c.ok ? { cls: 'ok', text: t('seat.ready') } : { cls: 'err', text: c.word || t('seat.failed'), title: c.text };
        },
        // A check belongs to the connection it ran against: change the model or address,
        // and the seat is unchecked again.
        seatCheckKey(m) { return [m.id, m.endpoint, m.model, m.provider].join('|'); },
        seatReadyHtml(slot, i) {
            const r = this.seatReadiness(slot);
            const e = s => this.escapeHtml(String(s == null ? '' : s));
            const retry = r.cls === 'err' && slot.control !== 'ki' ? ` onclick="event.stopPropagation(); game.ui.retrySeatCheck(${i})"` : '';
            return `<span class="seat-ready ${r.cls}" id="seatReady${i}" title="${e(r.title || r.text)}"${retry}><span class="seat-dot"></span><span class="seat-word">${e(r.text)}</span></span>`;
        },
        retrySeatCheck(i) {
            const slot = this.setupSlots()[i];
            const m = slot && (this._arenaConfig.models || []).find(x => x.id === slot.control);
            if (!m) return;
            if (m.provider === 'mcp') { WarMcpLink.shared(this.mcpHub(m)).connect(); return this.refreshSeatDots(); }
            if (this._seatChecks) this._seatChecks.delete(this.seatCheckKey(m));
            this.refreshSeatReadiness();
        },
        // Runs after the seats are drawn: start the checks still missing, list the MCP
        // seats with their hub, and keep the dots and the start button current.
        refreshSeatReadiness() {
            if (this._setupMode === 'campaign') return;
            const slots = this.setupSlots().slice(0, this.setupSlotCount());
            const models = this._arenaConfig.models || [];
            this._seatChecks = this._seatChecks || new Map();
            const hubs = new Map();
            slots.forEach((slot, i) => {
                const m = slot.control !== 'ki' && models.find(x => x.id === slot.control);
                if (!m) return;
                if (m.provider === 'mcp') {
                    if (!m.mcpToken) return;
                    const hub = this.mcpHub(m);
                    if (!hubs.has(hub)) hubs.set(hub, []);
                    hubs.get(hub).push({ token: m.mcpToken, seat: i + 1, name: m.name || this.mcpHarnessName(m.harness) });
                    return;
                }
                const key = this.seatCheckKey(m);
                if (this._seatChecks.has(key)) return;
                const entry = this.slotToSetupEntry(slot);
                if (!entry.connection || !entry.connection.model) {
                    this._seatChecks.set(key, { state: 'done', ok: false, word: t('seat.noModel'), text: t(entry.connection ? 'ar.checkNeedsModel' : 'ar.checkNeedsEndpoint') });
                    return;
                }
                this._seatChecks.set(key, { state: 'checking' });
                OpenAIAIManager.checkToolCalling(entry.connection).then(r => {
                    const text = t('ar.check_' + r.code, { s: ((r.latencyMs || 0) / 1000).toFixed(1), tool: r.tool || '', status: r.status || '', detail: r.detail || '' });
                    this._seatChecks.set(key, { state: 'done', ok: !!r.ok, text });
                    m._check = { ok: r.ok, code: r.code, via: r.via || null, latencyMs: r.latencyMs, at: Date.now() };
                    this.refreshSeatDots();
                });
            });
            if (typeof WarMcpLink === 'function') {
                for (const [hub, seats] of hubs) {
                    const link = WarMcpLink.shared(hub);
                    link.setSeats(seats);
                    if (!link._uiWatch) link._uiWatch = link.onChange(() => this.refreshSeatDots());
                }
            }
            this.refreshSeatDots();
        },
        refreshSeatDots() {
            const slots = this.setupSlots().slice(0, this.setupSlotCount());
            slots.forEach((slot, i) => {
                const el = document.getElementById('seatReady' + i);
                if (el) el.outerHTML = this.seatReadyHtml(slot, i);
            });
            const btn = document.getElementById('setupStartBtn');
            if (btn && this._setupMode !== 'campaign') {
                const blocked = this.arenaStartBlocked();
                btn.classList.toggle('blocked', blocked.length > 0);
                btn.title = blocked.length ? t('ar.startBlocked', { seats: blocked.join(', ') }) : '';
            }
        },
        // The seats that are not green; the arena starts only when this is empty.
        arenaStartBlocked() {
            if (this._setupMode === 'campaign') return [];
            return this.setupSlots().slice(0, this.setupSlotCount())
                .map((slot, i) => this.seatReadiness(slot).cls === 'ok' ? null : t('ar.slot', { n: i + 1 }))
                .filter(Boolean);
        },
        // An MCP seat plays turn-based, with a 180 s round unless one was set.
        mcpEnsureTurnBased() {
            if (this._setupMode === 'campaign') return;
            const models = this._arenaConfig.models || [];
            const anyMcp = this.setupSlots().slice(0, this.setupSlotCount())
                .some(s => s.control !== 'ki' && (models.find(x => x.id === s.control) || {}).provider === 'mcp');
            if (!anyMcp) return;
            let changed = false;
            if (!this._arenaConfig.turnBased) { this._arenaConfig.turnBased = true; changed = true; }
            if (!(parseInt(this._arenaConfig.roundTimeoutSec, 10) > 0)) { this._arenaConfig.roundTimeoutSec = ROUND_SEC; changed = true; }
            if (changed) {
                this.saveSetup();
                this.renderSetupOptions();
                this.showInfoMessage(t('ar.mcpTurnBased', { s: this.roundTimeoutSeconds() }));
            }
        }
    });
})();
