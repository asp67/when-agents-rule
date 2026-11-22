// The draw-call diet (overhaul step A4), second step: a building casts its shadow as one
// shape instead of batch by batch, its dressing is merged per material like the building,
// and the dressing is left out from the height where it is smaller than a pixel.
const test = require('node:test'), assert = require('node:assert/strict');
const vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
const src = f => fs.readFileSync(path.join(__dirname, '../js/engine/' + f + '.js'), 'utf8');

function load() {
    const scope = { window: {}, console }; scope.window.window = scope.window; vm.createContext(scope);
    for (const f of ['math3d', 'mesh', 'texgen', 'buildings', 'units', 'atmosphere']) vm.runInContext(src(f), scope);
    let made = 0;
    scope.window.GLCore = { createMeshBuffers: (gl, mesh) => { made++; return { mesh, n: mesh.positions.length / 3 }; }, drawMesh: (gl, prog, buf) => gl.drawn.push(buf) };
    vm.runInContext('Object.assign(globalThis, window);' + src('gamerenderer'), scope);
    return { W: scope.window, R: vm.runInContext('window.EngineRenderer', scope), made: () => made };
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
    assert.match(s, /this\._buildingBatches\(modelKey\+'\|dressing\|'\+!!building\.isWonder,dressing\.parts\.map\(p=>p\.blend\?Object\.assign\(\{\},p,\{blend:false\}\):p\)\)/);
    // Left out, with the worn patch before the door, from where units are their far models; the lights stay.
    assert.match(s, /if\(this\._halfH<=EngineRenderer\.FAR_UNIT_HALF_H\)\s+for\(const p of eb\.details\)/);
    assert.match(s, /if\(eb\.wear&&this\._halfH<=EngineRenderer\.FAR_UNIT_HALF_H\)dl\.blended\.push/);
    const lights = s.slice(s.indexOf('if(eb.details&&courtyards++<24){'), s.indexOf('if(this._halfH<=EngineRenderer.FAR_UNIT_HALF_H)\n') > 0 ? s.indexOf('if(this._halfH<=EngineRenderer.FAR_UNIT_HALF_H)\n') : s.indexOf('for(const p of eb.details)'));
    assert.match(lights, /addLight\(x,y,z,strength\)/, 'the lamps are lit before the dressing is decided on');
});

test('the dressing of a building really is the same for every building of its model', () => {
    const { W } = load(), B = W.EngineBuildings;
    const fp = { ex: 5, ez: 5, ey: 6 };
    const a = JSON.stringify(B.settlement('house', 'greek', fp)), b = JSON.stringify(B.settlement('house', 'greek', fp));
    assert.equal(a, b);
    assert.notEqual(a, JSON.stringify(B.settlement('house', 'egyptian', fp)));
    assert.doesNotMatch(src('buildings'), /Math\.random/);
});
