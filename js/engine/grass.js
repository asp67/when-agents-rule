// Decorative grass: seeded, opaque, double-sided triangles in bounded tile batches.
// No entities, simulation updates, alpha sorting or shadow-map draws.
(function () {
    const TILE = 16, TUFTS = 1024, MAX_VISIBLE = 108, MAX_CACHED = 216, INDICES_PER_TUFT = 36;
    const DRAW_RADIUS = 150;
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
    function mesh(seed, tx, tz, theme, bounds, obstacles, cover = () => 1, worldSize = 1000, layer = 0, pebbles = false) {
        let state = seedOf(seed + ':' + tx + ':' + tz + ':' + layer);
        const random = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296);
        const out = { positions: [], normals: [], uvs: [], indices: [] };
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
            if (stone) {
                // Twelve triangles, like a grass tuft: no extra batches or upload budget.
                // Negative U marks static pebbles in the shared clutter shader.
                const radius=.055+random()*.085, height=.035+random()*.065;
                const angle=random()*Math.PI*2, shade=random(), ring=[], cap=[];
                // Broad flat face with sloping shoulders instead of a pointed apex.
                const inset=.60+random()*.15;
                for(let k=0;k<4;k++) {
                    const a=angle+k*Math.PI/2, size=radius*(.8+random()*.2);
                    const dx=Math.cos(a)*size,dz=Math.sin(a)*size*.8;
                    ring.push([x+dx,.005,z+dz]);
                    cap.push([x+dx*inset,height,z+dz*inset]);
                }
                const faces=[[cap[0],cap[2],cap[1]],[cap[0],cap[3],cap[2]],
                    [ring[0],ring[1],ring[2]],[ring[0],ring[2],ring[3]]];
                for(let k=0;k<4;k++) {
                    const next=(k+1)%4;
                    faces.push([ring[k],cap[k],cap[next]],[ring[k],cap[next],ring[next]]);
                }
                for(const points of faces) {
                    const u=points[1].map((v,i)=>v-points[0][i]),v=points[2].map((v,i)=>v-points[0][i]);
                    const n=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]];
                    const length=Math.hypot(...n),base=out.positions.length/3;
                    for(const point of points){out.positions.push(...point);out.normals.push(...n.map(c=>c/length));out.uvs.push(-1,shade);}
                    out.indices.push(base,base+1,base+2);
                }
                continue;
            }
            // Continuous world-space height variation crosses tile boundaries.
            const meadow = .5 + .25*Math.sin(x*.12+z*.07) + .25*Math.sin(z*.19-x*.05);
            const angle = random() * Math.PI * 2;
            const height = .16 + moisture * (.14 + meadow*.22) + random()*.06;
            for (let blade = 0; blade < 6; blade++) {
                const a = angle + blade * Math.PI / 3, dx = Math.cos(a), dz = Math.sin(a);
                const h = height * (0.7 + random() * 0.3), w = 0.025 + random() * 0.035;
                const p = [x - dx*w, 0.018, z - dz*w, x + dx*w, 0.018, z + dz*w,
                    x + dz*h*.28, h, z - dx*h*.28];
                for (const sign of [1, -1]) {
                    const base = out.positions.length / 3;
                    out.positions.push(...p);
                    for (let k = 0; k < 3; k++) {
                        out.normals.push(-dz*0.2*sign, 0.98, dx*0.2*sign);
                        out.uvs.push(p[k*3]/worldSize+.5,p[k*3+2]/worldSize+.5);
                    }
                    out.indices.push(base, base + (sign === 1 ? 1 : 2), base + (sign === 1 ? 2 : 1));
                }
            }
        }
        return out;
    }

    class Grass {
        constructor(renderer) {
            this.renderer = renderer; this.cache = new Map(); this.visibility = new Map();
            this.cover = TexGen.grassCoverSampler(renderer._theme, TexGen.TERRAIN_SEED, TexGen.TERRAIN_WORLD);
        }
        disposeTile(tile) {
            for (const batch of tile.batches) for (const key of ['position', 'normal', 'uv', 'index']) this.renderer.gl.deleteBuffer(batch.buf[key]);
        }
        dispose() { for (const tile of this.cache.values()) this.disposeTile(tile); this.cache.clear(); }
        frame() {
            const r = this.renderer;
            const stats = r.grassStats = { patches: 0, batches: 0, tufts: 0, triangles: 0, uploaded: 0 };
            if (r.graphicsQuality !== 'cinematic' || r._halfH >= 160 || !r.terrain) return [];
            const half = Math.min(390, (r.terrain.size || 800) / 2 - 10);
            const x = r.cameraTarget.x, z = r.cameraTarget.z;
            const fow=r.game?.fogOfWar;
            if(this.fow!==fow || this.fogVersion!==fow?.visibilityVersion) {
                this.visibility.clear();this.fow=fow;this.fogVersion=fow?.visibilityVersion;
            }
            const obstacles = (r.buildings || []).filter(b => b.health > 0).map(b => ({ x: b.x, z: b.z,
                ex: (b._grassFootprint?.ex || (b.isWonder ? 12 : 8)) + 2.5,
                ez: (b._grassFootprint?.ez || (b.isWonder ? 12 : 8)) + 2.5 }));
            // Half the former square half-width, including its 0.6 padding.
            const resources = (r.terrain.resources || []).filter(o => !(o.amount <= 0)).map(o => ({
                x:o.x, z:o.z, radius:((o.type === 'wood' ? 1.5 : 3)+0.6)/2
            }));
            const candidates = [];
            for (let tz = Math.floor((z-DRAW_RADIUS)/TILE); tz <= Math.floor((z+DRAW_RADIUS)/TILE); tz++) {
                for (let tx = Math.floor((x-DRAW_RADIUS)/TILE); tx <= Math.floor((x+DRAW_RADIUS)/TILE); tx++) {
                    const cx = (tx+0.5)*TILE, cz = (tz+0.5)*TILE, distance = Math.hypot(cx-x, cz-z);
                    if (distance >= DRAW_RADIUS || Math.abs(cx) > half+TILE/2 || Math.abs(cz) > half+TILE/2 || r._cull(cx, cz, 32)) continue;
                    const key=tx+':'+tz;
                    if(!this.visibility.has(key))this.visibility.set(key,visibleRect(fow,cx,cz,TILE/2+.4,TILE/2+.4));
                    if(!this.visibility.get(key))continue;
                    candidates.push({ tx, tz, cx, cz, distance });
                }
            }
            candidates.sort((a,b) => a.distance-b.distance);
            // Fade before a budget boundary too, so changing the nearest-tile list
            // never drops a full-height patch during tracking shots.
            const edge = candidates.length > MAX_VISIBLE
                ? Math.min(DRAW_RADIUS,candidates[MAX_VISIBLE].distance) : DRAW_RADIUS;
            const entries = [];
            for (const c of candidates.slice(0, MAX_VISIBLE)) {
                const key = c.tx + ':' + c.tz;
                const near = obstacles.filter(o => Math.abs(o.x-c.cx) < TILE/2+o.ex+1 && Math.abs(o.z-c.cz) < TILE/2+o.ez+1);
                const blocked = near.concat(resources.filter(o => Math.abs(o.x-c.cx) < TILE/2+o.radius && Math.abs(o.z-c.cz) < TILE/2+o.radius));
                // Resource removal must regenerate cached grass just like construction.
                const signature = JSON.stringify(blocked);
                let tile = this.cache.get(key);
                if (tile && tile.signature !== signature) { this.disposeTile(tile); this.cache.delete(key); tile = null; }
                if (!tile) {
                    // Bound upload work when the director cuts to a distant scene.
                    if (stats.uploaded >= 3) continue;
                    const batches = [];
                    // Independent layers keep every mesh below the 16-bit index
                    // ceiling. Additional density is drawn only in close views.
                    for(let layer=0;layer<3;layer++) {
                        const data = mesh(r.terrain.seed || 1, c.tx, c.tz, r._theme, half, blocked, this.cover, TexGen.TERRAIN_WORLD,layer,true);
                        const buf = GLCore.createMeshBuffers(r.gl, data);
                        batches.push({ buf, fullCount: buf.count, tex: r.tex.terrain, noShadow: true,
                            vegetation: true, tint: [1,1,1] });
                    }
                    tile = { batches, signature };
                    this.cache.set(key, tile); stats.uploaded+=3;
                }
                // LRU retains nearby patches across cuts but never the whole map.
                this.cache.delete(key); this.cache.set(key, tile);
                const fade = Math.min(1, (160-r._halfH)/70, (edge-c.distance)/52.5);
                const close = Math.max(0,Math.min(1,(55-r._halfH)/25,(127.5-c.distance)/45));
                let drawn=false;
                tile.batches.forEach((batch,layer)=>{
                    const densityFade=fade*(layer ? close : 1);
                    batch.buf.count = Math.floor(batch.fullCount/INDICES_PER_TUFT*densityFade)*INDICES_PER_TUFT;
                    batch.model=window.M3D.scaling(1,Math.max(.05,fade),1);
                    if(batch.buf.count){entries.push(batch);drawn=true;stats.batches++;stats.tufts+=batch.buf.count/INDICES_PER_TUFT;stats.triangles+=batch.buf.count/3;}
                });
                if(drawn)stats.patches++;
            }
            while (this.cache.size > MAX_CACHED) {
                const key = this.cache.keys().next().value;
                this.disposeTile(this.cache.get(key)); this.cache.delete(key);
            }
            return entries;
        }
    }
    window.EngineGrass = { Grass, mesh, visibleRect, TILE, TUFTS, INDICES_PER_TUFT, MAX_VISIBLE, MAX_CACHED, DRAW_RADIUS };
})();
