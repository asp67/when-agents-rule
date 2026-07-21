// Terrain and map generation
// Difficulty presets: resource-count multipliers + a ground colour theme.
// The multipliers below are against the scatter counts at the call sites, NOT against
// each other, which the old comment here confused: it called easy "full resources" when
// easy DOUBLES food, and described medium as -50% food when against easy it is -75%.
// What a player actually compares is each preset against easy, so in those terms:
//   easy   = Summer Valley  392 food, 784 wood, 40 stone  (the baseline)
//   medium = Winter Valley  food x0.25                    (98 food)
//   hard   = Desert         food x0.125, wood x0.25, stone x0.5  (49 / 196 / 20)
// Gold has no entry and is deliberately identical in all three — 18 patches — so the
// scarcest resource is never what separates the presets.
// The setup screen derives its summary from this table rather than restating it, so
// changing a number here changes what the player is told.
const DIFFICULTY_MODS = {
    easy:   { food: 2.0,  wood: 1.0,  stone: 1.0, base: 0x79b94a, dry: 0xb2bd66 },
    medium: { food: 0.5,  wood: 1.0,  stone: 1.0, base: 0x9db9b3, dry: 0xcdd6d2 },
    hard:   { food: 0.25, wood: 0.25, stone: 0.5, base: 0xcdb886, dry: 0xc2a868 }
};

// ---- Where the land actually ends -------------------------------------------
// The coast is a wobbled square, NOT the ±size/2 box isWalkable used to assume:
// TexGen paints it at chebyshev radius + noise, so the real waterline swings
// between about 390 and 416. Nothing ever called isWalkable anyway, which is how
// units came to stand in the sea. Resolved per DIRECTION and cached for the
// session — the coast follows a fixed seed (only resources and props follow the
// map seed), and this is consulted for every unit every tick, which is no place
// for a root-find.
const COAST_LIMIT_N = 1024;
// A few units inland of the waterline — the surf's inner edge sits at LAND+3 — so
// units stop on sand rather than paddling in the shallows.
const COAST_WALK_DIST = 396;
let COAST_LIMIT = null;

function coastLimitTable() {
    if (COAST_LIMIT) return COAST_LIMIT;
    const wob = TexGen.coastSampler(TexGen.TERRAIN_SEED);
    const W = TexGen.TERRAIN_WORLD;
    const lim = new Float32Array(COAST_LIMIT_N + 1);
    for (let i = 0; i <= COAST_LIMIT_N; i++) {
        const t = (i / COAST_LIMIT_N) * 4, side = Math.min(3, Math.floor(t)), s = t - side;
        const p = side === 0 ? [1, s * 2 - 1] : side === 1 ? [1 - s * 2, 1]
            : side === 2 ? [-1, 1 - s * 2] : [s * 2 - 1, -1];
        // The same bisection the surf ribbon uses: dist(r) = r + wobble(r) is
        // strictly increasing, so this lands exactly where iteration only crept.
        let lo = COAST_WALK_DIST - TexGen.COAST_WOBBLE;
        let hi = COAST_WALK_DIST + TexGen.COAST_WOBBLE;
        for (let k = 0; k < 18; k++) {
            const mid = (lo + hi) / 2;
            const d = mid + wob((mid * p[0]) / W + 0.5, (mid * p[1]) / W + 0.5);
            if (d < COAST_WALK_DIST) lo = mid; else hi = mid;
        }
        lim[i] = (lo + hi) / 2;
    }
    COAST_LIMIT = lim;
    return lim;
}

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

    // How many nodes of each type still hold anything, RIGHT NOW. Handed to every
    // model so scarcity is visible: a wood figure sliding from 196 toward 40 is the
    // signal to stop prospecting and start farming.
    //
    // Live, not a snapshot of the seeded map, and that was a deliberate reversal.
    // A fixed starting figure goes stale the moment nodes are consumed — on a desert
    // map seeded with 49 food, a model that had found 4 would read "45 still out
    // there" long after they were gone, and keep scouting instead of building farms.
    // The harness would be causing the bad play, with a number that was true once.
    //
    // The cost, accepted knowingly: consumption by rivals is inferable in aggregate.
    // A player that drained 5 nodes while the total fell 50 can tell the other 45
    // went somewhere it cannot see. There is no position, no attribution and no way
    // to tell one rival from another in it — and unlike a stale figure, it never
    // misleads.
    //
    // Depleted nodes stay in the resources array (fog memory stores array indices),
    // so this counts amount > 0 rather than array length.
    nodesLeftOnMap() {
        return (this.resources || []).reduce((a, r) => {
            if (r.amount > 0) a[r.type] = (a[r.type] || 0) + 1;
            return a;
        }, {});
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

    // Chebyshev radius of the shoreline in the direction of (x, z).
    landLimit(x, z) {
        const lim = coastLimitTable();
        const ax = Math.abs(x), az = Math.abs(z);
        if (ax < 1e-6 && az < 1e-6) return lim[0];
        // Which side of the square this direction falls on, in the same perimeter
        // parameter the table was built over.
        let t;
        if (ax >= az) { const pz = z / ax; t = x > 0 ? (pz + 1) / 2 : 2 + (1 - pz) / 2; }
        else          { const px = x / az; t = z > 0 ? 1 + (1 - px) / 2 : 3 + (px + 1) / 2; }
        // Interpolate between entries rather than rounding to one: the coast's
        // slope is near 1, so snapping to the nearest of 1024 directions carried a
        // ~0.08-unit error straight into the answer for no reason.
        const f = Math.min(COAST_LIMIT_N, Math.max(0, (t / 4) * COAST_LIMIT_N));
        const i0 = Math.floor(f), i1 = Math.min(COAST_LIMIT_N, i0 + 1), a = f - i0;
        return lim[i0] * (1 - a) + lim[i1] * a;
    }

    isWalkable(x, z) {
        return Math.max(Math.abs(x), Math.abs(z)) <= this.landLimit(x, z);
    }

    // Pull a point back to the shoreline along its chebyshev ray. Scaling keeps the
    // direction, so the limit at the returned point is the one we just solved for.
    // Returns the point unchanged when it is already ashore.
    clampToLand(x, z) {
        const cheb = Math.max(Math.abs(x), Math.abs(z));
        const lim = this.landLimit(x, z);
        if (cheb <= lim) return { x, z };
        const k = lim / cheb;
        return { x: x * k, z: z * k };
    }

    getMinimapData() {
        return {
            resources: this.resources,
            size: this.size
        };
    }
}
