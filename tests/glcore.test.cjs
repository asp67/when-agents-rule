// The engine's WebGL plumbing since overhaul step A4: WebGL 2 first with WebGL 1 as the
// fallback, and vertex array objects so a draw is a few calls instead of some ten.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

function load(extra = {}) {
    const scope = Object.assign({ window: {}, console }, extra);
    vm.createContext(scope);
    vm.runInContext(read('js/engine/glcore.js'), scope);
    return scope.window.GLCore;
}
// A context that records every call; `kind` decides what it can do.
function context(kind) {
    const log = [];
    const gl = { log, DEPTH_TEST: 'DEPTH_TEST', CULL_FACE: 'CULL_FACE', BACK: 'BACK', ARRAY_BUFFER: 'ARRAY_BUFFER', ELEMENT_ARRAY_BUFFER: 'ELEMENT_ARRAY_BUFFER',
        FLOAT: 'FLOAT', TRIANGLES: 'TRIANGLES', UNSIGNED_SHORT: 'UNSIGNED_SHORT' };
    for (const f of ['enable', 'cullFace', 'bindBuffer', 'enableVertexAttribArray', 'vertexAttribPointer', 'drawElements', 'deleteBuffer'])
        gl[f] = (...a) => { log.push(f + '(' + a.map(x => (x && x.name) || x).join(',') + ')'); };
    let made = 0;
    if (kind === 2) {
        gl.createVertexArray = () => ({ name: 'array' + ++made });
        gl.bindVertexArray = a => log.push('bindArray(' + (a ? a.name : null) + ')');
        gl.deleteVertexArray = a => log.push('deleteArray(' + a.name + ')');
    }
    gl.getExtension = name => {
        if (kind !== 'ext' || name !== 'OES_vertex_array_object') return null;
        return { createVertexArrayOES: () => ({ name: 'array' + ++made }), bindVertexArrayOES: a => log.push('bindArray(' + (a ? a.name : null) + ')'), deleteVertexArrayOES: a => log.push('deleteArray(' + a.name + ')') };
    };
    return gl;
}
const mesh = () => ({ position: { name: 'pos' }, normal: { name: 'nrm' }, uv: { name: 'uv' }, index: { name: 'idx' }, count: 36 });
const main = { name: 'main', attribs: { aPosition: 0, aNormal: 1, aUv: 2 } }, shadow = { name: 'shadow', attribs: { aPosition: 0 } };

test('WebGL 2 is asked for first, WebGL 1 is the fallback, and ?webgl=1 asks for WebGL 1 outright', () => {
    const G = load();
    const canvas = (have) => { const asked = []; return { asked, getContext: (name, cfg) => { asked.push([name, JSON.stringify(cfg)]); return have.includes(name) ? context(name === 'webgl2' ? 2 : 'ext') : null; } }; };
    let c = canvas(['webgl2', 'webgl']);
    G.createContext(c, { preserveDrawingBuffer: true });
    assert.deepEqual(c.asked.map(a => a[0]), ['webgl2']);
    assert.equal(c.asked[0][1], '{"antialias":true,"preserveDrawingBuffer":true}');
    c = canvas(['webgl']);
    G.createContext(c);
    assert.deepEqual(c.asked.map(a => a[0]), ['webgl2', 'webgl']);
    c = canvas(['experimental-webgl']);
    G.createContext(c);
    assert.deepEqual(c.asked.map(a => a[0]), ['webgl2', 'webgl', 'experimental-webgl']);
    c = canvas(['webgl2', 'webgl']);
    G.createContext(c, { webgl1: true, preserveDrawingBuffer: true });
    assert.deepEqual(c.asked.map(a => a[0]), ['webgl']);
    assert.equal(c.asked[0][1], '{"antialias":true,"preserveDrawingBuffer":true}', 'the switch is ours, not a context attribute');
    c = canvas([]);
    assert.throws(() => G.createContext(c), e => e.noWebGL === true);
    // The page passes its ?webgl=1 on.
    assert.match(read('js/engine/gamerenderer.js'), /webgl1: typeof location !== 'undefined' && \/\[\?&\]webgl=1\(&\|\$\)\/\.test\(location\.search \|\| ''\) \}\);/);
    // Which one it got is said on the context, for the benchmark's report.
    class WebGL2RenderingContext {}
    const two = load({ WebGL2RenderingContext });
    const gl2 = Object.assign(new WebGL2RenderingContext(), context(2));
    assert.equal(two.createContext({ getContext: () => gl2 }).warVersion, 2);
    assert.equal(two.createContext({ getContext: name => (name === 'webgl' ? context('ext') : null) }).warVersion, 1);
    assert.match(read('js/perf-bench.js'), /webgl: gl\.warVersion \|\| 1,\s+arrays: !!GLCore\.vaoOf\(gl\),/);
});

test('with vertex arrays a mesh is pointed at once per program; a draw is then bind, draw, let go', () => {
    for (const kind of [2, 'ext']) {
        const G = load(), gl = context(kind), m = mesh();
        G.drawMesh(gl, main, m);
        assert.deepEqual(gl.log, ['bindArray(array1)', 'bindBuffer(ARRAY_BUFFER,pos)', 'enableVertexAttribArray(0)', 'vertexAttribPointer(0,3,FLOAT,false,0,0)',
            'bindBuffer(ARRAY_BUFFER,nrm)', 'enableVertexAttribArray(1)', 'vertexAttribPointer(1,3,FLOAT,false,0,0)',
            'bindBuffer(ARRAY_BUFFER,uv)', 'enableVertexAttribArray(2)', 'vertexAttribPointer(2,2,FLOAT,false,0,0)',
            'bindBuffer(ELEMENT_ARRAY_BUFFER,idx)', 'drawElements(TRIANGLES,36,UNSIGNED_SHORT,0)', 'bindArray(null)'], 'the first draw, ' + kind);
        gl.log.length = 0;
        G.drawMesh(gl, main, m); G.drawMesh(gl, main, m);
        assert.deepEqual(gl.log, ['bindArray(array1)', 'drawElements(TRIANGLES,36,UNSIGNED_SHORT,0)', 'bindArray(null)',
            'bindArray(array1)', 'drawElements(TRIANGLES,36,UNSIGNED_SHORT,0)', 'bindArray(null)'], 'every draw after it, ' + kind);
        // The shadow pass is another program with fewer attributes: its own array, pointed at once too.
        gl.log.length = 0;
        G.drawMesh(gl, shadow, m); G.drawMesh(gl, shadow, m);
        assert.deepEqual(gl.log, ['bindArray(array2)', 'bindBuffer(ARRAY_BUFFER,pos)', 'enableVertexAttribArray(0)', 'vertexAttribPointer(0,3,FLOAT,false,0,0)',
            'bindBuffer(ELEMENT_ARRAY_BUFFER,idx)', 'drawElements(TRIANGLES,36,UNSIGNED_SHORT,0)', 'bindArray(null)',
            'bindArray(array2)', 'drawElements(TRIANGLES,36,UNSIGNED_SHORT,0)', 'bindArray(null)']);
        // No array stays bound between draws: what is drawn by hand afterwards cannot write into a mesh's array.
        assert.equal(gl.log[gl.log.length - 1], 'bindArray(null)');
        // Given back with the mesh.
        gl.log.length = 0;
        G.deleteMeshBuffers(gl, m);
        assert.deepEqual(gl.log, ['deleteArray(array1)', 'deleteArray(array2)', 'deleteBuffer(pos)', 'deleteBuffer(nrm)', 'deleteBuffer(uv)', 'deleteBuffer(idx)']);
        assert.equal(m.arrays, null);
        G.deleteMeshBuffers(gl, null);
    }
});

test('without vertex arrays a mesh is pointed at for every draw, as it always was', () => {
    const G = load(), gl = context('none'), m = mesh();
    assert.equal(G.vaoOf(gl), null);
    G.drawMesh(gl, main, m);
    const first = gl.log.slice();
    assert.equal(first.length, 11);
    assert.equal(first[first.length - 1], 'drawElements(TRIANGLES,36,UNSIGNED_SHORT,0)');
    gl.log.length = 0;
    G.drawMesh(gl, main, m);
    assert.deepEqual(gl.log, first);
    gl.log.length = 0;
    G.deleteMeshBuffers(gl, m);
    assert.deepEqual(gl.log, ['deleteBuffer(pos)', 'deleteBuffer(nrm)', 'deleteBuffer(uv)', 'deleteBuffer(idx)']);
    // The answer is found once per context.
    let asked = 0;
    const counting = Object.assign(context('none'), { getExtension: () => { asked++; return null; } });
    G.vaoOf(counting); G.vaoOf(counting); G.drawMesh(counting, main, mesh());
    assert.equal(asked, 1);
});

test('buffers that are freed are freed through the helper, so their arrays go too', () => {
    // (A chunk's batch may have a second set of corners, for ghost nodes: build 1311. It goes the same way.)
    assert.match(read('js/engine/gamerenderer.js'), /for \(const c of this\._resChunks\.list\) for \(const g of c\.groups \|\| \[\]\) \{\r?\n\s+if \(g\.ghostBuf\) GLCore\.deleteMeshBuffers\(gl, g\.ghostBuf\);\r?\n\s+GLCore\.deleteMeshBuffers\(gl, g\.buf\);/);
    // A twin gives back its own positions and nothing of the mesh it was made beside.
    assert.match(read('js/engine/glcore.js'), /buffers\.shared \? \['instance'\] : buffers\.twin \? \['position'\] : \['position', 'normal', 'uv', 'bone', 'index'\]/);
    // A grass tile is a list of instances since build 1202 (and one of pebbles where it has any).
    assert.match(read('js/engine/grass.js'), /GLCore\.deleteMeshBuffers\(this\.renderer\.gl, tile\.tufts\);\s+if \(tile\.stones\) GLCore\.deleteMeshBuffers\(this\.renderer\.gl, tile\.stones\);/);
    // Nothing in the engine frees a mesh's buffers one by one any more.
    for (const f of ['js/engine/gamerenderer.js', 'js/engine/grass.js', 'js/engine/bloom.js', 'js/engine/fx.js', 'js/engine/occlusion.js'])
        assert.doesNotMatch(read(f), /deleteBuffer\(/, f);
});
