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
        arr.push({ kind, args, tex, m, blend: !!t.blend, team: !!t.team, key: kind + ':' + args.join(',') });
    };
    const shadow = (arr, r) => part(arr, 'disc', [r, 18], 'shadow', { y: 0.06, blend: true });

    // Four building eras following the classic scheme: STONE = hide teepees,
    // stick high-seats, bare dirt fields; NEOLITHIC = leather-shelled dome
    // huts, log towers, patchy crops; BRONZE = timber huts, longhouse TC,
    // proper crop rows; IRON = stone houses, stone towers, a small castle TC
    // and a fenced, organized farm.
    const ageOf = (o) => (o && o.age) || 'stone';
    const civOf = (o) => (o && o.civ) || null;
    const TIER = { stone: 0, neolithic: 1, bronze: 2, iron: 3 };

    // Cultural entrance trim, from bronze on (earlier eras carry only tiny
    // markers — cultures diverge as they mature). Facade faces +Z at `z`.
    // egyptian: battered pylon posts + gold lintel; greek: columned porch with
    // a pediment; yamato: a torii gate one step out (team-tinted beam);
    // persian: a glazed team-color lintel band.
    const doorTrim = (p, civ, tier, z, doorW = 1.4, doorH = 2.0, x = 0) => {
        if (!civ || tier < 2) return;
        if (civ === 'egyptian') {
            const px = doorW / 2 + 0.45;
            part(p, 'frustum', [0.66, 0.5, 0.4, 0.32, doorH + 0.3], 'masonry', { x: x - px, z });
            part(p, 'frustum', [0.66, 0.5, 0.4, 0.32, doorH + 0.3], 'masonry', { x: x + px, z });
            part(p, 'box', [doorW + 1.9, 0.28, 0.5], 'gold', { x, y: doorH + 0.45, z });
        } else if (civ === 'greek') {
            const px = doorW / 2 + 0.42;
            part(p, 'cylinder', [0.16, 0.19, doorH + 0.2, 8], 'plaster', { x: x - px, y: (doorH + 0.2) / 2, z });
            part(p, 'cylinder', [0.16, 0.19, doorH + 0.2, 8], 'plaster', { x: x + px, y: (doorH + 0.2) / 2, z });
            part(p, 'prism', [doorW + 1.7, 0.7, 0.9], 'plaster', { x, y: doorH + 0.28, z: z - 0.12 });
        } else if (civ === 'yamato') {
            const px = doorW / 2 + 0.55, tz = z + 1.15, th = doorH + 0.7;
            part(p, 'cylinder', [0.09, 0.11, th, 5], 'bark', { x: x - px, y: th / 2, z: tz });
            part(p, 'cylinder', [0.09, 0.11, th, 5], 'bark', { x: x + px, y: th / 2, z: tz });
            part(p, 'box', [doorW + 2.3, 0.17, 0.22], 'cloth', { x, y: th + 0.06, z: tz, team: true });
            if (tier >= 3) part(p, 'box', [doorW + 1.5, 0.13, 0.16], 'wood', { x, y: th - 0.42, z: tz });
        } else if (civ === 'persian') {
            part(p, 'box', [doorW + 1.6, 0.3, 0.24], 'cloth', { x, y: doorH + 0.32, z, team: true });
        }
    };

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
            const civ = civOf(o);
            const tier = TIER[age] || 0;
            shadow(p, 8.2);
            if (age === 'stone') {
                // Big Teepee — near-universal; cultures show only a tiny marker.
                teepee(p, 5.2, 7.6, 5);
                part(p, 'cylinder', [4.35, 4.7, 0.9, 10], civ === 'persian' ? 'cloth' : 'awning',
                    { y: 0.75, team: civ === 'persian' }); // Persia dyes the band its own color
                if (civ === 'egyptian') { // a votive gold pot by the flap
                    part(p, 'sphere', [1, 8, 6], 'gold', { x: 1.9, y: 0.24, z: 4.6, sx: 0.24, sy: 0.24, sz: 0.24 });
                }
                if (civ === 'greek') { // whitewashed threshold stones
                    part(p, 'sphere', [1, 8, 6], 'plaster', { x: -1.8, y: 0.2, z: 4.7, sx: 0.3, sy: 0.2, sz: 0.3 });
                    part(p, 'sphere', [1, 8, 6], 'plaster', { x: -2.4, y: 0.16, z: 4.3, sx: 0.22, sy: 0.16, sz: 0.22 });
                }
                if (civ === 'yamato') { // shimenawa-like rope ring around the tent
                    part(p, 'cylinder', [3.72, 3.72, 0.16, 10], 'bark', { y: 2.3 });
                }
            } else if (age === 'neolithic') {
                // Community dome hut + the first small trait at the entrance.
                domeHut(p, 4.9, 2.2, 'thatch');
                if (civ === 'egyptian') part(p, 'box', [1.7, 0.24, 0.3], 'gold', { y: 2.1, z: 4.8 });
                if (civ === 'greek') {
                    part(p, 'cylinder', [0.12, 0.15, 1.9, 7], 'plaster', { x: -1.05, y: 0.95, z: 4.75 });
                    part(p, 'cylinder', [0.12, 0.15, 1.9, 7], 'plaster', { x: 1.05, y: 0.95, z: 4.75 });
                }
                if (civ === 'yamato') { // a first small torii
                    part(p, 'cylinder', [0.08, 0.1, 2.1, 5], 'bark', { x: -1.1, y: 1.05, z: 5.7 });
                    part(p, 'cylinder', [0.08, 0.1, 2.1, 5], 'bark', { x: 1.1, y: 1.05, z: 5.7 });
                    part(p, 'box', [3.0, 0.15, 0.2], 'cloth', { y: 2.16, z: 5.7, team: true });
                }
                if (civ === 'persian') part(p, 'cylinder', [4.66, 4.94, 0.34, 12], 'cloth', { y: 1.95, team: true });
            } else if (age === 'bronze') {
                // Bronze: each culture raises its own great hall.
                if (civ === 'greek') {
                    // Megaron: stone platform, white hall, columned porch, tiled gable.
                    part(p, 'frustum', [10, 8, 9.4, 7.4, 0.8], 'masonry');
                    part(p, 'box', [7.6, 3.0, 5.2], 'plaster', { y: 2.3 });
                    part(p, 'prism', [8.6, 6.0, 2.2], 'rooftile', { y: 3.8 });
                    [-2.4, -0.8, 0.8, 2.4].forEach(x =>
                        part(p, 'cylinder', [0.22, 0.26, 2.8, 8], 'plaster', { x, y: 2.2, z: 3.5 }));
                    part(p, 'prism', [7.4, 1.8, 1.4], 'plaster', { y: 3.62, z: 3.4 });
                    part(p, 'box', [1.6, 2.0, 0.3], 'bark', { y: 1.8, z: 2.7 });
                } else if (civ === 'yamato') {
                    // Raised hall under double eaves, a torii before the gate.
                    part(p, 'frustum', [10, 8, 9.2, 7.2, 0.7], 'masonry');
                    part(p, 'box', [7.4, 2.8, 5.0], 'wood', { y: 2.1 });
                    part(p, 'pyramid', [10.8, 8.4, 0.9], 'thatch', { y: 3.4 });  // lower eave skirt
                    part(p, 'pyramid', [8.4, 6.2, 2.0], 'thatch', { y: 4.05 }); // upper roof
                    part(p, 'box', [0.12, 1.0, 0.12], 'bark', { y: 6.35, rz: 0.45 });
                    part(p, 'box', [0.12, 1.0, 0.12], 'bark', { y: 6.35, rz: -0.45 });
                    part(p, 'box', [1.7, 2.0, 0.3], 'bark', { y: 1.7, z: 2.58 });
                    doorTrim(p, 'yamato', 2, 2.7, 1.8, 2.2);
                } else if (civ === 'persian') {
                    // Walled mud-brick compound: tapered walls, buttresses, first dome.
                    part(p, 'frustum', [10.5, 8.5, 8.8, 7.0, 3.4], 'masonry');
                    [[-4.7, -3.8], [4.7, -3.8], [-4.7, 3.8], [4.7, 3.8]].forEach(([x, z]) =>
                        part(p, 'cylinder', [0.5, 0.68, 3.8, 7], 'masonry', { x, y: 1.9, z }));
                    part(p, 'box', [6.2, 1.8, 4.4], 'plaster', { y: 4.2 });
                    part(p, 'cylinder', [0, 1.35, 1.5, 9], 'cloth', { y: 5.85, team: true });
                    part(p, 'sphere', [1, 8, 6], 'gold', { y: 7.4, sx: 0.2, sy: 0.2, sz: 0.2 });
                    for (let i = 0; i < 5; i++) {
                        part(p, 'box', [0.55, 0.45, 0.4], 'masonry', { x: -4.0 + i * 2.0, y: 3.6, z: 4.05 });
                    }
                    part(p, 'box', [1.6, 2.4, 0.3], 'wood', { y: 1.3, z: 4.72 });
                    doorTrim(p, 'persian', 2, 4.75, 1.6, 2.5);
                } else if (civ === 'egyptian') {
                    // Temple hall: battered walls, small pylon gate, gold cornice.
                    part(p, 'frustum', [10, 8, 9.0, 7.2, 3.0], 'masonry');
                    part(p, 'box', [6.8, 1.6, 5.0], 'plaster', { y: 3.7 });
                    part(p, 'box', [9.4, 0.28, 0.34], 'gold', { y: 3.05, z: 3.62 });
                    part(p, 'frustum', [1.5, 1.1, 1.0, 0.8, 3.6], 'masonry', { x: -2.1, z: 4.0 });
                    part(p, 'frustum', [1.5, 1.1, 1.0, 0.8, 3.6], 'masonry', { x: 2.1, z: 4.0 });
                    part(p, 'box', [2.9, 0.4, 0.7], 'gold', { y: 3.75, z: 4.0 });
                    part(p, 'box', [1.5, 2.4, 0.3], 'bark', { y: 1.3, z: 4.35 });
                } else {
                    // Generic longhouse (no civ — engine-test).
                    part(p, 'frustum', [11, 8, 10.4, 7.4, 0.6], 'masonry');
                    part(p, 'box', [9.6, 3.2, 5.4], 'wood', { y: 2.2 });
                    part(p, 'prism', [10.6, 6.4, 2.8], 'thatch', { y: 3.8 });
                    part(p, 'box', [10.6, 0.22, 0.22], 'bark', { y: 6.6 });
                    part(p, 'box', [1.8, 2.2, 0.3], 'bark', { y: 1.7, z: 3.32 });
                }
            } else {
                // Iron: four castle archetypes, each unmistakably its culture's.
                if (civ === 'greek') {
                    // KASTRO: white fortress walls, corner towers, a temple-keep
                    // with colonnade and pediment on top.
                    part(p, 'frustum', [11, 11, 9.8, 9.8, 1.0], 'masonry');
                    part(p, 'box', [8.6, 3.2, 8.6], 'plaster', { y: 2.6 });
                    [[-4.2, -4.2], [4.2, -4.2], [4.2, 4.2], [-4.2, 4.2]].forEach(([x, z]) => {
                        part(p, 'box', [1.8, 4.4, 1.8], 'plaster', { x, y: 2.4, z });
                        part(p, 'pyramid', [2.2, 2.2, 0.9], 'rooftile', { x, y: 4.6, z });
                    });
                    part(p, 'box', [5.0, 0.6, 4.0], 'masonry', { y: 4.5 });
                    [[-1.8, -1.3], [-1.8, 1.3], [0, -1.3], [0, 1.3], [1.8, -1.3], [1.8, 1.3]].forEach(([x, z]) =>
                        part(p, 'cylinder', [0.2, 0.24, 2.2, 8], 'plaster', { x, y: 5.9, z }));
                    part(p, 'prism', [5.6, 4.4, 1.7], 'plaster', { y: 7.0 });
                    part(p, 'box', [1.8, 2.2, 0.3], 'wood', { y: 1.9, z: 4.32 });
                    doorTrim(p, 'greek', 3, 4.45, 1.8, 2.3);
                } else if (civ === 'yamato') {
                    // SHIRO: sloped stone base, stacked white floors, each under a
                    // wider dark-tiled eave, gold shachi on the crest.
                    part(p, 'frustum', [11, 11, 8.8, 8.8, 1.8], 'masonry');
                    part(p, 'box', [7.2, 2.2, 7.2], 'plaster', { y: 2.9 });
                    part(p, 'pyramid', [9.6, 9.6, 1.2], 'rooftile', { y: 4.0 });
                    part(p, 'box', [5.4, 1.9, 5.4], 'plaster', { y: 5.05 });
                    part(p, 'pyramid', [7.4, 7.4, 1.1], 'rooftile', { y: 5.95 });
                    part(p, 'box', [3.9, 1.7, 3.9], 'plaster', { y: 6.85 });
                    part(p, 'pyramid', [5.5, 5.5, 1.7], 'rooftile', { y: 7.65 });
                    part(p, 'box', [0.16, 0.55, 0.16], 'gold', { x: -0.7, y: 9.35, rz: 0.35 });
                    part(p, 'box', [0.16, 0.55, 0.16], 'gold', { x: 0.7, y: 9.35, rz: -0.35 });
                    part(p, 'box', [1.7, 2.0, 0.3], 'wood', { y: 1.6, z: 4.85 });
                    doorTrim(p, 'yamato', 3, 4.95, 1.7, 2.4);
                } else if (civ === 'persian') {
                    // KASBAH (Alamut): one massive tapered fortress body, stepped
                    // merlons, round towers under pointed team-glazed caps, a great
                    // gold-tipped dome over the inner keep.
                    part(p, 'frustum', [11.5, 11.5, 9.0, 9.0, 4.2], 'masonry');
                    [[-4.9, -4.9], [4.9, -4.9], [4.9, 4.9], [-4.9, 4.9]].forEach(([x, z]) => {
                        part(p, 'cylinder', [0.9, 1.15, 5.6, 8], 'masonry', { x, y: 2.8, z });
                        part(p, 'cylinder', [0, 1.05, 1.5, 8], 'cloth', { x, y: 6.35, z, team: true });
                    });
                    for (let i = 0; i < 5; i++) {
                        part(p, 'box', [0.6, 0.5, 0.4], 'masonry', { x: -4.0 + i * 2.0, y: 4.45, z: 4.35 });
                    }
                    part(p, 'box', [4.2, 2.0, 4.2], 'plaster', { y: 5.2 });
                    part(p, 'cylinder', [1.7, 1.9, 1.0, 9], 'cloth', { y: 6.7, team: true });
                    part(p, 'cylinder', [0, 1.7, 1.9, 9], 'cloth', { y: 8.15, team: true });
                    part(p, 'sphere', [1, 8, 6], 'gold', { y: 9.3, sx: 0.28, sy: 0.28, sz: 0.28 });
                    part(p, 'box', [1.6, 3.0, 0.4], 'wood', { y: 1.5, z: 5.4 });
                    doorTrim(p, 'persian', 3, 5.45, 1.6, 3.1);
                } else if (civ === 'egyptian') {
                    // MENNU: a temple-fortress — twin battered pylons bridge a gold
                    // lintel over the gate, battered enclosure walls behind, gold
                    // pyramidion over the sanctuary, obelisks flanking the approach.
                    part(p, 'frustum', [11, 9, 9.4, 7.6, 3.6], 'masonry', { z: -0.9 });
                    part(p, 'box', [6.6, 1.8, 4.8], 'plaster', { y: 4.4, z: -0.9 });
                    part(p, 'pyramid', [2.4, 2.4, 1.5], 'gold', { y: 5.3, z: -0.9 });
                    part(p, 'frustum', [3.0, 1.6, 2.2, 1.2, 5.4], 'masonry', { x: -2.8, z: 3.4 });
                    part(p, 'frustum', [3.0, 1.6, 2.2, 1.2, 5.4], 'masonry', { x: 2.8, z: 3.4 });
                    part(p, 'box', [3.2, 0.5, 0.9], 'gold', { y: 4.95, z: 3.4 });
                    part(p, 'box', [1.6, 2.6, 0.34], 'bark', { y: 1.4, z: 4.1 });
                    [[-5.4, 4.4], [5.4, 4.4]].forEach(([x, z]) => {
                        part(p, 'frustum', [0.66, 0.66, 0.32, 0.32, 4.2], 'masonry', { x, z });
                        part(p, 'pyramid', [0.42, 0.42, 0.55], 'gold', { x, y: 4.2, z });
                    });
                } else {
                    // Generic castle (no civ — engine-test).
                    part(p, 'frustum', [11, 11, 9.8, 9.8, 0.9], 'masonry');
                    part(p, 'box', [8.2, 3.6, 8.2], 'masonry', { y: 2.7 });
                    [[-4.1, -4.1], [4.1, -4.1], [4.1, 4.1], [-4.1, 4.1]].forEach(([x, z]) => {
                        part(p, 'cylinder', [0.95, 1.1, 5.2, 8], 'masonry', { x, y: 2.6, z });
                        part(p, 'cylinder', [0, 1.15, 1.5, 8], 'rooftile', { x, y: 5.95, z });
                    });
                    part(p, 'box', [3.6, 2.6, 3.6], 'masonry', { y: 5.8 });
                    part(p, 'pyramid', [4.2, 4.2, 1.6], 'rooftile', { y: 7.1 });
                    part(p, 'pyramid', [1.6, 1.6, 1.1], 'gold', { y: 8.7 });
                    part(p, 'box', [1.9, 2.2, 0.3], 'wood', { y: 1.9, z: 4.12 });
                }
            }
            return p;
        },
        house: (o = {}) => {
            const p = [];
            const age = ageOf(o);
            const civ = civOf(o);
            const tier = TIER[age] || 0;
            shadow(p, 4.4);
            if (age === 'stone') {
                teepee(p, 2.6, 4.3, 4); // universal — culture hasn't reached the hearth yet
            } else if (age === 'neolithic') {
                domeHut(p, 2.5, 1.4, 'leather');
            } else if (age === 'bronze') {
                part(p, 'box', [4.2, 2.2, 3.8], 'wood', { y: 1.1 });
                [[-1.95, -1.75], [1.95, -1.75], [-1.95, 1.75], [1.95, 1.75]].forEach(([x, z]) =>
                    part(p, 'box', [0.26, 2.3, 0.26], 'bark', { x, y: 1.15, z }));
                part(p, 'prism', [5.2, 4.6, 1.9], 'thatch', { y: 2.2 });
                part(p, 'box', [1.1, 1.5, 0.22], 'bark', { y: 0.75, z: 1.96 });
                doorTrim(p, civ, tier, 2.0, 1.1, 1.6);
                if (civ === 'yamato') {
                    [-2.55, 2.55].forEach(x => {
                        part(p, 'box', [0.1, 0.7, 0.1], 'bark', { x, y: 4.15, rz: 0.45 });
                        part(p, 'box', [0.1, 0.7, 0.1], 'bark', { x, y: 4.15, rz: -0.45 });
                    });
                }
            } else {
                part(p, 'box', [4.9, 0.5, 4.5], 'masonry', { y: 0.25 }); // plinth
                part(p, 'box', [4.6, 2.5, 4.2], 'plaster', { y: 1.65 });
                part(p, 'box', [1.2, 1.7, 0.25], 'wood', { y: 1.15, z: 2.16 });
                part(p, 'prism', [5.6, 5.0, 2.0], 'rooftile', { y: 2.9 });
                doorTrim(p, civ, tier, 2.3, 1.2, 1.8);
                if (civ === 'yamato') {
                    [-2.75, 2.75].forEach(x => {
                        part(p, 'box', [0.1, 0.7, 0.1], 'bark', { x, y: 4.95, rz: 0.45 });
                        part(p, 'box', [0.1, 0.7, 0.1], 'bark', { x, y: 4.95, rz: -0.45 });
                    });
                }
            }
            return p;
        },
        barracks: (o = {}) => {
            const p = [];
            const age = ageOf(o);
            shadow(p, 6.6);
            if (age === 'stone') {
                // War camp: a big hide A-tent over a ridge pole, a rack of spears
                // leaning beside it, sharpened stakes marking the muster ground.
                part(p, 'prism', [7.2, 5.6, 3.0], 'leather', { y: 0 });
                part(p, 'box', [7.6, 0.18, 0.18], 'bark', { y: 3.02 });
                part(p, 'cylinder', [0.05, 0.05, 2.6, 4], 'bark', { x: 4.6, y: 1.3, z: 1.2, rz: 0.35 });
                part(p, 'cylinder', [0.05, 0.05, 2.6, 4], 'bark', { x: 4.4, y: 1.3, z: 0.2, rz: -0.3 });
                part(p, 'cylinder', [0.05, 0.05, 2.6, 4], 'bark', { x: 4.7, y: 1.3, z: -0.8, rz: 0.2 });
                [[-4.3, 2.6], [-4.6, 1.2], [-4.4, -0.4]].forEach(([x, z]) =>
                    part(p, 'cylinder', [0.02, 0.11, 1.5, 5], 'bark', { x, y: 0.75, z }));
            } else if (age === 'neolithic') {
                // War lodge: lashed log walls under thatch, a palisade row out front.
                part(p, 'box', [7.6, 2.4, 5.6], 'wood', { y: 1.2 });
                part(p, 'box', [7.76, 0.2, 5.76], 'bark', { y: 0.9 });
                part(p, 'prism', [8.6, 6.4, 2.2], 'thatch', { y: 2.4 });
                part(p, 'box', [2.2, 2.0, 0.3], 'bark', { y: 1.0, z: 2.86 });
                [[-2.4, 3.6], [-1.2, 3.8], [0, 3.7], [1.2, 3.8], [2.4, 3.6]].forEach(([x, z]) =>
                    part(p, 'cylinder', [0.03, 0.13, 1.7, 5], 'bark', { x, y: 0.85, z }));
            } else if (age === 'bronze') {
                // Training hall: timber on a stone footing, a practice dummy in the yard.
                part(p, 'box', [8, 1.0, 6], 'masonry', { y: 0.5 });
                part(p, 'box', [7.6, 2.4, 5.6], 'wood', { y: 2.2 });
                part(p, 'prism', [8.8, 6.6, 2.3], 'thatch', { y: 3.4 });
                part(p, 'box', [2.4, 2.2, 0.3], 'bark', { y: 1.5, z: 2.86 });
                part(p, 'cylinder', [0.09, 0.11, 2.2, 5], 'bark', { x: 4.9, y: 1.1, z: 1.4 });
                part(p, 'box', [1.5, 0.14, 0.14], 'wood', { x: 4.9, y: 1.7, z: 1.4 });
                part(p, 'sphere', [1, 8, 6], 'thatch', { x: 4.9, y: 2.4, z: 1.4, sx: 0.28, sy: 0.3, sz: 0.28 });
            } else {
                // Iron: the stone garrison — masonry hall under fired tile, a
                // gold-rimmed shield with crossed swords over the gate, spears
                // racked by the door.
                part(p, 'box', [8, 3.2, 6], 'masonry', { y: 1.6 });
                part(p, 'box', [2.4, 2.3, 0.3], 'wood', { y: 1.15, z: 3.05 });
                part(p, 'prism', [8.8, 6.8, 2.4], 'rooftile', { y: 3.2 });
                part(p, 'cylinder', [0.55, 0.55, 0.1, 10], 'gold', { y: 2.72, z: 3.08, rx: Math.PI / 2 });
                part(p, 'box', [0.09, 1.3, 0.09], 'iron', { y: 2.72, z: 3.16, rz: 0.6 });
                part(p, 'box', [0.09, 1.3, 0.09], 'iron', { y: 2.72, z: 3.16, rz: -0.6 });
                part(p, 'cylinder', [0.05, 0.05, 2.4, 4], 'bark', { x: -3.2, y: 1.2, z: 3.3, rz: 0.3 });
                part(p, 'cylinder', [0.05, 0.05, 2.4, 4], 'bark', { x: -3.5, y: 1.2, z: 3.3, rz: -0.25 });
            }
            return p;
        },
        stable: (o = {}) => {
            const p = [];
            const age = ageOf(o);
            shadow(p, 6.2);
            const corral = (z = 3.6) => { // shared hitching rail
                [-2.2, 0, 2.2].forEach(x =>
                    part(p, 'cylinder', [0.09, 0.11, 1.1, 5], 'bark', { x, y: 0.55, z }));
                part(p, 'box', [4.8, 0.16, 0.16], 'wood', { y: 0.95, z });
            };
            if (age === 'stone') {
                // Hitching camp: a hide lean-to, the rail, and a water trough.
                part(p, 'prism', [6.0, 4.6, 2.4], 'leather', { y: 0, x: -0.6 });
                part(p, 'box', [6.4, 0.16, 0.16], 'bark', { x: -0.6, y: 2.42 });
                corral();
                part(p, 'box', [1.5, 0.4, 0.7], 'bark', { x: 2.9, y: 0.2, z: 2.2 });
            } else if (age === 'neolithic') {
                // Log stable under thatch, corral out front.
                part(p, 'box', [6.6, 2.2, 4.6], 'wood', { y: 1.1 });
                part(p, 'box', [6.76, 0.2, 4.76], 'bark', { y: 0.85 });
                part(p, 'prism', [7.4, 5.4, 1.8], 'thatch', { y: 2.2 });
                corral();
            } else if (age === 'bronze') {
                // Timber stable with hay and trough (the classic look).
                part(p, 'box', [7, 2.6, 5], 'wood', { y: 1.3 });
                part(p, 'prism', [7.8, 5.8, 1.9], 'thatch', { y: 2.6 });
                corral();
                part(p, 'cylinder', [0.5, 0.5, 0.9, 8], 'thatch', { x: 4.3, y: 0.5, z: 1.6, rx: Math.PI / 2 }); // hay bale
                part(p, 'box', [1.5, 0.4, 0.7], 'bark', { x: 4.4, y: 0.2, z: -0.6 });
            } else {
                // Iron: masonry stable under fired tile, full yard.
                part(p, 'box', [7, 2.6, 5], 'masonry', { y: 1.3 });
                part(p, 'box', [1.9, 1.9, 0.28], 'wood', { y: 0.95, z: 2.55 });
                part(p, 'prism', [7.8, 5.8, 2.0], 'rooftile', { y: 2.6 });
                corral();
                part(p, 'cylinder', [0.5, 0.5, 0.9, 8], 'thatch', { x: 4.3, y: 0.5, z: 1.6, rx: Math.PI / 2 });
                part(p, 'box', [1.5, 0.4, 0.7], 'bark', { x: 4.4, y: 0.2, z: -0.6 });
            }
            return p;
        },
        archery_range: (o = {}) => {
            const p = [];
            const age = ageOf(o);
            shadow(p, 5.8);
            const target = (x = 4.4) => { // ringed target on a post — the range's signature
                part(p, 'cylinder', [0.1, 0.12, 2.2, 5], 'bark', { x, y: 1.1 });
                part(p, 'cylinder', [0.75, 0.75, 0.1, 12], 'plaster', { x, y: 2.5, z: 0.06, rx: Math.PI / 2 });
                part(p, 'cylinder', [0.48, 0.48, 0.1, 12], 'awning', { x, y: 2.5, z: 0.12, rx: Math.PI / 2 });
                part(p, 'cylinder', [0.2, 0.2, 0.1, 10], 'gold', { x, y: 2.5, z: 0.18, rx: Math.PI / 2 });
            };
            if (age === 'stone') {
                // Practice ground: a hide shelter and the target — no hall yet.
                part(p, 'prism', [5.2, 4.2, 2.2], 'leather', { y: 0, x: -1.2 });
                part(p, 'box', [5.6, 0.15, 0.15], 'bark', { x: -1.2, y: 2.22 });
                target(3.8);
                part(p, 'cylinder', [0.05, 0.05, 2.4, 4], 'bark', { x: -3.9, y: 1.2, z: 2.2, rz: 0.3 }); // leaning bow staves
                part(p, 'cylinder', [0.05, 0.05, 2.4, 4], 'bark', { x: -4.1, y: 1.2, z: 2.0, rz: -0.25 });
            } else if (age === 'neolithic') {
                // Log cabin range under thatch.
                part(p, 'box', [5.6, 2.2, 4.6], 'wood', { y: 1.1 });
                part(p, 'box', [5.76, 0.2, 4.76], 'bark', { y: 0.85 });
                part(p, 'pyramid', [6.6, 5.6, 2.0], 'thatch', { y: 2.2 });
                target();
            } else if (age === 'bronze') {
                // Timber range hall.
                part(p, 'box', [6, 2.4, 5], 'wood', { y: 1.2 });
                part(p, 'pyramid', [7, 6, 2.2], 'thatch', { y: 2.4 });
                target();
            } else {
                // Iron: masonry hall under fired tile.
                part(p, 'box', [6, 2.4, 5], 'masonry', { y: 1.2 });
                part(p, 'box', [1.7, 1.8, 0.28], 'wood', { y: 0.9, z: 2.55 });
                part(p, 'pyramid', [7, 6, 2.2], 'rooftile', { y: 2.4 });
                target();
            }
            return p;
        },
        market: (o = {}) => {
            const p = [];
            const age = ageOf(o);
            shadow(p, 6.6);
            if (age === 'stone' || age === 'neolithic') {
                // Trading post: rough posts under a hide canopy, goods on a mat.
                part(p, 'box', [5.8, 0.14, 5], 'thatch', { y: 0.07 }); // woven ground mat
                [[-2.6, -2.2], [2.6, -2.2], [-2.6, 2.2], [2.6, 2.2]].forEach(([x, z]) =>
                    part(p, 'cylinder', [0.1, 0.13, 2.6, 5], 'bark', { x, y: 1.3, z }));
                part(p, 'box', [6.4, 0.16, 5.6], 'leather', { y: 2.72, rx: 0.09 }); // hide canopy
                part(p, 'sphere', [1, 8, 6], 'leather', { x: -1.4, y: 0.5, z: 0.6, sx: 0.55, sy: 0.5, sz: 0.55 });  // sacks
                part(p, 'sphere', [1, 8, 6], 'leather', { x: -0.5, y: 0.4, z: 1.3, sx: 0.45, sy: 0.4, sz: 0.45 });
                part(p, 'cylinder', [0.3, 0.4, 0.7, 8], 'leather', { x: 1.5, y: 0.35, z: 0.9 }); // clay pot
            } else if (age === 'bronze') {
                // Timber stall under the striped awning — the classic signature.
                part(p, 'box', [5.4, 2.0, 5.4], 'wood', { y: 1.0 });
                [[3.7, 3.7], [-3.7, 3.7], [3.7, -3.7], [-3.7, -3.7]].forEach(([x, z]) =>
                    part(p, 'cylinder', [0.1, 0.1, 2.7, 5], 'wood', { x, y: 1.35, z }));
                part(p, 'pyramid', [8.6, 8.6, 1.7], 'awning', { y: 2.7 });
                part(p, 'box', [0.8, 0.8, 0.8], 'wood', { x: 2.4, y: 0.4, z: 3.1 });        // crate
                part(p, 'cylinder', [0.4, 0.4, 0.9, 8], 'bark', { x: -2.5, y: 0.45, z: 3.1 }); // barrel
            } else {
                // Iron: a stone trading house, striped awnings over the stalls out front.
                part(p, 'box', [5.9, 0.5, 5.7], 'masonry', { y: 0.25 });
                part(p, 'box', [5.4, 2.4, 5.0], 'plaster', { y: 1.7 });
                part(p, 'prism', [6.4, 5.8, 2.0], 'rooftile', { y: 2.9 });
                part(p, 'box', [1.4, 1.8, 0.24], 'wood', { y: 1.15, z: 2.56 }); // door
                part(p, 'box', [2.4, 0.14, 1.5], 'awning', { x: -1.6, y: 2.35, z: 3.2, rx: 0.35 });
                part(p, 'box', [2.4, 0.14, 1.5], 'awning', { x: 1.6, y: 2.35, z: 3.2, rx: 0.35 });
                part(p, 'box', [0.8, 0.8, 0.8], 'wood', { x: 2.6, y: 0.4, z: 3.7 });
                part(p, 'cylinder', [0.4, 0.4, 0.9, 8], 'bark', { x: -2.7, y: 0.45, z: 3.8 });
                doorTrim(p, civOf(o), 3, 2.62, 1.4, 1.9);
            }
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
                const civB = civOf(o);
                if (civB === 'egyptian') part(p, 'box', [2.7, 0.2, 2.7], 'gold', { y: 5.52 });
                if (civB === 'greek') part(p, 'box', [2.7, 0.24, 2.7], 'plaster', { y: 5.52 });
                if (civB === 'persian') part(p, 'box', [2.7, 0.24, 2.7], 'cloth', { y: 5.52, team: true });
                if (civB === 'yamato') part(p, 'pyramid', [4.0, 4.0, 0.6], 'thatch', { y: 5.45 }); // second eave layer
            } else {
                // Iron: solid stone sentinel with a tiled cap.
                part(p, 'frustum', [3.6, 3.6, 2.7, 2.7, 6.5], 'masonry');
                part(p, 'box', [3.4, 0.7, 3.4], 'masonry', { y: 6.85 });
                part(p, 'pyramid', [3.9, 3.9, 1.7], 'rooftile', { y: 7.2 });
                part(p, 'box', [0.5, 1.3, 0.22], 'bark', { y: 4.6, z: 1.62 });
                const civI = civOf(o);
                if (civI === 'egyptian') part(p, 'box', [3.0, 0.22, 3.0], 'gold', { y: 6.62 });
                if (civI === 'greek') part(p, 'box', [3.0, 0.26, 3.0], 'plaster', { y: 6.62 });
                if (civI === 'persian') part(p, 'box', [3.0, 0.26, 3.0], 'cloth', { y: 6.62, team: true });
                if (civI === 'yamato') part(p, 'pyramid', [4.6, 4.6, 0.65], 'rooftile', { y: 6.55 }); // layered eaves
            }
            return p;
        },
        temple: (o = {}) => {
            const p = [];
            const civ = civOf(o);
            shadow(p, 6.8);
            if (civ === 'greek') {
                // Peripteral marble temple: stepped stylobate, a colonnade all
                // around the cella, gabled roof with pediments — the Parthenon
                // silhouette in miniature.
                part(p, 'frustum', [8.6, 7, 8.0, 6.4, 0.9], 'masonry');
                part(p, 'box', [4.6, 2.8, 3.4], 'plaster', { y: 2.35 });
                [-2.7, -0.9, 0.9, 2.7].forEach(x => {
                    part(p, 'cylinder', [0.24, 0.28, 2.9, 8], 'plaster', { x, y: 2.35, z: 2.5 });
                    part(p, 'cylinder', [0.24, 0.28, 2.9, 8], 'plaster', { x, y: 2.35, z: -2.5 });
                });
                [-0.9, 0.9].forEach(z => {
                    part(p, 'cylinder', [0.24, 0.28, 2.9, 8], 'plaster', { x: -2.7, y: 2.35, z });
                    part(p, 'cylinder', [0.24, 0.28, 2.9, 8], 'plaster', { x: 2.7, y: 2.35, z });
                });
                part(p, 'prism', [8.8, 7.2, 1.9], 'plaster', { y: 3.95 });
            } else if (civ === 'egyptian') {
                // Pylon temple: battered hall, gold cornice, twin pylons over the
                // gate, flag masts flying the player color.
                part(p, 'frustum', [8.4, 6.6, 7.6, 6.0, 2.6], 'masonry', { z: -0.6 });
                part(p, 'box', [5.2, 1.4, 4.2], 'plaster', { y: 3.2, z: -0.6 });
                part(p, 'box', [5.6, 0.24, 0.34], 'gold', { y: 2.75, z: 2.72 });
                part(p, 'frustum', [2.2, 1.3, 1.6, 1.0, 4.2], 'masonry', { x: -2.0, z: 2.9 });
                part(p, 'frustum', [2.2, 1.3, 1.6, 1.0, 4.2], 'masonry', { x: 2.0, z: 2.9 });
                part(p, 'box', [2.4, 0.4, 0.7], 'gold', { y: 4.4, z: 2.9 });
                part(p, 'box', [1.3, 2.2, 0.3], 'bark', { y: 1.2, z: 3.32 });
                [[-3.5, 3.4], [3.5, 3.4]].forEach(([x, z]) => {
                    part(p, 'cylinder', [0.06, 0.07, 5.2, 4], 'bark', { x, y: 2.6, z });
                    part(p, 'box', [0.34, 0.95, 0.05], 'cloth', { x: x + 0.2, y: 4.6, z, team: true });
                });
            } else if (civ === 'yamato') {
                // Shrine: a raised honden on posts under a steep thatch roof with
                // chigi finials and katsuogi ridge billets, torii before it.
                [[-1.8, -1.2], [1.8, -1.2], [-1.8, 1.2], [1.8, 1.2]].forEach(([x, z]) =>
                    part(p, 'cylinder', [0.14, 0.16, 1.4, 6], 'bark', { x, y: 0.7, z }));
                part(p, 'box', [4.6, 0.3, 3.4], 'wood', { y: 1.5 });
                part(p, 'box', [3.8, 1.9, 2.6], 'wood', { y: 2.75 });
                part(p, 'prism', [6.2, 4.6, 2.0], 'thatch', { y: 3.7 });
                [-2.9, 2.9].forEach(x => {
                    part(p, 'box', [0.1, 1.0, 0.1], 'bark', { x, y: 5.85, rz: 0.45 });
                    part(p, 'box', [0.1, 1.0, 0.1], 'bark', { x, y: 5.85, rz: -0.45 });
                });
                [-1.1, 0, 1.1].forEach(x =>
                    part(p, 'box', [0.22, 0.22, 1.0], 'bark', { x, y: 5.78 }));
                part(p, 'box', [1.4, 0.7, 0.9], 'wood', { y: 0.35, z: 2.0 }); // steps
                doorTrim(p, 'yamato', 3, 3.4, 2.0, 2.6);
            } else if (civ === 'persian') {
                // Fire temple (chahar taqi): four pillars carrying a team-glazed
                // dome over the open sanctuary, the sacred flame burning within.
                part(p, 'frustum', [7.4, 7.4, 6.8, 6.8, 0.8], 'masonry');
                [[-2.4, -2.4], [2.4, -2.4], [-2.4, 2.4], [2.4, 2.4]].forEach(([x, z]) =>
                    part(p, 'box', [1.3, 3.2, 1.3], 'masonry', { x, y: 2.4, z }));
                part(p, 'box', [6.2, 0.8, 6.2], 'masonry', { y: 4.4 });
                part(p, 'box', [6.3, 0.28, 0.24], 'cloth', { y: 4.4, z: 3.14, team: true });
                part(p, 'cylinder', [2.2, 2.5, 1.0, 9], 'cloth', { y: 5.3, team: true });
                part(p, 'cylinder', [0, 2.2, 2.0, 9], 'cloth', { y: 6.8, team: true });
                part(p, 'sphere', [1, 8, 6], 'gold', { y: 8.0, sx: 0.24, sy: 0.24, sz: 0.24 });
                part(p, 'cylinder', [0.5, 0.7, 0.9, 8], 'masonry', { y: 1.25 });
                part(p, 'cylinder', [0, 0.42, 0.9, 7], 'gold', { y: 2.15 }); // the flame
            } else {
                // Generic sanctuary (no civ — engine-test).
                part(p, 'frustum', [8, 7, 7.4, 6.4, 0.8], 'masonry');
                part(p, 'box', [5.6, 3.0, 4.6], 'plaster', { y: 2.3 });
                [-2.4, -0.8, 0.8, 2.4].forEach(x =>
                    part(p, 'cylinder', [0.26, 0.3, 3.0, 8], 'plaster', { x, y: 2.3, z: 2.85 }));
                part(p, 'prism', [8, 6.6, 2.2], 'rooftile', { y: 3.8 });
            }
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
