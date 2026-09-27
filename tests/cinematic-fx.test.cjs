'use strict';
// The Cinematic lighting style's building effects (review #12): fire by damage tier at
// fixed places on the roof, steady for a viewer who asked for less motion, rubble that
// fades on the match's own clock -- and none of it in the other lighting styles.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');

function fx() {
    const ctx = vm.createContext({ Math, Float32Array, String, window: {} });
    vm.runInContext(fs.readFileSync(path.join(root, 'js/engine/fx.js'), 'utf8'), ctx);
    return ctx.window.EngineFx;
}
// A frame's worth of drawing context, recording what was drawn.
function frame() {
    const I = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const sizes = [];   // one scaling per drawn entry, in drawing order
    const m3 = { multiply: (a, b) => a, translation: (x, y, z) => ({ x, y, z }), scaling: (x, y, z) => { sizes.push([x, y, z]); return I(); }, rotationY: () => I() };
    const dl = { blended: [], opaque: [] };
    return { m3, bb: I(), quad: 'quad', ringBuf: 'disc', boxBuf: 'box', tex: { mote: 'mote', rock: 'rock' }, dl, sizes };
}
const house = (hp, id = 'building_abc') => ({ id, x: 100, z: -50, health: hp, maxHealth: 1, _fireBox: { ex: 3, ez: 3, ey: 5 } });

test('damage tiers: smoke under 70 %, flames under 45 %, a blaze under 20 %', () => {
    const F = fx();
    assert.deepEqual([0.9, 0.69, 0.44, 0.19].map(F.tier), [0, 1, 2, 3]);
    const count = hp => { const f = frame(); const lights = F.burning(house(hp), hp, 10, false, f); return { n: f.dl.blended.length, lights, add: f.dl.blended.filter(e => e.additive).length }; };
    assert.equal(count(0.9).n, 0, 'a sound building draws nothing');
    const smoke = count(0.6);
    assert.ok(smoke.n > 0 && smoke.add === 0 && smoke.lights === null, 'smoke only: no flame, no light');
    const fire = count(0.3), blaze = count(0.1);
    assert.ok(fire.add > 0 && fire.lights instanceof Object);
    assert.ok(blaze.add > fire.add && blaze.n > fire.n, 'a blaze is more of everything');
    assert.equal(Array.from(blaze.lights).filter((v, i) => i % 4 === 3 && v > 0).length, 3, 'three lights, as the shader takes');
});

test('fires sit at fixed places inside the walls, on the side facing the camera', () => {
    const F = fx();
    const b = house(0.1);
    const a1 = F.spots(b, 3), a2 = F.spots(b, 3);
    assert.deepEqual(JSON.parse(JSON.stringify(a1)), JSON.parse(JSON.stringify(a2)), 'the same every frame');
    for (const s of a1) {
        assert.ok(Math.abs(s.x - b.x) <= b._fireBox.ex && Math.abs(s.z - b.z) <= b._fireBox.ez);
        assert.ok(s.y > 1 && s.y <= b._fireBox.ey + 0.3, 'on the roof, not above it');
    }
    const south = F.spots(b, 3, [b.x, 50, b.z + 100]), north = F.spots(b, 3, [b.x, 50, b.z - 100]);
    const mean = l => l.reduce((a, s) => a + s.z, 0) / l.length;
    assert.ok(mean(south) > mean(north), 'they lean toward the eye');
    assert.notDeepEqual(JSON.parse(JSON.stringify(F.spots(house(0.1, 'building_other'), 3))), JSON.parse(JSON.stringify(a1)));
});

test('for reduced motion the flames hold still and no embers rise', () => {
    const F = fx();
    const at = (t, still) => { const f = frame(); F.burning(house(0.1), 0.1, t, still, f); return f; };
    // The flame sprites' sizes (smoke drifts either way; flames are what flicker).
    const flames = f => f.dl.blended.map((e, i) => e.additive && e.buf === 'quad' && e.tint[0] === 1 && e.tint[1] < 0.9 ? f.sizes[i].join() : null).filter(Boolean);
    assert.deepEqual(flames(at(3, true)), flames(at(7.3, true)), 'the same flames at any moment');
    assert.notDeepEqual(flames(at(3, false)), flames(at(7.3, false)), 'and they do flicker otherwise');
    assert.ok(at(3, false).dl.blended.filter(e => e.additive).length > at(3, true).dl.blended.filter(e => e.additive).length, 'embers only when motion is welcome');
});

test('rubble fades out on the match clock and is gone after three minutes', () => {
    const F = fx();
    const r = { x: 0, z: 0, r: 3, born: 100, seed: 42 };
    const draw = t => { const f = frame(); F.rubble(r, t, f); return f.dl; };
    const fresh = draw(101);
    assert.ok(fresh.opaque.length >= 9, 'stones');
    assert.ok(fresh.blended.length >= 2, 'soot, and smoke while it smoulders');
    const late = draw(100 + F.RUBBLE_SECONDS * 0.9);
    assert.equal(late.opaque.length, 0, 'fading stones move to the blended pass');
    assert.ok(late.blended.every(e => e.alpha <= 1));
    const gone = draw(100 + F.RUBBLE_SECONDS);
    assert.equal(gone.opaque.length + gone.blended.length, 0);
    assert.equal(draw(99).blended.length, 0, 'nothing before it fell');
});

test('two light sets merge into the three the shader takes', () => {
    const F = fx();
    const a = new Float32Array(12); a.set([1, 2, 3, 0.5], 0);
    const b = new Float32Array(12); b.set([4, 5, 6, 1, 7, 8, 9, 1, 10, 11, 12, 1]);
    const m = Array.from(F.mergeLights(a, b));
    assert.deepEqual(m, [1, 2, 3, 0.5, 4, 5, 6, 1, 7, 8, 9, 1]);
});

test('only the Cinematic style draws any of it', () => {
    const src = fs.readFileSync(path.join(root, 'js/engine/gamerenderer.js'), 'utf8');
    const uses = src.split('\n').filter(l => /EngineFx\.(burning|rubble)\(|_bloom\.apply\(/.test(l));
    assert.equal(uses.length, 3);
    // Each call sits under a visualStyle === 'film' guard within a few lines.
    const lines = src.split('\n');
    for (const u of uses) {
        const i = lines.indexOf(u);
        assert.ok(lines.slice(Math.max(0, i - 12), i + 1).some(l => l.includes("visualStyle === 'film'")), u.trim());
    }
});
