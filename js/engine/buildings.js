// EngineBuildings — procedural building compositions for the in-house engine.
// Each builder returns PARTS: { kind, args, tex, m, blend, key } where kind/args
// name an EngineMesh primitive (so callers cache geometry by `key`), tex names a
// TexGen material, and m is the part's local transform. Every building carries a
// blended contact-shadow disc — the grounding that keeps things from floating.
(function () {
    const EngineBuildings = {};
    const M = () => window.M3D;

    const part = (arr, kind, args, tex, t = {}) => {
        const m3 = M();
        let m = m3.translation(t.x || 0, t.y || 0, t.z || 0);
        if (t.ry) m = m3.multiply(m, m3.rotationY(t.ry));
        if (t.rx) m = m3.multiply(m, m3.rotationX(t.rx));
        if (t.rz) m = m3.multiply(m, m3.rotationZ(t.rz));
        if (t.sx || t.sy || t.sz) m = m3.multiply(m, m3.scaling(t.sx || 1, t.sy || 1, t.sz || 1));
        arr.push({ kind, args, tex, m, blend: !!t.blend, key: kind + ':' + args.join(',') });
    };
    const shadow = (arr, r) => part(arr, 'disc', [r, 18], 'shadow', { y: 0.06, blend: true });

    // Four building eras following the classic scheme: STONE = hide teepees,
    // stick high-seats, bare dirt fields; NEOLITHIC = leather-shelled dome
    // huts, log towers, patchy crops; BRONZE = timber huts, longhouse TC,
    // proper crop rows; IRON = stone houses, stone towers, a small castle TC
    // and a fenced, organized farm.
    const ageOf = (o) => (o && o.age) || 'stone';

    // Teepee: hide cone + poles poking out the apex + door flap.
    const teepee = (p, r, h, poles) => {
        part(p, 'cylinder', [0, r, h, 10], 'leather', { y: h / 2 });
        for (let i = 0; i < poles; i++) {
            const a = (i / poles) * Math.PI * 2 + 0.35;
            part(p, 'cylinder', [0.05, 0.05, h * 0.32, 4], 'bark', {
                x: Math.cos(a) * r * 0.12, y: h + h * 0.06, z: Math.sin(a) * r * 0.12,
                rx: Math.sin(a) * 0.3, rz: -Math.cos(a) * 0.3
            });
        }
        part(p, 'box', [r * 0.42, h * 0.34, 0.14], 'bark', { y: h * 0.17, z: r * 0.92 });
    };

    // Dome hut: low round wall under a leather/thatch dome with a smoke cap.
    const domeHut = (p, r, wallH, tex) => {
        part(p, 'cylinder', [r * 0.96, r, wallH, 12], 'wood', { y: wallH / 2 });
        part(p, 'sphere', [1, 12, 8], tex, { y: wallH * 0.9, sx: r, sy: r * 0.72, sz: r });
        part(p, 'cylinder', [0, r * 0.18, r * 0.28, 6], 'bark', { y: wallH * 0.9 + r * 0.7 });
        part(p, 'box', [r * 0.5, wallH * 0.85, 0.16], 'bark', { y: wallH * 0.45, z: r * 0.97 });
    };

    const builders = {
        town_center: (o = {}) => {
            const p = [];
            const age = ageOf(o);
            shadow(p, 8.2);
            if (age === 'stone') {
                // Big Teepee: an oversized hide tent with a patterned base band.
                teepee(p, 5.2, 7.6, 5);
                part(p, 'cylinder', [4.35, 4.7, 0.9, 10], 'awning', { y: 0.75 });
            } else if (age === 'neolithic') {
                // Community dome hut.
                domeHut(p, 4.9, 2.2, 'thatch');
            } else if (age === 'bronze') {
                // Longhouse: a long timber hall under a big thatch gable.
                part(p, 'frustum', [11, 8, 10.4, 7.4, 0.6], 'masonry');
                part(p, 'box', [9.6, 3.2, 5.4], 'wood', { y: 2.2 });
                part(p, 'prism', [10.6, 6.4, 2.8], 'thatch', { y: 3.8 });
                part(p, 'box', [10.6, 0.22, 0.22], 'bark', { y: 6.6 });
                part(p, 'box', [1.8, 2.2, 0.3], 'bark', { y: 1.7, z: 3.32 });
            } else {
                // Iron: a small castle — keep, corner turrets, tiled caps.
                part(p, 'frustum', [11, 11, 9.8, 9.8, 0.9], 'masonry');
                part(p, 'box', [8.2, 3.6, 8.2], 'masonry', { y: 2.7 });
                [[-4.1, -4.1], [4.1, -4.1], [4.1, 4.1], [-4.1, 4.1]].forEach(([x, z]) => {
                    part(p, 'cylinder', [0.95, 1.1, 5.2, 8], 'masonry', { x, y: 2.6, z });
                    part(p, 'cylinder', [0, 1.15, 1.5, 8], 'rooftile', { x, y: 5.95, z });
                });
                part(p, 'box', [3.6, 2.6, 3.6], 'masonry', { y: 5.8 });
                part(p, 'pyramid', [4.2, 4.2, 1.6], 'rooftile', { y: 7.1 });
                part(p, 'box', [1.9, 2.2, 0.3], 'wood', { y: 1.9, z: 4.12 });
                part(p, 'pyramid', [1.6, 1.6, 1.1], 'gold', { y: 8.7 }); // iron finial
            }
            return p;
        },
        house: (o = {}) => {
            const p = [];
            const age = ageOf(o);
            shadow(p, 4.4);
            if (age === 'stone') {
                teepee(p, 2.6, 4.3, 4);
            } else if (age === 'neolithic') {
                domeHut(p, 2.5, 1.4, 'leather');
            } else if (age === 'bronze') {
                part(p, 'box', [4.2, 2.2, 3.8], 'wood', { y: 1.1 });
                [[-1.95, -1.75], [1.95, -1.75], [-1.95, 1.75], [1.95, 1.75]].forEach(([x, z]) =>
                    part(p, 'box', [0.26, 2.3, 0.26], 'bark', { x, y: 1.15, z }));
                part(p, 'prism', [5.2, 4.6, 1.9], 'thatch', { y: 2.2 });
                part(p, 'box', [1.1, 1.5, 0.22], 'bark', { y: 0.75, z: 1.96 });
            } else {
                part(p, 'box', [4.9, 0.5, 4.5], 'masonry', { y: 0.25 }); // plinth
                part(p, 'box', [4.6, 2.5, 4.2], 'plaster', { y: 1.65 });
                part(p, 'box', [1.2, 1.7, 0.25], 'wood', { y: 1.15, z: 2.16 });
                part(p, 'prism', [5.6, 5.0, 2.0], 'rooftile', { y: 2.9 });
            }
            return p;
        },
        barracks: () => {
            const p = [];
            shadow(p, 6.6);
            part(p, 'box', [8, 3.2, 6], 'masonry', { y: 1.6 });
            part(p, 'box', [2.4, 2.3, 0.3], 'wood', { y: 1.15, z: 3.05 });
            part(p, 'prism', [8.8, 6.8, 2.4], 'rooftile', { y: 3.2 });
            return p;
        },
        stable: () => {
            const p = [];
            shadow(p, 6.2);
            part(p, 'box', [7, 2.6, 5], 'wood', { y: 1.3 });
            part(p, 'prism', [7.8, 5.8, 1.9], 'thatch', { y: 2.6 });
            // corral rail
            part(p, 'cylinder', [0.09, 0.11, 1.1, 5], 'bark', { x: -2.2, y: 0.55, z: 3.6 });
            part(p, 'cylinder', [0.09, 0.11, 1.1, 5], 'bark', { x: 0, y: 0.55, z: 3.6 });
            part(p, 'cylinder', [0.09, 0.11, 1.1, 5], 'bark', { x: 2.2, y: 0.55, z: 3.6 });
            part(p, 'box', [4.8, 0.16, 0.16], 'wood', { y: 0.95, z: 3.6 });
            return p;
        },
        archery_range: () => {
            const p = [];
            shadow(p, 5.8);
            part(p, 'box', [6, 2.4, 5], 'masonry', { y: 1.2 });
            part(p, 'pyramid', [7, 6, 2.2], 'thatch', { y: 2.4 });
            // practice frame off to the side
            part(p, 'cylinder', [0.1, 0.12, 2.2, 5], 'bark', { x: 4.4, y: 1.1, z: 1.2 });
            part(p, 'cylinder', [0.1, 0.12, 2.2, 5], 'bark', { x: 4.4, y: 1.1, z: -1.2 });
            part(p, 'box', [0.16, 0.16, 2.8], 'wood', { x: 4.4, y: 2.1 });
            return p;
        },
        market: () => {
            const p = [];
            shadow(p, 6.6);
            part(p, 'box', [5.4, 2.0, 5.4], 'plaster', { y: 1.0 });
            part(p, 'cylinder', [0.1, 0.1, 2.7, 5], 'wood', { x: 3.7, y: 1.35, z: 3.7 });
            part(p, 'cylinder', [0.1, 0.1, 2.7, 5], 'wood', { x: -3.7, y: 1.35, z: 3.7 });
            part(p, 'cylinder', [0.1, 0.1, 2.7, 5], 'wood', { x: 3.7, y: 1.35, z: -3.7 });
            part(p, 'cylinder', [0.1, 0.1, 2.7, 5], 'wood', { x: -3.7, y: 1.35, z: -3.7 });
            part(p, 'pyramid', [8.6, 8.6, 1.7], 'awning', { y: 2.7 });
            return p;
        },
        farm: (o = {}) => {
            const p = [];
            const age = ageOf(o);
            if (age === 'stone') {
                // Bare turned dirt patch — no posts, just soil and clods.
                part(p, 'box', [6.4, 0.2, 6.4], 'field_dirt', { y: 0.1 });
            } else if (age === 'neolithic') {
                // Unorganized crops with rough corner stakes.
                part(p, 'box', [7, 0.22, 7], 'field_patchy', { y: 0.11 });
                [[-3.3, -3.3], [3.3, -3.3], [3.3, 3.3], [-3.3, 3.3]].forEach(([x, z]) =>
                    part(p, 'cylinder', [0.08, 0.1, 0.9, 5], 'bark', { x, y: 0.45, z }));
            } else if (age === 'bronze') {
                // Proper rows.
                part(p, 'box', [7, 0.22, 7], 'field', { y: 0.11 });
                [[-3.3, -3.3], [3.3, -3.3], [3.3, 3.3], [-3.3, 3.3]].forEach(([x, z]) =>
                    part(p, 'cylinder', [0.08, 0.1, 0.9, 5], 'bark', { x, y: 0.45, z }));
            } else {
                // Iron: organized grain field with a full fence, a water barrel
                // and a leaning tool by the gate.
                part(p, 'box', [7, 0.24, 7], 'field', { y: 0.12 });
                const F = 3.5;
                [[-F, -F], [0, -F], [F, -F], [-F, 0], [F, 0], [-F, F], [0, F], [F, F]].forEach(([x, z]) =>
                    part(p, 'cylinder', [0.08, 0.1, 1.0, 5], 'bark', { x, y: 0.5, z }));
                part(p, 'box', [7, 0.12, 0.12], 'wood', { y: 0.82, z: -F });
                part(p, 'box', [7, 0.12, 0.12], 'wood', { y: 0.82, z: F });
                part(p, 'box', [0.12, 0.12, 7], 'wood', { x: -F, y: 0.82 });
                part(p, 'box', [0.12, 0.12, 7], 'wood', { x: F, y: 0.82 });
                part(p, 'cylinder', [0.42, 0.42, 0.8, 9], 'wood', { x: F + 0.8, y: 0.4, z: F * 0.4 });
                part(p, 'cylinder', [0.04, 0.04, 1.5, 4], 'bark', { x: F + 0.7, y: 0.7, z: -F * 0.4, rz: 0.5 });
            }
            return p;
        },
        tower: (o = {}) => {
            const p = [];
            const age = ageOf(o);
            shadow(p, 3.8);
            if (age === 'stone') {
                // Wood-beam high seat: four legs, platform, guard rail — no roof.
                [[-1.1, -1.1], [1.1, -1.1], [1.1, 1.1], [-1.1, 1.1]].forEach(([x, z]) =>
                    part(p, 'cylinder', [0.13, 0.17, 5.2, 5], 'bark', { x, y: 2.6, z }));
                part(p, 'box', [2.4, 0.16, 0.16], 'wood', { y: 1.7, z: 1.1 });
                part(p, 'box', [3.0, 0.3, 3.0], 'wood', { y: 5.35 });
                [[-1.35, -1.35], [1.35, -1.35], [1.35, 1.35], [-1.35, 1.35]].forEach(([x, z]) =>
                    part(p, 'cylinder', [0.07, 0.07, 0.9, 4], 'bark', { x, y: 5.9, z }));
                part(p, 'box', [3.0, 0.1, 0.1], 'wood', { y: 6.3, z: -1.35 });
            } else if (age === 'neolithic') {
                // Crude log tower: rough timber stack with lashings + open lookout.
                part(p, 'box', [2.5, 4.6, 2.5], 'wood', { y: 2.3 });
                [1.0, 2.2, 3.4].forEach(y =>
                    part(p, 'box', [2.66, 0.2, 2.66], 'bark', { y }));
                part(p, 'box', [3.1, 0.3, 3.1], 'wood', { y: 4.75 });
                [[-1.4, -1.4], [1.4, -1.4], [1.4, 1.4], [-1.4, 1.4]].forEach(([x, z]) =>
                    part(p, 'cylinder', [0.08, 0.08, 0.9, 4], 'bark', { x, y: 5.3, z }));
            } else if (age === 'bronze') {
                // Timber tower on a stone footing, thatch cap.
                part(p, 'box', [3.2, 1.2, 3.2], 'masonry', { y: 0.6 });
                part(p, 'box', [2.4, 4.4, 2.4], 'wood', { y: 3.4 });
                part(p, 'box', [2.56, 0.18, 2.56], 'bark', { y: 3.2 });
                part(p, 'box', [3.1, 0.3, 3.1], 'wood', { y: 5.75 });
                part(p, 'pyramid', [3.4, 3.4, 1.5], 'thatch', { y: 5.9 });
                part(p, 'box', [0.4, 1.1, 0.2], 'bark', { y: 3.7, z: 1.22 });
            } else {
                // Iron: solid stone sentinel with a tiled cap.
                part(p, 'frustum', [3.6, 3.6, 2.7, 2.7, 6.5], 'masonry');
                part(p, 'box', [3.4, 0.7, 3.4], 'masonry', { y: 6.85 });
                part(p, 'pyramid', [3.9, 3.9, 1.7], 'rooftile', { y: 7.2 });
                part(p, 'box', [0.5, 1.3, 0.22], 'bark', { y: 4.6, z: 1.62 });
            }
            return p;
        },
        temple: () => {
            const p = [];
            shadow(p, 6.8);
            part(p, 'frustum', [8, 7, 7.4, 6.4, 0.8], 'masonry');
            part(p, 'box', [5.6, 3.0, 4.6], 'plaster', { y: 2.3 });
            [-2.4, -0.8, 0.8, 2.4].forEach(x =>
                part(p, 'cylinder', [0.26, 0.3, 3.0, 8], 'plaster', { x, y: 2.3, z: 2.85 }));
            part(p, 'prism', [8, 6.6, 2.2], 'rooftile', { y: 3.8 });
            return p;
        },
        wonder: () => {
            const p = [];
            shadow(p, 10);
            part(p, 'frustum', [13, 13, 10.4, 10.4, 2.2], 'masonry');
            part(p, 'frustum', [10.4, 10.4, 7.8, 7.8, 2.0], 'masonry', { y: 2.2 });
            part(p, 'frustum', [7.8, 7.8, 5.2, 5.2, 1.8], 'masonry', { y: 4.2 });
            part(p, 'pyramid', [5.2, 5.2, 2.6], 'gold', { y: 6.0 });
            return p;
        }
    };

    // A building's parts (empty array for unknown types — callers stay safe).
    EngineBuildings.parts = (type, opts) => {
        const b = builders[type];
        return b ? b(opts || {}) : [];
    };

    // Generic construction site sized to a footprint: plinth, a unit-height
    // shell box the RENDERER scales to h·progress (part index 2 — the growth
    // preview reaches the real final height), scaffold poles + crossbeams
    // sized to h.
    EngineBuildings.site = (w, d, h = 4) => {
        const p = [];
        shadow(p, Math.max(w, d) * 0.7);
        part(p, 'frustum', [w, d, w - 0.6, d - 0.6, 0.5], 'masonry');
        part(p, 'box', [w - 1.2, 1, d - 1.2], 'plaster', { y: 1 }); // shell (renderer-scaled)
        const px = w / 2 - 0.35, pz = d / 2 - 0.35;
        const ph = h + 0.7;
        [[-px, -pz], [px, -pz], [px, pz], [-px, pz]].forEach(([x, z]) =>
            part(p, 'cylinder', [0.11, 0.13, ph, 5], 'bark', { x, y: ph / 2, z }));
        part(p, 'box', [w, 0.14, 0.14], 'wood', { y: ph - 0.15, z: pz });
        part(p, 'box', [w, 0.14, 0.14], 'wood', { y: ph - 0.15, z: -pz });
        return p;
    };

    EngineBuildings.TYPES = Object.keys(builders);

    window.EngineBuildings = EngineBuildings;
})();
