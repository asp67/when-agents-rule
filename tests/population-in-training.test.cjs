// A unit in training holds its population slot (b1266, asp67 26 November 2026). The cap
// was checked against the units alive when the order came and never again: a seat at 9
// of 10 with three free trainers had three orders accepted and stood at 12 of 10, turn
// after turn, past the ceiling of 100 too. Now an order is refused when the units alive
// and the units already in training fill the slots -- for a model's seat, the rule-based
// brain and the human alike.
const test = require('node:test'), assert = require('node:assert/strict');
const { Realm } = require('../tools/bench/realm.cjs');

// A seat with three Town Centers (30 slots) and `alive` people.
function town(alive) {
    const m = new Realm({ seed: 11 });
    const [a, b] = m.startFixture(['greek', 'egyptian']);
    const tcs = [-60, 0, 60].map(z => m.addBuilding(a, 'town_center', -150, z));
    m.addBuilding(b, 'town_center', 150, 0);
    for (let i = 0; i < alive; i++) m.addUnit(a, 'worker', -130 + (i % 6) * 3, -20 + Math.floor(i / 6) * 3);
    Object.assign(a.resources, { food: 5000, wood: 5000, stone: 5000, gold: 5000 });
    const g = m.game;
    g.recomputeMaxPopulation(a);
    a.resources.updatePopulation(m.exec('Game').populationOf(a.units));
    return { m, g, a, tcs, ca: m.scripted(a) };
}
const training = tcs => tcs.filter(t => t.isProducing).length;

test('a model seat one below its cap trains one unit, not one per free trainer', () => {
    const { m, a, tcs, ca } = town(29);
    assert.equal(a.resources.maxPopulation, 30); assert.equal(a.resources.population, 29);
    const results = [1, 2, 3].map(() => m.command(ca, 'train_unit', { unitType: 'worker', reason: 'grow' }));
    assert.doesNotMatch(results[0], /^\[ERROR\]/, 'the first has a slot');
    assert.match(results[1], /^\[ERROR\] No available population slots\./, 'the second does not: ' + results[1]);
    assert.match(results[2], /^\[ERROR\] No available population slots\./);
    assert.equal(training(tcs), 1);
    m.run(20000);
    assert.equal(a.resources.population, 30, 'the cap holds');
});

test('the refusal carries the code and the verdict of a full town', () => {
    const { m, g, a, ca } = town(29);
    m.command(ca, 'train_unit', { unitType: 'worker', reason: 'grow' });
    m.command(ca, 'train_unit', { unitType: 'worker', reason: 'grow' });
    const last = ca._lastOutcome;
    assert.equal(last.code, 'populationLimit'); assert.equal(last.verdict, 'avoidable');
    assert.equal(a.resources.population, 29, 'nobody was born yet: the slot is held by the one in training');
});

test('the rule-based brain meets the same count', () => {
    const { m, g, a, tcs } = town(28);
    g.aiManager.trainUnit(a, 'worker', tcs[0]);
    g.aiManager.trainUnit(a, 'worker', tcs[1]);
    g.aiManager.trainUnit(a, 'worker', tcs[2]);
    assert.equal(training(tcs), 2, 'two slots, two in training');
    m.run(20000);
    assert.equal(a.resources.population, 30);
    assert.equal(m.exec('Game').populationInTraining(a), 0, 'and nothing held once they stand');
});

test('a slot comes back when the one in training is born, and when a unit falls', () => {
    const { m, g, a, ca } = town(29);
    m.command(ca, 'train_unit', { unitType: 'worker', reason: 'grow' });
    m.run(20000);
    assert.equal(a.resources.population, 30);
    assert.match(m.command(ca, 'train_unit', { unitType: 'worker', reason: 'grow' }), /^\[ERROR\]/, 'full');
    const one = a.units[0];
    one.health = 0; g.destroyTarget(one, null);
    m.run(500);
    assert.doesNotMatch(m.command(ca, 'train_unit', { unitType: 'worker', reason: 'grow' }), /^\[ERROR\]/, 'a slot is free again');
});

// What a model is shown agrees with what it is then told: "used" is the slots occupied.
test('the state counts the one in training among the slots occupied', () => {
    const { m, g, a, ca } = town(29);
    const before = g.openAIAIManager.buildGameStateJSON(ca);
    assert.equal(before.population.used, 29); assert.equal(before.population.capacityNow, 30);
    m.command(ca, 'train_unit', { unitType: 'worker', reason: 'grow' });
    const state = g.openAIAIManager.buildGameStateJSON(ca);
    assert.equal(state.population.used, 30, 'twenty-nine alive and one on the way');
    assert.equal(state.workers.total, 29, 'who is not a worker yet');
    assert.ok(JSON.stringify(state.units).includes('"pop"'), 'and the unit list says what stands in the way');
    assert.ok(!JSON.stringify(before.units).includes('"pop"'));
});
