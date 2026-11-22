// The Bench view (overhaul steps D2 to D4): the evaluation profile as a screen.
//
// A switch (the Bench button in the bar, the icon on the broadcast board, or the B key)
// that ADDS two panels to whichever mode is on screen. Analyze mode keeps its decision log
// and leaderboard, and the panels stand inside them; broadcast mode keeps its scoreboard
// and captions, and the panels stand at the edges under the board. Three things, read
// from the ledger (js/eval/ledger.js):
//   the matrix          every part of the profile by seat, with what it rests on, how it
//                       moved over the last ten minutes, and the decisions behind a cell;
//                       under the scored parts their Index, the range used, and the cost
//   the plan tracker    a seat's standing plan step by step: acted on, open, dropped
//   the response clock  each threat from the moment a seat was SHOWN it, the decisions it
//                       has had since, and what became of it
// Everything here is drawn from ledger.profile(), the object the command-line scorer
// prints, so the screen and the file cannot disagree. Nothing is worked out in this file
// but layout. Off until asked for, like the race chart: no panel turns up in a recording
// by itself.
(function () {
    if (typeof UIManager === 'undefined') return;
    const P = UIManager.prototype;
    const DIMS = WarEval.SCORED;
    const TREND_SEC = 600;
    const clock = sec => sec == null ? '–' : Math.floor(sec / 60) + ':' + String(Math.floor(sec) % 60).padStart(2, '0');
    const share = v => v == null ? '–' : (v * 100).toFixed(v > 0.9995 || v < 0.0005 ? 0 : 1) + ' %';
    // begun: part of what the step commits to is carried out and the step is still open;
    // part: it was settled with only part of it done.
    const GLYPH = { acted: '✓', begun: '◐', part: '◐', pending: '○', dropped: '✕', uncheckable: '·' };
    // The raw measure under a score, with the count it rests on.
    const rawOf = (key, s) => {
        const g = s.grounding, pl = s.planning, fl = s.follow, ta = s.tactical;
        if (key === 'grounding') return g.rated ? share(g.rate) + ' · ' + g.rated : '';
        if (key === 'planning') return pl.statements ? share(pl.coverage) + ' · ' + pl.revisions + '×' : '';
        if (key === 'follow') return fl.judged && fl.acted + fl.dropped ? fl.acted + '/' + (fl.acted + fl.dropped) : '';
        if (key === 'strategy') return s.strategy.samples ? share(s.strategy.powerShare) + (s.strategy.rank != null ? ' · #' + s.strategy.rank : '') : '';
        return ta.judged && ta.episodes + ta.wonders ? (ta.atOnce + ta.wonderAnswered) + '/' + (ta.episodes + ta.wonders) : '';
    };
    // ---- Broadcast comparisons (overhaul step D7) -----------------------------
    // How long one comparison stays, how long the strip keeps away after a caption, and
    // what a part must have had to go on before it is shown at all: a handful of
    // opportunities for EVERY model seat (a handful of minutes of power readings, for
    // Strategy). A part resting on one threat or two commands is not broadcast.
    const COMPARE = { showMs: 9000, quietMs: 3000, handful: 5, samples: 60 };
    const chances = (key, s) => key === 'grounding' ? (s.grounding.rated || 0)
        : key === 'planning' ? (s.decisions || 0)
        : key === 'follow' ? (s.follow.judged ? (s.follow.acted || 0) + (s.follow.part || 0) + (s.follow.dropped || 0) : 0)
        : key === 'tactical' ? (s.tactical.judged ? s.tactical.episodes + s.tactical.wonders : 0)
        : (s.strategy.samples || 0);

    P.benchOn = function () { return !!this.viewPreferences().bench; };
    P.toggleBenchView = function (on = !this.benchOn()) {
        this.viewPreferences().bench = !!on;
        this.saveViewPreferences();
        this.refreshBenchView();
        if (this.broadcastOn && this.broadcastOn() && this.renderBroadcast) this.renderBroadcast();   // its icon follows
    };
    // B switches the Bench panels and R the race chart while a match is being watched, in
    // either mode and except while typing. In broadcast mode the bar is gone, so the keys
    // and the icons on the board are the way to them. C switches the comparison lower
    // third, which exists in broadcast mode only. V flips the 3-D view between everything
    // and what one seat knows (the model's view, js/seat-view.js).
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
    // ---- Broadcast comparisons (overhaul step D7) -----------------------------
    // A lower third of broadcast mode: one part of the profile at a time, every model seat
    // side by side, changing every few seconds. It shares the caption's place, so it steps
    // aside while a caption is up and for a moment after. An overlay like the others: off
    // until asked for (the ⚖ icon on the board, or C), and remembered.
    P.compareOn = function () { return !!this.viewPreferences().compare; };
    P.toggleCompare = function (on = !this.compareOn()) {
        this.viewPreferences().compare = !!on;
        this.saveViewPreferences();
        this._cmp = null;
        this.updateCompare();
        if (this.broadcastOn && this.broadcastOn() && this.renderBroadcast) this.renderBroadcast();
    };
    // The parts that may be shown now, each with every model seat: only where every seat
    // has had a handful of opportunities, and only with two seats or more to compare.
    P.compareList = function (profile) {
        const seats = profile ? profile.seats.filter(s => s.decisions > 0) : [];
        if (seats.length < 2) return [];
        return DIMS.filter(key => seats.every(s => s[key].score != null && chances(key, s) >= (key === 'strategy' ? COMPARE.samples : COMPARE.handful)))
            .map(key => ({ key, seats: seats.map(s => ({ id: s.id, seat: s.seat, civ: s.civ, name: s.name || s.model || s.id, score: s[key].score, raw: rawOf(key, s), n: chances(key, s) })) }));
    };
    P.compareHtml = function (item) {
        const esc = s => this.escapeHtml(String(s == null ? '' : s));
        const ink = s => this.legibleColor ? this.legibleColor(this.identityHex ? this.identityHex(s.id, s.civ, s.seat) : '#cccccc') : '#cccccc';
        const best = Math.max(...item.seats.map(s => s.score)), tie = item.seats.filter(s => s.score === best).length > 1;
        return `<div class="bcmp-head"><b>${esc(t('eval.' + item.key))}</b><span>${esc(t('bench.cmp.' + item.key))}</span><em>${esc(t('eval.provisional'))}</em></div>`
            + '<div class="bcmp-rows">' + item.seats.map(s => `<div class="bcmp-seat${!tie && s.score === best ? ' is-lead' : ''}" style="--civ:${esc(ink(s))}">`
                + `<span class="bcmp-name">${this.teamDotHtml ? this.teamDotHtml(s.seat, 10) : ''}${esc(s.name)}</span>`
                + `<span class="bcmp-val"><b>${Math.round(s.score)}</b><i class="bcmp-bar"><u style="width:${Math.round(s.score)}%"></u></i><small>${esc(s.raw) || '&nbsp;'}</small></span></div>`).join('') + '</div>';
    };
    // Called on a timer while a match is watched. `now` is passed in by the tests.
    P.updateCompare = function (now = Date.now()) {
        let el = document.getElementById('compareStrip');
        const on = this.compareOn() && !!this.broadcastOn && this.broadcastOn() && this.game.spectatorMode && this.game.gameStarted;
        if (!on) { if (el) el.remove(); this._cmp = null; return; }
        const st = this._cmp || (this._cmp = { key: null, since: 0, quietUntil: 0, html: null });
        // A caption is up for as long as its timer runs (nextChronicleCaption).
        if (this._chronicleTimer) st.quietUntil = now + COMPARE.quietMs;
        const ledger = this.benchLedger();
        const list = ledger ? this.compareList(ledger.profile()) : [];
        if (!list.length || now < st.quietUntil) { if (el) el.classList.remove('is-in'); st.since = 0; return; }
        // The next part when this one has had its time, was interrupted, or may no longer be shown.
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

    // Where the panels start: under the mode's own top strip, the bar in analyze mode and
    // the scoreboard in broadcast mode, which wraps to a second row when there are many
    // seats. Measured, and handed to the stylesheet as --bench-top. The transcript panel
    // opens in the slot beside the leaderboard, so the matrix is told when it is up.
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
        for (const id of ['benchLeft', 'benchMatrix']) { const el = document.getElementById(id); if (el) el.style.display = on ? '' : 'none'; }
        this._benchSig = null;
        this.updateBenchView();
    };

    // The ledger the board reads: the running match's, or in the transcript analyzer the
    // loaded file's (build 1223).
    P.benchInAnalyzer = function () {
        const el = typeof document !== 'undefined' ? document.getElementById('analyzeScreen') : null;
        return !!(el && el.classList && el.classList.contains('active'));
    };
    P.benchLedger = function () { return this.benchInAnalyzer() ? (this.analyzer && this.analyzer.ledger) || null : this.evalLedger(); };
    // What a click on a decision does where the board is shown now, as the key of its
    // tooltip: null where it can do nothing (the results screen once the transcript is gone).
    P.benchLinkKey = function () {
        if (this.benchInAnalyzer()) return 'sum.openAnalyzer';
        const sum = typeof document !== 'undefined' ? document.getElementById('arenaSummaryScreen') : null;
        if (!sum || !sum.classList || !sum.classList.contains('active') || sum.classList.contains('snapshot')) return 'bench.open';
        return this.summaryCanOpen() ? 'sum.openAnalyzer' : null;
    };
    // A seat's decision in the transcript viewer: where every list in this view leads.
    P.openTranscriptTurn = function (playerId, turn) {
        if (turn == null) return;
        this._transcriptFor = playerId;
        this._tvWindowEnd = turn; this._tvPinned = turn; this._tvRendered = null;
        this.renderTranscriptViewer();
        this.updateSpectatorPlayerList();
        if (this.tvJumpTo) this.tvJumpTo(turn);
    };
    // A decision named in an evidence list, opened where it can be read. While a match
    // runs that is the transcript panel; from the results card over a running match the
    // card closes first; after the end the transcript opens in the analyzer at that seat's
    // decision, which leaves the results screen as the Analyzer button does.
    P.benchOpenTurn = function (playerId, turn) {
        if (turn == null) return;
        if (this._benchFull) this.toggleBenchFull(false);     // the board at full size steps out of the way
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
    // After the end a decision can be opened only while the transcript is still held.
    P.summaryCanOpen = function () {
        const rec = this.game.openAIAIManager && this.game.openAIAIManager.transcripts;
        return !!(rec && rec.hasData && rec.hasData());
    };

    // The report card (overhaul step D8): the comparison matrix on the results screen,
    // from the same ledger and the same markup as the Bench view. It is drawn after the
    // match's closing lines have reached the ledger, so at the end it shows the numbers
    // the exported file gives.
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
        // Under the matrix: the way to the board with the graphs over the match (build
        // 1223), and the chart to share, which sums a match up and so belongs here and not
        // on the live board (build 1227).
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
        const left = document.getElementById('benchLeft'), right = document.getElementById('benchMatrix'), full = document.getElementById('benchFull');
        // The panels belong to a match being watched with the Bench view on. The board at
        // full size is its own thing: it also opens from the results screen and in the
        // transcript analyzer (build 1223).
        const panels = !!(left && right && this.benchOn() && !this.benchInAnalyzer()), open = !!(full && this._benchFull);
        if (!panels && !open) {
            if (full && (full.innerHTML || full.style.display !== 'none')) { full.innerHTML = ''; full.style.display = 'none'; }
            return;
        }
        if (panels) this.benchPlace();
        const ledger = this.benchLedger(), link = this.benchLinkKey();
        const sig = [ledger ? ledger.lines + '.' + ledger.rev : -1, typeof getUiLang === 'function' ? getUiLang() : '', open, panels, link].join(':');
        if (sig === this._benchSig) return;
        this._benchSig = sig;
        // The scores over the match, once for the mini card and the full size alike.
        const data = this.benchSeries(ledger);
        if (panels) {
            // Two seats or more: the plan panel is as wide as two plans beside each other.
            const many = !!ledger && ledger.profile().seats.filter(s => s.decisions > 0).length > 1;
            if (left.classList && left.classList.toggle) left.classList.toggle('is-wide', many);
            left.innerHTML = this.benchHtml(ledger, { link, matrix: false }).left;
            right.innerHTML = this.benchMiniHtml(ledger, data);
        }
        if (full) {
            // Drawn again in place: where the reader had scrolled to is where they stay
            // (it used to jump back to the top at every decision).
            const body = open && full.querySelector ? full.querySelector('.bf-body') : null, at = body ? body.scrollTop : 0;
            full.style.display = open ? '' : 'none';
            full.innerHTML = open ? this.benchFullHtml(ledger, data, link) : '';
            const again = at && full.querySelector ? full.querySelector('.bf-body') : null;
            if (again) again.scrollTop = at;
        }
        // Samples of the history that did not fit into this refresh's budget: ask again in
        // a moment, a little at a time, so the game never stands still for a graph.
        if (ledger && ledger._live && ledger._live.pending > 0 && !this._benchFill && typeof setTimeout === 'function') {
            this._benchFill = setTimeout(() => { this._benchFill = null; this._benchSig = null; this.updateBenchView(); }, 120);
        }
    };

    // ---- the comparison board (build 1222, laid out again in build 1227) ---------------
    // asp67, 22 November 2026: "Change the lines to graphs over time. Separate it in 3
    // distinct sections per model: gameplay score, model performance and cost, score
    // summary. Have a mini card on screen that is still readable and toggle a full size
    // view when clicked." The first build read that wrongly and was thrown out the same
    // day: it put the power graph under gameplay, the five scores under performance, the
    // models under each other, the old matrix and the share chart at the bottom, and it
    // jumped back to the top at every refresh. In asp67's words what was wanted: "graphs
    // over time, models side by side, top section Gameplay, middle model performance,
    // bottom summary."
    //
    // So the board is one grid. A COLUMN is a model, and the models stand side by side.
    //   Gameplay            Grounding, Planning, Follow-through, Tactical and Strategy
    //                       over the match in one graph a model, and under it a strip of
    //                       the decisions that went wrong (Ledger.trace), each a way into
    //                       the transcript
    //   Model performance   over the match, on one scale for all models so the columns
    //                       can be compared: seconds a decision, tokens a decision, the
    //                       share of orders refused. Each is the rate of the seat's LATEST
    //                       decisions, so a slowdown or a growing prompt shows as a slope
    //   Summary             one table, a row a figure: the Index and its parts, what the
    //                       play cost, how disciplined it was, what the harness did
    // The mini card is the same grid with the labels left out and one graph a section.
    // Nothing is worked out here but layout, rates and ratios. The power graph is the Race
    // chart's, the matrix with its evidence is the report card's on the results screen, and
    // the chart to share stands there too: none of them is on this board.
    const PART_INK = { index: '#ddd3b4', grounding: '#7fd0bd', planning: '#8fbdf0', follow: '#9fd08a', tactical: '#f2c46a', strategy: '#e89ac0' };
    const TRACE_KINDS = ['loop', 'constraint', 'awareness', 'threat', 'refused'];
    const tokText = n => n == null ? '–' : n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(Math.round(n));
    const durText = ms => ms == null ? '–' : ms >= 60000 ? Math.round(ms / 60000) + ' min' : Math.round(ms / 1000) + ' s';
    const ratio = v => v == null || !isFinite(v) ? '–' : v >= 100 ? String(Math.round(v)) : v >= 10 ? v.toFixed(1) : v.toFixed(2);
    // Lines over time as one SVG. lines: [{ t, v, ink, width }], a null value breaks a line.
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
            return d ? `<path d="${d}" fill="none" stroke="${l.ink}" stroke-width="${l.width || 1.5}" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>` : '';
        };
        return `<svg class="bg-chart ${cls}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">${lines.map(path).join('')}</svg>`;
    };
    // No more points than a graph of this width can show.
    const thin = (t, v, most) => {
        if (t.length <= most) return { t, v };
        const step = t.length / most, T = [], V = [];
        for (let i = 0; i < most; i++) { const k = Math.min(t.length - 1, Math.round(i * step)); T.push(t[k]); V.push(v[k]); }
        T.push(t[t.length - 1]); V.push(v[v.length - 1]);
        return { t: T, v: V };
    };

    // How a seat has been deciding lately, at every sample of its history: seconds a
    // decision, tokens a decision and the share of its orders that were refused, each over
    // its latest RATE_DECISIONS decisions or more (back to the sample that many decisions
    // ago). A running total would only ever rise; this shows when a seat slows down, when
    // its prompt grows, when it starts to get orders refused. Null where there is nothing
    // to divide by: before the first decision, for tokens a harness does not report, and
    // for refusals in a file that does not record what became of the orders.
    const RATE_DECISIONS = 3;
    P.benchRates = function (sc) {
        const n = sc && sc.t ? sc.t.length : 0, out = { t: n ? sc.t : [], sec: [], tok: [], refused: [] };
        if (!n) return out;
        const tokens = i => (sc.promptTokens[i] || 0) + (sc.completionTokens[i] || 0), bad = i => (sc.avoidable[i] || 0) + (sc.invalid[i] || 0);
        const reports = tokens(n - 1) > 0, judged = (sc.ok[n - 1] || 0) + bad(n - 1) > 0;
        for (let i = 0; i < n; i++) {
            let j = i - 1;
            while (j >= 0 && sc.decisions[i] - sc.decisions[j] < RATE_DECISIONS) j--;
            const from = f => j >= 0 ? f(j) : 0;
            const decisions = sc.decisions[i] - from(k => sc.decisions[k]), orders = sc.commands[i] - from(k => sc.commands[k]);
            out.sec.push(decisions > 0 ? (sc.thinkingMs[i] - from(k => sc.thinkingMs[k])) / decisions / 1000 : null);
            out.tok.push(decisions > 0 && reports ? (tokens(i) - from(tokens)) / decisions : null);
            out.refused.push(orders > 0 && judged ? Math.min(100, 100 * (bad(i) - from(bad)) / orders) : null);
        }
        return out;
    };
    // Everything the board draws, by seat: the scores over the match, the rates from them,
    // and the largest value of each rate over all seats (the one scale a row is drawn on).
    // A finished match is scored once and kept; a running one is asked for cheaply (see
    // Ledger.liveHistory), with a budget so the game never waits for a graph.
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
    // What a seat's play cost and how disciplined it was, from its profile: the figures of
    // the summary.
    P.benchCost = function (s) {
        const g = s.grounding, e = s.efficiency, tok = e.tokens;
        const tokens = tok ? tok.promptTotal + tok.completionTotal : null, mistakes = g.avoidable + g.invalid;
        const thinking = e.latencyMs && e.latencyMs.n ? (this._benchThinking && this._benchThinking[s.id]) : null;
        const index = s.index.value;
        return {
            tokens, promptTokens: tok ? tok.promptTotal : null, completionTokens: tok ? tok.completionTotal : null, thinkingMs: thinking == null ? null : thinking,
            // The score for what it cost: Index points a million tokens, and a minute of thinking.
            perMTok: index != null && tokens ? index / (tokens / 1e6) : null,
            perMin: index != null && thinking ? index / (thinking / 60000) : null,
            invalidRate: g.judged ? g.invalid / g.judged : null,
            refusedRate: g.judged ? g.avoidable / g.judged : null,
            recovery: mistakes ? 1 - g.repeated / mistakes : null,
            lost: (e.failedRequests || 0) + (e.cancelledRequests || 0) + (e.missedRounds || 0),
            failed: e.failedRequests || 0, cancelled: e.cancelledRequests || 0, missed: e.missedRounds || 0
        };
    };
    // Thinking time so far by seat, kept from the scores over the match: the profile's
    // own efficiency block knows the median wait, not the sum.
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

    // Who plays a seat, beside its name: the model's own answers, or an agent framework
    // with the model inside it (build 1224).
    P.benchKindTag = function (s) {
        const esc = x => this.escapeHtml(String(x == null ? '' : x)), h = s.harness;
        if (!h || !h.known) return '';
        return h.external
            ? `<em class="bf-kind is-harness" title="${esc(t('bench.h.harnessTip'))}">${esc(t('bench.h.harness'))}${h.kind && h.kind !== 'other' ? ' · ' + esc(h.kind) : ''}</em>`
            : `<em class="bf-kind is-raw" title="${esc(t('bench.h.rawTip'))}">${esc(t('bench.h.raw'))}</em>`;
    };
    // What the game's own harness did for a seat, in a few words: answers it read out of
    // prose, requests it adapted, a human's interventions (build 1224).
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
    // The decisions that went wrong, on the match's clock (the decision inspector, build
    // 1223): a mark a finding under the gameplay graph, a loop as a span, each a way into
    // the transcript.
    P.benchMarksHtml = function (s, tr, end, link) {
        const esc = x => this.escapeHtml(String(x == null ? '' : x));
        if (!tr || !tr.judged) return `<div class="bt-strip is-none" title="${esc(t('bench.t.unjudged'))}"></div>`;
        const order = m => String(m.action == null ? '?' : m.action).replace(/_/g, ' ') + (m.code ? ' · ' + m.code : '');
        const line = m => m.kind === 'threat' ? this.benchThreatLine(m.threat, s)
            : m.kind === 'loop' ? t(m.open ? 'bench.t.loopOpen' : 'bench.t.loopLine', { order: order(m), n: m.n, upTo: m.upTo })
            : order(m) + (m.orders > 1 ? ' ×' + m.orders : '');
        const at = sec => end > 0 && sec != null ? Math.max(0, Math.min(100, 100 * sec / end)) : 0;
        return `<div class="bt-strip"${tr.marks.length ? '' : ` title="${esc(t('bench.t.none'))}"`}>` + tr.marks.map(m => {
            const left = at(m.sec), width = m.kind === 'loop' ? Math.max(0, at(m.upToSec) - left) : 0;
            const open = m.turn == null || !link ? '' : ` onclick="event.stopPropagation(); game.ui.benchOpenTurn('${esc(s.id)}', ${Number(m.turn)})"`;
            return `<i class="is-${m.kind}" style="left:${left.toFixed(1)}%${width ? ';width:' + width.toFixed(1) + '%' : ''}"${open} title="#${m.turn} ${clock(m.sec)} · ${esc(t('bench.t.' + m.kind))}: ${esc(line(m))}"></i>`;
        }).join('') + '</div>';
    };

    // The board as markup: at full size, or as the mini card. `data` is benchSeries().
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
        // Gameplay: the five scores over the match.
        const game = s => { const sc = series(s).score; return linesSvg(DIMS.map(k => Object.assign(thin(sc.t, sc[k] || [], most), { ink: PART_INK[k], width: mini ? 1.2 : 1.6 })), { w: W, h: mini ? 44 : 108, end: data.end, max: 100, cls: 'bb-game' }); };
        const keys = '<span class="bb-keys">' + DIMS.map(k => `<span><i style="background:${PART_INK[k]}"></i>${esc(t('eval.' + k))}</span>`).join('') + '</span>';
        // Model performance: a row a rate, every model on the same scale.
        const now = a => { for (let i = a.length - 1; i >= 0; i--) if (a[i] != null) return a[i]; return null; };
        // The end of a scale: the next round number at or above the largest value of any model.
        const round = v => { const m = Math.pow(10, Math.floor(Math.log10(v))); return [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find(k => k * m >= v - 1e-9) * m; };
        const RATES = [
            { key: 'sec', label: 'bench.b.secPer', ink: '#f2c46a', top: round(Math.max(1, data.top.sec)), text: v => v >= 10 ? Math.round(v) + ' s' : v.toFixed(1) + ' s' },
            { key: 'tok', label: 'bench.b.tokPer', ink: '#8fbdf0', top: round(Math.max(1, data.top.tok)), text: v => tokText(v) },
            { key: 'refused', label: 'bench.b.refusedNow', ink: '#ff8f7a', top: round(Math.max(10, data.top.refused)), text: v => Math.round(v) + ' %' }
        ];
        const rate = (r, s) => {
            const rt = series(s).rates, last = now(rt[r.key]);
            return linesSvg([Object.assign(thin(rt.t, rt[r.key], most), { ink: r.ink, width: mini ? 1.3 : 1.7 })], { w: W, h: mini ? 26 : 38, end: data.end, max: r.top, cls: 'bb-rate' })
                + `<b class="bb-now">${last == null ? esc(t(r.key === 'tok' ? 'bench.b.noUsage' : 'bench.h.notRecorded')) : esc(r.text(last))}</b>`;
        };
        if (mini) {
            return `<div class="bb is-mini" style="--n:${seats.length}" role="button" tabindex="0" title="${esc(t('bench.b.openTip'))}" onclick="game.ui.toggleBenchFull(true)">`
                + head + band('bench.b.game') + row('bb-graph', '', game)
                + band('bench.b.model') + row('bb-graph', '', s => rate(RATES[0], s))
                + band('bench.b.summary') + row('bb-index', '', s => `<b>${s.index.value == null ? '–' : Math.round(s.index.value)}</b><small>${esc(tokText(this.benchCost(s).tokens))}${this.benchCost(s).tokens == null ? '' : ' tok'}</small>`)
                + '</div>';
        }
        const traces = {};
        for (const s of seats) traces[s.id] = typeof ledger.trace === 'function' ? ledger.trace(s.id) : null;
        const kinds = TRACE_KINDS.filter(k => seats.some(s => traces[s.id] && traces[s.id].counts[k]));
        const markTitle = `<b title="${esc(t('bench.t.tip'))}">${esc(t('bench.t.title'))}</b>`;
        const markKeys = '<span class="bb-keys bt-keys">' + kinds.map(k => `<span class="is-${k}" title="${esc(t('bench.t.' + k + 'Tip'))}"><i></i>${esc(t('bench.t.' + k))}</span>`).join('') + '</span>';
        // Summary: a row a figure, a column a model; the best of a row stands out where there is one.
        const cost = {};
        for (const s of seats) cost[s.id] = this.benchCost(s);
        const pct = v => v == null ? '–' : share(v), num0 = v => v == null ? '–' : String(Math.round(v));
        const ROWS = [
            { label: t('eval.index'), val: s => s.index.value, text: num0, best: 1, cls: 'is-index', tip: s => this.evalTips(s).index },
            ...DIMS.map(k => ({ label: t('eval.' + k), ink: PART_INK[k], val: s => s[k].score, text: num0, best: 1, tip: s => this.evalTips(s)[k] })),
            { label: t('bench.b.tokens'), first: true, val: s => cost[s.id].tokens, text: v => v == null ? t('bench.b.noUsage') : tokText(v), tip: () => t('bench.b.tokensTip') },
            { label: t('bench.b.thinking'), val: s => cost[s.id].thinkingMs, text: durText },
            { label: t('bench.b.perMTok'), val: s => cost[s.id].perMTok, text: ratio, best: 1, tip: () => t('bench.b.perTip') },
            { label: t('bench.b.perMin'), val: s => cost[s.id].perMin, text: ratio, best: 1, tip: () => t('bench.b.perTip') },
            { label: t('bench.b.invalid'), first: true, val: s => cost[s.id].invalidRate, text: pct, best: -1, tip: () => t('bench.b.invalidTip') },
            { label: t('bench.b.refused'), val: s => cost[s.id].refusedRate, text: pct, best: -1, tip: () => t('bench.b.refusedTip') },
            { label: t('bench.b.recovery'), val: s => cost[s.id].recovery, text: pct, best: 1, tip: () => t('bench.b.recoveryTip') },
            { label: t('bench.t.loops'), val: s => traces[s.id] && traces[s.id].judged ? traces[s.id].counts.loop : null, text: num0, best: -1, tip: () => t('bench.t.loopTip') },
            { label: t('bench.b.lost'), val: s => cost[s.id].lost, text: num0, best: -1, tip: s => t('bench.b.lostTip', { failed: cost[s.id].failed, cancelled: cost[s.id].cancelled, missed: cost[s.id].missed }) },
            { label: t('bench.h.help'), first: true, val: () => null, text: null, words: s => this.benchHelpText(s), tip: () => t('bench.h.helpTip') }
        ];
        const table = ROWS.map(r => {
            const vals = seats.map(r.val).filter(v => v != null && isFinite(v));
            const lead = r.best && vals.length > 1 && Math.max(...vals) !== Math.min(...vals) ? (r.best > 0 ? Math.max(...vals) : Math.min(...vals)) : null;
            return row('bb-fig' + (r.first ? ' is-first' : '') + (r.cls ? ' ' + r.cls : ''), (r.ink ? `<i style="background:${r.ink}"></i>` : '') + esc(r.label), s => {
                const v = r.val(s), text = r.words ? r.words(s) : r.text(v);
                return `<span${v != null && v === lead ? ' class="is-lead"' : ''}${r.tip ? ` title="${esc(r.tip(s))}"` : ''}>${esc(text)}</span>`;
            });
        }).join('');
        return `<div class="bb" style="--n:${seats.length}">` + head
            + band('bench.b.gameFull') + row('bb-graph', keys, game) + row('bb-marks', markTitle, s => this.benchMarksHtml(s, traces[s.id], data.end, link)) + axis(markKeys)
            + band('bench.b.modelFull') + RATES.map(r => row('bb-graph', `<b title="${esc(t('bench.b.rateTip'))}">${esc(t(r.label))}</b><small>0 – ${esc(r.text(r.top))}</small>`, s => rate(r, s))).join('') + axis()
            + band('bench.b.summaryFull') + table + '</div>';
    };
    // The mini card: the board in the panel, and a click opens it at full size.
    P.benchMiniHtml = function (ledger, data = this.benchSeries(ledger)) {
        const esc = x => this.escapeHtml(String(x == null ? '' : x));
        const any = !!(ledger && ledger.profile().seats.some(s => s.decisions > 0));
        return `<div class="bench-head">${esc(t('bench.matrix'))}<span>${esc(t(any ? 'bench.b.open' : 'eval.provisional'))}</span></div>` + this.benchBoardHtml(ledger, data, { mini: true });
    };
    // The board at full size: nothing but the grid, sized to be read without scrolling.
    P.benchFullHtml = function (ledger, data = this.benchSeries(ledger), link = this.benchLinkKey()) {
        const esc = x => this.escapeHtml(String(x == null ? '' : x));
        const close = `<button type="button" class="bf-close" onclick="game.ui.toggleBenchFull(false)" title="${esc(t('bench.b.close'))}" aria-label="${esc(t('bench.b.close'))}">✕</button>`;
        return `<div class="bf-box" onclick="event.stopPropagation()"><div class="bf-head"><b>${esc(t('bench.matrix'))}</b><span>${esc(t('eval.provisional'))}</span>${close}</div>`
            + `<div class="bf-body">${this.benchBoardHtml(ledger, data, { link })}</div></div>`;
    };

    // ---- a chart to share (build 1226) ----------------------------------------------
    // The match as one picture (js/eval/share.js): the Index against what it cost, a point
    // a model, and where on the map each sent its orders. Saved as PNG or SVG. It stands on
    // the results screen, under the report card.
    const SOURCE = 'When Agents Rule · github.com/asp67/when-agents-rule';
    P.benchShareSpec = function (ledger, axis = this._shareAxis || 'speed') {
        const profile = ledger ? ledger.profile() : null, seats = profile ? profile.seats.filter(s => s.decisions > 0) : [];
        if (!seats.length) return null;
        const ink = s => this.legibleColor ? this.legibleColor(this.identityHex ? this.identityHex(s.id, s.civ, s.seat) : '#cccccc') : '#cccccc';
        const name = s => s.name || s.model || s.id;
        const cost = s => {
            const e = s.efficiency;
            if (axis === 'tokens') return e.tokens ? (e.tokens.promptTotal + e.tokens.completionTotal) / s.decisions / 1000 : null;
            return e.latencyMs ? WarShare.speedOf(e.latencyMs.median, !!(s.harness && s.harness.external)) : null;
        };
        const m = ledger.match || {}, end = ledger.lastSec || 0;
        return {
            title: seats.map(name).join(' · '),
            sub: [m.matchId, m.build != null ? t('share.build', { n: m.build }) : '', end ? clock(end) : '', m.promptVersion].filter(Boolean).join(' · '),
            x: t(axis === 'tokens' ? 'share.xTokens' : 'share.xSpeed'), y: t('share.yIndex'), yTop: 100,
            points: seats.map(s => ({ name: name(s), x: cost(s), y: s.index.value, ink: ink(s), harness: !!(s.harness && s.harness.external),
                note: s.index.value == null ? '' : String(Math.round(s.index.value)) })),
            heat: ledger.mapSize && typeof ledger.orders === 'function' ? { title: t('share.heat'), none: t('share.heatNone'),
                seats: seats.map(s => ({ name: name(s), ink: ink(s), grid: WarShare.grid(ledger.orders(s.id), ledger.mapSize) })) } : null,
            legend: { raw: t('bench.h.raw'), harness: t('bench.h.harness') }, notShown: t('share.notShown'), empty: t('share.empty'),
            foot: [SOURCE, t('share.foot', { scale: profile.scale || '?' })]
        };
    };
    P.benchShareHtml = function (ledger) {
        if (typeof WarShare === 'undefined') return '';
        const esc = x => this.escapeHtml(String(x == null ? '' : x)), axis = this._shareAxis || 'speed', spec = this.benchShareSpec(ledger, axis);
        if (!spec) return '';
        const pick = (k, label) => `<button type="button" class="bs-btn${axis === k ? ' is-on' : ''}" onclick="game.ui.benchShareAxis('${k}')">${esc(t(label))}</button>`;
        return `<div class="bf-share"><h4>${esc(t('share.title'))}<small>${esc(t('share.tip'))}</small></h4><div class="bs-bar">`
            + pick('speed', 'share.speed') + pick('tokens', 'share.tokens') + '<span></span>'
            + `<button type="button" class="bs-btn" onclick="game.ui.benchShareSave('png')">${esc(t('share.png'))}</button>`
            + `<button type="button" class="bs-btn" onclick="game.ui.benchShareSave('svg')">${esc(t('share.svg'))}</button></div>`
            + `<div class="bs-pic">${WarShare.card(spec)}</div></div>`;
    };
    P.benchShareAxis = function (axis) {
        this._shareAxis = axis === 'tokens' ? 'tokens' : 'speed';
        this.updateSummaryProfile();
    };
    P.benchShareSave = function (kind) {
        const ledger = this.benchLedger(), spec = this.benchShareSpec(ledger);
        if (!spec) return Promise.resolve(false);
        const id = (ledger.match && ledger.match.matchId) || 'match';
        return this.shareSave(WarShare.card(spec), id + '-' + (this._shareAxis || 'speed'), kind);
    };
    // A picture as a file: the SVG as it is, or drawn on a canvas and saved as a PNG of
    // the same 1600 x 900. Used by the board and by the Season page.
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

    // The two panels as markup. Apart from the page it is given, it reads nothing but the ledger.
    // `link` is the tooltip key of what a click on a decision does here, or null where it can do nothing.
    // `matrix: false` leaves the matrix out: behind the live panels it is not shown, and its
    // trend alone cost a scoring of the whole match at every refresh.
    P.benchHtml = function (ledger, { link = 'bench.open', matrix = true } = {}) {
        const esc = s => this.escapeHtml(String(s == null ? '' : s)), ev = this._benchEvidence;
        const profile = ledger ? ledger.profile() : null;
        const seats = profile ? profile.seats.filter(s => s.decisions > 0) : [];
        if (!seats.length) {
            const none = `<div class="bench-head">${esc(t('bench.matrix'))}</div><p class="bench-none">${esc(t('bench.none'))}</p>`;
            return { left: `<div class="bench-head">${esc(t('bench.plan'))}</div><p class="bench-none">${esc(t('bench.none'))}</p>`, right: none };
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
        // ---- the matrix ------------------------------------------------------
        if (matrix) {
        const raw = rawOf;
        const rows = DIMS.map(key => {
            const scores = seats.map(s => s[key].score).filter(v => v != null);
            const best = scores.length > 1 ? Math.max(...scores) : null;
            return `<tr><th scope="row">${esc(t('eval.' + key))}</th>` + seats.map(s => {
                // Strategy gains the placement when the match ends: a step, not a trend.
                const score = s[key].score, before = key === 'strategy' && s.strategy.final ? null : then(s.id, key);
                const delta = score != null && before != null ? Math.round(score) - Math.round(before) : 0;
                const trend = delta ? `<em class="${delta > 0 ? 'bm-up' : 'bm-down'}" title="${esc(t('bench.trendTip', { then: Math.round(before) }))}">${delta > 0 ? '▲' : '▼'}${Math.abs(delta)}</em>` : '';
                const cls = (score == null ? ' is-empty' : '') + (best != null && score === best ? ' is-lead' : '') + (ev && ev.key === key && ev.id === s.id ? ' is-open' : '');
                return `<td class="bm-cell${cls}" onclick="game.ui.benchShowEvidence('${key}', '${esc(s.id)}')" title="${esc(this.evalTips(s)[key] + ' ' + t('eval.provisional'))}">`
                    + `<b>${score == null ? '–' : Math.round(score)}</b>${trend}<i class="bm-bar"><u style="width:${score == null ? 0 : Math.round(score)}%"></u></i>`
                    + `<small>${esc(raw(key, s)) || '&nbsp;'}</small></td>`;
            }).join('') + '</tr>';
        }).join('');
        const index = seats.map(s => `<td class="bm-index" title="${esc(this.evalTips(s).index + ' ' + t('eval.provisional'))}">`
            + `<b>${s.index.value == null ? '–' : Math.round(s.index.value)}</b><small>${s.index.value == null ? '&nbsp;' : esc(t('bench.indexOf', { n: s.index.of }))}</small></td>`).join('');
        // The range a seat used with success: facts beside the profile, no score.
        const list = a => a.length ? a.join(', ') : '–';
        const range = seats.map(s => {
            const v = s.versatility, any = v.units.length + v.buildings.length + v.techs.length;
            return `<td class="bm-cost bm-range" title="${esc(t('bench.rangeTip', { units: list(v.units), buildings: list(v.buildings), techs: list(v.techs) }))}">`
                + `<b>${any ? v.units.length + ' · ' + v.buildings.length + ' · ' + v.techs.length : '–'}</b></td>`;
        }).join('');
        const cost = seats.map(s => {
            const e = s.efficiency, lat = e.latencyMs ? e.latencyMs.median : null;
            const latText = lat == null ? '–' : lat < 1000 ? Math.round(lat) + ' ms' : (lat / 1000).toFixed(lat < 10000 ? 1 : 0) + ' s';
            const tok = e.tokens && e.tokens.completionPerOk != null ? Math.round(e.tokens.completionPerOk) : null;
            return `<td class="bm-cost" title="${esc(t('bench.effTip', { lat: latText, tok: tok == null ? '–' : tok, cmds: e.commandsPerDecision == null ? '–' : e.commandsPerDecision.toFixed(2), missed: e.missedRounds }))}">`
                + `<b>${esc(latText)}</b><small>${tok == null ? '&nbsp;' : esc(t('bench.tok', { n: tok }))}</small></td>`;
        }).join('');
        right = `<div class="bench-head">${esc(t('bench.matrix'))}<span>${esc(t('eval.provisional'))}</span></div>`
            + `<table class="bm"><thead><tr><th></th>` + seats.map(s =>
                `<th scope="col" class="bm-seat" style="--civ:${esc(ink(s))}">${dot(s)}<span>${label(s)}</span></th>`).join('')
            + `</tr></thead><tbody>${rows}<tr class="bm-indexrow"><th scope="row">${esc(t('eval.index'))}</th>${index}</tr>`
            + `<tr class="bm-costrow"><th scope="row">${esc(t('bench.range'))}<small>${esc(t('bench.rangeUnit'))}</small></th>${range}</tr>`
            + `<tr class="bm-costrow"><th scope="row">${esc(t('bench.eff'))}</th>${cost}</tr></tbody></table>`;

        // What a cell rests on: the decisions behind it, each a way into the transcript.
        if (ev && seatOf(ev.id)) {
            const s = seatOf(ev.id);
            let items = [];
            if (ev.key === 'grounding') items = s.grounding.errors.slice(-12).reverse().map(x =>
                `<li${open(s, x.turn)}><span class="be-when">#${x.turn} ${clock(x.sec)}</span> ${esc(x.code)}${x.verdict === 'invalid' ? ' · ' + esc(t('log.tagInvalid')) : ''}</li>`);
            else if (ev.key === 'planning') items = s.planning.history.slice(-12).reverse().map(h =>
                `<li${open(s, h.turn)}><span class="be-when">#${h.turn} ${clock(h.sec)}</span> ${esc(t('bench.planChanged', { n: h.steps }))}</li>`);
            else if (ev.key === 'follow') items = (s.follow.standing || []).map(x =>
                `<li${open(s, s.planning.standing && s.planning.standing.turn)} class="is-${x.state}"><span class="be-when">${GLYPH[x.state]}</span> ${esc(x.text)}</li>`);
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

        // ---- the plan tracker ------------------------------------------------
        // Every seat's plan, two beside each other: two seats stand side by side, four as two
        // rows of two (asp67, 22 November 2026, when a third seat's plan was not shown: "make
        // the bench plan card a 2x2 grid"). Until build 1230 it showed two seats that had to
        // be picked on the matrix, which the live view no longer has.
        let left = `<div class="bench-head">${esc(t('bench.plan'))}</div><div class="bp-grid" style="--n:${Math.min(2, seats.length)}">` + seats.map(s => {
            const pl = s.planning, fl = s.follow;
            const head = `<h4>${dot(s)}<span>${label(s)}</span>`;
            if (!pl.standing) return `<section class="bp-seat" style="--civ:${esc(ink(s))}">${head}</h4><p class="bench-none">${esc(t('bench.noPlan'))}</p></section>`;
            const steps = (fl.standing || pl.standing.steps.map(x => ({ text: x.text, state: x.checkable ? 'pending' : 'uncheckable', after: null })));
            const closed = fl.judged ? fl.acted + (fl.part || 0) + fl.dropped : null;
            // Where on the match's clock the plan was changed.
            const ticks = pl.history.map(h => h.sec != null && now > 0 ? `<i style="left:${Math.min(100, 100 * h.sec / now).toFixed(1)}%"></i>` : '').join('');
            return `<section class="bp-seat" style="--civ:${esc(ink(s))}">${head}${closed ? `<em>${esc(t('bench.acted', { acted: fl.acted, closed }))}</em>` : ''}</h4>`
                + (pl.standing.objective ? `<p class="bp-objective">${esc(pl.standing.objective)}</p>` : '')
                + `<p class="bp-age"${open(s, pl.standing.turn)}>${esc(t('bench.planAge', { time: clock(pl.standing.sec), n: s.decisions - pl.standing.since }))}</p>`
                + `<ol class="bp-steps">` + steps.map(x => `<li class="is-${x.state}" title="${esc(t('bench.st.' + x.state))}"><i>${GLYPH[x.state]}</i><span>${esc(x.text)}</span>`
                    + (x.state === 'acted' && x.after ? `<small>+${x.after}</small>` : (x.state === 'begun' || x.state === 'part') ? `<small>${x.met}/${x.of}</small>` : '') + '</li>').join('') + '</ol>'
                + `<div class="bp-ribbon" title="${esc(t('bench.ribbon', { n: pl.history.length }))}">${ticks}</div></section>`;
        }).join('') + '</div>';

        // ---- the response clock ----------------------------------------------
        const threats = [];
        for (const s of seats) for (const e of s.tactical.list) threats.push({ s, e });
        threats.sort((a, b) => (b.e.sec || 0) - (a.e.sec || 0) || b.e.decision - a.e.decision);
        left += `<div class="bench-head bench-clockhead">${esc(t('bench.clock'))}</div>` + (threats.length
            ? threats.slice(0, 6).map(({ s, e }) => {
                const had = s.decisions - e.decision + 1, waiting = e.answeredAfter == null && had < WarEval.RESPONSE_WINDOW && s.tactical.judged;
                const state = e.answeredAfter != null ? (e.answeredAfter <= 1 ? 'answered' : 'slow') : waiting ? 'waiting' : 'missed';
                return `<div class="bc-card is-${state}" style="--civ:${esc(ink(s))}"${open(s, e.turn)}><span class="bc-time">${clock(e.sec)}</span>${dot(s)}`
                    + `<span class="bc-line"><b>${label(s)}</b> ${esc(this.benchThreatLine(e, s))}</span></div>`;
            }).join('')
            : `<p class="bench-none">${esc(t('bench.noThreat'))}</p>`);
        return { left, right };
    };

    // One threat in a sentence: what was shown, what the seat did, what became of it.
    P.benchThreatLine = function (e, seat) {
        const what = e.kind === 'wonder' ? t('bench.wonder') : e.what.join(', ').replace(/_/g, ' ');
        const had = seat.decisions - e.decision + 1;
        const answer = !seat.tactical.judged ? '' : e.answeredAfter === 0 ? t('bench.answered0') : e.answeredAfter != null ? t(e.answeredAfter === 1 ? 'bench.answered1' : 'bench.answered2')
            : had < WarEval.RESPONSE_WINDOW ? t('bench.waiting', { k: had, n: WarEval.RESPONSE_WINDOW }) : t('bench.unanswered');
        const end = e.kind === 'wonder' ? '' : e.outcome === 'lost' ? t('bench.lost', { what: e.lost.join(', ').replace(/_/g, ' ') }) : e.outcome === 'held' ? t('bench.held') : t('bench.ongoing');
        return [what + (e.by ? ' ' + t('bench.by', { who: e.by }) : ''), answer, end].filter(Boolean).join(' · ');
    };
})();
