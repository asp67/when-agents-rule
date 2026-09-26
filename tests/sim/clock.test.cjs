// One simulation clock (review #6 step 3). Gameplay timers -- the auto-defense window,
// the repair lock, the battle ledger, the formation charge -- run on simulated time, so
// a pause stops them and 2x runs them twice as fast, like everything else in the
// world. What a model is TOLD stays in real seconds. At 1x in a visible tab the two
// clocks agree, which is why the golden traces did not move.
const test = require('node:test'), assert = require('node:assert/strict');
const { GoldenMatch } = require('./harness.cjs');

function world() {
    const m = new GoldenMatch({ seed: 9 });
    const [a, b] = m.startFixture(['greek', 'persian']);
    m.addBuilding(a, 'town_center', -120, 0);
    m.addBuilding(b, 'town_center', 120, 0);
    m.scripted(a); m.scripted(b);
    return { m, g: m.game, a, b };
}

test('the clock advances with the simulation: steps, sim time, match time', () => {
    const { m, g } = world();
    m.run(1000);
    // Sixty-three 16 ms frames are 1008 ms of real time: twenty whole 50 ms steps, and
    // 8 ms carried to the next frame (review #6 step 9).
    assert.equal(g.clock.matchMs, 1008);
    assert.equal(g.clock.stepNo, 20);
    assert.equal(g.clock.simMs, 1000);
    assert.equal(g._simAccumulator, 8);
    g.simSpeed = 2;
    m.run(1000);
    assert.equal(g.clock.matchMs, 2016, 'real match time ignores the speed');
    assert.equal(g.clock.simMs, 3000, 'twice the rate: 2016 more budgeted, 2024 carried in, forty steps');
    assert.equal(g._simAccumulator, 24);
});

test('a pause stops the repair lock; 2x runs it twice as fast', () => {
    const { m, g, a } = world();
    const tc = a.buildings[0];
    m.run(500);
    tc._lastDamageTime = g.simNow();          // hit just now
    g.pauseState = 'paused';
    m.run(30000);                              // half a minute of real time, paused
    assert.equal(g.repairBarrierMsLeft(tc), 10000, 'no time passed for the lock');
    g.pauseState = 'running';
    g.simSpeed = 2;
    m.run(5008);                               // five real seconds at 2x
    assert.equal(g.repairBarrierMsLeft(tc), 0, 'ten simulated seconds have passed');
});

test('what a model is told stays in real seconds, across speed changes and pauses', () => {
    const { m, g } = world();
    m.run(10000);                              // 1x
    g.simSpeed = 2;
    m.run(4992);
    const stamp = g.simNow();                  // an event, five real seconds into 2x
    m.run(5008);
    g.pauseState = 'paused';
    m.run(10000);                              // not counted
    g.pauseState = 'running';
    g.simSpeed = 1;
    m.run(5008);
    const real = g.realSecsSince(stamp);
    // Exact to within one 50 ms step: simulated time lags real time by what the
    // accumulator holds. Models are told whole seconds.
    assert.ok(Math.abs(real - 10.016) <= 0.05, `10 real seconds since the event (5 at 2x, 5 at 1x): ${real}`);
    assert.ok(g.simNow() - stamp > 15000, 'while more simulated time than that went by');
});

test('auto-defense answers a blow that landed before a pause, after it', () => {
    const { m, g, a, b } = world();
    const mine = m.addUnit(a, 'warrior', 0, 0), theirs = m.addUnit(b, 'warrior', 3, 0);
    m.run(1000);
    mine._lastAttacker = theirs;
    mine._lastDamageTime = g.simNow();         // struck; the reflex has 4 s to answer
    g.pauseState = 'paused';
    m.run(60000);                              // a minute of real time, paused
    g.pauseState = 'running';
    m.run(1000);
    assert.equal(mine.attackTarget, theirs, 'the blow is still recent in game time');
});
