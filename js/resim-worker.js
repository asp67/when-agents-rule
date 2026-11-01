// ---------------------------------------------------------------------------
// The analyzer's re-simulation, in a worker (review #9, WAR side).
//
// The page's own game is the analyzer's stage, so the match is re-simulated here, in a
// world of its own: the rule files and the harness run as they do in the bench's Node
// realm (tools/bench/realm.cjs), with the renderer, the UI and the page as inert
// stand-ins. Nothing presentational decides anything, so nothing is lost.
//
// The page sends the script URLs it loaded (with their ?v=). They are fetched here and
// run from those very texts, and the texts are what get hashed: the check that the
// transcript's rules are the rules running cannot be fooled by a cache serving one copy
// to the hash and another to the engine.
//
// Messages in:  {type:'init', urls:{file:url}, recs:[header, contract, ...inputs], base?, sha256?, indexAhead?}
//               {type:'to', step}            go to the step (the newest request wins), verifying, and send the scene
// Messages out: {type:'loading', read, files}  a rule file fetched (for the page's progress)
//               {type:'progress', step, target, from}  a long walk under way
//               {type:'indexed', step, keyframes}      the furthest keyframe kept so far
//               {type:'ready', coreHash, harnessHash, lastInputStep, inputs}
//               {type:'frame', step, checked, ok, problem, divergedAt, complete, ended, scene, fx}
//
// `fx`: what the rules asked the renderer to show since the last frame -- arrows and
// stones, hit flashes, dust, battle rings -- for the page to show on its stage. They are
// presentation the rules call, not state, so the scene alone could not bring them back.
//               {type:'error', problem}
// ---------------------------------------------------------------------------
'use strict';
self.window = self;

// A presentation object whose every method is a no-op; the same stand-in as the bench
// realm's, which counts calls where this one has no one to report them to.
function inert(own = {}) {
    const p = new Proxy(own, {
        get(target, key) {
            if (key in target) return target[key];
            if (typeof key === 'symbol' || key === 'then' || String(key).startsWith('_')) return undefined;
            return () => {};
        },
        set(target, key, value) { target[key] = value; return true; },
    });
    standIns.add(p);
    return p;
}
// The stand-ins are presentation, never state: a keyframe keeps them by identity.
const standIns = new WeakSet();
const ctx2d = () => inert({
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    getImageData: (x, y, w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    createLinearGradient: () => inert(), createRadialGradient: () => inert(),
});
const element = () => inert({ style: {}, classList: inert(), dataset: {}, width: 0, height: 0, getContext: ctx2d });
const rafQueue = [];
self.document = inert({ hidden: false, getElementById: element, querySelector: element,
    querySelectorAll: () => [], createElement: element, body: element() });
self.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
self.requestAnimationFrame = cb => { rafQueue.push(cb); return rafQueue.length; };
self.t = key => key;
// The harness narrates every turn to the console; nobody reads a worker's.
const quiet = console.log;
console.log = () => {};
console.info = () => {};

let replay = null;
const fx = [];   // the renderer calls since the last frame (see the header)
const lf = s => String(s).replace(/\r\n/g, '\n');

// `base`, when given, is where the files of an older version of the rules are read from
// (a rule checkpoint, b1144: GitHub at the commit that holds them); otherwise they are the
// page's own. `sha256` is the page's own hash function, run before anything fetched: the
// texts are checked against the recording BEFORE any of them runs.
async function init({ urls, recs, base = null, sha256 = null, indexAhead = false }) {
    const fetchText = async url => { const r = await fetch(url, { cache: base ? 'force-cache' : 'no-store' }); if (!r.ok) throw new Error('cannot read ' + url); return r.text(); };
    const urlOf = f => urls[f] || (base ? base + f : '../' + f);
    const run = text => importScripts(URL.createObjectURL(new Blob([text], { type: 'text/javascript' })));
    run(await fetchText(sha256 || urls['js/sha256.js'] || '../js/sha256.js'));
    const pageSha = warSha256;
    // The manifest first: it names every other file, in load order.
    const manifestText = await fetchText(urlOf('js/manifest.js'));
    run(manifestText);
    const files = WarManifest.vm.slice().concat('js/resim.js'), texts = {};
    let read = 0;
    await Promise.all(files.map(async f => {
        texts[f] = await fetchText(urlOf(f));
        self.postMessage({ type: 'loading', read: ++read, files: files.length });
    }));
    const coreHash = pageSha(WarManifest.rules.map(f => lf(texts[f])).join('\n'));
    const harnessHash = pageSha(lf(texts[WarManifest.harness]));

    const contract = recs.find(r => r && r.type === 'contract');
    if (!contract || contract.coreHash !== coreHash || contract.harnessHash !== harnessHash) {
        return { type: 'error', problem: 'rules changed since recording', coreHash, harnessHash };
    }
    for (const f of files) run(texts[f]);
    const header = WarResim.header(recs), inputs = WarResim.inputs(recs);
    const refusal = WarResim.refusal(header, inputs);
    if (refusal) return { type: 'error', problem: refusal };

    // As the bench realm builds its game: the real Game, presentation inert.
    game = new Game();
    // Nothing may move this world but the replay. A hidden page's game ticks itself from
    // a timer worker (Game.initBackgroundDriver), which here would step the world between
    // messages; it is marked as already tried, so it is never started.
    game._bgDriverTried = true;
    const units = [], buildings = [];
    const drop = (list, e) => { const i = list.indexOf(e); if (i >= 0) list.splice(i, 1); };
    let frames = 0;
    // The calls the stage replays (fx above). An entity goes by id, as a unit or a building.
    const ref = e => e ? { id: e.id, b: !!(typeof BUILDING_DEFS !== 'undefined' && BUILDING_DEFS[e.type]) || !!e.isWonder, x: e.x, z: e.z, type: e.type } : null;
    const note = (k, data) => { fx.push(Object.assign({ k, step: game.clock.stepNo }, data)); if (fx.length > 4000) fx.splice(0, 2000); };
    game.renderer = inert({
        spawnProjectile: (from, to, kind, shooter) => note('proj', { from, to, kind, shooter: ref(shooter) }),
        flashHit: e => note('hit', { e: ref(e) }),
        spawnDust: (x, y, z, count, color) => note('dust', { x, y, z, count, color }),
        spawnBattleRing: (x, z) => note('ring', { x, z }),
        units, buildings, selectedUnits: [], replayMode: false, container: { clientWidth: 0, clientHeight: 0 },
        get _completedFrames() { return ++frames; }, grassStats: null,
        addUnit: e => { if (!units.includes(e)) units.push(e); },
        addBuilding: e => { if (!buildings.includes(e)) buildings.push(e); },
        killUnit: e => drop(units, e), removeUnit: e => drop(units, e),
        killBuilding: e => drop(buildings, e), removeBuilding: e => drop(buildings, e),
        clearScene: () => { units.length = 0; buildings.length = 0; },
    });
    game.ui = inert();
    game.terrain = new TerrainManager(null, 800);
    game.aiManager = new AIManager(game);

    const started = game._startArenaFromSetup(WarResim.spec(header));
    let done = false, error = null;
    started.then(() => { done = true; }, e => { error = e; done = true; });
    for (let i = 0; !done && i < 1000; i++) {
        rafQueue.splice(0).forEach(cb => cb());
        await new Promise(resolve => setTimeout(resolve, 0));
    }
    if (error) throw error;
    if (!game.gameStarted) throw new Error('the arena did not start');
    // The world moves only when asked: no frames drive it from here on.
    rafQueue.length = 0;
    self.requestAnimationFrame = () => 0;
    replay = new WarResim.Replay(game, header, inputs, ms => game.advanceSim(ms));
    fixed.add(inputs); fixed.add(header);
    if (!replay.ok) return { type: 'error', problem: replay.problem };
    ahead = !!indexAhead;
    keepKeyframe();   // the start: a jump back to it is a restore, not a rebuild
    return { type: 'ready', coreHash, harnessHash, lastInputStep: replay.lastInputStep, inputs: inputs.length };
}

// ---- Moving the world (b1145) ---------------------------------------------------------
// The page asks for a step whenever it wants one, and the newest request wins. A long
// walk goes in slices, yielding between them, so a jump made while one is under way
// replaces it. Before, the worker walked on to the old step and only then read the new
// request, so a jump back made during a long jump forward was lost, and the page rebuilt
// the whole match from its first second for every jump back (asp67, 1 Nov: "one has to
// always start at the start and then fast forward to the place of interest").
// A step behind the world, or past a keyframe the world has not reached, starts from the
// nearest keyframe at or before it. When nothing is asked for a second, the worker walks
// on ahead and keeps keyframes, so later jumps are short (`ahead`, set by the page).
const SLICE_MS = 100;        // work between yields: requests are read, progress is told
const SLICE = 200;           // steps walked between looks at the clock
const KEY_MAX = 24;          // keyframes kept, about 6 MB each; more widen the spacing
const IDLE_MS = 1000;
let keyEvery = 2400;         // steps between keyframes: a minute of play at normal speed
const keyframes = [];        // ascending by step; the first is the start, always kept
let goal = null, running = false, ahead = false;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
// A yield that lets the page's requests in. Not a zero timer: in a page that is not in
// front, timers are slowed to as little as one a second, and a jump crawled at 900 steps a
// second where the worker walks 2200. A message to itself is not slowed.
const yieldChannel = typeof MessageChannel === 'function' ? new MessageChannel() : null;
const yieldNow = () => (yieldChannel
    ? new Promise(resolve => { yieldChannel.port1.onmessage = () => resolve(); yieldChannel.port2.postMessage(0); })
    : pause(0));
// Walk toward `target` for about SLICE_MS.
function walkSlice(target) {
    const t0 = performance.now();
    do walk(target, SLICE);
    while (replay.ok && game.gameStarted && replay.step < target && performance.now() - t0 < SLICE_MS);
}
// The idle second before walking ahead ends early when a request comes: playback asks for
// the next frame every few milliseconds and must not wait it out.
let wake = null;
const idle = ms => new Promise(resolve => { wake = resolve; setTimeout(resolve, ms); });

function keepKeyframe() {
    const s = replay.step;
    if (keyframes.length && (s % keyEvery !== 0 || keyframes.some(k => k.step === s))) return;
    keyframes.push(saveKeyframe());
    keyframes.sort((a, b) => a.step - b.step);
    if (keyframes.length > KEY_MAX) {
        keyEvery *= 2;
        for (let i = keyframes.length - 1; i > 0; i--) if (keyframes[i].step % keyEvery !== 0) keyframes.splice(i, 1);
    }
    self.postMessage({ type: 'indexed', step: keyframes[keyframes.length - 1].step, keyframes: keyframes.length });
}
// Forward to `target` by at most `limit` steps, stopping at each keyframe step on the way.
function walk(target, limit) {
    const end = Math.min(target, replay.step + limit);
    while (replay.ok && game.gameStarted && replay.step < end) {
        const next = Math.min(end, (Math.floor(replay.step / keyEvery) + 1) * keyEvery);
        replay.to(next);
        if (replay.step === next) keepKeyframe(); else break;   // the match ended first
    }
}
function nearestKeyframe(step) {
    for (let i = keyframes.length - 1; i >= 0; i--) if (keyframes[i].step <= step) return keyframes[i];
    return null;
}
// The world at `target`, or as near as it gets (a divergence, the match's end). Returns
// false when a newer request replaced this one on the way.
async function reach(target) {
    const kf = nearestKeyframe(target);
    if (kf && (target < replay.step || kf.step > replay.step)) restoreKeyframe(kf);
    const from = replay.step;
    while (replay.ok && game.gameStarted && replay.step < target) {
        walkSlice(target);
        if (replay.step >= target || !replay.ok || !game.gameStarted) break;
        self.postMessage({ type: 'progress', step: replay.step, target, from });
        await yieldNow();
        if (goal !== target) return false;
    }
    return from;
}
async function run() {
    if (running) return;
    running = true;
    try {
        for (;;) {
            if (goal != null) {
                const target = goal;
                const from = await reach(target);
                if (from === false) continue;
                if (goal === target) goal = null;
                self.postMessage(frame(from));
                continue;
            }
            if (!ahead || !replay.ok) return;
            // Idle: a quiet second, then on ahead from the furthest keyframe.
            await idle(IDLE_MS);
            wake = null;
            if (goal != null) continue;
            const last = keyframes[keyframes.length - 1];
            if (!last || last.step >= replay.lastInputStep) return;
            if (last.step > replay.step) restoreKeyframe(last);
            while (ahead && goal == null && replay.ok && game.gameStarted && replay.step < replay.lastInputStep) {
                walkSlice(replay.lastInputStep);
                await yieldNow();
            }
            if (goal == null) return;
        }
    } finally { running = false; }
}

// The scene at the world's step. `from` is where this walk began: only what a viewer
// could have seen is sent, the last two seconds of a long jump, not every arrow of the
// minutes it skipped.
function frame(from) {
    const recent = fx.filter(e => e.step > Math.max(from, replay.step - 40)).slice(-300);
    fx.length = 0;
    return { type: 'frame', step: replay.step, checked: replay.checked, ok: replay.ok, problem: replay.problem,
             divergedAt: replay.divergedAt, divergedSeq: replay.divergedSeq, complete: replay.complete, ended: !game.gameStarted,
             scene: withMaxHealth(replay.scene()), fx: recent,
             indexed: keyframes.length ? keyframes[keyframes.length - 1].step : 0 };
}

// ---- Keyframes (b1145)---------------------------------------------------------------
// The world as it stood at a step, kept in this worker so a jump lands on the nearest one
// at or before the step asked for and plays on from there, instead of replaying the match
// from its first second. The same idea as the Platform's checkpoints
// (platform/server/checkpoint.cjs): the object graph from the game down, with the objects
// that something outside the graph holds (the global `game`, the replay, the renderer's
// lists) refilled in place, and presentation and functions kept by identity. The rule
// files keep their counters on the game for exactly this (units.js nextUnitHandle); the
// one static, the formation sequence, is saved beside it. Nothing here is trusted
// blindly: the replay goes on checking every recorded hash after a restore.
class KfRef { constructor(i) { this.i = i; } }
class KfExt { constructor(o) { this.o = o; } }
const fixed = new WeakSet();          // never copied: the recording (inputs, header)
const typedCopies = new WeakMap();    // a typed array -> its last copy, shared while unchanged
function sameTyped(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}
// Accessors and methods on an object refilled in place are its own, not the world's.
const dataKeys = o => Object.keys(o).filter(k => { const d = Object.getOwnPropertyDescriptor(o, k); return d && !d.get && !d.set && typeof d.value !== 'function'; });

function anchorsOf() {
    return [game, game.renderer, game.renderer.units, game.renderer.buildings, replay, game.terrain, game.aiManager, game.openAIAIManager].filter(Boolean);
}
function saveKeyframe() {
    const anchors = new Set(anchorsOf()), ids = new Map(), nodes = [];
    const enc = v => {
        if (v === null || (typeof v !== 'object' && typeof v !== 'function')) return v;
        if (ids.has(v)) return new KfRef(ids.get(v));
        const anchor = anchors.has(v);
        if (!anchor && (typeof v === 'function' || standIns.has(v) || fixed.has(v))) return new KfExt(v);
        const id = nodes.length, node = { anchor: anchor ? v : null };
        ids.set(v, id); nodes.push(node);
        if (v instanceof Map) { node.kind = 'M'; node.items = []; for (const [k, x] of v) node.items.push(enc(k), enc(x)); }
        else if (v instanceof Set) { node.kind = 'S'; node.items = []; for (const x of v) node.items.push(enc(x)); }
        else if (ArrayBuffer.isView(v)) {
            node.kind = 'T';
            let c = typedCopies.get(v);
            if (!c || !sameTyped(c, v)) { c = v.slice(); typedCopies.set(v, c); }
            node.copy = c;
        } else {
            node.kind = Array.isArray(v) ? 'A' : 'O';
            node.proto = Object.getPrototypeOf(v);
            node.keys = anchor ? dataKeys(v) : Object.keys(v);
            node.vals = node.keys.map(k => enc(v[k]));
        }
        return new KfRef(id);
    };
    const root = enc({ game, replay });
    return { step: replay.step, root, nodes, formationSeq: OpenAIAIManager._formationSeq };
}
function restoreKeyframe(kf) {
    const objs = kf.nodes.map(n => n.anchor ? n.anchor
        : n.kind === 'M' ? new Map() : n.kind === 'S' ? new Set() : n.kind === 'T' ? n.copy.slice()
        : n.kind === 'A' ? [] : Object.create(n.proto));
    const dec = v => (v instanceof KfRef ? objs[v.i] : v instanceof KfExt ? v.o : v);
    kf.nodes.forEach((n, i) => {
        const o = objs[i];
        if (n.kind === 'T') { if (n.anchor) o.set(n.copy); return; }
        if (n.kind === 'M') { o.clear(); for (let j = 0; j < n.items.length; j += 2) o.set(dec(n.items[j]), dec(n.items[j + 1])); return; }
        if (n.kind === 'S') { o.clear(); for (const x of n.items) o.add(dec(x)); return; }
        if (n.anchor) { for (const k of dataKeys(o)) delete o[k]; if (Array.isArray(o)) o.length = 0; }
        for (let j = 0; j < n.keys.length; j++) o[n.keys[j]] = dec(n.vals[j]);
    });
    OpenAIAIManager._formationSeq = kf.formationSeq;
    fx.length = 0;
}

// Each unit's and building's maximum health as the rules have it now. The stage used to
// take it from its own entity, made when the thing was first seen: an age-up raises a
// building's maximum and scales its health with it (morphBuildingsToAge), research raises
// a unit's, and the stage kept the old maximum. A building then stood above it, with no
// health bar, until damage took it below -- about half way down for an Iron Age building
// first seen in the Stone Age (asp67, 1 Nov). Added here rather than in resim.js, so it
// holds for any version of the rules the worker runs.
function withMaxHealth(scene) {
    const players = game.aiManager.aiPlayers;
    scene.seats.forEach(s => {
        const ai = players.find(p => p.id === s.id);
        if (!ai) return;
        const units = new Map(ai.units.map(u => [u.id, u])), buildings = new Map(ai.buildings.map(b => [b.id, b]));
        s.units.forEach(u => { const e = units.get(u.id); if (e && e.maxHealth > 0) u.maxHealth = e.maxHealth; });
        s.buildings.forEach(b => { const e = buildings.get(b.id); if (e && e.maxHealth > 0) b.maxHealth = e.maxHealth; });
    });
    return scene;
}

self.onmessage = async ({ data }) => {
    try {
        if (data.type === 'init') self.postMessage(await init(data));
        else if (data.type === 'to' && replay) {
            goal = Math.max(0, Math.floor(Number(data.step) || 0));
            if (wake) { wake(); wake = null; }
            await run();
        }
    } catch (e) {
        self.postMessage({ type: 'error', problem: (e && e.message) || String(e) });
        quiet('[resim]', e);
    }
};
