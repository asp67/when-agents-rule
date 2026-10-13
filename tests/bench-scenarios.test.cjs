// WAR Bench scenarios (war-scenario-v1, review #8 step 3). Every scenario must be
// solvable -- its reference solution succeeds in every variant -- and must not be
// solvable by standing still; the format is validated, the variants move everything
// consistently, and an episode is the same every time it is played.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const S = require('../tools/bench/scenario.cjs');

const ALL = S.loadAll();

test('the scenario set: four families, unique ids, filed under their family', () => {
    assert.deepEqual([...new Set(ALL.map(s => s.family))].sort(), ['fog-search', 'grounded-target', 'production-recovery', 'spatial-guard']);
    assert.equal(new Set(ALL.map(s => s.id)).size, ALL.length);
    const dir = path.join(__dirname, '../benchmarks/scenarios');
    for (const s of ALL) assert.ok(fs.existsSync(path.join(dir, s.family, s.id + '.json')), s.id);
});

for (const s of ALL.filter(x => !x.graded)) {
    test(`${s.id}: the reference solves every variant, and doing nothing solves none`, async () => {
        for (const v of s.variants) {
            const ref = await S.play(s, v, S.referencePolicy());
            assert.equal(ref.outcome, 'success', `${s.id}/${v}: reference ${ref.outcome} after ${ref.rounds} rounds`);
            for (const e of ref.log) if (e.results) assert.doesNotMatch(e.results, /\[ERROR\]/, `${s.id}/${v} round ${e.round}: ${e.results}`);
            const noop = await S.play(s, v, S.noopPolicy());
            assert.equal(noop.outcome, 'failure', `${s.id}/${v}: standing still ${noop.outcome}`);
        }
    });
}

// The Benchmark page cannot list a directory: it reads benchmarks/scenarios/index.json.
test('the page\'s scenario index lists exactly the scenario files', () => {
    const index = JSON.parse(fs.readFileSync(path.join(__dirname, '../benchmarks/scenarios/index.json'), 'utf8'));
    assert.deepEqual(index.scenarios.slice().sort(), ALL.map(s => s.family + '/' + s.id + '.json').sort());
});

// fog-search (b1094, asp67): finding the camp is luck, so it is a note, never the score.
// The score is how the search was run: the scouts' share of the marching, new ground
// per round, how many map tiles it reached per round (b1095: a search that stays near
// home must score below one that goes places), and explore orders that carry a route --
// counted only as far as the search reached. The reference, four scouts on four
// separate routes, earns full marks in every variant; the ways models actually fail
// rank below it in the order a player would rank them; standing still earns 0.
test('search-01: the search is graded on how it was run, in the order a player would rank it', async () => {
    const s = ALL.find(x => x.id === 'search-01');
    const W = require('../js/bench-core.js');
    // Written for the identity board and turned with the variant, as the reference is.
    const turned = (v, cmds) => cmds.map(c => ({ action: c.action, params: Object.assign({}, c.params,
        c.params.tile ? { tile: W.tileFor(v, c.params.tile) } : {}, c.params.then ? { then: c.params.then.map(x => W.tileFor(v, x)) } : {}) }));
    const ex = (tile, then) => ({ action: 'explore', params: Object.assign({ tile, unitType: 'scout_cavalry' }, then ? { then } : {}) });
    const policies = {
        reference: () => S.referencePolicy(),
        // Far, but without routes.
        noRoutes: v => ({ round }) => turned(v, round === 1 ? [ex('G1'), ex('G7'), ex('A7')] : round === 2 ? [ex('D4')] : []),
        // Routes, but every stop within two tiles of home.
        confined: v => ({ round }) => turned(v, round === 1 ? [ex('B1', ['C2', 'B3']), ex('A2', ['C1', 'A3']), ex('C3', ['B2', 'C1'])]
            : round === 2 ? [ex('A3', ['C3', 'B1'])] : round % 3 === 0 ? [ex(['B3', 'C2', 'A3', 'C3'][round % 4], ['B2', 'C1'])] : []),
        // One explore a turn, the unit left to the harness: riders first, then slower soldiers.
        onePerTurn: v => ({ round }) => turned(v, [{ action: 'explore', params: { tile: ['G1', 'D4', 'A7', 'G7', 'D7', 'E3', 'C6', 'F2', 'B5', 'E6', 'G5', 'A2'][round - 1] } }]),
        // Everyone onto one far spot -- the camp's own tile, the best a blob can be aimed.
        blob: () => ({ round, episode }) => round === 1 ? [{ action: 'move_units', params: { targetX: episode.realm.tags.camp.x, targetZ: episode.realm.tags.camp.z } }] : [],
        noop: () => S.noopPolicy(),
    };
    for (const v of s.variants) {
        const r = {};
        for (const [k, mk] of Object.entries(policies)) r[k] = await S.play(s, v, mk(v));
        for (const x of Object.values(r)) assert.equal(x.outcome, 'graded', v);
        const line = `${v}: ${Object.entries(r).map(([k, x]) => k + ' ' + x.score).join(', ')}`;
        assert.ok(r.reference.score >= 0.95, `${v}: reference ${r.reference.score} ${JSON.stringify(r.reference.parts)}`);
        assert.deepEqual(Object.keys(r.reference.parts), ['units', 'ground', 'reach', 'routes']);
        assert.ok(r.reference.parts.routes >= 0.95, v + ': reference routes ' + r.reference.parts.routes);
        assert.equal(r.noRoutes.parts.routes, 0);
        assert.ok(r.reference.score > r.noRoutes.score && r.noRoutes.score > r.confined.score && r.onePerTurn.score > r.confined.score, line);
        assert.ok(r.confined.score > r.blob.score, line);
        // Staying home is what reach sees, and what discounts its routes.
        assert.ok(r.confined.parts.reach < 0.4 && r.confined.parts.routes < 0.4, `${v}: confined ${JSON.stringify(r.confined.parts)}`);
        assert.ok(r.blob.parts.units < 0.5 && r.blob.parts.ground < 0.4, `${v}: blob ${JSON.stringify(r.blob.parts)}`);
        assert.equal(W.episodeScore(r.noop), 0);
        // Found or not is recorded, and ends the search, but scores nothing by itself.
        for (const x of Object.values(r)) {
            assert.ok('found' in x.notes);
            if (x.notes.found != null) assert.equal(x.rounds, x.notes.found);
        }
    }
});

test('a variant turns explore tiles with the board', () => {
    const s = ALL.find(x => x.id === 'search-01');
    const ref = v => S.instantiate(s, v).reference[0].commands[0].params;
    assert.deepEqual([ref('identity').tile, ref('identity').then], ['D1', ['G1', 'G4']]);
    assert.deepEqual([ref('rot180').tile, ref('rot180').then], ['D7', ['A7', 'A4']]);
    assert.deepEqual([ref('diagonal').tile, ref('diagonal').then], ['A4', ['A7', 'D7']]);
    assert.deepEqual([ref('mirrorX').tile, ref('mirrorX').then], ['D1', ['A1', 'A4']]);
});

test('an episode is the same every time it is played', async () => {
    const s = ALL.find(x => x.id === 'ford-01');
    const a = await S.play(s, 'rot90', S.referencePolicy()), b = await S.play(s, 'rot90', S.referencePolicy());
    assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test('a variant moves the board, the orders, the predicates and the objective together', async () => {
    const s = ALL.find(x => x.id === 'strike-01');
    for (const v of Object.keys(S.VARIANTS)) {
        const ep = await S.begin(s, v);
        const t = ep.realm.tags.target;
        const [x, z] = S.VARIANTS[v](40, 20);
        assert.deepEqual([t.x, t.z], [x, z], v);
        assert.ok(ep.objective.includes(`(${x}, ${z})`), v + ': ' + ep.objective);
        const ref = ep.inst.reference[0].commands[0].params;
        assert.deepEqual([ref.targetX, ref.targetZ], [x, z], v);
    }
});

test('validation refuses what the format does not allow', () => {
    const base = JSON.parse(JSON.stringify(ALL.find(x => x.id === 'strike-01')));
    const bad = mutate => { const c = JSON.parse(JSON.stringify(base)); mutate(c); return () => S.validate(c); };
    assert.throws(bad(c => { c.schema = 'war-scenario-v0'; }), /schema/);
    assert.throws(bad(c => { c.success.predicate = { destroyed: 'nothing-tagged-so' }; }), /unknown tag/);
    assert.throws(bad(c => { c.success.predicate = { count: { owner: 'subject', kind: 'unit' }, op: '~', value: 1 }; }), /op/);
    assert.throws(bad(c => { c.success.predicate = { eval: 'true' }; }), /unknown operator/);
    assert.throws(bad(c => { c.variants = ['sideways']; }), /unknown variant/);
    assert.throws(bad(c => { c.reference = []; }), /reference/);
    assert.throws(bad(c => { c.reference[0].round = 99; }), /round/);
    assert.throws(bad(c => { c.objective = 'Go to ({{point:nowhere.x}}, 0)'; }), /unknown point/);
});

// b1091 (asp67): an episode that runs out of time is neither a win nor a plain loss. It
// scores the advantage it built -- the scenario's `partial` measure -- capped below a win;
// a stopped "end" scenario never reaches its judgement, so it too is scored on its measure.
test('out of time: the advantage built, never a win, and nothing for standing still', async () => {
    const strike = ALL.find(x => x.id === 'strike-01'), recover = ALL.find(x => x.id === 'recover-01');
    // The warriors reach the barracks in round 4: stopped there, the damage done counts.
    const cut = await S.play(strike, 'identity', S.referencePolicy(), { stopAfter: 4 });
    assert.equal(cut.outcome, 'partial');
    assert.equal(cut.stopped, 'time');
    assert.ok(cut.score > 0 && cut.score < 1, 'score ' + cut.score);
    // Stopped before they arrive: nothing done, nothing earned.
    const early = await S.play(strike, 'identity', S.referencePolicy(), { stopAfter: 2 });
    assert.equal(early.outcome, 'failure');
    // Every soldier needed, but the last round never came: the cap, not a win.
    const held = await S.play(recover, 'identity', S.referencePolicy(), { stopAfter: 9 });
    assert.deepEqual([held.outcome, held.score], ['partial', 0.9]);
    // Run to the end it is judged as always.
    assert.equal((await S.play(recover, 'identity', S.referencePolicy())).outcome, 'success');
    const W = require('../js/bench-core.js');
    assert.deepEqual([cut, early, held].map(W.episodeScore), [cut.score, 0, 0.9]);
    const sc = W.score([cut, early, held]);
    assert.deepEqual(sc.outcomes, { success: 0, partial: 2, failure: 1 });
    assert.equal(sc.meanScore.mean, Math.round((cut.score + 0.9) / 3 * 10000) / 10000);
});

test('validation refuses a measure the format does not have', () => {
    const base = JSON.parse(JSON.stringify(ALL.find(x => x.id === 'strike-01')));
    const bad = mutate => { const c = JSON.parse(JSON.stringify(base)); mutate(c); return () => S.validate(c); };
    assert.throws(bad(c => { c.partial = { health: 'target' }; }), /unknown measure/);
    assert.throws(bad(c => { c.partial = { damage: 'nobody' }; }), /unknown tag/);
    assert.throws(bad(c => { c.partial = { share: { owner: 'subject', kind: 'unit' }, of: 0 }; }), /of > 0/);
    assert.throws(bad(c => { c.partial = { gate: { alive: 'target' }, then: { mean: [] } }; }), /non-empty/);
});

test('a scenario prompt replaces the victory paragraph and nothing else', () => {
    const scope = vm.createContext({ console });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/openai-ai.js'), 'utf8') + ';globalThis.M = OpenAIAIManager;', scope);
    const M = scope.M, base = M.defaultSystemPrompt(), obj = 'Destroy the barracks at (40, 20).';
    const sp = M.scenarioSystemPrompt(obj);
    assert.ok(base.includes(M.VICTORY_PARAGRAPH));
    assert.ok(!sp.includes(M.VICTORY_PARAGRAPH));
    assert.equal(sp.replace('Your objective in this scenario:\n' + obj, M.VICTORY_PARAGRAPH), base);
});

// b1097: each round is a new turn for the seat, as each request is in the arena. The
// executor's "already sent this turn" check keys on the turn count, which scenarios
// never advanced: a unit explored once was refused for the rest of the episode.
test('a unit explored in one round can be sent again in a later one', async () => {
    const s = ALL.find(x => x.id === 'search-01');
    let scout = null;
    const r = await S.play(s, 'identity', ({ round, episode }) => {
        if (round === 1) { scout = episode.subject.units.find(u => u.type === 'scout_cavalry'); return [{ action: 'explore', params: { tile: 'G1', unitIds: [scout.handle] } }]; }
        if (round === 3) return [{ action: 'explore', params: { tile: 'A7', unitIds: [scout.handle] } }];
        return [];
    });
    assert.match(r.log[2].results, new RegExp('OK - Sent your scout_cavalry #' + scout.handle + ' to scout tile A7'), r.log[2].results);
});
