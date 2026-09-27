'use strict';
// The strategic zoom layer (review #12): fades in between half-heights 90 and 140; each
// seat's army gathered into counted groups; bases; only battles still being fought.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createMatch } = require('../tools/bench/realm.cjs');
const root = path.resolve(__dirname, '..');

function Layer(context) {
    vm.runInContext(fs.readFileSync(path.join(root, 'js/strategic-layer.js'), 'utf8') + '\n;globalThis.__SL = StrategicLayer;', context);
    return context.__SL;
}

test('it fades in as the view widens, and is absent up close', () => {
    const SL = Layer(vm.createContext({ Math }));
    assert.equal(SL.fade(34), 0);
    assert.equal(SL.fade(90), 0);
    assert.equal(SL.fade(115), 0.5);
    assert.equal(SL.fade(140), 1);
    assert.equal(SL.fade(520), 1);
});

test('units gather into groups by distance, counted', () => {
    const SL = Layer(vm.createContext({ Math }));
    const at = (x, z) => ({ x, z });
    const g = Array.from(SL.group([at(0, 0), at(10, 0), at(-10, 5), at(300, 300), at(310, 290)]), x => ({ ...x }));
    assert.equal(g.length, 2);
    assert.equal(g[0].n, 3);
    assert.equal(g[1].n, 2);
    assert.ok(Math.abs(g[0].x - 0) < 1e-9 && Math.abs(g[1].x - 305) < 1e-9, 'each at its centre');
    assert.equal(SL.group([]).length, 0);
});

test('from a real match: armies without workers, one pip per Town Center, and live battles only', async () => {
    const m = await createMatch({ kind: 'board', seed: 'strategic', seats: [
        { civ: 'greek', age: 'bronze', buildings: [['town_center', -200, 0]],
          units: [['warrior', -20, 0], ['warrior', -22, 2], ['archer', -24, -2], ['worker', -195, 5]] },
        { civ: 'persian', age: 'bronze', buildings: [['town_center', 200, 0]], units: [['warrior', 20, 0]] },
    ] });
    const SL = Layer(m.context);
    const layer = new SL(m.game);
    layer.poll();
    const [a, b] = m.seats;
    const mine = Array.from(layer.armies).filter(x => x.id === a.id);
    assert.equal(mine.length, 1);
    assert.equal(mine[0].n, 3, 'the worker is not in the army');
    assert.equal(layer.bases.length, 2);
    assert.equal(layer.battles.length, 0, 'no fight, no marker');
    m.command(m.controllers[0], 'attack_target', { targetX: 20, targetZ: 0 });
    let fought = false;
    for (let t = 0; t < 30000 && !fought; t += 500) { m.advance(500); layer.poll(); fought = layer.battles.length > 0; }
    assert.ok(fought, 'the fight is marked while it lasts');
    assert.ok(layer.battles[0].n >= 2);
    for (let t = 0; t < 60000 && layer.battles.length; t += 1000) { m.advance(1000); layer.poll(); }
    assert.equal(layer.battles.length, 0, 'and gone once it has been quiet');
    assert.ok(b);
});
