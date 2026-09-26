// Keyed draws in the real loop: one seat's random choices do not depend on what any
// other seat did. With one shared generator, an extra draw anywhere -- one more
// priest, one more command -- shifted every later choice for every seat, so two runs
// of a match could not be compared past their first difference.
const test = require('node:test'), assert = require('node:assert/strict');
const { GoldenMatch } = require('./harness.cjs');

function run(extraForSeat0) {
    const m = new GoldenMatch({ seed: 17 });
    const [a, b] = m.startFixture(['greek', 'persian']);
    m.addBuilding(a, 'town_center', -120, 0);
    m.addBuilding(b, 'town_center', 120, 0);
    m.scripted(a); m.scripted(b);
    // Each seat: a wounded soldier and a priest beyond healing reach (10.5) but inside
    // its search (24), which walks over to a jittered spot beside the patient (a keyed
    // 'heal-walk' draw).
    const setUp = (ai, x, priests) => {
        const hurt = m.addUnit(ai, 'warrior', x, 0);
        hurt.health = hurt.maxHealth / 2;
        return Array.from({ length: priests }, (_, i) => m.addUnit(ai, 'priest', x, 18 + i));
    };
    setUp(a, -60, extraForSeat0 ? 2 : 1);
    const [theirs] = setUp(b, 60, 1);
    m.run(300);
    return { x: theirs.targetX, z: theirs.targetZ, moving: theirs.isMoving };
}

test("a seat's random choices do not depend on another seat's draws", () => {
    const plain = run(false), busy = run(true);
    assert.equal(plain.moving, true, 'the priest set off towards its patient');
    assert.deepEqual(busy, plain, "seat 0's extra priest changes nothing for seat 1");
});

// Every rule draw is keyed on the map seed, ids included (step 5), so nothing else
// random can reach a match: two runs whose leftover randomness differs end in the
// same state, down to every id.
test('a match depends on its map seed, not on any other randomness', async () => {
    const play = async seed => {
        const m = new GoldenMatch({ seed });
        await m.startArena({ seats: ['greek', 'persian'], seed: 'golden-opening' });
        m.run(60000);
        return m.hash();
    };
    assert.equal(await play(99), await play(11));
});

// The same, from the other side: the harness counts every Math.random call, and a
// match -- its start and its play -- makes none. (Building the game object does: the
// terrain's constructor lays out a throwaway unseeded map, as it does in a browser,
// before the match replaces it with the seeded one.)
test('a match draws nothing from Math.random, from its start to its end', async () => {
    const m = new GoldenMatch({ seed: 5 });
    const before = m.runtime.state().draws;
    await m.startArena({ seats: ['greek', 'persian', 'egyptian'], seed: 'no-leftovers' });
    m.run(90000);
    assert.equal(m.runtime.state().draws - before, 0);
});

// Ids carry no clock: the old 'unit_<ms>_<random>' told any model reading an enemy's
// id when that unit was trained. Now a prefix and eleven base-36 characters, unique
// in the match, and the same in every run of it.
test('ids are short, carry no time, are unique and repeat with the match', async () => {
    const ids = async () => {
        const m = new GoldenMatch({ seed: 5 });
        await m.startArena({ seats: ['greek', 'persian'], seed: 'id-check' });
        m.run(120000);
        const g = m.game;
        return JSON.parse(JSON.stringify({
            players: g.aiManager.aiPlayers.map(p => p.id),
            entities: g.getAllUnits().concat(g.getAllBuildings()).map(e => e.id)
        }));
    };
    const a = await ids(), b = await ids();
    assert.deepEqual(a, b, 'the same match makes the same ids');
    a.players.forEach(id => assert.match(id, /^ai_[0-9a-z]{11}$/));
    a.entities.forEach(id => assert.match(id, /^(unit|building)_[0-9a-z]{11}$/));
    assert.ok(a.entities.length > 10, 'units were trained and buildings built: ' + a.entities.length);
    assert.equal(new Set(a.entities.concat(a.players)).size, a.entities.length + a.players.length, 'no id twice');
});
