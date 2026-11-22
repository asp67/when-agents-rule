// Build 1211: the shore is never under the fog. Nobody walks the beach (units keep to the
// map's square, resources lie well inside it), so the wet sand, the foam, the reeds and the
// rocks of the coast lay under unexplored fog for a whole match. The fog's PICTURE is rubbed
// out along the coast; what the fog hides is the rules' business and is untouched.
const test = require('node:test'), assert = require('node:assert/strict');
const vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

function display(withIsland = true) {
    const calls = [], canvases = [];
    const ctx2d = canvas => ({ canvas, filter: 'none', globalCompositeOperation: 'source-over', imageSmoothingEnabled: true,
        createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
        putImageData(img) { canvas.image = img; }, save() {}, restore() { this.globalCompositeOperation = 'source-over'; this.filter = 'none'; }, clearRect() {}, fillRect() {},
        createLinearGradient: () => ({ addColorStop() {} }),
        drawImage(src, ...a) { calls.push(['draw', src, this.globalCompositeOperation, a]); } });
    const context = vm.createContext({ console, Math, Float32Array, Uint8Array, Uint8ClampedArray, Map, Set,
        document: { createElement: () => { const c = { width: 0, height: 0 }; const ctx = ctx2d(c); c.getContext = () => ctx; canvases.push(c); return c; } } });
    if (withIsland) for (const f of ['js/simulation/rng.js', 'js/simulation/math.js', 'js/simulation/island.js']) vm.runInContext(read(f), context);
    vm.runInContext(read('js/fogofwar.js') + '\nthis.Fog = FogOfWarManager;' + (withIsland ? 'this.Island = WarIsland;' : ''), context);
    vm.runInContext(read('js/fog-display.js'), context);
    const fow = Object.create(context.Fog.prototype);
    Object.assign(fow, { gridSize: 2, mapSize: 800, numTiles: 400, fogGrid: new Float32Array(400 * 400) });
    return { Fog: context.Fog, Island: context.Island, fow, calls, canvases };
}

test('how much of the fog is taken away: none inland, all of it at the shore and over the sea, following the coast', () => {
    const { Fog, Island } = display();
    const lift = Fog.shoreLift, land = Island.TERRAIN_LAND, half = Island.COAST_WOBBLE / 2;
    assert.equal(lift(0, 0), 0); assert.equal(lift(200, -150), 0);
    // Inside the land's line by more than the band and the coast's wobble: fog whole. Beyond it by the wobble: gone.
    for (const [x, z] of [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 0.5], [-0.3, 1]]) {
        const far = land + Fog.SHORE.whole - half - 1, out = land + half + 1;
        assert.equal(lift(x * far, z * far), 0, 'fog whole ' + far + ' out toward ' + [x, z]);
        assert.equal(lift(x * out, z * out), 1, 'no fog at the water toward ' + [x, z]);
        assert.equal(lift(x * (out + 40), z * (out + 40)), 1, 'nor over the sea');
        // Outward it only ever lifts, give or take the coast's own wobble along the way.
        for (let d = far; d <= out; d += 1) { const v = lift(x * d, z * d); assert.ok(v >= 0 && v <= 1); }
    }
    // The band lies where the constants say, measured from the land's line.
    const noise = Island.coastSampler(Island.TERRAIN_SEED);
    const off = (x, z) => Math.max(Math.abs(x), Math.abs(z)) + noise(x / Island.TERRAIN_WORLD + 0.5, z / Island.TERRAIN_WORLD + 0.5) - land;
    let soft = 0;
    for (let x = land - 60; x < land + 20; x += 0.25) {
        const h = off(x, 37), v = lift(x, 37);
        if (h <= Fog.SHORE.whole) assert.equal(v, 0); else if (h >= Fog.SHORE.gone) assert.equal(v, 1); else { assert.ok(v > 0 && v < 1); soft++; }
    }
    assert.ok(soft > 20, 'a soft edge, not a line');
    assert.ok(Fog.SHORE.whole < Fog.SHORE.gone && Fog.SHORE.gone < 0, 'gone before the land ends: the last stretch of dry beach is clear');
    // It follows the coast, which is not a square: along one side, the same distance out is fogged here and clear there.
    const along = []; for (let z = -300; z <= 300; z += 10) along.push(lift(land - 20, z));
    assert.ok(Math.min(...along) < 0.2 && Math.max(...along) > 0.8, 'the wobble of the coast shows in it');
    // Where there is no island to ask (a bare VM), nothing is lifted.
    assert.equal(display(false).Fog.shoreLift(417, 0), 0);
});

test('the picture of the fog has the shore rubbed out of it, each time it is painted', () => {
    const { Fog, fow, calls } = display();
    fow.initDisplay();
    assert.equal(fow.displayWorldSize, 800 + 2 * Fog.EDGE_MARGIN_WORLD);
    fow.paintFog();
    const shore = fow._shoreCanvas, S = Fog.SHORE_PIXELS;
    assert.ok(shore && shore.width === S && shore.height === S);
    // The last thing drawn onto the display canvas: the shore, rubbing out, over the whole plane.
    const draws = calls.filter(c => c[0] === 'draw'), last = draws[draws.length - 1], W = fow.fogDisplayCanvas.width;
    assert.equal(last[1], shore); assert.equal(last[2], 'destination-out'); assert.deepEqual(Array.from(last[3]), [0, 0, W, W]);
    // The picture: clear in the middle of the island, opaque at the rim of the plane; a column is x and a row is z.
    const a = (px, py) => shore.image.data[(py * S + px) * 4 + 3], D = fow.displayWorldSize;
    assert.equal(a(S / 2, S / 2), 0); assert.equal(a(2, S / 2), 255); assert.equal(a(S / 2, 2), 255); assert.equal(a(S - 3, S - 3), 255);
    for (const [px, py] of [[40, 200], [200, 40], [330, 100], [352, 192]]) {
        assert.equal(a(px, py), Math.round(255 * Fog.shoreLift(((px + 0.5) / S - 0.5) * D, ((py + 0.5) / S - 0.5) * D)));
    }
    // Made once for an island, not at every painting; let go with the rest.
    fow.paintFog(); assert.equal(fow._shoreCanvas, shore);
    fow.dropDisplay(); assert.equal(fow._shoreCanvas, null);
    // Without an island the fog is painted as it always was.
    const bare = display(false); bare.fow.initDisplay(); bare.fow.paintFog();
    assert.ok(!bare.fow._shoreCanvas);
    const rubbed = c => c[0] === 'draw' && c[2] === 'destination-out';
    assert.equal(bare.calls.filter(rubbed).length, 0); assert.equal(calls.filter(rubbed).length, 2);
});

test('what stands at the shore is shown unexplored; what the fog hides is still for the rules to say', () => {
    const r = read('js/engine/gamerenderer.js');
    assert.match(r, /const shore = typeof FogOfWarManager !== 'undefined' && FogOfWarManager\.shoreLift \? FogOfWarManager\.shoreLift : null;/);
    assert.match(r, /const atShore = mb => mb\.shore === undefined \? \(mb\.shore = !!shore && shore\(mb\.fx, mb\.fz\) >= 0\.5\) : mb\.shore;/);
    assert.match(r, /mb\.want = mb\.tier <= level && !mb\.built && \(!seen \|\| seen\(fow, mb\.fx, mb\.fz, 3, 3, true\) \|\| atShore\(mb\)\);/);
    // Units and buildings are hidden by the same test as before, which knows nothing of the shore.
    assert.match(r, /\(this\.entityHidden && this\.entityHidden\(b, 'building'\)\)/);
    assert.match(r, /\(this\.entityHidden && this\.entityHidden\(u, 'unit'\)\)/);
    assert.equal((r.match(/shoreLift/g) || []).length, 2, 'the renderer asks about the shore for its scatter and nothing else');
    // No rule file changed or knows of it: the data of the fog is as it was.
    const manifest = require(path.join(__dirname, '..', 'js/manifest.js'));
    assert.equal(manifest.rules.includes('js/fog-display.js'), false);
    for (const f of manifest.rules) assert.doesNotMatch(read(f), /shoreLift|FogOfWarManager\.SHORE/, f);
});
