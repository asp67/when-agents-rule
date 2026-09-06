// Shared shader sources and a WebGL 1 shadow target. No extensions required.
// A separate mask keeps terrain and offshore water shading continuous.
(function () {
    const EngineAtmosphere = {};
    EngineAtmosphere.vertex = `
        attribute vec3 aPosition, aNormal;
        attribute vec2 aUv;
        uniform mat4 uProj, uView, uModel, uLightMatrix;
        uniform vec2 uUvOffset;
        varying vec3 vNormal, vWorld;
        varying vec2 vUv;
        varying float vDepth;
        varying vec4 vShadow;
        void main() {
            vec4 world = uModel * vec4(aPosition, 1.0);
            // Inverse-transpose for orthogonal TRS columns, including nonuniform scale.
            mat3 basis = mat3(uModel);
            vec3 scale2 = vec3(dot(basis[0],basis[0]), dot(basis[1],basis[1]), dot(basis[2],basis[2]));
            vNormal = basis * (aNormal / max(scale2, vec3(0.00001)));
            vWorld = world.xyz;
            vUv = aUv + uUvOffset;
            vec4 vp = uView * world;
            vDepth = -vp.z;
            vShadow = uLightMatrix * world;
            gl_Position = uProj * vp;
        }`;
    EngineAtmosphere.fragment = `
        #ifdef GL_FRAGMENT_PRECISION_HIGH
        precision highp float;
        #else
        precision mediump float;
        #endif
        uniform sampler2D uTex, uShadowMap, uCoast;
        uniform vec3 uSunDir, uSunColor, uAmbient, uTint, uSky, uEye;
        uniform float uUnlit, uAlpha, uTime, uMaterial, uAtmosphere, uShadowStrength, uShadowTexel;
        uniform vec2 uHaze;
        varying vec3 vNormal, vWorld;
        varying vec2 vUv;
        varying float vDepth;
        varying vec4 vShadow;
        float shadowSample(vec2 uv, float depth) {
            vec2 enc = texture2D(uShadowMap, uv).rg;
            return step(depth, dot(enc, vec2(1.0, 1.0 / 255.0)));
        }
        float visibility(vec3 n) {
            if (uShadowStrength <= 0.0) return 1.0;
            vec3 p = vShadow.xyz / vShadow.w * 0.5 + 0.5;
            if (p.x <= 0.01 || p.x >= 0.99 || p.y <= 0.01 || p.y >= 0.99 || p.z <= 0.0 || p.z >= 1.0) return 1.0;
            float bias = max(0.00015, 0.0007 * (1.0 - max(dot(n,uSunDir),0.0)));
            float lit = 0.0;
            for (int y = -1; y <= 1; y++) {
                for (int x = -1; x <= 1; x++) {
                    lit += shadowSample(p.xy + vec2(float(x),float(y))*uShadowTexel, p.z-bias);
                }
            }
            float edge = smoothstep(0.01,0.08,min(min(p.x,p.y),min(1.0-p.x,1.0-p.y)));
            return mix(1.0, lit/9.0, uShadowStrength*edge);
        }
        void main() {
            vec4 t = texture2D(uTex, vUv);
            vec3 base = t.rgb * uTint;
            vec3 n = normalize(vNormal);
            vec3 eye = normalize(uEye-vWorld);
            float water = uMaterial > 1.5 && uMaterial < 2.5 ? 1.0
                : (uMaterial > 0.5 && uMaterial < 1.5 ? texture2D(uCoast,vUv).r : 0.0);
            float sun = max(dot(n,uSunDir),0.0);
            vec3 legacy = base*(uAmbient + uSunColor*sun);
            // Cool sky fill against warm sun; material colour remains legible in shade.
            vec3 skyFill = mix(vec3(0.21,0.22,0.19),vec3(0.44,0.49,0.54), n.y*0.5+0.5);
            vec3 light = skyFill + uSunColor*sun*visibility(n);
            vec3 col = base*light;
            if (uMaterial > 2.5 && uMaterial < 3.5) {
                col += vec3(0.70,0.58,0.37)*pow(max(dot(n,normalize(eye+uSunDir)),0.0),40.0)*0.32;
            }
            if (water > 0.01) {
                // World coordinates keep offshore and coastal waves continuous.
                vec2 p = vWorld.xz;
                float a = p.x*0.20+p.y*0.13+uTime*0.65;
                float b = p.x*-0.11+p.y*0.25-uTime*0.43;
                vec3 wn = normalize(vec3(cos(a)*0.16+cos(b)*0.10,1.0,sin(a)*0.12+sin(b)*0.16));
                float fresnel = pow(1.0-max(dot(eye,wn),0.0),3.0);
                float glint = pow(max(dot(wn,normalize(eye+uSunDir)),0.0),90.0);
                vec3 sea = mix(base*vec3(0.66,0.94,1.03),uSky*0.82,fresnel*0.65);
                sea += vec3(1.0,0.86,0.63)*glint*0.65;
                sea += vec3(0.018,0.035,0.034)*sin(a+b);
                col = mix(col,sea,water);
            }
            // A mild shoulder preserves bright plaster without bleaching the scene.
            col = col/(vec3(1.0)+col*0.16)*1.12;
            col = mix(legacy,col,uAtmosphere);
            col = mix(col,base,uUnlit);
            float haze = clamp((vDepth-uHaze.x)/max(1.0,uHaze.y-uHaze.x),0.0,1.0);
            float alpha = uMaterial > 0.5 && uMaterial < 2.5 ? 1.0 : t.a;
            gl_FragColor = vec4(mix(col,uSky,haze),alpha*uAlpha);
        }`;
    EngineAtmosphere.shadowVertex = `
        attribute vec3 aPosition;
        uniform mat4 uLightMatrix, uModel;
        void main() { gl_Position = uLightMatrix*uModel*vec4(aPosition,1.0); }`;
    EngineAtmosphere.shadowFragment = `
        #ifdef GL_FRAGMENT_PRECISION_HIGH
        precision highp float;
        #else
        precision mediump float;
        #endif
        void main() {
            vec2 enc = fract(gl_FragCoord.z*vec2(1.0,255.0));
            enc.x -= enc.y/255.0;
            gl_FragColor = vec4(enc,0.0,1.0);
        }`;
    EngineAtmosphere.createShadowTarget = (gl, size) => {
        const texture = gl.createTexture(), depth = gl.createRenderbuffer(), framebuffer = gl.createFramebuffer();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,size,size,0,gl.RGBA,gl.UNSIGNED_BYTE,null);
        gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
        gl.bindRenderbuffer(gl.RENDERBUFFER,depth);
        gl.renderbufferStorage(gl.RENDERBUFFER,gl.DEPTH_COMPONENT16,size,size);
        gl.bindFramebuffer(gl.FRAMEBUFFER,framebuffer);
        gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,texture,0);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER,gl.DEPTH_ATTACHMENT,gl.RENDERBUFFER,depth);
        const ready = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
        gl.bindFramebuffer(gl.FRAMEBUFFER,null);
        gl.bindRenderbuffer(gl.RENDERBUFFER,null);
        const target = { texture, depth, framebuffer, size };
        if (!ready) { EngineAtmosphere.disposeShadowTarget(gl,target); return null; }
        return target;
    };
    EngineAtmosphere.disposeShadowTarget = (gl, target) => {
        if (!target) return;
        gl.deleteTexture(target.texture); gl.deleteRenderbuffer(target.depth); gl.deleteFramebuffer(target.framebuffer);
    };
    window.EngineAtmosphere = EngineAtmosphere;
})();
