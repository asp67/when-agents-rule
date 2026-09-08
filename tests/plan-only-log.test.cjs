const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function setup(turnBased = false) {
    const scope = { console, getCivilization: () => ({ name: 'Egyptians', color: 0xffff00 }) };
    vm.createContext(scope);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/openai-ai.js'), 'utf8'), scope);
    const Manager = vm.runInContext('OpenAIAIManager', scope);
    const manager = new Manager({});
    manager.turnBased = turnBased; manager._roundNo = 7;
    const seat = { aiPlayer: { id: 'egypt', civilization: 'egyptian' },
        model: { provider: 'ollama' }, stats: { turnsExecuted: 0, actionCounts: {} }, turnLog: [{}],
        conversationHistory: [], _moveNo: 2, _moveMs: 34500 };
    seat.seat = seat; manager.aiControllers = [seat];
    const lane = Object.create(seat);
    lane._moveNo = 3; lane._moveMs = 1200; lane.pendingLog = [];
    seat.lanes = [lane];
    const call = (name, args) => ({ type: 'function', function: { name, arguments: JSON.stringify(args) } });
    const parse = calls => manager.parseResponse({ tool_calls: calls, finish_reason: 'tool_calls' }, lane);
    return { Manager, manager, seat, lane, call, parse };
}

for (const turnBased of [false, true]) {
    test(`plan-only turn logs exactly once with the answering lane's metadata (${turnBased ? 'round' : 'live'})`, () => {
        const { manager, seat, lane, call, parse } = setup(turnBased);
        const envelope = parse([call('plan', { objective: 'Expand', plan: ['Train workers'] })]);
        if (turnBased) {
            manager.notePipelineRescues = () => 0;
            seat.queuedAction = envelope; seat.answeringLane = lane;
            manager.flushRound([seat]);
        } else manager.executeTurn(lane, envelope);
        assert.equal(manager.decisionLog.length, 1);
        const entry = manager.decisionLog[0];
        assert.equal(entry.action, 'plan_only'); assert.equal(entry.playerId, 'egypt');
        assert.equal(entry.move, 3); assert.equal(entry.latencyMs, 1200);
        assert.equal(entry.reason, 'Expand'); assert.equal(entry.failed, false);
        assert.equal(entry.round, turnBased ? 7 : undefined);
        assert.equal(lane.pendingLog.length, 0);
        assert.equal(seat.objective, 'Expand'); assert.equal(seat.plan[0], 'Train workers');
        assert.equal(seat.stats.noActionReturns || 0, 0);
        assert.equal(seat.stats.planOnlyUpdates, 1);
        assert.match(seat.lastActionResult, /^OK - Plan saved/);
        assert.equal(seat.turnLog[0].outcome, seat.lastActionResult);
    });
}

test('a plan with an action keeps its action entry without a plan-only duplicate', () => {
    const { manager, lane, call, parse } = setup();
    const envelope = parse([call('plan', { objective: 'Expand', plan: ['Train workers'] }),
        call('wait', { reason: 'Save resources' })]);
    manager.executeTurn(lane, envelope);
    assert.equal(manager.decisionLog.length, 1);
    assert.equal(manager.decisionLog[0].action, 'wait');
    assert.equal(lane.stats.noActionReturns || 0, 0);
});

test('one plan and three game commands execute in the same turn', () => {
    const { manager, seat, lane, call, parse } = setup();
    const envelope = parse([call('plan', { objective: 'Hold position', plan: ['Save resources'] }),
        call('wait', { reason: 'First command' }), call('wait', { reason: 'Second command' }),
        call('wait', { reason: 'Third command' })]);
    manager.executeTurn(lane, envelope);
    assert.equal(seat.objective, 'Hold position');
    assert.equal(manager.decisionLog.length, 3);
    assert.equal(seat.stats.actionCounts.wait, 3);
    assert.equal(seat.stats.turnsExecuted, 1);
    assert.equal(seat.stats.noActionReturns || 0, 0);
    assert.equal(seat.stats.planOnlyUpdates || 0, 0);
});

test('successful plan-only feedback reaches the transcript with the lane identity', () => {
    const { manager, lane, call, parse } = setup();
    const results = [];
    manager.transcripts = { noteResult: (...args) => results.push(args) };
    lane.laneNo = 1;
    manager.executeTurn(lane, parse([call('plan', { plan: ['Scout the eastern edge'] })]));
    assert.equal(results.length, 1);
    assert.equal(results[0][0], 'egypt');
    assert.match(results[0][1], /^OK - Plan saved/);
    assert.equal(results[0][2], 1);
    assert.equal(manager.decisionLog[0].failed, false);
});

test('a genuinely empty turn still counts as a no-action return', () => {
    const { manager, lane } = setup();
    manager.registerNoActionReturn(lane);
    assert.equal(lane.stats.noActionReturns, 1);
    assert.match(lane.lastActionResult, /^\[ERROR\]/);
});

test('opening prompt, tool description and corrective feedback allow combined calls', () => {
    const { Manager, lane } = setup();
    const prompt = Manager.defaultSystemPrompt();
    assert.match(prompt, /plan.*ONCE AND.*3 GAME COMMANDS/);
    assert.match(prompt, /plan \+ assign_workers \+ train_unit \+ research_tech/);
    assert.match(prompt, /A plan-only turn is a successful plan update/);
    const tool = Manager.TOOLS.find(t => t.function.name === 'plan');
    assert.match(tool.function.description, /together with up to 3 game-command tools/);
    assert.match(Manager.howToAnswer(lane), /"plan" once AND up to 3/);
});
