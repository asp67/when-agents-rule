// TexGen — procedural material painters. Every texture in the engine is DRAWN
// here into an offscreen canvas at load time (seeded, so reproducible): no
// image assets, no downloads, nothing to license. This is where the classic
// look comes from — material reads (mudbrick vs wood vs grass) plus baked
// edge/AO darkening, tuned for the one locked camera angle.
(function () {
    const TexGen = {};

    // Deterministic RNG (mulberry32) so a map seed reproduces its textures.
    TexGen.rng = (seed) => {
        let s = (seed >>> 0) || 1;
        return () => {
            s |= 0; s = (s + 0x6D2B79F5) | 0;
            let t = Math.imul(s ^ (s >>> 15), 1 | s);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    };

    const canvas = (size) => {
        const c = document.createElement('canvas');
        c.width = c.height = size;
        return c;
    };

    // Tileable value noise in [0,1]: a coarse random lattice sampled with
    // bilinear interpolation and wrapped indices (so textures repeat cleanly).
    TexGen.valueNoise = (size, cells, rand) => {
        const lat = new Float32Array(cells * cells);
        for (let i = 0; i < lat.length; i++) lat[i] = rand();
        const out = new Float32Array(size * size);
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                const gx = (x / size) * cells, gy = (y / size) * cells;
                const x0 = Math.floor(gx), y0 = Math.floor(gy);
                const fx = gx - x0, fy = gy - y0;
                const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
                const i00 = lat[(y0 % cells) * cells + (x0 % cells)];
                const i10 = lat[(y0 % cells) * cells + ((x0 + 1) % cells)];
                const i01 = lat[((y0 + 1) % cells) * cells + (x0 % cells)];
                const i11 = lat[((y0 + 1) % cells) * cells + ((x0 + 1) % cells)];
                out[y * size + x] = (i00 * (1 - sx) + i10 * sx) * (1 - sy) + (i01 * (1 - sx) + i11 * sx) * sy;
            }
        }
        return out;
    };

    const clamp255 = (v) => Math.max(0, Math.min(255, Math.round(v)));

    // Fill a canvas from a base color modulated by layered noise; the workhorse
    // behind most materials. layers: [{noise, amp}] with noise in [0,1].
    const noisyFill = (ctx, size, base, layers) => {
        const img = ctx.createImageData(size, size);
        const d = img.data;
        for (let i = 0; i < size * size; i++) {
            let m = 0;
            for (const L of layers) m += (L.noise[i] - 0.5) * L.amp;
            d[i * 4] = clamp255(base[0] + m);
            d[i * 4 + 1] = clamp255(base[1] + m);
            d[i * 4 + 2] = clamp255(base[2] + m * 0.9);
            d[i * 4 + 3] = 255;
        }
        ctx.putImageData(img, 0, 0);
    };

    // ---- Materials --------------------------------------------------------------

    // Grass: layered green noise + blade speckles + sparse dirt scuffs.
    TexGen.grass = (seed = 1, size = 256) => {
        const rand = TexGen.rng(seed);
        const c = canvas(size), ctx = c.getContext('2d');
        noisyFill(ctx, size, [96, 138, 74], [
            { noise: TexGen.valueNoise(size, 8, rand), amp: 34 },
            { noise: TexGen.valueNoise(size, 32, rand), amp: 18 }
        ]);
        // blade flecks
        for (let i = 0; i < size * 22; i++) {
            const x = rand() * size, y = rand() * size;
            const g = 120 + rand() * 70;
            ctx.fillStyle = `rgba(${g * 0.55 | 0},${g | 0},${g * 0.42 | 0},0.5)`;
            ctx.fillRect(x, y, 1, 1 + rand() * 2);
        }
        // dirt scuffs
        for (let i = 0; i < 7; i++) {
            const x = rand() * size, y = rand() * size, r = 6 + rand() * 16;
            const g = ctx.createRadialGradient(x, y, 0, x, y, r);
            g.addColorStop(0, 'rgba(122,96,58,0.35)');
            g.addColorStop(1, 'rgba(122,96,58,0)');
            ctx.fillStyle = g;
            ctx.fillRect(x - r, y - r, r * 2, r * 2);
        }
        return c;
    };

    // Masonry: sandstone brick courses with mortar lines, per-brick tint and
    // baked edge shading (the AO that keeps walls from looking flat).
    TexGen.masonry = (seed = 2, size = 256) => {
        const rand = TexGen.rng(seed);
        const c = canvas(size), ctx = c.getContext('2d');
        noisyFill(ctx, size, [201, 173, 132], [
            { noise: TexGen.valueNoise(size, 16, rand), amp: 16 }
        ]);
        const rows = 8, courseH = size / rows;
        for (let r = 0; r < rows; r++) {
            const y = r * courseH;
            const offset = (r % 2) * courseH; // running bond
            const bricks = 4;
            const w = size / bricks;
            for (let b = -1; b < bricks + 1; b++) {
                const x = b * w + offset;
                const tint = (rand() - 0.5) * 26;
                ctx.fillStyle = `rgba(${clamp255(201 + tint)},${clamp255(171 + tint)},${clamp255(128 + tint * 0.8)},0.55)`;
                ctx.fillRect(x + 1.5, y + 1.5, w - 3, courseH - 3);
                // top-left light, bottom-right shade — sun-kissed bevel
                ctx.fillStyle = 'rgba(255,244,214,0.18)';
                ctx.fillRect(x + 1.5, y + 1.5, w - 3, 2);
                ctx.fillStyle = 'rgba(60,40,20,0.22)';
                ctx.fillRect(x + 1.5, y + courseH - 3.5, w - 3, 2);
            }
            // mortar lines
            ctx.fillStyle = 'rgba(94,76,54,0.5)';
            ctx.fillRect(0, y, size, 1.6);
            for (let b = 0; b < bricks + 1; b++) {
                ctx.fillRect(((b * w + offset) % size), y, 1.6, courseH);
            }
        }
        return c;
    };

    // Wood: vertical planks with grain streaks, knots and plank seams.
    TexGen.wood = (seed = 3, size = 256) => {
        const rand = TexGen.rng(seed);
        const c = canvas(size), ctx = c.getContext('2d');
        noisyFill(ctx, size, [128, 92, 58], [
            { noise: TexGen.valueNoise(size, 6, rand), amp: 20 }
        ]);
        const planks = 6, w = size / planks;
        for (let p = 0; p < planks; p++) {
            const x = p * w;
            const tint = (rand() - 0.5) * 24;
            ctx.fillStyle = `rgba(${clamp255(128 + tint)},${clamp255(92 + tint)},${clamp255(56 + tint * 0.7)},0.45)`;
            ctx.fillRect(x, 0, w, size);
            // grain streaks
            for (let i = 0; i < 26; i++) {
                const gx = x + rand() * w;
                ctx.strokeStyle = `rgba(70,46,26,${0.10 + rand() * 0.15})`;
                ctx.lineWidth = 0.8 + rand();
                ctx.beginPath();
                ctx.moveTo(gx, 0);
                ctx.bezierCurveTo(gx + (rand() - 0.5) * 6, size * 0.33, gx + (rand() - 0.5) * 6, size * 0.66, gx + (rand() - 0.5) * 4, size);
                ctx.stroke();
            }
            // occasional knot
            if (rand() < 0.7) {
                const kx = x + w * (0.3 + rand() * 0.4), ky = rand() * size, kr = 2 + rand() * 3;
                ctx.strokeStyle = 'rgba(60,38,20,0.55)';
                ctx.lineWidth = 1.2;
                ctx.beginPath();
                ctx.ellipse(kx, ky, kr, kr * 1.6, 0, 0, Math.PI * 2);
                ctx.stroke();
            }
            // plank seam with light edge
            ctx.fillStyle = 'rgba(52,34,18,0.6)';
            ctx.fillRect(x, 0, 1.4, size);
            ctx.fillStyle = 'rgba(255,226,180,0.12)';
            ctx.fillRect(x + 1.4, 0, 1, size);
        }
        return c;
    };

    window.TexGen = TexGen;
})();
