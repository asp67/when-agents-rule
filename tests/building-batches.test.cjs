// A finished building is drawn in batches (b1078): its parts merged into one mesh per
// material and cached per model. Each part used to be its own draw call, twice a frame
// with the shadow pass -- the Colosseum alone has 225 of them.
const test = require('node:test'), assert = require('node:assert/strict');
const vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
const src = f => fs.readFileSync(path.join(__dirname, '../js/engine/' + f + '.js'), 'utf8');

test('a finished building draws as a few merged meshes, the same parts in them', () => {
    const scope = { window: {}, console }; scope.window.window = scope.window; vm.createContext(scope);
    for (const f of ['math3d', 'mesh', 'texgen', 'buildings', 'units']) vm.runInContext(src(f), scope);
    let made = 0;
    scope.window.GLCore = { createMeshBuffers: (gl, mesh) => { made++; return { mesh }; } };
    vm.runInContext('Object.assign(globalThis, window);' + src('gamerenderer'), scope);
    const R = scope.window.EngineRenderer || vm.runInContext('window.EngineRenderer', scope);
    const fake = { gl: {} };
    const parts = scope.window.EngineBuildings.parts('colosseum', {});
    const batches = R.prototype._buildingBatches.call(fake, 'colosseum|iron|roman', parts);
    assert.equal(parts.length, 225);
    assert.ok(batches.length <= 10, `${batches.length} draw calls`);
    assert.equal(batches.reduce((n, b) => n + b.count, 0), parts.length, 'every part in a batch');
    const verts = parts.reduce((n, p) => n + scope.window.EngineMesh[p.kind](...p.args).positions.length, 0);
    assert.equal(batches.reduce((n, b) => n + b.buf.mesh.positions.length, 0), verts, 'and all their geometry');
    const again = R.prototype._buildingBatches.call(fake, 'colosseum|iron|roman', parts);
    assert.equal(again, batches, 'built once per model');
    assert.equal(made, batches.length);
});
