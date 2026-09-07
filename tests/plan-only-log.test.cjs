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
    return { manager, seat, lane, call, parse };
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
        assert.equal(entry.reason, 'Expand'); assert.equal(entry.failed, true);
        assert.equal(entry.round, turnBased ? 7 : undefined);
        assert.equal(lane.pendingLog.length, 0);
        assert.equal(seat.objective, 'Expand'); assert.equal(seat.plan[0], 'Train workers');
        assert.equal(seat.stats.noActionReturns, 1);
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
