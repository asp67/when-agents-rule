// The rule-based AI is the baseline every model is compared against and the
// Campaign's opponent. Two self-handicaps: it re-issued its attack order every
// 2 s think and reset each unit's swing timer, and it thought on wall time, so
// it kept thinking through a pause and its strength depended on the speed.
const test = require('node:test'), assert = require('node:assert/strict');
const vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
const root = path.resolve(__dirname, '..');
const source = f => fs.readFileSync(path.join(root, 'js', f), 'utf8');

test('a re-think leaves units already attacking the target mid-swing', () => {
    const context = vm.createContext({ console });
    vm.runInContext(source('ai.js') + '\nthis.AIManager = AIManager;', context);
    const mgr = Object.create(context.AIManager.prototype);
    let escorted = 0;
    mgr.game = { clearRetaliation() {}, escortSupportUnits() { escorted++; } };
    const target = { x: 50, z: 0, health: 100 };
    const army = Array.from({ length: 8 }, (_, i) => ({ x: i, z: 0, health: 10 }));
    mgr.commandArmy({ units: army }, army, target);
    army.forEach(u => { assert.equal(u.attackTarget, target); u.attackTimer = 700; });
    const fresh = { x: 0, z: 5, health: 10 };
    mgr.commandArmy({ units: army.concat(fresh) }, army.concat(fresh), target);
    army.forEach(u => assert.equal(u.attackTimer, 700, 'swing progress kept'));
    assert.equal(fresh.attackTarget, target);
    assert.equal(fresh.attackTimer, 0);
    assert.equal(escorted, 2);
});

test('the rule-based brain gets simulated time: none while paused, more at speed', () => {
    const src = source('game.js');
    const context = vm.createContext({ document: { hidden: true }, Date: { now: () => 1000 }, WarPositionRules: { apply() {} } });
    vm.runInContext(src, context);
    for (const [speed, pauseState, expected] of [[1, 'running', 1000], [2, 'running', 2000], [4, 'paused', 0]]) {
        const game = vm.runInContext('Object.create(Game.prototype)', context);
        game.clock = vm.runInContext('Game.newClock()', context);
        // Given in fixed 50 ms steps now (review #6 step 9): the total is what counts.
        const done = new Error('end of tick');
        let given = 0;
        Object.assign(game, { lastFrameTime: 0, simSpeed: speed, pauseState, gameStarted: true,
            aiManager: { aiPlayers: [], update(ms) { assert.equal(ms, 50); given += ms; } }, sampleTimeline() { throw done; }, pruneBattles() {}, renderer: { units: [], buildings: [] },
            anyWonderStanding: () => false, simulateStep() {}, keepUnitsAshore() {},
            checkWinConditions() {} });
        try { game.tick(); } catch (e) { if (e !== done) throw e; }
        assert.equal(given, expected, speed + 'x ' + pauseState);
    }
});
