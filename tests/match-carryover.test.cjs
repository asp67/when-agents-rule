// A match played after another one in the same page must play exactly as on a fresh page
// (b1083): a re-simulation is always a fresh page. The auto-defense beat and the contact
// scan's rotation were game-level and never reset, so the second match of an evening
// stopped replaying at its first fight -- the defense rallied on different steps.
const test = require('node:test'), assert = require('node:assert/strict');
const { createMatch } = require('../tools/bench/realm.cjs');

// Wall-clock stamps the presentation keeps; they never reach the rules.
const WALL_CLOCK = new Set(['lastFrameTime', '_tlLast', '_infoTick']);
const numbers = o => Object.fromEntries(Object.keys(o).filter(k => typeof o[k] === 'number' && !WALL_CLOCK.has(k)).map(k => [k, o[k]]));
const same = (label, a, b) => {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)]))
        assert.equal(a[k] ?? 0, b[k] ?? 0, `${label}.${k} carried over from the match before`);
};

test('a second match in one page starts with the same numbers as a fresh page', async () => {
    const seats = ['roman', 'maya'];
    const page = await createMatch({ kind: 'arena', seed: 'first', seats, mapSize: 800 });
    page.advance(50 * 1237);   // an odd number of steps, so every beat stands part-way
    await page.startArena({ seats, seed: 'second', mapSize: 800 });
    const fresh = await createMatch({ kind: 'arena', seed: 'second', seats, mapSize: 800 });
    same('game', numbers(page.game), numbers(fresh.game));
    same('aiManager', numbers(page.game.aiManager), numbers(fresh.game.aiManager));
    same('openAIAIManager', numbers(page.game.openAIAIManager), numbers(fresh.game.openAIAIManager));
    // ...and they go on to play the same match.
    page.advance(50 * 600); fresh.advance(50 * 600);
    assert.equal(page.game.stateHash(), fresh.game.stateHash());
});
