// What a research's description says is what the research does (build 1301). Three did
// not: Democracy said "Town Center -50% training time" and made every building train 1.5
// times as fast (a third less time); the Maya calendar said "Town Center" and sped up every
// building; Egypt's Mining said "stone mining +25%" and raised what a worker carries of
// every resource. The effects are the ones the balance was set on; the texts were wrong.
const test = require('node:test'), assert = require('node:assert/strict');
const vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
const { Realm } = require('../tools/bench/realm.cjs');

function world(civ) {
    const m = new Realm({ seed: 4 });
    const [a, b] = m.startFixture([civ, civ === 'persian' ? 'greek' : 'persian']);
    m.addBuilding(a, 'town_center', -100, 0); m.addBuilding(b, 'town_center', 100, 0);
    m.scripted(a); m.scripted(b);
    const techs = JSON.parse(vm.runInContext(`JSON.stringify(getCivilization(${JSON.stringify(civ)}).techTree)`, m.context));
    const research = id => m.game.completeResearch(id, vm.runInContext(`getCivilization(${JSON.stringify(civ)}).techTree[${JSON.stringify(id)}]`, m.context), a);
    return { m, a, techs, research };
}
// Every civilization's researches, as the rules hold them.
function allTechs() {
    const m = new Realm({ seed: 4 });
    return JSON.parse(vm.runInContext('JSON.stringify(Object.fromEntries(Object.keys(CIVILIZATIONS).map(c => [c, CIVILIZATIONS[c].techTree || {}])))', m.context));
}
// How long a building takes over a unit whose training is 5 seconds, on the match clock
// (a realm's run() is paced in frames, so its own milliseconds are not the world's).
function trainMs(w, building) {
    Object.assign(building, { isProducing: true, productionDuration: 5000, productionProgress: 0, productionType: 'worker' });
    const from = w.m.game.simNow();
    for (let i = 0; building.isProducing && i < 400; i++) w.m.run(50);
    return w.m.game.simNow() - from;
}

test('a research that speeds up training says by how much and where, and does that', () => {
    const found = [];
    for (const [civ, techs] of Object.entries(allTechs())) for (const [id, t] of Object.entries(techs)) {
        if (!(t.bonus && t.bonus.trainSpeed)) continue;
        found.push(civ + '.' + id);
        const pct = Math.round(t.bonus.trainSpeed * 100);
        assert.equal(t.description, `Alle Gebäude +${pct}% Ausbildungstempo`, civ + '.' + id);
        assert.equal(t.appliesTo, 'all_buildings', civ + '.' + id + ': its scope, as data');
        // Measured, at the Town Center and at a barracks: 5 seconds become 5 / (1 + bonus).
        for (const where of ['town_center', 'barracks']) {
            const plain = world(civ), fast = world(civ);
            fast.research(id);
            const at = w => (where === 'town_center' ? w.a.buildings[0] : w.m.addBuilding(w.a, 'barracks', -100, 40));
            const before = trainMs(plain, at(plain)), after = trainMs(fast, at(fast));
            assert.ok(Math.abs(before - 5000) <= 100, where + ' untouched: ' + before);
            assert.ok(Math.abs(after - 5000 / (1 + t.bonus.trainSpeed)) <= 100, `${civ}.${id} at the ${where}: ${after} ms, expected about ${Math.round(5000 / (1 + t.bonus.trainSpeed))}`);
        }
    }
    assert.deepEqual(found.sort(), ['greek.democracy', 'maya.calendar'], 'the researches that speed up training');
});

test('a research that raises what a worker gathers says so of every resource, and does that', () => {
    const found = [];
    for (const [civ, techs] of Object.entries(allTechs())) for (const [id, t] of Object.entries(techs)) {
        if (!(t.bonus && t.bonus.harvestRate && t.appliesTo === 'worker')) continue;
        found.push(civ + '.' + id);
        const pct = Math.round(t.bonus.harvestRate * 100);
        assert.equal(t.description, `Dorfbewohner ernten +${pct}% mehr`, civ + '.' + id + ': no one resource named, for it is all of them');
        // Measured: one load of each resource, with the research and without.
        const load = (w, type) => {
            const node = { type, x: -60, z: 40, amount: 500 };          // a fixture's map is bare
            w.m.game.terrain.resources.push(node);
            const worker = w.m.addUnit(w.a, 'worker', node.x, node.z);
            Object.assign(worker, { task: 'harvesting', harvestTarget: node, isHarvesting: true, isMoving: false, harvestTimer: 0 });
            let ms = 0;
            while (node.amount === 500 && ms < 6000) { w.m.run(50); ms += 50; }
            return 500 - node.amount;                                  // what the first load took
        };
        for (const type of ['food', 'wood', 'stone', 'gold']) {
            const plain = world(civ), more = world(civ);
            more.research(id);
            const base = load(plain, type), got = load(more, type);
            assert.ok(base > 0, type + ': a load was carried (' + base + ')');
            assert.ok(Math.abs(got / base - (1 + t.bonus.harvestRate)) < 0.001, `${civ}.${id}, ${type}: ${base} -> ${got}`);
        }
    }
    assert.ok(found.includes('egyptian.mining') && found.includes('egyptian.agriculture'), found.join(' '));
});

test('the new wording is there in every language, and the old one is gone', () => {
    const src = fs.readFileSync(path.join(__dirname, '../js/i18n.js'), 'utf8');
    const ctx = vm.createContext({ console, localStorage: { getItem: () => null, setItem() {} }, navigator: { language: 'en' }, window: {},
        document: { documentElement: {}, querySelectorAll: () => [], addEventListener() {} } });
    vm.runInContext(src + '\nthis.G = I18N_GAME;', ctx);
    for (const lang of ['en', 'es', 'zh']) {
        for (const de of ['Alle Gebäude +50% Ausbildungstempo', 'Alle Gebäude +25% Ausbildungstempo', 'Dorfbewohner ernten +25% mehr'])
            assert.ok(ctx.G[lang][de] && ctx.G[lang][de] !== de, lang + ' has: ' + de);
        for (const old of ['Dorfzentrum -50% Ausbildzeit', 'Dorfzentrum +25% Ausbildungstempo', 'Steinabbau +25% effizienter'])
            assert.equal(ctx.G[lang][old], undefined, lang + ' no longer carries: ' + old);
        assert.match(ctx.G[lang]['Alle Gebäude +50% Ausbildungstempo'], /50/);
        assert.match(ctx.G[lang]['Alle Gebäude +25% Ausbildungstempo'], /25/);
    }
});
