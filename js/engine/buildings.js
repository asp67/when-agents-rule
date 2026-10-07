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
        arr.push({ kind, args, tex, m, blend: !!t.blend, team: !!t.team, tint: t.tint || null, visualOnly: !!t.visualOnly, key: kind + ':' + args.join(',') });
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
        } else if (civ === 'roman') {
            // Pilasters carrying a round arch over a round-topped doorway (b1061, rebuilt
            // b1062). The arch is a ring of stones, not a disc: b1061 set a solid white
            // disc on the lintel, which covered the door and stuck up into the roof.
            const r = doorW / 2 + 0.12, px = r + 0.06;
            part(p, 'box', [0.3, doorH, 0.28], 'plaster', { x: x - px, y: doorH / 2, z });
            part(p, 'box', [0.3, doorH, 0.28], 'plaster', { x: x + px, y: doorH / 2, z });
            part(p, 'cylinder', [doorW / 2, doorW / 2, 0.1, 12], 'bark', { x, y: doorH, z: z - 0.06, rx: Math.PI / 2 });   // the round top of the opening
            for (let i = 0; i <= 6; i++) {   // the voussoirs, keystone in the middle
                const a = (i / 6) * Math.PI;
                part(p, 'box', [0.24, i === 3 ? 0.3 : 0.24, 0.3], 'plaster',
                    { x: x + Math.cos(a) * r, y: doorH + Math.sin(a) * r, z, rz: a - Math.PI / 2 });
            }
        } else if (civ === 'viking') {
            // Carved door posts that cross above the lintel (b1061).
            const px = doorW / 2 + 0.25;
            part(p, 'box', [0.22, doorH + 0.9, 0.22], 'wood', { x: x - px, y: (doorH + 0.9) / 2, z, rz: -0.12 });
            part(p, 'box', [0.22, doorH + 0.9, 0.22], 'wood', { x: x + px, y: (doorH + 0.9) / 2, z, rz: 0.12 });
            part(p, 'box', [doorW + 0.8, 0.26, 0.26], 'cloth', { x, y: doorH + 0.15, z, team: true });
        } else if (civ === 'maya') {
            // A stepped corbel lintel (b1061).
            part(p, 'box', [doorW + 1.2, 0.3, 0.32], 'masonry', { x, y: doorH + 0.15, z });
            part(p, 'box', [doorW + 0.6, 0.3, 0.32], 'cloth', { x, y: doorH + 0.45, z, team: true });
        }
    };

    // The three civilizations added in b1058-b1060, in their own shapes (b1061): a
    // palette alone left their Town Centers, houses and academies plain copies of the
    // generic ones. Bronze and Iron only -- the stone and neolithic huts are shared
    // by every culture, as for the four originals.
    const OWN_TOWN_CENTER = {
        roman: (p, age) => {
            if (age === 'bronze') {
                // Domus with an atrium: a walled square, tiled roofs on all four sides
                // around an open centre, a columned entrance and the owner's banner.
                part(p, 'frustum', [10.4, 10.4, 9.8, 9.8, 0.6], 'masonry');
                for (const [x, z, w, d] of [[0, 3.6, 8.6, 1.6], [0, -3.6, 8.6, 1.6], [3.6, 0, 1.6, 5.6], [-3.6, 0, 1.6, 5.6]]) {
                    part(p, 'box', [w, 2.8, d], 'plaster', { x, y: 2.0, z });
                    part(p, 'prism', w < d ? [d + 0.4, w + 0.6, 0.9] : [w + 0.4, d + 0.6, 0.9], 'rooftile', { x, y: 3.4, z, ry: w < d ? Math.PI / 2 : 0 });   // ridge along the wing
                }
                part(p, 'box', [2.6, 0.12, 2.6], 'cloth', { y: 0.65, team: true });            // the impluvium's pool
                [-1.3, 1.3].forEach(x => part(p, 'cylinder', [0.2, 0.24, 3.0, 8], 'plaster', { x, y: 2.1, z: 4.75 }));
                part(p, 'box', [3.4, 0.4, 0.9], 'plaster', { y: 3.75, z: 4.6 });
                part(p, 'box', [1.5, 2.2, 0.3], 'bark', { y: 1.7, z: 4.42 });
            } else {
                // Castrum: square walls with gate towers, and the dome of the principia.
                part(p, 'frustum', [11.4, 11.4, 10.8, 10.8, 0.7], 'masonry');
                for (const [x, z, w, d] of [[0, -4.9, 10.0, 0.8], [-4.9, 0, 0.8, 10.0], [4.9, 0, 0.8, 10.0], [-3.2, 4.9, 3.6, 0.8], [3.2, 4.9, 3.6, 0.8]])
                    part(p, 'box', [w, 3.0, d], 'plaster', { x, y: 2.2, z });
                for (const x of [-1.9, 1.9]) {   // the gate towers, crenellated
                    part(p, 'box', [1.6, 4.6, 1.6], 'masonry', { x, y: 3.0, z: 4.9 });
                    [-0.5, 0.5].forEach(dx => part(p, 'box', [0.4, 0.5, 1.6], 'masonry', { x: x + dx, y: 5.55, z: 4.9 }));
                }
                part(p, 'box', [2.4, 0.5, 0.8], 'plaster', { y: 4.5, z: 4.9 });           // the arch over the gate
                part(p, 'cylinder', [2.5, 2.6, 3.0, 16], 'plaster', { y: 2.2, z: -0.8 }); // the drum
                part(p, 'dome', [1, 16], 'rooftile', { y: 3.7, z: -0.8, sx: 2.55, sy: 2.0, sz: 2.55 });
                part(p, 'cylinder', [0.5, 0.5, 0.3, 10], 'gold', { y: 5.7, z: -0.8 });   // the oculus' ring
                part(p, 'cylinder', [0.07, 0.07, 3.0, 5], 'wood', { x: -4.9, y: 5.0, z: -4.9 });
                part(p, 'box', [1.1, 0.8, 0.06], 'cloth', { x: -4.4, y: 5.9, z: -4.9, team: true });   // the vexillum
                part(p, 'box', [1.5, 2.6, 0.3], 'bark', { y: 1.6, z: 5.32 });
            }
        },
        viking: (p, age) => {
            if (age === 'bronze') {
                // The chieftain's longhouse: bowed walls, a turf roof, crossed gables
                // and a shield by the door.
                part(p, 'frustum', [11.2, 7.4, 10.6, 6.8, 0.5], 'rock');
                part(p, 'box', [9.4, 2.6, 5.0], 'wood', { y: 1.8 });
                for (const side of [-1, 1]) part(p, 'box', [7.6, 2.2, 0.45], 'bark', { y: 1.6, z: side * 2.62 });
                part(p, 'prism', [10.6, 6.4, 3.0], 'thatch', { y: 3.1, tint: [.70, .86, .60] });
                for (const x of [-5.3, 5.3]) {
                    part(p, 'box', [0.2, 2.2, 0.2], 'wood', { x, y: 5.6, z: 0.5, rx: 0.5 });
                    part(p, 'box', [0.2, 2.2, 0.2], 'wood', { x, y: 5.6, z: -0.5, rx: -0.5 });
                }
                part(p, 'box', [1.5, 2.0, 0.3], 'bark', { y: 1.5, z: 2.86 });
                part(p, 'cylinder', [0.55, 0.55, 0.12, 12], 'cloth', { x: 1.6, y: 1.5, z: 2.95, rx: Math.PI / 2, team: true });
            } else {
                // A ring fort: a round rampart and palisade around the great hall.
                part(p, 'cylinder', [5.4, 5.9, 1.0, 20], 'rock', { y: 0.5 });
                for (let i = 0; i < 28; i++) {
                    const a = (i + 0.5) / 28 * Math.PI * 2;
                    if (Math.abs(Math.sin(a)) < 0.16 && Math.cos(a) > 0) continue;   // the gate gap, facing +Z
                    part(p, 'cylinder', [0.24, 0.28, 2.6, 6], 'bark', { x: Math.sin(a) * 5.2, y: 2.0, z: Math.cos(a) * 5.2 });
                }
                part(p, 'box', [7.0, 2.4, 3.6], 'wood', { y: 2.2 });
                part(p, 'prism', [8.0, 4.8, 2.6], 'thatch', { y: 3.4, tint: [.70, .86, .60] });
                for (const x of [-3.9, 3.9]) {
                    part(p, 'box', [0.2, 2.0, 0.2], 'wood', { x, y: 5.7, z: 0.45, rx: 0.5 });
                    part(p, 'box', [0.2, 2.0, 0.2], 'wood', { x, y: 5.7, z: -0.45, rx: -0.5 });
                }
                for (const x of [-1.0, 1.0]) part(p, 'box', [0.5, 4.2, 0.5], 'wood', { x, y: 2.6, z: 5.3 });   // the gate posts
                part(p, 'box', [2.6, 0.5, 0.6], 'cloth', { y: 4.5, z: 5.3, team: true });
                part(p, 'box', [1.3, 1.8, 0.3], 'bark', { y: 1.4, z: 1.85 });
            }
        },
        maya: (p, age) => {
            if (age === 'bronze') {
                // A stepped platform with the council house on top, a stair up the front.
                [[10.4, 0], [8.6, 0.9], [6.8, 1.8]].forEach(([w, y]) =>
                    part(p, 'frustum', [w, w, w - 0.6, w - 0.6, 0.9], 'masonry', { y }));
                part(p, 'box', [2.2, 0.3, 3.8], 'plaster', { y: 1.35, z: 4.2, rx: 0.62 });
                part(p, 'box', [5.0, 2.0, 3.6], 'plaster', { y: 3.7 });
                part(p, 'pyramid', [6.4, 5.0, 2.6], 'thatch', { y: 4.7 });
                part(p, 'box', [1.2, 1.5, 0.3], 'bark', { y: 3.45, z: 1.82 });
                part(p, 'box', [5.2, 0.3, 0.3], 'cloth', { y: 4.55, z: 1.85, team: true });
            } else {
                // The palace: a tall platform, a long range of rooms under a corbel
                // vault, and a pierced roof comb.
                [[11.0, 0], [9.6, 1.0], [8.2, 2.0], [6.8, 3.0]].forEach(([w, y]) =>
                    part(p, 'frustum', [w, w * 0.8, w - 0.6, w * 0.8 - 0.6, 1.0], 'masonry', { y }));
                part(p, 'box', [2.6, 0.3, 5.0], 'plaster', { y: 2.0, z: 3.9, rx: 0.68 });
                part(p, 'box', [6.0, 2.2, 3.4], 'plaster', { y: 5.1 });
                part(p, 'frustum', [6.4, 3.8, 5.0, 1.6, 1.4], 'masonry', { y: 6.2 });    // the corbel vault
                part(p, 'box', [4.4, 1.8, 0.4], 'cloth', { y: 8.5, team: true });         // the roof comb
                [-1.2, 0, 1.2].forEach(x => part(p, 'box', [0.45, 0.8, 0.5], 'bark', { x, y: 8.5 }));
                [-1.8, 0, 1.8].forEach(x => part(p, 'box', [0.9, 1.4, 0.3], 'bark', { x, y: 4.7, z: 1.62 }));
            }
        }
    };
    const OWN_HOUSE = {
        // The four originals (b1069): their houses were the shared timber hut and plaster
        // box, told apart only by palette and door trim.
        greek: (p, age, tier) => {
            if (age === 'bronze') {
                // Stone footing, whitewashed walls, a low tiled gable, a columned porch.
                part(p, 'box', [4.6, 0.4, 4.2], 'masonry', { y: 0.2 });
                part(p, 'box', [4.2, 2.2, 3.6], 'plaster', { y: 1.5 });
                part(p, 'prism', [4.8, 4.2, 0.9], 'rooftile', { y: 2.6 });
                part(p, 'box', [1.0, 1.5, 0.2], 'bark', { y: 1.15, z: 1.85 });
                doorTrim(p, 'greek', tier, 2.0, 1.0, 1.9);
                part(p, 'cylinder', [0.12, 0.2, 0.55, 8], 'masonry', { x: 1.6, y: 0.68, z: 2.2 });   // an amphora
            } else {
                // A Cycladic house: a white cube with a flat roof, a smaller cube on top
                // reached by an outside stair, door and shutters in the owner's colour.
                part(p, 'box', [4.4, 2.6, 4.0], 'plaster', { y: 1.3 });
                part(p, 'box', [4.55, 0.16, 4.15], 'plaster', { y: 2.66 });
                part(p, 'box', [2.3, 1.5, 2.1], 'plaster', { x: -0.9, y: 3.4, z: -0.8 });
                part(p, 'box', [2.45, 0.14, 2.25], 'plaster', { x: -0.9, y: 4.2, z: -0.8 });
                part(p, 'box', [1.0, 1.7, 0.12], 'cloth', { y: 0.85, z: 2.02, team: true });
                [-1.5, 1.5].forEach(x => part(p, 'box', [0.6, 0.6, 0.1], 'cloth', { x, y: 1.75, z: 2.02, team: true }));
                part(p, 'box', [0.5, 0.5, 0.1], 'cloth', { x: -0.9, y: 3.5, z: 0.27, team: true });
                for (let i = 0; i < 4; i++) part(p, 'box', [0.7, 0.32, 0.5], 'plaster', { x: 2.55, y: 0.3 + i * 0.62, z: -1.2 + i * 0.5 });
            }
        },
        egyptian: (p, age, tier) => {
            if (age === 'bronze') {
                // Battered mudbrick under a flat roof, a reed sun shelter on top.
                part(p, 'frustum', [4.6, 4.2, 4.1, 3.7, 2.4], 'masonry');
                [[-1.0, -0.8], [1.0, -0.8], [-1.0, 0.8], [1.0, 0.8]].forEach(([x, z]) =>
                    part(p, 'cylinder', [0.05, 0.05, 1.0, 4], 'bark', { x, y: 2.9, z }));
                part(p, 'box', [2.4, 0.1, 2.0], 'thatch', { y: 3.4 });
                [-1.2, 1.2].forEach(x => part(p, 'box', [0.4, 0.25, 0.1], 'bark', { x, y: 1.9, z: 1.95 }));
                part(p, 'box', [1.0, 1.5, 0.2], 'bark', { y: 0.75, z: 1.98 });
                doorTrim(p, 'egyptian', tier, 2.05, 1.0, 1.5);
            } else {
                // Two storeys of battered mudbrick, a parapet on the roof terrace and a
                // date palm beside the door.
                part(p, 'frustum', [4.8, 4.4, 4.3, 3.9, 2.8], 'masonry');
                part(p, 'frustum', [2.8, 2.4, 2.5, 2.1, 1.4], 'masonry', { x: -0.8, y: 2.8, z: -0.8 });
                for (const [x, z, w, d] of [[0, 1.9, 4.3, 0.15], [2.1, 0, 0.15, 3.9]]) part(p, 'box', [w, 0.4, d], 'masonry', { x, y: 3.0, z });
                part(p, 'box', [4.4, 0.2, 0.3], 'gold', { y: 2.7, z: 2.0 });
                part(p, 'box', [1.0, 1.6, 0.2], 'bark', { y: 0.8, z: 2.08 });
                doorTrim(p, 'egyptian', tier, 2.15, 1.0, 1.6);
                part(p, 'cylinder', [0.09, 0.14, 3.8, 6], 'bark', { x: 2.7, y: 1.9, z: 1.9, rz: -0.08 });
                for (let i = 0; i < 6; i++) {
                    const a = i / 6 * Math.PI * 2;
                    part(p, 'box', [1.3, 0.05, 0.3], 'foliage', { x: 2.85 + Math.cos(a) * 0.6, y: 3.75, z: 1.9 + Math.sin(a) * 0.6, ry: -a, rz: -0.35 });
                }
            }
        },
        persian: (p, age, tier) => {
            if (age === 'bronze') {
                // A mudbrick cube under a dome, a glazed band at the roofline.
                part(p, 'box', [4.2, 2.4, 4.0], 'masonry', { y: 1.2 });
                part(p, 'box', [4.3, 0.25, 4.1], 'cloth', { y: 2.3, team: true });
                part(p, 'dome', [1, 12], 'plaster', { y: 2.4, sx: 1.7, sy: 1.25, sz: 1.7 });
                part(p, 'box', [1.0, 1.5, 0.2], 'bark', { y: 0.75, z: 1.98 });
                doorTrim(p, 'persian', tier, 2.05, 1.0, 1.5);
            } else {
                // A badgir: the windcatcher tower over the house, and a glazed dome.
                part(p, 'box', [4.4, 2.8, 4.2], 'masonry', { y: 1.4 });
                part(p, 'box', [1.1, 2.4, 1.1], 'masonry', { x: 1.45, y: 4.0, z: -1.35 });
                for (const [x, z] of [[1.45, -0.78], [1.45, -1.92], [0.88, -1.35], [2.02, -1.35]])
                    part(p, 'box', [x === 1.45 ? 0.5 : 0.1, 0.8, x === 1.45 ? 0.1 : 0.5], 'bark', { x, y: 4.6, z });
                part(p, 'box', [1.3, 0.2, 1.3], 'masonry', { x: 1.45, y: 5.3, z: -1.35 });
                part(p, 'dome', [1, 12], 'cloth', { x: -0.6, y: 2.8, z: 0.3, sx: 1.5, sy: 1.3, sz: 1.5, team: true });
                part(p, 'box', [1.0, 1.6, 0.2], 'bark', { y: 0.8, z: 2.08 });
                doorTrim(p, 'persian', tier, 2.15, 1.0, 1.6);
            }
        },
        yamato: (p, age, tier) => {
            if (age === 'bronze') {
                // A minka on posts: a veranda along the front, a paper door, a steep
                // thatched hip-and-gable roof with the crossed finials.
                [[-1.9, -1.6], [1.9, -1.6], [-1.9, 1.6], [1.9, 1.6]].forEach(([x, z]) =>
                    part(p, 'cylinder', [0.1, 0.12, 0.7, 6], 'bark', { x, y: 0.35, z }));
                part(p, 'box', [4.4, 0.2, 3.8], 'wood', { y: 0.75 });
                part(p, 'box', [3.8, 1.6, 3.2], 'wood', { y: 1.65 });
                part(p, 'box', [4.4, 0.12, 0.8], 'wood', { y: 0.8, z: 2.2 });             // the engawa
                part(p, 'box', [1.3, 1.3, 0.08], 'plaster', { y: 1.55, z: 1.62 });       // the shoji door
                part(p, 'box', [0.06, 1.3, 0.1], 'bark', { y: 1.55, z: 1.65 });
                part(p, 'pyramid', [5.2, 4.6, 1.1], 'thatch', { y: 2.4 });
                part(p, 'prism', [3.4, 3.0, 1.5], 'thatch', { y: 3.2 });
                [-1.75, 1.75].forEach(x => {
                    part(p, 'box', [0.1, 0.8, 0.1], 'bark', { x, y: 4.75, rz: 0.45 });
                    part(p, 'box', [0.1, 0.8, 0.1], 'bark', { x, y: 4.75, rz: -0.45 });
                });
            } else {
                // A machiya: dark timber, a row of paper screens, two tiled roofs, the
                // noren curtain over the door in the owner's colour.
                part(p, 'box', [4.4, 0.3, 4.0], 'masonry', { y: 0.15 });
                part(p, 'box', [4.2, 2.2, 3.8], 'bark', { y: 1.4 });
                [-1.35, 0, 1.35].forEach(x => {
                    part(p, 'box', [1.0, 1.4, 0.08], 'plaster', { x, y: 1.2, z: 1.92 });
                    part(p, 'box', [0.05, 1.4, 0.1], 'wood', { x, y: 1.2, z: 1.95 });
                });
                part(p, 'box', [1.1, 0.45, 0.05], 'cloth', { y: 1.75, z: 2.0, team: true });
                part(p, 'pyramid', [5.0, 4.6, 0.8], 'rooftile', { y: 2.5 });
                part(p, 'box', [3.0, 1.0, 2.6], 'bark', { y: 3.4 });
                part(p, 'pyramid', [3.8, 3.4, 1.0], 'rooftile', { y: 3.9 });
            }
        },
        roman: (p, age, tier) => {
            if (age === 'bronze') {
                part(p, 'box', [4.2, 2.3, 3.8], 'plaster', { y: 1.15 });
                part(p, 'pyramid', [4.9, 4.5, 1.1], 'rooftile', { y: 2.3 });
            } else {
                // An insula: two storeys, a balcony, a low hipped tile roof.
                part(p, 'box', [4.4, 0.4, 4.2], 'masonry', { y: 0.2 });
                part(p, 'box', [4.2, 4.0, 3.8], 'plaster', { y: 2.4 });
                part(p, 'box', [3.4, 0.16, 0.8], 'wood', { y: 2.5, z: 2.3 });
                [-1.4, 0, 1.4].forEach(x => part(p, 'box', [0.6, 0.8, 0.12], 'bark', { x, y: 3.3, z: 1.96 }));
                part(p, 'pyramid', [4.9, 4.5, 1.0], 'rooftile', { y: 4.4 });
            }
            part(p, 'box', [1.0, 1.5, 0.22], 'bark', { y: 0.75, z: 1.96 });   // ground to 1.5, under the arch
            doorTrim(p, 'roman', tier, 2.05, 1.0, 1.5);
        },
        viking: (p, age, tier) => {
            // A turf house: low timber walls, the roof down to the ground at the back.
            part(p, 'box', [4.6, age === 'bronze' ? 1.6 : 2.0, 3.6], 'wood', { y: age === 'bronze' ? 0.8 : 1.0 });
            part(p, 'prism', [5.2, 4.6, age === 'bronze' ? 1.9 : 2.3], 'thatch', { y: age === 'bronze' ? 1.6 : 2.0, tint: [.70, .86, .60] });
            if (age !== 'bronze') for (const x of [-2.6, 2.6]) {
                part(p, 'box', [0.12, 1.3, 0.12], 'wood', { x, y: 4.4, z: 0.3, rx: 0.5 });
                part(p, 'box', [0.12, 1.3, 0.12], 'wood', { x, y: 4.4, z: -0.3, rx: -0.5 });
            }
            part(p, 'box', [1.0, 1.4, 0.22], 'bark', { y: 0.7, z: 1.86 });
            doorTrim(p, 'viking', tier, 1.95, 1.0, 1.4);
        },
        maya: (p, age, tier) => {
            // The na: rounded stucco walls under a tall, steep palm-thatch roof.
            if (age !== 'bronze') part(p, 'frustum', [5.2, 4.4, 4.8, 4.0, 0.5], 'masonry');
            const y0 = age === 'bronze' ? 0 : 0.5;
            part(p, 'cylinder', [1, 1, 2.0, 14], 'plaster', { y: y0 + 1.0, sx: 2.1, sz: 1.6 });
            part(p, 'pyramid', [4.8, 3.8, 3.4], 'thatch', { y: y0 + 2.0 });
            part(p, 'box', [0.9, 1.4, 0.2], 'bark', { y: y0 + 0.7, z: 1.62 });
            doorTrim(p, 'maya', tier, 1.7, 0.9, 1.4);
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
        // The +Z cone facet slopes inward: fit the entrance to that plane.
        const slope=r*Math.cos(Math.PI/10)/h, tilt=-Math.atan(slope);
        const doorH=h*.34, centerY=doorH/2, centerZ=(h-centerY)*slope+.035;
        part(p,'box',[r*.32,doorH/Math.cos(tilt),.045],'white',
            {y:centerY,z:centerZ,rx:tilt,tint:[.105,.083,.061]});
        // Folded hide edges run down the same sloping surface.
        for(const side of [-1,1])part(p,'box',[r*.055,doorH/Math.cos(tilt),.065],'leather',
            {x:side*r*.185,y:centerY,z:centerZ+.035,rx:tilt,visualOnly:true,tint:[1.28,1.14,.9]});
    };

    // Dome hut: low round wall under a leather/thatch dome with a smoke cap.
    const domeHut = (p, r, wallH, tex) => {
        part(p, 'cylinder', [r * 0.96, r, wallH, 12], 'wood', { y: wallH / 2 });
        part(p, 'sphere', [1, 12, 8], tex, { y: wallH * 0.9, sx: r, sy: r * 0.72, sz: r });
        part(p, 'cylinder', [0, r * 0.18, r * 0.28, 6], 'bark', { y: wallH * 0.9 + r * 0.7 });
        part(p, 'box', [r * 0.5, wallH * 0.85, 0.16], 'bark', { y: wallH * 0.45, z: r * 0.97 });
    };

    // ANCHORING, because it has now cost two rounds of floating geometry: box, cylinder
    // and sphere are CENTRE-anchored — y is the middle — while prism, pyramid and frustum
    // are BASE-anchored, where y is the bottom face. Place a roof at the height you want
    // its ridge and it hovers; place a plinth at half its height and it sinks. A part
    // whose bottom is above ground with nothing beneath it is a bug you will not see in a
    // part count or a height check — only by looking, or by testing for support.
    const builders = {
        town_center: (o = {}) => {
            const p = [];
            const age = ageOf(o);
            const civ = civOf(o);
            const tier = TIER[age] || 0;
            shadow(p, 8.2);
            if ((age === 'bronze' || age === 'iron') && OWN_TOWN_CENTER[civ]) { OWN_TOWN_CENTER[civ](p, age); return p; }
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
                if (civ === 'roman') { // a standard planted by the flap (b1061)
                    part(p, 'cylinder', [0.06, 0.07, 3.0, 5], 'wood', { x: 2.0, y: 1.5, z: 4.6 });
                    part(p, 'box', [0.7, 0.5, 0.06], 'cloth', { x: 2.0, y: 2.7, z: 4.6, team: true });
                    part(p, 'sphere', [1, 8, 6], 'gold', { x: 2.0, y: 3.1, z: 4.6, sx: 0.18, sy: 0.18, sz: 0.18 });
                }
                if (civ === 'viking') { // a round shield leaning by the door (b1061)
                    part(p, 'cylinder', [0.55, 0.55, 0.1, 12], 'cloth', { x: 1.9, y: 0.55, z: 4.5, rx: 1.3, team: true });
                }
                if (civ === 'maya') { // a carved stela (b1061)
                    part(p, 'box', [0.7, 1.8, 0.3], 'masonry', { x: -2.0, y: 0.9, z: 4.7 });
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
                if (civ === 'roman') { // two pillars and a lintel at the door (b1061)
                    [-1.0, 1.0].forEach(x => part(p, 'box', [0.3, 2.0, 0.3], 'plaster', { x, y: 1.0, z: 4.85 }));
                    part(p, 'box', [2.6, 0.3, 0.4], 'cloth', { y: 2.1, z: 4.85, team: true });
                }
                if (civ === 'viking') { // crossed gable boards on the smoke cap (b1061)
                    part(p, 'box', [0.14, 1.4, 0.14], 'wood', { y: 5.6, rz: 0.5 });
                    part(p, 'box', [0.14, 1.4, 0.14], 'wood', { y: 5.6, rz: -0.5 });
                }
                if (civ === 'maya') { // a low stucco platform under the hut (b1061)
                    part(p, 'cylinder', [5.4, 5.6, 0.35, 14], 'masonry', { y: 0.17 });
                }
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
            if ((age === 'bronze' || age === 'iron') && OWN_HOUSE[civ]) { OWN_HOUSE[civ](p, age, tier); return p; }
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
                [[-2.4, 3.6], [-1.2, 3.8], [1.2, 3.8], [2.4, 3.6]].forEach(([x, z]) =>
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
            const corral = () => { // hitching rail beside the stable; front approach stays open
                [-2.2, 0, 2.2].forEach(z =>
                    part(p, 'cylinder', [0.09, 0.11, 1.1, 5], 'bark', { x:-4.1, y: 0.55, z }));
                part(p, 'box', [0.16, 0.16, 4.8], 'wood', { x:-4.1, y: 0.95 });
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
            if(age==='neolithic' || age==='bronze') {
                const z=age==='neolithic'?2.35:2.55;
                part(p,'box',[1.9,1.9,.28],'bark',{y:.95,z});
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
            if(age==='neolithic' || age==='bronze') {
                const z=age==='neolithic'?2.35:2.55;
                part(p,'box',[1.7,1.8,.28],'bark',{y:.9,z});
            }
            return p;
        },
        // The academy: where a civilization keeps and grows what it knows. It used to be
        // a market — stalls, awnings, sacks, barrels — because that is what the building
        // was called until v512. Nothing here trades; the progression is from talking to
        // writing to teaching, and the iron form diverges per culture the way the temple
        // does, because a school is the most culturally specific thing a people builds.
        // Tallest point is 5.10 (Yamato iron), measured from real vertices rather than
        // guessed from arguments — H.academy in gamerenderer promises exactly that to the
        // construction shell.
        academy: (o = {}) => {
            const p = [];
            const age = ageOf(o);
            const civ = civOf(o);
            shadow(p, 6.6);
            if (age === 'stone' || age === 'neolithic') {
                // Teaching circle: swept ground, a speaker's slab, seats in a ring, shade
                // over the speaker, and a notched tally post — the first record kept.
                part(p, 'disc', [4.9, 20], 'field_dirt', { y: 0.05 });
                part(p, 'box', [1.9, 0.3, 1.3], 'rock', { y: 0.15 });
                for (let i = 0; i < 6; i++) {
                    const a2 = (i / 6) * Math.PI * 2 + 0.4;
                    part(p, 'sphere', [1, 8, 6], 'rock', { x: Math.cos(a2) * 3.5, y: 0.26,
                        z: Math.sin(a2) * 3.5, sx: 0.56, sy: 0.34, sz: 0.56 });
                }
                part(p, 'cylinder', [0.09, 0.12, 2.5, 5], 'bark', { x: -1.6, y: 1.25, z: -1.0 });
                part(p, 'cylinder', [0.09, 0.12, 2.5, 5], 'bark', { x: 1.6, y: 1.25, z: -1.0 });
                part(p, 'box', [3.8, 0.12, 2.1], 'leather', { y: 2.54, z: -0.5, rx: 0.12 });
                part(p, 'cylinder', [0.13, 0.16, 2.2, 6], 'bark', { x: 3.1, y: 1.1, z: 2.1 });
                [0.8, 1.2, 1.6, 2.0].forEach(y =>
                    part(p, 'box', [0.44, 0.07, 0.07], 'wood', { x: 3.1, y, z: 2.1 }));
                if (age === 'neolithic') {
                    // Clay tablets drying on a rack, once there is something worth keeping.
                    part(p, 'cylinder', [0.07, 0.07, 0.62, 4], 'bark', { x: -3.6, y: 0.31, z: 1.9 });
                    part(p, 'cylinder', [0.07, 0.07, 0.62, 4], 'bark', { x: -2.4, y: 0.31, z: 1.9 });
                    part(p, 'box', [1.6, 0.1, 0.9], 'wood', { x: -3.0, y: 0.63, z: 1.9 });
                    part(p, 'box', [0.52, 0.09, 0.36], 'plaster', { x: -3.3, y: 0.73, z: 1.88 });
                    part(p, 'box', [0.52, 0.09, 0.36], 'plaster', { x: -2.7, y: 0.73, z: 1.94, ry: 0.3 });
                }
            } else if (age === 'bronze') {
                // Scribe's hall: a timber hall on a plinth, a reading porch along the
                // front, desks out in the light, and a gnomon — the first instrument.
                part(p, 'box', [5.8, 0.34, 6.6], 'masonry', { y: 0.17 });   // deep enough to carry the porch
                part(p, 'box', [5.0, 2.2, 4.3], 'wood', { y: 1.44 });
                part(p, 'prism', [5.9, 5.1, 1.7], 'thatch', { y: 2.54 });
                [-2.0, -0.7, 0.7, 2.0].forEach(x =>
                    part(p, 'cylinder', [0.12, 0.14, 2.1, 6], 'bark', { x, y: 1.39, z: 2.85 }));
                part(p, 'box', [4.6, 0.16, 0.9], 'wood', { y: 2.5, z: 2.85 });
                part(p, 'box', [1.3, 1.7, 0.22], 'bark', { y: 1.19, z: 2.18 });
                // Two low desks, a stack of tablets on one of them.
                [-1.5, 1.5].forEach(x => {
                    part(p, 'box', [1.5, 0.12, 0.85], 'wood', { x, y: 0.72, z: 3.9, rx: -0.18 });
                    part(p, 'cylinder', [0.07, 0.07, 0.66, 4], 'bark', { x: x - 0.6, y: 0.33, z: 3.9 });
                    part(p, 'cylinder', [0.07, 0.07, 0.66, 4], 'bark', { x: x + 0.6, y: 0.33, z: 3.9 });
                });
                part(p, 'box', [0.52, 0.16, 0.36], 'plaster', { x: 1.4, y: 0.86, z: 3.85 });
                // Gnomon: a rod on a marked disc, telling the hour by its shadow.
                part(p, 'cylinder', [0.62, 0.62, 0.12, 12], 'plaster', { x: -3.4, y: 0.06, z: 0.4 });
                part(p, 'cylinder', [0.045, 0.055, 1.5, 4], 'bark', { x: -3.4, y: 0.87, z: 0.4, rz: 0.22 });
                doorTrim(p, civ, 2, 2.2, 1.3, 1.7);
            } else {
                // Iron: a real academy. Stone stylobate and hall are shared; the portico
                // above them is where the cultures part company.
                part(p, 'frustum', [8.2, 6.8, 7.6, 6.2, 0.8], 'masonry');
                part(p, 'box', [5.0, 2.6, 4.2], 'plaster', { y: 2.1 });
                part(p, 'box', [1.4, 1.9, 0.26], 'bark', { y: 1.75, z: 2.16 });
                if (civ === 'greek') {
                    // Stoa: a colonnade across the front under a pediment, and the
                    // curved exedra bench where the arguing actually happens.
                    part(p, 'prism', [6.2, 5.0, 1.5], 'plaster', { y: 3.4 });
                    [-2.1, -0.7, 0.7, 2.1].forEach(x =>
                        part(p, 'cylinder', [0.24, 0.28, 2.9, 9], 'plaster', { x, y: 2.25, z: 2.85 }));
                    // Entablature over the columns, not a second pediment above the ridge:
                    // prism is BASE-anchored, so a pediment placed by eye floated over the
                    // roof like a spare gable. The colonnade carries a beam, as it should.
                    part(p, 'box', [6.0, 0.36, 0.62], 'plaster', { y: 3.56, z: 2.85 });
                    part(p, 'box', [6.0, 0.16, 0.3], 'masonry', { y: 3.8, z: 2.9 });
                    for (let i = 0; i < 5; i++) {
                        const a2 = -0.9 + i * 0.45;
                        part(p, 'box', [0.9, 0.34, 0.5], 'masonry',
                            { x: Math.sin(a2) * 3.7, y: 0.17, z: 4.2 + Math.cos(a2) * 0.5, ry: -a2 });
                    }
                } else if (civ === 'egyptian') {
                    // House of Life: battered walls, a gold cornice, papyrus-bundle
                    // columns, and an obelisk cut with the record outside the door.
                    part(p, 'box', [5.6, 0.26, 4.8], 'gold', { y: 3.5 });
                    part(p, 'box', [5.2, 0.9, 4.4], 'masonry', { y: 3.9 });
                    [-2.0, 0, 2.0].forEach(x => {
                        part(p, 'cylinder', [0.3, 0.34, 2.7, 8], 'masonry', { x, y: 2.15, z: 2.9 });
                        part(p, 'frustum', [0.9, 0.9, 0.48, 0.48, 0.5], 'gold', { x, y: 3.5, z: 2.9 });
                    });
                    part(p, 'box', [3.4, 0.3, 1.2], 'masonry', { y: 4.05, z: 2.9 });
                    part(p, 'frustum', [0.72, 0.72, 0.42, 0.42, 3.0], 'masonry', { x: -3.5, y: 0, z: 3.3 });
                    part(p, 'pyramid', [0.46, 0.46, 0.5], 'gold', { x: -3.5, y: 3.0, z: 3.3 });
                } else if (civ === 'persian') {
                    // Talar pavilion: a slender columned porch, a glazed band in the
                    // player's colour and a low dome.
                    part(p, 'box', [5.2, 0.3, 4.4], 'cloth', { y: 3.5, team: true });
                    part(p, 'sphere', [1, 14, 10], 'rooftile', { y: 3.62, sx: 2.5, sy: 1.35, sz: 2.2 });
                    part(p, 'cylinder', [0.16, 0.2, 3.0, 10], 'plaster', { x: -2.2, y: 2.3, z: 3.0 });
                    part(p, 'cylinder', [0.16, 0.2, 3.0, 10], 'plaster', { x: -0.75, y: 2.3, z: 3.0 });
                    part(p, 'cylinder', [0.16, 0.2, 3.0, 10], 'plaster', { x: 0.75, y: 2.3, z: 3.0 });
                    part(p, 'cylinder', [0.16, 0.2, 3.0, 10], 'plaster', { x: 2.2, y: 2.3, z: 3.0 });
                    part(p, 'box', [5.2, 0.3, 0.9], 'cloth', { y: 3.9, z: 3.0, team: true });
                } else if (civ === 'yamato') {
                    // Yamato: post-and-beam under a deep hipped roof, a torii at the path
                    // and a stone lantern — you arrive through a gate, not a door.
                    part(p, 'pyramid', [7.0, 6.0, 1.7], 'rooftile', { y: 3.4 });
                    part(p, 'box', [6.4, 0.2, 5.4], 'wood', { y: 3.34 });
                    [-2.4, 2.4].forEach(x =>
                        part(p, 'cylinder', [0.17, 0.19, 3.0, 6], 'bark', { x, y: 2.3, z: 2.9 }));
                    part(p, 'box', [5.6, 0.2, 0.24], 'bark', { y: 3.7, z: 2.9 });
                    part(p, 'box', [5.0, 0.14, 0.18], 'cloth', { y: 3.3, z: 2.95, team: true });
                    [-1.15, 1.15].forEach(x =>
                        part(p, 'cylinder', [0.1, 0.12, 2.4, 5], 'bark', { x, y: 1.2, z: 4.5 }));
                    part(p, 'box', [3.1, 0.17, 0.22], 'cloth', { y: 2.44, z: 4.5, team: true });
                    part(p, 'box', [2.5, 0.13, 0.17], 'bark', { y: 2.06, z: 4.5 });
                    part(p, 'cylinder', [0.2, 0.26, 0.7, 6], 'rock', { x: 3.3, y: 0.35, z: 3.6 });
                    part(p, 'box', [0.6, 0.5, 0.6], 'plaster', { x: 3.3, y: 0.95, z: 3.6 });
                    part(p, 'pyramid', [0.85, 0.85, 0.4], 'rock', { x: 3.3, y: 1.2, z: 3.6 });
                } else if (civ === 'roman') {
                    // A basilica library (b1061): the hall lengthened under a tiled gable,
                    // arched windows along it, an apse at the back.
                    part(p, 'box', [7.0, 2.6, 4.2], 'plaster', { y: 2.1 });
                    part(p, 'prism', [7.6, 5.0, 1.5], 'rooftile', { y: 3.4 });
                    for (const x of [-2.6, -1.3, 1.3, 2.6]) part(p, 'box', [0.5, 1.2, 0.12], 'bark', { x, y: 2.5, z: 2.12 });
                    part(p, 'cylinder', [1.8, 1.8, 2.6, 12], 'plaster', { y: 2.1, z: -2.1 });
                    part(p, 'dome', [1, 12], 'rooftile', { y: 3.4, z: -2.1, sx: 1.85, sy: 1.0, sz: 1.85 });
                    part(p, 'box', [7.2, 0.3, 0.3], 'cloth', { y: 3.3, z: 2.2, team: true });
                } else if (civ === 'viking') {
                    // The rune-masters' hall (b1061): a steep shingled hall inside a ring
                    // of standing runestones.
                    part(p, 'prism', [5.6, 5.0, 2.8], 'bark', { y: 3.4 });
                    for (const x of [-2.8, 2.8]) {
                        part(p, 'box', [0.16, 1.6, 0.16], 'wood', { x, y: 6.4, z: 0.4, rx: 0.5 });
                        part(p, 'box', [0.16, 1.6, 0.16], 'wood', { x, y: 6.4, z: -0.4, rx: -0.5 });
                    }
                    for (let i = 0; i < 7; i++) {
                        const a = (i / 7) * Math.PI * 2 + 0.2;
                        part(p, 'box', [0.7, 1.6, 0.3], 'rock', { x: Math.sin(a) * 4.6, y: 0.8, z: Math.cos(a) * 3.9, ry: a });
                        part(p, 'box', [0.5, 0.12, 0.32], 'cloth', { x: Math.sin(a) * 4.6, y: 1.1, z: Math.cos(a) * 3.9, ry: a, team: true });
                    }
                } else if (civ === 'maya') {
                    // The observatory (b1061): a round tower on the hall, its dome slit
                    // toward the sky.
                    part(p, 'frustum', [5.4, 4.6, 5.0, 4.2, 0.4], 'masonry', { y: 3.4 });
                    part(p, 'cylinder', [1.7, 1.8, 2.4, 14], 'plaster', { y: 5.0 });
                    part(p, 'dome', [1, 14], 'plaster', { y: 6.2, sx: 1.75, sy: 1.5, sz: 1.75 });
                    part(p, 'box', [0.35, 0.9, 0.2], 'bark', { y: 6.9, z: 1.3, rx: -0.5 });
                    part(p, 'cylinder', [1.85, 1.85, 0.3, 14], 'cloth', { y: 6.25, team: true });
                } else {
                    // Any other culture, until it has a design of its own (b1056): a plain
                    // portico under a gable with a band in the player's colour. Yamato's
                    // academy stood here, so every unknown civilization built a torii.
                    part(p, 'prism', [6.0, 5.0, 1.4], 'rooftile', { y: 3.4 });
                    [-2.0, 2.0].forEach(x =>
                        part(p, 'cylinder', [0.2, 0.22, 2.9, 8], 'plaster', { x, y: 2.25, z: 2.85 }));
                    part(p, 'box', [5.4, 0.3, 0.5], 'cloth', { y: 3.55, z: 2.85, team: true });
                }
                doorTrim(p, civ, 3, 2.2, 1.4, 1.9);
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
                // Scattered plants on furrowed soil (b1006): rice for Yamato, maize for the
                // Maya (b1064), wheat elsewhere.
                const crop = o.civ === 'yamato' ? 'rice' : o.civ === 'maya' ? 'maize' : 'wheat';
                // A rice paddy is wet: darker soil under the green.
                part(p, 'box', [7, 0.22, 7], 'field_furrows', { y: 0.11, tint: crop === 'rice' ? [0.72, 0.74, 0.76] : null });
                part(p, 'crops', ['scatter', crop, 7], 'crop_' + crop, { y: 0.22 });
                [[-3.3, -3.3], [3.3, -3.3], [3.3, 3.3], [-3.3, 3.3]].forEach(([x, z]) =>
                    part(p, 'cylinder', [0.08, 0.1, 0.9, 5], 'bark', { x, y: 0.45, z }));
            } else {
                // Iron: an evenly filled field (rice for Yamato, maize for the Maya, wheat
                // elsewhere) with a full fence, a water barrel and a leaning tool by the gate.
                const crop = o.civ === 'yamato' ? 'rice' : o.civ === 'maya' ? 'maize' : 'wheat';
                part(p, 'box', [7, 0.24, 7], 'field_furrows', { y: 0.12, tint: crop === 'rice' ? [0.72, 0.74, 0.76] : null });
                part(p, 'crops', ['rows', crop, 11], 'crop_' + crop, { y: 0.24 });
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
            } else if (civ === 'roman') {
                // A round temple of Vesta (b1063): a podium with steps, a ring of
                // columns around the round cella, a conical tiled roof, the hearth's
                // gold finial on top.
                part(p, 'cylinder', [3.9, 4.1, 1.0, 20], 'masonry', { y: 0.5 });
                part(p, 'box', [2.2, 0.5, 1.6], 'masonry', { y: 0.25, z: 4.2 });                 // the steps
                part(p, 'cylinder', [2.3, 2.3, 3.0, 16], 'plaster', { y: 2.5 });              // the cella
                for (let i = 0; i < 12; i++) {
                    const a = (i + 0.5) / 12 * Math.PI * 2;
                    part(p, 'cylinder', [0.2, 0.24, 3.0, 8], 'plaster', { x: Math.sin(a) * 3.35, y: 2.5, z: Math.cos(a) * 3.35 });
                }
                part(p, 'cylinder', [3.65, 3.65, 0.4, 20], 'plaster', { y: 4.2 });            // the entablature
                part(p, 'cylinder', [3.65, 3.65, 0.18, 20], 'cloth', { y: 4.0, team: true });
                part(p, 'cylinder', [0.2, 3.9, 2.2, 20], 'rooftile', { y: 5.5 });              // the cone
                part(p, 'sphere', [1, 8, 6], 'gold', { y: 6.75, sx: 0.32, sy: 0.32, sz: 0.32 });
                part(p, 'box', [1.1, 2.0, 0.2], 'bark', { y: 2.0, z: 2.3 });
            } else if (civ === 'viking') {
                // The hof (b1063): a stave-built hall under stacked shingle roofs with
                // dragon heads, the sacred ash beside it, a sacrificial stone before it.
                part(p, 'frustum', [7.0, 5.6, 6.6, 5.2, 0.4], 'rock', { x: -0.8 });
                part(p, 'box', [4.6, 2.4, 3.6], 'wood', { x: -0.8, y: 1.6 });
                [[-3.1, -1.8], [1.5, -1.8], [-3.1, 1.8], [1.5, 1.8]].forEach(([x, z]) =>
                    part(p, 'cylinder', [0.2, 0.22, 3.0, 6], 'bark', { x, y: 1.9, z }));
                part(p, 'prism', [5.6, 4.8, 1.4], 'bark', { x: -0.8, y: 2.8 });                // lower roof
                part(p, 'box', [3.2, 1.0, 2.4], 'wood', { x: -0.8, y: 4.4 });
                part(p, 'prism', [4.0, 3.2, 1.6], 'bark', { x: -0.8, y: 4.9 });                // upper roof
                for (const x of [-2.8, 1.2]) {
                    part(p, 'box', [0.16, 1.4, 0.16], 'wood', { x, y: 6.8, z: 0.35, rx: 0.5 });
                    part(p, 'box', [0.16, 1.4, 0.16], 'wood', { x, y: 6.8, z: -0.35, rx: -0.5 });
                }
                part(p, 'box', [1.1, 1.7, 0.2], 'bark', { x: -0.8, y: 1.25, z: 1.85 });
                part(p, 'box', [3.4, 0.24, 0.24], 'cloth', { x: -0.8, y: 2.55, z: 1.9, team: true });
                part(p, 'cylinder', [0.3, 0.45, 3.6, 7], 'bark', { x: 3.4, y: 1.8, z: -0.6 });  // the ash
                part(p, 'sphere', [1, 10, 8], 'foliage', { x: 3.4, y: 4.4, z: -0.6, sx: 1.9, sy: 1.6, sz: 1.9 });
                part(p, 'box', [1.2, 0.6, 0.8], 'rock', { x: 2.6, y: 0.3, z: 2.6 });            // the altar stone
            } else if (civ === 'maya') {
                // A temple pyramid in the Tikal manner (b1063): steep and tall, where the
                // Town Center's platform is wide and low -- five narrow terraces, a stair,
                // the shrine and its high roof comb.
                [[6.6, 0], [5.6, 1.1], [4.6, 2.2], [3.8, 3.3], [3.0, 4.4]].forEach(([w, y]) =>
                    part(p, 'frustum', [w, w, w - 0.5, w - 0.5, 1.1], 'masonry', { y }));
                part(p, 'box', [1.5, 0.3, 4.6], 'plaster', { y: 2.75, z: 2.0, rx: 1.0 });       // the stair
                part(p, 'box', [2.6, 1.6, 2.2], 'plaster', { y: 6.3 });                          // the shrine
                part(p, 'box', [0.7, 1.0, 0.2], 'bark', { y: 6.0, z: 1.12 });
                part(p, 'frustum', [2.4, 1.4, 1.6, 0.6, 2.2], 'masonry', { y: 7.1 });            // the roof comb
                part(p, 'box', [1.7, 1.1, 0.3], 'cloth', { y: 8.1, z: 0.3, team: true });
                part(p, 'cylinder', [0.3, 0.22, 0.5, 8], 'masonry', { x: 1.6, y: 0.25, z: 4.3 }); // an incense brazier
                part(p, 'cylinder', [0, 0.18, 0.4, 6], 'gold', { x: 1.6, y: 0.7, z: 4.3 });
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
        // ---- The four Wonders (game types: pyramid / akropolis / firetemple /
        // shrine). During the engine swap they all borrowed the generic ziggurat
        // — Yamato's "shrine" rendered as a pyramid. Each is its own again.
        pyramid: () => { // Egypt: stepped pyramid, gold capstone, obelisk pair
            const p = [];
            shadow(p, 10);
            part(p, 'frustum', [13, 13, 10.4, 10.4, 2.2], 'masonry');
            part(p, 'frustum', [10.4, 10.4, 7.8, 7.8, 2.0], 'masonry', { y: 2.2 });
            part(p, 'frustum', [7.8, 7.8, 5.2, 5.2, 1.8], 'masonry', { y: 4.2 });
            part(p, 'pyramid', [5.2, 5.2, 2.6], 'gold', { y: 6.0 });
            [[-5.9, 6.0], [5.9, 6.0]].forEach(([x, z]) => {
                part(p, 'frustum', [0.7, 0.7, 0.34, 0.34, 4.0], 'masonry', { x, z });
                part(p, 'pyramid', [0.42, 0.42, 0.55], 'gold', { x, y: 4.0, z });
            });
            return p;
        },
        akropolis: () => { // Greece: great marble hall on a stepped crepidoma
            const p = [];
            shadow(p, 10);
            part(p, 'frustum', [13, 10, 12.2, 9.2, 1.0], 'masonry');
            part(p, 'frustum', [12.2, 9.2, 11.4, 8.4, 0.8], 'masonry', { y: 1.0 });
            part(p, 'box', [7.4, 4.2, 4.6], 'plaster', { y: 3.9 });
            [-4.9, -2.94, -0.98, 0.98, 2.94, 4.9].forEach(x => {
                part(p, 'cylinder', [0.3, 0.35, 4.4, 8], 'plaster', { x, y: 4.0, z: 3.5 });
                part(p, 'cylinder', [0.3, 0.35, 4.4, 8], 'plaster', { x, y: 4.0, z: -3.5 });
            });
            part(p, 'prism', [12.4, 9.6, 2.6], 'plaster', { y: 6.1 });
            part(p, 'pyramid', [0.9, 0.9, 0.7], 'gold', { y: 8.7 }); // acroterion
            return p;
        },
        firetemple: () => { // Persia: tiered round tower, the great flame on top
            const p = [];
            shadow(p, 10);
            part(p, 'cylinder', [5.0, 5.6, 2.6, 10], 'masonry', { y: 1.3 });
            part(p, 'cylinder', [3.5, 3.5, 0.6, 10], 'cloth', { y: 2.75, team: true }); // glazed band
            part(p, 'cylinder', [3.4, 4.2, 3.4, 10], 'masonry', { y: 4.4 });
            part(p, 'cylinder', [2.6, 2.6, 0.5, 10], 'cloth', { y: 6.0, team: true });
            part(p, 'cylinder', [3.0, 1.9, 1.1, 10], 'masonry', { y: 6.75 }); // fire bowl
            part(p, 'cylinder', [0, 1.6, 2.6, 8], 'gold', { y: 8.6 });        // the flame
            [[-4.6, 0], [4.6, 0], [0, -4.6], [0, 4.6]].forEach(([x, z]) =>
                part(p, 'cylinder', [0.45, 0.62, 3.2, 7], 'masonry', { x, y: 1.6, z }));
            return p;
        },
        shrine: () => { // Yamato: the great torii before a raised honden
            const p = [];
            shadow(p, 10);
            part(p, 'frustum', [13, 10, 12, 9, 1.0], 'masonry');
            // great torii
            part(p, 'cylinder', [0.55, 0.65, 7.2, 8], 'bark', { x: -3.4, y: 4.6, z: 3.0 });
            part(p, 'cylinder', [0.55, 0.65, 7.2, 8], 'bark', { x: 3.4, y: 4.6, z: 3.0 });
            part(p, 'box', [9.4, 0.55, 0.7], 'cloth', { y: 8.35, z: 3.0, team: true }); // kasagi
            part(p, 'box', [7.6, 0.4, 0.5], 'wood', { y: 7.1, z: 3.0 });                // nuki
            part(p, 'box', [0.4, 0.85, 0.4], 'wood', { y: 7.72, z: 3.0 });              // strut
            // honden behind, raised on posts
            [[-2.2, -3.2], [2.2, -3.2], [-2.2, -0.8], [2.2, -0.8]].forEach(([x, z]) =>
                part(p, 'cylinder', [0.16, 0.18, 1.6, 6], 'bark', { x, y: 1.8, z }));
            part(p, 'box', [5.2, 0.4, 3.8], 'wood', { y: 2.7, z: -2.0 });
            part(p, 'box', [4.4, 2.4, 3.0], 'wood', { y: 4.1, z: -2.0 });
            part(p, 'prism', [6.6, 4.8, 2.4], 'thatch', { y: 5.3, z: -2.0 });
            [-3.15, 3.15].forEach(x => {
                part(p, 'box', [0.12, 1.1, 0.12], 'bark', { x, y: 7.9, z: -2.0, rz: 0.45 });
                part(p, 'box', [0.12, 1.1, 0.12], 'bark', { x, y: 7.9, z: -2.0, rz: -0.45 });
            });
            [-1.2, 0, 1.2].forEach(x =>
                part(p, 'box', [0.24, 0.24, 1.2], 'bark', { x, y: 7.8, z: -2.0 }));
            return p;
        },
        colosseum: () => { // Rome (b1058, opened b1061): an arcaded ring around a sunken arena
            // A ring of wall segments, not solid drums: the arena floor is on the GROUND,
            // with the seating stepping down to it, so from above it reads as a bowl.
            // (b1058 stacked solid drums and laid the sand on top -- the floor on the roof.)
            const p = [];
            shadow(p, 10);
            const N = 24, ring = (r, h, thick, tex, y0 = 0, extra = {}) => {
                for (let i = 0; i < N; i++) {
                    const a = (i + 0.5) / N * Math.PI * 2;
                    part(p, 'box', [2 * Math.PI * r / N * 1.04, h, thick], tex,
                        Object.assign({ x: Math.sin(a) * r, y: y0 + h / 2, z: Math.cos(a) * r, ry: a }, extra));
                }
            };
            ring(6.2, 6.4, 0.7, 'masonry');                    // the outer wall
            // Three tiers of arches on its face, and a cornice on top of each.
            [[0.2, 2.0], [2.3, 1.9], [4.3, 1.7]].forEach(([y0, h], t) => {
                for (let i = 0; i < N; i++) {
                    const a = (i + 0.5 + (t % 2) * 0.5) / N * Math.PI * 2;
                    part(p, 'box', [0.75, h * 0.7, 0.12], 'bark',
                        { x: Math.sin(a) * 6.58, y: y0 + h * 0.45, z: Math.cos(a) * 6.58, ry: a });
                }
            });
            ring(6.45, 0.22, 1.2, 'plaster', 6.4);              // the top cornice
            ring(6.45, 0.4, 1.25, 'cloth', 5.1, { team: true });   // a band in the owner's colour
            // The seating: three steps down from the wall to the arena.
            ring(5.45, 4.6, 1.0, 'masonry');
            ring(4.55, 3.0, 1.0, 'plaster');
            ring(3.65, 1.5, 1.0, 'masonry');
            part(p, 'cylinder', [3.15, 3.15, 0.25, 20], 'plaster', { y: 0.12, tint: [1.18, 1.0, 0.72] });   // the sand
            part(p, 'box', [1.4, 0.3, 0.6], 'bark', { y: 0.35, z: 2.2 });   // a gate onto the floor
            [0, 1, 2, 3, 4, 5].forEach(i => {   // the velarium's masts
                const a = i / 6 * Math.PI * 2;
                part(p, 'cylinder', [0.07, 0.08, 2.2, 6], 'wood', { x: Math.sin(a) * 6.2, y: 7.6, z: Math.cos(a) * 6.2 });
            });
            return p;
        },
        longhall: () => { // Vikings (b1059): the king's hall, a long turf-roofed hall with dragon gables
            const p = [];
            shadow(p, 10);
            part(p, 'frustum', [12.6, 7.4, 12.0, 6.8, 0.6], 'masonry');                 // stone footing
            part(p, 'box', [10.8, 3.0, 5.2], 'wood', { y: 2.1 });                         // the hall
            // Bowed long walls: a slimmer box laid along each side reads as the curve.
            for (const side of [-1, 1]) part(p, 'box', [8.6, 2.6, 0.5], 'bark', { y: 1.9, z: side * 2.75 });
            part(p, 'prism', [11.6, 6.4, 3.4], 'thatch', { y: 3.6, tint: [.70, .86, .60] }); // turf roof
            // Crossed gable boards ending in dragon heads at both ends.
            for (const x of [-5.9, 5.9]) {
                part(p, 'box', [0.22, 2.6, 0.22], 'wood', { x, y: 6.6, z: 0.55, rx: 0.5 });
                part(p, 'box', [0.22, 2.6, 0.22], 'wood', { x, y: 6.6, z: -0.55, rx: -0.5 });
                part(p, 'box', [0.5, 0.42, 0.8], 'wood', { x, y: 7.85, z: 1.25 });
            }
            // A row of round shields along each wall, in the owner's colour.
            for (const side of [-1, 1]) for (let i = -3; i <= 3; i++)
                part(p, 'cylinder', [0.42, 0.42, 0.12, 12], 'cloth', { x: i * 1.2, y: 2.0, z: side * 3.05, rx: Math.PI / 2, team: true });
            part(p, 'box', [1.4, 2.0, 0.3], 'bark', { y: 1.6, x: 5.45, ry: Math.PI / 2 });   // the door
            return p;
        },
        el_castillo: () => { // Maya (b1060): nine terraces, a stair up the front, the temple on top
            const p = [];
            shadow(p, 10);
            const steps = 9, h = 0.72;
            for (let i = 0; i < steps; i++) {
                const w0 = 12.6 - i * 0.84, w1 = w0 - 0.5;
                part(p, 'frustum', [w0, w0, w1, w1, h], 'masonry', { y: i * h });
            }
            // The stair: one slab laid at the terraces' slope, with balustrades.
            const top = steps * h, run = (12.6 - (12.6 - (steps - 1) * 0.84 - 0.5)) / 2;
            const slope = Math.atan2(top, run), len = Math.hypot(top, run);
            part(p, 'box', [2.4, 0.3, len], 'plaster', { y: top / 2, z: 6.3 - run / 2, rx: slope });
            for (const x of [-1.35, 1.35]) part(p, 'box', [0.3, 0.5, len], 'masonry', { x, y: top / 2 + 0.2, z: 6.3 - run / 2, rx: slope });
            // The temple: walls, a dark doorway, a roof comb in the owner's colour.
            part(p, 'box', [3.4, 2.0, 3.0], 'plaster', { y: top + 1.0 });
            part(p, 'box', [1.0, 1.4, 0.2], 'bark', { y: top + 0.7, z: 1.52 });
            part(p, 'box', [3.8, 0.35, 3.4], 'masonry', { y: top + 2.15 });
            part(p, 'box', [2.6, 1.2, 0.35], 'cloth', { y: top + 2.9, team: true });
            return p;
        },
        wonder: () => { // generic fallback (engine-test / unknown wonder ids)
            const p = [];
            shadow(p, 10);
            part(p, 'frustum', [13, 13, 10.4, 10.4, 2.2], 'masonry');
            part(p, 'frustum', [10.4, 10.4, 7.8, 7.8, 2.0], 'masonry', { y: 2.2 });
            part(p, 'frustum', [7.8, 7.8, 5.2, 5.2, 1.8], 'masonry', { y: 4.2 });
            part(p, 'pyramid', [5.2, 5.2, 2.6], 'gold', { y: 6.0 });
            return p;
        }
    };

    // The same legacy ids as BUILDING_DEFS, for a sharper reason: an unknown type below
    // returns an EMPTY part list, so without this a transcript from before v512 would
    // replay with an invisible building standing in its own footprint. The engine cannot
    // see LEGACY_BUILDING_IDS (it loads first and stays dependency-free), so the pairs
    // are repeated here — and a mismatch shows up immediately as a missing building.
    builders.market = builders.academy;

    // A building's parts (empty array for unknown types — callers stay safe).
    EngineBuildings.parts = (type, opts) => {
        const b = builders[type], options = opts || {};
        const parts = b ? b(options) : [];
        const palette={
            egyptian:{wall:[1.12,1.02,.82],roof:[1.05,.88,.62],accent:[.21,.58,.64],hide:[1.4,1.21,.92]},
            greek:{wall:[1.08,1.08,1.03],roof:[1.08,.89,.78],accent:[.24,.43,.72],hide:[1.3,1.28,1.17]},
            yamato:{wall:[1.05,.96,.83],roof:[.60,.70,.73],accent:[.78,.28,.18],hide:[1.27,1.18,.99]},
            persian:{wall:[1.14,1.01,.83],roof:[.55,.88,.91],accent:[.18,.62,.68],hide:[1.36,1.1,.86]},
            // Travertine walls under terracotta, a deep red accent (b1058, red b1070).
            roman:{wall:[1.12,1.06,.93],roof:[1.16,.78,.60],accent:[.55,.13,.13],hide:[1.3,1.16,.96]},
            // Tarred timber and grey stone under turf roofs (b1059).
            viking:{wall:[.92,.90,.86],roof:[.70,.86,.60],accent:[.10,.55,.60],hide:[1.18,1.05,.88]},
            // White stucco over limestone, palm thatch, a jade accent (b1060).
            maya:{wall:[1.14,1.10,.98],roof:[1.02,.92,.70],accent:[.05,.58,.42],hide:[1.25,1.10,.90]}
        }[options.civ];
        const tier=TIER[options.age] || 0,details=[];
        if(palette)for(const p of parts){
            if(!p.team && !p.tint){
                if(['plaster','masonry','limestone'].includes(p.tex))p.tint=palette.wall;
                if(p.tex==='rooftile'){p.tint=palette.roof;if(options.civ==='yamato'||options.civ==='persian')p.tex='neutralRoof';}
                if(p.tex==='leather')p.tint=palette.hide;
            }
            if(tier===0 && p.kind==='prism' && p.tex==='leather' && p.args[0]>3){
                const [w,d,h]=p.args,doorH=h*.57,tilt=-Math.atan(d/(2*h));
                const face=[];
                part(face,'box',[Math.min(1.35,w*.22),doorH/Math.cos(tilt),.045],'white',
                    {y:doorH/2,z:d/2*(1-doorH/(2*h))+.035,rx:tilt,tint:[.105,.083,.061],visualOnly:true});
                for(const f of face){f.m=M().multiply(p.m,f.m);details.push(f);}
            }
            // Paint bands and small shutters on existing vertical walls only.
            if(tier>=1 && p.kind==='box' && ['wood','plaster','masonry'].includes(p.tex)
                && p.args[0]>3 && p.args[1]>1.8 && p.args[2]>2){
                const [w,h,d]=p.args;
                const ornament=(args,tex,x,y,z,tint)=>details.push({kind:'box',args,tex,tint,
                    m:M().multiply(p.m,M().translation(x,y,z)),visualOnly:true});
                for(const side of [-1,1]){
                    ornament([w*.94,.16,.065],'white',0,h*.34,side*(d/2+.025),palette.accent);
                    if(options.civ!=='greek')for(const x of [-w*.29,w*.29]){
                        ornament([.58,.70,.065],'white',x,.02,side*(d/2+.03),[.15,.13,.11]);
                        for(const offset of [-.19,0,.19])ornament([.045,.7,.085],'wood',x+offset,.02,side*(d/2+.075),palette.wall);
                    }
                }
            }
            if(p.team && p.kind==='box' && p.args[0]>1 && p.args[1]<.6 && p.args[2]<1 && tier>=2){
                // Cultural trim differs from the player-colored flag and runner.
                p.team=false;p.tint=palette.accent;
            }
        }
        parts.push(...details);
        if (options.civ !== 'greek' || tier < 2) return parts;
        // Refine existing architecture. Decorative parts are excluded from the
        // renderer's footprint measurement so visual work cannot change clearance.
        const ornaments=[];
        for (const p of parts) {
            if (p.tex === 'plaster' || p.tex === 'masonry') p.tex='limestone';
            if (p.kind === 'cylinder' && p.tex === 'limestone' && p.args[2] > 1.5 && p.args[0] < .5) {
                p.args=[p.args[0],p.args[1],p.args[2],16];p.key='cylinder:'+p.args.join(',');
                const h=p.args[2], radius=Math.max(p.args[0],p.args[1]);
                for (const top of [-1,1]) {
                    const m=M().multiply(p.m,M().translation(0,top*(h/2-.10),0));
                    ornaments.push({kind:'box',args:[radius*2.9,.20,radius*2.9],tex:'limestone',m,visualOnly:true});
                }
            }
            if (p.kind === 'box' && p.tex === 'limestone' && p.args[0]>3 && p.args[1]>1.8 && p.args[2]>2) {
                for (const side of [-1,1]) {
                    ornaments.push({kind:'box',args:[.60,.82,.06],tex:'wood',
                        m:M().multiply(p.m,M().translation(side*p.args[0]*.30,.12,p.args[2]/2+.015)),visualOnly:true});
                    ornaments.push({kind:'box',args:[.78,.12,.16],tex:'limestone',
                        m:M().multiply(p.m,M().translation(side*p.args[0]*.30,-.34,p.args[2]/2+.04)),visualOnly:true});
                }
            }
            if (p.kind === 'prism' && (p.tex === 'limestone' || p.tex === 'rooftile')) {
                const [w,d,h]=p.args;
                // Stone cornice under terracotta tiles; retain the original silhouette.
                const cornice={kind:'box',args:[w,.16,d],tex:'limestone',
                    m:M().multiply(p.m,M().translation(0,.08,0)),visualOnly:true};
                ornaments.push(cornice);
                p.tex='rooftile';
                for(const side of [-1,1]) {
                    ornaments.push({kind:'box',args:[w*.88,.14,.12],tex:'limestone',
                        m:M().multiply(p.m,M().translation(0,.23,side*(d/2+.01))),visualOnly:true});
                }
            }
        }
        return parts.concat(ornaments);
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

    // Optional courtyard dressing, deliberately separate from collision bounds.
    EngineBuildings.settlement = (type, civ, foot) => {
        const parts=[];
        if (!['town_center','house','market'].includes(type)) return {parts};
        const x=-foot.ex-1.7,z=foot.ez*.35;
        const jarTint=civ==='persian'?[.25,.58,.60]:civ==='egyptian'?[.75,.58,.35]:[.68,.33,.20];
        for(let i=0;i<2;i++) {
            const px=x+i*.6,pz=z+.9+i*.2,h=i?.55:.8;
            if(civ==='yamato') {
                part(parts,'cylinder',[.25,.27,h,8],'wood',{x:px,y:h/2,z:pz});
                for(const y of [h*.2,h*.8])part(parts,'cylinder',[.275,.275,.055,8],'bark',{x:px,y,z:pz});
            } else {
                part(parts,'cylinder',[.24,.17,h*.65,8],'white',{x:px,y:h*.325,z:pz,tint:jarTint});
                part(parts,'cylinder',[.12,.24,h*.35,8],'white',{x:px,y:h*.825,z:pz,tint:jarTint});
                part(parts,'disc',[.10,8],'white',{x:px,y:h+.006,z:pz,tint:[.13,.10,.075]});
            }
        }
        if(type==='market')return {parts};
        const fire=[x,0,z-.7];
        part(parts,'cylinder',[.46,.5,.16,10],'stone',{x,y:.08,z:fire[2]});
        part(parts,'disc',[.36,10],'white',{x,y:.167,z:fire[2],tint:[.10,.07,.055]});
        for(const rx of [-.55,.55])part(parts,'box',[.12,.10,.62],'bark',{x,y:.21,z:fire[2],ry:rx});
        return {parts,fire};
    };

    // Locate a facade surface beside the doorway, ignoring ground and roof slopes.
    EngineBuildings.lampMount = (parts,side=-1) => {
        const obstacles=parts.filter(p=>['rooftile','neutralRoof','thatch','leather'].includes(p.tex)
            || (p.visualOnly&&p.tint&&Math.max(...p.tint)<.35)).map(p=>{
            const mesh=window.EngineMesh[p.kind](...p.args),m=p.m,lo=[Infinity,Infinity,Infinity],hi=[-Infinity,-Infinity,-Infinity];
            for(let i=0;i<mesh.positions.length;i+=3)for(let k=0;k<3;k++){
                const v=m[k]*mesh.positions[i]+m[k+4]*mesh.positions[i+1]+m[k+8]*mesh.positions[i+2]+m[k+12];
                lo[k]=Math.min(lo[k],v);hi[k]=Math.max(hi[k],v);
            }
            return {lo,hi};
        });
        for(const y of [1.74,1.35,.95,.75])for(const x of [1.35,1.65,1.1,2.0,2.4,2.8].map(v=>v*side)){
            let front=-Infinity;
            for(const p of parts){
                if(p.blend||p.visualOnly||['shadow','cloth'].includes(p.tex))continue;
                const mesh=window.EngineMesh[p.kind](...p.args),m=p.m;
                const point=i=>{const k=i*3,a=mesh.positions[k],b=mesh.positions[k+1],c=mesh.positions[k+2];
                    return [m[0]*a+m[4]*b+m[8]*c+m[12],m[1]*a+m[5]*b+m[9]*c+m[13],m[2]*a+m[6]*b+m[10]*c+m[14]];};
                for(let i=0;i<mesh.indices.length;i+=3){
                    const a=point(mesh.indices[i]),b=point(mesh.indices[i+1]),c=point(mesh.indices[i+2]);
                    const n=M().cross(b.map((v,k)=>v-a[k]),c.map((v,k)=>v-a[k]));
                    if(n[2]<=0||Math.abs(n[1])>Math.hypot(...n)*.55)continue;
                    const d=(b[1]-c[1])*(a[0]-c[0])+(c[0]-b[0])*(a[1]-c[1]);
                    if(Math.abs(d)<1e-8)continue;
                    const u=((b[1]-c[1])*(x-c[0])+(c[0]-b[0])*(y-c[1]))/d;
                    const v=((c[1]-a[1])*(x-c[0])+(a[0]-c[0])*(y-c[1]))/d;
                    if(u>=0&&v>=0&&u+v<=1)front=Math.max(front,u*a[2]+v*b[2]+(1-u-v)*c[2]);
                }
            }
            if(front>0&&!obstacles.some(o=>o.lo[0]<x+.34&&o.hi[0]>x-.34
                &&o.lo[1]<y+.75&&o.hi[1]>y-.18&&o.lo[2]<front+.65&&o.hi[2]>front-.10))return {x,y,z:front};
        }
        return null;
    };
    EngineBuildings.entranceLamp = (type, age, civ, foot, buildingParts, side=-1, standalone=false) => {
        const parts=[];
        if(type==='farm')return {parts};
        const early=['stone','neolithic'].includes(age);
        const mount=early?null:standalone?{x:side*1.8,y:1.74,z:8.2}:EngineBuildings.lampMount(buildingParts||EngineBuildings.parts(type,{age,civ}),side);
        if(!early&&!mount)return {parts};
        const x=early?side*1.65:mount.x,z=early?foot.ez+.45:mount.z+.32;
        if(early){
            part(parts,'cylinder',[.18,.26,.13,8],'stone',{x,y:.065,z});
            part(parts,'cylinder',[.055,.075,1.65,6],'bark',{x,y:.9,z});
            part(parts,'cylinder',[.13,.09,.3,7],'leather',{x,y:1.72,z,tint:[.45,.32,.20]});
            return {parts,light:[x,1.94,z],early:true};
        }
        // Bracket penetrates the facade slightly; no ground post in later eras.
        const finish=lightY=>{
            const dy=mount.y-1.74;
            for(const p of parts)p.m=M().multiply(M().translation(0,dy,0),p.m);
            return {parts,light:[x,lightY+dy,z],early:false,mount};
        };
        if(standalone){
            part(parts,'cylinder',[.22,.3,.15,8],'stone',{x,y:.075,z});
            part(parts,'cylinder',[.07,.09,1.65,6],civ==='yamato'?'wood':'iron',{x,y:.9,z});
        }else part(parts,'box',[.14,.34,.10],'iron',{x,y:1.78,z:mount.z+.025});
        if(!standalone)part(parts,'box',[.10,.09,.42],'iron',{x,y:1.70,z:mount.z+.17});
        if(civ==='greek'||civ==='egyptian'){
            part(parts,'cylinder',[.23,.12,.17,9],'white',{x,y:1.77,z,tint:civ==='greek'?[.64,.29,.14]:[.78,.57,.29]});
            part(parts,'disc',[.17,9],'white',{x,y:1.86,z,tint:[.12,.085,.045]});
            return finish(1.94);
        }
        const tex=civ==='yamato'?'wood':'iron';
        part(parts,'box',[.48,.08,.48],tex,{x,y:1.74,z});
        for(const dx of [-.19,.19])for(const dz of [-.19,.19])
            part(parts,'box',[.045,.48,.045],tex,{x:x+dx,y:2,z:z+dz});
        part(parts,'prism',[.61,.20,.58],civ==='yamato'?'wood':'gold',{x,y:2.24,z});
        return finish(1.98);
    };

    EngineBuildings.TYPES = Object.keys(builders);

    window.EngineBuildings = EngineBuildings;
})();
