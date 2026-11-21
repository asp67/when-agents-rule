// Lived-in ground (overhaul step A3): open ground varies broadly and rolls a little; paths
// appear where units really walk, the earth is packed before doors, a fight scars the
// ground; and what is no longer walked grows over again.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const Occl = require(path.join(root, 'js/engine/occlusion.js'));
const { SIZE, TILE, TILES, REGROW_MS, REGROW_STRIPS } = Occl;

const canvas = () => { const ctx = new Proxy({}, { get: (t, k) => k === 'getImageData' ? (x, y, w, h) => ({ data: new Uint8Array(w * h * 4) }) : k === 'createRadialGradient' ? () => ({ addColorStop() {} }) : () => {}, set: () => true }); return { getContext: () => ctx }; };
function card() {
    const log = [];
    const gl = new Proxy({}, { get: (t, k) => typeof k === 'string' && /^[A-Z][A-Z0-9_]*$/.test(k) ? k : (...a) => { log.push([k, ...a]); return k === 'createTexture' ? {} : undefined; } });
    return { gl, log };
}
// Wear at a world place, 0 to 255.
const wearAt = (m, x, z) => m.wear[Math.floor(m.px(z)) * SIZE + Math.floor(m.px(x))];

test('treading adds up, most at the centre, to worn bare and no further; only the tiles it touched are sent again', () => {
    const m = new Occl.Map(800, () => canvas()), { gl, log } = card();
    m.sync(gl, () => [], 1000);
    assert.deepEqual([m.dirty.size, m.stale.size, m.sent], [0, 0, 256]);
    m.tread(25, 25, 60, 2);
    const centre = wearAt(m, 25, 25), near = wearAt(m, 26.2, 25);
    assert.ok(centre > 50 && centre <= 60 && near > 0 && near < centre, centre + ' at the centre, ' + near + ' a little off');
    assert.equal(wearAt(m, 28, 25), 0, 'nothing past its radius');
    assert.deepEqual([...m.stale], [8 * TILES + 8]);
    for (let i = 0; i < 10; i++) m.tread(25, 25, 60, 2);
    assert.equal(wearAt(m, 25, 25), 255);
    // Sent as it stands: nothing is painted for it, and the wear rides in the second channel.
    log.length = 0;
    const painted = m.painted;
    assert.equal(m.sync(gl, () => { throw new Error('nothing to paint'); }, 24), 1);
    assert.equal(m.painted, painted);
    const part = log.find(l => l[0] === 'texSubImage2D');
    assert.deepEqual(part.slice(3, 9), [512, 512, 64, 64, 'LUMINANCE_ALPHA', 'UNSIGNED_BYTE']);
    const local = ((Math.floor(m.px(25)) - 512) * TILE + (Math.floor(m.px(25)) - 512)) * 2;
    assert.deepEqual([part[9][local], part[9][local + 1]], [0, 255], 'what stands, then the wear');
    // Painting a tile again for what stands on it keeps its wear.
    m.touch(25, 25, 1);
    m.sync(gl, () => [], 24);
    assert.equal(wearAt(m, 25, 25), 255);
    // Off the map: nothing, and nothing breaks.
    m.tread(5000, 5000, 60, 2); m.tread(-401, 0, 60, 0.5);
    assert.equal(m.stale.size, 0);
    // A way trodden along its length leaves no gaps.
    m.treadLine(-100, -100, -60, -80, 30, 1);
    for (let k = 0; k <= 10; k++) assert.ok(wearAt(m, -100 + 4 * k, -100 + 2 * k) > 12, 'at ' + k);
    m.clearWear();
    assert.deepEqual([wearAt(m, 25, 25), wearAt(m, -80, -90), m.stale.size], [0, 0, 256]);
});

test('what is no longer walked grows over again, a strip of the map at a time', () => {
    const m = new Occl.Map(800, () => canvas());
    m.dirty.clear();
    m.tread(25, 25, 40, 1);                 // row 544 of 1024: the ninth strip of sixteen
    m.tread(25, -390, 3, 1);                // the first strip
    m.stale.clear();
    const a = wearAt(m, 25, 25), b = wearAt(m, 25, -390);
    assert.equal(m.regrow(0), 0, 'the first call only starts the clock');
    assert.equal(m.regrow(REGROW_MS / REGROW_STRIPS - 1), 0, 'not yet');
    assert.equal(m.regrow(REGROW_MS / REGROW_STRIPS), 1, 'the first strip: one tile in it had wear');
    assert.deepEqual([wearAt(m, 25, -390), wearAt(m, 25, 25)], [b - 1, a]);
    assert.deepEqual([...m.stale], [0 * TILES + 8]);
    // One round of the map takes REGROW_MS and takes one step off everything.
    let t = REGROW_MS / REGROW_STRIPS;
    for (let k = 1; k < REGROW_STRIPS; k++) { t += REGROW_MS / REGROW_STRIPS; m.regrow(t); }
    assert.deepEqual([wearAt(m, 25, -390), wearAt(m, 25, 25)], [b - 1, a - 1]);
    for (let round = 0; round < 3; round++) for (let k = 0; k < REGROW_STRIPS; k++) { t += REGROW_MS / REGROW_STRIPS; m.regrow(t); }
    assert.deepEqual([wearAt(m, 25, -390), wearAt(m, 25, 25)], [0, a - 4], 'gone, and never below nothing');
    // A long gap (a paused match, a hidden tab) is one strip, not a leap.
    assert.ok(m.regrow(t + 1e7) <= TILES);
    assert.ok(REGROW_MS * 255 / 60000 > 30 && REGROW_MS * 255 / 60000 < 60, 'a bare path is green again in ' + (REGROW_MS * 255 / 60000).toFixed(0) + ' minutes');
});

// ---- the renderer --------------------------------------------------------------------
function renderer() {
    let sim = 0;
    const context = vm.createContext({ console, Math, Float32Array, Uint8Array, WeakMap, WeakSet, Map, Set, GLCore: { drawMesh() {} },
        document: { addEventListener() {}, createElement: () => canvas() },
        TexGen: { TERRAIN_SEED: 1, TERRAIN_WORLD: 1000, TERRAIN_LAND: 400 }, performance: { now: () => 0 } });
    context.window = context;
    for (const f of ['js/engine/math3d.js', 'js/engine/atmosphere.js', 'js/engine/occlusion.js', 'js/engine/gamerenderer.js']) vm.runInContext(read(f), context);
    const r = Object.create(context.EngineRenderer.prototype), { gl } = card();
    const unit = (x, z, type = 'infantry', o = {}) => Object.assign({ x, z, health: 10, _engine: { type }, mesh: { visible: true } }, o);
    Object.assign(r, { gl, visualStyle: 'cinematic', graphicsQuality: 'balanced', buildings: [], units: [], terrain: { size: 800, resources: [] },
        game: { simNow: () => sim }, _ghostFrom() {}, removeUnit() {}, removeBuilding() {}, spawnDust() {}, _rubble: [] });
    // One second of the match, as the frames of that second see it.
    const second = () => { sim += 1000; r._syncOcclusion(); };
    return { r, context, unit, second, T: context.EngineRenderer.TREAD, setSim: v => { sim = v; }, sim: () => sim };
}

test('a unit treads the way it came, once a second of the match; many feet make a path', () => {
    const { r, unit, second, T } = renderer();
    const walker = unit(0, 0), guard = unit(100, 100);
    r.units = [walker, guard];
    r._syncOcclusion(); second(); second();                       // the map, the clock, and a first look at where everyone stands
    const o = r._occl;
    assert.equal(o.treads, 0);
    walker.x = 6; second();                                       // six units in a second
    assert.equal(o.treads, 1);
    for (const x of [1, 3, 5]) assert.ok(wearAt(o, x, 0) >= T.foot * 0.9, 'trodden at ' + x);
    assert.equal(wearAt(o, 100, 100), 0, 'standing still wears nothing');
    assert.equal(wearAt(o, 12, 0), 0, 'and nothing ahead of where it got to');
    // Frames inside the same second add nothing.
    const once = wearAt(o, 3, 0);
    for (let i = 0; i < 30; i++) r._syncOcclusion();
    assert.equal(wearAt(o, 3, 0), once);
    // There and back, twenty times: a path. One pass is hardly a mark.
    assert.ok(once < 255 * 0.1, 'one pass: ' + once);
    for (let i = 0; i < 20; i++) { walker.x = 0; second(); walker.x = 6; second(); }
    assert.ok(wearAt(o, 3, 0) > 255 * 0.5, 'forty more: ' + wearAt(o, 3, 0));
    // A horse wears more than a man, an engine more than a horse.
    assert.ok(T.foot < T.horse && T.horse < T.siege);
    const horse = unit(0, 50, 'cavalry'), engine = unit(0, 80, 'siege'), treb = unit(0, 110, 'x', { _engine: { type: 'x', static: true } });
    r.units = [horse, engine, treb];
    second();
    horse.x = engine.x = treb.x = 6; second();
    assert.ok(wearAt(o, 3, 50) >= T.horse * 0.9 && wearAt(o, 3, 80) >= T.siege * 0.9 && wearAt(o, 3, 110) >= T.siege * 0.9);
    assert.ok(wearAt(o, 3, 81) > 0 && wearAt(o, 3, 51) === 0, 'and it is wider');
});

test('a jump is not a walk, and a unit that is not drawn leaves no trace', () => {
    const { r, unit, second } = renderer();
    const u = unit(0, 0), hidden = unit(0, 40), rival = unit(0, 80, 'infantry', { owner: 'rival' }), dead = unit(0, 120);
    r.units = [u, hidden, rival, dead];
    r._syncOcclusion(); second(); second();
    const o = r._occl;
    u.x = 200; second();                                          // a respawn, a seek
    assert.equal(o.treads, 0);
    assert.equal(wearAt(o, 100, 0), 0);
    u.x = 204; second();                                          // and it walks on from there
    assert.ok(wearAt(o, 202, 0) > 0 && wearAt(o, 100, 0) === 0);
    // Under fog, or left out of the model's view: nothing, and no streak when it shows again.
    hidden.mesh.visible = false; r.entityHidden = (e, kind) => kind === 'unit' && e.owner === 'rival'; dead.health = 0;
    hidden.x = rival.x = dead.x = 5; second();
    assert.deepEqual([wearAt(o, 3, 40), wearAt(o, 3, 80), wearAt(o, 3, 120)], [0, 0, 0]);
    hidden.mesh.visible = true; r.entityHidden = null;
    hidden.x = rival.x = 9; second();
    assert.ok(wearAt(o, 7, 40) > 0 && wearAt(o, 7, 80) > 0, 'drawn again, it treads again');
    assert.deepEqual([wearAt(o, 3, 40), wearAt(o, 3, 80)], [0, 0], 'from where it was last seen to stand, not from where it went under');
});

test('the earth is packed around a building once and before its door, and kept so; a death and a ruin scar the ground', () => {
    const { r, second, T } = renderer();
    const door = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 100, 0.025, 107];           // a model matrix: the decal before the door, at 100, 107
    const house = { x: 100, z: 100, type: 'house', _engine: { wear: { model: door } }, _grassFootprint: { ex: 5, ez: 4 }, mesh: { visible: true } };
    const farm = { x: -100, z: -100, type: 'farm', _engine: {}, _grassFootprint: { ex: 5, ez: 5 }, mesh: { visible: true } };
    r.buildings = [house, farm];
    r._syncOcclusion();
    const o = r._occl;
    const atDoor = wearAt(o, 100, 107), beside = wearAt(o, 106.5, 100);
    assert.ok(atDoor > T.door * 0.9, 'before the door: ' + atDoor);
    assert.ok(beside > 0 && beside < T.apron && beside < atDoor / 3, 'a little all round: ' + beside);
    assert.equal(wearAt(o, -100, -100), 0, 'a field is not packed earth');
    // Once: the fog taking the building and giving it back does not pack it again.
    for (let k = 0; k < 4; k++) { house.mesh.visible = k % 2 === 1; for (let i = 0; i < 6; i++) r._syncOcclusion(); }
    assert.equal(wearAt(o, 100, 107), atDoor);
    // Kept: it grows over like any ground, and every thirty seconds it is trodden a little again,
    // twice as much before the door, which is more than grows over in that time.
    for (let i = 0; i < 29; i++) second();
    const grown = wearAt(o, 100, 107);
    assert.ok(grown <= atDoor && grown >= atDoor - 3, 'half a minute of regrowth: ' + (atDoor - grown));
    second(); second();
    assert.ok(wearAt(o, 100, 107) > grown && wearAt(o, 100, 107) <= grown + T.upkeep * 2);
    assert.ok(T.upkeep * 2 > 30000 / REGROW_MS && T.upkeep > 30000 / REGROW_MS, 'trodden faster than it grows over');
    // Where someone fell, and where a building came down.
    r.killUnit({ x: 0.4, z: 0.4 });                                // the middle of a pixel of the map, so the centre is read at full strength
    assert.ok(wearAt(o, 0.4, 0.4) >= T.fallen * 0.9 && wearAt(o, 3.6, 0.4) === 0);
    r.killBuilding(house);
    assert.ok(wearAt(o, 100, 100) >= T.ruin * 0.9 && wearAt(o, 104, 100) > wearAt(o, 106.5, 100));
    assert.ok(T.ruin > T.fallen && T.ruin * REGROW_MS / 60000 > 15, 'a ruin shows for ' + (T.ruin * REGROW_MS / 60000).toFixed(0) + ' minutes');
});

test('the analyzer\'s still board wears nothing; a replay wears its own ground and a jump wipes it', () => {
    const { r, unit, second } = renderer();
    const u = unit(0, 0);
    r.units = [u];
    r._syncOcclusion(); second(); second();
    const o = r._occl;
    r.replayMode = true;                                          // decisions stepped through: a moment each
    u.x = 6; second(); u.x = 12; second();
    r.killUnit({ x: 50, z: 50 });
    assert.deepEqual([o.treads, wearAt(o, 3, 0), wearAt(o, 50, 50)], [0, 0, 0]);
    r.resimPlaying = true;                                        // played again: it moves as a match does
    let seats = [{}];
    r.ageSource = () => seats;
    second(); u.x = 18; second();
    assert.ok(wearAt(o, 15, 0) > 0);
    seats = null;                                                 // the replay jumps
    r._syncOcclusion();
    assert.deepEqual([wearAt(o, 15, 0), o.treads], [0, 0]);
    seats = [{}];
    u.x = 300; second(); second();                                // landed somewhere else: no streak across the map
    assert.equal(o.treads, 0);
    u.x = 304; second();
    assert.ok(wearAt(o, 302, 0) > 0);
    // Nothing of this in Simple lighting or on Low: no map, no wear.
    const low = renderer();
    low.r.graphicsQuality = 'low';
    low.r._syncOcclusion(); low.r.killUnit({ x: 0, z: 0 });
    assert.equal(low.r._occl, undefined);
});

test('the shader: broad variation and relief on open ground, bare soil and thinner grass where it is worn, Simple lighting untouched', () => {
    const { context } = renderer();
    const f = vm.runInContext('EngineAtmosphere.fragment', context), R = context.EngineRenderer, src = read('js/engine/gamerenderer.js');
    assert.match(f, /uniform vec2 uGroundVary;\s+uniform vec4 uSoil;/);
    // Three slow waves; their slopes are the derivatives of the same waves, so the shading fits the patches.
    const m = f.match(/float w1=q\.x\*([\d.]+)\+q\.y\*([\d.]+), w2=q\.y\*([\d.]+)-q\.x\*([\d.]+)\+1\.7, w3=q\.x\*([\d.]+)\+q\.y\*([\d.]+)\+0\.6;\s+float broad=([\d.]+)\*sin\(w1\)\+([\d.]+)\*sin\(w2\)\+([\d.]+)\*sin\(w3\);\s+vec2 slope=vec2\(([^;]+)\);/);
    assert.ok(m, 'the waves and their slopes');
    const [ax, az, bz, bx, cx, cz, wa, wb, wc] = m.slice(1, 10).map(Number);
    assert.ok(Math.abs(wa + wb + wc - 1) < 1e-9, 'the three add up to one');
    for (const k of [ax, az, bz, bx, cx, cz]) assert.ok(2 * Math.PI / k > 35 && 2 * Math.PI / k < 320, 'a wave ' + (2 * Math.PI / k).toFixed(0) + ' units long');
    const slope = m[10].replace(/\s+/g, '');
    assert.equal(slope, `${wa}*${ax}*cos(w1)-${wb}*${bx}*cos(w2)+${wc}*${cx}*cos(w3),${wa}*${az}*cos(w1)+${wb}*${bz}*cos(w2)+${wc}*${cz}*cos(w3)`);
    // Only Atmospheric, only the ground and the grass on it, never the sea; and after Simple lighting has taken its sum.
    assert.match(f, /if \(uAtmosphere > 0\.5 && uGroundVary\.x > 0\.0 && \(\(uMaterial > 0\.5 && uMaterial < 1\.5\) \|\| \(uVegetation > 0\.5 && vPebble < 0\.5\)\)\) \{/);
    assert.ok(f.indexOf('vec3 legacy = base*(uAmbient + uSunColor*sun);') < f.indexOf('float broad='), 'legacy is summed from the plain colour');
    assert.match(f, /float land=1\.0-water;\s+base\*=1\.0\+land\*uGroundVary\.x\*broad;/);
    assert.match(f, /relief=1\.0-land\*82\.0\*uGroundVary\.x\*dot\(slope,uSunDir\.xz\);/);
    // How strong per land: a meadow leans dry or lush, sand a little, snow only rolls.
    assert.deepEqual(JSON.parse(JSON.stringify(R.GROUND_VARY)), { summer: [0.11, 1], desert: [0.09, 0.3], winter: [0.07, 0] });
    for (const v of Object.values(R.GROUND_VARY)) assert.ok(v[0] * (wa + wb + wc) <= 0.12, 'never more than an eighth lighter or darker');
    // Worn ground: toward this land's soil, the edge broken by the ground's grain; no grass on it.
    assert.match(f, /float worn=smoothstep\(0\.10,0\.62,ground\.y\+grain\*0\.5\+[^;]+\)\*\(1\.0-water\);\s+base=mix\(base,uSoil\.rgb\*\(0\.94\+grain\*0\.5\),worn\*uSoil\.a\);\s+groundCover\*=1\.0-worn;/);
    assert.match(f, /if \(uVegetation > 0\.5 && vPebble < 0\.5 && ground\.y > 0\.14 \+ 0\.5\*waveHash\(floor\(vWorld\.xz\*1\.6\)\)\) discard;/);
    assert.match(src, /this\._soil = \[\.\.\.palette\.soil\.map\(v => v \/ 255 \* bare\[0\]\), bare\[1\]\];/);
    assert.match(src, /gl\.uniform4fv\(this\.prog\.uniforms\.uSoil, this\._soil \|\| \[0\.5, 0\.45, 0\.35, 0\]\);/);
    assert.match(src, /gl\.uniform2f\(this\.prog\.uniforms\.uGroundVary, vary\[0\], vary\[1\]\);/);
    assert.ok(R.WORN.summer[1] > R.WORN.winter[1] && R.WORN.summer[1] > R.WORN.desert[1], 'a path shows most across a meadow');
    // In Simple lighting the map is not read (its strength is zero there), so nothing is worn and nothing thins.
    assert.match(f, /if \(uOcclMap\.y > 0\.0 && onGround\) \{/);
});
