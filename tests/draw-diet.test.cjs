// The draw-call diet (overhaul step A4), second step: a building casts its shadow as one
// shape instead of batch by batch, its dressing is merged per material like the building,
// and the dressing is left out from the height where it is smaller than a pixel.
const test = require('node:test'), assert = require('node:assert/strict');
const vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
const src = f => fs.readFileSync(path.join(__dirname, '../js/engine/' + f + '.js'), 'utf8');

function load() {
    const scope = { window: {}, console, performance: { now: () => 1000 } }; scope.window.window = scope.window; vm.createContext(scope);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/simulation/island.js'), 'utf8'), scope);   // the island the painters read (build 1188)
    for (const f of ['math3d', 'mesh', 'texgen', 'buildings', 'units', 'atmosphere']) vm.runInContext(src(f), scope);
    let made = 0;
    scope.window.GLCore = { createMeshBuffers: (gl, mesh) => { made++; return { mesh, n: mesh.positions.length / 3 }; },
        createShadowBuffers: (gl, mesh) => { made++; return { mesh, n: mesh.positions.length / 3, shadowOnly: true }; }, drawMesh: (gl, prog, buf) => gl.drawn.push(buf) };
    vm.runInContext('Object.assign(globalThis, window);' + src('gamerenderer'), scope);
    return { W: scope.window, R: vm.runInContext('window.EngineRenderer', scope), made: () => made, scope };
}
const vertsOf = (W, parts) => parts.reduce((n, p) => n + W.EngineMesh[p.kind](...p.args).positions.length / 3, 0);

test('a building casts as one shape: every solid part in it, built once per model', () => {
    const { W, R, made } = load(), fake = { gl: {} };
    const parts = W.EngineBuildings.parts('town_center', { age: 'iron', civ: 'greek' });
    const solid = parts.filter(p => !p.blend);
    assert.ok(solid.length > 20 && solid.length < parts.length, solid.length + ' solid parts of ' + parts.length);
    const casters = R.prototype._buildingCaster.call(fake, 'town_center|iron|greek', parts);
    assert.equal(casters.length, 1);
    assert.equal(casters[0].n, vertsOf(W, solid), 'all the solid geometry, none of the see-through');
    assert.equal(R.prototype._buildingCaster.call(fake, 'town_center|iron|greek', parts), casters, 'built once per model');
    assert.equal(made(), 1);
    // Against the batches the shadow pass used to draw.
    const batches = R.prototype._buildingBatches.call(fake, 'town_center|iron|greek', parts).filter(b => !b.blend);
    assert.ok(batches.length >= 5, batches.length + ' solid batches were ' + batches.length + ' shadow draws');
    // The largest building of all: a 16-bit index range holds 65535 corners, so it may take more than one.
    const col = W.EngineBuildings.parts('colosseum', {}), big = R.prototype._buildingCaster.call(fake, 'colosseum|iron|roman', col);
    assert.ok(big.length >= 1 && big.length <= 3, big.length + ' casters for the Colosseum');
    assert.ok(big.every(b => b.n <= 65535));
    assert.equal(big.reduce((n, b) => n + b.n, 0), vertsOf(W, col.filter(p => !p.blend)));
    // Forced to split: nothing lost, nothing over the range.
    const many = []; for (let i = 0; i < 9; i++) many.push(...solid.map(p => Object.assign({}, p)));
    const split = R.prototype._buildingCaster.call(fake, 'nine town centers', many);
    if (vertsOf(W, many) > 65535) assert.ok(split.length > 1);
    assert.ok(split.every(b => b.n <= 65535));
    assert.equal(split.reduce((n, b) => n + b.n, 0), vertsOf(W, many));
});

test('the shadow pass draws what casts for itself, and each building once', () => {
    const { R } = load();
    const drawn = [], calls = [];
    const gl = new Proxy({ drawn }, { get: (t, k) => k in t ? t[k] : typeof k === 'string' && /^[A-Z][A-Z0-9_]*$/.test(k) ? k : (...a) => { calls.push(k); return false; } });
    const r = Object.create(R.prototype), e = (name, o) => Object.assign({ buf: name, model: [] }, o);
    Object.assign(r, { gl, visualStyle: 'cinematic', _halfH: 40, cameraTarget: { x: 0, z: 0 }, sunDir: [-0.63, 0.7, 0.35], shadowProg: { uniforms: {} },
        _shadowTarget: { size: 1024, framebuffer: {} }, _ground: e('ground'), _sea: e('sea') });
    r._dl = { opaque: [r._sea, r._ground, e('wall batch', { noShadow: true }), e('roof batch', { noShadow: true }), e('flag pole'), e('runner', { noShadow: true }), e('unit part'), e('grass', { noShadow: true })],
        blended: [e('smoke')], bars: [], casters: [e('town center, whole'), e('house, whole')] };
    r._renderShadows();
    assert.deepEqual(drawn, ['flag pole', 'unit part', 'town center, whole', 'house, whole']);
    // A list made before there were casters (a test's stand-in) still draws.
    drawn.length = 0;
    r._dl = { opaque: [e('unit part')], blended: [], bars: [] };
    r._renderShadows();
    assert.deepEqual(drawn, ['unit part']);
});

test('a finished building: batches for the picture, a caster for the shadow, its dressing merged with the model', () => {
    const s = src('gamerenderer');
    // The batches say they cast nothing; the caster carries the building's own matrix.
    assert.match(s, /model: world, base: m3\.identity\(\), noShadow: true \};\s+\(g\.blend \? eb\.blended : eb\.opaque\)\.push\(entry\);\s+\}\s+eb\.casters = this\._buildingCaster\(modelKey, parts\)\.map\(buf => \(\{ buf, model: world \}\)\);/);
    // A building under construction has no model key: its parts cast one by one, as before.
    assert.match(s, /\} else parts\.forEach\(\(p, i\) => \{\s+const entry = \{\s+buf: this\._buf\(p\.kind, p\.args\), tex: this\.tex\[p\.tex\],/);
    // In the frame: a caster goes with the building when it is drawn solid, not when it is a remembered, faded one.
    assert.match(s, /for \(const en of eb\.opaque\) dl\.opaque\.push\(flash \? \{ \.\.\.en, tint: FLASH \} : en\);\s+for \(const en of eb\.blended\) dl\.blended\.push\(en\);\s+if \(eb\.casters\) for \(const en of eb\.casters\) dl\.casters\.push\(en\);/);
    const faded = s.slice(s.indexOf('if (b._fade != null && b._fade < 1) {'), s.indexOf('for (const en of eb.opaque) dl.opaque.push(flash'));
    assert.doesNotMatch(faded, /casters/);
    // Both pictures of a frame have their own list of casters, emptied before each is built.
    assert.match(s, /this\._dl = \{ opaque: \[\], blended: \[\], bars: \[\], casters: \[\] \};/);
    assert.match(s, /this\._dl2 = \{ opaque: \[\], blended: \[\], bars: \[\], casters: \[\] \}\)/);
    assert.match(s, /\(dl\.casters \|\| \(dl\.casters = \[\]\)\)\.length = 0;/);
    // The dressing: merged per material and cached with the model; a Wonder's has its own key (two lamps).
    assert.match(s, /const dressed=modelKey\?dressing\.parts\.map\(p=>p\.blend\?Object\.assign\(\{\},p,\{blend:false\}\):p\):null;\s+eb\.details=modelKey\s+\? this\._buildingBatches\(modelKey\+'\|dressing\|'\+!!building\.isWonder,dressed\)/);
    // Left out, with the worn patch before the door, from where units are their far models; the lights stay.
    assert.match(s, /if\(this\._halfH<=EngineRenderer\.FAR_UNIT_HALF_H\)\{\s+for\(const p of eb\.details\)/);
    assert.match(s, /if\(eb\.wear&&this\._halfH<=EngineRenderer\.FAR_UNIT_HALF_H\)dl\.blended\.push/);
    const block = s.slice(s.indexOf('if(eb.details&&courtyards++<24){'), s.indexOf('for(const p of eb.details)'));
    assert.match(block, /addLight\(x,y,z,strength\)/, 'the lamps are lit before the dressing is decided on');
    // The dressing casts as one shape as well (build 1185): its batches say they cast nothing, and its
    // caster goes with it only while it is drawn solid. Fading out it is see-through and casts nothing.
    assert.match(s, /\.map\(g=>\(\{buf:g\.buf,tex:this\.tex\[g\.texName\],tint:g\.tint\|\|this\.WHITE,model:world,noShadow:true\}\)\)/);
    assert.match(s, /eb\.detailCasters=modelKey\?this\._buildingCaster\(modelKey\+'\|dressing\|'\+!!building\.isWonder,dressed\)\.map\(buf=>\(\{buf,model:world\}\)\):null;/);
    assert.match(s, /if\(detailFade===1&&eb\.detailCasters\)for\(const en of eb\.detailCasters\)dl\.casters\.push\(en\);/);
});

test('the dressing of a building really is the same for every building of its model', () => {
    const { W } = load(), B = W.EngineBuildings;
    const fp = { ex: 5, ez: 5, ey: 6 };
    const a = JSON.stringify(B.settlement('house', 'greek', fp)), b = JSON.stringify(B.settlement('house', 'greek', fp));
    assert.equal(a, b);
    assert.notEqual(a, JSON.stringify(B.settlement('house', 'egyptian', fp)));
    assert.doesNotMatch(src('buildings'), /Math\.random/);
});

// ---- the town (build 1185) ---------------------------------------------------------------
test('a caster is where the corners are and nothing else', () => {
    const scope = { window: {}, console }; vm.createContext(scope);
    vm.runInContext(src('glcore'), scope);
    const G = scope.window.GLCore, made = [];
    const gl = new Proxy({}, { get: (t, k) => typeof k === 'string' && /^[A-Z][A-Z0-9_]*$/.test(k) ? k : (...a) => { if (k === 'bufferData') made.push(a[0] + ' ' + a[1].constructor.name + ' ' + a[1].length); return {}; } });
    const mesh = { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1], uvs: [0, 0, 1, 0, 0, 1], indices: [0, 1, 2] };
    const plain = G.createShadowBuffers(gl, mesh);
    assert.deepEqual(made, ['ARRAY_BUFFER Float32Array 9', 'ELEMENT_ARRAY_BUFFER Uint16Array 3'], 'no normals, no texture coordinates');
    assert.deepEqual([!!plain.position, plain.normal, plain.uv, plain.bone, plain.count], [true, undefined, undefined, null, 3]);
    assert.ok(G.createShadowBuffers(gl, Object.assign({ bones: new Float32Array([0, 1, 1]) }, mesh)).bone, 'a unit\'s caster keeps its bones');
    // Drawn by the shadow's program, which asks for the position (and the bone) only.
    const calls = [];
    const gl2 = new Proxy({}, { get: (t, k) => k in t ? t[k] : typeof k === 'string' && /^[A-Z][A-Z0-9_]*$/.test(k) ? k : k === 'getExtension' ? () => null
        : (k === 'createVertexArray' || String(k).startsWith('_')) ? undefined : (...a) => { calls.push(k); } });
    G.drawMesh(gl2, { attribs: { aPosition: 0, aBone: 1 } }, plain);
    assert.deepEqual(calls, ['bindBuffer', 'enableVertexAttribArray', 'vertexAttribPointer', 'disableVertexAttribArray', 'bindBuffer', 'drawElements']);
    // The casters of buildings, units and forest chunks are all made this way.
    const s = src('gamerenderer');
    assert.equal((s.match(/GLCore\.createShadowBuffers\(/g) || []).length, 3);
});

test('a forest chunk casts as one shape, and a felled tree leaves it too', () => {
    const { W, R } = load();
    const log = [];
    let cur = null;
    const gl = { ARRAY_BUFFER: 1, bindBuffer: (t, b) => { cur = b; }, bufferSubData: (t, off, d) => { cur.data.set(d, off / 4); log.push(cur); }, deleteBuffer() {} };
    W.GLCore.createMeshBuffers = (g, mesh) => ({ mesh, position: { data: Float32Array.from(mesh.positions) } });
    W.GLCore.createShadowBuffers = (g, mesh) => ({ mesh, shadowOnly: true, position: { data: Float32Array.from(mesh.positions) } });
    const r = Object.create(R.prototype);
    Object.assign(r, { gl, _resEntries: new WeakMap(), _theme: 'summer', _geo: new Map(), _cull: () => false, _buf: (kind, args) => ({ kind, args }) });
    r.tex = new Proxy({}, { get: (o, k) => (o[k] = o[k] || { name: k }) });
    const node = (x, z, type = 'wood') => ({ type, x, z, amount: 100, mesh: type === 'wood' ? { trunk: { visible: true }, leaves: { visible: true } } : { visible: true } });
    const rs = []; for (let i = 0; i < 24; i++) rs.push(node(5 + (i % 6) * 4, 5 + Math.floor(i / 6) * 4));
    rs.push(node(30, 30, 'stone'), node(34, 30, 'gold'));
    r.terrain = { resources: rs };
    const frame = () => { const dl = { opaque: [], blended: [], casters: [] }; r._pushResourceChunks(dl); return dl; };
    const dl = frame();
    // For the picture: a batch per material, none of which casts. For the shadow: one shape.
    assert.ok(dl.opaque.length >= 3 && dl.opaque.every(e => e.noShadow === true && e.tex), dl.opaque.length + ' solid batches');
    assert.equal(dl.casters.length, 1, dl.opaque.length + ' shadow draws were, 1 is');
    assert.ok(dl.casters[0].buf.shadowOnly && !dl.casters[0].tex);
    assert.equal(dl.casters[0].buf.mesh.positions.length, dl.opaque.reduce((n, e) => n + e.buf.mesh.positions.length, 0), 'every solid corner, none of the see-through blobs');
    assert.ok(dl.blended.length >= 1 && dl.blended.every(e => !e.noShadow));
    // A woodcutter fells one: its corners are collapsed in its materials' batches and in the caster.
    const chunk = r._resChunks.list[0], caster = chunk.groups.find(g => g.caster), mb = chunk.members.find(m => m.i === 3);
    const inCaster = mb.ranges.filter(x => x.g === caster);
    assert.ok(inCaster.length >= 2 && inCaster.length === mb.ranges.filter(x => !x.g.caster && !x.g.blend).length, 'once in the caster for every solid part it has');
    log.length = 0;
    rs[3].amount = 0; rs[3].mesh = null;
    frame();
    assert.equal(log.length, mb.ranges.length);
    for (const x of inCaster) assert.ok(caster.buf.position.data.subarray(x.start * 3, (x.start + x.count) * 3).every(v => v === 0), 'gone from the shadow');
    const other = chunk.members.find(m => m.i === 4).ranges.find(x => x.g === caster);
    assert.ok(caster.buf.position.data.subarray(other.start * 3, (other.start + other.count) * 3).some(v => v !== 0), 'its neighbour still casts');
    // A list made before there were casters (a test's stand-in) still takes them.
    const bare = { opaque: [], blended: [] };
    r._pushResourceChunks(bare);
    assert.equal(bare.casters.length, 1);
});

test('a worker\'s lantern is drawn as far as it can be seen: all of it up close, frame and flame from the middle distance, only its light from far off', () => {
    const { W, R } = load(), m3 = W.M3D;
    const r = Object.create(R.prototype);
    const worker = { x: 10, z: 20, health: 5, maxHealth: 5, type: 'worker', mesh: { visible: true }, _engine: { type: 'worker', entries: [], phase: 0.3, far: () => [] } };
    Object.assign(r, { gl: {}, units: [worker], buildings: [], graphicsQuality: 'cinematic', visualStyle: 'cinematic', WHITE: [1, 1, 1], tex: new Proxy({}, { get: (o, k) => (o[k] = o[k] || { name: k }) }),
        _unitDir: new WeakMap(), _unitPrev: new WeakMap(), _ghosts: [], _dustPool: [], _projectiles: [], _rubble: [], _rings: [], cameraTarget: { x: 10, z: 20 }, _theme: 'summer',
        _buf: (kind, args) => ({ kind, args }), _cull: () => false, _refreshIdentity() {}, _frameNo: 0, _dl: { opaque: [], blended: [], bars: [], casters: [] },
        game: { _environmentSeconds: W.EngineAtmosphere.previewTime('summer', 'night') } });
    const at = half => {
        r._halfH = half;
        r._assembleFrame(3, 0.016, m3.identity());
        const lamp = new Set(r._workerLampModel.map(p => p.buf));
        const solid = r._dl.opaque.filter(e => lamp.has(e.buf)), glow = r._dl.blended.filter(e => e.additive), flame = r._dl.blended.filter(e => lamp.has(e.buf));
        return { solid: solid.map(e => e.tex.name).sort().join('+'), casts: solid.filter(e => !e.noShadow).length, flame: flame.length, glow: glow.length };
    };
    const MID = W.EngineRenderer.MID_UNIT_HALF_H, FAR = W.EngineRenderer.FAR_UNIT_HALF_H;
    assert.deepEqual(at(MID - 5), { solid: 'iron+white', casts: 2, flame: 1, glow: 3 }, 'up close: as it was');
    assert.deepEqual(at(MID + 20), { solid: 'iron', casts: 0, flame: 1, glow: 3 }, 'from the middle distance');
    assert.deepEqual(at(FAR + 50), { solid: '', casts: 0, flame: 0, glow: 2 }, 'from far off: the glow on the ground and around the flame');
    // By day the lantern is out: nothing glows, the frame is still on the belt.
    r.game._environmentSeconds = 0;
    assert.deepEqual(at(MID + 20), { solid: 'iron', casts: 0, flame: 0, glow: 0 });
    assert.deepEqual(at(FAR + 50), { solid: '', casts: 0, flame: 0, glow: 0 });
    // Not on Balanced or Low, as before; and not for a soldier.
    r.graphicsQuality = 'balanced'; r.game._environmentSeconds = W.EngineAtmosphere.previewTime('summer', 'night');
    assert.deepEqual(at(MID - 5), { solid: '', casts: 0, flame: 0, glow: 0 });
});

// ---- the scatter on open ground (build 1186) -----------------------------------------------
test('bushes, pebbles and flowers are drawn a chunk at a time, and a tint of its own is read from a strip', () => {
    const { W, R, scope } = load(), m3 = W.M3D;
    const log = [], strips = [];
    let cur = null, freed = 0, textures = 0;
    const gl = { ARRAY_BUFFER: 1, TEXTURE_2D: 2, RGBA: 3, UNSIGNED_BYTE: 4, NEAREST: 5, CLAMP_TO_EDGE: 6, TEXTURE_MIN_FILTER: 7, TEXTURE_MAG_FILTER: 8, TEXTURE_WRAP_S: 9, TEXTURE_WRAP_T: 10,
        bindBuffer: (t, b) => { cur = b; }, bufferSubData: (t, off, d) => { cur.data.set(d, off / 4); log.push(cur); },
        createTexture: () => ({ strip: ++textures }), bindTexture() {}, texParameteri() {}, deleteTexture() { textures--; },
        texImage2D: (t, l, f, w, h, b, f2, ty, px) => strips.push({ w, h, px: Array.from(px) }) };
    W.GLCore.createMeshBuffers = (g, mesh) => ({ mesh, position: { data: Float32Array.from(mesh.positions) } });
    W.GLCore.createShadowBuffers = (g, mesh) => ({ mesh, shadowOnly: true, position: { data: Float32Array.from(mesh.positions) } });
    W.GLCore.deleteMeshBuffers = () => { freed++; };
    const r = Object.create(R.prototype);
    const WHITE = [1, 1, 1];
    Object.assign(r, { gl, WHITE, _theme: 'summer', _cull: () => false, terrain: { resources: [] }, fogView: null, game: null });
    r.tex = new Proxy({}, { get: (o, k) => (o[k] = o[k] || { name: k }) });
    const at = (kind, args, texName, tint, x, z) => ({ kind, args, texName, tint, model: m3.translation(x, 0.3, z), x, z });
    const grey = v => [v, v, v];
    r._props = [
        at('sphere', [1, 7, 5], 'worldFoliage', WHITE, 10, 10), at('sphere', [1, 7, 5], 'worldFoliage', [0.88, 0.95, 0.85], 11, 10),
        at('sphere', [1, 7, 5], 'worldFoliage', WHITE, 40, 70),
        at('sphere', [1, 6, 4], 'white', grey(0.40), 20, 30), at('sphere', [1, 6, 4], 'white', grey(0.45), 60, 30), at('sphere', [1, 6, 4], 'white', grey(0.4001), 90, 90),
        at('sphere', [1, 5, 4], 'white', [0.85, 0.84, 0.70], 100, 20),
        at('sphere', [1, 6, 4], 'white', grey(0.50), 200, 30)          // the next square over
    ];
    const frame = () => { const dl = { opaque: [], blended: [], casters: [] }; r._pushPropChunks(dl); return dl; };
    const dl = frame();
    // Seven props in the first square: plain bushes, tinted bushes, and everything that is white times a tint.
    const first = dl.opaque.slice(0, 3), names = first.map(e => (e.tex.name || 'strip') + (e.tint ? ' tinted' : ''));
    assert.deepEqual(names.sort(), ['strip', 'worldFoliage', 'worldFoliage tinted'], 'three draws for seven props');
    assert.equal(dl.opaque.length, 4, 'and one for the square beside it');
    assert.ok(dl.opaque.every(e => e.noShadow === true));
    assert.equal(dl.casters.length, 2, 'a caster a square: eight shadow draws were, two are');
    const sphere = n => W.EngineMesh.sphere(...n).positions.length / 3;
    assert.equal(dl.casters[0].buf.mesh.positions.length / 3, 3 * sphere([1, 7, 5]) + 3 * sphere([1, 6, 4]) + sphere([1, 5, 4]));
    // The strip: one texel a tint, the same grey twice takes one, and each prop reads the middle of its own.
    const N = R.PROP_TINTS, strip = strips[strips.length - 1];
    assert.deepEqual([strip.w, strip.h, textures], [N, 1, 1]);
    const b8 = v => Math.round(v * 255);
    assert.deepEqual(strip.px.slice(0, 16), [b8(0.40), b8(0.40), b8(0.40), 255, b8(0.45), b8(0.45), b8(0.45), 255, b8(0.85), b8(0.84), b8(0.70), 255, 128, 128, 128, 255]);
    assert.ok(strip.px.slice(16).every(v => v === 255));
    const flat = first.find(e => !e.tex.name), uvs = flat.buf.mesh.uvs, n64 = sphere([1, 6, 4]);
    const us = i => Array.from(new Set(Array.from(uvs.slice(i * 2, (i + n64) * 2)).filter((v, k) => k % 2 === 0)));
    assert.deepEqual(us(0), [Math.fround(0.5 / N)], 'the first pebble: texel 0');
    assert.deepEqual(us(n64), [Math.fround(1.5 / N)], 'the second: texel 1');
    assert.deepEqual(us(2 * n64), [Math.fround(0.5 / N)], 'a grey that rounds to the first one shares its texel');
    assert.ok(Array.from(uvs).filter((v, k) => k % 2 === 1).every(v => v === 0.5));
    assert.equal(flat.tint, undefined, 'and no tint on the draw: the strip is the colour');
    // Under fog a prop is collapsed in its batch and in the caster, and comes back when the ground is explored.
    const chunk = r._propChunkList[0], caster = chunk.groups.find(g => g.caster), bush = chunk.members[2];
    let hidden = true;
    scope.EngineGrass = { visibleRect: (fow, x, z, ex, ez, all) => { assert.deepEqual([ex, ez, all], [3, 3, true]); return !(hidden && x === 40 && z === 70); } };
    log.length = 0;
    const fogged = frame();
    assert.equal(fogged.opaque.length, 4);
    assert.equal(log.length, 2, 'one write in its batch, one in the caster');
    const inCaster = bush.ranges.find(x => x.g === caster);
    assert.ok(caster.buf.position.data.subarray(inCaster.start * 3, (inCaster.start + inCaster.count) * 3).every(v => v === 0));
    hidden = false; log.length = 0;
    frame();
    assert.equal(log.length, 2);
    assert.ok(caster.buf.position.data.subarray(inCaster.start * 3, (inCaster.start + inCaster.count) * 3).some(v => v !== 0), 'restored');
    frame();
    assert.equal(log.length, 2, 'nothing written while nothing changes');
    // A square out of view is not looked at; one with nothing explored is not built.
    r._cull = (x) => x > 128;
    assert.equal(frame().opaque.length, 3);
    // A new map frees the old one's chunks and its strip.
    r._freePropChunks();
    assert.deepEqual([freed, textures, r._propChunkList, r._propTints], [4 + 2, 0, null, null]);
    // Past the strip's width a tint keeps a draw of its own rather than a wrong colour.
    r._props = []; for (let i = 0; i < N + 2; i++) r._props.push(at('sphere', [1, 6, 4], 'white', [i / 255, 0, 0], 5 + (i % 10), 5));
    const many = frame();
    assert.equal(many.opaque.length, 1 + 2);
    assert.equal(many.opaque.filter(e => e.tint).length, 2);
});

test('the scatter is kept as recipes and drawn through its chunks only', () => {
    const s = src('gamerenderer');
    assert.match(s, /props\.push\(\{ kind, args, texName: tex, tint, model: TRSp\(x, y, z, sx, sy, sz, ry\), x, z \}\)/);
    assert.match(s, /this\._freePropChunks\(\);\s+this\._props = props;/);
    assert.match(s, /if \(this\._props && this\._halfH < 90\) this\._pushPropChunks\(dl\);/);
    assert.doesNotMatch(s, /dl\.opaque\.push\(pr\)/);
    // The forests' builder is the one that merges them; a prop brings its own parts to it.
    assert.match(s, /const e = mb\.entries \|\| this\._resourceEntries\(rs\[mb\.i\], mb\.i\);/);
});
