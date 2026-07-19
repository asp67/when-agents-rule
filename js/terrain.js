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
        this.spawns = [];         // Town Center positions, set by the game BEFORE generateTerrain:
                                  // scatterRotational rotates one sector onto each of them
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
        this._seededNodeCounts = null;   // recounted lazily; see seededNodeCounts()
        // Ground, water, foam and ambient cover are painted/drawn by the engine
        // (terrain mega-texture flecks replace the old instanced prop scatter).
    }

    // Fairness scatter for the PLENTIFUL types (food, wood): the map is split
    // into a 7×7 grid of equal tiles and EVERY tile receives the SAME number of
    // nodes, placed uniformly within it. Matches the 7×7 grid the models already
    // reason about when exploring. A map seed still reproduces the exact layout.
    //
    // Was 3×3. Counts were equal per tile even then, but a 240-unit tile left so
    // much room for the within-tile roll that two players could still draw very
    // different hauls at the same distance from home — the residual randomness
    // that flawed same-civ arena results. A 102-unit tile cuts that jitter to
    // roughly a third. (The 3×3 itself had replaced a polar wedge scatter that
    // drew radius uniformly — density ∝ 1/r — and piled everything into the map
    // centre; see scatterRotational, which fixes that sampling rather than
    // abandoning the idea.)
    scatterEqual(type, totalCount, amount) {
        const margin = 40;                 // keep off the beach ring
        const usable = this.size - margin * 2;
        const G = 7;
        const tile = usable / G;
        const per = Math.max(1, Math.round(totalCount / (G * G)));
        for (let tx = 0; tx < G; tx++) {
            for (let tz = 0; tz < G; tz++) {
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

    // Fairness placement for the SCARCE types (stone, gold). Two dozen nodes
    // cannot fill 49 cells at any player count: forcing gold onto the grid would
    // have meant one per cell — 45 nodes, as many as Desert has food bushes. Gold
    // would stop being worth fighting over, and the Wonder runs on gold.
    //
    // Their equality is not per-CELL but per-PLAYER: lay `k` nodes in one player's
    // sector and rotate that sector onto every other. Spawns sit evenly spaced on
    // a circle, so one rotation maps a player's surroundings onto the next
    // player's node for node — same count, same radii, same angles. total = N*k is
    // EXACTLY equal for any N, needs no divisibility, and leaves the counts at
    // their intended 40 / 18 instead of inflating them.
    //
    // Radius is drawn as r = √(rMin² + u·(R² − rMin²)) — uniform by AREA. Drawing
    // r uniformly (density ∝ 1/r) is precisely the bug that discredited the old
    // wedge scatter: the idea was sound, the sampling wasn't.
    //
    // The keep-out is a RADIUS around every Town Center, not a list of grid cells:
    // spawns move with the player count (they are a circle, not four fixed
    // squares), so a hardcoded cell list only ever matched the 4-player case.
    // Testing against all spawns stays rotation-invariant, because rotating by one
    // sector maps the spawn set onto itself.
    scatterRotational(type, totalCount, amount) {
        const spawns = (this.spawns && this.spawns.length) ? this.spawns : null;
        if (!spawns) return this.scatterEqual(type, totalCount, amount); // no match context: grid it
        const N = spawns.length;
        const per = Math.max(1, Math.round(totalCount / N));
        const R = this.size / 2 - 40;   // same usable radius the grid's box spans
        const rMin = 60;                // nothing on the map's navel
        const KEEPOUT = 95;             // no stone/gold this close to ANY Town Center
        const sector = (Math.PI * 2) / N;
        const a0 = Math.atan2(spawns[0].z, spawns[0].x);
        const tooClose = (x, z) => spawns.some(s => Math.hypot(x - s.x, z - s.z) < KEEPOUT);
        for (let i = 0; i < per; i++) {
            let r = rMin, t = a0;
            for (let tries = 0; tries < 60; tries++) {
                const u = this.rand();
                r = Math.sqrt(rMin * rMin + u * (R * R - rMin * rMin));
                t = a0 + (this.rand() - 0.5) * sector;
                if (!tooClose(Math.cos(t) * r, Math.sin(t) * r)) break;
            }
            for (let p = 0; p < N; p++) {   // …and every player gets the same node
                const ang = t + p * sector;
                this.resources.push({
                    type, x: Math.cos(ang) * r, z: Math.sin(ang) * r,
                    amount, mesh: this._handle(type), health: amount
                });
            }
        }
    }

    generateResources() {
        // Food (berry bushes): base 196 → 392 / 98 / 49 nodes, EXACT on the 49-cell
        // grid at every difficulty (8 / 2 / 1 per tile — the old 272 base divided
        // into neither 9 nor 49, so the rounding quietly overshot Winter and
        // undershot Desert). Deliberately scarcer than before: bushes alone no
        // longer carry a match, which turns farms from a nicety into a real
        // tactical choice — and on Desert (114% of the food needed to reach Iron)
        // into a requirement.
        this.scatterEqual('food', 196 * this.diffMods().food, 500);
    }

    // What this map holds, per type — the size of the larder every model is told.
    //
    // Counted from the array rather than the seeding formula, because the scatter can
    // place a couple fewer than the target where a sector has no room, and a stated
    // total that quietly differs from reality is worse than none.
    //
    // Counted LAZILY, on first ask, because clearResourcesNear() splices nodes out
    // under each starting Town Center AFTER generateTerrain() runs — counting during
    // generation reported 392 food on a map that ended up with 390.
    //
    // Safe to cache from then on: depletion sets amount to 0 and KEEPS the node in
    // the array (fog memory stores array indices), so nothing is removed mid-match.
    // And a cached figure is what we want anyway — a live count would fall as nodes
    // were consumed, letting a player infer rivals mining somewhere it cannot see.
    seededNodeCounts() {
        if (!this._seededNodeCounts) {
            this._seededNodeCounts = (this.resources || []).reduce((a, r) => {
                a[r.type] = (a[r.type] || 0) + 1; return a;
            }, {});
        }
        return this._seededNodeCounts;
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
        // Wood (trees): base 784 → 784 / 784 / 196, EXACT on the grid (16 / 16 / 4
        // per tile). Up from 640: wood was never the binding constraint (5300 buys
        // every age-up against ~58k available), it pairs with the food cut to make
        // farms affordable, and it costs nothing to draw — the map's total node
        // budget is flat at ~1236, the same as before. It just reads greener.
        this.scatterEqual('wood', 784 * this.diffMods().wood, 300);
    }

    generateStones() {
        // Stone: base 40 (Desert -50%), placed ROTATIONALLY — every player gets the
        // same stone at the same distances. Count is unchanged; the 3×3 grid used to
        // round 40/9 → 4 and deliver only 36, so this also repays the 4 nodes that
        // rounding had been quietly eating.
        this.scatterRotational('stone', 40 * this.diffMods().stone, 1000);
    }

    generateGold() {
        // Gold is the Wonder's fuel and the one thing worth fighting a war over, so
        // it stays SCARCE at 18 — rotational placement makes every player's share
        // identical without diluting it. On the 49-cell grid the smallest equal
        // share would have been one per cell: 45 nodes, as many as Desert has food
        // bushes. Equal, and worthless.
        this.scatterRotational('gold', 18, 2000);
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
