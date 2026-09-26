const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
// Recorded matches are not deployed everywhere (the platform server has none), so a
// test that reads them reports as skipped there rather than as a failure.
const HAS_SAMPLES = require('node:fs').existsSync(require('node:path').join(__dirname, '..', 'samples', 'index.json'));
const NEEDS_SAMPLES = { skip: !HAS_SAMPLES && 'samples/ not present' };
if (!HAS_SAMPLES) { require('node:test')('recorded match checks', NEEDS_SAMPLES, () => {}); return; }
const root = path.resolve(__dirname, '..');
const catalogue = JSON.parse(fs.readFileSync(path.join(root, 'samples/index.json'), 'utf8')).matches;

function setup(fetcher) {
    // The real message path. The analyzer has no visible unit card, so errors must
    // reach the page-level notice; this test used to stub showErrorMessage, which is
    // why it never saw them being written into a 0x0 element.
    const errors = [];
    const notice = {hidden: true, className: '', setAttribute() {}, addEventListener() {},
        set textContent(v) { errors.push(v); }, get textContent() { return errors[errors.length - 1]; }};
    const unitInfo = {getClientRects: () => []};
    const elements = {appNotice: notice, unitInfo};
    const scope = vm.createContext({fetch: fetcher, console, t: k => k, setTimeout: () => 0, clearTimeout() {},
        document: {getElementById: id => elements[id] || null}});
    vm.runInContext(fs.readFileSync(path.join(root, 'js/ui.js'), 'utf8') + '\nthis.UI = UIManager;', scope);
    const ui = Object.create(scope.UI.prototype);
    ui.anFillSamplePicker = () => {};
    ui.errors = errors;
    ui.notice = notice;
    return ui;
}

for (const id of ['match-20260907-120324', 'match-20260909-211941']) {
    test('direct link waits for the catalogue and loads the complete transcript: ' + id, async () => {
        const requests = [];
        let release;
        const ready = new Promise(resolve => { release = resolve; });
        const ui = setup(async url => {
            requests.push(url);
            if (url === 'samples/index.json') { await ready; return {ok: true, json: async () => ({matches: catalogue})}; }
            return {ok: true, text: async () => fs.readFileSync(path.join(root, url), 'utf8')};
        });
        let loaded;
        ui.analyzer = {load: (text, file) => { loaded = {text, file}; }};
        ui.anStopPlay = ui.resetChartCache = ui.anRender = () => {};
        const pending = ui.anLoadLinkedMatch(id);
        assert.equal(loaded, undefined);
        release();
        await pending;
        assert.equal(loaded.file, catalogue.find(m => m.matchId === id).file);
        assert.equal(JSON.parse(loaded.text.split('\n')[0]).matchId, id);
        assert.equal(requests.length, 2);
        assert.equal(ui.errors.length, 0);
    });
}

test('unknown IDs, empty IDs and URL/path inputs never fetch another transcript', async () => {
    const ui = setup(async () => { throw Error('unexpected fetch'); });
    ui._sampleIndex = catalogue;
    ui.anLoadSample = () => assert.fail('must not fall back to the default');
    for (const id of ['', 'unknown', '../private.jsonl', 'https://example.com/log.jsonl']) await ui.anLoadLinkedMatch(id);
    assert.equal(ui.errors.length, 4);
});

test('catalogue outage reports a failure instead of opening an unrelated game', async () => {
    const ui = setup(async () => ({ok: false}));
    ui.anLoadSample = () => assert.fail('unexpected fallback');
    await ui.anLoadLinkedMatch('match-20260907-120324');
    assert.equal(ui.errors.length, 1);
    assert.equal(ui.notice.hidden, false);
});

test('startup opens links locally and publicly while preserving normal defaults', () => {
    // Browser start-up lives in js/boot.js (review #6 step 8).
    const source = fs.readFileSync(path.join(root, 'js/boot.js'), 'utf8');
    const at = source.lastIndexOf("window.addEventListener('load',");
    assert.ok(at >= 0, 'the load handler is in boot.js');
    const boot = source.slice(at);
    for (const [demo, query, expected] of [
        [true, '?match=match-20260907-120324', ['open', 'match-20260907-120324']],
        [false, '?match=match-20260909-211941', ['open', 'match-20260909-211941']],
        [true, '', ['open', 'default']], [false, '', []], [true, '?match=', ['open', '']]
    ]) {
        const calls = [];
        const scope = {WAR_DEMO_ONLY: demo, URLSearchParams, location: {search: query},
            document: {body: {classList: {add() {}}}},
            window: {addEventListener: (event, callback) => callback()},
            Game: class {init() {} ui = {anOpen: () => calls.push('open'), anLoadSample: () => calls.push('default'), anLoadLinkedMatch: id => calls.push(id)};}};
        vm.runInNewContext(boot, scope);
        assert.deepEqual(calls, expected);
    }
});
