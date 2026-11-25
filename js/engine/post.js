// EnginePost -- the scene drawn into a picture of its own, then put on the canvas
// (overhaul step A10). Presentation only.
//
// Without it the scene is drawn straight into the canvas, and that stays the way
// whenever nothing here is wanted. It is wanted in two cases:
//
//   a smaller scene   When the quality governor takes resolution off, the canvas used to
//                     shrink and the browser stretched it back, blurring everything on it
//                     alike. Now the canvas keeps its size: the scene is drawn smaller
//                     into the target here, brought up to the canvas with a sharpening
//                     filter, and what is drawn after it (health bars, banners) is drawn
//                     at the canvas's own resolution.
//   focus             A close-up can blur toward the top and bottom of the picture, as a
//                     lens does over a model landscape (EngineRenderer.tiltShift).
//
// The bloom then reads this picture instead of copying the finished frame.
//
// WebGL 2 only: the target is multisampled, as the canvas is, and a multisampled target
// needs renderbufferStorageMultisample and blitFramebuffer. create() answers null on
// WebGL 1, and the renderer then draws as it always has.
(function () {
    const VERT = `
        attribute vec2 aPos;
        varying vec2 vUv;
        void main() { vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;
    // uTexel   one texel of the scene, in uv
    // uSharpen how much of the difference from its four neighbours a texel is pushed by
    // uFocus   x: the line of the picture that is sharp (uv.y), y: half the height of the
    //          sharp band, z: the blur at the picture's edge in scene texels, w: 0 = off
    const FRAG = `
        precision mediump float;
        uniform sampler2D uSrc;
        uniform vec2 uTexel;
        uniform float uSharpen;
        uniform vec4 uFocus;
        uniform float uVignette;
        varying vec2 vUv;
        void main() {
            // The scene's own alpha goes to the canvas with it: drawn straight into the
            // canvas, a blended part leaves the alpha it leaves, and the page shows through
            // the same amount either way.
            vec4 here = texture2D(uSrc, vUv);
            vec3 c = here.rgb;
            float soft = 0.0;
            if (uFocus.w > 0.5) {
                float away = max(0.0, abs(vUv.y - uFocus.x) - uFocus.y) / max(0.001, 0.5 - uFocus.y);
                soft = min(1.0, away);
                vec2 r = uTexel * uFocus.z * soft * soft;
                if (soft > 0.0) {
                    // Eight taps on two rings: enough for a blur of a few texels.
                    vec3 s = c * 2.0;
                    s += texture2D(uSrc, vUv + r * vec2( 1.0,  0.0)).rgb + texture2D(uSrc, vUv + r * vec2(-1.0,  0.0)).rgb;
                    s += texture2D(uSrc, vUv + r * vec2( 0.0,  1.0)).rgb + texture2D(uSrc, vUv + r * vec2( 0.0, -1.0)).rgb;
                    s += texture2D(uSrc, vUv + r * vec2( 0.6,  0.6)).rgb + texture2D(uSrc, vUv + r * vec2(-0.6,  0.6)).rgb;
                    s += texture2D(uSrc, vUv + r * vec2( 0.6, -0.6)).rgb + texture2D(uSrc, vUv + r * vec2(-0.6, -0.6)).rgb;
                    c = s * 0.1;
                }
            }
            float k = uSharpen * (1.0 - soft);
            if (k > 0.0) {
                vec3 n = texture2D(uSrc, vUv + vec2(uTexel.x, 0.0)).rgb + texture2D(uSrc, vUv - vec2(uTexel.x, 0.0)).rgb
                       + texture2D(uSrc, vUv + vec2(0.0, uTexel.y)).rgb + texture2D(uSrc, vUv - vec2(0.0, uTexel.y)).rgb;
                // Never past what the neighbourhood holds: an edge is made crisper, not ringed.
                vec3 lo = min(c, n * 0.25) * 0.85, hi = max(c, n * 0.25) * 1.15 + 0.02;
                c = clamp(c + (c * 4.0 - n) * k, lo, hi);
            }
            if (uVignette > 0.0) {
                vec2 d = vUv - 0.5;
                c *= 1.0 - uVignette * smoothstep(0.18, 0.56, dot(d, d));
            }
            gl_FragColor = vec4(clamp(c, 0.0, 1.0), here.a);
        }`;

    const EnginePost = {
        // How strongly a scene drawn smaller than the canvas is sharpened on its way up.
        // Nothing at full size: a picture that was not stretched needs no repair.
        SHARPEN: 0.22,
        SAMPLES: 4,
        supported(gl) {
            return !!(gl && gl.warVersion === 2 && gl.renderbufferStorageMultisample && gl.blitFramebuffer);
        },
        create(gl) {
            if (!EnginePost.supported(gl)) return null;
            let prog;
            try { prog = GLCore.compileProgram(gl, VERT, FRAG); } catch (e) { return null; }
            const quad = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, quad);
            gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
            let size = null, drawFb = null, colour = null, depth = null, readFb = null, tex = null;
            const release = () => {
                if (drawFb) gl.deleteFramebuffer(drawFb);
                if (readFb) gl.deleteFramebuffer(readFb);
                if (colour) gl.deleteRenderbuffer(colour);
                if (depth) gl.deleteRenderbuffer(depth);
                if (tex) gl.deleteTexture(tex);
                size = drawFb = readFb = colour = depth = tex = null;
            };
            const build = (w, h) => {
                release();
                const samples = Math.max(1, Math.min(EnginePost.SAMPLES, gl.getParameter(gl.MAX_SAMPLES) || 1));
                colour = gl.createRenderbuffer();
                gl.bindRenderbuffer(gl.RENDERBUFFER, colour);
                gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.RGBA8, w, h);
                depth = gl.createRenderbuffer();
                gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
                gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.DEPTH_COMPONENT24, w, h);
                gl.bindRenderbuffer(gl.RENDERBUFFER, null);
                drawFb = gl.createFramebuffer();
                gl.bindFramebuffer(gl.FRAMEBUFFER, drawFb);
                gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, colour);
                gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
                const drawOk = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
                tex = gl.createTexture();
                gl.bindTexture(gl.TEXTURE_2D, tex);
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
                readFb = gl.createFramebuffer();
                gl.bindFramebuffer(gl.FRAMEBUFFER, readFb);
                gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
                const readOk = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
                gl.bindFramebuffer(gl.FRAMEBUFFER, null);
                if (!drawOk || !readOk) { release(); return false; }
                size = [w, h];
                return true;
            };
            return {
                // The scene of this frame goes into a target of w x h: bound, and the
                // viewport set. false when the card would not make one (the caller then
                // draws into the canvas as before).
                begin(w, h) {
                    if (!(w > 0 && h > 0)) return false;
                    if ((!size || size[0] !== w || size[1] !== h) && !build(w, h)) return false;
                    gl.bindFramebuffer(gl.FRAMEBUFFER, drawFb);
                    gl.viewport(0, 0, w, h);
                    return true;
                },
                // The scene as a texture (its samples resolved), and onto the canvas of
                // W x H. Leaves the canvas bound with its whole viewport, blending off and
                // depth testing on; the caller restores its program.
                // opts: { sharpen, focus: [line, halfBand, texels] | null }
                present(W, H, opts) {
                    const o = opts || {}, w = size[0], h = size[1];
                    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, drawFb);
                    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, readFb);
                    gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
                    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
                    gl.viewport(0, 0, W, H);
                    const cull = gl.isEnabled(gl.CULL_FACE);
                    gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE); gl.depthMask(false);
                    gl.useProgram(prog);
                    gl.activeTexture(gl.TEXTURE0);
                    gl.bindTexture(gl.TEXTURE_2D, tex);
                    gl.uniform1i(prog.uniforms.uSrc, 0);
                    gl.uniform2f(prog.uniforms.uTexel, 1 / w, 1 / h);
                    gl.uniform1f(prog.uniforms.uSharpen, o.sharpen > 0 ? o.sharpen : 0);
                    if (o.vignette != null && prog.uniforms.uVignette) gl.uniform1f(prog.uniforms.uVignette, o.vignette > 0 ? o.vignette : 0);
                    const f = o.focus;
                    gl.uniform4f(prog.uniforms.uFocus, f ? f[0] : 0.5, f ? f[1] : 0.5, f ? f[2] : 0, f ? 1 : 0);
                    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
                    gl.enableVertexAttribArray(prog.attribs.aPos);
                    gl.vertexAttribPointer(prog.attribs.aPos, 2, gl.FLOAT, false, 0, 0);
                    gl.drawArrays(gl.TRIANGLES, 0, 3);
                    gl.disableVertexAttribArray(prog.attribs.aPos);
                    gl.enable(gl.DEPTH_TEST);
                    if (cull) gl.enable(gl.CULL_FACE);
                },
                // What present() resolved: { tex, w, h }, for the bloom to read.
                get scene() { return size ? { tex, w: size[0], h: size[1] } : null; },
                get size() { return size; },
                dispose() { release(); gl.deleteBuffer(quad); },
            };
        },
    };
    window.EnginePost = EnginePost;
})();
