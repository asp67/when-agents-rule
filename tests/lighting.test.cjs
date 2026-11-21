// Light and colour (overhaul step A1): EngineAtmosphere.lighting gives the Atmospheric
// shader its key light, its two fills and its grade; the shader adds light up in linear
// space and keeps Simple lighting as it was.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const scope = { window: {} }; vm.createContext(scope);
vm.runInContext(read('js/engine/atmosphere.js'), scope);
const A = scope.window.EngineAtmosphere, L = A.LIGHT;
// The three themes' sun and sky, as the renderer sets them (gamerenderer._buildTextures).
const THEMES = { summer: [[0.96, 0.84, 0.66], [0.42, 0.60, 0.79]], desert: [[0.99, 0.82, 0.59], [0.66, 0.71, 0.75]], winter: [[0.74, 0.77, 0.83], [0.60, 0.67, 0.76]] };
const at = (theme, seconds) => A.lighting(seconds, THEMES[theme][0], THEMES[theme][1], theme);
const when = (theme, period) => at(theme, A.previewTime(theme, period));
const luma = c => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
// What a flat piece of ground of this colour looks like before the shoulder: lit, and in shadow.
const lit = (l, base) => base.map((b, i) => b * Math.sqrt(l.fillHigh[i] + l.key[i] * L.sunUp));
const shade = (l, base) => base.map((b, i) => b * Math.sqrt(l.fillHigh[i]));
const GRASS = [0.45, 0.60, 0.30];

test('the themes here are the renderer\'s own, and lighting() carries the day cycle unchanged', () => {
    const src = read('js/engine/gamerenderer.js');
    for (const [theme, [sun, sky]] of Object.entries(THEMES)) for (const c of [sun, sky])
        assert.ok(src.includes('[' + c.map(v => v.toFixed(2)).join(', ') + ']'), theme + ' ' + c);
    for (const theme in THEMES) for (let t = 0; t < 720; t += 37) {
        const day = A.daylight(t, THEMES[theme][0], THEMES[theme][1], theme), l = at(theme, t);
        assert.deepEqual([l.night, Array.from(l.sun), Array.from(l.sky)], [day.night, Array.from(day.sun), Array.from(day.sky)]);
    }
    assert.match(src, /const atmosphere = window\.EngineAtmosphere\.lighting\(/);
    assert.match(src, /this\.sunDir = M\(\)\.normalize\(\[-0\.65, 0\.72, 0\.36\]\)/);
    assert.ok(Math.abs(0.72 / Math.hypot(0.65, 0.72, 0.36) - L.sunUp) < 0.0005, 'sunUp is the height of the renderer\'s sun');
});

test('by day, full sun on flat ground comes to the colour it had: the palettes were painted against it', () => {
    for (const theme in THEMES) {
        const l = when(theme, 'noon'), sun = THEMES[theme][0];
        lit(l, [1, 1, 1]).forEach((v, i) => assert.ok(Math.abs(v - (L.skyUp[i] + sun[i] * L.sunUp)) < 1e-9, theme + ' channel ' + i));
        // Shade is the sky's colour, bluer than the sunlit ground beside it and clearly darker.
        const sunlit = lit(l, [1, 1, 1]), shaded = shade(l, [1, 1, 1]);
        assert.ok(shaded[2] / shaded[0] > sunlit[2] / sunlit[0], theme + ': shade is bluer');
        const ratio = luma(shaded) / luma(sunlit);
        assert.ok(ratio > 0.38 && ratio < 0.56, theme + ': shade at ' + ratio.toFixed(2) + ' of the sunlit ground');
        // Light from below is the ground's own colour thrown back: weaker than the sky, and warmer.
        assert.ok(luma(l.fillLow) < luma(l.fillHigh), theme);
        if (theme !== 'winter') assert.ok(l.fillLow[0] / l.fillLow[2] > l.fillHigh[0] / l.fillHigh[2], theme + ': warm from below');
    }
    // A desert sun squared would be orange; solved for, it keeps the sand its colour.
    const d = when('desert', 'noon').key;
    assert.ok(d[0] / d[2] < 1.9, 'desert key red over blue: ' + (d[0] / d[2]).toFixed(2));
});

test('a night you can read: moonlit ground is brighter than it was, shade is dark blue and not black', () => {
    for (const theme in THEMES) {
        const l = when(theme, 'night');
        assert.equal(l.night, 1);
        const was = luma(GRASS.map((b, i) => b * (L.skyUp[i] * [0.40, 0.49, 0.66][i] + l.sun[i] * L.sunUp)));   // the old night, same ground
        const now = luma(lit(l, GRASS)), dark = luma(shade(l, GRASS));
        assert.ok(now > was * 1.25, theme + ': ' + now.toFixed(3) + ' against ' + was.toFixed(3));
        assert.ok(now / dark > 1.6, theme + ': the moon still models shapes (' + (now / dark).toFixed(2) + ')');
        assert.ok(dark > 0.13, theme + ': shade is not black (' + dark.toFixed(3) + ')');
        assert.ok(l.key[2] > l.key[0] * 3 && l.fillHigh[2] > l.fillHigh[0] * 2, theme + ': blue');
        // Less colour at night, and a stronger edge light to lift figures off dark ground.
        assert.ok(l.grade[3] < when(theme, 'noon').grade[3] && l.rim > when(theme, 'noon').rim);
        assert.ok(now < luma(lit(when(theme, 'noon'), GRASS)) * 0.6, theme + ': and it is still night');
    }
});

test('dusk is warm, noon is neutral, and nothing jumps anywhere in the day', () => {
    for (const theme in THEMES) {
        const noon = when(theme, 'noon'), dusk = when(theme, 'dusk');
        assert.deepEqual(Array.from(noon.grade).slice(0, 3), [1, 1, 1]);
        assert.ok(dusk.key[0] / dusk.key[2] > noon.key[0] / noon.key[2] + 0.1, theme + ': the low sun is redder');
        assert.ok(dusk.grade[0] > 1 && dusk.grade[2] < 1, theme + ': the grade of that hour');
        let worst = 0;
        for (let t = 0; t < 720; t += 0.5) {
            const a = at(theme, t), b = at(theme, t + 0.5);
            for (const k of ['key', 'fillHigh', 'fillLow', 'grade']) a[k].forEach((v, i) => {
                assert.ok(Number.isFinite(v) && v >= 0, theme + ' ' + k + ' at ' + t);
                worst = Math.max(worst, Math.abs(v - b[k][i]));
            });
            worst = Math.max(worst, Math.abs(a.rim - b.rim));
        }
        // The key runs from about 1.6 down to 0.15, and the shortest dusk (the desert's) lasts
        // 60 s: a steady fade is 0.012 in half a second, and nothing is allowed four times that.
        assert.ok(worst < 0.05, theme + ': the largest step in half a second is ' + worst.toFixed(4));
        assert.deepEqual(JSON.stringify(at(theme, 720)), JSON.stringify(at(theme, 0)));
    }
    assert.deepEqual(JSON.stringify(A.lighting(100, THEMES.summer[0], THEMES.summer[1], 'nowhere')), JSON.stringify(at('summer', 100)), 'an unknown theme is summer');
});

test('the shader adds light up in linear space, rolls off by the brightest channel, and leaves Simple lighting alone', () => {
    const f = A.fragment;
    assert.match(f, /uniform vec3 uKey, uFillHigh, uFillLow;\s+uniform vec4 uGrade;\s+uniform float uRim;/);
    assert.match(f, /vec3 albedo = base\*base;/);
    // The fill and the key; `contact` is the contact shading of step A2 (tests/occlusion.test.cjs),
    // `relief` the rolling ground of step A3 (tests/ground.test.cjs).
    assert.match(f, /vec3 light = mix\(uFillLow,uFillHigh,n\.y\*0\.5\+0\.5\)\*contact \+ uKey\*sun\*relief\*visibility\(n\)\*mix\(1\.0,contact,0\.75\);/);
    assert.match(f, /float peak = max\(col\.r,max\(col\.g,col\.b\)\);\s+col \*= min\(1\.0\/max\(peak,0\.0001\),\(1\.06\+peak\*0\.10\)\/\(1\.0\+peak\*0\.62\)\);\s+col = sqrt\(col\);/);
    assert.match(f, /col = mix\(vec3\(dot\(col,vec3\(0\.299,0\.587,0\.114\)\)\),col,uGrade\.a\)\*uGrade\.rgb;/);
    // The shoulder never takes the brightest channel past white, and passes mid tones nearly as they are.
    const curve = p => Math.min(1 / p, (1.06 + p * 0.10) / (1 + p * 0.62)) * p;
    for (const p of [0.01, 0.1, 0.3, 0.8, 1.4, 2, 5, 50]) assert.ok(curve(p) <= 1 + 1e-12, 'peak ' + p);
    assert.ok(curve(0.1) > 0.1 && curve(0.3) > 0.27 && curve(1.4) > curve(0.8));
    // Simple lighting: its own sum, mixed in last, never through the new curve.
    assert.match(f, /vec3 legacy = base\*\(uAmbient \+ uSunColor\*sun\);/);
    assert.match(f, /legacy\+=base\*vec3\(1\.0,\.46,\.12\)\*reach\*1\.8;/);
    assert.match(f, /col = sqrt\(col\);[\s\S]{0,200}col = mix\(legacy,col,uAtmosphere\);\s+col = mix\(col,base,uUnlit\);/);
    assert.equal((f.match(/legacy/g) || []).length, 3, 'legacy is set, lit by lamps, and mixed in: nothing else touches it');
});

test('every uniform the renderer sets is one the shaders declare', () => {
    const src = read('js/engine/gamerenderer.js'), declared = new Set();
    for (const text of [A.vertex, A.fragment]) for (const m of text.matchAll(/uniform\s+(?:(?:lowp|mediump|highp)\s+)?\w+\s+([^;]+);/g))
        for (const name of m[1].split(',')) declared.add(name.trim().replace(/\[\d+\]$/, ''));
    const used = new Set([...src.matchAll(/(?:this\.prog\.uniforms|\bU)\.(u[A-Z]\w*)/g)].map(m => m[1]));
    assert.ok(used.size > 30 && ['uKey', 'uFillHigh', 'uFillLow', 'uGrade', 'uRim'].every(u => used.has(u)));
    assert.deepEqual([...used].filter(u => !declared.has(u)), [], 'set by the renderer, declared by no shader');
    // And each of the five is given what lighting() returns under that name.
    for (const [u, key] of [['uKey', 'key'], ['uFillHigh', 'fillHigh'], ['uFillLow', 'fillLow'], ['uGrade', 'grade'], ['uRim', 'rim']])
        assert.match(src, new RegExp('uniforms\\.' + u + ', atmosphere\\.' + key + '\\)'));
});

test('the wear under a building takes the ground\'s light; the rest of the blended pass stays unlit', () => {
    const src = read('js/engine/gamerenderer.js');
    assert.match(src, /eb\.wear=\{buf:this\._buf\('disc',\[1,18\]\),tex:this\.tex\.mote,\s+tint:[^\n]+alpha:\.26,lit:true,/);
    // The real draw: which entries are drawn lit, in which pass.
    const log = [];
    const gl = new Proxy({}, { get: (t, k) => typeof k === 'string' && /^[A-Z][A-Z0-9_]*$/.test(k) ? k : (...a) => { if (k === 'uniform1f' && a[0] === 'uUnlit') log.push(a[1]); } });
    const context = vm.createContext({ console, Math, Float32Array, Uint8Array, WeakMap, Map, Set, GLCore: { drawMesh() { log.push('draw'); } },
        document: { addEventListener() {} }, TexGen: { TERRAIN_SEED: 1, TERRAIN_WORLD: 1000, TERRAIN_LAND: 400 }, performance: { now: () => 0 } });
    context.window = context;
    vm.runInContext(read('js/engine/math3d.js'), context);
    vm.runInContext(read('js/engine/atmosphere.js'), context);
    vm.runInContext(read('js/engine/gamerenderer.js'), context);
    const r = Object.create(context.EngineRenderer.prototype), e = o => Object.assign({ buf: {}, tex: {}, model: [] }, o);
    Object.assign(r, { gl, prog: { uniforms: new Proxy({}, { get: (t, k) => k }) }, tex: { white: {} }, WHITE: [1, 1, 1], sunDir: [0, 1, 0], _sky: [0, 0, 0], _sun: [1, 1, 1],
        _dl: { opaque: [e(), e()], blended: [e(), e({ lit: true }), e({ lit: true }), e()], bars: [e()] }, _fogEntry: e(), visualStyle: 'cinematic' });
    const l = at('summer', 0);
    r._drawPicture({ view: [], proj: [], haze: [0, 1], eye: [0, 0, 0] }, l, 0, [0, 0, 100, 100], false);
    assert.deepEqual(log, [0, 'draw', 'draw', 1, 'draw', 0, 'draw', 'draw', 1, 'draw', 1, 'draw', 1, 'draw']);
});
