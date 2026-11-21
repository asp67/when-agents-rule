// The second camera (overhaul step B3): js/second-camera.js picks the fight the main
// picture is not showing, and the renderer draws it as a second picture of the same frame.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const SecondCamera = require(path.join(root, 'js/second-camera.js'));

const fight = (key, onMain, o = {}) => Object.assign({ key, x: 100, z: 50, half: 20, seats: ['a', 'b'], onMain }, o);
const keyOf = c => c && c.key;

test('the picture opens on a fight that has gone unseen for a moment, and never on one the main picture shows', () => {
    const cam = new SecondCamera(), A = SecondCamera.APPEAR_MS;
    assert.equal(cam.update(0, [fight('f1', true)]), null);
    assert.equal(cam.update(5000, [fight('f1', true)]), null, 'shown in the main picture: nothing to add');
    assert.equal(cam.update(6000, [fight('f1', true), fight('f2', false)]), null, 'unseen, but only just');
    assert.equal(cam.update(6000 + A - 1, [fight('f1', true), fight('f2', false)]), null);
    assert.equal(keyOf(cam.update(6000 + A, [fight('f1', true), fight('f2', false)])), 'f2');
    // Nothing is fought: nothing opens, and a wait does not carry over a gap.
    const idle = new SecondCamera();
    assert.equal(idle.update(0, [fight('f2', false)]), null);
    assert.equal(idle.update(600, []), null);
    assert.equal(idle.update(A + 100, [fight('f2', false)]), null, 'the wait starts again');
    assert.equal(keyOf(idle.update(2 * A + 100, [fight('f2', false)])), 'f2');
    // Two unseen fights trading places in the ranking still open the picture: each waits on its own.
    const two = new SecondCamera();
    two.update(0, [fight('f2', false), fight('f3', false)]);
    two.update(A / 2, [fight('f3', false), fight('f2', false)]);
    assert.equal(keyOf(two.update(A, [fight('f3', false), fight('f2', false)])), 'f3', 'the better of those that have waited');
});

test('it stays on its fight while that is fought, lingers when it ends, and steps back when the main picture goes there', () => {
    const C = SecondCamera, open = () => { const c = new SecondCamera(); c.update(0, [fight('f2', false)]); c.update(C.APPEAR_MS, [fight('f2', false)]); return c; };
    const t0 = C.APPEAR_MS;
    // A better fight elsewhere does not pull it away; where the fight moves, it follows.
    let cam = open();
    const cur = cam.update(t0 + 1000, [fight('f9', false), fight('f2', false, { x: 140, half: 30, seats: ['a', 'b', 'c'] })]);
    assert.deepEqual([cur.key, cur.x, cur.half, cur.seats.join()], ['f2', 140, 30, 'a,b,c']);
    // The fight ends: the ground is shown a little longer, then the picture closes.
    assert.equal(keyOf(cam.update(t0 + 1000 + C.LINGER_MS - 1, [])), 'f2');
    assert.equal(cam.update(t0 + 1000 + C.LINGER_MS, []), null);
    // The main picture cuts to the same fight: the second one has nothing to add, and goes sooner.
    cam = open();
    assert.ok(C.TAKEN_MS < C.LINGER_MS);
    assert.equal(keyOf(cam.update(t0 + C.TAKEN_MS - 1, [fight('f2', true)])), 'f2');
    assert.equal(cam.update(t0 + C.TAKEN_MS, [fight('f2', true)]), null);
    // A flicker at the frame's edge inside that time changes nothing.
    cam = open();
    cam.update(t0 + 200, [fight('f2', true)]);
    assert.equal(keyOf(cam.update(t0 + 400, [fight('f2', false)])), 'f2');
    assert.equal(keyOf(cam.update(t0 + 400 + C.TAKEN_MS + 50, [fight('f2', false)])), 'f2');
    // Once closed, the next unseen fight waits its turn like the first did.
    cam = open();
    cam.update(t0 + C.LINGER_MS, [fight('f9', false)]);
    assert.equal(cam.cur, null);
    assert.equal(keyOf(cam.update(t0 + C.LINGER_MS + C.APPEAR_MS, [fight('f9', false)])), 'f9');
});

test('the camera opens on the fight and glides after it; its frame fits the small picture', () => {
    const cam = new SecondCamera();
    assert.equal(cam.view(0), null);
    cam.update(0, [fight('f2', false)]); cam.update(SecondCamera.APPEAR_MS, [fight('f2', false)]);
    const first = cam.view(1000);
    assert.deepEqual([first.x, first.z, first.halfH], [100, 50, 20], 'no glide in from somewhere else');
    cam.update(5000, [fight('f2', false, { x: 130, half: 30 })]);
    const a = cam.view(1016).x, b = cam.view(1032).x;
    assert.ok(a > 100 && a < 103 && b > a, 'a small step a frame: ' + a + ', ' + b);
    for (let t = 1048; t < 4000; t += 16) cam.view(t);
    const late = cam.view(4000);
    assert.ok(Math.abs(late.x - 130) < 0.1 && Math.abs(late.halfH - 30) < 0.1, 'and it arrives');
    // A long gap between two frames (a hidden tab) is one step, not a jump past the fight.
    cam.update(6000, [fight('f2', false, { x: 160, half: 30 })]);
    assert.ok(cam.view(60000).x < 160);
    // The next fight gets its own opening frame.
    cam.update(6000 + SecondCamera.LINGER_MS + 1, []);
    assert.equal(cam.view(70000), null);
    assert.deepEqual([0, 4, 10, 100].map(SecondCamera.halfFor), [11, 12.2, 20, 40]);
});

// ---- the renderer --------------------------------------------------------------------
function renderer() {
    let now = 100;
    const frames = [], log = [];
    const gl = new Proxy({}, { get: (t, k) => typeof k === 'string' && /^[A-Z][A-Z0-9_]*$/.test(k) ? k
        : (...a) => { if (['viewport', 'scissor', 'enable', 'disable', 'clear'].includes(k)) log.push(k + '(' + a.join(',') + ')'); } });
    const context = vm.createContext({ console, Math, Float32Array, Uint8Array, WeakMap, Map, Set,
        document: { addEventListener() {}, createElement: () => ({ getContext: () => ({}) }) },
        TexGen: { TERRAIN_SEED: 1, TERRAIN_WORLD: 1000, TERRAIN_LAND: 400 },
        performance: { now: () => now }, requestAnimationFrame: fn => frames.push(fn) });
    context.window = context;
    context.GLCore = { drawMesh() {} };
    vm.runInContext(read('js/engine/math3d.js'), context);
    vm.runInContext(read('js/engine/atmosphere.js'), context);
    vm.runInContext(read('js/engine/gamerenderer.js'), context);
    const r = Object.create(context.EngineRenderer.prototype);
    Object.assign(r, { gl, prog: { uniforms: {} }, tex: { white: {} }, canvas: { id: 'main' }, W: 1200, H: 600, PW: 1800, PH: 900,
        _halfH: 34, _yaw: 0.1, _pitch: 0.5, _lookY: 0, _lastTime: 80, terrain: { size: 800 },
        cameraTarget: { x: 10, y: 0, z: 20, set(x, y, z) { Object.assign(this, { x, y, z }); } },
        _daySky: [0.42, 0.60, 0.79], _daySun: [0.96, 0.84, 0.66], sunDir: [0, 1, 0], WHITE: [1, 1, 1],
        _dl: { opaque: [], blended: [], bars: [] }, updateCamera() {}, _syncFog() {}, units: [], buildings: [] });
    return { r, gl, log, context, frame: () => { now += 16; r.renderFrame(); }, now: () => now };
}
const copyInto = (w, h) => { const copies = []; return { copies, canvas: { width: w, height: h, getContext: () => ({ drawImage: (...a) => copies.push(a) }) } }; };

test('a frame with a second view draws that first, copies it out, and leaves the main picture as it was', () => {
    const { r, log, frame } = renderer(), runs = [];
    r._assembleFrame = function () { runs.push({ inset: !!this._insetPass, x: this.cameraTarget.x, z: this.cameraTarget.z, halfH: this._halfH, yaw: this._yaw, pitch: this._pitch,
        aspect: this._aspect(), ownList: this._dl !== mainList, at: log.length }); };
    const mainList = r._dl, out = copyInto(480, 270);
    let asked = 0;
    r.secondView = () => { asked++; return { x: -300, z: 250, halfH: 18, yaw: Math.PI / 4, pitch: 0.44, canvas: out.canvas }; };
    frame();
    assert.equal(asked, 1);
    assert.deepEqual(runs.map(x => [x.inset, x.x, x.z, x.halfH, x.yaw, x.pitch, x.aspect, x.ownList]),
        [[true, -300, 250, 18, Math.PI / 4, 0.44, 480 / 270, true], [false, 10, 20, 34, 0.1, 0.5, 2, false]]);
    // The second picture: a corner of the frame, clipped so its clear takes nothing else; copied
    // from that corner (counted from the top in a canvas) before the main picture is drawn over it.
    const drawn = log.filter(l => /^(viewport|scissor|clear|enable\(SCISSOR|disable\(SCISSOR)/.test(l));
    assert.deepEqual(drawn, ['viewport(0,0,480,270)', 'enable(SCISSOR_TEST)', 'scissor(0,0,480,270)', 'clear(0)', 'disable(SCISSOR_TEST)',
        'viewport(0,0,1800,900)', 'clear(0)']);
    assert.equal(out.copies.length, 1);
    assert.deepEqual(out.copies[0].slice(1), [0, 900 - 270, 480, 270, 0, 0, 480, 270]);
    assert.equal(out.copies[0][0], r.canvas);
    // Afterwards everything that reads the camera reads the main one.
    assert.deepEqual([r.cameraTarget.x, r.cameraTarget.z, r._halfH, r._yaw, r._pitch, r._dl === mainList, r._insetPass, r._aspect()], [10, 20, 34, 0.1, 0.5, true, false, 2]);
    assert.ok(Math.abs(r._cam.halfH - 34) < 1e-9 && Math.abs(r._cam.aspect - 2) < 1e-9);
});

test('no second view, or one that cannot be drawn, is one picture; a failure in it does not take the camera', () => {
    const one = renderer(); let runs = 0;
    one.r._assembleFrame = function () { runs++; assert.equal(!!this._insetPass, false); };
    one.frame();
    one.r.secondView = () => null;
    one.frame();
    assert.equal(runs, 2);
    assert.equal(one.log.filter(l => l.startsWith('scissor')).length, 0);
    // A canvas with no size yet, or larger than the frame it is cut from.
    for (const [w, h] of [[0, 0], [2000, 270], [480, 1000]]) {
        const out = copyInto(w, h); runs = 0;
        one.r.secondView = () => ({ x: 0, z: 0, halfH: 18, yaw: 0, pitch: 0.44, canvas: out.canvas });
        one.frame();
        assert.deepEqual([runs, out.copies.length], [1, 0], w + 'x' + h);
    }
    const bad = renderer(), out = copyInto(480, 270);
    bad.r._assembleFrame = function () { if (this._insetPass) throw new Error('second picture failed'); };
    bad.r.secondView = () => ({ x: -300, z: 250, halfH: 18, yaw: 1, pitch: 0.44, canvas: out.canvas });
    const list = bad.r._dl;
    assert.throws(() => bad.frame(), /second picture failed/);
    assert.deepEqual([bad.r.cameraTarget.x, bad.r.cameraTarget.z, bad.r._halfH, bad.r._yaw, bad.r._pitch, bad.r._dl === list, bad.r._insetPass, bad.r._aspect()], [10, 20, 34, 0.1, 0.5, true, false, 2]);
});

test('with two pictures in a frame nothing in the world moves twice', () => {
    const { r, context, frame, now } = renderer();
    // Enough of a renderer for the real list builder: one unit turning toward its target, one
    // falling ghost, one damage ping.
    context.EngineUnits = { pose: () => ({ mats: {}, bob: 0 }), META: { infantry: { barY: 2 } } };
    const enemy = { x: 110, z: 100, health: 5, maxHealth: 5 };
    const unit = { x: 100, z: 100, health: 5, maxHealth: 5, isAttacking: true, attackTarget: enemy, _engine: { type: 'infantry', entries: [], phase: 0 } };
    const setup = () => {
        Object.assign(r, { units: [unit], buildings: [], graphicsQuality: 'balanced', visualStyle: 'classic', _unitDir: new WeakMap(), _unitPrev: new WeakMap(),
            _ghosts: [{ t: 0, dur: 10, kind: 'unit', px: 0, pz: 0, entries: [] }], _dustPool: [], _projectiles: [], _rubble: [],
            _rings: [{ active: true, t: 0, dur: 10, x: 0, z: 0 }], _buf: (kind, args) => ({ kind, args }), _cull: () => false, _refreshIdentity() {}, _frameNo: 0,
            _lastTime: now() });                 // every frame below is 16 ms long
        delete unit._engine.frameNo;
    };
    let marksAsked = 0;
    r.intentMarks = () => { marksAsked++; return null; };
    const state = () => [r._unitDir.get(unit), r._ghosts[0].t, r._rings[0].t];
    setup(); frame();
    const single = state(), askedOnce = marksAsked;
    assert.ok(single[0] > 0 && single[1] > 0 && single[2] > 0, 'one picture moves them: ' + single);
    setup(); marksAsked = 0;
    const out = copyInto(480, 270);
    r.secondView = () => ({ x: 100, z: 100, halfH: 18, yaw: 0.1, pitch: 0.5, canvas: out.canvas });
    frame();
    assert.deepEqual(state().map(v => +v.toFixed(9)), single.map(v => +v.toFixed(9)), 'two pictures move them just as far');
    assert.deepEqual([out.copies.length, marksAsked, askedOnce], [1, 1, 1], 'and the orders are asked for once, for the main picture');
    // A unit only the second picture shows still turns: it is reached there first, with the frame's time.
    setup();
    r._cull = function () { return !this._insetPass; };
    frame();
    assert.ok(Math.abs(r._unitDir.get(unit) - single[0]) < 1e-9);
});

// ---- the page ------------------------------------------------------------------------
function page(saved = {}) {
    const els = {}, store = { saved: JSON.stringify(saved) }, cls = new Set();
    const el = id => (els[id] = { id, style: { display: 'none' }, innerHTML: '', width: 300, height: 150, _attrs: {},
        classList: { toggle: (c, v) => { v ? cls.add(id + '.' + c) : cls.delete(id + '.' + c); } }, setAttribute(k, v) { this._attrs[k] = v; },
        getBoundingClientRect: () => ({ width: 390, height: 219.4 }) });
    ['secondCam', 'secondCamCanvas', 'secondCamHead', 'secondCamBtn'].forEach(el);
    const context = vm.createContext({ console, Date, Math, Map, Set, t: k => k,
        localStorage: { getItem: k => (k === 'warViewPreferencesV1' ? store.saved : null), setItem: (k, v) => { if (k === 'warViewPreferencesV1') store.saved = v; } },
        document: { getElementById: id => els[id] || null, body: { classList: { contains: () => false, toggle() {} } } } });
    for (const f of ['js/ui.js', 'js/second-camera.js']) vm.runInContext(read(f) + '\nthis.UI = UIManager;', context);
    const u = Object.create(context.UI.prototype);
    u.escapeHtml = s => String(s); u.chronicleSeatHtml = id => '[' + id + ']';
    const mk = (id, x, z) => ({ health: 5, owner: id, x, z });
    const enc = (...p) => ({ participants: new Set(p) });
    const fights = [
        { key: 'e1', active: true, score: 150, x: 0, z: 0, r: 4, encounter: enc(mk('a', 0, 0), mk('b', 1, 0)) },
        { key: 'e2', active: true, score: 140, x: 500, z: 500, r: 10, encounter: enc(mk('b', 500, 500), mk('c', 501, 500), mk('wild', 502, 500), Object.assign(mk('a', 0, 0), { health: 0 })) },
        { key: 'e3', active: false, imminent: true, score: 999, x: 900, z: 900, r: 4, encounter: enc() }];
    let scans = 0;
    const r = { graphicsQuality: 'cinematic', renderScale: 2, replayMode: false, poseSource: null, _halfH: 30, canvas: { clientWidth: 1000, clientHeight: 500 },
        // The main picture looks at the origin: 10 world units to 100 px.
        worldToScreen: (x, y, z) => ({ x: 500 + x * 10, y: 250 + z * 10 }) };
    u.game = { spectatorMode: true, gameStarted: true, _actionCam: true, renderer: r, aiManager: { aiPlayers: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] },
        _director: { fights: () => fights, scanThreats: () => { scans++; } } };
    return { u, els, cls, r, fights, store, scans: () => scans };
}

test('the page reads the fights from the director: who is in each, and whether the main picture shows it', () => {
    const { u, r, fights, scans } = page({ second: true });
    const list = () => JSON.parse(JSON.stringify(u.secondFights(1000, null)));
    // Being fought now, best first; an approach that has not struck yet is not a fight to show.
    assert.deepEqual(list(), [
        { key: 'e1', x: 0, z: 0, half: 12.2, seats: ['a', 'b'], onMain: true },
        { key: 'e2', x: 500, z: 500, half: 20, seats: ['b', 'c'], onMain: false }]);   // seats: alive, and a seat of the match
    assert.equal(scans(), 0, 'the director keeps its own fights while it drives the camera');
    u.game._actionCam = false;
    list();
    assert.equal(scans(), 1, 'with the action camera off, the list is brought up to date here');
    // In the frame but from too far up to be seen as a fight: not shown by the main picture.
    r._halfH = u.game.renderer._halfH = 400;
    assert.equal(list()[0].onMain, false);
    r._halfH = 30;
    // At the frame's edge neither flips: the fight on the second picture must come well inside to count
    // as shown, any other well outside to count as unseen.
    fights[0].x = 47;                                   // 970 px of 1000: inside, within 8 % of the edge
    assert.deepEqual([u.secondFights(1000, null)[0].onMain, u.secondFights(1000, 'e1')[0].onMain], [true, false]);
    fights[0].x = 53;                                   // 1030 px: outside, within 5 % of the edge
    assert.deepEqual([u.secondFights(1000, null)[0].onMain, u.secondFights(1000, 'e1')[0].onMain], [true, false]);
    fights[0].x = 60;
    assert.equal(u.secondFights(1000, null)[0].onMain, false);
    u.game._director = null;
    assert.deepEqual(Array.from(u.secondFights(1000, null)), []);
});

test('the picture shows only when asked for, on High, over a live match; and the renderer is told where it stands', () => {
    const { u, els } = page({ second: true });
    assert.equal(u.secondOn(), true);
    assert.equal(u.updateSecondCam(0), null);
    assert.equal(u.secondViewPose(0), null, 'nothing is drawn before a fight has waited its moment');
    const cur = u.updateSecondCam(SecondCamera.APPEAR_MS);
    assert.equal(cur.key, 'e2');
    assert.equal(els.secondCam.style.display, '');
    assert.equal(els.secondCamHead.innerHTML, '<b>second.title</b><span>[b] <i>·</i> [c]</span>');
    // Drawn at the size it is shown, times the main picture's scale, to a limit.
    assert.deepEqual([els.secondCamCanvas.width, els.secondCamCanvas.height], [585, 329]);
    const pose = u.secondViewPose(1000);
    assert.deepEqual([pose.x, pose.z, pose.halfH, pose.yaw, pose.pitch, pose.canvas === els.secondCamCanvas], [500, 500, 20, Math.PI / 4, 0.44, true]);
    // Each of these takes it away at once, and a fight then waits again.
    const offs = { 'not High': p => { p.r.graphicsQuality = 'balanced'; }, 'a recording': p => { p.r.replayMode = true; }, 'a replay': p => { p.r.poseSource = () => null; },
        'no match': p => { p.u.game.gameStarted = false; }, 'switched off': p => { p.u.viewPreferences().second = false; } };
    for (const why in offs) {
        const p = page({ second: true });
        p.u.updateSecondCam(0); p.u.updateSecondCam(SecondCamera.APPEAR_MS);
        assert.equal(p.els.secondCam.style.display, '', why);
        offs[why](p);
        assert.equal(p.u.updateSecondCam(SecondCamera.APPEAR_MS + 250), null, why);
        assert.deepEqual([p.els.secondCam.style.display, p.u.secondViewPose(2000), p.u._second.cur], ['none', null, null], why);
        offs[why] = null;
    }
});

test('off until asked for: a button, a key and an icon on the board, in four languages', () => {
    const { u, cls, els, store } = page({});
    assert.equal(u.secondOn(), false);
    u.updateSecondCam(0); u.updateSecondCam(5000);
    assert.equal(els.secondCam.style.display, 'none', 'a fight is unseen, and still nothing turns up by itself');
    u.toggleSecondCam();
    assert.deepEqual([u.secondOn(), cls.has('secondCamBtn.sb-on'), els.secondCamBtn._attrs['aria-pressed'], JSON.parse(store.saved).second], [true, true, 'true', true]);
    u.toggleSecondCam();
    assert.deepEqual([u.secondOn(), cls.has('secondCamBtn.sb-on'), JSON.parse(store.saved).second], [false, false, false]);

    const ui = read('js/ui.js'), html = read('index.html'), keys = read('js/eval/bench-view.js'), css = read('css/styles.css');
    assert.match(ui, /second: saved\.second === true/);
    assert.match(ui, /this\.game\.renderer\.secondView = now => this\.secondViewPose\(now\);/);
    assert.match(ui, /setInterval\(\(\) => \{ if \(!document\.hidden\) this\.updateSecondCam\(\); \}, 250\)/);
    assert.match(ui, /this\.game\.renderer\.secondView = null;/);
    assert.match(ui, /icon\('broadcastSecond'[^\n]+toggleSecondCam\(\)/);
    assert.match(ui, /on\('broadcastSecond', !!this\.secondOn && this\.secondOn\(\)\);/);
    assert.match(keys, /if \(key === 'i'\) \{ if \(!this\.toggleSecondCam\) return; e\.preventDefault\(\); this\.toggleSecondCam\(\); return; \}/);
    assert.match(html, /id="secondCamBtn" onclick="game\.ui\.toggleSecondCam\(\)" aria-pressed="false" data-i18n="spec\.second" data-i18n-title="spec\.secondTitle"/);
    assert.match(html, /<div id="secondCam" class="second-cam" style="display:none;"><div class="second-head" id="secondCamHead"><\/div><canvas id="secondCamCanvas"><\/canvas><\/div>/);
    assert.match(css, /\.second-cam canvas \{[^}]*aspect-ratio: 16 \/ 9/);
    const context = vm.createContext({ window: {}, navigator: { language: 'en' }, localStorage: { getItem: () => null, setItem() {} },
        document: { documentElement: {}, querySelectorAll: () => [], addEventListener() {} } });
    vm.runInContext(read('js/i18n.js') + ';this.I = I18N;', context);
    for (const lang of ['en', 'de', 'es', 'zh']) for (const k of ['spec.second', 'spec.secondTitle', 'second.title']) {
        assert.ok(k in context.I[lang], lang + ' lacks ' + k);
        if (k === 'spec.secondTitle') assert.match(context.I[lang][k], /\(I\)|（I）/, lang + ' names the key');
    }
});
