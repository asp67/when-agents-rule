// The frame-time instrument (overhaul step F1): js/engine/perf.js and js/perf-bench.js.
// What is tested here is the arithmetic and the bookkeeping -- what counts as a frame,
// what counts as a stall, that counting draws leaves the context as it found it. What a
// frame costs on a real GPU is the instrument's output, not something a test can assert.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const root = path.join(__dirname, '..');
const EnginePerf = require(path.join(root, 'js/engine/perf.js'));

const TRIANGLES = 4, STRIP = 5, LINES = 1;
function fakeGL(timer) {
    const calls = [];
    const gl = {
        TRIANGLES, TRIANGLE_STRIP: STRIP, TRIANGLE_FAN: 6, LINES, calls,
        drawElements(mode, count) { calls.push(['drawElements', mode, count]); },
        drawArrays(mode, first, count) { calls.push(['drawArrays', mode, count]); },
        getExtension: name => (timer && name === 'EXT_disjoint_timer_query') ? timer : null,
        getParameter: () => (timer ? timer.disjointNow : false)
    };
    return gl;
}
function fakeTimer() {
    const t = {
        TIME_ELAPSED_EXT: 1, QUERY_RESULT_AVAILABLE_EXT: 2, QUERY_RESULT_EXT: 3, GPU_DISJOINT_EXT: 4,
        disjointNow: false, begun: 0, ended: 0, dropped: 0, next: 0, ns: [],
        createQueryEXT() { return { id: t.next++, done: false }; },
        deleteQueryEXT() { t.dropped++; },
        beginQueryEXT(_, q) { t.begun++; t.open = q; },
        endQueryEXT() { t.ended++; if (t.open) t.open.done = true; t.open = null; },
        getQueryObjectEXT(q, what) { return what === 2 ? q.done : (t.ns[q.id] || 0); }
    };
    return t;
}

test('summary gives the median and the slow tail, and zeros for nothing', () => {
    const s = EnginePerf.summary([10, 30, 20, 40, 50]);
    assert.deepEqual([s.n, s.median, s.max, s.mean], [5, 30, 50, 30]);
    assert.equal(s.p95, 48);                               // between the two slowest
    assert.equal(EnginePerf.summary([7]).p99, 7);
    assert.deepEqual(EnginePerf.summary([]), { n: 0, median: 0, p95: 0, p99: 0, max: 0, mean: 0 });
    assert.equal(EnginePerf.summary([1, NaN, 3]).n, 2);
});

test('the gap between frames is recorded, a tab that was away is a stall and not a slow frame', () => {
    const m = new EnginePerf.Meter(null);
    for (const t of [100, 116, 133, 5000, 5017]) { m.frameBegin(t); m.frameEnd(); }
    const s = m.stats();
    assert.equal(s.frames, 5);
    assert.equal(s.interval.n, 3);                         // 16, 17, 17: the first frame has no gap
    assert.equal(s.stalls, 1);
    assert.equal(s.interval.max, 17);
    assert.equal(Math.round(s.fps), 59);
    assert.equal(m.lastInterval, 17);
    assert.deepEqual(m.recent(2), [17, 17]);
});

test('frames drawn while the page is hidden are not timed', () => {
    const had = Object.getOwnPropertyDescriptor(globalThis, 'document');
    globalThis.document = { hidden: true };
    try {
        const m = new EnginePerf.Meter(null);
        m.frameBegin(0); m.frameEnd(); m.frameBegin(16); m.frameEnd();
        assert.equal(m.stats().interval.n, 0);
        assert.equal(m.lastInterval, 0);
        globalThis.document.hidden = false;
        m.frameBegin(32); m.frameEnd();
        assert.equal(m.stats().interval.n, 1);
    } finally {
        if (had) Object.defineProperty(globalThis, 'document', had); else delete globalThis.document;
    }
});

test('slow frames are counted against 30 a second', () => {
    const m = new EnginePerf.Meter(null);
    let t = 0;
    for (const gap of [0, 16, 16, 40, 16, 60]) { t += gap; m.frameBegin(t); m.frameEnd(); }
    assert.equal(m.stats().slow, 2);
});

test('detail counts draw calls and triangles per frame and gives the context back untouched', () => {
    const gl = fakeGL(), own = gl.drawElements, m = new EnginePerf.Meter(gl);
    m.setDetail(true);
    assert.notEqual(gl.drawElements, own);
    m.frameBegin(0);
    gl.drawElements(TRIANGLES, 300, 0, 0); gl.drawElements(TRIANGLES, 30, 0, 0);
    gl.drawArrays(STRIP, 0, 4); gl.drawArrays(LINES, 0, 8);
    m.frameEnd();
    assert.deepEqual([m.draws, m.tris], [4, 112]);         // 100 + 10 + 2, and lines are no triangles
    assert.equal(gl.calls.length, 4);                      // every call still reached the context
    m.frameBegin(16); gl.drawElements(TRIANGLES, 3, 0, 0); m.frameEnd();
    assert.deepEqual([m.draws, m.tris], [1, 1]);           // per frame, not a running total
    m.setDetail(false);
    assert.equal(gl.drawElements, own);
    // A real context keeps its methods on the prototype: nothing may be left on the object.
    const proto = { TRIANGLES, drawElements() {}, drawArrays() {}, getExtension: () => null };
    const real = Object.create(proto), m2 = new EnginePerf.Meter(real);
    m2.setDetail(true); assert.ok(Object.hasOwn(real, 'drawElements'));
    m2.setDetail(false); assert.ok(!Object.hasOwn(real, 'drawElements') && !Object.hasOwn(real, 'drawArrays'));
});

test('GPU time comes from the timer query, a frame late, and a disjoint reading is dropped', () => {
    const timer = fakeTimer(), gl = fakeGL(timer), m = new EnginePerf.Meter(gl);
    assert.equal(m.stats().gpu, null);
    m.setDetail(true);
    assert.equal(m.gpuSupported, true);
    timer.ns = [4e6, 6e6, 9e6];
    m.frameBegin(0); m.frameEnd();                         // query 0 runs
    m.frameBegin(16); m.frameEnd();                        // query 0 read, query 1 runs
    assert.deepEqual([m.stats().gpu.n, m.stats().gpu.median], [1, 4]);
    timer.disjointNow = true;
    m.frameBegin(32); m.frameEnd();                        // query 1 arrives disjoint: dropped
    assert.equal(m.stats().gpu.n, 1);
    timer.disjointNow = false;
    m.frameBegin(48); m.frameEnd();
    assert.deepEqual([m.stats().gpu.n, m.stats().gpu.max], [2, 9]);
    assert.equal(timer.begun, timer.ended);
});

test('a frame that threw half-way does not leave a query open', () => {
    const timer = fakeTimer(), gl = fakeGL(timer), m = new EnginePerf.Meter(gl);
    m.setDetail(true);
    m.frameBegin(0);                                       // ...and the frame throws: no frameEnd
    m.frameBegin(16); m.frameEnd();
    assert.equal(timer.begun, 2); assert.equal(timer.ended, 2);
    m.setDetail(false);
    assert.equal(m.gpuSupported, false);
});

test('without a timer query the readout says n/a rather than zero', () => {
    const m = new EnginePerf.Meter(fakeGL());
    m.setDetail(true);
    assert.equal(m.gpuSupported, false);
    assert.match(EnginePerf.Overlay.text(m.stats(), ''), /no frames measured yet/);
    for (const t of [0, 16, 33]) { m.frameBegin(t); m.frameEnd(); }
    const text = EnginePerf.Overlay.text(m.stats(), 'High   1920x1080');
    assert.match(text, /GPU n\/a/);
    assert.match(text, /^frame {2}16\.5 ms/);
    assert.match(text, /High {3}1920x1080$/);
});

// ---- the fly-through --------------------------------------------------------------
function bench() {
    const ctx = vm.createContext({ window: { addEventListener() {} }, EnginePerf, URLSearchParams, console });
    return vm.runInContext(fs.readFileSync(path.join(root, 'js/perf-bench.js'), 'utf8') + '\n;WarPerfBench', ctx);
}

test('the benchmark scene is a match that ships', () => {
    const B = bench(), index = JSON.parse(fs.readFileSync(path.join(root, 'samples/index.json'), 'utf8'));
    const list = Array.isArray(index) ? index : index.matches;
    assert.ok(list.some(m => m.file === B.SCENE.file), B.SCENE.file + ' is not in samples/index.json');
    assert.ok(fs.existsSync(path.join(root, 'samples', B.SCENE.file)));
});

test('the path is five shots between the two largest towns, the same every time', () => {
    const B = bench();
    const renderer = { wholeMapHalf: () => 400, buildings: [
        { owner: 'a', x: 100, z: 100 }, { owner: 'a', x: 120, z: 100 }, { owner: 'a', x: 110, z: 130 },
        { owner: 'b', x: -200, z: -200 }, { owner: 'b', x: -220, z: -200 }, { owner: 'c', x: 0, z: 300 }] };
    const legs = B.legs(renderer);
    // Arrays made inside the vm are another realm's: compare them by value.
    assert.deepEqual(Array.from(legs, l => l.id), ['overview', 'town', 'close-up', 'crossing', 'night town']);
    assert.deepEqual([legs[1].from.x, legs[1].from.z], [110, 110]);   // the town with most buildings
    assert.deepEqual([legs[3].to.x, legs[3].to.z], [-210, -200]);     // ...to the second
    assert.deepEqual(JSON.parse(JSON.stringify(B.legs(renderer))), JSON.parse(JSON.stringify(legs)));
    const cam = { cameraTarget: { set(x, y, z) { this.x = x; this.z = z; } } };
    B.pose(cam, legs[2], 0.5);
    assert.deepEqual([cam.cameraTarget.x, cam._halfH, cam._lookY], [110, 27, 0]);
});

test('the report compares a run with the one before only when both drew the same thing', () => {
    const B = bench();
    const pass = (id, mean) => ({ id, label: id, fps: 1000 / mean, cost: { mean, median: mean, p95: mean, p99: mean, max: mean },
        build: { median: 1 }, gpu: null, draws: { median: 600 }, tris: { median: 300000 },
        legs: [{ id: 'overview', median: mean }] });
    const run = (mean, gpu) => ({ kind: 'war-perf/1', build: 1149, at: '2026-11-21T00:00:00.000Z', size: '1920x1080', framesPerLeg: 120,
        scene: { file: 'f', sec: 1, units: 1, buildings: 1, nodes: 1 }, machine: { gpu }, passes: [pass('low', mean)] });
    const a = run(10, 'card'), b = run(10.4, 'card');
    assert.equal(B.comparable(a, b), true);
    assert.equal(B.comparable(a, run(10, 'another card')), false);
    assert.equal(B.comparable(a, null), false);
    assert.match(B.text(b, a), /\+4\.0 %/);
    assert.match(B.text(b, null), /GPU/);
    assert.doesNotMatch(B.text(b, null), /vs last/);
    assert.match(B.text(b, null), /n\/a/);
});
