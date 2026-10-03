// The WAR Bench runner (review #8 step 4). A model seat is the arena's own seat: its
// turns go through sendToOpenAI, strict -- no adaptation, no rate-limit retry, no
// context shrinking -- under a declared ceiling. The "model" here is a stub on the
// wire, so the whole path is real: scenario prompt, request, parser, executor, score.
const test = require('node:test'), assert = require('node:assert/strict');
const S = require('../tools/bench/scenario.cjs');
const { modelPolicy, runSuite } = require('../tools/bench/runner.cjs');

const ALL = S.loadAll();
const CFG = { name: 'stub', endpoint: 'http://127.0.0.1:9/v1', model: 'stub-model', maxTokens: 512, reqOpts: { temperature: 0.4 } };
const reply = calls => ({ ok: true, status: 200, headers: { get: () => 'application/json' },
    json: async () => ({ choices: [{ message: { role: 'assistant', content: null, tool_calls: calls }, finish_reason: 'tool_calls' }], usage: {} }) });
const refused = (status, text) => ({ ok: false, status, headers: { get: () => null }, text: async () => text });

// A "model" that answers each round with the scenario's reference commands, as tool calls.
function referenceModel(inst, seen) {
    let round = 0;
    return async (url, init) => {
        round++;
        seen.push(JSON.parse(init.body));
        const r = inst.reference.find(x => x.round === round);
        const calls = (r ? r.commands : [{ action: 'wait', params: {} }]).map((c, i) =>
            ({ id: 'c' + i, type: 'function', function: { name: c.action, arguments: JSON.stringify(c.params) } }));
        return reply(calls);
    };
}

test('a model on the wire playing the reference solves every scenario, through the arena path', async () => {
    for (const s of ALL) {
        const seen = [];
        const inst = S.instantiate(s, 'identity');
        const r = await S.play(s, 'identity', modelPolicy(CFG, { fetchImpl: referenceModel(inst, seen) }));
        assert.equal(r.outcome, 'success', `${s.id}: ${r.outcome}; ${r.log.map(e => e.results).join(' | ')}`);
        assert.equal(seen.length, r.rounds, 'one request per round');
        // What the model was sent: the scenario's objective in place of the victory
        // paragraph, the fixed parameters, and a state that states the protocol.
        const first = seen[0], system = first.messages[0].content;
        assert.match(system, /Your objective in this scenario:/);
        assert.doesNotMatch(system, /You win by either/);
        assert.equal(first.temperature, 0.4);
        const stateText = first.messages[first.messages.length - 1].content;
        assert.match(stateText, /"worldSecondsPerRound": ?10/);
        assert.match(stateText, /"secondsToAnswer": ?120/);
    }
});

test('strict: a refused parameter or a rate limit costs the round, with no retry and no adaptation', async () => {
    const s = ALL.find(x => x.id === 'strike-01');
    for (const answer of [refused(400, 'Unsupported parameter: temperature'), refused(429, 'rate limit exceeded')]) {
        let requests = 0;
        const r = await S.play(s, 'identity', modelPolicy(CFG, { fetchImpl: async () => { requests++; return answer; } }));
        assert.equal(requests, r.rounds, `status ${answer.status}: exactly one request per round`);
        assert.equal(r.outcome, 'failure');
    }
    // The arena seat, for contrast, adapts: the same refusal is retried without the parameter.
    const ep = await S.begin(s, 'identity');
    let bodies = [];
    const policy = modelPolicy(CFG, { fetchImpl: async (u, init) => { bodies.push(JSON.parse(init.body)); return bodies.length === 1 ? refused(400, 'Unsupported parameter: temperature') : reply([]); } });
    const state = ep.mgr.buildGameStateJSON(ep.subjectController);
    await policy({ round: 1, state, episode: ep });
    assert.equal(bodies.length, 1, 'strict');
    ep.subjectController._strict = false;
    bodies = [];
    await ep.mgr.sendToOpenAI(ep.subjectController, state);
    assert.equal(bodies.length, 2, 'not strict: adapted and retried');
    assert.ok(!('temperature' in bodies[1]));
});

test('the ceiling: a request still open at the ceiling is cut, and the round goes on without it', async () => {
    // strike-01: nothing ends it early while nobody acts (ford-01 would fail at round
    // 4, when the raiders reach an undefended ford), so every round is played.
    const s = ALL.find(x => x.id === 'strike-01');
    const hang = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => {
        const e = new Error('aborted'); e.name = 'AbortError'; reject(e);
    }));
    const t0 = Date.now();
    const r = await S.play(s, 'identity', modelPolicy(CFG, { fetchImpl: hang }), { ceilingMs: 150 });
    const took = Date.now() - t0;
    assert.equal(r.rounds, s.rounds, 'every round was played');
    assert.ok(took >= 150 * s.rounds && took < 150 * s.rounds + 5000, 'cut at the ceiling each round: ' + took + ' ms');
    assert.equal(r.outcome, 'failure');
});

test('runSuite plays every scenario x variant x attempt in a fixed order', async () => {
    const res = await runSuite(ALL, () => S.referencePolicy(), { variants: ['identity', 'rot90'], attempts: 2 });
    assert.equal(res.length, ALL.length * 2 * 2);
    assert.deepEqual(res.slice(0, 4).map(r => [r.id, r.variant, r.attempt]),
        [[ALL[0].id, 'identity', 1], [ALL[0].id, 'identity', 2], [ALL[0].id, 'rot90', 1], [ALL[0].id, 'rot90', 2]]);
    assert.ok(res.every(r => r.outcome === 'success'));
});

test('a seat plays its own prompt: a prefix or a whole template, only the victory paragraph swapped', async () => {
    const s = ALL.find(x => x.id === 'strike-01');
    const sent = async (extra) => {
        const ep = await S.begin(s, 'identity');
        let body;
        const pol = modelPolicy(Object.assign({}, CFG, extra), { fetchImpl: async (u, init) => { body = JSON.parse(init.body); return reply([]); } });
        await pol({ round: 1, state: ep.mgr.buildGameStateJSON(ep.subjectController), episode: ep });
        return { system: body.messages[0].content, M: ep.mgr.constructor, objective: ep.objective, ep };
    };
    const { system, M, objective, ep } = await sent({ promptPrefix: 'Do not overthink.' });
    // Exactly the arena seat's prompt -- rendered by the same builder -- with the
    // objective in the victory paragraph's place.
    ep.subjectController.model.customSystemPrompt = 'Do not overthink.\n\n' + M.defaultSystemPrompt();
    const arena = ep.mgr.buildSystemPrompt(ep.subject);
    assert.equal(system, arena.replace(M.VICTORY_PARAGRAPH, 'Your objective in this scenario:\n' + objective));
    assert.ok(system.startsWith('Do not overthink.\n\nYou ARE'));
    const custom = await sent({ systemPrompt: 'Be brief.\n' + M.VICTORY_PARAGRAPH + '\nThat is all.' });
    assert.equal(custom.system, 'Be brief.\nYour objective in this scenario:\n' + custom.objective + '\nThat is all.');
    await assert.rejects(sent({ systemPrompt: 'No victory paragraph here.' }), /exactly once/);
});
