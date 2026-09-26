// The transcript must record what the results count, and what a human or the
// harness changed. Per-command verdicts come from the same classifier as the
// metrics, so their sums always agree; advice, pauses, adaptations and speed
// changes are written as lines of their own; the header says which schema,
// build and mode produced the file.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const root = path.resolve(__dirname, '..');

function setup() {
    const scope = { console, getCivilization: () => ({ name: 'Egyptians', color: 0xffff00 }) };
    vm.createContext(scope);
    vm.runInContext(fs.readFileSync(path.join(root, 'js/openai-ai.js'), 'utf8'), scope);
    const Manager = vm.runInContext('OpenAIAIManager', scope);
    const manager = new Manager({});
    const seat = { id: 'egypt', aiPlayer: { id: 'egypt', civilization: 'egyptian' },
        model: { provider: 'ollama' }, stats: { turnsExecuted: 0, actionCounts: {} }, turnLog: [{}],
        conversationHistory: [], _moveNo: 2, _moveMs: 1000 };
    seat.seat = seat; manager.aiControllers = [seat];
    const lane = Object.create(seat); lane.pendingLog = []; seat.lanes = [lane];
    const written = { results: [], notes: [], events: [] };
    manager.transcripts = {
        noteResult: (id, text, laneNo, outcomes) => written.results.push({ id, text, outcomes }),
        note: (id, entry) => written.notes.push(Object.assign({ playerId: id }, entry)),
        noteMatch: entry => written.events.push(entry), flush() {},
    };
    const call = (name, args) => ({ type: 'function', function: { name, arguments: JSON.stringify(args) } });
    const parse = calls => manager.parseResponse({ tool_calls: calls, finish_reason: 'tool_calls' }, lane);
    return { Manager, manager, seat, lane, call, parse, written };
}

test('a single command is stamped with its verdict', () => {
    const { manager, lane, call, parse, written } = setup();
    manager.executeTurn(lane, parse([call('wait', { reason: 'Hold' })]));
    assert.equal(written.results.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(written.results[0].outcomes)),
        [{ n: 1, action: 'wait', code: null, verdict: 'ok' }]);
});

test('batched verdicts sum exactly to the result metrics', () => {
    const { manager, seat, lane, call, parse, written } = setup();
    seat.stats = manager.newStats();
    const broken = { type: 'function', function: { name: 'wait', arguments: '{not json' } };
    // An invented action in the legacy {action} shape, and an unparsable call.
    manager.executeTurn(lane, parse([call('wait', {}), call('act', { action: 'fly_away', params: {} }), broken]));
    // Four commands: the fourth is over the limit.
    manager.executeTurn(lane, parse([call('wait', {}), call('wait', {}), call('wait', {}), call('wait', {})]));
    const [a, b] = written.results.map(r => r.outcomes);
    assert.deepEqual(a.map(o => o.verdict).join(), 'ok,invalid,invalid');
    assert.equal(a[1].action, 'fly_away'); assert.equal(a[2].code, 'unparsedCall');
    assert.deepEqual(b.map(o => o.verdict).join(), 'ok,ok,ok,avoidable');
    assert.equal(b[3].code, 'commandLimit');
    assert.deepEqual([...b.map(o => o.n)], [1, 2, 3, 4]);
    const verdicts = a.concat(b).map(o => o.verdict), count = v => verdicts.filter(x => x === v).length;
    const st = seat.stats;
    assert.equal(count('ok'), st.actionsSucceeded);
    assert.equal(count('invalid'), st.invalidActions);
    assert.equal(count('avoidable'), st.actionsRejected);
    assert.equal(count('contended'), st.actionsContended);
    // Nothing carries over into the next turn.
    manager.executeTurn(lane, parse([call('wait', {})]));
    assert.equal(written.results[2].outcomes.length, 1);
});

test('the classifier reads contention from UNFOREWARNED codes', () => {
    const { Manager } = setup();
    assert.equal(Manager.verdictFor('OK - done', null), 'ok');
    assert.equal(Manager.verdictFor('[ERROR] Unknown action "x".', null), 'invalid');
    assert.equal(Manager.verdictFor('[ERROR] busy', 'trainerBusy'), 'contended');
    assert.equal(Manager.verdictFor('[ERROR] Cannot afford house.', 'cannotAfford'), 'avoidable');
});

test('seat pauses are recorded as human interventions, once per change', () => {
    const { manager, written } = setup();
    manager.commitDecision = () => {};
    manager.setPaused('egypt', true); manager.setPaused('egypt', true); manager.setPaused('egypt', false);
    assert.deepEqual(written.notes.map(n => [n.type, n.kind, n.human]),
        [['intervention', 'seatPaused', true], ['intervention', 'seatResumed', true]]);
    assert.ok(written.notes.every(n => typeof n.matchSeconds === 'number' && n.playerId === 'egypt'));
});

test('match events carry no seat and say requested and effective speed', () => {
    const { manager, written } = setup();
    manager.noteMatchEvent({ kind: 'speed', requested: 4, speed: 4, effective: 1 });
    assert.equal(written.events[0].type, 'match_event');
    assert.equal(written.events[0].playerId, undefined);
    assert.equal(written.events[0].effective, 1);
});

test('the recorder writes match events into the export and the header names the schema', async () => {
    class Blob { constructor(parts) { this.text = parts.join(''); } }
    const context = vm.createContext({ console, navigator: {}, Blob, Date });
    vm.runInContext(fs.readFileSync(path.join(root, 'js/transcript.js'), 'utf8') + '\nthis.T = TranscriptRecorder;', context);
    const rec = new context.T();
    await rec.begin('match-x', [{ id: 'p1', civilization: 'greek', seat: 0 }], { schema: 'war-transcript/2', mode: 'arena' });
    rec.noteMatch({ type: 'match_event', kind: 'paused', matchSeconds: 5 });
    rec.record('p1', { parsed: { action: 'wait' } });
    rec.noteResult('p1', 'OK', undefined, [{ n: 1, action: 'wait', code: null, verdict: 'ok' }]);
    const lines = (await rec.exportBlob()).text.split('\n').filter(Boolean).map(l => JSON.parse(l));
    assert.equal(lines[0].schema, 'war-transcript/2');
    assert.ok(lines.some(l => l.type === 'match_event' && !l.playerId));
    assert.equal(lines.find(l => !l.type).outcomes[0].verdict, 'ok');
    const src = fs.readFileSync(path.join(root, 'js/openai-ai.js'), 'utf8');
    for (const key of ["schema: 'war-transcript/2'", "mode: this.game.spectatorMode ? 'arena' : 'campaign'", 'humanSeat:', 'build:'])
        assert.ok(src.includes(key), key);
});

test('the analyzer keeps notes out of the seat list and counts each kind', () => {
    const context = vm.createContext({ console });
    vm.runInContext(fs.readFileSync(path.join(root, 'js/analyzer.js'), 'utf8') + '\nthis.T = TranscriptAnalyzer;', context);
    const a = new context.T({});
    const lines = [
        { type: 'match', players: [{ id: 'p1', seat: 0, civ: 'greek' }], mode: 'campaign' },
        { type: 'match_event', kind: 'paused', matchSeconds: 3, at: 3 },
        { type: 'intervention', kind: 'advice', human: true, text: 'Build towers', playerId: 'p1', matchSeconds: 4, at: 4 },
        { type: 'round_missed', playerId: 'p1', matchSeconds: 5, at: 5 },
        { playerId: 'p1', parsed: { action: 'wait' }, harnessResult: 'OK', at: 6, state: { clock: { matchSeconds: 6 } } },
    ];
    a.load(lines.map(l => JSON.stringify(l)).join('\n'), 'x.jsonl');
    assert.equal(a.seats.size, 1);
    const st = a.stats();
    assert.equal(st.markers, 1);
    assert.equal(st.interventions, 1);
    assert.equal(a.turnKind(lines[1]), 'matchEvent');
    assert.equal(a.turnKind(lines[2]), 'intervention');
});
