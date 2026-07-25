// ---------------------------------------------------------------------------
// Transcript analyzer — read a finished match back, turn by turn.
//
// A transcript is the only artifact that survives a match, and until now reading
// one meant writing a script. This turns it into something you can scrub: the
// graph with a playhead, a list of every turn every seat took, and for each one
// what that model was told, what it decided, why it said it decided that, and
// what the harness answered.
//
// It renders ONLY what the file attests to. No interpolation between snapshots:
// they arrive 8 to 900 seconds apart depending on the seat, and units move ~3u/s,
// so a smooth animation would be inventing up to hundreds of units of travel per
// unit per frame. A frame here is a moment the transcript vouches for, and the
// gaps are left visible because they are part of what happened — a seat that was
// asked twelve times while another answered once is the story, not a rendering
// defect to smooth over.
// ---------------------------------------------------------------------------
class TranscriptAnalyzer {
    constructor(ui) {
        this.ui = ui;
        this.reset();
    }

    reset() {
        this.header = null;      // type:"match" — the conditions
        this.results = null;     // type:"results" — absent if the match was interrupted
        this.timeline = null;    // type:"timeline" — ditto
        this.turns = [];         // every turn, chronological across all seats
        this.markers = [];       // type:"round_missed" and anything else non-turn
        this.chapters = [];      // derived: what a reader would want to jump to
        this.seats = new Map();  // playerId -> {id, seat, civ, model, name, turns:[]}
        this.filter = 'all';
        this.seatFilter = null;
        this.cursor = -1;
        this.mode = 'gathered';
        this.union = false;      // single seat = what that model could see
        this.autoCam = true;     // point the camera at the action until told not to  // its own chart mode; the results screen keeps its own
        this.fileName = null;
        this.parseErrors = 0;
    }

    // ---- loading ----------------------------------------------------------

    // Tolerant on purpose. A transcript can be truncated by a crash mid-write, and
    // JSONL exists precisely so every complete line before that still reads — so a
    // bad line is counted and skipped, never fatal. An interrupted match with no
    // results/timeline tail is a normal thing to open, not an error.
    load(text, fileName) {
        this.reset();
        this.fileName = fileName || null;
        const lines = String(text || '').split(/\r?\n/);
        for (const line of lines) {
            if (!line.trim()) continue;
            let o;
            try { o = JSON.parse(line); } catch (e) { this.parseErrors++; continue; }
            if (o.type === 'match') { this.header = o; continue; }
            if (o.type === 'results') { this.results = o; continue; }
            if (o.type === 'timeline') { this.timeline = o; continue; }
            if (o.type) { this.markers.push(o); continue; }   // round_missed and future kinds
            // A turn always carries the seat that took it — record() refuses to write one
            // without a playerId. So an object that lacks it is not a turn with fields
            // missing, it is a line that does not belong to this format: a stray "{}" in
            // a hand-edited file counted as a turn and drew one broken row where the
            // empty state belonged. Counted as unreadable, which is what it is.
            if (!o.playerId) { this.parseErrors++; continue; }
            this.turns.push(o);
        }
        // One clock for everything. Turns carry it in the state; markers carry it at the
        // top level; both measure from the timeline's origin, so they interleave without
        // conversion. `at` is the tiebreak so two events in the same second keep the
        // order they happened in.
        const secOf = (r) => (r.state && r.state.clock && typeof r.state.clock.matchSeconds === 'number')
            ? r.state.clock.matchSeconds
            : (typeof r.matchSeconds === 'number' ? r.matchSeconds : null);
        const all = this.turns.concat(this.markers);
        all.forEach(r => { r._sec = secOf(r); });
        // A transcript written before matchSeconds existed still opens: fall back to the
        // wall-clock stamp, offset from the first record so the axis starts at zero.
        const t0 = all.length ? Math.min(...all.map(r => r.at || Infinity)) : 0;
        all.forEach(r => { if (r._sec == null) r._sec = Math.max(0, Math.round(((r.at || t0) - t0) / 1000)); });
        all.sort((a, b) => (a._sec - b._sec) || ((a.at || 0) - (b.at || 0)));
        this.order = all;

        (this.header && this.header.players || []).forEach(p => {
            this.seats.set(p.id, { id: p.id, seat: p.seat, civ: p.civ, civilization: p.civ,
                                   model: p.model, name: p.name, settings: p.settings || null, turns: [] });
        });
        // A seat the header never mentioned (older transcript, or a file merged by hand)
        // still gets a row rather than having its turns vanish.
        this.order.forEach(r => {
            if (!r.playerId) return;
            if (!this.seats.has(r.playerId)) {
                this.seats.set(r.playerId, { id: r.playerId, seat: r.seat, civ: r.civ,
                    civilization: r.civ, model: r.model, name: r.name, turns: [] });
            }
            this.seats.get(r.playerId).turns.push(r);
        });

        this._carryForward();
        this._indexNodes();
        this._buildChapters();
        this.cursor = this.order.length ? 0 : -1;
        return this;
    }

    // objective and plan PERSIST across turns — "omit to keep current" — so about one
    // turn in ten carries neither while very much having both. Reading only what is on
    // the line would show a blank plan that is not blank, which is the same class of lie
    // this harness keeps having to fix elsewhere. Resolved once, per seat, in order.
    _carryForward() {
        const last = new Map();
        this.order.forEach(r => {
            if (r.type) return;                       // markers do not carry a plan
            const cur = last.get(r.playerId) || { objective: null, plan: null };
            const p = r.parsed || {};
            if (typeof p.objective === 'string' && p.objective.trim()) cur.objective = p.objective.trim();
            if (Array.isArray(p.plan) && p.plan.length) cur.plan = p.plan.slice();
            last.set(r.playerId, cur);
            r._objective = cur.objective;
            r._plan = cur.plan;
            // Whether THIS turn changed it, so the reader can see a model rewriting its
            // plan rather than only that it has one.
            r._objectiveNew = typeof p.objective === 'string' && !!p.objective.trim();
            r._planNew = Array.isArray(p.plan) && p.plan.length > 0;
        });
    }

    // What a reader would want to jump to, from the sources that already computed it:
    // the timeline's own event arrays, plus the turns where something happened that no
    // graph shows — a fight, a refusal, a skipped round.
    _buildChapters() {
        const ch = [];
        const civOf = id => {
            const s = this.seats.get(id);
            return (s && (s.name || s.model || s.civ)) || id;
        };
        const tl = this.timeline || {};
        (tl.ages || []).forEach(e => ch.push({ t: e.t, kind: 'age', icon: '⏫',
            text: `${civOf(e.id)} → ${e.age}`, id: e.id }));
        (tl.wonders || []).forEach(e => ch.push({ t: e.t, kind: 'wonder',
            icon: e.event === 'lost' ? '💥' : '🏛️',
            text: `${civOf(e.id)} wonder ${e.event}`, id: e.id }));
        (tl.exhausted || []).forEach(e => ch.push({ t: e.t, kind: 'dry', icon: '⚱',
            text: `${civOf(e.id)}: ${e.type} ran out`, id: e.id }));
        this.order.forEach((r, i) => {
            if (r.type === 'round_missed') {
                ch.push({ t: r._sec, kind: 'missed', icon: '⏱',
                    text: `${civOf(r.playerId)} missed the round`, id: r.playerId, index: i });
                return;
            }
            const b = r.state && r.state.battles;
            if (Array.isArray(b) && b.length) {
                ch.push({ t: r._sec, kind: 'battle', icon: '⚔️',
                    text: `${civOf(r.playerId)} in combat`, id: r.playerId, index: i });
            }
        });
        // Battles span many turns, so one entry per turn would bury everything else.
        // Collapse runs of the same kind+seat inside a short window into the first.
        ch.sort((a, b) => a.t - b.t);
        const out = [];
        ch.forEach(c => {
            const dup = out.find(o => o.kind === c.kind && o.id === c.id
                && (c.kind === 'battle' ? (c.t - o.t) <= 45 : c.t === o.t));
            if (!dup) out.push(c);
        });
        this.chapters = out;
    }

    // ---- the board --------------------------------------------------------

    // When each node position was FIRST seen, by whom. nearestNodes is capped (ten
    // food/wood per Town Center; stone and gold listed whole), so no single snapshot
    // holds everything a seat knew — but the union across snapshots does, and indexing
    // the first sighting lets the board reveal the map as the reader scrubs instead of
    // showing at second zero what nobody had found yet.
    //
    // Nodes are never removed once seen. A node that stops appearing may have been
    // emptied or may simply have fallen outside the nearest-N window, and the file
    // cannot tell those apart — so the board says "discovered by now", which is true,
    // rather than guessing at "still there", which would not be.
    _indexNodes() {
        this.nodeIndex = [];
        const seen = new Map();
        this.order.forEach(r => {
            if (r.type) return;
            ((r.state && r.state.nearestNodes) || []).forEach(n => {
                if (typeof n.x !== 'number' || typeof n.z !== 'number') return;
                const key = n.type + '@' + Math.round(n.x) + ',' + Math.round(n.z);
                let e = seen.get(key);
                if (!e) {
                    e = { type: n.type, x: n.x, z: n.z, firstSec: r._sec, seats: new Map() };
                    seen.set(key, e);
                    this.nodeIndex.push(e);
                }
                // WHEN each seat first saw it, not merely that it did. The right-click
                // flag asks who knew a spot at THIS moment, and a bare set answers a
                // different question — one that is true of the whole match.
                if (!e.seats.has(r.playerId)) e.seats.set(r.playerId, r._sec);
            });
        });
        this.nodeIndex.sort((a, b) => a.firstSec - b.firstSec);
    }

    // Everything to draw for one moment. `union` decides whose eyes: a single seat is
    // the honest reconstruction of what that model could see, the union is the analyst's
    // overview that no player ever had. Both are useful and they are different claims,
    // so the board says which one it is showing rather than blending them.
    scene(rec, union) {
        if (!rec) return null;
        const sec = rec._sec;
        const out = { sec, union: !!union, seats: [], nodes: [], enemies: [] };

        out.nodes = (this.nodeIndex || []).filter(n => n.firstSec <= sec && (union
            // ...and had seen it BY now, not merely at some point in the match.
            ? true : (n.seats.get(rec.playerId) != null && n.seats.get(rec.playerId) <= sec)));

        // Each seat's latest snapshot at or before this moment, with its age. Nothing is
        // moved or guessed forward: a seat last heard from 200s ago is drawn where it was
        // 200s ago and labelled as such.
        this.seats.forEach(s => {
            if (!union && s.id !== rec.playerId) return;
            let last = null;
            for (const r of s.turns) {
                if (r.type) continue;
                if (r._sec <= sec) last = r; else break;
            }
            if (!last) return;
            const st = last.state || {};
            out.seats.push({
                id: s.id, seat: s.seat, name: s.name || s.model || s.civ,
                civilization: s.civilization, ageSec: sec - last._sec,
                isCurrent: s.id === rec.playerId,
                // Its OWN epoch at its OWN last snapshot: what its buildings looked like.
                epoch: (st.epoch && st.epoch.currentEpoch) || 'stone',
                // Its own record of where it has been, so the union view can add them up.
                exploration: (st.map && st.map.exploration) || null,
                units: Array.isArray(st.friendlyUnits) ? st.friendlyUnits : [],
                buildings: Array.isArray(st.friendlyBuildings) ? st.friendlyBuildings : []
            });
        });

        // Enemies, from the selected seat only — in union mode each seat is already drawn
        // from its own snapshot, so repeating them as somebody else's sighting would
        // double the army.
        //
        // Two kinds, and the difference is the whole point. CONFIRMED is what the seat can
        // see this instant: a live position. REMEMBERED is where something was the last
        // time it was seen, which is a claim about the past — the harness already keeps
        // that for buildings (they arrive carrying visible:false, 84 of 109 in one match)
        // but not for units, so unit sightings are accumulated here: latest sighting per
        // id wins, and being seen somewhere new replaces the old place rather than adding
        // a second ghost of the same unit.
        if (!union) {
            const st = rec.state || {};
            const seat = this.seats.get(rec.playerId);
            const remembered = new Map();
            if (seat) {
                for (const r of seat.turns) {
                    if (r.type) continue;
                    if (r._sec > sec) break;
                    ((r.state && r.state.enemyUnits) || []).forEach(u => {
                        if (typeof u.x === 'number') remembered.set(String(u.id), { e: u, at: r._sec });
                    });
                }
            }
            const liveIds = new Set((st.enemyUnits || []).map(u => String(u.id)));
            (st.enemyUnits || []).forEach(u => out.enemies.push(Object.assign({}, u, { confirmed: true })));
            remembered.forEach((v, id) => {
                if (liveIds.has(id)) return;   // seen right now: already added as confirmed
                out.enemies.push(Object.assign({}, v.e, { confirmed: false, lastSeenSec: v.at }));
            });
            // Buildings carry their own confirmed flag from the harness.
            (st.enemyBuildings || []).forEach(b =>
                out.enemies.push(Object.assign({}, b, { confirmed: b.visible !== false, isBuilding: true })));
        }
        return out;
    }


    // Who knew this spot, at the moment being read. The game answers this from live
    // players' _knownResIdx and _explored, which a recorded match has none of — so the
    // spectator flag reported every square of ground as undiscovered by everyone.
    // Answered from the transcript instead, in the shape discoveryAt returns.
    discoveryAt(x, z, sec) {
        const idOf = s => ({ civ: s.civ, seat: s.seat });
        // A node first: it is the specific thing a reader right-clicks to check.
        let best = null, bestD = 6;
        (this.nodeIndex || []).forEach(n => {
            if (n.firstSec > sec) return;
            const d = Math.hypot(n.x - x, n.z - z);
            if (d < bestD) { bestD = d; best = n; }
        });
        if (best) {
            const knowers = [];
            this.seats.forEach(st => {
                const t0 = best.seats.get(st.id);
                if (t0 != null && t0 <= sec) knowers.push(idOf(st));
            });
            return { kind: 'node', res: best.type, knowers };
        }
        // Otherwise plain ground: whose exploration record covers this tile. Coarser
        // than the live game's per-cell grid because the transcript only records a
        // percentage per 7x7 tile — so this says who has been in this AREA.
        const size = (this.header && this.header.mapSize) || 800;
        const SPAN = 7, half = size / 2, tile = size / SPAN;
        const col = Math.floor((x + half) / tile), row = Math.floor((z + half) / tile);
        const key = String.fromCharCode(65 + col) + (row + 1);
        const knowers = [];
        if (col >= 0 && col < SPAN && row >= 0 && row < SPAN) {
            this.seats.forEach(st => {
                let last = null;
                for (const r of st.turns) { if (r.type) continue; if (r._sec <= sec) last = r; else break; }
                const exp = last && last.state && last.state.map && last.state.map.exploration;
                if (exp && exp[key] > 0) knowers.push(idOf(st));
            });
        }
        return { kind: 'ground', knowers };
    }

    // The wonder clock at this moment, or null. Read from the OWNER's own snapshot
    // wherever possible — it carries secondsUntilYouWin, the same countdown a rival
    // sees as secondsUntilEnemyWins — so the header shows one authoritative number
    // rather than whichever seat happened to be selected.
    wonderStatus(rec) {
        if (!rec) return null;
        const sec = rec._sec;
        let out = null;
        this.seats.forEach(st => {
            if (out && out.secs != null) return;
            let last = null;
            for (const r of st.turns) { if (r.type) continue; if (r._sec <= sec) last = r; else break; }
            const w = last && ((last.state && last.state.friendlyBuildings) || [])
                .find(b => b.wonder === true || b.isWonder === true);
            if (!w) return;
            out = { owner: st, seat: st.seat, building: w.state === 'under_construction',
                    secs: (typeof w.secondsUntilYouWin === 'number') ? w.secondsUntilYouWin : null,
                    buildSecs: (typeof w.buildSecondsRemaining === 'number') ? w.buildSecondsRemaining : null,
                    healthPct: w.healthPct, ageSec: sec - last._sec };
        });
        if (out) return out;
        // Nobody's own snapshot has one; fall back to what the selected seat can see of
        // somebody else's.
        const st2 = (rec.state && rec.state.enemyBuildings) || [];
        const e = st2.find(b => b.isWonder === true);
        if (!e) return null;
        return { owner: this.seats.get(e.owner) || null, seat: (this.seats.get(e.owner) || {}).seat,
                 building: e.state === 'under_construction',
                 secs: (typeof e.secondsUntilEnemyWins === 'number') ? e.secondsUntilEnemyWins : null,
                 buildSecs: null, healthPct: e.healthPct, ageSec: 0, seen: true };
    }
    // ---- selection -------------------------------------------------------

    visible() {
        return this.order.filter(r => {
            if (this.seatFilter && r.playerId !== this.seatFilter) return false;
            switch (this.filter) {
                case 'battles':  return !!(r.state && r.state.battles && r.state.battles.length);
                case 'rejected': return typeof r.harnessResult === 'string' && r.harnessResult.startsWith('[ERROR]');
                case 'missed':   return r.type === 'round_missed';
                case 'planned':  return !!r._planNew;
                default:         return true;
            }
        });
    }

    current() { return this.order[this.cursor] || null; }

    seek(index) {
        if (!this.order.length) return null;
        this.cursor = Math.max(0, Math.min(this.order.length - 1, index));
        return this.current();
    }

    // Nearest record at or before a point on the graph — how a click on the chart
    // becomes a selection. At-or-before rather than nearest so scrubbing never jumps
    // ahead of where the reader pointed.
    seekSeconds(sec) {
        if (!this.order.length) return null;
        let idx = 0;
        for (let i = 0; i < this.order.length; i++) {
            if (this.order[i]._sec <= sec) idx = i; else break;
        }
        return this.seek(idx);
    }

    step(delta) {
        const vis = this.visible();
        if (!vis.length) return this.current();
        const cur = this.current();
        let i = vis.indexOf(cur);
        if (i === -1) {
            // The cursor is on a record the filter hides: move to the neighbour in the
            // direction of travel rather than snapping to the top of the list.
            const at = cur ? cur._sec : 0;
            i = delta >= 0 ? vis.findIndex(r => r._sec > at) : -1;
            if (i === -1 && delta < 0) {
                for (let k = vis.length - 1; k >= 0; k--) if (vis[k]._sec < at) { i = k; break; }
            }
            if (i === -1) i = delta >= 0 ? 0 : vis.length - 1;
            return this.seek(this.order.indexOf(vis[i]));
        }
        const next = Math.max(0, Math.min(vis.length - 1, i + delta));
        return this.seek(this.order.indexOf(vis[next]));
    }


    // What this turn is ABOUT, in world coordinates — the camera's subject in auto
    // mode. Ordered by what a reader came for: a fight first, then the place the order
    // named, then that seat's Town Center, and only then the centre of mass of its
    // forces. Returns null when the snapshot shows nothing worth pointing at, which
    // leaves the camera where the reader last put it.
    cameraInterest(rec, sc) {
        if (!rec) return null;
        const st = rec.state || {};
        const b = (st.battles || [])[0];
        if (b && Array.isArray(b.at) && b.at.length === 2) return { x: b.at[0], z: b.at[1] };
        const p = (rec.parsed && rec.parsed.params) || {};
        if (typeof p.targetX === 'number' && typeof p.targetZ === 'number') {
            return { x: p.targetX, z: p.targetZ };
        }
        const mine = (sc && sc.seats || []).find(x => x.isCurrent)
            || { buildings: st.friendlyBuildings || [], units: st.friendlyUnits || [] };
        const tc = (mine.buildings || []).find(x => /town_center/i.test(x.type || ''));
        if (tc) return { x: tc.x, z: tc.z };
        const us = mine.units || [];
        if (us.length) {
            return { x: us.reduce((n, u) => n + u.x, 0) / us.length,
                     z: us.reduce((n, u) => n + u.z, 0) / us.length };
        }
        return null;
    }
    // ---- derived readings -------------------------------------------------

    // How stale every OTHER seat is at the selected moment. The honest answer to "what
    // did the board look like here": one seat is current and the rest were last heard
    // from some seconds ago, which is a fact about the match, not a gap to paper over.
    staleness(rec) {
        if (!rec) return [];
        const out = [];
        this.seats.forEach(s => {
            let last = null;
            for (const r of s.turns) { if (r._sec <= rec._sec && !r.type) last = r; else if (r._sec > rec._sec) break; }
            out.push({ seat: s, last, ageSec: last ? (rec._sec - last._sec) : null,
                       isCurrent: s.id === rec.playerId });
        });
        return out.sort((a, b) => (a.seat.seat || 0) - (b.seat.seat || 0));
    }

    durationSec() {
        if (this.order.length) return this.order[this.order.length - 1]._sec;
        const s = this.timeline && this.timeline.samples;
        return (s && s.length) ? s[s.length - 1].t : 0;
    }

    // The seat list for the shared chart renderer, which reads only {id, seat, civilization}.
    chartPlayers() { return [...this.seats.values()]; }

    stats() {
        const perSeat = [...this.seats.values()].map(s => {
            const turns = s.turns.filter(r => !r.type);
            const missed = s.turns.filter(r => r.type === 'round_missed').length;
            const rejected = turns.filter(r => typeof r.harnessResult === 'string'
                && r.harnessResult.startsWith('[ERROR]')).length;
            const lat = turns.map(r => r.latencyMs || 0).filter(x => x > 0);
            return { seat: s, turns: turns.length, missed, rejected,
                     avgLatency: lat.length ? lat.reduce((a, b) => a + b, 0) / lat.length : 0 };
        });
        return { perSeat, total: this.turns.length, markers: this.markers.length,
                 parseErrors: this.parseErrors, duration: this.durationSec() };
    }
}
