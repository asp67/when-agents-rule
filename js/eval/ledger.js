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
// Three parts of the profile are filled so far:
//   grounding    were the commands valid when they were issued?
//   planning     does the seat keep a live, concrete plan, and restate it after a shock?
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

    // ---- planning (step C2) ---------------------------------------------------------
    // What a decision said about the plan, by the analyzer's own rule for "planned": a
    // non-empty list of steps, or an objective with text in it. null when it said nothing.
    function planOf(parsed) {
        if (!parsed || typeof parsed !== 'object') return null;
        const steps = Array.isArray(parsed.plan) && parsed.plan.length ? parsed.plan.map(s => String(s)) : null;
        const objective = typeof parsed.objective === 'string' && parsed.objective.trim() ? parsed.objective.trim() : null;
        return steps || objective ? { objective, steps } : null;
    }

    // The names a seat was shown: what it could train, build and research, and who it is
    // up against. A plan step is checkable when it names one of them, and only names the
    // seat itself was given count -- a step is never matched against a list it never saw.
    function everyValue(node, key, into, depth) {
        if (!node || typeof node !== 'object' || depth > 5) return;
        if (Array.isArray(node)) { for (const x of node) everyValue(x, key, into, depth + 1); return; }
        if (typeof node[key] === 'string') into.add(node[key]);
        for (const k in node) if (k !== 'cost' && node[k] && typeof node[k] === 'object') everyValue(node[k], key, into, depth + 1);
    }
    function learnNames(vocab, state) {
        if (!state || typeof state !== 'object') return;
        // `units` and `buildings` from build 1023 on; the two flat lists before that.
        everyValue(state.units && (state.units.trainable || state.units.blocked) ? state.units : state.trainableUnits, 'id', vocab.units, 0);
        const b = state.buildings && (state.buildings.buildable || state.buildings.blocked) ? state.buildings : state.buildableStructures;
        everyValue(b, 'type', vocab.buildings, 0);
        const r = state.research || {};
        for (const x of r.researched || []) if (typeof x === 'string') vocab.techs.add(x);
        everyValue(r.available, 'id', vocab.techs, 0);
        for (const o of (state.gameStats && state.gameStats.opponents) || []) {
            if (o && typeof o.id === 'string') vocab.opponents.add(o.id);
            if (o && typeof o.civilization === 'string') vocab.opponents.add(o.civilization);
        }
    }
    const plain = s => ' ' + String(s).toLowerCase().replace(/[_\-]/g, ' ').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim() + ' ';
    // The name as a word of the step, in the singular or one of its plurals.
    function names(text, name) {
        const n = String(name).toLowerCase().replace(/[_\-]/g, ' ');
        return text.includes(' ' + n + ' ') || text.includes(' ' + n + 's ') || text.includes(' ' + n + 'es ')
            || (n.endsWith('y') && text.includes(' ' + n.slice(0, -1) + 'ies '))
            || (n.endsWith('man') && text.includes(' ' + n.slice(0, -3) + 'men '));
    }
    // What a step commits to, as kinds of command that could carry it out. An empty list
    // is a step nothing recorded could confirm: "stay flexible", "play well".
    function checkable(step, vocab) {
        const text = plain(step), kinds = [];
        const add = (kind, name) => { if (!kinds.some(k => k.kind === kind && k.name === name)) kinds.push({ kind, name }); };
        for (const u of vocab.units) if (u !== 'worker' && names(text, u)) add('train', u);
        for (const b of vocab.buildings) if (names(text, b)) add('build', b);
        for (const x of vocab.techs) if (!vocab.buildings.has(x) && names(text, x)) add('research', x);
        if (/ (iron|bronze|neolithic) age | age up | next age | advance to /.test(text)) add('age', 'age');
        if (/ wonder /.test(text)) add('wonder', 'wonder');
        if (/ workers? | villagers? /.test(text)) add('train', 'worker');
        if (/ (attack|raze|destroy|kill|raid|strike|assault|siege|hunt) /.test(text) || [...vocab.opponents].some(o => names(text, o))) add('attack', 'attack');
        if (/ (scout|explore|find|search|sweep) /.test(text)) add('explore', 'explore');
        return kinds;
    }
    // Something in the state a plan could not have counted on. Read from what the MODEL
    // was shown, never from the world: a raid it was not told about is not a shock to it.
    const SHOCK_WINDOW = 3;                  // decisions a seat has to restate its plan
    const LOSS_FROM = 12, LOSS_SHARE = 0.75; // a quarter of its people gone since the last decision

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
                s = { id: o.playerId, seat: null, civ: null, model: null, name: null, turns: [], markers: {},
                    vocab: { units: new Set(), buildings: new Set(), techs: new Set(), opponents: new Set() } };
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
            const st = o.state && typeof o.state === 'object' ? o.state : {};
            const clock = st.clock, threats = st.threats || {};
            const seat = this._seat(o);
            learnNames(seat.vocab, st);
            seat.turns.push({
                plan: planOf(o.parsed),
                // What the state showed that a plan could not have counted on.
                people: num(st.population ? st.population.used : (st.resources ? st.resources.population : null)),
                attacked: Array.isArray(threats.underAttack) && threats.underAttack.length > 0,
                wonders: Array.isArray(threats.enemyWonders) ? threats.enemyWonders.map(w => String(w && w.id)) : [],
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

        // Does it keep a live, concrete plan?
        _planning(seat) {
            const turns = seat.turns, vocab = seat.vocab;
            const history = [], shocks = [];
            let standing = null, covered = 0, statements = 0, steps = 0, concrete = 0;
            let people = null, wasAttacked = false;
            const seenWonders = new Set();
            const same = (a, b) => plain(a.objective || '') === plain(b.objective || '')
                && a.steps.length === b.steps.length && a.steps.every((s, i) => plain(s) === plain(b.steps[i]));
            turns.forEach((t, i) => {
                // A shock is in the state the decision was GIVEN, so it comes before the
                // decision's own plan: restating the plan in that very reply answers it.
                if (people != null && t.people != null && people >= LOSS_FROM && t.people <= people * LOSS_SHARE) shocks.push({ at: i, kind: 'losses', revised: false });
                if (t.people != null) people = t.people;
                if (t.attacked && !wasAttacked) shocks.push({ at: i, kind: 'attacked', revised: false });
                wasAttacked = t.attacked;
                for (const id of t.wonders) if (!seenWonders.has(id)) { seenWonders.add(id); shocks.push({ at: i, kind: 'wonder', revised: false }); }

                if (t.plan) {
                    statements++;
                    // A statement that leaves one half out keeps that half as it stood.
                    const next = { objective: t.plan.objective != null ? t.plan.objective : (standing ? standing.objective : null),
                        steps: t.plan.steps || (standing ? standing.steps.map(s => s.text) : []) };
                    if (!standing || !same(next, { objective: standing.objective, steps: standing.steps.map(s => s.text) })) {
                        const known = new Set(standing ? standing.steps.map(s => plain(s.text)) : []);
                        standing = { decision: i + 1, turn: t.turn, sec: t.sec, objective: next.objective,
                            steps: next.steps.map(text => ({ text, fresh: !known.has(plain(text)), checks: checkable(text, vocab) })) };
                        history.push(standing);
                        for (const s of standing.steps) if (s.fresh) { steps++; if (s.checks.length) concrete++; }
                        for (const sh of shocks) if (!sh.revised && i - sh.at <= SHOCK_WINDOW) sh.revised = true;
                    }
                }
                if (standing) covered++;
            });
            const coverage = turns.length ? covered / turns.length : null;
            const concreteRate = steps ? concrete / steps : null;
            const answered = shocks.filter(s => s.revised).length;
            const kinds = { attacked: 0, wonder: 0, losses: 0 };
            for (const s of shocks) kinds[s.kind]++;
            return {
                // Every decision that stated a plan, and how many of those changed it.
                statements, revisions: history.length,
                firstAt: history.length ? { decision: history[0].decision, sec: history[0].sec } : null,
                coverage, steps, concrete, concreteRate,
                shocks: Object.assign({ n: shocks.length, revised: answered }, kinds),
                standing: standing ? { objective: standing.objective, since: standing.decision, sec: standing.sec,
                    steps: standing.steps.map(s => ({ text: s.text, checkable: s.checks.length > 0 })) } : null,
                history: history.map(h => ({ decision: h.decision, sec: h.sec, steps: h.steps.length })),
                // v0: the mean of coverage, concrete steps and revision after a shock; a
                // seat no shock reached is held to its coverage for the third part. A seat
                // that never stated a plan has none, which is 0 and not a missing value.
                score: !turns.length ? null : !history.length ? 0
                    : Math.round(1000 * (coverage + (concreteRate || 0) + (shocks.length ? answered / shocks.length : coverage)) / 3) / 10
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

        // Worked out again only when a line has arrived since: the page asks once a
        // second, a match adds a line every few. Treat the result as read-only.
        profile() {
            if (this._profile && this._profileLines === this.lines + ':' + this.unreadable) return this._profile;
            const seats = [...this.seats.values()].map(s => {
                const grounding = this._grounding(s.turns);
                return { id: s.id, seat: s.seat, civ: s.civ, model: s.model, name: s.name,
                    decisions: s.turns.length, grounding, planning: this._planning(s), efficiency: this._efficiency(s, grounding.ok) };
            });
            seats.sort((a, b) => (a.seat == null ? 1e9 : a.seat) - (b.seat == null ? 1e9 : b.seat) || String(a.id).localeCompare(String(b.id)));
            this._profileLines = this.lines + ':' + this.unreadable;
            this._profile = { kind: 'war-eval/' + WarEval.VERSION, scale: WarEval.SCALE, match: this.match,
                lines: this.lines, unreadable: this.unreadable, seats };
            return this._profile;
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
