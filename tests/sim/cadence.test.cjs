// Cadence invariance (review #6 step 9). The simulation advances in fixed 50 ms steps;
// frames only feed the accumulator. So a match reaches exactly the same state -- every
// position, timer and id -- whether the browser draws at 60 fps, 20 fps, or a hidden tab
// ticks four times a second, and the frozen-step driver reaches it with no frames at all.
const test = require('node:test'), assert = require('node:assert/strict');
const { GoldenMatch } = require('./harness.cjs');

const FRAMES = [16, 25, 50, 125, 250];   // all divide the run lengths below exactly

async function arena(frameMs, ms) {
    const m = new GoldenMatch({ seed: 41, frameMs, hidden: frameMs >= 250 });
    await m.startArena({ seats: ['greek', 'persian'], seed: 'cadence' });
    m.run(ms);
    return m;
}

test('an arena reaches the same state at every frame rate', async () => {
    const hashes = [];
    for (const f of FRAMES) hashes.push((await arena(f, 90000)).hash());
    assert.deepEqual(hashes, FRAMES.map(() => hashes[0]), 'frames of ' + FRAMES.join(', ') + ' ms');
});

test('the frozen-step driver reaches that state with no frames at all', async () => {
    const framed = await arena(16, 90000);
    const m = new GoldenMatch({ seed: 41 });
    await m.startArena({ seats: ['greek', 'persian'], seed: 'cadence' });
    assert.equal(m.game.advanceSim(90000), 1800, 'eighteen hundred 50 ms steps');
    assert.equal(m.game.clock.simMs, framed.game.clock.simMs);
    // Everything the rules decide: the harness's projection without its own frame clock.
    const rules = x => { const s = x.snapshot(); delete s.clock; return JSON.stringify(s); };
    assert.equal(rules(m), rules(framed));
});

test('the driver takes whole steps only, and stops when the match ends', async () => {
    const m = new GoldenMatch({ seed: 42 });
    await m.startArena({ seats: ['greek', 'persian'], seed: 'cadence' });
    assert.throws(() => m.game.advanceSim(30), /whole number/);
    m.game.gameStarted = false;
    assert.equal(m.game.advanceSim(1000), 0, 'an ended match does not move');
});
