// "A finished building that can produce such a unit and pay for one now" (the rule of
// 1 October 2026) did not ask whether the unit may be trained at all (b1269). A unit
// behind a research of its own -- the engineer behind Siege Engineering, the Maya's
// scout behind Scouting -- counted as soon as its price was in the bank. A seat left with
// an academy, 60 food and 30 wood was kept in the match: every order to train was
// refused for the research, the research could not be paid, and the match could not end
// until somebody found the academy.
const test = require('node:test'), assert = require('node:assert/strict');
const { Realm } = require('../tools/bench/realm.cjs');

// A bronze-age seat with nothing but an academy and a house.
function remnant(bank, techs = {}) {
    const m = new Realm({ seed: 6 });
    const [a, b] = m.startFixture(['greek', 'egyptian']);
    a.age = 'bronze'; b.age = 'bronze';
    m.addBuilding(a, 'academy', -100, 0); m.addBuilding(a, 'house', -100, 20);
    m.addBuilding(b, 'town_center', 100, 0); m.addUnit(b, 'warrior', 100, 10);
    m.game.recomputeMaxPopulation(a);
    Object.assign(a.resources, { food: 0, wood: 0, stone: 0, gold: 0 }, bank);
    Object.assign(a.researchedTechs, techs);
    return { m, g: m.game, a };
}

test('the price of an engineer does not keep a seat in that cannot research Siege Engineering', () => {
    const { g, a } = remnant({ food: 60, wood: 30 });
    assert.equal(a.units.length, 0);
    assert.equal(g.isPlayerEliminated(a), true);
});

test('with the research done, the price of the unit is enough', () => {
    const { g, a } = remnant({ food: 60, wood: 30 }, { siege_engineering: true });
    assert.equal(g.isPlayerEliminated(a), false);
});

test('with the research still to do, the seat is in only if it can pay for both', () => {
    // Siege Engineering 150 wood + 100 gold, an engineer 50 food + 20 wood.
    assert.equal(remnant({ food: 50, wood: 170, gold: 100 }).g.isPlayerEliminated(remnant({ food: 50, wood: 170, gold: 100 }).a), false);
    const short = remnant({ food: 50, wood: 169, gold: 100 });
    assert.equal(short.g.isPlayerEliminated(short.a), true, 'one wood short of the two together');
});

test('a research already under way is paid for: the unit\'s price is enough again', () => {
    const { g, a } = remnant({ food: 60, wood: 30 });
    a.currentResearch = { techId: 'siege_engineering', progress: 0, duration: 15000 };
    assert.equal(g.isPlayerEliminated(a), false);
});
