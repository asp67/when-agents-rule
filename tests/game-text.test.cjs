// Game data is written in German and translated by its source text (tg), so a
// reworded name or description silently loses its translation. And the Wonder
// descriptions said "hold 180s" for months after the rule became 600 s.
const test = require('node:test'), assert = require('node:assert/strict');
const vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, 'js', f), 'utf8');

function gameDictionaries() {
    const context = vm.createContext({});
    vm.runInContext(read('i18n.js') + '\nthis.G = I18N_GAME;', context);
    return context.G;
}

test('every name and description in the game data has a translation', () => {
    const G = gameDictionaries();
    const missing = [];
    for (const f of ['civilizations.js', 'buildings.js', 'units.js']) {
        const re = /\b(name|description)\s*:\s*(["'])((?:(?!\2).)*)\2/g;
        const src = read(f);
        let m;
        while ((m = re.exec(src))) {
            for (const lang of ['en', 'es', 'zh']) {
                if (!(m[3] in G[lang])) missing.push(lang + ': ' + m[3] + ' (' + f + ')');
            }
        }
    }
    assert.deepEqual(missing, []);
});

test('wonder descriptions state the hold time the rules use', () => {
    const held = Number((read('game.js').match(/this\.wonderRequired = (\d+);/) || [])[1]);
    assert.ok(held > 0, 'wonderRequired not found in game.js');
    const wonders = read('civilizations.js').match(/description: '[^']*Weltwunder[^']*'/g) || [];
    assert.equal(wonders.length, 4);
    for (const d of wonders) assert.match(d, new RegExp(held + 's halten'));
    const G = gameDictionaries();
    for (const lang of ['en', 'es', 'zh']) {
        const key = Object.keys(G[lang]).find(k => k.startsWith('Weltwunder'));
        assert.ok(G[lang][key].includes(String(held)), lang + ': ' + G[lang][key]);
    }
});
