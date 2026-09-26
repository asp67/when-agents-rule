// A seat pointing at a model with no endpoint used to become a rule-based seat
// before the arena's own check could see it, so a fresh profile started four
// rule-based players under model names. The arena must refuse and name the seat;
// the campaign may substitute its documented stand-in, but must say so.
const test = require('node:test'), assert = require('node:assert/strict');
const vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
const root = path.resolve(__dirname, '..');

function ui() {
    const shown = [];
    const scope = vm.createContext({ console, t: (k, p) => k + (p ? JSON.stringify(p) : ''),
        document: { getElementById: () => null } });
    vm.runInContext(fs.readFileSync(path.join(root, 'js/ui.js'), 'utf8') + '\nthis.UI = UIManager;', scope);
    const u = Object.create(scope.UI.prototype);
    u.saveSetup = u.saveArenaConfig = () => {};
    u.showInfoMessage = m => shown.push(m);
    u._arenaConfig = { prompt: '', count: 2,
        models: [{ id: 'm1', name: 'Unnamed model 1', endpoint: '' },
                 { id: 'm2', name: 'Local', endpoint: 'http://localhost:11434', model: 'qwen', auth: {} }],
        slots: [{ civ: 'greek', control: 'm1' }, { civ: 'persian', control: 'm2' }] };
    u._campaignConfig = { playerCiv: 'egyptian', count: 2,
        slots: [{ civ: 'greek', control: 'm1' }, { civ: 'yamato', control: 'ki' }] };
    u.shown = shown;
    return u;
}

test('an arena seat without an endpoint stays a model seat with no connection', () => {
    const u = ui();
    const setup = u.collectArenaSetup();
    assert.equal(setup[0].type, 'llm');
    assert.equal(setup[0].connection, null);
    assert.equal(setup[1].type, 'llm');
    assert.equal(setup[1].connection.endpoint, 'http://localhost:11434');
});

test('the arena start refuses it, naming the seat, instead of alert() or a silent swap', () => {
    const src = fs.readFileSync(path.join(root, 'js/game.js'), 'utf8');
    const at = src.indexOf('async _startArenaFromSetup(');
    assert.ok(at >= 0, 'arena start found');
    const body = src.slice(at);
    const check = body.slice(0, body.indexOf('this.spectatorMode = true;'));
    assert.match(check, /setup\[i\]\.type === 'llm' && !\(setup\[i\]\.connection && setup\[i\]\.connection\.endpoint\)/);
    assert.match(check, /showErrorMessage\(t\('ar\.slotNeedsModel'/);
    assert.doesNotMatch(check, /alert\(/);
});

test('the campaign substitutes the rule-based AI visibly', () => {
    const u = ui();
    const setup = u.collectCampaignSetup();
    assert.equal(setup.opponents[0].type, 'ki');
    assert.equal(setup.opponents[0].substituted, true);
    assert.equal(setup.opponents[1].type, 'ki');
    assert.equal(u.shown.length, 1);
    assert.match(u.shown[0], /ar\.slotSubstituted/);
});
