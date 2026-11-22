// Build 1216 (asp67, 22 November 2026): "Resource nodes are often clipped when close ups
// from workers show them harvesting, which looks like they are harvesting a missing node."
// Resources are drawn in blocks, asked about by their middle with a margin. The test for
// "behind the camera" asked about the middle alone.
const test = require('node:test'), assert = require('node:assert/strict');
const vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

function renderer() {
    const scope = { window: {}, console, performance: { now: () => 1000 } }; scope.window.window = scope.window; vm.createContext(scope);
    for (const f of ['js/simulation/rng.js', 'js/simulation/math.js', 'js/simulation/island.js']) vm.runInContext(read(f), scope);
    for (const f of ['math3d', 'mesh', 'texgen', 'buildings', 'units', 'atmosphere', 'fx']) vm.runInContext(read('js/engine/' + f + '.js'), scope);
    scope.window.GLCore = { createMeshBuffers: (gl, mesh) => ({ mesh }), createShadowBuffers: (gl, mesh) => ({ mesh }), deleteMeshBuffers() {}, drawMesh() {} };
    vm.runInContext('Object.assign(globalThis, window);' + read('js/engine/gamerenderer.js'), scope);
    const R = vm.runInContext('window.EngineRenderer', scope), M = scope.window.M3D;
    // A camera as the renderer makes it: looking at (x, z) from a frame half-height, a yaw and a pitch.
    const at = (x, z, halfH, yaw, pitch, lookY = 0) => {
        const tanHalf = Math.tan(10 * Math.PI / 180), cam = M.dimetricView(x, z, halfH / tanHalf, yaw, pitch, lookY);
        return Object.assign(Object.create(R.prototype), { _cam: { view: cam.view, eye: cam.eye, tanHalf, aspect: 1.6 } });
    };
    return { R, at };
}

test('a block of resources is drawn when any of it can be in the picture, though its middle lies behind the camera', () => {
    const { R, at } = renderer();
    const margin = R.RES_CHUNK * 0.71 + 14;
    // A close-up of a woodcutter at (0, 0): the frame 3.6 high, the camera 20 units off at a low angle.
    const close = at(0, 0, 3.6, 0, 0.17, 1.0), eye = close._cam.eye;
    assert.ok(Math.hypot(eye[0], eye[2]) > 19 && Math.hypot(eye[0], eye[2]) < 21);
    // The tree stands a step beside the worker; the middle of its block is 30 units behind the eye.
    assert.equal(close._cull(4, eye[2] + 30, margin), false, 'the block the tree is in');
    for (const [x, z] of [[-30, 10], [25, 28], [0, eye[2] + 1], [-20, eye[2] + 40]]) assert.equal(close._cull(x, z, margin), false, 'a block around the subject: ' + [x, z]);
    // The tree itself, asked about alone, was never the trouble; nor a unit before the lens.
    assert.equal(close._cull(1.5, -1, 6), false);
    // A block that is all behind the camera is still left out, and one far off to the side.
    assert.equal(close._cull(0, eye[2] + margin + 5, margin), true, 'all of it behind the eye');
    assert.equal(close._cull(400, -100, margin), true);
    // The same from every side a close-up may stand on.
    for (let yaw = 0; yaw < Math.PI * 2; yaw += Math.PI / 4) {
        const cam = at(100, -50, 3.6, yaw, 0.17, 1.0), e = cam._cam.eye, back = [e[0] - 100, e[2] + 50], l = Math.hypot(...back);
        assert.equal(cam._cull(e[0] + back[0] / l * 30, e[2] + back[1] / l * 30, margin), false, 'yaw ' + yaw.toFixed(2));
        assert.equal(cam._cull(e[0] + back[0] / l * (margin + 6), e[2] + back[1] / l * (margin + 6), margin), true);
    }
    // From game height nothing changes for what is well in front of the camera: in stays in, out stays out.
    const game = at(0, 0, 30, Math.PI / 4, 0.46);
    assert.equal(game._cull(0, 0, 6), false); assert.equal(game._cull(20, -10, 6), false);
    assert.equal(game._cull(300, 300, 6), true); assert.equal(game._cull(-200, 150, 18), true);
    assert.match(read('js/engine/gamerenderer.js'), /if \(vz - margin > -2\) return true;/);
});
