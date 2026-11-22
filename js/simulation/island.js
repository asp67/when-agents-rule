// ---------------------------------------------------------------------------
// The island a match is played on: how large it is and where its shore runs.
//
// These are rules. The shore decides where a unit can walk and where a building can
// stand (js/terrain.js resolves it per direction), and the map's size decides how far
// apart the seats start. Until build 1188 they lived in the texture painters
// (js/engine/texgen.js), which made every painter part of the rules hash: repainting a
// roof would have marked all earlier matches as not comparable. The painters are
// presentation now and read the island from here, so the coast they paint, the surf
// the renderer lays on it and the line a unit stops at are still one line.
//
// Moved as it was: the same constants, the same noise lattice from the same stream of
// the game's one generator (js/simulation/rng.js). No map changed.
// ---------------------------------------------------------------------------
const WarIsland = {
    // The coastline is a wobbled square: chebyshev distance from the centre plus a
    // noise offset of up to half COAST_WOBBLE either way.
    COAST_CELLS: 24,
    COAST_WOBBLE: 26,
    // The coast follows a fixed seed: only resources and props follow the map's seed.
    TERRAIN_SEED: 12345,
    TERRAIN_WORLD: 1000,
    // 400 put the waterline THROUGH the play square: with COAST_WOBBLE the shore ran
    // between 387 and 413, so parts of an 800x800 map were sea. 33 of the 1764
    // exploration cells sat in water across 14 of the 49 tiles, none of which could
    // ever read 100% -- and one match spent 91 scouts on a tile it could not finish.
    // 417 puts the whole square ashore with the wobble's 13 to spare.
    TERRAIN_LAND: 417,
    // The map a match is played on (b1057): 800 (7x7 tiles) or 1200 (11x11). The island
    // scales with it -- world = 1.25 x map, shore = map/2 + 17 -- and the coast's noise
    // gets proportionally more cells, so the shoreline keeps its ~42-unit wobble instead
    // of stretching. At 800 every value is the one above, so the standard map is
    // unchanged to the pixel. Set by the game before the map is generated, and by the
    // analyzer from a transcript's header.
    MAP_SIZE: 800,
    setMapSize(size) {
        const s = size > 0 ? size : 800;
        WarIsland.MAP_SIZE = s;
        WarIsland.TERRAIN_WORLD = s * 1.25;
        WarIsland.TERRAIN_LAND = s / 2 + 17;
        WarIsland.COAST_CELLS = Math.round(24 * WarIsland.TERRAIN_WORLD / 1000);
    },

    // Wrapped-bilinear noise SAMPLER in [0,1]: query by (u, v) in [0,1) without
    // precomputing a full-resolution array. The coast is one of these; the painters
    // use the same sampler for their own fields.
    noiseSampler(cells, rand) {
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
    },
    coastNoise(rand) { return WarIsland.noiseSampler(WarIsland.COAST_CELLS, rand); },
    // The coast's wobble at (u, v) of the world square, in world units. The painters'
    // terrain bake draws its coast sampler FIRST from the same seeded stream, so drawing
    // it first from that seed here reproduces the painted lattice exactly.
    coastSampler(seed) {
        const n = WarIsland.coastNoise(WarRng.stream(seed || 7, 1));
        return (u, v) => (n(u, v) - 0.5) * WarIsland.COAST_WOBBLE;
    },
};
if (typeof module !== 'undefined' && module.exports) module.exports = WarIsland;
