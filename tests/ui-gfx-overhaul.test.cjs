'use strict';
// Verification suite for the WebGL Graphics (G1–G4) & LLM Benchmark UI Overhaul (U1–U5).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

test('G1–G3: shader declares micro-relief, cloud shadows, smooth shadow PCF, and post vignette', () => {
    const atmo = read('js/engine/atmosphere.js');
    assert.match(atmo, /uniform float uCloudShadow, uReliefStrength;/);
    assert.match(atmo, /smoothstep\(depth - eps, depth \+ eps, d\)/);
    assert.match(atmo, /uMaterial > 3\.5 && uMaterial < 6\.5/);
    assert.match(atmo, /uMaterial > 6\.5 && uMaterial < 7\.5/);
    assert.match(atmo, /uCloudShadow \* smoothstep/);
    const post = read('js/engine/post.js');
    assert.match(post, /uniform float uVignette;/);
    assert.match(post, /if \(uVignette > 0\.0\)/);
    const ren = read('js/engine/gamerenderer.js');
    assert.match(ren, /this\.visualStyle = \['classic', 'cinematic', 'film'\]\.includes\(style\) \? style : 'cinematic';/);
    assert.match(ren, /uCloudShadow/);
    assert.match(ren, /uReliefStrength/);
});

test('G2: EngineFx.ambientWeather emits biome-appropriate particles without exceeding pool', () => {
    const ctx = vm.createContext({ Math, Float32Array, String, window: {} });
    vm.runInContext(read('js/engine/fx.js'), ctx);
    const Fx = ctx.window.EngineFx;
    for (const theme of ['summer', 'winter', 'desert']) {
        const P = new Fx.Particles(200);
        const n = Fx.ambientWeather(P, { x: 0, z: 0 }, 35, 1.0, { theme, night: theme === 'summer' ? 0.8 : 0, level: 2 });
        assert.ok(n > 0 && P.n === n, theme + ' emitted ' + n);
    }
    // Far overview or Low tier emits nothing.
    const P2 = new Fx.Particles(200);
    assert.equal(Fx.ambientWeather(P2, { x: 0, z: 0 }, 120, 1.0, { theme: 'winter', night: 0, level: 2 }), 0);
    assert.equal(Fx.ambientWeather(P2, { x: 0, z: 0 }, 35, 1.0, { theme: 'winter', night: 0, level: 0 }), 0);
});

test('G4 & U2: IntentLayer classifies verdicts, extracts rejection reasons, and filters key tactical orders', () => {
    const ctx = vm.createContext({ Math, Date, Map, Set, WeakSet, Number, String, Array, Object, JSON });
    vm.runInContext(read('js/intent-layer.js') + '\nthis.IntentLayer = IntentLayer;', ctx);
    const L = ctx.IntentLayer;
    assert.equal(L.verdictOf({ outcome: '[ERROR] Target building_9 not found.' }, 0), 'invalid');
    assert.equal(L.verdictOf({ outcome: '[ERROR] Target moved out of sight.' }, 0), 'contended');
    assert.equal(L.verdictOf({ outcome: '[ERROR] Not enough wood to build barracks.' }, 0), 'avoidable');
    assert.equal(L.verdictOf({ outcome: 'OK - Training militia' }, 0), 'ok');
    assert.equal(L.verdictOf({ outcomes: [{ n: 1, verdict: 'invalid' }] }, 0), 'invalid');
    assert.equal(L.errorText({ outcome: '[ERROR] Target building_9 not found.' }, 0), 'Target building_9 not found.');
    // Key filter keeps tactics & EVERY refused order, suppresses routine valid economy churn.
    assert.equal(L.isKeyOrder('attack_target', {}, false), true);
    assert.equal(L.isKeyOrder('train_unit', { unitType: 'worker' }, false), false);
    assert.equal(L.isKeyOrder('train_unit', { unitType: 'worker' }, true), true);
    assert.equal(L.isKeyOrder('assign_workers', { resourceType: 'food' }, false), false);
    assert.equal(L.isKeyOrder('build_structure', { buildingType: 'house' }, false), false);
    assert.equal(L.isKeyOrder('build_structure', { buildingType: 'barracks' }, false), true);
});

test('U5: Analyze mode with visible leaderboard hides duplicate #benchMatrix and B opens #benchFull directly', () => {
    const WarEval = require(path.join(ROOT, 'js/eval/ledger.js'));
    const els = {}, store = {}, body = new Set();
    const mk = id => (els[id] = { id, style: { display: '' }, innerHTML: '', classList: { toggle() {}, contains: () => false }, setAttribute() {} });
    ['benchMatrix', 'benchFull', 'benchBtn', 'spectatorLeaderboard', 'spectatorPlayerList'].forEach(mk);
    const ctx = vm.createContext({
        console, Date, WarEval, t: k => k, getUiLang: () => 'en',
        OpenAIAIManager: { MAX_COMMANDS_PER_TURN: 3 },
        localStorage: { getItem: k => store[k] || null, setItem: (k, v) => { store[k] = v; } },
        document: {
            getElementById: id => els[id] || null,
            addEventListener() {},
            body: { classList: { toggle: (c, on) => on ? body.add(c) : body.delete(c), contains: c => body.has(c) }, style: { setProperty() {}, removeProperty() {} } }
        }
    });
    for (const f of ['js/ui.js', 'js/eval/bench-view.js']) vm.runInContext(read(f) + '\nthis.UI = UIManager;', ctx);
    const u = Object.create(ctx.UI.prototype);
    u.escapeHtml = s => String(s);
    u.teamDotHtml = () => '';
    const ledger = WarEval.createLedger();
    u.game = { spectatorMode: true, gameStarted: true, openAIAIManager: { transcripts: { ledger } } };
    // Analyze mode with visible leaderboard -> mini card suppressed, toggleBenchView opens #benchFull
    assert.equal(u.benchMiniSuppressed(), true);
    u.toggleBenchView();
    assert.equal(u._benchFull, true);
    assert.equal(els.benchMatrix.style.display, 'none');
    assert.equal(els.benchFull.style.display, '');
    // Switch to Broadcast mode -> mini card is allowed again
    body.add('broadcast-mode');
    assert.equal(u.benchMiniSuppressed(), false);
});

test('U1: thinkElapsedMs and compactNum report live inference telemetry accurately', () => {
    const ctx = vm.createContext({ console, Date, Map, Set, t: k => k, document: { getElementById: () => null } });
    vm.runInContext(read('js/ui.js') + '\nthis.UI = UIManager;', ctx);
    const u = Object.create(ctx.UI.prototype);
    assert.equal(u.compactNum(340), '340');
    assert.equal(u.compactNum(1460), '1.5k');
    assert.equal(u.compactNum(23296), '23k');
    const c1 = { id: 'a', pending: true, paused: false, turnLog: [{}, {}] };
    assert.equal(u.thinkElapsedMs(c1, 10000), 0);
    assert.equal(u.thinkElapsedMs(c1, 14500), 4500);
    // Back-to-back turn where pending stayed true between ticks resets cleanly to 0
    c1.turnLog.push({});
    assert.equal(u.thinkElapsedMs(c1, 15000), 0);
    assert.equal(u.thinkElapsedMs(c1, 17200), 2200);
    c1.pending = false;
    assert.equal(u.thinkElapsedMs(c1, 18000), 0);
});

test('U3: SeatView.stats and realityGhosts report explored %, stale age, and ground-truth coordinates', () => {
    const ctx = vm.createContext({ console, Math, Date, Float32Array, Map, Set, document: { createElement: () => ({ width: 0, height: 0, getContext: () => ({}) }) } });
    vm.runInContext(read('js/fogofwar.js') + '\n' + read('js/seat-view.js') + '\nthis.SeatView = SeatView;', ctx);
    const a = {
        id: 'a', seat: 0, units: [], buildings: [],
        _unitMemory: new Map([['u1', { id: 'u1', owner: 'b', type: 'archer', sx: 0, sz: 10, x: 10, z: 10, visible: false, located: true, at: 5000 }]])
    };
    const realUnit = { id: 'u1', owner: 'b', type: 'archer', x: 40, z: -20, health: 30 };
    const grid = new Float32Array(100);
    for (let i = 0; i < 44; i++) grid[i] = 1;
    const sv = new ctx.SeatView({
        simNow: () => 250000,
        realSecsSince: at => (25000 - at) / 1000,
        getAllUnits: () => [realUnit],
        aiManager: { aiPlayers: [a] }
    });
    sv.seat = 0;
    sv.fog = { fogGrid: grid, isPositionCurrentlyVisible: () => false };
    const ownKill = { owner: 'b', health: 0, _lastAttacker: { owner: 'a' } };
    const otherKill = { owner: 'b', health: 0, _lastAttacker: { owner: 'c' } };
    const finishedInFog = { owner: 'b', health: 200, underConstruction: false, x: 16, z: 16 };
    a._knownEnemyBuildings = new Set([finishedInFog]);
    a._enemyBuildingSeen = new Map([
        [ownKill, { type: 'house', x: 12, z: 12 }],
        [otherKill, { type: 'tower', x: 14, z: 14 }],
        [finishedInFog, { type: 'tower', x: 16, z: 16, state: 'under_construction', buildPct: 25 }]
    ]);
    const st = sv.stats();
    assert.deepEqual(JSON.parse(JSON.stringify(st)), { exploredPct: 44, staleCount: 2, oldestSec: 20 });
    assert.equal(sv.hidden(finishedInFog, 'building'), true, 'live completed tower hidden when last seen under construction');
    const specs = sv.ghostSpecs();
    const ucGhost = specs.find(s => s.underConstruction);
    assert.ok(ucGhost && ucGhost.type === 'tower' && ucGhost.buildPct === 25, 'renders last-seen scaffold snapshot');
    const rg = sv.realityGhosts();
    assert.equal(rg.length, 2);
    assert.equal(rg.some(x => x.type === 'house'), false, 'building razed by this seat does not reappear as ghost');
    assert.equal(rg.some(x => x.type === 'tower'), true, 'building destroyed out of sight by another seat stays ghosted');
    assert.equal(rg[0].ageSec, 20);
    assert.deepEqual(JSON.parse(JSON.stringify(rg[0].heading)), { dx: 1, dz: 0 });
    assert.deepEqual(JSON.parse(JSON.stringify(rg[0].real)), { x: 40, z: -20 });
});

test('No WarManifest rule or harness files were modified by presentation changes', () => {
    const manifest = require(path.join(ROOT, 'js/manifest.js'));
    assert.ok(Array.isArray(manifest.rules) && manifest.rules.length > 0);
    assert.equal(manifest.rules.includes('js/ui.js'), false);
    assert.equal(manifest.rules.includes('js/intent-layer.js'), false);
    assert.equal(manifest.rules.includes('js/seat-view.js'), false);
});

test('G2 & G4 runtime smoke: EngineRenderer._assembleFrame executes cleanly with weather, 3D arcs, TC pulse, range rings, and Wonder beacon', () => {
    const ctx = vm.createContext({
        console, Math, Date, Map, Set, WeakMap, Float32Array, Uint8Array, Array, Object, String, Number,
        performance: { now: () => 5000 },
        document: { addEventListener() {}, createElement: () => ({ width: 64, height: 64, getContext: () => ({}) }) },
        GLCore: { createMeshBuffers: () => ({}), drawMesh() {}, instancingOf: () => false },
        TexGen: { TERRAIN_SEED: 1, TERRAIN_WORLD: 1000, TERRAIN_LAND: 400 }
    });
    ctx.window = ctx;
    for (const f of ['js/engine/math3d.js', 'js/engine/mesh.js', 'js/engine/units.js', 'js/engine/atmosphere.js', 'js/engine/fx.js', 'js/engine/gamerenderer.js']) {
        vm.runInContext(read(f), ctx);
    }
    const r = Object.create(ctx.EngineRenderer.prototype);
    const ai = { id: 'p1', seat: 0, _eliminated: false, _wonderHold: 540000 };
    const tc = { id: 'b_tc', type: 'town_center', owner: 'p1', x: 0, z: 0, health: 500, maxHealth: 500 };
    const tower = { id: 'b_tw', type: 'tower', owner: 'p2', x: 25, z: 0, health: 200, maxHealth: 200, attackRange: 18 };
    const wonder = { id: 'b_w', type: 'wonder', isWonder: true, owner: 'p1', x: -20, z: 10, health: 1000, maxHealth: 1000 };
    const treb = { id: 'u_t', type: 'trebuchet', owner: 'p1', x: -10, z: -10, health: 100, range: 50 };
    const ghostUnit = {
        x: 12, z: -8, _fade: 0.4,
        _engine: {
            type: 'infantry', phase: 0, boneNames: [], boneMats: null,
            entries: [{ buf: {}, tex: {}, tint: [1, 1, 1], base: ctx.M3D.identity(), skin: false }]
        }
    };
    const ghostBld = {
        x: -14, z: 18, _fade: 0.4,
        _engine: { opaque: [{ buf: {}, tex: {}, tint: [1, 1, 1], model: ctx.M3D.identity() }], blended: [] }
    };
    Object.assign(r, {
        gl: {}, graphicsQuality: 'cinematic', visualStyle: 'film', _reducedMotion: false,
        cloudShadows: true, weatherMotes: true, tcThinkingPulse: true,
        _theme: 'summer', _nightFactor: 0.1, _halfH: 34, cameraTarget: { x: 0, y: 0, z: 0 },
        _dl: { opaque: [], blended: [], bars: [], casters: [] },
        _geo: new Map(), _projectiles: [], _rings: [], _ghosts: [], _rubble: [], _breaks: [],
        _seatGhosts: new Map([['u', { kind: 'unit', ent: ghostUnit }], ['b', { kind: 'building', ent: ghostBld }]]),
        tex: { white: {}, mote: {}, ring: {}, shadow: {}, rock: {} }, WHITE: [1, 1, 1],
        units: [], buildings: [tc, tower, wonder], selectedBuilding: tower, selectedUnits: [treb],
        entityHidden: () => false, _cull: () => false, _fow: () => null,
        intentMarks: () => [
            { from: { x: -10, z: -10 }, to: { x: 25, z: 0 }, marker: false, refused: false, verdict: 'ok', alpha: 1, color: '#e6c27a', action: 'attack_target', params: { targetId: 'b_tw' } },
            { from: null, to: { x: 0, z: 0 }, waypoints: [{ x: 30, z: 10 }, { x: 55, z: -15 }], marker: true, refused: false, verdict: 'ok', alpha: 1, color: '#7cc4a0', action: 'explore', params: { tile: 'D4', then: ['E4', 'F3'] } },
            { from: { x: 0, z: 0 }, to: { x: 15, z: 15 }, marker: false, refused: true, verdict: 'invalid', alpha: 1, color: '#9aa4b1', action: 'move_units', params: {} }
        ],
        game: {
            spectatorMode: true, wonderPace: 1, wonderRequired: 600,
            aiManager: { aiPlayers: [ai] },
            openAIAIManager: { aiControllers: [{ id: 'p1', pending: true, paused: false, aiPlayer: ai }] }
        }
    });
    assert.doesNotThrow(() => r._assembleFrame(12.5, 0.05, ctx.M3D.identity()));
    assert.ok(r._dl.blended.length > 40, 'blended pass contains multi-waypoint 3D arcs, TC pulse, range rings, Wonder beacon, and particles');
    // Min camera pitch is 5 degrees (5° closer to ground than the previous 10°)
    const gr = read('js/engine/gamerenderer.js');
    assert.match(gr, /Math\.max\(5\*Math\.PI\/180,/);
    assert.match(gr, /Math\.max\(5 \* Math\.PI \/ 180,/);
});

test('Multi-waypoint explore tool calls resolve every stop in IntentLayer worldMarks and frame shapes', () => {
    const ctx = vm.createContext({ console, Date, WeakSet, Set, Map, Math });
    vm.runInContext(read('js/intent-layer.js') + '\nthis.IL = IntentLayer;', ctx);
    const layer = new ctx.IL({ EXPLORE_TILES: 7, terrain: { size: 700 }, getAllUnits: () => [], getAllBuildings: () => [] });
    const ai = { id: 'p1', seat: 0, units: [], buildings: [] };
    const turn = { toolCalls: [{ name: 'explore', args: JSON.stringify({ tile: 'C5', then: ['D5', 'E4'] }) }] };
    layer.add(ai, turn, 1000);
    const marks = layer.worldMarks(1500);
    assert.equal(marks.length, 1);
    assert.equal(marks[0].waypoints.length, 2);
    assert.deepEqual(marks[0].waypoints[0], layer.tileCentre('D5'));
    assert.deepEqual(marks[0].waypoints[1], layer.tileCentre('E4'));
    assert.equal(layer.bubbles[0].text, 'explore C5 → D5 → E4');
    const f = layer.frame((x, z) => ({ x, y: z }), 1500);
    assert.equal(f.shapes[0].waypoints.length, 2);
});
