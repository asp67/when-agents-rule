const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
function setup(){
    let id=0;const deleted=[];
    const scope={window:{M3D:{scaling:(...args)=>args}},GLCore:{createMeshBuffers:(_gl,m)=>({position:++id,normal:++id,uv:++id,index:++id,count:m.indices.length})}};
    vm.createContext(scope);
    vm.runInContext(fs.readFileSync(path.join(__dirname,'../js/engine/texgen.js'),'utf8'),scope);
    scope.TexGen=scope.window.TexGen;
    vm.runInContext(fs.readFileSync(path.join(__dirname,'../js/engine/grass.js'),'utf8'),scope);
    const renderer={gl:{deleteBuffer:b=>deleted.push(b)},graphicsQuality:'cinematic',_halfH:25,
        cameraTarget:{x:0,z:0},terrain:{size:800,seed:'arena',resources:[]},buildings:[],tex:{white:{}},_theme:'summer',_cull:()=>false};
    return {G:scope.window.EngineGrass,renderer,deleted};
}
test('grass is reproducible, themed, finite and within WebGL 1 mesh limits',()=>{
    const {G}=setup();const m=G.mesh('seed',0,0,'summer',390,[]);
    assert.deepEqual(m,G.mesh('seed',0,0,'summer',390,[]));
    assert.notDeepEqual(m,G.mesh('other',0,0,'summer',390,[]));
    for(const theme of ['summer','winter','desert']){
        const mesh=G.mesh('seed',0,0,theme,390,[]);
        assert.ok(mesh.positions.every(Number.isFinite));
        assert.ok(mesh.indices.every(i=>i>=0&&i<mesh.positions.length/3&&i<65536));
        assert.equal(mesh.indices.length%G.INDICES_PER_TUFT,0);
        if(theme!=='summer')assert.ok(mesh.indices.length<m.indices.length/2);
    }
});
test('grass excludes building/resource footprints and the beach',()=>{
    const {G}=setup();
    const blockers=[{x:12,z:12,ex:20,ez:20}];
    assert.equal(G.mesh('seed',0,0,'summer',390,blockers).indices.length,0);
    assert.equal(G.mesh('seed',30,30,'summer',390,[]).indices.length,0);
});

test('dry ground generates no grass; green areas have dense low cover with ground-aligned UVs',()=>{
    const {G}=setup();
    assert.equal(G.mesh('seed',0,0,'summer',390,[],()=>0).indices.length,0);
    const mesh=G.mesh('seed',0,0,'summer',390,[],()=>1);
    assert.equal(mesh.indices.length/G.INDICES_PER_TUFT,G.TUFTS);
    for(let i=0;i<mesh.positions.length;i+=3){
        assert.ok(mesh.positions[i+1]>=0.018&&mesh.positions[i+1]<=0.58);
        assert.equal(mesh.uvs[i/3*2],mesh.positions[i]/1000+.5);
        assert.equal(mesh.uvs[i/3*2+1],mesh.positions[i+2]/1000+.5);
    }
});

test('clutter stays on explored terrain after units leave, but never on unexplored terrain',()=>{
    const {G,renderer:r}=setup();const fow={mapSize:800,gridSize:2,numTiles:400,visibilityVersion:1,fogGrid:new Float32Array(160000)};
    r.game={fogOfWar:fow};const grass=new G.Grass(r);
    assert.equal(grass.frame().length,0);assert.equal(r.grassStats.uploaded,0);
    fow.fogGrid[200*400+200]=2;fow.visibilityVersion++;
    grass.frame();assert.ok(r.grassStats.uploaded>0);
    assert.equal(G.visibleRect(fow,1,1,3,3,true),false,'a whole decoration must be explored');
    fow.fogGrid[200*400+200]=1;fow.visibilityVersion++;
    assert.ok(grass.frame().length>0,'grass remains after the scouting unit leaves');
    fow.fogGrid.fill(1);fow.visibilityVersion++;
    assert.ok(grass.frame().length>0);
    assert.equal(G.visibleRect(fow,1,1,3,3,true),true,'decorations remain on explored land');
    fow.fogGrid.fill(0);fow.visibilityVersion++;
    assert.equal(grass.frame().length,0);
});
test('grass shader mask reveals both explored and currently visible cells',()=>{
    const scope={window:{}};vm.createContext(scope);
    vm.runInContext(fs.readFileSync(path.join(__dirname,'../js/engine/texgen.js'),'utf8'),scope);
    scope.TexGen=scope.window.TexGen;
    vm.runInContext(fs.readFileSync(path.join(__dirname,'../js/engine/gamerenderer.js'),'utf8'),scope);
    const r=Object.create(scope.window.EngineRenderer.prototype),uploads=[];
    r.gl={createTexture:()=>({}),bindTexture:()=>{},pixelStorei:()=>{},texParameteri:()=>{},
        texImage2D:(...args)=>uploads.push(Array.from(args.at(-1)))};
    const fow={numTiles:2,visibilityVersion:1,fogGrid:new Float32Array([0,1,2,0])};
    r.game={fogOfWar:fow};r._syncFog();
    assert.deepEqual(uploads,[[0,255,255,0]]);
    fow.fogGrid[2]=1;fow.visibilityVersion++;r._syncFog();
    assert.deepEqual(uploads[1],[0,255,255,0],'leaving sight does not hide grass fragments');
});
test('cinematic batches obey upload, draw and cache budgets and dispose all buffers',()=>{
    const {G,renderer:r,deleted}=setup();const grass=new G.Grass(r);
    for(let frame=0;frame<20;frame++){
        grass.frame();assert.ok(r.grassStats.uploaded<=3);assert.ok(r.grassStats.patches<=G.MAX_VISIBLE);
        assert.ok(r.grassStats.tufts<=G.MAX_VISIBLE*G.TUFTS*3);
    }
    assert.ok(grass.cache.size>0);
    const near=r.grassStats.tufts;r._halfH=70;grass.frame();assert.ok(r.grassStats.tufts<near);
    r._halfH=80;assert.ok(grass.frame().length>0);
    r._halfH=90;grass.frame();const wide=r.grassStats.tufts;
    r._halfH=125;assert.ok(grass.frame().length>0);assert.ok(r.grassStats.tufts<wide);
    r._halfH=160;assert.equal(grass.frame().length,0);
    r._halfH=25;r.graphicsQuality='balanced';assert.equal(grass.frame().length,0);
    r.graphicsQuality='cinematic';
    for(let frame=0;frame<240;frame++){r.cameraTarget.x=(frame%8)*70-280;r.cameraTarget.z=(Math.floor(frame/8)%8)*70-280;grass.frame();}
    assert.ok(grass.cache.size<=G.MAX_CACHED);assert.ok(deleted.length>0);
    const count=grass.cache.size,before=deleted.length;grass.dispose();
    assert.equal(deleted.length-before,count*12);assert.equal(grass.cache.size,0);
});
test('resource clearings are circular, half-width, and refill after depletion or removal',()=>{
    const {G,renderer:r,deleted}=setup();r.cameraTarget={x:8,z:8};r._cull=(x,z)=>x!==8||z!==8;
    const node={x:8,z:8,type:'wood',amount:100};r.terrain.resources=[node];
    const grass=new G.Grass(r);grass.cover=()=>1;grass.frame();
    let tile=grass.cache.get('0:0');
    assert.equal(JSON.parse(tile.signature)[0].radius,1.05);
    const sparse=tile.batches[0].fullCount;
    node.amount=0;grass.frame();
    tile=grass.cache.get('0:0');assert.ok(tile.batches[0].fullCount>sparse);
    assert.equal(deleted.length,12);assert.ok(r.grassStats.uploaded<=3);
    node.amount=100;node.type='gold';grass.frame();
    assert.equal(JSON.parse(grass.cache.get('0:0').signature)[0].radius,1.8);
    r.terrain.resources=[];grass.frame();
    assert.equal(grass.cache.get('0:0').batches[0].fullCount,G.TUFTS*G.INDICES_PER_TUFT);
    const mesh=G.mesh('circle',0,0,'summer',390,[{x:8,z:8,radius:3}],()=>1);
    let corner=false;
    for(let i=0;i<mesh.positions.length;i+=108){
        const x=(mesh.positions[i]+mesh.positions[i+3])/2-8;
        const z=(mesh.positions[i+2]+mesh.positions[i+5])/2-8;
        assert.ok(x*x+z*z>=9-1e-9);
        if(Math.abs(x)<3&&Math.abs(z)<3)corner=true;
    }
    assert.ok(corner,'grass fills the corners outside the circular clearing');
});
test('new construction invalidates affected grass and leaves other patches cached',()=>{
    const {G,renderer:r,deleted}=setup();const grass=new G.Grass(r);
    grass.frame();
    r.buildings.push({health:100,x:12,z:12,_grassFootprint:{ex:20,ez:20}});
    grass.frame();assert.ok(deleted.length>=4);
    const tile=grass.cache.get('0:0');if(tile)assert.ok(tile.batches.every(b=>b.fullCount===0));
    assert.ok(grass.cache.size>0);
});

test('three independent lush layers fit 16-bit buffers and extra layers disappear at wider zoom',()=>{
    const {G,renderer:r}=setup();
    const meshes=[0,1,2].map(layer=>G.mesh('seed',0,0,'summer',390,[],()=>1,1000,layer));
    for(const m of meshes){
        assert.equal(m.indices.length/G.INDICES_PER_TUFT,G.TUFTS);
        assert.ok(m.positions.length/3<65536);
        assert.ok(m.indices.every(i=>i<m.positions.length/3));
    }
    assert.notDeepEqual(meshes[0].positions,meshes[1].positions);
    const heights=meshes[0].positions.filter((_,i)=>i%3===1);
    assert.ok(Math.max(...heights)>.4);
    const grass=new G.Grass(r);
    for(let i=0;i<12;i++)grass.frame();
    assert.ok(r.grassStats.batches>r.grassStats.patches);
    r._halfH=60;grass.frame();
    assert.equal(r.grassStats.batches,r.grassStats.patches);
});

test('dry-ground pebbles are tiny, static-tagged, deterministic and use the existing mesh budget',()=>{
 const {G}=setup();
 const args=['pebbles',0,0,'desert',390,[],()=>0,1000,0,true];
 const m=G.mesh(...args);assert.ok(m.indices.length>0);assert.deepEqual(m,G.mesh(...args));
 assert.ok(m.indices.length<=G.TUFTS*G.INDICES_PER_TUFT);
 assert.ok(m.positions.length/3<65536);assert.ok(m.normals.every(Number.isFinite));
 for(let i=0;i<m.positions.length;i+=3)assert.ok(m.positions[i+1]>=.005&&m.positions[i+1]<=.1);
 for(let i=0;i<m.uvs.length;i+=2)assert.equal(m.uvs[i],-1);
 // Each stone begins with two upward-facing triangles sharing a flat top.
 for(let i=0;i<m.positions.length;i+=108){
  const height=m.positions[i+1];
  for(let v=0;v<6;v++){
   assert.equal(m.positions[i+v*3+1],height);
   assert.ok(m.normals[i+v*3+1]>.99);
  }
 }
 assert.equal(G.mesh('pebbles',0,0,'winter',390,[],()=>0,1000,0,true).indices.length,0);
 assert.equal(G.mesh('pebbles',0,0,'desert',390,[],()=>0,1000,1,true).indices.length,0);
 assert.equal(G.mesh('pebbles',0,0,'desert',390,[{x:8,z:8,ex:20,ez:20}],()=>0,1000,0,true).indices.length,0);
});

test('clutter beyond the old 100-unit radius fades within the expanded circle',()=>{
 const {G,renderer:r}=setup();r._cull=(x,z)=>x!==120||z!==8;
 const grass=new G.Grass(r);grass.cover=()=>1;
 const entries=grass.frame();assert.ok(entries.length>0);
 const tile=grass.cache.get('7:0');assert.ok(tile);
 assert.ok(tile.batches[0].buf.count<tile.batches[0].fullCount);
 r.cameraTarget.x=-40;assert.equal(grass.frame().length,0,'outside the 150-unit circle');
});
