// explore takes a route (b1084): "tile" and up to two more in "then", walked in order.
// Each next tile is aimed when the unit reaches the one before it; the last arrival ends
// exactly as a plain explore does. Any unit may take one, a worker too -- the model decides.
const test = require('node:test'), assert = require('node:assert/strict');
const { createMatch } = require('../tools/bench/realm.cjs');

async function setup() {
    const m = await createMatch({ kind: 'arena', seed: 'explore-route', seats: ['greek', 'persian'], mapSize: 800 });
    const g = m.game, ai = m.seats[0], c = m.scripted(ai);
    const T = g.EXPLORE_TILES, cell = g.terrain.size / T, half = g.terrain.size / 2;
    const tileOf = (x, z) => ({ row: Math.floor((z + half) / cell), col: Math.floor((x + half) / cell) });
    const label = t => String.fromCharCode(65 + t.col) + (t.row + 1);
    const tc = ai.buildings.find(b => b.type === 'town_center');
    const home = tileOf(tc.x, tc.z);
    // Three tiles in a row beside home, staying on the map.
    const dc = home.col < T / 2 ? 1 : -1;
    const stops = [0, 1, 2].map(i => ({ row: home.row, col: home.col + dc * i }));
    const worker = ai.units.find(u => u.type === 'worker');
    return { m, g, ai, c, tileOf, label, stops, worker };
}

// Advance until the unit stops moving or `ms` runs out; returns the tiles it was aiming
// at, in order, each time its aim changed.
function walk(m, unit, tileOf, ms) {
    const aims = [];
    let aim = null;
    for (let t = 0; t < ms; t += 250) {
        const key = unit.targetX + ',' + unit.targetZ;
        if (unit.isMoving && key !== aim) { aim = key; aims.push(tileOf(unit.targetX, unit.targetZ)); }
        if (!unit.isMoving) break;
        m.advance(250);
    }
    return aims;
}

test('a route of three tiles is walked in order, then ends as a plain explore does', async () => {
    const { m, g, ai, c, tileOf, label, stops, worker } = await setup();
    const res = m.command(c, 'explore', { tile: label(stops[0]), then: [label(stops[1]), label(stops[2])], unitIds: [worker.handle] });
    assert.match(String(res), new RegExp(`^OK .*tile ${label(stops[0])} .*, then ${label(stops[1])}, then ${label(stops[2])}\\.`), res);

    // The state shows the route while tiles remain after the leg it is on.
    const orders = m.game.openAIAIManager.buildGameStateJSON(c).ordersInProgress || [];
    const mine = orders.find(o => o.order === 'explore');
    assert.ok(mine, JSON.stringify(orders));
    assert.deepEqual([...mine.unitIds], [worker.handle]);
    assert.deepEqual([...mine.route], [label(stops[1]), label(stops[2])]);

    const aims = walk(m, worker, tileOf, 600000);
    assert.deepEqual(aims.map(label), stops.map(label), 'each tile in turn');
    assert.equal(worker.isMoving, false, 'and it stops at the last');
    assert.equal(worker.task, null, 'no longer a scout: exactly as a plain explore ends');
    assert.ok(!worker._route, 'the route is spent');
    const after = m.game.openAIAIManager.buildGameStateJSON(c).ordersInProgress || [];
    assert.ok(!after.some(o => o.order === 'explore'));
});

test('a later order to the unit ends its route', async () => {
    const { m, c, tileOf, label, stops, worker } = await setup();
    m.command(c, 'explore', { tile: label(stops[1]), then: [label(stops[2]), label(stops[0])], unitIds: [worker.handle] });
    m.advance(2000);
    const res = m.command(c, 'move_units', { unitIds: [worker.handle], targetX: Math.round(worker.x) + 6, targetZ: Math.round(worker.z) });
    assert.match(String(res), /^OK/, res);
    for (let t = 0; t < 60000 && worker.isMoving; t += 250) m.advance(250);
    assert.equal(worker.isMoving, false, 'it stays where the new order put it');
    assert.ok(!worker._route);
});

test('more than three tiles, or a bad one in "then", sends nothing', async () => {
    const { m, c, label, stops, worker } = await setup();
    const long = m.command(c, 'explore', { tile: label(stops[0]), then: ['A1', 'A2', 'A3'], unitIds: [worker.handle] });
    assert.match(String(long), /^\[ERROR\] explore visits at most 3 tiles/, long);
    const bad = m.command(c, 'explore', { tile: label(stops[0]), then: ['Q99'], unitIds: [worker.handle] });
    assert.match(String(bad), /^\[ERROR\] "Q99" in "then" is not a map tile/, bad);
    assert.equal(worker.task === 'scouting', false, 'the worker was not sent');
    // A list written as one string is the same list.
    const one = m.command(c, 'explore', { tile: label(stops[0]), then: `${label(stops[1])}, ${label(stops[2])}`, unitIds: [worker.handle] });
    assert.match(String(one), /^OK/, one);
    assert.equal(worker._route.stops.length, 2);
});

test('a soldier walks a route too', async () => {
    const { m, ai, c, tileOf, label, stops } = await setup();
    const tc = ai.buildings.find(b => b.type === 'town_center');
    const soldier = m.addUnit(ai, 'militia', tc.x + 8, tc.z + 8);
    const res = m.command(c, 'explore', { tile: label(stops[1]), then: [label(stops[2])], unitIds: [soldier.handle] });
    assert.match(String(res), /^OK .*, then /, res);
    const aims = walk(m, soldier, tileOf, 600000);
    assert.deepEqual(aims.map(label), [label(stops[1]), label(stops[2])]);
    assert.equal(soldier.isMoving, false);
    assert.ok(!soldier._route);
});
