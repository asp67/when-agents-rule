// A farmer whose farm is razed is idle, and its seat decides what it does next (b1268).
//
// Standing at the farm, it was sent to the nearest node of any kind within 50 -- one its
// seat had never discovered, as easily as not: the one place where the rules both chose
// for the seat and looked through the fog. Carrying a load home at that moment, it was
// left with no task and still tied to the dead farm: not idle for anyone who asked,
// reported to its model as farming, and never given a farm again.
const test = require('node:test'), assert = require('node:assert/strict');
const vm = require('node:vm');
const { Realm } = require('../tools/bench/realm.cjs');

function village() {
    const m = new Realm({ seed: 9 });
    const [a, b] = m.startFixture(['greek', 'egyptian']);
    m.addBuilding(a, 'town_center', -100, 0); m.addBuilding(b, 'town_center', 100, 0);
    const g = m.game;
    m.scripted(a); m.scripted(b);   // model seats: no brain puts an idle worker to work
    const farm = m.addBuilding(a, 'farm', -80, 0);
    const worker = m.addUnit(a, 'worker', -80, 1);
    Object.assign(worker, { task: 'farm_work', farmRef: farm }); farm.assignedWorker = worker;
    // Gold a few steps away that this seat has never seen.
    g.terrain.resources.push({ type: 'gold', x: -70, z: 6, amount: 500 });
    a._knownResIdx = new Set();
    const job = u => vm.runInContext('OpenAIAIManager', m.context).workerJob(g, u);
    return { m, g, a, farm, worker, job };
}
const raze = (g, farm) => { farm.health = 0; g.destroyTarget(farm, null); };

test('razed under its feet: the farmer stands idle and goes to no node its seat never found', () => {
    const { m, g, farm, worker, job } = village();
    m.run(1000);
    raze(g, farm);
    m.run(3000);
    assert.equal(worker.task, null);
    assert.equal(worker.farmRef, null);
    assert.ok(!worker.harvestTarget, 'no node chosen for it');
    assert.equal(g.isIdleWorker(worker), true);
    assert.equal(job(worker), 'idle');
});

test('razed while it carries a load home: the load is banked and the farmer is idle', () => {
    const { m, g, a, farm, worker, job } = village();
    const food = a.resources.food;
    Object.assign(worker, { task: 'carrying', carryingResource: true, carryingResourceType: 'food', harvestAmount: 10,
        x: -99, z: 4, targetX: -99, targetZ: 4, isMoving: false, harvestTarget: null });
    raze(g, farm);
    m.run(2000);
    assert.equal(a.resources.food, food + 10, 'what it carried is not lost');
    assert.equal(worker.task, null);
    assert.equal(worker.farmRef, null, 'it is no dead farm\'s farmer');
    assert.equal(g.isIdleWorker(worker), true);
    assert.equal(job(worker), 'idle', 'and its model is not told it is farming');
});
