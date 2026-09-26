// The past-turn recap replayed "buildingsByType":{} into every exchange since the
// live state's buildings tally was retired: it read b.byType from a key that had
// become the buildable list. The counts now come from friendlyBuildings.
const test = require('node:test'), assert = require('node:assert/strict');
const vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
// Recorded matches are not deployed everywhere (the platform server has none), so a
// test that reads them reports as skipped there rather than as a failure.
const HAS_SAMPLES = require('node:fs').existsSync(require('node:path').join(__dirname, '..', 'samples', 'index.json'));
const NEEDS_SAMPLES = { skip: !HAS_SAMPLES && 'samples/ not present' };
const root = path.resolve(__dirname, '..');

function manager() {
    const context = vm.createContext({ console, window: {}, localStorage: { getItem() { return null; }, setItem() {} } });
    const src = fs.readFileSync(path.join(root, 'js/openai-ai.js'), 'utf8').replace(new RegExp("^" + String.fromCharCode(0xFEFF)), '');
    vm.runInContext(src + '\nthis.M = OpenAIAIManager;', context);
    return Object.create(context.M.prototype);
}

test('recap counts buildings by type from friendlyBuildings', () => {
    const m = manager();
    const recap = JSON.parse(m.buildCompactState({
        buildings: { buildable: ['house'] },
        friendlyBuildings: [
            { type: 'town_center', state: 'complete' },
            { type: 'house', state: 'complete' },
            { type: 'house', state: 'under_construction' },
        ],
    }));
    assert.deepEqual({ ...recap.buildingsByType }, { town_center: 1, house: 2 });
    assert.equal(recap.buildingsUnderConstruction, 1);
});

test('recorded states from a real match produce non-empty recaps', NEEDS_SAMPLES, () => {
    const m = manager();
    const file = path.join(root, 'samples/2026-09-09_gemini3.8-deepseek-v4-gpt5.6-qwen3.8_121min.jsonl');
    const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
        .filter(r => !r.type && r.state && Array.isArray(r.state.friendlyBuildings) && r.state.friendlyBuildings.length);
    assert.ok(rows.length > 100);
    for (const r of rows.slice(0, 50)) {
        const recap = JSON.parse(m.buildCompactState(r.state));
        const total = Object.values(recap.buildingsByType).reduce((a, b) => a + b, 0);
        assert.equal(total, r.state.friendlyBuildings.length);
    }
});
