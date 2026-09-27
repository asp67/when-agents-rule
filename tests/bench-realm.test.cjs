// The reference realm (tools/bench/realm.cjs): WAR Bench's engine. Node is the declared
// reference runtime, so these pin what the bench relies on -- rules loadable from a
// bundle's own copies, a frozen driver that steps exactly, and one way to start a match.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { Realm, createMatch, RULE_FILES, ROOT } = require('../tools/bench/realm.cjs');

const diskSources = () => Object.fromEntries(RULE_FILES.map(f =>
    [f, fs.readFileSync(path.join(ROOT, f), 'utf8').split('\r\n').join('\n')]));

async function minuteOf(options) {
    const m = await createMatch({ kind: 'arena', seats: ['greek', 'persian'], seed: 'realm-sources' }, options);
    m.advance(60000);
    return m.hash();
}

test('rules loaded from supplied sources run exactly as the files on disk', async () => {
    assert.equal(await minuteOf({ sources: diskSources() }), await minuteOf({}));
});

test('a changed rule text changes the result, and incomplete sources are refused', async () => {
    const src = diskSources();
    // Workers get one more hit point: a rule the snapshot sees from the first step.
    // (maxHarvest looked like a rule and is not: no code reads it, so doubling it
    // changed nothing -- a mutation has to be one the rules actually consult.)
    const units = src['js/units.js'];
    const mutated = units.replace('health: 40,', 'health: 41,');
    assert.ok(mutated !== units, 'the mutation must bite');
    assert.notEqual(await minuteOf({ sources: { ...src, 'js/units.js': mutated } }), await minuteOf({ sources: src }));
    const { ['js/ai.js']: gone, ...partial } = src;
    assert.throws(() => new Realm({ sources: partial }), /js\/ai\.js/);
});

test('advance takes exactly the steps asked for, with no frames', async () => {
    const m = await createMatch({ kind: 'arena', seats: ['greek', 'persian'], seed: 'realm-steps' });
    const g = m.game, s0 = g.clock.stepNo, t0 = g.clock.simMs;
    assert.equal(m.advance(10000), 200);
    assert.equal(g.clock.stepNo - s0, 200);
    assert.equal(g.clock.simMs - t0, 10000);
    const clock = m.runtime.now();
    assert.throws(() => m.advance(75), /whole number of 50 ms steps/);
    assert.equal(m.runtime.now(), clock, 'a refused advance moves nothing');
});

test('createMatch builds a board with exactly the entities given', async () => {
    const m = await createMatch({ kind: 'board', seed: 'board-1', seats: [
        { civ: 'greek', age: 'bronze', resources: { food: 500, wood: 400, stone: 0, gold: 0 }, techs: ['house'],
          buildings: [['town_center', -100, 0]], units: [['worker', -90, 0], ['warrior', -80, 5, { health: 50 }]] },
        { civ: 'persian', buildings: [['town_center', 100, 0], ['tower', 60, 0]] },
    ] });
    const [a, b] = m.seats;
    assert.equal(m.game.mapSeed, 'board-1');
    assert.deepEqual(Array.from(a.units, u => u.type), ['worker', 'warrior']);
    assert.equal(a.units[1].health, 50);
    assert.deepEqual(Array.from(b.buildings, x => x.type), ['town_center', 'tower']);
    assert.equal(a.age, 'bronze');
    assert.equal(a.resources.food, 500);
    assert.equal(a.researchedTechs.house, true);
    assert.equal(a.resources.population, 2);
    // Every board seat is a model seat with no model: it moves only by commands.
    const r = m.command(m.controllers[0], 'move_units', { targetX: -60, targetZ: 0 });
    assert.match(r, /^OK/);
    m.advance(5000);
    assert.ok(a.units[1].x > -80, 'the warrior moved on the command');
});
