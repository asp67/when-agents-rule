// GLCore — raw WebGL plumbing for the in-house engine: context creation,
// shader compilation, mesh buffers, canvas-painted textures and draw calls.
// Deliberately tiny: exactly what the game needs, nothing speculative.
(function () {
    const GLCore = {};

    GLCore.createContext = (canvas, opts) => {
        const cfg = Object.assign({ antialias: true }, opts || {});
        // WebGL 2 is asked for first (overhaul step A4): vertex array objects and
        // instancing are part of it instead of extensions that may be missing. The
        // shaders are the same GLSL either way. WebGL 1 remains the fallback, and
        // { webgl1: true } asks for it outright (the page's ?webgl=1, for comparing).
        const one = !!cfg.webgl1;
        delete cfg.webgl1;
        // 'experimental-webgl' is the same WebGL 1, exposed under the old name by some
        // older builds and by drivers the browser has half-blocklisted. Costs one line
        // and is occasionally the difference between a working machine and a black
        // screen, so ask twice before giving up.
        const gl = (!one && canvas.getContext('webgl2', cfg)) || canvas.getContext('webgl', cfg) || canvas.getContext('experimental-webgl', cfg);
        // A marked error, because the caller has to tell THIS apart from every other
        // failure: it is the one that is about the machine rather than about the game.
        if (!gl) {
            const err = new Error('WebGL not available');
            err.noWebGL = true;
            throw err;
        }
        gl.enable(gl.DEPTH_TEST);
        // Back-face culling is ON since the M2 winding audit: every builder's
        // triangle winding provably agrees with its outward normals
        // (EngineMesh.auditWinding returns 0 for the whole library).
        gl.enable(gl.CULL_FACE);
        gl.cullFace(gl.BACK);
        gl.warVersion = (typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext) ? 2 : 1;
        return gl;
    };

    // Vertex array objects: part of WebGL 2, an extension in WebGL 1, missing on a few old
    // drivers (then null, and a mesh is pointed at afresh for every draw, as it always was).
    GLCore.vaoOf = gl => {
        if (gl._warVao !== undefined) return gl._warVao;
        let v = null;
        if (typeof gl.createVertexArray === 'function') {
            v = { create: () => gl.createVertexArray(), bind: a => gl.bindVertexArray(a), remove: a => gl.deleteVertexArray(a) };
        } else {
            const ext = typeof gl.getExtension === 'function' ? gl.getExtension('OES_vertex_array_object') : null;
            if (ext) v = { create: () => ext.createVertexArrayOES(), bind: a => ext.bindVertexArrayOES(a), remove: a => ext.deleteVertexArrayOES(a) };
        }
        return (gl._warVao = v);
    };

    // Instancing: one mesh drawn many times in one call, each time with the next entry of a
    // list (overhaul step A6: the grass). Part of WebGL 2, an extension in WebGL 1; null
    // where neither is there, and then nothing instanced is drawn.
    GLCore.instancingOf = gl => {
        if (gl._warInstancing !== undefined) return gl._warInstancing;
        let v = null;
        if (typeof gl.drawElementsInstanced === 'function') {
            v = { divisor: (at, n) => gl.vertexAttribDivisor(at, n), draw: (count, n) => gl.drawElementsInstanced(gl.TRIANGLES, count, gl.UNSIGNED_SHORT, 0, n) };
        } else {
            const ext = typeof gl.getExtension === 'function' ? gl.getExtension('ANGLE_instanced_arrays') : null;
            if (ext) v = { divisor: (at, n) => ext.vertexAttribDivisorANGLE(at, n), draw: (count, n) => ext.drawElementsInstancedANGLE(gl.TRIANGLES, count, gl.UNSIGNED_SHORT, 0, n) };
        }
        return (gl._warInstancing = v);
    };

    // A list of places for a mesh that is already on the card: four numbers an entry
    // (what they mean is the shader's business: aInstance), or eight (stride 8: a second
    // four, aInstanceColor -- the particles of build 1206). The result is drawn like any
    // mesh; it shares the mesh's buffers and owns only its list. `instances` is how many
    // entries a draw takes, from the start of the list: set it lower to draw fewer.
    GLCore.createInstances = (gl, mesh, data, stride = 4) => {
        const instance = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, instance);
        gl.bufferData(gl.ARRAY_BUFFER, data, stride === 8 ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW);
        return { position: mesh.position, normal: mesh.normal, uv: mesh.uv, bone: null, index: mesh.index, count: mesh.count,
            shared: true, instance, stride, _bytes: data.byteLength || 0,
            instances: data.length / stride, capacity: data.length / stride };
    };
    // The same list, longer or changed: reuse GPU allocation with bufferSubData when it fits.
    GLCore.setInstances = (gl, buffers, data) => {
        gl.bindBuffer(gl.ARRAY_BUFFER, buffers.instance);
        const bytes = data.byteLength || 0;
        if (bytes > 0 && buffers._bytes && bytes <= buffers._bytes && typeof gl.bufferSubData === 'function') {
            gl.bufferSubData(gl.ARRAY_BUFFER, 0, data);
        } else {
            gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
            buffers._bytes = bytes;
        }
        buffers.instances = data.length / (buffers.stride || 4);
        if (buffers.instances > buffers.capacity) buffers.capacity = buffers.instances;
    };

    GLCore.compileProgram = (gl, vsSource, fsSource) => {
        const make = (type, src) => {
            const sh = gl.createShader(type);
            gl.shaderSource(sh, src);
            gl.compileShader(sh);
            if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
                throw new Error('Shader compile failed: ' + gl.getShaderInfoLog(sh) + '\n--- source ---\n' + src);
            }
            return sh;
        };
        const prog = gl.createProgram();
        gl.attachShader(prog, make(gl.VERTEX_SHADER, vsSource));
        gl.attachShader(prog, make(gl.FRAGMENT_SHADER, fsSource));
        // The position is attribute 0, which is always an array. Left to the linker, an
        // attribute that is often a constant (a mesh's bone number, for a mesh without
        // bones) could land there, and a constant at 0 is slow on desktop drivers.
        gl.bindAttribLocation(prog, 0, 'aPosition');
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
            throw new Error('Program link failed: ' + gl.getProgramInfoLog(prog));
        }
        // Cache attribute/uniform locations by walking the actives — callers use
        // program.attribs.name / program.uniforms.name instead of lookups.
        prog.attribs = {};
        prog.uniforms = {};
        const nA = gl.getProgramParameter(prog, gl.ACTIVE_ATTRIBUTES);
        for (let i = 0; i < nA; i++) {
            const info = gl.getActiveAttrib(prog, i);
            prog.attribs[info.name] = gl.getAttribLocation(prog, info.name);
        }
        const nU = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
        for (let i = 0; i < nU; i++) {
            const info = gl.getActiveUniform(prog, i);
            const name = info.name.replace(/\[0\]$/, '');
            prog.uniforms[name] = gl.getUniformLocation(prog, name);
        }
        return prog;
    };

    // Upload an EngineMesh ({positions, normals, uvs, indices}) to GPU buffers.
    GLCore.createMeshBuffers = (gl, mesh) => {
        const buf = (target, data) => {
            const b = gl.createBuffer();
            gl.bindBuffer(target, b);
            gl.bufferData(target, data, gl.STATIC_DRAW);
            return b;
        };
        return {
            position: buf(gl.ARRAY_BUFFER, new Float32Array(mesh.positions)),
            normal: buf(gl.ARRAY_BUFFER, new Float32Array(mesh.normals)),
            uv: buf(gl.ARRAY_BUFFER, new Float32Array(mesh.uvs)),
            // The number of the bone each vertex hangs on: only a unit's skinned mesh has it.
            bone: mesh.bones ? buf(gl.ARRAY_BUFFER, new Float32Array(mesh.bones)) : null,
            index: buf(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(mesh.indices)),
            count: mesh.indices.length
        };
    };

    // A canvas painted by TexGen becomes a mipmapped texture. Materials repeat
    // by default; pass { clamp: true } for one-shot maps like the terrain
    // mega-texture (repeat would bleed the far edge into the near one).
    // Pass { nomip: true } for non-power-of-two canvases (e.g. the fog display
    // canvas): WebGL1 forbids generateMipmap on NPOT — LINEAR + clamp only.
    GLCore.createTextureFromCanvas = (gl, canvas, opts) => {
        const wrap = (opts && opts.clamp) ? gl.CLAMP_TO_EDGE : gl.REPEAT;
        const nomip = !!(opts && opts.nomip);
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
        if (!nomip) gl.generateMipmap(gl.TEXTURE_2D);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, nomip ? gl.LINEAR : gl.LINEAR_MIPMAP_LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
        return tex;
    };

    // Bind a mesh's buffers to a program's standard attributes and draw it.
    // A mesh that is only ever drawn into the shadow map: where its corners are, which bone
    // each hangs on if any, and nothing else. The shadow's program reads no normals and no
    // texture coordinates, and a caster is a second copy of geometry already on the card.
    GLCore.createShadowBuffers = (gl, mesh) => {
        const buf = (target, data) => { const b = gl.createBuffer(); gl.bindBuffer(target, b); gl.bufferData(target, data, gl.STATIC_DRAW); return b; };
        return {
            position: buf(gl.ARRAY_BUFFER, new Float32Array(mesh.positions)),
            bone: mesh.bones ? buf(gl.ARRAY_BUFFER, new Float32Array(mesh.bones)) : null,
            index: buf(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(mesh.indices)),
            count: mesh.indices.length
        };
    };

    // A second set of corners for a mesh that is already on the card: positions of its own,
    // all at one point to begin with, and the first mesh's normals, texture coordinates and
    // indices. For drawing a part of a merged mesh in another pass: whoever does moves that
    // part's corners from the one set to the other (the model's view's ghost nodes).
    GLCore.createTwinBuffers = (gl, buffers, corners) => {
        const position = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, position);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(corners * 3), gl.DYNAMIC_DRAW);
        return { position, normal: buffers.normal, uv: buffers.uv, bone: null, index: buffers.index, count: buffers.count, twin: true };
    };

    // Draws a mesh. With vertex array objects the mesh is pointed at once per program
    // and remembered: a draw is then three calls instead of some ten, which is most of what
    // a draw call costs the page. The array is let go again after every draw, so nothing
    // drawn by hand afterwards (the bloom's quad) can write into a mesh's array.
    GLCore.drawMesh = (gl, program, buffers) => {
        const vao = GLCore.vaoOf(gl);
        // An instanced mesh is drawn once for each of the first `instances` entries of its list.
        const inst = buffers.instance ? GLCore.instancingOf(gl) : null;
        if (buffers.instance && (!inst || !(buffers.instances > 0))) return;
        const go = () => { if (inst) inst.draw(buffers.count, Math.min(buffers.instances, buffers.capacity)); else gl.drawElements(gl.TRIANGLES, buffers.count, gl.UNSIGNED_SHORT, 0); };
        if (!vao) { GLCore.pointMesh(gl, program, buffers); go(); return; }
        let array = buffers.arrays && buffers.arrays.get(program);
        if (array) vao.bind(array);
        else {
            array = vao.create();
            (buffers.arrays || (buffers.arrays = new Map())).set(program, array);
            vao.bind(array);
            GLCore.pointMesh(gl, program, buffers);      // kept by the array, the index buffer included
        }
        go();
        vao.bind(null);
    };

    // Gives a mesh's buffers back to the card, with the arrays that pointed at them.
    GLCore.deleteMeshBuffers = (gl, buffers) => {
        if (!buffers) return;
        const vao = GLCore.vaoOf(gl);
        if (buffers.arrays) { if (vao) for (const a of buffers.arrays.values()) vao.remove(a); buffers.arrays = null; }
        // A list of instances owns its list only: the mesh it places belongs to whoever made it.
        // A twin owns its positions only: the rest is the mesh's it was made beside.
        for (const k of buffers.shared ? ['instance'] : buffers.twin ? ['position'] : ['position', 'normal', 'uv', 'bone', 'index']) if (buffers[k]) gl.deleteBuffer(buffers[k]);
    };

    // Points the program's attributes at a mesh's buffers.
    GLCore.pointMesh = (gl, program, buffers) => {
        gl.bindBuffer(gl.ARRAY_BUFFER, buffers.position);
        gl.enableVertexAttribArray(program.attribs.aPosition);
        gl.vertexAttribPointer(program.attribs.aPosition, 3, gl.FLOAT, false, 0, 0);
        if (program.attribs.aNormal !== undefined) {
            gl.bindBuffer(gl.ARRAY_BUFFER, buffers.normal);
            gl.enableVertexAttribArray(program.attribs.aNormal);
            gl.vertexAttribPointer(program.attribs.aNormal, 3, gl.FLOAT, false, 0, 0);
        }
        if (program.attribs.aUv !== undefined) {
            gl.bindBuffer(gl.ARRAY_BUFFER, buffers.uv);
            gl.enableVertexAttribArray(program.attribs.aUv);
            gl.vertexAttribPointer(program.attribs.aUv, 2, gl.FLOAT, false, 0, 0);
        }
        if (program.attribs.aBone !== undefined) {
            if (buffers.bone) {
                gl.bindBuffer(gl.ARRAY_BUFFER, buffers.bone);
                gl.enableVertexAttribArray(program.attribs.aBone);
                gl.vertexAttribPointer(program.attribs.aBone, 1, gl.FLOAT, false, 0, 0);
            } else gl.disableVertexAttribArray(program.attribs.aBone);   // bone 0 for every vertex: none
        }
        // The list of an instanced mesh: one entry a drawing, not one a corner. A mesh
        // without one says so too -- where there are no vertex arrays the setting is the
        // context's, and would be left over from the grass.
        if (program.attribs.aInstance !== undefined) {
            const inst = GLCore.instancingOf(gl), at = program.attribs.aInstance, colour = program.attribs.aInstanceColor;
            const wide = buffers.stride === 8, bytes = wide ? 32 : 0;
            if (buffers.instance && inst) {
                gl.bindBuffer(gl.ARRAY_BUFFER, buffers.instance);
                gl.enableVertexAttribArray(at);
                gl.vertexAttribPointer(at, 4, gl.FLOAT, false, bytes, 0);
                inst.divisor(at, 1);
            } else { gl.disableVertexAttribArray(at); if (inst) inst.divisor(at, 0); }
            // The second four of a wide list: a particle's colour and how much of it shows.
            if (colour !== undefined) {
                if (buffers.instance && inst && wide) {
                    gl.enableVertexAttribArray(colour);
                    gl.vertexAttribPointer(colour, 4, gl.FLOAT, false, bytes, 16);
                    inst.divisor(colour, 1);
                } else { gl.disableVertexAttribArray(colour); if (inst) inst.divisor(colour, 0); }
            }
        }
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buffers.index);
    };

    window.GLCore = GLCore;
})();
