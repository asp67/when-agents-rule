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

// Who plays a seat is decided anew at every start (b1263). The mark "a model plays this
// seat" was kept for the life of the page, and seat ids are seeded: in a series on one
// seed, a rule-based seat that came to stand where a model had stood was never played.
test('a seat a model played is the rule-based brain\'s again in the next match on the same seed', async () => {
    const seats = ['roman', 'maya'];
    const page = await createMatch({ kind: 'arena', seed: 'series', seats, mapSize: 800 });
    const first = page.seats[0].id;
    page.game.aiManager.markAsOpenAIControlled(first);   // as the start path marks a model's seat
    await page.startArena({ seats, seed: 'series', mapSize: 800 });
    const again = page.game.aiManager.aiPlayers[0];
    assert.equal(again.id, first, 'the same seed gives the same seat ids');
    assert.equal(page.game.aiManager.openAIControlled.size, 0, 'no seat is a model\'s before the new match says so');
    page.advance(120000);
    assert.ok(again.units.length + again.buildings.length > 4, 'the brain plays it: ' + again.units.length + ' units, ' + again.buildings.length + ' buildings');
});

// The campaign's start never emptied the list at all: the seats of the match before stood
// in it beside the new opponent, with units and buildings that are in no scene.
test('a campaign after another match has its own opponents and no others', async () => {
    const { startCampaign } = require('./lib/campaign-realm.cjs');
    const page = await createMatch({ kind: 'arena', seed: 'before', seats: ['egyptian', 'yamato', 'greek'], mapSize: 800 });
    page.game.aiManager.markAsOpenAIControlled(page.seats[0].id);
    const g = startCampaign(page, 'roman', ['maya']);
    assert.deepEqual(Array.from(g.aiManager.aiPlayers, a => a.civilization), ['maya']);
    assert.equal(g.aiManager.openAIControlled.size, 0);
});
