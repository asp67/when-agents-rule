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
    const turn = (id, n, latencyMs, tokens) => rec.record(id, { at: 1000 + n, latencyMs, tokens,
        state: { clock: { matchSeconds: n * 10 } }, parsed: { commands: [{ action: 'train_unit' }, { action: 'train_unit' }] } });
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
