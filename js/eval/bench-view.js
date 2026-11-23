// The Bench view (Scale v4): the evaluation profile as an informative, human-readable screen.
//
// Everything here is read from ledger.profile(), ledger.history(), and ledger.trace(),
// so live on-screen numbers and post-match exports agree to the decimal. Nothing is scored
// in the view layer: only layout, rolling rates, duration-invariant ratios, and card chrome.
(function () {
    if (typeof UIManager === 'undefined') return;
    const P = UIManager.prototype;
    const DIMS = WarEval.SCORED;
    const TREND_SEC = 600;
    const clock = sec => sec == null ? '–' : Math.floor(sec / 60) + ':' + String(Math.floor(sec) % 60).padStart(2, '0');
    const share = v => v == null ? '–' : (v * 100).toFixed(v > 0.9995 || v < 0.0005 ? 0 : 1) + ' %';
    const clamp100 = v => Math.max(0, Math.min(100, v));

    const rawOf = (key, s) => {
        const g = s.grounding || {}, m = s.macro || {}, sp = s.spatial || {}, ta = s.tactical || {}, st = s.strategy || {};
        if (key === 'grounding') return g.rated ? share(g.rate) + ' · ' + g.rated : '';
        if (key === 'macro') return m.score != null ? (m.bwUtil != null ? share(m.bwUtil) + ' bw · ' : '') + (m.passiveWaits || 0) + ' pw' : '';
        if (key === 'spatial') return sp.score != null ? (sp.maxExplored == null ? '–' : Math.round(sp.maxExplored) + '%') + ' · ' + (sp.discovered || 0) + '/' + (sp.opponents || 0) : '';
        if (key === 'tactical') {
            const thr = (ta.episodes || 0) + (ta.wonders || 0);
            if (!ta.battles && !thr) return '';
            const raids = thr ? (ta.atOnce != null ? (ta.atOnce + (ta.wonderAnswered || 0)) : '–') + '/' + thr : '0/0';
            return (ta.battles || 0) + '⚔ · ' + raids;
        }
        return st.samples ? (st.trajDom == null ? '–' : Math.round(st.trajDom)) + (st.rank != null ? ' · #' + st.rank : '') : '';
    };

    const COMPARE = { showMs: 9000, quietMs: 3000, handful: 5, samples: 60, driftMin: WarEval.DRIFT_MIN_DECISIONS || 16 };
    const chances = (key, s) => key === 'grounding' ? (s.grounding.rated || 0)
        : key === 'macro' ? (s.decisions || 0)
        : key === 'spatial' ? (s.decisions || 0)
        : key === 'tactical' ? (s.tactical.judged ? ((s.tactical.episodes || 0) + (s.tactical.wonders || 0) + (s.tactical.battles || 0)) : 0)
        : (s.strategy.samples || 0);

    P.benchOn = function () { return !!this.viewPreferences().bench; };
    P.toggleBenchView = function (on = !this.benchOn()) {
        this.viewPreferences().bench = !!on;
        this.saveViewPreferences();
        this.refreshBenchView();
        if (this.broadcastOn && this.broadcastOn() && this.renderBroadcast) this.renderBroadcast();
    };

    P.wireBenchKey = function () {
        if (this._benchKeyWired) return;
        this._benchKeyWired = true;
        document.addEventListener('keydown', e => {
            const key = String(e.key || '').toLowerCase();
            if ((key !== 'b' && key !== 'r' && key !== 'c' && key !== 'v' && key !== 'i') || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
            const el = e.target;
            if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
            if (!this.game.spectatorMode || !this.game.gameStarted) return;
            if (key === 'v') { if (!this.seatView) return; e.preventDefault(); this.toggleSeatView(); return; }
            if (key === 'i') { if (!this.toggleSecondCam) return; e.preventDefault(); this.toggleSecondCam(); return; }
            if (key === 'c' ? !(this.broadcastOn && this.broadcastOn()) : !document.getElementById(key === 'b' ? 'benchMatrix' : 'raceChart')) return;
            e.preventDefault();
            if (key === 'b') this.toggleBenchView(); else if (key === 'r') this.toggleRaceChart(); else this.toggleCompare();
        });
    };

    P.compareOn = function () { return !!this.viewPreferences().compare; };
    P.toggleCompare = function (on = !this.compareOn()) {
        this.viewPreferences().compare = !!on;
        this.saveViewPreferences();
        this._cmp = null;
        this.updateCompare();
        if (this.broadcastOn && this.broadcastOn() && this.renderBroadcast) this.renderBroadcast();
    };

    // Broadcast Lower-Third slides: the 5 Scale v4 pillars (when gated sample counts exist)
    // plus two analytical spotlights: Action Bandwidth & Long-Horizon Drift.
    P.compareList = function (profile) {
        const seats = profile ? profile.seats.filter(s => s.decisions > 0) : [];
        if (seats.length < 2) return [];
        const warmup = seats.some(s => s.warmup);
        const list = DIMS.filter(key => seats.every(s => s[key] && s[key].score != null && chances(key, s) >= (key === 'strategy' ? COMPARE.samples : COMPARE.handful)))
            .map(key => ({
                key, warmup,
                seats: seats.map(s => ({
                    id: s.id, seat: s.seat, civ: s.civ,
                    name: s.name || s.model || s.id,
                    score: s[key].score, raw: rawOf(key, s), n: chances(key, s)
                }))
            }));
        if (seats.every(s => s.macro && s.macro.batch && s.decisions >= COMPARE.handful)) {
            list.push({
                key: 'bandwidth', warmup,
                seats: seats.map(s => {
                    const m = s.macro;
                    const bw = m.bwUtil != null ? m.bwUtil * 100 : (m.score || 0);
                    const okD = m.okPerDecision == null ? '' : m.okPerDecision.toFixed(1) + ' ' + t('bench.unitOkDec');
                    const par = m.parallelRate == null ? '' : share(m.parallelRate) + ' ×2+';
                    const pw = (m.passiveWaits || 0) + ' ' + t('bench.unitPw');
                    return {
                        id: s.id, seat: s.seat, civ: s.civ,
                        name: s.name || s.model || s.id,
                        score: bw, disp: m.bwUtil != null ? Math.round(bw) + '%' : String(Math.round(bw)),
                        batch: m.batch,
                        n: s.decisions,
                        raw: [okD, par, pw].filter(Boolean).join(' · ')
                    };
                })
            });
        }
        if (seats.every(s => s.drift && s.drift.decisions >= COMPARE.driftMin)) {
            list.push({
                key: 'drift', warmup,
                seats: seats.map(s => {
                    const d = s.drift;
                    const pen = Math.max(0, d.errDeltaPp || 0) * 2 + Math.max(0, d.idleDeltaPp || 0) + Math.max(0, ((d.latencyRatio || 1) - 1) * 15);
                    const score = clamp100(Math.round(100 - pen));
                    const parts = [
                        d.errDeltaPp != null ? (d.errDeltaPp > 0 ? '+' : '') + d.errDeltaPp.toFixed(1) + 'pp ' + t('bench.unitErr') : '',
                        d.idleDeltaPp != null ? (d.idleDeltaPp > 0 ? '+' : '') + d.idleDeltaPp.toFixed(1) + 'pp ' + t('bench.unitIdle') : '',
                        d.latencyRatio != null ? d.latencyRatio.toFixed(2) + '×' : ''
                    ].filter(Boolean);
                    return {
                        id: s.id, seat: s.seat, civ: s.civ,
                        name: s.name || s.model || s.id,
                        n: d.decisions,
                        score, raw: parts.join(' · ')
                    };
                })
            });
        }
        return list;
    };

    P.compareHtml = function (item) {
        const esc = s => this.escapeHtml(String(s == null ? '' : s));
        const ink = s => this.legibleColor ? this.legibleColor(this.identityHex ? this.identityHex(s.id, s.civ, s.seat) : '#cccccc') : '#cccccc';
        const best = Math.max(...item.seats.map(s => s.score)), tie = item.seats.filter(s => s.score === best).length > 1;
        const allowLead = !item.warmup && !tie;
        const title = item.key === 'bandwidth' ? t('bench.b.batchDist')
            : item.key === 'drift' ? t('bench.b.driftTitle') : t('eval.' + item.key);
        return `<div class="bcmp-head"><b>${esc(title)}</b><span>${esc(t('bench.cmp.' + item.key))}</span>`
            + `<em>${esc(t(item.warmup ? 'bench.warmupShort' : 'eval.provisional'))}</em></div>`
            + '<div class="bcmp-rows">' + item.seats.map(s => `<div class="bcmp-seat${allowLead && s.score === best ? ' is-lead' : ''}" style="--civ:${esc(ink(s))}">`
                + `<span class="bcmp-name">${this.teamDotHtml ? this.teamDotHtml(s.seat, 10) : ''}${esc(s.name)}</span>`
                + `<span class="bcmp-val"><b>${esc(s.disp != null ? s.disp : Math.round(s.score))}</b>`
                + (s.batch ? batchBarHtml(s.batch, true) : `<i class="bcmp-bar"><u style="width:${Math.round(s.score)}%"></u></i>`)
                + `<small>${esc(s.raw) || '&nbsp;'}</small></span></div>`).join('') + '</div>';
    };

    P.updateCompare = function (now = Date.now()) {
        let el = document.getElementById('compareStrip');
        const on = this.compareOn() && !!this.broadcastOn && this.broadcastOn() && this.game.spectatorMode && this.game.gameStarted;
        if (!on) { if (el) el.remove(); this._cmp = null; return; }
        const st = this._cmp || (this._cmp = { key: null, since: 0, quietUntil: 0, html: null });
        if (this._chronicleTimer) st.quietUntil = now + COMPARE.quietMs;
        const ledger = this.benchLedger();
        const list = ledger ? this.compareList(ledger.profile()) : [];
        if (!list.length || now < st.quietUntil) { if (el) el.classList.remove('is-in'); st.since = 0; return; }
        if (!st.since || now - st.since >= COMPARE.showMs || !list.some(x => x.key === st.key)) {
            st.key = list[(list.findIndex(x => x.key === st.key) + 1) % list.length].key;
            st.since = now;
        }
        const html = this.compareHtml(list.find(x => x.key === st.key));
        if (!el) {
            el = document.createElement('div');
            el.id = 'compareStrip'; el.className = 'broadcast-compare';
            el.setAttribute('role', 'status');
            document.body.appendChild(el);
            st.html = null;
        }
        if (html !== st.html) { el.innerHTML = html; st.html = html; }
        el.classList.add('is-in');
    };

    P.benchPlace = function () {
        const body = document.body;
        if (!body || !body.style || !body.style.setProperty) return;
        body.classList.toggle('tv-open', !!this._transcriptFor);
        const anchor = document.getElementById(body.classList.contains('broadcast-mode') ? 'broadcastBoard' : 'spectatorHUD');
        const r = anchor && anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : null;
        const top = r && r.height ? Math.round(this.zoomedPx(r.bottom + 10)) + 'px' : '';
        if (top === this._benchTop) return;
        this._benchTop = top;
        if (top) body.style.setProperty('--bench-top', top); else body.style.removeProperty('--bench-top');
    };

    P.refreshBenchView = function () {
        this.wireBenchKey();
        const on = this.benchOn(), btn = document.getElementById('benchBtn');
        document.body.classList.toggle('bench-view', on);
        if (btn) { btn.classList.toggle('sb-on', on); btn.setAttribute('aria-pressed', on ? 'true' : 'false'); }
        const el = document.getElementById('benchMatrix');
        if (el) el.style.display = on ? '' : 'none';
        this._benchSig = null;
        this.updateBenchView();
    };

    P.benchInAnalyzer = function () {
        const el = typeof document !== 'undefined' ? document.getElementById('analyzeScreen') : null;
        return !!(el && el.classList && el.classList.contains('active'));
    };
    P.benchLedger = function () { return this.benchInAnalyzer() ? (this.analyzer && this.analyzer.ledger) || null : this.evalLedger(); };
    P.benchLinkKey = function () {
        if (this.benchInAnalyzer()) return 'sum.openAnalyzer';
        const sum = typeof document !== 'undefined' ? document.getElementById('arenaSummaryScreen') : null;
        if (!sum || !sum.classList || !sum.classList.contains('active') || sum.classList.contains('snapshot')) return 'bench.open';
        return this.summaryCanOpen() ? 'sum.openAnalyzer' : null;
    };

    P.openTranscriptTurn = function (playerId, turn) {
        if (turn == null) return;
        this._transcriptFor = playerId;
        this._tvWindowEnd = turn; this._tvPinned = turn; this._tvRendered = null;
        this.renderTranscriptViewer();
        this.updateSpectatorPlayerList();
        if (this.tvJumpTo) this.tvJumpTo(turn);
    };

    P.benchOpenTurn = function (playerId, turn) {
        if (turn == null) return;
        if (this._benchFull) this.toggleBenchFull(false);
        if (this.benchInAnalyzer()) {
            const led = this.benchLedger(), at = led && led.profile().seats.find(s => s.id === playerId);
            return at && at.seat != null ? this.anApplyMoment({ seat: at.seat + 1, turn }) : undefined;
        }
        const sum = document.getElementById('arenaSummaryScreen');
        if (!sum || !sum.classList.contains('active')) return this.openTranscriptTurn(playerId, turn);
        if (sum.classList.contains('snapshot')) { this.closeArenaSnapshot(); return this.openTranscriptTurn(playerId, turn); }
        const ledger = this.benchLedger(), seat = ledger && ledger.profile().seats.find(s => s.id === playerId);
        if (!seat || seat.seat == null || !this.summaryCanOpen()) return;
        return this.watchInAnalyzer().then(() => this.anApplyMoment({ seat: seat.seat + 1, turn }));
    };

    P.summaryCanOpen = function () {
        const rec = this.game.openAIAIManager && this.game.openAIAIManager.transcripts;
        return !!(rec && rec.hasData && rec.hasData());
    };

    P.updateSummaryProfile = function () {
        const el = document.getElementById('summaryProfile'), sum = document.getElementById('arenaSummaryScreen');
        if (!el || !sum) return;
        const ledger = this.benchLedger();
        const has = !!ledger && ledger.profile().seats.some(s => s.decisions > 0);
        el.style.display = has ? '' : 'none';
        if (!has) { if (el.innerHTML) el.innerHTML = ''; this._sumProfileSig = null; return; }
        const ev = this._benchEvidence, link = this.benchLinkKey();
        const sig = [ledger.lines + '.' + ledger.rev, typeof getUiLang === 'function' ? getUiLang() : '', ev ? ev.key + ev.id : '', link, this._shareAxis || ''].join(':');
        if (sig === this._sumProfileSig) return;
        this._sumProfileSig = sig;
        el.innerHTML = this.benchHtml(ledger, { link }).right
            + `<button type="button" class="summary-board-btn" onclick="game.ui.toggleBenchFull(true)">${this.escapeHtml(t('bench.b.fullBtn'))}</button>`
            + `<p class="summary-profile-note">${this.escapeHtml(t('sum.profileNote'))}</p>`
            + this.benchShareHtml(ledger);
    };

    P.benchShowEvidence = function (key, id) {
        const cur = this._benchEvidence;
        this._benchEvidence = cur && cur.key === key && cur.id === id ? null : { key, id };
        this._benchSig = null;
        this.updateBenchView();
        this.updateSummaryProfile();
    };

    P.updateBenchView = function () {
        const right = document.getElementById('benchMatrix'), full = document.getElementById('benchFull');
        const panels = !!(right && this.benchOn() && !this.benchInAnalyzer()), open = !!(full && this._benchFull);
        if (!panels && !open) {
            if (full && (full.innerHTML || full.style.display !== 'none')) { full.innerHTML = ''; full.style.display = 'none'; }
            return;
        }
        if (panels) this.benchPlace();
        const ledger = this.benchLedger(), link = this.benchLinkKey();
        const sig = [ledger ? ledger.lines + '.' + ledger.rev : -1, typeof getUiLang === 'function' ? getUiLang() : '', open, panels, link].join(':');
        if (sig === this._benchSig) return;
        this._benchSig = sig;
        const data = this.benchSeries(ledger);
        if (panels) right.innerHTML = this.benchMiniHtml(ledger, data);
        if (full) {
            const body = open && full.querySelector ? full.querySelector('.bf-body') : null, at = body ? body.scrollTop : 0;
            full.style.display = open ? '' : 'none';
            full.innerHTML = open ? this.benchFullHtml(ledger, data, link) : '';
            const again = at && full.querySelector ? full.querySelector('.bf-body') : null;
            if (again) again.scrollTop = at;
        }
        if (ledger && ledger._live && ledger._live.pending > 0 && !this._benchFill && typeof setTimeout === 'function') {
            this._benchFill = setTimeout(() => { this._benchFill = null; this._benchSig = null; this.updateBenchView(); }, 120);
        }
    };

    const PART_INK = { index: '#ddd3b4', grounding: '#4ecdc4', macro: '#60a5fa', spatial: '#a78bfa', tactical: '#f59e0b', strategy: '#ec4899' };
    const TRACE_KINDS = ['loop', 'awareness', 'constraint', 'passive', 'threat', 'refused'];
    const tokText = n => n == null ? '–' : n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(Math.round(n));
    const durText = ms => ms == null ? '–' : ms >= 60000 ? (ms / 60000).toFixed(1) + 'm' : ms >= 1000 ? (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + 's' : Math.round(ms) + 'ms';
    const ratio = v => v == null || !isFinite(v) ? '–' : v >= 100 ? String(Math.round(v)) : v >= 10 ? v.toFixed(1) : v.toFixed(2);
    const signedPp = v => v == null ? '–' : (v > 0 ? '+' : '') + v.toFixed(1) + ' pp';

    function batchBarHtml(batch, compact) {
        if (!batch || !batch.shares) return '';
        const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
        const tip = t('bench.batchTip', { c3: batch.three || 0, c2: batch.two || 0, c1: batch.one || 0, j0: batch.justified0 || 0, p0: batch.passive0 || 0 });
        const segs = [['c3', batch.shares.three], ['c2', batch.shares.two], ['c1', batch.shares.one], ['j0', batch.shares.justified0], ['p0', batch.shares.passive0]]
            .filter(([, v]) => v > 0)
            .map(([cls, v]) => `<i class="bb-batch-seg is-${cls}" style="width:${(v * 100).toFixed(1)}%"></i>`).join('');
        return `<span class="bb-batch${compact ? ' is-compact' : ''}" title="${esc(tip)}">${segs}</span>`;
    }

    const linesSvg = (lines, { w, h, end, min = 0, max, cls = '' }) => {
        const top = max != null ? max : Math.max(1, ...lines.map(l => Math.max(0, ...l.v.filter(v => v != null))));
        const x = t => end > 0 ? (t / end) * w : 0, y = v => h - 1 - ((Math.min(top, v) - min) / ((top - min) || 1)) * (h - 2);
        const path = l => {
            let d = '', pen = false;
            for (let i = 0; i < l.t.length; i++) {
                if (l.v[i] == null) { pen = false; continue; }
                d += (pen ? 'L' : 'M') + x(l.t[i]).toFixed(1) + ' ' + y(l.v[i]).toFixed(1);
                pen = true;
            }
            if (!d) return '';
            const dash = l.dash ? ` stroke-dasharray="${l.dash}"` : '';
            return `<path d="${d}" fill="none" stroke="${l.ink}" stroke-width="${l.width || 1.5}"${dash} vector-effect="non-scaling-stroke" stroke-linejoin="round"/>`;
        };
        return `<svg class="bg-chart ${cls}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">${lines.map(path).join('')}</svg>`;
    };

    const thin = (t, v, most) => {
        if (t.length <= most) return { t, v };
        const step = t.length / most, T = [], V = [];
        for (let i = 0; i < most; i++) { const k = Math.min(t.length - 1, Math.round(i * step)); T.push(t[k]); V.push(v[k]); }
        T.push(t[t.length - 1]); V.push(v[v.length - 1]);
        return { t: T, v: V };
    };

    // Rolling rate windows over the latest decisions: latency, tokens, and canonical refused % (over rated commands).
    const RATE_DECISIONS = 3;
    P.benchRates = function (sc) {
        const n = sc && sc.t ? sc.t.length : 0, out = { t: n ? sc.t : [], sec: [], tok: [], refused: [] };
        if (!n) return out;
        const tokens = i => (sc.promptTokens[i] || 0) + (sc.completionTokens[i] || 0);
        const bad = i => (sc.avoidable[i] || 0) + (sc.invalid[i] || 0);
        const ratedAt = i => (sc.rated && sc.rated[i] != null) ? sc.rated[i] : ((sc.ok[i] || 0) + bad(i));
        const reports = tokens(n - 1) > 0, judged = ratedAt(n - 1) > 0 || bad(n - 1) > 0;
        for (let i = 0; i < n; i++) {
            let j = i - 1;
            while (j >= 0 && sc.decisions[i] - sc.decisions[j] < RATE_DECISIONS) j--;
            const from = f => j >= 0 ? f(j) : 0;
            const decisions = sc.decisions[i] - from(k => sc.decisions[k]);
            const ratedWin = ratedAt(i) - from(ratedAt);
            out.sec.push(decisions > 0 ? (sc.thinkingMs[i] - from(k => sc.thinkingMs[k])) / decisions / 1000 : null);
            out.tok.push(decisions > 0 && reports ? (tokens(i) - from(tokens)) / decisions : null);
            out.refused.push(ratedWin > 0 && judged ? Math.min(100, 100 * (bad(i) - from(bad)) / ratedWin) : null);
        }
        return out;
    };

    P.benchSeries = function (ledger) {
        if (!ledger || typeof ledger.history !== 'function') return null;
        let h;
        if (ledger.results || typeof ledger.liveHistory !== 'function') {
            const key = ledger.lines + ':' + ledger.rev;
            if (!ledger._boardHistory || ledger._boardHistory.key !== key) ledger._boardHistory = { key, h: ledger.history() };
            h = ledger._boardHistory.h;
        } else h = ledger.liveHistory(WarEval.HISTORY_SEC, this._benchBudget == null ? 8 : this._benchBudget);
        const seats = {}, top = { sec: 0, tok: 0, refused: 0 };
        let end = h.samples.length ? h.samples[h.samples.length - 1].t : 0;
        for (const s of h.seats) {
            const score = WarEval.Ledger.series(h, s.id) || { t: [] }, rates = this.benchRates(score.t.length ? score : null);
            for (const k of ['sec', 'tok', 'refused']) for (const v of rates[k]) if (v != null && v > top[k]) top[k] = v;
            seats[s.id] = { score, rates };
        }
        return { end, seats, top };
    };

    // Duration-invariant cost & discipline figures per seat.
    P.benchCost = function (s) {
        const g = s.grounding || {}, e = s.efficiency || {}, tok = e.tokens;
        const tokens = tok ? tok.promptTotal + tok.completionTotal : null;
        const thinking = e.thinkingMsTotal > 0 ? e.thinkingMsTotal : (e.latencyMs && e.latencyMs.n ? (this._benchThinking && this._benchThinking[s.id]) : null);
        return {
            tokens,
            promptTokens: tok ? tok.promptTotal : null,
            completionTokens: tok ? tok.completionTotal : null,
            thinkingMs: thinking == null ? null : thinking,
            latMedian: e.latencyMs ? e.latencyMs.median : null,
            latP90: e.latencyMs ? e.latencyMs.p90 : null,
            tokPerDec: !tok ? null : (e.tokensPerDecision != null ? e.tokensPerDecision : (tokens && s.decisions ? tokens / s.decisions : null)),
            promptPerDec: !tok ? null : (e.promptPerDecision != null ? e.promptPerDecision : (s.decisions ? tok.promptTotal / s.decisions : null)),
            outPerDec: !tok ? null : (e.completionPerDecision != null ? e.completionPerDecision : (s.decisions ? tok.completionTotal / s.decisions : null)),
            outPerOk: !tok ? null : (e.outputPerValidOrder != null ? e.outputPerValidOrder : tok.completionPerOk),
            okPerMin: e.effectiveOrdersPerMin,
            scorePer10k: !tok ? null : e.scorePer10kTokPerDec,
            hallucinationRate: g.hallucinationRate,
            constraintRate: g.constraintRate,
            invalidRate: g.rated ? g.invalid / g.rated : null,
            refusedRate: g.rated ? g.avoidable / g.rated : null,
            recovery: g.recoveryRate != null ? g.recoveryRate : (g.repeatRate != null ? 1 - g.repeatRate : null),
            drift: s.drift || null,
            batch: (s.macro && s.macro.batch) || null,
            lost: (e.failedRequests || 0) + (e.cancelledRequests || 0) + (e.missedRounds || 0),
            failed: e.failedRequests || 0, cancelled: e.cancelledRequests || 0, missed: e.missedRounds || 0
        };
    };

    P.benchKeepThinking = function (data) {
        this._benchThinking = {};
        for (const id in data.seats) { const v = data.seats[id].score.thinkingMs; this._benchThinking[id] = v && v.length ? v[v.length - 1] : null; }
    };

    P.toggleBenchFull = function (on = !this._benchFull) {
        this._benchFull = !!on;
        this._benchSig = null;
        if (on && !this._benchFullKey && typeof document !== 'undefined' && document.addEventListener) {
            this._benchFullKey = e => { if (e.key === 'Escape' && this._benchFull) this.toggleBenchFull(false); };
            document.addEventListener('keydown', this._benchFullKey);
        }
        this.updateBenchView();
    };

    P.benchKindTag = function (s) {
        const esc = x => this.escapeHtml(String(x == null ? '' : x)), h = s.harness;
        if (!h || !h.known) return '';
        return h.external
            ? `<em class="bf-kind is-harness" title="${esc(t('bench.h.harnessTip'))}">${esc(t('bench.h.harness'))}${h.kind && h.kind !== 'other' ? ' · ' + esc(h.kind) : ''}</em>`
            : `<em class="bf-kind is-raw" title="${esc(t('bench.h.rawTip'))}">${esc(t('bench.h.raw'))}</em>`;
    };

    P.benchHelpText = function (s) {
        const h = s.harness;
        if (!h) return t('bench.h.notRecorded');
        const said = [];
        if (h.fromProse) said.push(t('bench.h.sProse', { n: h.fromProse }));
        if (h.recorded && h.adapted) said.push(t('bench.h.sAdapted', { n: h.adapted }));
        if (h.recorded && h.intervened) said.push(t('bench.h.sHuman', { n: h.intervened }));
        if (said.length) return said.join(', ');
        return h.recorded || h.byToolCall ? t('bench.h.none') : t('bench.h.notRecorded');
    };

    P.benchMarksHtml = function (s, tr, end, link) {
        const esc = x => this.escapeHtml(String(x == null ? '' : x));
        if (!tr || !tr.judged) return `<div class="bt-strip is-none" title="${esc(t('bench.t.unjudged'))}"></div>`;
        const order = m => String(m.action == null ? '?' : m.action).replace(/_/g, ' ') + (m.code ? ' · ' + m.code : '');
        const line = m => m.kind === 'threat' ? this.benchThreatLine(m.threat, s)
            : m.kind === 'loop' ? t(m.open ? 'bench.t.loopOpen' : 'bench.t.loopLine', { order: order(m), n: m.n, upTo: m.upTo })
            : m.kind === 'passive' ? (m.n >= WarEval.STALL_MIN
                ? t('bench.t.passiveStall', { n: m.n, upTo: m.upTo, open: m.openFronts || 1 })
                : t('bench.t.passiveLine', { open: m.openFronts || 1 }))
            : order(m) + (m.orders > 1 ? ' ×' + m.orders : '');
        const at = sec => end > 0 && sec != null ? Math.max(0, Math.min(100, 100 * sec / end)) : 0;
        return `<div class="bt-strip"${tr.marks.length ? '' : ` title="${esc(t('bench.t.none'))}"`}>` + tr.marks.map(m => {
            const left = at(m.sec);
            const width = (m.kind === 'loop' || (m.kind === 'passive' && m.upToSec != null)) ? Math.max(0, at(m.upToSec) - left) : 0;
            const open = m.turn == null || !link ? '' : ` onclick="event.stopPropagation(); game.ui.benchOpenTurn('${esc(s.id)}', ${Number(m.turn)})"`;
            return `<i class="is-${m.kind}" style="left:${left.toFixed(1)}%${width ? ';width:' + width.toFixed(1) + '%' : ''}"${open} title="#${m.turn} ${clock(m.sec)} · ${esc(t('bench.t.' + m.kind))}: ${esc(line(m))}"></i>`;
        }).join('') + '</div>';
    };

    P.benchBoardHtml = function (ledger, data, { mini = false, link = 'bench.open' } = {}) {
        const esc = x => this.escapeHtml(String(x == null ? '' : x));
        const profile = ledger ? ledger.profile() : null, seats = profile ? profile.seats.filter(s => s.decisions > 0) : [];
        if (!seats.length || !data) return `<p class="bench-none">${esc(t('bench.none'))}</p>`;
        this.benchKeepThinking(data);
        const ink = s => this.legibleColor ? this.legibleColor(this.identityHex ? this.identityHex(s.id, s.civ, s.seat) : '#cccccc') : '#cccccc';
        const dot = s => this.teamDotHtml ? this.teamDotHtml(s.seat, mini ? 9 : 12) : '';
        const name = s => s.name || s.model || s.id;
        const series = s => data.seats[s.id] || { score: { t: [] }, rates: { t: [], sec: [], tok: [], refused: [] } };
        const W = mini ? 100 : 320, most = mini ? 50 : 200;
        const cells = make => seats.map(s => `<div class="bb-col" style="--civ:${esc(ink(s))}">${make(s)}</div>`).join('');
        const row = (cls, label, make) => `<div class="bb-row ${cls}">${mini ? '' : `<div class="bb-lab">${label}</div>`}${cells(make)}</div>`;
        const band = key => `<div class="bb-sec">${esc(t(key))}</div>`;
        const head = row('bb-head', '', s => `${dot(s)}<span title="${esc(name(s) + (s.model && s.model !== s.name ? ' · ' + s.model : ''))}">${esc(name(s))}</span>${mini ? '' : this.benchKindTag(s)}`);
        const axis = (label = '') => mini ? '' : row('bb-axis', label, () => `<span>0:00</span><span>${clock(data.end)}</span>`);
        const anyWarmup = seats.some(s => s.warmup);
        const allowLead = !anyWarmup;

        // Live Mini Card: 2-line sparkline (WAR solid + Dom dashed), 5 vertical G/M/S/T/D equalizer bars, WAR + latency, batching bar
        if (mini) {
            const miniGraph = s => {
                const sc = series(s).score;
                return linesSvg([
                    Object.assign(thin(sc.t, sc.index || [], most), { ink: PART_INK.index, width: 1.7 }),
                    Object.assign(thin(sc.t, sc.strategy || [], most), { ink: PART_INK.strategy, width: 1.1, dash: '3,2' })
                ], { w: W, h: 36, end: data.end, max: 100, cls: 'bb-game' });
            };
            const eq = s => '<div class="bb-eq">' + DIMS.map(k => {
                const val = s[k] && s[k].score;
                const h = val == null ? 0 : Math.round(val);
                return `<span class="bb-eq-bar" title="${esc(t('eval.' + k) + ': ' + (val == null ? '–' : Math.round(val)))}">`
                    + `<b>${val == null ? '–' : Math.round(val)}</b>`
                    + `<i><u style="height:${h}%;background:${PART_INK[k]}"></u></i>`
                    + `<small>${esc(t('eval.glyph.' + k))}</small></span>`;
            }).join('') + '</div>';
            const miniFoot = s => {
                const c = this.benchCost(s), m = s.macro || {};
                const latText = c.latMedian == null ? '–' : durText(c.latMedian);
                const okD = m.okPerDecision == null ? '–' : m.okPerDecision.toFixed(1);
                const outOk = c.outPerOk == null ? '' : Math.round(c.outPerOk) + ' out/ok';
                const fullMeta = [okD + ' ok/d', outOk, latText].filter(Boolean).join(' · ');
                const shortMeta = seats.length > 2 ? (okD + '/d · ' + latText) : fullMeta;
                return `<div class="bb-mini-foot">${batchBarHtml(c.batch, true)}<span title="${esc(fullMeta)}">${esc(shortMeta)}</span></div>`;
            };
            return `<div class="bb is-mini" style="--n:${seats.length}" role="button" tabindex="0" title="${esc(t('bench.b.openTip'))}" onclick="game.ui.toggleBenchFull(true)">`
                + head
                + row('bb-graph', '', miniGraph)
                + row('bb-eqrow', '', eq)
                + row('bb-index', '', s => `<b>${s.index.value == null ? '–' : Math.round(s.index.value)}</b><small>${esc(t(s.warmup ? 'bench.early' : 'eval.indexShort'))}</small>`)
                + row('bb-footrow', '', miniFoot)
                + '</div>';
        }

        // Full Board: 5 pillars + dashed WAR Score
        const game = s => {
            const sc = series(s).score;
            const lines = DIMS.map(k => Object.assign(thin(sc.t, sc[k] || [], most), { ink: PART_INK[k], width: 1.6 }));
            lines.push(Object.assign(thin(sc.t, sc.index || [], most), { ink: PART_INK.index, width: 2.2, dash: '4,2' }));
            return linesSvg(lines, { w: W, h: 108, end: data.end, max: 100, cls: 'bb-game' });
        };
        const keys = '<span class="bb-keys">'
            + `<span><i style="background:${PART_INK.index}"></i>${esc(t('eval.index'))}</span>`
            + DIMS.map(k => `<span><i style="background:${PART_INK[k]}"></i>${esc(t('eval.' + k))}</span>`).join('') + '</span>';

        const now = a => { for (let i = a.length - 1; i >= 0; i--) if (a[i] != null) return a[i]; return null; };
        const round = x => { const p = Math.pow(10, Math.floor(Math.log10(x))), n = x / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p; };
        const RATES = [
            { key: 'sec', label: 'bench.b.secPer', ink: '#f2c46a', top: round(Math.max(1, data.top.sec)), text: v => v >= 10 ? Math.round(v) + ' s' : v.toFixed(1) + ' s' },
            { key: 'tok', label: 'bench.b.tokPer', ink: '#8fbdf0', top: round(Math.max(1, data.top.tok)), text: v => tokText(v) },
            { key: 'refused', label: 'bench.b.refusedNow', ink: '#ff8f7a', top: round(Math.max(10, data.top.refused)), text: v => Math.round(v) + ' %' }
        ];
        const rate = (r, s) => {
            const rt = series(s).rates, last = now(rt[r.key]);
            return linesSvg([Object.assign(thin(rt.t, rt[r.key], most), { ink: r.ink, width: 1.7 })], { w: W, h: 38, end: data.end, max: r.top, cls: 'bb-rate' })
                + `<b class="bb-now">${last == null ? esc(t(r.key === 'tok' ? 'bench.b.noUsage' : 'bench.h.notRecorded')) : esc(r.text(last))}</b>`;
        };

        const traces = {};
        for (const s of seats) traces[s.id] = typeof ledger.trace === 'function' ? ledger.trace(s.id) : null;
        const kinds = TRACE_KINDS.filter(k => seats.some(s => traces[s.id] && traces[s.id].counts[k]));
        const markTitle = `<b title="${esc(t('bench.t.tip'))}">${esc(t('bench.t.title'))}</b>`;
        const markKeys = '<span class="bb-keys bt-keys">' + kinds.map(k => `<span class="is-${k}" title="${esc(t('bench.t.' + k + 'Tip'))}"><i></i>${esc(t('bench.t.' + k))}</span>`).join('') + '</span>';

        const cost = {};
        for (const s of seats) cost[s.id] = this.benchCost(s);
        const pct = v => v == null ? '–' : share(v), num0 = v => v == null ? '–' : String(Math.round(v));
        const valWithRaw = (score, raw) => score == null ? '–' : (raw ? `${Math.round(score)} (${raw})` : String(Math.round(score)));

        const ROWS = [
            { label: t('eval.index'), val: s => s.index.value, text: (v, s) => v == null ? '–' : (v.toFixed ? v.toFixed(1) : String(v)) + (s.warmup ? ' · ' + t('bench.early') : ''), best: 1, cls: 'is-index', tip: s => this.evalTips(s).index },
            ...DIMS.map(k => ({ label: t('eval.' + k), ink: PART_INK[k], val: s => s[k] && s[k].score, text: (v, s) => valWithRaw(v, rawOf(k, s)), best: 1, tip: s => this.evalTips(s)[k] })),
            // Action Bandwidth & Initiative
            { label: t('bench.b.batchDist'), first: true, val: s => s.macro && s.macro.bwUtil, html: s => {
                const c = cost[s.id], m = s.macro || {};
                const okD = m.okPerDecision == null ? '–' : m.okPerDecision.toFixed(1) + ' ok/d';
                return batchBarHtml(c.batch, false) + `<small class="bb-sub">${esc(okD)}</small>`;
            }, tip: () => t('bench.b.batchDistTip') },
            { label: t('bench.b.parallel'), val: s => s.macro && s.macro.parallelRate, text: pct, best: 1, tip: () => t('bench.b.parallelTip') },
            { label: t('bench.b.passiveWaits'), val: s => s.macro && s.macro.passiveWaitRate, text: (v, s) => v == null ? '–' : `${share(v)} (${s.macro.passiveWaits}/${s.decisions})`, best: -1, tip: () => t('bench.b.passiveWaitsTip') },
            // Cognitive Cost (Duration-Invariant)
            { label: t('bench.b.latency'), first: true, val: s => cost[s.id].latMedian, text: (v, s) => { const c = cost[s.id]; return c.latMedian == null ? '–' : durText(c.latMedian) + (c.latP90 != null ? ' / ' + durText(c.latP90) : ''); }, best: -1, tip: () => t('bench.b.latencyTip') },
            { label: t('bench.b.tokPerDec'), val: s => cost[s.id].tokPerDec, text: (v, s) => { const c = cost[s.id]; return v == null ? t('bench.b.noUsage') : `${tokText(v)} (${tokText(c.promptPerDec)}·${tokText(c.outPerDec)})`; }, best: -1, tip: () => t('bench.b.tokPerDecTip') },
            { label: t('bench.b.outPerOk'), val: s => cost[s.id].outPerOk, text: ratio, best: -1, tip: () => t('bench.b.outPerOkTip') },
            { label: t('bench.b.okPerMin'), val: s => cost[s.id].okPerMin, text: ratio, best: 1, tip: () => t('bench.b.okPerMinTip') },
            { label: t('bench.b.scorePer10k'), val: s => cost[s.id].scorePer10k, text: ratio, best: 1, tip: () => t('bench.b.scorePer10kTip') },
            // Long-Horizon Drift
            { label: t('bench.b.errDrift'), first: true, val: s => { const d = cost[s.id].drift; return d ? d.errDeltaPp : null; }, text: (v, s) => cost[s.id].drift ? signedPp(v) : t('bench.b.noDrift'), best: -1, tip: () => t('bench.b.errDriftTip') },
            { label: t('bench.b.idleDrift'), val: s => { const d = cost[s.id].drift; return d ? d.idleDeltaPp : null; }, text: (v, s) => cost[s.id].drift ? signedPp(v) : t('bench.b.noDrift'), best: -1, tip: () => t('bench.b.idleDriftTip') },
            { label: t('bench.b.latRatio'), val: s => { const d = cost[s.id].drift; return d ? d.latencyRatio : null; }, text: (v, s) => !cost[s.id].drift ? t('bench.b.noDrift') : v == null ? '–' : v.toFixed(2) + '×', best: -1, tip: () => t('bench.b.latRatioTip') },
            // Discipline & Harness
            { label: t('bench.b.hallucinations'), first: true, val: s => cost[s.id].hallucinationRate, text: pct, best: -1, tip: () => t('bench.b.hallucinationsTip') },
            { label: t('bench.b.constraints'), val: s => cost[s.id].constraintRate, text: pct, best: -1, tip: () => t('bench.b.constraintsTip') },
            { label: t('bench.b.recovery'), val: s => cost[s.id].recovery, text: pct, best: 1, tip: () => t('bench.b.recoveryTip') },
            { label: t('bench.t.loops'), val: s => traces[s.id] && traces[s.id].judged ? traces[s.id].counts.loop : null, text: num0, best: -1, tip: () => t('bench.t.loopTip') },
            { label: t('bench.b.lost'), val: s => cost[s.id].lost, text: num0, best: -1, tip: s => t('bench.b.lostTip', { failed: cost[s.id].failed, cancelled: cost[s.id].cancelled, missed: cost[s.id].missed }) },
            { label: t('bench.h.help'), first: true, val: () => null, text: null, words: s => this.benchHelpText(s), tip: () => t('bench.h.helpTip') }
        ];

        const table = ROWS.map(r => {
            const vals = seats.map(r.val).filter(v => v != null && isFinite(v));
            const lead = allowLead && r.best && vals.length > 1 && Math.max(...vals) !== Math.min(...vals) ? (r.best > 0 ? Math.max(...vals) : Math.min(...vals)) : null;
            return row('bb-fig' + (r.first ? ' is-first' : '') + (r.cls ? ' ' + r.cls : ''), (r.ink ? `<i style="background:${r.ink}"></i>` : '') + esc(r.label), s => {
                if (r.html) return `<span${r.tip ? ` title="${esc(r.tip(s))}"` : ''}>${r.html(s)}</span>`;
                const v = r.val(s), text = r.words ? r.words(s) : r.text(v, s);
                return `<span${allowLead && v != null && v === lead ? ' class="is-lead"' : ''}${r.tip ? ` title="${esc(r.tip(s))}"` : ''}>${esc(text)}</span>`;
            });
        }).join('');

        return `<div class="bb" style="--n:${seats.length}">` + head
            + band('bench.b.gameFull') + row('bb-graph', keys, game) + row('bb-marks', markTitle, s => this.benchMarksHtml(s, traces[s.id], data.end, link)) + axis(markKeys)
            + band('bench.b.modelFull') + RATES.map(r => row('bb-graph', `<b title="${esc(t('bench.b.rateTip'))}">${esc(t(r.label))}</b><small>0 – ${esc(r.text(r.top))}</small>`, s => rate(r, s))).join('') + axis()
            + band('bench.b.summaryFull') + table + '</div>';
    };

    P.benchMiniHtml = function (ledger, data = this.benchSeries(ledger)) {
        const esc = x => this.escapeHtml(String(x == null ? '' : x));
        const prof = ledger ? ledger.profile() : null;
        const seats = prof ? prof.seats.filter(s => s.decisions > 0) : [];
        const any = seats.length > 0, warmup = seats.some(s => s.warmup);
        const mode = (ledger && ledger.match && ledger.match.mode === 'lockstep') ? 'bench.mode.lockstepShort' : 'bench.mode.realtimeShort';
        const badge = !any ? t('eval.provisional') : warmup ? t('bench.warmupShort') : t(mode);
        return `<div class="bench-head">${esc(t('bench.matrix'))}<span${warmup ? ' class="bf-warmup"' : ''}>${esc(badge)} · ${esc(t('bench.b.open'))}</span></div>` + this.benchBoardHtml(ledger, data, { mini: true });
    };

    P.benchFullHtml = function (ledger, data = this.benchSeries(ledger), link = this.benchLinkKey()) {
        const esc = x => this.escapeHtml(String(x == null ? '' : x));
        const prof = ledger ? ledger.profile() : null;
        const seats = prof ? prof.seats.filter(s => s.decisions > 0) : [];
        const modeKey = (ledger && ledger.match && ledger.match.mode === 'lockstep') ? 'bench.mode.lockstep' : 'bench.mode.realtime';
        const warmup = seats.some(s => s.warmup);
        const close = `<button type="button" class="bf-close" onclick="game.ui.toggleBenchFull(false)" title="${esc(t('bench.b.close'))}" aria-label="${esc(t('bench.b.close'))}">✕</button>`;
        const pills = `<span class="bf-pill">${esc(t(modeKey))}</span><span class="bf-pill">v4</span>`
            + (warmup ? `<span class="bf-pill is-warmup">${esc(t('bench.warmup'))}</span>` : '');
        return `<div class="bf-box" onclick="event.stopPropagation()"><div class="bf-head"><b>${esc(t('bench.matrix'))}</b>${pills}${close}</div>`
            + `<div class="bf-body">${this.benchBoardHtml(ledger, data, { link })}</div></div>`;
    };

    const SOURCE = 'When Agents Rule · github.com/asp67/when-agents-rule';
    P.benchShareSpec = function (ledger, axis = this._shareAxis || 'outPerOk') {
        const profile = ledger ? ledger.profile() : null, seats = profile ? profile.seats.filter(s => s.decisions > 0) : [];
        if (!seats.length) return null;
        const ink = s => this.legibleColor ? this.legibleColor(this.identityHex ? this.identityHex(s.id, s.civ, s.seat) : '#cccccc') : '#cccccc';
        const name = s => s.name || s.model || s.id;
        const cost = s => {
            const e = s.efficiency || {};
            if (axis === 'tokens') return e.tokensPerDecision != null ? e.tokensPerDecision / 1000 : (e.tokens && s.decisions ? (e.tokens.promptTotal + e.tokens.completionTotal) / s.decisions / 1000 : null);
            if (axis === 'speed') return e.latencyMs ? WarShare.speedOf(e.latencyMs.median, !!(s.harness && s.harness.external)) : null;
            return e.outputPerValidOrder != null ? e.outputPerValidOrder : (e.tokens ? e.tokens.completionPerOk : null);
        };
        const m = ledger.match || {}, end = ledger.lastSec || 0;
        const xKey = axis === 'tokens' ? 'share.xTokens' : axis === 'speed' ? 'share.xSpeed' : 'share.xOutPerOk';
        return {
            title: seats.map(name).join(' · '),
            sub: [m.matchId, m.build != null ? t('share.build', { n: m.build }) : '', end ? clock(end) : '', m.promptVersion].filter(Boolean).join(' · '),
            x: t(xKey), y: t('share.yIndex'), yTop: 100, sweetSpot: true,
            points: seats.map(s => ({
                name: name(s), x: cost(s), y: s.index.value, ink: ink(s), harness: !!(s.harness && s.harness.external),
                note: s.index.value == null ? '' : String(Math.round(s.index.value))
            })),
            heat: ledger.mapSize && typeof ledger.orders === 'function' ? {
                title: t('share.heat'), none: t('share.heatNone'),
                seats: seats.map(s => ({ name: name(s), ink: ink(s), grid: WarShare.grid(ledger.orders(s.id), ledger.mapSize) }))
            } : null,
            legend: { raw: t('bench.h.raw'), harness: t('bench.h.harness') }, notShown: t('share.notShown'), empty: t('share.empty'),
            foot: [SOURCE, t('share.foot', { scale: profile.scale || '?' })]
        };
    };

    P.benchShareHtml = function (ledger) {
        if (typeof WarShare === 'undefined') return '';
        const esc = x => this.escapeHtml(String(x == null ? '' : x)), axis = this._shareAxis || 'outPerOk', spec = this.benchShareSpec(ledger, axis);
        if (!spec) return '';
        const pick = (k, label) => `<button type="button" class="bs-btn${axis === k ? ' is-on' : ''}" onclick="game.ui.benchShareAxis('${k}')">${esc(t(label))}</button>`;
        return `<div class="bf-share"><h4>${esc(t('share.title'))}<small>${esc(t('share.tip'))}</small></h4><div class="bs-bar">`
            + pick('outPerOk', 'share.outPerOk') + pick('speed', 'share.speed') + pick('tokens', 'share.tokens') + '<span></span>'
            + `<button type="button" class="bs-btn" onclick="game.ui.benchShareSave('png')">${esc(t('share.png'))}</button>`
            + `<button type="button" class="bs-btn" onclick="game.ui.benchShareSave('svg')">${esc(t('share.svg'))}</button></div>`
            + `<div class="bs-pic">${WarShare.card(spec)}</div></div>`;
    };

    P.benchShareAxis = function (axis) {
        this._shareAxis = (axis === 'tokens' || axis === 'speed') ? axis : 'outPerOk';
        this.updateSummaryProfile();
    };

    P.benchShareSave = function (kind) {
        const ledger = this.benchLedger(), spec = this.benchShareSpec(ledger);
        if (!spec) return Promise.resolve(false);
        const id = (ledger.match && ledger.match.matchId) || 'match';
        return this.shareSave(WarShare.card(spec), id + '-' + (this._shareAxis || 'outPerOk'), kind);
    };

    P.sharePng = function (svg) {
        return new Promise((resolve, reject) => {
            const img = new Image(), url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
            img.onload = () => {
                const c = document.createElement('canvas');
                c.width = WarShare.W; c.height = WarShare.H;
                c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
                URL.revokeObjectURL(url);
                c.toBlob(b => b ? resolve(b) : reject(new Error('no image')), 'image/png');
            };
            img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('the chart could not be drawn')); };
            img.src = url;
        });
    };

    P.shareSave = function (svg, name, kind = 'png') {
        const put = (blob, ext) => {
            const a = document.createElement('a'), url = URL.createObjectURL(blob);
            a.href = url; a.download = String(name).replace(/[^\w.-]+/g, '_') + '.' + ext;
            document.body.appendChild(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 4000);
            return true;
        };
        if (kind === 'svg') return Promise.resolve(put(new Blob([svg], { type: 'image/svg+xml' }), 'svg'));
        return this.sharePng(svg).then(blob => put(blob, 'png'))
            .catch(e => { console.warn('[share] no picture', e); if (this.showErrorMessage) this.showErrorMessage(t('share.failed')); return false; });
    };

    // Results Matrix & drilldown evidence.
    P.benchHtml = function (ledger, { link = 'bench.open', matrix = true } = {}) {
        const esc = s => this.escapeHtml(String(s == null ? '' : s)), ev = this._benchEvidence;
        const profile = ledger ? ledger.profile() : null;
        const seats = profile ? profile.seats.filter(s => s.decisions > 0) : [];
        if (!seats.length) {
            return { right: `<div class="bench-head">${esc(t('bench.matrix'))}</div><p class="bench-none">${esc(t('bench.none'))}</p>` };
        }
        const now = ledger.lastSec || 0;
        const past = matrix && now >= TREND_SEC + 60 ? ledger.profileAt(now - TREND_SEC) : null;
        const then = (id, key) => { const s = past && past.seats.find(x => x.id === id); return s && s[key] ? s[key].score : null; };
        const ink = s => this.legibleColor ? this.legibleColor(this.identityHex ? this.identityHex(s.id, s.civ, s.seat) : '#cccccc') : '#cccccc';
        const dot = s => this.teamDotHtml ? this.teamDotHtml(s.seat, 10) : '';
        const label = s => esc(s.name || s.model || s.id);
        const open = (s, turn) => turn == null || !link ? '' : ` onclick="event.stopPropagation(); game.ui.benchOpenTurn('${esc(s.id)}', ${Number(turn)})" title="${esc(t(link))}"`;
        const seatOf = id => seats.find(s => s.id === id);
        let right = '';

        if (matrix) {
            const anyWarmup = seats.some(s => s.warmup);
            const rows = DIMS.map(key => {
                const scores = seats.map(s => s[key] && s[key].score).filter(v => v != null);
                const best = !anyWarmup && scores.length > 1 ? Math.max(...scores) : null;
                return `<tr><th scope="row">${esc(t('eval.' + key))}</th>` + seats.map(s => {
                    const score = s[key].score, before = key === 'strategy' && s.strategy.final ? null : then(s.id, key);
                    const delta = score != null && before != null ? Math.round(score) - Math.round(before) : 0;
                    const trend = delta ? `<em class="${delta > 0 ? 'bm-up' : 'bm-down'}" title="${esc(t('bench.trendTip', { then: Math.round(before) }))}">${delta > 0 ? '▲' : '▼'}${Math.abs(delta)}</em>` : '';
                    const tip = this.evalTips(s)[key] + (score != null ? ' — ' + t('bench.cellTip') : '');
                    const picked = ev && ev.key === key && ev.id === s.id ? ' is-picked' : '';
                    const click = score == null ? '' : ` onclick="game.ui.benchShowEvidence('${key}', '${esc(s.id)}')"`;
                    const lead = best != null && score === best ? ' is-lead' : '';
                    return `<td class="bm-cell${score == null ? ' is-empty' : ''}${lead}${picked}" title="${esc(tip)}"${click}>`
                        + `<div class="bm-top"><b>${score == null ? '–' : Math.round(score)}</b>${trend}</div>`
                        + `<i class="bm-bar"><u style="width:${score == null ? 0 : Math.round(score)}%;background:${PART_INK[key]}"></u></i>`
                        + `<small>${esc(rawOf(key, s)) || '&nbsp;'}</small></td>`;
                }).join('') + '</tr>';
            }).join('');

            const idxScores = seats.map(s => s.index && s.index.value).filter(v => v != null);
            const bestIdx = !anyWarmup && idxScores.length > 1 ? Math.max(...idxScores) : null;
            const index = seats.map(s => {
                const v = s.index && s.index.value;
                return `<td class="bm-index${bestIdx != null && v === bestIdx ? ' is-lead' : ''}" title="${esc(this.evalTips(s).index)}">`
                    + `<b>${v == null ? '–' : Math.round(v)}</b><small>${v == null ? '&nbsp;' : esc(s.warmup ? t('bench.early') : t('bench.indexOf', { n: s.index.of }))}</small></td>`;
            }).join('');

            const bwCells = seats.map(s => {
                const m = s.macro || {};
                const okD = m.okPerDecision == null ? '–' : m.okPerDecision.toFixed(1) + ' ok/d';
                return `<td class="bm-cost">${batchBarHtml(m.batch, true)}<small>${esc(okD)} · ${m.passiveWaits || 0} pw</small></td>`;
            }).join('');

            const list = a => a.length ? a.join(', ') : '–';
            const range = seats.map(s => {
                const v = s.versatility, any = v.units.length + v.buildings.length + v.techs.length;
                return `<td class="bm-cost bm-range" title="${esc(t('bench.rangeTip', { units: list(v.units), buildings: list(v.buildings), techs: list(v.techs) }))}">`
                    + `<b>${any ? v.units.length + ' · ' + v.buildings.length + ' · ' + v.techs.length : '–'}</b></td>`;
            }).join('');

            const cost = seats.map(s => {
                const c = this.benchCost(s);
                const latText = c.latMedian == null ? '–' : durText(c.latMedian);
                const tok = c.outPerOk != null ? Math.round(c.outPerOk) : null;
                return `<td class="bm-cost" title="${esc(t('bench.effTip', { lat: latText, tok: tok == null ? '–' : tok, cmds: s.efficiency.commandsPerDecision == null ? '–' : s.efficiency.commandsPerDecision.toFixed(2), missed: c.missed }))}">`
                    + `<b>${esc(latText)}</b><small>${tok == null ? '&nbsp;' : esc(t('bench.outTok', { n: tok }))}</small></td>`;
            }).join('');

            right = `<div class="bench-head">${esc(t('bench.matrix'))}<span>Scale ${esc((profile && profile.scale) || 'v4')}</span></div>`
                + `<table class="bm"><thead><tr><th></th>` + seats.map(s =>
                    `<th scope="col" class="bm-seat" style="--civ:${esc(ink(s))}">${dot(s)}<span>${label(s)}</span></th>`).join('')
                + `</tr></thead><tbody>${rows}<tr class="bm-indexrow"><th scope="row">${esc(t('eval.index'))}</th>${index}</tr>`
                + `<tr class="bm-costrow"><th scope="row">${esc(t('bench.b.batchShort'))}</th>${bwCells}</tr>`
                + `<tr class="bm-costrow"><th scope="row">${esc(t('bench.range'))}<small>${esc(t('bench.rangeUnit'))}</small></th>${range}</tr>`
                + `<tr class="bm-costrow"><th scope="row">${esc(t('bench.eff'))}</th>${cost}</tr></tbody></table>`;

            if (ev && seatOf(ev.id)) {
                const s = seatOf(ev.id);
                let items = [];
                if (ev.key === 'grounding') items = s.grounding.errors.slice(-12).reverse().map(x =>
                    `<li${open(s, x.turn)}><span class="be-when">#${x.turn} ${clock(x.sec)}</span> ${esc(x.code)} · ${esc(x.cls === 'reference' ? t('bench.b.hallucinations') : t('bench.b.constraints'))}</li>`);
                else if (ev.key === 'macro') {
                    const tr = typeof ledger.trace === 'function' ? ledger.trace(s.id) : null;
                    const passive = tr ? tr.marks.filter(m => m.kind === 'passive').slice(-8).reverse() : [];
                    items.push(`<li class="be-plain"><span class="be-when">Dev ${Math.round(s.macro.devScore || 0)}</span> ${esc(t('bench.evMacro', { bw: share(s.macro.bwUtil), par: share(s.macro.parallelRate), pw: s.macro.passiveWaits || 0, jw: s.macro.justifiedWaits || 0 }))}</li>`);
                    for (const pm of passive) items.push(`<li${open(s, pm.turn)}><span class="be-when">#${pm.turn} ${clock(pm.sec)}</span> ${esc(pm.n >= WarEval.STALL_MIN ? t('bench.t.passiveStall', { n: pm.n, upTo: pm.upTo, open: pm.openFronts || 1 }) : t('bench.t.passiveLine', { open: pm.openFronts || 1 }))}</li>`);
                }
                else if (ev.key === 'spatial') {
                    items.push(`<li class="be-plain"><span class="be-when">${s.spatial.maxExplored == null ? '–' : Math.round(s.spatial.maxExplored) + '%'}</span> ${esc(t('bench.evSpatial', { disc: s.spatial.discovered || 0, opp: s.spatial.opponents || 0, ord: s.spatial.spatialOrders || 0, err: s.spatial.spatialErrors || 0 }))}</li>`);
                    const spErrs = s.grounding.errors.filter(e => WarEval.SPATIAL_ERROR_CODES && WarEval.SPATIAL_ERROR_CODES.has(e.code)).slice(-8).reverse();
                    for (const x of spErrs) items.push(`<li${open(s, x.turn)}><span class="be-when">#${x.turn} ${clock(x.sec)}</span> ${esc(x.code)}</li>`);
                }
                else if (ev.key === 'strategy') {
                    const g = s.strategy, line = (when, text) => `<li class="be-plain"><span class="be-when">${when}</span> ${esc(text)}</li>`;
                    items = g.ages.map(a => line(clock(a.sec), t('age.' + a.age)));
                    if (g.clearLeadAt != null) items.push(line(clock(g.clearLeadAt), t('bench.lead') + (g.converted == null ? '' : ' · ' + t(g.converted ? 'bench.leadWon' : 'bench.leadLost'))));
                    if (g.battles) items.push(line('⚔', t('bench.battles', { n: g.battles, destroyed: g.destroyed, lost: g.lost })));
                }
                else items = s.tactical.list.slice(-12).reverse().map(e =>
                    `<li${open(s, e.turn)}><span class="be-when">#${e.turn} ${clock(e.sec)}</span> ${esc(this.benchThreatLine(e, s))}</li>`);
                right += `<div class="bench-evidence" style="--civ:${esc(ink(s))}"><div class="bench-head">${esc(t('eval.' + ev.key))} · ${label(s)}<span>${esc(t('bench.evidence'))}</span></div>`
                    + (items.length ? `<ul>${items.join('')}</ul>` : `<p class="bench-none">${esc(t('bench.nothing'))}</p>`) + '</div>';
            }
        }

        return { right };
    };

    P.benchThreatLine = function (e, seat) {
        const what = e.kind === 'wonder' ? t('bench.wonder') : e.what.join(', ').replace(/_/g, ' ');
        const had = seat.decisions - e.decision + 1;
        const answer = !seat.tactical.judged ? '' : e.answeredAfter === 0 ? t('bench.answered0') : e.answeredAfter != null ? t(e.answeredAfter === 1 ? 'bench.answered1' : 'bench.answered2')
            : had < WarEval.RESPONSE_WINDOW ? t('bench.waiting', { k: had, n: WarEval.RESPONSE_WINDOW }) : t('bench.unanswered');
        const end = e.kind === 'wonder' ? '' : e.outcome === 'lost' ? t('bench.lost', { what: e.lost.join(', ').replace(/_/g, ' ') }) : e.outcome === 'held' ? t('bench.held') : t('bench.ongoing');
        return [what + (e.by ? ' ' + t('bench.by', { who: e.by }) : ''), answer, end].filter(Boolean).join(' · ');
    };
})();
