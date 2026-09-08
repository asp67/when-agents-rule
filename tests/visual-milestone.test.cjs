const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
function context() {
    const scope={console,window:{},localStorage:{getItem:()=>null,setItem:()=>{}},
        TexGen:{TERRAIN_WORLD:1000,TERRAIN_LAND:417,TERRAIN_SEED:12345}};
    scope.document={createElement:()=>({getContext:()=>({createImageData:(w,h)=>({data:new Uint8ClampedArray(w*h*4)}),putImageData(img){scope.lastImage=img;}})})};
    vm.createContext(scope);
    for(const name of ['math3d','mesh','texgen','atmosphere','units','buildings','gamerenderer']) {
        vm.runInContext(fs.readFileSync(path.join(root,'js/engine',name+'.js'),'utf8'),scope);
        Object.assign(scope,scope.window);
    }
    return scope;
}
function fakeGL(complete=true) {
    let id=0;
    const calls=[];
    const gl={calls,FRAMEBUFFER_COMPLETE:123,FRAMEBUFFER:1,TEXTURE_2D:2,RENDERBUFFER:3,DITHER:4,
        isEnabled:()=>true,createTexture:()=>({texture:++id}),createRenderbuffer:()=>({depth:++id}),createFramebuffer:()=>({fb:++id}),
        checkFramebufferStatus:()=>complete?123:0};
    for(const name of ['bindTexture','texImage2D','texParameteri','bindRenderbuffer','renderbufferStorage','bindFramebuffer','framebufferTexture2D','framebufferRenderbuffer','deleteTexture','deleteRenderbuffer','deleteFramebuffer','viewport','clearColor','clear','useProgram','uniformMatrix4fv','enable','disable','polygonOffset']) gl[name]=(...args)=>calls.push([name,...args]);
    return gl;
}
test('coastal water mask leaves the entire playable square as land',()=>{
    const s=context();s.TexGen.coastMask(128);
    const d=s.lastImage.data;
    for(let y=0;y<128;y++) for(let x=0;x<128;x++) {
        const wx=(x/128-.5)*1000,wz=(y/128-.5)*1000;
        if(Math.abs(wx)<=400&&Math.abs(wz)<=400) assert.equal(d[(y*128+x)*4],0);
        assert.equal(d[(y*128+x)*4+3],255);
    }
    assert.equal(d[0],255);
});
test('Greek decorative details retain existing measured structural footprints',()=>{
    const s=context(), r=Object.create(s.EngineRenderer.prototype);r._footprint=new Map();
    for(const type of ['town_center','house','temple','barracks','archery_range']) {
        const parts=s.EngineBuildings.parts(type,{civ:'greek',age:'iron'});
        assert.ok(parts.some(p=>p.tex==='limestone'),type);
        assert.ok(parts.some(p=>p.visualOnly),type);
        const expected=r._meshFootprint(parts.filter(p=>!p.visualOnly),type+':structural');
        const actual=r._meshFootprint(parts,type+':all');
        assert.deepEqual(actual,expected);
        for(const p of parts) {
            assert.ok(Array.from(p.m).every(Number.isFinite));
            const mesh=s.EngineMesh[p.kind](...p.args);
            assert.ok(mesh.positions.every(Number.isFinite));
            assert.equal(s.EngineMesh.auditWinding(mesh),0,type+'/'+p.kind);
        }
    }
});
test('unsupported shadow framebuffers fall back without leaking GPU resources',()=>{
    const s=context(),gl=fakeGL(false);
    assert.equal(s.EngineAtmosphere.createShadowTarget(gl,1024),null);
    for(const name of ['deleteTexture','deleteRenderbuffer','deleteFramebuffer']) assert.equal(gl.calls.filter(c=>c[0]===name).length,1);
    assert.ok(gl.calls.some(c=>c[0]==='bindFramebuffer'&&c[2]===null));
});
test('quality changes release the previous target and low quality allocates no shadow map',()=>{
    const s=context(),r=Object.create(s.EngineRenderer.prototype);r.gl=fakeGL();
    r.setGraphicsQuality('cinematic');assert.equal(r._shadowTarget.size,2048);
    r.setGraphicsQuality('low');assert.equal(r._shadowTarget,null);
    assert.equal(r.gl.calls.filter(c=>c[0]==='deleteFramebuffer').length,1);
    r.setGraphicsQuality('bad');assert.equal(r.graphicsQuality,'balanced');assert.equal(r._shadowTarget.size,1024);
});
test('shadow pass uses only admitted opaque geometry and restores the default framebuffer',()=>{
    const s=context(),r=Object.create(s.EngineRenderer.prototype),gl=fakeGL(),drawn=[];
    s.GLCore={drawMesh:(_,__,buf)=>drawn.push(buf)};
    const ground={buf:'ground'},sea={buf:'sea'},unit={buf:'visible-unit'},prop={buf:'no-shadow',noShadow:true};
    Object.assign(r,{gl,_shadowTarget:{framebuffer:{},size:1024},visualStyle:'cinematic',_halfH:48,
        cameraTarget:{x:0,z:-340},sunDir:s.M3D.normalize([-.65,.72,.36]),shadowProg:{uniforms:{}},
        _ground:ground,_sea:sea,_dl:{opaque:[ground,sea,unit,prop]}});
    r._renderShadows();assert.deepEqual(drawn,['visible-unit']);
    assert.ok(gl.calls.some(c=>c[0]==='bindFramebuffer'&&c[2]===null));
    assert.ok(Array.from(r._lightMatrix).every(Number.isFinite));
    r.visualStyle='classic';drawn.length=0;r._renderShadows();assert.equal(drawn.length,0);
});

test('all civilization/unit tiers produce outward, finite geometry within WebGL 1 index limits',()=>{
    const s=context();
    for(const civ of ['greek','egyptian','yamato','persian']) {
        for(const type of s.EngineUnits.TYPES) for(const tier of [1,2,3]) for(const variant of (civ==='greek'?[0,1,2]:civ==='yamato'?[0,1]:[0])) {
            const options={civ,tier,variant,badge:'circle'};
            const parts=s.EngineUnits.parts(type,options), batches=s.EngineUnits.batches(parts);
            assert.deepEqual(options,{civ,tier,variant,badge:'circle'},'composition must not mutate caller options');
            for(const b of batches) {
                const label=`${civ}/${type}/${tier}/${b.tex}/${b.bone}`;
                assert.ok(b.mesh.positions.every(Number.isFinite),label);
                assert.ok(b.mesh.normals.every(Number.isFinite),label);
                assert.equal(s.EngineMesh.auditWinding(b.mesh),0,label);
                assert.ok(b.mesh.indices.every(i=>i>=0 && i<65536 && i<b.mesh.positions.length/3),label);
            }
            if(type==='infantry' && tier>=2) assert.ok(batches.length<=22,'armor, mouth and hair detail must stay batched');
        }
    }
    // The standing chariot rider uses a separate composition from mounted cavalry.
    for(const b of s.EngineUnits.batches(s.EngineUnits.parts('cavalry',{civ:'egyptian',unit:'horse_carriage'}))) {
        assert.equal(s.EngineMesh.auditWinding(b.mesh),0);
    }
});

test('baking scaled armor preserves positions and unit normals through every limb pose',()=>{
    const s=context(),m=s.M3D;
    const transform=(a,p,w)=>[0,1,2].map(r=>a[r]*p[0]+a[4+r]*p[1]+a[8+r]*p[2]+a[12+r]*w);
    const parts=s.EngineUnits.parts('infantry',{civ:'greek',tier:3,badge:'diamond'});
    for(const animation of ['idle','walk','attack','harvest']) {
        const pose=s.EngineUnits.pose('infantry',animation,.61,.3);
        for(const part of parts) {
            const original=s.EngineMesh[part.kind](...part.args), baked=s.EngineMesh.mergeParts([part]);
            const bone=pose.mats[part.bone]||m.identity();
            for(let i=0;i<original.positions.length;i+=3) {
                const expected=transform(bone,transform(part.m,original.positions.slice(i,i+3),1),1);
                const actual=transform(bone,baked.positions.slice(i,i+3),1);
                actual.forEach((v,k)=>assert.ok(Math.abs(v-expected[k])<1e-6));
                assert.ok(Math.abs(Math.hypot(...baked.normals.slice(i,i+3))-1)<1e-6);
            }
        }
    }
});

test('unit batches share geometry across seats while keeping team and badge tints per instance',()=>{
    const s=context(),r=Object.create(s.EngineRenderer.prototype);
    s.GLCore={createMeshBuffers:(_,mesh)=>({mesh})};
    s.getTeamBadge=()=>({shape:'circle'});
    Object.assign(r,{units:[],gl:{},tex:new Proxy({},{get:(_,key)=>key}),WHITE:[1,1,1]});
    r._badgeTints=seat=>({fill:[seat,0,0],rim:[0,seat,0]});
    const a={unitType:'infantry',type:'warrior',civilization:'greek',seat:1,color:0xff0000};
    const b={...a,seat:2,color:0x0000ff};
    r.addUnit(a);r.addUnit(b);
    assert.equal(r._unitModels.size,1);
    a._engine.entries.forEach((entry,i)=>assert.equal(entry.buf,b._engine.entries[i].buf));
    assert.ok(a._engine.entries.some((entry,i)=>JSON.stringify(entry.tint)!==JSON.stringify(b._engine.entries[i].tint)));
});

test('tree forks meet the trunk, with a single closed canopy and unchanged resource data',()=>{
    const s=context(),r=Object.create(s.EngineRenderer.prototype);
    Object.assign(r,{_resEntries:new WeakMap(),_theme:'summer',tex:{shadow:'shadow',worldBark:'bark',worldFoliage:'foliage'}});
    r._buf=(kind,args)=>({kind,args});
    for(let i=0;i<4;i++) {
        const res={type:'wood',x:17,z:-32,amount:100},before={...res};
        const entries=r._resourceEntries(res,i), crowns=entries.opaque.filter(e=>e.buf.kind==='canopy');
        assert.equal(crowns.length,1);
        assert.equal(s.EngineMesh.auditWinding(s.EngineMesh.canopy(i)),0);
        for(const fork of entries.opaque.filter(e=>e.buf.kind==='cylinder'&&e.buf.args[0]===.09)) {
            const half=fork.buf.args[2]/2,m=fork.model;
            assert.ok(Math.hypot(m[12]-m[4]*half-res.x,m[14]-m[6]*half-res.z)<1e-5,'fork bottom must meet trunk axis');
        }
        assert.deepEqual(res,before);
        assert.equal(r._resourceEntries(res,i),entries,'resource geometry stays cached');
    }
});

test('Yamato and Persian civilian hat rims sit above the eyebrows and overlap the head',()=>{
    const s=context();
    for(const civ of ['yamato','persian']) for(const type of ['worker','ranged']) {
        const parts=s.EngineUnits.parts(type,{civ,tier:1});
        const brow=parts.find(p=>p.kind==='box' && p.tex.startsWith('hair') && p.args[0]===.067);
        const hat=parts.find(p=>p.kind==='cylinder' && (civ==='yamato'
            ? p.tex==='thatch' && p.args[1]===.37
            : p.tex==='cloth' && p.args[0]===.09 && p.args[1]===.23));
        const head=parts.find(p=>p.kind==='sphere' && p.tex==='skin' && Math.abs(p.m[13]-1.49)<1e-5);
        assert.ok(brow && hat && head,civ+'/'+type);
        const bottom=hat.m[13]-hat.args[2]/2, browTop=brow.m[13]+brow.args[1]/2;
        assert.ok(bottom>browTop && bottom-browTop<.025,civ+'/'+type+' brow clearance');
        assert.ok(bottom<head.m[13]+head.m[5],civ+'/'+type+' must overlap skull');
    }
});


test('every handheld assembly tilts away from the body and stays anchored to its palm under animation',()=>{
    const s=context(),m=s.M3D;
    const transform=(a,p)=>[0,1,2].map(r=>a[r]*p[0]+a[4+r]*p[1]+a[8+r]*p[2]+a[12+r]);
    const cases=[['worker',1,'axe'],['infantry',1,'club'],['infantry',2,'sword'],
        ['ranged',1,'bow'],['ranged',2,'crossbow'],['ranged',3,'bow'],['priest',1,'staff'],
        ['cavalry',1,'javelin'],['cavalry',2,'spear'],['cavalry',3,'lance'],['cavalry',1,'chariot-spear','horse_carriage']];
    for(const [type,tier,name,unit] of cases) {
        const parts=s.EngineUnits.parts(type,{civ:'egyptian',tier,unit});
        const held=parts.filter(p=>p.attachment===name);
        assert.ok(held.length,name);
        const {grip,gripFrame:frame,bone}=held[0];
        const palm=parts.find(p=>p.tex==='skin' && p.bone===bone && grip.every((v,i)=>Math.abs(v-p.m[12+i])<1e-6));
        assert.ok(palm,name+' palm');
        // Long shafts lean forward and out, away from the upper arm. A crossbow
        // has a horizontal stock: its forward end tilts upward instead.
        if(name==='crossbow') assert.ok(frame[9]>.1,name+' pitch');
        else {
            assert.ok(frame[6]>.3,name+' forward pitch');
            assert.ok(frame[4]*Math.sign(grip[0])>.1,name+' outward pitch');
        }
        for(const animation of ['idle','walk','attack','harvest']) for(const t of [0,.23,.61,1.07]) {
            const pose=s.EngineUnits.pose(type,animation,t,.3),arm=pose.mats[bone]||m.identity();
            const expected=transform(arm,Array.from(palm.m).slice(12,15));
            for(const piece of held) {
                assert.equal(piece.bone,palm.bone,name+' must follow the palm bone');
                assert.equal(piece.gripFrame,frame,name+' pieces share one rigid grip frame');
                const actual=transform(m.multiply(arm,piece.gripFrame),[0,0,0]);
                actual.forEach((v,i)=>assert.ok(Math.abs(v-expected[i])<1e-6,name+' animated grip'));
            }
        }
    }
});

test('civilization facial hair covers every human class, with visible mouths and stable color variants',()=>{
    const s=context();
    const palettes={greek:['hairBlack','hairBrown','hairBlond'],persian:['hairBlack'],yamato:['hairBrown','hairWhite'],egyptian:['hairBlack']};
    for(const [civ,colors] of Object.entries(palettes)) {
        const variants=new Set(Array.from({length:12},(_,i)=>s.EngineUnits.appearanceVariant(civ,'worker'+i)));
        assert.equal(variants.size,colors.length,civ+' variety');
        for(const variant of variants) for(const type of s.EngineUnits.TYPES) {
            const parts=s.EngineUnits.parts(type,{civ,variant});
            assert.equal(parts.filter(p=>p.tex==='mouth' && !p.bone).length,1,civ+'/'+type+' human mouth');
            const beard=parts.filter(p=>p.tex===colors[variant] && p.kind==='sphere' && !p.bone && p.m[13]<(type==='cavalry'?1.78:1.42));
            assert.ok(beard.length,civ+'/'+type+' beard');
        }
    }
    const r=Object.create(s.EngineRenderer.prototype);
    s.GLCore={createMeshBuffers:(_,mesh)=>({mesh})};s.getTeamBadge=()=>({shape:'circle'});
    Object.assign(r,{units:[],gl:{},tex:new Proxy({},{get:(_,key)=>key}),WHITE:[1,1,1]});
    r._badgeTints=()=>({fill:[1,0,0],rim:[0,1,0]});
    const units=Array.from({length:3},(_,i)=>({unitType:'worker',type:'worker',civilization:'greek',seat:1,color:0xff0000,handle:i+1}));
    for(const u of units) r.addUnit(u);
    assert.equal(r._unitModels.size,3,'cache must preserve all three appearances');
    for(const u of units) {
        const color=palettes.greek[s.EngineUnits.appearanceVariant('greek',u.handle)];
        assert.ok(u._engine.entries.some(e=>e.tex===color));
        const previous=u._engine.entries.map(e=>e.buf);
        r.addUnit(u);
        assert.equal(r.units.length,3,'recomposition must not duplicate units');
        u._engine.entries.forEach((e,i)=>assert.equal(e.buf,previous[i],'same handle reuses appearance'));
        const replay={...u,handle:u.handle+1,_appearanceId:u.handle};r.addUnit(replay);
        replay._engine.entries.forEach((e,i)=>assert.equal(e.buf,previous[i],'recorded handle retains appearance'));
        r.removeUnit(replay);
    }
});

test('horse legs stand symmetrically, remain joined at the hips, and carry a proportionate centered head',()=>{
    const s=context(),m=s.M3D;
    for(const tier of [1,2,3]) {
        const parts=s.EngineUnits.parts('cavalry',{civ:'persian',tier});
        const legs=parts.filter(p=>p.kind==='cylinder' && /^leg[FB][LR]$/.test(p.bone));
        assert.equal(legs.length,4);
        for(const leg of legs) {
            assert.ok(Math.abs(leg.m[4])<1e-6 && Math.abs(leg.m[6])<1e-6,'straight rest leg');
            const twin=legs.find(p=>p.bone!==leg.bone && Math.abs(p.m[12]+leg.m[12])<1e-6 && p.m[14]===leg.m[14]);
            assert.ok(twin,'mirrored leg');
            const hip=[leg.m[12],leg.m[13]+leg.args[2]/2,leg.m[14]];
            for(const t of [0,.19,.57,.91]) {
                const pose=s.EngineUnits.pose('cavalry','walk',t),a=pose.mats[leg.bone]||m.identity();
                const moved=[0,1,2].map(r=>a[r]*hip[0]+a[4+r]*hip[1]+a[8+r]*hip[2]+a[12+r]);
                assert.ok(moved.every((v,i)=>Math.abs(v-hip[i])<1e-6),'leg rotates at connected hip');
            }
        }
        const skull=parts.find(p=>p.bone==='head' && p.tex==='leather' && p.kind==='sphere' && Math.abs(p.m[13]-1.48)<1e-6);
        const body=parts.find(p=>!p.bone && p.tex==='leather' && Math.abs(p.m[13]-.90)<1e-6);
        assert.ok(skull && body);
        assert.equal(skull.m[12],0,'head stays on centerline');
        const radius=p=>Math.hypot(p.m[8],p.m[9],p.m[10]);
        assert.ok(radius(skull)/radius(body)>.4,'skull has substantial length relative to barrel');
    }
});

test('mounted riders have complete, equally substantial arms and connected seated legs',()=>{
    const s=context(),m=s.M3D;
    const point=(a,p)=>[0,1,2].map(r=>a[r]*p[0]+a[4+r]*p[1]+a[8+r]*p[2]+a[12+r]);
    const near=(a,b,label)=>assert.ok(a.every((v,i)=>Math.abs(v-b[i])<1e-6),label);
    for(const civ of ['greek','egyptian','yamato','persian']) for(const tier of [1,2,3]) {
        const parts=s.EngineUnits.parts('cavalry',{civ,tier});
        const limbs=new Map(parts.filter(p=>p.riderLimb).map(p=>[p.riderLimb,p]));
        assert.equal(limbs.size,8,'two upper arms, forearms, thighs and calves');
        for(const [name,p] of limbs) {
            near(point(p.m,[0,-p.args[2]/2,0]),p.jointStart,name+' start');
            near(point(p.m,[0,p.args[2]/2,0]),p.jointEnd,name+' end');
            const twin=limbs.get(name.slice(0,-1)+(name.endsWith('L')?'R':'L'));
            assert.deepEqual(p.args.slice(0,2),twin.args.slice(0,2),'paired limb thickness');
        }
        for(const side of ['L','R']) {
            const upper=limbs.get('upperArm'+side),forearm=limbs.get('forearm'+side);
            assert.ok(upper.args[1]>=.08 && forearm.args[1]>=.07,'arms comparable to foot soldiers');
            near(upper.jointEnd,forearm.jointStart,'joined elbow');
            const palm=parts.find(p=>p.tex==='skin' && p.kind==='sphere' && p.bone==='arm'+side
                && point(p.m,[0,0,0]).every((v,i)=>Math.abs(v-forearm.jointEnd[i])<1e-6));
            assert.ok(palm,'hand meets forearm');
            for(const anim of ['idle','walk','attack']) for(const t of [0,.2,.6]) {
                const pose=s.EngineUnits.pose('cavalry',anim,t);
                const a=pose.mats[upper.bone]||m.identity(),b=pose.mats[forearm.bone]||m.identity();
                near(point(m.multiply(a,upper.m),[0,upper.args[2]/2,0]),
                    point(m.multiply(b,forearm.m),[0,-forearm.args[2]/2,0]),'animated elbow');
                near(point(a,upper.jointStart),upper.jointStart,'shoulder pivot stays attached');
            }
            const thigh=limbs.get('thigh'+side),calf=limbs.get('calf'+side);
            near(thigh.jointEnd,calf.jointStart,'joined knee');
            assert.ok(Math.abs(calf.jointEnd[0])>.32,'calf stays outside horse barrel');
            assert.ok(thigh.jointEnd[2]>thigh.jointStart[2] && calf.jointEnd[2]<calf.jointStart[2],'bent riding knee');
            assert.equal(thigh.bone,null,'rider thighs do not inherit horse leg motion');
            assert.equal(calf.bone,null,'rider calves do not inherit horse leg motion');
            assert.ok(parts.some(p=>p.tex==='leather' && p.kind==='shoe' && !p.bone
                && Math.abs(p.m[12]-calf.jointEnd[0])<1e-6 && p.m[13]<calf.jointEnd[1]
                && p.m[14]>calf.jointEnd[2]),'forward boot below ankle');
        }
    }
    const chariot=s.EngineUnits.parts('cavalry',{civ:'egyptian',unit:'horse_carriage'});
    for(const name of ['upperArmL','forearmL','upperArmR','forearmR'])
        assert.ok(chariot.some(p=>p.riderLimb===name),'chariot '+name);
});

test('horse leg caps stay fully inside the actual body mesh throughout the stride',()=>{
    const s=context(),m=s.M3D;
    const transform=(a,p)=>[0,1,2].map(r=>a[r]*p[0]+a[4+r]*p[1]+a[8+r]*p[2]+a[12+r]);
    // The body is a union of convex, faceted ellipsoids. Checking its triangle
    // planes catches exposed rims that an ideal smooth-ellipsoid test can miss.
    for(const options of [{tier:1},{tier:2},{tier:3},{unit:'horse_carriage'}]) {
        const parts=s.EngineUnits.parts('cavalry',{civ:'egyptian',...options});
        const bodies=parts.filter(p=>p.kind==='sphere' && p.tex==='leather' && !p.bone
            && p.m[12]===0 && p.m[13]>.85 && p.m[13]<1);
        assert.equal(bodies.length,3);
        const hulls=bodies.map(body=>{
            const mesh=s.EngineMesh.mergeParts([body]),planes=[];
            for(let i=0;i<mesh.indices.length;i+=3) {
                const [a,b,c]=mesh.indices.slice(i,i+3).map(j=>mesh.positions.slice(j*3,j*3+3));
                const normal=m.cross(b.map((v,j)=>v-a[j]),c.map((v,j)=>v-a[j]));
                if(Math.hypot(...normal)>1e-8) planes.push([a,m.normalize(normal)]);
            }
            return planes;
        });
        for(const leg of parts.filter(p=>p.kind==='cylinder' && /^leg[FB][LR]$/.test(p.bone))) {
            const mesh=s.EngineMesh.cylinder(...leg.args),cap=[];
            for(let i=0;i<mesh.positions.length;i+=3)
                if(Math.abs(mesh.positions[i+1]-leg.args[2]/2)<1e-6) cap.push(mesh.positions.slice(i,i+3));
            assert.ok(cap.length>=leg.args[3]+1,'complete top rim and center');
            for(let frame=0;frame<=32;frame++) {
                const pose=s.EngineUnits.pose('cavalry','walk',frame*2*Math.PI/(32*7));
                const matrix=m.multiply(pose.mats[leg.bone],leg.m),points=cap.map(p=>transform(matrix,p));
                assert.ok(hulls.some(planes=>points.every(p=>planes.every(([a,n])=>
                    m.dot(n,p.map((v,i)=>v-a[i])) < -1e-4))),leg.bone+' cap must be buried, frame '+frame);
            }
        }
    }
});

test('shadow projection moves in whole light-space texels at every active zoom and quality',()=>{
    const s=context(),m=s.M3D,sun=m.normalize([-.65,.72,.36]);
    const project=(a,p)=>[0,1,2].map(r=>.5+.5*(a[r]*p[0]+a[4+r]*p[1]+a[8+r]*p[2]+a[12+r]));
    for(const size of [1024,2048]) for(const zoom of [10,27,48,100,125,159]) {
        const a=s.EngineAtmosphere.shadowCamera(m,{x:0,z:0},zoom,size,sun);
        for(const move of [.1,.4,1,3,17]) {
            const b=s.EngineAtmosphere.shadowCamera(m,{x:a.worldTexel*move,z:-a.worldTexel*move/3},zoom,size,sun);
            const p=project(a.matrix,[17,3,-12]),q=project(b.matrix,[17,3,-12]);
            for(let i=0;i<2;i++) {
                const pixels=(p[i]-q[i])*size;
                assert.ok(Math.abs(pixels-Math.round(pixels))<.002,'fractional shadow-map drift');
            }
            assert.ok(Array.from(b.matrix).every(Number.isFinite));
        }
        assert.ok(Math.abs(m.dot(a.right,sun))<1e-6 && Math.abs(m.dot(a.up,sun))<1e-6);
        assert.equal(a.depthPerTexel,a.worldTexel/999);
    }
});

test('receiver-plane comparisons cover PCF sample depths without erasing nearby occluders',()=>{
    const s=context(),m=s.M3D,sun=m.normalize([-.65,.72,.36]);
    let oldFalseShadows=0;
    // Independent plane intersections in world space validate the gradient used
    // by the shader; this is numerical verification, not a GPU rasterization test.
    for(const size of [1024,2048]) for(const zoom of [10,48,100,159]) {
        const camera=s.EngineAtmosphere.shadowCamera(m,{x:100,z:-200},zoom,size,sun);
        for(const normal of [[0,1,0],sun,m.normalize([-.4,1,.5]),m.normalize([.3,1,-.2])]) {
            const ndl=m.dot(normal,sun);
            const slope=[m.dot(normal,camera.right),m.dot(normal,camera.up)].map(v=>v/Math.max(ndl,.2)*camera.depthPerTexel);
            const bias=2/65025+camera.depthPerTexel*(.10+.35*(1-ndl));
            for(const fx of [.01,.3,.7,.99]) for(const fy of [.01,.7,.99]) for(const x of [-1,0,1]) for(const y of [-1,0,1]) {
                const delta=[x+.5-fx,y+.5-fy];
                const lateral=camera.right.map((v,i)=>(v*delta[0]+camera.up[i]*delta[1])*camera.worldTexel);
                const alongSun=-m.dot(normal,lateral)/ndl;
                const stored=Math.floor((.45-alongSun/999)*65025)/65025;
                const expected=.45+slope[0]*delta[0]+slope[1]*delta[1]-bias;
                assert.ok(expected<=stored,'plane shadows itself');
                assert.ok(expected>stored-1/999,'one-world-unit occluder must still shadow the plane');
                const oldBias=Math.max(.00015,.0007*(1-ndl));
                if(.45-oldBias>stored)oldFalseShadows++;
            }
        }
    }
    assert.ok(oldFalseShadows>0,'fixture must expose the previous comparison failure');
    assert.match(s.EngineAtmosphere.fragment,/p\.z\+dot\(slope,delta\)-bias/);
});

test('packed shadow writes disable dithering and restore its previous state',()=>{
    for(const initiallyOn of [true,false]) {
        const s=context(),r=Object.create(s.EngineRenderer.prototype),gl=fakeGL();let enabled=initiallyOn,draws=0;
        gl.isEnabled=cap=>{assert.equal(cap,gl.DITHER);return enabled;};
        gl.disable=cap=>{assert.equal(cap,gl.DITHER);enabled=false;};
        gl.enable=cap=>{assert.equal(cap,gl.DITHER);enabled=true;};
        s.GLCore={drawMesh:()=>{assert.equal(enabled,false,'numeric depth must not be dithered');draws++;}};
        Object.assign(r,{gl,_shadowTarget:{framebuffer:{},size:2048},visualStyle:'cinematic',_halfH:48,
            cameraTarget:{x:0,z:-340},sunDir:s.M3D.normalize([-.65,.72,.36]),shadowProg:{uniforms:{}},_dl:{opaque:[{buf:{}}]}});
        r._renderShadows();assert.equal(draws,1);assert.equal(enabled,initiallyOn);
    }
});

test('seasonal trees have finite outward geometry, varied silhouettes and bounded material batches',()=>{
 const s=context();
 for(const style of ['pine','bare','desert'])for(let v=0;v<4;v++)for(const mat of ['bark','foliage','snow']){
  const mesh=s.EngineMesh.seasonalTree(style,v,mat);
  assert.ok(mesh.positions.every(Number.isFinite));assert.ok(mesh.normals.every(Number.isFinite));
  assert.equal(s.EngineMesh.auditWinding(mesh),0,style+'/'+v+'/'+mat);
  assert.ok(mesh.positions.length/3<65536);
  if(style==='bare'&&mat!=='bark')assert.equal(mesh.indices.length,0);
 }
 assert.notDeepEqual(s.EngineMesh.seasonalTree('pine',0,'foliage'),s.EngineMesh.seasonalTree('pine',1,'foliage'));
 const r=Object.create(s.EngineRenderer.prototype);r._buf=(kind,args)=>({kind,args});
 r.tex={shadow:'shadow',worldBark:'bark',worldFoliage:'foliage',white:'snow'};
 for(const theme of ['winter','desert']){
  r._theme=theme;r._resEntries=new WeakMap();let bare=0;
  for(let i=0;i<20;i++){
   const res={type:'wood',x:i,z:0,amount:100},before={...res},e=r._resourceEntries(res,i);
   assert.ok(e.opaque.length<=3);assert.deepEqual(res,before);
   if(e.opaque[0].buf.args[0]==='bare'){bare++;assert.equal(e.opaque.length,1);}
  }
  assert.equal(bare,theme==='winter'?4:0);
 }
});

test('flat shoe soles stay slightly embedded throughout the humanoid stride',()=>{
 const s=context(),mesh=s.EngineMesh.shoe();
 const sole=mesh.positions.filter((_,i)=>i%3===1);
 assert.equal(Math.min(...sole),-.02);assert.ok(sole.filter(y=>y===-.02).length>10);
 const parts=s.EngineUnits.parts('worker',{civ:'greek',tier:1}).filter(p=>p.kind==='shoe');
 assert.equal(parts.length,2);
 for(let step=0;step<80;step++){
  const pose=s.EngineUnits.pose('worker','walk',step*.025),ys=[];
  for(const p of parts){
   const m=s.M3D.multiply(pose.mats[p.bone],p.m);
   for(let i=0;i<mesh.positions.length;i+=3)ys.push(m[1]*mesh.positions[i]+m[5]*mesh.positions[i+1]+m[9]*mesh.positions[i+2]+m[13]+pose.bob);
  }
  const low=Math.min(...ys);assert.ok(low>=-.04&&low<=0,'supporting sole must stay grounded: '+low);
 }
});

test('all building families and cultural finishes have valid geometry; tent doors follow the cone',()=>{
 const s=context(),checked=new Set();
 for(const civ of ['egyptian','greek','yamato','persian'])for(const age of ['stone','neolithic','bronze','iron'])for(const type of s.EngineBuildings.TYPES){
  const parts=s.EngineBuildings.parts(type,{civ,age});assert.ok(parts.length,type);
  for(const p of parts){
   assert.ok(p.m.every(Number.isFinite),type+'/'+civ+'/'+age);
   if(p.tint)assert.ok(p.tint.every(v=>Number.isFinite(v)&&v>=0));
   const key=p.kind+JSON.stringify(p.args);if(checked.has(key))continue;checked.add(key);
   const mesh=s.EngineMesh[p.kind](...p.args);assert.ok(mesh.positions.every(Number.isFinite));
   assert.equal(s.EngineMesh.auditWinding(mesh),0,key);
  }
 }
 for(const [type,r,h] of [['town_center',5.2,7.6],['house',2.6,4.3]]){
  const door=s.EngineBuildings.parts(type,{civ:'yamato',age:'stone'}).find(p=>p.tex==='white'&&p.tint?.[0]===.105);
  assert.ok(door);const slope=r*Math.cos(Math.PI/10)/h;
  for(const side of [-1,1]){
   const y=door.m[13]+side*door.args[1]/2*door.m[5],z=door.m[14]+side*door.args[1]/2*door.m[6];
   assert.ok(Math.abs(z-((h-y)*slope+.035))<1e-5,'door stays flush with sloping tent facet');
  }
 }
});

test('early stable and archery entrances face clear ground; stable hitching rail is beside the hall',()=>{
 const s=context();
 for(const civ of ['greek','egyptian','yamato','persian'])for(const age of ['neolithic','bronze'])for(const type of ['stable','archery_range']){
  const parts=s.EngineBuildings.parts(type,{civ,age});
  const door=parts.find(p=>p.kind==='box'&&p.tex==='bark'&&p.args[2]===.28&&p.m[14]>2);
  assert.ok(door,type+'/'+civ+'/'+age);assert.equal(door.m[12],0);
  assert.ok(Math.abs(door.m[13]-door.args[1]/2)<1e-6);
  if(type==='stable'){
   const rail=parts.find(p=>p.kind==='box'&&p.args[2]===4.8);
   assert.ok(rail);assert.ok(rail.m[12]<-4);assert.equal(rail.m[14],0);
  }
 }
});
