// Shared shader sources and a WebGL 1 shadow target. No extensions required.
// A separate mask keeps terrain and offshore water shading continuous.
(function () {
    const EngineAtmosphere = {};
    // Seconds of full day, dusk, full night and dawn. Every season totals 720s.
    EngineAtmosphere.daySchedule = theme => theme==='winter' ? [210,90,330,90]
        : theme==='desert' ? [300,60,300,60] : [330,90,210,90];
    EngineAtmosphere.previewTime = (theme,period) => {
        const [day,dusk,night,dawn]=EngineAtmosphere.daySchedule(theme);
        return ({noon:0,dusk:day/2+dusk/2,night:day/2+dusk+night/2,
            dawn:day/2+dusk+night+dawn/2})[period]??0;
    };
    // Twelve unpaused real-time minutes, starting at noon. Cosmetic only; exploration
    // and unit sight never depend on this clock. Remap the existing light curve so
    // its full-day/full-night thresholds land on the exact seasonal boundaries.
    EngineAtmosphere.daylight = (seconds, sun, sky, theme='summer') => {
        const [day,dusk,night,dawn]=EngineAtmosphere.daySchedule(theme);
        const time=((seconds+day/2)%720+720)%720;
        const dayEdge=Math.acos(.35),nightEdge=Math.acos(-.25),tau=Math.PI*2;
        let angle;
        if(time<day)angle=-dayEdge+time/day*2*dayEdge;
        else if(time<day+dusk)angle=dayEdge+(time-day)/dusk*(nightEdge-dayEdge);
        else if(time<day+dusk+night)angle=nightEdge+(time-day-dusk)/night*(tau-2*nightEdge);
        else angle=tau-nightEdge+(time-day-dusk-night)/dawn*(nightEdge-dayEdge);
        const elevation = Math.cos(angle);
        const smooth = (a,b,x) => { const t=Math.max(0,Math.min(1,(x-a)/(b-a))); return t*t*(3-2*t); };
        const daylight = smooth(-0.25,0.35,elevation);
        const warm = (1-smooth(0.05,0.65,Math.abs(elevation))) * daylight;
        const blend = (a,b,t) => a.map((v,i)=>v+(b[i]-v)*t);
        return {
            night: 1-daylight,
            sun: blend([0.18,0.24,0.38],blend(sun,[1.0,0.49,0.24],warm*0.8),daylight),
            sky: blend([0.075,0.105,0.19],blend(sky,[0.67,0.40,0.32],warm*0.6),daylight)
        };
    };
    // Snap in the light's image plane: rounding world X/Z leaves fractional
    // shadow texels after the sun rotation, which makes edges crawl during pans.
    EngineAtmosphere.shadowCamera = (m, target, halfH, size, sun) => {
        const span=Math.max(65,Math.min(300,halfH*2.4)), worldTexel=2*span/size;
        const right=m.normalize(m.cross([0,1,0],sun)), up=m.cross(sun,right);
        const center=[target.x,0,target.z];
        const dx=Math.round(m.dot(right,center)/worldTexel)*worldTexel-m.dot(right,center);
        const dy=Math.round(m.dot(up,center)/worldTexel)*worldTexel-m.dot(up,center);
        const snapped=center.map((v,i)=>v+right[i]*dx+up[i]*dy);
        const eye=snapped.map((v,i)=>v+sun[i]*450);
        return { matrix:m.multiply(m.ortho(-span,span,-span,span,1,1000),m.lookAt(eye,snapped,[0,1,0])),
            right,up,worldTexel,depthPerTexel:worldTexel/999 };
    };
    EngineAtmosphere.vertex = `
        attribute vec3 aPosition, aNormal;
        attribute vec2 aUv;
        uniform mat4 uProj, uView, uModel, uLightMatrix;
        uniform vec2 uUvOffset;
        uniform mediump float uGrassTime, uVegetation;
        uniform vec4 uCloth;
        uniform float uClothTime;
        varying mediump float vGrassTip, vPebble;
        varying vec3 vNormal, vWorld;
        varying vec2 vUv;
        varying float vDepth;
        varying vec4 vShadow;
        void main() {
            vec4 world = uModel * vec4(aPosition, 1.0);
            // Pole edge stays pinned; the ownership badge follows the same fold.
            if(dot(uCloth.zw,uCloth.zw)>.5){
                float along=max(0.0,dot(world.xz-uCloth.xy,uCloth.zw));
                float fold=sin(along*7.0-uClothTime*2.0)*along*.09;
                world.xz+=vec2(-uCloth.w,uCloth.z)*fold;
            }
            vPebble = aUv.x < -0.5 ? 1.0 : 0.0;
            vGrassTip = clamp((aPosition.y-0.018) / 0.562, 0.0, 1.0);
            if (uVegetation > 0.5 && vPebble < 0.5) {
                float gust = sin(world.x*0.17 + world.z*0.11 + uGrassTime*1.3)
                    + 0.45*sin(world.x*0.37 - world.z*0.23 + uGrassTime*2.1);
                world.xz += vec2(0.045,0.025)*gust*vGrassTip*vGrassTip*uModel[1][1];
            }
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
        uniform sampler2D uTex, uShadowMap, uCoast, uGroundDetail;
        uniform sampler2D uClutterVisibility;
        uniform float uClutterMapSize, uClutterFog, uPebbleGround;
        uniform mediump float uVegetation;
        varying mediump float vGrassTip, vPebble;
        uniform vec4 uGroundCover;
        uniform vec3 uSunDir, uSunColor, uAmbient, uTint, uSky, uEye;
        uniform vec4 uLocalLights[3];
        uniform vec3 uShadowRight, uShadowUp;
        uniform float uShadowDepthPerTexel;
        uniform float uUnlit, uAlpha, uTime, uNight, uMaterial, uAtmosphere, uShadowStrength, uShadowTexel;
        uniform vec2 uHaze;
        varying vec3 vNormal, vWorld;
        varying vec2 vUv;
        varying float vDepth;
        varying vec4 vShadow;
        // Bounded arithmetic also works on WebGL 1 mediump implementations.
        float waveHash(vec2 p) {
            p = fract(p * vec2(0.1031,0.11369));
            p += dot(p,p.yx+19.19);
            return fract((p.x+p.y)*p.x);
        }
        // Value and analytic gradient of a smooth, aperiodic wave field.
        vec3 waveField(vec2 p) {
            vec2 i=floor(p), f=fract(p), u=f*f*(3.0-2.0*f);
            vec2 du=6.0*f*(1.0-f);
            float a=waveHash(i), b=waveHash(i+vec2(1.0,0.0));
            float c=waveHash(i+vec2(0.0,1.0)), d=waveHash(i+vec2(1.0));
            return vec3(mix(mix(a,b,u.x),mix(c,d,u.x),u.y),
                mix(b-a,d-c,u.y)*du.x, mix(c-a,d-b,u.x)*du.y);
        }
        float shadowSample(vec2 uv, float depth) {
            vec2 enc = texture2D(uShadowMap, uv).rg;
            return step(depth, dot(enc, vec2(1.0, 1.0 / 255.0)));
        }
        float visibility(vec3 n) {
            if (uShadowStrength <= 0.0) return 1.0;
            vec3 p = vShadow.xyz / vShadow.w * 0.5 + 0.5;
            if (p.x <= 0.01 || p.x >= 0.99 || p.y <= 0.01 || p.y >= 0.99 || p.z <= 0.0 || p.z >= 1.0) return 1.0;
            float ndl = max(dot(n,uSunDir),0.0);
            // Each PCF tap samples a different point on the receiving surface.
            // Compare against that point's plane depth, not the centre depth.
            // A small texel-scaled margin covers packing and curved-normal error.
            vec2 slope = vec2(dot(n,uShadowRight),dot(n,uShadowUp))
                / max(ndl,0.2) * uShadowDepthPerTexel;
            float bias = 2.0/65025.0 + uShadowDepthPerTexel*(0.10+0.35*(1.0-ndl));
            #ifndef GL_FRAGMENT_PRECISION_HIGH
            bias = max(bias,0.001);
            #endif
            vec2 pixel = p.xy/uShadowTexel;
            vec2 base = floor(pixel)+0.5;
            float lit = 0.0, weightSum = 0.0;
            for (int y = -1; y <= 1; y++) {
                for (int x = -1; x <= 1; x++) {
                    vec2 delta = base+vec2(float(x),float(y))-pixel;
                    // Tent weights soften texel transitions without extra lookups.
                    vec2 weights = max(vec2(0.0),vec2(1.5)-abs(delta));
                    float weight = weights.x*weights.y;
                    lit += weight*shadowSample((base+vec2(float(x),float(y)))*uShadowTexel,
                        p.z+dot(slope,delta)-bias);
                    weightSum += weight;
                }
            }
            float edge = smoothstep(0.01,0.08,min(min(p.x,p.y),min(1.0-p.x,1.0-p.y)));
            return mix(1.0, lit/weightSum, uShadowStrength*edge);
        }
        void main() {
            if (uVegetation > 0.5 && uClutterFog > 0.5) {
                vec2 fogUv = vWorld.xz / uClutterMapSize + 0.5;
                if (min(fogUv.x,fogUv.y) < 0.0 || max(fogUv.x,fogUv.y) > 1.0
                    || texture2D(uClutterVisibility,fogUv).r < 0.99) discard;
            }
            vec4 t = texture2D(uTex, vUv);
            vec3 base = t.rgb * uTint;
            if (uVegetation > 0.5) base *= mix(0.90,1.06,vGrassTip);
            if (uVegetation > 0.5 && vPebble > 0.5) base = mix(vec3(.19,.175,.15),vec3(.32,.30,.265),vUv.y);
            vec3 n = normalize(vNormal);
            vec3 eye = normalize(uEye-vWorld);
            float water = uMaterial > 1.5 && uMaterial < 2.5 ? 1.0
                : (uMaterial > 0.5 && uMaterial < 1.5 ? texture2D(uCoast,vUv).r : 0.0);
            if (uMaterial > 0.5 && uMaterial < 1.5) {
                // Mipmapped detail lives in world metres, so close-up ground no
                // longer magnifies a single map texel into a smooth colour blob.
                // A second rotated scale breaks repetition; fade it in overview
                // shots and underwater rather than producing distant shimmer.
                vec2 a=texture2D(uGroundDetail,vWorld.xz/16.0).rg-vec2(0.502);
                vec2 b=texture2D(uGroundDetail,mat2(0.8,0.6,-0.6,0.8)*vWorld.xz/39.0).rg-vec2(0.502);
                float cover=clamp(dot(vec4(base,1.0),uGroundCover),0.0,1.0);
                float grain=mix(a.g, a.r, cover)*0.85+mix(b.g,b.r,cover)*0.35;
                float nearDetail=1.0-smoothstep(120.0,320.0,distance(uEye,vWorld));
                base*=1.0+grain*nearDetail*(1.0-water);
                float patch=clamp((.5+.28*sin(vWorld.x*.047+vWorld.z*.023)+.22*sin(vWorld.z*.061-vWorld.x*.019)-.3)/.4,0.0,1.0);
                float gravel=texture2D(uGroundDetail,vWorld.xz/16.0).b;
                float dry=1.0-smoothstep(.45,.9,cover);
                base=mix(base,base*.56,gravel*dry*patch*(1.0-water)*uPebbleGround);
            }
            float sun = max(dot(n,uSunDir),0.0);
            vec3 legacy = base*(uAmbient + uSunColor*sun);
            // Cool sky fill against warm sun; material colour remains legible in shade.
            vec3 skyFill = mix(vec3(0.21,0.22,0.19),vec3(0.44,0.49,0.54), n.y*0.5+0.5);
            skyFill *= mix(vec3(1.0),vec3(0.40,0.49,0.66),uNight);
            vec3 light = skyFill + uSunColor*sun*visibility(n);
            vec3 col = base*light;
            // One nearby entrance lamp per building, without extra light/shadow passes.
            for(int i=0;i<3;i++){
              vec4 localLight=uLocalLights[i];
              if(localLight.w>0.0){
                vec3 delta=localLight.xyz-vWorld;
                float d2=dot(delta,delta);
                float facing=max(0.0,dot(n,delta*inversesqrt(max(.01,d2))));
                vec3 glow=base*vec3(1.0,.46,.12)*facing*localLight.w*1.8/(1.0+d2*1.7);
                col+=glow;legacy+=glow;
              }
            }
            if (uMaterial > 2.5 && uMaterial < 3.5) {
                // Broad polished highlight plus sky rim; silver stays silver.
                vec3 specTint=mix(vec3(1.0),base,0.3);
                float spec=pow(max(dot(n,normalize(eye+uSunDir)),0.0),48.0);
                float rim=pow(1.0-max(dot(n,eye),0.0),4.0);
                col += specTint*uSunColor*spec*0.85 + uSky*rim*0.22;
            }
            if (water > 0.01) {
                // World coordinates keep offshore and coastal waves continuous.
                // Both scales ride the same current instead of fighting each
                // other. Spatial rotation still keeps the surface irregular.
                vec2 p = vWorld.xz - vec2(0.56,-0.28)*uTime;
                vec3 swell=waveField(p*0.032);
                mat2 turn=mat2(0.8,0.6,-0.6,0.8);
                vec3 chop=waveField(turn*p*0.11);
                // Suppress fine slopes in distant/overview shots; no glitter aliasing.
                float detail=1.0-smoothstep(100.0,550.0,distance(uEye,vWorld));
                vec2 grad=swell.yz*0.13 + vec2(dot(turn[0],chop.yz),dot(turn[1],chop.yz))*0.075*detail;
                vec3 wn=normalize(vec3(-grad.x,1.0,-grad.y));
                float fresnel=0.035+0.965*pow(1.0-max(dot(eye,wn),0.0),5.0);
                float glint=pow(max(dot(wn,normalize(eye+uSunDir)),0.0),48.0);
                vec3 sea=mix(base*vec3(0.72,0.96,1.02)*mix(vec3(1.0),vec3(0.38,0.48,0.65),uNight),uSky*0.72,fresnel*0.8);
                sea += uSunColor*glint*0.42;
                sea *= 0.98+swell.x*0.04;
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
            // The far plane must not wrap back to encoded zero.
            #ifdef GL_FRAGMENT_PRECISION_HIGH
            float depth = min(gl_FragCoord.z,1.0-1.0/65025.0);
            #else
            float depth = min(gl_FragCoord.z,1.0-1.0/1024.0);
            #endif
            vec2 enc = fract(depth*vec2(1.0,255.0));
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
