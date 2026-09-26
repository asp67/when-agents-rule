// Every UI string exists in all four languages. Spanish had silently lost the
// eight model-catalogue import/export strings, so those buttons fell back to a
// key or another language. The outcome tables (I18N_OUTCOMES, I18N_OUTCOMES_2)
// are the one deliberate exception: English shows the harness's own text
// verbatim, so only de/es/zh carry their keys (see the comment above them).
const test = require('node:test'), assert = require('node:assert/strict');
const vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
const root = path.resolve(__dirname, '..');

test('UI keys are present in every language', () => {
    const context = vm.createContext({ window: {}, navigator: { language: 'en' },
        localStorage: { getItem() { return null; }, setItem() {} },
        document: { documentElement: {}, querySelectorAll() { return []; }, addEventListener() {} } });
    const src = fs.readFileSync(path.join(root, 'js/i18n.js'), 'utf8');
    vm.runInContext(src + ';this.I = I18N; this.O = [I18N_OUTCOMES, I18N_OUTCOMES_2];', context);
    const I = context.I;
    const outcomeKeys = new Set();
    context.O.forEach(table => Object.values(table).forEach(d => Object.keys(d).forEach(k => outcomeKeys.add(k))));
    const langs = Object.keys(I);
    assert.deepEqual([...langs].sort(), ['de', 'en', 'es', 'zh']);
    const all = new Set();
    langs.forEach(l => Object.keys(I[l]).forEach(k => all.add(k)));
    const missing = [];
    for (const l of langs) {
        for (const k of all) {
            if (l === 'en' && outcomeKeys.has(k)) continue;
            if (!(k in I[l])) missing.push(l + ': ' + k);
        }
    }
    assert.deepEqual(missing, []);
});
