'use strict';
// A model's own tool-call markup left inside a call's arguments (GLM's <tool_call>,
// <arg_key>, <arg_value>) means its tags came out broken and the calls were cut apart in the
// wrong places (28 Sep 2026: a reason that swallowed the whole next train_unit; a key reading
// 'archer</arg_value><arg_key>reason'). Such a call is not run and not repaired -- the model
// is told -- and the display shows the reason only up to the first stray tag.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createMatch } = require('../tools/bench/realm.cjs');
const taxonomy = require('../tools/bench/taxonomy.cjs');

async function setup() {
    const m = await createMatch({ kind: 'board', seed: 'raw-markup', seats: [
        { civ: 'greek', age: 'bronze', buildings: [['town_center', -100, 0]], resources: { food: 900, wood: 900, stone: 900, gold: 900 } },
        { civ: 'persian', age: 'bronze', buildings: [['town_center', 120, 0]] },
    ] });
    const mgr = m.game.openAIAIManager, c = m.controllers[0];
    const run = (action, params) => { mgr.executeAction(c, { action, params }); return { result: String(c.seat.lastActionResult || ''), code: c._lastOutcome && c._lastOutcome.code }; };
    return { m, mgr, c, run };
}

test('a call carrying raw tool-call markup is refused with a plain explanation', async () => {
    const { m, run } = await setup();
    const food = () => m.seats[0].resources.food, before = food();
    const swallowed = run('train_unit', { unitType: 'worker',
        reason: 'Food is strong; keep the villager stream flowing<tool_call>train_unit<arg_key>reason</arg_key><arg_value>Keep the villager stream flowing' });
    assert.match(swallowed.result, /^\[ERROR\] train_unit: its arguments contain raw tool-call markup .* nothing written inside it was run, including any command after the break\. Send each command as its own tool call/);
    assert.equal(swallowed.code, 'rawToolMarkup');
    const brokenKey = run('train_unit', { unitType: 'worker', 'archer</arg_value><arg_key>reason': 'Archery range idle' });
    assert.equal(brokenKey.code, 'rawToolMarkup', 'a broken key too');
    assert.equal(food(), before, 'nothing was trained: no food spent');
    assert.equal(taxonomy.CLASS_OF.rawToolMarkup, 'reference', 'the bench classifies it as a malformed call');
});

test('an ordinary reason with angle brackets still runs', async () => {
    const { m, run } = await setup();
    const before = m.seats[0].resources.food;
    const ok = run('train_unit', { unitType: 'worker', reason: 'Gold <3 per trip; more hands first -> then the wonder' });
    assert.ok(m.seats[0].resources.food < before, 'the worker was paid for: ' + ok.result);
    assert.doesNotMatch(ok.result, /raw tool-call markup/);
    assert.notEqual(ok.code, 'rawToolMarkup');
});

test('the log and the bubbles show the reason only up to the first stray tag', async () => {
    const { m, mgr, c } = await setup();
    mgr.executeAction(c, { action: 'train_unit', params: { unitType: 'worker', reason: 'Keep the villagers coming<tool_call>train_unit<arg_key>reason</arg_key>' } });
    assert.equal(mgr.decisionLog.at(-1).reason, 'Keep the villagers coming …');
    assert.equal(String(mgr.decisionLog.at(-1).params.reason).includes('<tool_call>'), true, 'the record keeps the raw arguments');
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js/intent-layer.js'), 'utf8'), m.context, { filename: 'js/intent-layer.js' });
    const reasonText = vm.runInContext('IntentLayer.reasonText', m.context);
    assert.equal(reasonText('Hold the ford<arg_key>reason</arg_key>'), 'Hold the ford …');
    assert.equal(reasonText('Plain reason'), 'Plain reason');
});
