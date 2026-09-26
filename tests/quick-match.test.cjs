// Quick match plays one library model against the rule-based AI as a one-off spec: it
// must pick a model that can play, and must never write itself over the saved setup.
// Rematch replays the spec of the match that just ended.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');

function ui() {
    const scope = { console, t: k => k, document: { getElementById: () => null } };
    vm.createContext(scope);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/ui.js'), 'utf8') + '\nthis.UI = UIManager;', scope);
    const u = Object.create(scope.UI.prototype), started = [], errors = [];
    u._arenaConfig = { models: [], slots: [{ civ: 'yamato', control: 'ki' }], count: 4, prompt: 'P', turnBased: true };
    u.saveArenaConfig = () => {}; u.showModelLibrary = () => {};
    u.showErrorMessage = m => errors.push(m);
    u.game = { startArenaFromSetup: spec => { started.push(spec); return spec; } };
    return { u, started, errors };
}
const model = (id, extra) => Object.assign({ id, name: 'm' + id, endpoint: 'http://127.0.0.1:1/v1', model: 'x', auth: { type: 'none' } }, extra);

test('picks a checked model first, then an unchecked one, never a failed or incomplete one', () => {
    const { u } = ui();
    u._arenaConfig.models = [model(1, { model: '' }), model(2, { _check: { ok: false } }), model(3), model(4, { _check: { ok: true } })];
    assert.equal(u.quickMatchModel().id, 4);
    u._arenaConfig.models.pop();
    assert.equal(u.quickMatchModel().id, 3);
    u._arenaConfig.models.pop();
    assert.equal(u.quickMatchModel(), null);
});

test('without a playable model it says so and starts nothing', () => {
    const { u, started, errors } = ui();
    u.quickMatch();
    assert.equal(started.length, 0);
    assert.deepEqual([...errors], ['ar.quickNeedsModel']);
});

test('the spec is model vs rule-based AI in real time, and the saved setup is untouched', () => {
    const { u, started } = ui();
    u._arenaConfig.models = [model(7)];
    const before = JSON.stringify(u._arenaConfig);
    u.quickMatch();
    const spec = started[0];
    assert.equal(spec.preset, 'quick-match'); assert.equal(spec.turnBased, false); assert.equal(spec.difficulty, 'easy');
    assert.equal(spec.setup.length, 2);
    assert.equal(spec.setup[0].type, 'llm'); assert.equal(spec.setup[0].connection.libraryId, 7);
    assert.equal(spec.setup[1].type, 'ki');
    assert.equal(JSON.stringify(u._arenaConfig), before);
});

test('rematch replays the finished match spec after purging its transcripts', async () => {
    const { u, started } = ui();
    let purged = 0;
    const spec = { setup: [{ civ: 'greek', type: 'ki' }, { civ: 'persian', type: 'ki' }], seed: 's1', turnBased: true };
    u.game.arenaSpec = spec;
    u.game.openAIAIManager = { transcripts: { purge: async () => { purged++; } } };
    await u.rematchArena();
    assert.equal(purged, 1);
    assert.equal(started[0], spec);
});

test('the harness takes the round mode from the match spec, not the setup screen', () => {
    const src = fs.readFileSync(path.join(__dirname, '../js/openai-ai.js'), 'utf8');
    assert.match(src, /const spec = \(this\.game && this\.game\.spectatorMode && this\.game\.arenaSpec\) \|\| null;\s*this\.turnBased = spec \? !!spec\.turnBased/);
    assert.match(src, /preset: \(this\.game\.spectatorMode && this\.game\.arenaSpec && this\.game\.arenaSpec\.preset\) \|\| null/);
});
