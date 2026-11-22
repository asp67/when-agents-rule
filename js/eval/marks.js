// Evaluation marks in the world (overhaul step B4): what the ledger has just judged,
// shown where it happened.
//
//   step     a tick where a plan step was carried out: at the site that was built, the
//            building that trained or researched, the point that was attacked
//   answer   an arrow from the responders to the threat their order answers
//   battle   a plate over a finished battle with what each side lost
//
// The first two come from the evaluation profile (js/eval/ledger.js: follow.done and the
// answers in tactical.list), the third from the chronicle's own battle event, which is
// also what the ledger counts. Nothing here judges anything, and nothing is guessed: a
// mark appears when the ledger reports the fact, at the place the order named. Marks are
// drawn with the intent layer, so the Intent switch hides them with it.
//
// No DOM and no game in here: poll() turns new facts into marks, frame() hands them to the
// page with the positions the page resolves (js/ui.js, drawEvalMarks).
class EvalMarks {
    constructor() {
        this.marks = [];
        this.seen = new Set();
        this._started = false;
    }

    static get LIFE_MS() { return 8000; }
    static get FADE_MS() { return 1500; }
    static get TEXT_MAX() { return 46; }
    static alpha(now, born, life = EvalMarks.LIFE_MS) {
        const age = now - born;
        if (age < 0 || age >= life) return 0;
        return age < life - EvalMarks.FADE_MS ? 1 : (life - age) / EvalMarks.FADE_MS;
    }
    static short(text) {
        const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
        return s.length > EvalMarks.TEXT_MAX ? s.slice(0, EvalMarks.TEXT_MAX - 1).trimEnd() + '…' : s;
    }

    // What is new in the profile since the last look. The first look only takes stock: a
    // page opened on a match already under way does not replay its whole history as marks.
    poll(profile, now = Date.now()) {
        const fresh = [];
        for (const s of (profile && profile.seats) || []) {
            for (const d of (s.follow && s.follow.done) || []) {
                const key = 'step|' + s.id + '|' + d.decision + '|' + d.text + '|' + (d.met || 1);
                if (this.seen.has(key)) continue;
                this.seen.add(key);
                // met of: how much of what the step commits to stands done with this order (all of it = the step is carried out).
                fresh.push({ kind: 'step', id: s.id, seat: s.seat, text: EvalMarks.short(d.text), by: d.by, met: d.met || 1, of: d.of || 1 });
            }
            for (const e of (s.tactical && s.tactical.list) || []) {
                if (!e.answer || !e.at) continue;
                const key = 'answer|' + s.id + '|' + e.kind + '|' + e.decision;
                if (this.seen.has(key)) continue;
                this.seen.add(key);
                fresh.push({ kind: 'answer', id: s.id, seat: s.seat, to: e.at, by: e.answer, wonder: e.kind === 'wonder', what: e.what || [] });
            }
        }
        const live = this._started;
        if (live) fresh.forEach((m, k) => this.marks.push(Object.assign(m, { born: now + k * 400, life: EvalMarks.LIFE_MS })));
        this._started = true;
        this.prune(now);
        return live ? fresh.length : 0;
    }
    // A finished battle, as the chronicle tells it: where, and what each side lost.
    battle(e, now = Date.now()) {
        if (!e || e.kind !== 'battle' || !e.sides || e.x == null || e.z == null) return false;
        const sides = Object.keys(e.sides).map(id => ({ id, lost: e.sides[id].lost || 0, involved: e.sides[id].involved || 0 }));
        if (sides.length < 2 || !sides.some(s => s.lost > 0)) return false;       // a skirmish nobody fell in tells nothing
        this.marks.push({ kind: 'battle', at: { x: e.x, z: e.z }, sides, born: now, life: EvalMarks.LIFE_MS });
        this.prune(now);
        return true;
    }
    prune(now) { this.marks = this.marks.filter(m => now - m.born < m.life); }

    // The marks to draw now. \`place(mark)\` is the page's: it returns { at, from } in world
    // coordinates for a step or an answer (from only where units were sent), or null when
    // the place no longer exists. \`project(x, z)\` returns screen {x, y} or null.
    frame(project, place, now = Date.now()) {
        const out = [];
        for (const m of this.marks) {
            const opacity = EvalMarks.alpha(now, m.born, m.life);
            if (!(opacity > 0)) continue;
            const where = m.kind === 'battle' ? { at: m.at, from: null } : place(m);
            if (!where || !where.at) continue;
            const at = project(where.at.x, where.at.z);
            if (!at) continue;
            const from = where.from ? project(where.from.x, where.from.z) : null;
            out.push(Object.assign({}, m, { opacity, x: at.x, y: at.y, from }));
        }
        return out;
    }
}
if (typeof module !== 'undefined' && module.exports) module.exports = EvalMarks;
