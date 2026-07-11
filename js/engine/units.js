// EngineUnits — procedural unit compositions + the cosmetic pose system.
// Same part contract as EngineBuildings ({kind, args, tex, m, blend, key}) with
// two extra fields: `team` (multiply the texture by the player color at draw
// time — the team-color mask) and `bone` (named limb). pose() returns per-bone
// matrices that swing limbs around their pivots for walk/harvest/attack cycles;
// parts without a bone stay rigid. Units are small on screen — silhouette,
// palette and team color do the work, so parts stay chunky and few.
(function () {
    const EngineUnits = {};
    const M = () => window.M3D;

    const part = (arr, kind, args, tex, t = {}) => {
        const m3 = M();
        let m = m3.translation(t.x || 0, t.y || 0, t.z || 0);
        if (t.ry) m = m3.multiply(m, m3.rotationY(t.ry));
        if (t.rx) m = m3.multiply(m, m3.rotationX(t.rx));
        if (t.rz) m = m3.multiply(m, m3.rotationZ(t.rz));
        if (t.sx || t.sy || t.sz) m = m3.multiply(m, m3.scaling(t.sx || 1, t.sy || 1, t.sz || 1));
        arr.push({
            kind, args, tex, m, blend: !!t.blend, team: !!t.team,
            bone: t.bone || null, key: kind + ':' + args.join(',')
        });
    };
    const shadow = (arr, r) => part(arr, 'disc', [r, 14], 'shadow', { y: 0.05, blend: true });

    // Civ-identifying HEADGEAR — the most readable identity channel at unit
    // scale. kind: 'civil' (workers/archers), 'military' (infantry + cavalry
    // riders), 'priest'. (x, y, z) is the head centre, s scales for riders.
    // No civ (engine-test) falls back to the original generic looks.
    const headgear = (p, civ, kind, x, y, z, s = 1) => {
        const S = (v) => +(v * s).toFixed(3);
        if (civ === 'greek') {
            if (kind === 'military') {
                // Corinthian-style dome with a team-colored crest
                part(p, 'sphere', [1, 8, 6], 'iron', { x, y: y + S(0.03), z, sx: S(0.19), sy: S(0.15), sz: S(0.19) });
                part(p, 'box', [S(0.05), S(0.13), S(0.36)], 'cloth', { x, y: y + S(0.2), z, team: true });
            } else if (kind === 'priest') {
                part(p, 'cylinder', [S(0.19), S(0.19), S(0.06), 8], 'foliage', { x, y: y + S(0.06), z }); // laurel wreath
            } else {
                part(p, 'cylinder', [S(0.185), S(0.185), S(0.07), 8], 'cloth', { x, y: y + S(0.05), z, team: true }); // headband
            }
        } else if (civ === 'egyptian') {
            // Nemes-style headcloth with a neck flap; gold accents by station
            part(p, 'sphere', [1, 8, 6], 'cloth', { x, y: y + S(0.05), z, sx: S(0.19), sy: S(0.13), sz: S(0.19), team: true });
            part(p, 'box', [S(0.3), S(0.24), S(0.06)], 'cloth', { x, y: y - S(0.06), z: z - S(0.15), team: true });
            if (kind === 'priest') part(p, 'cylinder', [S(0.13), S(0.13), S(0.1), 8], 'gold', { x, y: y + S(0.18), z });
            if (kind === 'military') part(p, 'cylinder', [S(0.24), S(0.26), S(0.06), 8], 'gold', { x, y: y - S(0.2), z }); // collar
        } else if (civ === 'yamato') {
            if (kind === 'military') {
                // kabuto: iron dome, flared brim, small gold maedate crest
                part(p, 'sphere', [1, 8, 6], 'iron', { x, y: y + S(0.03), z, sx: S(0.18), sy: S(0.14), sz: S(0.18) });
                part(p, 'cylinder', [S(0.26), S(0.3), S(0.05), 8], 'iron', { x, y: y - S(0.03), z });
                part(p, 'box', [S(0.16), S(0.1), S(0.03)], 'gold', { x, y: y + S(0.14), z: z + S(0.15) });
            } else if (kind === 'priest') {
                part(p, 'cylinder', [S(0.05), S(0.11), S(0.22), 6], 'bark', { x, y: y + S(0.16), z }); // eboshi cap
            } else {
                part(p, 'cylinder', [S(0.02), S(0.33), S(0.14), 8], 'thatch', { x, y: y + S(0.12), z }); // kasa
            }
        } else if (civ === 'persian') {
            // soft domed cap rising to a point (tiara); soldiers wear iron underneath
            if (kind === 'military') part(p, 'sphere', [1, 8, 6], 'iron', { x, y, z, sx: S(0.185), sy: S(0.12), sz: S(0.185) });
            part(p, 'cylinder', [S(0.06), S(0.17), S(0.2), 8], 'cloth', { x, y: y + S(0.13), z, team: true });
        } else {
            // generic fallback (no civ given)
            if (kind === 'military') {
                part(p, 'sphere', [1, 8, 6], 'iron', { x, y: y + S(0.03), z, sx: S(0.19), sy: S(0.15), sz: S(0.19) });
            } else if (kind === 'priest') {
                part(p, 'sphere', [1, 8, 6], 'cloth', { x, y: y + S(0.06), z, sx: S(0.185), sy: S(0.11), sz: S(0.185), team: true });
            } else {
                part(p, 'cylinder', [S(0.02), S(0.3), S(0.16), 8], 'thatch', { x, y: y + S(0.11), z });
            }
        }
    };

    // Shared humanoid trunk: booted legs, team tunic, head, arms (~1.6 tall).
    const humanoid = (p, opts = {}) => {
        shadow(p, 0.72);
        part(p, 'cylinder', [0.075, 0.09, 0.62, 5], 'leather', { x: -0.13, y: 0.37, bone: 'legL' });
        part(p, 'cylinder', [0.075, 0.09, 0.62, 5], 'leather', { x: 0.13, y: 0.37, bone: 'legR' });
        part(p, 'cylinder', [0.23, 0.3, 0.62, 7], 'cloth', { y: 0.99, team: true });
        part(p, 'sphere', [1, 8, 6], 'skin', { y: 1.47, sx: 0.17, sy: 0.17, sz: 0.17 });
        part(p, 'cylinder', [0.06, 0.07, 0.52, 5], opts.sleeves || 'skin', { x: -0.34, y: 0.96, rz: -0.1, bone: 'armL' });
        part(p, 'cylinder', [0.06, 0.07, 0.52, 5], opts.sleeves || 'skin', { x: 0.34, y: 0.96, rz: 0.1, bone: 'armR' });
    };

    const builders = {
        worker: (o = {}) => {
            const p = [];
            humanoid(p);
            headgear(p, o.civ, 'civil', 0, 1.5, 0);
            part(p, 'cylinder', [0.028, 0.028, 0.55, 4], 'bark', { x: 0.37, y: 0.86, z: 0.08, bone: 'armR' });
            part(p, 'box', [0.06, 0.18, 0.26], 'iron', { x: 0.37, y: 1.1, z: 0.18, bone: 'armR' }); // axe head
            return p;
        },
        infantry: (o = {}) => {
            const p = [];
            humanoid(p);
            headgear(p, o.civ, 'military', 0, 1.47, 0);
            part(p, 'box', [0.055, 0.62, 0.1], 'iron', { x: 0.37, y: 0.98, z: 0.26, rx: 0.5, bone: 'armR' }); // sword
            part(p, 'box', [0.16, 0.05, 0.06], 'iron', { x: 0.37, y: 0.74, z: 0.12, bone: 'armR' }); // guard
            if (o.civ === 'persian') {
                // tall rectangular wicker shield — the Persian signature
                part(p, 'box', [0.38, 0.62, 0.06], 'thatch', { x: -0.4, y: 0.92, z: 0.16, bone: 'armL' });
            } else {
                part(p, 'cylinder', [0.27, 0.27, 0.06, 9], 'wood', { x: -0.4, y: 0.95, z: 0.14, rx: Math.PI / 2, bone: 'armL' }); // round shield
            }
            return p;
        },
        ranged: (o = {}) => {
            const p = [];
            humanoid(p);
            if (o.civ) headgear(p, o.civ, 'civil', 0, 1.5, 0);
            else part(p, 'sphere', [1, 8, 6], 'leather', { y: 1.53, sx: 0.18, sy: 0.11, sz: 0.18 }); // generic cap
            part(p, 'cylinder', [0.026, 0.026, 1.15, 4], 'wood', { x: -0.37, y: 0.95, z: 0.14, rz: 0.14, bone: 'armL' }); // bow stave
            part(p, 'cylinder', [0.07, 0.09, 0.5, 5], 'bark', { x: 0.1, y: 1.12, z: -0.28, rz: 0.5 }); // quiver
            return p;
        },
        priest: (o = {}) => {
            const p = [];
            shadow(p, 0.78);
            part(p, 'cylinder', [0.21, 0.37, 1.25, 8], 'cloth', { y: 0.67 }); // cream robe (no legs)
            part(p, 'box', [0.42, 0.5, 0.06], 'cloth', { y: 0.98, z: 0.2, team: true }); // sash
            part(p, 'sphere', [1, 8, 6], 'skin', { y: 1.47, sx: 0.17, sy: 0.17, sz: 0.17 });
            headgear(p, o.civ, 'priest', 0, 1.5, 0);
            part(p, 'cylinder', [0.06, 0.07, 0.52, 5], 'cloth', { x: -0.34, y: 0.96, rz: -0.1, bone: 'armL' });
            part(p, 'cylinder', [0.06, 0.07, 0.52, 5], 'cloth', { x: 0.34, y: 0.96, rz: 0.1, bone: 'armR' });
            part(p, 'cylinder', [0.028, 0.028, 1.35, 5], 'bark', { x: 0.37, y: 0.72, z: 0.08, bone: 'armR' }); // staff
            part(p, 'sphere', [1, 8, 6], 'gold', { x: 0.37, y: 1.42, z: 0.08, sx: 0.08, sy: 0.08, sz: 0.08, bone: 'armR' });
            return p;
        },
        cavalry: (o = {}) => {
            const p = [];
            shadow(p, 1.05);
            // horse
            part(p, 'sphere', [1, 10, 7], 'leather', { y: 0.78, sx: 0.34, sy: 0.42, sz: 0.88 }); // barrel
            part(p, 'cylinder', [0.05, 0.065, 0.7, 5], 'leather', { x: -0.18, y: 0.35, z: 0.55, bone: 'legFL' });
            part(p, 'cylinder', [0.05, 0.065, 0.7, 5], 'leather', { x: 0.18, y: 0.35, z: 0.55, bone: 'legFR' });
            part(p, 'cylinder', [0.05, 0.065, 0.7, 5], 'leather', { x: -0.18, y: 0.35, z: -0.55, bone: 'legBL' });
            part(p, 'cylinder', [0.05, 0.065, 0.7, 5], 'leather', { x: 0.18, y: 0.35, z: -0.55, bone: 'legBR' });
            part(p, 'cylinder', [0.1, 0.14, 0.65, 6], 'leather', { y: 1.18, z: 0.72, rx: -0.6 }); // neck
            part(p, 'box', [0.16, 0.38, 0.2], 'leather', { y: 1.5, z: 0.98, rx: 0.45 }); // head
            part(p, 'cylinder', [0.02, 0.05, 0.5, 4], 'bark', { y: 0.95, z: -0.95, rx: 0.6 }); // tail
            part(p, 'box', [0.42, 0.08, 0.55], 'cloth', { y: 1.21, z: -0.05, team: true }); // saddle blanket
            // rider
            part(p, 'cylinder', [0.17, 0.21, 0.5, 6], 'cloth', { y: 1.52, z: -0.05, team: true });
            part(p, 'cylinder', [0.05, 0.06, 0.42, 4], 'leather', { x: -0.31, y: 1.3, rz: -0.3 });
            part(p, 'cylinder', [0.05, 0.06, 0.42, 4], 'leather', { x: 0.31, y: 1.3, rz: 0.3 });
            part(p, 'sphere', [1, 8, 6], 'skin', { y: 1.9, z: -0.05, sx: 0.14, sy: 0.14, sz: 0.14 });
            headgear(p, o.civ, 'military', 0, 1.93, -0.05, 0.8);
            part(p, 'cylinder', [0.05, 0.06, 0.4, 4], 'skin', { x: 0.26, y: 1.6, z: 0.02, rz: 0.15, bone: 'armR' });
            part(p, 'cylinder', [0.02, 0.02, 1.6, 4], 'wood', { x: 0.32, y: 1.55, z: 0.2, rx: 0.4, bone: 'armR' }); // spear
            return p;
        }
    };

    // Limb pivots per type (unit-local space, before facing/world transforms).
    const HUMAN_PIVOTS = {
        legL: [-0.13, 0.68, 0], legR: [0.13, 0.68, 0],
        armL: [-0.34, 1.22, 0], armR: [0.34, 1.22, 0]
    };
    const PIVOTS = {
        worker: HUMAN_PIVOTS, infantry: HUMAN_PIVOTS, ranged: HUMAN_PIVOTS, priest: HUMAN_PIVOTS,
        cavalry: {
            legFL: [-0.18, 0.7, 0.55], legFR: [0.18, 0.7, 0.55],
            legBL: [-0.18, 0.7, -0.55], legBR: [0.18, 0.7, -0.55],
            armR: [0.26, 1.77, 0.02]
        }
    };

    // opts.civ ('greek' | 'egyptian' | 'yamato' | 'persian') picks the cultural
    // headgear/accents; omit for the generic look (engine-test).
    EngineUnits.parts = (type, opts) => {
        const b = builders[type];
        return b ? b(opts || {}) : [];
    };

    // Per-type render metadata: health-bar height above the ground.
    EngineUnits.META = {
        worker: { barY: 2.0 }, infantry: { barY: 2.0 }, ranged: { barY: 2.0 },
        priest: { barY: 2.0 }, cavalry: { barY: 2.45 }
    };

    // Cosmetic animation: returns { mats, bob } — mats maps bone name → matrix
    // (rotation about that limb's pivot), bob is a world-Y offset for the body.
    // t is seconds; phase de-synchronizes crowds.
    EngineUnits.pose = (type, anim, t, phase = 0) => {
        const m3 = M();
        const P = PIVOTS[type] || {};
        const mats = {};
        let bob = 0;
        const swing = (bone, R) => {
            const pv = P[bone];
            if (pv) mats[bone] = m3.rotateAround(R, pv[0], pv[1], pv[2]);
        };
        if (type === 'cavalry') {
            if (anim === 'walk') {
                const s = Math.sin(t * 7 + phase);
                swing('legFL', m3.rotationX(s * 0.55)); swing('legBR', m3.rotationX(s * 0.55));
                swing('legFR', m3.rotationX(-s * 0.55)); swing('legBL', m3.rotationX(-s * 0.55));
                bob = Math.abs(s) * 0.06;
            } else if (anim === 'attack') {
                // couch the spear forward
                const s = Math.sin(t * 7.5 + phase);
                swing('armR', m3.rotationX(-0.3 - Math.max(0, s) * 0.5));
            }
        } else if (anim === 'walk') {
            const s = Math.sin(t * 6.5 + phase);
            swing('legL', m3.rotationX(s * 0.55)); swing('legR', m3.rotationX(-s * 0.55));
            swing('armL', m3.rotationX(-s * 0.35)); swing('armR', m3.rotationX(s * 0.35));
            bob = Math.abs(Math.cos(t * 6.5 + phase)) * 0.04;
        } else if (anim === 'harvest') {
            // overhead chop, weapon rides the same bone
            const s = Math.sin(t * 5.5 + phase);
            swing('armR', m3.rotationX(-0.55 - s * 0.75));
            swing('armL', m3.rotationX(-0.1 - s * 0.15));
        } else if (anim === 'attack') {
            // snappy slash: fast down-stroke, held wind-up
            const s = Math.sin(t * 7.5 + phase);
            swing('armR', m3.rotationX(-0.35 - Math.max(0, s) * 1.05));
            swing('armL', m3.rotationX(Math.min(0, s) * 0.2));
        } else { // idle: barely-there arm sway
            const s = Math.sin(t * 1.6 + phase);
            swing('armL', m3.rotationX(s * 0.06));
            swing('armR', m3.rotationX(-s * 0.06));
        }
        return { mats, bob };
    };

    EngineUnits.TYPES = Object.keys(builders);

    window.EngineUnits = EngineUnits;
})();
