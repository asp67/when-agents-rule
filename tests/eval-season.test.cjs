// The season table (overhaul step C7): js/eval/season.js and tools/eval/season.cjs.
// Held here: that results are added up only under the same conditions and scale, that a
// mean says how sure it is, that nothing is called ahead on one match or while intervals
// touch, and that a seat-swapped pair takes the seat out of the difference.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const root = path.resolve(__dirname, '..');
const WarEval = require(path.join(root, 'js/eval/ledger.js'));
const WarSeason = require(path.join(root, 'js/eval/season.js'));
const { loadConditions, entriesOf, report } = require(path.join(root, 'tools/eval/season.cjs'));
const sample = f => path.join(root, 'samples', f);
const HAS_SAMPLES = fs.existsSync(path.join(root, 'samples', 'index.json'));

// A match on paper: [name, seat, rank, Index] per model seat, all under conditions `cond`.
let serial = 0;
const scoresOf = v => typeof v === 'number' ? { grounding: v, planning: v, follow: v, tactical: v, strategy: v, index: v } : Object.assign({ grounding: null, planning: null, follow: null, tactical: null, strategy: null, index: null }, v);
const match = (seats, o = {}) => ({ v: 1, scale: o.scale || 'v1', matchId: o.id || 'm' + (++serial), at: o.at || serial, build: o.build || 1162,
    mapSeed: o.seed === undefined ? 'seed-' + serial : o.seed, layout: o.layout || 'greek,persian', players: seats.length, source: 'test',
    seats: seats.map(([name, seat, rank, v, cond]) => ({ id: name + seat, seat, name, model: name + '-model', rank, of: seats.length, winner: rank === 1,
        cond: cond === undefined ? (o.cond === undefined ? 'cond-a' : o.cond) : cond, protocol: 'turn-based', core: 'core', scores: scoresOf(v) })) });
const row = (g, name) => g.models.find(m => m.name === name);

test('a mean comes with its interval, one match has none, and the interval stays inside the scale', () => {
    assert.deepEqual(WarSeason.interval([70]), { mean: 70, lo: null, hi: null, n: 1, sd: null });
    assert.deepEqual(WarSeason.interval([]), { mean: null, lo: null, hi: null, n: 0, sd: null });
    // 60, 70, 80: sd 10, t(2) = 4.303, half = 4.303 x 10 / sqrt(3) = 24.8.
    assert.deepEqual(WarSeason.interval([60, 70, 80]), { mean: 70, lo: 45.2, hi: 94.8, n: 3, sd: 10 });
    // Two matches far apart say almost nothing: the interval is the whole scale, not beyond it.
    assert.deepEqual(WarSeason.interval([10, 90]), { mean: 50, lo: 0, hi: 100, n: 2, sd: 56.6 });
    assert.deepEqual([WarSeason.interval([-30, 50], -100, 100).lo, WarSeason.interval([-30, 50], -100, 100).hi], [-100, 100]);
    assert.deepEqual(WarSeason.interval([null, 40, undefined, NaN]).n, 1);        // a part with no score is not a zero
});

test('ahead means apart: at least two matches on both sides, and intervals that do not touch', () => {
    const I = WarSeason.interval;
    assert.equal(WarSeason.separated(I([80, 82, 81]), I([40, 42, 41])), true);
    assert.equal(WarSeason.separated(I([80, 82, 81]), I([40])), false);            // one match on one side
    assert.equal(WarSeason.separated(I([99]), I([1])), false);                     // one match each, however far apart
    assert.equal(WarSeason.separated(I([70, 80, 75]), I([60, 72, 66])), false);    // close: the intervals touch
    assert.equal(WarSeason.apartFromZero(I([8, 10, 9], -100, 100)), true);
    assert.equal(WarSeason.apartFromZero(I([8, -6, 3], -100, 100)), false);
    assert.equal(WarSeason.apartFromZero(I([12], -100, 100)), false);
});

test('a single match never makes a leader, and close results stay "not separated"', () => {
    // One match, 90 against 10: no leader on any part.
    let t = WarSeason.table([match([['A', 0, 1, 90], ['B', 1, 2, 10]])]);
    assert.equal(t.groups.length, 1);
    assert.deepEqual(Object.values(t.groups[0].leaders), [null, null, null, null, null, null]);
    assert.deepEqual([row(t.groups[0], 'A').parts.index, row(t.groups[0], 'A').matches], [{ mean: 90, lo: null, hi: null, n: 1, sd: null }, 1]);
    // Three matches each, clearly apart: A is ahead, on every part.
    t = WarSeason.table([[90, 10], [88, 14], [92, 12]].map(([a, b]) => match([['A', 0, 1, a], ['B', 1, 2, b]])));
    assert.deepEqual(Object.values(t.groups[0].leaders), Array(6).fill(WarSeason.modelKey({ name: 'A', model: 'A-model' })));
    assert.deepEqual([row(t.groups[0], 'A').firsts, row(t.groups[0], 'B').firsts, t.groups[0].matches], [3, 0, 3]);
    // Three matches each, close: nobody is.
    t = WarSeason.table([[70, 60], [80, 72], [75, 66]].map(([a, b]) => match([['A', 0, 1, a], ['B', 1, 2, b]])));
    assert.deepEqual(Object.values(t.groups[0].leaders), Array(6).fill(null));
    // Ahead of one rival but not of the other is not ahead.
    t = WarSeason.table([[90, 10, 85], [88, 14, 91], [92, 12, 88]].map(([a, b, c]) => match([['A', 0, 1, a], ['B', 1, 3, b], ['C', 2, 2, c]])));
    assert.equal(t.groups[0].leaders.index, null);
    // A part one model has no score for is left out of that part's comparison, not counted as zero.
    t = WarSeason.table([1, 2, 3].map(i => match([['A', 0, 1, { index: 80 + i, tactical: 90 + i }], ['B', 1, 2, { index: 20 + i }]])));
    assert.deepEqual([t.groups[0].leaders.index === WarSeason.modelKey({ name: 'A', model: 'A-model' }), t.groups[0].leaders.tactical, row(t.groups[0], 'B').parts.tactical.n], [true, null, 0]);
});

test('only the same conditions and the same scale are added up; the rest are groups of their own', () => {
    const t = WarSeason.table([
        match([['A', 0, 1, 80], ['B', 1, 2, 40]], { id: 'x1' }),
        match([['A', 0, 1, 84], ['B', 1, 2, 44]], { id: 'x2' }),
        match([['A', 0, 1, 20], ['B', 1, 2, 90]], { id: 'y1', cond: 'cond-b' }),          // another harness or build
        match([['A', 0, 1, 10], ['B', 1, 2, 95]], { id: 'z1', scale: 'v0' }),             // scored on another scale
        match([['A', 0, 1, 80], ['B', 1, 2, 40]], { id: 'x1' }),                          // the same match again: counted once
        match([['A', 0, 2, 55, 'cond-a'], ['C', 1, 1, 60, 'cond-c']], { id: 'w1' }),      // one match, two families of contract
        match([['Old', 0, 1, 70], ['Older', 1, 2, 30]], { id: 'o1', cond: null }),        // conditions not recorded
    ]);
    assert.equal(t.matches, 6);
    const ids = t.groups.map(g => g.id + '/' + g.scale + ':' + g.matches).sort();
    assert.deepEqual(ids, ['cond-a/v0:1', 'cond-a/v1:3', 'cond-b/v1:1']);
    const main = t.groups.find(g => g.id === 'cond-a' && g.scale === 'v1');
    assert.deepEqual([row(main, 'A').matches, row(main, 'A').parts.index.mean, row(main, 'B').matches, row(main, 'B').parts.index.mean], [3, 73, 2, 42]);
    // C sat alone under its conditions in its one match: listed, not tabled.
    assert.deepEqual(t.alone.map(a => [a.name, a.cond, a.scores.index]), [['C', 'cond-c', 60]]);
    // And what has no recorded conditions is compared with nothing, not even its own match.
    assert.deepEqual(t.unrecorded.map(u => u.name), ['Old', 'Older']);
    assert.equal(t.groups.some(g => g.models.some(m => m.name === 'Old')), false);
});

test('head to head counts who placed above whom when two models met', () => {
    const t = WarSeason.table([match([['A', 0, 1, 80], ['B', 1, 2, 40]]), match([['A', 0, 2, 50], ['B', 1, 1, 70]]), match([['A', 0, 1, 80], ['B', 1, 3, 40], ['C', 2, 2, 60]]),
        match([['A', 0, 1, 80]])]);
    const h = Object.fromEntries(t.groups[0].headToHead.map(x => [WarSeason.label(x.a) + WarSeason.label(x.b), [x.met, x.aAhead, x.bAhead]]));
    assert.deepEqual(h, { AB: [3, 2, 1], AC: [1, 1, 0], BC: [1, 0, 1] });
});

test('a seat-swapped pair takes the seat out of the difference', () => {
    // Seat 0 is worth 20 points on this map. A is 10 better than B.
    const first = match([['A', 0, 1, 70], ['B', 1, 2, 40]], { seed: 'map-1', at: 1 });
    const swap = match([['B', 0, 1, 60], ['A', 1, 2, 50]], { seed: 'map-1', at: 2 });
    let t = WarSeason.table([first, swap]);
    let s = t.groups[0].swaps[0];
    assert.deepEqual([WarSeason.label(s.a), WarSeason.label(s.b), s.pairs, s.diff.index.mean, s.diff.index.n], ['A', 'B', 1, 10, 1]);
    assert.equal(WarSeason.apartFromZero(s.diff.index), false);                     // one pair is one sample
    // Three such pairs on three maps: 10, 12 and 8 apart, and that is apart from zero.
    const pairs = [[70, 40, 60, 50], [75, 41, 61, 51], [66, 42, 58, 50]].flatMap(([a0, b1, b0, a1], i) => [
        match([['A', 0, 1, a0], ['B', 1, 2, b1]], { seed: 'map-' + i, at: 10 * i + 1 }), match([['B', 0, 1, b0], ['A', 1, 2, a1]], { seed: 'map-' + i, at: 10 * i + 2 })]);
    t = WarSeason.table(pairs);
    s = t.groups[0].swaps[0];
    assert.deepEqual([s.pairs, s.diff.index.mean, s.diff.index.n, WarSeason.apartFromZero(s.diff.index)], [3, 10, 3, true]);
    // Not a swapped pair: the same seats again (a plain rematch), another map, or other civilizations in the seats.
    const again = match([['A', 0, 1, 72], ['B', 1, 2, 38]], { seed: 'map-1', at: 3 });
    assert.deepEqual(WarSeason.table([first, again]).groups[0].swaps, []);
    assert.deepEqual(WarSeason.table([first, match([['B', 0, 1, 60], ['A', 1, 2, 50]], { seed: 'map-9' })]).groups[0].swaps, []);
    assert.deepEqual(WarSeason.table([first, match([['B', 0, 1, 60], ['A', 1, 2, 50]], { seed: 'map-1', layout: 'roman,maya' })]).groups[0].swaps, []);
    assert.deepEqual(WarSeason.table([first, match([['B', 0, 1, 60], ['A', 1, 2, 50]], { seed: null })]).groups[0].swaps, []);
    // A match is used in one pair only: first + swap pair up, the third finds no partner.
    assert.equal(WarSeason.table([first, swap, match([['B', 0, 1, 61], ['A', 1, 2, 49]], { seed: 'map-1', at: 4 })]).groups[0].swaps[0].pairs, 1);
});

test('an entry is what a transcript says: conditions by the one rule, placement by the results, scores by the ledger', { skip: !HAS_SAMPLES }, () => {
    const file = '2026-11-07_pi-hy4-hermes-deepseek-v4.1_12min.jsonl', text = fs.readFileSync(sample(file), 'utf8');
    const C = loadConditions();
    const e = WarSeason.entryOf(text, { evaluator: WarEval, conditions: C, source: 'sample', file });
    const lines = text.split('\n').filter(Boolean).map(l => JSON.parse(l));
    const header = lines.find(o => o.type === 'match'), contract = lines.find(o => o.type === 'contract'), results = lines.find(o => o.type === 'results');
    assert.deepEqual([e.matchId, e.build, e.scale, e.mapSeed, e.layout, e.players, e.source, e.file], [header.matchId, 1147, 'v2', 'rmw6l1lw4lumm', 'greek,persian', 2, 'sample', file]);
    const profile = WarEval.profileOf(text);
    for (const s of e.seats) {
        const p = profile.seats.find(x => x.id === s.id), r = results.ranking.find(x => x.playerId === s.id);
        assert.equal(s.cond, C.id(C.seat(header, contract, s.id)));
        assert.deepEqual([s.rank, s.of, s.winner], [r.rank, 2, !!r.isWinner]);
        assert.deepEqual(s.scores, { grounding: p.grounding.score, planning: p.planning.score, follow: p.follow.score, tactical: p.tactical.score, strategy: p.strategy.score, index: p.index.value });
    }
    assert.deepEqual(e.seats.map(s => [s.name, s.cond, s.protocol, s.rank]), [['pi MCP', 'ba441132b2b0', 'turn-based', 2], ['HERMES MCP', 'ba441132b2b0', 'turn-based', 1]]);
    // A file from before conditions were recorded: an entry whose seats are comparable with nothing.
    const old = fs.readdirSync(path.join(root, 'samples')).find(f => f.startsWith('2026-08-17'));
    const o = WarSeason.entryOf(fs.readFileSync(sample(old), 'utf8'), { evaluator: WarEval, conditions: C });
    assert.ok(o.seats.length >= 3 && o.seats.every(s => s.cond === null));
    assert.equal(WarSeason.entryOf('not a transcript\n{"turn":1}', { evaluator: WarEval, conditions: C }), null);
});

test('the shipped matches: three meetings of two harnesses are a comparison, and the table says how far it goes', { skip: !HAS_SAMPLES }, () => {
    const files = fs.readdirSync(path.join(root, 'samples')).filter(f => f.startsWith('2026-11-07')).map(sample);
    const t = WarSeason.table(entriesOf(files));
    assert.deepEqual([t.matches, t.groups.length, t.alone.length, t.unrecorded.length], [3, 1, 0, 0]);
    const g = t.groups[0], hermes = row(g, 'HERMES MCP'), pi = row(g, 'pi MCP');
    assert.deepEqual([g.id, g.protocol, g.builds, g.scale, hermes.matches, hermes.firsts, pi.firsts], ['ba441132b2b0', 'turn-based', [1147], 'v2', 3, 3, 0]);
    // Hermes won all three and is ahead on Strategy, and on Follow-through, where it carried out every step in all three. On the Index, 79.5 against 30.6, it is not: three matches leave the intervals touching.
    assert.deepEqual([g.leaders.strategy === hermes.key, g.leaders.index, g.leaders.grounding, g.leaders.planning], [true, null, null, null]);
    assert.deepEqual([hermes.parts.index.mean, pi.parts.index.mean, WarSeason.separated(hermes.parts.index, pi.parts.index)], [79.5, 30.6, false]);
    assert.deepEqual([g.leaders.follow === hermes.key, hermes.parts.follow.mean, hermes.parts.follow.sd, pi.parts.follow.mean], [true, 100, 0, 73.9]);
    assert.deepEqual(g.headToHead.map(h => [WarSeason.label(h.a), WarSeason.label(h.b), h.met, h.aAhead, h.bAhead]), [['HERMES MCP', 'pi MCP', 3, 3, 0]]);
    assert.deepEqual(g.swaps, []);                                                 // three different maps: no swapped pair among them
    const text = report(t);
    assert.match(text, /3 matches: 1 sets of conditions with something to add up or compare/);
    assert.match(text, /CONDITIONS ba441132b2b0 +turn-based, build 1147, scale v2, 3 matches/);
    assert.match(text, /HERMES MCP +3 +3 .*86\.0 \[75\.7 to 96\.3\] \* +79\.5 \[44\.4 to 100\.0\]/);
    assert.match(text, /\* ahead of every other model here: the intervals do not touch\. Elsewhere: not separated yet\./);
    assert.match(text, /HERMES MCP v pi MCP: met 3, HERMES MCP placed above 3, pi MCP 0/);
});

test('samples/season.json is what the shipped matches give, on this build\'s scale', { skip: !HAS_SAMPLES }, () => {
    const stored = JSON.parse(fs.readFileSync(sample('season.json'), 'utf8'));
    const files = fs.readdirSync(path.join(root, 'samples')).filter(f => f.endsWith('.jsonl')).sort().map(sample);
    const fresh = JSON.parse(JSON.stringify(entriesOf(files, { source: 'sample' })));
    assert.deepEqual([stored.kind, stored.scale, stored.entries.length], ['war-season-entries/1', WarEval.SCALE, files.length]);
    assert.deepEqual(stored.entries, fresh, 'run: node tools/eval/season.cjs samples --write samples/season.json');
    const t = WarSeason.table(stored.entries);
    assert.deepEqual([t.matches, t.groups.length, t.alone.length, t.unrecorded.length], [20, 10, 14, 26]);
    // Nowhere in the shipped matches is a model ahead of another on the Index.
    assert.equal(t.groups.some(g => g.leaders.index), false);
});
