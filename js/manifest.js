// ---------------------------------------------------------------------------
// Which files make up the game's rules, in the order they load.
//
// One list, read by everything that needs to know: the contract fingerprint hashes
// `rules` (js/conditions.js), the golden-trace harness loads `vm` into a bare VM, and
// the lint tests scan `rules` plus the harness for engine-dependent Math and random
// numbers. Before this each kept its own list, and a new rule file had to be added to
// all of them by hand -- which is how the harness once ran without the renderer's
// positional pass and a fingerprint once omitted a rule file.
//
//   rules    code that decides what happens in a match: the fingerprint's coreHash
//   harness  the model harness: what models are told and how their commands run
//   vm       everything a bare VM loads to run a match, in a working order
// ---------------------------------------------------------------------------
var WarManifest = Object.freeze({
    rules: Object.freeze([
        'js/simulation/rng.js', 'js/simulation/math.js', 'js/engine/texgen.js',
        'js/civilizations.js', 'js/buildings.js', 'js/units.js', 'js/resources.js',
        'js/terrain.js', 'js/fogofwar.js', 'js/simulation/position-rules.js',
        'js/ai.js', 'js/game.js', 'js/standing-orders.js',
    ]),
    harness: 'js/openai-ai.js',
    vm: Object.freeze([
        'js/simulation/rng.js', 'js/simulation/math.js', 'js/engine/texgen.js',
        'js/civilizations.js', 'js/buildings.js', 'js/units.js', 'js/resources.js',
        'js/terrain.js', 'js/fogofwar.js', 'js/simulation/position-rules.js', 'js/ai.js',
        'js/sha256.js', 'js/conditions.js', 'js/openai-ai.js',
        'js/game.js', 'js/standing-orders.js',
    ]),
});
if (typeof module !== 'undefined' && module.exports) module.exports = WarManifest;
