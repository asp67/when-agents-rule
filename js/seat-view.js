// ---------------------------------------------------------------------------
// The model's view (overhaul step B1): the world as one seat knows it.
//
// A spectator sees everything. With this on, the 3-D view shows what the followed
// seat's model was told instead:
//   fog      unexplored ground is covered, explored ground is hazed, and only what
//            the seat's own units and buildings see right now is clear -- the grid
//            the minimap's seat knob already draws (game.seatDiscoveryGrid)
//   rivals   a rival's unit is drawn only while it is in the seat's sight; a rival's
//            building once discovered stays, under the haze, as buildings do
//   ghosts   what the seat still believes but cannot see: a rival unit where it was
//            last seen, and a building that has fallen out of sight since. These are
//            the seat's own memory (unit memory, last-seen buildings), the same its
//            state is built from at every decision.
//
// A viewing aid and nothing else. It reads the match and writes one thing: two hooks
// on the renderer (fogView, entityHidden). No seat's state changes and no transcript
// records that anybody looked.
//
// The fog picture is drawn by the fog manager's own code on a second set of canvases:
// an object that inherits FogOfWarManager's methods and owns its grid. The rules file
// is not touched, and the union fog the spectator had stays as it was underneath.
// ---------------------------------------------------------------------------
class SeatView {
    constructor(game) {
        this.game = game;
        this.seat = null;           // the seat whose view is shown, or null: everything
        this.fog = null;
    }

    static get REFRESH_MS() { return 400; }

    ai() { return this.seat == null ? null : ((this.game.aiManager && this.game.aiManager.aiPlayers) || []).find(a => a.seat === this.seat) || null; }
    on() { return this.seat != null && !!this.fog; }

    // The second fog: same size, same drawing, its own grid and canvases.
    makeFog() {
        const base = this.game.fogOfWar;
        if (!base || typeof FogOfWarManager === 'undefined') return null;
        const f = Object.create(FogOfWarManager.prototype);
        f.game = this.game;
        f.gridSize = base.gridSize; f.mapSize = base.mapSize; f.numTiles = base.numTiles;
        f.fogGrid = new Float32Array(f.numTiles * f.numTiles);
        f.fogDirty = false;
        f.visibilityVersion = 0;
        f._marginCells = base._marginCells;
        f.displayWorldSize = base.displayWorldSize;
        const canvas = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
        f.fogCanvas = canvas(f.numTiles, f.numTiles);
        f.fogCtx = f.fogCanvas.getContext('2d');
        const cells = f.numTiles + 2 * f._marginCells;
        f._scratchCanvas = canvas(cells, cells);
        f._scratchCtx = f._scratchCanvas.getContext('2d');
        f.fogDisplayCanvas = canvas(base.fogDisplayCanvas.width, base.fogDisplayCanvas.height);
        f.fogDisplayCtx = f.fogDisplayCanvas.getContext('2d');
        return f;
    }

    // Show this seat's view, or everything (null). Returns whether a view is on.
    set(seat) {
        const r = this.game.renderer;
        this.seat = seat == null ? null : seat;
        if (this.seat != null && !this.ai()) this.seat = null;
        if (this.seat != null && (!this.fog || this.fog.numTiles !== (this.game.fogOfWar && this.game.fogOfWar.numTiles))) this.fog = this.makeFog();
        if (this.seat != null && !this.fog) this.seat = null;
        if (r) {
            r.fogView = this.on() ? this.fog : null;
            r.entityHidden = this.on() ? (e, kind) => this.hidden(e, kind) : null;
        }
        if (this.on()) this.refresh();
        return this.on();
    }

    // The seat's grid, as it stands now, drawn into the second fog.
    refresh() {
        if (!this.on()) return false;
        const grid = this.game.seatDiscoveryGrid ? this.game.seatDiscoveryGrid(this.seat) : null;
        if (!grid || grid.length !== this.fog.fogGrid.length) return false;
        this.fog.fogGrid.set(grid);
        this.fog.updateFogTexture();
        return true;
    }

    // Is this unit or building left out of the picture? Its own are never; a rival's
    // unit unless it is in sight; a rival's building unless it is in sight or remembered.
    hidden(e, kind) {
        const ai = this.ai();
        if (!ai || !e) return false;
        if (e.owner === ai.id) return false;
        if (kind === 'building') {
            if (e.isWonder) return false;                                    // a Wonder is public, as in the model's state
            if (typeof Game !== 'undefined' && Game.hiddenSite && Game.hiddenSite(e)) return true;
            if (this.fog.isPositionCurrentlyVisible(e.x, e.z)) return false;
            return !(ai._knownEnemyBuildings && ai._knownEnemyBuildings.has(e));
        }
        return !this.fog.isPositionCurrentlyVisible(e.x, e.z);
    }

    // What the seat believes and cannot see: where the model's state still lists a
    // rival's unit as last seen, and a remembered building that no longer stands.
    ghosts() {
        const ai = this.ai(), g = this.game, out = [];
        if (!ai || !this.on()) return out;
        const mem = ai._unitMemory;
        if (mem && mem.forEach) mem.forEach(r => {
            if (!r || r.visible || r.located === false || r.x == null || r.z == null) return;   // in sight, or known to have left the spot
            if (this.fog.isPositionCurrentlyVisible(r.x, r.z)) return;        // the seat can see the spot: nothing is believed there
            out.push({ kind: 'unit', type: r.type, x: r.x, z: r.z, owner: r.owner, at: r.at });
        });
        const seen = ai._enemyBuildingSeen;
        if (seen && seen.forEach) seen.forEach((snap, b) => {
            if (!b || b.health > 0 || !snap || this.fog.isPositionCurrentlyVisible(snap.x, snap.z)) return;
            out.push({ kind: 'building', type: snap.type, x: snap.x, z: snap.z, owner: b.owner, fallen: true });
        });
        return out;
    }

    // U3: Read-only epistemic telemetry for the Model View lens banner (explored %, stale ghost count & max age).
    stats() {
        const ai = this.ai();
        if (!ai || !this.on() || !this.fog) return null;
        const grid = this.fog.fogGrid;
        let seen = 0;
        for (let i = 0; i < grid.length; i++) if (grid[i] > 0) seen++;
        const exploredPct = grid.length ? Math.round((seen / grid.length) * 100) : 0;
        const ghosts = this.ghosts();
        const now = (this.game && this.game.simNow) ? this.game.simNow() : Date.now();
        let oldestSec = 0;
        for (const q of ghosts) {
            if (q.at != null && now >= q.at) oldestSec = Math.max(oldestSec, Math.round((now - q.at) / 1000));
        }
        return { exploredPct, staleCount: ghosts.length, oldestSec };
    }

    // U3: Read-only ground-truth lookup for Reality Diff tethers (where a remembered enemy unit actually went).
    realityGhosts() {
        const ai = this.ai(), g = this.game, out = [];
        if (!ai || !this.on()) return out;
        const mem = ai._unitMemory;
        const liveUnits = g && g.getAllUnits ? g.getAllUnits() : [];
        const byId = new Map();
        for (const u of liveUnits) if (u && u.health > 0) byId.set(String(u.id), u);
        const now = g && g.simNow ? g.simNow() : Date.now();
        if (mem && mem.forEach) mem.forEach((r, key) => {
            if (!r || r.visible || r.located === false || r.x == null || r.z == null) return;
            if (this.fog.isPositionCurrentlyVisible(r.x, r.z)) return;
            const real = byId.get(String(r.id != null ? r.id : key)) || null;
            const ageSec = r.at != null && now >= r.at ? Math.round((now - r.at) / 1000) : null;
            out.push({ kind: 'unit', type: r.type, x: r.x, z: r.z, owner: r.owner, at: r.at, ageSec,
                real: real ? { x: real.x, z: real.z } : null });
        });
        const seen = ai._enemyBuildingSeen;
        if (seen && seen.forEach) seen.forEach((snap, b) => {
            if (!b || b.health > 0 || !snap || this.fog.isPositionCurrentlyVisible(snap.x, snap.z)) return;
            out.push({ kind: 'building', type: snap.type, x: snap.x, z: snap.z, owner: b.owner, fallen: true, ageSec: null, real: null });
        });
        return out;
    }
}
if (typeof module !== 'undefined' && module.exports) module.exports = SeatView;
