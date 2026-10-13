// ---------------------------------------------------------------------------
// WAR Bench, the shared core (b1091). Everything a benchmark scenario is made of that
// does not depend on where it runs: the scenario language (war-scenario-v1), its
// variants and predicates, the frozen stage a scenario plays on, the round loop, the
// model seat, the baselines, the outcome taxonomy, the scoring and the statistics.
//
// Two hosts load this one file. Node (tools/bench/*.cjs) requires it; the browser's
// Benchmark page and its worker (js/bench-worker.js) load it as a script. A result
// recorded in either is therefore scored by the same code, and a run recorded in the
// browser verifies with `war-bench verify` exactly as a Node run does.
//
// A REALM is the world a scenario plays in, built by the host:
//   realm.exec(code)   evaluate in the rules' own global (a VM context in Node, the
//                      worker's global in the browser) -- how classes are reached,
//                      since a class declaration is not a property of any global
//   realm.lend(obj)    give the rules' global these values (fetch, timers)
//   realm.runtime      createRuntime(seed): the seeded Math.random and stepped clock
//   realm.rafQueue     the animation-frame callbacks the rules asked for
//   realm.presentation the inert stand-ins' call counts
//   realm.seed
// Everything else a realm does is done by the functions below, on that interface.
// ---------------------------------------------------------------------------
var WarBench = (function () {
'use strict';

const SCHEMA = 'war-scenario-v1';
const ROUND_MS = 10000;
// How long a seat may take to answer one round: the declared ceiling of the protocol.
// It is told to the seat (clock.secondsToAnswer) and enforced exactly (the request is
// aborted at it); an answer that misses it is an empty round, never a retry.
const CEILING_MS = 120000;
// The most a scenario that ran out of time can earn (b1091, asp67): the advantage it
// built, never a win.
const PARTIAL_CAP = 0.9;

// ---- The stage -------------------------------------------------------------------
// The two inputs a browser cannot hold still -- Math.random and the clock -- replaced
// by a seeded generator and a stepped clock. An LCG, as in the Platform's headless
// runtime: tiny, fast, fully specified.
function createRuntime(seed, RealMath = Math, RealDate = Date) {
    let state = seed >>> 0, elapsed = 0, draws = 0;
    const epoch = 1700000000000;
    const math = Object.create(RealMath);
    math.random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; draws++; return state / 4294967296; };
    class ClockDate extends RealDate {
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

// The globals the rules find before they load: the runtime's Math and clock, a page
// that is never drawn, and storage that keeps nothing.
function stageGlobals(realm, { hidden = false } = {}) {
    const rt = realm.runtime, calls = realm.presentation;
    // Fog of war paints a canvas; its pixel buffers are real, so any rule that reads
    // fog back reads what it wrote.
    const ctx2d = () => inert('canvas2d', calls, {
        createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
        getImageData: (x, y, w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
        createLinearGradient: () => inert('gradient', calls),
        createRadialGradient: () => inert('gradient', calls),
    });
    const element = () => inert('element', calls, { style: {}, classList: inert('classList', calls), dataset: {},
        width: 0, height: 0, getContext: ctx2d });
    return {
        Math: rt.Math, Date: rt.Date, performance: { now: () => rt.now() },
        console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
        document: inert('document', calls, { hidden, getElementById: element, querySelector: element,
            querySelectorAll: () => [], createElement: element, body: element() }),
        localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        requestAnimationFrame: cb => { realm.rafQueue.push(cb); return realm.rafQueue.length; },
        t: key => key,
    };
}

// The game, once the rules have loaded: the real Game, with the renderer, the UI and
// the sound as inert stand-ins.
function makeGame(realm, normalSpeed = 1) {
    const calls = realm.presentation;
    realm.exec('Game.NORMAL_SIM_SPEED = ' + Number(normalSpeed));
    // game.js declares the global `game` itself (a lexical binding), so it is assigned
    // inside the rules' global; a property set from outside would be shadowed.
    const g = realm.exec('game = new Game(); game');
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
        // As the real one does at every match start. Rules read these lists (a new id
        // is checked against the living entities), so a second match in one page would
        // otherwise meet the last match's entities in them.
        clearScene: () => { units.length = 0; buildings.length = 0; },
    });
    g.ui = inert('ui', calls);
    g.terrain = realm.exec('new TerrainManager(null, 800)');
    g.aiManager = realm.exec('new AIManager(game)');
    return g;
}

// A flat, featureless board for scripted fights: no nodes, no coast. `mapSeed` keys
// every random draw of the match; by default one per realm seed.
function startFixture(realm, civs, mapSeed = null) {
    const g = realm.game;
    g.spectatorMode = true;
    // As the real start does, before anything is placed or ordered: it resets the
    // standing orders and unit handles, and done lazily by the first tick it would wipe
    // orders already given.
    g.mapSeed = mapSeed != null ? String(mapSeed) : 'fixture-' + realm.seed;
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
    g.openAIAIManager = realm.exec('new OpenAIAIManager(game)');
    g.fogOfWar = realm.exec('new FogOfWarManager(game)');
    g.lastFrameTime = realm.runtime.Date.now();
    g.gameStarted = true;
    realm.rafQueue.push(() => g.gameLoop());
    return g.aiManager.aiPlayers;
}

// A model seat with no model: the rule-based brain leaves it alone, and the harness's
// per-tick seat work (discovery, attack reports, defeat) runs for it as for any model
// seat. It is PAUSED, the spectator's own switch, so it is never asked for a turn; it
// moves only by the commands given to it.
function scripted(realm, ai) {
    const mgr = realm.game.openAIAIManager;
    realm.game.aiManager.markAsOpenAIControlled(ai.id);
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

function addUnit(realm, ai, type, x, z, fields = {}) {
    const u = realm.exec('createUnit')(type, x, z, ai.id, ai.civilization, ai.age);
    if (!u) throw new Error('unknown unit ' + type);
    Object.assign(u, fields);
    ai.units.push(u);
    ai.resources.updatePopulation(ai.units.length);
    realm.game.renderer.addUnit(u);
    return u;
}

function addBuilding(realm, ai, type, x, z, fields = {}) {
    const b = realm.exec('createBuilding')(type, x, z, ai.id, ai.civilization, { age: ai.age });
    if (!b) throw new Error('unknown building ' + type);
    Object.assign(b, fields);
    ai.buildings.push(b);
    realm.game.renderer.addBuilding(b);
    if (realm.game.recomputeMaxPopulation) realm.game.recomputeMaxPopulation(ai);
    return b;
}

// The frozen driver: exactly `ms` of simulated time in 50 ms steps, no frames at all --
// how a scenario advances between rounds. The runtime clock moves with it, so anything
// the harness stamps in wall time agrees.
function advance(realm, ms) {
    // Refused before anything moves: a clock stepped for a call the rules then refuse
    // would leave the two disagreeing.
    if (!Number.isInteger(ms / 50) || ms < 0) throw new RangeError('advance takes a whole number of 50 ms steps, got ' + ms);
    realm.runtime.advance(ms);
    return realm.game.advanceSim(ms);
}

// Everything the rules decide, projected to plain data. Floats are kept exact: a trace
// that rounds would let a drift hide until it changed an outcome.
function snapshot(realm) {
    const g = realm.game;
    const ref = v => (v && (v.id || v.handle)) || null;
    const fields = ['id', 'type', 'x', 'z', 'health', 'maxHealth', 'task', 'isMoving', 'isAttacking',
        'targetX', 'targetZ', 'attackTimer', 'carryingResource', 'harvestAmount', 'buildProgress',
        'underConstruction', 'isProducing', 'productionType', 'productionProgress', 'foodAmount'];
    const project = e => Object.assign(Object.fromEntries(fields.filter(k => e[k] !== undefined).map(k => [k, e[k]])),
        { attackTarget: ref(e.attackTarget), harvestTarget: ref(e.harvestTarget), buildTarget: ref(e.buildTarget) });
    return JSON.parse(JSON.stringify({
        clock: realm.runtime.state(),
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

// A board: two seats with exactly the entities given. fields.tag names an entity for
// whoever set the board up (a scenario's predicates and commands); it is kept in
// realm.tags, never written onto the entity. Every seat is a scripted model seat.
function setupBoard(realm, config) {
    const players = startFixture(realm, config.seats.map(s => s.civ), config.seed);
    realm.seats = Array.from(players);
    realm.controllers = realm.seats.map(p => scripted(realm, p));
    realm.tags = {};
    const trainOptions = realm.exec('typeof getTrainOptionsForBuilding === "function" ? getTrainOptionsForBuilding : null');
    const place = (add, p, [type, x, z, fields]) => {
        const { tag, ...rest } = fields || {};
        const e = add(p, type, x, z, rest);
        // A finished trainer offers what its owner's age allows, as one completed in
        // play does (Game.completeConstruction); a board otherwise has idle barracks.
        if (!e.underConstruction && trainOptions && !e.isWonder) {
            const opts = trainOptions(type, p.age, p.civilization);
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
        for (const b of s.buildings || []) place((...a) => addBuilding(realm, ...a), p, b);
        for (const u of s.units || []) place((...a) => addUnit(realm, ...a), p, u);
        for (const t of s.techs || []) p.researchedTechs[t] = true;
        if (s.resources) Object.assign(p.resources, s.resources);
        p.resources.updatePopulation(p.units.length);
    });
    return realm;
}

// ---- The scenario language ---------------------------------------------------------
// war-scenario-v1: one JSON file per scenario, under benchmarks/scenarios/<family>/<id>.json:
//
//   schema      "war-scenario-v1"
//   id, family, title
//   objective   what the model is told, in place of the default prompt's victory
//               paragraph (OpenAIAIManager.scenarioSystemPrompt). {{tag.x}}, {{tag.z}},
//               {{point:name.x}} and {{point:name.z}} are replaced by positions AFTER the
//               variant's transform, so the text always matches the board.
//   rounds      how many rounds the subject gets: the scenario's game-time limit. A
//               round is: observe, decide, execute, then exactly ROUND_MS of simulated
//               time (the frozen driver).
//   board       a board config (setupBoard); seat 0 is the SUBJECT (the seat scored),
//               seat 1 the RIVAL. Entities may carry fields.tag to be named below.
//   points      named places: {"ford": [0, 0]}.
//   rival       the rival's orders: [{round, action, params}], run through the same
//               executor a model's commands go through.
//   success     {when: "any" | "end", predicate}: "any" ends the episode the first time
//               the predicate holds after a round; "end" asks only after the last.
//   failure     optional predicate; true after any round ends the episode failed.
//   invariant   optional {from, predicate}: must hold after every round from `from` on.
//   partial     optional measure (b1091): when the episode runs out of time -- its
//               rounds, or the run's wall-clock limit -- without success and without
//               failing, it scores this measure of the advantage built, from 0 up to
//               PARTIAL_CAP: never a win. Without a measure, or at 0, it failed.
//   graded      (b1093) instead of success: a measure of HOW the subject played, scored
//               when the episode ends -- for a task whose result is luck, like finding
//               something in the fog. The outcome is "graded" and the score is the
//               measure, 0 to 1. Its `parts` are kept per episode, so the report can say
//               which part of the play was weak. `success` is then optional.
//   until       optional predicate (b1093): the episode ends after the first round it
//               holds -- a search ends when the thing is found, and the play that found
//               it is graded on the rounds it took.
//   notes       optional {name: predicate} (b1093): recorded, never scored -- the first
//               round each held, or null. "Did it find the camp" is a note.
//   variants    names from VARIANTS (the square's eight symmetries).
//   reference   a proven solution, [{round, commands: [{action, params}]}]. Tests play it
//               in every variant and require success; they also require that doing
//               nothing fails, so no scenario is solved by standing still.
//
// Explore orders name map tiles, not coordinates: a board is the 800 map, 7 x 7 tiles
// (BOARD_TILES), and a variant moves a tile label with its centre, so a reference
// solution's route turns with the board.
//
// Everything is data: predicates and measures are a small closed JSON language
// evaluated here, never code, so a scenario can be read, diffed and checked without
// running anything.

// The eight symmetries of the square map. A variant moves every coordinate in the
// scenario the same way -- entities, points, rival orders, predicates, reference -- so
// it is the same problem seen from another side.
const VARIANTS = Object.freeze({
    identity: (x, z) => [x, z],
    rot90: (x, z) => [-z, x],
    rot180: (x, z) => [-x, -z],
    rot270: (x, z) => [z, -x],
    mirrorX: (x, z) => [-x, z],
    mirrorZ: (x, z) => [x, -z],
    diagonal: (x, z) => [z, x],
    antidiagonal: (x, z) => [-z, -x],
});

const BOARD_TILES = 7;
const OPS = ['>=', '>', '==', '<', '<=', '!='];
const OWNERS = ['subject', 'rival'];
function tagOf(s, tag) {
    for (const seat of s.board.seats) for (const e of [...(seat.units || []), ...(seat.buildings || [])])
        if (e[3] && e[3].tag === tag) return e;
    return null;
}
function checkCount(c, where, s, fail) {
    if (!c || typeof c !== 'object') fail(where + ': count takes an object');
    if (!OWNERS.includes(c.owner)) fail('count.owner is subject or rival');
    if (!['unit', 'building'].includes(c.kind)) fail('count.kind is unit or building');
    const bad = Object.keys(c).filter(k => !['owner', 'kind', 'type', 'class', 'near'].includes(k));
    if (bad.length) fail('unknown count keys ' + bad.join(', '));
    if (c.near) {
        const n = c.near;
        if (!(n.r > 0)) fail('near needs a radius r');
        if (n.point != null ? !(s.points && s.points[n.point]) : n.tag != null ? !tagOf(s, n.tag) : !(Number.isFinite(n.x) && Number.isFinite(n.z)))
            fail('near needs a known point, a known tag, or x and z');
    }
}
function checkPredicate(p, where, s) {
    const fail = msg => { throw new Error(`${s.id}: ${where}: ${msg}`); };
    if (!p || typeof p !== 'object' || Array.isArray(p)) fail('a predicate is an object');
    const keys = Object.keys(p);
    if (keys.length !== 1 && !('count' in p)) fail('one operator per predicate: ' + keys.join(', '));
    if ('all' in p || 'any' in p) {
        const list = p.all || p.any;
        if (!Array.isArray(list) || !list.length) fail('all/any take a non-empty list');
        list.forEach((q, i) => checkPredicate(q, `${where}.${'all' in p ? 'all' : 'any'}[${i}]`, s));
    } else if ('not' in p) checkPredicate(p.not, where + '.not', s);
    else if ('destroyed' in p || 'alive' in p) {
        const tag = p.destroyed || p.alive;
        if (!tagOf(s, tag)) fail('unknown tag ' + tag);
    } else if ('eliminated' in p) {
        if (!OWNERS.includes(p.eliminated)) fail('eliminated takes subject or rival');
    } else if ('seen' in p) {
        if (!tagOf(s, p.seen)) fail('unknown tag ' + p.seen);
    } else if ('count' in p) {
        const extra = keys.filter(k => !['count', 'op', 'value'].includes(k));
        if (extra.length) fail('unknown keys ' + extra.join(', '));
        checkCount(p.count, where, s, fail);
        if (!OPS.includes(p.op) || !Number.isFinite(p.value)) fail('count needs op (' + OPS.join(' ') + ') and a numeric value');
    } else fail('unknown operator ' + keys[0]);
}
// Measures (the `partial` and `graded` language), each a number from 0 to 1:
//   {"damage": tag}                     the share of the tagged entity's health gone
//   {"share": count, "of": n}           min(1, count / n), count as in a predicate
//   {"gate": predicate, "then": m}      m while the predicate holds, else 0
//   {"mean": [m, ...]}                  the mean of several
//   {"parts": {name: m, ...}}           the mean of several, each kept by name
//   {"times": [m, ...]}                 the product of several: one counts only as far
//                                       as the other holds (b1095)
// and three that read the episode, not only its last moment (b1093):
//   {"travelShare": {"type"|"class"}}   that kind's share of all the ground the
//                                       subject's units covered; 0 if nothing moved
//   {"exploredRate": n}                 new ground the subject uncovered per round, as a
//                                       share of the map, against n: min(1, rate / n)
//   {"tilesReached": {"min", "perRound"}} map tiles the subject came to see at least
//                                       `min` % of, beyond those it saw at the start, per
//                                       round, against perRound: how far the search went,
//                                       not only how much it saw (b1095, asp67)
//   {"orderShare": {"action", "with"}}  of the subject's orders of that action that
//                                       were carried out, the share whose params carry
//                                       `with` (e.g. explore with "then": a route)
function checkMeasure(m, where, s) {
    const fail = msg => { throw new Error(`${s.id}: ${where}: ${msg}`); };
    if (!m || typeof m !== 'object' || Array.isArray(m)) fail('a measure is an object');
    if ('damage' in m) { if (!tagOf(s, m.damage)) fail('unknown tag ' + m.damage); }
    else if ('share' in m) { checkCount(m.share, where, s, fail); if (!(m.of > 0)) fail('share needs of > 0'); }
    else if ('gate' in m) { checkPredicate(m.gate, where + '.gate', s); checkMeasure(m.then, where + '.then', s); }
    else if ('mean' in m) {
        if (!Array.isArray(m.mean) || !m.mean.length) fail('mean takes a non-empty list');
        m.mean.forEach((x, i) => checkMeasure(x, `${where}.mean[${i}]`, s));
    } else if ('parts' in m) {
        const names = Object.keys(m.parts || {});
        if (!names.length) fail('parts takes at least one named measure');
        names.forEach(k => checkMeasure(m.parts[k], `${where}.parts.${k}`, s));
    } else if ('travelShare' in m) {
        const t = m.travelShare || {};
        if (!t.type === !t.class) fail('travelShare names a type or a class');
    } else if ('times' in m) {
        if (!Array.isArray(m.times) || m.times.length < 2) fail('times takes two or more measures');
        m.times.forEach((x, i) => checkMeasure(x, `${where}.times[${i}]`, s));
    } else if ('tilesReached' in m) {
        const r = m.tilesReached || {};
        if (!(r.min > 0 && r.min <= 100) || !(r.perRound > 0)) fail('tilesReached takes min (percent seen) and perRound');
    } else if ('exploredRate' in m) {
        if (!(m.exploredRate > 0)) fail('exploredRate takes the share of the map per round that scores 1');
    } else if ('orderShare' in m) {
        const o = m.orderShare || {};
        if (typeof o.action !== 'string' || typeof o.with !== 'string') fail('orderShare takes an action and a param name');
    } else fail('unknown measure ' + Object.keys(m)[0]);
}
function validate(s) {
    const fail = msg => { throw new Error(`${s && s.id || '?'}: ${msg}`); };
    if (!s || s.schema !== SCHEMA) fail('schema must be ' + SCHEMA);
    for (const k of ['id', 'family', 'title', 'objective']) if (typeof s[k] !== 'string' || !s[k]) fail('missing ' + k);
    if (!Number.isInteger(s.rounds) || s.rounds < 1 || s.rounds > 60) fail('rounds is 1..60');
    if (!s.board || !Array.isArray(s.board.seats) || s.board.seats.length !== 2) fail('board has two seats: subject, rival');
    if (s.graded) checkMeasure(s.graded, 'graded', s);
    if (s.success || !s.graded) {
        if (!s.success || !['any', 'end'].includes(s.success.when)) fail('success.when is any or end');
        checkPredicate(s.success.predicate, 'success', s);
    }
    if (s.until) checkPredicate(s.until, 'until', s);
    if (s.notes) for (const [k, p] of Object.entries(s.notes)) checkPredicate(p, 'notes.' + k, s);
    if (s.failure) checkPredicate(s.failure, 'failure', s);
    if (s.invariant) {
        if (!Number.isInteger(s.invariant.from)) fail('invariant.from is a round');
        checkPredicate(s.invariant.predicate, 'invariant', s);
    }
    if (s.partial) checkMeasure(s.partial, 'partial', s);
    if (!Array.isArray(s.variants) || !s.variants.length) fail('variants: at least one');
    for (const v of s.variants) if (!VARIANTS[v]) fail('unknown variant ' + v);
    if (!Array.isArray(s.reference) || !s.reference.length) fail('a reference solution is required');
    for (const r of [...s.reference, ...(s.rival || [])]) if (!Number.isInteger(r.round) || r.round < 1 || r.round > s.rounds) fail('an order round is outside 1..rounds');
    const known = new Set(Object.keys(s.points || {}));
    for (const m of s.objective.matchAll(/\{\{(point:)?([A-Za-z0-9_-]+)\.(x|z)\}\}/g))
        if (m[1] ? !known.has(m[2]) : !tagOf(s, m[2])) fail('objective names unknown ' + (m[1] ? 'point ' : 'tag ') + m[2]);
    return s;
}

// A board tile label moved by a variant: column A.. and row 1.. on the board's grid,
// centred on the middle tile, so every symmetry maps a tile onto a tile.
function tileFor(variant, label) {
    const f = VARIANTS[variant], half = (BOARD_TILES - 1) / 2;
    const m = /^([A-Za-z])(\d+)$/.exec(String(label).trim());
    if (!m || !f) return label;
    const [x, z] = f(m[1].toUpperCase().charCodeAt(0) - 65 - half, Number(m[2]) - 1 - half);
    return String.fromCharCode(65 + Math.round(x + half)) + (Math.round(z + half) + 1);
}

// The scenario with every coordinate moved by the variant. Pure data in, data out.
function instantiate(s, variant = 'identity') {
    const f = VARIANTS[variant];
    if (!f) throw new Error('unknown variant ' + variant);
    const c = JSON.parse(JSON.stringify(s));
    const move = e => { const [x, z] = f(e[1], e[2]); e[1] = x; e[2] = z; };
    for (const seat of c.board.seats) { (seat.units || []).forEach(move); (seat.buildings || []).forEach(move); }
    for (const k of Object.keys(c.points || {})) c.points[k] = f(c.points[k][0], c.points[k][1]);
    // A tile label moves with its centre: column A.. and row 1.. on the board's grid,
    // centred on the middle tile, so every symmetry maps a tile onto a tile.
    const half = (BOARD_TILES - 1) / 2;
    const moveTile = label => tileFor(variant, label);
    const moveParams = p => {
        if (p && Number.isFinite(p.targetX) && Number.isFinite(p.targetZ)) [p.targetX, p.targetZ] = f(p.targetX, p.targetZ);
        if (p && typeof p.tile === 'string') p.tile = moveTile(p.tile);
        if (p && p.then != null) p.then = Array.isArray(p.then) ? p.then.map(moveTile) : String(p.then).split(/[^A-Za-z0-9]+/).filter(Boolean).map(moveTile);
    };
    (c.rival || []).forEach(o => moveParams(o.params));
    (c.reference || []).forEach(r => r.commands.forEach(o => moveParams(o.params)));
    const moveCount = n => { if (n && n.near && Number.isFinite(n.near.x)) [n.near.x, n.near.z] = f(n.near.x, n.near.z); };
    const movePred = p => {
        if (!p || typeof p !== 'object') return;
        moveCount(p.count);
        for (const k of ['all', 'any']) if (p[k]) p[k].forEach(movePred);
        if (p.not) movePred(p.not);
    };
    const moveMeasure = m => {
        if (!m || typeof m !== 'object') return;
        moveCount(m.share);
        if (m.gate) { movePred(m.gate); moveMeasure(m.then); }
        if (m.mean) m.mean.forEach(moveMeasure);
        if (m.parts) Object.values(m.parts).forEach(moveMeasure);
        if (m.times) m.times.forEach(moveMeasure);
    };
    if (c.success) movePred(c.success.predicate);
    movePred(c.failure); if (c.invariant) movePred(c.invariant.predicate);
    movePred(c.until); for (const p of Object.values(c.notes || {})) movePred(p);
    moveMeasure(c.partial); moveMeasure(c.graded);
    c.variant = variant;
    return c;
}

function countOf(c, w) {
    const owner = w.seat(c.owner);
    let list = Array.from(c.kind === 'unit' ? owner.units : owner.buildings).filter(e => e.health > 0);
    if (c.type) list = list.filter(e => e.type === c.type);
    if (c.class === 'military') list = list.filter(e => e.type !== 'worker' && e.unitType !== 'support');
    else if (c.class === 'worker') list = list.filter(e => e.type === 'worker');
    else if (c.class) list = list.filter(e => e.unitType === c.class);
    if (c.near) {
        const at = c.near.point != null ? { x: w.points[c.near.point][0], z: w.points[c.near.point][1] }
            : c.near.tag != null ? w.tags[c.near.tag] : c.near;
        list = list.filter(e => Math.hypot(e.x - at.x, e.z - at.z) <= c.near.r);
    }
    return list.length;
}
function gone(e, w) {
    if (!e) return true;
    if (!(e.health > 0)) return true;
    const owners = [w.seat('subject'), w.seat('rival')];
    return !owners.some(o => o.units.includes(e) || o.buildings.includes(e));
}
// Has the subject ever had this entity's ground in sight? Read off the exploration
// bitmap the game keeps for every player (Game.markExploration), the same one the
// state's map.exploration is made of.
function seenBy(owner, e, w) {
    if (!e || !owner || !owner._explored) return false;
    const g = w.game, G = g.EXPLORE_GRID, size = (g.terrain && g.terrain.size) || 800, cell = size / G;
    const gx = Math.floor((e.x + size / 2) / cell), gz = Math.floor((e.z + size / 2) / cell);
    return gx >= 0 && gx < G && gz >= 0 && gz < G && owner._explored[gz * G + gx] === 1;
}
// The share of the map a player has ever seen: its exploration bitmap, counted.
function exploredShare(owner) {
    const grid = owner && owner._explored;
    if (!grid || !grid.length) return 0;
    let n = 0;
    for (let i = 0; i < grid.length; i++) n += grid[i];
    return n / grid.length;
}
// Where the subject's living units stand: one entry per round edge of the trace.
function positions(owner) {
    return Array.from(owner.units).filter(u => u.health > 0).map(u => ({ id: u.id, type: u.type, cls: u.unitType, x: u.x, z: u.z }));
}

function evaluate(p, w) {
    if (p.all) return p.all.every(q => evaluate(q, w));
    if (p.any) return p.any.some(q => evaluate(q, w));
    if (p.not) return !evaluate(p.not, w);
    if (p.destroyed != null) return gone(w.tags[p.destroyed], w);
    if (p.alive != null) return !gone(w.tags[p.alive], w);
    if (p.eliminated) return !!w.game.isPlayerEliminated(w.seat(p.eliminated));
    if (p.seen != null) return seenBy(w.seat('subject'), w.tags[p.seen], w);
    if (p.count) {
        const n = countOf(p.count, w), v = p.value;
        return { '>=': n >= v, '>': n > v, '==': n === v, '<': n < v, '<=': n <= v, '!=': n !== v }[p.op];
    }
    throw new Error('unknown predicate');
}
function measure(m, w) {
    const clamp = v => Math.max(0, Math.min(1, v));
    if (m.damage != null) {
        const e = w.tags[m.damage];
        if (gone(e, w)) return 1;
        return clamp(1 - e.health / (e.maxHealth || e.health || 1));
    }
    if (m.share) return clamp(countOf(m.share, w) / m.of);
    if (m.gate) return evaluate(m.gate, w) ? measure(m.then, w) : 0;
    if (m.mean) return m.mean.reduce((a, x) => a + measure(x, w), 0) / m.mean.length;
    if (m.parts) { const v = Object.values(measureParts(m, w)); return v.reduce((a, b) => a + b, 0) / v.length; }
    if (m.travelShare) {
        const want = m.travelShare;
        let all = 0, mine = 0;
        for (let i = 1; i < (w.trace || []).length; i++) {
            const before = new Map(w.trace[i - 1].map(u => [u.id, u]));
            for (const u of w.trace[i]) {
                const b = before.get(u.id);
                if (!b) continue;
                const d = Math.hypot(u.x - b.x, u.z - b.z);
                all += d;
                if (want.type ? u.type === want.type : u.cls === want.class) mine += d;
            }
        }
        return all > 0 ? clamp(mine / all) : 0;
    }
    if (m.times) return m.times.reduce((a, x) => a * measure(x, w), 1);
    if (m.tilesReached) {
        const rounds = w.rounds || 0;
        if (!rounds) return 0;
        const { min, perRound } = m.tilesReached;
        const now = w.game.explorationSummary(w.seat('subject'));
        let n = 0;
        now.forEach((row, r) => row.forEach((p, c) => { if (p >= min && !(w.tiles0 && w.tiles0[r][c] >= min)) n++; }));
        return clamp(n / rounds / perRound);
    }
    if (m.exploredRate) {
        const rounds = w.rounds || 0;
        if (!rounds) return 0;
        return clamp((exploredShare(w.seat('subject')) - (w.explored0 || 0)) / rounds / m.exploredRate);
    }
    if (m.orderShare) {
        const { action, with: key } = m.orderShare;
        let done = 0, carrying = 0;
        for (const e of w.log || []) for (const o of e.outcomes || []) {
            if (o.action !== action || o.verdict !== 'ok') continue;
            const c = (e.commands || [])[o.n - 1];
            if (!c || c.action !== action) continue;
            done++;
            const v = c.params && c.params[key];
            if (v != null && !(Array.isArray(v) && !v.length) && String(v).trim() !== '') carrying++;
        }
        return done ? carrying / done : 0;
    }
    throw new Error('unknown measure');
}
// A parts measure, each part by name, rounded as scores are.
function measureParts(m, w) {
    const out = {};
    for (const [k, x] of Object.entries(m.parts)) out[k] = Math.round(measure(x, w) * 1000) / 1000;
    return out;
}

// The objective text with its placeholders filled from the board as it now stands.
function objectiveText(inst, tags) {
    return inst.objective.replace(/\{\{(point:)?([A-Za-z0-9_-]+)\.(x|z)\}\}/g, (m, isPoint, name, axis) => {
        const v = isPoint ? inst.points[name][axis === 'x' ? 0 : 1] : tags[name][axis];
        return String(Math.round(v));
    });
}
// {"$id": "tag"} anywhere in params becomes that entity's id.
function resolve(v, tags) {
    if (Array.isArray(v)) return v.map(x => resolve(x, tags));
    if (v && typeof v === 'object') {
        if (typeof v.$id === 'string') {
            if (!tags[v.$id]) throw new Error('unknown tag ' + v.$id);
            return tags[v.$id].id;
        }
        return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolve(x, tags)]));
    }
    return v;
}

// ---- The outcome taxonomy ----------------------------------------------------------
// Every outcome code the harness can give a command (log.out.* in js/openai-ai.js, plus
// the parser's own), in one of six classes. Scores and baselines read this table and
// nothing else; tests/bench-taxonomy.test.cjs holds it to the harness both ways --
// every code the harness can emit is here, and every code here still exists.
//
//   done        the command took effect
//   constraint  a well-formed command the world refused: cannot afford, busy, a
//               prerequisite missing, nobody free to do it. A legal move, badly timed.
//   contended   refused for something no snapshot could have forewarned
//               (OpenAIAIManager.UNFOREWARNED): the state was true when read.
//   reference   the command named something that is not there or cannot be meant: an
//               unknown unit, tech, building or target, a selection matching nothing,
//               a malformed call. The random-valid baseline must never earn one.
//   harness     the harness failed, not the seat
//   meta        not a command's outcome: log lines about lanes, rounds and healing
const CLASSES = Object.freeze({
    done: ['ageUpStarted', 'assignQueued', 'attackDispatched', 'attackEngaging', 'attackMarching', 'attackMoving',
        'buildStarted', 'deleted', 'destroyed', 'exploreSent', 'moveUnits', 'reassigned', 'repairStarted',
        'researchStarted', 'trainUnit'],
    constraint: ['alreadyResearched', 'alreadyResearching', 'alreadyUpgrading', 'alreadyWonder', 'assignFromBusy', 'commandLimit',
        'assignFromEmpty', 'assignIdleTaken', 'buildNeedsTech', 'buildingCannotTrainTier', 'buildingNeedsAge',
        'buildingUnderConstr', 'cannotAfford', 'exploreAlreadySent', 'farmAllManned', 'farmManned', 'farmUnderConstr',
        'laneDuplicateAge', 'laneDuplicateBuilding', 'laneDuplicateTech', 'maxAge', 'missingPrereq',
        'noBuildingDestroy', 'noBuildingTrains', 'noDamagedNear', 'noFinishedFarms', 'noMilitaryAttack',
        'noMilitaryMove', 'noTCPlacement', 'noTCTrain', 'noTCWorkers', 'noUnitDelete', 'noUnitExplore',
        'noWorkersBuild', 'noWorkersForFarms', 'noWorkersReassign', 'noWorkersRepair', 'noWorkersScouting', 'notDiscovered',
        'nothingToRepair', 'populationHardCap', 'populationLimit', 'refuseDestroyLastTC', 'repairFailed',
        'researchedElsewhere', 'techNeedsAge', 'unitBuildingNotBuilt', 'unitBuildingNotUnlocked', 'unitNeedsAge', 'unitNeedsTech'],
    contended: ['assignAllCarrying', 'assignFromRaced', 'assignIdleFighting', 'assignIdleRaced', 'laneResearchBusy',
        'noClearSpot', 'noWorkerIdleBuild', 'orderedUnitsGone', 'targetGone', 'trainerBusy'],
    reference: ['assignBadCarry', 'assignBadFrom', 'assignBadSpill', 'assignFromSame', 'assignNeedsCoords',
        'assignNeedsResource', 'attackNeedsCoords', 'attackNoMatch', 'civCannotBuild', 'civCannotTrain',
        'exploreBadTile', 'exploreNeedsTile', 'exploreRouteTooLong', 'farmNeedsCoords', 'moveBadMode', 'moveNeedsCoords', 'moveNoMatch',
        'notAResearchTech', 'notACommand', 'offMap', 'renamedBuilding', 'repairNeedsCoords', 'targetIsOwn',
        'targetNotFound', 'targetOutOfSight', 'techIsBuilding', 'unknownBuilding', 'unknownTech', 'unknownUnit', 'unparsedCall', 'rawToolMarkup'],
    harness: ['executionFailed'],
    meta: ['healDropped', 'healStripped', 'laneDropped', 'roundMissed'],
});
const CLASS_OF = Object.freeze(Object.fromEntries(
    Object.entries(CLASSES).flatMap(([cls, codes]) => codes.map(c => [c, cls]))));
// The class of one recorded outcome ({code, verdict} as takeOutcomes returns it). A
// rejection that carries no code is 'uncoded': the harness refused it without saying
// why in its own vocabulary, which the taxonomy check counts rather than hides.
function classify(outcome) {
    if (!outcome) return 'uncoded';
    if (outcome.code && CLASS_OF[outcome.code]) return CLASS_OF[outcome.code];
    if (outcome.verdict === 'ok') return 'done';
    return outcome.code ? 'unknown:' + outcome.code : 'uncoded';
}

// ---- Episodes ----------------------------------------------------------------------
// A fresh episode of `scenario` in `variant`: the started realm, both seats and a world
// view for the predicates. Nothing has been observed or ordered yet. `makeRealm()` is
// the host's: a new, empty realm with the rules loaded and the game made.
//
// The protocol is turn-based lockstep with ROUND_MS slices, and the seat's state says
// so exactly as an arena lockstep seat's does (clock.secondsToAnswer from the ceiling,
// clock.worldSecondsPerRound). The slice budget is unbounded here because the episode
// itself drives the world, a round at a time, through the frozen stepper.
function begin(scenario, variant, { makeRealm, ceilingMs = CEILING_MS } = {}) {
    const inst = instantiate(scenario, variant);
    const realm = setupBoard(makeRealm(), Object.assign({ seed: inst.board.seed || inst.id }, inst.board));
    const mgr = realm.game.openAIAIManager;
    mgr.turnBased = true;
    mgr.roundTimeoutMs = () => ceilingMs;
    mgr.requestAbortMs = () => ceilingMs;
    realm.game._lockstep = { sliceMs: ROUND_MS, budget: Infinity };
    const [subject, rival] = realm.seats, [cs, cr] = realm.controllers;
    const world = { game: realm.game, tags: realm.tags, points: inst.points || {},
        seat: who => (who === 'subject' ? subject : rival),
        // What the episode-reading measures read (b1093): the subject's units at every
        // round edge, the rounds played with their orders, and the ground it could see
        // before the first one -- computed on a stand-in, so nothing in the world moves.
        trace: [positions(subject)], log: [], rounds: 0, explored0: 0, tiles0: null };
    if (realm.game.markExploration) {
        const shim = { units: subject.units, buildings: subject.buildings };
        realm.game.markExploration(shim);
        world.explored0 = exploredShare(shim);
        world.tiles0 = realm.game.explorationSummary(shim);
    }
    return { inst, realm, mgr, subject, rival, subjectController: cs, rivalController: cr, world,
        objective: objectiveText(inst, realm.tags), ceilingMs };
}

// An episode's score: 1 for success, the partial measure for one that ran out of time,
// 0 for failure.
function episodeScore(r) { return r.outcome === 'success' ? 1 : (r.outcome === 'partial' || r.outcome === 'graded') ? r.score : 0; }

// Play one episode. `policy(turn)` returns the subject's answer for a round -- a list of
// commands, or a whole envelope ({commands, objective, plan}) as a model's reply parses
// to, or null for no answer -- where turn = {round, state, episode} and state is exactly
// what a model would be sent this round (observed and committed, as a model turn does).
// Returns the outcome, its score and a per-round log: what was ordered, what the
// executor answered, what held afterwards.
//
// options: makeRealm (required), ceilingMs, onRoundEnd(entry, episode) after each
// round's step (bundles record the world's hash there), and stopAfter: the number of
// rounds a run's wall-clock limit allowed, or null -- a stopped episode is scored as one
// that ran out of rounds there.
async function play(scenario, variant, policy, options = {}) {
    const { onRoundEnd = null, stopAfter = null, shouldStop = null, ...beginOptions } = options;
    const ep = begin(scenario, variant, beginOptions);
    const { inst, realm, mgr, subjectController: cs, rivalController: cr, world } = ep;
    const log = [];
    // Each command's outcome code, as the executor drains it for the transcript. Read
    // by wrapping the drain on this episode's manager; nothing it does changes.
    let heard = [];
    const take = mgr.takeOutcomes.bind(mgr);
    mgr.takeOutcomes = c => { const list = take(c); if (c === cs) heard.push(...list); return list; };
    let outcome = null, round = 0, stopped = null, ended = false;
    const notes = inst.notes ? Object.fromEntries(Object.keys(inst.notes).map(k => [k, null])) : null;
    for (round = 1; round <= inst.rounds && !outcome && !ended; round++) {
        if (stopAfter != null && round > stopAfter) { stopped = 'time'; break; }
        if (shouldStop && shouldStop(round)) { stopped = 'time'; break; }
        const state = mgr.buildGameStateJSON(cs);
        const answer = await policy({ round, state, episode: ep });
        const envelope = Array.isArray(answer) ? { commands: resolve(answer, realm.tags) } : (answer || { commands: [] });
        const commands = Array.isArray(envelope.commands) ? envelope.commands : [];
        const rivalOrders = (inst.rival || []).filter(o => o.round === round).map(o => resolve(o, realm.tags));
        // The two seats act in an order that rotates by round, as turn-based rounds do,
        // so neither side always moves first.
        const entry = { round, commands, results: null, rival: [] };
        const subjectActs = () => {
            if (!commands.length && envelope.objective === undefined && envelope.plan === undefined) { entry.results = null; return; }
            cs.lastActionResult = null;
            heard = [];
            mgr.executeTurn(cs, envelope);
            entry.results = cs.lastActionResult;
            entry.outcomes = heard.map(o => ({ n: o.n, action: o.action, code: o.code, verdict: o.verdict, class: classify(o) }));
        };
        const rivalActs = () => { for (const o of rivalOrders) { mgr.executeAction(cr, { action: o.action, params: o.params }); entry.rival.push(cr.lastActionResult); } };
        if (round % 2) { rivalActs(); subjectActs(); } else { subjectActs(); rivalActs(); }
        // The round's decision-log entries, held per seat in lockstep, go in now -- the
        // first half of flushRound, whose second half (running queued answers) the
        // episode has just done itself.
        for (const c of [cs, cr]) for (const k of ['pendingControl', 'pendingLog']) {
            if (c[k] && c[k].length) { for (const e of c[k]) mgr.commitDecision(e); c[k] = []; }
        }
        advance(realm, ROUND_MS);
        entry.simMs = realm.game.clock.simMs;
        world.trace.push(positions(ep.subject));
        world.log.push(entry);
        world.rounds = round;
        if (notes) for (const [k, p] of Object.entries(inst.notes)) if (notes[k] == null && evaluate(p, world)) notes[k] = round;
        if (inst.failure && evaluate(inst.failure, world)) outcome = 'failure';
        else if (inst.invariant && round >= inst.invariant.from && !evaluate(inst.invariant.predicate, world)) outcome = 'failure';
        else if (inst.success && inst.success.when === 'any' && evaluate(inst.success.predicate, world)) outcome = 'success';
        else if (inst.until && evaluate(inst.until, world)) ended = true;
        else if (!realm.game.gameStarted) {
            // The match ended on its own (a seat eliminated): judged now, or graded.
            if (inst.success) outcome = evaluate(inst.success.predicate, world) ? 'success' : 'failure';
            ended = true;
        }
        entry.after = outcome || 'running';
        log.push(entry);
        if (onRoundEnd) onRoundEnd(entry, ep);
    }
    // Out of time: the rounds are spent, or the run's clock stopped the episode. An
    // "end" scenario is judged now as it always was -- unless the clock cut it short,
    // when its last round never came. Anything not won scores the advantage it built.
    // A graded scenario is scored on how it was played, however it ended -- out of
    // rounds, out of time, or `until` -- unless it failed outright.
    let partial = 0, graded = null, parts = null;
    if (!outcome && inst.graded) {
        outcome = 'graded';
        graded = measure(inst.graded, world);
        if (inst.graded.parts) parts = measureParts(inst.graded, world);
    } else if (!outcome) {
        if (!stopped && evaluate(inst.success.predicate, world)) outcome = 'success';
        else {
            partial = inst.partial ? Math.min(PARTIAL_CAP, measure(inst.partial, world)) : 0;
            outcome = partial > 0 ? 'partial' : 'failure';
        }
    }
    const r = { id: inst.id, family: inst.family, variant: inst.variant, outcome, rounds: log.length, log };
    if (outcome === 'partial') r.score = Math.round(partial * 1000) / 1000;
    if (outcome === 'graded') r.score = Math.round(graded * 1000) / 1000;
    if (parts) r.parts = parts;
    if (notes) r.notes = notes;
    if (stopped) r.stopped = stopped;
    return r;
}

// ---- Policies ----------------------------------------------------------------------
// The scenario's own proven solution, as a policy -- read from the episode's instance,
// whose coordinates the variant has already moved.
const referencePolicy = () => ({ round, episode }) => {
    const r = (episode.inst.reference || []).find(x => x.round === round);
    return r ? r.commands : [];
};
// Doing nothing at all.
const noopPolicy = () => () => [];

// mulberry32 over a string hash: small, fully specified, independent of the realm's RNG.
function rngFor(key) {
    let h = 2166136261;
    for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619); }
    let a = h >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const pick = (r, list) => list[Math.floor(r() * list.length)];
const RESOURCES = ['food', 'wood', 'stone', 'gold'];
const MODES = ['march', 'scout', 'guard', 'patrol'];

// One command built from the state, or null when the chosen kind has nothing to name.
function randomCommand(r, st) {
    const b = (st.map && st.map.bounds) || { minX: -400, maxX: 400, minZ: -400, maxZ: 400 };
    const point = () => ({ targetX: Math.round(b.minX + 20 + r() * (b.maxX - b.minX - 40)),
                           targetZ: Math.round(b.minZ + 20 + r() * (b.maxZ - b.minZ - 40)) });
    const home = (st.map && st.map.yourSpawnArea) || { x: 0, z: 0 };
    const near = () => ({ targetX: Math.round(home.x + (r() - 0.5) * 60), targetZ: Math.round(home.z + (r() - 0.5) * 60) });
    const own = st.friendlyUnits || [];
    const military = own.filter(u => u.type !== 'worker' && u.type !== 'priest');
    // Units in sight only: a remembered one ("visible": false) cannot be named by id.
    const enemies = [...(st.enemyUnits || []).filter(u => u && u.visible !== false), ...(st.enemyBuildings || [])].filter(e => e && e.id != null);
    const trainable = [];
    for (const byAge of Object.values((st.units && st.units.trainable) || {}))
        for (const list of Object.values(byAge)) for (const t of list) {
            const id = (t && typeof t === 'object') ? t.id : t;   // listed as {id, cost}
            if (id && !trainable.includes(id)) trainable.push(id);
        }
    const buildable = ((st.buildings && st.buildings.buildable) || []).map(x => x.type);
    const techs = ((st.research && st.research.available) || []).map(x => x.id);
    const tiles = Object.keys((st.map && st.map.exploration) || {});
    const select = () => {
        // Sometimes the whole army, sometimes a type it owns, sometimes exact ids.
        const k = r();
        if (k < 0.4 || !military.length) return {};
        if (k < 0.7) { const t = pick(r, military).type; return { units: { [t]: 1 + Math.floor(r() * 3) } }; }
        return { unitIds: military.filter(() => r() < 0.5).map(u => u.id).slice(0, 5).concat([pick(r, military).id]) };
    };
    const kinds = {
        train_unit: () => trainable.length ? { unitType: pick(r, trainable) } : null,
        build_structure: () => buildable.length ? Object.assign({ buildingType: pick(r, buildable) }, near()) : null,
        research_tech: () => techs.length ? { techId: pick(r, techs) } : null,
        upgrade_age: () => ({}),
        assign_workers: () => ({ resourceType: pick(r, RESOURCES), count: 1 + Math.floor(r() * 3) }),
        repair_building: () => ({}),
        explore: () => tiles.length ? { tile: pick(r, tiles) } : null,
        move_units: () => Object.assign({ mode: pick(r, MODES) }, point(), select()),
        attack_target: () => (enemies.length && r() < 0.6) ? Object.assign({ targetId: String(pick(r, enemies).id) }, select())
            : Object.assign(point(), select()),
        wait: () => ({}),
    };
    const action = pick(r, Object.keys(kinds));
    const params = kinds[action]();
    return params ? { action, params } : null;
}

function randomValidPolicy(key) {
    const r = rngFor('random-valid:' + key);
    return ({ state }) => {
        const n = 1 + Math.floor(r() * 3), out = [];
        for (let i = 0; i < n * 3 && out.length < n; i++) {
            const c = randomCommand(r, state);
            if (c) out.push(c);
        }
        return out;
    };
}

// The three baselines by name, as policy factories (scenario, variant, attempt):
//   noop          answers nothing, every round
//   random-valid  one to three commands a round, each built only from names and places
//                 the state shows. It may be refused for the world's reasons (cannot
//                 afford, busy, nobody free) -- constraint errors -- but must never earn
//                 a reference error: it never names anything that is not there.
//   scripted      the scenario's reference solution, which must score 100 %
// Seeded: the same scenario, variant and attempt give the same commands every time.
const BASELINES = Object.freeze({
    noop: () => noopPolicy(),
    'random-valid': (s, v, a) => randomValidPolicy(`${s.id}/${v}/${a}`),
    scripted: () => referencePolicy(),
});

// A model as a policy: the ARENA's seat, not a lookalike. Its turn goes through the
// arena's own sendToOpenAI: the same request builder (buildTurnRequest), the same
// parser, the same rolling history. Three things are switched off, by the seat's strict
// flag, so a score belongs to the request that was declared and not to one the harness
// repaired: parameter adaptation after a refusal, the rate-limit retry, and context
// shrinking. Parameters an endpoint refuses belong in the run's model config; at run
// time a refusal is a failed round.
//
// `cfg` = {name, endpoint, model, provider, maxTokens, contextSize, language, reqOpts,
// auth, promptPrefix | systemPrompt}; reqOpts are the fixed request parameters
// (temperature, topP, reasoning, extraBody, ...). `fetchImpl` is the host's fetch, lent
// to the rules' global with the timers the send loop needs.
function modelPolicy(cfg, { fetchImpl = (typeof fetch === 'function' ? fetch : null), timers = null } = {}) {
    if (!cfg || !cfg.endpoint) throw new Error('modelPolicy: an endpoint is required');
    return async ({ round, state, episode }) => {
        const { mgr, realm, subjectController: c } = episode;
        if (round === 1) {
            const M = mgr.constructor;   // a class declaration is not a property of a global
            c.model = {
                name: cfg.name || cfg.model, endpoint: cfg.endpoint, model: cfg.model || 'default',
                // As the seat declares it: an unset maxTokens stays unset (the request
                // then carries none, as the arena seat's does).
                provider: cfg.provider || 'openai', maxTokens: cfg.maxTokens == null ? null : cfg.maxTokens,
                contextSize: cfg.contextSize || null, language: cfg.language || 'en',
                auth: cfg.auth || { type: 'none' },
                // The fixed parameters ride where the arena keeps learned ones, so the
                // request carries exactly them and nothing learns on top.
                _reqOpts: Object.assign({}, cfg.reqOpts || {}),
                // The seat's own prompt, as its arena seat plays it: a whole template
                // (systemPrompt) or the default with a prefix line (promptPrefix, e.g.
                // "Do not overthink."). Only the victory paragraph becomes the objective.
                customSystemPrompt: M.scenarioSystemPrompt(episode.objective,
                    cfg.systemPrompt != null ? cfg.systemPrompt
                        : cfg.promptPrefix != null ? String(cfg.promptPrefix) + '\n\n' + M.defaultSystemPrompt() : null),
            };
            c.lanes = [c];
            c._strict = true;
            // The send loop's own machinery, lent to the realm (it has no timers or
            // network of its own: nothing in the rules may use them).
            realm.lend(Object.assign({ fetch: fetchImpl }, timers || {}));
        }
        const envelope = await mgr.sendToOpenAI(c, state);
        return envelope && !envelope.noAction ? envelope : null;
    };
}

// ---- Statistics --------------------------------------------------------------------
// Small, exact where they can be, and seeded where they cannot: a report must come out
// the same every time it is computed.

// Wilson score interval for k successes in n trials (95 % by default). Well behaved at
// 0 and n, where the normal approximation collapses to a zero-width interval.
function wilson(k, n, z = 1.959963984540054) {
    if (!n) return { p: null, lo: null, hi: null, k, n };
    const p = k / n, z2 = z * z, den = 1 + z2 / n;
    const mid = (p + z2 / (2 * n)) / den;
    const half = (z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n))) / den;
    return { p, lo: Math.max(0, mid - half), hi: Math.min(1, mid + half), k, n };
}

// The mean of scores in [0, 1] with a 95 % interval: the normal approximation, widened
// to Wilson's at the extremes so that five identical scores do not read as certainty.
function meanScore(scores, z = 1.959963984540054) {
    const n = scores.length;
    if (!n) return { mean: null, lo: null, hi: null, n };
    const mean = scores.reduce((a, b) => a + b, 0) / n;
    const sd = n > 1 ? Math.sqrt(scores.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (n - 1)) : 0;
    const half = z * sd / Math.sqrt(n);
    const w = wilson(mean * n, n, z);
    const round = v => Math.round(v * 10000) / 10000;
    return { mean: round(mean), lo: round(Math.max(0, Math.min(mean - half, w.lo))), hi: round(Math.min(1, Math.max(mean + half, w.hi))), n };
}

// C(n, k) as a float, exact for the small numbers a bench uses.
function choose(n, k) {
    if (k < 0 || k > n) return 0;
    let r = 1;
    for (let i = 1; i <= k; i++) r = r * (n - k + i) / i;
    return r;
}

// pass^k: the chance that k independent attempts at the same task ALL succeed, estimated
// without bias from c successes in n attempts as C(c, k) / C(n, k), then averaged over
// tasks. pass^1 is the plain success rate; pass^k falls as k grows unless a policy is
// reliable, which is the point of reporting it. null when no task has k attempts.
function passHatK(cells, k) {
    const usable = cells.filter(c => c.n >= k);
    if (!usable.length) return null;
    return usable.reduce((s, c) => s + choose(c.successes, k) / choose(c.n, k), 0) / usable.length;
}

// Group results into cells (one scenario x variant, all its attempts), with the
// successes and the summed episode scores (partial and graded credit included).
function cellsOf(results) {
    const map = new Map();
    for (const r of results) {
        const key = r.id + '/' + r.variant;
        const c = map.get(key) || { key, id: r.id, family: r.family, variant: r.variant, n: 0, successes: 0, scoreSum: 0 };
        c.n++; if (r.outcome === 'success') c.successes++;
        c.scoreSum += episodeScore(r);
        map.set(key, c);
    }
    return [...map.values()].sort((a, b) => a.key.localeCompare(b.key));
}

// ---- Scoring -----------------------------------------------------------------------
// A run, scored: success rates with Wilson intervals -- overall, per family, per
// scenario -- the mean score (partial credit included) with its interval, pass^k for
// every k the attempts allow, and what became of every command, by outcome class.
// Plain data in, plain data out.
function rate(results) {
    return wilson(results.filter(r => r.outcome === 'success').length, results.length);
}
function score(results) {
    const cells = cellsOf(results);
    const maxAttempts = Math.max(0, ...cells.map(c => c.n));
    const passK = {};
    for (let k = 1; k <= maxAttempts; k++) passK[k] = passHatK(cells, k);
    const group = key => {
        const out = {};
        for (const r of results) (out[r[key]] || (out[r[key]] = [])).push(r);
        return Object.entries(out).sort();
    };
    const by = key => Object.fromEntries(group(key).map(([k, rs]) => [k, rate(rs)]));
    const meanBy = key => Object.fromEntries(group(key).map(([k, rs]) => [k, meanScore(rs.map(episodeScore))]));
    const outcomes = { success: 0, partial: 0, failure: 0 };
    for (const r of results) outcomes[r.outcome] = (outcomes[r.outcome] || 0) + 1;
    // A graded scenario's parts, averaged per scenario: which part of the play was weak.
    const partsByScenario = {};
    for (const [id, rs] of group('id')) {
        const withParts = rs.filter(r => r.parts);
        if (!withParts.length) continue;
        const sum = {};
        for (const r of withParts) for (const [k, v] of Object.entries(r.parts)) sum[k] = (sum[k] || 0) + v;
        partsByScenario[id] = Object.fromEntries(Object.entries(sum).map(([k, v]) => [k, Math.round(v / withParts.length * 1000) / 1000]));
    }
    // Every command's fate. "uncoded" is a refusal the harness gave no code; it is
    // reported, never folded into another class.
    const classes = {};
    let commands = 0, rounds = 0;
    for (const r of results) {
        rounds += r.rounds;
        for (const e of r.log) for (const o of e.outcomes || []) { commands++; classes[o.class] = (classes[o.class] || 0) + 1; }
    }
    return {
        episodes: results.length, cells: cells.length,
        success: rate(results), passK,
        byFamily: by('family'), byScenario: by('id'),
        meanScore: meanScore(results.map(episodeScore)), meanByFamily: meanBy('family'), meanByScenario: meanBy('id'),
        outcomes, partsByScenario,
        commands, commandsPerRound: rounds ? commands / rounds : 0, classes,
    };
}

// ---- Bundles -----------------------------------------------------------------------
// A run recorded so anyone can check it later without calling a model and without the
// WAR that made it (tools/bench/bundle.cjs documents the records). Built here so a run
// recorded in the browser is the same file a Node run writes; `sha` is the host's
// SHA-256 (hex) of a string. Lines are JSON, hash-chained: every record carries `prev`,
// the SHA-256 of the line before it.
const BUNDLE_SCHEMA = 'war-bench-bundle-v1';
function bundleChain(sha, onLine = null) {
    let prev = null;
    const lines = [];
    return { lines, push(rec) { const line = JSON.stringify(Object.assign({ prev }, rec)); lines.push(line); prev = sha(line); if (onLine) onLine(line); } };
}
// The header and every blob: the rule sources ({path: text}, line endings normalized)
// and the scenarios. `policy` = {name, kind, config}; a model's config carries no
// credentials.
function bundleOpen(chain, { sha, sources, scenarios, policy, label = null, ceilingMs = CEILING_MS, variants = null, attempts = 1, coreHash, extra = null }) {
    const files = {};
    for (const [p, text] of Object.entries(sources)) files[p] = sha(text);
    for (const s of scenarios) files['scenario:' + s.id] = sha(JSON.stringify(s));
    chain.push(Object.assign({ type: 'header', schema: BUNDLE_SCHEMA, protocol: { scenario: SCHEMA, roundMs: ROUND_MS, ceilingMs },
           policy: { name: policy.name, kind: policy.kind, config: policy.config || null }, label,
           coreHash, harnessHash: sha(sources['js/openai-ai.js']), files,
           scenarios: scenarios.map(s => s.id), variants, attempts }, extra || {}));
    const blobs = new Map();
    for (const [p, text] of Object.entries(sources)) blobs.set(files[p], text);
    for (const s of scenarios) blobs.set(files['scenario:' + s.id], JSON.stringify(s));
    for (const [hash, text] of [...blobs].sort()) chain.push({ type: 'blob', sha256: hash, text });
}
// One episode: its rounds as recorded ({round, stateHash, answer, wire, results,
// outcomes, rival, worldHash, after}), then how it ended.
function bundleEpisode(chain, { id, variant, attempt }, rounds, result, snapshot) {
    chain.push({ type: 'episode', id, variant, attempt });
    for (const x of rounds) chain.push(Object.assign({ type: 'round' }, x, { type: 'round' }));
    chain.push(Object.assign({ type: 'end', id, variant, attempt, outcome: result.outcome, rounds: result.rounds },
        result.score != null ? { score: result.score } : {}, result.stopped ? { stopped: result.stopped } : {},
        result.parts ? { parts: result.parts } : {}, result.notes ? { notes: result.notes } : {},
        { snapshot }));
}
function bundleClose(chain, results) { chain.push({ type: 'close', episodes: results.length, score: score(results) }); }

return {
    SCHEMA, ROUND_MS, CEILING_MS, PARTIAL_CAP, VARIANTS, BOARD_TILES,
    createRuntime, inert, stageGlobals, makeGame, startFixture, scripted, addUnit, addBuilding, advance, snapshot, setupBoard,
    validate, instantiate, tileFor, evaluate, measure, measureParts, objectiveText, resolve,
    CLASSES, CLASS_OF, classify,
    begin, play, episodeScore,
    referencePolicy, noopPolicy, rngFor, randomCommand, randomValidPolicy, BASELINES, modelPolicy,
    wilson, meanScore, choose, passHatK, cellsOf, rate, score,
    BUNDLE_SCHEMA, bundleChain, bundleOpen, bundleEpisode, bundleClose,
};
})();
if (typeof module !== 'undefined' && module.exports) module.exports = WarBench;
