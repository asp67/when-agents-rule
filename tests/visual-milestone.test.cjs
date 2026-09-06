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
    for(const name of ['math3d','mesh','texgen','atmosphere','buildings','gamerenderer']) {
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
