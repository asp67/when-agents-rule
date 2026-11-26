// The first state of an arena match counts the people standing there (b1264). The
// campaign's start has derived the population right after it creates the workers for a
// long time; the arena's start never did, so until the first rules step every seat read
// population 0 beside three workers -- and a model's opening state is built before it.
const test = require('node:test'), assert = require('node:assert/strict');
const { createMatch } = require('../tools/bench/realm.cjs');

test('an arena seat opens with its three workers counted', async () => {
    const m = await createMatch({ kind: 'arena', seed: 'opening', seats: ['roman', 'maya'], mapSize: 800 });
    for (const ai of m.seats) {
        assert.equal(ai.units.length, 3);
        assert.equal(ai.resources.population, 3, 'before any step of the match');
        const state = m.game.openAIAIManager.buildGameStateJSON(m.scripted(ai));
        assert.equal(state.population.used, 3, 'and in the state a model would be sent now');
        assert.equal(state.workers.total, 3);
    }
});
