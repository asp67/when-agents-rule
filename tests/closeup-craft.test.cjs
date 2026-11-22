// Overhaul step B5 (build 1212): close-up craft. A soft drift and a slow push-in on close
// shots, the sharp line of the picture on the subject instead of on its middle, and a
// focus pull from one subject to another inside a shot. Cuts stay cuts.
const test = require('node:test'), assert = require('node:assert/strict');
const vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

function setup() {
    const scope = { console, location: { search: '' } };
    vm.createContext(scope);
    vm.runInContext(read('js/director.js'), scope);
    const Director = vm.runInContext('Director', scope), SHOTS = vm.runInContext('DIR_SHOTS', scope);
    const players = ['a', 'b'].map(id => ({ id, units: [], buildings: [], age: 'stone' }));
    const game = { aiManager: { aiPlayers: players }, isPlayerEliminated: () => false, effectiveSimSpeed: () => 1,
        terrain: { size: 800 }, renderer: { _yaw: 0 },
        _resolveCamSubject: s => { if (!s) return null; if (s.kind === 'ent') return s.ent.health > 0 ? s.ent : null; const l = (s.units || []).filter(u => u.health > 0); return l.length ? l[0] : null; },
        _subjectZoom: () => 30 };
    const d = new Director(game);
    d.candidates = () => [];          // nothing competes: the shot under test runs its time
    // A shot begun by hand, with a length the test knows.
    const run = (type, pose, now, ms) => { d.shot = d.begin(type, type + ':a:x', 50, pose, now); d.shot.until = d.shot.planned = now + ms; return d.shot; };
    return { d, game, players, SHOTS, run };
}

test('the shots say what they want: drift and full focus up close, a pull where there are two subjects', () => {
    const { SHOTS } = setup();
    assert.deepEqual([SHOTS.closeup.drift, SHOTS.closeup.focus, SHOTS.closeup.push], [0.07, 1, 0.07]);
    assert.deepEqual([SHOTS.clash.drift, SHOTS.clash.focus, SHOTS.clash.push], [0.05, 1, 0.03]);
    assert.deepEqual([SHOTS.contact.focus, Array.from(SHOTS.contact.pull)], [0.8, [0.25, 0.7]]);
    assert.deepEqual([SHOTS.pov.focus, Array.from(SHOTS.pov.pull)], [0.7, [0.2, 0.6]]);
    // Nothing else drifts, pulls or asks for focus: the economy half stays as still as it was.
    for (const [name, s] of Object.entries(SHOTS)) {
        if (!['closeup', 'clash'].includes(name)) assert.equal(s.drift, undefined, name);
        if (!['closeup', 'clash', 'contact', 'pov'].includes(name)) { assert.equal(s.focus, undefined, name); assert.equal(s.pull, undefined, name); }
        if (s.pull) assert.ok(s.pull[0] >= 0 && s.pull[1] > s.pull[0] && s.pull[1] <= 1, name);
        if (s.drift) assert.ok(s.drift > 0 && s.drift <= 0.1, name + ': a few degrees, no more');
    }
    // The two shots with a second subject carry it in their pose.
    const src = read('js/director.js');
    assert.match(src, /subject: \{ kind: 'ent', ent: b \}, second: threat/);
    assert.match(src, /subject: \{ kind: 'ent', ent: mine \}, second: them/);
});

test('a close shot drifts a few degrees round its subject and tightens, eased over its whole length', () => {
    const { d, run } = setup();
    const u = { owner: 'a', type: 'militia', x: 100, z: 50, health: 40 };
    const now = 500000, ms = 4000;
    run('closeup', { x: 100, z: 50, yaw: 0.6, halfH: 3.6, lookY: 1.0, closeup: true, subject: { kind: 'units', units: [u] } }, now, ms);
    const first = d.update(now);
    assert.equal(first.cut, true); assert.ok(Math.abs(first.yaw - 0.6) < 1e-9, 'the cut lands on the angle it was given');
    assert.ok(Math.abs(first.halfH - 3.6) < 1e-9);
    const yaws = [], halves = [];
    for (let t = 0; t <= ms; t += 250) { const p = d.update(now + t); yaws.push(p.yaw - 0.6); halves.push(p.halfH); assert.equal(t > 0 ? p.cut : false, false); }
    const dir = Math.sign(yaws[yaws.length - 1]);
    assert.ok(dir !== 0 && Math.abs(Math.abs(yaws[yaws.length - 1]) - 0.07) < 1e-9, 'four degrees by the end: ' + yaws[yaws.length - 1]);
    for (let i = 1; i < yaws.length; i++) assert.ok((yaws[i] - yaws[i - 1]) * dir >= -1e-12, 'one way only');
    // Eased: slow at both ends, fastest in the middle.
    const step = i => Math.abs(yaws[i] - yaws[i - 1]);
    assert.ok(step(1) < step(8) && step(yaws.length - 1) < step(8));
    assert.ok(Math.abs(halves[halves.length - 1] - 3.6 * 0.93) < 1e-9 && halves.every((h, i) => !i || h <= halves[i - 1] + 1e-12), 'a slow push in of seven in a hundred');
    // Held on past its time, it has stopped drifting.
    assert.ok(Math.abs(d.update(now + ms + 3000).yaw - 0.6 - dir * 0.07) < 1e-9);
    // The subject walks: the shot follows it, and what is sharp follows too.
    u.x = 104; const p = d.update(now + 2000);
    assert.equal(p.x, 104);
    assert.deepEqual([p.focus.x, p.focus.y, p.focus.z, p.focus.amount], [104, 1.0, 50, 1]);
});

test('a camera that stands still does not drift: it turns to follow, as before', () => {
    const { d, run } = setup();
    const u = { owner: 'a', type: 'worker', x: 100, z: 50, health: 40 };
    run('closeup', { x: 100, z: 50, yaw: 0.6, halfH: 3.6, lookY: 1.0, closeup: true, eye: [110, 4, 60], subject: { kind: 'units', units: [u] } }, 500000, 4000);
    for (let t = 0; t <= 4000; t += 500) { const p = d.update(500000 + t); assert.equal(p.yaw, 0.6); assert.deepEqual(Array.from(p.eye), [110, 4, 60]); }
});

test('a focus pull: the sharp place travels from the first subject to the second while the pull runs, and never across a cut', () => {
    const { d, run, SHOTS } = setup();
    const mine = { owner: 'a', type: 'scout', x: 0, z: 0, health: 30 }, them = { owner: 'b', type: 'militia', x: 40, z: -20, health: 40 };
    const now = 700000, ms = 4000, [from, to] = SHOTS.contact.pull;
    run('contact', { x: 20, z: -10, yaw: 0, halfH: 30, subject: { kind: 'ent', ent: mine }, second: them }, now, ms);
    const at = share => d.update(now + ms * share).focus;
    // On the cut and until the pull begins: the first subject, at the height the shot looks at.
    for (const s of [0, from * 0.5, from]) { const f = at(s); assert.ok(Math.abs(f.x) < 1e-9 && Math.abs(f.z) < 1e-9 && f.y === 1 && f.amount === 0.8, 'still on the scout at ' + s); }
    // Midway through the pull: midway between them. From its end on: the second subject.
    const mid = at((from + to) / 2); assert.ok(Math.abs(mid.x - 20) < 1e-9 && Math.abs(mid.z + 10) < 1e-9);
    for (const s of [to, 0.9, 1, 1.5]) { const f = at(s); assert.ok(Math.abs(f.x - 40) < 1e-9 && Math.abs(f.z + 20) < 1e-9, 'on what it found at ' + s); }
    // One way, and eased.
    let last = -1; for (let s = 0; s <= 1; s += 0.02) { const x = at(s).x; assert.ok(x >= last - 1e-9); last = x; }
    assert.ok(at(from + 0.02).x < 40 * 0.02 / (to - from), 'it starts slowly');
    // Both move: the place follows them.
    mine.x = 10; them.x = 60; assert.ok(Math.abs(at(1).x - 60) < 1e-9); assert.ok(Math.abs(at(0).x - 10) < 1e-9);
    // The second falls: back on the first, where there is still something to look at.
    them.health = 0; assert.ok(Math.abs(at(1).x - 10) < 1e-9);
    // A shot without a second subject, and one that asks for no focus.
    const u = { owner: 'a', type: 'militia', x: 5, z: 5, health: 40 };
    run('follow', { x: 5, z: 5, yaw: 0, halfH: 30, subject: { kind: 'units', units: [u] } }, now, ms);
    assert.equal(d.update(now + 100).focus, null);
    // A new shot begins with its own first subject: nothing of the old pull is carried over.
    them.health = 40;
    const other = { owner: 'a', type: 'scout', x: -200, z: 300, health: 30 };
    run('contact', { x: -200, z: 300, yaw: 0, halfH: 30, subject: { kind: 'ent', ent: other }, second: them }, now + 10000, ms);
    const cut = d.update(now + 10000);
    assert.equal(cut.cut, true); assert.deepEqual([cut.focus.x, cut.focus.z], [-200, 300]);
});

test('the renderer: a shot may ask for more focus than its height gives, and the sharp line travels inside a shot and jumps on a cut', () => {
    const scope = { window: {}, console, performance: { now: () => 1000 } }; scope.window.window = scope.window; vm.createContext(scope);
    for (const f of ['js/simulation/rng.js', 'js/simulation/math.js', 'js/simulation/island.js']) vm.runInContext(read(f), scope);
    for (const f of ['math3d', 'mesh', 'texgen', 'buildings', 'units', 'atmosphere', 'fx']) vm.runInContext(read('js/engine/' + f + '.js'), scope);
    scope.window.GLCore = { createMeshBuffers: (gl, mesh) => ({ mesh }), createShadowBuffers: (gl, mesh) => ({ mesh }), deleteMeshBuffers() {}, drawMesh() {} };
    vm.runInContext('Object.assign(globalThis, window);' + read('js/engine/gamerenderer.js'), scope);
    const R = vm.runInContext('window.EngineRenderer', scope), F = R.FOCUS;
    let y = null;
    const make = extra => Object.assign(Object.create(R.prototype), { tiltShift: true, graphicsQuality: 'cinematic', _halfH: 40, canvas: { clientHeight: 1000 },
        worldToScreen: () => (y == null ? null : { x: 500, y }) }, extra);
    const r = make();
    // How much: by height as before (none from 28 up, all from 14 down); a shot may ask for more, never on another tier or with the switch off.
    assert.equal(r._focusAmount(), 0); r._halfH = 21; assert.equal(r._focusAmount(), 0.5); r._halfH = 40;
    r._shotFocus = { x: 0, y: 1, z: 0, amount: 0.8 }; assert.equal(r._focusAmount(), 0.8);
    r._halfH = 10; assert.equal(r._focusAmount(), 1); r._halfH = 40;
    assert.equal(make({ graphicsQuality: 'balanced', _shotFocus: r._shotFocus })._focusAmount(), 0);
    assert.equal(make({ tiltShift: false, _shotFocus: r._shotFocus })._focusAmount(), 0);
    // Which line: the middle without a shot; the subject's line with one (0 the bottom, 1 the top).
    const plain = make(); assert.equal(plain._focusLine(0.016), F.line);
    y = 300; assert.equal(r._focusLine(0.016), 0.7, 'the first picture is sharp where the shot says');
    // The subject moves down the picture: the line travels there, a share of the way each frame.
    y = 600;
    const a = r._focusLine(0.1); assert.ok(Math.abs(a - (0.7 + (0.4 - 0.7) * 0.1 * F.pullRate)) < 1e-9);
    let last = a; for (let i = 0; i < 40; i++) { const v = r._focusLine(0.1); assert.ok(v <= last + 1e-12 && v >= 0.4 - 1e-9); last = v; }
    assert.ok(Math.abs(last - 0.4) < 1e-3, 'and arrives');
    // A cut: the line is where the new shot says at once.
    y = 350; r._focusCut = true; assert.equal(r._focusLine(0.016), 0.65); assert.equal(r._focusCut, false);
    // Kept away from the picture's edges; a place behind the camera leaves the line in the middle.
    y = 20; r._focusCut = true; assert.equal(r._focusLine(0.016), F.lineMax);
    y = 990; r._focusCut = true; assert.equal(r._focusLine(0.016), F.lineMin);
    y = null; r._focusCut = true; assert.equal(r._focusLine(0.016), F.line);
    assert.ok(F.lineMin > F.band && F.lineMax < 1 - F.band && F.pullRate > 1 && F.pullRate < 6);
    // The shot hands it over, a cut is marked, and a picture without a shot has none.
    const src = read('js/engine/gamerenderer.js');
    assert.match(src, /this\._shotFocus = shot\.focus \|\| null;\s+if \(shot\.cut\) this\._focusCut = true;/);
    assert.match(src, /if \(shot\) this\.applyPose\(shot, deltaTime\);\s+else this\._shotFocus = null;/);
    assert.match(src, /const cam = this\._computeCam\(\);\s+this\._focusNow = this\._focusLine\(deltaTime\);/);
    assert.match(src, /focus: own\.focus > 0 \? \[this\._focusNow == null \? F\.line : this\._focusNow, F\.band, F\.blur \* own\.focus \* own\.sh \/ 1080\] : null/);
    // No rule file and nothing a model sees is touched.
    const manifest = require(path.join(__dirname, '..', 'js/manifest.js'));
    assert.equal(manifest.rules.concat(manifest.harness).some(f => /director|gamerenderer/.test(f)), false);
});
