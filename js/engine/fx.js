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
    // ---- particles (overhaul step A9, build 1206) -------------------------------------------
    // Dust, sparks, chips and trails. Until now every mote of dust was a draw of its own (a
    // burst was twenty-four) and there was nothing else. Now all the particles in a picture
    // are two draws: one list for what is laid over the scene (dust, smoke, chips) and one
    // for what is added to it as light (sparks, flame). Each is a square that faces the
    // camera, placed by the card from a list of eight numbers a particle: where it is, how
    // large, its colour and how much of it shows (GLCore.createInstances, stride 8). The
    // sprite is soft: about a third of the square's width shows, so sizes are generous.
    //
    // Presentation only. A particle is born from something the renderer was already told
    // (a hit, a shot, a death) or already draws (a marching unit), never from a new rule,
    // and its chance comes from Math.random, not from the game's random numbers.
    const FIELDS = 16;   // x y z  vx vy vz  age life  size grow  r g b  alpha gravity kind
    class Particles {
        constructor(max = 1400) {
            this.max = max; this.n = 0;
            this.p = new Float32Array(max * FIELDS);
            this.lists = [new Float32Array(max * 8), new Float32Array(max * 8)];   // laid over, added
            this.counts = [0, 0];
            this.bufs = [null, null];
            // What is drawn this frame and not kept: the streak behind a shot (streak, below).
            this.passing = [];
        }
        // A streak for this frame: n squares along a line from (x, y, z) back by len, each
        // smaller and fainter than the one before. Not kept: whoever wants it next frame
        // asks again, so it follows a shot exactly and ends when the shot does.
        streak(x, y, z, dx, dy, dz, len, n, size, tint, alpha, additive) {
            for (let i = 0; i < n; i++) {
                const k = i / n, s = k * len;
                this.passing.push(x - dx * s, y - dy * s, z - dz * s, size * (1 - 0.6 * k), tint[0], tint[1], tint[2], alpha * (1 - k) * (1 - k), additive ? 1 : 0);
            }
        }
        // o: x y z, vx vy vz (units a second), life (seconds), size and grow (its size at the
        // end, as a factor), tint, alpha, gravity, additive, drag (how fast it slows: 0 none).
        emit(o) {
            if (this.n >= this.max) return false;
            const j = this.n++ * FIELDS, p = this.p, t = o.tint || WHITE;
            p[j] = o.x; p[j + 1] = o.y; p[j + 2] = o.z;
            p[j + 3] = o.vx || 0; p[j + 4] = o.vy || 0; p[j + 5] = o.vz || 0;
            p[j + 6] = 0; p[j + 7] = o.life || 0.5;
            p[j + 8] = o.size || 0.3; p[j + 9] = o.grow == null ? 1 : o.grow;
            p[j + 10] = t[0]; p[j + 11] = t[1]; p[j + 12] = t[2];
            p[j + 13] = o.alpha == null ? 1 : o.alpha;
            p[j + 14] = o.gravity || 0;
            // kind: 0 laid over, 1 added as light; +2 when it slows in the air (smoke, dust that hangs).
            p[j + 15] = (o.additive ? 1 : 0) + (o.drag ? 2 : 0);
            return true;
        }
        // A light for this frame: one square added to the scene (a torch's flame, its glow).
        flare(x, y, z, size, tint, alpha) { this.passing.push(x, y, z, size, tint[0], tint[1], tint[2], alpha, 1); }
        clear() { this.n = 0; this.counts[0] = this.counts[1] = 0; this.passing.length = 0; }
        update(dt) {
            if (!(dt > 0)) return;
            const p = this.p;
            for (let i = this.n - 1; i >= 0; i--) {
                const j = i * FIELDS;
                p[j + 6] += dt;
                if (p[j + 6] >= p[j + 7]) {            // gone: the last one takes its place
                    const last = --this.n * FIELDS;
                    if (last !== j) p.copyWithin(j, last, last + FIELDS);
                    continue;
                }
                p[j + 4] -= p[j + 14] * dt;
                if (p[j + 15] >= 2) { const slow = Math.max(0, 1 - 2.4 * dt); p[j + 3] *= slow; p[j + 4] *= slow; p[j + 5] *= slow; }
                p[j] += p[j + 3] * dt; p[j + 1] += p[j + 4] * dt; p[j + 2] += p[j + 5] * dt;
                // What falls lands and lies: it does not sink through the ground.
                if (p[j + 1] < 0.08 && p[j + 14] > 0) { p[j + 1] = 0.08; p[j + 3] *= 0.4; p[j + 5] *= 0.4; p[j + 4] = 0; }
            }
        }
        // Writes the two lists: x y z size, r g b and what shows of it. A particle comes in
        // over the first tenth of its life and goes over the rest.
        fill() {
            const p = this.p, c = this.counts;
            c[0] = c[1] = 0;
            for (let i = 0; i < this.n; i++) {
                const j = i * FIELDS, k = p[j + 6] / p[j + 7], which = p[j + 15] % 2, out = this.lists[which], o = c[which]++ * 8;
                out[o] = p[j]; out[o + 1] = p[j + 1]; out[o + 2] = p[j + 2];
                out[o + 3] = p[j + 8] * (1 + (p[j + 9] - 1) * k);
                out[o + 4] = p[j + 10]; out[o + 5] = p[j + 11]; out[o + 6] = p[j + 12];
                out[o + 7] = p[j + 13] * (k < 0.1 ? k / 0.1 : (1 - k) / 0.9);
            }
            // ...and this frame's streaks, as far as the lists have room.
            const q = this.passing;
            for (let i = 0; i + 8 < q.length; i += 9) {
                const which = q[i + 8];
                if (c[which] >= this.max) continue;
                const out = this.lists[which], o = c[which]++ * 8;
                for (let f = 0; f < 8; f++) out[o + f] = q[i + f];
            }
            q.length = 0;
            return c;
        }
        // The draws for this frame. With instancing: at most two. Without it (an old WebGL 1
        // driver): one a particle, as dust always was.
        entries(r, quad, fm, bb) {
            if (!this.n && !this.passing.length) return NONE;
            const c = this.fill(), out = [], gl = r.gl, tex = r.tex.mote || r.tex.white;
            const instanced = typeof GLCore !== 'undefined' && typeof GLCore.instancingOf === 'function' && GLCore.instancingOf(gl);
            for (let which = 0; which < 2; which++) {
                if (!c[which]) continue;
                const data = this.lists[which].subarray(0, c[which] * 8);
                if (instanced) {
                    if (!this.bufs[which]) { this.bufs[which] = GLCore.createInstances(gl, quad, data, 8); this.ents = this.ents || []; this.ents[which] = { buf: this.bufs[which], tex, additive: which === 1, particles: true }; }
                    else GLCore.setInstances(gl, this.bufs[which], data);
                    const e = this.ents[which];
                    e.tex = tex; e.model = r._identity || (r._identity = window.M3D.identity());
                    out.push(e);
                } else for (let i = 0; i < c[which]; i++) {
                    const o = i * 8, s = data[o + 3];
                    out.push({ buf: quad, tex, tint: [data[o + 4], data[o + 5], data[o + 6]], alpha: data[o + 7], additive: which === 1,
                        model: fm.multiply(fm.multiply(fm.translation(data[o], data[o + 1], data[o + 2]), bb), fm.scaling(s, s, 1)) });
                }
            }
            return out;
        }
        dispose(gl) { for (let i = 0; i < 2; i++) if (this.bufs[i]) { GLCore.deleteMeshBuffers(gl, this.bufs[i]); this.bufs[i] = null; } }
    }
    const WHITE = [1, 1, 1], NONE = [];
    const rand = (a, b) => a + Math.random() * (b - a);
    EngineFx.Particles = Particles;

    // What a tier draws of the new effects: Low the dust bursts it always had, Balanced and
    // High the rest. A viewer who asked for less motion gets the bursts only.
    EngineFx.level = (quality, still) => still ? 0 : quality === 'cinematic' ? 2 : quality === 'balanced' ? 1 : 0;

    // A burst of dust: what a death or a fallen building always raised, as soft motes now.
    EngineFx.burst = (P, x, y, z, count, tint) => {
        for (let i = 0; i < count; i++) {
            const a = Math.random() * Math.PI * 2, s = rand(1.5, 4.5);
            P.emit({ x, y, z, vx: Math.cos(a) * s, vy: rand(2.2, 4.8), vz: Math.sin(a) * s, life: rand(0.6, 0.95), size: rand(1.0, 1.6), grow: 1.6, tint, alpha: 0.9, gravity: 7 });
        }
    };

    // A hit: sparks off a unit; chips of stone and a spark or two off a wall.
    EngineFx.sparks = (P, x, y, z, wall) => {
        const n = wall ? 3 : 6;
        for (let i = 0; i < n; i++) {
            const a = Math.random() * Math.PI * 2, s = rand(1.6, 4.2);
            P.emit({ x: x + Math.cos(a) * 0.3, y, z: z + Math.sin(a) * 0.3, vx: Math.cos(a) * s, vy: rand(1.5, 4.5), vz: Math.sin(a) * s, life: rand(0.3, 0.55), size: rand(0.42, 0.7), grow: 0.35,
                tint: [1, rand(0.5, 0.78), rand(0.12, 0.3)], alpha: 1, gravity: 9, additive: true });
        }
        if (wall) for (let i = 0; i < 5; i++) {
            const a = Math.random() * Math.PI * 2, s = rand(1.2, 3.2), g = rand(0.5, 0.72);
            P.emit({ x, y, z, vx: Math.cos(a) * s, vy: rand(1.2, 3.6), vz: Math.sin(a) * s, life: rand(0.45, 0.8), size: rand(0.4, 0.7), tint: [g, g * 0.97, g * 0.92], alpha: 1, gravity: 9 });
        }
    };

    // What a shot draws behind it in the air: a streak along the way it came (dx, dy, dz:
    // the way it flies), every frame of its flight. An arrow's is pale and three units
    // long; a fire arrow's glows; a sling stone's is short; a boulder's is dust. A fire
    // arrow and a boulder leave smoke and dust hanging as well, a puff every SMOKE_STEP
    // seconds (puff: whether one is due).
    EngineFx.SMOKE_STEP = 0.05;
    EngineFx.trail = (P, kind, x, y, z, dx, dy, dz, puff) => {
        if (kind === 'fire') {
            P.streak(x, y, z, dx, dy, dz, 2.6, 9, 0.75, [1, 0.5, 0.12], 0.9, true);
            if (puff) P.emit({ x, y: y + 0.05, z, vy: 0.5, life: 0.7, size: 0.26, grow: 2.2, tint: [0.4, 0.39, 0.38], alpha: 0.25, drag: 1 });
        } else if (kind === 'boulder') {
            P.streak(x, y, z, dx, dy, dz, 2.2, 6, 1.3, [0.62, 0.6, 0.56], 0.4, false);
            if (puff) P.emit({ x, y, z, life: 0.6, size: 0.5, grow: 1.7, tint: [0.62, 0.6, 0.56], alpha: 0.2, drag: 1 });
        } else if (kind === 'stone') {
            P.streak(x, y, z, dx, dy, dz, 1.2, 5, 0.45, [0.9, 0.9, 0.88], 0.5, false);
        } else {
            P.streak(x, y, z, dx, dy, dz, 3.0, 12, 0.5, [0.98, 0.96, 0.9], 0.8, false);
        }
    };

    // ---- what a unit raises and carries (overhaul step A9, build 1207) ------------------------
    // Read from what the unit is doing as it is drawn: walking, working, the hour. Nothing
    // is asked of the rules.
    //
    // Dust: a walker leaves a puff for every stretch of ground it covers, a rider for half
    // that stretch and a larger one, an engine larger still. So an army's dust is as large
    // as the army: a scout raises a wisp, sixty men a cloud. In the land's own colour:
    // earth, sand, powder snow.
    // (Paler than the ground it rises from, or it would not show against it.)
    EngineFx.GROUND_DUST = { summer: [[0.84, 0.77, 0.62], 0.62], desert: [[0.98, 0.92, 0.76], 0.70], winter: [[1, 1, 1], 0.65] };
    EngineFx.DUST_EVERY = { infantry: 1.6, ranged: 1.6, priest: 1.6, cavalry: 0.8, worker: 3.2, engine: 0.8 };
    EngineFx.TORCH_NIGHT = 0.35;      // how much of the night there must be before torches are lit
    EngineFx.TORCH_HAND = [0.36, 2.0, 0.14];
    // o: moved (units this frame), tSec, level (1 Balanced, 2 High), theme, night (0 to 1),
    // world (the unit's matrix), far (drawn as its far model: too small for a torch or chips),
    // marching (how many units were on the move last frame).
    //
    // The more that march together, the fewer puffs each one leaves (one in 1 + marching / 12):
    // sixty men still raise far more than six, but not ten times the dust, which would hide them.
    EngineFx.unitMotion = (P, u, ue, o) => {
        const kind = ue.static ? 'engine' : ue.type;
        if (u.isMoving && o.moved > 0.001 && o.moved < 3) {
            // Balanced: half the puffs.
            const every = (EngineFx.DUST_EVERY[kind] || 1.6) * (o.level > 1 ? 1 : 2) * (1 + (o.marching || 0) / 12);
            ue.dustWalk = (ue.dustWalk || 0) + o.moved;
            if (ue.dustWalk >= every) {
                ue.dustWalk = 0;
                const [tint, alpha] = EngineFx.GROUND_DUST[o.theme] || EngineFx.GROUND_DUST.summer;
                P.emit({ x: u.x + rand(-0.3, 0.3), y: 0.15, z: u.z + rand(-0.3, 0.3), vx: rand(-0.3, 0.3), vy: rand(0.35, 0.8), vz: rand(-0.3, 0.3),
                    life: rand(1.0, 1.7), size: kind === 'engine' ? 3.4 : kind === 'cavalry' ? 2.8 : 2.2, grow: 2.3, tint, alpha, drag: 1 });
            }
        }
        // Torches: at night one soldier in three carries one (which, by the unit: the same
        // man every night). A flame over the hand, a glow about the bearer, now and then an
        // ember. The flame is drawn, not lit: it throws no light on the ground or the men.
        ue.torchLit = 0;
        if (o.night > EngineFx.TORCH_NIGHT && !o.far && !ue.static && ue.type !== 'worker' && ue.type !== 'priest') {
            if (ue.torch === undefined) ue.torch = Math.floor((ue.phase || 0) * 1000) % 3 === 0;
            if (ue.torch) {
                const w = o.world, [lx, ly, lz] = EngineFx.TORCH_HAND;
                const x = w[0] * lx + w[8] * lz + w[12], y = ly + w[13], z = w[2] * lx + w[10] * lz + w[14];
                const k = Math.min(1, (o.night - EngineFx.TORCH_NIGHT) / 0.25), ph = (ue.phase || 0);
                const f = 1 + 0.16 * Math.sin(o.tSec * 11 + ph * 7) + 0.08 * Math.sin(o.tSec * 17 + ph * 3);
                P.flare(x, y + 0.22, z, 1.15 * f, [1, 0.42, 0.08], 0.9 * k);
                P.flare(x, y + 0.14, z, 0.55 * f, [1, 0.85, 0.40], 0.95 * k);
                P.flare(x, y - 0.5, z, 5.5, [1, 0.45, 0.12], 0.09 * k);
                if (Math.random() < 0.04) P.emit({ x, y: y + 0.3, z, vx: rand(-0.4, 0.4), vy: rand(0.8, 1.6), vz: rand(-0.4, 0.4), life: rand(0.5, 0.9), size: 0.3, grow: 0.3, tint: [1, 0.6, 0.2], alpha: 0.9, additive: true });
                ue.torchLit = k;
            }
        }
        // Chips: a worker's tool comes down once in a swing (EngineUnits.pose, 'harvest': the
        // arm is lowest when sin(5.5 t + phase) is -1), and what it strikes gives something up.
        if ((u.isHarvesting || u.isBuilding) && !o.far) {
            const swing = Math.floor((o.tSec * 5.5 + (ue.phase || 0) + Math.PI / 2) / (2 * Math.PI));
            if (ue.swing !== undefined && swing !== ue.swing) {
                const w = o.world, reach = 0.75;
                EngineFx.chips(P, u.isBuilding ? 'saw' : (u.harvestTarget && u.harvestTarget.type) || 'food', w[8] * reach + w[12], 0.75, w[10] * reach + w[14]);
            }
            ue.swing = swing;
        } else ue.swing = undefined;
    };

    // What a blow of a tool throws up: wood chips at a tree, stone chips and a spark at a
    // quarry, a glint at a gold seam, a leaf or two at a bush or a field, sawdust where a
    // building goes up.
    EngineFx.chips = (P, kind, x, y, z) => {
        const fly = (n, tint, size, extra) => { for (let i = 0; i < n; i++) { const a = Math.random() * Math.PI * 2, s = rand(0.8, 2.4);
            P.emit(Object.assign({ x, y, z, vx: Math.cos(a) * s, vy: rand(1.4, 3.2), vz: Math.sin(a) * s, life: rand(0.4, 0.7), size, tint, alpha: 1, gravity: 9 }, extra)); } };
        if (kind === 'wood') fly(4, [0.80, 0.63, 0.40], 0.42);
        else if (kind === 'stone') { fly(4, [0.62, 0.62, 0.64], 0.42); fly(1, [1, 0.8, 0.4], 0.4, { additive: true, life: 0.25 }); }
        else if (kind === 'gold') { fly(3, [0.58, 0.55, 0.50], 0.4); fly(2, [1, 0.86, 0.32], 0.5, { additive: true, life: 0.35 }); }
        else if (kind === 'saw') { for (let i = 0; i < 3; i++) P.emit({ x: x + rand(-0.3, 0.3), y: y - 0.2, z: z + rand(-0.3, 0.3), vy: rand(0.2, 0.6), life: rand(0.6, 0.9), size: 0.9, grow: 1.9, tint: [0.82, 0.70, 0.50], alpha: 0.4, drag: 1 }); }
        else fly(2, [0.42, 0.56, 0.26], 0.36);
    };

    window.EngineFx = EngineFx;
})();
