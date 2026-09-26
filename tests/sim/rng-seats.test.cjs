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

// Every rule draw is keyed on the map seed, so nothing else random can reach the
// outcome: the harness's own generator now feeds only ids (seeded in step 5).
test('a match depends on its map seed, not on any other randomness', async () => {
    const play = async seed => {
        const m = new GoldenMatch({ seed });
        await m.startArena({ seats: ['greek', 'persian'], seed: 'golden-opening' });
        m.run(60000);
        // Through JSON: arrays made inside the VM carry its prototypes, and a strict
        // deepEqual would reject equal values for that alone.
        return JSON.parse(JSON.stringify(m.game.aiManager.aiPlayers.map(p => p.units.map(u => [u.type, u.x, u.z, u.health]))));
    };
    assert.deepEqual(await play(99), await play(11));
});
