// Run real UI/analyzer/renderer methods with the DOM and GPU boundaries stubbed.
// These checks cover state behavior; they do not replace browser visual testing.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const source = file => fs.readFileSync(path.join(root, file), 'utf8');

function harness(saved = null) {
    const frames = [], timers = new Map();
    let now = 100, timerId = 0, stored = saved;
    const noop = () => {};
    const document = { readyState: 'loading', addEventListener: noop,
        getElementById: () => null, querySelector: () => null,
        visibilityState: 'visible', body: { dataset: {} } };
    const context = vm.createContext({ document, console,
        window: { M3D: { billboard: () => [] } },
        TexGen: { TERRAIN_SEED: 1, TERRAIN_WORLD: 1000, TERRAIN_LAND: 400 },
        performance: { now: () => now }, requestAnimationFrame: fn => frames.push(fn),
        setInterval: (fn, ms) => { timers.set(++timerId, { fn, ms }); return timerId; },
        clearInterval: id => timers.delete(id),
        localStorage: { getItem: () => stored, setItem: (_, value) => { stored = value; } }
    });
    vm.runInContext(source('js/ui.js') + '\nthis.UIManager = UIManager;', context);
    vm.runInContext(source('js/analyzer.js') + '\nthis.TranscriptAnalyzer = TranscriptAnalyzer;', context);
    vm.runInContext(source('js/engine/gamerenderer.js'), context);
    const renderer = Object.create(context.window.EngineRenderer.prototype);
    Object.assign(renderer, { _cameraMoveId: 0, _halfH: 34, _yaw: 0, _pitch: .5,
        terrain: { size: 800 }, W: 1200, H: 600,
        cameraTarget: { x: 0, y: 0, z: 0, set(x, y, z) { Object.assign(this, { x, y, z }); } },
        onWindowResize: noop });
    const ui = new context.UIManager({ renderer });
    ui.anRender = noop;
    return { context, document, frames, timers, renderer, ui,
        setTime: n => { now = n; }, saved: () => stored };
}

test('preferences recover from corrupt storage and persist independently of model settings', () => {
    const h = harness('{broken');
    assert.equal(h.ui.viewPreferences().split, 52);
    assert.equal(h.ui.viewPreferences().rate, 1);
    h.ui.anSetLayout('read');
    h.ui.setReadingSize('compact');
    h.ui.anSetReplayRate('4');
    const restored = harness(h.saved()).ui.viewPreferences();
    assert.equal(restored.layout, 'read');
    assert.equal(restored.split, 28);
    assert.equal(restored.text, 'compact');
    assert.equal(restored.rate, 4);
    h.ui.anSetLayout('toString');
    h.ui.anSetReplayRate('-1');
    assert.equal(h.ui.viewPreferences().layout, 'read');
    assert.equal(h.ui.viewPreferences().rate, 4);
    const clamped = harness('{"split":900,"rate":100,"layout":"unknown"}').ui.viewPreferences();
    assert.equal(clamped.split, 80);
    assert.equal(clamped.rate, 1);
    assert.equal(clamped.layout, 'balanced');
});

test('rate changes replace the timer; playback follows recorded filtered entries and stops at the end', () => {
    const h = harness();
    const a = h.ui.analyzer = new h.context.TranscriptAnalyzer(h.ui);
    a.order = [{ _sec: 0 }, { _sec: 20 }, { _sec: 90 }, { _sec: 200 }];
    a.cursor = 0;
    a.visible = () => [a.order[0], a.order[2], a.order[3]];
    h.ui.anTogglePlay();
    assert.equal([...h.timers.values()][0].ms, 1000);
    h.ui.anSetReplayRate(4);
    assert.equal(h.timers.size, 1);
    let timer = [...h.timers.values()][0];
    assert.equal(timer.ms, 250);
    timer.fn(); assert.equal(a.cursor, 2);
    timer.fn(); assert.equal(a.cursor, 3);
    timer.fn(); assert.equal(h.timers.size, 0);
    assert.deepEqual(a.order.map(r => r._sec), [0, 20, 90, 200]);
});

test('scrubbing stops playback, reaches entries hidden by filters, and clamps to the recording', () => {
    const h = harness();
    const a = h.ui.analyzer = new h.context.TranscriptAnalyzer(h.ui);
    a.order = [{ _sec: 0 }, { _sec: 20 }, { _sec: 90 }]; a.cursor = 0;
    a.visible = () => [a.order[0], a.order[2]];
    h.ui.anTogglePlay();
    h.ui.anScrub('1');
    assert.equal(h.timers.size, 0); assert.equal(a.cursor, 1);
    h.ui.anScrub('900'); assert.equal(a.cursor, 2);
    h.ui.anScrub('invalid'); assert.equal(a.cursor, 2);
    h.ui.anTogglePlay(); h.document.visibilityState = 'hidden';
    [...h.timers.values()][0].fn();
    assert.equal(h.timers.size, 0); assert.equal(a.cursor, 2);
});

test('camera commands respect map and zoom bounds, reset pose, and cancel pending travel', () => {
    const h = harness(), r = h.renderer;
    r.moveCameraTo(300, 300);
    r.setCameraView('selection', { x: 500, z: -500 });
    h.setTime(500); h.frames.shift()();
    assert.equal(r.cameraTarget.x, 400); assert.equal(r.cameraTarget.z, -400);
    for (let i = 0; i < 100; i++) r.setCameraView('zoomIn');
    assert.equal(r._halfH, 10);
    for (let i = 0; i < 100; i++) r.setCameraView('zoomOut');
    assert.equal(r._halfH, 520);
    r.setCameraView('reset');
    assert.equal(r._halfH, 34); assert.equal(r._yaw, Math.PI / 4);
    assert.equal(r._pitch, Math.atan(.5));
    r.setCameraView('overview');
    assert.equal(r.cameraTarget.x, 0); assert.equal(r.cameraTarget.z, 0);
    assert.ok(Number.isFinite(r._halfH));
});

function renderFrame(replayMode) {
    const h = harness(), r = h.renderer, noop = () => {};
    // Two close friendly units and one inside a building exercise both live pushes.
    const units = [{ x: 10, z: 10, owner: 1 }, { x: 10.5, z: 10, owner: 1 },
        { x: 50, z: 50, owner: 2 }];
    Object.assign(r, { replayMode, units, buildings: [{ x: 50, z: 50, type: 'house' }],
        _lastTime: 83.333, updateCamera: noop, _computeCam: () => ({ view: [], proj: [], haze: [] }),
        _assembleFrame: noop, _syncFog: noop,
        gl: new Proxy({}, { get: () => noop }), prog: { uniforms: {} },
        _sky: [0, 0, 0], _sun: [], sunDir: [], _dl: { opaque: [], blended: [], bars: [] } });
    const before = structuredClone(units);
    r.animate(); h.setTime(116.667); h.frames.shift()();
    return { before, after: units };
}

test('replay render frames preserve recorded positions, including overlaps', () => {
    const { before, after } = renderFrame(true);
    assert.deepEqual(after, before);
});

test('live rendering retains friendly separation and building clearance', () => {
    const { before, after } = renderFrame(false);
    assert.ok(after[0].x < before[0].x);
    assert.ok(after[1].x > before[1].x);
    assert.equal(after[2].x, 54.5);
});

test('all workspace controls have translations in every supported UI language', () => {
    const h = harness();
    vm.runInContext(source('js/i18n.js') + '\nthis.labels = I18N_VIEW;', h.context);
    const keys = Object.keys(h.context.labels.en);
    for (const language of ['en', 'de', 'es', 'zh']) {
        assert.deepEqual(Object.keys(h.context.labels[language]), keys);
        for (const key of keys) assert.ok(h.context.labels[language][key].length > 0);
    }
});

test('repeated analyzer renders restore campaign input and clear replay state on exit', () => {
    const h = harness();
    const cv = { parentElement: null, nextSibling: null };
    const home = { insertBefore(node) { node.parentElement = this; } };
    const host = { appendChild(node) { node.parentElement = this; } };
    cv.parentElement = home;
    h.document.getElementById = id => ({ gameCanvas: cv, anViewport: host })[id] || null;
    h.ui.anBindPick = () => {}; h.ui.anBindKeys = () => {};
    h.renderer.clearScene = () => {};
    h.ui.game.spectatorMode = false;
    h.ui._anFog = {}; h.ui.game.fogOfWar = h.ui._anFog;
    h.ui.anMountStage(); h.ui.anMountStage();
    assert.equal(h.renderer.replayMode, true);
    assert.equal(h.ui.game.spectatorMode, true);
    h.ui.anUnmountStage();
    assert.equal(cv.parentElement, home);
    assert.equal(h.renderer.replayMode, false);
    assert.equal(h.ui.game.spectatorMode, false);
    assert.equal(h.ui.game.fogOfWar, null);
});

function selectionHarness() {
    const h = harness(), r = h.renderer;
    h.context.window.addEventListener = () => {};
    h.context.location = { hostname: 'localhost', protocol: 'http:', search: '' };
    h.context.t = key => key;
    vm.runInContext(source('js/game.js') + '\nthis.Game = Game;', h.context);
    const game = Object.create(h.context.Game.prototype);
    Object.assign(game, { renderer: r, ui: h.ui, aiManager: { aiPlayers: [] },
        getAllUnits: () => r.units, disableActionCam: () => {} });
    h.ui.game = game;
    h.ui.updateUnitInfo = (unit, building) => { h.ui._infoSubject = { unit, building }; };
    game.updateUnitInfo = (...args) => h.ui.updateUnitInfo(...args);
    h.ui.showInfoMessage = message => { h.message = message; };
    Object.assign(r, { units: [], buildings: [], selectedUnits: [],
        canvas: { getBoundingClientRect: () => ({ left: 0, top: 0 }) },
        worldToScreen: (x, y, z) => ({ x, y: z }) });
    return { ...h, game };
}

test('Selection focuses a unit picked through the live spectator path', () => {
    const h = selectionHarness(), r = h.renderer;
    const unit = { x: 70, z: 90, health: 100 };
    r.units = [unit];
    h.game.aiManager.aiPlayers = [{ units: [unit], buildings: [] }];
    h.game.spectatorPick(70, 90);
    assert.equal(unit.selected, true);
    h.ui.cameraAction('selection');
    assert.equal(r.cameraTarget.x, 70);
    assert.equal(r.cameraTarget.z, 90);
});

test('Selection uses current unit groups ahead of a previous building and rejects stale selections', () => {
    const h = selectionHarness(), r = h.renderer;
    const building = { x: -100, z: -100, health: 100 };
    const units = [{ x: 40, z: 60, health: 100 }, { x: 80, z: 100, health: 100 }];
    r.units = units; r.buildings = [building];
    h.game.selectedBuilding = building;
    r.selectMultipleUnits(units);
    h.ui.cameraAction('selection');
    assert.equal(r.cameraTarget.x, 60); assert.equal(r.cameraTarget.z, 80);
    h.game.selectBuilding(building);
    h.ui.cameraAction('selection');
    assert.equal(r.cameraTarget.x, -100); assert.equal(r.cameraTarget.z, -100);
    // A replay rebuild removes the old entity, even if an old reference survives.
    r.buildings = [];
    r.setCameraView('overview');
    h.ui.cameraAction('selection');
    assert.equal(r.cameraTarget.x, 0); assert.equal(r.cameraTarget.z, 0);
});
