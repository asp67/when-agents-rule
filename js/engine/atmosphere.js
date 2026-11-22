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
    // Atmospheric lighting adds its light up in linear space (overhaul step A1). These
    // are the amounts; the display curve is a square root in the shader, so a colour here
    // is the square of the colour it looks like.
    EngineAtmosphere.LIGHT = {
        // By day the key light is not chosen, it is solved for: full sun on flat ground
        // must come to the colour it had before, the sky's fill of that time plus the
        // theme's sun at this height. Every ground palette was painted against that, and
        // squaring a warm sun instead turned desert sand orange.
        skyUp: [0.44, 0.49, 0.54], sunUp: 0.696,
        moonGain: 4.6,                      // at night: the night's light squared, times this. A moon that models shapes
        fillSky: 0.55, fillFloor: 0.03,     // how much of the sky's colour comes down as fill, and a floor under it
        nightFill: [0.04, 0.065, 0.13],     // what a clear night adds, so shade is dark blue and not black
        bounce: 0.10,                       // how much of the key light the ground sends back up
        fillLow: 0.25,                      // how much of the sky fill reaches a face that looks down
        ground: { summer: [0.55, 0.70, 0.35], desert: [0.90, 0.75, 0.50], winter: [0.85, 0.90, 1.0] },
        duskKey: [0.16, 0.0, -0.08],        // the low sun: more red, less blue, at its most halfway to night
        duskGain: [0.02, 0.0, -0.02],       // the grade of that hour
        saturation: 1.12, nightSaturation: 0.92, duskSaturation: 0.08,
        rim: 1.6, nightRim: 3.2             // sky light on an edge turned away: what lifts a figure off dark ground
    };
    // The air between the eye and what it looks at (overhaul step A8). What lies beyond
    // the point the camera looks at takes on the air's colour, more the farther it is:
    // none at that point, amount at most, rate = how fast it gets there (of the amount,
    // 1 - exp(-rate x how many times farther)). The colour is the hour's sky lifted
    // toward tone by lift; at night there is less of it and it is the night's own blue.
    // Measured against the look-at distance, not in world units, so the whole-map view
    // is not a wall of haze and a low shot across a town still has depth.
    EngineAtmosphere.AIR = { amount: 0.34, nightAmount: 0.26, rate: 0.75, lift: 0.52, nightLift: 0.10, tone: [0.80, 0.86, 0.93] };
    EngineAtmosphere.air = (day) => {
        const A=EngineAtmosphere.AIR, n=day.night, lift=A.lift+(A.nightLift-A.lift)*n;
        return [0,1,2].map(i=>day.sky[i]+(A.tone[i]-day.sky[i])*lift).concat(A.amount+(A.nightAmount-A.amount)*n);
    };
    // Where the light stands by the hour (a candidate, renderer.movingSun). The sun was
    // never in the picture and never moved, so every shadow lay the same way all day.
    // It still is not in the picture, but it can travel: swing degrees to either side of
    // where it has always stood, which it passes at noon, and down to low degrees above
    // the horizon at the day's two ends. The moon travels the same way back by night, so
    // the light never jumps: at dusk and at dawn it stands still while one hands over to
    // the other. low is kept well up, or shadows would run out of the shadow map.
    // comp: how far the key light is raised as the light sinks, so that open ground does
    // not go dark with it (0 = not at all, 1 = flat ground keeps its noon brightness).
    EngineAtmosphere.SUN = { swing: 52, low: 27, comp: 0.6 };
    // -1 at the start of the day, 0 at noon, +1 at its end; back to -1 through the night.
    EngineAtmosphere.sunPhase = (seconds, theme='summer') => {
        const [day,dusk,night]=EngineAtmosphere.daySchedule(theme);
        const time=((seconds+day/2)%720+720)%720;
        if(time<day)return time/day*2-1;
        if(time<day+dusk)return 1;
        if(time<day+dusk+night)return 1-(time-day-dusk)/night*2;
        return -1;
    };
    EngineAtmosphere.sunDirection = (rest, phase) => {
        const S=EngineAtmosphere.SUN, rad=Math.PI/180, length=Math.hypot(rest[0],rest[1],rest[2])||1;
        const azimuth=Math.atan2(rest[2],rest[0])+phase*S.swing*rad;
        const high=Math.asin(rest[1]/length), low=Math.min(high,S.low*rad);
        const elevation=low+(high-low)*Math.cos(phase*Math.PI/2);
        return [Math.cos(elevation)*Math.cos(azimuth),Math.sin(elevation),Math.cos(elevation)*Math.sin(azimuth)];
    };
    // daylight() and, from it, what the Atmospheric shader is given: the key light (sun
    // or moon), the fill from above and from below, the grade (gain per channel, then
    // saturation) and the strength of the rim.
    // lower: how many times lower the light stands than at noon (noon's height over this
    // hour's), where it moves; left out, it stands where it always has.
    EngineAtmosphere.lighting = (seconds, sun, sky, theme='summer', lower=1) => {
        const L=EngineAtmosphere.LIGHT, day=EngineAtmosphere.daylight(seconds,sun,sky,theme);
        const sunk=lower>1?Math.pow(lower,EngineAtmosphere.SUN.comp):1;
        const n=day.night, dusk=4*n*(1-n), ground=L.ground[theme]||L.ground.summer;
        const fillHigh=day.sky.map((v,i)=>v*v*L.fillSky+L.fillFloor+n*L.nightFill[i]);
        const key=day.sun.map((v,i)=>{
            const sunlit=L.skyUp[i]+v*L.sunUp;                           // flat ground in full sun, as it looked
            const byDay=Math.max(0,(sunlit*sunlit-fillHigh[i])/L.sunUp), byNight=v*v*L.moonGain;
            return (byDay+(byNight-byDay)*n)*(1+dusk*L.duskKey[i])*sunk;
        });
        const fillLow=key.map((v,i)=>v*ground[i]*L.bounce+fillHigh[i]*L.fillLow);
        return { night:n, sun:day.sun, sky:day.sky, key, fillHigh, fillLow, air:EngineAtmosphere.air(day), airRate:EngineAtmosphere.AIR.rate,
            grade:[1+dusk*L.duskGain[0],1+dusk*L.duskGain[1],1+dusk*L.duskGain[2],
                L.saturation+(L.nightSaturation-L.saturation)*n+dusk*L.duskSaturation],
            rim:L.rim+(L.nightRim-L.rim)*n };
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
        attribute float aBone;
        // An instanced mesh (the grass, overhaul step A6): the same tuft drawn once for each
        // entry of a list, and this is the entry: x, z, and its size times the cosine and
        // the sine of its turn (no angle to work out for each corner). uInstanced says
        // whether the mesh being drawn has such a list; uInstanceWorld is the width of the
        // ground's colour map, which a tuft takes its colour from where it stands.
        attribute vec4 aInstance;
        // A particle (overhaul step A9; uInstanced is 2): a square that faces the camera. Its
        // entry is where it is and how large, and a second four its colour and how much of
        // it shows. uBillRight and uBillUp are the picture's own right and up in the world.
        attribute vec4 aInstanceColor;
        uniform vec3 uBillRight, uBillUp;
        varying mediump vec4 vInst;
        uniform float uInstanced, uInstanceWorld;
        uniform mat4 uProj, uView, uModel, uLightMatrix;
        // A unit's limbs (overhaul step A4): each vertex names the bone it hangs on and is
        // moved by that bone's matrix before the unit's own. Bone 0 is none. uSkin says
        // whether the mesh being drawn has bones at all.
        uniform mat4 uBones[13];
        uniform float uSkin;
        uniform vec2 uUvOffset;
        uniform mediump float uGrassTime, uVegetation, uGust;
        uniform vec4 uCloth;
        uniform float uClothTime;
        varying mediump float vGrassTip, vPebble, vGust;
        varying vec3 vNormal, vWorld;
        varying vec2 vUv;
        varying float vDepth;
        varying vec4 vShadow;
        void main() {
            vec4 local = vec4(aPosition, 1.0);
            vec3 normal = aNormal;
            if (uSkin > 0.5) {
                mat4 bone = uBones[int(aBone + 0.5)];
                local = bone * local;
                normal = mat3(bone) * normal;      // a bone turns about a pivot: no scale to undo
            }
            bool stone = aUv.x < -0.5;
            float stoneShade = 0.0;
            vInst = vec4(1.0);
            bool sown = uInstanced > 0.5 && uInstanced < 1.5;      // grass and its pebbles
            if (uInstanced > 1.5) {
                local.xyz = aInstance.xyz + (uBillRight*aPosition.x + uBillUp*aPosition.y)*aInstance.w;
                normal = vec3(0.0, 1.0, 0.0);
                vInst = aInstanceColor;
            } else if (sown) {
                // A pebble is the pebble mesh at the entry's size. A tuft keeps its base and
                // is stretched from there: its tips move up and out by the entry's height.
                vec3 p = local.xyz;
                float size = length(aInstance.zw);
                if (stone) p *= size;
                else if (p.y > 0.1) { p.y *= size; p.xz *= size; }
                float c = aInstance.z / size, s = aInstance.w / size;
                local.xyz = vec3(c*p.x + s*p.z + aInstance.x, p.y, c*p.z - s*p.x + aInstance.y);
                normal = vec3(c*normal.x + s*normal.z, normal.y, c*normal.z - s*normal.x);
                stoneShade = fract(sin(dot(aInstance.xy, vec2(12.9898, 78.233))) * 43758.5453);
            }
            vec4 world = uModel * local;
            // Pole edge stays pinned; the ownership badge follows the same fold.
            if(dot(uCloth.zw,uCloth.zw)>.5){
                float along=max(0.0,dot(world.xz-uCloth.xy,uCloth.zw));
                float fold=sin(along*7.0-uClothTime*2.0)*along*.09;
                world.xz+=vec2(-uCloth.w,uCloth.z)*fold;
            }
            vPebble = stone ? 1.0 : 0.0;
            vGrassTip = clamp(((sown ? local.y : aPosition.y)-0.018) / 0.562, 0.0, 1.0);
            vGust = 0.0;
            if (uVegetation > 0.5 && vPebble < 0.5) {
                // Every tuft flutters where it stands, as it always has...
                float flutter = sin(world.x*0.17 + world.z*0.11 + uGrassTime*1.3)
                    + 0.45*sin(world.x*0.37 - world.z*0.23 + uGrassTime*2.1);
                // ...and gusts travel across the field (overhaul step A6): fronts some
                // seventy units apart, moving with the wind at about nine units a second,
                // their line bent by a slow wave across it so that no two pass alike. In a
                // gust the grass leans with the wind and flutters harder; between gusts it
                // is as it was. (Every factor of the time is a tenth: the clock wraps
                // every twenty pi seconds, and nothing may jump when it does.)
                const vec2 wind = vec2(0.866, 0.5);
                float along = dot(world.xz, wind), across = dot(world.xz, vec2(-wind.y, wind.x));
                float front = sin(along*0.09 - uGrassTime*0.8 + 1.7*sin(across*0.031 + uGrassTime*0.1));
                vGust = uGust * smoothstep(0.3, 1.0, front);
                float bend = vGrassTip*vGrassTip*uModel[1][1];
                world.xz += (vec2(0.045,0.025)*flutter*(1.0 + 0.8*vGust) + wind*0.12*vGust) * bend;
            }
            // Inverse-transpose for orthogonal TRS columns, including nonuniform scale.
            mat3 basis = mat3(uModel);
            vec3 scale2 = vec3(dot(basis[0],basis[0]), dot(basis[1],basis[1]), dot(basis[2],basis[2]));
            vNormal = basis * (normal / max(scale2, vec3(0.00001)));
            vWorld = world.xyz;
            vUv = aUv + uUvOffset;
            // A tuft is the colour of the ground it stands on; a pebble has a shade of its own.
            if (sown) vUv = stone ? vec2(-1.0, stoneShade) : local.xz / uInstanceWorld + 0.5;
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
        uniform float uClutterMapSize, uClutterFog, uPebbleGround, uGrayGravel, uGroundGain;
        uniform mediump float uVegetation;
        varying mediump vec4 vInst;
        varying mediump float vGust;
        varying mediump float vGrassTip, vPebble;
        uniform vec4 uGroundCover;
        uniform vec3 uSunDir, uSunColor, uAmbient, uTint, uSky, uEye;
        uniform vec4 uLocalLights[3];
        uniform vec3 uShadowRight, uShadowUp;
        uniform float uShadowDepthPerTexel;
        uniform float uUnlit, uAlpha, uTime, uNight, uMaterial, uAtmosphere, uShadowStrength, uShadowTexel;
        uniform vec2 uHaze;
        uniform vec4 uAir;
        uniform vec2 uAirDist;
        uniform float uMist;
        uniform vec3 uKey, uFillHigh, uFillLow;
        uniform vec4 uGrade;
        uniform float uRim;
        uniform sampler2D uOccl;
        uniform vec2 uOcclMap;
        uniform vec2 uGroundVary;
        uniform vec4 uSoil;
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
            // The top-down map of the ground (EngineOcclusion): what stands on it here and
            // how worn it is. Read by the ground and the grass; nothing under fog, which
            // would give away what the fog hides.
            vec2 ground = vec2(0.0);
            bool onGround = (uMaterial > 0.5 && uMaterial < 1.5) || uVegetation > 0.5;
            if (uOcclMap.y > 0.0 && onGround) {
                vec4 standing = texture2D(uOccl, vWorld.xz*uOcclMap.x + 0.5);
                ground = vec2(standing.r, standing.a);
                if (uClutterFog > 0.5) ground *= texture2D(uClutterVisibility, vWorld.xz/uClutterMapSize + 0.5).r;
            }
            // Grass does not grow where it is walked on: tuft by tuft it gives out as the
            // ground wears, so a path shows through it.
            if (uVegetation > 0.5 && vPebble < 0.5 && ground.y > 0.14 + 0.5*waveHash(floor(vWorld.xz*1.6))) discard;
            vec4 t = texture2D(uTex, vUv);
            // The fog of war as mist (overhaul step A8): two soft fields drifting across
            // each other make banks that are a little lighter and denser, and by night
            // the mist is dark, not a grey sheet over a dark land. It only ever thickens:
            // what the fog hides stays as hidden as it was.
            if (uMist > 0.5) {
                vec2 q = vWorld.xz*0.026;
                float bank = waveField(q + uTime*vec2(0.021,0.012)).x*0.62 + waveField(q*2.4 - uTime*vec2(0.017,0.029)).x*0.38;
                t.rgb *= (0.86 + 0.30*bank)*mix(vec3(1.0), vec3(0.34,0.40,0.56), uNight);
                t.a = min(1.0, t.a*(1.0 + 0.16*bank));
            }
            vec3 base = t.rgb * uTint * vInst.rgb;
            // Bent over in a gust, the blades show their paler side: the wave one sees cross a field.
            if (uVegetation > 0.5) base *= mix(0.90,1.06,vGrassTip) * (1.0 + 0.15*vGust*vGrassTip);
            if (uVegetation > 0.5 && vPebble > 0.5) base = mix(
                mix(vec3(.19,.175,.15),vec3(.32,.30,.265),vUv.y),
                vec3(mix(.40,.50,vUv.y)),uGrayGravel);
            vec3 n = normalize(vNormal);
            vec3 eye = normalize(uEye-vWorld);
            float groundCover = 1.0, relief = 1.0;
            // The coast's map: how much of the point is water, how far out it lies, and how
            // wet the sand is above the waterline (TexGen.coastMask). The open sea beyond
            // the ground's rim is all water, and deep.
            vec3 coast = uMaterial > 1.5 && uMaterial < 2.5 ? vec3(1.0)
                : (uMaterial > 0.5 && uMaterial < 1.5 ? texture2D(uCoast,vUv).rgb : vec3(0.0));
            float water = coast.r;
            if (uMaterial > 0.5 && uMaterial < 1.5) {
                // Mipmapped detail lives in world metres, so close-up ground no
                // longer magnifies a single map texel into a smooth colour blob.
                // A second rotated scale breaks repetition; fade it in overview
                // shots and underwater rather than producing distant shimmer.
                vec2 a=texture2D(uGroundDetail,vWorld.xz/16.0).rg-vec2(0.502);
                vec2 b=texture2D(uGroundDetail,mat2(0.8,0.6,-0.6,0.8)*vWorld.xz/39.0).rg-vec2(0.502);
                float cover=clamp(dot(vec4(base,1.0),uGroundCover),0.0,1.0);
                groundCover=cover;
                float grain=mix(a.g, a.r, cover)*0.85+mix(b.g,b.r,cover)*0.35;
                float nearDetail=1.0-smoothstep(120.0,320.0,distance(uEye,vWorld));
                base*=1.0+grain*nearDetail*(1.0-water);
                float patch=clamp((.5+.28*sin(vWorld.x*.047+vWorld.z*.023)+.22*sin(vWorld.z*.061-vWorld.x*.019)-.3)/.4,0.0,1.0);
                float gravel=texture2D(uGroundDetail,vWorld.xz/16.0).b;
                float dry=1.0-smoothstep(.45,.9,cover);
                vec3 gravelColor=mix(base*.56,vec3(.45),uGrayGravel);
                base=mix(base,gravelColor,gravel*dry*patch*(1.0-water)*uPebbleGround);
                // Snow and sand in full sun left the tone curve near white and the bloom
                // at full strength on top, washing out their detail: dry ground on those
                // maps is a touch darker (gamerenderer sets the gain per theme).
                base*=mix(uGroundGain,1.0,water);
                // Worn ground goes toward the bare soil of this land (uSoil, and how far),
                // the ground's own grain and a slow wobble breaking the edge of a path.
                // Only where the ground IS worn, and the breaking-up grows with the wear:
                // as first written (build 1176) the grain alone passed the threshold, so
                // unworn ground everywhere took specks of soil, in Simple lighting and on
                // Low too, where nothing is meant to wear at all.
                if(ground.y>0.004){
                    float edge=(grain*0.5+0.09*sin(vWorld.x*0.83+vWorld.z*0.41)*sin(vWorld.z*0.67-vWorld.x*0.29))*min(1.0,ground.y*6.0);
                    float worn=smoothstep(0.10,0.62,ground.y+edge)*(1.0-water);
                    base=mix(base,uSoil.rgb*(0.94+grain*0.5),worn*uSoil.a);
                    groundCover*=1.0-worn;
                }
            }
            float sun = max(dot(n,uSunDir),0.0);
            vec3 legacy = base*(uAmbient + uSunColor*sun);
            // Open ground is not one flat fill (overhaul step A3): three slow waves, 40 to
            // 160 units long, make it a little lighter here and darker there, lean the
            // meadow toward dry or lush with them (uGroundVary: how much lighter and
            // darker, how much of the lean), and shade their slopes against the sun as
            // if the land rolled. The grass on it follows, or it would lie over the
            // patches like a sheet. Atmospheric only: the sum for Simple lighting is taken
            // above, from the plain colour.
            if (uAtmosphere > 0.5 && uGroundVary.x > 0.0 && ((uMaterial > 0.5 && uMaterial < 1.5) || (uVegetation > 0.5 && vPebble < 0.5))) {
                vec2 q=vWorld.xz;
                float w1=q.x*0.021+q.y*0.034, w2=q.y*0.047-q.x*0.031+1.7, w3=q.x*0.083+q.y*0.071+0.6;
                float broad=0.4*sin(w1)+0.35*sin(w2)+0.25*sin(w3);
                vec2 slope=vec2(0.4*0.021*cos(w1)-0.35*0.031*cos(w2)+0.25*0.083*cos(w3),
                    0.4*0.034*cos(w1)+0.35*0.047*cos(w2)+0.25*0.071*cos(w3));
                float land=1.0-water;
                base*=1.0+land*uGroundVary.x*broad;
                base*=mix(vec3(1.0),mix(vec3(0.95,1.0,0.93),vec3(1.06,1.0,0.90),broad*0.5+0.5),land*groundCover*uGroundVary.y);
                relief=1.0-land*82.0*uGroundVary.x*dot(slope,uSunDir.xz);
            }
            // Atmospheric: light is added up in linear space and brought back to the
            // display at the end (a square and a square root stand in for the display
            // curve). The key light is the sun or the moon; the fill comes from the sky
            // above and, warmer and weaker, from the lit ground below.
            vec3 albedo = base*base;
            // Wet sand (overhaul step A7): above the waterline the beach is darker where the
            // last wave reached, and that line moves up and down the beach with the swash,
            // unevenly along it. A little of the sky lies on it.
            float wetSand = 0.0, swash = 0.5;
            if (uMaterial > 0.5 && uMaterial < 1.5 && coast.b > 0.0 && water < 0.99) {
                swash = 0.5 + 0.5*sin(uTime*0.6 + waveField(vWorld.xz*0.07).x*6.2832);
                wetSand = smoothstep(0.34 - 0.24*swash, 0.80, coast.b)*(1.0-water);
                albedo *= 1.0 - 0.33*wetSand;
            }
            // Contact shading (uOcclMap: one over the map's span, then the strength). The
            // ground and the grass darken by what stands on them (read above). Things that stand
            // darken toward their own foot. The fill is taken in full and the key light
            // by three quarters: with the fill alone the ground beside a sunlit wall
            // hardly changed.
            float contact = 1.0;
            if (uOcclMap.y > 0.0) {
                if (onGround) {
                    contact = 1.0 - ground.x*uOcclMap.y;
                } else if (uMaterial < 0.5) {
                    contact = mix(1.0 - 0.55*uOcclMap.y, 1.0, smoothstep(0.0, 1.5, vWorld.y));
                }
            }
            vec3 light = mix(uFillLow,uFillHigh,n.y*0.5+0.5)*contact + uKey*sun*relief*visibility(n)*mix(1.0,contact,0.75);
            vec3 col = albedo*light + uSky*uSky*wetSand*0.07;
            // Sky light along an edge turned away from the eye, on things that stand:
            // it is what lifts a figure off the ground at night.
            if (uMaterial < 0.5 || uMaterial > 2.5) {
                float rim = 1.0-max(dot(n,eye),0.0);
                col += albedo*uFillHigh*rim*rim*rim*uRim;
            }
            // One nearby entrance lamp per building, without extra light/shadow passes.
            for(int i=0;i<3;i++){
              vec4 localLight=uLocalLights[i];
              if(localLight.w>0.0){
                vec3 delta=localLight.xyz-vWorld;
                float d2=dot(delta,delta);
                float facing=max(0.0,dot(n,delta*inversesqrt(max(.01,d2))));
                float reach=facing*localLight.w/(1.0+d2*1.7);
                col+=albedo*vec3(1.0,.30,.045)*reach*5.2;
                legacy+=base*vec3(1.0,.46,.12)*reach*1.8;
              }
            }
            if (uMaterial > 2.5 && uMaterial < 3.5) {
                // Broad polished highlight plus sky rim; silver stays silver.
                vec3 specTint=mix(vec3(1.0),base,0.3);
                float spec=pow(max(dot(n,normalize(eye+uSunDir)),0.0),48.0);
                float rim=pow(1.0-max(dot(n,eye),0.0),4.0);
                col += specTint*uKey*spec*0.6 + uSky*uSky*rim*0.3;
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
                float towardSun=max(dot(wn,normalize(eye+uSunDir)),0.0);
                float glint=pow(towardSun,48.0);
                // The shallows (overhaul step A7): for the first stretch out from the beach
                // the water is clear over pale sand -- lighter, greener, mirroring less of
                // the sky -- and the light the ripples gather plays on the bottom.
                float shallow=1.0-smoothstep(0.0,0.42,coast.g);
                shallow*=shallow;
                vec3 body=base*vec3(0.72,0.96,1.02);
                body=mix(body,body*vec3(1.24,1.30,1.10)+vec3(0.015,0.035,0.025),shallow);
                float caustic=waveField(p*0.46).x*waveField(turn*p*0.39+vec2(3.1,7.7)).x;
                body*=1.0+0.55*shallow*detail*smoothstep(0.28,0.52,caustic);
                vec3 sea=mix(body*mix(vec3(1.0),vec3(0.38,0.48,0.65),uNight),uSky*0.72,fresnel*0.8*(1.0-0.5*shallow));
                // The sun on the sea: the tight glint it always had, and with it glitter --
                // a finer set of ripples whose facets flash where they happen to mirror the
                // sun to the eye, twinkling as they pass. Both show only when the camera
                // looks toward the sun, at about the sun's own height. (The camera sees
                // every point of the sea from almost the same direction, so the glitter
                // lies on all the water in view, not in a path narrowing to the horizon.)
                vec3 fine=waveField(turn*p*0.83+vec2(5.3,1.7));
                vec2 facet=grad+vec2(dot(turn[0],fine.yz),dot(turn[1],fine.yz))*0.22*detail;
                float flash=pow(max(dot(normalize(vec3(-facet.x,1.0,-facet.y)),normalize(eye+uSunDir)),0.0),160.0);
                float twinkle=0.30+0.70*smoothstep(0.45,0.80,waveField(p*2.7+vec2(uTime*0.6,0.0)).x);
                sea += uSunColor*(glint*0.42 + flash*twinkle*detail*0.85);
                sea *= 0.98+swell.x*0.04;
                // The sea keeps the look it was tuned to: its own shoulder, then into
                // linear with the rest.
                sea = sea/(vec3(1.0)+sea*0.16)*1.12;
                col = mix(col,sea*sea,water);
                // Foam (overhaul step A7): bands that roll in toward the beach over the last
                // fifteen units, about six apart and a little under a unit a second, ragged
                // and bent by a slow wave along the shore; and a line of it where the water
                // lies on the sand, coming and going with the swash. It is lit like
                // anything white: by the sky and the key light.
                float off=coast.g*60.0;
                float nearShore=1.0-smoothstep(3.0,15.0,off);
                if (nearShore > 0.0) {
                    float roll=off*1.1+uTime*0.9+waveField(vWorld.xz*0.045).x*5.0+waveField(vWorld.xz*0.23+vec2(4.0,9.0)).x*2.2;
                    float crest=smoothstep(0.74,0.98,0.5+0.5*sin(roll));
                    float ragged=smoothstep(0.22,0.78,waveField(vWorld.xz*0.33+vec2(uTime*0.07,0.0)).x);
                    float lap=smoothstep(0.03,0.10,water)*(1.0-smoothstep(0.10,0.24,water))*(0.40+0.60*swash);
                    float foam=clamp(crest*ragged*nearShore*smoothstep(0.02,0.20,water)+lap*(0.55+0.45*ragged),0.0,1.0);
                    col=mix(col,(uFillHigh*0.85+uKey*0.70)*0.80,foam*0.82);
                }
            }
            // The shoulder works on the brightest channel and scales the colour by it, so
            // bright plaster and lit sand roll off without losing their hue. Then back to
            // the display, and the grade of the hour.
            float peak = max(col.r,max(col.g,col.b));
            col *= min(1.0/max(peak,0.0001),(1.06+peak*0.10)/(1.0+peak*0.62));
            col = sqrt(col);
            col = mix(vec3(dot(col,vec3(0.299,0.587,0.114))),col,uGrade.a)*uGrade.rgb;
            col = mix(legacy,col,uAtmosphere);
            col = mix(col,base,uUnlit);
            // The air between (overhaul step A8): what lies beyond the point the camera
            // looks at fades toward the air's colour. Not what is drawn unlit -- a flame
            // or a marker is seen through it -- and not in Simple lighting.
            float beyond = max(0.0, vDepth/max(1.0,uAirDist.x) - 1.0);
            col = mix(col, uAir.rgb, uAir.a*(1.0-exp(-beyond*uAirDist.y))*(1.0-uUnlit)*uAtmosphere);
            float haze = clamp((vDepth-uHaze.x)/max(1.0,uHaze.y-uHaze.x),0.0,1.0);
            float alpha = uMaterial > 0.5 && uMaterial < 2.5 ? 1.0 : t.a;
            gl_FragColor = vec4(mix(col,uSky,haze),alpha*uAlpha*vInst.a);
        }`;
    EngineAtmosphere.shadowVertex = `
        attribute vec3 aPosition;
        attribute float aBone;
        uniform mat4 uLightMatrix, uModel;
        uniform mat4 uBones[13];
        uniform float uSkin;
        void main() {
            vec4 local = vec4(aPosition,1.0);
            if (uSkin > 0.5) local = uBones[int(aBone + 0.5)] * local;
            gl_Position = uLightMatrix*uModel*local;
        }`;
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
