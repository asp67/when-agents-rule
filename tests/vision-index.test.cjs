// The batch visibility index must give exactly the linear scans' answers: the same
// distance expression, the same rules about dead units and construction sites, and
// no eye ever missing from a cell -- including points exactly on a sight boundary.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const root = path.resolve(__dirname, '..');

function load() {
    const scope = { console: { log() {}, warn() {}, error() {} } };
    vm.createContext(scope);
    for (const f of ['js/simulation/math.js', 'js/ai.js', 'js/openai-ai.js']) vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), scope);
    return vm.runInContext('({ AIManager, OpenAIAIManager, buildVisionTest })', scope);
}
// The real vision rules, read from game.js's methods rather than copied.
function gameRules() {
    const src = fs.readFileSync(path.join(root, 'js/game.js'), 'utf8');
    const scope = { document: { hidden: true } };
    vm.createContext(scope);
    vm.runInContext(fs.readFileSync(path.join(root, 'js/simulation/math.js'), 'utf8'), scope);
    vm.runInContext(src, scope);
    const G = vm.runInContext('Game', scope);
    return { unitVision: G.prototype.unitVision, buildingVision: G.prototype.buildingVision };
}

test('the index answers exactly as isVisibleTo and isPositionVisibleToAI', () => {
    const { AIManager, OpenAIAIManager, buildVisionTest } = load();
    const game = gameRules();
    let seed = 12345;
    const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
    const mgr = Object.create(AIManager.prototype); mgr.game = game;
    const harness = Object.create(OpenAIAIManager.prototype);
    const types = ['warrior', 'archer', 'worker', 'priest'];
    const btypes = ['house', 'tower', 'town_center', 'barracks'];
    let checked = 0, seen = 0;
    for (let world = 0; world < 40; world++) {
        const ai = { units: [], buildings: [] };
        for (let i = 0; i < 60; i++) ai.units.push({ x: (rnd() - 0.5) * 800, z: (rnd() - 0.5) * 800, type: types[i % 4],
            unitType: i % 5 === 0 ? 'cavalry' : 'infantry', visionBonus: i % 7 === 0 ? 1.25 : undefined, health: i % 9 === 0 ? 0 : 50 });
        for (let i = 0; i < 12; i++) ai.buildings.push({ x: (rnd() - 0.5) * 800, z: (rnd() - 0.5) * 800, type: btypes[i % 4],
            isWonder: i === 11, underConstruction: i % 5 === 0, health: i % 6 === 0 ? 0 : 500 });
        const points = [];
        for (let i = 0; i < 400; i++) points.push([(rnd() - 0.5) * 820, (rnd() - 0.5) * 820]);
        // Points exactly on (and a hair either side of) every eye's sight boundary.
        for (const e of ai.units.concat(ai.buildings)) {
            const r = e.type && btypes.includes(e.type) ? game.buildingVision(e) : game.unitVision(e);
            for (const d of [r, r - 1e-9, r + 1e-9]) points.push([e.x + d, e.z], [e.x, e.z - d]);
        }
        const see = buildVisionTest(game, ai), seeH = buildVisionTest(game, ai, true);
        for (const [x, z] of points) {
            const a = mgr.isVisibleTo(ai, x, z);
            assert.equal(see(x, z), a, `isVisibleTo at (${x}, ${z})`);
            assert.equal(seeH(x, z), !!harness.isPositionVisibleToAI(ai, x, z, game), `isPositionVisibleToAI at (${x}, ${z})`);
            checked++; if (a) seen++;
        }
    }
    assert.ok(checked > 30000 && seen > 1000, `checked ${checked}, visible ${seen}`);
});
