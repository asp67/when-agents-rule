// Connection presets fill in only the plumbing: endpoint, dialect, auth type. The
// model id stays the user's choice, and the lists are alphabetical so no provider is
// placed first.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');

test('presets fill plumbing only, local ones test at once, cloud ones wait for a key', () => {
    const scope = { console, t: (k, p) => k + (p ? JSON.stringify(p) : ''), document: { getElementById: () => null } };
    vm.createContext(scope);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/ui.js'), 'utf8') + '\nthis.UI = UIManager;', scope);
    const P = scope.UI.MODEL_PRESETS;
    for (const list of [P.local, P.cloud]) {
        const names = list.map(p => p.name.toLowerCase());
        assert.deepEqual([...names], [...names].sort(), 'alphabetical');
        for (const p of list) { assert.match(p.endpoint, /^https?:\/\//); assert.ok(['openai', 'ollama', 'anthropic', 'google'].includes(p.provider)); }
    }
    // OpenRouter logs in with a button (b1025); the other clouds take a key.
    assert.ok(P.cloud.every(p => p.auth === (p.key === 'openrouter' ? 'oauth' : 'bearer')) && P.local.every(p => !p.auth));
    const u = Object.create(scope.UI.prototype), tested = [], notes = [];
    u._arenaConfig = { models: [], slots: [] };
    u.saveArenaConfig = u.renderArenaLibrary = u.renderArenaSlots = u.updateLibrarySummary = () => {};
    u.testArenaModel = id => tested.push(id); u.showInfoMessage = m => notes.push(m);
    u.addArenaModel('ollama'); u.addArenaModel('openai'); u.addArenaModel('openrouter');
    const [local, cloud, login] = u._arenaConfig.models;
    assert.equal(local.endpoint, 'http://localhost:11434'); assert.equal(local.model, ''); assert.equal(local.auth.type, 'none');
    assert.equal(cloud.provider, 'openai'); assert.equal(cloud.model, ''); assert.equal(cloud.auth.type, 'bearer'); assert.equal(cloud.auth.key, '');
    assert.deepEqual([...tested], [local.id]);
    assert.match(notes[1], /ar\.presetKey/);
    assert.equal(login.auth.type, 'oauth'); assert.equal(login.auth.accessToken, '');
    assert.match(notes[2], /ar\.presetLogin/);
});
