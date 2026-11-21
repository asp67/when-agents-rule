// WarEval -- the evaluation ledger (overhaul step C1).
//
// What a model did, read from the transcript and from nothing else: the same lines,
// whether they arrive one at a time from a match in progress or from a file afterwards.
// That rule is what keeps a number shown live and a number published later from ever
// disagreeing, and it is why nothing in here reaches into the game or the harness. If
// it is not in the record, it is not scored.
//
// A ledger keeps a small digest of every decision and works the profile out on request.
// Every figure of a seat comes from that seat's own lines in the order it wrote them, so
// the order in which different seats' lines arrive changes nothing: a file lists one
// seat after another, a live match interleaves them, and both give the same profile.
//
// This step fills two parts of the profile:
//   grounding    were the commands valid when they were issued?
//   efficiency   what did a decision cost? Shown beside the profile, never inside it.
(function (root) {
    'use strict';
    const WarEval = {
        VERSION: 1,
        // How raw rates become 0-100. 'v0' is the mapping proposed with the plan, stated
        // so it can be argued with; calibration against anchors is a later step (C6).
        SCALE: 'v0',
        // A mistake made again inside this many decisions counts as repeated.
        REPEAT_WINDOW: 2,
    };

    // Lines about a seat that are not decisions. `input` lines name a seat too, but they
    // are the replay's record of what the engine was told, not something the model did.
    const SEAT_MARKERS = new Set(['round_missed', 'request_failed', 'request_cancelled', 'final_word']);
    // The harness's verdicts (OpenAIAIManager.verdictFor). Only the first three are the
    // model's own doing: `contended` was refused on something no state could have warned
    // of, `harnessFault` is the harness failing on a valid command.
    const VERDICTS = ['ok', 'avoidable', 'invalid', 'contended', 'harnessFault'];

    const num = v => (typeof v === 'number' && Number.isFinite(v)) ? v : null;
    const clamp01 = x => Math.max(0, Math.min(1, x));
    function quantile(values, q) {
        if (!values.length) return null;
        const s = values.slice().sort((a, b) => a - b);
        const i = (s.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
        return s[lo] + (s[hi] - s[lo]) * (i - lo);
    }
    const sum = values => values.reduce((a, b) => a + b, 0);

    function commandsOf(parsed) {
        if (!parsed || typeof parsed !== 'object') return 0;
        if (Array.isArray(parsed.commands)) return parsed.commands.length;
        return parsed.action ? 1 : 0;       // the single-command reply of early builds
    }

    class Ledger {
        constructor() {
            this.match = null;
            this.seats = new Map();          // playerId -> { id, seat, civ, model, name, turns: [], markers: {} }
            this.lines = 0;
            this.unreadable = 0;
        }

        _seat(o) {
            let s = this.seats.get(o.playerId);
            if (!s) {
                s = { id: o.playerId, seat: null, civ: null, model: null, name: null, turns: [], markers: {} };
                this.seats.set(o.playerId, s);
            }
            if (s.seat == null && o.seat != null) s.seat = o.seat;
            if (s.civ == null && (o.civ || o.civilization)) s.civ = o.civ || o.civilization;
            if (s.model == null && o.model) s.model = o.model;
            if (s.name == null && o.name) s.name = o.name;
            return s;
        }

        // One transcript line as text. A line that does not parse is counted and skipped:
        // a file cut short by a crash still reads up to the cut.
        addLine(text) {
            const line = String(text == null ? '' : text).trim();
            if (!line) return;
            let o;
            try { o = JSON.parse(line); } catch (e) { this.unreadable++; return; }
            this.add(o);
        }

        // One transcript record, already parsed.
        add(o) {
            if (!o || typeof o !== 'object') return;
            this.lines++;
            if (o.type === 'match') {
                this.match = { matchId: o.matchId || null, build: o.build != null ? o.build : null,
                    promptVersion: o.promptVersion || null };
                for (const p of o.players || []) if (p && p.id) this._seat({ playerId: p.id, seat: p.seat, civ: p.civ, model: p.model, name: p.name });
                return;
            }
            if (o.type) {
                if (!o.playerId || !SEAT_MARKERS.has(o.type)) return;
                const s = this._seat(o);
                s.markers[o.type] = (s.markers[o.type] || 0) + 1;
                return;
            }
            if (!o.playerId) return;         // not a line of this format
            const tokens = o.tokens && typeof o.tokens === 'object' ? o.tokens : null;
            const clock = o.state && o.state.clock;
            this._seat(o).turns.push({
                turn: num(o.turn),
                sec: clock ? num(clock.matchSeconds) : null,
                latencyMs: num(o.latencyMs) > 0 ? o.latencyMs : null,
                prompt: tokens ? num(tokens.prompt) : null,
                completion: tokens ? num(tokens.completion) : null,
                commands: commandsOf(o.parsed),
                // One { n, action, code, verdict } per command, written by the harness
                // from build 1023 on. Absent means nobody recorded what happened.
                outcomes: Array.isArray(o.outcomes) ? o.outcomes.map(x => ({ code: x && x.code != null ? String(x.code) : null,
                    verdict: x && VERDICTS.includes(x.verdict) ? x.verdict : 'unknown' })) : null
            });
        }

        // Were the commands valid when they were issued?
        _grounding(turns) {
            const count = { ok: 0, avoidable: 0, invalid: 0, contended: 0, harnessFault: 0, unknown: 0 };
            const codes = new Map();
            let unjudged = 0, repeated = 0;
            const before = [];               // the mistakes of the last decisions, newest last
            for (const t of turns) {
                const mine = [];
                if (!t.outcomes) unjudged += t.commands;
                else {
                    unjudged += Math.max(0, t.commands - t.outcomes.length);
                    for (const x of t.outcomes) {
                        count[x.verdict]++;
                        if (x.verdict !== 'avoidable' && x.verdict !== 'invalid') continue;
                        codes.set(x.code, (codes.get(x.code) || 0) + 1);
                        if (before.some(prev => prev.includes(x.code))) repeated++;
                        mine.push(x.code);
                    }
                }
                before.push(mine);
                if (before.length > WarEval.REPEAT_WINDOW) before.shift();
            }
            // What the model could have got right: contended commands and the harness's
            // own failures leave both sides, as they do in the match results.
            const mistakes = count.avoidable + count.invalid, judged = count.ok + mistakes;
            const rate = judged ? count.ok / judged : null;
            return {
                judged, ok: count.ok, avoidable: count.avoidable, invalid: count.invalid,
                contended: count.contended, harnessFault: count.harnessFault, unjudged,
                rate, repeated, repeatRate: mistakes ? repeated / mistakes : null,
                mistakes: [...codes.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
                    .map(([code, n]) => ({ code, n })),
                // v0: one command in ten refused for a reason the state had shown is 0.
                score: rate == null ? null : Math.round(1000 * clamp01(1 - (1 - rate) * 10)) / 10
            };
        }

        // What did a decision cost? Beside the profile, never inside it.
        _efficiency(seat, ok) {
            const turns = seat.turns;
            const lat = turns.map(t => t.latencyMs).filter(v => v != null);
            const tok = turns.filter(t => t.prompt != null && t.completion != null);
            const commands = sum(turns.map(t => t.commands));
            const completion = sum(tok.map(t => t.completion));
            return {
                latencyMs: lat.length ? { median: quantile(lat, 0.5), p90: quantile(lat, 0.9), n: lat.length } : null,
                // null where the seat's harness reports no usage (an MCP seat's does not).
                tokens: tok.length ? {
                    promptMedian: quantile(tok.map(t => t.prompt), 0.5), completionMedian: quantile(tok.map(t => t.completion), 0.5),
                    promptTotal: sum(tok.map(t => t.prompt)), completionTotal: completion, n: tok.length,
                    // Completion tokens for every command that worked. A seat that issues
                    // none has paid for nothing, which is not zero.
                    completionPerOk: ok ? completion / ok : null
                } : null,
                commandsPerDecision: turns.length ? commands / turns.length : null,
                emptyDecisions: turns.filter(t => !t.commands).length,
                missedRounds: seat.markers.round_missed || 0,
                failedRequests: seat.markers.request_failed || 0,
                cancelledRequests: seat.markers.request_cancelled || 0
            };
        }

        profile() {
            const seats = [...this.seats.values()].map(s => {
                const grounding = this._grounding(s.turns);
                return { id: s.id, seat: s.seat, civ: s.civ, model: s.model, name: s.name,
                    decisions: s.turns.length, grounding, efficiency: this._efficiency(s, grounding.ok) };
            });
            seats.sort((a, b) => (a.seat == null ? 1e9 : a.seat) - (b.seat == null ? 1e9 : b.seat) || String(a.id).localeCompare(String(b.id)));
            return { kind: 'war-eval/' + WarEval.VERSION, scale: WarEval.SCALE, match: this.match,
                lines: this.lines, unreadable: this.unreadable, seats };
        }
    }

    WarEval.Ledger = Ledger;
    WarEval.createLedger = () => new Ledger();
    // The profile of a whole transcript given as text.
    WarEval.profileOf = (text) => {
        const ledger = new Ledger();
        for (const line of String(text || '').split(/\r?\n/)) ledger.addLine(line);
        return ledger.profile();
    };

    root.WarEval = WarEval;
    if (typeof module !== 'undefined' && module.exports) module.exports = WarEval;
})(typeof window !== 'undefined' ? window : globalThis);
