// The Wonder countdown at the arena's pace (asp67, build 1021). The countdown counts
// seconds at the 1x pace (game ms 2 per real ms): at 1x its 600 seconds are ten real
// minutes, 2x falls back to 1x while a Wonder stands, and 1/2x stays at 1/2x, where a
// countdown second takes two real seconds.
const test = require('node:test'), assert = require('node:assert/strict');
const { Realm } = require('../tools/bench/realm.cjs');

function world(speed) {
    const m = new Realm({ seed: 21, normalSpeed: 2 });
    const [def, atk] = m.startFixture(['egyptian', 'yamato']);
    def.age = 'iron'; atk.age = 'iron';
    const g = m.game;
    g.wonderRequired = 10;   // ten countdown seconds: twenty game seconds
    m.addBuilding(def, 'town_center', -40, 0);
    m.addBuilding(atk, 'town_center', 120, 0);
    m.addUnit(def, 'champion', -40, 20);
    m.addUnit(atk, 'champion', 120, 20);
    const wonder = m.addBuilding(def, 'pyramid', 0, 0);
    g.simSpeed = speed;
    return { m, g, def, wonder };
}

test('at 1x a Wonder stands ten countdown seconds of the 1x pace; 2x falls back to 1x', () => {
    const { m, g, def, wonder } = world(4);
    assert.equal(wonder.isWonder, true);
    assert.equal(g.wonderPace, 2, 'a countdown second is two game seconds');
    assert.equal(g.wonderHoldMs(), 20000);
    assert.equal(g.effectiveSimSpeed(), 2, '2x falls back to 1x while it stands');
    m.run(5000);
    assert.ok(Math.abs(def._wonderHold - 10000) <= 100, 'five real seconds are ten game seconds: ' + def._wonderHold);
    assert.equal(g.gameStarted, true, 'half the countdown gone, not all of it');
    m.run(5200);
    assert.equal(g.gameStarted, false, 'ten real seconds at 1x end it');
});

test('at 1/2x a Wonder holds the pace where it is, and a countdown second takes two real ones', () => {
    const { m, g, def } = world(1);
    assert.equal(g.effectiveSimSpeed(), 1, '1/2x stays');
    m.run(10000);
    assert.ok(Math.abs(def._wonderHold - 10000) <= 100, 'ten real seconds are ten game seconds: ' + def._wonderHold);
    assert.equal(g.gameStarted, true, 'five countdown seconds left');
    m.run(10200);
    assert.equal(g.gameStarted, false, 'twenty real seconds at 1/2x end it');
});
