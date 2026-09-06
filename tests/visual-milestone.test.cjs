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
    const gl={calls,FRAMEBUFFER_COMPLETE:123,FRAMEBUFFER:1,TEXTURE_2D:2,RENDERBUFFER:3,
        createTexture:()=>({texture:++id}),createRenderbuffer:()=>({depth:++id}),createFramebuffer:()=>({fb:++id}),
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
    assert.equal(gl.calls.at(-1)[0],'bindFramebuffer');assert.equal(gl.calls.at(-1)[2],null);
    assert.ok(Array.from(r._lightMatrix).every(Number.isFinite));
    r.visualStyle='classic';drawn.length=0;r._renderShadows();assert.equal(drawn.length,0);
});

test('all civilization/unit tiers produce outward, finite geometry within WebGL 1 index limits',()=>{
    const s=context();
    for(const civ of ['greek','egyptian','yamato','persian']) {
        for(const type of s.EngineUnits.TYPES) for(const tier of [1,2,3]) {
            const options={civ,tier,badge:'circle'};
            const parts=s.EngineUnits.parts(type,options), batches=s.EngineUnits.batches(parts);
            assert.deepEqual(options,{civ,tier,badge:'circle'},'composition must not mutate caller options');
            for(const b of batches) {
                const label=`${civ}/${type}/${tier}/${b.tex}/${b.bone}`;
                assert.ok(b.mesh.positions.every(Number.isFinite),label);
                assert.ok(b.mesh.normals.every(Number.isFinite),label);
                assert.equal(s.EngineMesh.auditWinding(b.mesh),0,label);
                assert.ok(b.mesh.indices.every(i=>i>=0 && i<65536 && i<b.mesh.positions.length/3),label);
            }
            if(type==='infantry' && tier>=2) assert.ok(batches.length<=20,'armor detail must stay batched');
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
    Object.assign(r,{_resEntries:new WeakMap(),_theme:'summer',tex:{shadow:'shadow',bark:'bark',foliage:'foliage'}});
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
