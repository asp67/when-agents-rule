// EngineFx -- the Cinematic lighting style's building effects (review #12).
//
// Presentation only, and all of it optional: Simple and Atmospheric draw none of this.
//   burning   a damaged building smokes (under 70 %), burns (under 45 %) and blazes
//             (under 20 %), with a local light on its walls and, when blazing, embers
//   rubble    soot and stones where a building fell, fading out over three minutes of
//             match time (the environment clock, so it waits while the match is paused)
// Each fire sits at places fixed by the building's id, so it does not jump about from
// frame to frame, and is built from the same soft sprites as the hearths. A viewer who
// asked for reduced motion gets steady flames and no embers.
(function () {
    const frac = v => v - Math.floor(v);
    const rnd = (seed, i) => frac(Math.sin(seed * 0.0007 + i * 12.9898) * 43758.5453);

    const EngineFx = {
        RUBBLE_SECONDS: 180,

        seedOf(id) {
            const s = String(id == null ? '' : id);
            let h = 2166136261;
            for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
            return (h >>> 0) % 100000;
        },

        tier(hpct) { return hpct < 0.2 ? 3 : hpct < 0.45 ? 2 : hpct < 0.7 ? 1 : 0; },

        // Where the fires of this building sit, in world units.
        // `eye` is the camera's position: fires lean to the side of the roof that faces
        // it, since a fire on the far slope would only ever show as a glow behind the ridge.
        spots(b, tier, eye = null) {
            const fb = b._fireBox, seed = EngineFx.seedOf(b.id || (b.x + ',' + b.z));
            const n = tier >= 3 ? 3 : tier === 2 ? 2 : 1;
            let fx = 0, fz = 0;
            if (eye) { const ex = eye[0] - b.x, ez = eye[2] - b.z, l = Math.hypot(ex, ez) || 1; fx = ex / l; fz = ez / l; }
            const out = [];
            for (let i = 0; i < n; i++) {
                // On the roof, not inside it: roofs here are cones and pitches, highest at
                // the centre and lower towards the eaves, and a fire drawn inside one is
                // hidden by it. So the farther out a spot, the lower it sits.
                const dx = (rnd(seed, 2 * i) - 0.5) * 0.7 + fx * 0.3, dz = (rnd(seed, 2 * i + 1) - 0.5) * 0.7 + fz * 0.3;
                const out1 = Math.min(1, Math.max(Math.abs(dx), Math.abs(dz)) * 2);
                out.push({
                    x: b.x + dx * fb.ex,
                    z: b.z + dz * fb.ez,
                    y: Math.max(1, fb.ey * (1 - 0.62 * out1)) + 0.25,
                    phase: rnd(seed, i + 13) * 10,
                });
            }
            return out;
        },

        // Draw one building's smoke and fire into the frame. Returns the local lights
        // (up to three, as the shader takes) for its walls, or null.
        burning(b, hpct, t, still, { m3, bb, quad, ringBuf, tex, dl, eye }) {
            const tier = EngineFx.tier(hpct);
            if (!tier) return null;
            // `side` shifts a sprite sideways as the camera sees it, so tongues stay apart
            // from every angle.
            const sprite = (x, y, z, w, h, tint, alpha, additive, side = 0) => dl.blended.push({ buf: quad, tex: tex.mote, tint, alpha, additive,
                model: m3.multiply(m3.multiply(m3.multiply(m3.translation(x, y, z), bb), m3.translation(side, 0, 0)), m3.scaling(w, h, 1)) });
            const lights = tier >= 2 ? new Float32Array(12) : null;
            let li = 0;
            const spots = EngineFx.spots(b, tier, eye);
            // Flames scale with the building: a Wonder's fire is not a house's.
            const scale = Math.max(0.8, Math.min(1.8, (b._fireBox.ey || 5) / 5));
            spots.forEach((s, k) => {
                // Smoke: darker and taller as it gets worse, drifting downwind.
                const n = 3 + tier, rise = 3 + tier * 2.5, grey = tier >= 3 ? 0.24 : tier === 2 ? 0.34 : 0.46;
                for (let i = 0; i < n; i++) {
                    const age = frac(t * (0.1 + 0.03 * tier) + i / n + s.phase);
                    const size = (0.8 + age * 2.2) * (1 + 0.3 * tier);
                    sprite(s.x + age * rise * 0.35, s.y + 0.4 + age * rise, s.z + age * rise * 0.12, size, size * 1.1,
                        [grey, grey * 0.97, grey * 0.94], Math.sin(age * Math.PI) * (0.22 + 0.07 * tier), false);
                }
                if (tier < 2) return;
                // Flames: three tongues, each an orange body over a yellow core, flickering
                // out of step unless the viewer asked for less motion.
                const f = still ? 1 : 1 + 0.14 * Math.sin((t + s.phase) * 9) + 0.08 * Math.sin((t + s.phase) * 14);
                const big = (tier >= 3 ? 1.7 : 1.1) * scale;
                for (let j = 0; j < 3; j++) {
                    const fj = still ? 1 : 1 + 0.18 * Math.sin((t + s.phase) * (8 + 3 * j) + j * 2.1);
                    const h = (j === 1 ? 1.9 : 1.3) * big * fj, ox = (j - 1) * 0.32 * big;
                    sprite(s.x, s.y + h * 0.42, s.z, 0.62 * big, h, [1, 0.32 + 0.05 * j, 0.05], 0.85, true, ox);
                    sprite(s.x, s.y + h * 0.26, s.z, 0.3 * big, h * 0.5, [1, 0.8, 0.3], 0.95, true, ox);
                }
                if (li < 3) { lights.set([s.x, s.y + 0.4, s.z, (tier >= 3 ? 3.2 : 1.9) * f], 4 * li); li++; }
                // Embers: sparks lifting off a blaze.
                if (tier >= 3 && !still) for (let i = 0; i < 5; i++) {
                    const age = frac(t * 0.6 + i / 5 + s.phase * 0.37);
                    sprite(s.x + Math.sin(i * 2.1 + t) * 0.6 * age, s.y + 0.6 + age * 4.5, s.z + Math.cos(i * 1.7 + t) * 0.6 * age,
                        0.12, 0.12, [1, 0.62, 0.18], (1 - age) * 0.9, true);
                }
                if (k === 0 && tier >= 3) dl.blended.push({ buf: ringBuf, tex: tex.mote, tint: [1, 0.36, 0.07], alpha: 0.35, additive: true,
                    model: m3.multiply(m3.translation(b.x, 0.05, b.z), m3.scaling(b._fireBox.ex * 1.4 + 1.5, 1, b._fireBox.ez * 1.4 + 1.5)) });
            });
            return lights;
        },

        // Two light sets as one, the first set's lights first; the shader takes three.
        mergeLights(a, b) {
            const out = new Float32Array(12);
            let n = 0;
            for (const src of [a, b]) for (let i = 0; i < 3 && n < 3; i++) if (src[4 * i + 3] > 0) { out.set(src.subarray(4 * i, 4 * i + 4), 4 * n); n++; }
            return out;
        },

        // Soot and stones where a building fell; a wisp of smoke at first; gone in three minutes.
        rubble(r, t, { m3, bb, quad, ringBuf, boxBuf, tex, dl }) {
            const age = (t - r.born) / EngineFx.RUBBLE_SECONDS;
            if (age < 0 || age >= 1) return;
            const fade = age < 0.8 ? 1 : (1 - age) / 0.2;
            dl.blended.push({ buf: ringBuf, tex: tex.mote, tint: [0.05, 0.045, 0.04], alpha: 0.85 * fade,
                model: m3.multiply(m3.translation(r.x, 0.04, r.z), m3.scaling(r.r * 1.15, 1, r.r * 1.15)) });
            for (let i = 0; i < 9; i++) {
                const a = rnd(r.seed, i) * Math.PI * 2, d = Math.sqrt(rnd(r.seed, i + 20)) * r.r * 0.85;
                const s = 0.3 + rnd(r.seed, i + 40) * 0.7, h = s * (0.35 + rnd(r.seed, i + 60) * 0.5);
                const model = m3.multiply(m3.multiply(m3.translation(r.x + Math.cos(a) * d, h / 2, r.z + Math.sin(a) * d),
                    m3.rotationY(rnd(r.seed, i + 80) * Math.PI)), m3.scaling(s, h, s * 0.8));
                const shade = 0.36 + rnd(r.seed, i + 100) * 0.2;
                const entry = { buf: boxBuf, tex: tex.rock || tex.masonry, tint: [shade + 0.25, shade + 0.22, shade + 0.18], model };
                if (fade < 1) dl.blended.push({ ...entry, alpha: fade }); else dl.opaque.push(entry);
            }
            // Still smouldering for the first thirty-six seconds.
            if (age < 0.2 && quad && bb) {
                const wisp = (0.2 - age) / 0.2;
                for (let i = 0; i < 3; i++) {
                    const k = frac(t * 0.08 + i / 3), size = 0.9 + k * 1.8;
                    dl.blended.push({ buf: quad, tex: tex.mote, tint: [0.42, 0.41, 0.4], alpha: Math.sin(k * Math.PI) * 0.18 * wisp,
                        model: m3.multiply(m3.multiply(m3.translation(r.x + k * 1.2, 0.5 + k * 3.5, r.z), bb), m3.scaling(size, size, 1)) });
                }
            }
        },
    };
    window.EngineFx = EngineFx;
})();
