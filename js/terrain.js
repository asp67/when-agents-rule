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

    // Fairness scatter: the map is split into a 3×3 grid of equal tiles (the
    // same nine sections the models' exploration compass reports) and EVERY
    // tile receives the SAME number of nodes of the given type, placed
    // uniformly within it. This replaces two sources of imbalance: the old
    // polar wedge scatter (uniform in radius → density ∝ 1/r, which piled
    // food and wood into the map center) and the one-roll-for-the-whole-map
    // stone scatter whose variance could starve a quadrant. A map seed still
    // reproduces the exact layout.
    scatterEqual(type, totalCount, amount) {
        const margin = 40;                 // keep off the beach ring
        const usable = this.size - margin * 2;
        const tile = usable / 3;
        const per = Math.max(1, Math.round(totalCount / 9));
        for (let tx = 0; tx < 3; tx++) {
            for (let tz = 0; tz < 3; tz++) {
                const x0 = -usable / 2 + tx * tile;
                const z0 = -usable / 2 + tz * tile;
                for (let i = 0; i < per; i++) {
                    const inset = 6;       // stay off the tile seams (visual clumping)
                    const x = x0 + inset + this.rand() * (tile - inset * 2);
                    const z = z0 + inset + this.rand() * (tile - inset * 2);
                    this.resources.push({ type, x, z, amount, mesh: this._handle(type), health: amount });
                }
            }
        }
    }

    generateResources() {
        // Food (berry bushes): ~272 at full strength, scaled by the difficulty's
        // food multiplier (Winter -50%, Desert -75%), equal per 3×3 tile.
        this.scatterEqual('food', 272 * this.diffMods().food, 500);
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
        // Wood (trees): ~640 at full strength, scaled by the difficulty's wood
        // multiplier (Desert -75%), equal per 3×3 tile.
        this.scatterEqual('wood', 640 * this.diffMods().wood, 300);
    }

    generateStones() {
        // Stone: ~40 at full strength (Desert -50%), equal per 3×3 tile — the
        // old single uniform roll could leave a whole quadrant stone-poor.
        this.scatterEqual('stone', 40 * this.diffMods().stone, 1000);
    }

    generateGold() {
        // Gold is crucial (the Wonder runs on it): exactly two nodes in every
        // 3×3 tile (18 total — the old 4×4 grid had 16, close enough that the
        // economy balance holds, and equality is worth the two extra nodes).
        this.scatterEqual('gold', 18, 2000);
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
