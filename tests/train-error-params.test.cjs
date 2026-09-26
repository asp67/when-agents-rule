// Models copy error text verbatim. The train_unit refusal for a {"type": n} map
// told them to put the amount in "count" -- a parameter train_unit does not have.
// Every quoted parameter an error names must exist on that tool.
const test = require('node:test'), assert = require('node:assert/strict');
const vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
const root = path.resolve(__dirname, '..');

function load() {
    const context = vm.createContext({ console, window: {}, localStorage: { getItem() { return null; }, setItem() {} } });
    for (const f of ['civilizations.js', 'buildings.js', 'units.js', 'openai-ai.js']) {
        const src = fs.readFileSync(path.join(root, 'js', f), 'utf8').replace(new RegExp("^" + String.fromCharCode(0xFEFF)), '');
        vm.runInContext(src, context);
    }
    vm.runInContext('this.M = OpenAIAIManager;', context);
    return context.M;
}

test('the train_unit shape error names only train_unit parameters', () => {
    const M = load();
    const m = Object.create(M.prototype);
    m.outcome = () => {};
    const ai = { id: 'p1', civilization: 'greek', units: [], buildings: [], resources: {} };
    const msg = m.executeTrainUnit(ai, {}, { champion: 3 }, {});
    assert.match(msg, /^\[ERROR\]/);
    assert.doesNotMatch(msg, /"count"/);
    const tool = M.TOOLS.find ? M.TOOLS.find(t => (t.function || t).name === 'train_unit') : null;
    const declared = tool ? Object.keys(((tool.function || tool).parameters || {}).properties || {}) : ['unitType'];
    assert.ok(declared.includes('unitType'));
    assert.ok(!declared.includes('count'));
});
