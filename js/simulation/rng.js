// ---------------------------------------------------------------------------
// The game's one random-number source.
//
// Two kinds of draw:
//
//   stream(seed)   mulberry32, one sequence from one 32-bit seed. The map generator
//                  and the texture painters use it; both carried their own copy of the
//                  same generator until they were consolidated here, and the outputs
//                  are bit-identical to those copies (same seeds, same maps, same
//                  textures).
//
//   draw(state, key)   a KEYED draw for rule code. The value depends only on the
//                  match seed, the key (who drew, and what for) and how many draws
//                  that key has made before -- never on how many draws anything else
//                  made first. With one shared generator, a model that issued one
//                  extra command would shift every later random choice for every
//                  seat, so no two runs of a match could line up past the first
//                  difference. Keyed, a seat's worker spots and build sites depend on
//                  that seat's own history alone.
//
// The keyed state is plain data ({seed, n}) so a match checkpoint can store it.
//
// Rule code must not call Math.random: tests/rng.test.cjs enforces it, with named
// exemptions (seed minting, and an entity made with no game at all). Presentation --
// renderer, camera, audio -- keeps Math.random; it decides nothing.
// ---------------------------------------------------------------------------
var WarRng = Object.freeze({
    // mulberry32. `fallback` replaces a zero seed: 1 for textures and 42 for maps,
    // as their own copies had it.
    stream(seed, fallback = 1) {
        let a = (seed >>> 0) || fallback;
        return function () {
            a |= 0; a = (a + 0x6D2B79F5) | 0;
            let t = Math.imul(a ^ (a >>> 15), 1 | a);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    },

    // A string to a 32-bit seed: the map generator's own hash, kept exactly, so an
    // existing map seed still produces its map.
    hashSeed(text) {
        const s = String(text);
        let h = 1779033703 ^ s.length;
        for (const ch of s) {
            h = Math.imul(h ^ ch.charCodeAt(0), 3432918353);
            h = (h << 13) | (h >>> 19);
        }
        return h >>> 0;
    },

    keyed(seed) { return { seed: String(seed == null ? '' : seed), n: {} }; },

    // An id from two draws of `next`: 52 bits as eleven base-36 characters. Enough
    // that a collision in one match is a one-in-a-hundred-million event even at ten
    // thousand ids, and the caller checks for it anyway.
    id(prefix, next) {
        const hi = Math.floor(next() * 0x100000000), lo = Math.floor(next() * 0x100000);
        return prefix + (hi * 0x100000 + lo).toString(36).padStart(11, '0');
    },

    // The n-th draw for `key` in this match, in [0, 1).
    draw(state, key) {
        const n = state.n[key] || 0;
        state.n[key] = n + 1;
        return WarRng.stream(WarRng.hashSeed(state.seed + '|' + key + '|' + n), 42)();
    },
});
if (typeof module !== 'undefined' && module.exports) module.exports = WarRng;
