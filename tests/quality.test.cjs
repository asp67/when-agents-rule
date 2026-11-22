// Graphics quality that sticks and adapts (overhaul step F2): the governor's decisions
// (js/engine/perf.js) and what the renderer does with a choice (js/engine/gamerenderer.js).
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const root = path.join(__dirname, '..');
const EnginePerf = require(path.join(root, 'js/engine/perf.js'));

// Feed the governor frames `gap` ms apart for `ms` of match time; collect what it decides.
function play(g, clock, gap, ms) {
    const out = [];
    for (const end = clock.t + ms; clock.t < end; clock.t += gap) {
        const act = g.frame(gap, clock.t);
        if (act) out.push([act.why, Math.round(clock.t / 1000)]);
    }
    return out;
}
// A machine in three numbers: what the page spends on a High frame, what the graphics
// card spends on it at full resolution, and how much lighter the other tiers are. The
// picture is as slow as the frame is expensive, but never faster than a 60 Hz display.
function machine(page, gpu, lighter = [1, 0.4, 0.2]) {
    const m = { page, gpu, known: false };
    m.cost = g => ({ build: m.page * (0.6 + 0.4 * lighter[g.tierIndex]), gpu: m.gpu * g.scale * g.scale * lighter[g.tierIndex] });
    m.run = (g, clock, ms) => {
        const out = [];
        for (const end = clock.t + ms; clock.t < end;) {
            const c = m.cost(g), gap = Math.max(16.7, c.build + c.gpu);
            const act = g.frame(gap, clock.t);
            if (act) out.push(act.why);
            clock.t += gap;
        }
        return out;
    };
    return m;
}

test('a machine that holds 60 a second is left alone', () => {
    const g = new EnginePerf.Governor(), clock = { t: 1000 };
    assert.deepEqual(play(g, clock, 16.7, 120000), []);
    assert.deepEqual([g.scale, g.tier], [1, 'cinematic']);
});

test('a graphics card that is a little too slow loses one step of resolution and nothing else', () => {
    const g = new EnginePerf.Governor(), clock = { t: 1000 }, m = machine(3, 24);
    assert.deepEqual(m.run(g, clock, 120000), ['slow: resolution down']);   // 27 ms a frame, then 20
    assert.deepEqual([g.scale, g.tier], [0.85, 'cinematic']);
});

test('one step is all the resolution a tier gives up: then a lighter tier, sharp again', () => {
    const g = new EnginePerf.Governor(), clock = { t: 1000 }, m = machine(4, 110);
    const whys = m.run(g, clock, 240000);
    assert.deepEqual(whys, ['slow: resolution down', 'slow: tier down', 'slow: resolution down', 'slow: tier down',
        'slow: resolution down']);
    // Low is the last tier, so it is the only one that would go on to 0.7 and 0.6.
    assert.deepEqual([g.scale, g.tier], [0.85, 'low']);
    const weaker = new EnginePerf.Governor(), w = machine(4, 260);
    w.run(weaker, { t: 1000 }, 240000);
    assert.deepEqual([weaker.scale, weaker.tier], [0.6, 'low']);
});

test('the tier waits for nine slow seconds; resolution moves after three', () => {
    const g = new EnginePerf.Governor(), clock = { t: 0 };
    const whys = play(g, clock, 30, 3200).concat(play(new EnginePerf.Governor({ gentle: 0 }), { t: 0 }, 30, 8000));
    assert.deepEqual(whys.map(w => w[0]), ['slow: resolution down']);       // and no tier step inside 8 s
    const patient = new EnginePerf.Governor({ gentle: 0 });
    assert.deepEqual(play(patient, { t: 0 }, 30, 10000).map(w => w[0]), ['slow: tier down']);
});

test('a step that bought nothing is undone, and the lever rests twice as long each time', () => {
    // Slow for a reason no graphics setting reaches, on a browser that reports no GPU time.
    const g = new EnginePerf.Governor(), clock = { t: 0 };
    const first = play(g, clock, 33.3, 30000);
    assert.deepEqual(first.map(w => w[0]), ['slow: resolution down', 'resolution did not help', 'slow: tier down', 'tier did not help']);
    assert.deepEqual([g.scale, g.tier], [1, 'cinematic']);
    const later = play(g, clock, 33.3, 900000);
    const tries = later.filter(w => w[0] === 'slow: tier down').map(w => w[1]);
    assert.equal(tries.length, 3);
    assert.ok(tries[1] - tries[0] > 100 && tries[2] - tries[1] > 200, 'tier attempts at ' + tries.join(', ') + ' s');
    for (const [why] of later) assert.ok(/down|did not help/.test(why), why);
    // Whatever was tried last has been judged and taken back by the end of a quiet stretch.
    play(g, clock, 33.3, 5000);
    assert.equal(g.tier, 'cinematic');
});

test('with GPU time known, a cheap frame on a slow display is never touched', () => {
    // 30 a second because the browser says so (battery saver, remote desktop): 5 ms of work.
    const g = new EnginePerf.Governor({ costOf: () => ({ build: 2, gpu: 3 }) }), clock = { t: 1000 };
    assert.deepEqual(play(g, clock, 33.3, 300000), []);
    assert.deepEqual([g.scale, g.tier], [1, 'cinematic']);
});

test('resolution comes back when the load has gone, and a raise that fails waits longer', () => {
    const g = new EnginePerf.Governor(), clock = { t: 1000 }, m = machine(2, 21);   // 23 ms, or 17 at 0.85
    assert.deepEqual(m.run(g, clock, 10000), ['slow: resolution down']);
    // Still heavy: after 20 smooth seconds it tries full resolution, which does not hold;
    // the next try comes 40 s later, not 20.
    const tries = m.run(g, clock, 100000);
    assert.deepEqual(tries, ['smooth: resolution up', 'raise did not hold', 'smooth: resolution up', 'raise did not hold']);
    assert.equal(g.scale, 0.85);
    m.gpu = 8;                                   // the fight is over
    assert.deepEqual(m.run(g, clock, 200000), ['smooth: resolution up']);
    assert.equal(g.scale, 1);
});

test('with GPU time known, a raise the numbers rule out is not tried', () => {
    const m = machine(2, 21), g = new EnginePerf.Governor({ costOf: () => m.cost(g) }), clock = { t: 1000 };
    m.run(g, clock, 10000);
    assert.equal(g.scale, 0.85);
    assert.deepEqual(m.run(g, clock, 300000), []);   // 2 + 21 ms at full size: no point asking
    m.gpu = 8;
    assert.deepEqual(m.run(g, clock, 60000), ['smooth: resolution up']);
});

test('what Auto found is where it starts next time', () => {
    const g = new EnginePerf.Governor({ tier: 'balanced', level: 2 });
    assert.deepEqual([g.tier, g.scale], ['balanced', 0.7]);
    g.reset('cinematic', 0);
    assert.deepEqual([g.tier, g.scale], ['cinematic', 1]);
    const odd = new EnginePerf.Governor({ tier: 'nonsense', level: 99 });
    assert.deepEqual([odd.tier, odd.scale], ['cinematic', 0.6]);
});

// ---- the renderer -------------------------------------------------------------------
function context(ratio = 1) {
    const store = new Map();
    const scope = { console, window: { devicePixelRatio: ratio },
        localStorage: { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) },
        TexGen: { TERRAIN_WORLD: 1000, TERRAIN_LAND: 417, TERRAIN_SEED: 12345 },
        document: { createElement: () => ({ getContext: () => ({}) }) } };
    vm.createContext(scope);
    for (const f of ['simulation/rng', 'simulation/math', 'simulation/island', 'engine/math3d', 'engine/mesh', 'engine/texgen', 'engine/atmosphere',
        'engine/units', 'engine/buildings', 'engine/perf', 'engine/gamerenderer']) {
        vm.runInContext(fs.readFileSync(path.join(root, 'js', f + '.js'), 'utf8'), scope);
        Object.assign(scope, scope.window);
    }
    scope.store = store;
    return scope;
}
function renderer(s, over) {
    let id = 0;
    const gl = new Proxy({}, { get: (t, k) => k === 'checkFramebufferStatus' ? () => 1 : k === 'FRAMEBUFFER_COMPLETE' ? 1
        : /^create/.test(String(k)) ? () => ({ id: ++id }) : () => null });
    const r = Object.create(s.EngineRenderer.prototype);
    Object.assign(r, { gl, canvas: { width: 0, height: 0, style: {} }, W: 1000, H: 500, qualityChoice: 'auto',
        perf: new s.EnginePerf.Meter(null), _governor: new s.EnginePerf.Governor() }, over);
    return r;
}

test('the drawing buffer follows the display up to what the tier allows', () => {
    const size = (ratio, tier) => { const s = context(ratio), r = renderer(s, { qualityChoice: tier }); r.setGraphicsQuality(tier); return [r.canvas.width, r.canvas.height, r.renderScale]; };
    assert.deepEqual(size(1, 'cinematic'), [1000, 500, 1]);     // an ordinary display: as before
    assert.deepEqual(size(1, 'low'), [1000, 500, 1]);
    assert.deepEqual(size(2, 'cinematic'), [2000, 1000, 2]);
    assert.deepEqual(size(2, 'balanced'), [1500, 750, 1.5]);
    assert.deepEqual(size(2, 'low'), [1000, 500, 1]);           // Low draws what every tier drew before
    assert.deepEqual(size(1.25, 'balanced'), [1250, 625, 1.25]);
    assert.deepEqual(size(3, 'cinematic'), [2000, 1000, 2]);
});

test('the element keeps its size on the page whatever the buffer holds', () => {
    const s = context(2), r = renderer(s, { qualityChoice: 'cinematic' });
    r.setGraphicsQuality('cinematic');
    assert.deepEqual([r.canvas.style.width, r.canvas.style.height], ['1000px', '500px']);
    assert.equal(r._aspect(), 2);
    r.pinRenderSize(1920, 1080);
    assert.deepEqual([r.canvas.width, r.canvas.height, r.PW, r.PH], [1920, 1080, 1920, 1080]);
    assert.equal(r._aspect(), 16 / 9);
    assert.equal(r.canvas.style.width, '1000px');
    r.pinRenderSize(0, 0);
    assert.deepEqual([r.canvas.width, r.canvas.height], [2000, 1000]);
});

test('a picked tier is remembered and stays as picked; Auto measures afresh', () => {
    const s = context(), r = renderer(s);
    r.setQualityChoice('low');
    assert.deepEqual([r.qualityChoice, r.graphicsQuality, s.store.get('warQuality')], ['low', 'low', 'low']);
    assert.equal(r._shadowTarget, null);
    // A fixed tier ignores the governor: nothing it does reaches the picture.
    r._governor.level = 3; r._sizeCanvas();
    assert.equal(r.renderScale, 1);
    r.game = { gameStarted: true }; r.perf.lastInterval = 40;
    for (let t = 0; t < 20000; t += 40) r._govern(t);
    assert.equal(r.graphicsQuality, 'low');
    s.store.set('warQualityAuto', 'balanced:2');
    r.setQualityChoice('auto');
    assert.deepEqual([r.qualityChoice, r.graphicsQuality, s.store.get('warQuality')], ['auto', 'cinematic', 'auto']);
    assert.equal(s.store.has('warQualityAuto'), false);
    assert.deepEqual([r._governor.level, r._governor.tier], [0, 'cinematic']);
    r.setQualityChoice('ultra');
    assert.equal(r.qualityChoice, 'auto');
});

test('Auto adapts only a picture someone is watching, and remembers what it found', () => {
    const s = context(), r = renderer(s);
    r.setQualityChoice('auto');
    let told = 0;
    r.onQualityChange = () => { told++; };
    const slow = ms => { r.perf.lastInterval = 40; for (let t = r._t || 0, end = t + ms; t < end; t += 40) { r._govern(t); r._t = t + 40; } };
    slow(20000);                                  // the start screen: not a picture
    assert.deepEqual([r.renderScale, r.graphicsQuality, told], [1, 'cinematic', 0]);
    r.game = { gameStarted: true };
    r.pinRenderSize(1920, 1080); slow(20000);     // the benchmark pins the size: hands off
    assert.equal(r._governor.level, 0);
    r.pinRenderSize(0, 0);
    slow(4000);                                   // a match: two slow windows, resolution goes first
    assert.equal(r.renderScale, 0.85);
    assert.deepEqual([r.canvas.width, r.canvas.height], [850, 425]);
    assert.equal(s.store.get('warQualityAuto'), 'cinematic:1');
    assert.equal(told, 1);
    // No GPU time on this fake context, so the step is judged: 40 ms before and after.
    slow(60000);
    assert.equal(r.graphicsQuality, 'cinematic'); // nothing helped, so everything is back
    assert.equal(r.renderScale, 1);
    assert.equal(s.store.get('warQualityAuto'), 'cinematic:0');
    r.game = { gameStarted: false }; r.replayMode = true;
    assert.doesNotThrow(() => slow(2000));        // a replay counts as a picture too
});

test('nothing is drawn while no screen shows the map, and sound keeps its tick', () => {
    const s = context(), r = renderer(s);
    let frames = 0, ticks = 0, asked = 0;
    s.requestAnimationFrame = () => { asked++; };
    r.renderFrame = () => { frames++; };
    r.game = { sound: { update() { ticks++; } } };
    // A stand-in that is not in a page at all: draws, as every test renderer does.
    r.animate(); assert.deepEqual([frames, ticks, asked], [1, 0, 1]);
    // In the page, on a hidden screen: display:none gives no offsetParent.
    r.canvas = { isConnected: true, offsetParent: null, style: {} };
    r.animate(); r.animate(); assert.deepEqual([frames, ticks, asked], [1, 2, 3]);
    r.canvas.offsetParent = {};
    r.animate(); assert.deepEqual([frames, ticks], [2, 2]);
    // The benchmark holds the loop and draws for itself, visible or not.
    r.holdFrames = true; r.animate(); assert.deepEqual([frames, ticks, asked], [2, 2, 5]);
});
