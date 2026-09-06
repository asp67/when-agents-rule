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

    // Wrapped-bilinear noise SAMPLER in [0,1]: query by (u, v) in [0,1) without
    // precomputing a full-resolution array — the terrain mega-texture samples
    // millions of pixels, so per-pixel lattice lookups beat 16MB temporaries.
    TexGen.noiseSampler = (cells, rand) => {
        const lat = new Float32Array(cells * cells);
        for (let i = 0; i < lat.length; i++) lat[i] = rand();
        return (u, v) => {
            const gx = ((u % 1) + 1) % 1 * cells, gy = ((v % 1) + 1) % 1 * cells;
            const x0 = Math.floor(gx), y0 = Math.floor(gy);
            const fx = gx - x0, fy = gy - y0;
            const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
            const i00 = lat[(y0 % cells) * cells + (x0 % cells)];
            const i10 = lat[(y0 % cells) * cells + ((x0 + 1) % cells)];
            const i01 = lat[((y0 + 1) % cells) * cells + (x0 % cells)];
            const i11 = lat[((y0 + 1) % cells) * cells + ((x0 + 1) % cells)];
            return (i00 * (1 - sx) + i10 * sx) * (1 - sy) + (i01 * (1 - sx) + i11 * sx) * sy;
        };
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

    // Bark: rough vertical ridges, darker and busier than plank wood.
    TexGen.bark = (seed = 4, size = 128) => {
        const rand = TexGen.rng(seed);
        const c = canvas(size), ctx = c.getContext('2d');
        noisyFill(ctx, size, [92, 68, 46], [
            { noise: TexGen.valueNoise(size, 10, rand), amp: 22 }
        ]);
        for (let i = 0; i < 42; i++) {
            const x = rand() * size;
            const light = rand() < 0.35;
            ctx.strokeStyle = light ? 'rgba(150,116,80,0.35)' : `rgba(44,30,18,${0.25 + rand() * 0.3})`;
            ctx.lineWidth = 1 + rand() * 1.6;
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.bezierCurveTo(x + (rand() - 0.5) * 10, size * 0.33, x + (rand() - 0.5) * 10, size * 0.66, x + (rand() - 0.5) * 8, size);
            ctx.stroke();
        }
        return c;
    };

    // Foliage: leafy clusters over a base green — canopies, bushes; optional
    // berry speckle turns it into the food bush.
    TexGen.foliage = (seed, base, opts = {}) => {
        const rand = TexGen.rng(seed || 5);
        const size = opts.size || 128;
        const c = canvas(size), ctx = c.getContext('2d');
        // Broad colour masses; lighting and crown shape supply the detail.
        // Bright baked flecks used to look like spots glued onto green balloons.
        noisyFill(ctx,size,base||[83,108,61],[
            {noise:TexGen.valueNoise(size,5,rand),amp:12},
            {noise:TexGen.valueNoise(size,12,rand),amp:4}
        ]);
        // berries
        if (opts.berries) {
            for (let i = 0; i < 42; i++) {
                const x = rand() * size, y = rand() * size, r = 1.6 + rand() * 1.6;
                ctx.fillStyle = 'rgba(90,20,26,0.9)';
                ctx.beginPath(); ctx.arc(x + 0.6, y + 0.6, r, 0, Math.PI * 2); ctx.fill();
                ctx.fillStyle = 'rgba(196,44,52,0.95)';
                ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
                ctx.fillStyle = 'rgba(255,180,180,0.8)';
                ctx.fillRect(x - r * 0.35, y - r * 0.35, 1, 1);
            }
        }
        return c;
    };

    // Rock: cracked gray stone; opts.gold laces it with bright ore veins.
    TexGen.rock = (seed, opts = {}) => {
        const rand = TexGen.rng(seed || 6);
        const size = opts.size || 128;
        const c = canvas(size), ctx = c.getContext('2d');
        noisyFill(ctx, size, opts.base || [138, 138, 142], [
            { noise: TexGen.valueNoise(size, 7, rand), amp: 26 },
            { noise: TexGen.valueNoise(size, 24, rand), amp: 12 }
        ]);
        // cracks
        for (let i = 0; i < 14; i++) {
            let x = rand() * size, y = rand() * size;
            ctx.strokeStyle = `rgba(52,52,58,${0.3 + rand() * 0.3})`;
            ctx.lineWidth = 0.8 + rand() * 0.8;
            ctx.beginPath();
            ctx.moveTo(x, y);
            for (let s = 0; s < 4; s++) {
                x += (rand() - 0.5) * 34; y += (rand() - 0.5) * 34;
                ctx.lineTo(x, y);
            }
            ctx.stroke();
        }
        // speckle
        for (let i = 0; i < size * 5; i++) {
            const v = 100 + rand() * 90;
            ctx.fillStyle = `rgba(${v | 0},${v | 0},${(v * 1.04) | 0},0.35)`;
            ctx.fillRect(rand() * size, rand() * size, 1.4, 1.4);
        }
        if (opts.gold) {
            for (let i = 0; i < 9; i++) {
                let x = rand() * size, y = rand() * size;
                ctx.strokeStyle = 'rgba(238,192,80,0.9)';
                ctx.lineWidth = 1.4 + rand() * 1.4;
                ctx.beginPath();
                ctx.moveTo(x, y);
                for (let s = 0; s < 3; s++) {
                    x += (rand() - 0.5) * 30; y += (rand() - 0.5) * 30;
                    ctx.lineTo(x, y);
                }
                ctx.stroke();
                ctx.strokeStyle = 'rgba(255,232,150,0.5)';
                ctx.lineWidth = 0.7;
                ctx.stroke();
            }
        }
        return c;
    };

    // Thatch: layered straw courses with ragged row shadows — house/farm roofs.
    TexGen.thatch = (seed = 8, size = 128) => {
        const rand = TexGen.rng(seed);
        const c = canvas(size), ctx = c.getContext('2d');
        noisyFill(ctx, size, [186, 152, 88], [
            { noise: TexGen.valueNoise(size, 12, rand), amp: 20 }
        ]);
        const rows = 7, rh = size / rows;
        for (let r = 0; r < rows; r++) {
            const y = r * rh;
            // straw strokes
            for (let i = 0; i < 60; i++) {
                const x = rand() * size;
                const v = 150 + rand() * 70;
                ctx.strokeStyle = `rgba(${v | 0},${(v * 0.8) | 0},${(v * 0.42) | 0},0.5)`;
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(x, y + 1 + rand() * 2);
                ctx.lineTo(x + (rand() - 0.5) * 4, y + rh - 1);
                ctx.stroke();
            }
            // course shadow (baked AO under each layer)
            ctx.fillStyle = 'rgba(74,52,24,0.4)';
            ctx.fillRect(0, y + rh - 2.2, size, 2.2);
            ctx.fillStyle = 'rgba(255,230,160,0.16)';
            ctx.fillRect(0, y, size, 1.6);
        }
        return c;
    };

    // Roof tiles: scalloped terracotta rows with per-tile tint and row shade.
    TexGen.rooftile = (seed = 9, size = 128) => {
        const rand = TexGen.rng(seed);
        const c = canvas(size), ctx = c.getContext('2d');
        noisyFill(ctx, size, [172, 96, 66], [
            { noise: TexGen.valueNoise(size, 14, rand), amp: 14 }
        ]);
        const rows = 6, rh = size / rows, tiles = 8, tw = size / tiles;
        for (let r = 0; r < rows; r++) {
            const y = r * rh;
            const off = (r % 2) * (tw / 2);
            for (let i = -1; i <= tiles; i++) {
                const x = i * tw + off;
                const tint = (rand() - 0.5) * 28;
                ctx.fillStyle = `rgba(${clamp255(176 + tint)},${clamp255(98 + tint * 0.7)},${clamp255(64 + tint * 0.5)},0.75)`;
                ctx.beginPath();
                ctx.arc(x + tw / 2, y + rh, tw / 2 - 0.6, Math.PI, 0);
                ctx.fill();
                ctx.strokeStyle = 'rgba(84,40,26,0.55)';
                ctx.lineWidth = 1.1;
                ctx.stroke();
            }
            ctx.fillStyle = 'rgba(70,32,20,0.35)';
            ctx.fillRect(0, y + rh - 1.6, size, 1.6);
        }
        return c;
    };

    // Plaster: warm whitewash with hairline cracks and a strong vertical baked-AO
    // gradient (lit near the eaves, grounded at the footing).
    TexGen.plaster = (seed = 10, size = 128) => {
        const rand = TexGen.rng(seed);
        const c = canvas(size), ctx = c.getContext('2d');
        noisyFill(ctx, size, [226, 214, 192], [
            { noise: TexGen.valueNoise(size, 9, rand), amp: 12 },
            { noise: TexGen.valueNoise(size, 30, rand), amp: 7 }
        ]);
        for (let i = 0; i < 6; i++) {
            let x = rand() * size, y = rand() * size * 0.6;
            ctx.strokeStyle = 'rgba(120,104,84,0.35)';
            ctx.lineWidth = 0.7;
            ctx.beginPath();
            ctx.moveTo(x, y);
            for (let s = 0; s < 3; s++) { x += (rand() - 0.5) * 18; y += 8 + rand() * 14; ctx.lineTo(x, y); }
            ctx.stroke();
        }
        // baked AO: light wash at the top, earthy grounding at the bottom
        let g = ctx.createLinearGradient(0, 0, 0, size);
        g.addColorStop(0, 'rgba(255,248,230,0.16)');
        g.addColorStop(0.75, 'rgba(0,0,0,0)');
        g.addColorStop(1, 'rgba(88,70,50,0.38)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, size, size);
        return c;
    };

    // Market awning: bold striped cloth with fabric grain and sag shading.
    TexGen.awning = (seed = 11, colA = [196, 60, 60], colB = [232, 222, 200], size = 128) => {
        const rand = TexGen.rng(seed);
        const c = canvas(size), ctx = c.getContext('2d');
        const stripes = 8, sw = size / stripes;
        for (let i = 0; i < stripes; i++) {
            const col = i % 2 === 0 ? colA : colB;
            ctx.fillStyle = `rgb(${col[0]},${col[1]},${col[2]})`;
            ctx.fillRect(i * sw, 0, sw, size);
        }
        // fabric grain + sag shadows
        for (let i = 0; i < size * 4; i++) {
            ctx.fillStyle = `rgba(60,40,30,${0.04 + rand() * 0.05})`;
            ctx.fillRect(rand() * size, rand() * size, 1.5, 1);
        }
        const g = ctx.createLinearGradient(0, 0, 0, size);
        g.addColorStop(0, 'rgba(255,255,255,0.14)');
        g.addColorStop(1, 'rgba(60,30,20,0.22)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, size, size);
        return c;
    };

    // Tilled field in three growth stages matching the farm's epoch look:
    // 'dirt' (stone age: bare turned soil + clods), 'patchy' (neolithic:
    // unorganized crop tufts), 'rows' (bronze/iron: proper furrows + grain).
    TexGen.field = (seed = 12, size = 128, stage = 'rows') => {
        const rand = TexGen.rng(seed);
        const c = canvas(size), ctx = c.getContext('2d');
        noisyFill(ctx, size, stage === 'dirt' ? [112, 84, 50] : [126, 96, 60], [
            { noise: TexGen.valueNoise(size, 16, rand), amp: 16 }
        ]);
        if (stage === 'dirt') {
            // bare soil: clods and a few pale stones, no crops yet
            for (let i = 0; i < 16; i++) {
                const x = rand() * size, y = rand() * size, r = 3 + rand() * 7;
                ctx.fillStyle = `rgba(58,40,22,${0.3 + rand() * 0.25})`;
                ctx.beginPath();
                ctx.ellipse(x, y, r, r * 0.6, rand() * 3.14, 0, Math.PI * 2);
                ctx.fill();
            }
            for (let i = 0; i < 8; i++) {
                ctx.fillStyle = 'rgba(180,164,140,0.5)';
                ctx.fillRect(rand() * size, rand() * size, 2.5, 2);
            }
            return c;
        }
        if (stage === 'patchy') {
            // scattered irregular tufts — visible crops, no order
            for (let i = 0; i < 22; i++) {
                const x = rand() * size, y = rand() * size, r = 4 + rand() * 9;
                for (let j = 0; j < 10; j++) {
                    const v = 105 + rand() * 75;
                    ctx.fillStyle = `rgba(${(v * 0.5) | 0},${v | 0},${(v * 0.38) | 0},0.8)`;
                    const a = rand() * Math.PI * 2, rr = rand() * r;
                    ctx.fillRect(x + Math.cos(a) * rr, y + Math.sin(a) * rr, 1.5, 2.5 + rand() * 2);
                }
            }
            return c;
        }
        // 'rows': dark furrow rows with grain lines
        const rows = 9, rh = size / rows;
        for (let r = 0; r < rows; r++) {
            const y = r * rh + rh / 2;
            ctx.fillStyle = 'rgba(66,46,26,0.55)';
            ctx.fillRect(0, y - 1.6, size, 3.2);
            ctx.fillStyle = 'rgba(210,180,130,0.18)';
            ctx.fillRect(0, y - 3.2, size, 1.4);
            // grain along the furrow
            for (let i = 0; i < 26; i++) {
                const x = rand() * size;
                const v = 110 + rand() * 70;
                ctx.fillStyle = `rgba(${(v * 0.5) | 0},${v | 0},${(v * 0.38) | 0},0.8)`;
                ctx.fillRect(x, y - 3 - rand() * 2.4, 1.4, 3 + rand() * 2.4);
            }
        }
        return c;
    };

    // Cloth: light woven fabric, deliberately near-white — team color arrives at
    // draw time via the uTint uniform multiplying this base (the team-color mask).
    TexGen.cloth = (seed = 13, size = 64) => {
        const rand = TexGen.rng(seed);
        const c = canvas(size), ctx = c.getContext('2d');
        noisyFill(ctx, size, [212, 206, 194], [
            { noise: TexGen.valueNoise(size, 8, rand), amp: 12 },
            { noise: TexGen.valueNoise(size, 24, rand), amp: 7 }
        ]);
        // weave: faint warp/weft lines
        ctx.fillStyle = 'rgba(120,110,96,0.10)';
        for (let i = 0; i < size; i += 3) { ctx.fillRect(0, i, size, 1); ctx.fillRect(i, 0, 1, size); }
        const g = ctx.createLinearGradient(0, 0, 0, size);
        g.addColorStop(0, 'rgba(255,252,240,0.10)');
        g.addColorStop(1, 'rgba(70,58,44,0.22)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, size, size);
        return c;
    };

    // Skin: warm tan with gentle mottling — faces and hands.
    TexGen.skin = (seed = 14, size = 32) => {
        const rand = TexGen.rng(seed);
        const c = canvas(size), ctx = c.getContext('2d');
        noisyFill(ctx, size, [212, 170, 128], [
            { noise: TexGen.valueNoise(size, 6, rand), amp: 10 }
        ]);
        return c;
    };

    // Leather: smooth mottled brown — horse hides, boots, caps.
    TexGen.leather = (seed = 15, size = 64) => {
        const rand = TexGen.rng(seed);
        const c = canvas(size), ctx = c.getContext('2d');
        noisyFill(ctx, size, [126, 90, 56], [
            { noise: TexGen.valueNoise(size, 6, rand), amp: 18 },
            { noise: TexGen.valueNoise(size, 18, rand), amp: 9 }
        ]);
        for (let i = 0; i < 20; i++) {
            const x = rand() * size, y = rand() * size, r = 3 + rand() * 8;
            const g = ctx.createRadialGradient(x, y, 0, x, y, r);
            const dark = rand() < 0.5;
            g.addColorStop(0, dark ? 'rgba(70,46,26,0.22)' : 'rgba(180,140,96,0.20)');
            g.addColorStop(1, 'rgba(0,0,0,0)');
            ctx.fillStyle = g;
            ctx.fillRect(x - r, y - r, r * 2, r * 2);
        }
        return c;
    };

    // Iron: brushed blue-gray metal with a cool top sheen — weapons and helmets.
    TexGen.iron = (seed = 16, size = 64) => {
        const rand = TexGen.rng(seed);
        const c = canvas(size), ctx = c.getContext('2d');
        noisyFill(ctx, size, [168, 172, 182], [
            { noise: TexGen.valueNoise(size, 10, rand), amp: 12 }
        ]);
        for (let i = 0; i < 40; i++) {
            const y = rand() * size;
            const light = rand() < 0.4;
            ctx.fillStyle = light ? 'rgba(230,236,246,0.18)' : 'rgba(70,76,90,0.16)';
            ctx.fillRect(0, y, size, 0.9);
        }
        const g = ctx.createLinearGradient(0, 0, 0, size);
        g.addColorStop(0, 'rgba(240,246,255,0.20)');
        g.addColorStop(1, 'rgba(40,46,60,0.24)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, size, size);
        return c;
    };

    // Solid: flat color swatch — health-bar quads and other tinted UI geometry.
    // Optional alpha (0..255) makes it a translucent ghost (building previews).
    TexGen.solid = (r = 255, g = 255, b = 255, a = 255) => {
        const c = canvas(8), ctx = c.getContext('2d');
        ctx.clearRect(0, 0, 8, 8);
        ctx.fillStyle = `rgba(${r},${g},${b},${a / 255})`;
        ctx.fillRect(0, 0, 8, 8);
        return c;
    };

    // Foam: broken white surf streaks on transparent ground, tileable along X —
    // the shoreline ring. Drawn blended with a pulsing alpha + slow UV drift.
    TexGen.foam = (seed = 17, size = 128) => {
        const rand = TexGen.rng(seed);
        const c = canvas(size), ctx = c.getContext('2d');
        for (let band = 0; band < 3; band++) {
            const y = size * (0.25 + band * 0.25);
            for (let i = 0; i < 30; i++) {
                const x = rand() * size;
                const w = 8 + rand() * 26, h = 1.5 + rand() * 2.5;
                ctx.fillStyle = `rgba(255,255,255,${0.25 + rand() * 0.45})`;
                ctx.beginPath();
                ctx.ellipse((x + w / 2) % size, y + (rand() - 0.5) * 10, w / 2, h, 0, 0, Math.PI * 2);
                ctx.fill();
            }
        }
        // fleck spray
        for (let i = 0; i < size * 2; i++) {
            ctx.fillStyle = `rgba(255,255,255,${0.15 + rand() * 0.3})`;
            ctx.fillRect(rand() * size, rand() * size, 1.4, 1.2);
        }
        return c;
    };

    // Ring: a soft-edged annulus on transparent ground — selection rings and
    // battle pings, colored at draw time via uTint. Maps onto EngineMesh.disc.
    TexGen.ring = (size = 128) => {
        const c = canvas(size), ctx = c.getContext('2d');
        const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
        g.addColorStop(0, 'rgba(255,255,255,0)');
        g.addColorStop(0.72, 'rgba(255,255,255,0)');
        g.addColorStop(0.8, 'rgba(255,255,255,0.95)');
        g.addColorStop(0.92, 'rgba(255,255,255,0.95)');
        g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, size, size);
        return c;
    };

    // Soft round contact shadow (real alpha) — the blob that grounds buildings
    // and units on any terrain. Drawn blended, not lit.
    TexGen.shadowBlob = (size = 128) => {
        const c = canvas(size), ctx = c.getContext('2d');
        const g = ctx.createRadialGradient(size / 2, size / 2, size * 0.1, size / 2, size / 2, size / 2);
        g.addColorStop(0, 'rgba(10,10,16,0.5)');
        g.addColorStop(0.7, 'rgba(10,10,16,0.32)');
        g.addColorStop(1, 'rgba(10,10,16,0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, size, size);
        return c;
    };

    // Fine limestone courses: a restrained warm stone for the Greek milestone.
    TexGen.limestone = (seed=317,size=256) => {
        const rand=TexGen.rng(seed), c=canvas(size), ctx=c.getContext('2d');
        noisyFill(ctx,size,[206,198,173],[{noise:TexGen.valueNoise(size,32,rand),amp:14}]);
        for(let row=0;row<8;row++) {
            const y=row*size/8;
            ctx.fillStyle='rgba(63,60,49,.22)';ctx.fillRect(0,y,size,1);
            for(let col=-1;col<4;col++) {
                const x=(col+(row%2)*.5)*size/3;
                ctx.fillRect(x,y,1,size/8);
                ctx.fillStyle='rgba(255,247,221,.2)';ctx.fillRect(x+1,y+1,size/3-2,1);
                ctx.fillStyle='rgba(63,60,49,.22)';
            }
        }
        return c;
    };

    // ---- Terrain mega-texture ---------------------------------------------------
    // One big canvas covering the whole map (classic pre-baked look): deep water
    // at the rim, a noise-wobbled coastline, wet + dry beach bands, then the
    // themed interior with patch/grain variation. Sampled once per pixel via
    // noise SAMPLERS (no full-res temporaries).
    TexGen.TERRAIN_PALETTES = {
        summer: {
            waterDeep: [16, 47, 62], water: [44, 111, 112], wetSand: [166, 148, 108],
            sand: [214, 196, 148], soil: [151, 133, 99],
            grass: [130, 145, 91], grassDark: [79, 109, 66]
        },
        winter: {
            waterDeep: [26, 52, 74], water: [44, 84, 108], wetSand: [148, 158, 166],
            sand: [186, 194, 200], soil: [126, 134, 136],
            grass: [225, 232, 230], grassDark: [178, 199, 208]
        },
        desert: {
            waterDeep: [30, 76, 92], water: [50, 108, 120], wetSand: [178, 148, 102],
            sand: [224, 194, 138], soil: [188, 148, 94],
            grass: [223, 195, 143], grassDark: [196, 161, 112]
        }
    };

    // The coastline is a wobbled square: chebyshev distance from the centre plus a
    // noise offset. The mega-texture PAINTS that line and the shoreline foam has to
    // FOLLOW it, so both read the wobble from here. They used to disagree — the surf
    // sat on a fixed radius while the painted coast wandered +/-13 units around it,
    // which is why the waves ran up the beach in places and out to sea in others.
    TexGen.COAST_CELLS = 24;
    TexGen.COAST_WOBBLE = 26;
    // The island's dimensions live with the thing that DRAWS the coast, because
    // everything that needs to agree about where land ends reads them from here:
    // the renderer's ground plane and surf ribbon, and the terrain's walkability.
    TexGen.TERRAIN_SEED = 12345;
    TexGen.TERRAIN_WORLD = 1000;
    // 400 put the waterline THROUGH the play square: with COAST_WOBBLE the shore ran
    // between 387 and 413, so parts of an 800x800 map were sea. 33 of the 1764
    // exploration cells sat in water across 14 of the 49 tiles, none of which could
    // ever read 100% -- and one match spent 91 scouts on a tile it could not finish.
    // 417 puts the whole square ashore with the wobble's 13 to spare.
    TexGen.TERRAIN_LAND = 417;
    TexGen.coastNoise = (rand) => TexGen.noiseSampler(TexGen.COAST_CELLS, rand);
    // Standalone version for callers outside the texture bake. Inside TexGen.terrain
    // the coast sampler is the FIRST one drawn from the seeded stream, so drawing it
    // first from the same seed here reproduces that lattice exactly.
    TexGen.coastSampler = (seed) => {
        const n = TexGen.coastNoise(TexGen.rng(seed || 7));
        return (u, v) => (n(u, v) - 0.5) * TexGen.COAST_WOBBLE;
    };

    // Open water beyond the map. The mega-texture ends at the ground plane's rim, and
    // past it the frame was a single flat colour — the sea's DETAIL stopped even once
    // its mean matched. This tiles out to the horizon underneath everything. The mean
    // is exactly waterDeep, so it lands on the same lit value as the rim band and the
    // clear colour behind it: only the grain carries across, never a step.
    // Cell counts are chosen against OPEN_WATER_TILE so the grain lands at roughly
    // the same world scale as the mega-texture's own (~18 units), which is what makes
    // it read as water rather than as a repeat. Tiled too tightly it reads as a
    // checkerboard — at 40 units a tile the same patch showed a dozen times across
    // one view, which was more distracting than the flat colour it replaced.
    TexGen.OPEN_WATER_TILE = 400;
    TexGen.OPEN_WATER_SEED = 5;
    // ONE grain field for all open water, queried in TILE space (period 1). The sea
    // plane bakes it into a tiling sheet and the mega-texture samples it at the SAME
    // world phase for its own deep water. That shared phase is the whole point: two
    // independent noise fields have matching means but uncorrelated grain, so where
    // they met at the ground plane's rim the pattern jumped and drew a visible
    // square. One field cannot disagree with itself.
    TexGen.openWaterGrain = (seed = TexGen.OPEN_WATER_SEED) => {
        const rand = TexGen.rng(seed);
        const broad = TexGen.noiseSampler(6, rand);    // ~67-unit swell
        const fine = TexGen.noiseSampler(22, rand);    // ~18-unit grain
        return (u, v) => (broad(u, v) - 0.5) * 3 + (fine(u, v) - 0.5) * 2;
    };
    TexGen.openWater = (theme, seed = TexGen.OPEN_WATER_SEED, size = 512) => {
        const P = (TexGen.TERRAIN_PALETTES[theme] || TexGen.TERRAIN_PALETTES.summer).waterDeep;
        const grain = TexGen.openWaterGrain(seed);
        const c = canvas(size), ctx = c.getContext('2d');
        const img = ctx.createImageData(size, size), d = img.data;
        for (let py = 0; py < size; py++) {
            for (let px = 0; px < size; px++) {
                const g = grain(px / size, py / size);
                const i = (py * size + px) * 4;
                d[i] = clamp255(P[0] + g);
                d[i + 1] = clamp255(P[1] + g);
                d[i + 2] = clamp255(P[2] + g * 0.9);
                d[i + 3] = 255;
            }
        }
        ctx.putImageData(img, 0, 0);
        return c;
    };

    // A separate mask preserves full colour precision in the terrain canvas.
    TexGen.coastMask = (size = 512) => {
        const c=canvas(size), ctx=c.getContext('2d'), img=ctx.createImageData(size,size);
        const coast=TexGen.coastSampler(TexGen.TERRAIN_SEED);
        for (let y=0;y<size;y++) for (let x=0;x<size;x++) {
            const u=x/size,v=y/size;
            const dist=Math.max(Math.abs((u-.5)*TexGen.TERRAIN_WORLD),Math.abs((v-.5)*TexGen.TERRAIN_WORLD))+coast(u,v);
            const value=Math.round(255*Math.max(0,Math.min(1,(dist-TexGen.TERRAIN_LAND-3)/10)));
            const i=(y*size+x)*4;
            img.data[i]=img.data[i+1]=img.data[i+2]=value; img.data[i+3]=255;
        }
        ctx.putImageData(img,0,0); return c;
    };

    const smooth = (a,b,x) => {
        const t=Math.max(0,Math.min(1,(x-a)/(b-a)));
        return t*t*(3-2*t);
    };

    // Two surface families in R/G: organic cover and exposed earth. This small,
    // seamless sheet is sampled in world space, independently of map resolution.
    // Seeded wrapped strokes produce grass fibre, wind-packed snow and sand grain
    // without painting fake objects or highlights into the map.
    TexGen.groundDetail = (theme, size=256) => {
        const rand=TexGen.rng(936), broad=TexGen.noiseSampler(12,rand);
        const fine=TexGen.noiseSampler(88,rand), c=canvas(size), ctx=c.getContext('2d');
        const img=ctx.createImageData(size,size), d=img.data;
        for(let y=0;y<size;y++) for(let x=0;x<size;x++) {
            const u=x/size,v=y/size, grain=(fine(u,v)-.5)*32;
            const drift=Math.sin((u*12+v*4+(broad(u,v)-.5)*.5)*Math.PI*2);
            const i=(y*size+x)*4;
            d[i]=clamp255(128+(broad(u,v)-.5)*26+grain*.6
                +(theme==='summer'?0:drift*(theme==='winter'?5:9)));
            d[i+1]=clamp255(128+grain+(broad(u,v)-.5)*14);
            d[i+2]=128;d[i+3]=255;
        }
        ctx.putImageData(img,0,0);
        if(theme==='summer') {
            ctx.lineWidth=.65;
            for(let i=0;i<4600;i++) {
                const x=rand()*size,y=rand()*size,dx=(rand()-.5)*3,dy=1+rand()*3;
                const g=108+Math.floor(rand()*42);
                ctx.strokeStyle=`rgb(${g},128,128)`;
                // Wrap every stroke, including the diagonal corners of the tile.
                for(const ox of [-size,0,size]) for(const oy of [-size,0,size]) {
                    if(x+ox < -4 || x+ox > size+4 || y+oy < -4 || y+oy > size+4) continue;
                    ctx.beginPath();ctx.moveTo(x+ox,y+oy);ctx.lineTo(x+ox+dx,y+oy+dy);ctx.stroke();
                }
            }
        }
        return c;
    };

    // World-only materials. The existing bark/rock/foliage painters are also used
    // by costumes and architecture, so those shared materials stay independent.
    TexGen.worldSurface = (kind, theme, seed=77, size=128) => {
        const rand=TexGen.rng(seed), broad=TexGen.noiseSampler(5,rand);
        const medium=TexGen.noiseSampler(13,rand), fine=TexGen.noiseSampler(42,rand);
        const c=canvas(size),ctx=c.getContext('2d'),img=ctx.createImageData(size,size);
        const base=kind==='bark'?[102,83,59]:(kind==='foliage' || kind==='berries')
            ?(theme==='winter'?[66,91,78]:theme==='desert'?[113,118,72]:[86,111,65])
            :(theme==='winter'?[146,154,161]:theme==='desert'?[166,147,120]:[150,148,130]);
        for(let y=0;y<size;y++) for(let x=0;x<size;x++) {
            const u=x/size,v=y/size;
            const b=broad(u,v),m=medium(u,v),f=fine(u,v);
            let tone=(b-.5)*22+(m-.5)*7+(f-.5)*3;
            if(kind==='bark') {
                const ridge=medium(u,v*.12);
                tone=(ridge-.5)*30+(f-.5)*3;
            } else if(kind==='stone' || kind==='ore') {
                // Broad mineral beds, with muted inclusions instead of random
                // black cracks and white speckles that resemble baked glitter.
                tone=(b-.5)*29+(m-.5)*10+(f-.5)*4;
            }
            const ore=kind==='ore'?smooth(.60,.72,m*.7+b*.3):0;
            const i=(y*size+x)*4;
            for(let ch=0;ch<3;ch++) {
                const rock=base[ch]+tone;
                img.data[i+ch]=clamp255(rock+([198,156,65][ch]-rock)*ore*.9);
            }
            img.data[i+3]=255;
        }
        ctx.putImageData(img,0,0);
        if(kind==='berries') {
            // Matte fruit clusters retain food recognition without white dots.
            for(let i=0;i<24;i++) {
                const x=rand()*size,y=rand()*size,r=size*(.009+rand()*.008);
                ctx.fillStyle=i%3?'#9e5144':'#ba6751';
                for(const ox of [-size,0,size]) for(const oy of [-size,0,size]) {
                    if(x+ox+r<0 || x+ox-r>size || y+oy+r<0 || y+oy-r>size) continue;
                    ctx.beginPath();ctx.arc(x+ox,y+oy,r,0,Math.PI*2);ctx.fill();
                }
            }
        }
        return c;
    };

    TexGen.terrain = (theme, seed, size = 2048, worldSize = 1000, landHalf = 400) => {
        const P=TexGen.TERRAIN_PALETTES[theme] || TexGen.TERRAIN_PALETTES.summer;
        const rand=TexGen.rng(seed || 7);
        const nCoast=TexGen.coastNoise(rand); // MUST remain first: foam/walkability share this stream.
        const broad=TexGen.noiseSampler(7,rand), patch=TexGen.noiseSampler(23,rand);
        const broken=TexGen.noiseSampler(67,rand), grain=TexGen.noiseSampler(191,rand);
        const seaGrain=TexGen.openWaterGrain();
        const c=canvas(size),ctx=c.getContext('2d'),img=ctx.createImageData(size,size),d=img.data;
        for(let y=0;y<size;y++) for(let x=0;x<size;x++) {
            const u=x/size,v=y/size,wx=(u-.5)*worldSize,wz=(v-.5)*worldSize;
            const dist=Math.max(Math.abs(wx),Math.abs(wz))+(nCoast(u,v)-.5)*TexGen.COAST_WOBBLE;
            const h=dist-landHalf;
            let r,g,b,cover=0;
            const sea=seaGrain(wx/TexGen.OPEN_WATER_TILE,wz/TexGen.OPEN_WATER_TILE);
            if(h>=42) {
                r=P.waterDeep[0]+sea;g=P.waterDeep[1]+sea;b=P.waterDeep[2]+sea*.9;
            } else {
                // Domain-warped patches avoid the large square noise grid. Fine
                // breakup follows the same cover field rather than random dots.
                const macro=broad(u,v);
                const p=patch(u+(macro-.5)*.07,v+(macro-.5)*.045);
                const m=broken(u,v),f=grain(u,v);
                const field=macro*.50+p*.36+m*.14;
                cover=smooth(theme==='summer'?.30:.24,theme==='summer'?.58:.66,field);
                const lush=smooth(.28,.74,p*.6+macro*.4);
                let variation=(m-.5)*5+(f-.5)*3;
                if(theme==='desert' || theme==='winter') {
                    const wind=Math.sin((u*27+v*11+(macro-.5)*3+p*.4)*Math.PI*2);
                    variation+=wind*(theme==='desert'?3.5:2);
                }
                const beach=smooth(-34,-13,h+(p-.5)*6);
                const wet=smooth(-9,3,h),shallow=smooth(3,13,h),deep=smooth(13,42,h);
                const kSea=smooth(10,42,h);
                const color=[0,0,0];
                for(let ch=0;ch<3;ch++) {
                    const plant=P.grassDark[ch]+(P.grass[ch]-P.grassDark[ch])*lush;
                    let value=P.soil[ch]+(plant-P.soil[ch])*cover;
                    value+=(P.sand[ch]-value)*beach;
                    value+=(P.wetSand[ch]-value)*wet;
                    value+=(P.water[ch]-value)*shallow;
                    value+=(P.waterDeep[ch]-value)*deep;
                    color[ch]=value+variation*(1-kSea)+sea*kSea*(ch===2?.9:1);
                }
                [r,g,b]=color;
            }
            const i=(y*size+x)*4;
            d[i]=clamp255(r);d[i+1]=clamp255(g);d[i+2]=clamp255(b);
            d[i+3]=255;
        }
        ctx.putImageData(img,0,0);
        return c;
    };

    window.TexGen = TexGen;
})();
