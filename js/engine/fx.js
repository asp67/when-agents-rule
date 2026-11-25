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
            // What is laid over takes the hour's light; what glows (sparks, flames) does not.
            const light = r._flatLight || null;
            const instanced = typeof GLCore !== 'undefined' && typeof GLCore.instancingOf === 'function' && GLCore.instancingOf(gl);
            for (let which = 0; which < 2; which++) {
                if (!c[which]) continue;
                const data = this.lists[which].subarray(0, c[which] * 8);
                if (instanced) {
                    if (!this.bufs[which]) { this.bufs[which] = GLCore.createInstances(gl, quad, data, 8); this.ents = this.ents || []; this.ents[which] = { buf: this.bufs[which], tex, additive: which === 1, particles: true }; }
                    else GLCore.setInstances(gl, this.bufs[which], data);
                    const e = this.ents[which];
                    e.tex = tex; e.model = r._identity || (r._identity = window.M3D.identity());
                    e.tint = which === 0 && light ? light : null;
                    out.push(e);
                } else for (let i = 0; i < c[which]; i++) {
                    const o = i * 8, s = data[o + 3], l = which === 0 && light ? light : WHITE;
                    out.push({ buf: quad, tex, tint: [data[o + 4] * l[0], data[o + 5] * l[1], data[o + 6] * l[2]], alpha: data[o + 7], additive: which === 1,
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
    // Dust, chips and the streak behind an arrow are drawn unlit, as their own colour: right
    // at noon, a glow in the dark. This is what flat open ground gets of the light at this
    // hour against noon, as the display shows it (the shader's square root, then the hour's
    // grade), so that what hangs over the ground darkens and warms with the ground.
    // now, noon: EngineAtmosphere.lighting() of the two hours; up: how high the light stands.
    EngineFx.flatLight = (now, nowUp, noon, noonUp, out = [1, 1, 1]) => {
        for (let i = 0; i < 3; i++) {
            const a = now.fillHigh[i] + now.key[i] * Math.max(0, nowUp), b = noon.fillHigh[i] + noon.key[i] * Math.max(0, noonUp);
            out[i] = Math.min(1.1, Math.sqrt(Math.max(0, a) / Math.max(b, 1e-4)) * now.grade[i]);
        }
        return out;
    };
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
    // How large a puff is against what build 1207 raised: seen in a real match, an army's
    // dust stood over it as a pale cloud and hid the men (asp67: half the size, or a quarter).
    EngineFx.MARCH_DUST = 0.4;
    // o: moved (units this frame), tSec, level (1 Balanced, 2 High), theme,
    // world (the unit's matrix), far (drawn as its far model: too small for chips),
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
                    life: rand(1.0, 1.7), size: (kind === 'engine' ? 3.4 : kind === 'cavalry' ? 2.8 : 2.2) * EngineFx.MARCH_DUST, grow: 2.3 * EngineFx.MARCH_DUST, tint, alpha, drag: 1 });
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

    // Biome atmospheric micro-particles (G2): subtle natural weather riding the existing
    // 2-draw instanced Particles pool (0 extra draw calls).
    // - Winter: small crisp drifting snowflakes
    // - Desert: faint low ground-skimming wind dust
    // - Summer: clear by day; sparse tiny low-grass firefly pinpoints at night (non-blooming)
    EngineFx.ambientWeather = (P, target, halfH, dt, o) => {
        if (!P || !target || !(dt > 0) || !(o && o.level >= 1) || halfH > 95) return 0;
        const theme = o.theme || 'summer', night = o.night || 0;
        if (theme === 'summer' && night <= 0.35) return 0;
        const baseRate = theme === 'winter' ? 22 : theme === 'desert' ? 16 : 3.2;
        const rate = baseRate * (o.level > 1 ? 1 : 0.6);
        P._weatherAcc = (P._weatherAcc || 0) + dt * rate;
        const count = Math.min(8, Math.floor(P._weatherAcc));
        if (count < 1) return 0;
        P._weatherAcc -= count;
        const span = Math.max(20, Math.min(75, halfH * 1.45));
        let emitted = 0;
        for (let i = 0; i < count; i++) {
            const x = target.x + rand(-span, span), z = target.z + rand(-span, span);
            if (theme === 'winter') {
                // Fine crisp drifting snowflakes (mote sprite shows ~1/3 of quad width)
                if (P.emit({ x, y: rand(9, 21), z, vx: rand(1.4, 2.8), vy: rand(-2.6, -1.4), vz: rand(0.5, 1.5),
                    life: rand(3.2, 5.2), size: rand(0.24, 0.36), grow: 0.95, tint: [0.95, 0.98, 1.0], alpha: 0.62 })) emitted++;
            } else if (theme === 'desert') {
                // Continuous wind-blown sand wisps skimming low across the dunes (no drag stall)
                if (P.emit({ x: x - 10, y: rand(0.25, 1.9), z: z - 4, vx: rand(6.8, 11.5), vy: rand(0.06, 0.36), vz: rand(1.8, 3.8),
                    life: rand(1.8, 3.0), size: rand(0.60, 1.10), grow: 1.35, tint: [0.98, 0.91, 0.74], alpha: 0.30 })) emitted++;
            } else {
                // Summer night: small warm low-grass fireflies (non-additive so they stay crisp)
                if (P.emit({ x, y: rand(0.35, 1.6), z, vx: rand(-0.4, 0.4), vy: rand(0.08, 0.28), vz: rand(-0.4, 0.4),
                    life: rand(2.2, 3.8), size: rand(0.22, 0.32), grow: 0.75, tint: [0.96, 0.85, 0.36], alpha: 0.68 * Math.min(1, (night - 0.3) * 1.5) })) emitted++;
            }
        }
        return emitted;
    };

    // ---- a building collapses (overhaul step A9; build 1208, done over in build 1210) -----------
    // A building that fell sank into the ground as one flat thing. Build 1208 threw its
    // parts outward whole, which looked like a kicked-over box of wooden blocks: a roof
    // slid off in one piece. Now the building comes down on itself. Its large parts are
    // cut into irregular chunks (a body is one solid block in the model, a roof one prism).
    // The walls give way first, from the top, and their chunks tip and fall inward; the
    // roof holds a moment longer, sags from the middle and drops onto them, breaking up
    // as it goes. What is left lies as a low heap inside the footprint and fades.
    // How it breaks follows from the building's id, so a replay breaks it the same way.
    EngineFx.BREAK_SECONDS = 2.7;
    EngineFx.BREAK_FADE = 0.7;           // the heap fades over this long at the end
    EngineFx.BREAK_MAX_PARTS = 140;      // a Wonder of more parts than this sinks as before
    EngineFx.BREAK_MAX_PIECES = 110;     // chunks a building, all its parts together
    EngineFx.BREAK_AT_ONCE = 4;          // buildings coming down at the same time; one more sinks as before
    EngineFx.CHUNK = { wall: 1.5, roof: 1.25 };   // a part longer than this is cut again

    // A mesh as loose triangles, eight numbers a corner (place, normal, texture place), moved
    // by a part's matrix into the building's own space.
    EngineFx.looseTriangles = (mesh, m) => {
        const P = mesh.positions, N = mesh.normals, U = mesh.uvs, I = mesh.indices, out = new Array(I.length * 8);
        // Normals go by the matrix's cofactors, so a part that was stretched keeps its faces' directions.
        const c0 = m[5] * m[10] - m[6] * m[9], c1 = m[6] * m[8] - m[4] * m[10], c2 = m[4] * m[9] - m[5] * m[8];
        const c3 = m[2] * m[9] - m[1] * m[10], c4 = m[0] * m[10] - m[2] * m[8], c5 = m[1] * m[8] - m[0] * m[9];
        const c6 = m[1] * m[6] - m[2] * m[5], c7 = m[2] * m[4] - m[0] * m[6], c8 = m[0] * m[5] - m[1] * m[4];
        for (let k = 0; k < I.length; k++) {
            const i = I[k] * 3, j = I[k] * 2, o = k * 8, x = P[i], y = P[i + 1], z = P[i + 2], a = N[i], b = N[i + 1], c = N[i + 2];
            out[o] = m[0] * x + m[4] * y + m[8] * z + m[12]; out[o + 1] = m[1] * x + m[5] * y + m[9] * z + m[13]; out[o + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
            const nx = c0 * a + c3 * b + c6 * c, ny = c1 * a + c4 * b + c7 * c, nz = c2 * a + c5 * b + c8 * c, l = Math.hypot(nx, ny, nz) || 1;
            out[o + 3] = nx / l; out[o + 4] = ny / l; out[o + 5] = nz / l; out[o + 6] = U[j]; out[o + 7] = U[j + 1];
        }
        return out;
    };
    // Cut loose triangles in two along the plane n . p = d: [what lies before it, what lies
    // behind]. Each half is closed again where it was cut, so a chunk is a solid thing and
    // not a shell one can look into. (The closing face fans out from the middle of the cut,
    // which is right for the plain shapes buildings are made of.)
    EngineFx.cutTriangles = (tris, nx, ny, nz, d) => {
        const EPS = 1e-5, front = [], back = [], cutEdges = [], side = [0, 0, 0];
        const corner = o => [tris[o], tris[o + 1], tris[o + 2], tris[o + 3], tris[o + 4], tris[o + 5], tris[o + 6], tris[o + 7]];
        const fan = (to, poly) => { for (let k = 1; k + 1 < poly.length; k++) to.push(...poly[0], ...poly[k], ...poly[k + 1]); };
        for (let t = 0; t < tris.length; t += 24) {
            let before = 0, behind = 0;
            for (let k = 0; k < 3; k++) { const o = t + k * 8, s = tris[o] * nx + tris[o + 1] * ny + tris[o + 2] * nz - d; side[k] = s > EPS ? s : s < -EPS ? s : 0; if (side[k] > 0) before++; else if (side[k] < 0) behind++; }
            if (!behind) { for (let k = 0; k < 24; k++) front.push(tris[t + k]); continue; }
            if (!before) { for (let k = 0; k < 24; k++) back.push(tris[t + k]); continue; }
            const f = [], b = [], on = [];
            for (let k = 0; k < 3; k++) {
                const a = corner(t + k * 8), sa = side[k], sc = side[(k + 1) % 3];
                if (sa >= 0) f.push(a);
                if (sa <= 0) b.push(a);
                if (sa === 0) on.push(a);
                if (sa * sc < 0) {
                    const c = corner(t + ((k + 1) % 3) * 8), u = sa / (sa - sc), v = a.map((q, i) => q + (c[i] - q) * u);
                    f.push(v); b.push(v); on.push(v);
                }
            }
            fan(front, f); fan(back, b);
            if (on.length === 2) cutEdges.push(on[0], on[1]);
        }
        if (cutEdges.length >= 6 && front.length && back.length) {
            const mid = [0, 0, 0, 0, 0, 0, 0, 0];
            for (const v of cutEdges) for (let i = 0; i < 8; i++) mid[i] += v[i] / cutEdges.length;
            const length = Math.hypot(nx, ny, nz) || 1;
            const face = (to, sx, sy, sz) => {
                sx /= length; sy /= length; sz /= length;
                for (let k = 0; k < cutEdges.length; k += 2) {
                    let a = cutEdges[k], b = cutEdges[k + 1];
                    const ux = a[0] - mid[0], uy = a[1] - mid[1], uz = a[2] - mid[2], vx = b[0] - mid[0], vy = b[1] - mid[1], vz = b[2] - mid[2];
                    const wx = uy * vz - uz * vy, wy = uz * vx - ux * vz, wz = ux * vy - uy * vx, facing = wx * sx + wy * sy + wz * sz;
                    if (Math.abs(facing) < 1e-9) continue;
                    if (facing < 0) { const s = a; a = b; b = s; }
                    for (const v of [mid, a, b]) to.push(v[0], v[1], v[2], sx, sy, sz, v[6], v[7]);
                }
            };
            face(front, -nx, -ny, -nz); face(back, nx, ny, nz);
        }
        return [front, back];
    };
    const boundsOf = tris => {
        const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
        for (let o = 0; o < tris.length; o += 8) for (let k = 0; k < 3; k++) { const v = tris[o + k]; if (v < b[k]) b[k] = v; if (v > b[k + 3]) b[k + 3] = v; }
        return b;
    };
    // Break loose triangles into chunks no longer than size, at most `most` of them: the
    // longest chunk is cut again across its length, a little off the middle and a little
    // askew, so no two chunks are alike and none is a brick.
    EngineFx.chunks = (tris, size, most, seed) => {
        const list = [{ tris, b: boundsOf(tris), depth: 0 }];
        let turn = 0;
        while (list.length < most) {
            let pick = -1, longest = size;
            for (let i = 0; i < list.length; i++) { const b = list[i].b, e = Math.max(b[3] - b[0], b[4] - b[1], b[5] - b[2]); if (e > longest && list[i].depth < 6) { longest = e; pick = i; } }
            if (pick < 0) break;
            const it = list[pick], b = it.b, ext = [b[3] - b[0], b[4] - b[1], b[5] - b[2]], axis = ext[0] >= ext[1] && ext[0] >= ext[2] ? 0 : ext[1] >= ext[2] ? 1 : 2;
            const n = [0, 0, 0]; turn++;
            for (let k = 0; k < 3; k++) n[k] = k === axis ? 1 : (rnd(seed, turn * 7 + k) - 0.5) * 0.7;
            const l = Math.hypot(n[0], n[1], n[2]); n[0] /= l; n[1] /= l; n[2] /= l;
            const at = [0, 1, 2].map(k => (b[k] + b[k + 3]) / 2 + (k === axis ? (rnd(seed, turn * 7 + 4) - 0.5) * 0.3 * ext[k] : 0));
            const [f, k2] = EngineFx.cutTriangles(it.tris, n[0], n[1], n[2], n[0] * at[0] + n[1] * at[1] + n[2] * at[2]);
            if (!f.length || !k2.length) { it.depth = 99; continue; }      // the plane missed it: leave it whole
            list.splice(pick, 1, { tris: f, b: boundsOf(f), depth: it.depth + 1 }, { tris: k2, b: boundsOf(k2), depth: it.depth + 1 });
        }
        return list.map(it => it.tris);
    };
    // The chunks of a building and how each will fall. parts: EngineBuildings.parts();
    // meshOf(kind, args): the part's mesh. A piece: its mesh in the building's own space,
    // the part it came from, where its middle is (c), and its fall.
    EngineFx.collapse = (parts, seed, meshOf) => {
        const solid = parts.filter(p => !p.blend && p.tex !== 'shadow').map((p, i) => {
            const tris = EngineFx.looseTriangles(meshOf(p.kind, p.args), p.m), b = boundsOf(tris);
            return { p, i, tris, b, volume: Math.max(0.001, (b[3] - b[0]) * (b[4] - b[1]) * (b[5] - b[2])) };
        });
        if (!solid.length) return [];
        // How high the building stands, going by its large parts (a flagpole does not count).
        // What begins in its upper half is roof, or an upper floor, which comes down the same
        // way; what begins below is wall.
        const bySize = solid.slice().sort((a, b) => b.volume - a.volume);
        let height = 0;
        for (const s of bySize) if (s.volume >= bySize[0].volume * 0.08) height = Math.max(height, s.b[4]);
        const top = Math.max(0.5, height * 0.55);
        let reach = 0.5;
        for (const s of solid) reach = Math.max(reach, Math.abs(s.b[0]), Math.abs(s.b[3]), Math.abs(s.b[2]), Math.abs(s.b[5]));
        let spare = Math.max(0, EngineFx.BREAK_MAX_PIECES - solid.length);
        const pieces = [];
        for (const s of bySize) {
            const high = s.b[1] >= height * 0.5;
            const made = EngineFx.chunks(s.tris, high ? EngineFx.CHUNK.roof : EngineFx.CHUNK.wall, 1 + Math.min(spare, high ? 12 : 16), seed + s.i * 31);
            spare -= made.length - 1;
            for (const tris of made) pieces.push({ s, tris, high });
        }
        return pieces.map(({ s, tris, high }, i) => {
            const n = tris.length / 8, positions = new Array(n * 3), normals = new Array(n * 3), uvs = new Array(n * 2), indices = new Array(n);
            let cx = 0, cy = 0, cz = 0;
            for (let k = 0; k < n; k++) {
                const o = k * 8;
                positions[k * 3] = tris[o]; positions[k * 3 + 1] = tris[o + 1]; positions[k * 3 + 2] = tris[o + 2];
                normals[k * 3] = tris[o + 3]; normals[k * 3 + 1] = tris[o + 4]; normals[k * 3 + 2] = tris[o + 5];
                uvs[k * 2] = tris[o + 6]; uvs[k * 2 + 1] = tris[o + 7]; indices[k] = k;
                cx += tris[o] / n; cy += tris[o + 1] / n; cz += tris[o + 2] / n;
            }
            const r = j => rnd(seed, i * 13 + j + 500), dist = Math.hypot(cx, cz), out = Math.min(1, dist / reach);
            // Which way is inward: toward the building's middle; for what stands in the middle, any way.
            const a = dist > 0.25 ? Math.atan2(-cz, -cx) : r(0) * Math.PI * 2, ix = Math.cos(a), iz = Math.sin(a);
            let delay, rest, go, side, tip, ax, az, yaw;
            if (high) {
                // The roof: held a moment, then down from the middle outward, each chunk turning its own
                // way. (Not held long: over a tall tower a roof that waits hangs in the air above a heap.)
                delay = 0.10 + r(1) * 0.16 + 0.12 * out;
                rest = 0.45 + r(2) * 0.50 + 0.45 * (1 - out);     // on top of the heap, not under it
                go = dist * r(3) * 0.25; side = (r(4) - 0.5) * 0.7;
                const t = r(5) * Math.PI * 2; ax = Math.cos(t); az = Math.sin(t);
                tip = (r(6) - 0.5) * 1.6; yaw = (r(7) - 0.5) * 1.0;
            } else {
                // A wall: its top goes first; every chunk tips inward (its top toward the middle) and falls there.
                delay = 0.04 + r(1) * 0.16 + 0.30 * (1 - Math.min(1, cy / top));
                rest = 0.12 + r(2) * 0.30 + 0.35 * (1 - out);
                go = dist * (0.25 + r(3) * 0.40); side = (r(4) - 0.5) * 0.6;
                ax = iz; az = -ix;
                tip = 1.0 + r(6) * 0.7; yaw = (r(7) - 0.5) * 0.8;
            }
            // A large chunk of wall would stand out of the heap like a tooth. It comes to rest
            // lower, the larger it is, most of it in the ground: what shows of it is rubble of the
            // size of the rest, and the heap stays low enough for the roof to lie on top of it.
            if (!high) {
                let reachOut = 0;
                for (let k = 0; k < n; k++) reachOut = Math.max(reachOut, Math.hypot(positions[k * 3] - cx, positions[k * 3 + 1] - cy, positions[k * 3 + 2] - cz));
                rest = Math.min(rest, 1.25 - reachOut);
            }
            rest = Math.min(cy, rest);
            const dur = Math.max(high ? 0.4 : 0.5, Math.sqrt(2 * (cy - rest) / 9)) * (1 + r(8) * 0.15);
            return { p: s.p, mesh: { positions, normals, uvs, indices }, high, c: [cx, cy, cz], delay, dur, rest,
                mx: ix * go - iz * side, mz: iz * go + ix * side, ax, az, tip, yaw };
        });
    };
    // Where a piece is t seconds after the building fell: a matrix in the building's own
    // space, written into out (sixteen numbers). It falls as things fall, faster and faster,
    // tips as it goes, lands and lies.
    EngineFx.collapseMatrix = (piece, t, out) => {
        const tt = Math.min(1, Math.max(0, (t - piece.delay) / piece.dur)), fall = tt * tt;
        const [cx, cy, cz] = piece.c, x = cx + piece.mx * tt, y = cy - (cy - piece.rest) * fall, z = cz + piece.mz * tt;
        // Turned about a level axis (ax, 0, az) by the tip, then about the upright by the yaw.
        const th = piece.tip * tt * Math.sqrt(tt), c = Math.cos(th), s = Math.sin(th), k = 1 - c, ax = piece.ax, az = piece.az;
        const r00 = c + ax * ax * k, r01 = -az * s, r02 = ax * az * k, r10 = az * s, r11 = c, r12 = -ax * s, r20 = ax * az * k, r21 = ax * s, r22 = c + az * az * k;
        const yw = piece.yaw * tt, yc = Math.cos(yw), ys = Math.sin(yw);
        // R = Ry(yaw) * Raxis(tip); rows of Ry: [yc 0 ys; 0 1 0; -ys 0 yc]
        const m00 = yc * r00 + ys * r20, m01 = yc * r01 + ys * r21, m02 = yc * r02 + ys * r22;
        const m20 = -ys * r00 + yc * r20, m21 = -ys * r01 + yc * r21, m22 = -ys * r02 + yc * r22;
        out[0] = m00; out[1] = r10; out[2] = m20; out[3] = 0;
        out[4] = m01; out[5] = r11; out[6] = m21; out[7] = 0;
        out[8] = m02; out[9] = r12; out[10] = m22; out[11] = 0;
        out[12] = x - (m00 * cx + m01 * cy + m02 * cz); out[13] = y - (r10 * cx + r11 * cy + r12 * cz); out[14] = z - (m20 * cx + m21 * cy + m22 * cz); out[15] = 1;
        return out;
    };
    // How much of the heap shows: all of it, then fading at the end.
    EngineFx.breakFade = t => Math.max(0, Math.min(1, (EngineFx.BREAK_SECONDS - t) / EngineFx.BREAK_FADE));
    // The dust of a collapse: when the walls go, when the roof lands, and as it settles.
    // Slow pale clouds that rise from inside the footprint and hang.
    EngineFx.BREAK_DUST = [0.2, 0.75, 1.2];
    EngineFx.rubbleDust = (P, x, z, ex, ez, n) => {
        for (let i = 0; i < n; i++) P.emit({ x: x + rand(-ex, ex), y: rand(0.3, 1.2), z: z + rand(-ez, ez), vx: rand(-0.7, 0.7), vy: rand(0.5, 1.4), vz: rand(-0.7, 0.7),
            life: rand(1.2, 2.0), size: rand(1.5, 2.3), grow: 1.5, tint: [0.80, 0.76, 0.68], alpha: 0.42, drag: 1 });
    };

    window.EngineFx = EngineFx;
})();
