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
    // A turn that points nowhere is still the seat's newest: it replaces the last, and its
    // command is named on a bubble at the building that trains it -- with no ring.
    c.turnLog.push(turn([['train_unit', { unitType: 'worker' }]]));
    layer.poll(2500);
    assert.deepEqual(Array.from(layer.intents, i => i.action), [], 'no place, no ring');
    const q = layer.bubbles.filter(x => x.seat === seat);
    assert.equal(q.length, 1);assert.equal(q[0].action, 'train_unit');assert.equal(q[0].text, 'train unit');
    const tc = m.seats[0].buildings.find(x => x.type === 'town_center');
    assert.deepEqual({ x: q[0].anchor.x, z: q[0].anchor.z }, { x: tc.x, z: tc.z }, 'workers are trained at the Town Center');
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
    // The train command points at no place: its bubble comes after the ringed ones.
    assert.deepEqual(texts, [['Burn their house.', false], ['move units', true], ['Look north.', false], ['more hands', false]]);
    for (const [k, i] of layer.intents.entries()) {
        const b = layer.bubbles[k];
        assert.deepEqual({ x: b.anchor.x, z: b.anchor.z }, { x: i.to.x, z: i.to.z }, 'on its own ring');
    }
    // The two over the house do not cover each other. The attack names the house, so its
    // bubble stands a bubble higher (b1000); the move only names a point, and fits below.
    const f = layer.frame((x, z) => ({ x, y: z }), 1500);
    const [a, b] = f.bubbles;
    assert.equal(a.x, b.x);
    assert.equal(a.lift, true, 'the attack on the house is lifted');
    assert.equal(b.lift, false, 'a move to a point is not');
    assert.equal(a.y, house.z - a.h, 'its bottom where its top would have been');
    assert.ok(b.y <= a.y - a.h || a.y <= b.y - b.h, 'the two do not overlap');
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

test('a bubble whose ring is out of view slides along its path to where the camera looks', async () => {
    const { layer } = await setup();
    const { anchorFor } = layer.constructor;
    // Screen = world, 0..100 square in view.
    const project = (x, z) => ({ x, y: z });
    const view = focus => ({ focus, w: 100, h: 100 });
    const b = { anchor: { x: 400, z: 50 }, from: { x: -300, z: 50 } };
    // Ring in view: on the ring.
    assert.deepEqual(anchorFor({ anchor: { x: 60, z: 50 }, from: b.from }, project, view({ x: 50, z: 50 })), { x: 60, y: 50 });
    // Ring off to the right, camera on the path: on the path at the camera's point.
    assert.deepEqual(anchorFor(b, project, view({ x: 30, z: 80 })), { x: 30, y: 50 });
    // The path out of view too: stays on its ring (off screen; nothing to show).
    assert.deepEqual(anchorFor(b, project, { focus: { x: 30, z: 900 }, w: 100, h: 40 }), { x: 400, y: 50 });
    // No path (an order with no known origin), or no view: on the ring.
    assert.deepEqual(anchorFor({ anchor: b.anchor }, project, view({ x: 30, z: 50 })), { x: 400, y: 50 });
    assert.deepEqual(anchorFor(b, project, null), { x: 400, y: 50 });
});

test('an explore ring moves to where the harness really sends the scout, once it has answered', async () => {
    const { m, layer, c, turn } = await setup();
    layer.poll(0);
    const w = m.seats[0].units.find(u => u.type === 'worker');
    const t = turn([['explore', { tile: 'D4', reason: 'Look at the middle.' }], ['explore', { tile: 'A1' }]]);
    c.turnLog.push(t);
    layer.poll(1000);
    const [e, refused] = layer.intents;
    assert.deepEqual({ x: e.to.x, z: e.to.z }, { x: 0, z: 0 }, 'the tile centre until the answer is in');
    assert.equal(e.marker, true);
    // The harness answers: it sent this worker to the least-seen part of D4.
    w.targetX = 37; w.targetZ = -21;
    t.outcome = 'Command 1/2: OK - Sent your worker #' + w.handle + ' to scout tile D4 (~9s to arrive).\nCommand 2/2: [ERROR] No unit available to explore.';
    layer.poll(1250);
    assert.deepEqual({ x: e.to.x, z: e.to.z }, { x: 37, z: -21 });
    assert.deepEqual({ x: e.from.x, z: e.from.z }, { x: w.x, z: w.z }, 'and a path from the scout');
    assert.equal(e.marker, false);
    const b = layer.bubbles.find(x => x.index === e.index);
    assert.deepEqual({ x: b.anchor.x, z: b.anchor.z }, { x: 37, z: -21 }, 'the bubble goes with it');
    assert.equal(b.from, e.from);
    // The refused one keeps its tile.
    const a1 = layer.tileCentre('A1');
    assert.deepEqual({ x: refused.to.x, z: refused.to.z }, { x: a1.x, z: a1.z });
});

test('bubbles pinned to the top edge pile downward instead of leaving the screen', async () => {
    const { layer } = await setup();
    const { stack } = layer.constructor;
    const box = x => ({ x, y: 120, w: 200, h: 50 });   // tops at 70, the highest allowed
    const ys = Array.from(stack([box(0), box(10), box(20)], 4, 70));
    assert.equal(ys[0], 120);
    assert.ok(ys[1] - 50 >= ys[0] + 4 - 1e-9, 'the second goes below the first: ' + ys);
    assert.ok(ys[2] - 50 >= ys[1] + 4 - 1e-9, 'and the third below that: ' + ys);
    assert.ok(ys.every(y => y - 50 >= 70), 'none climbs past the edge');
    // Without an edge they still climb, as before.
    const free = Array.from(stack([box(0), box(10)], 4));
    assert.ok(free[1] <= free[0] - 50);
});

// The bubble names its call after the model's name (asp67, 28 Sep 2026): a turn that
// points nowhere (train, research) but gives a reason keeps the call on its one bubble,
// so the page can show the call's icon and what was called.
test('a reason-only bubble keeps the call it came with', async () => {
    const { m, layer, turn } = await setup();
    const ai = m.seats[0];
    layer.add(ai, turn([['train_unit', { unitType: 'warrior', reason: 'More spears before the raid.' }]]), 1000);
    const b = layer.bubbles.find(x => x.seat === ai.id);
    assert.ok(b, 'one bubble over the base');
    assert.equal(b.action, 'train_unit');
    assert.equal(b.params.unitType, 'warrior');
    assert.equal(b.summary, false);
});

// A command that points at no place is shown where it is carried out (28 Sep 2026: 132 of
// 372 turns of a recorded match had lost such commands from the map).
test('a placeless command appears at the building that carries it out, with no ring', async () => {
    const m = await createMatch({ kind: 'board', seed: 'intent-home', seats: [
        { civ: 'greek', age: 'bronze', buildings: [['town_center', -100, 0], ['barracks', -60, 40, { tag: 'barracks' }]] },
        { civ: 'persian', age: 'bronze', buildings: [['town_center', 120, 0]] },
    ] });
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/intent-layer.js'), 'utf8'), m.context, { filename: 'js/intent-layer.js' });
    const layer = vm.runInContext('new IntentLayer(game)', m.context), ai = m.seats[0];
    const turn = calls => ({ toolCalls: calls.map(([name, args]) => ({ id: 'x', name, args: JSON.stringify(args) })) });
    layer.add(ai, turn([['train_unit', { unitType: 'militia', reason: 'Spears for the ford.' }], ['research_tech', { techId: 'bronze_working' }], ['wait', {}]]), 1000);
    const at = a => layer.bubbles.find(b => b.action === a).anchor, bx = m.tags.barracks, tc = ai.buildings.find(b => b.type === 'town_center');
    assert.equal(layer.bubbles.length, 3, 'every command has its bubble');
    assert.deepEqual({ x: at('train_unit').x, z: at('train_unit').z }, { x: bx.x, z: bx.z }, 'militia at the barracks');
    assert.deepEqual({ x: at('wait').x, z: at('wait').z }, { x: tc.x, z: tc.z }, 'the rest at the Town Center');
    assert.equal(layer.worldMarks(1000).length, 0, 'none of them draws a ring');
});

// Plans (29 Sep 2026): the plan call's bubble said only "plan". It is shown whole, on an
// edge of the view, three times as long as a turn's bubbles; two at most, a seat's new plan
// replacing its own, a third seat's replacing the oldest in its place.
test('a plan is shown whole on an edge, lasts three times as long, and two at most', async () => {
    const { m, layer, turn } = await setup();
    const [a, b] = m.seats, c3 = { id: 'third', seat: 2, units: [], buildings: [] };
    const long = 'Hold the ford at C4 with spears and archers until the second barracks is up, then push east along the river and burn every house on the way';
    const IL = vm.runInContext('IntentLayer', m.context);
    layer.add(a, turn([['plan', { objective: 'Win by Wonder', plan: ['Boom to 30 workers', long, 'Wall the pass'] }], ['train_unit', { unitType: 'worker', reason: 'more hands' }]]), 1000);
    assert.deepEqual(Array.from(layer.bubbles, x => x.text), ['more hands'], 'the plan is not a map bubble');
    assert.equal(layer.plans.length, 1);
    const p = layer.plans[0];
    assert.equal(p.objective, 'Win by Wonder');
    assert.deepEqual(Array.from(p.steps), ['Boom to 30 workers', long, 'Wall the pass'], 'every step, none cut short');
    assert.equal(p.life, 3 * IL.lifeFor(['Win by Wonder', 'Boom to 30 workers', long, 'Wall the pass'].join(' ')));
    assert.equal(p.slot, 0);
    // The seat's next turn replaces its bubbles, not its plan.
    layer.add(a, turn([['wait', { reason: 'Saving up.' }]]), 12000);
    assert.equal(layer.plans.length, 1, 'the plan outlives the next turn');
    assert.equal(layer.frame((x, z) => ({ x, y: z }), 12000 + 20000).plans.length, 1, 'still up at 3x a turn bubble');
    layer.add(b, turn([['plan', { objective: 'Rush', plan: ['Kill their workers'] }]]), 13000);
    assert.deepEqual(Array.from(layer.plans, q => [q.seat, q.slot]), [[a.id, 0], [b.id, 1]]);
    layer.add(a, turn([['plan', { plan: ['Tower the Wonder'] }]]), 14000);
    assert.deepEqual(Array.from(layer.plans, q => [q.seat, q.slot, q.steps.join()]), [[b.id, 1, 'Kill their workers'], [a.id, 0, 'Tower the Wonder']], 'a seat replaces its own plan, in its place');
    layer.add(c3, turn([['plan', { objective: 'Turtle' }]]), 15000);
    assert.deepEqual(Array.from(layer.plans, q => [q.seat, q.slot]), [[a.id, 0], ['third', 1]], 'a third replaces the oldest, in its place');
    layer.add(b, turn([['plan', {}]]), 16000);
    assert.equal(layer.plans.length, 2, 'an empty plan call shows nothing');
    const f = layer.frame((x, z) => ({ x, y: z }), 16000);
    assert.deepEqual(Array.from(f.plans, q => q.slot), [0, 1]);
    assert.equal(layer.frame((x, z) => ({ x, y: z }), 1e9).plans.length, 0, 'and they end');
});

test('a bubble on a building or a resource stands a bubble higher; one on open ground does not', async () => {
    const { m, layer, turn } = await setup();
    const ai = m.seats[0];
    layer.add(ai, turn([
        ['train_unit', { unitType: 'worker', reason: 'more hands' }],
        ['build_structure', { buildingType: 'house', targetX: -140, targetZ: 60, reason: 'Room to grow' }],
        ['assign_workers', { resourceType: 'wood', targetX: -150, targetZ: -80, count: 3, reason: 'Wood for the wall' }],
        ['explore', { tile: 'A1', reason: 'Look north.' }],
    ]), 1000);
    const f = layer.frame((x, z) => ({ x, y: z }), 1500);
    const by = t => f.bubbles.find(b => b.text === t);
    for (const t of ['more hands', 'Room to grow', 'Wood for the wall']) {
        const b = by(t);
        assert.equal(b.lift, true, t);
        assert.equal(b.y, b.ay - b.h, t + ': its bottom where its top was');
    }
    assert.equal(by('Look north.').lift, false);
    assert.equal(by('Look north.').y, by('Look north.').ay);
    // With a view: lifted only while standing on its own point.
    const away = layer.frame((x, z) => ({ x: x + 5000, y: z }), 1500, { focus: { x: 0, z: 0 }, w: 800, h: 600 });
    assert.ok(away.bubbles.every(b => !b.lift), 'resting on an edge, it covers nothing');
});

test('a seat\'s calls that all point out of view are one card; one in view keeps its own', async () => {
    const { m, layer, turn } = await setup();
    const ai = m.seats[0], house = m.tags.house;
    layer.add(ai, turn([
        ['attack_target', { targetId: house.id, unitIds: [m.tags.w1.handle], reason: 'Burn their house.' }],
        ['train_unit', { unitType: 'worker' }],
        ['explore', { tile: 'A1', reason: 'Look north.' }],
    ]), 1000);
    const view = { focus: { x: 0, z: 0 }, w: 800, h: 600 };
    // Everything far off to the right: one card, the calls in the turn's order.
    const off = layer.frame((x, z) => ({ x: x + 5000, y: z + 300 }), 1500, view);
    assert.equal(off.bubbles.length, 1, 'one card');
    const card = off.bubbles[0];
    assert.deepEqual(Array.from(card.lines, l => [l.action, l.text]),
        [['attack_target', 'Burn their house.'], ['explore', 'Look north.'], ['train_unit', 'train unit']]);
    assert.equal(card.lines[2].summary, true, 'a call without a reason stays named by its call');
    // The explore's tile in view: it keeps its own bubble; the two away still merge.
    const a1 = layer.tileCentre('A1');
    const mixed = layer.frame((x, z) => (x === a1.x && z === a1.z ? { x: 400, y: 300 } : { x: x + 5000, y: z + 300 }), 1500, view);
    assert.equal(mixed.bubbles.length, 2);
    assert.equal(mixed.bubbles.find(b => !b.lines).text, 'Look north.');
    assert.equal(mixed.bubbles.find(b => b.lines).lines.length, 2);
    // Without a view nothing is merged.
    assert.equal(layer.frame((x, z) => ({ x: x + 5000, y: z }), 1500).bubbles.length, 3);
});

// The harness numbers the game commands only; a plan call sent first must not push every
// refusal mark one command late (found 29 Sep 2026 while showing plans).
test('a plan sent first does not shift which command is marked refused', async () => {
    const { m, layer, turn } = await setup();
    const ai = m.seats[0], house = m.tags.house;
    const t = turn([
        ['plan', { objective: 'Raid', plan: ['Burn the house'] }],
        ['attack_target', { targetId: house.id, unitIds: [m.tags.w1.handle], reason: 'Burn their house.' }],
        ['explore', { tile: 'A1', reason: 'Look north.' }],
    ]);
    t.outcome = 'Command 1/2: [ERROR] Out of reach.\nCommand 2/2: OK - Sent your warrior #2 to explore A1.';
    layer.add(ai, t, 1000);
    const f = layer.frame((x, z) => ({ x, y: z }), 1500);
    assert.equal(f.bubbles.find(b => b.text === 'Burn their house.').refused, true, 'the attack was the refused one');
    assert.equal(f.bubbles.find(b => b.text === 'Look north.').refused, false);
});
