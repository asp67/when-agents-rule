'use strict';
// Golden-trace harness: runs WAR's own rule code in a VM, the way the browser runs it,
// with the two inputs a browser cannot hold still -- Math.random and the clock --
// replaced by a seeded generator and a stepped clock.
//
// It drives the real loop, not a re-creation of it. Each frame does what a browser
// frame does, in the browser's order: the renderer's frame (whose positional pass --
// same-owner separation and building clearance -- is a rule today, living in
// gamerenderer.js) and then Game.tick(). The positional pass is cut out of the
// renderer's source at named anchors and run as written; when the determinism work
// moves it into the simulation step (review #6 step 2), the anchors fail loudly and
// this harness must change with it. Nothing here re-implements a rule.
//
// What a trace pins is WAR as it runs at a fixed 16 ms frame in a visible tab. The
// frame rate and tab visibility are rules inputs today; that is the reason for the
// determinism work, and the reason this harness fixes them rather than hiding them.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const ROOT = path.resolve(__dirname, '../..');
// Line endings normalized: a Windows checkout has CRLF, and the anchors below are LF.
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8').split('\r\n').join('\n');

const FRAME_MS = 16;

function createRuntime(seed) {
    // LCG, as in the Platform's headless runtime: tiny, fast, fully specified.
    let state = seed >>> 0, elapsed = 0, draws = 0;
    const epoch = 1700000000000;
    const math = Object.create(Math);
    math.random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; draws++; return state / 4294967296; };
    class ClockDate extends Date {
        constructor(...args) { super(...(args.length ? args : [epoch + elapsed])); }
        static now() { return epoch + elapsed; }
    }
    return { Math: math, Date: ClockDate, advance(ms) { elapsed += ms; },
             now: () => elapsed, state: () => ({ elapsed, draws }) };
}

// A presentation object whose every method is a no-op. Presentation calls cannot
// change a rule, so they are counted rather than enumerated; a method a rule READS a
// value from must be given explicitly in `own`, or the trace would pin `undefined`.
function inert(name, calls, own = {}) {
    return new Proxy(own, {
        get(target, key) {
            if (key in target) return target[key];
            if (typeof key === 'symbol' || key === 'then' || String(key).startsWith('_')) return undefined;
            return (...args) => { calls[name + '.' + String(key)] = (calls[name + '.' + String(key)] || 0) + 1; };
        },
        set(target, key, value) { target[key] = value; return true; }
    });
}

// The positional pass, exactly as the renderer runs it each frame.
function positionPassSource() {
    const src = read('js/engine/gamerenderer.js');
    const start = src.indexOf('            if (!this.replayMode) {\n                const SEPARATION_DIST');
    const end = src.indexOf('\n            // draw ---', start);
    if (start < 0 || end < 0) throw new Error('renderer positional-pass anchors moved: update tests/sim/harness.cjs (review #6 step 2)');
    return '(function (deltaTime) {\n' + src.slice(start, end) + '\n})';
}

const RULE_FILES = ['js/engine/texgen.js', 'js/civilizations.js', 'js/buildings.js', 'js/units.js', 'js/resources.js',
    'js/terrain.js', 'js/fogofwar.js', 'js/ai.js', 'js/sha256.js', 'js/conditions.js', 'js/openai-ai.js',
    'js/game.js', 'js/standing-orders.js'];

class GoldenMatch {
    constructor({ seed = 1 } = {}) {
        this.runtime = createRuntime(seed);
        this.presentation = {};
        const rt = this.runtime, calls = this.presentation;
        // Fog of war paints a canvas; its pixel buffers are real, so any rule that
        // reads fog back reads what it wrote.
        const ctx2d = () => inert('canvas2d', calls, {
            createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
            getImageData: (x, y, w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
            createLinearGradient: () => inert('gradient', calls),
            createRadialGradient: () => inert('gradient', calls),
        });
        const element = () => inert('element', calls, { style: {}, classList: inert('classList', calls), dataset: {},
            width: 0, height: 0, getContext: ctx2d });
        this.rafQueue = [];
        const context = vm.createContext({
            Math: rt.Math, Date: rt.Date, performance: { now: () => rt.now() },
            console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
            document: inert('document', calls, { hidden: false, getElementById: element, querySelector: element,
                querySelectorAll: () => [], createElement: element, body: element() }),
            localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
            requestAnimationFrame: cb => { this.rafQueue.push(cb); return this.rafQueue.length; },
            t: key => key,
        });
        vm.runInContext('globalThis.window = globalThis', context);
        for (const file of RULE_FILES) {
            let source = read(file);
            if (file === 'js/game.js') {
                const boundary = source.indexOf('\nconst WAR_PRIVATE_HOST');
                if (boundary < 0) throw new Error('game.js browser-boot boundary moved');
                source = source.slice(0, boundary);
            }
            vm.runInContext(source, context, { filename: file });
        }
        this.context = context;
        this.positionPass = vm.runInContext(positionPassSource(), context, { filename: 'gamerenderer.js#position-pass' });

        // game.js declares the global `game` itself (a lexical binding), so it is
        // assigned inside the context; a property set from outside would be shadowed.
        const g = this.game = vm.runInContext('game = new Game(); game', context);
        const units = [], buildings = [];
        const drop = (list, e) => { const i = list.indexOf(e); if (i >= 0) list.splice(i, 1); };
        let frames = 0;
        g.renderer = inert('renderer', calls, {
            units, buildings, selectedUnits: [], replayMode: false, container: { clientWidth: 0, clientHeight: 0 },
            get _completedFrames() { return ++frames; }, grassStats: null,
            addUnit: e => { if (!units.includes(e)) units.push(e); },
            addBuilding: e => { if (!buildings.includes(e)) buildings.push(e); },
            killUnit: e => drop(units, e), removeUnit: e => drop(units, e),
            killBuilding: e => drop(buildings, e), removeBuilding: e => drop(buildings, e),
        });
        g.ui = inert('ui', calls);
        g.terrain = vm.runInContext('new TerrainManager(null, 800)', context);
        g.aiManager = vm.runInContext('new AIManager(game)', context);
    }

    // The arena start path itself (Game._startArenaFromSetup), with a match spec.
    async startArena({ seats, seed, difficulty = 'easy' }) {
        const setup = seats.map(s => (typeof s === 'string' ? { civ: s, type: 'ki' } : s));
        const started = this.game._startArenaFromSetup({ setup, seed, difficulty, turnBased: false });
        let done = false, error = null;
        started.then(() => { done = true; }, e => { error = e; done = true; });
        // Frames pass while the scene is prepared; the clock does not, as in a
        // browser where these are a handful of frames before the match starts.
        for (let i = 0; !done && i < 1000; i++) {
            const queue = this.rafQueue.splice(0);
            queue.forEach(cb => cb());
            await new Promise(resolve => setImmediate(resolve));
        }
        if (error) throw error;
        if (!this.game.gameStarted) throw new Error('arena did not start');
    }

    // A flat, featureless board for scripted fights: no nodes, no coast.
    startFixture(civs) {
        const g = this.game;
        g.spectatorMode = true;
        // As the real start does, before anything is placed or ordered: it resets the
        // standing orders and unit handles, and done lazily by the first tick it would
        // wipe orders already given.
        g.resetTimeline();
        g.terrain.resources = [];
        g.terrain.clampToLand = (x, z) => ({ x, z });
        g.terrain.isOnLand = () => true;
        g.aiManager.aiPlayers = [];
        civs.forEach((civ, i) => {
            const ai = g.aiManager.addAIPlayer(civ, 'medium');
            ai.seat = i;
            ai.age = 'bronze';
        });
        g.openAIAIManager = vm.runInContext('new OpenAIAIManager(game)', this.context);
        g.fogOfWar = vm.runInContext('new FogOfWarManager(game)', this.context);
        g.lastFrameTime = this.runtime.Date.now();
        g.gameStarted = true;
        this.rafQueue.push(() => g.gameLoop());
        return g.aiManager.aiPlayers;
    }

    // A model seat with no model: the rule-based brain leaves it alone, and the
    // harness's per-tick seat work (discovery, attack reports, defeat) runs for it as
    // for any model seat. It is PAUSED, the spectator's own switch, so it is never
    // asked for a turn; it moves only by the scripted commands given below.
    scripted(ai) {
        const mgr = this.game.openAIAIManager;
        this.game.aiManager.markAsOpenAIControlled(ai.id);
        const c = {
            id: ai.id, aiPlayer: ai, model: { name: 'scripted', model: 'scripted', language: 'en' },
            lastTurnTime: 0, turnCount: 0, paused: true, conversationHistory: [], turnLog: [],
            _pendingTurnUser: null, lastActionResult: null, pendingAdvice: [], objective: '', plan: [],
            pendingAttackReports: [], stats: mgr.newStats(), lanes: [],
        };
        c.seat = c;
        mgr.aiControllers.push(c);
        return c;
    }

    // A command through the models' own executor, as a tool call would arrive.
    command(controller, action, params) {
        const mgr = this.game.openAIAIManager;
        mgr.executeAction(controller, { action, params });
        return controller.seat.lastActionResult;
    }

    addUnit(ai, type, x, z, fields = {}) {
        const u = this.context.createUnit(type, x, z, ai.id, ai.civilization, ai.age);
        if (!u) throw new Error('unknown unit ' + type);
        Object.assign(u, fields);
        ai.units.push(u);
        ai.resources.updatePopulation(ai.units.length);
        this.game.renderer.addUnit(u);
        return u;
    }

    addBuilding(ai, type, x, z, fields = {}) {
        const b = this.context.createBuilding(type, x, z, ai.id, ai.civilization, { age: ai.age });
        if (!b) throw new Error('unknown building ' + type);
        Object.assign(b, fields);
        ai.buildings.push(b);
        this.game.renderer.addBuilding(b);
        if (this.game.recomputeMaxPopulation) this.game.recomputeMaxPopulation(ai);
        return b;
    }

    // One browser frame: the clock moves, the renderer's frame runs its positional
    // pass, then every other animation-frame callback (the game loop's tick).
    frame() {
        this.runtime.advance(FRAME_MS);
        this.positionPass.call(this.game.renderer, Math.min(0.1, FRAME_MS / 1000));
        const queue = this.rafQueue.splice(0);
        queue.forEach(cb => cb());
    }

    run(ms, every = null, onCheckpoint = null) {
        const end = this.runtime.now() + ms;
        let next = every ? this.runtime.now() + every : Infinity;
        while (this.runtime.now() < end) {
            this.frame();
            if (this.runtime.now() >= next) { onCheckpoint(this.runtime.now()); next += every; }
        }
    }

    // Everything the rules decide, projected to plain data. Floats are kept exact:
    // a trace that rounds would let a drift hide until it changed an outcome.
    snapshot() {
        const g = this.game;
        const ref = v => (v && (v.id || v.handle)) || null;
        const fields = ['id', 'type', 'x', 'z', 'health', 'maxHealth', 'task', 'isMoving', 'isAttacking',
            'targetX', 'targetZ', 'attackTimer', 'carryingResource', 'harvestAmount', 'buildProgress',
            'underConstruction', 'isProducing', 'productionType', 'productionProgress', 'foodAmount'];
        const project = e => Object.assign(Object.fromEntries(fields.filter(k => e[k] !== undefined).map(k => [k, e[k]])),
            { attackTarget: ref(e.attackTarget), harvestTarget: ref(e.harvestTarget), buildTarget: ref(e.buildTarget) });
        return JSON.parse(JSON.stringify({
            clock: this.runtime.state(),
            wonderTimer: g.wonderTimer || 0,
            seats: g.aiManager.aiPlayers.map(p => ({
                id: p.id, civ: p.civilization, age: p.age, eliminated: !!p._eliminated,
                resources: Object.fromEntries(['food', 'wood', 'stone', 'gold', 'population', 'maxPopulation'].map(k => [k, p.resources[k]])),
                research: Object.keys(p.researchedTechs || {}).sort(),
                units: p.units.map(project), buildings: p.buildings.map(project),
            })),
            nodes: (g.terrain.resources || []).map(r => [r.type, r.x, r.z, r.amount]),
        }));
    }

    hash() { return createHash('sha256').update(JSON.stringify(this.snapshot())).digest('hex').slice(0, 16); }

    // What a person reads when a trace breaks: counts, not coordinates.
    summary() {
        const s = this.snapshot();
        return {
            t: Math.round(s.clock.elapsed / 1000),
            seats: s.seats.map(p => {
                const byType = {};
                p.units.forEach(u => { byType[u.type] = (byType[u.type] || 0) + 1; });
                return { civ: p.civ, age: p.age, out: p.eliminated,
                    res: [p.resources.food, p.resources.wood, p.resources.stone, p.resources.gold].map(Math.floor),
                    units: byType, hp: Math.round(p.units.reduce((a, u) => a + u.health, 0)),
                    buildings: p.buildings.length, research: p.research.length };
            }),
        };
    }
}

// Golden file handling. A trace is re-recorded only on purpose:
//   WAR_GOLDEN=update node --test tests/sim/
// and the commit that does it says which rules change made it necessary.
function checkGolden(t, assert, name, trace) {
    const file = path.join(__dirname, 'golden', name + '.json');
    if (process.env.WAR_GOLDEN === 'update') {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(trace, null, 1) + '\n');
        t.diagnostic('recorded golden trace: ' + name);
        return;
    }
    // A missing trace fails rather than being recorded, or deleting one would pass.
    if (!fs.existsSync(file)) assert.fail(`no golden trace ${name}; record it with WAR_GOLDEN=update`);
    const want = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (let i = 0; i < Math.max(want.length, trace.length); i++) {
        const a = want[i], b = trace[i];
        if (!a || !b || a.hash !== b.hash) {
            assert.deepEqual(b && b.summary, a && a.summary,
                `${name}: first divergence at checkpoint ${i} (t=${(a || b).summary.t}s)`);
            assert.fail(`${name}: diverges at checkpoint ${i} (t=${a.summary.t}s) with identical counts: positions or timers moved`);
        }
    }
}

module.exports = { GoldenMatch, checkGolden, FRAME_MS };
