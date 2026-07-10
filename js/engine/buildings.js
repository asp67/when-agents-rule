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
        if (t.sx || t.sy || t.sz) m = m3.multiply(m, m3.scaling(t.sx || 1, t.sy || 1, t.sz || 1));
        arr.push({ kind, args, tex, m, blend: !!t.blend, key: kind + ':' + args.join(',') });
    };
    const shadow = (arr, r) => part(arr, 'disc', [r, 18], 'shadow', { y: 0.06, blend: true });

    // Ages 'stone'/'neolithic' read as early (timber + thatch), 'bronze'/'iron'
    // as late (plaster + fired tile). One material era per pair keeps the epoch
    // readable at a glance without a whole second building set.
    const early = (age) => !age || age === 'stone' || age === 'neolithic';

    const builders = {
        town_center: (o = {}) => {
            const p = [];
            const e = early(o.age);
            shadow(p, 8.2);
            part(p, 'frustum', [11, 11, 9.8, 9.8, 0.9], 'masonry');
            part(p, 'box', [9, 3.4, 9], e ? 'wood' : 'plaster', { y: 2.6 });
            part(p, 'box', [1.9, 2.2, 0.3], e ? 'bark' : 'wood', { y: 2.0, z: 4.6 });
            part(p, 'pyramid', [11, 11, 3.6], e ? 'thatch' : 'rooftile', { y: 4.3 });
            if (o.age === 'iron') part(p, 'pyramid', [2.4, 2.4, 1.5], 'gold', { y: 7.85 }); // iron-age finial
            return p;
        },
        house: (o = {}) => {
            const p = [];
            const e = early(o.age);
            shadow(p, 4.4);
            part(p, 'box', [4.6, 2.5, 4.2], e ? 'wood' : 'plaster', { y: 1.25 });
            part(p, 'box', [1.2, 1.7, 0.25], e ? 'bark' : 'wood', { y: 0.85, z: 2.16 });
            part(p, 'prism', [5.6, 5.0, 2.0], e ? 'thatch' : 'rooftile', { y: 2.5 });
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
        farm: () => {
            const p = [];
            part(p, 'box', [7, 0.22, 7], 'field', { y: 0.11 });
            [[-3.3, -3.3], [3.3, -3.3], [3.3, 3.3], [-3.3, 3.3]].forEach(([x, z]) =>
                part(p, 'cylinder', [0.08, 0.1, 0.9, 5], 'bark', { x, y: 0.45, z }));
            return p;
        },
        tower: (o = {}) => {
            const p = [];
            const e = early(o.age);
            shadow(p, 3.8);
            part(p, 'frustum', [3.6, 3.6, 2.7, 2.7, 6.5], e ? 'wood' : 'masonry');
            part(p, 'box', [3.4, 0.7, 3.4], e ? 'wood' : 'masonry', { y: 6.85 });
            part(p, 'pyramid', [3.9, 3.9, 1.7], e ? 'thatch' : 'rooftile', { y: 7.2 });
            part(p, 'box', [0.5, 1.3, 0.22], 'bark', { y: 4.6, z: 1.62 });
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

    // Generic construction site sized to a footprint: plinth, waist-high walls,
    // corner scaffold poles with crossbeams.
    EngineBuildings.site = (w, d) => {
        const p = [];
        shadow(p, Math.max(w, d) * 0.7);
        part(p, 'frustum', [w, d, w - 0.6, d - 0.6, 0.5], 'masonry');
        part(p, 'box', [w - 1.2, 1.1, d - 1.2], 'plaster', { y: 1.05 });
        const px = w / 2 - 0.35, pz = d / 2 - 0.35;
        [[-px, -pz], [px, -pz], [px, pz], [-px, pz]].forEach(([x, z]) =>
            part(p, 'cylinder', [0.11, 0.13, 3.6, 5], 'bark', { x, y: 1.8, z }));
        part(p, 'box', [w, 0.14, 0.14], 'wood', { y: 3.5, z: pz });
        part(p, 'box', [w, 0.14, 0.14], 'wood', { y: 3.5, z: -pz });
        return p;
    };

    EngineBuildings.TYPES = Object.keys(builders);

    window.EngineBuildings = EngineBuildings;
})();
