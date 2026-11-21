// The evaluation ledger (overhaul step C1): js/eval/ledger.js, its command-line twin and
// its hook in the transcript recorder. Three things are held here:
//   - the numbers on three shipped matches, so a change to the rules of counting shows;
//   - that the ledger, reading only per-command outcomes, arrives at what the harness
//     counted for itself during the match, on every shipped match that records them;
//   - that a match in progress and its exported file give the same profile.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const WarEval = require(path.join(root, 'js/eval/ledger.js'));
const { profileFile, report } = require(path.join(root, 'tools/eval/war-eval.cjs'));
const sample = f => path.join(root, 'samples', f);
const samples = fs.readdirSync(path.join(root, 'samples')).filter(f => f.endsWith('.jsonl')).sort();

// name, decisions, ok, avoidable, invalid, contended, not judged, repeated, score,
// latency median and p90 (ms), tokens in and out per decision (median), completion tokens
// per ok command, commands per decision, empty decisions, missed rounds, cancelled
// requests, most frequent mistake.
const PINNED = {
    '2026-10-05_gpt6.1-sol-claude-sonnet5.5-deepseek-v4.1-glm5.3_99min.jsonl': [
        ['O gpt-6.1-sol', 87, 78, 3, 0, 1, 1, 0, 61.5, 4816, 6249, 19332, 93, 103, 0.954, 4, 0, 0, 'notDiscovered'],
        ['O claude-sonnet-5.5', 128, 349, 2, 0, 5, 1, 0, 94.3, 6472, 10569, 72032, 563, 238, 2.789, 0, 0, 0, 'commandLimit'],
        ['O deepseek-v4.1-flash', 128, 354, 11, 0, 4, 2, 2, 69.9, 8974, 21991, 57415, 1804.5, 801, 2.898, 1, 0, 0, 'noTCWorkers'],
        ['DGX GLM5.3 Flash', 126, 321, 11, 0, 2, 0, 0, 66.3, 41543, 73085, 42176, 744.5, 320, 2.651, 0, 1, 1, 'populationLimit'],
    ],
    '2026-10-17_gemini-4-argon-qwen3.8-flashnext-q2_0-qwen3.8-flashnext-nvfp4_68min.jsonl': [
        ['DGX Qwen3.8 flash next nvfp4', 82, 215, 12, 0, 2, 0, 2, 47.1, 36289, 74921, 8140, 1500.5, 654, 2.793, 0, 2, 0, 'assignFromEmpty'],
        ['RTX qwen3.8 flash next Q2_0', 52, 137, 2, 0, 1, 0, 0, 85.6, 30982, 45172, 12656.5, 1761.5, 706, 2.692, 0, 0, 0, 'unitBuildingNotBuilt'],
        ['O gemini-4-argon', 84, 229, 0, 0, 8, 0, 0, 100, 8635, 19633, 34700.5, 264, 139, 2.821, 0, 0, 0, null],
    ],
    // Two MCP seats: their harnesses report no token usage, and that reads as "not
    // reported", never as zero.
    '2026-11-07_pi-hy4-hermes-deepseek-v4.1_12min.jsonl': [
        ['pi MCP', 40, 56, 6, 0, 5, 1, 5, 0, 13, 22, null, null, null, 1.7, 0, 0, 0, 'noTCWorkers'],
        ['HERMES MCP', 39, 108, 1, 0, 2, 0, 0, 90.8, 4952, 18946, null, null, null, 2.846, 0, 0, 1, 'populationLimit'],
    ],
};
const row = s => {
    const g = s.grounding, e = s.efficiency, t = e.tokens;
    return [s.name, s.decisions, g.ok, g.avoidable, g.invalid, g.contended, g.unjudged, g.repeated, g.score,
        e.latencyMs && Math.round(e.latencyMs.median), e.latencyMs && Math.round(e.latencyMs.p90),
        t && t.promptMedian, t && t.completionMedian, t && Math.round(t.completionPerOk),
        +e.commandsPerDecision.toFixed(3), e.emptyDecisions, e.missedRounds, e.cancelledRequests,
        (g.mistakes[0] || {}).code || null];
};

for (const [file, want] of Object.entries(PINNED)) {
    test('the profile of ' + file.slice(0, 10) + ' (' + want.length + ' seats) is what it was', async () => {
        const p = await profileFile(sample(file));
        assert.deepEqual(p.seats.map(row), want);
        assert.equal(p.kind, 'war-eval/1'); assert.equal(p.scale, 'v1'); assert.equal(p.unreadable, 0);
        // valid = ok of ok + avoidable + invalid with the waits left out, and the score is the mapping of it.
        for (const s of p.seats) {
            const g = s.grounding;
            assert.equal(g.judged, g.ok + g.avoidable + g.invalid);
            assert.equal(g.rated, g.judged - g.waits);
            assert.equal(g.rate, (g.ok - g.waits) / g.rated);
            assert.equal(g.score, Math.round(1000 * Math.max(0, 1 - (1 - g.rate) * 10)) / 10);
        }
    });
}

test('the ledger arrives at the harness\'s own counts on every shipped match that records outcomes', () => {
    let checked = 0;
    for (const file of samples) {
        const text = fs.readFileSync(sample(file), 'utf8'), p = WarEval.profileOf(text);
        const results = JSON.parse(text.split('\n').find(l => l.startsWith('{"type":"results"')));
        for (const s of p.seats) {
            const m = results.ranking.find(r => r.playerId === s.id).metrics, g = s.grounding, e = s.efficiency;
            assert.equal(e.missedRounds, m.roundsMissed || 0, file + ' ' + s.name + ': missed rounds');
            if (!g.judged) {
                // Before build 1023 no outcome was written: nothing is judged, nothing is guessed.
                assert.deepEqual([g.rate, g.score, g.ok], [null, null, 0], file + ' ' + s.name);
                continue;
            }
            assert.deepEqual([g.ok, g.avoidable, g.invalid, g.contended],
                [m.succeeded, m.rejected, m.invalidActions, m.contended || 0], file + ' ' + s.name + ': verdicts');
            // The harness counts a request it sent; the ledger a decision that came back.
            assert.equal(s.decisions, m.decisions - (m.roundsMissed || 0), file + ' ' + s.name + ': decisions');
            if (e.tokens) assert.deepEqual([e.tokens.promptTotal, e.tokens.completionTotal], [m.promptTokens, m.completionTokens], file + ' ' + s.name + ': tokens');
            else assert.deepEqual([m.promptTokens, m.completionTokens], [0, 0], file + ' ' + s.name + ': no usage reported');
            checked++;
        }
    }
    // 39 seats in 13 matches when this was written; more as matches are added.
    assert.ok(checked >= 39, 'only ' + checked + ' seats had outcomes to check');
});

test('the order in which different seats\' lines arrive changes nothing', () => {
    const lines = fs.readFileSync(sample(Object.keys(PINNED)[0]), 'utf8').split('\n').filter(Boolean);
    const inFile = WarEval.createLedger();
    lines.forEach(l => inFile.addLine(l));
    // As a live match writes them: by the moment each was stamped, seats interleaved.
    const stamped = lines.map((l, i) => ({ l, i, at: (JSON.parse(l).at) || 0 })).sort((a, b) => a.at - b.at || a.i - b.i);
    const live = WarEval.createLedger();
    stamped.forEach(x => live.addLine(x.l));
    assert.notDeepEqual(stamped.map(x => x.i), lines.map((_, i) => i));   // it really is another order
    assert.deepEqual(live.profile(), inFile.profile());
});

test('a match in progress and its exported file give the same profile', async () => {
    class Blob { constructor(parts) { this.text = parts.join(''); } }
    const context = vm.createContext({ console, navigator: {}, Blob, Date, WarEval });
    vm.runInContext(fs.readFileSync(path.join(root, 'js/transcript.js'), 'utf8') + '\nthis.T = TranscriptRecorder;', context);
    const rec = new context.T();
    await rec.begin('match-x', [{ id: 'a', civilization: 'greek', seat: 0, name: 'Seat A', model: 'model-a' },
        { id: 'b', civilization: 'persian', seat: 1, name: 'Seat B', model: 'model-b' }], { build: 1151, promptVersion: 'v-test' });
    const out = (...v) => v.map((x, i) => ({ n: i + 1, action: 'train_unit', code: x === 'ok' ? 'trainUnit' : x === 'contended' ? 'trainerBusy' : 'cannotAfford', verdict: x }));
    // Seat a states a plan at its first decision and rewrites it when it is attacked; seat b never does.
    const plans = { 1: { objective: 'Boom, then strike', plan: ['Train workers', 'Build a barracks', 'Stay flexible'] },
        21: { plan: ['Build a tower', 'Attack the persians'] } };
    const turn = (id, n, latencyMs, tokens) => rec.record(id, { at: 1000 + n, latencyMs, tokens,
        state: { clock: { matchSeconds: n * 10 }, population: { used: 10 + n },
            buildings: { buildable: [{ type: 'barracks' }, { type: 'tower' }] }, gameStats: { opponents: [{ id: 'persian-2', civilization: 'persian' }] },
            threats: { underAttack: n >= 20 && n < 23 ? [{ kind: 'unit', type: 'worker' }] : [], enemyWonders: [] } },
        parsed: Object.assign({ commands: [{ action: 'train_unit' }, { action: 'train_unit' }] }, id === 'a' ? plans[n] : null) });
    for (let n = 1; n <= 30; n++) {
        // The two seats interleave, and a carries NaN and undefined where JSON has none.
        turn('a', n, n % 7 ? 2000 + n : NaN, { prompt: 9000 + n, completion: 300 + n, cached: undefined });
        turn('b', n, 500 + n, null);
        rec.noteResult('b', 'ok', undefined, out('ok', n % 5 ? 'ok' : 'avoidable'));
        rec.noteInput({ type: 'input', kind: 'observe', playerId: 'a', step: n });
        if (n % 4) rec.noteResult('a', 'ok', undefined, out('ok', n % 3 ? 'ok' : 'contended'));   // every fourth: no result
        if (n === 12) rec.note('a', { type: 'round_missed', round: 12 });
    }
    rec.finish([{ type: 'results', outcome: 'last_standing' }, { type: 'timeline', samples: [] }]);
    const exported = WarEval.profileOf((await rec.exportBlob()).text);
    const live = rec.ledger.profile();
    assert.deepEqual(live, exported);
    // And it is a profile with something in it, not two empty ones agreeing.
    const [a, b] = live.seats;
    assert.deepEqual([a.name, a.decisions, a.efficiency.missedRounds, a.efficiency.tokens.n], ['Seat A', 30, 1, 30]);
    assert.deepEqual([a.grounding.ok, a.grounding.contended, a.grounding.unjudged], [38, 8, 14]);
    assert.equal(a.efficiency.latencyMs.n, 26);                       // the NaN ones are not latencies
    assert.deepEqual([b.grounding.ok, b.grounding.avoidable, b.grounding.repeated, b.efficiency.tokens], [54, 6, 0, null]);
    assert.equal(live.match.build, 1151);
    // Planning travels the same road: a's two statements, the attack at decision 20
    // answered at 21, and b, who was attacked too and never stated anything.
    assert.deepEqual([a.planning.statements, a.planning.revisions, a.planning.steps, a.planning.concrete], [2, 2, 5, 4]);
    assert.deepEqual([a.planning.shocks.n, a.planning.shocks.revised, a.planning.standing.objective], [1, 1, 'Boom, then strike']);
    assert.deepEqual([b.planning.statements, b.planning.score, b.planning.shocks.n, b.planning.standing], [0, 0, 1, null]);
    // The next match starts a fresh ledger.
    await rec.begin('match-y', [], {});
    assert.equal(rec.ledger.profile().seats.length, 0);
});

test('the recorder works without the ledger loaded', async () => {
    class Blob { constructor(parts) { this.text = parts.join(''); } }
    const context = vm.createContext({ console, navigator: {}, Blob, Date });
    vm.runInContext(fs.readFileSync(path.join(root, 'js/transcript.js'), 'utf8') + '\nthis.T = TranscriptRecorder;', context);
    const rec = new context.T();
    await rec.begin('m', [{ id: 'a', civilization: 'greek', seat: 0 }], {});
    rec.record('a', { parsed: { commands: [] } }); rec.noteResult('a', 'ok');
    assert.equal(rec.ledger, null);
    assert.equal((await rec.exportBlob()).text.split('\n').filter(Boolean).length, 2);
});

// ---- the rules of counting, one at a time --------------------------------------------
const turnLine = (playerId, outcomes, extra) => JSON.stringify(Object.assign({ turn: 1, playerId,
    parsed: { commands: (outcomes || []).map(() => ({ action: 'x' })) },
    outcomes: outcomes ? outcomes.map(([verdict, code], i) => ({ n: i + 1, action: 'x', code, verdict })) : undefined }, extra));
const grounding = lines => { const l = WarEval.createLedger(); lines.forEach(x => l.addLine(x)); return l.profile().seats[0].grounding; };

test('a wait can never be refused, so it is counted and left out of the rate', () => {
    const wait = (verdict = 'ok') => ({ n: 1, action: 'wait', code: 'waited', verdict });
    const line = outcomes => JSON.stringify({ turn: 1, playerId: 'a', parsed: { commands: outcomes.map(o => ({ action: o.action })) }, outcomes });
    const act = (verdict, code = 'c') => ({ n: 1, action: 'train_unit', code, verdict });
    // 18 orders that worked, 2 refused, and 20 waits: 90 % valid, not 95 %.
    let g = grounding([line(Array.from({ length: 18 }, () => act('ok')).concat([act('avoidable', 'cannotAfford'), act('avoidable', 'cannotAfford')], Array.from({ length: 20 }, () => wait())))]);
    assert.deepEqual([g.judged, g.ok, g.waits, g.rated, g.rate, g.score], [40, 38, 20, 20, 0.9, 0]);
    // Only waits: counted as the harness counts them, and nothing to rate. A dash, not 100.
    g = grounding([line([wait()]), line([wait()]), line([wait()])]);
    assert.deepEqual([g.judged, g.ok, g.waits, g.rated, g.rate, g.score], [3, 3, 3, 0, null, null]);
    // A wait that was refused is a mistake like any other.
    g = grounding([line([wait('invalid'), act('ok')])]);
    assert.deepEqual([g.waits, g.rated, g.invalid, g.rate], [0, 2, 1, 0.5]);
    // Across the shipped matches the counts stay the harness's own: waits are among the ok.
    for (const f of samples) for (const s of WarEval.profileOf(fs.readFileSync(sample(f), 'utf8')).seats) assert.ok(s.grounding.waits <= s.grounding.ok, f);
});

test('contended commands and the harness\'s own failures leave both sides of the rate', () => {
    const g = grounding([turnLine('a', [['ok', 'k'], ['ok', 'k'], ['contended', 'trainerBusy'], ['harnessFault', 'executionFailed'], ['avoidable', 'cannotAfford']])]);
    assert.deepEqual([g.judged, g.ok, g.avoidable, g.contended, g.harnessFault], [3, 2, 1, 1, 1]);
    assert.equal(g.rate, 2 / 3);
    assert.equal(g.score, 0);                               // a third refused: far past one in ten
    assert.equal(grounding([turnLine('a', [['ok', 'k'], ['contended', 'trainerBusy']])]).score, 100);
});

test('a mistake counts as repeated when the same one was made in the last two decisions', () => {
    const miss = code => turnLine('a', [['avoidable', code]]), fine = turnLine('a', [['ok', 'k']]);
    assert.equal(grounding([miss('cannotAfford'), miss('cannotAfford')]).repeated, 1);
    assert.equal(grounding([miss('cannotAfford'), fine, miss('cannotAfford')]).repeated, 1);
    assert.equal(grounding([miss('cannotAfford'), fine, fine, miss('cannotAfford')]).repeated, 0);   // three decisions on
    assert.equal(grounding([miss('cannotAfford'), miss('populationLimit')]).repeated, 0);            // another mistake
    // Twice in ONE decision is one decision's mistake, not a repeat of an earlier one.
    assert.equal(grounding([turnLine('a', [['avoidable', 'cannotAfford'], ['avoidable', 'cannotAfford']])]).repeated, 0);
    const g = grounding([miss('cannotAfford'), miss('cannotAfford'), miss('populationLimit')]);
    assert.deepEqual(g.mistakes, [{ code: 'cannotAfford', n: 2 }, { code: 'populationLimit', n: 1 }]);
    assert.equal(g.repeatRate, 1 / 3);
    // An invented action is a mistake like any other.
    assert.equal(grounding([turnLine('a', [['invalid', 'notACommand']]), turnLine('a', [['invalid', 'notACommand']])]).repeated, 1);
});

test('a command nobody recorded an outcome for is not judged, and nothing is guessed', () => {
    const none = grounding([turnLine('a', null, { parsed: { commands: [{}, {}] } })]);
    assert.deepEqual([none.judged, none.unjudged, none.rate, none.score, none.repeatRate], [0, 2, null, null, null]);
    const early = grounding([JSON.stringify({ turn: 1, playerId: 'a', parsed: { action: 'train_unit', params: {} } })]);
    assert.equal(early.unjudged, 1);                         // the single-command reply of early builds
    const part = grounding([turnLine('a', [['ok', 'k']], { parsed: { commands: [{}, {}, {}] } })]);
    assert.deepEqual([part.ok, part.unjudged], [1, 2]);
    const odd = grounding([turnLine('a', [['brand-new-verdict', 'k'], ['ok', 'k']])]);
    assert.deepEqual([odd.ok, odd.judged], [1, 1]);          // an unknown verdict is not counted as anything
});

test('lines that are not a seat\'s decisions are not counted as one', () => {
    const l = WarEval.createLedger();
    l.addLine(JSON.stringify({ type: 'match', matchId: 'm', build: 7, players: [{ id: 'a', seat: 1, civ: 'greek', model: 'mm', name: 'A' }, { id: 'b', seat: 0 }] }));
    l.addLine(JSON.stringify({ type: 'input', kind: 'observe', playerId: 'zz', step: 0 }));
    l.addLine(JSON.stringify({ type: 'chronicle', kind: 'battle' }));
    l.addLine(JSON.stringify({ type: 'final_word', playerId: 'a', text: 'gg' }));
    l.addLine(JSON.stringify({ type: 'request_failed', playerId: 'a' }));
    l.addLine('{"turn":1,"playerId":"a","parsed":{"commands":[]}');   // cut off by a crash
    l.addLine('{}');
    l.addLine('');
    const p = l.profile();
    assert.deepEqual(p.seats.map(s => [s.id, s.seat, s.decisions]), [['b', 0, 0], ['a', 1, 0]]);   // in seat order
    assert.equal(p.unreadable, 1);
    assert.deepEqual([p.seats[1].efficiency.failedRequests, p.seats[1].efficiency.commandsPerDecision, p.seats[1].efficiency.latencyMs], [1, null, null]);
    assert.deepEqual(p.match, { matchId: 'm', build: 7, promptVersion: null });
});

test('the command-line report says so when a file predates recorded outcomes', async () => {
    const old = samples.find(f => f.startsWith('2026-08-17'));
    const text = report(old, await profileFile(sample(old)));
    assert.match(text, /recorded from build 1023 on/);
    assert.match(text, /build not recorded/);
    const mcp = report('x.jsonl', await profileFile(sample('2026-11-07_pi-hy4-hermes-deepseek-v4.1_12min.jsonl')));
    assert.match(mcp, /not reported/);
    assert.match(mcp, /pi MCP +0 +89\.1 % +56 +7 /);            // seven of its 56 were waits
    assert.doesNotMatch(mcp, /recorded from build 1023/);
});

// ---- planning (step C2) ------------------------------------------------------------------
// name, score, plan statements, of which changed the plan, decision of the first plan,
// share of decisions under a plan, new steps, of which checkable, shocks, of which were
// followed by a changed plan within three decisions, steps of the plan standing at the end.
const PLANNING = {
    '2026-10-05_gpt6.1-sol-claude-sonnet5.5-deepseek-v4.1-glm5.3_99min.jsonl': [
        ['O gpt-6.1-sol', 81.5, 4, 4, 1, 1, 18, 14, 3, 2, 4],
        ['O claude-sonnet-5.5', 58.3, 9, 9, 58, 0.555, 53, 33, 7, 4, 5],
        ['O deepseek-v4.1-flash', 83, 53, 53, 1, 1, 361, 177, 9, 9, 3],
        ['DGX GLM5.3 Flash', 67.1, 17, 17, 2, 0.992, 93, 64, 6, 2, 6],
    ],
    '2026-10-17_gemini-4-argon-qwen3.8-flashnext-q2_0-qwen3.8-flashnext-nvfp4_68min.jsonl': [
        ['DGX Qwen3.8 flash next nvfp4', 81.7, 31, 31, 1, 1, 292, 132, 6, 6, 10],
        ['RTX qwen3.8 flash next Q2_0', 87.1, 19, 19, 1, 1, 137, 84, 2, 2, 8],
        ['O gemini-4-argon', 94.5, 17, 17, 1, 1, 61, 51, 6, 6, 2],
    ],
    '2026-11-07_pi-hy4-hermes-deepseek-v4.1_12min.jsonl': [
        ['pi MCP', 100, 1, 1, 1, 1, 6, 6, 0, 0, 6],
        ['HERMES MCP', 91.7, 1, 1, 1, 1, 8, 6, 0, 0, 8],
    ],
};
for (const [file, want] of Object.entries(PLANNING)) {
    test('planning on ' + file.slice(0, 10) + ' is what it was', async () => {
        const p = await profileFile(sample(file));
        assert.deepEqual(p.seats.map(s => { const g = s.planning; return [s.name, g.score, g.statements, g.revisions, g.firstAt && g.firstAt.decision,
            +g.coverage.toFixed(3), g.steps, g.concrete, g.shocks.n, g.shocks.revised, g.standing ? g.standing.steps.length : null]; }), want);
    });
}

test('plan statements equal the plan calls in every shipped file', () => {
    let seats = 0;
    for (const file of samples) {
        const text = fs.readFileSync(sample(file), 'utf8'), calls = {};
        for (const l of text.split('\n')) {
            if (!l || l.startsWith('{"type"')) continue;
            const o = JSON.parse(l), q = o.parsed || {};
            if ((Array.isArray(q.plan) && q.plan.length) || (typeof q.objective === 'string' && q.objective.trim())) calls[o.playerId] = (calls[o.playerId] || 0) + 1;
        }
        for (const s of WarEval.profileOf(text).seats) {
            const g = s.planning;
            assert.equal(g.statements, calls[s.id] || 0, file + ' ' + s.name);
            assert.ok(g.revisions <= g.statements && g.history.length === g.revisions, file + ' ' + s.name);
            assert.equal(g.score === 0, g.statements === 0 && s.decisions > 0, file + ' ' + s.name + ': 0 means no plan, and only that');
            seats++;
        }
    }
    assert.ok(seats >= 60);
});

const planTurn = (parsed, state, playerId = 'a') => JSON.stringify({ turn: 1, playerId, parsed: Object.assign({ commands: [] }, parsed),
    state: Object.assign({ population: { used: 20 }, threats: { underAttack: [], enemyWonders: [] },
        units: { trainable: { barracks: { stone: [{ id: 'militia', cost: { food: 50 } }] } }, blocked: { stable: { bronze: [{ id: 'horse_archer' }] } } },
        buildings: { buildable: [{ type: 'tower' }], blocked: [{ type: 'archery_range' }] },
        research: { researched: ['house'], available: [{ id: 'farm' }, { id: 'archery_range' }] },
        gameStats: { opponents: [{ id: 'maya-2', civilization: 'maya' }] } }, state) });
const planning = lines => { const l = WarEval.createLedger(); lines.forEach(x => l.addLine(x)); return l.profile().seats[0].planning; };
const quiet = planTurn({}), attacked = planTurn({}, { threats: { underAttack: [{ type: 'house' }], enemyWonders: [] } });

test('a seat that never states a plan has none: 0, not a gap and not an average', () => {
    const g = planning([quiet, quiet, quiet]);
    assert.deepEqual([g.score, g.statements, g.revisions, g.firstAt, g.coverage, g.concreteRate, g.standing], [0, 0, 0, null, 0, null, null]);
    const none = WarEval.createLedger();
    none.addLine(JSON.stringify({ type: 'match', players: [{ id: 'a', seat: 0 }] }));
    assert.equal(none.profile().seats[0].planning.score, null);          // no decision at all: nothing to say
});

test('a plan stands from the decision that states it, and saying it again changes nothing', () => {
    const plan = { objective: 'Hold the hill', plan: ['Build a tower', 'Train militia'] };
    const g = planning([quiet, planTurn(plan), quiet, planTurn(plan), planTurn({ objective: 'hold  the HILL' })]);
    assert.deepEqual([g.statements, g.revisions, g.coverage, g.firstAt.decision], [3, 1, 0.8, 2]);
    assert.deepEqual([g.steps, g.concrete, g.concreteRate], [2, 2, 1]);
    // A statement with one half keeps the other as it stood.
    const half = planning([planTurn(plan), planTurn({ objective: 'Take the coast' }), planTurn({ plan: ['Build a tower', 'Scout north'] })]);
    assert.equal(half.revisions, 3);
    assert.deepEqual([half.standing.objective, half.standing.steps.map(s => s.text), half.standing.since], ['Take the coast', ['Build a tower', 'Scout north'], 3]);
    assert.equal(half.steps, 3);                                         // "Build a tower" is counted once: it was not new again
    assert.deepEqual(half.history.map(h => h.steps), [2, 2, 2]);
});

test('a step is checkable when it names something the seat was shown, or a kind of move', () => {
    const steps = ['Train militia', 'Get horse archers', 'Build two towers', 'Research farm', 'Reach the bronze age', 'Start the wonder',
        'Add villagers', 'Raid the Maya', 'Scout the east', 'Stay flexible', 'Train legionaries', 'Build an Archery Range'];
    const g = planning([planTurn({ plan: steps })]);
    assert.deepEqual(g.standing.steps.filter(s => !s.checkable).map(s => s.text), ['Stay flexible', 'Train legionaries']);   // a unit it was never shown
    assert.deepEqual([g.steps, g.concrete], [12, 10]);
    // The same step is checkable for a seat whose state did list that unit.
    const shown = planning([planTurn({ plan: ['Train legionaries'] }, { units: { trainable: { barracks: { iron: [{ id: 'legionary' }] } } } })]);
    assert.equal(shown.concrete, 1);
    // The early flat lists are read as well.
    const early = planning([JSON.stringify({ turn: 1, playerId: 'a', parsed: { plan: ['Train a warrior', 'Build a house'], action: 'wait' },
        state: { trainableUnits: { barracks: { bronze: [{ id: 'warrior' }] } }, buildableStructures: [{ type: 'house' }], resources: { population: 5 } } })]);
    assert.equal(early.concrete, 2);
});

test('a shock is what the state showed, and a changed plan within three decisions answers it', () => {
    const fresh = n => planTurn({ plan: ['Build a tower', 'Plan ' + n] });
    const at = (lines, k) => planning(lines).shocks[k];
    // Attacked at decision 2, plan changed at 5: three decisions on, still an answer.
    assert.deepEqual([at([fresh(1), attacked, quiet, quiet, fresh(2)], 'n'), at([fresh(1), attacked, quiet, quiet, fresh(2)], 'revised')], [1, 1]);
    assert.equal(at([fresh(1), attacked, quiet, quiet, quiet, fresh(2)], 'revised'), 0);       // four on: too late
    // The reply to the very state that showed the attack counts.
    assert.equal(at([fresh(1), planTurn({ plan: ['Build a tower', 'Defend'] }, { threats: { underAttack: [{ type: 'house' }], enemyWonders: [] } })], 'revised'), 1);
    // Saying the same plan again is not a revision.
    assert.equal(at([fresh(1), attacked, fresh(1)], 'revised'), 0);
    // One attack is one shock, however long it lasts; a second one after a pause is another.
    assert.equal(at([attacked, attacked, attacked, quiet, attacked], 'attacked'), 2);
    // A new enemy Wonder once, and a quarter of the people gone between two decisions.
    const wonder = planTurn({}, { threats: { underAttack: [], enemyWonders: [{ id: 'w1' }] } });
    assert.equal(at([quiet, wonder, wonder], 'wonder'), 1);
    const people = n => planTurn({}, { population: { used: n } });
    assert.equal(at([people(20), people(15)], 'losses'), 1);
    assert.equal(at([people(20), people(16)], 'losses'), 0);
    assert.equal(at([people(10), people(4)], 'losses'), 0);              // too few to call it a shock
    // No shock: the third part of the score falls back to coverage.
    assert.equal(planning([planTurn({ plan: ['Build a tower'] }), quiet]).score, 100);
    assert.equal(planning([planTurn({ plan: ['Build a tower'] }), attacked, quiet, quiet, quiet, quiet]).score, 66.7);
});

test('the profile is worked out again when a line has arrived, and not before', () => {
    const l = WarEval.createLedger();
    l.addLine(quiet);
    const first = l.profile();
    assert.equal(l.profile(), first);
    l.addLine(planTurn({ plan: ['Build a tower'] }));
    assert.notEqual(l.profile(), first);
    assert.equal(l.profile().seats[0].planning.statements, 1);
    l.addLine('{not json');
    assert.equal(l.profile().unreadable, 1);
});

// ---- follow-through (step C3) ------------------------------------------------------------
// name, score, new checkable steps followed, acted on, dropped (not within ten decisions),
// of which carried out later while still in the plan, still pending, median decisions to
// act, commitments carried out, commitments made, orders serving the plan, orders a plan
// can be about that were given under one.
const FOLLOW = {
    '2026-10-05_gpt6.1-sol-claude-sonnet5.5-deepseek-v4.1-glm5.3_99min.jsonl': [
        ['O gpt-6.1-sol', 42.9, 14, 6, 8, 3, 0, 3.5, 7, 19, 45, 58],
        ['O claude-sonnet-5.5', 75.8, 33, 25, 8, 0, 0, 0, 27, 35, 133, 158],
        ['O deepseek-v4.1-flash', 75.6, 177, 133, 43, 1, 1, 0, 188, 270, 172, 252],
        ['DGX GLM5.3 Flash', 89.1, 64, 57, 7, 0, 0, 1, 75, 93, 125, 231],
    ],
    '2026-10-17_gemini-4-argon-qwen3.8-flashnext-q2_0-qwen3.8-flashnext-nvfp4_68min.jsonl': [
        ['DGX Qwen3.8 flash next nvfp4', 73.6, 132, 95, 34, 0, 3, 1, 130, 188, 83, 125],
        ['RTX qwen3.8 flash next Q2_0', 87.5, 84, 63, 9, 1, 12, 1, 83, 117, 66, 87],
        ['O gemini-4-argon', 92.2, 51, 47, 4, 1, 0, 0, 73, 82, 164, 185],
    ],
    '2026-11-07_pi-hy4-hermes-deepseek-v4.1_12min.jsonl': [
        ['pi MCP', 66.7, 6, 4, 2, 0, 0, 2, 5, 14, 34, 38],
        ['HERMES MCP', 50, 6, 3, 3, 3, 0, 1, 3, 11, 60, 87],
    ],
};
for (const [file, want] of Object.entries(FOLLOW)) {
    test('follow-through on ' + file.slice(0, 10) + ' is what it was', async () => {
        const p = await profileFile(sample(file));
        assert.deepEqual(p.seats.map(s => { const h = s.follow; return [s.name, h.score, h.steps, h.acted, h.dropped, h.late, h.pending, h.decisionsToAct,
            h.commitmentsMet, h.commitments, h.ordersServing, h.ordersUnderPlan]; }), want);
        for (const s of p.seats) {
            const h = s.follow;
            assert.equal(h.acted + h.dropped + h.pending, h.steps, s.name);
            assert.ok(h.late <= h.dropped && h.commitmentsMet <= h.commitments && h.ordersServing <= h.ordersUnderPlan, s.name);
            assert.equal(h.steps, s.planning.concrete, s.name + ': every new checkable step is followed, and only those');
        }
    });
}

// One decision: what it planned, what it ordered and whether each order worked.
const move = (plan, orders) => JSON.stringify({ turn: 1, playerId: 'a',
    parsed: Object.assign({ commands: (orders || []).map(([action, name]) => ({ action, params: action === 'train_unit' ? { unitType: name } : action === 'build_structure' ? { buildingType: name }
        : action === 'research_tech' ? { techId: name } : action === 'move_units' ? { mode: name } : {} })) }, plan ? { plan } : null),
    outcomes: (orders || []).map(([action, , verdict], i) => ({ n: i + 1, action, code: 'c', verdict: verdict || 'ok' })),
    state: { population: { used: 20 }, threats: { underAttack: [], enemyWonders: [] },
        units: { trainable: { barracks: { stone: [{ id: 'militia' }, { id: 'archer' }] } } },
        buildings: { buildable: [{ type: 'tower' }, { type: 'barracks' }, { type: 'wonder', builtAs: 'akropolis', isWonder: true }] },
        research: { available: [{ id: 'longbow' }, { id: 'barracks' }] }, gameStats: { opponents: [{ id: 'maya-2', civilization: 'maya' }] } } });
const follow = lines => { const l = WarEval.createLedger(); lines.forEach(x => l.addLine(x)); return l.profile().seats[0].follow; };
const idle = n => Array.from({ length: n }, () => move(null, [['assign_workers']]));

test('a step is acted on when an order that worked carries it out within ten decisions', () => {
    const f = follow([move(['Train militia', 'Build a tower', 'Stay flexible']), ...idle(3), move(null, [['train_unit', 'militia']]), ...idle(8)]);
    assert.deepEqual([f.steps, f.acted, f.dropped, f.pending, f.late], [2, 1, 1, 0, 0]);     // "Stay flexible" is not followed at all
    assert.deepEqual([f.rate, f.score, f.decisionsToAct], [0.5, 50, 4]);
    assert.deepEqual(f.standing.map(s => s.state), ['acted', 'dropped', 'uncheckable']);
    assert.equal(f.standing[0].after, 4);
    // The order in the very reply that states the plan counts, and so does the tenth decision after it.
    assert.equal(follow([move(['Train militia'], [['train_unit', 'militia']])]).decisionsToAct, 0);
    assert.equal(follow([move(['Train militia']), ...idle(9), move(null, [['train_unit', 'militia']])]).acted, 1);
    assert.equal(follow([move(['Train militia']), ...idle(10), move(null, [['train_unit', 'militia']])]).acted, 0);
});

test('an order that was refused carries nothing out, and neither does the wrong one', () => {
    const refused = follow([move(['Train militia'], [['train_unit', 'militia', 'avoidable']]), ...idle(10)]);
    assert.deepEqual([refused.acted, refused.dropped, refused.score], [0, 1, 0]);
    const wrong = follow([move(['Train militia'], [['train_unit', 'archer']]), ...idle(10)]);
    assert.deepEqual([wrong.acted, wrong.dropped], [0, 1]);
    const contended = follow([move(['Train militia'], [['train_unit', 'militia', 'contended']]), ...idle(10)]);
    assert.equal(contended.acted, 0);                    // it did not happen, whoever is to blame
});

test('each kind of commitment has the orders that carry it out', () => {
    const one = (step, order) => follow([move([step], [order])]).acted;
    assert.equal(one('Build a tower', ['build_structure', 'tower']), 1);
    assert.equal(one('Build a barracks', ['research_tech', 'barracks']), 1);     // unlocking it is the first half of building it
    assert.equal(one('Research longbow', ['research_tech', 'longbow']), 1);
    assert.equal(one('Research longbow', ['research_tech', 'barracks']), 0);
    assert.equal(one('Advance to the bronze age', ['upgrade_age']), 1);
    assert.equal(one('Build the Akropolis', ['build_structure', 'wonder']), 1);
    assert.equal(one('Build the Akropolis', ['build_structure', 'tower']), 0);
    assert.equal(one('Attack the Maya', ['attack_target']), 1);
    assert.equal(one('Scout the east', ['explore']), 1);
    assert.equal(one('Scout the east', ['move_units', 'scout']), 1);              // scouting is ordered two ways
    assert.equal(one('Scout the east', ['move_units', 'march']), 0);
});

test('a step still open is pending, not dropped, and too early is a dash', () => {
    const f = follow([move(['Train militia', 'Build a tower'], [['train_unit', 'militia']]), ...idle(4)]);
    assert.deepEqual([f.acted, f.dropped, f.pending, f.score], [1, 0, 1, 100]);
    assert.deepEqual(f.standing.map(s => s.state), ['acted', 'pending']);
    const early = follow([move(['Train militia']), ...idle(4)]);
    assert.deepEqual([early.pending, early.rate, early.score], [1, null, null]);
});

test('a step carried out later, while it still stood in the plan, is counted as late and stays dropped', () => {
    const late = follow([move(['Build the Akropolis', 'Train militia']), ...idle(14), move(null, [['build_structure', 'wonder']])]);
    assert.deepEqual([late.acted, late.dropped, late.late], [0, 2, 1]);
    assert.deepEqual(late.standing.map(s => s.state), ['late', 'dropped']);
    // Once the step has left the plan, carrying it out later is not following the plan.
    const left = follow([move(['Build the Akropolis']), ...idle(5), move(['Train archers']), ...idle(8), move(null, [['build_structure', 'wonder']]), ...idle(10)]);
    assert.deepEqual([left.dropped, left.late], [2, 0]);
    // A step repeated in a changed plan is followed from where it was first stated.
    const kept = follow([move(['Train militia', 'Build a tower']), ...idle(5), move(['Train militia', 'Scout the east']), ...idle(5), move(null, [['train_unit', 'militia']])]);
    assert.deepEqual([kept.steps, kept.late, kept.standing[0].state], [3, 1, 'late']);
});

test('several commitments in one step: acted on with the first, and counted one by one', () => {
    const f = follow([move(['Train militia and archers, then build a tower'], [['train_unit', 'archer']]), ...idle(10)]);
    assert.deepEqual([f.acted, f.commitments, f.commitmentsMet], [1, 3, 1]);
});

test('orders that serve the plan are counted only among orders a plan can be about, given under one', () => {
    const f = follow([move(null, [['train_unit', 'archer']]),                     // before any plan: not counted
        move(['Train militia'], [['train_unit', 'militia'], ['train_unit', 'archer'], ['assign_workers'], ['train_unit', 'militia', 'avoidable']])]);
    assert.deepEqual([f.ordersUnderPlan, f.ordersServing, f.servingRate], [2, 1, 0.5]);
});

test('no plan, or a plan with nothing checkable in it, earns nothing', () => {
    assert.equal(follow(idle(12)).score, 0);
    assert.equal(follow([move(['Stay flexible', 'Play well']), ...idle(12)]).score, 0);
    assert.equal(follow([move(['Stay flexible'])]).score, null);                  // ten decisions have not passed: it may still say something
    // A file that records no outcomes cannot say what was carried out: nothing is counted.
    const old = follow([JSON.stringify({ turn: 1, playerId: 'a', parsed: { plan: ['Train militia'], commands: [{ action: 'train_unit', params: { unitType: 'militia' } }] },
        state: { units: { trainable: { barracks: { stone: [{ id: 'militia' }] } } } } })]);
    assert.deepEqual([old.judged, old.score, old.acted, old.steps], [false, null, null, 1]);
});

// ---- tactical response (step C4) ---------------------------------------------------------
// name, score, attack episodes, answered inside the window, of which at once, median
// decisions to answer, episodes that cost a building, episodes held, episodes the state
// called undefended, rival Wonders sighted, of which attacked.
const TACTICAL = {
    '2026-10-05_gpt6.1-sol-claude-sonnet5.5-deepseek-v4.1-glm5.3_99min.jsonl': [
        ['O gpt-6.1-sol', 50, 1, 1, 1, 0, 1, 0, 1, 1, 0],
        ['O claude-sonnet-5.5', 66.7, 5, 3, 3, 0, 2, 3, 1, 1, 1],
        ['O deepseek-v4.1-flash', 66.7, 4, 2, 2, 0, 2, 2, 2, 2, 2],
        ['DGX GLM5.3 Flash', 100, 2, 2, 2, 0, 1, 1, 1, 1, 1],
    ],
    '2026-10-17_gemini-4-argon-qwen3.8-flashnext-q2_0-qwen3.8-flashnext-nvfp4_68min.jsonl': [
        ['DGX Qwen3.8 flash next nvfp4', 66.7, 3, 2, 2, 0, 1, 2, 1, 0, 0],
        ['RTX qwen3.8 flash next Q2_0', 0, 1, 0, 0, null, 1, 0, 1, 0, 0],
        ['O gemini-4-argon', 75, 3, 2, 2, 0, 0, 3, 0, 1, 1],
    ],
    // Twelve minutes in which neither seat was ever shown a threat: a dash, not a zero.
    '2026-11-07_pi-hy4-hermes-deepseek-v4.1_12min.jsonl': [
        ['pi MCP', null, 0, 0, 0, null, 0, 0, 0, 0, 0],
        ['HERMES MCP', null, 0, 0, 0, null, 0, 0, 0, 0, 0],
    ],
};
for (const [file, want] of Object.entries(TACTICAL)) {
    test('tactical response on ' + file.slice(0, 10) + ' is what it was', async () => {
        const p = await profileFile(sample(file));
        assert.deepEqual(p.seats.map(s => { const g = s.tactical; return [s.name, g.score, g.episodes, g.answered, g.atOnce, g.decisionsToAnswer, g.lost, g.held, g.undefended, g.wonders, g.wonderAnswered]; }), want);
    });
}

test('every episode opens at a state that showed the threat, after one that did not', () => {
    let episodes = 0;
    for (const file of samples) {
        const text = fs.readFileSync(sample(file), 'utf8'), byTurn = new Map();
        for (const l of text.split('\n')) {
            if (!l || l.startsWith('{"type"')) continue;
            const o = JSON.parse(l), th = (o.state && o.state.threats) || {};
            byTurn.set(o.playerId + '|' + o.turn, { attacked: (th.underAttack || []).length > 0, wonders: (th.enemyWonders || []).map(w => String(w.id)), sec: o.state && o.state.clock && o.state.clock.matchSeconds });
        }
        for (const s of WarEval.profileOf(text).seats) for (const e of s.tactical.list) {
            const at = byTurn.get(s.id + '|' + e.turn), before = byTurn.get(s.id + '|' + (e.turn - 1));
            assert.ok(at, file + ' ' + s.name + ' turn ' + e.turn);
            assert.equal(at.sec, e.sec, file + ': the episode carries the moment of its first sighting');
            if (e.kind === 'attack') { assert.equal(at.attacked, true, file + ' ' + s.name); if (before) assert.equal(before.attacked, false, file + ' ' + s.name + ': it had not been shown before'); }
            else assert.ok(at.wonders.length > 0 && !(before && before.wonders.length === at.wonders.length && before.wonders.every(w => at.wonders.includes(w))), file + ' ' + s.name + ': a Wonder it had not been shown');
            episodes++;
        }
    }
    assert.ok(episodes >= 100, 'only ' + episodes + ' episodes in the shipped matches');
});

// One decision: what the state showed under attack, and what was ordered.
const scene = (attack, orders, more) => JSON.stringify({ turn: 1, playerId: 'a',
    parsed: { commands: (orders || []).map(o => ({ action: o.action, params: o })) },
    outcomes: (orders || []).map((o, i) => ({ n: i + 1, action: o.action, code: 'c', verdict: o.verdict || 'ok' })),
    state: Object.assign({ clock: { matchSeconds: 100 }, population: { used: 20 },
        threats: { underAttack: attack || [], enemyWonders: [] },
        friendlyBuildings: [{ type: 'barracks', x: 100, z: 100 }, { type: 'town_center', x: 0, z: 0 }],
        friendlyUnits: [{ id: 1, type: 'worker', x: 102, z: 98 }, { id: 2, type: 'worker', x: -200, z: -200 }],
        enemyUnits: [{ id: 'e1', type: 'archer', x: 110, z: 104, owner: 'maya-2' }] }, more) });
const raid = [{ kind: 'building', type: 'barracks', x: 100, z: 100, healthPct: 60, attackerAt: { x: 110, z: 104, owner: 'maya-2' } }];
const workerRaid = [{ kind: 'unit', type: 'worker', x: 102, z: 98, healthPct: 50, attackerAt: { x: 110, z: 104, owner: 'maya-2' } }];
const tactical = lines => { const l = WarEval.createLedger(); lines.forEach(x => l.addLine(x)); return l.profile().seats[0].tactical; };
const calm = scene(null, [{ action: 'train_unit', unitType: 'worker' }]);

test('an order aimed at the threat answers it; training more soldiers does not', () => {
    const one = order => tactical([calm, scene(raid, [order]), calm]);
    assert.deepEqual([one({ action: 'attack_target', targetX: 108, targetZ: 100 }).answered, one({ action: 'attack_target', targetX: 108, targetZ: 100 }).score], [1, 100]);
    assert.equal(one({ action: 'attack_target', targetId: 'e1' }).answered, 1);          // a target named by its id points where the state showed it
    assert.equal(one({ action: 'attack_target', targetX: -300, targetZ: -300 }).answered, 0);   // an attack somewhere else is not an answer
    assert.equal(one({ action: 'move_units', targetX: 95, targetZ: 105, units: { militia: 4 } }).answered, 1);
    assert.equal(one({ action: 'move_units', mode: 'scout', targetX: 95, targetZ: 105 }).answered, 0);
    assert.equal(one({ action: 'build_structure', buildingType: 'tower', targetX: 104, targetZ: 96 }).answered, 1);
    assert.equal(one({ action: 'build_structure', buildingType: 'house', targetX: 104, targetZ: 96 }).answered, 0);
    assert.equal(one({ action: 'repair_building', targetX: 100, targetZ: 100 }).answered, 1);
    assert.equal(one({ action: 'train_unit', unitType: 'militia' }).answered, 0);
    assert.deepEqual([one({ action: 'train_unit', unitType: 'militia' }).unanswered, one({ action: 'train_unit', unitType: 'militia' }).score], [1, 0]);
    assert.equal(one({ action: 'attack_target', targetX: 108, targetZ: 100, verdict: 'avoidable' }).answered, 0);   // an order that was refused answered nothing
});

test('pulling the threatened people out protects them, wherever they are sent', () => {
    const out = tactical([calm, scene(workerRaid, [{ action: 'move_units', unitIds: [1], targetX: -250, targetZ: -250 }]), calm]);
    assert.equal(out.answered, 1);
    const other = tactical([calm, scene(workerRaid, [{ action: 'move_units', unitIds: [2], targetX: -250, targetZ: -250 }]), calm]);
    assert.equal(other.answered, 0);                                                        // somebody else, far from the raid
});

test('at once is the decision that was shown the threat or the next; the window is three', () => {
    const answer = scene(null, [{ action: 'attack_target', targetX: 108, targetZ: 100 }]);
    const after = n => tactical([calm, scene(raid, []), ...Array.from({ length: n - 1 }, () => calm), ...(n ? [answer] : []), calm]);
    assert.deepEqual([after(1).answered, after(1).atOnce, after(1).score], [1, 1, 100]);   // the raid had left the state: still aimed at where it was
    assert.deepEqual([after(2).answered, after(2).atOnce, after(2).score, after(2).decisionsToAnswer], [1, 0, 0, 2]);
    assert.deepEqual([after(3).answered, after(3).unanswered], [0, 1]);
});

test('one attack is one episode however long it lasts, and what it cost is reported beside the answer', () => {
    const gone = { friendlyBuildings: [{ type: 'town_center', x: 0, z: 0 }] };
    const t = tactical([calm, scene(raid, []), scene(raid, []), scene(null, [], gone), calm, scene(workerRaid, [{ action: 'attack_target', targetId: 'e1' }]), calm]);
    assert.deepEqual([t.episodes, t.answered, t.lost, t.held, t.score], [2, 1, 1, 1, 50]);
    assert.deepEqual(t.list.map(e => [e.kind, e.decision, e.sec, e.decisions, e.outcome, e.what.join(), e.by, e.answeredAfter]),
        [['attack', 2, 100, 2, 'lost', 'barracks', 'maya-2', null], ['attack', 6, 100, 1, 'held', 'worker', 'maya-2', 0]]);
    // A match that ends with the attack still on: neither held nor lost.
    assert.equal(tactical([calm, scene(raid, [])]).list[0].outcome, 'open');
    assert.equal(tactical([calm, scene([Object.assign({ noDefenders: true }, raid[0])], [])]).undefended, 1);
});

test('a rival Wonder is a threat from the decision that first showed it, answered by an attack on it', () => {
    const wonder = { threats: { underAttack: [], enemyWonders: [{ id: 'w1', type: 'pyramid', x: 300, z: 300, owner: 'maya-2' }] } };
    const hit = tactical([calm, scene(null, [], wonder), scene(null, [{ action: 'attack_target', targetId: 'w1' }], wonder), scene(null, [], wonder)]);
    assert.deepEqual([hit.wonders, hit.wonderAnswered, hit.episodes, hit.score], [1, 1, 0, 100]);
    assert.equal(tactical([calm, scene(null, [{ action: 'attack_target', targetX: 310, targetZ: 290 }], wonder)]).wonderAnswered, 1);
    assert.equal(tactical([calm, scene(null, [{ action: 'attack_target', targetX: 0, targetZ: 0 }], wonder), calm, calm]).wonderAnswered, 0);
    assert.equal(tactical([calm, scene(null, [], wonder), calm, calm, scene(null, [{ action: 'attack_target', targetId: 'w1' }], wonder)]).score, 0);   // the fourth decision is too late
});

test('a seat that was never shown a threat has no tactical score, and a file without outcomes is not judged', () => {
    const none = tactical([calm, calm, calm]);
    assert.deepEqual([none.episodes, none.wonders, none.score, none.list.length], [0, 0, null, 0]);
    const old = tactical([JSON.stringify({ turn: 1, playerId: 'a', parsed: { commands: [{ action: 'attack_target', params: { targetX: 108, targetZ: 100 } }] },
        state: { threats: { underAttack: raid, enemyWonders: [] } } })]);
    assert.deepEqual([old.judged, old.episodes, old.answered, old.score], [false, 1, null, null]);
});

// ---- Strategy, the range used and the Index (overhaul steps C5 and C6) ------
// name, score, the score without the placement, rank, share of power, share of the
// time ahead, clear lead from (s), converted, battles, destroyed, lost, ages reached at
// (s), unit types, buildings, technologies and kinds of order used with success, Index
// and how many parts it is the mean of.
const STRATEGY = {
    '2026-10-05_gpt6.1-sol-claude-sonnet5.5-deepseek-v4.1-glm5.3_99min.jsonl': [
        ['O gpt-6.1-sol', 11.4, 17.1, 4, 0.085, 0.006, null, null, 12, 3, 23, '487', 2, 5, 5, 9, 39.5, 4],
        ['O claude-sonnet-5.5', 71.7, 74.3, 2, 0.376, 0.721, 3493, false, 36, 136, 144, '412/812/1342', 3, 6, 4, 9, 69.2, 4],
        ['O deepseek-v4.1-flash', 52.7, 62.4, 3, 0.252, 0.184, null, null, 48, 205, 151, '372/1147/2037', 10, 9, 13, 9, 63, 4],
        ['DGX GLM5.3 Flash', 77.2, 65.9, 1, 0.288, 0.107, null, null, 44, 99, 81, '372/1147/2493', 11, 10, 13, 10, 75.8, 4],
    ],
    '2026-10-17_gemini-4-argon-qwen3.8-flashnext-q2_0-qwen3.8-flashnext-nvfp4_68min.jsonl': [
        ['DGX Qwen3.8 flash next nvfp4', 37.7, 56.6, 3, 0.377, 0.616, null, null, 16, 48, 79, '437/1112/1848', 6, 10, 14, 10, 52.9, 4],
        ['RTX qwen3.8 flash next Q2_0', 34.1, 26.2, 2, 0.21, 0.04, null, null, 7, 7, 60, '667/1612', 7, 9, 11, 8, 49, 4],
        ['O gemini-4-argon', 84.8, 77.3, 1, 0.413, 0.358, 3558, true, 21, 138, 54, '622/1112/1687', 6, 6, 12, 9, 86.7, 4],
    ],
    // Neither MCP seat has a tactical score here: three parts, not four.
    '2026-11-07_pi-hy4-hermes-deepseek-v4.1_12min.jsonl': [
        ['pi MCP', 25.8, 38.7, 2, 0.273, 0.152, null, null, 7, 9, 13, '470', 1, 4, 6, 7, 30.8, 3],
        ['HERMES MCP', 85.3, 78, 1, 0.727, 0.993, 410, true, 7, 13, 9, '255/710', 4, 6, 5, 7, 74, 3],
    ],
};
for (const [file, want] of Object.entries(STRATEGY)) {
    test('strategy, range and Index on ' + file.slice(0, 10) + ' are what they were', async () => {
        const p = await profileFile(sample(file));
        assert.deepEqual(p.seats.map(s => { const g = s.strategy, v = s.versatility; return [s.name, g.score, g.running, g.rank, +g.powerShare.toFixed(3), +g.leadShare.toFixed(3),
            g.clearLeadAt, g.converted, g.battles, g.destroyed, g.lost, g.ages.map(a => a.sec).join('/'), v.units.length, v.buildings.length, v.techs.length, v.orders.length,
            s.index.value, s.index.of]; }), want);
        for (const s of p.seats) assert.equal(s.versatility.score, null);
    });
}

test('strategy reads the match\'s own record: its placement, its power score, its battles', () => {
    let files = 0;
    for (const f of samples) {
        const lines = fs.readFileSync(sample(f), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
        const results = lines.find(o => o.type === 'results'), timeline = lines.find(o => o.type === 'timeline');
        if (!results || !timeline || !timeline.samples.length) continue;
        files++;
        const p = WarEval.profileOf(fs.readFileSync(sample(f), 'utf8'));
        for (const s of p.seats) {
            const row = results.ranking.find(r => r.playerId === s.id), g = s.strategy;
            assert.deepEqual([g.final, g.rank, g.of, g.winner], [true, row.rank, results.ranking.length, !!row.isWinner], f + ' ' + s.name);
            assert.ok(g.powerShare > 0 && g.powerShare < 1 && g.score >= 0 && g.score <= 100, f + ' ' + s.name);
        }
        // Every seat's share of all power: together they are all of it. (A seat with no
        // decisions is not in the profile, so only where every seat is.)
        if (p.seats.length === results.ranking.length) assert.ok(Math.abs(p.seats.reduce((a, s) => a + s.strategy.powerShare, 0) - 1) < 1e-9, f);
        // A battle's losses are counted once on each side of it.
        const battles = lines.filter(o => o.type === 'chronicle' && o.kind === 'battle');
        for (const s of p.seats) assert.equal(s.strategy.lost, battles.reduce((a, b) => a + ((b.sides[s.id] || {}).lost || 0), 0), f + ' ' + s.name);
    }
    assert.ok(files >= 15, 'only ' + files + ' files with results and a timeline');
});

// A two-seat match on paper: a's decisions, and what the match wrote about itself.
const seatsLine = JSON.stringify({ type: 'match', players: [{ id: 'a', seat: 0 }, { id: 'b', seat: 1 }] });
const tick = (t, a, b) => ({ t, p: { a: { pw: a, al: 1 }, b: { pw: b, al: 1 } } });
const timelineOf = (samples, ages) => JSON.stringify({ type: 'timeline', samples, ages: ages || [] });
const resultsOf = winner => JSON.stringify({ type: 'results', ranking: [{ playerId: winner, rank: 1, isWinner: true }, { playerId: winner === 'a' ? 'b' : 'a', rank: 2, isWinner: false }] });
const battle = (t, a, b) => JSON.stringify({ type: 'chronicle', kind: 'battle', t, sides: { a: { involved: 9, lost: a }, b: { involved: 9, lost: b } } });
const strategyOf = lines => { const l = WarEval.createLedger(); [seatsLine, move(null, [['assign_workers']])].concat(lines).forEach(x => l.addLine(x)); return l.profile().seats.find(s => s.id === 'a').strategy; };

test('strategy is the mean of placement, share of power against an even split, and the exchange in battles', () => {
    // Even power, no battle, won: placement 1, power (0.5 x 2 / 1.5) = two thirds.
    const even = Array.from({ length: 10 }, (_, i) => tick(i * 5, 500, 500));
    let g = strategyOf([timelineOf(even), resultsOf('a')]);
    assert.deepEqual([g.placement, g.powerShare, g.evenShare, g.exchange, g.score, g.running], [1, 0.5, 0.5, null, 83.3, 66.7]);
    // The same match lost: only the placement moves.
    g = strategyOf([timelineOf(even), resultsOf('b')]);
    assert.deepEqual([g.placement, g.score, g.running, g.winner], [0, 33.3, 66.7, false]);
    // Three quarters of all power is half again an even split: full marks, and no more than that.
    g = strategyOf([timelineOf(even.map(x => tick(x.t, 900, 300))), resultsOf('a')]);
    assert.deepEqual([g.powerShare, g.leadShare, g.score], [0.75, 1, 100]);
    // Battles: it destroyed 6 and lost 2, so three quarters of the losses were the other side's.
    g = strategyOf([battle(20, 1, 4), battle(30, 1, 2), timelineOf(even), resultsOf('a')]);
    assert.deepEqual([g.battles, g.destroyed, g.lost, g.exchange, g.score], [2, 6, 2, 0.75, 80.6]);
    // A battle it was not in is not its battle.
    g = strategyOf([JSON.stringify({ type: 'chronicle', kind: 'battle', t: 5, sides: { b: { lost: 3 }, c: { lost: 1 } } }), timelineOf(even)]);
    assert.deepEqual([g.battles, g.exchange], [0, null]);
});

test('a clear lead is a quarter more power than the next seat, held five minutes, and it is said whether it was won', () => {
    const run = (from, to, a, b) => { const out = []; for (let t = from; t < to; t += 5) out.push(tick(t, a, b)); return out; };
    // 1.25 times for 4:55 is not one; for five minutes it is, from the reading that completes them.
    let g = strategyOf([timelineOf(run(0, 100, 500, 500).concat(run(100, 395, 625, 500), run(395, 600, 500, 500))), resultsOf('a')]);
    assert.deepEqual([g.clearLeadAt, g.converted], [null, null]);
    g = strategyOf([timelineOf(run(0, 100, 500, 500).concat(run(100, 400, 625, 500), run(400, 600, 500, 500))), resultsOf('a')]);
    assert.deepEqual([g.clearLeadAt, g.converted], [395, true]);
    g = strategyOf([timelineOf(run(0, 100, 500, 500).concat(run(100, 400, 625, 500), run(400, 600, 100, 500))), resultsOf('b')]);
    assert.deepEqual([g.clearLeadAt, g.converted], [395, false]);
    // A fifth more is ahead, and counted as time ahead, but it is not a clear lead.
    g = strategyOf([timelineOf(run(0, 600, 600, 500)), resultsOf('a')]);
    assert.deepEqual([g.leadShare, g.clearLeadAt], [1, null]);
    assert.deepEqual([WarEval.LEAD_FACTOR, WarEval.LEAD_SECONDS], [1.25, 300]);
});

test('a running match has no placement yet, and the timeline shown to it gives way to the line in the file', () => {
    const l = WarEval.createLedger();
    [seatsLine, move(null, [['assign_workers']]), battle(20, 1, 3)].forEach(x => l.addLine(x));
    assert.deepEqual([l.profile().seats[0].strategy.samples, l.profile().seats[0].strategy.exchange], [0, 0.75]);
    const live = { samples: [tick(5, 600, 400), tick(10, 600, 400)], ages: [{ t: 8, id: 'a', age: 'neolithic' }] };
    l.preview(live);
    let g = l.profile().seats[0].strategy;
    assert.deepEqual(JSON.parse(JSON.stringify([g.final, g.rank, g.placement, g.samples, g.powerShare, g.score, g.running, g.ages])), [false, null, null, 2, 0.6, 77.5, 77.5, [{ age: 'neolithic', sec: 8 }]]);
    // Shown the same timeline again, nothing is worked out again; with a new reading it is.
    const before = l.profile();
    l.preview(live);
    assert.equal(l.profile(), before);
    live.samples.push(tick(15, 200, 800));
    l.preview(live);
    assert.equal(l.profile().seats[0].strategy.samples, 3);
    // The file's own lines are the last word, and what the page showed then equals the file.
    l.addLine(resultsOf('a')); l.addLine(timelineOf(live.samples, live.ages));
    live.samples.push(tick(20, 0, 1000)); l.preview(live);               // too late: not in the file
    const fromFile = WarEval.createLedger();
    [seatsLine, move(null, [['assign_workers']]), battle(20, 1, 3), resultsOf('a'), timelineOf(live.samples.slice(0, 3), live.ages)].forEach(x => fromFile.addLine(x));
    assert.deepEqual(l.profile(), fromFile.profile());
    assert.deepEqual([l.profile().seats[0].strategy.final, l.profile().seats[0].strategy.samples], [true, 3]);
    assert.doesNotThrow(() => { WarEval.createLedger().preview(null); WarEval.createLedger().preview({}); });
});

test('the profile as it stood at a second reads the timeline and the battles up to it, without the placement', () => {
    const l = WarEval.createLedger();
    [seatsLine, JSON.stringify(Object.assign(JSON.parse(move(null, [['assign_workers']])), { state: { clock: { matchSeconds: 10 } } })),
        battle(20, 0, 4), battle(300, 6, 0), timelineOf([tick(5, 500, 500), tick(10, 500, 500), tick(400, 100, 900)], [{ t: 8, id: 'a', age: 'neolithic' }, { t: 350, id: 'a', age: 'bronze' }]), resultsOf('b')].forEach(x => l.addLine(x));
    const then = l.profileAt(100).seats[0].strategy, now = l.profile().seats[0].strategy;
    assert.deepEqual([then.final, then.placement, then.samples, then.battles, then.exchange, then.ages.length], [false, null, 2, 1, 1, 1]);
    assert.deepEqual([now.final, now.placement, now.samples, now.battles, now.exchange, now.ages.length], [true, 0, 3, 2, 0.4, 2]);
    assert.equal(then.score, then.running);
});

test('the range used is what worked, as facts and without a score', () => {
    const l = WarEval.createLedger();
    [move(null, [['train_unit', 'worker'], ['train_unit', 'militia'], ['train_unit', 'archer', 'avoidable']]),
        move(null, [['build_structure', 'tower'], ['research_tech', 'longbow'], ['train_unit', 'militia']]),
        move(null, [['build_structure', 'barracks', 'contended'], ['attack_target']])].forEach(x => l.addLine(x));
    const v = l.profile().seats[0].versatility;
    // The archer was refused and the barracks came to nothing; a worker is not an army.
    assert.deepEqual(JSON.parse(JSON.stringify(v)), { units: ['militia'], buildings: ['tower'], techs: ['longbow'], orders: ['attack_target', 'build_structure', 'research_tech', 'train_unit'], score: null });
});

test('the Index is the mean of four parts, and a plan counts in it as far as it was followed', () => {
    assert.deepEqual(Array.from(WarEval.SCORED), ['grounding', 'planning', 'follow', 'tactical', 'strategy']);
    assert.deepEqual(Array.from(WarEval.INDEX_PARTS), ['grounding', 'plan', 'tactical', 'strategy']);
    const index = s => JSON.parse(JSON.stringify(s.index));
    const l = WarEval.createLedger();
    [seatsLine, move(['Build a tower'], [['build_structure', 'tower']])].forEach(x => l.addLine(x));
    let s = l.profile().seats[0];
    // Grounding 100; a plan of one step, carried out: 100 x 100. Never shown a threat, no power reading: two parts.
    assert.deepEqual([s.grounding.score, s.planning.score, s.follow.score, s.tactical.score, s.strategy.score], [100, 100, 100, null, null]);
    assert.deepEqual(index(s), { value: 100, of: 2, parts: 4, plan: 100 });
    l.addLine(timelineOf([tick(5, 100, 500)])); l.addLine(resultsOf('b'));
    s = l.profile().seats.find(x => x.id === 'a');
    assert.deepEqual([s.strategy.score, s.index.value, s.index.of], [11.1, 70.4, 3]);
    // The plan-only anchor on paper: one concrete plan, then only waits, for longer than
    // the window a step is followed. Planning is full, follow-through is nothing, and
    // the Index has nothing to show for either. The waits leave it no Grounding.
    const talker = WarEval.createLedger();
    [seatsLine, move(['Build a tower', 'Train militia'], [['wait']])].concat(Array.from({ length: 12 }, () => move(null, [['wait']]))).forEach(x => talker.addLine(x));
    s = talker.profile().seats[0];
    assert.deepEqual([s.grounding.score, s.planning.score, s.follow.score], [null, 100, 0]);
    assert.deepEqual(index(s), { value: 0, of: 1, parts: 4, plan: 0 });
    // A plan too young to have been followed or dropped is left out, not counted as nothing.
    const young = WarEval.createLedger();
    [seatsLine, move(['Build a tower'], [['train_unit', 'worker']])].forEach(x => young.addLine(x));
    s = young.profile().seats[0];
    assert.deepEqual([s.planning.score, s.follow.score], [100, null]);
    assert.deepEqual(index(s), { value: 100, of: 1, parts: 4, plan: null });
    // A file without outcomes leaves one part that can be read: it decided and stated no
    // plan. The Index says how few parts it stands on.
    const none = WarEval.createLedger();
    none.addLine(JSON.stringify({ turn: 1, playerId: 'z', parsed: { commands: [{ action: 'wait' }] } }));
    assert.deepEqual(index(none.profile().seats[0]), { value: 0, of: 1, parts: 4, plan: 0 });
    // A seat no model decided for is in the match and on the timeline, and has no Index.
    const other = l.profile().seats.find(x => x.id === 'b');
    assert.deepEqual([other.decisions, other.strategy.rank, other.strategy.score, other.index.value, other.index.of], [0, 1, 100, null, 0]);
});

test('the command-line report prints strategy, the range and the Index beside the parts', async () => {
    const file = sample('2026-10-17_gemini-4-argon-qwen3.8-flashnext-q2_0-qwen3.8-flashnext-nvfp4_68min.jsonl');
    const text = report(file, await profileFile(file));
    assert.match(text, /STRATEGY +score +placed +share of power +even split +time ahead +clear lead/);
    assert.match(text, /O gemini-4-argon +85 +1 of 3 +41\.3 % +33\.3 % +35\.8 % +from 59:18, won +21 +138 : 54 +neolithic 10:22, bronze 18:32, iron 28:07/);
    assert.match(text, /RANGE USED +unit types +buildings +technologies +kinds of order\n.*\n.*\nO gemini-4-argon +6 +6 +12 +9/);
    assert.match(text, /INDEX +mean +of +grounding +plan as followed +tactical +strategy/);
    assert.match(text, /O gemini-4-argon +86\.7 +4 parts +100 +87 +\d+ +85/);
    assert.match(text, /GROUNDING +score +valid +ok +of which waits +avoidable/);
    assert.match(text, /Score scale v1: provisional\. valid = ok of ok \+ avoidable \+ invalid, with waits left out/);
    assert.match(text, /One match is one sample/);
});
