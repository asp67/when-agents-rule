// Overhaul step A7 (build 1205): water and shore. Wet sand above the waterline, foam that
// rolls in, clear shallows, and glitter where the sea mirrors the sun to the eye. All in the
// water branch of the main shader, fed by two more channels of the coast's map; no extra
// pass and no draw more.
const test = require('node:test'), assert = require('node:assert/strict');
const vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

function texgen() {
    const scope = { window: {} }; vm.createContext(scope);
    scope.document = { createElement: () => ({ getContext: () => ({ createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData(img) { scope.lastImage = img; } }) }) };
    for (const f of ['js/simulation/rng.js', 'js/simulation/math.js', 'js/simulation/island.js', 'js/engine/texgen.js']) vm.runInContext(read(f), scope);
    return { T: scope.window.TexGen, scope };
}
const shader = () => read('js/engine/atmosphere.js');

test('the coast\'s map says how much of a point is water, how far out it lies and how wet the sand is', () => {
    const { T, scope } = texgen(), size = 256;
    T.coastMask(size);
    const px = scope.lastImage.data, coast = T.coastSampler(T.TERRAIN_SEED);
    assert.equal(T.SHORE_DEEP, 60); assert.equal(T.SHORE_WET, 6);
    const clamp = v => Math.max(0, Math.min(1, v));
    let wet = 0, shallow = 0, deep = 0, dry = 0;
    for (let y = 0; y < size; y += 3) for (let x = 0; x < size; x += 3) {
        const u = x / size, v = y / size, i = (y * size + x) * 4;
        const off = Math.max(Math.abs((u - .5) * T.TERRAIN_WORLD), Math.abs((v - .5) * T.TERRAIN_WORLD)) + coast(u, v) - T.TERRAIN_LAND - 3;
        assert.equal(px[i], Math.round(255 * clamp(off / 10)), 'red is the water\'s share, as it always was');
        assert.equal(px[i + 1], Math.round(255 * clamp(off / 60)), 'green: how far out, to sixty units');
        assert.equal(px[i + 2], Math.round(255 * clamp(1 + off / 6)), 'blue: wet at the water, dry six units up the beach');
        assert.equal(px[i + 3], 255);
        if (off < -6) { dry++; assert.deepEqual([px[i], px[i + 1], px[i + 2]], [0, 0, 0]); }
        else if (off < 0) { wet++; assert.equal(px[i], 0); assert.ok(px[i + 2] > 0); }
        else if (off < 60) shallow++; else { deep++; assert.deepEqual([px[i], px[i + 1], px[i + 2]], [255, 255, 255]); }
    }
    assert.ok(dry > 1000 && wet > 20 && shallow > 200 && deep > 20, 'all four zones are on the map: ' + [dry, wet, shallow, deep]);
});

test('the shader reads the three channels once; the open sea beyond the ground is all water and deep', () => {
    const s = shader();
    assert.match(s, /vec3 coast = uMaterial > 1\.5 && uMaterial < 2\.5 \? vec3\(1\.0\)\s+: \(uMaterial > 0\.5 && uMaterial < 1\.5 \? texture2D\(uCoast,vUv\)\.rgb : vec3\(0\.0\)\);\s+float water = coast\.r;/);
    assert.equal((s.match(/texture2D\(uCoast/g) || []).length, 1);
    // The distances the map was painted with are the ones the shader turns its values back into.
    assert.match(s, /float off=coast\.g\*60\.0;/);
});

test('wet sand: darker above the waterline, to a line that moves with the swash; Simple lighting is untouched', () => {
    const s = shader();
    assert.match(s, /if \(uMaterial > 0\.5 && uMaterial < 1\.5 && coast\.b > 0\.0 && water < 0\.99\) \{\s+swash = 0\.5 \+ 0\.5\*sin\(uTime\*0\.6 \+ waveField\(vWorld\.xz\*0\.07\)\.x\*6\.2832\);\s+wetSand = smoothstep\(0\.34 - 0\.24\*swash, 0\.80, coast\.b\)\*\(1\.0-water\);\s+albedo \*= 1\.0 - 0\.33\*wetSand;/);
    assert.match(s, /vec3 col = albedo\*light \+ uSky\*uSky\*wetSand\*0\.07;/);
    // The sum for Simple lighting is taken from the plain colour, before any of this.
    assert.ok(s.indexOf('vec3 legacy = base*(uAmbient + uSunColor*sun);') < s.indexOf('float wetSand = 0.0, swash = 0.5;'));
    // Neither the wet sand nor the water's own block changes the plain colour or that sum.
    const wetBlock = s.slice(s.indexOf('float wetSand = 0.0'), s.indexOf('// Contact shading')), seaBlock = s.slice(s.indexOf('if (water > 0.01) {'), s.indexOf('float peak = max(col.r'));
    for (const block of [wetBlock, seaBlock]) { assert.ok(block.length > 200); assert.doesNotMatch(block, /\blegacy\b|\bbase\s*[*+]?=(?!=)/); }
    // In numbers: the wet line reaches further up the beach when the swash is in.
    const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
    const wetAt = (b, reach) => smooth(0.34 - 0.24 * reach, 0.80, b);
    assert.equal(wetAt(0.05, 0), 0); assert.equal(wetAt(0.05, 1), 0);
    assert.ok(wetAt(0.3, 1) > 0.1 && wetAt(0.3, 0) === 0, 'four units up the beach: wet only when the swash is in');
    assert.equal(wetAt(0.85, 0), 1);
});

test('the shallows are lighter, greener and mirror less; light plays on the bottom close by', () => {
    const s = shader();
    assert.match(s, /float shallow=1\.0-smoothstep\(0\.0,0\.42,coast\.g\);\s+shallow\*=shallow;/);
    assert.match(s, /body=mix\(body,body\*vec3\(1\.24,1\.30,1\.10\)\+vec3\(0\.015,0\.035,0\.025\),shallow\);/);
    assert.match(s, /body\*=1\.0\+0\.55\*shallow\*detail\*smoothstep\(0\.28,0\.52,caustic\);/);
    assert.match(s, /vec3 sea=mix\(body\*mix\(vec3\(1\.0\),vec3\(0\.38,0\.48,0\.65\),uNight\),uSky\*0\.72,fresnel\*0\.8\*\(1\.0-0\.5\*shallow\)\);/);
    // Out at sea (shallow 0) the colour is what it was: the body is the old one, and the mirror at full.
    assert.match(s, /vec3 body=base\*vec3\(0\.72,0\.96,1\.02\);/);
});

test('glitter: facets of a finer ripple flash where they mirror the sun, on top of the glint the sea always had', () => {
    const s = shader();
    assert.match(s, /float towardSun=max\(dot\(wn,normalize\(eye\+uSunDir\)\),0\.0\);\s+float glint=pow\(towardSun,48\.0\);/);
    assert.match(s, /float flash=pow\(max\(dot\(normalize\(vec3\(-facet\.x,1\.0,-facet\.y\)\),normalize\(eye\+uSunDir\)\),0\.0\),160\.0\);/);
    assert.match(s, /sea \+= uSunColor\*\(glint\*0\.42 \+ flash\*twinkle\*detail\*0\.85\);/);
    // Flat water mirrors the sun to the eye only from the far side of it, at its height: away from
    // that line nothing flashes, which is why the default view of a noon sea has none.
    const norm = v => { const l = Math.hypot(...v); return v.map(x => x / l); };
    const lobe = (eye, sun) => { const h = norm(eye.map((v, i) => v + sun[i])); return Math.pow(Math.max(h[1], 0), 160); };
    const sun = norm([-0.65, 0.72, 0.36]);
    assert.ok(lobe([-sun[0], sun[1], -sun[2]], sun) > 0.999, 'on the mirror line');
    assert.ok(lobe(norm([0.632, 0.447, 0.632]), sun) < 1e-12, 'the default camera, with the sun behind it');
});

test('foam rolls in toward the beach and laps at the waterline', () => {
    const s = shader();
    assert.match(s, /float nearShore=1\.0-smoothstep\(3\.0,15\.0,off\);/);
    assert.match(s, /float roll=off\*1\.1\+uTime\*0\.9\+waveField\(vWorld\.xz\*0\.045\)\.x\*5\.0\+waveField\(vWorld\.xz\*0\.23\+vec2\(4\.0,9\.0\)\)\.x\*2\.2;/);
    assert.match(s, /float lap=smoothstep\(0\.03,0\.10,water\)\*\(1\.0-smoothstep\(0\.10,0\.24,water\)\)\*\(0\.40\+0\.60\*swash\);/);
    assert.match(s, /col=mix\(col,\(uFillHigh\*0\.85\+uKey\*0\.70\)\*0\.80,foam\*0\.82\);/);
    // A crest keeps its phase: as time goes on it is nearer the beach. About six units from crest
    // to crest, a little under a unit a second.
    const apart = 2 * Math.PI / 1.1, speed = 0.9 / 1.1;
    assert.ok(apart > 5 && apart < 6.5 && speed > 0.7 && speed < 0.95);
    const phase = (off, t) => off * 1.1 + t * 0.9;
    assert.ok(Math.abs(phase(10, 0) - phase(10 - speed * 4, 4)) < 1e-9, 'four seconds later the same crest is ' + (speed * 4).toFixed(1) + ' units further in');
    // No foam on dry sand.
    assert.match(s, /crest\*ragged\*nearShore\*smoothstep\(0\.02,0\.20,water\)\+lap\*\(0\.55\+0\.45\*ragged\)/);
});

test('the foam ribbon is drawn only in Simple lighting, and the reeds stand at the water', () => {
    const r = read('js/engine/gamerenderer.js');
    assert.match(r, /if \(this\._foam && this\.visualStyle === 'classic'\) \{/);
    // The waterline is three units beyond the land's line: reeds from a little above it into the shallows.
    assert.match(r, /const r = radiusAt\(p\[0\], p\[1\], LAND \+ 2 \+ rng\(\) \* 6\), x = r \* p\[0\], z = r \* p\[1\];/);
    // No rule file reads the coast's map.
    for (const f of ['js/terrain.js', 'js/game.js', 'js/simulation/island.js', 'js/simulation/position-rules.js']) assert.doesNotMatch(read(f), /coastMask|SHORE_DEEP|SHORE_WET/, f);
});
