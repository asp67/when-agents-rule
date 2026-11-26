// assign_workers does for a farm what its description says it does (b1279). The farm
// branch was written before "whenCarrying" and the queue for builders and fighters, and
// never learned either:
//  - "whenCarrying" was not read. A carried load was destroyed whatever the model asked
//    for -- with "skipAssignment" and "deliverLoad" too -- and without a word.
//  - "from": "building" was answered "neither is ever pulled", where the description
//    says such workers are taken when that ends, and where every other resource queues.
//  - "count" is described as "Default 3"; for a farm it is every unmanned farm.
const test = require('node:test'), assert = require('node:assert/strict');
const vm = require('node:vm');
const { Realm } = require('../tools/bench/realm.cjs');

// A village with two finished, unmanned farms and no workers yet.
function village() {
    const m = new Realm({ seed: 14 });
    const [a, b] = m.startFixture(['greek', 'egyptian']);
    const tc = m.addBuilding(a, 'town_center', -100, 0); m.addBuilding(b, 'town_center', 100, 0);
    const ca = m.scripted(a); m.scripted(b);
    const farms = [m.addBuilding(a, 'farm', -80, 10), m.addBuilding(a, 'farm', -80, -10)];
    const g = m.game;
    const free = (x = -90, z = 0) => m.addUnit(a, 'worker', x, z);
    // A worker walking home with ten wood.
    const carrier = (x = -60, z = 0) => Object.assign(m.addUnit(a, 'worker', x, z), { task: 'carrying', carryingResource: true,
        carryingResourceType: 'wood', harvestAmount: 10, isMoving: true, targetX: tc.x, targetZ: tc.z });
    const assign = params => m.command(ca, 'assign_workers', Object.assign({ resourceType: 'farm', reason: 'food' }, params));
    return { m, g, a, tc, farms, free, carrier, assign };
}

test('skipAssignment leaves a carrying worker alone', () => {
    const { a, farms, free, carrier, assign } = village();
    const w = free(), c = carrier();
    const said = assign({ whenCarrying: 'skipAssignment' });
    assert.match(said, /^OK - Sent 1 worker\(s\) to man 1 farm\(s\)/);
    assert.equal(w.task, 'farm_work');
    assert.equal(c.task, 'carrying'); assert.equal(c.harvestAmount, 10); assert.equal(c.farmRef || null, null);
    assert.equal(farms.filter(f => f.assignedWorker).length, 1);
    const none = village(); none.carrier();
    assert.match(none.assign({ whenCarrying: 'skipAssignment' }), /^\[ERROR\] All 1 available worker\(s\) are carrying a load\./);
});

test('deliverLoad banks the load first, then the worker mans the farm', () => {
    const { m, g, a, farms, carrier, assign } = village();
    const c = carrier(), wood = a.resources.wood;
    const said = assign({ whenCarrying: 'deliverLoad', count: 1 });
    assert.match(said, /^OK - Sent 1 worker\(s\) to man 1 farm\(s\)/);
    assert.match(said, /1 of them (is|are) carrying and go(es)? after the drop-off/);
    assert.equal(c.harvestAmount, 10, 'the load is still in its hands');
    m.run(30000);
    assert.equal(a.resources.wood, wood + 10, 'and reaches the stockpile');
    assert.equal(c.task, 'farm_work');
    assert.ok(farms.includes(c.farmRef) && c.farmRef.assignedWorker === c);
    assert.equal(g.farmFarmer(c.farmRef), c);
});

test('by default the worker moves now and the reply says what that destroyed', () => {
    const { a, carrier, assign } = village();
    const c = carrier(), wood = a.resources.wood;
    const said = assign({ count: 1 });
    assert.equal(c.task, 'farm_work'); assert.equal(c.harvestAmount, 0);
    assert.match(said, /Returning workers spilled 10 wood they were carrying\./);
    assert.equal(a.resources.wood, wood);
});

test('a value that is none of the three is refused, as for every resource', () => {
    const { free, assign } = village(); free();
    assert.match(assign({ whenCarrying: 'later' }), /^\[ERROR\] assign_workers "whenCarrying": expected spillLoad\|deliverLoad\|skipAssignment\./);
});

test('"from": "building" queues the builder for the farm, and it goes when the build ends', () => {
    const { m, g, a, farms, assign } = village();
    const builder = m.addUnit(a, 'worker', -110, 20);
    const site = m.addBuilding(a, 'house', -110, 22, { underConstruction: true, buildProgress: 0, buildTime: 3000, health: 1 });
    Object.assign(builder, { task: 'building', buildTarget: site, isMoving: false });
    const said = assign({ from: 'building', count: 1 });
    assert.match(said, /^OK - 1 worker\(s\) queued for a farm at \(-80, -?10\)/, said);
    assert.equal(builder.task, 'building', 'it keeps building');
    const orders = g.openAIAIManager.buildGameStateJSON(g.openAIAIManager.aiControllers.find(c => c.aiPlayer === a) || m.scripted(a)).ordersInProgress;
    const queued = orders.find(o => o.order === 'assign_workers');
    assert.ok(queued, 'the state shows the order it accepted: ' + JSON.stringify(orders));
    assert.equal(queued.units, 1); assert.equal(queued.to[0], -80); assert.ok(queued.secondsRemaining > 0);
    m.run(12000);
    assert.equal(site.underConstruction, false);
    assert.equal(builder.task, 'farm_work');
    assert.ok(farms.includes(builder.farmRef) && g.farmFarmer(builder.farmRef) === builder);
});

test('a farm job queued for a farm that falls in the meantime is dropped', () => {
    const { m, g, a, farms, assign } = village();
    farms[1].health = 0; g.destroyTarget(farms[1], null);
    const builder = m.addUnit(a, 'worker', -110, 20);
    const site = m.addBuilding(a, 'house', -110, 22, { underConstruction: true, buildProgress: 0, buildTime: 3000, health: 1 });
    Object.assign(builder, { task: 'building', buildTarget: site, isMoving: false });
    assign({ from: 'building', count: 1 });
    farms[0].health = 0; g.destroyTarget(farms[0], null);
    m.run(12000);
    assert.notEqual(builder.task, 'farm_work');
    assert.equal(builder.farmRef || null, null);
});

test('the description says what the count means for a farm, and the error names the right list', () => {
    const { m, assign } = village();
    const tool = vm.runInContext("OpenAIAIManager.ACTIONS.find(a => a.name === 'assign_workers')", m.context);
    assert.match(tool.params.count.description, /Default 3, max 20; for "farm", every unmanned farm\./);
    assert.match(assign({ targetX: 5 }), /one of your farms in "friendlyBuildings"/);
});
