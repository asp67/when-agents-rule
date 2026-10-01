// ---------------------------------------------------------------------------
// The match chronicle (review #11): what happened, as a spectator would tell it.
//
// It READS the match and changes nothing: no rule calls it, and it keeps its own
// bookkeeping, so the rules and their hash are untouched. Every source is the game's
// own record of the thing, never a second definition of it:
//
//   contact     two seats meet: a rival enters a seat's _metRivals, the set the
//               harness already keeps for "who has this seat discovered"
//   clash       a new engagement in the battle ledger (game._battles)
//   battle      that engagement going quiet (Game.BATTLE_QUIET_MS without a blow),
//               with each side's involvement and losses as the ledger counted them
//   building    a building lost, from the loss record the destroy path keeps
//               (owner._lostBuildings), with who destroyed it; a Town Center and a
//               Wonder are their own kinds
//   age         a seat reaching a new age
//   wonder      raised, and its hold counting down (120/60/30/10 s left)
//   elimination a seat eliminated
//   speed/pause the tempo as the spectator set it
//
// Each entry carries the match clock (seconds), the seats it concerns, a place where
// it has one, and a weight (1 detail, 2 notable, 3 decisive). The spectator view shows
// captions from it when the viewer turns captions on; the transcript records every
// entry as a `chronicle` line, apart from the turns.
// ---------------------------------------------------------------------------
class MatchChronicle {
    constructor(game) {
        this.game = game;
        this.listeners = new Set();
        this.reset();
    }

    static get COUNTDOWN() { return [120, 60, 30, 10]; }

    reset() {
        this.entries = [];
        this._met = new Set();
        this._battles = new Map();      // ledger entry -> { clash: bool, done: bool }
        this._losses = new WeakSet();   // loss records already told
        this._ages = new Map();
        this._eliminated = new Set();
        this._wonders = new WeakMap();  // wonder building -> { raised, stage }
        this._speed = null;
        this._paused = null;
        this._started = false;
        this._closed = false;
    }

    subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

    seconds() {
        const g = this.game, h = g.openAIAIManager;
        if (h && typeof h.matchSecondsNow === 'function') return h.matchSecondsNow();
        return Math.round(((g.clock && g.clock.matchMs) || 0) / 1000);
    }

    // `t` is the match clock, which stands still while paused; `at` is the wall clock a
    // video of the match runs on, which does not.
    emit(kind, fields, weight = 1) {
        const e = Object.assign({ type: 'chronicle', kind, t: this.seconds(), at: Date.now(), weight }, fields);
        this.entries.push(e);
        try {
            const tr = this.game.openAIAIManager && this.game.openAIAIManager.transcripts;
            if (tr && tr.matchId && tr.noteMatch) tr.noteMatch(e);
        } catch (err) { /* the chronicle never costs the match anything */ }
        this.listeners.forEach(fn => { try { fn(e); } catch (err) { /* a listener's problem stays its own */ } });
        return e;
    }

    // What is already so at the start is the starting position, not news.
    baseline() {
        const g = this.game, ais = (g.aiManager && g.aiManager.aiPlayers) || [];
        ais.forEach(ai => {
            this._ages.set(ai.id, ai.age);
            (ai._metRivals || []).forEach(k => this._met.add([ai.id, k].sort().join('|')));
            (ai._lostBuildings || []).forEach(l => this._losses.add(l));
            if (ai._eliminated) this._eliminated.add(ai.id);
        });
        (g._battles || []).forEach(b => this._battles.set(b, { clash: true, done: false }));
        this._speed = g.simSpeed || 1;
        this._paused = g.pauseState === 'paused';
        this._started = true;
    }

    update() {
        const g = this.game;
        if (!g || !g.aiManager) return;
        // The step that ends a match is the one with the most to tell (the last Town
        // Center, the elimination): one more pass after the end, then nothing.
        if (!g.gameStarted) { if (!this._started || this._closed) return; this._closed = true; }
        if (!this._started) { this.baseline(); return; }
        const ais = g.aiManager.aiPlayers || [];
        const byLabel = new Map(ais.map(ai => [g.seatLabel ? g.seatLabel(ai) : ai.id, ai.id]));

        // Tempo first: a pause explains everything that does not happen after it.
        const paused = g.pauseState === 'paused';
        if (paused !== this._paused) { this._paused = paused; this.emit(paused ? 'pause' : 'resume', { seats: [] }, 1); }
        const speed = g.simSpeed || 1;
        if (speed !== this._speed) { this._speed = speed; this.emit('speed', { seats: [], speed }, 1); }

        // Contact, once per pair, whoever saw whom first.
        ais.forEach(ai => (ai._metRivals || []).forEach(k => {
            const pair = [ai.id, k].sort().join('|');
            if (this._met.has(pair)) return;
            this._met.add(pair);
            this.emit('contact', { seats: [ai.id, k] }, 2);
        }));

        // Engagements: announced when they open with two sides in them, told in full
        // when they go quiet. An entry that vanishes before it went quiet was merged
        // into another, which carries its story on.
        const now = g.simNow ? g.simNow() : 0, quiet = (g.constructor && g.constructor.BATTLE_QUIET_MS) || 10000;
        const live = new Set(g._battles || []);
        for (const b of live) {
            let st = this._battles.get(b);
            if (!st) this._battles.set(b, st = { clash: false, done: false });
            const sides = Object.keys(b.sides || {});
            if (!st.clash && sides.length >= 2) {
                st.clash = true;
                this.emit('clash', { seats: sides, x: Math.round(b.x), z: Math.round(b.z) }, 1);
            }
            if (!st.done && st.clash && now - b.lastAt > quiet) {
                st.done = true;
                const tally = {};
                let lost = 0;
                sides.forEach(id => {
                    const s = b.sides[id];
                    const involved = Object.values(s.involved || {}).reduce((a, t) => a + (t.ids ? t.ids.size : 0), 0);
                    const l = Object.values(s.lost || {}).reduce((a, n) => a + n, 0);
                    lost += l;
                    tally[id] = { involved, lost: l };
                });
                this.emit('battle', { seats: sides, x: Math.round(b.x), z: Math.round(b.z), sides: tally,
                    seconds: Math.round((b.lastAt - b.startedAt) / 1000) }, lost >= 10 ? 3 : lost >= 3 ? 2 : 1);
            }
        }
        for (const b of [...this._battles.keys()]) if (!live.has(b)) this._battles.delete(b);

        ais.forEach(ai => {
            // Losses, from the destroy path's own record, with who did it.
            (ai._lostBuildings || []).forEach(l => {
                if (this._losses.has(l)) return;
                this._losses.add(l);
                const by = l.to ? byLabel.get(l.to) || null : null;
                const kind = l.wonder ? 'wonder-lost' : l.type === 'town_center' ? 'town-center-lost' : 'building-lost';
                this.emit(kind, { seats: by ? [ai.id, by] : [ai.id], building: l.type, by, x: l.x, z: l.z },
                    kind === 'building-lost' ? 1 : 3);
            });
            // Ages.
            if (this._ages.get(ai.id) !== ai.age) {
                this._ages.set(ai.id, ai.age);
                this.emit('age', { seats: [ai.id], age: ai.age }, 2);
            }
            // Wonders: raised, then counted down.
            const required = g.wonderRequired || 600;
            (ai.buildings || []).forEach(b => {
                if (!b.isWonder || b.underConstruction || b.health <= 0) return;
                let w = this._wonders.get(b);
                if (!w) {
                    this._wonders.set(b, w = { stage: -1 });
                    this.emit('wonder-raised', { seats: [ai.id], building: b.type, x: Math.round(b.x), z: Math.round(b.z), required }, 3);
                }
                const left = required - (ai._wonderHold || 0) / 1000 / (g.wonderPace || 1);
                const stage = MatchChronicle.COUNTDOWN.filter(s => left <= s).length - 1;
                if (stage > w.stage) {
                    w.stage = stage;
                    this.emit('wonder-countdown', { seats: [ai.id], seconds: MatchChronicle.COUNTDOWN[stage] }, 3);
                }
            });
            // Eliminations.
            if (ai._eliminated && !this._eliminated.has(ai.id)) {
                this._eliminated.add(ai.id);
                this.emit('elimination', { seats: [ai.id] }, 3);
            }
        });
    }
}

if (typeof module !== 'undefined' && module.exports) module.exports = MatchChronicle;
