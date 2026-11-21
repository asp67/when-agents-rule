// Moments on screen (overhaul step B2): the reel of the match's heaviest moments on the
// results screen, each with the decision behind it and a way to watch it.
//
// Watching a moment is the re-simulated Playback in the analyzer: the real 3-D picture,
// from the worker and its keyframes, for a match the analyzer can play again.
//
// There is no replay in a corner during the match. One renderer draws one world, and
// while a match runs that is the live one. A top-down picture of dots was tried in its
// place (build 1168) and taken out again (build 1172): it was not a replay. A real one
// needs a second renderer (overhaul step B3).
(function () {
    if (typeof UIManager === 'undefined') return;
    const P = UIManager.prototype;
    const clock = sec => Math.floor(sec / 60) + ':' + String(Math.floor(sec) % 60).padStart(2, '0');

    // The match in its heaviest moments: what happened, the decision behind it where one
    // is found, and the way to watch it. Built from the chronicle and the ledger
    // (js/eval/moments.js).
    P.reelMoments = function () {
        const ch = this.chronicle, ledger = this.evalLedger ? this.evalLedger() : null;
        if (!ch || !ch.entries || typeof WarMoments === 'undefined') return [];
        return WarMoments.pick(ch.entries, 5).map(m => Object.assign(m, { cause: ledger ? WarMoments.causeOf(m, ledger.seats, ch.entries) : null }));
    };
    P.updateSummaryReel = function () {
        const el = document.getElementById('summaryReel'), sum = document.getElementById('arenaSummaryScreen');
        if (!el || !sum) return;
        const snapshot = sum.classList.contains('snapshot'), list = snapshot ? [] : this.reelMoments();
        el.style.display = list.length ? '' : 'none';
        if (!list.length) { el.innerHTML = ''; return; }
        const esc = s => this.escapeHtml(String(s == null ? '' : s)), ledger = this.evalLedger();
        const canWatch = this.summaryCanOpen && this.summaryCanOpen();
        const nameOf = id => { const s = ledger && ledger.seats.get(id); return (s && (s.name || s.model)) || id; };
        el.innerHTML = `<div class="bench-head">${esc(t('reel.title'))}<span>${esc(t('reel.sub'))}</span></div><ol class="reel-list">` + list.map((m, i) => {
            const c = m.cause;
            const why = c ? t('reel.cause', { who: nameOf(c.id), turn: c.turn, time: clock(c.sec), order: tg(String(c.action).replace(/_/g, ' ')) + (c.name ? ' (' + tg(String(c.name).replace(/_/g, ' ')) + ')' : '') }) : t('reel.noCause');
            return `<li><span class="reel-time">${clock(m.start)}</span><span class="reel-what">${this.chronicleText(m.event)}</span>`
                + `<span class="reel-why${c ? '' : ' is-none'}">${esc(why)}</span>`
                + (canWatch ? `<button class="test-btn" onclick="game.ui.watchMoment(${i})" title="${esc(t('reel.watchTip'))}">${esc(t('reel.watch'))}</button>` : '') + '</li>';
        }).join('') + '</ol>';
        this._reel = list;
    };
    // Open a moment of the finished match in the analyzer: the re-simulated Playback a few
    // seconds before it where the match can be played again, the recorded decisions at
    // that time where it cannot. Leaves the results screen, as the Analyzer button does.
    P.watchMoment = async function (i) {
        const m = (this._reel || [])[i];
        if (!m || !this.summaryCanOpen || !this.summaryCanOpen()) return;
        const sec = Math.max(0, m.start - 5);
        await this.watchInAnalyzer();
        this.anApplyMoment({ t: sec });
        const a = this.analyzer;
        if (!a || !a.inputs || !a.inputs.length) return;
        // The analyzer's own answer to "can this be played again" (a word when it cannot).
        const why = await this.anResimCheck();
        const step = typeof why === 'string' ? null : this.anResimStepAtSec(sec, a);
        if (step != null) return this.anResimStart(step);
    };
})();
