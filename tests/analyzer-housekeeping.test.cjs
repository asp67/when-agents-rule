// The analyzer's small promises (sweep of 26 November 2026, builds 1288-1291): the marks
// over the scrubber are drawn, a replay that has ended still takes a jump, the picker
// takes the same file twice, and a series does not start its next match under a reader.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

function page(elements = {}) {
    const context = vm.createContext({ console, Date, Math, Map, Set, t: k => 'T:' + k, setInterval, clearInterval,
        localStorage: { getItem: () => null, setItem() {} },
        document: { getElementById: id => elements[id] || null, querySelector: () => null, visibilityState: 'visible',
            body: { classList: { contains: () => false, toggle() {} } } }, location: { search: '' } });
    for (const f of ['js/ui.js', 'js/analyzer.js']) vm.runInContext(read(f) + '\nthis.UI = UIManager; this.TA = typeof TranscriptAnalyzer === "function" ? TranscriptAnalyzer : this.TA;', context);
    return { u: Object.create(context.UI.prototype), context };
}
const sample = () => {
    const dir = path.join(root, 'samples');
    const name = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort((a, b) => fs.statSync(path.join(dir, a)).size - fs.statSync(path.join(dir, b)).size)[0];
    return { name, text: fs.readFileSync(path.join(dir, name), 'utf8') };
};

test('the scrubber carries a mark for the rejected turns, the new plans, the fights, the ages and the Wonders of the match', () => {
    const host = { innerHTML: '' }, { u, context } = page({ anSwimlane: host });
    const a = new context.TA(u), s = sample();
    a.load(s.text, s.name);
    assert.ok(a.order.length > 50, s.name + ': ' + a.order.length + ' records');
    u.anRenderSwimlane(a);
    const ticks = [...host.innerHTML.matchAll(/class="an-swim-tick is-(\w+)" style="left:([\d.]+)%" title="([^"]*)" onclick="[^"]*game\.ui\.anScrub\((\d+)\)"/g)]
        .map(m => ({ kind: m[1], pct: Number(m[2]), label: m[3], idx: Number(m[4]) }));
    assert.equal(ticks.length, (host.innerHTML.match(/<button/g) || []).length, 'every mark is read by this test');
    const kinds = new Set(ticks.map(k => k.kind));
    // What the file holds, asked of the analyzer itself: each kind it has is marked.
    const turns = a.order.filter(r => !r.type);
    const has = {
        error: turns.some(r => a.hasError(r)), plan: turns.some(r => r._planNew),
        battle: a.chapters.some(c => c.kind === 'battle'), age: a.chapters.some(c => c.kind === 'age'),
        wonder: a.chapters.some(c => /^wonder/.test(c.kind)),
    };
    assert.ok(has.error && has.plan && has.battle && has.age, 'the sample has something of each to mark: ' + JSON.stringify(has));
    for (const k of Object.keys(has)) assert.equal(kinds.has(k), has[k], k + ' marks');
    // A mark leads to the record it stands for.
    for (const k of ticks.filter(x => x.kind === 'error')) assert.ok(a.hasError(a.order[k.idx]), 'an error mark is on a rejected turn');
    for (const k of ticks.filter(x => x.kind === 'plan')) assert.ok(a.order[k.idx]._planNew, 'a plan mark is on a turn that wrote a plan');
    for (const k of ticks) assert.ok(k.idx >= 0 && k.idx < a.order.length && Math.abs(k.pct - k.idx / (a.order.length - 1) * 100) < 0.01);
    assert.ok(ticks.length <= 400, ticks.length + ' marks: thinned, the scrubber stays readable');

    // Another file with nothing to mark shows none of these.
    const empty = new context.TA(u);
    u.anRenderSwimlane(empty);
    assert.equal(host.innerHTML, '', 'the marks of the file before are gone');
});

