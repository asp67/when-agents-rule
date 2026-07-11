// Terrain and map generation
// Difficulty presets: resource-count multipliers + a ground colour theme.
//   easy   = Summer Valley (full resources, lush green)
//   medium = Winter Valley (-50% food, pale wintry ground)
//   hard   = Desert        (-75% food, -75% wood, -50% stone, sandy ground)
const DIFFICULTY_MODS = {
    easy:   { food: 2.0,  wood: 1.0,  stone: 1.0, base: 0x79b94a, dry: 0xb2bd66 },
    medium: { food: 0.5,  wood: 1.0,  stone: 1.0, base: 0x9db9b3, dry: 0xcdd6d2 },
    hard:   { food: 0.25, wood: 0.25, stone: 0.5, base: 0xcdb886, dry: 0xc2a868 }
};

// Pure DATA since the in-house engine (M6): this class generates and manages
// the map's resource layout; all drawing (island mega-texture, water, foam,
// resource meshes) lives in EngineRenderer. The `scene` constructor argument
// is kept for signature compatibility and ignored. Each resource carries a
// plain visibility handle ({visible} / {trunk, leaves}) that fog toggles and
// the renderer reads — depletion nulls it.
class TerrainManager {
    constructor(scene, size = 200) {
        this.size = size;
        this.grid = [];
        this.gridSize = 2;
        this.numTiles = size / this.gridSize;
        this.resources = [];
        this.difficulty = 'easy'; // set by the game before each regenerate
        this.seed = null;         // optional map seed: same seed => same resource layout
        this.generateTerrain();
    }

    diffMods() { return DIFFICULTY_MODS[this.difficulty] || DIFFICULTY_MODS.easy; }

    // Deterministic PRNG (mulberry32) so a user-supplied seed reproduces the exact
    // same map — the fair way to compare two models on identical terrain. With no
    // seed, rand() falls through to Math.random (fresh map every game).
    _initRand() {
        if (this.seed == null || this.seed === '') { this.rand = Math.random; return; }
        let h = 1779033703 ^ String(this.seed).length;
        for (const ch of String(this.seed)) {
            h = Math.imul(h ^ ch.charCodeAt(0), 3432918353);
            h = (h << 13) | (h >>> 19);
        }
        let a = (h >>> 0) || 42;
        this.rand = function () {
            a |= 0; a = (a + 0x6D2B79F5) | 0;
            let t = Math.imul(a ^ (a >>> 15), 1 | a);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    // A fresh visibility handle in the shape fog + renderer expect.
    _handle(type) {
        return type === 'wood'
            ? { trunk: { visible: true }, leaves: { visible: true } }
            : { visible: true };
    }

    generateTerrain() {
        this._initRand();
        // Idempotent: a rematch simply regenerates the layout (the renderer
        // rebuilds its ground texture + resource entries from it in setTerrain).
        this.resources = [];
        this.generateResources();
        this.generateTrees();
        this.generateStones();
        this.generateGold();
        // Ground, water, foam and ambient cover are painted/drawn by the engine
        // (terrain mega-texture flecks replace the old instanced prop scatter).
    }

    // The map is split into four 90° wedges, one centred on each player's spawn
    // direction (top/right/bottom/left). A random point inside player `area`'s
    // wedge — used to spread food & wood evenly across players but randomly within.
    randomPosInArea(area) {
        const baseAngles = [-Math.PI / 2, 0, Math.PI / 2, Math.PI]; // matches the 4 spawn directions
        const a = baseAngles[area % 4] + (this.rand() - 0.5) * (Math.PI / 2);
        const maxR = this.size / 2 - 24; // keep off the beach/edge
        const r = 24 + this.rand() * (maxR - 24);
        return { x: Math.cos(a) * r, z: Math.sin(a) * r };
    }

    generateResources() {
        // Food (berry bushes): 272 total at full strength (68 each), spread EVENLY
        // across the 4 player areas but placed randomly within each wedge. Scaled
        // by the difficulty's food multiplier (Winter -50%, Desert -75%).
        const perArea = Math.max(1, Math.round(68 * this.diffMods().food));
        for (let area = 0; area < 4; area++) {
            for (let i = 0; i < perArea; i++) {
                const { x, z } = this.randomPosInArea(area);
                this.resources.push({ type: 'food', x, z, amount: 500, mesh: this._handle('food'), health: 500 });
            }
        }
    }

    // Remove a single resource node (its handle just goes with it).
    removeResourceNode(res) {
        const i = this.resources.indexOf(res);
        if (i >= 0) this.resources.splice(i, 1);
    }

    // Deplete a node in place: empty it and drop its handle, but KEEP it in the
    // resources array. Harvesting decrements amount and calls this at zero. We must
    // not splice here — every AI's fog memory (_knownResIdx) stores ARRAY INDICES,
    // so removing an element mid-game would shift indices and corrupt it. An empty
    // node (amount 0, mesh null) is skipped by all harvest/discovery/minimap code
    // and by the renderer's resource pass.
    depleteResourceNode(res) {
        if (!res) return;
        res.amount = 0;
        res.mesh = null; // fog visibility + minimap + renderer skip nodes without a handle
    }

    // Clear every resource node within `radius` of (x,z). Used to keep starting
    // Town Centers from spawning on top of a node (which causes harvesters to
    // insta-drop). Returns how many were removed.
    clearResourcesNear(x, z, radius) {
        let n = 0;
        for (const r of this.resources.slice()) {
            if (Math.hypot(r.x - x, r.z - z) < radius) { this.removeResourceNode(r); n++; }
        }
        return n;
    }

    generateTrees() {
        // Wood (trees): 640 total at full strength (160 each), spread EVENLY across
        // the 4 player areas but placed randomly within each wedge. Scaled by the
        // difficulty's wood multiplier (Desert -75%).
        const perArea = Math.max(1, Math.round(160 * this.diffMods().wood));
        for (let area = 0; area < 4; area++) {
            for (let t = 0; t < perArea; t++) {
                const { x, z } = this.randomPosInArea(area);
                this.resources.push({ type: 'wood', x, z, amount: 300, mesh: this._handle('wood'), health: 300 });
            }
        }
    }

    generateStones() {
        const count = Math.max(1, Math.round(40 * this.diffMods().stone)); // Desert -50%
        for (let i = 0; i < count; i++) {
            const x = (this.rand() - 0.5) * (this.size - 20);
            const z = (this.rand() - 0.5) * (this.size - 20);
            this.resources.push({ type: 'stone', x, z, amount: 1000, mesh: this._handle('stone'), health: 1000 });
        }
    }

    generateGold() {
        // Gold is crucial, so spread it via a jittered grid: one node randomly
        // placed inside each cell of a grid covering the map. This keeps placement
        // random but guarantees no large section is left without gold.
        const cells = 4; // 4x4 = 16 nodes, evenly distributed
        const usable = this.size - 60;       // keep clear of the very edge
        const cellSize = usable / cells;
        const start = -usable / 2;
        for (let cx = 0; cx < cells; cx++) {
            for (let cz = 0; cz < cells; cz++) {
                const inset = cellSize * 0.18; // jitter within the cell, off the borders
                const x = start + cx * cellSize + inset + this.rand() * (cellSize - 2 * inset);
                const z = start + cz * cellSize + inset + this.rand() * (cellSize - 2 * inset);
                this.resources.push({ type: 'gold', x, z, amount: 2000, mesh: this._handle('gold'), health: 2000 });
            }
        }
    }

    getTerrainHeight(x, z) {
        return 0; // Flat terrain for simplicity
    }

    isWalkable(x, z) {
        // Check bounds
        if (Math.abs(x) > this.size / 2 || Math.abs(z) > this.size / 2) {
            return false;
        }
        return true;
    }

    getMinimapData() {
        return {
            resources: this.resources,
            size: this.size
        };
    }
}
