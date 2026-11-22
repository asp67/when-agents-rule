// The model's view (overhaul step B1): js/seat-view.js, the two hooks it sets on the
// renderer, and the switch in js/ui.js. Held here: that the view is one seat's fog drawn
// by the fog manager's own code on a second grid, that it hides exactly what that seat
// cannot see, that its ghosts are the seat's own memory, and that it changes nothing else.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

// The real fog manager and the real view, on canvases that only count what is drawn.
function world() {
    const drawn = { images: 0 };
    const ctx2d = () => ({ createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData() { drawn.images++; }, drawImage() {}, save() {}, restore() {},
        clearRect() {}, fillRect() {}, createLinearGradient: () => ({ addColorStop() {} }), set filter(v) {}, set fillStyle(v) {} });
    const context = vm.createContext({ console, Math, Float32Array, Uint8Array, Uint8ClampedArray, Map, Set,
        document: { createElement: () => ({ width: 0, height: 0, getContext: ctx2d }) } });
    vm.runInContext(read('js/fogofwar.js') + '\nthis.Fog = FogOfWarManager;', context);
    vm.runInContext(read('js/fog-display.js'), context);   // how the fog looks (build 1188): not a rule file
    vm.runInContext('var Game = { hiddenSite: b => !!b.unstartedSite };', context);
    vm.runInContext(read('js/seat-view.js') + '\nthis.View = SeatView;', context);
    // A 40 x 40 map in 2-unit cells. Seat 0 sees the west half now (2), has seen a strip beyond it (1), and nothing of the east.
    const N = 20, grids = { 0: new Float32Array(N * N), 1: new Float32Array(N * N).fill(2) };
    for (let z = 0; z < N; z++) for (let x = 0; x < N; x++) grids[0][z * N + x] = x < 10 ? 2 : x < 13 ? 1 : 0;
    const a = { id: 'a', seat: 0, units: [], buildings: [] }, b = { id: 'b', seat: 1, units: [], buildings: [] };
    const base = Object.create(context.Fog.prototype);
    Object.assign(base, { gridSize: 2, mapSize: 40, numTiles: N, _marginCells: 3, displayWorldSize: 52, fogGrid: new Float32Array(N * N).fill(2), fogDisplayCanvas: { width: 104, height: 104 }, visibilityVersion: 7 });
    const game = { fogOfWar: base, renderer: { fogView: null, entityHidden: null }, aiManager: { aiPlayers: [a, b] }, seatDiscoveryGrid: seat => grids[seat] || null };
    return { View: context.View, Fog: context.Fog, game, a, b, base, grids, drawn };
}
// World x for a grid column: the map spans -20..20.
const west = -15, strip = 3, east = 15;

test('the view is one seat\'s grid, drawn by the fog manager\'s own code on a second fog', () => {
    const { View, Fog, game, base, grids, drawn } = world();
    const v = new View(game);
    assert.deepEqual([v.on(), game.renderer.fogView, game.renderer.entityHidden], [false, null, null]);
    assert.equal(v.set(0), true);
    // A second fog of the same shape, inheriting the manager's methods, with its own grid and canvases.
    assert.equal(Object.getPrototypeOf(v.fog), Fog.prototype);
    assert.notEqual(v.fog, base);
    assert.notEqual(v.fog.fogGrid, base.fogGrid);
    assert.deepEqual([v.fog.numTiles, v.fog.gridSize, v.fog.mapSize, v.fog.displayWorldSize, v.fog.fogDisplayCanvas.width], [20, 2, 40, 52, 104]);
    assert.deepEqual(Array.from(v.fog.fogGrid), Array.from(grids[0]));
    assert.ok(drawn.images >= 1 && v.fog.fogDirty === true && v.fog.visibilityVersion >= 1);     // drawn, and the renderer is told to upload it
    // The renderer is handed the second fog and a filter; the match's own fog is as it was.
    assert.equal(game.renderer.fogView, v.fog);
    assert.equal(typeof game.renderer.entityHidden, 'function');
    assert.deepEqual([Array.from(base.fogGrid).every(x => x === 2), base.visibilityVersion], [true, 7]);
    // Explored or in sight, and in sight now, as the manager answers for its own grid.
    assert.deepEqual([v.fog.isPositionVisible(west, 0), v.fog.isPositionVisible(strip, 0), v.fog.isPositionVisible(east, 0)], [true, true, false]);
    assert.deepEqual([v.fog.isPositionCurrentlyVisible(west, 0), v.fog.isPositionCurrentlyVisible(strip, 0)], [true, false]);
    // The seat's units move: the next refresh redraws from the new grid.
    grids[0].fill(2);
    const before = drawn.images;
    assert.equal(v.refresh(), true);
    assert.deepEqual([v.fog.isPositionCurrentlyVisible(east, 0), drawn.images > before], [true, true]);
    // Another seat reuses the same second fog; everything again takes both hooks away.
    const fog = v.fog;
    assert.equal(v.set(1), true);
    assert.deepEqual([v.fog === fog, v.seat], [true, 1]);
    assert.equal(v.set(null), false);
    assert.deepEqual([game.renderer.fogView, game.renderer.entityHidden, v.seat], [null, null, null]);
    // A seat that is not in the match, or a match without fog: no view.
    assert.equal(v.set(9), false);
    game.fogOfWar = null;
    assert.equal(new View(game).set(0), false);
});

test('it hides what the seat cannot see: a rival\'s unit out of sight, a rival\'s building never discovered', () => {
    const { View, game, a, b } = world();
    const v = new View(game);
    v.set(0);
    const unit = (owner, x) => ({ owner, x, z: 0, health: 5 }), bld = (owner, x, o) => Object.assign({ owner, x, z: 0, health: 100 }, o);
    const known = bld('b', east), unknown = bld('b', east), inSight = bld('b', west), site = bld('b', west, { unstartedSite: true }), wonder = bld('b', east, { isWonder: true });
    a._knownEnemyBuildings = new Set([known]);
    const hide = game.renderer.entityHidden;
    // Its own are never hidden, wherever they stand.
    assert.deepEqual([hide(unit('a', east), 'unit'), hide(bld('a', east), 'building')], [false, false]);
    // A rival's unit: drawn in sight, not in the haze of ground once seen, not in the dark.
    assert.deepEqual([hide(unit('b', west), 'unit'), hide(unit('b', strip), 'unit'), hide(unit('b', east), 'unit')], [false, true, true]);
    // A rival's building: in sight; out of sight but discovered; out of sight and never discovered.
    assert.deepEqual([hide(inSight, 'building'), hide(known, 'building'), hide(unknown, 'building')], [false, false, true]);
    // A Wonder is public, as the model's state says; a siege site not yet begun is unseen even in sight.
    assert.deepEqual([hide(wonder, 'building'), hide(site, 'building')], [false, true]);
    // Seen through the other seat, which sees everything here, nothing is hidden.
    v.set(1);
    assert.deepEqual([game.renderer.entityHidden(unit('a', east), 'unit'), game.renderer.entityHidden(unknown, 'building')], [false, false]);
    void b;
});

test('its ghosts are the seat\'s own memory: where a rival was last seen, and a building that fell out of sight', () => {
    const { View, game, a } = world();
    const v = new View(game);
    assert.deepEqual(Array.from(v.ghosts()), []);                                   // no view, no ghosts
    v.set(0);
    a._unitMemory = new Map([
        ['u1', { id: 'u1', owner: 'b', type: 'archer', x: east, z: 4, visible: false, located: true, at: 100 }],     // remembered, out of sight
        ['u2', { id: 'u2', owner: 'b', type: 'militia', x: west, z: 4, visible: true, located: true, at: 120 }],     // in sight: drawn as itself
        ['u3', { id: 'u3', owner: 'b', type: 'cavalry', x: east, z: 8, visible: false, located: false, at: 90 }],    // its spot was seen empty since: whereabouts unknown
        ['u4', { id: 'u4', owner: 'b', type: 'worker', x: west, z: 8, visible: false, located: true, at: 80 }]]);    // the seat can see the spot now
    const fallen = { owner: 'b', health: 0 }, standing = { owner: 'b', health: 100 }, fallenInSight = { owner: 'b', health: 0 };
    a._enemyBuildingSeen = new Map([[fallen, { type: 'tower', x: east, z: -6 }], [standing, { type: 'barracks', x: east, z: -9 }], [fallenInSight, { type: 'house', x: west, z: -6 }]]);
    assert.deepEqual(JSON.parse(JSON.stringify(v.ghosts())), [
        { kind: 'unit', type: 'archer', x: east, z: 4, owner: 'b', at: 100 },
        { kind: 'building', type: 'tower', x: east, z: -6, owner: 'b', fallen: true }]);
    // A seat with no memory yet has none.
    v.set(1);
    assert.deepEqual(Array.from(v.ghosts()), []);
});

// The switch, on the page class with a stand-in for the view.
function page() {
    const els = {}, made = [];
    const context = vm.createContext({ console, Date, t: (k, v) => k + (v ? JSON.stringify(v) : ''), tg: s => s, OpenAIAIManager: { MAX_COMMANDS_PER_TURN: 3 },
        document: { getElementById: id => els[id] || null, createElement: () => { const e = { style: { setProperty(k, v) { this[k] = v; } }, setAttribute() {}, innerHTML: '', remove() { delete els[e.id]; } }; made.push(e); return e; },
            body: { appendChild: e => { els[e.id] = e; } } } });
    vm.runInContext(read('js/ui.js') + '\nthis.UI = UIManager;', context);
    const u = Object.create(context.UI.prototype);
    u.escapeHtml = s => String(s); u.teamDotHtml = () => ''; u.legibleColor = c => c; u.identityHex = id => '#' + id; u.anCivName = c => 'civ:' + c;
    const calls = [];
    u.refreshMinimapFogKnobs = () => calls.push('knobs');
    const ais = [{ id: 'r', seat: 0, civilization: 'roman' }, { id: 'a', seat: 1, civilization: 'greek' }, { id: 'b', seat: 2, civilization: 'maya' }];
    u.game = { spectatorMode: true, gameStarted: true, minimapFogSeat: null, _minimapFogManual: false, updateMinimap: () => calls.push('minimap'),
        aiManager: { aiPlayers: ais }, openAIAIManager: { aiControllers: [{ id: 'a', model: { name: 'Model A' } }, { id: 'b', model: { name: 'Model B' } }] } };
    u.seatView = { seat: null, refreshed: 0, on() { return this.seat != null; }, set(s) { this.seat = ais.some(x => x.seat === s) ? s : null; return this.on(); },
        refresh() { this.refreshed++; }, ai() { return ais.find(x => x.seat === this.seat) || null; } };
    return { u, els, calls };
}

test('V flips between everything and one seat: the first model seat, or the one the minimap already shows', () => {
    const { u, els, calls } = page();
    // No knob pressed: the first MODEL seat (seat 0 is rule-based), and the minimap follows.
    assert.equal(u.toggleSeatView(), true);
    assert.deepEqual([u.seatView.seat, u.game.minimapFogSeat, u.game._minimapFogManual, calls.join()], [1, 1, true, 'knobs,minimap']);
    assert.equal(els.seatViewBadge.innerHTML, '<span>view.badge{"who":"Model A"}</span>');
    assert.equal(els.seatViewBadge.style['--seat'], '#a');
    // Off again: everything, and the knob the view pressed is let go.
    assert.equal(u.toggleSeatView(), false);
    assert.deepEqual([u.seatView.seat, u.game.minimapFogSeat, u.game._minimapFogManual, els.seatViewBadge], [null, null, false, undefined]);
    // A knob pressed by hand beforehand is the seat, and stays pressed afterwards: it was not the view's.
    u.game.minimapFogSeat = 2; u.game._minimapFogManual = true;
    u.toggleSeatView();
    assert.deepEqual([u.seatView.seat, els.seatViewBadge.innerHTML], [2, '<span>view.badge{"who":"Model B"}</span>']);
    u.toggleSeatView();
    assert.deepEqual([u.seatViewOn(), u.game.minimapFogSeat], [false, 2]);
    // A rule-based seat can be looked through as well: it is named by its civilization.
    u.game.minimapFogSeat = 0;
    u.toggleSeatView();
    assert.equal(els.seatViewBadge.innerHTML, '<span>view.badge{"who":"civ:roman"}</span>');
    // Not while no match is being watched.
    u.toggleSeatView(false);
    u.game.gameStarted = false;
    assert.equal(u.toggleSeatView(), false);
});

test('while it is on, the view follows the minimap\'s knob and refreshes with the seat\'s units', () => {
    const { u, els } = page();
    u.updateSeatView();                                                             // off: nothing happens
    assert.equal(u.seatView.refreshed, 0);
    u.toggleSeatView();
    u.updateSeatView();
    assert.deepEqual([u.seatView.seat, u.seatView.refreshed], [1, 1]);
    // Another knob (by hand, or the auto camera changing its subject): the view moves there.
    u.game.minimapFogSeat = 2;
    u.updateSeatView();
    assert.deepEqual([u.seatView.seat, els.seatViewBadge.innerHTML], [2, '<span>view.badge{"who":"Model B"}</span>']);
    // "Every seat" on the minimap ends the view.
    u.game.minimapFogSeat = null;
    u.updateSeatView();
    assert.deepEqual([u.seatViewOn(), els.seatViewBadge], [false, undefined]);
});

test('nothing but the picture changes: the rules files are untouched, and every fog read in the renderer goes through one place', () => {
    const manifest = require(path.join(root, 'js/manifest.js'));
    assert.equal(manifest.rules.includes('js/fogofwar.js'), true);
    assert.equal(manifest.rules.includes('js/fog-display.js'), false);
    assert.equal(manifest.rules.concat(manifest.harness).some(f => /seat-view/.test(f)), false);
    const view = read('js/seat-view.js').replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(view, /FogOfWarManager\.prototype\.\w+\s*=/);               // it inherits the manager's methods and replaces none
    assert.doesNotMatch(view, /\.health\s*=|\.visible\s*=|_knownEnemyBuildings\.(add|delete)|_unitMemory\.(set|delete)|minimapFogSeat\s*=/);   // reads the match, writes nothing in it
    const r = read('js/engine/gamerenderer.js');
    assert.doesNotMatch(r, /this\.game\?\.fogOfWar|this\.game\.fogOfWar[^)]/);
    assert.match(r, /_fow\(\) \{ return this\.fogView \|\| \(this\.game && this\.game\.fogOfWar\) \|\| null; \}/);
    assert.match(r, /\(this\.entityHidden && this\.entityHidden\(b, 'building'\)\)/);
    assert.match(r, /\(this\.entityHidden && this\.entityHidden\(u, 'unit'\)\)/);
    assert.match(read('js/engine/grass.js'), /const fow=r\._fow \? r\._fow\(\) : r\.game\?\.fogOfWar;/);
    // The switch: V, in either mode; the ghosts are drawn whether or not Intent is on; teardown gives the renderer back.
    assert.match(read('js/eval/bench-view.js'), /if \(key === 'v'\) \{ if \(!this\.seatView\) return; e\.preventDefault\(\); this\.toggleSeatView\(\); return; \}/);
    const ui = read('js/ui.js');
    assert.match(ui, /if \(r && r\.worldToScreen\) this\.drawSeatGhosts\(svg, NS\);\r?\n\s+if \(r && r\.worldToScreen && this\.intentOn\(\)\) this\.drawEvalMarks/);
    assert.match(ui, /if \(this\.seatView\) this\.seatView\.set\(null\);/);
    const context = vm.createContext({ window: {}, navigator: { language: 'en' }, localStorage: { getItem: () => null, setItem() {} },
        document: { documentElement: {}, querySelectorAll: () => [], addEventListener() {} } });
    vm.runInContext(read('js/i18n.js') + ';this.I = I18N;', context);
    for (const lang of ['en', 'de', 'es', 'zh']) for (const k of ['view.badge', 'view.ghostUnit', 'view.ghostBuilding']) assert.ok(k in context.I[lang], lang + ' lacks ' + k);
});
