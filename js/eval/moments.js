// Moments (overhaul step B2): the heaviest events of a match, each with the decision
// behind it.
//
// The chronicle already says what happened and how much it weighed (js/chronicle.js);
// the ledger holds every decision of every model seat with its orders (js/eval/ledger.js).
// This file joins the two and judges nothing:
//   pick(events, n)       the n heaviest events, kept apart in time, in the order they happened
//   causeOf(moment, ...)  the last order that worked and plausibly led there: an attack
//                         or a march toward a battle before it began, the attack before a
//                         building fell or a seat was put out, the age-up, the Wonder's
//                         own building order
// A cause is offered only when such an order exists close before the event. A fight that
// began with no order behind it (guards answering, armies meeting) has none, and says so.
//
// No DOM. The page draws the reel and the corner replay from this (js/moments-view.js).
(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.WarMoments = api;
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const KEEP_APART_SEC = 30;
    // How long before an event an order still counts as what led to it, and how near a
    // battle an order with a place must point.
    const CAUSE_WINDOW_SEC = 180, CAUSE_RADIUS = 90;

    const lostIn = e => Object.values(e.sides || {}).reduce((a, s) => a + (s.lost || 0), 0);
    // How heavy an event is for the story of the match. Fights by what fell in them; the
    // rest by kind. Contacts, clashes and countdown ticks are not moments of their own.
    function weightOf(e) {
        if (!e) return 0;
        switch (e.kind) {
            case 'elimination': return 90;
            case 'wonder-lost': return 80;
            case 'town-center-lost': return 60;
            case 'wonder-raised': return 55;
            case 'battle': { const lost = lostIn(e); return lost ? Math.min(100, 10 + 3 * lost) : 0; }
            case 'building-lost': return 12;
            case 'age': return 10;
            default: return 0;
        }
    }
    // When it began: a battle is reported at its end, with how long it lasted.
    const startOf = e => e.kind === 'battle' ? Math.max(0, (e.t || 0) - (e.seconds || 0)) : (e.t || 0);

    // The n heaviest, at least half a minute apart from one another, in time order.
    function pick(events, n = 5) {
        const all = (events || []).filter(e => e && e.type !== 'input').map(e => ({ e, weight: weightOf(e), start: startOf(e) })).filter(m => m.weight > 0);
        all.sort((a, b) => b.weight - a.weight || a.start - b.start);
        // No more than three in five of one kind: a match of many big fights still shows
        // the Wonder that ended it.
        const out = [], most = Math.max(1, Math.ceil(n * 0.6)), kinds = {};
        for (const m of all) {
            if (out.length >= n) break;
            if (out.some(o => Math.abs(o.start - m.start) < KEEP_APART_SEC) || (kinds[m.e.kind] || 0) >= most) continue;
            kinds[m.e.kind] = (kinds[m.e.kind] || 0) + 1;
            out.push(m);
        }
        return out.sort((a, b) => a.start - b.start).map(m => ({ kind: m.e.kind, t: m.e.t || 0, start: m.start, weight: m.weight, seats: m.e.seats || [], x: m.e.x, z: m.e.z, event: m.e }));
    }

    // The decision behind a moment: { id, decision, turn, sec, action, name } or null.
    // \`seats\` is the ledger's map of seats (id -> { turns: [{ turn, sec, cmds }] }).
    function causeOf(moment, seats, events) {
        const e = moment.event || moment, at = moment.start != null ? moment.start : startOf(e);
        const turnsOf = id => { const s = seats && seats.get ? seats.get(id) : null; return (s && s.turns) || []; };
        const near = c => c.x == null || c.z == null || e.x == null || e.z == null || (Math.abs(c.x - e.x) <= CAUSE_RADIUS && Math.abs(c.z - e.z) <= CAUSE_RADIUS);
        // The last decision of this seat at or before the moment with an order that fits.
        const last = (id, fits, window = CAUSE_WINDOW_SEC) => {
            const turns = turnsOf(id);
            for (let i = turns.length - 1; i >= 0; i--) {
                const t = turns[i];
                if (t.sec == null || t.sec > at) continue;
                if (at - t.sec > window) break;
                const c = t.cmds.find(c => c.ok === true && fits(c));
                if (c) return { id, decision: i + 1, turn: t.turn, sec: t.sec, action: c.action, name: c.name || null };
            }
            return null;
        };
        const sent = c => (c.action === 'attack_target' || (c.action === 'move_units' && !c.scouting)) && near(c);
        if (e.kind === 'battle') {
            // Of the sides that fought, the order given last before the first blow.
            const found = Object.keys(e.sides || {}).map(id => last(id, sent)).filter(Boolean);
            return found.sort((a, b) => b.sec - a.sec)[0] || null;
        }
        if (e.kind === 'building-lost' || e.kind === 'town-center-lost' || e.kind === 'wonder-lost') return e.by ? last(e.by, sent, 300) : null;
        if (e.kind === 'elimination') {
            // Who took the seat's last building, where the chronicle says so shortly before.
            const out = e.seats && e.seats[0];
            const fall = (events || []).filter(x => x && (x.kind === 'building-lost' || x.kind === 'town-center-lost') && x.by && x.seats && x.seats[0] === out && x.t <= at && at - x.t <= 120)
                .sort((a, b) => b.t - a.t)[0];
            return fall ? last(fall.by, c => c.action === 'attack_target' || (c.action === 'move_units' && !c.scouting), 300) : null;
        }
        if (e.kind === 'age') return e.seats && e.seats[0] ? last(e.seats[0], c => c.action === 'upgrade_age', 600) : null;
        if (e.kind === 'wonder-raised') return e.seats && e.seats[0] ? last(e.seats[0], c => c.action === 'build_structure' && (c.name === 'wonder' || c.name === e.building), 1800) : null;
        return null;
    }

    return { KEEP_APART_SEC, CAUSE_WINDOW_SEC, weightOf, startOf, lostIn, pick, causeOf };
});
