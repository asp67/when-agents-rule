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
    vm.runInContext(fs.readFileSync(path.join(root, 'js/buildings.js'), 'utf8'), scope);
    vm.runInContext(src, scope);
    const G = vm.runInContext('Game', scope);
    return { unitVision: G.prototype.unitVision, buildingVision: G.prototype.buildingVision,
        buildingSightCircles: G.prototype.buildingSightCircles, towerWatchCircles: G.prototype.towerWatchCircles };
}

test('the index answers exactly as isVisibleTo and isPositionVisibleToAI', () => {
    const { AIManager, OpenAIAIManager, buildVisionTest } = load();
    const game = gameRules();
    let seed = 12345;
    const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
    const mgr = Object.create(AIManager.prototype); mgr.game = game;
    const harness = Object.create(OpenAIAIManager.prototype);
    const types = ['warrior', 'archer', 'worker', 'priest'];
    // A trebuchet sees 20 around itself and 20 around each enemy tower in its watch
    // (b1110): extra eyes away from its own position, which every path must count.
    const btypes = ['house', 'tower', 'town_center', 'barracks', 'trebuchet'];
    let checked = 0, seen = 0, watchEyes = 0;
    for (let world = 0; world < 40; world++) {
        const ai = { units: [], buildings: [] };
        for (let i = 0; i < 60; i++) ai.units.push({ x: (rnd() - 0.5) * 800, z: (rnd() - 0.5) * 800, type: types[i % 4],
            unitType: i % 5 === 0 ? 'cavalry' : 'infantry', visionBonus: i % 7 === 0 ? 1.25 : undefined, health: i % 9 === 0 ? 0 : 50 });
        for (let i = 0; i < 12; i++) ai.buildings.push({ x: (rnd() - 0.5) * 800, z: (rnd() - 0.5) * 800, type: btypes[i % 4],
            isWonder: i === 11, underConstruction: i % 5 === 0, health: i % 6 === 0 ? 0 : 500, owner: 'a' });
        for (let i = 0; i < 3; i++) ai.buildings.push({ x: (rnd() - 0.5) * 800, z: (rnd() - 0.5) * 800, type: 'trebuchet',
            watch: 120 + 24 * (i % 2), underConstruction: i === 2 && world % 3 === 0, health: 100, owner: 'a' });
        // Enemy towers, some near the trebuchets, one a site, one destroyed.
        const enemy = [];
        for (const t of ai.buildings.filter(b => b.type === 'trebuchet'))
            for (let i = 0; i < 3; i++) enemy.push({ x: t.x + (rnd() - 0.5) * 300, z: t.z + (rnd() - 0.5) * 300, type: 'tower', owner: 'b',
                underConstruction: i === 1, health: i === 2 && world % 2 ? 0 : 400 });
        // A trebuchet on wheels (b1110): its watch rides with the unit.
        for (let i = 0; i < 2; i++) ai.units.push({ x: (rnd() - 0.5) * 800, z: (rnd() - 0.5) * 800, type: 'advanced_trebuchet', unitType: 'siege',
            watch: 144, health: i === 1 && world % 4 === 0 ? 0 : 200, owner: 'a' });
        for (const t of ai.units.filter(u => u.type === 'advanced_trebuchet'))
            for (let i = 0; i < 2; i++) enemy.push({ x: t.x + (rnd() - 0.5) * 300, z: t.z + (rnd() - 0.5) * 300, type: 'tower', owner: 'b', health: 400 });
        game.getAllBuildings = () => ai.buildings.concat(enemy);
        const points = [];
        for (let i = 0; i < 400; i++) points.push([(rnd() - 0.5) * 820, (rnd() - 0.5) * 820]);
        // Points exactly on (and a hair either side of) every eye's sight boundary.
        const eyes = ai.units.flatMap(e => [{ x: e.x, z: e.z, r: game.unitVision(e) }].concat(e.health > 0 ? game.towerWatchCircles(e) : []))
            .concat(ai.buildings.flatMap(b => b.health > 0 ? game.buildingSightCircles(b) : []));
        for (const e of eyes) for (const d of [e.r, e.r - 1e-9, e.r + 1e-9]) points.push([e.x + d, e.z], [e.x, e.z - d]);
        watchEyes += ai.buildings.reduce((n, b) => n + (b.type === 'trebuchet' && b.health > 0 ? game.buildingSightCircles(b).length - 1 : 0), 0);
        const see = buildVisionTest(game, ai), seeH = buildVisionTest(game, ai, true);
        for (const [x, z] of points) {
            const a = mgr.isVisibleTo(ai, x, z);
            assert.equal(see(x, z), a, `isVisibleTo at (${x}, ${z})`);
            assert.equal(seeH(x, z), !!harness.isPositionVisibleToAI(ai, x, z, game), `isPositionVisibleToAI at (${x}, ${z})`);
            checked++; if (a) seen++;
        }
    }
    assert.ok(checked > 30000 && seen > 1000, `checked ${checked}, visible ${seen}`);
    assert.ok(watchEyes > 20, `trebuchet tower-watch circles exercised: ${watchEyes}`);
});
