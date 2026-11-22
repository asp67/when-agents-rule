// Decorative grass: seeded, opaque, double-sided tufts, drawn instanced in bounded tiles.
// No entities, simulation updates, alpha sorting or shadow-map draws.
//
// Instanced since build 1202 (overhaul step A6). Until then a tile was a mesh of its own:
// 1,024 tufts of six blades written out corner by corner, 36,864 corners and 1.2 MB a
// layer, built on the page and uploaded, and only the High tier could afford it. Now there
// is ONE tuft (and one pebble) on the card, and a tile is a list of where its tufts stand:
// four numbers a tuft (x, z, and its height times the cosine and the sine of its turn, so
// that the shader has no angle to work out), 16 KB a layer, 75 times less. The card draws
// the one tuft once for each place in the list (GLCore.createInstances). A tile's three
// layers are one list, the denser ones after the first, and how much of it is drawn is
// just how far into the list the draw goes: one draw a tile, where High made up to three.
// That is what lets the default tier have grass at all.
(function () {
    const TILE = 16, TUFTS = 1024, MAX_VISIBLE = 108, MAX_CACHED = 216, INDICES_PER_TUFT = 36;
    const DRAW_RADIUS = 150;
    // What a tier draws. share: the part of a tile's tufts that is drawn; layers: how
    // many of a tile's layers a close view may add; pebbles: the dry ground's stones.
    // A tier that is not named draws no grass (Low).
    const TIERS = {
        cinematic: { radius: DRAW_RADIUS, visible: MAX_VISIBLE, share: 1, layers: 3, pebbles: true },
        balanced: { radius: 110, visible: 60, share: 0.5, layers: 1, pebbles: false }
    };
    // Pebbles are a few centimetres: from this camera height on they are under a pixel.
    const PEBBLE_HALF_H = 60;
    // Tile building per frame (b1007): a time budget, not one tile. A cut to a wide view
    // needs up to MAX_VISIBLE tiles, and building one a frame filled it square by square
    // over ~110 frames. BUILD_MS is spent per frame (at least one layer always) -- twice
    // that right after a cut, while more than CUT_MISSING tiles are missing: a frame
    // that cuts already reads as a change, a field filling for a second does not. A
    // tile's denser layers are built only when the camera is close enough to draw them,
    // and a new tile grows in over GROW_MS instead of popping up at full height.
    const BUILD_MS = 4, CUT_BUILD_MS = 8, CUT_MISSING = 24, GROW_MS = 350;
    const clock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
    function visibleRect(fow, x, z, ex, ez, all = false) {
        if (!fow?.fogGrid) return true;
        const half=fow.mapSize/2, step=fow.gridSize, n=fow.numTiles;
        let any=false;
        for(let gz=Math.floor((z-ez+half)/step);gz<=Math.floor((z+ez+half)/step);gz++) {
            for(let gx=Math.floor((x-ex+half)/step);gx<=Math.floor((x+ex+half)/step);gx++) {
                const visible=gx>=0&&gz>=0&&gx<n&&gz<n&&fow.fogGrid[gz*n+gx]>=1;
                if(all&&!visible)return false;
                if(visible){if(!all)return true;any=true;}
            }
        }
        return any;
    }
    function seedOf(value) {
        let n = 2166136261;
        for (const ch of String(value)) n = Math.imul(n ^ ch.charCodeAt(0), 16777619);
        return n >>> 0;
    }

    // The one tuft: six blades round a point, each a triangle seen from both sides, a
    // unit tall at its tallest. Its base corners keep their place; the shader moves the
    // tips out and up by the tuft's height (EngineAtmosphere.vertex, uInstanced). The
    // blades differ in height and width by fixed amounts, not by chance: every tuft is
    // this one, turned and stretched.
    const BLADES = [[1, .040], [.78, .030], [.92, .055], [.72, .035], [.88, .050], [.82, .028]];
    function tuftMesh() {
        const out = { positions: [], normals: [], uvs: [], indices: [] };
        BLADES.forEach(([h, w], blade) => {
            const a = blade * Math.PI / 3, dx = Math.cos(a), dz = Math.sin(a);
            const p = [-dx*w, 0.018, -dz*w, dx*w, 0.018, dz*w, dz*h*.28, h, -dx*h*.28];
            for (const sign of [1, -1]) {
                const base = out.positions.length / 3;
                out.positions.push(...p);
                for (let k = 0; k < 3; k++) { out.normals.push(-dz*0.2*sign, 0.98, dx*0.2*sign); out.uvs.push(0, 0); }
                out.indices.push(base, base + (sign === 1 ? 1 : 2), base + (sign === 1 ? 2 : 1));
            }
        });
        return out;
    }
    // The one pebble: a broad flat face with sloping shoulders, twelve triangles, a tenth
    // of a unit across. Negative U marks it as a static stone in the clutter shader.
    const STONE_RADIUS = 0.1;
    function stoneMesh() {
        const out = { positions: [], normals: [], uvs: [], indices: [] };
        const radius = STONE_RADIUS, height = .062, inset = .68, sizes = [.94, .82, 1, .88], ring = [], cap = [];
        for (let k = 0; k < 4; k++) {
            const a = k*Math.PI/2, size = radius*sizes[k], dx = Math.cos(a)*size, dz = Math.sin(a)*size*.8;
            ring.push([dx, .005, dz]);
            cap.push([dx*inset, height, dz*inset]);
        }
        const faces = [[cap[0],cap[2],cap[1]],[cap[0],cap[3],cap[2]],[ring[0],ring[1],ring[2]],[ring[0],ring[2],ring[3]]];
        for (let k = 0; k < 4; k++) { const next = (k+1)%4; faces.push([ring[k],cap[k],cap[next]],[ring[k],cap[next],ring[next]]); }
        for (const points of faces) {
            const u = points[1].map((v,i)=>v-points[0][i]), v = points[2].map((v,i)=>v-points[0][i]);
            const n = [u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]];
            const length = Math.hypot(...n), base = out.positions.length/3;
            for (const point of points) { out.positions.push(...point); out.normals.push(...n.map(c=>c/length)); out.uvs.push(-1, 0); }
            out.indices.push(base, base+1, base+2);
        }
        return out;
    }

    // Where a tile's tufts and pebbles stand: four numbers each: x, z, and the size times
    // the cosine and the sine of the turn. A tuft's size is its height; a pebble's is 1 for
    // the pebble mesh as made. By the map's seed: the same tile has the same grass. A layer
    // is a second and third sowing of the same tile.
    function instances(seed, tx, tz, theme, bounds, obstacles, cover = () => 1, layer = 0, pebbles = false) {
        let state = seedOf(seed + ':' + tx + ':' + tz + ':' + layer);
        const random = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296);
        const tufts = [], stones = [];
        const density = theme === 'winter' ? 0.06 : theme === 'desert' ? 0.12 : 1;
        for (let i = 0; i < TUFTS; i++) {
            const x = (tx + random()) * TILE, z = (tz + random()) * TILE;
            const accept = random();
            const moisture = cover(x,z);
            const patch = Math.max(0,Math.min(1,(.5+.28*Math.sin(x*.047+z*.023)+.22*Math.sin(z*.061-x*.019)-.3)/.4));
            const stone = pebbles && layer === 0 && theme !== 'winter' && accept < (1-moisture)*patch*.85;
            if ((!stone && accept >= density * Math.pow(moisture,layer ? 2 : 1)) || Math.abs(x) > bounds || Math.abs(z) > bounds) continue;
            if (obstacles.some(o => o.radius !== undefined
                ? (x-o.x)**2 + (z-o.z)**2 < o.radius**2
                : Math.abs(x - o.x) < o.ex + 0.6 && Math.abs(z - o.z) < o.ez + 0.6)) continue;
            if (stone) { const size = (.055 + random()*.085) / STONE_RADIUS, turn = random()*Math.PI*2; stones.push(x, z, size*Math.cos(turn), size*Math.sin(turn)); continue; }
            // Continuous world-space height variation crosses tile boundaries.
            const meadow = .5 + .25*Math.sin(x*.12+z*.07) + .25*Math.sin(z*.19-x*.05);
            const angle = random() * Math.PI * 2;
            const height = .16 + moisture * (.14 + meadow*.22) + random()*.06;
            tufts.push(x, z, height*Math.cos(angle), height*Math.sin(angle));
        }
        return { tufts, stones };
    }

    class Grass {
        constructor(renderer) {
            this.renderer = renderer; this.cache = new Map(); this.visibility = new Map();
            this.cover = TexGen.grassCoverSampler(renderer._theme, TexGen.TERRAIN_SEED, TexGen.TERRAIN_WORLD);
            // Without instancing (a WebGL 1 driver that lacks even the extension) there is
            // no grass: the tile-by-tile meshes are gone.
            this.can = !!GLCore.instancingOf(renderer.gl);
            this.tuft = this.stone = null;
        }
        disposeTile(tile) {
            GLCore.deleteMeshBuffers(this.renderer.gl, tile.tufts);
            if (tile.stones) GLCore.deleteMeshBuffers(this.renderer.gl, tile.stones);
        }
        dispose() {
            for (const tile of this.cache.values()) this.disposeTile(tile);
            this.cache.clear();
            for (const k of ['tuft', 'stone']) if (this[k]) { GLCore.deleteMeshBuffers(this.renderer.gl, this[k]); this[k] = null; }
        }
        frame() {
            const r = this.renderer;
            const stats = r.grassStats = { patches: 0, batches: 0, tufts: 0, triangles: 0, uploaded: 0 };
            const tier = TIERS[r.graphicsQuality];
            if (!tier || !this.can || r._halfH >= 160 || !r.terrain) return [];
            if (!this.tuft) { this.tuft = GLCore.createMeshBuffers(r.gl, tuftMesh()); this.stone = GLCore.createMeshBuffers(r.gl, stoneMesh()); }
            const half = (r.terrain.size || 800) / 2 - 10;   // was capped at 390, the 800 map's value (b1057)
            const x = r.cameraTarget.x, z = r.cameraTarget.z;
            const fow=r._fow ? r._fow() : r.game?.fogOfWar;   // the model's view swaps the fog (gamerenderer._fow)
            if(this.fow!==fow || this.fogVersion!==fow?.visibilityVersion) {
                this.visibility.clear();this.fow=fow;this.fogVersion=fow?.visibilityVersion;
            }
            // What keeps grass off the ground: buildings and resource sites. A number is made
            // of all of them each frame, and only when it differs from the last frame's are
            // they looked at tile by tile: until build 1202 every tile in view was held
            // against every building and every site every frame, which on the default tier
            // would have been most of what its grass costs the page.
            let stamp = 17;
            for (const b of r.buildings || []) if (b.health > 0) { const fp = b._grassFootprint; stamp = (stamp * 31 + b.x * 7 + b.z * 13 + (fp ? fp.ex + fp.ez * 3 : b.isWonder ? 5 : 1)) % 2147483647; }
            for (const o of r.terrain.resources || []) if (!(o.amount <= 0)) stamp = (stamp * 31 + o.x * 7 + o.z * 13 + (o.type === 'wood' ? 1 : 2)) % 2147483647;
            const changed = stamp !== this.stamp;
            this.stamp = stamp;
            let world = null;
            const blockers = c => {
                if (!world) world = {
                    obstacles: (r.buildings || []).filter(b => b.health > 0).map(b => ({ x: b.x, z: b.z,
                        ex: (b._grassFootprint?.ex || (b.isWonder ? 12 : 8)) + 2.5,
                        ez: (b._grassFootprint?.ez || (b.isWonder ? 12 : 8)) + 2.5 })),
                    // Half the former square half-width, including its 0.6 padding.
                    resources: (r.terrain.resources || []).filter(o => !(o.amount <= 0)).map(o => ({
                        x:o.x, z:o.z, radius:((o.type === 'wood' ? 1.5 : 3)+0.6)/2 })) };
                const near = world.obstacles.filter(o => Math.abs(o.x-c.cx) < TILE/2+o.ex+1 && Math.abs(o.z-c.cz) < TILE/2+o.ez+1);
                return near.concat(world.resources.filter(o => Math.abs(o.x-c.cx) < TILE/2+o.radius && Math.abs(o.z-c.cz) < TILE/2+o.radius));
            };
            const candidates = [], RADIUS = tier.radius;
            for (let tz = Math.floor((z-RADIUS)/TILE); tz <= Math.floor((z+RADIUS)/TILE); tz++) {
                for (let tx = Math.floor((x-RADIUS)/TILE); tx <= Math.floor((x+RADIUS)/TILE); tx++) {
                    const cx = (tx+0.5)*TILE, cz = (tz+0.5)*TILE, distance = Math.hypot(cx-x, cz-z);
                    if (distance >= RADIUS || Math.abs(cx) > half+TILE/2 || Math.abs(cz) > half+TILE/2 || r._cull(cx, cz, 32)) continue;
                    const key=tx+':'+tz;
                    if(!this.visibility.has(key))this.visibility.set(key,visibleRect(fow,cx,cz,TILE/2+.4,TILE/2+.4));
                    if(!this.visibility.get(key))continue;
                    candidates.push({ tx, tz, cx, cz, distance });
                }
            }
            candidates.sort((a,b) => a.distance-b.distance);
            let missing = 0;
            for (const c of candidates.slice(0, tier.visible)) if (!this.cache.has(c.tx + ':' + c.tz)) missing++;
            const now = clock(), budgetEnd = now + (missing > CUT_MISSING ? CUT_BUILD_MS : BUILD_MS);
            const canBuild = () => stats.uploaded === 0 || clock() < budgetEnd;
            const sow = (c, blocked, layer) => instances(r.terrain.seed || 1, c.tx, c.tz, r._theme, half, blocked, this.cover, layer, tier.pebbles);
            const entry = (buf, extra) => Object.assign({ buf, tex: r.tex.terrain, noShadow: true, vegetation: true, tint: [1,1,1] }, extra);
            // Fade before a budget boundary too, so changing the nearest-tile list
            // never drops a full-height patch during tracking shots.
            const edge = candidates.length > tier.visible
                ? Math.min(RADIUS,candidates[tier.visible].distance) : RADIUS;
            const entries = [];
            for (const c of candidates.slice(0, tier.visible)) {
                const key = c.tx + ':' + c.tz;
                let tile = this.cache.get(key);
                // Resource removal must regenerate cached grass just like construction: a tile
                // sown before the town last changed is held against it again.
                let blocked = null, signature = null;
                // (A tile this frame has no time left to sow is not looked into either.)
                if (!tile && !canBuild()) continue;
                if (!tile || tile.stamp !== stamp) {
                    blocked = blockers(c); signature = JSON.stringify(blocked);
                    if (tile && tile.signature !== signature) { this.disposeTile(tile); this.cache.delete(key); tile = null; }
                    else if (tile) tile.stamp = stamp;
                }
                if (!tile) {
                    // Bound upload work when the director cuts to a distant scene: the
                    // frame's budget, nearest tiles first. The base layer comes first.
                    if (!canBuild()) continue;
                    const first = sow(c, blocked, 0);
                    tile = { list: first.tufts, counts: [first.tufts.length / 4], blocked, signature, stamp, born: now,
                        tufts: GLCore.createInstances(r.gl, this.tuft, new Float32Array(first.tufts)),
                        stones: first.stones.length ? GLCore.createInstances(r.gl, this.stone, new Float32Array(first.stones)) : null };
                    tile.entry = entry(tile.tufts);
                    if (tile.stones) tile.stoneEntry = entry(tile.stones);
                    stats.uploaded++;
                    this.cache.set(key, tile);
                }
                // LRU retains nearby patches across cuts but never the whole map.
                this.cache.delete(key); this.cache.set(key, tile);
                const grow = Math.min(1, (now - (tile.born || 0)) / GROW_MS);
                // (The band a tile fades in over is a third of the circle, on either tier.)
                const fade = Math.min(1, (160-r._halfH)/70, (edge-c.distance)/(52.5*RADIUS/DRAW_RADIUS)) * grow;
                const close = Math.max(0,Math.min(1,(55-r._halfH)/25,(127.5-c.distance)/45));
                // The denser layers, once a close view would draw them: sown after the
                // first in the same list, which is sent to the card again whole.
                while (close > 0 && tile.counts.length < tier.layers && canBuild()) {
                    const more = sow(c, tile.blocked, tile.counts.length).tufts;
                    for (let i = 0; i < more.length; i++) tile.list.push(more[i]);
                    tile.counts.push(tile.list.length / 4);
                    GLCore.setInstances(r.gl, tile.tufts, new Float32Array(tile.list));
                    stats.uploaded++;
                }
                // How far into the list the draw goes: the first layer by the fade, the
                // denser ones by how close the view is as well.
                const base = tile.counts[0], dense = tile.counts[tile.counts.length - 1] - base;
                const drawn = Math.floor((base + dense * close) * fade * tier.share);
                if (!drawn) continue;
                const model = window.M3D.scaling(1,Math.max(.05,fade),1);
                tile.tufts.instances = drawn;
                tile.entry.model = model;
                entries.push(tile.entry);
                stats.patches++; stats.batches++; stats.tufts += drawn; stats.triangles += drawn * INDICES_PER_TUFT / 3;
                if (tile.stones && r._halfH < PEBBLE_HALF_H && close > 0) {
                    tile.stoneEntry.model = model;
                    entries.push(tile.stoneEntry);
                    stats.batches++; stats.triangles += tile.stones.instances * 12;
                }
            }
            while (this.cache.size > MAX_CACHED) {
                const key = this.cache.keys().next().value;
                this.disposeTile(this.cache.get(key)); this.cache.delete(key);
            }
            return entries;
        }
    }
    window.EngineGrass = { Grass, instances, tuftMesh, stoneMesh, visibleRect, TIERS, TILE, TUFTS, INDICES_PER_TUFT, MAX_VISIBLE, MAX_CACHED, DRAW_RADIUS, PEBBLE_HALF_H, STONE_RADIUS };
})();
