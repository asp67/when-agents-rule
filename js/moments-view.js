// Moments on screen (overhaul step B2): the replay of a fight in a corner while the match
// goes on, and the reel of the match's heaviest moments on the results screen.
//
// The corner replay is a tactical one: a small top-down picture of the fight, played back
// from positions taped while it was fought (a few seconds of dots in the seats' colours,
// a cross where a unit fell). It is not the 3-D picture: one renderer draws one world, and
// the world on screen is the live one. The 3-D footage of a moment is the re-simulated
// Playback, which the reel opens at that moment, for a match the analyzer can play again.
//
// Like every overlay here: off until asked for (the Replay button in the bar, the icon on
// the broadcast board, or P), remembered, and it changes nothing in the match.
(function () {
    if (typeof UIManager === 'undefined') return;
    const P = UIManager.prototype;
    const TAPE = { everyMs: 250, keepMs: 45000, radius: 55, showMs: 9000, speed: 2.5, w: 300, h: 190 };
    const clock = sec => Math.floor(sec / 60) + ':' + String(Math.floor(sec) % 60).padStart(2, '0');

    P.replaysOn = function () { return !!this.viewPreferences().replays; };
    P.toggleReplays = function (on = !this.replaysOn()) {
        this.viewPreferences().replays = !!on;
        this.saveViewPreferences();
        const btn = document.getElementById('replayBtn');
        if (btn) { btn.classList.toggle('sb-on', !!on); btn.setAttribute('aria-pressed', on ? 'true' : 'false'); }
        if (!on) this.closeReplay();
        if (this.broadcastOn && this.broadcastOn() && this.renderBroadcast) this.renderBroadcast();
    };

    // ---- taping ------------------------------------------------------------------
    // While a fight is on, where every unit near it stands, four times a second. One tape
    // per fight (the game's own battle ledger says which are live); a tape is dropped when
    // its fight has been over for a while and nobody asked for it.
    P.tapeFights = function (now = Date.now()) {
        const g = this.game, tapes = this._tapes || (this._tapes = new Map());
        if (!this.replaysOn() || !g.gameStarted) { tapes.clear(); return 0; }
        const sim = g.simNow ? g.simNow() : 0, quiet = (g.constructor && g.constructor.BATTLE_QUIET_MS) || 10000;
        const live = (g._battles || []).filter(b => sim - b.lastAt <= quiet && Object.keys(b.sides || {}).length >= 2);
        const ais = (g.aiManager && g.aiManager.aiPlayers) || [];
        for (const b of live) {
            let tape = tapes.get(b);
            if (!tape) tapes.set(b, tape = { x: b.x, z: b.z, frames: [], seen: new Map(), born: now });
            tape.x = b.x; tape.z = b.z; tape.at = now;
            const dots = [];
            for (const ai of ais) for (const u of ai.units || []) {
                if (!(u.health > 0) || Math.abs(u.x - b.x) > TAPE.radius || Math.abs(u.z - b.z) > TAPE.radius) continue;
                dots.push([u.id, ai.id, Math.round(u.x * 10) / 10, Math.round(u.z * 10) / 10]);
                tape.seen.set(u.id, { owner: ai.id, x: u.x, z: u.z });
            }
            tape.frames.push({ t: now, dots });
            while (tape.frames.length && now - tape.frames[0].t > TAPE.keepMs) tape.frames.shift();
        }
        for (const [b, tape] of tapes) if (!live.includes(b) && now - tape.at > 15000) tapes.delete(b);
        return live.length;
    };
    // The chronicle reports a fight when it is over. A decisive one (the chronicle's own
    // weight, two or more) is shown again from its tape, the nearest one to where it was.
    P.replayBattle = function (e, now = Date.now()) {
        if (!this.replaysOn() || !e || e.kind !== 'battle' || (e.weight || 0) < 2 || !this._tapes) return false;
        let best = null, dist = 40;
        for (const tape of this._tapes.values()) {
            const d = Math.hypot(tape.x - e.x, tape.z - e.z);
            if (d <= dist && tape.frames.length >= 4) { best = tape; dist = d; }
        }
        if (!best) return false;
        this._replay = { tape: { x: best.x, z: best.z, frames: best.frames.slice(), seen: new Map(best.seen) }, event: e, started: now };
        this.drawReplay(now);
        return true;
    };
    P.closeReplay = function () {
        this._replay = null;
        const el = document.getElementById('replayCorner');
        if (el) el.remove();
    };

    // ---- the corner ---------------------------------------------------------------
    // Where the tape stands at a moment of the showing: it plays faster than it was fought
    // and holds its last frame until the corner closes.
    P.replayFrameAt = function (rp, now) {
        const f = rp.tape.frames, span = f[f.length - 1].t - f[0].t;
        const at = f[0].t + Math.min(span, (now - rp.started) * TAPE.speed);
        let i = 0;
        while (i < f.length - 1 && f[i + 1].t <= at) i++;
        return { frame: f[i], index: i, done: at >= f[f.length - 1].t };
    };
    P.drawReplay = function (now = Date.now()) {
        const rp = this._replay;
        if (!rp) return;
        if (now - rp.started > TAPE.showMs || !this.replaysOn() || !this.game.gameStarted) { this.closeReplay(); return; }
        let el = document.getElementById('replayCorner');
        if (!el) {
            el = document.createElement('div');
            el.id = 'replayCorner'; el.className = 'replay-corner';
            el.innerHTML = '<div class="replay-head"></div><canvas width="' + TAPE.w + '" height="' + TAPE.h + '"></canvas>';
            document.body.appendChild(el);
            const e = rp.event, seat = id => this.chronicleSeatHtml(id);
            const lost = Object.keys(e.sides || {}).map(id => seat(id) + ' ' + this.escapeHtml(t('replay.lost', { n: e.sides[id].lost || 0 }))).join(' · ');
            el.firstChild.innerHTML = '<b>' + this.escapeHtml(t('replay.title', { time: clock(Math.max(0, (e.t || 0) - (e.seconds || 0))) })) + '</b><span>' + lost + '</span>';
        }
        const canvas = el.querySelector('canvas'), ctx = canvas && canvas.getContext ? canvas.getContext('2d') : null;
        if (!ctx) return;
        const { frame, index } = this.replayFrameAt(rp, now);
        const ais = (this.game.aiManager && this.game.aiManager.aiPlayers) || [];
        const ink = id => { const ai = ais.find(a => a.id === id); return ai ? this.identityHex(ai.id, ai.civilization, ai.seat) : '#cfd8e3'; };
        const R = TAPE.radius, sx = x => (x - rp.tape.x + R) / (2 * R) * TAPE.w, sz = z => (z - rp.tape.z + R) / (2 * R) * TAPE.h;
        ctx.clearRect(0, 0, TAPE.w, TAPE.h);
        ctx.fillStyle = '#2f3a2c'; ctx.fillRect(0, 0, TAPE.w, TAPE.h);
        // Those who stood in an earlier frame and are gone from this one fell: a cross where they last stood.
        const here = new Set(frame.dots.map(d => d[0]));
        ctx.lineWidth = 2;
        const fallen = new Map();
        for (let k = 0; k <= index; k++) for (const d of rp.tape.frames[k].dots) if (!here.has(d[0])) fallen.set(d[0], d);
        for (const d of fallen.values()) {
            const x = sx(d[2]), y = sz(d[3]);
            ctx.strokeStyle = ink(d[1]); ctx.globalAlpha = 0.75;
            ctx.beginPath(); ctx.moveTo(x - 4, y - 4); ctx.lineTo(x + 4, y + 4); ctx.moveTo(x + 4, y - 4); ctx.lineTo(x - 4, y + 4); ctx.stroke();
        }
        ctx.globalAlpha = 1;
        for (const d of frame.dots) {
            ctx.fillStyle = ink(d[1]); ctx.strokeStyle = 'rgba(0,0,0,0.7)'; ctx.lineWidth = 1;
            ctx.beginPath(); ctx.arc(sx(d[2]), sz(d[3]), 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        }
    };

    // ---- the reel -----------------------------------------------------------------
    // The match in its heaviest moments, on the results screen: what happened, the decision
    // behind it where one is found, and the way to watch it. Built from the chronicle and
    // the ledger (js/eval/moments.js).
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
    // seconds before it where the match re-simulates, the recorded decisions at that time
    // where it does not. Leaves the results screen, as the Analyzer button does.
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
