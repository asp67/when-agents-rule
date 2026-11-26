// Egypt's Pottery says "villagers build +25% faster" and built 56% faster (b1267): the
// research raised the owner's build bonus AND each worker's own build speed, and a site
// advances by the product of the two. No other bonus is read twice: a worker's harvest
// and walking bonuses each have one reader.
const test = require('node:test'), assert = require('node:assert/strict');
const vm = require('node:vm');
const { Realm } = require('../tools/bench/realm.cjs');

// How long one worker standing at a 10-second site takes to finish it.
function buildMs(research) {
    const m = new Realm({ seed: 4 });
    const [a, b] = m.startFixture(['egyptian', 'greek']);
    m.addBuilding(a, 'town_center', -100, 0); m.addBuilding(b, 'town_center', 100, 0);
    const g = m.game;
    const early = m.addUnit(a, 'worker', -80, 0);
    if (research) g.completeResearch('pottery', vm.runInContext("getCivilization('egyptian').techTree.pottery", m.context), a);
    const late = m.addUnit(a, 'worker', -80, 30);            // trained after the research
    if (research) g.applyResearchedBonusesToUnit(late, a);
    const times = [early, late].map((w, i) => {
        const site = m.addBuilding(a, 'house', w.x, w.z + 2, { underConstruction: true, buildProgress: 0, buildTime: 10000, health: 1 });
        Object.assign(w, { task: 'building', buildTarget: site, isMoving: false });
        let ms = 0;
        while (site.underConstruction && ms < 20000) { m.run(50); ms += 50; }
        return ms;
    });
    return times;
}

test('Pottery makes a villager build a quarter faster, once', () => {
    const [plainEarly, plainLate] = buildMs(false);
    const [early, late] = buildMs(true);
    const near = (got, want, label) => assert.ok(Math.abs(got - want) <= 100, `${label}: ${got} ms, expected about ${want}`);
    near(plainLate, plainEarly, "without the research both take the same");
    near(early, plainEarly / 1.25, 'a worker who was there when it was researched');
    near(late, plainEarly / 1.25, 'a worker trained afterwards');
});
