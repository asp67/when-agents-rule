// The analyzer opened from a match's results (build 1177): Back leads to the results again,
// the transcript stays until the results are left for good, and the auto camera is on from
// the start so a moment opened from the results is not played out as dots on the whole map.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

function page() {
    const back = { text: 'Zurück', attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, set textContent(v) { this.text = v; }, get textContent() { return this.text; } };
    const context = vm.createContext({ console, Date, Math, Map, Set, t: k => 'T:' + k,
        localStorage: { getItem: () => null, setItem() {} },
        document: { getElementById: () => null, querySelector: s => (s === '.an-back' ? back : null), body: { classList: { contains: () => false, toggle() {} } } } });
    for (const f of ['js/ui.js', 'js/analyzer.js']) vm.runInContext(read(f) + '\nthis.UI = UIManager; this.TA = typeof TranscriptAnalyzer === "function" ? TranscriptAnalyzer : this.TA;', context);
    const u = Object.create(context.UI.prototype), calls = [];
    let purged = 0;
    Object.assign(u, { showScreen: id => calls.push('screen ' + id), anLoadSampleIndex() {}, anRender() {}, anStopPlay: () => calls.push('stop'),
        anResimStop: () => calls.push('resim off'), anUnmountStage: () => calls.push('unmount'), resetChartCache() {}, showErrorMessage: m => calls.push('error ' + m),
        analyzer: { load: (text, name) => calls.push('load ' + name + ' ' + text.length) } });
    u.game = { openAIAIManager: { transcripts: { matchId: 'match-1', hasData: () => true, exportBlob: async () => ({ text: async () => 'transcript' }), purge: async () => { purged++; } } } };
    return { u, calls, back, context, purged: () => purged };
}

test('opened from the menu, Back says Back and leads to the game modes', () => {
    const { u, calls, back } = page();
    u.anOpen();
    assert.deepEqual([back.text, back.attrs['data-i18n']], ['T:common.back', 'common.back']);
    assert.deepEqual(calls, ['screen analyzeScreen']);
    calls.length = 0;
    u.anClose();
    assert.deepEqual(calls, ['stop', 'resim off', 'unmount', 'screen gameModeScreen']);
});

test('opened from a match\'s results, Back says so and leads there; the transcript stays for the way back', async () => {
    const { u, calls, back, purged } = page();
    await u.watchInAnalyzer();
    assert.deepEqual(calls, ['screen analyzeScreen', 'stop', 'load match-1-transcripts.jsonl 10']);
    assert.deepEqual([back.text, back.attrs['data-i18n'], u._anFromSummary], ['T:an.backResults', 'an.backResults', true]);
    assert.equal(purged(), 0, 'not deleted on the way into the analyzer: the results screen can save it and open another moment');
    calls.length = 0;
    u.anClose();
    assert.deepEqual(calls, ['stop', 'resim off', 'unmount', 'screen arenaSummaryScreen'], 'a replay in progress is stopped, and the results are back');
    assert.deepEqual([back.text, u._anFromSummary], ['T:common.back', false]);
    // A second moment, the same way; and then the menu's way, which forgets the results.
    await u.watchInAnalyzer();
    assert.equal(u._anFromSummary, true);
    u.anOpen();
    calls.length = 0;
    u.anClose();
    assert.equal(calls[calls.length - 1], 'screen gameModeScreen');
    // Leaving the results for good still deletes the stored copy, as the notice there says.
    u.game.showArenaSetup = () => {};
    await u.leaveArenaSummary(false);
    assert.equal(purged(), 1);
});

test('nothing to open: no screen change, and Back keeps leading where it led', async () => {
    const { u, calls } = page();
    u.game.openAIAIManager.transcripts.hasData = () => false;
    await u.watchInAnalyzer();
    assert.deepEqual([calls.length, u._anFromSummary], [0, undefined]);
});

test('the auto camera is on when a transcript is opened, and the way back is worded in four languages', () => {
    const { context } = page();
    assert.equal(new context.TA({}).autoCam, true);
    assert.equal(new context.TA({}).union, true, 'the whole board is still what a reader meets first');
    const ui = read('js/ui.js');
    // During Playback the auto camera is the director; stepping through decisions it keeps the turn in view.
    assert.match(ui, /if \(!rs \|\| !a \|\| !a\.autoCam \|\| !rs\.world \|\| typeof Director !== 'function'\) return null;/);
    assert.match(ui, /if \(a\.autoCam\) this\.anAimCamera\(rec, sc\);/);
    const i18n = vm.createContext({ window: {}, navigator: { language: 'en' }, localStorage: { getItem: () => null, setItem() {} },
        document: { documentElement: {}, querySelectorAll: () => [], addEventListener() {} } });
    vm.runInContext(read('js/i18n.js') + ';this.I = I18N;', i18n);
    const words = ['en', 'de', 'es', 'zh'].map(lang => i18n.I[lang]['an.backResults']);
    assert.ok(words.every(w => typeof w === 'string' && w.length > 2) && new Set(words).size === 4, words.join(' | '));
    assert.match(read('index.html'), /<button class="sb-end an-back" onclick="game\.ui\.anClose\(\)" data-i18n="common\.back">/);
});
