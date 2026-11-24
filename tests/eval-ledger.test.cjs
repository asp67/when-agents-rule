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
        ['O gpt-6.1-sol', 87, 78, 2, 0, 2, 1, 0, 90, 4816, 6249, 19332, 93, 107, 0.954, 4, 0, 0, 'notDiscovered'],
        ['O claude-sonnet-5.5', 128, 349, 1, 0, 6, 1, 0, 98.7, 6472, 10569, 72032, 563, 239, 2.789, 0, 0, 0, 'commandLimit'],
        ['O deepseek-v4.1-flash', 128, 354, 5, 0, 10, 2, 0, 94.1, 8974, 21991, 57415, 1804.5, 801, 2.898, 1, 0, 0, 'cannotAfford'],
        ['DGX GLM5.3 Flash', 126, 321, 4, 0, 9, 0, 0, 94.6, 41543, 73085, 42176, 744.5, 326, 2.651, 0, 1, 1, 'commandLimit'],
    ],
    '2026-10-17_gemini-4-argon-qwen3.8-flashnext-q2_0-qwen3.8-flashnext-nvfp4_68min.jsonl': [
        ['DGX Qwen3.8 flash next nvfp4', 82, 215, 8, 0, 6, 0, 0, 83.1, 36289, 74921, 8140, 1500.5, 654, 2.793, 0, 2, 0, 'assignFromEmpty'],
        ['RTX qwen3.8 flash next Q2_0', 52, 137, 0, 0, 3, 0, 0, 100, 30982, 45172, 12656.5, 1761.5, 706, 2.692, 0, 0, 0, null],
        ['O gemini-4-argon', 84, 229, 0, 0, 8, 0, 0, 100, 8635, 19633, 34700.5, 264, 140, 2.821, 0, 0, 0, null],
    ],
    // Two MCP seats: their harnesses report no token usage, and that reads as "not
    // reported", never as zero.
    '2026-11-07_pi-hy4-hermes-deepseek-v4.1_12min.jsonl': [
        ['pi MCP', 40, 56, 8, 0, 3, 1, 6, 30.8, 13, 22, null, null, null, 1.7, 0, 0, 0, 'noTCWorkers'],
        ['HERMES MCP', 39, 108, 1, 0, 2, 0, 0, 96.2, 4952, 18946, null, null, null, 2.846, 0, 0, 1, 'populationLimit'],
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
        assert.equal(p.kind, 'war-eval/1'); assert.equal(p.scale, 'v4.1'); assert.equal(p.unreadable, 0);
        // Scale v4.1 severity-weighted Bayesian Grounding: 100 * exp(-4.5 * (1.0*constraint + 2.5*reference + 1.5*repeated) / (rated + 8)).
        for (const s of p.seats) {
            const g = s.grounding;
            assert.equal(g.judged, g.ok + g.avoidable + g.invalid);
            assert.equal(g.rated, g.judged - g.waits);
            assert.equal(g.rate, (g.ok - g.waits) / g.rated);
            const w = 1.0 * g.constraint + 2.5 * g.reference + 1.5 * g.repeated;
            assert.equal(g.score, Math.round(1000 * Math.exp(-4.5 * w / (g.rated + 8))) / 10);
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
            // Scale v4.1 snapshot-grounded reconciliation conserves total judged + contended commands:
            // world-drift stale errors move from avoidable -> contended, and hallucinated handles move back.
            assert.deepEqual([g.ok, g.invalid, g.avoidable + g.contended],
                [m.succeeded, m.invalidActions, m.rejected + (m.contended || 0)], file + ' ' + s.name + ': verdicts conserved');
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
    // Qualitative plan container travels identically without heuristic grading: a's two statements, b's none.
    assert.deepEqual([a.plan.statements, a.plan.revisions, a.plan.firstAt, JSON.parse(JSON.stringify(a.plan.standing))],
        [2, 1, 1, { objective: null, steps: ['Build a tower', 'Attack the persians'] }]);
    assert.deepEqual([b.plan.statements, b.plan.revisions, b.plan.firstAt, b.plan.standing], [0, 0, null, null]);
    assert.equal('score' in a.plan, false);
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
    // 18 orders that worked, 2 constraint refusals, and 20 waits: 90 % valid over 20 rated, Bayesian K=8 score = 72.5.
    let g = grounding([line(Array.from({ length: 18 }, () => act('ok')).concat([act('avoidable', 'cannotAfford'), act('avoidable', 'cannotAfford')], Array.from({ length: 20 }, () => wait())))]);
    assert.deepEqual([g.judged, g.ok, g.waits, g.rated, g.rate, g.score], [40, 38, 20, 20, 0.9, 72.5]);
    // Only waits: zero rated commands -> score is 0 (wait-farming yields 0, never 100 or null).
    g = grounding([line([wait()]), line([wait()]), line([wait()])]);
    assert.deepEqual([g.judged, g.ok, g.waits, g.rated, g.rate, g.score], [3, 3, 3, 0, null, 0]);
    // A wait that was refused is a mistake like any other.
    g = grounding([line([wait('invalid'), act('ok')])]);
    assert.deepEqual([g.waits, g.rated, g.invalid, g.rate], [0, 2, 1, 0.5]);
    // Across the shipped matches the counts stay the harness's own: waits are among the ok.
    for (const f of samples) for (const s of WarEval.profileOf(fs.readFileSync(sample(f), 'utf8')).seats) assert.ok(s.grounding.waits <= s.grounding.ok, f);
});

test('contended commands and the harness\'s own failures leave both sides of the rate; severity and K=8 weight errors', () => {
    const g = grounding([turnLine('a', [['ok', 'k'], ['ok', 'k'], ['contended', 'trainerBusy'], ['harnessFault', 'executionFailed'], ['avoidable', 'cannotAfford']])]);
    assert.deepEqual([g.judged, g.ok, g.avoidable, g.contended, g.harnessFault], [3, 2, 1, 1, 1]);
    assert.equal(g.rate, 2 / 3);
    assert.equal(g.score, 66.4);                            // 1 constraint in 3 rated with K=8 Bayesian smoothing
    assert.equal(grounding([turnLine('a', [['ok', 'k'], ['contended', 'trainerBusy']])]).score, 100);
    // Reference errors (2.5x) hurt more than constraint errors (1.0x), and repeats add +1.5x.
    const refErr = grounding([turnLine('a', [['ok', 'k'], ['invalid', 'targetNotFound']])]);
    const conErr = grounding([turnLine('a', [['ok', 'k'], ['avoidable', 'cannotAfford']])]);
    assert.equal(conErr.score, 63.8);
    assert.ok(refErr.score < conErr.score, '2.5x reference penalty < 1.0x constraint penalty');
    const singleRef = grounding([turnLine('a', [['invalid', 'targetNotFound'], ['ok', 'k'], ['ok', 'k']]), turnLine('a', [['ok', 'k'], ['ok', 'k']])]);
    const repCon = grounding([turnLine('a', [['avoidable', 'cannotAfford']]), turnLine('a', [['avoidable', 'cannotAfford']])]);
    assert.ok(singleRef.reference === 1 && repCon.repeated === 1);
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
    assert.deepEqual(p.match, { matchId: 'm', build: 7, promptVersion: null, turnBased: false, lockstepSliceMs: null, roundTimeoutMs: null, mode: 'realtime', maxCommands: 3 });
});

test('the command-line report says so when a file predates recorded outcomes', async () => {
    const old = samples.find(f => f.startsWith('2026-08-17'));
    const text = report(old, await profileFile(sample(old)));
    assert.match(text, /recorded from build 1023 on/);
    assert.match(text, /build not recorded/);
    const mcp = report('x.jsonl', await profileFile(sample('2026-11-07_pi-hy4-hermes-deepseek-v4.1_12min.jsonl')));
    assert.match(mcp, /not reported/);
    assert.match(mcp, /pi MCP +30\.8 +86\.0 % +49 +7 /);           // seven of its 56 were waits
    assert.doesNotMatch(mcp, /recorded from build 1023/);
});

// ---- Macro & Agency, Spatial, Qualitative Plan (Scale v4.1) -----------------------------
const MACRO = {
    '2026-10-05_gpt6.1-sol-claude-sonnet5.5-deepseek-v4.1-glm5.3_99min.jsonl': [
        ['O gpt-6.1-sol', 54.8, 39.7, 73.8, 56, 0.342, 0, 3, 4, 11, 13, 8, 5, 1],
        ['O claude-sonnet-5.5', 85.1, 90, 69.3, 94.3, 0.906, 0.93, 0, 0, 51, 60, 28, 4, 3],
        ['O deepseek-v4.1-flash', 87.1, 100, 63.8, 93.2, 0.904, 0.962, 1, 0, 27, 63, 21, 13, 3],
        ['DGX GLM5.3 Flash', 88.7, 100, 76.1, 86.1, 0.855, 0.879, 5, 0, 23, 75, 25, 13, 3],
    ],
    '2026-10-17_gemini-4-argon-qwen3.8-flashnext-q2_0-qwen3.8-flashnext-nvfp4_68min.jsonl': [
        ['DGX Qwen3.8 flash next nvfp4', 85.4, 91.1, 67.9, 95.3, 0.922, 0.93, 0, 0, 18, 35, 18, 14, 3],
        ['RTX qwen3.8 flash next Q2_0', 87.3, 87.8, 81.7, 92, 0.867, 0.933, 0, 0, 18, 40, 17, 11, 2],
        ['O gemini-4-argon', 91.6, 100, 77.9, 94, 0.927, 0.952, 1, 0, 20, 51, 16, 12, 3],
    ],
    '2026-11-07_pi-hy4-hermes-deepseek-v4.1_12min.jsonl': [
        ['pi MCP', 77.9, 90.6, 82.2, 56.8, 0.516, 0.125, 5, 2, 14, 14, 9, 6, 1],
        ['HERMES MCP', 93.8, 100, 80.7, 98.5, 0.975, 1, 0, 0, 20, 40, 15, 5, 2],
    ],
};
for (const [file, want] of Object.entries(MACRO)) {
    test('macro and situational batching on ' + file.slice(0, 10) + ' are what they were', async () => {
        const p = await profileFile(sample(file));
        assert.deepEqual(p.seats.map(s => { const m = s.macro; return [s.name, m.score, m.devScore, m.opsScore, m.agencyScore,
            m.bwUtil == null ? null : +m.bwUtil.toFixed(3), m.parallelRate == null ? null : +m.parallelRate.toFixed(3),
            m.passiveWaits, m.justifiedWaits, m.maxWorkers, m.maxPop, m.maxBuildings, m.maxTechs, m.ages]; }), want);
    });
}

const SPATIAL = {
    '2026-10-05_gpt6.1-sol-claude-sonnet5.5-deepseek-v4.1-glm5.3_99min.jsonl': [
        ['O gpt-6.1-sol', 77.1, 34.9, 3, 3, 41, 1],
        ['O claude-sonnet-5.5', 90.3, 45.6, 3, 3, 121, 0],
        ['O deepseek-v4.1-flash', 88.6, 44, 3, 3, 109, 0],
        ['DGX GLM5.3 Flash', 76.1, 31.9, 3, 3, 104, 0],
    ],
    '2026-10-17_gemini-4-argon-qwen3.8-flashnext-q2_0-qwen3.8-flashnext-nvfp4_68min.jsonl': [
        ['DGX Qwen3.8 flash next nvfp4', 56.3, 14.2, 2, 2, 66, 1],
        ['RTX qwen3.8 flash next Q2_0', 59.5, 15.2, 2, 2, 37, 0],
        ['O gemini-4-argon', 100, 57.9, 2, 2, 86, 0],
    ],
    '2026-11-07_pi-hy4-hermes-deepseek-v4.1_12min.jsonl': [
        ['pi MCP', 66.8, 10.2, 1, 1, 19, 0],
        ['HERMES MCP', 69.6, 10.9, 1, 1, 34, 0],
    ],
};
for (const [file, want] of Object.entries(SPATIAL)) {
    test('spatial and fog reasoning on ' + file.slice(0, 10) + ' are what they were', async () => {
        const p = await profileFile(sample(file));
        assert.deepEqual(p.seats.map(s => { const sp = s.spatial; return [s.name, sp.score, sp.maxExplored == null ? null : +sp.maxExplored.toFixed(1), sp.discovered, sp.opponents, sp.spatialOrders, sp.spatialErrors]; }), want);
    });
}

test('macro openFronts measures situational 3/turn batching, deduplicates assign_workers, separates passive waits, and gates zero dev', () => {
    const macroOf = lines => { const l = WarEval.createLedger(); lines.forEach(x => l.addLine(x)); return l.profile().seats[0].macro; };
    const open3State = (sec = 120) => ({
        clock: { matchSeconds: sec },
        workers: { total: 6, idle: 2 },
        population: { used: 10, capacityNow: 15, capacityCeiling: 100 },
        resources: { food: 400, wood: 400, stone: 100, gold: 100 },
        friendlyBuildings: [{ type: 'town_center', x: 0, z: 0, state: 'complete', busy: false }],
        units: { trainable: { town_center: { stone: [{ id: 'worker' }] } } },
        research: { researched: ['house'], available: [{ id: 'farm', canAfford: true }] },
        epoch: { current: 'stone', nextEpochCost: { food: 800, wood: 800, stone: 400, gold: 0 } }
    });
    const cmdLine = (cmds, state, outcomes) => JSON.stringify({
        turn: 1, playerId: 'a',
        parsed: { commands: cmds.map(a => ({ action: a, params: {} })) },
        outcomes: outcomes || cmds.map((a, i) => ({ n: i + 1, action: a, code: 'k', verdict: 'ok' })),
        state
    });
    // 3 open fronts (idle workers + available tech + idle trainer): 3 distinct valid commands earn full bandwidth vs 1/3 for 1 command.
    const batched = macroOf([cmdLine(['assign_workers', 'train_unit', 'research_tech'], open3State())]);
    const single = macroOf([cmdLine(['train_unit'], open3State())]);
    assert.deepEqual([batched.bwUtil, batched.parallelRate, batched.batch.three], [1, 1, 1]);
    assert.deepEqual([+single.bwUtil.toFixed(3), single.parallelRate, single.batch.one], [0.333, 0, 1]);
    // Spamming assign_workers three times in one turn deduplicates to 1 productive operation.
    const spamAssign = macroOf([cmdLine(['assign_workers', 'assign_workers', 'assign_workers'], open3State())]);
    assert.deepEqual([+spamAssign.bwUtil.toFixed(3), spamAssign.parallelRate], [0.333, 0]);
    // Wait when openFronts >= 1 is passiveWait; wait when openFronts === 0 is justifiedWait.
    const calmState = { clock: { matchSeconds: 120 }, workers: { total: 6, idle: 0 }, population: { used: 6, capacityNow: 15, capacityCeiling: 100 }, resources: { food: 50, wood: 50, stone: 0, gold: 0 } };
    const passiveWait = macroOf([cmdLine(['wait'], open3State())]);
    const justifiedWait = macroOf([cmdLine(['wait'], calmState)]);
    assert.deepEqual([passiveWait.passiveWaits, passiveWait.justifiedWaits], [1, 0]);
    assert.deepEqual([justifiedWait.passiveWaits, justifiedWait.justifiedWaits], [0, 1]);
    assert.ok(justifiedWait.agencyScore > passiveWait.agencyScore);
    // Starting baseline (3 workers, 3 pop, 1 bld, 0 tech, 0 age) has devScore = 0 -> activityGate = 0 -> macro.score = 0.
    const baseline = { clock: { matchSeconds: 120 }, workers: { total: 3, idle: 0 }, population: { used: 3, capacityNow: 10, capacityCeiling: 100 }, friendlyBuildings: [{ type: 'town_center', x: 0, z: 0 }] };
    const zeroDev = macroOf([cmdLine(['assign_workers'], baseline)]);
    assert.deepEqual([zeroDev.devScore, zeroDev.activityGate, zeroDev.score], [0, 0, 0]);
});

test('spatial rewards exploration, post-4m rival discovery, and clean spatial commands', () => {
    const spOf = lines => { const l = WarEval.createLedger(); lines.forEach(x => l.addLine(x)); return l.profile().seats[0].spatial; };
    const spTurn = (sec, explored, opps, cmds) => JSON.stringify({
        turn: 1, playerId: 'a',
        parsed: { commands: cmds.map(([a]) => ({ action: a, params: {} })) },
        outcomes: cmds.map(([a, v, code], i) => ({ n: i + 1, action: a, code: code || 'k', verdict: v || 'ok' })),
        state: {
            clock: { matchSeconds: sec },
            map: { exploration: [[explored, explored]] },
            gameStats: { opponents: opps.map((d, i) => ({ id: 'r' + i, discovered: d })) }
        }
    });
    // Early (<= 4m): discovery weight is 0, clean scout scores strongly. Late (16m): missing discovery pulls score down.
    const earlyClean = spOf([spTurn(180, 12, [false, false], [['explore', 'ok']])]);
    const lateMissed = spOf([spTurn(960, 25, [false, false], [['explore', 'ok']])]);
    const lateFound = spOf([spTurn(960, 25, [true, true], [['explore', 'ok']])]);
    const lateErrs = spOf([spTurn(960, 25, [true, true], [['attack_target', 'invalid', 'targetOutOfSight'], ['move_units', 'avoidable', 'offMap']])]);
    assert.ok(earlyClean.discScore === 0 && earlyClean.expScore > 90);
    assert.ok(lateFound.score > lateMissed.score && lateFound.score > lateErrs.score);
    assert.deepEqual([lateErrs.spatialOrders, lateErrs.spatialErrors], [2, 2]);
});

test('plan statements equal the plan calls in every shipped file, cleanly deduplicated without scoring', () => {
    let seats = 0;
    for (const file of samples) {
        const text = fs.readFileSync(sample(file), 'utf8'), calls = {};
        for (const l of text.split('\n')) {
            if (!l || l.startsWith('{"type"')) continue;
            const o = JSON.parse(l), q = o.parsed || {};
            if ((Array.isArray(q.plan) && q.plan.length) || (typeof q.objective === 'string' && q.objective.trim())) calls[o.playerId] = (calls[o.playerId] || 0) + 1;
        }
        for (const s of WarEval.profileOf(text).seats) {
            const g = s.plan;
            assert.equal(g.statements, calls[s.id] || 0, file + ' ' + s.name);
            assert.equal('score' in g, false, file + ' ' + s.name);
            assert.equal(g.statements ? g.revisions : 0, g.history.length ? g.history.length - 1 : 0, file + ' ' + s.name);
            seats++;
        }
    }
    assert.ok(seats >= 60);
});

const planTurn = (parsed, state, playerId = 'a') => JSON.stringify({ turn: 1, playerId, parsed: Object.assign({ commands: [] }, parsed),
    state: Object.assign({ population: { used: 20 }, threats: { underAttack: [], enemyWonders: [] } }, state) });
const planOf = lines => { const l = WarEval.createLedger(); lines.forEach(x => l.addLine(x)); return l.profile().seats[0].plan; };
const quiet = planTurn({});

test('qualitative plan stores standing plan and counts revisions without grading prose', () => {
    const empty = planOf([quiet, quiet]);
    assert.deepEqual([empty.statements, empty.revisions, empty.firstAt, empty.standing], [0, 0, null, null]);
    const p1 = { objective: 'Hold', plan: ['Build tower', 'Train militia'] };
    const p2 = { objective: 'Hold', plan: ['Build tower', 'Attack'] };
    const res = planOf([quiet, planTurn(p1), planTurn(p1), planTurn(p2)]);
    assert.deepEqual([res.statements, res.revisions, res.firstAt, res.standing], [3, 1, 2, { objective: 'Hold', steps: ['Build tower', 'Attack'] }]);
});

test('the profile is worked out again when a line has arrived, and not before', () => {
    const l = WarEval.createLedger();
    l.addLine(quiet);
    const first = l.profile();
    assert.equal(l.profile(), first);
    l.addLine(planTurn({ plan: ['Build a tower'] }));
    assert.notEqual(l.profile(), first);
    assert.equal(l.profile().seats[0].plan.statements, 1);
    l.addLine('{not json');
    assert.equal(l.profile().unreadable, 1);
});

// ---- Tactical & Combat (Scale v4) ---------------------------------------------------------
const TACTICAL = {
    '2026-10-05_gpt6.1-sol-claude-sonnet5.5-deepseek-v4.1-glm5.3_99min.jsonl': [
        ['O gpt-6.1-sol', 27.8, 1, 1, 1, 0, 1, 0, 1, 1, 0, 12, 3, 23, 0, 7],
        ['O claude-sonnet-5.5', 50.3, 3, 1, 1, 1, 2, 1, 1, 1, 1, 36, 127, 144, 35, 7],
        ['O deepseek-v4.1-flash', 60.3, 3, 2, 2, 0, 2, 1, 2, 2, 2, 48, 192, 151, 29, 34],
        ['DGX GLM5.3 Flash', 55.1, 2, 2, 2, 0, 1, 1, 1, 1, 1, 44, 77, 81, 7, 23],
    ],
    '2026-10-17_gemini-4-argon-qwen3.8-flashnext-q2_0-qwen3.8-flashnext-nvfp4_68min.jsonl': [
        ['DGX Qwen3.8 flash next nvfp4', 39.2, 3, 2, 2, 0, 1, 2, 1, 0, 0, 16, 48, 79, 0, 28],
        ['RTX qwen3.8 flash next Q2_0', 20.4, 1, 0, 0, null, 1, 0, 1, 0, 0, 7, 7, 60, 0, 17],
        ['O gemini-4-argon', 72.8, 0, 0, 0, null, 0, 0, 0, 1, 1, 21, 138, 54, 45, 0],
    ],
    '2026-11-07_pi-hy4-hermes-deepseek-v4.1_12min.jsonl': [
        ['pi MCP', 41, 0, 0, 0, null, 0, 0, 0, 0, 0, 7, 9, 13, 0, 3],
        ['HERMES MCP', 59, 0, 0, 0, null, 0, 0, 0, 0, 0, 7, 13, 9, 3, 0],
    ],
};
for (const [file, want] of Object.entries(TACTICAL)) {
    test('tactical and combat on ' + file.slice(0, 10) + ' is what it was', async () => {
        const p = await profileFile(sample(file));
        assert.deepEqual(p.seats.map(s => { const g = s.tactical; return [s.name, g.score, g.episodes, g.answered, g.atOnce, g.decisionsToAnswer, g.lost, g.held, g.undefended, g.wonders, g.wonderAnswered, g.battles, g.destroyed, g.unitsLost, g.bldRazed, g.bldLost]; }), want);
    });
}

test('every episode opens at a state that showed a home threat, after one that did not', () => {
    const isHome = (u, blds) => u && typeof u.x === 'number' && typeof u.z === 'number'
        && (u.kind === 'building' || u.type === 'worker'
            || blds.some(b => b && typeof b.x === 'number' && typeof b.z === 'number' && Math.hypot(u.x - b.x, u.z - b.z) <= WarEval.HOME_RADIUS));
    let episodes = 0;
    for (const file of samples) {
        const text = fs.readFileSync(sample(file), 'utf8'), byTurn = new Map();
        for (const l of text.split('\n')) {
            if (!l || l.startsWith('{"type"')) continue;
            const o = JSON.parse(l), th = (o.state && o.state.threats) || {};
            const blds = (o.state && o.state.friendlyBuildings) || [];
            const homeAttacked = Array.isArray(th.underAttack) && th.underAttack.some(u => isHome(u, blds));
            byTurn.set(o.playerId + '|' + o.turn, { attacked: homeAttacked, wonders: (th.enemyWonders || []).map(w => String(w.id)), sec: o.state && o.state.clock && o.state.clock.matchSeconds });
        }
        for (const s of WarEval.profileOf(text).seats) for (const e of s.tactical.list) {
            const at = byTurn.get(s.id + '|' + e.turn), before = byTurn.get(s.id + '|' + (e.turn - 1));
            assert.ok(at, file + ' ' + s.name + ' turn ' + e.turn);
            assert.equal(at.sec, e.sec, file + ': the episode carries the moment of its first sighting');
            if (e.kind === 'attack') { assert.equal(at.attacked, true, file + ' ' + s.name); if (before) assert.equal(before.attacked, false, file + ' ' + s.name + ': no prior home threat'); }
            else assert.ok(at.wonders.length > 0 && !(before && before.wonders.length === at.wonders.length && before.wonders.every(w => at.wonders.includes(w))), file + ' ' + s.name + ': a Wonder it had not been shown');
            episodes++;
        }
    }
    assert.ok(episodes >= 70, 'only ' + episodes + ' episodes in the shipped matches');
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
const farSkirmish = [{ kind: 'unit', type: 'militia', x: 350, z: 350, healthPct: 50, attackerAt: { x: 355, z: 350, owner: 'maya-2' } }];
const nearArmyRaid = [{ kind: 'unit', type: 'militia', x: 160, z: 100, healthPct: 50, attackerAt: { x: 165, z: 100, owner: 'maya-2' } }];
const tactical = lines => { const l = WarEval.createLedger(); lines.forEach(x => l.addLine(x)); return l.profile().seats[0].tactical; };
const calm = scene(null, [{ action: 'train_unit', unitType: 'worker' }]);

test('an order aimed at the threat answers it, HOME_RADIUS filters skirmishes, and assign_workers answers worker raids', () => {
    const one = order => tactical([calm, scene(raid, [order]), calm]);
    assert.deepEqual([one({ action: 'attack_target', targetX: 108, targetZ: 100 }).answered, one({ action: 'attack_target', targetX: 108, targetZ: 100 }).score], [1, 54.4]);
    assert.equal(one({ action: 'attack_target', targetId: 'e1' }).answered, 1);          // a target named by its id points where the state showed it
    assert.equal(one({ action: 'attack_target', targetX: -300, targetZ: -300 }).answered, 0);   // an attack somewhere else is not an answer
    assert.equal(one({ action: 'move_units', targetX: 95, targetZ: 105, units: { militia: 4 } }).answered, 1);
    assert.equal(one({ action: 'move_units', mode: 'scout', targetX: 95, targetZ: 105 }).answered, 0);
    assert.equal(one({ action: 'build_structure', buildingType: 'tower', targetX: 104, targetZ: 96 }).answered, 1);
    assert.equal(one({ action: 'build_structure', buildingType: 'house', targetX: 104, targetZ: 96 }).answered, 0);
    assert.equal(one({ action: 'repair_building', targetX: 100, targetZ: 100 }).answered, 1);
    assert.equal(one({ action: 'assign_workers' }).answered, 0);                         // assign_workers alone does not answer a building raid
    assert.equal(one({ action: 'train_unit', unitType: 'militia' }).answered, 0);
    assert.deepEqual([one({ action: 'train_unit', unitType: 'militia' }).unanswered, one({ action: 'train_unit', unitType: 'militia' }).score], [1, 45.6]);
    assert.equal(one({ action: 'attack_target', targetX: 108, targetZ: 100, verdict: 'avoidable' }).answered, 0);
    // Worker raid is answered by assign_workers; far skirmish > HOME_RADIUS (110) does not open an episode.
    assert.deepEqual([tactical([calm, scene(workerRaid, [{ action: 'assign_workers' }]), calm]).answered,
        tactical([calm, scene(farSkirmish, []), calm]).episodes,
        tactical([calm, scene(nearArmyRaid, []), calm]).episodes], [1, 0, 1]);
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
    assert.deepEqual([after(1).answered, after(1).atOnce, after(1).score], [1, 1, 54.4]);
    assert.deepEqual([after(2).answered, after(2).atOnce, after(2).score, after(2).decisionsToAnswer], [1, 0, 45.6, 2]);
    assert.deepEqual([after(3).answered, after(3).unanswered], [0, 1]);
});

test('one attack is one episode however long it lasts, and value-weighted combat + razings + 3-way splits score tactical exchange', () => {
    const gone = { friendlyBuildings: [{ type: 'town_center', x: 0, z: 0 }] };
    const t = tactical([calm, scene(raid, []), scene(raid, []), scene(null, [], gone), calm, scene(workerRaid, [{ action: 'attack_target', targetId: 'e1' }]), calm]);
    assert.deepEqual([t.episodes, t.answered, t.lost, t.held, t.score], [2, 1, 1, 1, 50]);
    assert.deepEqual(t.list.map(e => [e.kind, e.decision, e.sec, e.decisions, e.outcome, e.what.join(), e.by, e.answeredAfter]),
        [['attack', 2, 100, 2, 'lost', 'barracks', 'maya-2', null], ['attack', 6, 100, 1, 'held', 'worker', 'maya-2', 0]]);
    assert.equal(tactical([calm, scene(raid, [])]).list[0].outcome, 'open');
    assert.equal(tactical([calm, scene([Object.assign({ noDefenders: true }, raid[0])], [])]).undefended, 1);
    // 3-way battle with lostValue + Town Center razing (600) by seat a: splits enemy losses by 2, values expensive losses higher.
    const l = WarEval.createLedger();
    l.addLine(calm);
    l.addLine(JSON.stringify({ type: 'chronicle', kind: 'battle', t: 120, sides: { a: { lost: 1, lostValue: 100 }, b: { lost: 2, lostValue: 200 }, c: { lost: 2, lostValue: 600 } } }));
    l.addLine(JSON.stringify({ type: 'chronicle', kind: 'town-center-lost', t: 130, by: 'a', seats: ['b'] }));
    const res = l.profile().seats[0].tactical;
    assert.deepEqual([res.battles, res.destroyed, res.unitsLost, res.bldRazed, res.bldLost, res.valueWeighted], [1, 2, 1, 1, 0, true]);
    assert.ok(res.exchange > 0.9 && res.exchangeScore > 73 && res.score > 65);
});

test('a rival Wonder is a threat from the decision that first showed it, answered by an attack on it', () => {
    const wonder = { threats: { underAttack: [], enemyWonders: [{ id: 'w1', type: 'pyramid', x: 300, z: 300, owner: 'maya-2' }] } };
    const hit = tactical([calm, scene(null, [], wonder), scene(null, [{ action: 'attack_target', targetId: 'w1' }], wonder), scene(null, [], wonder)]);
    assert.deepEqual([hit.wonders, hit.wonderAnswered, hit.episodes, hit.score], [1, 1, 0, 54.4]);
    assert.equal(tactical([calm, scene(null, [{ action: 'attack_target', targetX: 310, targetZ: 290 }], wonder)]).wonderAnswered, 1);
    assert.equal(tactical([calm, scene(null, [{ action: 'attack_target', targetX: 0, targetZ: 0 }], wonder), calm, calm]).wonderAnswered, 0);
    assert.equal(tactical([calm, scene(null, [], wonder), calm, calm, scene(null, [{ action: 'attack_target', targetId: 'w1' }], wonder)]).score, 45.6);
});

test('peaceful tactical falls back to 50 * activityGate, and unjudged transcripts use exchangeScore', () => {
    const none = tactical([calm, calm, calm]);
    assert.deepEqual([none.episodes, none.wonders, none.score, none.list.length], [0, 0, 50, 0]);
    const idleCalm = tactical([scene(null, [], { population: { used: 3 }, friendlyBuildings: [{ type: 'town_center', x: 0, z: 0 }] })]);
    assert.equal(idleCalm.score, 0);
    const old = tactical([JSON.stringify({ turn: 1, playerId: 'a', parsed: { commands: [{ action: 'attack_target', params: { targetX: 108, targetZ: 100 } }] },
        state: { population: { used: 20 }, threats: { underAttack: raid, enemyWonders: [] } } })]);
    assert.deepEqual([old.judged, old.episodes, old.answered, old.score], [false, 1, null, 50]);
});

// ---- Dominance (Strategy), Versatility, WAR Score, Drift & Warmup (Scale v4.1) --
const STRATEGY = {
    '2026-10-05_gpt6.1-sol-claude-sonnet5.5-deepseek-v4.1-glm5.3_99min.jsonl': [
        ['O gpt-6.1-sol', 10.8, 14.4, 4, 0.085, 0.006, null, null, 12, 3, 23, '487', 2, 5, 5, 9, 50.1, 5],
        ['O claude-sonnet-5.5', 64, 63.1, 2, 0.376, 0.721, 3493, false, 36, 127, 144, '412/812/1342', 3, 6, 4, 9, 78.1, 5],
        ['O deepseek-v4.1-flash', 35.9, 36.7, 3, 0.252, 0.184, null, null, 48, 192, 151, '372/1147/2037', 10, 9, 13, 9, 71.9, 5],
        ['DGX GLM5.3 Flash', 60.9, 47.9, 1, 0.288, 0.107, null, null, 44, 77, 81, '372/1147/2493', 11, 10, 13, 10, 76, 5],
    ],
    '2026-10-17_gemini-4-argon-qwen3.8-flashnext-q2_0-qwen3.8-flashnext-nvfp4_68min.jsonl': [
        ['DGX Qwen3.8 flash next nvfp4', 35.6, 47.5, 3, 0.377, 0.616, null, null, 16, 48, 79, '437/1112/1848', 6, 10, 14, 10, 61.2, 5],
        ['RTX qwen3.8 flash next Q2_0', 39.9, 36.5, 2, 0.21, 0.04, null, null, 7, 7, 60, '667/1612', 7, 9, 11, 8, 63.8, 5],
        ['O gemini-4-argon', 71.3, 61.7, 1, 0.413, 0.358, 3558, true, 21, 138, 54, '622/1112/1687', 6, 6, 12, 9, 86.6, 5],
    ],
    '2026-11-07_pi-hy4-hermes-deepseek-v4.1_12min.jsonl': [
        ['pi MCP', 13, 17.3, 2, 0.273, 0.152, null, null, 7, 9, 13, '470', 1, 4, 6, 7, 45.1, 5],
        ['HERMES MCP', 87, 82.7, 1, 0.727, 0.993, 410, true, 7, 13, 9, '255/710', 4, 6, 5, 7, 83.7, 5],
    ],
};
for (const [file, want] of Object.entries(STRATEGY)) {
    test('strategy, range and WAR Score on ' + file.slice(0, 10) + ' are what they were', async () => {
        const p = await profileFile(sample(file));
        assert.deepEqual(p.seats.map(s => { const g = s.strategy, v = s.versatility; return [s.name, g.score, g.trajDom, g.rank, +g.powerShare.toFixed(3), +g.leadShare.toFixed(3),
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
        if (p.seats.length === results.ranking.length) assert.ok(Math.abs(p.seats.reduce((a, s) => a + s.strategy.powerShare, 0) - 1) < 1e-9, f);
        const battles = lines.filter(o => o.type === 'chronicle' && o.kind === 'battle');
        for (const s of p.seats) assert.equal(s.strategy.lost, battles.reduce((a, b) => a + ((b.sides[s.id] || {}).lost || 0), 0), f + ' ' + s.name);
    }
    assert.ok(files >= 15, 'only ' + files + ' files with results and a timeline');
});

// Two-seat synthetic match helpers
const orderTurn = (orders, extra) => JSON.stringify(Object.assign({ turn: 1, playerId: 'a',
    parsed: Object.assign({ commands: (orders || []).map(([action, name]) => ({ action, params: action === 'train_unit' ? { unitType: name } : action === 'build_structure' ? { buildingType: name } : action === 'research_tech' ? { techId: name } : {} })) }, extra && extra.plan ? { plan: extra.plan } : null),
    outcomes: (orders || []).map(([action, , verdict], i) => ({ n: i + 1, action, code: 'c', verdict: verdict || 'ok' })),
    state: Object.assign({ clock: { matchSeconds: 60 }, population: { used: 20 }, threats: { underAttack: [], enemyWonders: [] } }, extra && extra.state) }, extra && extra.raw));
const over = JSON.stringify({ type: 'results', ranking: [{ playerId: 'a', rank: 1 }] });
const seatsLine = JSON.stringify({ type: 'match', players: [{ id: 'a', seat: 0 }, { id: 'b', seat: 1 }] });
const tick = (t, a, b) => ({ t, p: { a: { pw: a, al: 1 }, b: { pw: b, al: 1 } } });
const timelineOf = (samples, ages) => JSON.stringify({ type: 'timeline', samples, ages: ages || [] });
const resultsOf = winner => JSON.stringify({ type: 'results', ranking: [{ playerId: winner, rank: 1, isWinner: true }, { playerId: winner === 'a' ? 'b' : 'a', rank: 2, isWinner: false }] });
const battle = (t, a, b) => JSON.stringify({ type: 'chronicle', kind: 'battle', t, sides: { a: { involved: 9, lost: a }, b: { involved: 9, lost: b } } });
const strategyOf = lines => { const l = WarEval.createLedger(); [seatsLine, orderTurn([['assign_workers']])].concat(lines).forEach(x => l.addLine(x)); return l.profile().seats.find(s => s.id === 'a').strategy; };

test('strategy uses time-weighted Bradley-Terry dominance (50 at tie) blended 75/25 with final placement', () => {
    const even = Array.from({ length: 10 }, (_, i) => tick(i * 5, 500, 500));
    let g = strategyOf([timelineOf(even), resultsOf('a')]);
    assert.deepEqual([g.placement, g.powerShare, g.evenShare, g.trajDom, g.score, g.running], [1, 0.5, 0.5, 50, 62.5, 50]);
    g = strategyOf([timelineOf(even), resultsOf('b')]);
    assert.deepEqual([g.placement, g.trajDom, g.score, g.winner], [0, 50, 37.5, false]);
    // 900 vs 300 gives 1/(1+(1/3)^1.5) = 83.9% dominance; winner placement = 100 -> 0.75*83.9 + 25 = 87.9.
    g = strategyOf([timelineOf(even.map(x => tick(x.t, 900, 300))), resultsOf('a')]);
    assert.deepEqual([g.powerShare, g.leadShare, g.trajDom, g.score], [0.75, 1, 83.9, 87.9]);
    // Late power advantage at t=900 carries higher weight w = 1 + t/300 than early advantage at t=0.
    const lateLead = strategyOf([timelineOf([tick(0, 200, 800), tick(900, 800, 200)])]);
    const earlyLead = strategyOf([timelineOf([tick(0, 800, 200), tick(900, 200, 800)])]);
    assert.ok(lateLead.trajDom > 65 && earlyLead.trajDom < 35);
});

test('a clear lead is a quarter more power than the next seat, held five minutes, and it is said whether it was won', () => {
    const run = (from, to, a, b) => { const out = []; for (let t = from; t < to; t += 5) out.push(tick(t, a, b)); return out; };
    let g = strategyOf([timelineOf(run(0, 100, 500, 500).concat(run(100, 395, 625, 500), run(395, 600, 500, 500))), resultsOf('a')]);
    assert.deepEqual([g.clearLeadAt, g.converted], [null, null]);
    g = strategyOf([timelineOf(run(0, 100, 500, 500).concat(run(100, 400, 625, 500), run(400, 600, 500, 500))), resultsOf('a')]);
    assert.deepEqual([g.clearLeadAt, g.converted], [395, true]);
    g = strategyOf([timelineOf(run(0, 100, 500, 500).concat(run(100, 400, 625, 500), run(400, 600, 100, 500))), resultsOf('b')]);
    assert.deepEqual([g.clearLeadAt, g.converted], [395, false]);
    g = strategyOf([timelineOf(run(0, 600, 600, 500)), resultsOf('a')]);
    assert.deepEqual([g.leadShare, g.clearLeadAt], [1, null]);
    assert.deepEqual([WarEval.LEAD_FACTOR, WarEval.LEAD_SECONDS], [1.25, 300]);
});

test('a running match has no placement yet, and the timeline shown to it gives way to the line in the file', () => {
    const l = WarEval.createLedger();
    [seatsLine, orderTurn([['assign_workers']]), battle(20, 1, 3)].forEach(x => l.addLine(x));
    assert.deepEqual([l.profile().seats[0].strategy.samples, l.profile().seats[0].tactical.battles], [0, 1]);
    const live = { samples: [tick(5, 600, 400), tick(10, 600, 400)], ages: [{ t: 8, id: 'a', age: 'neolithic' }] };
    l.preview(live);
    let g = l.profile().seats[0].strategy;
    assert.deepEqual(JSON.parse(JSON.stringify([g.final, g.rank, g.placement, g.samples, g.powerShare, g.score, g.running, g.ages])),
        [false, null, null, 2, 0.6, 64.8, 64.8, [{ age: 'neolithic', sec: 8 }]]);
    const before = l.profile();
    l.preview(live);
    assert.equal(l.profile(), before);
    live.samples.push(tick(15, 200, 800));
    l.preview(live);
    assert.equal(l.profile().seats[0].strategy.samples, 3);
    l.addLine(resultsOf('a')); l.addLine(timelineOf(live.samples, live.ages));
    live.samples.push(tick(20, 0, 1000)); l.preview(live);
    const fromFile = WarEval.createLedger();
    [seatsLine, orderTurn([['assign_workers']]), battle(20, 1, 3), resultsOf('a'), timelineOf(live.samples.slice(0, 3), live.ages)].forEach(x => fromFile.addLine(x));
    assert.deepEqual(l.profile(), fromFile.profile());
    assert.deepEqual([l.profile().seats[0].strategy.final, l.profile().seats[0].strategy.samples], [true, 3]);
    assert.doesNotThrow(() => { WarEval.createLedger().preview(null); WarEval.createLedger().preview({}); });
});

test('the profile as it stood at a second reads the timeline and the battles up to it, without the placement', () => {
    const l = WarEval.createLedger();
    [seatsLine, orderTurn([['assign_workers']], { state: { clock: { matchSeconds: 10 } } }),
        battle(20, 0, 4), battle(300, 6, 0), timelineOf([tick(5, 500, 500), tick(10, 500, 500), tick(400, 100, 900)], [{ t: 8, id: 'a', age: 'neolithic' }, { t: 350, id: 'a', age: 'bronze' }]), resultsOf('b')].forEach(x => l.addLine(x));
    const then = l.profileAt(100).seats[0], now = l.profile().seats[0];
    assert.deepEqual([then.strategy.final, then.strategy.placement, then.strategy.samples, then.tactical.battles, then.strategy.ages.length], [false, null, 2, 1, 1]);
    assert.deepEqual([now.strategy.final, now.strategy.placement, now.strategy.samples, now.tactical.battles, now.strategy.ages.length], [true, 0, 3, 2, 2]);
    assert.equal(then.strategy.score, then.strategy.running);
});

test('the range used is what worked, as facts and without a score', () => {
    const l = WarEval.createLedger();
    [orderTurn([['train_unit', 'worker'], ['train_unit', 'militia'], ['train_unit', 'archer', 'avoidable']]),
        orderTurn([['build_structure', 'tower'], ['research_tech', 'longbow'], ['train_unit', 'militia']]),
        orderTurn([['build_structure', 'barracks', 'contended'], ['attack_target']])].forEach(x => l.addLine(x));
    const v = l.profile().seats[0].versatility;
    assert.deepEqual(JSON.parse(JSON.stringify(v)), { units: ['militia'], buildings: ['tower'], techs: ['longbow'], orders: ['attack_target', 'build_structure', 'research_tech', 'train_unit'], score: null });
});

test('WAR Score uses fixed Scale v4 weights (20/25/15/15/25), denies wait-only farming, and gates idle seats', () => {
    assert.deepEqual(Array.from(WarEval.SCORED), ['grounding', 'macro', 'spatial', 'tactical', 'strategy']);
    assert.deepEqual(Array.from(WarEval.INDEX_PARTS), ['grounding', 'macro', 'spatial', 'tactical', 'strategy']);
    assert.deepEqual(WarEval.WEIGHTS, { grounding: 0.20, macro: 0.25, spatial: 0.15, tactical: 0.15, strategy: 0.25 });
    const l = WarEval.createLedger();
    [seatsLine, orderTurn([['build_structure', 'tower']], { plan: ['Build a tower'], state: { population: { used: 3 } } })].forEach(x => l.addLine(x));
    let s = l.profile().seats[0];
    assert.equal(s.index.parts, 5);
    assert.equal(s.index.of, 4);                                       // no strategy sample yet
    l.addLine(timelineOf([tick(5, 100, 500)])); l.addLine(resultsOf('b'));
    s = l.profile().seats.find(x => x.id === 'a');
    assert.equal(s.index.of, 5);
    // Plan + wait-only talker earns 0 grounding, 0 macro, 0 tactical -> near-zero WAR Score.
    const talker = WarEval.createLedger();
    [seatsLine, orderTurn([['wait']], { plan: ['Build a tower', 'Train militia'], state: { population: { used: 3 }, workers: { total: 3, idle: 3 } } })]
        .concat(Array.from({ length: 12 }, () => orderTurn([['wait']], { state: { population: { used: 3 }, workers: { total: 3, idle: 3 } } })), [over])
        .forEach(x => talker.addLine(x));
    const ts = talker.profile().seats[0];
    assert.deepEqual([ts.grounding.score, ts.macro.score, ts.tactical.score], [0, 0, 0]);
    assert.ok(ts.index.value < 5);
    // A seat no model decided for has no WAR Score.
    const other = l.profile().seats.find(x => x.id === 'b');
    assert.deepEqual([other.decisions, other.strategy.rank, other.strategy.score, other.index.value, other.index.of], [0, 1, 93.9, null, 0]);
});

test('drift activates at 16+ decisions and warmup protects early snapshots', () => {
    const l = WarEval.createLedger();
    for (let i = 1; i <= 14; i++) {
        l.addLine(JSON.stringify({ turn: i, playerId: 'a', latencyMs: 1000,
            tokens: { prompt: 5000, completion: 100 },
            parsed: { commands: [{ action: 'train_unit', params: {} }] },
            outcomes: [{ n: 1, action: 'train_unit', code: 'k', verdict: i <= 8 ? 'ok' : 'avoidable' }],
            state: { clock: { matchSeconds: i * 10 }, workers: { total: 4, idle: i <= 8 ? 0 : 2 }, population: { used: 6 } } }));
    }
    let s = l.profile().seats[0];
    assert.equal(s.drift, null);                                        // 14 < DRIFT_MIN_DECISIONS (16)
    assert.equal(s.warmup, true);                                       // sec=140 < 300 && rated=14 < 15 -> warmup holds
    l.addLine(JSON.stringify({ turn: 15, playerId: 'a', latencyMs: 1000,
        tokens: { prompt: 5000, completion: 100 },
        parsed: { commands: [{ action: 'train_unit', params: {} }] },
        outcomes: [{ n: 1, action: 'train_unit', code: 'k', verdict: 'avoidable' }],
        state: { clock: { matchSeconds: 150 }, workers: { total: 4, idle: 2 }, population: { used: 6 } } }));
    assert.equal(l.profile().seats[0].warmup, false);                   // rated === 15 exits warmup even before 300s
    assert.equal(l.profile().seats[0].drift, null);                     // 15 still < DRIFT_MIN_DECISIONS (16)
    l.addLine(JSON.stringify({ turn: 16, playerId: 'a', latencyMs: 2000,
        tokens: { prompt: 12000, completion: 100 },
        parsed: { commands: [{ action: 'train_unit', params: {} }] },
        outcomes: [{ n: 1, action: 'train_unit', code: 'k', verdict: 'avoidable' }],
        state: { clock: { matchSeconds: 160 }, workers: { total: 4, idle: 2 }, population: { used: 6 } } }));
    s = l.profile().seats[0];
    assert.equal(s.warmup, false);                                      // rated >= 15 exits warmup even before 300s
    assert.ok(s.drift && s.drift.decisions === 16);
    assert.equal(s.drift.errDeltaPp, 100);
    assert.equal(s.drift.idleDeltaPp, 50);
    assert.ok(s.drift.latencyRatio >= 1);
});

test('the command-line report prints Scale v4 tables, Dominance, WAR Score, Cost & Drift', async () => {
    const file = sample('2026-10-17_gemini-4-argon-qwen3.8-flashnext-q2_0-qwen3.8-flashnext-nvfp4_68min.jsonl');
    const text = report(file, await profileFile(file));
    assert.match(text, /DOMINANCE \(25%\) +score +placed +trajDom +power share +even split +time ahead +clear lead +ages/);
    assert.match(text, /O gemini-4-argon +71\.3 +1 of 3 +61\.7 +41\.3 % +33\.3 % +35\.8 % +from 59:18, won +neolithic 10:22, bronze 18:32, iron 28:07/);
    assert.match(text, /RANGE USED +unit types +buildings +technologies +kinds of order\n.*\n.*\nO gemini-4-argon +6 +6 +12 +9/);
    assert.match(text, /WAR SCORE +score +warmup +of +grounding +macro +spatial +tactical +dominance/);
    assert.match(text, /O gemini-4-argon +86\.6 +- +5\/5 +100\.0 +91\.6 +100\.0 +72\.8 +71\.3/);
    assert.match(text, /COST & DRIFT +decisions +medLat +p90 +tok\/dec +out\/ok +ok\/think-m +errDrift +idleDrift +latRatio/);
    assert.match(text, /GROUNDING \(20%\) +score +valid +ok +waits +constraint +reference +repeated +contended +unjudged/);
    assert.match(text, /Score scale v4\.1\. Weights: 20% Grounding \+ 25% Macro & Agency \+ 15% Spatial \+ 15% Tactical \+ 25% Dominance\./);
});

// ---- the profile in the export (overhaul step D8) ------------------------------------
test('the profile a results line carries is the profile its own file gives', async () => {
    class Blob { constructor(parts) { this.text = parts.join(''); } }
    const context = vm.createContext({ console, navigator: {}, Blob, Date, WarEval });
    vm.runInContext(fs.readFileSync(path.join(root, 'js/transcript.js'), 'utf8') + '\nthis.T = TranscriptRecorder;', context);
    const rec = new context.T();
    await rec.begin('match-d8', [{ id: 'a', civilization: 'greek', seat: 0, name: 'Seat A', model: 'model-a' },
        { id: 'b', civilization: 'persian', seat: 1, name: 'Seat B', model: 'model-b' }], { build: 1162, promptVersion: 'v-test' });
    const raid = [{ kind: 'building', type: 'barracks', x: 100, z: 100, attackerAt: { x: 108, z: 102, owner: 'persian-2' } }];
    for (let n = 1; n <= 14; n++) {
        for (const id of ['a', 'b']) {
            rec.record(id, { at: 1000 + n, latencyMs: 900, tokens: { prompt: 9000, completion: 200 },
                state: { clock: { matchSeconds: n * 30 }, population: { used: 12 }, buildings: { buildable: [{ type: 'tower' }] },
                    friendlyBuildings: [{ type: 'barracks', x: 100, z: 100 }], threats: { underAttack: n === 6 ? raid : [], enemyWonders: [] } },
                parsed: Object.assign({ commands: [{ action: n === 6 ? 'attack_target' : n % 4 ? 'build_structure' : 'wait', params: n === 6 ? { targetX: 105, targetZ: 100 } : { buildingType: 'tower' } }] },
                    id === 'a' && n === 1 ? { objective: 'Hold', plan: ['Build a tower'] } : null) });
            rec.noteResult(id, 'ok', undefined, [{ n: 1, action: n === 6 ? 'attack_target' : n % 4 ? 'build_structure' : 'wait', code: 'c', verdict: id === 'b' && n % 5 === 0 ? 'avoidable' : 'ok' }]);
        }
    }
    const before = JSON.stringify(rec.ledger.profile());
    const results = { type: 'results', outcome: 'last_standing', ranking: [{ playerId: 'a', rank: 1, isWinner: true }, { playerId: 'b', rank: 2, isWinner: false }] };
    const timeline = { type: 'timeline', samples: Array.from({ length: 80 }, (_, i) => ({ t: i * 5, p: { a: { pw: 600 + i }, b: { pw: 400 } } })), ages: [{ t: 120, id: 'a', age: 'neolithic' }] };
    // Worked out before the two lines exist, and the ledger is left as it was.
    const carried = WarEval.publicProfile(rec.ledger.profileWith(results, timeline));
    assert.equal(JSON.stringify(rec.ledger.profile()), before);
    assert.deepEqual([carried.seats[0].strategy.final, carried.seats[0].strategy.rank, carried.seats[0].strategy.samples], [true, 1, 80]);
    results.profile = carried;
    rec.finish([results, timeline]);
    // A reader of the exported file, scoring it again, arrives at what the file carries.
    const text = (await rec.exportBlob()).text;
    const again = WarEval.profileOf(text);
    assert.ok(WarEval.sameProfile(JSON.parse(JSON.stringify(WarEval.publicProfile(again))), again.recorded));
    assert.deepEqual(JSON.parse(JSON.stringify(rec.ledger.profile())), JSON.parse(JSON.stringify(again)));
    // It is a profile with something in it: every Scale v4 pillar of seat a has a score.
    const a = again.recorded.seats[0];
    assert.deepEqual([a.name, a.decisions, a.grounding.waits, a.grounding.rated, a.plan.statements, a.tactical.episodes, a.tactical.atOnce], ['Seat A', 14, 3, 11, 1, 1, 1]);
    for (const k of WarEval.SCORED) assert.equal(typeof a[k].score, 'number', k);
    assert.equal(typeof a.index.value, 'number');
    // The long lists and verbose plan text stay in the transcript, not the summary profile.
    assert.deepEqual([a.grounding.errors, a.plan.history, a.plan.standing, a.tactical.list], [undefined, undefined, undefined, undefined]);
    assert.ok(again.seats[0].tactical.list.length === 1 && again.seats[0].plan.history.length === 1);
    assert.ok(JSON.stringify(carried).length < 6000, 'the carried profile is ' + JSON.stringify(carried).length + ' characters');
    // The scorer says whether the file agrees with it, and notices a number that was changed.
    const file = path.join(require('node:os').tmpdir(), 'war-d8-' + process.pid + '.jsonl');
    try {
        fs.writeFileSync(file, text);
        assert.match(report(file, await profileFile(file)), /The file carries its own profile, scale v4\.1: scored again here, it is the same\./);
        fs.writeFileSync(file, text.replace('"waits":3', '"waits":2'));
        assert.match(report(file, await profileFile(file)), /The file carries its own profile, scale v4\.1: scored again here on scale v4\.1, it differs\./);
    } finally { fs.rmSync(file, { force: true }); }
    // A file without one says nothing about it.
    assert.doesNotMatch(report('x.jsonl', await profileFile(sample('2026-11-07_pi-hy4-hermes-deepseek-v4.1_12min.jsonl'))), /carries its own profile/);
});

test('a seat no model decided for is not in the exported profile', () => {
    const l = WarEval.createLedger();
    [seatsLine, orderTurn([['build_structure', 'tower']], { plan: ['Build a tower'] }), timelineOf([tick(5, 100, 500)]), resultsOf('b')].forEach(x => l.addLine(x));
    const p = l.profile(), pub = WarEval.publicProfile(p);
    assert.deepEqual([p.seats.length, pub.seats.length, pub.seats[0].id, pub.kind, pub.scale, p.recorded], [2, 1, 'a', 'war-eval/1', 'v4.1', null]);
});
