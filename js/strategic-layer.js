// ---------------------------------------------------------------------------
// The strategic zoom layer (review #12): what the map says when the camera is too far
// out to see a soldier.
//
// It fades in as the view widens past a half-height of 90 and is fully there by 140:
//   bases    a flag on each Town Center: the seat's waving flag, as on its flag poles
//   armies   each seat's fighting units, gathered into groups, flagged the same way
//            with crossed swords in the badge and the number of units beneath
//   battles  a marker on every fight still going (the battle ledger, not a guess)
// It reads the match and changes nothing. Groups are rebuilt four times a second.
// ---------------------------------------------------------------------------
class StrategicLayer {
    constructor(game) {
        this.game = game;
        this.armies = [];
        this.bases = [];
        this.battles = [];
    }

    static get NEAR() { return 90; }
    static get POLE_PX() { return 50; }   // the marker line, in screen pixels
    static get FAR() { return 140; }
    static get GROUP_RADIUS() { return 45; }

    // 0 up close, 1 once the view is wide; nothing is drawn at 0.
    static fade(halfH) {
        return Math.max(0, Math.min(1, (halfH - StrategicLayer.NEAR) / (StrategicLayer.FAR - StrategicLayer.NEAR)));
    }

    // Greedy grouping: a unit joins the first group whose centre is within `radius`,
    // and the centre follows. Order-stable, so a standing army keeps one glyph.
    static group(units, radius = StrategicLayer.GROUP_RADIUS) {
        const groups = [];
        for (const u of units) {
            let g = null;
            for (const c of groups) if (Math.hypot(c.x - u.x, c.z - u.z) <= radius) { g = c; break; }
            if (!g) groups.push(g = { x: u.x, z: u.z, n: 0, sx: 0, sz: 0, units: [] });
            g.n++; g.sx += u.x; g.sz += u.z; g.units.push(u);
            g.x = g.sx / g.n; g.z = g.sz / g.n;
        }
        // The members travel with the group, so a drawing can follow them between rebuilds.
        return groups.map(({ x, z, n, units }) => ({ x, z, n, units }));
    }

    poll() {
        const g = this.game, ais = (g.aiManager && g.aiManager.aiPlayers) || [];
        const armies = [], bases = [];
        for (const ai of ais) {
            if (ai._eliminated) continue;
            const army = (ai.units || []).filter(u => u.health > 0 && u.type !== 'worker');
            for (const grp of StrategicLayer.group(army)) armies.push(Object.assign({ id: ai.id, seat: ai.seat, civ: ai.civilization }, grp));
            for (const b of ai.buildings || []) if (b.type === 'town_center' && b.health > 0 && !b.underConstruction) bases.push({ id: ai.id, seat: ai.seat, civ: ai.civilization, x: b.x, z: b.z });
        }
        const now = g.simNow ? g.simNow() : 0, quiet = (g.constructor && g.constructor.BATTLE_QUIET_MS) || 10000;
        this.battles = (g._battles || []).filter(b => now - b.lastAt <= quiet && Object.keys(b.sides || {}).length >= 2)
            .map(b => ({ x: b.x, z: b.z, n: Object.values(b.sides).reduce((a, s) =>
                a + Object.values(s.involved || {}).reduce((k, t) => k + (t.ids ? t.ids.size : 0), 0), 0) }));
        this.armies = armies;
        this.bases = bases;
    }
}
if (typeof module !== 'undefined' && module.exports) module.exports = StrategicLayer;
