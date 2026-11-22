// Overhaul step A8 (build 1191): the air between the eye and what it looks at, and the fog
// of war drawn as mist. The sky itself is not built: the camera looks down by ten degrees
// or more with a field of view of twenty, so the horizon never enters the picture.
const test = require('node:test'), assert = require('node:assert/strict');
const vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
function atmosphere() {
    const scope = { window: {} }; scope.window.window = scope.window; vm.createContext(scope);
    vm.runInContext(read('js/engine/atmosphere.js'), scope);
    return scope.window.EngineAtmosphere;
}
const SUN = [1.0, 0.95, 0.85], SKY = [0.42, 0.62, 0.86];

test('the air has the hour\'s colour: the sky lifted by day, the night\'s own blue by night, and less of it', () => {
    const A = atmosphere(), P = A.AIR;
    const noon = A.lighting(A.previewTime('summer', 'noon'), SUN, SKY, 'summer');
    const night = A.lighting(A.previewTime('summer', 'night'), SUN, SKY, 'summer');
    assert.equal(noon.air.length, 4);
    assert.equal(noon.night, 0);
    // By day: between the sky and the tone, by the lift.
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(noon.air[i] - (noon.sky[i] + (P.tone[i] - noon.sky[i]) * P.lift)) < 1e-12);
    assert.ok(noon.air.slice(0, 3).every((v, i) => v > noon.sky[i]), 'lighter than the sky it is made of');
    assert.equal(noon.air[3], P.amount);
    // By night: nearly the night sky itself, dark, and thinner.
    assert.equal(night.night, 1);
    assert.equal(night.air[3], P.nightAmount);
    assert.ok(night.air[3] < noon.air[3]);
    assert.ok(Math.max(...night.air.slice(0, 3)) < 0.3 && night.air[2] > night.air[0], 'dark and blue');
    // Through dusk it goes from one to the other without a jump.
    let last = noon.air;
    for (let s = A.previewTime('summer', 'noon'); s <= A.previewTime('summer', 'night'); s += 3) {
        const air = A.lighting(s, SUN, SKY, 'summer').air;
        assert.ok(air.every((v, i) => Math.abs(v - last[i]) < 0.05), 'at ' + s + ' s');
        last = air;
    }
});

test('the air thickens with how many times farther a thing is than what the camera looks at', () => {
    const src = read('js/engine/atmosphere.js'), A = atmosphere();
    assert.match(src, /float beyond = max\(0\.0, vDepth\/max\(1\.0,uAirDist\.x\) - 1\.0\);/);
    assert.match(src, /col = mix\(col, uAir\.rgb, uAir\.a\*\(1\.0-exp\(-beyond\*uAirDist\.y\)\)\*\(1\.0-uUnlit\)\*uAtmosphere\);/);
    // None at the point looked at or nearer, most of the amount at three times the distance, never more than the amount.
    const of = times => A.AIR.amount * (1 - Math.exp(-Math.max(0, times - 1) * A.AIR.rate));
    assert.equal(of(0.5), 0);
    assert.equal(of(1), 0);
    assert.ok(of(1.56) > 0.08 && of(1.56) < 0.16, 'the far edge of the ordinary view: about a tenth, ' + of(1.56).toFixed(3));
    assert.ok(of(3.5) > 0.24 && of(3.5) < A.AIR.amount, 'the far edge of a low shot');
    assert.ok(of(100) <= A.AIR.amount);
    // It comes before the far fade into the sky, and the renderer gives it the look-at distance.
    assert.ok(src.indexOf('uAir.a*(1.0-exp(') < src.indexOf('gl_FragColor = vec4(mix(col,uSky,haze),alpha*uAlpha);'));
    const r = read('js/engine/gamerenderer.js');
    assert.match(r, /gl\.uniform4fv\(this\.prog\.uniforms\.uAir, atmosphere\.air \|\| \[0, 0, 0, 0\]\);/);
    assert.match(r, /gl\.uniform2f\(this\.prog\.uniforms\.uAirDist, cam\.dist \|\| 1, atmosphere\.airRate \|\| 0\);/);
    assert.equal(A.lighting(0, [1, 1, 1], [0.5, 0.6, 0.8], 'summer').airRate, A.AIR.rate);
    assert.match(r, /tanHalf, aspect, dist,/, 'the camera carries that distance');
});

test('the fog of war is drawn as mist: it drifts, it is dark by night, and it only ever thickens', () => {
    const src = read('js/engine/atmosphere.js'), r = read('js/engine/gamerenderer.js');
    const block = src.slice(src.indexOf('if (uMist > 0.5) {'), src.indexOf('vec3 base = t.rgb * uTint;'));
    assert.match(block, /waveField\(q \+ uTime\*vec2\([\d.]+,[\d.]+\)\)\.x\*0\.62 \+ waveField\(q\*2\.4 - uTime\*vec2\([\d.]+,[\d.]+\)\)\.x\*0\.38/, 'two fields drifting across each other');
    assert.match(block, /mix\(vec3\(1\.0\), vec3\(0\.34,0\.40,0\.56\), uNight\)/);
    // The alpha is multiplied by one or more: no bank ever shows more of what the fog hides.
    assert.match(block, /t\.a = min\(1\.0, t\.a\*\(1\.0 \+ 0\.16\*bank\)\);/);
    assert.doesNotMatch(block, /t\.a\s*\*=|t\.a = [^m]/);
    // Only the fog's plane is mist, and the flag is sent like the others: when it changes.
    assert.match(r, /tex: this\._fogTex, tint: this\.WHITE, mist: true,/);
    assert.equal((r.match(/mist: true/g) || []).length, 1);
    assert.match(r, /const ms = obj\.mist \? 1 : 0;\s+if \(ms !== mist\) \{ gl\.uniform1f\(U\.uMist, ms\); mist = ms; \}/);
    // Its edge is wider, and that is the display's business, not the rules'.
    assert.match(read('js/fog-display.js'), /FogOfWarManager\.FEATHER_WORLD = 8;/);
    assert.doesNotMatch(read('js/fogofwar.js'), /FEATHER/);
});
