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
// Messages in:  {type:'init', urls:{file:url}, recs:[header, contract, ...inputs]}
//               {type:'to', step}            advance, verifying, and send the scene
// Messages out: {type:'ready', coreHash, harnessHash, lastInputStep, inputs}
//               {type:'frame', step, checked, ok, problem, divergedAt, complete, ended, scene}
//               {type:'error', problem}
// ---------------------------------------------------------------------------
'use strict';
self.window = self;

// A presentation object whose every method is a no-op; the same stand-in as the bench
// realm's, which counts calls where this one has no one to report them to.
function inert(own = {}) {
    return new Proxy(own, {
        get(target, key) {
            if (key in target) return target[key];
            if (typeof key === 'symbol' || key === 'then' || String(key).startsWith('_')) return undefined;
            return () => {};
        },
        set(target, key, value) { target[key] = value; return true; },
    });
}
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
const lf = s => String(s).replace(/\r\n/g, '\n');

async function init({ urls, recs }) {
    const fetchText = async url => { const r = await fetch(url, { cache: 'no-store' }); if (!r.ok) throw new Error('cannot read ' + url); return r.text(); };
    // The manifest first: it names every other file, in load order.
    const manifestText = await fetchText(urls['js/manifest.js'] || '../js/manifest.js');
    importScripts(URL.createObjectURL(new Blob([manifestText], { type: 'text/javascript' })));
    const files = WarManifest.vm.slice(), texts = {};
    await Promise.all(files.concat('js/resim.js').map(async f => { texts[f] = await fetchText(urls[f] || '../' + f); }));
    for (const f of files.concat('js/resim.js')) importScripts(URL.createObjectURL(new Blob([texts[f]], { type: 'text/javascript' })));
    const coreHash = warSha256(WarManifest.rules.map(f => lf(texts[f])).join('\n'));
    const harnessHash = warSha256(lf(texts[WarManifest.harness]));

    const contract = recs.find(r => r && r.type === 'contract');
    if (!contract || contract.coreHash !== coreHash || contract.harnessHash !== harnessHash) {
        return { type: 'error', problem: 'rules changed since recording', coreHash, harnessHash };
    }
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
    game.renderer = inert({
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
    if (!replay.ok) return { type: 'error', problem: replay.problem };
    return { type: 'ready', coreHash, harnessHash, lastInputStep: replay.lastInputStep, inputs: inputs.length };
}

function frame(step) {
    replay.to(step);
    return { type: 'frame', step: replay.step, checked: replay.checked, ok: replay.ok, problem: replay.problem,
             divergedAt: replay.divergedAt, divergedSeq: replay.divergedSeq, complete: replay.complete, ended: !game.gameStarted, scene: replay.scene() };
}

self.onmessage = async ({ data }) => {
    try {
        if (data.type === 'init') self.postMessage(await init(data));
        else if (data.type === 'to' && replay) self.postMessage(frame(data.step));
    } catch (e) {
        self.postMessage({ type: 'error', problem: (e && e.message) || String(e) });
        quiet('[resim]', e);
    }
};
