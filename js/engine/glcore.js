// GLCore — raw WebGL plumbing for the in-house engine: context creation,
// shader compilation, mesh buffers, canvas-painted textures and draw calls.
// Deliberately tiny: exactly what the game needs, nothing speculative.
(function () {
    const GLCore = {};

    GLCore.createContext = (canvas, opts) => {
        const gl = canvas.getContext('webgl', Object.assign({ antialias: true }, opts || {}));
        if (!gl) throw new Error('WebGL not available');
        gl.enable(gl.DEPTH_TEST);
        // Back-face culling is ON since the M2 winding audit: every builder's
        // triangle winding provably agrees with its outward normals
        // (EngineMesh.auditWinding returns 0 for the whole library).
        gl.enable(gl.CULL_FACE);
        gl.cullFace(gl.BACK);
        return gl;
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
    GLCore.drawMesh = (gl, program, buffers) => {
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
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buffers.index);
        gl.drawElements(gl.TRIANGLES, buffers.count, gl.UNSIGNED_SHORT, 0);
    };

    window.GLCore = GLCore;
})();
