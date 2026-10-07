// Before more civilizations (b1056): the places that knew only the four by name. The
// rule-based AI never trained a civilization's own units, a building's HP bonus was
// matched by the bonus's name, an unknown civilization built Yamato's academy, and the
// UI wrote the four out by hand in ten places.
const test = require('node:test'), assert = require('node:assert/strict');
const vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
const root = path.resolve(__dirname, '..');
const source = f => fs.readFileSync(path.join(root, 'js', f), 'utf8');

const rules = () => {
    const context = vm.createContext({ console, t: k => k, WarMath: { powInt: (b, e) => b ** e } });
    vm.runInContext(['units.js', 'civilizations.js', 'buildings.js', 'ai.js'].map(source).join('\n') +
        '\nthis.AIManager = AIManager; this.getTrainOptionsForBuilding = getTrainOptionsForBuilding;' +
        ' this.buildingMaxHealth = buildingMaxHealth; this.getCivilization = getCivilization; this.BUILDING_DEFS = BUILDING_DEFS;', context);
    return context;
};

test('the rule-based AI trains a civilization\'s own unit when it is as advanced', () => {
    const c = rules();
    const mgr = Object.create(c.AIManager.prototype);
    const rich = { food: 9999, wood: 9999, stone: 9999, gold: 9999 };
    const pick = (civilization, age, type, resources = rich) => mgr.getUnitToTrain(
        { civilization, age, resources }, { type, trainOptions: c.getTrainOptionsForBuilding(type, age, civilization) });
    assert.equal(pick('greek', 'neolithic', 'barracks'), 'hoplite', 'it trained militia');
    assert.equal(pick('greek', 'bronze', 'barracks'), 'phalanx', 'the most advanced of its own');
    assert.equal(pick('greek', 'iron', 'barracks'), 'champion', 'an Iron unit outranks a Bronze one');
    assert.equal(pick('yamato', 'bronze', 'barracks'), 'samurai');
    assert.equal(pick('egyptian', 'bronze', 'stable'), 'horse_carriage', 'it chose the scout over the chariot');
    // Persia's own units replace shared ids, so the ladder already named them.
    assert.equal(pick('persian', 'iron', 'stable'), 'heavy_cavalry');
    assert.equal(pick('persian', 'bronze', 'barracks'), 'warrior');
    // A unique it cannot pay for does not stall the building.
    assert.equal(pick('greek', 'neolithic', 'barracks', { food: 500, wood: 500, stone: 0, gold: 0 }), 'militia');
});

test('a building HP bonus is read from the bonus\'s data, not its name', () => {
    const c = rules();
    const house = c.BUILDING_DEFS.house;
    const base = c.buildingMaxHealth(house, c.getCivilization('persian'), 'stone');
    assert.equal(c.getCivilization('egyptian').bonus.buildingHealth, 1.5);
    assert.equal(c.getCivilization('greek').bonus.buildingHealth, 1.3);
    assert.equal(c.buildingMaxHealth(house, c.getCivilization('egyptian'), 'stone'), Math.round(base * 1.5 / 50) * 50);
    // Renamed bonus, same effect: the name is a label (it was the switch).
    const renamed = { bonus: Object.assign({}, c.getCivilization('greek').bonus, { name: 'Acropolis' }) };
    assert.equal(c.buildingMaxHealth(house, renamed, 'stone'), c.buildingMaxHealth(house, c.getCivilization('greek'), 'stone'));
});

test('an unknown civilization\'s academy is no one\'s design', () => {
    const scope = { window: {} }; vm.createContext(scope);
    for (const f of ['math3d', 'mesh', 'buildings']) vm.runInContext(source('engine/' + f + '.js'), scope);
    // The shapes. A known civilization adds tinted details of its own, so the old
    // fallback showed as a SUBSET of Yamato's parts, never as an equal list.
    const keys = civ => scope.window.EngineBuildings.parts('academy', { age: 'iron', civ }).map(p => p.key);
    const other = keys('maya');
    for (const civ of ['yamato', 'greek', 'egyptian', 'persian'])
        assert.ok(other.some(k => !keys(civ).includes(k)), civ + "'s academy, built by a stranger");
});

test('the UI takes its civilizations from the data', () => {
    const ui = source('ui.js');
    assert.doesNotMatch(ui, /greek: t\('civ\.greek\.name'\)/, 'a hand-written list of names');
    assert.doesNotMatch(ui, /greek: '#4ecca3'/, 'a hand-written list of colours');
    assert.doesNotMatch(ui, /\['egyptian', 'greek', 'persian', 'yamato'\]\.map|const civs = \['egyptian'/, 'a hand-written slot list');
    assert.doesNotMatch(source('game.js'), /wonderTypes/, 'the four Wonder types by name');
});
