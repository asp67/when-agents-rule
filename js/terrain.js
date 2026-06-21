// Terrain and map generation
class TerrainManager {
    constructor(scene, size = 200) {
        this.scene = scene;
        this.size = size;
        this.grid = [];
        this.gridSize = 2;
        this.numTiles = size / this.gridSize;
        this.resources = [];
        this.generateTerrain();
    }

    generateTerrain() {
        // Idempotent: clear any terrain from a previous call (constructor + game both call this)
        if (this.ground) this.scene.remove(this.ground);
        if (this.water) this.scene.remove(this.water);
        (this.resources || []).forEach(res => {
            if (!res.mesh) return;
            if (res.mesh.trunk) { this.scene.remove(res.mesh.trunk); this.scene.remove(res.mesh.leaves); }
            else this.scene.remove(res.mesh);
        });
        this.resources = [];

        // --- Ground: gently rolling, vertex-coloured grassland ---
        const seg = Math.min(140, Math.max(48, Math.floor(this.size / 7)));
        const geometry = new THREE.PlaneGeometry(this.size, this.size, seg, seg);
        const pos = geometry.attributes.position;
        const base = new THREE.Color(0x79b94a);   // lush green grass
        const dryC = new THREE.Color(0xb2bd66);    // subtle dry-grass tint
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

        // (Beach is baked into the ground edge vertices above — no separate plane.)

        // Generate resource nodes
        this.generateResources();
        
        // Add trees
        this.generateTrees();
        
        // Add stone deposits
        this.generateStones();
        
        // Add gold deposits
        this.generateGold();

        // Add grid lines
        this.addGridLines();
    }

    // The map is split into four 90° wedges, one centred on each player's spawn
    // direction (top/right/bottom/left). A random point inside player `area`'s
    // wedge — used to spread food & wood evenly across players but randomly within.
    randomPosInArea(area) {
        const baseAngles = [-Math.PI / 2, 0, Math.PI / 2, Math.PI]; // matches the 4 spawn directions
        const a = baseAngles[area % 4] + (Math.random() - 0.5) * (Math.PI / 2);
        const maxR = this.size / 2 - 24; // keep off the beach/edge
        const r = 24 + Math.random() * (maxR - 24);
        return { x: Math.cos(a) * r, z: Math.sin(a) * r };
    }

    generateResources() {
        // Food (animals): 272 total (~50% more than the old 180), spread EVENLY
        // across the 4 player areas (68 each) but placed randomly within each wedge.
        const perArea = 68;
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

                this.resources.push({ type: 'food', x, z, amount: 300, mesh: animal, health: 300 });
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
        // Wood (trees): 640 total, spread EVENLY across the 4 player areas (160
        // each) but placed randomly within each area's wedge.
        const perArea = 160;
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
            const leafShade = new THREE.Color(0x2f8f2f).offsetHSL(0, 0, (Math.random() - 0.5) * 0.12);
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
                amount: 200,
                mesh: { trunk, leaves },
                health: 200
            });
          }
        }
    }

    generateStones() {
        for (let i = 0; i < 40; i++) {
            const x = (Math.random() - 0.5) * (this.size - 20);
            const z = (Math.random() - 0.5) * (this.size - 20);
            
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
                amount: 400,
                mesh: stone,
                health: 400
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
                const x = start + cx * cellSize + inset + Math.random() * (cellSize - 2 * inset);
                const z = start + cz * cellSize + inset + Math.random() * (cellSize - 2 * inset);

                const gold = new THREE.Mesh(new THREE.OctahedronGeometry(1, 0), goldMat);
                gold.position.set(x, 0.8, z);
                gold.castShadow = true;
                this.scene.add(gold);

                this.resources.push({
                    type: 'gold',
                    x: x,
                    z: z,
                    amount: 250,
                    mesh: gold,
                    health: 250
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
