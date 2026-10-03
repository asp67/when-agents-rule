// What a seat is told of enemy units (asp67, b1042): in sight, or remembered as last seen,
// with how long ago; a tally per rival of what it has seen and not seen die; and an attack
// by id only on what is in sight. space-bunny wrote "their field army is dead" ten turns
// running over a living army of 9 to 17 -- the units had simply left its list.
const test = require('node:test'), assert = require('node:assert/strict');
const { createMatch } = require('../tools/bench/realm.cjs');

async function board() {
    const m = await createMatch({ kind: 'board', seed: 'unit-memory', seats: [
        { civ: 'greek', age: 'bronze', buildings: [['town_center', -250, 0]], units: [['warrior', 0, 0, { tag: 'eye' }]] },
        { civ: 'persian', age: 'bronze', buildings: [['town_center', 250, 0]],
          units: [['warrior', 6, 0, { tag: 'foe' }], ['worker', 0, 6, { tag: 'hand' }]] },
    ] });
    const mgr = m.game.openAIAIManager, c = m.controllers[0];
    const state = () => mgr.buildGameStateJSON(c);
    const foe = () => state().enemyUnits.find(u => u.id === m.tags.foe.id) || null;
    return { m, mgr, c, state, foe, eye: m.tags.eye };
}

test('out of sight, a unit is listed as last seen, with how long ago', async () => {
    const { m, foe } = await board();
    m.tags.foe.health = m.tags.foe.maxHealth / 2;
    assert.deepEqual([foe().visible, foe().healthPct, foe().secondsAgo], [true, 50, undefined]);
    m.tags.foe.x = 200; m.tags.hand.x = 200;          // gone out of sight
    m.advance(4000);
    const u = foe();
    assert.equal(u.visible, false);
    assert.deepEqual([u.x, u.z, u.healthPct], [6, 0, 50], 'where and as it was seen');
    assert.ok(u.secondsAgo >= 3, 'and how long ago: ' + u.secondsAgo);
});

test('the rival\'s tally counts what was seen and not seen die, located or not', async () => {
    const { m, state } = await board();
    const rival = m.seats[1];
    m.seats[0]._metRivals = new Set([rival.id]);
    state();
    m.tags.foe.x = 200; m.tags.hand.x = 200;
    const opp = state().gameStats.opponents.find(o => o.discovered);
    assert.deepEqual(JSON.parse(JSON.stringify(opp.seenAlive)), { warrior: 1, worker: 1 });
    assert.ok(opp.seenSecondsAgo && opp.seenSecondsAgo.newest >= 0);
});

test('attack by id refuses a remembered unit and names where it was seen', async () => {
    const { m, c, state } = await board();
    state();
    m.tags.foe.x = 200; m.tags.hand.x = 200;
    state();                                            // the seat is shown it out of sight
    const res = m.command(c, 'attack_target', { targetId: m.tags.foe.id });
    assert.match(String(res), /^\[ERROR\] .* is out of your sight\. .*last seen at \(6, 0\)/);
    // In sight, the same id is an attack.
    m.tags.foe.x = 6; m.tags.hand.x = 0;
    state();
    assert.match(String(m.command(c, 'attack_target', { targetId: m.tags.foe.id })), /^OK/);
});

test('a remembered unit that died unseen is refused the same way, not "not found"', async () => {
    const { m, c, state } = await board();
    state();
    m.tags.foe.x = 200;
    state();
    const foe = m.tags.foe, rival = m.seats[1];
    foe.health = 0; rival.units.splice(rival.units.indexOf(foe), 1); m.game.renderer.removeUnit(foe);
    assert.match(String(m.command(c, 'attack_target', { targetId: foe.id })), /is out of your sight/);
});

test('what the scan learns while a state is out is kept when it commits', async () => {
    const { m, mgr, c } = await board();
    const g = m.game, ai = m.seats[0];
    const { pending } = mgr.observe(c);
    m.advance(1000);
    const scout = m.addUnit(m.seats[1], 'warrior', -6, 0);   // walks into sight after the look
    g.noteUnitSighting(ai, scout, g.simNow());
    mgr.commitObservation(c, pending);
    assert.ok(ai._unitMemory.has(String(scout.id)), 'the scan\'s newer sighting survives the commit');
    assert.ok(ai._unitMemory.has(String(m.tags.foe.id)));
});
