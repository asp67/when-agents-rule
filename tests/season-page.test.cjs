// The Season page (overhaul step D9): js/season-page.js, and the two things in ui.js that
// feed it: a finished match is kept, and a rematch can trade the models' seats.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const WarEval = require(path.join(root, 'js/eval/ledger.js'));
const WarSeason = require(path.join(root, 'js/eval/season.js'));
const { loadConditions } = require(path.join(root, 'tools/eval/season.cjs'));
const HAS_SAMPLES = fs.existsSync(path.join(root, 'samples', 'index.json'));

// The page on a stand-in for the browser: storage that can be made to fail, one element.
function page({ failing = false } = {}) {
    const store = {}, els = { seasonBody: { innerHTML: '' }, seasonScreen: { classList: { contains: () => true } } }, shown = [];
    const context = vm.createContext({ console, Date, WarSeason, WarEval, WarConditions: loadConditions(),
        t: (k, v) => k + (v ? JSON.stringify(v) : ''),
        localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { if (failing) throw new Error('QuotaExceededError'); store[k] = v; } },
        document: { getElementById: id => els[id] || null, querySelector: () => ({ id: 'startScreen' }) },
        fetch: async () => ({ ok: true, json: async () => ({ entries: [] }) }) });
    vm.runInContext(fs.readFileSync(path.join(root, 'js/season-page.js'), 'utf8') + '\nthis.Page = SeasonPage;', context);
    const ui = { escapeHtml: s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'), showScreen: id => shown.push(id) };
    return { Page: context.Page, p: new context.Page(ui), store, els, shown };
}
let serial = 0;
const flat = v => ({ grounding: v, macro: v, spatial: v, tactical: v, strategy: v, index: v });
const match = (seats, o = {}) => ({ v: 1, scale: 'v1', matchId: o.id || 'm' + (++serial), at: o.at || 1795000000000 + serial * 60000, build: 1164, duration: '12:00',
    mapSeed: o.seed === undefined ? 'seed-' + serial : o.seed, layout: 'greek,persian', players: seats.length, source: o.source || 'played', file: o.file || null,
    seats: seats.map(([name, seat, rank, v, cond]) => ({ id: name + seat, seat, name, model: name + '-model', rank, of: seats.length, winner: rank === 1,
        cond: cond === undefined ? 'cond-a' : cond, protocol: 'turn-based', core: 'core', scores: flat(v) })) });

test('a match is kept once, can be forgotten, and a browser that will not store says so', () => {
    const { Page, store } = page();
    assert.deepEqual(Array.from(Page.load()), []);
    assert.equal(Page.keep(match([['A', 0, 1, 80]], { id: 'x' })), true);
    assert.equal(Page.keep(match([['A', 0, 1, 85]], { id: 'x' })), true);            // the same match again replaces it
    assert.equal(Page.keep(match([['B', 0, 1, 40]], { id: 'y' })), true);
    assert.deepEqual(Array.from(Page.load(), e => e.matchId + ' ' + e.seats[0].scores.index), ['x 85', 'y 40']);
    assert.equal(JSON.parse(store['war.season.v1']).kind, 'war-season-entries/1');
    assert.equal(Page.keep(null), false);
    assert.equal(Page.keep({ matchId: 'z', seats: [] }), false);                    // no model seat: nothing to keep
    Page.forget('x');
    assert.deepEqual(Array.from(Page.load(), e => e.matchId), ['y']);
    Page.forget(null);
    assert.deepEqual(Array.from(Page.load()), []);
    const broken = page({ failing: true });
    assert.equal(broken.Page.keep(match([['A', 0, 1, 80]])), false);
    assert.deepEqual(Array.from(broken.Page.load()), []);
    store['war.season.v1'] = '{not json';
    assert.deepEqual(Array.from(Page.load()), []);                                  // a damaged store reads as empty, and the page still opens
});

test('the table marks a model ahead only where it is apart, and says in words where it is not', () => {
    const { Page, p } = page();
    for (const [a, b] of [[90, 10], [88, 14], [92, 12]]) Page.keep(match([['Alpha', 0, 1, a], ['Beta', 1, 2, b]]));
    p.samples = [];
    let html = p.html();
    assert.equal((html.match(/<section class="season-group">/g) || []).length, 1);
    assert.match(html, /season\.conditions <code>cond-a<\/code><small>season\.groupMeta\{&quot;protocol&quot;:&quot;turn-based&quot;,&quot;builds&quot;:&quot;1164&quot;,&quot;scale&quot;:&quot;v1&quot;,&quot;n&quot;:3\}/);
    // Alpha is ahead on all six columns, Beta on none: six stars, each with its range on the track.
    assert.equal((html.match(/class="sn-cell is-lead"/g) || []).length, 6);
    // Build 1225: beside the mean and its interval stand every placement, the lowest, the median and the highest match, and a tick a match.
    assert.match(html, /<th scope="row" title="Alpha-model">Alpha<\/th><td>3<\/td><td>3<\/td><td class="sn-places" title="season\.placesTip">1 · 1 · 1<\/td><td class="sn-cell is-lead" title="season\.cellTip\{&quot;mean&quot;:&quot;90\.0&quot;,&quot;lo&quot;:&quot;85\.0&quot;,&quot;hi&quot;:&quot;95\.0&quot;,&quot;n&quot;:3\} season\.spreadTip\{&quot;min&quot;:&quot;88\.0&quot;,&quot;median&quot;:&quot;90\.0&quot;,&quot;max&quot;:&quot;92\.0&quot;,&quot;values&quot;:&quot;90, 88, 92&quot;\} season\.leadTip"><b>90 ★<\/b><small>85–95<\/small><small class="sn-spread">88 · 90 · 92<\/small>/);
    assert.match(html, /<i class="sn-range"><u style="left:85%;width:10%"><\/u><em style="left:90%"><\/em><em style="left:88%"><\/em><em style="left:92%"><\/em><s style="left:90%"><\/s><\/i>/);
    assert.match(html, /<th scope="row" title="Beta-model">Beta<\/th><td>3<\/td><td>0<\/td><td class="sn-places" title="season\.placesTip">2 · 2 · 2<\/td>/);
    assert.match(html, /<tr><th>season\.model<\/th><th>season\.matches<\/th><th>season\.firsts<\/th><th title="season\.placesTip">season\.places<\/th>/);
    assert.doesNotMatch(html, /bf-kind|season\.mixed/, 'these entries do not say who played: no tag, no note');
    assert.match(html, /<p class="season-verdict">season\.someLead<\/p>/);
    assert.match(html, /season\.met\{&quot;a&quot;:&quot;Alpha&quot;,&quot;b&quot;:&quot;Beta&quot;,&quot;n&quot;:3,&quot;aAhead&quot;:3,&quot;bAhead&quot;:0\}/);
    assert.match(html, /season\.count\{&quot;n&quot;:3,&quot;kept&quot;:3\}/);
    // One match each: numbers, the words for one match, no star, and the reason.
    Page.forget(null);
    Page.keep(match([['Alpha', 0, 1, 99], ['Beta', 1, 2, 1]]));
    html = p.html();
    assert.doesNotMatch(html, /is-lead|★/);
    assert.match(html, /<b>99<\/b><small>season\.oneMatch<\/small>/);
    assert.match(html, /<p class="season-verdict">season\.needTwo<\/p>/);
    // Close over three matches: no star, and the other reason.
    Page.forget(null);
    for (const [a, b] of [[70, 60], [80, 72], [75, 66]]) Page.keep(match([['Alpha', 0, 1, a], ['Beta', 1, 2, b]]));
    html = p.html();
    assert.doesNotMatch(html, /is-lead|★/);
    assert.match(html, /<p class="season-verdict">season\.touch<\/p>/);
});

test('what cannot be compared is listed apart and labelled; swapped pairs and kept matches have their own lists', () => {
    const { Page, p } = page();
    Page.keep(match([['Alpha', 0, 1, 70], ['Beta', 1, 2, 40]], { seed: 'map-1', at: 1795000000000 }));
    Page.keep(match([['Beta', 0, 1, 60], ['Alpha', 1, 2, 50]], { seed: 'map-1', at: 1795000600000 }));
    Page.keep(match([['Solo', 0, 1, 55, 'cond-solo']], { source: 'imported', file: 'solo.jsonl' }));
    p.samples = [match([['Ancient', 0, 1, 77, null]], { id: 's1', source: 'sample' })];
    let html = p.html();
    assert.match(html, /season\.swaps<\/h4><ul class="season-list"><li>Alpha − Beta: season\.swap\{&quot;n&quot;:1\} season\.swapOne\{&quot;d&quot;:&quot;\+10\.0&quot;\}<\/li>/);
    assert.match(html, /<summary>season\.alone\{&quot;n&quot;:1\}<\/summary>\s*<p class="season-verdict">season\.aloneNote<\/p>[\s\S]*<th scope="row">Solo<\/th><td><code>cond-solo<\/code><\/td>/);
    assert.match(html, /<summary>season\.unrecorded\{&quot;n&quot;:1\}<\/summary>\s*<p class="season-verdict">season\.unrecordedNote<\/p>[\s\S]*<th scope="row">Ancient<\/th>/);
    assert.match(html, /<summary>season\.kept\{&quot;n&quot;:3\}<\/summary>/);
    assert.match(html, /<td>season\.srcImported<\/td><td>Solo<\/td>/);
    assert.equal((html.match(/season\.forget</g) || []).length, 3);
    assert.match(html, /season\.count\{&quot;n&quot;:4,&quot;kept&quot;:3\}/);
    // Without the samples the old match is gone from the table; what is kept here stays.
    p.setSamples(false);
    html = p.html();
    assert.doesNotMatch(html, /Ancient/);
    assert.match(html, /season\.count\{&quot;n&quot;:3,&quot;kept&quot;:3\}/);
    assert.match(html, /<input type="checkbox"  onchange/);
    // Nothing at all: it says what to do, and while the samples are still loading it says that.
    Page.forget(null);
    assert.match(p.html(), /<p class="season-empty">season\.empty<\/p>/);
    p.samples = null;
    assert.match(p.html(), /<p class="season-empty">season\.loading<\/p>/);
});

test('a transcript file added here is scored here; a file that is not one is named', { skip: !HAS_SAMPLES }, async () => {
    const { Page, p, els } = page();
    p.samples = [];
    const name = '2026-11-07_pi-hy4-hermes-deepseek-v4.1_12min.jsonl', text = fs.readFileSync(path.join(root, 'samples', name), 'utf8');
    await p.addFiles([{ name, text: async () => text }, { name: 'notes.txt', text: async () => 'hello' }, { name: 'gone.jsonl', text: async () => { throw new Error('unreadable'); } }]);
    assert.equal(p.note, 'season.added{"n":1} season.refused{"files":"notes.txt, gone.jsonl"}');
    const kept = Page.load();
    assert.deepEqual(Array.from(kept, e => [e.source, e.file, e.scale, Array.from(e.seats, s => s.name + ' ' + s.cond + ' #' + s.rank).join(', ')].join(' | ')),
        ['imported | ' + name + ' | v4.1 | pi MCP ba441132b2b0 #2, HERMES MCP ba441132b2b0 #1']);
    assert.match(els.seasonBody.innerHTML, /<p class="season-note">season\.added/);
    // Who played stands beside the name (build 1225): both seats of this match are agent harnesses, so nothing is mixed.
    assert.match(els.seasonBody.innerHTML, /<th scope="row" title="Deepseek V4\.1 Flash 1017">HERMES MCP <em class="bf-kind is-harness" title="bench\.h\.harnessTip">bench\.h\.harness · hermes<\/em><\/th><td>1<\/td><td>1<\/td><td class="sn-places" title="season\.placesTip">1<\/td>/);
    assert.match(els.seasonBody.innerHTML, />pi MCP <em class="bf-kind is-harness" title="bench\.h\.harnessTip">bench\.h\.harness<\/em><\/th>/);
    assert.deepEqual(Array.from(kept[0].seats, x => x.via), ['harness', 'harness:hermes']);
    assert.doesNotMatch(els.seasonBody.innerHTML, /season\.mixed/);
    // Added again, it is still one match.
    await p.addFiles([{ name, text: async () => text }]);
    assert.equal(Page.load().length, 1);
});

test('every string of the page is keyed in all four languages, and it opens and closes as a screen', async () => {
    const context = vm.createContext({ window: {}, navigator: { language: 'en' }, localStorage: { getItem: () => null, setItem() {} },
        document: { documentElement: {}, querySelectorAll: () => [], addEventListener() {} } });
    vm.runInContext(fs.readFileSync(path.join(root, 'js/i18n.js'), 'utf8') + ';this.I = I18N;', context);
    const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    const src = fs.readFileSync(path.join(root, 'js/season-page.js'), 'utf8') + html.split('\n').filter(l => /season|summaryRematchSwapBtn/.test(l)).join('\n');
    const keys = new Set([...src.matchAll(/t\('([a-z]+\.[A-Za-z0-9.]+)'/g)].map(m => m[1]).concat([...src.matchAll(/data-i18n(?:-title)?="([^"]+)"/g)].map(m => m[1])));
    for (const k of ['season.alone', 'season.aloneNote', 'season.unrecorded', 'season.unrecordedNote', 'season.swapApart', 'season.swapTouch', 'season.srcImported', 'season.srcPlayed', 'season.empty', 'season.loading']) keys.add(k);
    for (const k of WarSeason.PARTS) keys.add('eval.' + k);
    keys.delete('eval.'); keys.delete('season.');
    assert.ok(keys.size >= 45, 'only ' + keys.size + ' keys found: did the pattern change?');
    for (const lang of ['en', 'de', 'es', 'zh']) for (const k of keys) assert.ok(k in context.I[lang], lang + ' lacks ' + k);
    assert.doesNotMatch(fs.readFileSync(path.join(root, 'js/season-page.js'), 'utf8').replace(/\/\/.*$/gm, ''), />[A-Z][a-z]+ [a-z]+ [a-z]+</);
    // A screen beside Benchmark: reached from the menu, with the scripts it stands on loaded before it.
    assert.match(html, /<button class="menu-btn" onclick="game\.ui\.benchPage\(\)\.open\(\)"[^>]*>[^<]*<\/button>\s*<button class="menu-btn" onclick="game\.ui\.seasonPage\(\)\.open\(\)" data-i18n="season\.menu">/);
    assert.match(html, /<div id="seasonScreen" class="screen">[\s\S]*<div id="seasonBody"><\/div>/);
    const at = f => html.indexOf('src="' + f + '?');
    assert.ok(at('js/conditions.js') > 0 && at('js/eval/ledger.js') > 0 && at('js/eval/season.js') > at('js/eval/ledger.js') && at('js/season-page.js') > at('js/eval/season.js') && at('js/season-page.js') > at('js/ui.js'));
    const { p, shown } = page();
    await p.open();
    assert.deepEqual([shown.join(), p.returnTo, Array.from(p.samples)], ['seasonScreen', 'startScreen', []]);
    p.close();
    assert.equal(shown.join(), 'seasonScreen,startScreen');
});

test('a finished match joins the table, and a rematch can trade the models\' seats', () => {
    const src = fs.readFileSync(path.join(root, 'js/ui.js'), 'utf8');
    // Kept right after the closing lines are written, from the same results the file carries.
    assert.match(src, /rec\.finish\(\[results, timeline, scores\]\);[\s\S]{0,700}WarSeason\.entryFrom\(\{ header: rec\.matchMeta, contract: this\.game\.openAIAIManager\.contract \|\| null, results, profile: results\.profile, source: 'played' \}[\s\S]{0,120}this\._seasonKept = SeasonPage\.keep\(entry\);/);
    const context = vm.createContext({ console, Date, WarEval, t: k => k, OpenAIAIManager: { MAX_COMMANDS_PER_TURN: 3 }, document: { getElementById: () => null } });
    vm.runInContext(src + '\nthis.UI = UIManager;', context);
    const swap = s => JSON.parse(JSON.stringify(context.UI.swapModelSeats(s)));
    const llm = (civ, name) => ({ civ, type: 'llm', systemPrompt: 'p-' + name, connection: { name } }), who = list => list.map(s => s.civ + ':' + (s.connection ? s.connection.name : s.type + (s.profile || '')));
    // Two models and a rule-based seat: the models trade, the civilizations and the rule-based seat stay.
    const setup = [llm('greek', 'a'), llm('persian', 'b'), { civ: 'egyptian', type: 'ki', profile: 'turtle' }];
    assert.deepEqual(who(swap(setup)), ['greek:b', 'persian:a', 'egyptian:kiturtle']);
    assert.equal(swap(setup)[0].systemPrompt, 'p-b');                              // a model takes its own prompt and connection along
    assert.deepEqual(who(setup), ['greek:a', 'persian:b', 'egyptian:kiturtle']);   // the match that was played is not rewritten
    assert.deepEqual(who(swap(swap(setup))), who(setup));                          // and swapping twice is the first match again
    // Three models move on by one; one model has nobody to trade with.
    assert.deepEqual(who(swap([llm('greek', 'a'), { civ: 'roman', type: 'ki' }, llm('persian', 'b'), llm('maya', 'c')])), ['greek:b', 'roman:ki', 'persian:c', 'maya:a']);
    assert.deepEqual(who(swap([llm('greek', 'a'), { civ: 'roman', type: 'ki' }])), ['greek:a', 'roman:ki']);
    // The season module reads such a pair as one: same seed and civilizations, seats traded.
    const first = match([['a', 0, 1, 70], ['b', 1, 2, 40]], { seed: 's', at: 1 }), second = match([['b', 0, 1, 60], ['a', 1, 2, 50]], { seed: 's', at: 2 });
    assert.equal(WarSeason.table([first, second]).groups[0].swaps[0].pairs, 1);
    const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    assert.match(html, /id="summaryRematchSwapBtn" onclick="game\.ui\.rematchArena\(true\)"/);
    assert.match(html, /id="summarySeasonBtn" onclick="game\.ui\.seasonPage\(\)\.open\(\)"/);
});

test('build 1225: raw models and agent harnesses in one table are tagged, and the table says so', () => {
    const { Page, p } = page();
    const via = (m, vias) => { m.seats.forEach((s, i) => { s.via = vias[i]; }); return m; };
    for (const [a, b] of [[90, 10], [60, 30]]) Page.keep(via(match([['Alpha', 0, 1, a], ['Beta', 1, 2, b]]), ['raw', 'harness:claude-code']));
    p.samples = [];
    const html = p.html();
    assert.match(html, /title="Alpha-model">Alpha <em class="bf-kind is-raw" title="bench\.h\.rawTip">bench\.h\.raw<\/em><\/th>/);
    assert.match(html, /title="Beta-model">Beta <em class="bf-kind is-harness" title="bench\.h\.harnessTip">bench\.h\.harness · claude-code<\/em><\/th>/);
    assert.match(html, /<p class="season-verdict">season\.\w+<\/p><p class="season-verdict">season\.mixed<\/p>/);
    // Two matches: the lowest, the median and the highest, and a tick for each on the track.
    assert.match(html, /<small class="sn-spread">60 · 75 · 90<\/small><i class="sn-range"><u [^>]*><\/u><em style="left:90%"><\/em><em style="left:60%"><\/em><s style="left:75%"><\/s><\/i>/);
    // One match has no spread to show: the words "1 match", as before.
    const one = page();
    one.Page.keep(match([['Alpha', 0, 1, 90], ['Beta', 1, 2, 10]]));
    one.p.samples = [];
    assert.doesNotMatch(one.p.html(), /sn-spread|<em style/);
    // A long history shows its newest twelve placements.
    const long = page();
    for (let i = 0; i < 14; i++) long.Page.keep(match([['Alpha', 0, i < 2 ? 2 : 1, 80], ['Beta', 1, i < 2 ? 1 : 2, 20]]));
    long.p.samples = [];
    assert.match(long.p.html(), /<td class="sn-places" title="season\.placesTip">… 1 · 1 · 1 · 1 · 1 · 1 · 1 · 1 · 1 · 1 · 1 · 1<\/td>/);
    // Every string is keyed in all four languages.
    const ctx = vm.createContext({ window: {}, navigator: { language: 'en' }, localStorage: { getItem: () => null, setItem() {} }, document: { documentElement: {}, querySelectorAll: () => [], addEventListener() {} } });
    vm.runInContext(fs.readFileSync(path.join(root, 'js/i18n.js'), 'utf8') + ';this.I = I18N;', ctx);
    for (const lang of ['en', 'de', 'es', 'zh']) for (const k of ['season.places', 'season.placesTip', 'season.spreadTip', 'season.mixed', 'bench.h.raw', 'bench.h.harness', 'bench.h.rawTip', 'bench.h.harnessTip'])
        assert.ok(k in ctx.I[lang], lang + ' lacks ' + k);
});
