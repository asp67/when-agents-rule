'use strict';
// Strike-synced combat (review #12): a fighter's swing follows the rules' attack timer,
// so the blow lands when the damage does; strides follow the ground covered; archers
// draw and release; priests channel.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

function units() {
    const scope = { console, window: {} };
    vm.createContext(scope);
    for (const f of ['js/simulation/rng.js', 'js/simulation/math.js']) vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), scope);
    for (const name of ['math3d', 'mesh', 'units']) {
        vm.runInContext(fs.readFileSync(path.join(root, 'js/engine', name + '.js'), 'utf8'), scope);
        Object.assign(scope, scope.window);
    }
    return scope.EngineUnits;
}
const arm = (pose, bone = 'armR') => Array.from(pose.mats[bone] || []).map(v => Math.round(v * 1e6) / 1e6).join();

test('the slash winds up slowly, strikes fast and lands with the damage', () => {
    const U = units();
    const a = U.swingAngle;
    // Continuous through the cycle, with the blow at the timer's wrap.
    for (const p of [0.12, 0.82]) assert.ok(Math.abs(a(p - 1e-6) - a(p + 1e-6)) < 1e-3, 'continuous at ' + p);
    assert.ok(Math.abs(a(0.999) - 0.2) < 0.02 && Math.abs(a(0) - 0.2) < 1e-9, 'the arm is down, through the target, as the timer wraps');
    assert.ok(a(0.8199) < -1.44, 'fully raised just before the down-stroke');
    // The down-stroke is quick: about a quarter of the wind-up's time.
    const raise = 0.82 - 0.12, strike = 1 - 0.82;
    assert.ok(strike * 3 < raise);
});

test('the swing follows the attack timer, not the clock', () => {
    const U = units();
    const at = (t, strike) => arm(U.pose('infantry', 'attack', t, 1.3, { strike }));
    assert.equal(at(1, 0.5), at(97.3, 0.5), 'the same moment in the cycle looks the same whenever it is');
    assert.notEqual(at(1, 0.5), at(1, 0.95));
    // Cavalry thrusts home on the blow.
    const cav = s => arm(U.pose('cavalry', 'attack', 0, 0, { strike: s }));
    assert.notEqual(cav(0.3), cav(0.99));
});

test('strides follow the ground covered: standing still, the legs do not cycle', () => {
    const U = units();
    const legs = (t, stride) => arm(U.pose('infantry', 'walk', t, 0.5, { stride }), 'legL');
    assert.equal(legs(1, 4.2), legs(55, 4.2), 'no distance, no step, whatever the clock says');
    assert.equal(legs(0, 0), legs(0, 2 * Math.PI / 2.2), 'one full stride per 2.86 units walked');
    assert.notEqual(legs(0, 0), legs(0, 0.7));
    // Without a stride (older callers) the tempo still comes from the clock.
    assert.notEqual(legs(1, undefined), legs(1.2, undefined));
});

test('archers draw and release, the bow arm held on the target; priests channel', () => {
    const U = units();
    const shoot = s => U.pose('ranged', 'shoot', 0, 0, { strike: s });
    assert.equal(arm(shoot(0.2), 'armL'), arm(shoot(0.9), 'armL'), 'the bow arm stays on target');
    assert.notEqual(arm(shoot(0.2)), arm(shoot(0.9)), 'the string hand draws back');
    const ch = U.pose('priest', 'channel', 3, 0);
    assert.ok(ch.mats.armL && ch.mats.armR, 'both hands raised');
});
