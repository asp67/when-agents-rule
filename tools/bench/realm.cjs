'use strict';
// WAR's reference realm: the game's own rule code in a Node VM, with the two inputs a
// browser cannot hold still -- Math.random and the clock -- replaced by a seeded
// generator and a stepped clock. Node is the declared reference runtime of WAR Bench
// (review #8): a result is what this realm computes at a given core hash.
//
// It runs the real code, not a re-creation of it. Driven by frames (run), each frame
// moves the clock and runs every animation-frame callback -- the game loop's tick() --
// exactly as a tab does. Driven frozen (advance), it steps the simulation with no
// frames at all. The renderer, the UI and the sound are inert stand-ins that count
// their calls: nothing presentational decides anything since the positional pass moved
// into the simulation step (js/simulation/position-rules.js).
//
// The golden-trace tests (tests/sim/harness.cjs) and the bench runner share this file,
// so the engine the tests pin is the engine the bench scores.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const ROOT = path.resolve(__dirname, '../..');
// Line endings normalized: a Windows checkout has CRLF.
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

// The rule files in load order, from the one list of them: the manifest's own `vm`
// list, read from the same place the rules come from (disk, or a bundle's sources).
function ruleFiles(sources) {
    if (!sources) return ['js/manifest.js'].concat(require(path.join(ROOT, 'js/manifest.js')).vm);
    if (!sources['js/manifest.js']) throw new Error('sources carry no js/manifest.js');
    const ctx = vm.createContext({});
    vm.runInContext(sources['js/manifest.js'] + '\n;globalThis.__m = WarManifest;', ctx);
    const files = ['js/manifest.js'].concat(Array.from(ctx.__m.vm));
    const missing = files.filter(f => typeof sources[f] !== 'string');
    if (missing.length) throw new Error('sources lack rule files: ' + missing.join(', '));
    return files;
}
const RULE_FILES = ruleFiles(null);

class Realm {
    // frameMs and hidden describe the tab: 16 ms frames in a visible tab by default. A
    // hidden tab is driven by the background worker, a tick every 250 ms.
    //
    // `sources` ({path: text}) runs these rule texts instead of the files on disk: a
    // bundle's verify replays on the rules it recorded, whatever WAR has become since.
    //
    // `normalSpeed` is the pace a match starts at and a Wonder holds it to, in game ms
    // per real ms. The arena's default became 2 in build 1020; the Bench, the golden
    // traces and every result recorded with them stay at 1 unless asked otherwise.
    constructor({ seed = 1, frameMs = FRAME_MS, hidden = false, sources = null, normalSpeed = 1 } = {}) {
        this.frameMs = frameMs;
        this.sources = sources;
        this.seed = seed;
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
            document: inert('document', calls, { hidden, getElementById: element, querySelector: element,
                querySelectorAll: () => [], createElement: element, body: element() }),
            localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
            requestAnimationFrame: cb => { this.rafQueue.push(cb); return this.rafQueue.length; },
            t: key => key,
        });
        vm.runInContext('globalThis.window = globalThis', context);
        // Whole files: browser start-up lives in js/boot.js, so nothing is cut.
        for (const file of ruleFiles(sources)) vm.runInContext(sources ? sources[file] : read(file), context, { filename: file });
        this.context = context;
        vm.runInContext('Game.NORMAL_SIM_SPEED = ' + Number(normalSpeed), context);

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
            // As the real one does at every match start. Rules read these lists (a new
            // id is checked against the living entities), so a second match in one
            // page would otherwise meet the last match's entities in them.
            clearScene: () => { units.length = 0; buildings.length = 0; },
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
    // `mapSeed` keys every random draw of the match; by default one per realm seed.
    startFixture(civs, mapSeed = null) {
        const g = this.game;
        g.spectatorMode = true;
        // As the real start does, before anything is placed or ordered: it resets the
        // standing orders and unit handles, and done lazily by the first tick it would
        // wipe orders already given.
        g.mapSeed = mapSeed != null ? String(mapSeed) : 'fixture-' + this.seed;
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

    // One browser frame: the clock moves, then every animation-frame callback runs
    // (the game loop's tick).
    frame() {
        this.runtime.advance(this.frameMs);
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

    // The frozen driver (review #6 step 9): exactly `ms` of simulated time in 50 ms
    // steps, no frames at all -- how the bench advances a scenario between turns. The
    // runtime clock moves with it, so anything the harness stamps in wall time agrees.
    advance(ms) {
        // Refused before anything moves: a clock stepped for a call the rules then
        // refuse would leave the two disagreeing.
        if (!Number.isInteger(ms / 50) || ms < 0) throw new RangeError('advance takes a whole number of 50 ms steps, got ' + ms);
        this.runtime.advance(ms);
        return this.game.advanceSim(ms);
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


// A match from a plain config, the one way the bench (and anything else without a UI)
// starts one:
//   { kind: 'arena', seats: ['greek', {civ, type, profile}], seed, difficulty }
//       the arena's own start path (Game._startArenaFromSetup) on a generated map;
//   { kind: 'board', seed, seats: [{civ, age, units: [[type, x, z, fields?]],
//       buildings: [[type, x, z, fields?]], resources: {food,..}, techs: [..]}] }
//       a flat, featureless board with exactly the entities given; fields.tag names an
//       entity in realm.tags.
// Every seat of a board is a model seat with no model (scripted): it moves only by
// commands. Resolves to the started Realm; `realm.seats` are its players in seat order.
async function createMatch(config, options = {}) {
    const realm = new Realm(Object.assign({ seed: 1 }, options));
    if (config.kind === 'arena') {
        await realm.startArena({ seats: config.seats, seed: config.seed, difficulty: config.difficulty });
        realm.seats = Array.from(realm.game.aiManager.aiPlayers);
        return realm;
    }
    if (config.kind !== 'board') throw new Error('createMatch: unknown kind ' + config.kind);
    const players = realm.startFixture(config.seats.map(s => s.civ), config.seed);
    realm.seats = Array.from(players);
    realm.controllers = realm.seats.map(p => realm.scripted(p));
    // A `tag` in an entity's fields names it for whoever set the board up (a scenario's
    // predicates and commands); it is kept here, never written onto the entity.
    realm.tags = {};
    const place = (add, p, [type, x, z, fields]) => {
        const { tag, ...rest } = fields || {};
        const e = add(p, type, x, z, rest);
        // A finished trainer offers what its owner's age allows, as one completed in
        // play does (Game.completeConstruction); a board otherwise has idle barracks.
        if (!e.underConstruction && typeof realm.context.getTrainOptionsForBuilding === 'function' && !e.isWonder) {
            const opts = realm.context.getTrainOptionsForBuilding(type, p.age, p.civilization);
            if (opts && opts.length) e.trainOptions = Array.from(opts);
        }
        if (tag != null) {
            if (realm.tags[tag]) throw new Error('createMatch: tag used twice: ' + tag);
            realm.tags[tag] = e;
        }
    };
    config.seats.forEach((s, i) => {
        const p = realm.seats[i];
        if (s.age) p.age = s.age;
        for (const b of s.buildings || []) place((...a) => realm.addBuilding(...a), p, b);
        for (const u of s.units || []) place((...a) => realm.addUnit(...a), p, u);
        for (const t of s.techs || []) p.researchedTechs[t] = true;
        if (s.resources) Object.assign(p.resources, s.resources);
        p.resources.updatePopulation(p.units.length);
    });
    return realm;
}

module.exports = { Realm, createMatch, createRuntime, inert, ruleFiles, RULE_FILES, FRAME_MS, ROOT };
