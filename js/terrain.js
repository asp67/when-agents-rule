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

class TerrainManager {
    constructor(scene, size = 200) {
        this.scene = scene;
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

    generateTerrain() {
        this._initRand();
        // Idempotent: clear any terrain from a previous call (constructor + game both call this)
        if (this.ground) this.scene.remove(this.ground);
        if (this.water) this.scene.remove(this.water);
        (this.resources || []).forEach(res => {
            if (!res.mesh) return;
            if (res.mesh.trunk) { this.scene.remove(res.mesh.trunk); this.scene.remove(res.mesh.leaves); }
            else this.scene.remove(res.mesh);
        });
        this.resources = [];
        // Ambient ground-cover props from the previous map (instanced; disposed fully)
        (this.propMeshes || []).forEach(m => {
            this.scene.remove(m);
            if (m.geometry) m.geometry.dispose();
            if (m.material) m.material.dispose();
        });
        this.propMeshes = [];

        // --- Ground: gently rolling, vertex-coloured grassland ---
        const seg = Math.min(140, Math.max(48, Math.floor(this.size / 7)));
        const geometry = new THREE.PlaneGeometry(this.size, this.size, seg, seg);
        const pos = geometry.attributes.position;
        const mods = this.diffMods();
        const base = new THREE.Color(mods.base);   // ground colour (theme per difficulty)
        const dryC = new THREE.Color(mods.dry);    // subtle dry-patch tint
        const sandC = new THREE.Color(0xcbb784);   // beach sand
        const tmp = new THREE.Color();
        const colors = [];
        const half = this.size / 2;
        const beachStart = half - 26;  // grass fades to sand within this band of the edge
        for (let i = 0; i < pos.count; i++) {
            const x = pos.getX(i), y = pos.getY(i);
            // Flat ground (matches getTerrainHeight=0) so lighting stays even and
            // buildings/units never float; visual interest comes from colour only.
            pos.setZ(i, 0);
            const n = Math.sin(x * 0.08) * Math.cos(y * 0.09);   // fine brightness noise
            const lift = 0.94 + 0.10 * n;
            const patch = Math.sin(x * 0.045) * Math.cos(y * 0.05);
            tmp.copy(base).multiplyScalar(lift);
            if (patch > 0.78) tmp.lerp(dryC, (patch - 0.78) * 1.4);
            // Square sandy beach baked into the edge vertices (no separate plane,
            // so nothing can z-fight the ground).
            const edge = Math.max(Math.abs(x), Math.abs(y));
            if (edge > beachStart) {
                tmp.lerp(sandC, Math.min(1, (edge - beachStart) / 26));
            }
            colors.push(tmp.r, tmp.g, tmp.b);
        }
        geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
        geometry.computeVertexNormals();
        const material = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
        this.ground = new THREE.Mesh(geometry, material);
        this.ground.rotation.x = -Math.PI / 2;
        this.ground.position.y = -0.1;
        this.ground.receiveShadow = true;
        this.scene.add(this.ground);

        // --- Water: broad plane below the map edges for an island feel ---
        const waterGeo = new THREE.PlaneGeometry(this.size * 3, this.size * 3);
        const waterMat = new THREE.MeshLambertMaterial({ color: 0x2c6c8c, transparent: true, opacity: 0.9 });
        this.water = new THREE.Mesh(waterGeo, waterMat);
        this.water.rotation.x = -Math.PI / 2;
        this.water.position.y = -2.4;
        this.water.receiveShadow = false;
        this.scene.add(this.water);

        // --- Shoreline foam: soft white surf band hugging the island footprint,
        // sitting just above the water. Its opacity pulses gently (renderer).
        if (this.foam) { this.scene.remove(this.foam); this.foam.geometry.dispose(); this.foam.material.dispose(); }
        const outer = this.size / 2 + 9, inner = this.size / 2 - 2;
        const foamShape = new THREE.Shape();
        foamShape.moveTo(-outer, -outer); foamShape.lineTo(outer, -outer);
        foamShape.lineTo(outer, outer); foamShape.lineTo(-outer, outer); foamShape.closePath();
        const foamHole = new THREE.Path();
        foamHole.moveTo(-inner, -inner); foamHole.lineTo(inner, -inner);
        foamHole.lineTo(inner, inner); foamHole.lineTo(-inner, inner); foamHole.closePath();
        foamShape.holes.push(foamHole);
        this.foam = new THREE.Mesh(
            new THREE.ShapeGeometry(foamShape),
            new THREE.MeshBasicMaterial({ color: 0xeef6f8, transparent: true, opacity: 0.4, depthWrite: false })
        );
        this.foam.rotation.x = -Math.PI / 2;
        this.foam.position.y = -2.15;
        this.scene.add(this.foam);

        // (Beach is baked into the ground edge vertices above — no separate plane.)

        // Generate resource nodes
        this.generateResources();
        
        // Add trees
        this.generateTrees();
        
        // Add stone deposits
        this.generateStones();
        
        // Add gold deposits
        this.generateGold();

        // Ambient ground cover, themed per difficulty
        this.generateAmbientProps();

        // Add grid lines
        this.addGridLines();
    }

    // Theme-aware ambient ground cover (purely cosmetic). One InstancedMesh per
    // prop kind = one draw call for hundreds of instances. Themes follow the
    // difficulty maps: Summer Valley is lush (bushes + flowers), Winter Valley is
    // sparse and frosted (snow-capped bushes + snow patches, NO flowers), the
    // Desert is dry (flat olive bushes + rust rocks, NO grass or flowers).
    // Placement uses this.rand(), so a map seed reproduces the identical scatter.
    generateAmbientProps() {
        const half = this.size / 2 - 28; // keep off the beach ring

        // Place one InstancedMesh from an explicit entry list ({x,y,z,ry,sx,sy,sz}).
        const scatterAt = (geo, colorHex, entries, opts = {}) => {
            if (!entries.length) return;
            const mat = new THREE.MeshLambertMaterial({ color: colorHex });
            if (opts.opacity != null) { mat.transparent = true; mat.opacity = opts.opacity; }
            const inst = new THREE.InstancedMesh(geo, mat, entries.length);
            inst.frustumCulled = false; // instances span the whole map
            inst.receiveShadow = true;
            const dummy = new THREE.Object3D();
            entries.forEach((e, i) => {
                dummy.position.set(e.x, e.y, e.z);
                dummy.rotation.set(0, e.ry || 0, 0);
                dummy.scale.set(e.sx, e.sy, e.sz);
                dummy.updateMatrix();
                inst.setMatrixAt(i, dummy.matrix);
            });
            inst.instanceMatrix.needsUpdate = true;
            this.scene.add(inst);
            this.propMeshes.push(inst);
        };

        // Random uniform scatter (uniform footprint, optional vertical flattening).
        const scatter = (geo, colorHex, count, yBase, opts = {}) => {
            const sMin = opts.sMin || 0.7, sMax = opts.sMax || 1.4, fl = opts.flatten || 1;
            const entries = [];
            for (let i = 0; i < count; i++) {
                const s = sMin + this.rand() * (sMax - sMin);
                entries.push({
                    x: (this.rand() * 2 - 1) * half, y: yBase * s, z: (this.rand() * 2 - 1) * half,
                    ry: this.rand() * Math.PI * 2, sx: s, sy: s * fl, sz: s
                });
            }
            scatterAt(geo, colorHex, entries, opts);
        };

        // Low-poly BUSHES (the old cone "tufts" read as spikes): a squashed
        // icosahedron blob, most with a smaller companion blob clumped beside it
        // in a second shade, plus an optional snow cap (winter). 2–3 draw calls.
        const bushGeo = new THREE.IcosahedronGeometry(0.36, 1);
        const makeBushes = (count, colorMain, colorSide, opts = {}) => {
            const main = [], side = [], caps = [];
            const squash = opts.squash || 0.6;
            const sMin = opts.sMin || 0.8, sMax = opts.sMax || 1.7;
            for (let i = 0; i < count; i++) {
                const x = (this.rand() * 2 - 1) * half, z = (this.rand() * 2 - 1) * half;
                const s = sMin + this.rand() * (sMax - sMin);
                main.push({ x, y: 0.36 * squash * s, z, ry: this.rand() * Math.PI * 2, sx: s, sy: s * squash, sz: s });
                if (this.rand() < 0.7) {
                    const a = this.rand() * Math.PI * 2, d = 0.34 * s;
                    const s2 = s * (0.45 + this.rand() * 0.25);
                    side.push({ x: x + Math.cos(a) * d, y: 0.36 * squash * s2, z: z + Math.sin(a) * d, ry: this.rand() * Math.PI * 2, sx: s2, sy: s2 * squash, sz: s2 });
                }
                if (opts.snowCaps) {
                    caps.push({ x, y: 0.36 * squash * s * 1.55, z, ry: this.rand() * Math.PI * 2, sx: s * 0.72, sy: s * 0.24, sz: s * 0.72 });
                }
            }
            scatterAt(bushGeo, colorMain, main);
            scatterAt(bushGeo, colorSide, side);
            if (caps.length) scatterAt(bushGeo, 0xf4f7f9, caps);
        };

        // Ambient STONES: flat, rounded, warm/dark-toned river pebbles —
        // deliberately nothing like the harvestable stone nodes (big angular
        // 0x808080 GRAY dodecahedra), so decoration can't be mistaken for a
        // resource.
        const pebbleGeo = new THREE.SphereGeometry(0.17, 6, 5);

        if (this.difficulty === 'hard') {
            // Desert: flat dry olive bushes, rust-brown rocks, dune-worn pebbles.
            makeBushes(420, 0x8a7d43, 0x9c8f55, { squash: 0.5, sMin: 0.7, sMax: 1.5 });
            scatter(new THREE.DodecahedronGeometry(0.3, 0), 0x9a7a58, 550, 0.16, { flatten: 0.7 });
            scatter(pebbleGeo, 0x9c8a6b, 320, 0.07, { flatten: 0.45 });
        } else if (this.difficulty === 'medium') {
            // Winter Valley: frosted bushes with snow caps, snow patches, slate pebbles.
            makeBushes(450, 0x5f8471, 0x6f957f, { snowCaps: true });
            const snowGeo = new THREE.CircleGeometry(0.9, 8);
            snowGeo.rotateX(-Math.PI / 2);
            scatter(snowGeo, 0xf2f6f8, 550, 0.03, { opacity: 0.9, sMin: 0.6, sMax: 1.8 });
            scatter(pebbleGeo, 0x5d6672, 380, 0.07, { flatten: 0.45 });
        } else {
            // Summer Valley: lush green bushes, flowers in three colours, earth pebbles.
            makeBushes(680, 0x3f8f3d, 0x55a84e);
            const flowerGeo = new THREE.SphereGeometry(0.11, 6, 5);
            scatter(flowerGeo, 0xf5f2e8, 220, 0.3, { sMin: 0.8, sMax: 1.2 });
            scatter(flowerGeo, 0xffd75e, 220, 0.3, { sMin: 0.8, sMax: 1.2 });
            scatter(flowerGeo, 0xe88bb0, 180, 0.3, { sMin: 0.8, sMax: 1.2 });
            scatter(pebbleGeo, 0x7d746a, 340, 0.07, { flatten: 0.45 });
        }
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
        // Food (animals): 272 total at full strength (68 each), spread EVENLY across
        // the 4 player areas but placed randomly within each wedge. Scaled by the
        // difficulty's food multiplier (Winter -50%, Desert -75%).
        const perArea = Math.max(1, Math.round(68 * this.diffMods().food));
        for (let area = 0; area < 4; area++) {
            for (let i = 0; i < perArea; i++) {
                const { x, z } = this.randomPosInArea(area);

                // Create animal mesh (small sphere to represent deer/rabbit)
                const animalGeo = new THREE.SphereGeometry(0.6, 8, 6);
                const animalMat = new THREE.MeshLambertMaterial({ color: 0x8B4513 });
                const animal = new THREE.Mesh(animalGeo, animalMat);
                animal.position.set(x, 0.6, z);
                animal.castShadow = false; // decorative; avoids shadow clutter
                this.scene.add(animal);

                this.resources.push({ type: 'food', x, z, amount: 500, mesh: animal, health: 500 });
            }
        }
    }

    // Remove a single resource node and its mesh(es) from the scene.
    removeResourceNode(res) {
        const i = this.resources.indexOf(res);
        if (i >= 0) this.resources.splice(i, 1);
        if (res && res.mesh) {
            if (res.mesh.trunk) { this.scene.remove(res.mesh.trunk); this.scene.remove(res.mesh.leaves); }
            else this.scene.remove(res.mesh);
        }
    }

    // Deplete a node in place: empty it and drop its mesh, but KEEP it in the
    // resources array. Harvesting decrements amount and calls this at zero. We must
    // not splice here — every AI's fog memory (_knownResIdx) stores ARRAY INDICES,
    // so removing an element mid-game would shift indices and corrupt it. An empty
    // node (amount 0, mesh null) is skipped by all harvest/discovery/minimap code.
    depleteResourceNode(res) {
        if (!res) return;
        res.amount = 0;
        if (res.mesh) {
            if (res.mesh.trunk) { this.scene.remove(res.mesh.trunk); this.scene.remove(res.mesh.leaves); }
            else this.scene.remove(res.mesh);
            res.mesh = null; // fog visibility + minimap skip nodes without a mesh
        }
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

            // Create tree
            const trunkGeo = new THREE.CylinderGeometry(0.3, 0.4, 2, 8);
            const trunkMat = new THREE.MeshLambertMaterial({ color: 0x8B4513 });
            const trunk = new THREE.Mesh(trunkGeo, trunkMat);
            trunk.position.set(x, 1, z);
            trunk.castShadow = false;

            const leavesGeo = new THREE.ConeGeometry(2, 4, 8);
            // slight per-tree colour variation so the forest isn't uniform
            const leafShade = new THREE.Color(0x2f8f2f).offsetHSL(0, 0, (this.rand() - 0.5) * 0.12);
            const leavesMat = new THREE.MeshLambertMaterial({ color: leafShade });
            const leaves = new THREE.Mesh(leavesGeo, leavesMat);
            leaves.position.set(x, 4, z);
            leaves.castShadow = false;
            
            this.scene.add(trunk);
            this.scene.add(leaves);
            
            this.resources.push({
                type: 'wood',
                x: x,
                z: z,
                amount: 300,
                mesh: { trunk, leaves },
                health: 300
            });
          }
        }
    }

    generateStones() {
        const count = Math.max(1, Math.round(40 * this.diffMods().stone)); // Desert -50%
        for (let i = 0; i < count; i++) {
            const x = (this.rand() - 0.5) * (this.size - 20);
            const z = (this.rand() - 0.5) * (this.size - 20);
            
            // Create stone deposit
            const stoneGeo = new THREE.DodecahedronGeometry(1.5, 0);
            const stoneMat = new THREE.MeshLambertMaterial({ color: 0x808080 });
            const stone = new THREE.Mesh(stoneGeo, stoneMat);
            stone.position.set(x, 0.8, z);
            stone.castShadow = true;
            
            this.scene.add(stone);
            
            this.resources.push({
                type: 'stone',
                x: x,
                z: z,
                amount: 1000,
                mesh: stone,
                health: 1000
            });
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
        const goldMat = new THREE.MeshLambertMaterial({
            color: 0xFFD700,
            emissive: 0xFFD700,
            emissiveIntensity: 0.3
        });
        for (let cx = 0; cx < cells; cx++) {
            for (let cz = 0; cz < cells; cz++) {
                const inset = cellSize * 0.18; // jitter within the cell, off the borders
                const x = start + cx * cellSize + inset + this.rand() * (cellSize - 2 * inset);
                const z = start + cz * cellSize + inset + this.rand() * (cellSize - 2 * inset);

                const gold = new THREE.Mesh(new THREE.OctahedronGeometry(1, 0), goldMat);
                gold.position.set(x, 0.8, z);
                gold.castShadow = true;
                this.scene.add(gold);

                this.resources.push({
                    type: 'gold',
                    x: x,
                    z: z,
                    amount: 2000,
                    mesh: gold,
                    health: 2000
                });
            }
        }
    }

    addGridLines() {
        // Intentionally no grid overlay — the harsh black grid hurt the look.
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
