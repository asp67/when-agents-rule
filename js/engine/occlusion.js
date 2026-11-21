// EngineOcclusion — a top-down map of the ground, for two things the shader reads from it:
//
//   what stands on it (contact shading, overhaul step A2): the ground and the grass sit in
//   soft darkness where a building, a tree or a rock meets them;
//
//   where it has been walked on (lived-in ground, overhaul step A3): paths appear where
//   workers and armies really go, the earth is packed around buildings, and a fight
//   leaves the ground scarred.
//
// One 1024 x 1024 texture over the playable square, two channels: 0 open ground to 1 right
// under something, and 0 untouched to 1 worn bare. What stands is painted on a 2-D canvas
// from the things themselves; wear is added up in memory as it happens and slowly grows
// over again. Both are kept in tiles of 64 pixels, and only the tiles something changed
// in are sent to the card: a woodcutter felling a tree costs one or two small tiles, not
// the map.
//
// Presentation only. It reads where things stand and go, and decides nothing.
(function () {
    const SIZE = 1024, TILE = 64, N = SIZE / TILE;
    // How far past its own edge a thing can darken the ground, in world units: how far
    // around a change the tiles are painted again, and how far outside a tile its painter
    // looks for things that reach into it.
    const REACH = 4.2;
    // A round thing fades out this far beyond its radius. A box is painted this much wider
    // than its walls and then blurred by this much, so the ground is darkest along the
    // wall and clear some four units out.
    const ROUND_FADE = 1.8, BOX_GROW = 0.8, BOX_BLUR = 3.2;
    // Wear grows over again: one step of 255 every REGROW_MS, a strip of rows at a time. A
    // path walked bare is green again some forty minutes after the last foot; a single
    // crossing is gone in a few.
    const REGROW_MS = 10000, REGROW_STRIPS = 16;

    class OcclusionMap {
        // span: the side of the square the map covers, in world units, centred on the origin.
        // makeCanvas: () => a canvas (the page's document.createElement in the engine).
        constructor(span, makeCanvas) {
            this.span = span;
            this.perUnit = SIZE / span;                 // pixels per world unit
            this.canvas = makeCanvas ? makeCanvas(SIZE) : null;
            // Read back tile by tile, so it is asked to stay in main memory.
            this.ctx = this.canvas ? this.canvas.getContext('2d', { willReadFrequently: true }) : null;
            this.occ = new Uint8Array(SIZE * SIZE);     // what stands, as last painted
            this.wear = new Uint8Array(SIZE * SIZE);    // where it has been walked
            this.dirty = new Set();                     // tiles whose standing things changed: painted again
            this.stale = new Set();                     // tiles whose wear changed: sent again as they are
            for (let i = 0; i < N * N; i++) this.dirty.add(i);
            this.texture = null;
            this.painted = 0;                           // tiles painted so far, for tests
            this.sent = 0;                              // tiles sent to the card so far
            this._strip = 0; this._regrown = null;
        }

        px(world) { return (world / this.span + 0.5) * SIZE; }

        // Something that stands changed inside this circle: the tiles it can reach are painted again.
        touch(x, z, r) {
            const reach = (r || 0) + REACH, t = v => Math.floor(this.px(v) / TILE);
            const x0 = Math.max(0, t(x - reach)), x1 = Math.min(N - 1, t(x + reach));
            const z0 = Math.max(0, t(z - reach)), z1 = Math.min(N - 1, t(z + reach));
            for (let tz = z0; tz <= z1; tz++) for (let tx = x0; tx <= x1; tx++) this.dirty.add(tz * N + tx);
        }
        touchAll() { for (let i = 0; i < N * N; i++) this.dirty.add(i); }

        // The world rectangle a tile shows, widened by what can reach into it.
        tileWorld(index) {
            const tx = index % N, tz = Math.floor(index / N), w = TILE / this.perUnit;
            const x0 = (tx * TILE / SIZE - 0.5) * this.span, z0 = (tz * TILE / SIZE - 0.5) * this.span;
            return { tx, tz, x0: x0 - REACH, z0: z0 - REACH, x1: x0 + w + REACH, z1: z0 + w + REACH };
        }

        // The ground was trodden here: `amount` (of 255) at the centre, falling off to nothing
        // at `radius` world units. Adds up, to worn bare and no further.
        tread(x, z, amount, radius) {
            const cx = this.px(x), cz = this.px(z), r = Math.max(0.75, (radius || 1) * this.perUnit);
            const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(SIZE - 1, Math.ceil(cx + r));
            const z0 = Math.max(0, Math.floor(cz - r)), z1 = Math.min(SIZE - 1, Math.ceil(cz + r));
            if (x0 > x1 || z0 > z1) return;
            const wear = this.wear;
            let hit = false;
            for (let pz = z0; pz <= z1; pz++) for (let px = x0; px <= x1; px++) {
                const d = Math.hypot(px + 0.5 - cx, pz + 0.5 - cz) / r;
                if (d >= 1) continue;
                const i = pz * SIZE + px, v = wear[i] + amount * (1 - d * d);
                wear[i] = v > 255 ? 255 : v;
                hit = true;
            }
            if (!hit) return;
            for (let tz = Math.floor(z0 / TILE); tz <= Math.floor(z1 / TILE); tz++)
                for (let tx = Math.floor(x0 / TILE); tx <= Math.floor(x1 / TILE); tx++) this.stale.add(tz * N + tx);
        }
        // A way from one place to another, trodden along its length.
        treadLine(x0, z0, x1, z1, amount, radius) {
            const len = Math.hypot(x1 - x0, z1 - z0), steps = Math.max(1, Math.ceil(len / Math.max(0.4, (radius || 1) * 0.8)));
            for (let i = 1; i <= steps; i++) this.tread(x0 + (x1 - x0) * i / steps, z0 + (z1 - z0) * i / steps, amount, radius);
        }
        clearWear() {
            this.wear.fill(0);
            for (let i = 0; i < N * N; i++) this.stale.add(i);
        }
        // Grows over again with time: one strip of rows per call falls by a step, so the whole
        // map takes REGROW_MS and no frame carries more than a sixteenth of it.
        regrow(now) {
            if (this._regrown == null) { this._regrown = now; return 0; }
            const due = Math.floor((now - this._regrown) / (REGROW_MS / REGROW_STRIPS));
            if (due < 1) return 0;
            this._regrown = now;
            const wear = this.wear, rows = SIZE / REGROW_STRIPS, z0 = this._strip * rows;
            this._strip = (this._strip + 1) % REGROW_STRIPS;
            let changed = 0;
            for (let tz = Math.floor(z0 / TILE); tz < (z0 + rows) / TILE; tz++) for (let tx = 0; tx < N; tx++) {
                let any = false;
                for (let pz = Math.max(z0, tz * TILE); pz < Math.min(z0 + rows, (tz + 1) * TILE); pz++) {
                    const row = pz * SIZE + tx * TILE;
                    for (let i = row; i < row + TILE; i++) if (wear[i]) { wear[i]--; any = true; }
                }
                if (any) { this.stale.add(tz * N + tx); changed++; }
            }
            return changed;
        }

        // Paints the tiles whose standing things changed, and sends those and the tiles whose
        // wear changed to the card: up to `budget` tiles in all.
        // blobsIn(x0, z0, x1, z1) -> what stands in that world rectangle:
        //   { x, z, r, strength }            a round thing (a tree, a rock)
        //   { x, z, ex, ez, strength }       a box by its half-sides (a building)
        // Returns how many tiles were sent.
        sync(gl, blobsIn, budget = 24) {
            if (!this.ctx || !(this.dirty.size || this.stale.size)) return 0;
            if (!this.texture) {
                this.texture = gl.createTexture();
                gl.bindTexture(gl.TEXTURE_2D, this.texture);
                gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE_ALPHA, SIZE, SIZE, 0, gl.LUMINANCE_ALPHA, gl.UNSIGNED_BYTE, new Uint8Array(SIZE * SIZE * 2));
                gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            }
            const ctx = this.ctx, both = this._both || (this._both = new Uint8Array(TILE * TILE * 2));
            let done = 0;
            gl.bindTexture(gl.TEXTURE_2D, this.texture);
            gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
            const send = index => {
                const px = (index % N) * TILE, pz = Math.floor(index / N) * TILE;
                for (let row = 0, o = 0; row < TILE; row++) {
                    const at = (pz + row) * SIZE + px;
                    for (let i = at; i < at + TILE; i++) { both[o++] = this.occ[i]; both[o++] = this.wear[i]; }
                }
                gl.texSubImage2D(gl.TEXTURE_2D, 0, px, pz, TILE, TILE, gl.LUMINANCE_ALPHA, gl.UNSIGNED_BYTE, both);
                this.sent++; done++;
            };
            for (const index of this.dirty) {
                if (done >= budget) break;
                this.dirty.delete(index); this.stale.delete(index);
                const t = this.tileWorld(index), px = t.tx * TILE, pz = t.tz * TILE;
                ctx.save();
                ctx.beginPath(); ctx.rect(px, pz, TILE, TILE); ctx.clip();
                ctx.globalCompositeOperation = 'source-over';
                ctx.fillStyle = '#000';
                ctx.fillRect(px, pz, TILE, TILE);
                // Where two things overlap the ground is as dark as under the darker one,
                // not darker than either.
                ctx.globalCompositeOperation = 'lighten';
                for (const b of blobsIn(t.x0, t.z0, t.x1, t.z1) || []) this.paint(b);
                ctx.restore();
                const data = ctx.getImageData(px, pz, TILE, TILE).data;
                for (let row = 0, i = 0; row < TILE; row++) {
                    const at = (pz + row) * SIZE + px;
                    for (let col = 0; col < TILE; col++, i += 4) this.occ[at + col] = data[i];
                }
                this.painted++;
                send(index);
            }
            for (const index of this.stale) {
                if (done >= budget) break;
                this.stale.delete(index);
                send(index);
            }
            gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
            return done;
        }

        // One thing on the map: full strength under it, fading to nothing a little way out.
        paint(b) {
            const ctx = this.ctx, k = this.perUnit, v = Math.round(255 * Math.max(0, Math.min(1, b.strength == null ? 1 : b.strength)));
            const x = this.px(b.x), z = this.px(b.z), grey = 'rgb(' + v + ',' + v + ',' + v + ')';
            if (b.r != null) {
                const inner = Math.max(0.5, b.r * 0.55 * k), outer = (b.r + ROUND_FADE) * k;
                const g = ctx.createRadialGradient(x, z, inner, x, z, outer);
                g.addColorStop(0, grey); g.addColorStop(1, '#000');
                ctx.fillStyle = g;
                ctx.beginPath(); ctx.arc(x, z, outer, 0, Math.PI * 2); ctx.fill();
                return;
            }
            // A box: the canvas blurs a shape's shadow for us. The shape itself is drawn far
            // off the canvas and only its shadow lands here.
            const FAR = SIZE * 4, ex = (b.ex + BOX_GROW) * k, ez = (b.ez + BOX_GROW) * k;
            ctx.shadowColor = grey; ctx.shadowBlur = BOX_BLUR * k; ctx.shadowOffsetX = FAR; ctx.shadowOffsetY = 0;
            ctx.fillStyle = '#fff';
            ctx.fillRect(x - ex - FAR, z - ez, ex * 2, ez * 2);
            ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetX = 0;
        }

        dispose(gl) { if (this.texture) gl.deleteTexture(this.texture); this.texture = null; }
    }

    const EngineOcclusion = { Map: OcclusionMap, SIZE, TILE, TILES: N, REACH, REGROW_MS, REGROW_STRIPS };
    if (typeof window !== 'undefined') window.EngineOcclusion = EngineOcclusion;
    if (typeof module !== 'undefined' && module.exports) module.exports = EngineOcclusion;
})();
