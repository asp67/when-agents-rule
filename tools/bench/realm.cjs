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
// so the engine the tests pin is the engine the bench scores. Since b1091 the stage
// itself -- the runtime, the stand-ins, the board, the snapshot -- lives in
// js/bench-core.js, which the browser's benchmark worker loads too; this file is the
// Node host around it: a VM context per realm.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const W = require('../../js/bench-core.js');
const ROOT = path.resolve(__dirname, '../..');
// Line endings normalized: a Windows checkout has CRLF.
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8').split('\r\n').join('\n');

const FRAME_MS = 16;

const { createRuntime, inert } = W;

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
        this.rafQueue = [];
        const context = vm.createContext(W.stageGlobals(this, { hidden }));
        vm.runInContext('globalThis.window = globalThis', context);
        // Whole files: browser start-up lives in js/boot.js, so nothing is cut.
        for (const file of ruleFiles(sources)) vm.runInContext(sources ? sources[file] : read(file), context, { filename: file });
        this.context = context;
        this.game = W.makeGame(this, normalSpeed);
    }

    // The realm interface js/bench-core.js works on: code evaluated in the rules' own
    // global, and values lent to it.
    exec(code) { return vm.runInContext(code, this.context); }
    lend(values) { Object.assign(this.context, values); }

    // The arena start path itself (Game._startArenaFromSetup), with a match spec.
    async startArena({ seats, seed, difficulty = 'easy', mapSize = 800 }) {
        const setup = seats.map(s => (typeof s === 'string' ? { civ: s, type: 'ki' } : s));
        const started = this.game._startArenaFromSetup({ setup, seed, difficulty, mapSize, turnBased: false });
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
    startFixture(civs, mapSeed = null) { return W.startFixture(this, civs, mapSeed); }

    // A model seat with no model, moved only by scripted commands (WarBench.scripted).
    scripted(ai) { return W.scripted(this, ai); }

    // A command through the models' own executor, as a tool call would arrive.
    command(controller, action, params) {
        const mgr = this.game.openAIAIManager;
        mgr.executeAction(controller, { action, params });
        return controller.seat.lastActionResult;
    }

    addUnit(ai, type, x, z, fields = {}) { return W.addUnit(this, ai, type, x, z, fields); }
    addBuilding(ai, type, x, z, fields = {}) { return W.addBuilding(this, ai, type, x, z, fields); }

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
    // steps, no frames at all -- how the bench advances a scenario between turns.
    advance(ms) { return W.advance(this, ms); }

    // Everything the rules decide, projected to plain data (WarBench.snapshot).
    snapshot() { return W.snapshot(this); }

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
        await realm.startArena({ seats: config.seats, seed: config.seed, difficulty: config.difficulty, mapSize: config.mapSize });
        realm.seats = Array.from(realm.game.aiManager.aiPlayers);
        return realm;
    }
    if (config.kind !== 'board') throw new Error('createMatch: unknown kind ' + config.kind);
    return W.setupBoard(realm, config);
}

module.exports = { Realm, createMatch, createRuntime, inert, ruleFiles, RULE_FILES, FRAME_MS, ROOT };
