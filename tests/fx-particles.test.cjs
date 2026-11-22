// Overhaul step A9, first slice (build 1206): particles. Dust, sparks, chips and the streak
// behind a shot are squares that face the camera, all of them in two draws a picture, placed
// by the card from a list of eight numbers each.
const test = require('node:test'), assert = require('node:assert/strict');
const vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

function fx(instancing = true) {
    const made = [];
    const scope = { window: {}, Math: Object.create(Math) };
    scope.window.M3D = { identity: () => 'identity' };
    scope.GLCore = { instancingOf: () => instancing ? {} : null,
        createInstances: (gl, mesh, data, stride) => { const b = { mesh, stride, instance: {}, instances: data.length / stride, sent: [data.length] }; made.push(b); return b; },
        setInstances: (gl, b, data) => { b.instances = data.length / b.stride; b.sent.push(data.length); }, deleteMeshBuffers: (gl, b) => { b.deleted = true; } };
    vm.createContext(scope);
    vm.runInContext(read('js/engine/fx.js'), scope);
    return { F: scope.window.EngineFx, made, scope };
}
const near = (a, b, eps = 1e-5) => Math.abs(a - b) < eps;

test('a particle flies, falls, lands and is gone when its life is over', () => {
    const { F } = fx(), P = new F.Particles(8);
    assert.ok(P.emit({ x: 1, y: 2, z: 3, vx: 2, vy: 4, vz: -2, life: 3, size: 0.5, gravity: 10, tint: [0.2, 0.4, 0.6], alpha: 0.8 }));
    P.update(0.1);
    const p = P.p;
    assert.ok(near(p[0], 1.2) && near(p[2], 2.8), 'moved by its speed');
    assert.ok(near(p[4], 3) && near(p[1], 2.3), 'gravity takes from its rise before the step');
    // Up to its top (about 2.8 after 0.4 s), then down: on the ground some 1.2 s after it left.
    for (let i = 0; i < 3; i++) P.update(0.1);
    assert.ok(p[1] > 2.55, 'near the top of its arc: ' + p[1]);
    for (let i = 0; i < 11; i++) P.update(0.1);
    assert.ok(near(p[1], 0.08) && p[4] === 0, 'what falls lands and lies: ' + p[1]);
    assert.equal(P.n, 1);
    P.update(1.6);
    assert.equal(P.n, 0, 'gone at the end of its life');
    P.update(0); P.update(-1); P.update(NaN);         // a paused frame moves nothing and breaks nothing
});

test('the list is full at its size, and the last particle takes a dead one\'s place', () => {
    const { F } = fx(), P = new F.Particles(3);
    for (const [x, life] of [[1, 0.2], [2, 5], [3, 5]]) assert.ok(P.emit({ x, y: 1, z: 0, life }));
    assert.equal(P.emit({ x: 4, y: 1, z: 0 }), false, 'no room: the particle is not made');
    P.update(0.3);
    assert.equal(P.n, 2);
    assert.deepEqual([P.p[0], P.p[16]].sort(), [2, 3], 'the two that live are the two that are kept');
    P.clear(); assert.equal(P.n, 0);
});

test('two lists: what is laid over the scene and what is added to it as light, eight numbers a particle', () => {
    const { F } = fx(), P = new F.Particles(16);
    P.emit({ x: 1, y: 1, z: 1, life: 1, size: 2, grow: 3, tint: [0.1, 0.2, 0.3], alpha: 0.5 });
    P.emit({ x: 5, y: 1, z: 1, life: 1, size: 1, tint: [1, 0.5, 0], additive: true });
    P.update(0.5);
    const c = P.fill();
    assert.deepEqual(Array.from(c), [1, 1]);
    const laid = Array.from(P.lists[0].subarray(0, 8)), added = Array.from(P.lists[1].subarray(0, 8));
    assert.ok(near(laid[0], 1) && near(laid[3], 4), 'half way through its life it is half way to its last size: ' + laid[3]);
    assert.ok(near(laid[4], 0.1) && near(laid[5], 0.2) && near(laid[6], 0.3));
    assert.ok(near(laid[7], 0.5 * (0.5 / 0.9)), 'it comes in over the first tenth of its life and goes over the rest');
    assert.ok(near(added[0], 5) && near(added[4], 1));
    // In at once, out slowly.
    const Q = new F.Particles(4); Q.emit({ x: 0, y: 1, z: 0, life: 1, alpha: 1 });
    Q.update(0.05); Q.fill(); assert.ok(near(Q.lists[0][7], 0.5));
    Q.update(0.05); Q.fill(); assert.ok(near(Q.lists[0][7], 1));
});

test('a streak is drawn for one frame: squares back along the way a shot came, smaller and fainter', () => {
    const { F } = fx(), P = new F.Particles(64);
    P.streak(10, 2, 0, 1, 0, 0, 3, 6, 0.5, [1, 1, 1], 0.8, false);
    P.streak(0, 2, 0, 0, 0, 1, 2, 4, 0.7, [1, 0.5, 0.1], 0.9, true);
    const c = P.fill();
    assert.deepEqual(Array.from(c), [6, 4]);
    const xs = [], sizes = [], alphas = [];
    for (let i = 0; i < 6; i++) { xs.push(P.lists[0][i * 8]); sizes.push(P.lists[0][i * 8 + 3]); alphas.push(P.lists[0][i * 8 + 7]); }
    assert.ok(near(xs[0], 10) && near(xs[5], 10 - 2.5), 'from the shot back by its length');
    for (let i = 1; i < 6; i++) assert.ok(xs[i] < xs[i - 1] && sizes[i] < sizes[i - 1] && alphas[i] < alphas[i - 1]);
    assert.ok(near(alphas[0], 0.8));
    assert.deepEqual(Array.from(P.fill()), [0, 0], 'not kept: next frame it is asked for again or it is gone');
    // Streaks give way when the lists are full: nothing is written past their end.
    const small = new F.Particles(3);
    small.streak(0, 1, 0, 1, 0, 0, 3, 12, 0.5, [1, 1, 1], 1, false);
    assert.deepEqual(Array.from(small.fill()), [3, 0]);
});

test('all the particles of a picture are two draws; without instancing each is a draw, as dust always was', () => {
    const quad = { quad: true }, fm = { multiply: (a, b) => [a, b], translation: (...a) => a, scaling: (...a) => a };
    const r = { gl: {}, tex: { mote: { mote: true } }, _identity: 'one' };
    const { F, made } = fx(true), P = new F.Particles(32);
    assert.equal(P.entries(r, quad, fm, 'bb').length, 0, 'nothing to draw is no draw');
    for (let i = 0; i < 5; i++) P.emit({ x: i, y: 1, z: 0, life: 1 });
    for (let i = 0; i < 3; i++) P.emit({ x: i, y: 1, z: 0, life: 1, additive: true });
    P.update(0.2);
    const ents = P.entries(r, quad, fm, 'bb');
    assert.equal(ents.length, 2);
    assert.deepEqual(Array.from(ents, e => [e.buf.stride, e.buf.instances, !!e.additive, e.particles, e.model]), [[8, 5, false, true, 'one'], [8, 3, true, true, 'one']]);
    assert.ok(ents.every(e => e.tex === r.tex.mote && e.buf.mesh === quad));
    // Next frame the same two lists are sent again, not made again.
    P.update(0.1);
    const again = P.entries(r, quad, fm, 'bb');
    assert.equal(made.length, 2); assert.equal(again[0], ents[0]);
    assert.deepEqual(made.map(b => b.sent.length), [2, 2]);
    P.dispose(r.gl); assert.ok(made.every(b => b.deleted));
    // An old driver: one draw a particle, placed by its own matrix.
    const old = fx(false), Q = new old.F.Particles(8);
    Q.emit({ x: 1, y: 2, z: 3, life: 1, size: 0.5, tint: [0.3, 0.3, 0.3] }); Q.emit({ x: 2, y: 2, z: 3, life: 1, additive: true });
    Q.update(0.2);
    const each = Q.entries(r, quad, fm, 'bb');
    assert.equal(each.length, 2); assert.equal(old.made.length, 0);
    assert.ok(each.every(e => e.buf === quad && e.tint.length === 3 && e.alpha > 0 && e.model));
});

test('what the effects make: a burst of dust, sparks off a unit, sparks and chips off a wall', () => {
    const { F } = fx();
    const count = P => { const c = P.fill(); return [c[0], c[1]]; };
    let P = new F.Particles(64); F.burst(P, 0, 1, 0, 24, [0.6, 0.55, 0.5]); assert.deepEqual(count(P), [24, 0]);
    P = new F.Particles(64); F.sparks(P, 0, 1, 0, false); assert.deepEqual(count(P), [0, 6]);
    P = new F.Particles(64); F.sparks(P, 0, 1, 0, true); assert.deepEqual(count(P), [5, 3]);
    // A shot's streak by its kind; smoke and dust are left hanging only when a puff is due.
    for (const [kind, laid, added, puff] of [['arrow', 12, 0, 0], ['stone', 5, 0, 0], ['fire', 0, 9, 1], ['boulder', 6, 0, 1]]) {
        P = new F.Particles(64); F.trail(P, kind, 0, 2, 0, 1, 0, 0, false); assert.deepEqual(count(P), [laid, added], kind);
        P = new F.Particles(64); F.trail(P, kind, 0, 2, 0, 1, 0, 0, true); assert.equal(P.n, puff, kind + ' leaves ' + puff + ' behind');
    }
    // Low and a viewer who asked for less motion get the dust bursts and nothing else.
    assert.deepEqual([F.level('low', false), F.level('balanced', false), F.level('cinematic', false), F.level('cinematic', true)], [0, 1, 2, 0]);
});

test('a wide list of instances is eight numbers an entry: the place and size, then the colour', () => {
    const scope = { window: {} }; vm.createContext(scope); vm.runInContext(read('js/engine/glcore.js'), scope);
    const G = scope.window.GLCore, calls = [];
    const gl = { TRIANGLES: 4, UNSIGNED_SHORT: 5123, ARRAY_BUFFER: 34962, ELEMENT_ARRAY_BUFFER: 34963, STATIC_DRAW: 35044, FLOAT: 5126,
        createBuffer: () => ({}), bindBuffer() {}, bufferData() {}, enableVertexAttribArray: a => calls.push(['enable', a]), disableVertexAttribArray: a => calls.push(['disable', a]),
        vertexAttribPointer: (...a) => calls.push(['pointer', ...a]), vertexAttribDivisor: (...a) => calls.push(['divisor', ...a]), drawElementsInstanced: (...a) => calls.push(['drawInstanced', ...a]),
        drawElements: (...a) => calls.push(['draw', ...a]), createVertexArray: () => ({}), bindVertexArray() {}, deleteVertexArray() {}, deleteBuffer() {} };
    const mesh = { position: {}, normal: {}, uv: {}, bone: null, index: {}, count: 6 };
    const program = { attribs: { aPosition: 0, aNormal: 1, aUv: 2, aBone: 3, aInstance: 4, aInstanceColor: 5 } };
    const wide = G.createInstances(gl, mesh, new Float32Array(8 * 7), 8);
    assert.equal(wide.stride, 8); assert.equal(wide.instances, 7);
    G.drawMesh(gl, program, wide);
    assert.deepEqual(calls.filter(c => c[0] === 'pointer' && c[1] >= 4).map(c => [c[1], c[2], c[5], c[6]]), [[4, 4, 32, 0], [5, 4, 32, 16]], 'two fours, thirty-two bytes an entry');
    assert.deepEqual(calls.filter(c => c[0] === 'divisor').map(c => c.slice(1)), [[4, 1], [5, 1]]);
    assert.deepEqual(calls.at(-1), ['drawInstanced', 4, 6, 5123, 0, 7]);
    G.setInstances(gl, wide, new Float32Array(8 * 3)); assert.equal(wide.instances, 3);
    // The grass's list is four numbers still, and has no colour of its own.
    calls.length = 0;
    const narrow = G.createInstances(gl, mesh, new Float32Array(4 * 5));
    assert.equal(narrow.stride, 4); assert.equal(narrow.instances, 5);
    G.drawMesh(gl, program, narrow);
    assert.deepEqual(calls.filter(c => c[0] === 'pointer' && c[1] === 4).map(c => [c[2], c[5], c[6]]), [[4, 0, 0]]);
    assert.ok(calls.some(c => c[0] === 'disable' && c[1] === 5));
    // A plain mesh says it has neither.
    calls.length = 0; G.drawMesh(gl, program, { position: {}, normal: {}, uv: {}, bone: null, index: {}, count: 6 });
    assert.deepEqual(calls.filter(c => c[0] === 'divisor').map(c => c.slice(1)), [[4, 0], [5, 0]]);
});

test('the shader lays a particle along the picture\'s right and up, in its own colour; nothing else changes colour', () => {
    const s = read('js/engine/atmosphere.js');
    assert.match(s, /attribute vec4 aInstanceColor;\s+uniform vec3 uBillRight, uBillUp;\s+varying mediump vec4 vInst;/);
    assert.match(s, /vInst = vec4\(1\.0\);\s+bool sown = uInstanced > 0\.5 && uInstanced < 1\.5;[^\n]*\n\s+if \(uInstanced > 1\.5\) \{\s+local\.xyz = aInstance\.xyz \+ \(uBillRight\*aPosition\.x \+ uBillUp\*aPosition\.y\)\*aInstance\.w;\s+normal = vec3\(0\.0, 1\.0, 0\.0\);\s+vInst = aInstanceColor;\s+\} else if \(sown\) \{/);
    assert.match(s, /vec3 base = t\.rgb \* uTint \* vInst\.rgb;/);
    assert.match(s, /gl_FragColor = vec4\(mix\(col,uSky,haze\),alpha\*uAlpha\*vInst\.a\);/);
    // What was the grass's alone stays the grass's: a particle is not stretched like a tuft or coloured by the ground.
    assert.match(s, /vGrassTip = clamp\(\(\(sown \? local\.y : aPosition\.y\)-0\.018\) \/ 0\.562, 0\.0, 1\.0\);/);
    assert.match(s, /if \(sown\) vUv = stone \? vec2\(-1\.0, stoneShade\) : local\.xz \/ uInstanceWorld \+ 0\.5;/);
    assert.equal((s.match(/varying mediump vec4 vInst;/g) || []).length, 2, 'named alike in both shaders');
    const r = read('js/engine/gamerenderer.js');
    assert.match(r, /const inst = obj\.buf\.instance \? \(obj\.buf\.stride === 8 \? 2 : 1\) : 0;/);
    assert.match(r, /gl\.uniform3f\(this\.prog\.uniforms\.uBillRight, cam\.view\[0\], cam\.view\[4\], cam\.view\[8\]\);\s+gl\.uniform3f\(this\.prog\.uniforms\.uBillUp, cam\.view\[1\], cam\.view\[5\], cam\.view\[9\]\);/);
});

test('the renderer: dust bursts are particles on every tier; sparks and trails only where the tier has them', () => {
    const r = read('js/engine/gamerenderer.js');
    // Moved on once a frame, whichever picture is built first; drawn in both.
    assert.match(r, /particles\.update\(once\(particles\)\);\s+for \(const e of particles\.entries\(this, quad, fm, bb\)\) dl\.blended\.push\(e\);/);
    assert.match(r, /spawnDust\(x, y, z, count, color\) \{\s+const P = this\._fx\(\);\s+if \(P\) EngineFx\.burst\(P, x, y, z, Math\.min\(24, count \|\| 24\), this\._tintOf\(color == null \? 0xb0a48e : color\)\);/);
    assert.doesNotMatch(r, /_dustPool/);
    // A hit: only on a tier with effects, in view, and not for every blow.
    assert.match(r, /if \(this\._fxLevel\(\) > 0 && !\(now < entity\._sparkUntil\) && !this\._cull\(entity\.x, entity\.z, 4\)\) \{/);
    assert.match(r, /entity\._sparkUntil = now \+ 100;/);
    // A shot's streak follows the way it flies at this point of its arc.
    assert.match(r, /let vx = p\.tx - p\.sx, vy = \(p\.ty - p\.sy\) \+ Math\.PI \* Math\.cos\(Math\.PI \* k\) \* p\.arc, vz = p\.tz - p\.sz;/);
    assert.match(r, /const fxLevel = this\._fxLevel\(\), fxP = fxLevel > 0 \? this\._fx\(\) : null;/);
    assert.match(r, /const trails = fxP;/);
    assert.match(r, /if \(this\._particles\) this\._particles\.clear\(\);/);
    // Presentation only: the rules know nothing of it, and it takes no number from the game's dice.
    const fxSrc = read('js/engine/fx.js');
    assert.doesNotMatch(fxSrc, /SimRng|game\.rng|\.rng\(/);
    const manifest = read('js/manifest.js');
    assert.doesNotMatch(manifest.slice(manifest.indexOf('rules'), manifest.indexOf(']', manifest.indexOf('rules'))), /fx\.js|gamerenderer/);
});

// ---- what a unit raises and carries (build 1207) ----------------------------------------
const ONE = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const walk = (F, type, opts, steps = 80, step = 0.2) => {
    const P = new F.Particles(400), u = { x: 0, z: 0, isMoving: true }, ue = { type, phase: 0.001 };
    for (let i = 0; i < steps; i++) { u.x += step; F.unitMotion(P, u, ue, Object.assign({ moved: step, tSec: i / 60, level: 2, theme: 'summer', night: 0, world: ONE, far: false, marching: 0 }, opts)); }
    return P;
};

test('dust under marching feet: a puff for every stretch walked, more for a rider, less in a crowd and on Balanced', () => {
    const { F } = fx();
    // Sixteen units walked in steps of a fifth (the steps do not add up exactly, so a puff comes
    // every eight or nine of them).
    const foot = walk(F, 'infantry').n;
    assert.ok(foot >= 8 && foot <= 10, 'a puff every 1.6 units: ' + foot);
    // Within a quarter of what is wanted (the same rounding of steps, twice over).
    const near2 = (n, want) => Math.abs(n - want) <= Math.max(2, want * 0.25);
    assert.ok(near2(walk(F, 'cavalry').n, foot * 2), 'a rider: twice as many');
    assert.ok(near2(walk(F, 'worker').n, foot / 2));
    assert.ok(near2(walk(F, 'infantry', { level: 1 }).n, foot / 2), 'Balanced: half the puffs');
    assert.ok(near2(walk(F, 'infantry', { marching: 12 }).n, foot / 2), 'twelve on the move: each leaves half');
    assert.ok(walk(F, 'infantry', { marching: 60 }).n <= 2);
    // An army's dust still grows with the army, though not in step with it.
    const total = n => n / (1 + n / 12);
    assert.ok(total(60) > total(13) && total(13) > total(3) && total(60) < 60 / 4);
    // Standing still raises none; nor does a jump across the map (a replay's cut).
    const P = new F.Particles(8), u = { x: 0, z: 0, isMoving: false }, ue = { type: 'infantry' };
    for (let i = 0; i < 50; i++) F.unitMotion(P, u, ue, { moved: 0.2, tSec: 0, level: 2, theme: 'summer', night: 0, world: ONE });
    assert.equal(P.n, 0);
    u.isMoving = true; F.unitMotion(P, u, ue, { moved: 40, tSec: 0, level: 2, theme: 'summer', night: 0, world: ONE });
    assert.equal(P.n, 0);
    // In the land's colour, and paler than it.
    for (const theme of ['summer', 'desert', 'winter']) {
        const Q = walk(F, 'infantry', { theme }, 9);
        Q.fill();
        const [tint, alpha] = F.GROUND_DUST[theme];
        assert.ok(Math.abs(Q.lists[0][4] - tint[0]) < 1e-6 && alpha > 0.5 && tint.every(v => v > 0.6), theme);
    }
    // Build 1209: a puff is two fifths of what build 1207 raised. Seen in a real match, an
    // army's dust stood over it as a pale cloud (asp67: half the size, or a quarter).
    assert.equal(F.MARCH_DUST, 0.4);
    const size = kind => { const P = new F.Particles(4), u = { x: 0, z: 0, isMoving: true }, ue = { type: kind === 'engine' ? 'infantry' : kind, static: kind === 'engine' };
        for (let i = 0; i < 40 && !P.n; i++) F.unitMotion(P, u, ue, { moved: 0.2, tSec: 0, level: 2, theme: 'summer', world: ONE }); P.fill(); return P.lists[0][3]; };
    assert.ok(size('infantry') > 0.8 && size('infantry') < 1.0, 'a walker: ' + size('infantry'));
    assert.ok(size('cavalry') > size('infantry') && size('engine') > size('cavalry') && size('engine') < 1.5);
});

// Build 1209: asp67 saw the birds and the soldiers' torches in a match and had both removed.
test('no birds and no torches: nothing of either is left in the effects or the renderer', () => {
    const { F } = fx();
    for (const name of ['Birds', 'birdMesh', 'BIRD_REACH', 'TORCH_NIGHT', 'TORCH_HAND']) assert.equal(F[name], undefined, name);
    assert.equal(new F.Particles(2).flare, undefined);
    // A soldier at night adds nothing to the picture by standing there.
    const P = new F.Particles(8), ue = { type: 'infantry', phase: 0.003 };
    F.unitMotion(P, { x: 5, z: 7, isMoving: false }, ue, { moved: 0, tSec: 1, level: 2, theme: 'summer', world: ONE, far: false });
    assert.equal(P.n, 0); assert.equal(P.passing.length, 0); assert.equal(ue.torch, undefined);
    for (const f of ['js/engine/fx.js', 'js/engine/gamerenderer.js']) assert.doesNotMatch(read(f), /torchLit|TORCH_|ue.torch|Birds|birdMesh|BIRD_/, f);
});

test('chips: once a swing a worker\'s tool throws up what it strikes', () => {
    const { F } = fx();
    const work = (u, seconds) => { const P = new F.Particles(200), ue = { type: 'worker', phase: 0 }; let made = 0;
        for (let i = 0; i < seconds * 60; i++) { const before = P.n; F.unitMotion(P, u, ue, { moved: 0, tSec: i / 60, level: 1, theme: 'summer', night: 0, world: ONE, far: false }); made += P.n - before; P.update(0); }
        return { P, made, ue }; };
    // A swing is 2 pi / 5.5 seconds: in four seconds, three blows land (the first frame only starts the count).
    const wood = work({ x: 0, z: 0, isHarvesting: true, harvestTarget: { type: 'wood' } }, 4);
    assert.equal(wood.made, 3 * 4, 'four chips a blow');
    const stone = work({ x: 0, z: 0, isHarvesting: true, harvestTarget: { type: 'stone' } }, 4);
    assert.equal(stone.made, 3 * 5); stone.P.fill(); assert.equal(stone.P.counts[1], 3, 'a spark a blow off the rock');
    assert.equal(work({ x: 0, z: 0, isHarvesting: true, harvestTarget: { type: 'gold' } }, 4).made, 3 * 5);
    assert.equal(work({ x: 0, z: 0, isBuilding: true }, 4).made, 3 * 3, 'sawdust where a building goes up');
    assert.equal(work({ x: 0, z: 0, isHarvesting: true, harvestTarget: null }, 4).made, 3 * 2, 'a field or a bush: a leaf or two');
    assert.equal(work({ x: 0, z: 0 }, 4).made, 0, 'idle hands throw up nothing');
    // The chips fly from before the worker, where the tool comes down.
    const P = new F.Particles(8); F.chips(P, 'wood', 3, 0.75, 4); assert.ok(P.p[0] === 3 && P.p[2] === 4);
});

test('the renderer asks once a frame for a unit that is seen whole', () => {
    const r = read('js/engine/gamerenderer.js');
    assert.match(r, /if \(fxP && !inset && !still && !\(u\._fade != null && u\._fade < 1\)\) \{/);
    assert.match(r, /EngineFx\.unitMotion\(fxP, u, ue, \{ moved, tSec, level: fxLevel, theme: this\._theme, world, far, marching \}\);/);
    assert.match(r, /if \(!inset\) this\._marching = onTheMove;/);
});

// Build 1209, found in the first real match: marching dust glowed at night.
test('dust and chips take the hour\'s light; sparks and flames keep their own', () => {
    const scope = { window: {}, console }; scope.window.window = scope.window; vm.createContext(scope);
    for (const f of ['js/simulation/rng.js', 'js/simulation/math.js', 'js/engine/math3d.js', 'js/engine/atmosphere.js', 'js/engine/fx.js']) vm.runInContext(read(f), scope);
    const A = scope.window.EngineAtmosphere, F = scope.window.EngineFx;
    const sun = [1, 0.96, 0.88], sky = [0.62, 0.78, 0.92], rest = [0.45, 0.72, 0.53].map(v => v / Math.hypot(0.45, 0.72, 0.53));
    const noon = A.lighting(0, sun, sky, 'summer', 1);
    const at = seconds => { const d = A.sunDirection(rest, A.sunPhase(seconds, 'summer')), L = A.lighting(seconds, sun, sky, 'summer', rest[1] / d[1]); return { night: L.night, light: F.flatLight(L, d[1], noon, rest[1]) }; };
    assert.ok(at(0).light.every(v => Math.abs(v - 1) < 1e-6), 'at noon dust is the colour it was given');
    const dark = [260, 300, 360, 420].map(at);
    assert.ok(dark.every(d => d.night === 1));
    for (const d of dark) {
        assert.ok(d.light[0] > 0.25 && d.light[0] < 0.5, 'at night less than half the red: ' + d.light[0]);
        assert.ok(d.light[2] > d.light[1] && d.light[1] > d.light[0], 'and bluer, as the ground is');
    }
    // Never brighter than a little over noon, never black, at any hour of the day.
    for (let s = 0; s < 720; s += 10) assert.ok(at(s).light.every(v => v > 0.2 && v <= 1.1), 'hour ' + s);
    // It fills the list it is given: nothing is made anew each picture.
    const keep = [0, 0, 0], d = A.sunDirection(rest, A.sunPhase(300, 'summer'));
    assert.equal(F.flatLight(A.lighting(300, sun, sky, 'summer', rest[1] / d[1]), d[1], noon, rest[1], keep), keep);
    assert.ok(keep[0] > 0 && keep[0] < 0.5);

    // The list that is laid over wears it as its tint; the list that is added as light does not.
    const quad = { quad: true }, fm = { multiply: (a, b) => [a, b], translation: (...a) => a, scaling: (...a) => a };
    const night = [0.36, 0.45, 0.68], r = { gl: {}, tex: { mote: {} }, _identity: 'one', _flatLight: night };
    const { F: G } = fx(true), P = new G.Particles(8);
    P.emit({ x: 0, y: 1, z: 0, life: 1 }); P.emit({ x: 0, y: 1, z: 0, life: 1, additive: true }); P.update(0.1);
    const [over, glow] = P.entries(r, quad, fm, 'bb');
    assert.equal(over.tint, night); assert.equal(glow.tint, null);
    r._flatLight = null; assert.equal(P.entries(r, quad, fm, 'bb')[0].tint, null, 'a renderer that has not solved the light yet draws them as they are');
    const old = fx(false), Q = new old.F.Particles(8);
    Q.emit({ x: 0, y: 1, z: 0, life: 1, tint: [0.5, 0.5, 0.5] }); Q.emit({ x: 0, y: 1, z: 0, life: 1, additive: true, tint: [0.5, 0.5, 0.5] }); Q.update(0.1);
    const each = Q.entries({ gl: {}, tex: { mote: {} }, _flatLight: night }, quad, fm, 'bb');
    assert.ok(Math.abs(each[0].tint[0] - 0.18) < 1e-6 && Math.abs(each[0].tint[2] - 0.34) < 1e-6 && each[1].tint[0] === 0.5);
    const src = read('js/engine/gamerenderer.js');
    assert.match(src, /this\._flatLight = EngineFx\.flatLight\(atmosphere, this\.sunDir\[1\], this\._noonLight\.light, rest\[1\], this\._flatLight \|\| \[1, 1, 1\]\);/);
});
