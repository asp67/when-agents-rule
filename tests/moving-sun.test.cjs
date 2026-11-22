// The light travels through the day, so the shadows do. asp67, 22 November: "An invisible
// sun would still move the shadows though, might be worth trying." Built switched off in
// build 1192, switched on by asp67 in build 1193 after seeing it. renderer.movingSun =
// false: the light stands where it always has and nothing changes.
const test = require('node:test'), assert = require('node:assert/strict');
const vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
function atmosphere() {
    const scope = { window: {} }; scope.window.window = scope.window; vm.createContext(scope);
    vm.runInContext(read('js/engine/atmosphere.js'), scope);
    return scope.window.EngineAtmosphere;
}
const REST = (() => { const v = [-0.65, 0.72, 0.36], l = Math.hypot(...v); return v.map(x => x / l); })();
const deg = r => r * 180 / Math.PI, elevation = d => deg(Math.asin(d[1])), azimuth = d => deg(Math.atan2(d[2], d[0]));

test('at noon the light stands where it always has; at the day\'s ends it is lower and to either side', () => {
    const A = atmosphere(), S = A.SUN;
    const noon = A.sunDirection(REST, 0);
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(noon[i] - REST[i]) < 1e-12);
    const morning = A.sunDirection(REST, -1), evening = A.sunDirection(REST, 1);
    assert.ok(Math.abs(elevation(morning) - S.low) < 1e-9 && Math.abs(elevation(evening) - S.low) < 1e-9);
    const turn = (a, b) => ((azimuth(a) - azimuth(b) + 540) % 360) - 180;
    assert.ok(Math.abs(turn(evening, noon) - S.swing) < 1e-9 && Math.abs(turn(morning, noon) + S.swing) < 1e-9);
    // Always a direction of length one, never under the low limit, never above noon.
    for (let p = -1; p <= 1.0001; p += 0.05) {
        const d = A.sunDirection(REST, p);
        assert.ok(Math.abs(Math.hypot(...d) - 1) < 1e-12);
        assert.ok(elevation(d) >= S.low - 1e-9 && elevation(d) <= elevation(REST) + 1e-9, 'at ' + p.toFixed(2));
    }
    assert.ok(S.low >= 25, 'kept well up: a lower light throws shadows out of the shadow map');
});

test('the light never jumps: across the day one way, back through the night, still while sun and moon hand over', () => {
    const A = atmosphere();
    for (const theme of ['summer', 'winter', 'desert']) {
        const [day, dusk, night, dawn] = A.daySchedule(theme);
        assert.equal(A.sunPhase(0, theme), 0, 'noon');
        assert.equal(A.sunPhase(-day / 2, theme), -1);
        assert.ok(Math.abs(A.sunPhase(day / 2 - 0.001, theme) - 1) < 1e-4);
        assert.equal(A.sunPhase(day / 2 + dusk / 2, theme), 1, 'still through dusk');
        assert.ok(Math.abs(A.sunPhase(day / 2 + dusk + night / 2, theme)) < 1e-9, 'the moon at the middle of the night stands where the sun does at noon');
        assert.equal(A.sunPhase(day / 2 + dusk + night + dawn / 2, theme), -1, 'still through dawn');
        let last = A.sunDirection(REST, A.sunPhase(0, theme)), most = 0;
        for (let s = 0.5; s <= 720; s += 0.5) {
            const d = A.sunDirection(REST, A.sunPhase(s, theme));
            most = Math.max(most, deg(Math.acos(Math.min(1, d[0] * last[0] + d[1] * last[1] + d[2] * last[2]))));
            last = d;
        }
        assert.ok(most < 0.35, theme + ': at most ' + most.toFixed(3) + ' degrees in half a second');
    }
});

test('a lower light is made up for in part, and not at all at noon or where the light does not move', () => {
    const A = atmosphere(), sun = [1.0, 0.95, 0.85], sky = [0.42, 0.62, 0.86];
    const plain = A.lighting(100, sun, sky, 'summer'), same = A.lighting(100, sun, sky, 'summer', 1);
    assert.deepEqual(Array.from(same.key), Array.from(plain.key));
    const low = A.lighting(100, sun, sky, 'summer', 1.5);
    const gain = Math.pow(1.5, A.SUN.comp);
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(low.key[i] - plain.key[i] * gain) < 1e-12);
    assert.ok(gain > 1 && gain < 1.5, 'open ground darkens a little as the light sinks, as it does out of doors');
    assert.deepEqual(Array.from(low.fillHigh), Array.from(plain.fillHigh), 'the sky\'s fill is the hour\'s, whatever the light does');
});

test('on since build 1193, and off still means exactly as before', () => {
    const r = read('js/engine/gamerenderer.js');
    assert.match(r, /this\.movingSun = true;/);
    assert.match(r, /const rest = this\._sunRest \|\| \(this\._sunRest = this\.sunDir\);\s+this\.sunDir = this\.movingSun\s+\? EngineAtmosphere\.sunDirection\(rest, EngineAtmosphere\.sunPhase\(hour, this\._theme\)\) : rest;/);
    assert.match(r, /this\.movingSun \? rest\[1\] \/ this\.sunDir\[1\] : 1\);/);
    // The shadow map and the shader read the same direction, the one of this frame.
    assert.match(r, /EngineAtmosphere\.shadowCamera\(M\(\),this\.cameraTarget,this\._halfH,target\.size,this\.sunDir\)/);
    assert.match(r, /gl\.uniform3fv\(this\.prog\.uniforms\.uSunDir, this\.sunDir\);/);
});
