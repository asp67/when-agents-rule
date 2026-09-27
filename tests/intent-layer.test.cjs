'use strict';
// The intent layer (review #11): a model's newest orders drawn where they point, with its
// own reason. Targets resolve exactly or not at all; an order with no known origin is a
// marker, never a guessed arrow; the reason is verbatim up to 160 characters.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createMatch } = require('../tools/bench/realm.cjs');

const ROOT = path.resolve(__dirname, '..');

async function setup() {
    const m = await createMatch({ kind: 'board', seed: 'intent', seats: [
        { civ: 'greek', age: 'bronze', buildings: [['town_center', -100, 0]],
          units: [['warrior', -60, 0, { tag: 'w1' }], ['warrior', -60, 10, { tag: 'w2' }], ['archer', -50, -20, { tag: 'a1' }], ['worker', -95, 8]] },
        { civ: 'persian', age: 'bronze', buildings: [['house', 100, 0, { tag: 'house' }]], units: [['warrior', 90, 0]] },
    ] });
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/intent-layer.js'), 'utf8'), m.context, { filename: 'js/intent-layer.js' });
    const layer = vm.runInContext('new IntentLayer(game)', m.context);
    const c = m.controllers[0];
    const turn = calls => ({ toolCalls: calls.map(([name, args]) => ({ id: 'x', name, args: JSON.stringify(args) })) });
    return { m, layer, c, turn };
}

test('an order resolves to its target and its units, and the reason goes beside it', async () => {
    const { m, layer, c, turn } = await setup();
    layer.poll(0);   // what was in the log before is history, not news
    const house = m.tags.house, w1 = m.tags.w1, w2 = m.tags.w2;
    c.turnLog.push(turn([['attack_target', { targetId: house.id, unitIds: [w1.handle, w2.handle], reason: 'Their house is undefended.' }]]));
    assert.equal(layer.poll(1000), 1);
    assert.equal(layer.intents.length, 1);
    const i = layer.intents[0];
    assert.deepEqual({ x: i.to.x, z: i.to.z }, { x: house.x, z: house.z });
    assert.deepEqual({ x: i.from.x, z: i.from.z }, { x: (w1.x + w2.x) / 2, z: (w1.z + w2.z) / 2 }, 'the two named units, by the handles the model was shown');
    assert.equal(i.marker, false);
    const b = layer.bubbles.find(b => b.seat === m.seats[0].id);
    assert.equal(b.text, 'Their house is undefended.');
    // Drawn through whatever projection the view has; behind the camera means not drawn.
    const f = layer.frame((x, z) => ({ x: x + 1000, y: z + 1000 }), 2000);
    assert.equal(f.shapes.length, 1);
    assert.equal(f.shapes[0].to.x, house.x + 1000);
    assert.equal(f.bubbles.length, 1);
    assert.equal(layer.frame(() => null, 2000).shapes.length, 0);
});

test('never guessed: an unknown target draws nothing, an explore with no unit named is a marker only', async () => {
    const { m, layer, c, turn } = await setup();
    layer.poll(0);
    c.turnLog.push(turn([
        ['attack_target', { targetId: 'building_doesnotexist' }],
        ['explore', { tile: 'D4', reason: 'Scout the centre.' }],
        ['train_unit', { unitType: 'worker', reason: 'more hands' }],
    ]));
    layer.poll(1000);
    assert.equal(layer.intents.length, 1, 'only the explore resolves');
    const e = layer.intents[0];
    assert.equal(e.marker, true);
    assert.equal(e.from, null);
    assert.deepEqual({ x: e.to.x, z: e.to.z }, { x: 0, z: 0 }, 'D4 is the centre tile of the 7x7 grid');
    // The first reason given, anchored on its target.
    assert.equal(layer.bubbles.find(b => b.seat === m.seats[0].id).text, 'Scout the centre.');
    // Omitting "units" means the whole army, as the tool says: workers are not in it.
    c.turnLog.push(turn([['move_units', { targetX: 0, targetZ: 50 }]]));
    layer.poll(2000);
    const mv = layer.intents.find(x => x.action === 'move_units');
    const army = [m.tags.w1, m.tags.w2, m.tags.a1];
    assert.ok(Math.abs(mv.from.x - army.reduce((a, u) => a + u.x, 0) / 3) < 1e-9);
    // A type names where that type stands.
    c.turnLog.push(turn([['attack_target', { targetX: 90, targetZ: 0, units: { archer: 1 } }]]));
    layer.poll(3000);
    const ar = layer.intents.find(x => x.action === 'attack_target');
    assert.deepEqual({ x: ar.from.x, z: ar.from.z }, { x: m.tags.a1.x, z: m.tags.a1.z });
});

test('reasons stay verbatim to 160 characters; bubbles of turns that land together are staggered; all of it fades', async () => {
    const { m, layer, c, turn } = await setup();
    layer.poll(0);
    const long = 'x'.repeat(100) + ' ' + 'y'.repeat(100);
    const IntentLayer = layer.constructor;
    assert.equal(IntentLayer.reasonText(long).length, 160);
    assert.ok(IntentLayer.reasonText(long).endsWith('…'));
    assert.equal(IntentLayer.reasonText('  keep   it\nas said '), 'keep it as said');
    const other = m.controllers[1];
    c.turnLog.push(turn([['explore', { tile: 'A1', reason: 'first' }]]));
    other.turnLog.push(turn([['explore', { tile: 'G7', reason: 'second' }]]));
    layer.poll(10000);
    const born = Array.from(layer.bubbles, b => b.born).sort();
    assert.deepEqual(born, [10000, 10600]);
    assert.equal(layer.frame(() => ({ x: 0, y: 0 }), 10100).bubbles.length, 1, 'the second waits its turn');
    layer.poll(10600 + IntentLayer.LIFE_MAX_MS);
    assert.equal(layer.intents.length + layer.bubbles.length, 0);
});

test('a refused order is drawn as refused once the harness has answered, and not before', async () => {
    const { layer, c, turn } = await setup();
    const IntentLayer = layer.constructor;
    assert.equal(IntentLayer.rejected({ outcome: null }, 0), null, 'not answered yet: nothing claimed');
    assert.equal(IntentLayer.rejected({ outcome: '[ERROR] You have no military units.' }, 0), true);
    assert.equal(IntentLayer.rejected({ outcome: 'OK - moving' }, 0), false);
    const batch = { outcome: 'Command 1/2: OK - Scout sent\nCommand 2/2: [ERROR] No clear spot.' };
    assert.deepEqual([IntentLayer.rejected(batch, 0), IntentLayer.rejected(batch, 1)], [false, true]);
    layer.poll(0);
    const t = turn([['explore', { tile: 'B2' }], ['move_units', { targetX: 10, targetZ: 10 }]]);
    c.turnLog.push(t);
    layer.poll(1000);
    const draw = () => Array.from(layer.frame((x, z) => ({ x, y: z }), 1500).shapes, s => s.refused);
    assert.deepEqual(draw(), [false, false]);
    t.outcome = 'Command 1/2: OK - Scout sent\nCommand 2/2: [ERROR] You have no military units.';
    assert.deepEqual(draw(), [false, true]);
    assert.equal(layer.frame((x, z) => ({ x, y: z }), 1500).shapes[1].color, '#9aa4b1');
});

test('a bubble whose order was refused says so', async () => {
    const { layer, c, turn } = await setup();
    layer.poll(0);
    const t = turn([['move_units', { targetX: 10, targetZ: 10, reason: 'Screen the workers.' }]]);
    c.turnLog.push(t);
    layer.poll(1000);
    const bubble = () => layer.frame((x, z) => ({ x, y: z }), 1500).bubbles[0];
    assert.equal(bubble().refused, false);
    t.outcome = '[ERROR] You have no military units to move.';
    assert.equal(bubble().refused, true);
    assert.equal(bubble().text, 'Screen the workers.', 'the reason itself is never edited');
});

test('every bubble holds, then fades over the same last stretch -- none fades faster than another', async () => {
    const { layer } = await setup();
    const IntentLayer = layer.constructor;
    const short = IntentLayer.lifeFor('ok'), long = IntentLayer.lifeFor('z'.repeat(160));
    assert.equal(short, IntentLayer.LIFE_MS);
    assert.equal(long, IntentLayer.LIFE_MAX_MS, 'a long reason stays up longer, to be read');
    for (const life of [short, long]) {
        assert.equal(IntentLayer.alpha(life - IntentLayer.FADE_MS - 1, 0, life), 1, 'fully visible until the fade');
        assert.equal(IntentLayer.alpha(life - IntentLayer.FADE_MS / 2, 0, life), 0.5, 'the same fade, whatever the length');
        assert.equal(IntentLayer.alpha(life, 0, life), 0);
    }
});

test('a mark never stands without its bubble: a reasonless order is named, and a new turn replaces the last', async () => {
    const { m, layer, c, turn } = await setup();
    layer.poll(0);
    const seat = m.seats[0].id;
    c.turnLog.push(turn([['explore', { tile: 'D4', reason: 'Scout the centre.' }]]));
    layer.poll(1000);
    c.turnLog.push(turn([['move_units', { tile: 'E4' }]]));
    layer.poll(2000);
    assert.deepEqual(Array.from(layer.intents, i => i.action), ['move_units'], 'the explore is replaced, not left behind');
    const b = layer.bubbles.find(x => x.seat === seat);
    assert.equal(b.summary, true);
    assert.equal(b.text, 'move units E4', 'named by its command, since it gave no reason');
    assert.equal(b.life, layer.intents[0].life, 'marks and bubble live and fade together');
    // Every visible mark has its seat's bubble visible beside it, all through the fade.
    for (let now = 2000; now < 2000 + b.life + 500; now += 250) {
        const marks = layer.worldMarks(now), f = layer.frame((x, z) => ({ x, y: z }), now);
        if (marks.length) assert.ok(f.bubbles.some(x => x.seat === seat && Math.abs(x.opacity - marks[0].alpha) < 1e-9), 'at ' + now);
    }
    // A turn that points nowhere and says nothing leaves the last one standing.
    c.turnLog.push(turn([['train_unit', { unitType: 'worker' }]]));
    layer.poll(2500);
    assert.deepEqual(Array.from(layer.intents, i => i.action), ['move_units']);
});

test('the renderer gets ground marks: a ring at the target, a path from the units, refused ones grey', async () => {
    const { m, layer, c, turn } = await setup();
    layer.poll(0);
    const house = m.tags.house;
    const t = turn([['attack_target', { targetId: house.id, unitIds: [m.tags.w1.handle], reason: 'Burn it.' }]]);
    c.turnLog.push(t);
    layer.poll(1000);
    const [mk] = layer.worldMarks(1500);
    assert.deepEqual({ x: mk.to.x, z: mk.to.z }, { x: house.x, z: house.z });
    assert.deepEqual({ x: mk.from.x, z: mk.from.z }, { x: m.tags.w1.x, z: m.tags.w1.z });
    assert.equal(mk.alpha, 1);
    assert.equal(mk.refused, false);
    t.outcome = '[ERROR] Out of reach.';
    assert.equal(layer.worldMarks(1500)[0].color, '#9aa4b1');
    assert.equal(layer.worldMarks(1000 + layer.intents[0].life).length, 0, 'gone when its life ends');
});

test('every ring has its own bubble with its own reason, or its command named; close bubbles stack', async () => {
    const { m, layer, c, turn } = await setup();
    layer.poll(0);
    const seat = m.seats[0].id, house = m.tags.house;
    c.turnLog.push(turn([
        ['train_unit', { unitType: 'worker', reason: 'more hands' }],
        ['attack_target', { targetId: house.id, unitIds: [m.tags.w1.handle], reason: 'Burn their house.' }],
        ['move_units', { unitIds: [m.tags.w2.handle], targetX: house.x, targetZ: house.z }],
        ['explore', { tile: 'A1', reason: 'Look north.' }],
    ]));
    layer.poll(1000);
    assert.equal(layer.intents.length, 3);
    const texts = Array.from(layer.bubbles, b => [b.text, b.summary]);
    assert.deepEqual(texts, [['Burn their house.', false], ['move units', true], ['Look north.', false]]);
    for (const [k, i] of layer.intents.entries()) {
        const b = layer.bubbles[k];
        assert.deepEqual({ x: b.anchor.x, z: b.anchor.z }, { x: i.to.x, z: i.to.z }, 'on its own ring');
    }
    // The two over the house do not cover each other.
    const f = layer.frame((x, z) => ({ x, y: z }), 1500);
    const [a, b] = f.bubbles;
    assert.equal(a.x, b.x);
    assert.ok(b.y <= a.y - a.h, 'the second stands above the first');
    assert.equal(f.bubbles[2].y, layer.tileCentre('A1').z, 'a lone bubble stays on its point');
    // A turn that only says something shows it once, over its base.
    c.turnLog.push(turn([['train_unit', { unitType: 'worker', reason: 'Boom first.' }]]));
    layer.poll(2000);
    assert.equal(layer.intents.length, 0);
    assert.deepEqual(Array.from(layer.bubbles, b => b.text), ['Boom first.']);
    const tc = m.seats[0].buildings.find(b => b.type === 'town_center');
    assert.deepEqual({ x: layer.bubbles[0].anchor.x, z: layer.bubbles[0].anchor.z }, { x: tc.x, z: tc.z });
});

test('bubbles that would overlap are stacked by their full width, not a fixed sideways reach', async () => {
    const { layer } = await setup();
    const { stack } = layer.constructor;
    const box = x => ({ x, y: 300, w: 260, h: 60 });
    // 200 px apart: two 260 px bubbles still overlap by 60 px. The old 150 px reach missed
    // this, and the second covered the first one's reason.
    const [a, b] = stack([box(0), box(200)]);
    assert.equal(a, 300);
    assert.ok(b <= a - 60, 'the second stands above the first: ' + b);
    // 270 px apart they clear each other and both stay on their points.
    assert.deepEqual(Array.from(stack([box(0), box(270)])), [300, 300]);
    // A third that meets both climbs above whichever it meets, until it is clear.
    const three = stack([box(0), box(100), box(50)]);
    assert.ok(three[2] <= three[1] - 60 && three[1] <= three[0] - 60, JSON.stringify(three));
});
