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
        ['O gpt-6.1-sol', 87, 78, 3, 0, 1, 1, 0, 63, 4816, 6249, 19332, 93, 103, 0.954, 4, 0, 0, 'notDiscovered'],
        ['O claude-sonnet-5.5', 128, 349, 2, 0, 5, 1, 0, 94.3, 6472, 10569, 72032, 563, 238, 2.789, 0, 0, 0, 'commandLimit'],
        ['O deepseek-v4.1-flash', 128, 354, 11, 0, 4, 2, 2, 69.9, 8974, 21991, 57415, 1804.5, 801, 2.898, 1, 0, 0, 'noTCWorkers'],
        ['DGX GLM5.3 Flash', 126, 321, 11, 0, 2, 0, 0, 66.9, 41543, 73085, 42176, 744.5, 320, 2.651, 0, 1, 1, 'populationLimit'],
    ],
    '2026-10-17_gemini-4-argon-qwen3.8-flashnext-q2_0-qwen3.8-flashnext-nvfp4_68min.jsonl': [
        ['DGX Qwen3.8 flash next nvfp4', 82, 215, 12, 0, 2, 0, 2, 47.1, 36289, 74921, 8140, 1500.5, 654, 2.793, 0, 2, 0, 'assignFromEmpty'],
        ['RTX qwen3.8 flash next Q2_0', 52, 137, 2, 0, 1, 0, 0, 85.6, 30982, 45172, 12656.5, 1761.5, 706, 2.692, 0, 0, 0, 'unitBuildingNotBuilt'],
        ['O gemini-4-argon', 84, 229, 0, 0, 8, 0, 0, 100, 8635, 19633, 34700.5, 264, 139, 2.821, 0, 0, 0, null],
    ],
    // Two MCP seats: their harnesses report no token usage, and that reads as "not
    // reported", never as zero.
    '2026-11-07_pi-hy4-hermes-deepseek-v4.1_12min.jsonl': [
        ['pi MCP', 40, 56, 6, 0, 5, 1, 5, 3.2, 13, 22, null, null, null, 1.7, 0, 0, 0, 'noTCWorkers'],
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
        assert.equal(p.kind, 'war-eval/1'); assert.equal(p.scale, 'v0'); assert.equal(p.unreadable, 0);
        // valid = ok of ok + avoidable + invalid, and the score is the v0 mapping of it.
        for (const s of p.seats) {
            const g = s.grounding;
            assert.equal(g.judged, g.ok + g.avoidable + g.invalid);
            assert.equal(g.rate, g.ok / g.judged);
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
    assert.match(mcp, /pi MCP +3 +90\.3 %/);
    assert.doesNotMatch(mcp, /recorded from build 1023/);
});

// ---- planning (step C2) ------------------------------------------------------------------
// name, score, plan statements, of which changed the plan, decision of the first plan,
// share of decisions under a plan, new steps, of which checkable, shocks, of which were
// followed by a changed plan within three decisions, steps of the plan standing at the end.
const PLANNING = {
    '2026-10-05_gpt6.1-sol-claude-sonnet5.5-deepseek-v4.1-glm5.3_99min.jsonl': [
        ['O gpt-6.1-sol', 85.2, 4, 4, 1, 1, 18, 16, 3, 2, 4],
        ['O claude-sonnet-5.5', 65.2, 9, 9, 58, 0.555, 53, 44, 7, 4, 5],
        ['O deepseek-v4.1-flash', 96, 53, 53, 1, 1, 361, 318, 9, 9, 3],
        ['DGX GLM5.3 Flash', 76.4, 17, 17, 2, 0.992, 93, 90, 6, 2, 6],
    ],
    '2026-10-17_gemini-4-argon-qwen3.8-flashnext-q2_0-qwen3.8-flashnext-nvfp4_68min.jsonl': [
        ['DGX Qwen3.8 flash next nvfp4', 93.9, 31, 31, 1, 1, 292, 239, 6, 6, 10],
        ['RTX qwen3.8 flash next Q2_0', 94.9, 19, 19, 1, 1, 137, 116, 2, 2, 8],
        ['O gemini-4-argon', 99.5, 17, 17, 1, 1, 61, 60, 6, 6, 2],
    ],
    '2026-11-07_pi-hy4-hermes-deepseek-v4.1_12min.jsonl': [
        ['pi MCP', 100, 1, 1, 1, 1, 6, 6, 0, 0, 6],
        ['HERMES MCP', 100, 1, 1, 1, 1, 8, 8, 0, 0, 8],
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
