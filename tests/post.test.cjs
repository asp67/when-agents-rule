// Overhaul step A10 (build 1189): the scene can be drawn into a picture of its own
// (js/engine/post.js) and put on the canvas from there -- sharpened when it was drawn
// smaller than the canvas, focused when that is switched on. Whenever neither is wanted
// the scene goes straight into the canvas, as it always has.
const test = require('node:test'), assert = require('node:assert/strict');
const vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
const src = f => fs.readFileSync(path.join(__dirname, '../js/engine/' + f + '.js'), 'utf8');

// A card that writes down what it is asked. Constants answer with their own names.
function card({ version = 2, complete = true, maxSamples = 8 } = {}) {
    const calls = []; let id = 0;
    const own = { warVersion: version, calls,
        getParameter: () => maxSamples, isEnabled: () => true,
        checkFramebufferStatus: () => (complete ? 'FRAMEBUFFER_COMPLETE' : 'FRAMEBUFFER_UNSUPPORTED') };
    for (const k of ['Buffer', 'Renderbuffer', 'Framebuffer', 'Texture']) own['create' + k] = () => ({ kind: k, id: ++id });
    const gl = new Proxy(own, { get: (t, k) => {
        if (k in t) return t[k];
        if (typeof k !== 'string') return undefined;
        if (/^[A-Z][A-Z0-9_]*$/.test(k)) return k;
        if (version < 2 && (k === 'renderbufferStorageMultisample' || k === 'blitFramebuffer')) return undefined;
        return (...a) => { calls.push([k, ...a]); };
    } });
    return gl;
}
const named = (gl, name) => gl.calls.filter(c => c[0] === name).map(c => c.slice(1));
function load(files) {
    const scope = { window: {}, console, performance: { now: () => 1000 } }; scope.window.window = scope.window; vm.createContext(scope);
    scope.window.GLCore = { compileProgram: () => ({ uniforms: new Proxy({}, { get: (t, k) => k }), attribs: { aPos: 0 } }),
        createMeshBuffers: (gl, mesh) => ({ mesh }), createShadowBuffers: (gl, mesh) => ({ mesh }), drawMesh() {} };
    vm.runInContext('Object.assign(globalThis, window);', scope);
    for (const f of files) { vm.runInContext(f.includes('/') ? fs.readFileSync(path.join(__dirname, '..', f), 'utf8') : src(f), scope); vm.runInContext('Object.assign(globalThis, window);', scope); }
    return scope;
}

test('a picture of its own needs WebGL 2; without it there is none and nothing is asked of the card', () => {
    const P = load(['post']).window.EnginePost;
    const old = card({ version: 1 });
    assert.equal(P.supported(old), false);
    assert.equal(P.create(old), null);
    assert.equal(old.calls.length, 0);
    assert.equal(P.supported(card()), true);
    assert.equal(P.supported(null), false);
});

test('the target is made once per size, multisampled as the canvas is, and freed when the size changes', () => {
    const P = load(['post']).window.EnginePost, gl = card(), fx = P.create(gl);
    assert.equal(fx.scene, null);
    assert.equal(fx.begin(1344, 756), true);
    assert.deepEqual(named(gl, 'renderbufferStorageMultisample'), [['RENDERBUFFER', 4, 'RGBA8', 1344, 756], ['RENDERBUFFER', 4, 'DEPTH_COMPONENT24', 1344, 756]]);
    assert.deepEqual(named(gl, 'viewport').pop(), [0, 0, 1344, 756]);
    assert.equal(named(gl, 'bindFramebuffer').pop()[1].kind, 'Framebuffer', 'the scene is drawn into it');
    assert.deepEqual([fx.scene.w, fx.scene.h, fx.scene.tex.kind], [1344, 756, 'Texture']);
    const made = gl.calls.length;
    fx.begin(1344, 756);
    assert.equal(named(gl, 'renderbufferStorageMultisample').length, 2, 'the same size: the same target');
    assert.equal(gl.calls.length, made + 2, 'bound, and the viewport set');
    fx.begin(1920, 1080);
    assert.equal(named(gl, 'renderbufferStorageMultisample').length, 4);
    assert.deepEqual([named(gl, 'deleteFramebuffer').length, named(gl, 'deleteRenderbuffer').length, named(gl, 'deleteTexture').length], [2, 2, 1]);
    assert.equal(fx.begin(0, 10), false);
    // A card with fewer samples than four gives what it has; one that will not make the target says so.
    const few = card({ maxSamples: 2 }); P.create(few).begin(8, 8);
    assert.equal(named(few, 'renderbufferStorageMultisample')[0][1], 2);
    const no = card({ complete: false }), fx2 = P.create(no);
    assert.equal(fx2.begin(64, 64), false);
    assert.equal(fx2.scene, null);
    assert.equal(named(no, 'deleteFramebuffer').length, 2, 'and keeps nothing');
});

test('onto the canvas: resolved, sharpened only when asked, focused only when asked', () => {
    const P = load(['post']).window.EnginePost, gl = card(), fx = P.create(gl);
    fx.begin(1344, 756);
    gl.calls.length = 0;
    fx.present(1920, 1080, { sharpen: P.SHARPEN, focus: null });
    assert.deepEqual(named(gl, 'blitFramebuffer'), [[0, 0, 1344, 756, 0, 0, 1344, 756, 'COLOR_BUFFER_BIT', 'NEAREST']]);
    const binds = named(gl, 'bindFramebuffer');
    assert.deepEqual(binds.map(b => b[0]), ['READ_FRAMEBUFFER', 'DRAW_FRAMEBUFFER', 'FRAMEBUFFER']);
    assert.equal(binds[2][1], null, 'the canvas');
    assert.deepEqual(named(gl, 'viewport'), [[0, 0, 1920, 1080]]);
    assert.deepEqual(named(gl, 'uniform2f'), [['uTexel', 1 / 1344, 1 / 756]]);
    assert.deepEqual(named(gl, 'uniform1f'), [['uSharpen', P.SHARPEN]]);
    assert.deepEqual(named(gl, 'uniform4f'), [['uFocus', 0.5, 0.5, 0, 0]]);
    assert.deepEqual(named(gl, 'drawArrays'), [['TRIANGLES', 0, 3]]);
    assert.ok(gl.calls.findIndex(c => c[0] === 'blitFramebuffer') < gl.calls.findIndex(c => c[0] === 'drawArrays'));
    gl.calls.length = 0;
    fx.present(1920, 1080, { sharpen: 0, focus: [0.5, 0.17, 3.5] });
    assert.deepEqual(named(gl, 'uniform1f'), [['uSharpen', 0]]);
    assert.deepEqual(named(gl, 'uniform4f'), [['uFocus', 0.5, 0.17, 3.5, 1]]);
    // The shader hands the scene's own alpha on: the page shows through a blended part as much as before.
    assert.match(src('post'), /gl_FragColor = vec4\(clamp\(c, 0\.0, 1\.0\), here\.a\);/);
    // Sharpening stops where the focus blurs, and never pushes a texel past its neighbourhood.
    assert.match(src('post'), /float k = uSharpen \* \(1\.0 - soft\);/);
    assert.match(src('post'), /c = clamp\(c \+ \(c \* 4\.0 - n\) \* k, lo, hi\);/);
});

test('the bloom reads the scene it is handed and copies the frame only when it is not', () => {
    const B = load(['bloom']).window.EngineBloom;
    const gl = card(), bloom = B.create(gl), scene = { tex: { kind: 'Texture', id: 'scene' }, w: 1344, h: 756 };
    assert.equal(bloom.apply(1920, 1080, 0.3, scene), true);
    assert.equal(named(gl, 'copyTexSubImage2D').length, 0, 'no copy of the frame');
    assert.deepEqual(named(gl, 'texImage2D').map(c => [c[3], c[4]]), [[480, 270], [480, 270]], 'the two quarter targets, and no texture of the frame\'s size');
    assert.deepEqual(named(gl, 'uniform2f').find(c => c[0] === 'uTexel'), ['uTexel', 1 / 1344, 1 / 756]);
    assert.ok(named(gl, 'bindTexture').some(c => c[1] === scene.tex));
    // As before where the scene went straight into the canvas.
    const gl2 = card(), direct = B.create(gl2);
    direct.apply(1920, 1080, 0.3);
    assert.deepEqual(named(gl2, 'copyTexSubImage2D'), [['TEXTURE_2D', 0, 0, 0, 0, 0, 1920, 1080]]);
    assert.deepEqual(named(gl2, 'uniform2f').find(c => c[0] === 'uTexel'), ['uTexel', 1 / 1920, 1 / 1080]);
    assert.equal(named(gl2, 'texImage2D').length, 3);
});

test('what the governor takes off the resolution comes off the scene where there is a target, off the canvas where there is none', () => {
    const scope = load(['js/simulation/island.js', 'math3d', 'mesh', 'texgen', 'buildings', 'units', 'atmosphere', 'post', 'gamerenderer']);
    const R = scope.window.EngineRenderer;
    scope.window.devicePixelRatio = 1.25;
    const r = Object.assign(Object.create(R.prototype), { gl: card(), qualityChoice: 'auto', _governor: { scale: 0.75 }, graphicsQuality: 'cinematic', postUpscale: true });
    assert.equal(r._pickScale(), 1.25, 'the canvas keeps the display\'s resolution');
    assert.equal(r.sceneScale, 0.75);
    r._governor.scale = 1;
    assert.deepEqual([r._pickScale(), r.sceneScale], [1.25, 1]);
    r._governor.scale = 0.75;
    // Switched off, on WebGL 1, or after the card refused the target: the canvas shrinks, as before.
    r.postUpscale = false;
    assert.deepEqual([r._pickScale(), r.sceneScale], [1.25 * 0.75, 1]);
    r.postUpscale = true; r.gl = card({ version: 1 });
    assert.deepEqual([r._pickScale(), r.sceneScale], [1.25 * 0.75, 1]);
    r.gl = card(); r._postFx = null;
    assert.deepEqual([r._pickScale(), r.sceneScale], [1.25 * 0.75, 1]);
    // A tier someone picked is not governed.
    r._postFx = undefined; r.qualityChoice = 'cinematic';
    assert.deepEqual([r._pickScale(), r.sceneScale], [1.25, 1]);
    // Focus: only when switched on, only on High, all of it on a close-up and none from where a town is seen whole.
    const F = R.FOCUS, at = h => { r._halfH = h; return r._focusAmount(); };
    assert.equal(at(10), 0, 'not without the switch');
    r.tiltShift = true;
    assert.deepEqual([at(F.near - 2), at((F.near + F.far) / 2), at(F.far), at(90)], [1, 0.5, 0, 0]);
    r.graphicsQuality = 'balanced';
    assert.equal(at(10), 0);
});

test('the frame: a picture of its own only when one is wanted, never for the second picture', () => {
    const s = src('gamerenderer');
    const body = s.slice(s.indexOf('        _drawPicture(cam, atmosphere, now, rect, inset) {'), s.indexOf('        _drawSecond(view, now, deltaTime, atmosphere) {'));
    assert.match(body, /if \(!inset\) \{\s+const s = this\.sceneScale > 0 && this\.sceneScale < 1 \? this\.sceneScale : 1, focus = this\._focusAmount\(\);\s+if \(\(s < 1 \|\| focus > 0 \|\| this\.postAlways\) && this\._post\(\)\) \{/);
    assert.match(body, /const sw = Math\.max\(1, Math\.round\(CW \* s\)\), sh = Math\.max\(1, Math\.round\(CH \* s\)\);\s+if \(this\._postFx\.begin\(sw, sh\)\) \{ own = \{ s, focus, sh \}; rect = \[0, 0, sw, sh\]; \}/);
    assert.match(body, /else \{ this\._postFx = null; this\._postFailed = true; \}/, 'a card that refuses: the canvas shrinks again');
    // Onto the canvas after the fog and the rings, before the bloom, and the bars after both at the canvas's size.
    const at = t => { const i = body.indexOf(t); assert.ok(i > 0, t); return i; };
    assert.ok(at('draw(this._ringEntries, 1);') < at('this._postFx.present(CW, CH,'));
    assert.ok(at('this._postFx.present(CW, CH,') < at('this._bloom.apply('));
    assert.ok(at('this._bloom.apply(') < at('draw(this._dl.bars, 1);'));
    assert.match(body, /sharpen: own\.s < 1 \? EnginePost\.SHARPEN : 0,/);
    assert.match(body, /focus: own\.focus > 0 \? \[this\._focusNow == null \? F\.line : this\._focusNow, F\.band, F\.blur \* own\.focus \* own\.sh \/ 1080\] : null/);
    assert.match(body, /_bloom\.apply\(this\.PW \|\| this\.W, this\.PH \|\| this\.H, 0\.22 \+ 0\.3 \* atmosphere\.night, own \? this\._postFx\.scene : null\)/);
    assert.match(s, /if \(this\._postFailed\) \{ this\._postFailed = false; this\._sizeCanvas\(\); \}/);
    // Focus is on (build 1190, switched on from stills); the measuring switch is not.
    assert.match(s, /this\.postUpscale = true;\s+this\.tiltShift = true;\s+this\.postAlways = false;/);
});
