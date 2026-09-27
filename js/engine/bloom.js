// EngineBloom -- a minimal bloom for the Cinematic lighting style (review #12).
//
// Presentation only. The frame is drawn exactly as before, into the canvas and with its
// antialiasing; then that finished image is copied into a texture (copyTexSubImage2D
// resolves the multisampled buffer, so nothing loses its smoothing), its brightest parts
// are kept at a quarter of the resolution, blurred twice, and added back over the frame.
// Fires, lamps and sunlit stone gain a soft halo; nothing else changes.
//
// WebGL 1: non-power-of-two textures with CLAMP and LINEAR only, no mipmaps.
(function () {
    const VERT = `
        attribute vec2 aPos;
        varying vec2 vUv;
        void main() { vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;
    // Four taps per output texel: the quarter-size target sees every source pixel's
    // neighbourhood rather than one pixel in sixteen, which would shimmer as the camera moves.
    const BRIGHT = `
        precision mediump float;
        uniform sampler2D uSrc;
        uniform vec2 uTexel;
        uniform float uThreshold, uKnee;
        varying vec2 vUv;
        vec3 pick(vec2 o) {
            vec3 c = texture2D(uSrc, vUv + o * uTexel).rgb;
            float l = max(c.r, max(c.g, c.b));
            return c * smoothstep(uThreshold, uThreshold + uKnee, l);
        }
        void main() {
            vec3 c = pick(vec2(-1.0, -1.0)) + pick(vec2(1.0, -1.0)) + pick(vec2(-1.0, 1.0)) + pick(vec2(1.0, 1.0));
            gl_FragColor = vec4(c * 0.25, 1.0);
        }`;
    const BLUR = `
        precision mediump float;
        uniform sampler2D uSrc;
        uniform vec2 uDir;
        varying vec2 vUv;
        void main() {
            vec3 c = texture2D(uSrc, vUv).rgb * 0.227027;
            c += texture2D(uSrc, vUv + uDir * 1.384615).rgb * 0.316216;
            c += texture2D(uSrc, vUv - uDir * 1.384615).rgb * 0.316216;
            c += texture2D(uSrc, vUv + uDir * 3.230769).rgb * 0.070270;
            c += texture2D(uSrc, vUv - uDir * 3.230769).rgb * 0.070270;
            gl_FragColor = vec4(c, 1.0);
        }`;
    const ADD = `
        precision mediump float;
        uniform sampler2D uSrc;
        uniform float uStrength;
        varying vec2 vUv;
        void main() { gl_FragColor = vec4(texture2D(uSrc, vUv).rgb * uStrength, 1.0); }`;

    function texture(gl, w, h) {
        const t = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        return t;
    }
    function target(gl, w, h) {
        const tex = texture(gl, w, h), fb = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        return ok ? { tex, fb, w, h } : null;
    }

    const EngineBloom = {
        // The threshold sits high: bloom is for light sources and the sun on pale stone,
        // not for every lit wall. Strength is set per frame by the caller (more at night).
        THRESHOLD: 0.78, KNEE: 0.18,

        create(gl) {
            let progs;
            try {
                progs = {
                    bright: GLCore.compileProgram(gl, VERT, BRIGHT),
                    blur: GLCore.compileProgram(gl, VERT, BLUR),
                    add: GLCore.compileProgram(gl, VERT, ADD),
                };
            } catch (e) { return null; }   // a driver that cannot: the frame stays as it was
            const quad = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, quad);
            gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
            let size = null, scene = null, a = null, b = null;
            const draw = (prog) => {
                gl.bindBuffer(gl.ARRAY_BUFFER, quad);
                gl.enableVertexAttribArray(prog.attribs.aPos);
                gl.vertexAttribPointer(prog.attribs.aPos, 2, gl.FLOAT, false, 0, 0);
                gl.drawArrays(gl.TRIANGLES, 0, 6);
            };
            const release = () => {
                if (scene) gl.deleteTexture(scene);
                for (const t of [a, b]) if (t) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fb); }
                scene = a = b = null; size = null;
            };
            return {
                // Add the bloom of what is on screen now. Leaves the default framebuffer
                // bound, blending off and depth testing on; the caller restores its program.
                apply(W, H, strength) {
                    if (!(strength > 0) || W < 8 || H < 8) return false;
                    if (!size || size[0] !== W || size[1] !== H) {
                        release();
                        const qw = Math.max(1, W >> 2), qh = Math.max(1, H >> 2);
                        scene = texture(gl, W, H); a = target(gl, qw, qh); b = target(gl, qw, qh);
                        if (!a || !b) { release(); return false; }
                        size = [W, H];
                    }
                    const cull = gl.isEnabled(gl.CULL_FACE);
                    gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE); gl.depthMask(false);
                    gl.activeTexture(gl.TEXTURE0);
                    // The finished frame, antialiasing resolved.
                    gl.bindTexture(gl.TEXTURE_2D, scene);
                    gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, W, H);
                    // Bright parts at a quarter of the size.
                    gl.bindFramebuffer(gl.FRAMEBUFFER, a.fb);
                    gl.viewport(0, 0, a.w, a.h);
                    gl.useProgram(progs.bright);
                    gl.uniform1i(progs.bright.uniforms.uSrc, 0);
                    gl.uniform2f(progs.bright.uniforms.uTexel, 1 / W, 1 / H);
                    gl.uniform1f(progs.bright.uniforms.uThreshold, EngineBloom.THRESHOLD);
                    gl.uniform1f(progs.bright.uniforms.uKnee, EngineBloom.KNEE);
                    draw(progs.bright);
                    // Blurred, twice each way.
                    gl.useProgram(progs.blur);
                    gl.uniform1i(progs.blur.uniforms.uSrc, 0);
                    for (let pass = 0; pass < 2; pass++) {
                        gl.bindFramebuffer(gl.FRAMEBUFFER, b.fb);
                        gl.bindTexture(gl.TEXTURE_2D, a.tex);
                        gl.uniform2f(progs.blur.uniforms.uDir, 1 / a.w, 0);
                        draw(progs.blur);
                        gl.bindFramebuffer(gl.FRAMEBUFFER, a.fb);
                        gl.bindTexture(gl.TEXTURE_2D, b.tex);
                        gl.uniform2f(progs.blur.uniforms.uDir, 0, 1 / a.h);
                        draw(progs.blur);
                    }
                    // Added back over the frame.
                    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
                    gl.viewport(0, 0, W, H);
                    gl.enable(gl.BLEND);
                    gl.blendFunc(gl.ONE, gl.ONE);
                    gl.useProgram(progs.add);
                    gl.uniform1i(progs.add.uniforms.uSrc, 0);
                    gl.uniform1f(progs.add.uniforms.uStrength, strength);
                    gl.bindTexture(gl.TEXTURE_2D, a.tex);
                    draw(progs.add);
                    gl.disable(gl.BLEND);
                    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
                    gl.enable(gl.DEPTH_TEST);
                    if (cull) gl.enable(gl.CULL_FACE);
                    gl.disableVertexAttribArray(progs.add.attribs.aPos);
                    return true;
                },
                dispose() { release(); },
            };
        },
    };
    window.EngineBloom = EngineBloom;
})();
