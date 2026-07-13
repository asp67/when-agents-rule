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

    // The HORSE, rebuilt joint by joint (shared by every cavalry tier). All
    // numbers are solved so parts EMBED in their parent instead of floating:
    // leg tops sink into the body underside, the neck root sits inside the
    // chest sphere, the head overlaps the neck top, the tail roots inside the
    // rump. +Z is forward; positive rx leans a cylinder's +Y axis toward +Z.
    // Neck/head/ears/mane/muzzle share bone 'head' (walk nod); legs carry
    // their hooves on the same bone so they swing as one limb.
    const horse = (p, tier) => {
        shadow(p, 1.05);
        part(p, 'sphere', [1, 10, 7], 'leather', { y: 0.86, sx: 0.30, sy: 0.34, sz: 0.62 });            // barrel
        part(p, 'sphere', [1, 8, 6], 'leather', { y: 0.92, z: 0.48, sx: 0.26, sy: 0.30, sz: 0.30 });    // chest
        part(p, 'sphere', [1, 8, 6], 'leather', { y: 0.90, z: -0.44, sx: 0.27, sy: 0.31, sz: 0.34 });   // rump
        const leg = (x, z, bone) => {
            part(p, 'cylinder', [0.045, 0.06, 0.62, 5], 'leather', { x, y: 0.36, z, bone });            // top embeds at y 0.67
            part(p, 'cylinder', [0.065, 0.07, 0.09, 5], 'bark', { x, y: 0.075, z, bone });              // hoof
        };
        leg(-0.16, 0.46, 'legFL'); leg(0.16, 0.46, 'legFR');
        leg(-0.16, -0.46, 'legBL'); leg(0.16, -0.46, 'legBR');
        part(p, 'cylinder', [0.085, 0.14, 0.5, 6], 'leather', { y: 1.18, z: 0.62, rx: 0.6, bone: 'head' });   // neck: root (0,0.97,0.48) in chest, top (0,1.39,0.76)
        part(p, 'box', [0.15, 0.17, 0.3], 'leather', { y: 1.43, z: 0.86, rx: 0.25, bone: 'head' });           // head, overlaps neck top
        part(p, 'box', [0.10, 0.11, 0.16], 'leather', { y: 1.38, z: 1.02, rx: 0.25, bone: 'head' });          // muzzle
        part(p, 'cylinder', [0, 0.028, 0.09, 4], 'bark', { x: -0.05, y: 1.56, z: 0.80, bone: 'head' });       // ears
        part(p, 'cylinder', [0, 0.028, 0.09, 4], 'bark', { x: 0.05, y: 1.56, z: 0.80, bone: 'head' });
        part(p, 'box', [0.045, 0.44, 0.10], 'bark', { y: 1.25, z: 0.53, rx: 0.6, bone: 'head' });             // mane strip on the neck's back edge
        part(p, 'cylinder', [0.05, 0.02, 0.5, 4], 'bark', { y: 0.79, z: -0.85, rx: -2.6 });                   // tail: roots at (0,1.0,-0.72) inside the rump
        part(p, 'box', [0.4, 0.07, 0.46], 'cloth', { y: 1.16, z: 0.02, team: true });                          // saddle blanket
        if (tier >= 2) part(p, 'box', [0.22, 0.09, 0.28], 'leather', { y: 1.22 });                             // saddle seat
        if (tier >= 3) {
            // barding: chamfron on the face, chest plate, flank plates
            part(p, 'box', [0.13, 0.05, 0.26], 'iron', { y: 1.52, z: 0.88, rx: 0.25, bone: 'head' });
            part(p, 'box', [0.34, 0.3, 0.08], 'iron', { y: 0.98, z: 0.74, rx: 0.25 });
            part(p, 'box', [0.06, 0.26, 0.6], 'iron', { x: -0.29, y: 0.94 });
            part(p, 'box', [0.06, 0.26, 0.6], 'iron', { x: 0.29, y: 0.94 });
        }
    };

    // How much war a unit wears: 1 = levy/light, 2 = the line trooper,
    // 3 = elite. Derived from the specific unit id (see TIER below) so
    // militia / warrior / champion stop sharing one body.
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
            const tier = o.tier || 2;
            const p = [];
            humanoid(p, tier >= 3 ? { sleeves: 'leather' } : {});
            headgear(p, o.civ, 'military', 0, 1.47, 0);
            if (tier === 1) {
                // militia: a knobbed wooden club and no shield — a levy, not a soldier
                part(p, 'cylinder', [0.04, 0.055, 0.5, 5], 'bark', { x: 0.37, y: 0.95, z: 0.22, rx: 0.5, bone: 'armR' });
                part(p, 'sphere', [1, 6, 5], 'bark', { x: 0.37, y: 1.14, z: 0.42, sx: 0.075, sy: 0.075, sz: 0.075, bone: 'armR' });
            } else {
                part(p, 'box', [0.055, 0.62, 0.1], 'iron', { x: 0.37, y: 0.98, z: 0.26, rx: 0.5, bone: 'armR' }); // sword
                part(p, 'box', [0.16, 0.05, 0.06], tier >= 3 ? 'gold' : 'iron', { x: 0.37, y: 0.74, z: 0.12, bone: 'armR' }); // guard
                if (o.civ === 'persian') {
                    // tall rectangular shield — the Persian signature; iron for champions
                    part(p, 'box', [0.38, 0.62, 0.06], tier >= 3 ? 'iron' : 'thatch', { x: -0.4, y: 0.92, z: 0.16, bone: 'armL' });
                } else {
                    part(p, 'cylinder', [0.27, 0.27, 0.06, 9], tier >= 3 ? 'iron' : 'wood', { x: -0.4, y: 0.95, z: 0.14, rx: Math.PI / 2, bone: 'armL' }); // round shield
                }
            }
            if (tier >= 3) {
                // champion: pauldrons + a back banner in team color over the head
                part(p, 'sphere', [1, 6, 5], 'iron', { x: -0.31, y: 1.28, sx: 0.11, sy: 0.08, sz: 0.11 });
                part(p, 'sphere', [1, 6, 5], 'iron', { x: 0.31, y: 1.28, sx: 0.11, sy: 0.08, sz: 0.11 });
                part(p, 'cylinder', [0.018, 0.018, 0.85, 4], 'bark', { y: 1.35, z: -0.24 });
                part(p, 'box', [0.26, 0.34, 0.03], 'cloth', { y: 1.72, z: -0.24, team: true });
            }
            return p;
        },
        ranged: (o = {}) => {
            const tier = o.tier || 1;
            const p = [];
            humanoid(p, tier >= 2 ? { sleeves: 'leather' } : {});
            if (tier >= 2) headgear(p, o.civ, 'military', 0, 1.47, 0);
            else if (o.civ) headgear(p, o.civ, 'civil', 0, 1.5, 0);
            else part(p, 'sphere', [1, 8, 6], 'leather', { y: 1.53, sx: 0.18, sy: 0.11, sz: 0.18 }); // generic cap
            if (tier === 2) {
                // crossbow held level: stock, iron lath across it, stirrup nose —
                // a horizontal weapon reads instantly against the archer's tall stave
                part(p, 'box', [0.05, 0.06, 0.6], 'wood', { x: 0.36, y: 1.05, z: 0.3, bone: 'armR' });
                part(p, 'cylinder', [0.022, 0.022, 0.5, 4], 'iron', { x: 0.36, y: 1.07, z: 0.52, rz: Math.PI / 2, bone: 'armR' });
                part(p, 'box', [0.05, 0.1, 0.05], 'iron', { x: 0.36, y: 1.0, z: 0.56, bone: 'armR' });
            } else {
                part(p, 'cylinder', [0.026, 0.026, tier >= 3 ? 1.3 : 1.15, 4], 'wood', { x: -0.37, y: 0.95, z: 0.14, rz: 0.14, bone: 'armL' }); // bow stave
                if (tier >= 3) part(p, 'cylinder', [0.032, 0.032, 0.36, 4], 'gold', { x: -0.37, y: 0.95, z: 0.14, rz: 0.14, bone: 'armL' }); // gilt grip
            }
            part(p, 'cylinder', [0.07, 0.09, 0.5, 5], 'bark', { x: 0.1, y: 1.12, z: -0.28, rz: 0.5 }); // quiver
            if (tier >= 3) part(p, 'box', [0.34, 0.5, 0.04], 'cloth', { y: 1.05, z: -0.26, team: true }); // elite cape
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
            if (o.unit === 'horse_carriage') {
                // Egypt's chariot: a light horse pulling a two-wheeled cart with
                // a standing, helmeted spearman. Rider and cart are rigid; the
                // horse keeps its leg/head bones so the trot reads normally.
                const p = [];
                horse(p, 1);
                part(p, 'disc', [0.7, 12], 'shadow', { y: 0.05, z: -1.15, blend: true });
                part(p, 'cylinder', [0.035, 0.035, 0.86, 5], 'bark', { y: 0.34, z: -1.15, rz: Math.PI / 2 }); // axle
                part(p, 'cylinder', [0.34, 0.34, 0.08, 10], 'wood', { x: -0.42, y: 0.34, z: -1.15, rz: Math.PI / 2 });
                part(p, 'cylinder', [0.34, 0.34, 0.08, 10], 'wood', { x: 0.42, y: 0.34, z: -1.15, rz: Math.PI / 2 });
                part(p, 'box', [0.55, 0.34, 0.62], 'wood', { y: 0.66, z: -1.18 });          // cart tub
                part(p, 'box', [0.5, 0.14, 0.05], 'wood', { y: 0.87, z: -0.88 });           // front rail
                part(p, 'cylinder', [0.022, 0.022, 0.62, 4], 'bark', { x: -0.2, y: 0.5, z: -0.72, rx: 1.45 }); // hitch shafts
                part(p, 'cylinder', [0.022, 0.022, 0.62, 4], 'bark', { x: 0.2, y: 0.5, z: -0.72, rx: 1.45 });
                part(p, 'cylinder', [0.14, 0.17, 0.44, 6], 'cloth', { y: 1.06, z: -1.18, team: true });        // rider
                part(p, 'sphere', [1, 8, 6], 'skin', { y: 1.41, z: -1.18, sx: 0.13, sy: 0.13, sz: 0.13 });
                headgear(p, o.civ, 'military', 0, 1.44, -1.18, 0.75);                                          // helmet
                part(p, 'cylinder', [0.045, 0.055, 0.36, 4], 'skin', { x: 0.18, y: 1.22, z: -1.02, rz: 0.2, rx: 0.3 });
                part(p, 'cylinder', [0.018, 0.018, 1.5, 4], 'wood', { x: 0.24, y: 1.32, z: -0.8, rx: 0.5 });   // spear
                part(p, 'cylinder', [0, 0.028, 0.12, 4], 'iron', { x: 0.24, y: 1.98, z: -0.44, rx: 0.5 });     // spear tip
                return p;
            }
            const tier = o.tier || 2;
            const p = [];
            horse(p, tier);
            // rider: torso seated over the blanket, legs hugging the barrel
            part(p, 'cylinder', [0.16, 0.2, 0.46, 6], 'cloth', { y: 1.47, team: true });
            part(p, 'cylinder', [0.05, 0.06, 0.4, 4], 'leather', { x: -0.28, y: 1.18, z: 0.05, rz: -0.35 });
            part(p, 'cylinder', [0.05, 0.06, 0.4, 4], 'leather', { x: 0.28, y: 1.18, z: 0.05, rz: 0.35 });
            part(p, 'sphere', [1, 8, 6], 'skin', { y: 1.85, sx: 0.14, sy: 0.14, sz: 0.14 });
            headgear(p, o.civ, tier === 1 ? 'civil' : 'military', 0, 1.88, 0, 0.8);
            part(p, 'cylinder', [0.05, 0.06, 0.4, 4], tier >= 3 ? 'leather' : 'skin', { x: 0.24, y: 1.55, z: 0.04, rz: 0.15, bone: 'armR' });
            if (tier === 1) {
                // scout: a short javelin, bareback but for the blanket
                part(p, 'cylinder', [0.016, 0.016, 1.1, 4], 'wood', { x: 0.3, y: 1.52, z: 0.2, rx: 0.4, bone: 'armR' });
            } else if (tier === 2) {
                part(p, 'cylinder', [0.02, 0.02, 1.6, 4], 'wood', { x: 0.32, y: 1.55, z: 0.2, rx: 0.4, bone: 'armR' }); // spear
            } else {
                // heavy: a true lance with an iron tip and a team pennant
                part(p, 'cylinder', [0.028, 0.028, 1.9, 4], 'wood', { x: 0.32, y: 1.55, z: 0.2, rx: 0.4, bone: 'armR' });
                part(p, 'cylinder', [0, 0.03, 0.14, 4], 'iron', { x: 0.32, y: 2.29, z: 0.61, rx: 0.4, bone: 'armR' });
                part(p, 'box', [0.05, 0.16, 0.22], 'cloth', { x: 0.32, y: 2.2, z: 0.62, team: true, bone: 'armR' });
            }
            return p;
        }
    };

    // Specific unit id → visual tier. Unlisted ids fall back per category
    // (ranged reads as the plain archer, everything else as the line trooper).
    // Uniques dress by their station: hoplite a trooper, phalanx/samurai elite.
    const TIER = {
        militia: 1, warrior: 2, champion: 3,
        archer: 1, crossbowman: 2, elite_archer: 3,
        scout_cavalry: 1, cavalry: 2, heavy_cavalry: 3,
        slinger: 1, hoplite: 2, phalanx: 3, samurai: 3, archer_ship: 1
    };

    // Limb pivots per type (unit-local space, before facing/world transforms).
    const HUMAN_PIVOTS = {
        legL: [-0.13, 0.68, 0], legR: [0.13, 0.68, 0],
        armL: [-0.34, 1.22, 0], armR: [0.34, 1.22, 0]
    };
    const PIVOTS = {
        worker: HUMAN_PIVOTS, infantry: HUMAN_PIVOTS, ranged: HUMAN_PIVOTS, priest: HUMAN_PIVOTS,
        cavalry: {
            legFL: [-0.16, 0.67, 0.46], legFR: [0.16, 0.67, 0.46],
            legBL: [-0.16, 0.67, -0.46], legBR: [0.16, 0.67, -0.46],
            armR: [0.24, 1.72, 0.04],
            head: [0, 0.98, 0.5] // neck root — the walk nod swings the whole neck
        }
    };

    // opts.civ ('greek' | 'egyptian' | 'yamato' | 'persian') picks the cultural
    // headgear/accents; opts.unit (specific id like 'champion') picks the tier
    // dressing. Omit both for the generic look (engine-test).
    EngineUnits.parts = (type, opts) => {
        const o = opts || {};
        if (o.tier == null) o.tier = TIER[o.unit] || (type === 'ranged' ? 1 : 2);
        const b = builders[type];
        return b ? b(o) : [];
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
                swing('head', m3.rotationX(Math.sin(t * 7 + phase + 1) * 0.07)); // the trot nod
                bob = Math.abs(s) * 0.06;
            } else if (anim === 'attack') {
                // couch the spear forward
                const s = Math.sin(t * 7.5 + phase);
                swing('armR', m3.rotationX(-0.3 - Math.max(0, s) * 0.5));
            } else { // idle: a slow grazing bow of the neck
                swing('head', m3.rotationX(Math.max(0, Math.sin(t * 0.9 + phase)) * 0.12));
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
