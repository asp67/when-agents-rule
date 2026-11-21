// EngineOcclusion — contact shading (overhaul step A2): a top-down map of what stands on
// the ground, so the ground and the grass can sit in soft darkness where a building, a
// tree or a rock meets them.
//
// One 1024 x 1024 texture over the playable square, one channel: 0 open ground, 1 right
// under something. It is painted on a 2-D canvas, in tiles of 64 pixels, and only the
// tiles something changed in are painted again and sent to the card: a woodcutter
// felling a tree costs one or two small tiles, not the map.
//
// Presentation only. It reads where things stand and decides nothing.
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

    class OcclusionMap {
        // span: the side of the square the map covers, in world units, centred on the origin.
        // makeCanvas: () => a canvas (the page's document.createElement in the engine).
        constructor(span, makeCanvas) {
            this.span = span;
            this.perUnit = SIZE / span;                 // pixels per world unit
            this.canvas = makeCanvas ? makeCanvas(SIZE) : null;
            // Read back tile by tile, so it is asked to stay in main memory.
            this.ctx = this.canvas ? this.canvas.getContext('2d', { willReadFrequently: true }) : null;
            this.dirty = new Set();
            for (let i = 0; i < N * N; i++) this.dirty.add(i);
            this.texture = null;
            this.painted = 0;                           // tiles painted so far, for the frame readout and tests
        }

        px(world) { return (world / this.span + 0.5) * SIZE; }

        // Something changed inside this circle: the tiles it can reach are painted again.
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

        // Paints up to `budget` of the changed tiles and sends them to the card.
        // blobsIn(x0, z0, x1, z1) -> what stands in that world rectangle:
        //   { x, z, r, strength }            a round thing (a tree, a rock)
        //   { x, z, ex, ez, strength }       a box by its half-sides (a building)
        // Returns how many tiles were painted.
        sync(gl, blobsIn, budget = 24) {
            if (!this.ctx || !this.dirty.size) return 0;
            if (!this.texture) {
                this.texture = gl.createTexture();
                gl.bindTexture(gl.TEXTURE_2D, this.texture);
                gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, SIZE, SIZE, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, new Uint8Array(SIZE * SIZE));
                gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            }
            const ctx = this.ctx, lum = this._lum || (this._lum = new Uint8Array(TILE * TILE));
            let done = 0;
            gl.bindTexture(gl.TEXTURE_2D, this.texture);
            gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
            for (const index of this.dirty) {
                if (done >= budget) break;
                this.dirty.delete(index);
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
                for (let i = 0; i < lum.length; i++) lum[i] = data[i * 4];
                gl.texSubImage2D(gl.TEXTURE_2D, 0, px, pz, TILE, TILE, gl.LUMINANCE, gl.UNSIGNED_BYTE, lum);
                done++;
            }
            gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
            this.painted += done;
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

    const EngineOcclusion = { Map: OcclusionMap, SIZE, TILE, TILES: N, REACH };
    if (typeof window !== 'undefined') window.EngineOcclusion = EngineOcclusion;
    if (typeof module !== 'undefined' && module.exports) module.exports = EngineOcclusion;
})();
