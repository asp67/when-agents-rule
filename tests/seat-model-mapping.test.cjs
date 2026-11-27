// A seat keeps its model across a reload, whatever happened to the library (b1282).
//
// A seat names its model by id, and a model's id is its place in the list, counted anew
// on every load. Nothing led from the ids a setup was saved under to the new ones: after
// one model was deleted, every later model moved into the seat of the one before it at
// the next reload. Seats set to D and C came back as B and D, and the next match ran the
// wrong models under the right-looking setup unless somebody read the dropdowns again.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const ROOT = path.join(__dirname, '..');

// A browser profile: its storage, and a page loaded in it as often as wanted.
function profile() {
    const store = {};
    const localStorage = { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } };
    const scope = vm.createContext({ console, localStorage,
        document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], visibilityState: 'visible', addEventListener() {}, documentElement: {} },
        location: { search: '', href: 'http://localhost/' }, window: {}, navigator: {} });
    for (const f of ['js/i18n.js', 'js/ui.js']) vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), scope, { filename: f });
    const UI = vm.runInContext('UIManager', scope);
    // One page load: the library and both setups read from storage.
    const load = async () => {
        const u = new UI({});
        u.getArenaDefaultPrompt = () => 'PROMPT';
        u.renderArenaLibrary = u.renderArenaSlots = u.updateLibrarySummary = u.renderCampaignSetup = u.renderArenaSetup = () => {};
        u._arenaConfig = await u.loadArenaConfig();
        u._campaignConfig = u.loadCampaignConfig();
        return u;
    };
    const names = (u, slots) => Array.from(slots, s => (s.control === 'ki' ? 'ki' : (u._arenaConfig.models.find(m => m.id === s.control) || { name: '(none)' }).name));
    return { store, load, arena: u => names(u, u._arenaConfig.slots), campaign: u => names(u, u._campaignConfig.slots) };
}
const model = (u, name) => u._arenaConfig.models.find(m => m.name === name);

async function library(p, modelNames) {
    const u = await p.load();
    u._arenaConfig.models = modelNames.map(n => u.makeArenaModel({ name: n }));
    u.saveSetup();
    return p.load();
}

test('seats keep their models when a model before them is deleted and the page reloads', async () => {
    const p = profile();
    let u = await library(p, ['A', 'B', 'C', 'D']);
    u._arenaConfig.slots[0].control = model(u, 'D').id; u._arenaConfig.slots[1].control = model(u, 'C').id;
    u._arenaConfig.slots[2].control = 'ki'; u._arenaConfig.slots[3].control = 'ki';
    u._campaignConfig.slots[0].control = model(u, 'B').id; u._campaignConfig.slots[1].control = model(u, 'D').id;
    u.saveSetup();
    u.doRemoveArenaModel(model(u, 'A').id);
    assert.deepEqual(p.arena(u), ['D', 'C', 'ki', 'ki'], 'before the reload');
    u = await p.load();
    assert.deepEqual(p.arena(u), ['D', 'C', 'ki', 'ki'], 'and after it');
    assert.deepEqual(p.campaign(u).slice(0, 2), ['B', 'D'], 'the campaign\'s opponents too');
    u = await p.load();
    assert.deepEqual(p.arena(u), ['D', 'C', 'ki', 'ki'], 'and after another');
});

test('a setup saved before this build is read by the ids it was saved under', async () => {
    const p = profile();
    // As b1280 wrote it after A (id 1) was deleted: ids with a gap, seats by id, no uid on a seat.
    const m = (id, name) => ({ id, uid: 'uid' + name.toLowerCase() + '00', name, endpoint: 'http://127.0.0.1:1/v1', model: name });
    p.store.arenaConfigV2 = JSON.stringify({ models: [m(2, 'B'), m(3, 'C'), m(4, 'D')], prompt: 'PROMPT',
        slots: [{ civ: 'greek', control: 4, prompt: null }, { civ: 'persian', control: 3, prompt: null }, { civ: 'yamato', control: 'ki', prompt: null }, { civ: 'egyptian', control: 'ki', prompt: null }] });
    p.store.campaignConfigV1 = JSON.stringify({ playerCiv: 'greek', count: 2, slots: [{ civ: 'persian', control: 2, prompt: null }, { civ: 'yamato', control: 4, prompt: null }] });
    const u = await p.load();
    assert.deepEqual(p.arena(u), ['D', 'C', 'ki', 'ki']);
    assert.deepEqual(p.campaign(u).slice(0, 2), ['B', 'D']);
});

test('a seat whose model is gone is rule-based, never the model that stands in its place', async () => {
    const p = profile();
    const m = (id, name) => ({ id, uid: 'uid' + name.toLowerCase() + '00', name, endpoint: 'http://127.0.0.1:1/v1', model: name });
    p.store.arenaConfigV2 = JSON.stringify({ models: [m(1, 'A'), m(2, 'B')], prompt: 'PROMPT',
        slots: [{ civ: 'greek', control: 7, prompt: null }, { civ: 'persian', control: 2, controlUid: 'uidgone000', prompt: null },
                { civ: 'yamato', control: 1, controlUid: 'uidb00', prompt: null }, { civ: 'egyptian', control: 'ki', prompt: null }] });
    const u = await p.load();
    assert.deepEqual(p.arena(u), ['ki', 'ki', 'B', 'ki'], 'an unknown id, a uid that is gone, a uid that leads elsewhere than the id');
});

test('an imported catalogue seats its models by the ids it was exported with', async () => {
    const p = profile();
    let u = await library(p, ['Old', 'Keep']);
    u._campaignConfig.slots[0].control = model(u, 'Old').id; u._campaignConfig.slots[1].control = model(u, 'Keep').id;
    const keepUid = model(u, 'Keep').uid;
    u.saveSetup();
    u.showConfirm = (body, yes) => yes(); u.showNotice = u.showInfoMessage = () => {}; u.showErrorMessage = e => { throw new Error(e); };
    u.configHasSecrets = () => false;
    const m = (id, name) => ({ id, uid: 'uid' + name.toLowerCase() + '00', name, endpoint: 'http://127.0.0.1:1/v1', model: name });
    u._applyImportedCatalog(JSON.stringify({ models: [m(5, 'X'), m(9, 'Y'), m(12, 'Z'), Object.assign(m(13, 'Keep'), { uid: keepUid })], prompt: 'PROMPT',
        slots: [{ civ: 'greek', control: 12, prompt: null }, { civ: 'persian', control: 5, prompt: null }, { civ: 'yamato', control: 'ki', prompt: null }, { civ: 'egyptian', control: 9, prompt: null }] }));
    assert.deepEqual(p.arena(u), ['Z', 'X', 'ki', 'Y']);
    // The campaign's opponents named models of the library that was replaced.
    assert.deepEqual(p.campaign(u).slice(0, 2), ['ki', 'Keep'], 'gone with the old library, or found again in the new one');
    u = await p.load();
    assert.deepEqual(p.arena(u), ['Z', 'X', 'ki', 'Y']); assert.deepEqual(p.campaign(u).slice(0, 2), ['ki', 'Keep']);
});
