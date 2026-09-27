// ---------------------------------------------------------------------------
// Seat-true colours (review #12): the one answer to "what colour is this seat?".
//
// A seat wears its civilization's colour, as it always has -- unless two seats in the
// match play the same civilization. Then two armies would be one colour, so EVERY seat
// wears its seat badge's colour instead (the same badge the leaderboard, minimap knobs
// and banners show). Every seat, not only the two: a civilization's own colour can sit
// next to a badge's (Persian tomato beside seat 2's red), and the badges are the one
// palette made to be told apart. Seat 0's badge is white, which on cloth reads as
// undyed, so seat 0 wears charcoal.
//
// Presentation only. Units, buildings, the minimap, the leaderboard, the Wonder bar and
// the results all ask here, so they cannot disagree. The live match is read from the
// game; the analyzer names its seats with use() while it shows a recorded match.
// ---------------------------------------------------------------------------
var WarIdentity = {
    CHARCOAL: 0x3a3a3a,
    _seats: null,

    // The seats to answer for: [{id, seat, civ}], or null for the live match.
    use(seats) {
        WarIdentity._seats = seats ? seats.map(s => ({ id: s.id, seat: s.seat, civ: s.civ || s.civilization })) : null;
    },
    seats() {
        if (WarIdentity._seats) return WarIdentity._seats;
        const g = typeof game !== 'undefined' ? game : null;
        const ais = (g && g.aiManager && g.aiManager.aiPlayers) || [];
        return ais.map(a => ({ id: a.id, seat: a.seat, civ: a.civilization }));
    },
    // Does this match have two seats on one civilization?
    shared(seats = WarIdentity.seats()) {
        const civs = seats.map(s => s.civ).filter(Boolean);
        return new Set(civs).size < civs.length;
    },
    // The colour, as a number. `fallback` is used when nothing better is known.
    color(ownerId, civ, seat, fallback = null) {
        const all = WarIdentity.seats();
        const me = all.find(s => s.id === ownerId) || null;
        const c = civ || (me && me.civ) || null;
        const st = seat != null ? seat : (me ? me.seat : null);
        if (st != null && WarIdentity.shared(all)) {
            if (st === 0) return WarIdentity.CHARCOAL;
            const b = typeof getTeamBadge === 'function' ? getTeamBadge(st) : null;
            if (b && b.fill) return parseInt(b.fill.slice(1), 16);
        }
        const def = c && typeof getCivilization === 'function' ? getCivilization(c) : null;
        if (def && def.color != null) return def.color;
        return fallback != null ? fallback : 0xffffff;
    },
    hex(ownerId, civ, seat, fallback = null) {
        return '#' + WarIdentity.color(ownerId, civ, seat, fallback).toString(16).padStart(6, '0');
    },
};
if (typeof module !== 'undefined' && module.exports) module.exports = WarIdentity;
