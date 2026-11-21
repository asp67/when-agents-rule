// Contact shading (overhaul step A2): js/engine/occlusion.js keeps a top-down map of what
// stands on the ground, in tiles; the renderer keeps it current and the shader reads it.
// The map's second channel, wear, is step A3 (tests/ground.test.cjs).
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const Occl = require(path.join(root, 'js/engine/occlusion.js'));
const { SIZE, TILE, TILES, REACH } = Occl;

// A canvas that records what is painted on it, and a card that records what it is sent.
function canvas() {
    const calls = [];
    const ctx = new Proxy({ calls }, {
        get: (t, k) => k in t ? t[k]
            : k === 'getImageData' ? (x, y, w, h) => { calls.push(['read', x, y, w, h]); const d = new Uint8Array(w * h * 4); for (let i = 0; i < w * h; i++) { d[i * 4] = (x / TILE + i) % 251; d[i * 4 + 1] = 7; } return { data: d }; }
            : k === 'createRadialGradient' ? (...a) => { const g = { at: a, stops: [], addColorStop(o, c) { this.stops.push([o, c]); } }; return g; }
            : (...a) => { calls.push([k, ...a]); },
        set: (t, k, v) => { t[k] = v; calls.push(['set ' + k, typeof v === 'object' ? 'gradient' : v]); return true; } });
    return { ctx, calls, getContext: (kind, opts) => { calls.push(['context', kind, opts && opts.willReadFrequently]); return ctx; } };
}
function card() {
    const log = [];
    const gl = new Proxy({}, { get: (t, k) => typeof k === 'string' && /^[A-Z][A-Z0-9_]*$/.test(k) ? k : (...a) => { log.push([k, ...a]); return k === 'createTexture' ? { tex: true } : undefined; } });
    return { gl, log };
}
const tileOf = (x, z, span) => Math.floor((z / span + 0.5) * SIZE / TILE) * TILES + Math.floor((x / span + 0.5) * SIZE / TILE);

test('the map is 1024 pixels over the playable square, in tiles; a change marks only the tiles it can reach', () => {
    assert.deepEqual([SIZE, TILE, TILES], [1024, 64, 16]);
    const m = new Occl.Map(800, () => canvas());
    assert.equal(m.dirty.size, 256, 'a new map is painted whole');
    assert.deepEqual([m.px(-400), m.px(0), m.px(400), m.perUnit], [0, 512, 1024, 1.28]);
    m.dirty.clear();
    // The middle of a tile, a small thing: that tile only. One tile is 50 world units across.
    m.touch(25, 25, 2);
    assert.deepEqual([...m.dirty], [tileOf(25, 25, 800)]);
    // On a tile's edge: both sides. At a corner: four.
    m.dirty.clear(); m.touch(50, 25, 1);
    assert.deepEqual([...m.dirty].sort((a, b) => a - b), [tileOf(49, 25, 800), tileOf(51, 25, 800)]);
    m.dirty.clear(); m.touch(50, 50, 1);
    assert.equal(m.dirty.size, 4);
    // Within reach of an edge counts: a thing darkens the ground past its own edge.
    m.dirty.clear(); m.touch(50 - 1 - REACH + 0.1, 25, 1);
    assert.equal(m.dirty.size, 2);
    m.dirty.clear(); m.touch(50 - 1 - REACH - 0.6, 25, 1);
    assert.equal(m.dirty.size, 1);
    // Off the map, or over its rim: nothing outside the 256 tiles.
    m.dirty.clear(); m.touch(-399, 399, 3); m.touch(5000, 5000, 3);
    assert.deepEqual([...m.dirty], [15 * TILES]);
    m.touchAll();
    assert.equal(m.dirty.size, 256);
    // A tile's painter is asked for what stands in its square and what can reach into it.
    const t = m.tileWorld(tileOf(25, 25, 800));
    assert.deepEqual([t.tx, t.tz, t.x0, t.z0, t.x1, t.z1], [8, 8, -REACH, -REACH, 50 + REACH, 50 + REACH]);
});

test('painting takes a few tiles a frame: each cleared, painted from what stands there, and sent as its own small piece', () => {
    const c = canvas(), { gl, log } = card();
    const m = new Occl.Map(800, () => c);
    assert.deepEqual(c.calls[0], ['context', '2d', true], 'read back tile by tile, so kept in main memory');
    m.dirty.clear();
    m.touch(25, 25, 2); m.touch(125, 25, 2); m.touch(225, 25, 2);
    const asked = [];
    const blobs = (x0, z0, x1, z1) => { asked.push([x0, z0, x1, z1]); return [{ x: 25, z: 25, r: 2, strength: 0.78 }, { x: 30, z: 30, ex: 4, ez: 3, strength: 1 }]; };
    c.calls.length = 0;
    assert.equal(m.sync(gl, blobs, 2), 2, 'two this frame');
    assert.equal(m.dirty.size, 1);
    assert.deepEqual(asked[0], [-REACH, -REACH, 50 + REACH, 50 + REACH]);
    // The whole texture is made once, empty; then one piece per tile at the tile's own place.
    const whole = log.filter(l => l[0] === 'texImage2D'), parts = log.filter(l => l[0] === 'texSubImage2D');
    assert.deepEqual([whole.length, whole[0].slice(1, 9).join()], [1, 'TEXTURE_2D,0,LUMINANCE_ALPHA,1024,1024,0,LUMINANCE_ALPHA,UNSIGNED_BYTE']);
    assert.deepEqual(parts.map(p => p.slice(1, 9).join()), ['TEXTURE_2D,0,512,512,64,64,LUMINANCE_ALPHA,UNSIGNED_BYTE', 'TEXTURE_2D,0,640,512,64,64,LUMINANCE_ALPHA,UNSIGNED_BYTE']);
    assert.ok(parts[0][9] instanceof Uint8Array && parts[0][9].length === 64 * 64 * 2, 'two channels a pixel');
    // One buffer serves every tile (the card copies it as it is sent), so it holds the last one
    // here: the tile at 640, whose stand-in pixels count up from 10 in red. What stands is the
    // red of what was painted; the other channel is the wear, none here.
    assert.equal(parts[0][9], parts[1][9]);
    assert.deepEqual(Array.from(parts[1][9].slice(0, 6)), [10, 0, 11, 0, 12, 0]);
    assert.deepEqual([m.occ[512 * 1024 + 640], m.occ[512 * 1024 + 641]], [10, 11], 'and it is kept, so a tile can be sent again without being painted again');
    // On the canvas, per tile: clip to the tile, clear it, then paint so that overlaps take the darker of the two.
    const k = c.calls.map(x => x[0] + (x.length > 1 ? ' ' + x.slice(1).join(',') : ''));
    const first = k.slice(0, k.indexOf('restore') + 2);
    assert.deepEqual(first.slice(0, 8), ['save', 'beginPath', 'rect 512,512,64,64', 'clip', 'set globalCompositeOperation source-over', 'set fillStyle #000', 'fillRect 512,512,64,64', 'set globalCompositeOperation lighten']);
    assert.deepEqual(first.slice(-2), ['restore', 'read 512,512,64,64']);
    assert.equal(m.sync(gl, blobs, 24), 1);
    assert.equal(m.sync(gl, blobs, 24), 0, 'nothing changed: nothing painted, nothing sent');
    assert.deepEqual([m.painted, m.sent, log.filter(l => l[0] === 'texSubImage2D').length], [3, 3, 3]);
    m.dispose(gl);
    assert.equal(m.texture, null);
    // No canvas (a test's stand-in renderer): the map does nothing and breaks nothing.
    assert.equal(new Occl.Map(800, null).sync(gl, blobs, 24), 0);
});

test('a round thing fades from its body outward; a box is darkest along its walls and soft beyond them', () => {
    const c = canvas(), m = new Occl.Map(800, () => c);
    c.calls.length = 0;
    m.paint({ x: 0, z: 0, r: 2, strength: 0.5 });
    const arc = c.calls.find(x => x[0] === 'arc');
    assert.deepEqual([arc[1], arc[2]], [512, 512]);
    assert.ok(arc[3] > 2 * 1.28 && arc[3] < (2 + REACH) * 1.28, 'past its radius, inside its reach: ' + arc[3]);
    c.calls.length = 0;
    m.paint({ x: 0, z: 0, ex: 5, ez: 3, strength: 1 });
    const set = Object.fromEntries(c.calls.filter(x => x[0].startsWith('set ')).map(x => [x[0].slice(4), x[1]]));
    const rect = c.calls.find(x => x[0] === 'fillRect');
    // Only the blurred shadow lands on the map: the box itself is drawn far off it.
    assert.ok(rect[1] + rect[3] < 0, 'the box is off the canvas');
    assert.ok(rect[3] / 2 > 5 * 1.28 && rect[4] / 2 > 3 * 1.28, 'wider than its walls');
    assert.ok((rect[3] / 2) / 1.28 - 5 + 0 < REACH && c.calls.some(x => x[0] === 'set shadowBlur' && x[1] > 2 && x[1] / 1.28 + (rect[3] / 2) / 1.28 - 5 <= REACH + 1e-9), 'and all of it within reach');
    assert.equal(set.shadowOffsetX, 0, 'the shadow settings are put back');
    assert.ok(c.calls.some(x => x[0] === 'set shadowColor' && x[1] === 'rgb(255,255,255)'));
});

// ---- the renderer --------------------------------------------------------------------
function renderer() {
    const context = vm.createContext({ console, Math, Float32Array, Uint8Array, WeakMap, Map, Set, GLCore: { drawMesh() {} },
        document: { addEventListener() {}, createElement: () => canvas() }, TexGen: { TERRAIN_SEED: 1, TERRAIN_WORLD: 1000, TERRAIN_LAND: 400 }, performance: { now: () => 0 } });
    context.window = context;
    for (const f of ['js/engine/math3d.js', 'js/engine/atmosphere.js', 'js/engine/occlusion.js', 'js/engine/gamerenderer.js']) vm.runInContext(read(f), context);
    const r = Object.create(context.EngineRenderer.prototype), { gl, log } = card();
    const res = (type, x, z, amount = 100) => ({ type, x, z, amount });
    const house = (x, z, o = {}) => Object.assign({ x, z, _engine: {}, _grassFootprint: { ex: 5, ez: 4 }, mesh: { visible: true } }, o);
    Object.assign(r, { gl, visualStyle: 'cinematic', graphicsQuality: 'balanced', buildings: [house(100, 100)],
        terrain: { size: 800, resources: [res('wood', -100, -100), res('wood', -98, -100), res('stone', 200, -200), res('gold', 210, -200), res('food', 0, 300), res('wood', 390, 390, 0)] } });
    return { r, gl, log, context, house, res };
}
const kinds = list => Array.from(list, b => (b.r != null ? 'round' : 'box') + '@' + b.x + ',' + b.z).sort();

test('the renderer keeps the map to what stands and is drawn: buildings, and nodes that have something left', () => {
    const { r, house } = renderer();
    r._syncOcclusion();
    const o = r._occl;
    assert.deepEqual([o.span, o.painted, o.dirty.size], [800, 24, 232], 'a new map, the first 24 tiles of it');
    for (let i = 0; i < 10; i++) r._syncOcclusion();
    assert.deepEqual([o.painted, o.dirty.size], [256, 0], 'whole after eleven frames');
    // What stands in a square: the nodes with something left, and the building by its walls.
    assert.deepEqual(kinds(r._occlBlobs(-400, -400, 400, 400)), ['box@100,100', 'round@-100,-100', 'round@-98,-100', 'round@0,300', 'round@200,-200', 'round@210,-200']);
    assert.deepEqual(kinds(r._occlBlobs(190, -210, 205, -190)), ['round@200,-200']);
    const box = Array.from(r._occlBlobs(90, 90, 110, 110))[0];
    assert.deepEqual([box.ex, box.ez, box.strength], [4, 3, 1], 'the footprint less the unit of margin it carries for the grass');
    // A tree is larger or smaller by its own number, as it is drawn.
    const [a, b] = Array.from(r._occlBlobs(-101, -101, -97, -99));
    assert.ok(a.r !== b.r && a.r > 1.2 && b.r < 2.1 && a.strength === 0.78);

    // Nothing changes: nothing is painted.
    for (let i = 0; i < 12; i++) r._syncOcclusion();
    assert.equal(o.painted, 256);
    // A tree is felled: its tiles are painted again without it. Seen within six frames.
    r.terrain.resources[0].amount = 0;
    for (let i = 0; i < 6; i++) r._syncOcclusion();
    assert.ok(o.painted > 256 && o.painted <= 260, 'a handful of tiles: ' + (o.painted - 256));
    assert.deepEqual(kinds(r._occlBlobs(-101, -101, -97, -99)), ['round@-98,-100']);
    // A building goes up, and one comes down.
    let before = o.painted;
    r.buildings.push(house(-200, 200));
    for (let i = 0; i < 6; i++) r._syncOcclusion();
    assert.ok(o.painted > before);
    assert.deepEqual(kinds(r._occlBlobs(-210, 190, -190, 210)), ['box@-200,200']);
    before = o.painted;
    r.buildings.shift();
    for (let i = 0; i < 6; i++) r._syncOcclusion();
    assert.ok(o.painted > before);
    assert.deepEqual(kinds(r._occlBlobs(90, 90, 110, 110)), []);
});

test('a building that is not drawn darkens nothing: the ground does not give away what the fog or the model\'s view hides', () => {
    const { r, house } = renderer();
    const rival = house(-300, 0, { owner: 'rival' });
    r.buildings.push(rival);
    for (let i = 0; i < 12; i++) r._syncOcclusion();
    assert.deepEqual(kinds(r._occlBlobs(-310, -10, -290, 10)), ['box@-300,0']);
    const painted = () => r._occl.painted;
    let before = painted();
    rival.mesh.visible = false;                                   // the fog takes it
    for (let i = 0; i < 6; i++) r._syncOcclusion();
    assert.deepEqual(kinds(r._occlBlobs(-310, -10, -290, 10)), []);
    assert.ok(painted() > before, 'and its tiles are painted again');
    rival.mesh.visible = true;
    for (let i = 0; i < 6; i++) r._syncOcclusion();
    assert.equal(r._occlBlobs(-310, -10, -290, 10).length, 1);
    r.entityHidden = (e, kind) => kind === 'building' && e.owner === 'rival';   // the model's view leaves it out
    for (let i = 0; i < 6; i++) r._syncOcclusion();
    assert.deepEqual(kinds(r._occlBlobs(-310, -10, -290, 10)), []);
    r.entityHidden = null;
    for (let i = 0; i < 6; i++) r._syncOcclusion();
    assert.equal(r._occlBlobs(-310, -10, -290, 10).length, 1);
    // One not composed yet has no footprint to darken with.
    r.buildings.push({ x: 0, z: 0, mesh: { visible: true } });
    for (let i = 0; i < 6; i++) r._syncOcclusion();
    assert.deepEqual(kinds(r._occlBlobs(-10, -10, 10, 10)), []);
});

test('no contact shading in Simple lighting or on Low; another map starts another occlusion map', () => {
    const { r, context } = renderer();
    assert.equal(r._occlStrength(), context.EngineRenderer.CONTACT);
    assert.ok(context.EngineRenderer.CONTACT > 0.4 && context.EngineRenderer.CONTACT <= 1);
    for (const [k, v] of [['visualStyle', 'classic'], ['graphicsQuality', 'low']]) {
        const keep = r[k]; r[k] = v;
        assert.equal(r._occlStrength(), 0, v);
        r._syncOcclusion();
        assert.equal(r._occl, undefined, v + ': no map is built that nothing reads');
        r[k] = keep;
    }
    r._syncOcclusion();
    const first = r._occl;
    r.terrain = { size: 1200, resources: [] };
    r._syncOcclusion();
    assert.ok(r._occl !== first && r._occl.span === 1200 && first.texture === null, 'the old one is given back to the card');
    assert.match(read('js/engine/gamerenderer.js'), /if \(this\._occl\) \{ this\._occl\.dispose\(this\.gl\); this\._occl = null; \}/);
});

test('the shader reads the map for the ground and the grass, never under fog, and darkens standing things toward their foot', () => {
    const f = vm.runInContext('EngineAtmosphere.fragment', renderer().context);
    assert.match(f, /uniform sampler2D uOccl;\s+uniform vec2 uOcclMap;/);
    // One read of the map, for the ground and the grass, and nothing of it under fog.
    assert.match(f, /bool onGround = \(uMaterial > 0\.5 && uMaterial < 1\.5\) \|\| uVegetation > 0\.5;\s+if \(uOcclMap\.y > 0\.0 && onGround\) \{\s+vec4 standing = texture2D\(uOccl, vWorld\.xz\*uOcclMap\.x \+ 0\.5\);\s+ground = vec2\(standing\.r, standing\.a\);\s+if \(uClutterFog > 0\.5\) ground \*= texture2D\(uClutterVisibility, vWorld\.xz\/uClutterMapSize \+ 0\.5\)\.r;/);
    assert.equal((f.match(/texture2D\(uOccl/g) || []).length, 1);
    assert.match(f, /if \(onGround\) \{\s+contact = 1\.0 - ground\.x\*uOcclMap\.y;/);
    assert.match(f, /\} else if \(uMaterial < 0\.5\) \{\s+contact = mix\(1\.0 - 0\.55\*uOcclMap\.y, 1\.0, smoothstep\(0\.0, 1\.5, vWorld\.y\)\);/);
    // Simple lighting is not touched by it.
    assert.doesNotMatch(f, /legacy[^;\n]*contact/);
    const src = read('js/engine/gamerenderer.js'), html = read('index.html');
    assert.match(src, /gl\.activeTexture\(gl\.TEXTURE5\);\s+gl\.bindTexture\(gl\.TEXTURE_2D, occl \? occl\.texture : this\.tex\.white\);\s+gl\.uniform1i\(this\.prog\.uniforms\.uOccl, 5\);\s+gl\.uniform2f\(this\.prog\.uniforms\.uOcclMap, occl \? 1 \/ occl\.span : 0, occl \? this\._occlStrength\(\) : 0\);/);
    assert.match(src, /this\._syncFog\(\);\s+this\._syncOcclusion\(\);/);
    assert.ok(html.indexOf('js/engine/occlusion.js') > 0 && html.indexOf('js/engine/occlusion.js') < html.indexOf('js/engine/gamerenderer.js'));
});
