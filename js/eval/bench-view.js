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
    const GLYPH = { acted: '✓', pending: '○', dropped: '✕', late: '◐', uncheckable: '·' };
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
        : key === 'follow' ? (s.follow.judged ? (s.follow.acted || 0) + (s.follow.dropped || 0) : 0)
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
    // third, which exists in broadcast mode only.
    P.wireBenchKey = function () {
        if (this._benchKeyWired) return;
        this._benchKeyWired = true;
        document.addEventListener('keydown', e => {
            const key = String(e.key || '').toLowerCase();
            if ((key !== 'b' && key !== 'r' && key !== 'c') || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
            const el = e.target;
            if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
            if (!this.game.spectatorMode || !this.game.gameStarted) return;
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

    P.benchLedger = function () { return this.evalLedger(); };
    // A seat's decision in the transcript viewer: where every list in this view leads.
    P.openTranscriptTurn = function (playerId, turn) {
        if (turn == null) return;
        this._transcriptFor = playerId;
        this._tvWindowEnd = turn; this._tvPinned = turn; this._tvRendered = null;
        this.renderTranscriptViewer();
        this.updateSpectatorPlayerList();
        if (this.tvJumpTo) this.tvJumpTo(turn);
    };
    // Up to two seats' plans side by side; picking a third lets the oldest go.
    P.benchPin = function (id) {
        const pins = this._benchSeats || (this._benchSeats = []);
        const at = pins.indexOf(id);
        if (at >= 0) pins.splice(at, 1); else { pins.push(id); if (pins.length > 2) pins.shift(); }
        this._benchSig = null;
        this.updateBenchView();
        this.updateSummaryProfile();
    };
    // A decision named in an evidence list, opened where it can be read. While a match
    // runs that is the transcript panel; from the results card over a running match the
    // card closes first; after the end the transcript opens in the analyzer at that seat's
    // decision, which leaves the results screen as the Analyzer button does.
    P.benchOpenTurn = function (playerId, turn) {
        if (turn == null) return;
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
        const snapshot = sum.classList.contains('snapshot'), ev = this._benchEvidence;
        const link = snapshot ? 'bench.open' : this.summaryCanOpen() ? 'sum.openAnalyzer' : null;
        const sig = [ledger.lines + '.' + ledger.rev, typeof getUiLang === 'function' ? getUiLang() : '', (this._benchSeats || []).join(','), ev ? ev.key + ev.id : '', link].join(':');
        if (sig === this._sumProfileSig) return;
        this._sumProfileSig = sig;
        el.innerHTML = this.benchHtml(ledger, { link }).right + `<p class="summary-profile-note">${this.escapeHtml(t('sum.profileNote'))}</p>`;
    };
    P.benchShowEvidence = function (key, id) {
        const cur = this._benchEvidence;
        this._benchEvidence = cur && cur.key === key && cur.id === id ? null : { key, id };
        this._benchSig = null;
        this.updateBenchView();
        this.updateSummaryProfile();
    };

    P.updateBenchView = function () {
        const left = document.getElementById('benchLeft'), right = document.getElementById('benchMatrix');
        if (!left || !right || !this.benchOn()) return;
        this.benchPlace();
        const ledger = this.benchLedger(), ev = this._benchEvidence;
        const sig = [ledger ? ledger.lines + '.' + ledger.rev : -1, typeof getUiLang === 'function' ? getUiLang() : '', (this._benchSeats || []).join(','), ev ? ev.key + ev.id : ''].join(':');
        if (sig === this._benchSig) return;
        this._benchSig = sig;
        const view = this.benchHtml(ledger);
        left.innerHTML = view.left; right.innerHTML = view.right;
    };

    // The two panels as markup. Apart from the page it is given, it reads nothing but the ledger.
    // `link` is the tooltip key of what a click on a decision does here, or null where it can do nothing.
    P.benchHtml = function (ledger, { link = 'bench.open' } = {}) {
        const esc = s => this.escapeHtml(String(s == null ? '' : s)), ev = this._benchEvidence;
        const profile = ledger ? ledger.profile() : null;
        const seats = profile ? profile.seats.filter(s => s.decisions > 0) : [];
        if (!seats.length) {
            const none = `<div class="bench-head">${esc(t('bench.matrix'))}</div><p class="bench-none">${esc(t('bench.none'))}</p>`;
            return { left: `<div class="bench-head">${esc(t('bench.plan'))}</div><p class="bench-none">${esc(t('bench.none'))}</p>`, right: none };
        }
        const now = ledger.lastSec || 0;
        const past = now >= TREND_SEC + 60 ? ledger.profileAt(now - TREND_SEC) : null;
        const then = (id, key) => { const s = past && past.seats.find(x => x.id === id); return s && s[key] ? s[key].score : null; };
        const ink = s => this.legibleColor ? this.legibleColor(this.identityHex ? this.identityHex(s.id, s.civ, s.seat) : '#cccccc') : '#cccccc';
        const dot = s => this.teamDotHtml ? this.teamDotHtml(s.seat, 10) : '';
        const label = s => esc(s.name || s.model || s.id);
        const open = (s, turn) => turn == null || !link ? '' : ` onclick="event.stopPropagation(); game.ui.benchOpenTurn('${esc(s.id)}', ${Number(turn)})" title="${esc(t(link))}"`;
        let pins = (this._benchSeats || []).filter(id => seats.some(s => s.id === id));
        if (!pins.length) pins = [(seats.find(s => s.planning.standing) || seats[0]).id];

        // ---- the matrix ------------------------------------------------------
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
        let right = `<div class="bench-head">${esc(t('bench.matrix'))}<span>${esc(t('eval.provisional'))}</span></div>`
            + `<table class="bm"><thead><tr><th></th>` + seats.map(s =>
                `<th scope="col" class="bm-seat${pins.includes(s.id) ? ' is-pinned' : ''}" style="--civ:${esc(ink(s))}" onclick="game.ui.benchPin('${esc(s.id)}')" title="${esc(t('bench.pin'))}">${dot(s)}<span>${label(s)}</span></th>`).join('')
            + `</tr></thead><tbody>${rows}<tr class="bm-indexrow"><th scope="row">${esc(t('eval.index'))}</th>${index}</tr>`
            + `<tr class="bm-costrow"><th scope="row">${esc(t('bench.range'))}<small>${esc(t('bench.rangeUnit'))}</small></th>${range}</tr>`
            + `<tr class="bm-costrow"><th scope="row">${esc(t('bench.eff'))}</th>${cost}</tr></tbody></table>`;

        // What a cell rests on: the decisions behind it, each a way into the transcript.
        const seatOf = id => seats.find(s => s.id === id);
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

        // ---- the plan tracker ------------------------------------------------
        let left = `<div class="bench-head">${esc(t('bench.plan'))}</div>` + pins.map(id => {
            const s = seatOf(id), pl = s.planning, fl = s.follow;
            const head = `<h4>${dot(s)}<span>${label(s)}</span>`;
            if (!pl.standing) return `<section class="bp-seat" style="--civ:${esc(ink(s))}">${head}</h4><p class="bench-none">${esc(t('bench.noPlan'))}</p></section>`;
            const steps = (fl.standing || pl.standing.steps.map(x => ({ text: x.text, state: x.checkable ? 'pending' : 'uncheckable', after: null })));
            const closed = fl.judged ? fl.acted + fl.dropped : null;
            // Where on the match's clock the plan was changed.
            const ticks = pl.history.map(h => h.sec != null && now > 0 ? `<i style="left:${Math.min(100, 100 * h.sec / now).toFixed(1)}%"></i>` : '').join('');
            return `<section class="bp-seat" style="--civ:${esc(ink(s))}">${head}${closed ? `<em>${esc(t('bench.acted', { acted: fl.acted, closed }))}</em>` : ''}</h4>`
                + (pl.standing.objective ? `<p class="bp-objective">${esc(pl.standing.objective)}</p>` : '')
                + `<p class="bp-age"${open(s, pl.standing.turn)}>${esc(t('bench.planAge', { time: clock(pl.standing.sec), n: s.decisions - pl.standing.since }))}</p>`
                + `<ol class="bp-steps">` + steps.map(x => `<li class="is-${x.state}" title="${esc(t('bench.st.' + x.state))}"><i>${GLYPH[x.state]}</i><span>${esc(x.text)}</span>`
                    + (x.state === 'acted' && x.after ? `<small>+${x.after}</small>` : '') + '</li>').join('') + '</ol>'
                + `<div class="bp-ribbon" title="${esc(t('bench.ribbon', { n: pl.history.length }))}">${ticks}</div></section>`;
        }).join('');

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
