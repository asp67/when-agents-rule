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
//   nodes    a tree, a mine or a herd is drawn once the seat itself has found it
//   ghosts   what the seat still believes but cannot see: a rival unit where it was
//            last seen, and a building that has fallen out of sight since. These are
//            the seat's own memory (unit memory, last-seen buildings), the same its
//            state is built from at every decision.
//
// A viewing aid and nothing else. It reads the match and writes one thing: its hooks
// on the renderer (fogView, entityHidden, entityFade, nodeHidden). No seat's state changes and no transcript
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
            r.entityFade = this.on() ? (e, kind) => this.fadeOf(e, kind) : null;
            r.nodeHidden = this.on() ? (res, idx) => this.nodeHidden(res, idx) : null;
            if (!this.on() && typeof r.setSeatGhosts === 'function') r.setSeatGhosts(null);
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
        const r = this.game.renderer;
        if (r && typeof r.setSeatGhosts === 'function') r.setSeatGhosts(this.ghostSpecs());
        return true;
    }

    // Translucent 0.62 fade for discovered enemy buildings out of current sight (reads as
    // ~40% after the explored-fog veil is composited on top).
    fadeOf(e, kind) {
        const ai = this.ai();
        if (!ai || !e || !this.on() || e.owner === ai.id) return null;
        if (kind === 'building' && !e.isWonder && !this.fog.isPositionCurrentlyVisible(e.x, e.z)) return 0.62;
        return null;
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
            if (!(ai._knownEnemyBuildings && ai._knownEnemyBuildings.has(e))) return true;
            // If last seen while under construction, hide the live building so a site that
            // finished out of sight does not leak its completed state; ghostSpecs() renders
            // the remembered scaffold at its last-seen buildPct instead.
            const snap = ai._enemyBuildingSeen && ai._enemyBuildingSeen.get && ai._enemyBuildingSeen.get(e);
            if (snap && snap.state === 'under_construction') return true;
            return false;
        }
        return !this.fog.isPositionCurrentlyVisible(e.x, e.z);
    }

    // Is this resource node left out? One the seat has not found is. A node's own show/hide
    // flag is set by the spectator's fog, which is every seat's put together, so without
    // this the view drew the forests and mines the rivals had found as well (build 1309).
    // Asked of the seat's own memory by node index, the list its state is built from; a
    // seat that keeps none is answered by the ground it has explored, as the minimap does.
    nodeHidden(res, idx) {
        const ai = this.ai();
        if (!ai || !res) return false;
        if (ai._knownResIdx && ai._knownResIdx.has) return !ai._knownResIdx.has(idx);
        return !this.fog.isPositionVisible(res.x, res.z);
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
        const ais = (g && g.aiManager && g.aiManager.aiPlayers) || [];
        const goneForSeat = b => {
            if (b._lastAttacker && b._lastAttacker.owner === ai.id) return true;
            const o = ais.find(p => p.id === b.owner);
            return !!(o && o._eliminated);
        };
        if (seen && seen.forEach) seen.forEach((snap, b) => {
            if (!b || b.health > 0 || !snap || goneForSeat(b) || this.fog.isPositionCurrentlyVisible(snap.x, snap.z)) return;
            out.push({ kind: 'building', type: snap.type, x: snap.x, z: snap.z, owner: b.owner, fallen: true });
        });
        return out;
    }

    // Read-only specs for EngineRenderer.setSeatGhosts: enriches ghosts() with owner civ/seat/age,
    // plus remembered under-construction building snapshots so out-of-sight sites render in their
    // last-seen scaffold state rather than leaking later completion.
    ghostSpecs() {
        const ai = this.ai();
        const ais = (this.game.aiManager && this.game.aiManager.aiPlayers) || [];
        const enrich = q => {
            const o = ais.find(a => a.id === q.owner);
            return Object.assign({}, q, {
                civ: (o && o.civilization) || 'greek',
                seat: o ? o.seat : 0,
                age: (o && o.age) || 'stone'
            });
        };
        const out = this.ghosts().map(enrich);
        if (ai && this.on() && ai._enemyBuildingSeen && ai._enemyBuildingSeen.forEach) {
            ai._enemyBuildingSeen.forEach((snap, b) => {
                if (!b || !(b.health > 0) || b.isWonder || !snap || snap.state !== 'under_construction') return;
                if (!(ai._knownEnemyBuildings && ai._knownEnemyBuildings.has(b))) return;
                if (this.fog.isPositionCurrentlyVisible(b.x, b.z)) return;
                out.push(enrich({
                    kind: 'building', type: snap.type, x: b.x, z: b.z, owner: b.owner,
                    underConstruction: true, buildPct: snap.buildPct || 0
                }));
            });
        }
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
        const ageOf = at => {
            if (at == null) return null;
            if (this.game && typeof this.game.realSecsSince === 'function') return Math.max(0, Math.round(this.game.realSecsSince(at)));
            const now = (this.game && this.game.simNow) ? this.game.simNow() : Date.now();
            return now >= at ? Math.round((now - at) / 1000) : null;
        };
        let oldestSec = 0;
        for (const q of ghosts) {
            const a = ageOf(q.at);
            if (a != null) oldestSec = Math.max(oldestSec, a);
        }
        return { exploredPct, staleCount: ghosts.length, oldestSec };
    }

    // U3: Read-only ghost telemetry for Model View: real-time secondsAgo (via game.realSecsSince),
    // observed heading (from sightedAt -> lastSeen), plus ground-truth coordinates for tests/tools.
    realityGhosts() {
        const ai = this.ai(), g = this.game, out = [];
        if (!ai || !this.on()) return out;
        const mem = ai._unitMemory;
        const liveUnits = g && g.getAllUnits ? g.getAllUnits() : [];
        const byId = new Map();
        for (const u of liveUnits) if (u && u.health > 0) byId.set(String(u.id), u);
        const now = g && g.simNow ? g.simNow() : Date.now();
        const ageOf = at => {
            if (at == null) return null;
            if (g && typeof g.realSecsSince === 'function') return Math.max(0, Math.round(g.realSecsSince(at)));
            return now >= at ? Math.round((now - at) / 1000) : null;
        };
        if (mem && mem.forEach) mem.forEach((r, key) => {
            if (!r || r.visible || r.located === false || r.x == null || r.z == null) return;
            if (this.fog.isPositionCurrentlyVisible(r.x, r.z)) return;
            const real = byId.get(String(r.id != null ? r.id : key)) || null;
            const ageSec = ageOf(r.at);
            const hdx = r.sx != null ? r.x - r.sx : 0, hdz = r.sz != null ? r.z - r.sz : 0;
            const hlen = Math.hypot(hdx, hdz);
            const heading = hlen >= 4 ? { dx: hdx / hlen, dz: hdz / hlen } : null;
            out.push({ kind: 'unit', type: r.type, x: r.x, z: r.z, owner: r.owner, at: r.at, ageSec, heading,
                real: real ? { x: real.x, z: real.z } : null });
        });
        const seen = ai._enemyBuildingSeen;
        const ais = (g && g.aiManager && g.aiManager.aiPlayers) || [];
        if (seen && seen.forEach) seen.forEach((snap, b) => {
            if (!b || b.health > 0 || !snap) return;
            if (b._lastAttacker && b._lastAttacker.owner === ai.id) return;
            const o = ais.find(p => p.id === b.owner);
            if (o && o._eliminated) return;
            if (this.fog.isPositionCurrentlyVisible(snap.x, snap.z)) return;
            out.push({ kind: 'building', type: snap.type, x: snap.x, z: snap.z, owner: b.owner, fallen: true, ageSec: null, real: null });
        });
        return out;
    }
}
if (typeof module !== 'undefined' && module.exports) module.exports = SeatView;
