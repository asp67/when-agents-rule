const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const read=f=>fs.readFileSync(path.join(__dirname,'..',f),'utf8');
// The clutter builds tiles against a time budget and grows new tiles in over time (b1007).
// The tests own the clock: every reading advances it 1 ms (a stand-in for the work done
// between readings), and a test moves it on between frames with `later()`.
//
// Since build 1202 a tile is a list of where its tufts stand, drawn instanced: the tests
// read the lists (EngineGrass.instances) where they once read a tile's mesh.
function setup(){
    let id=0;const deleted=[],lists=[];const clock={t:1000};
    const scope={window:{M3D:{scaling:(...args)=>args}},GLCore:{createMeshBuffers:(_gl,m)=>({position:++id,normal:++id,uv:++id,index:++id,count:m.indices.length})},
        performance:{now:()=>(clock.t+=1)}};
    vm.createContext(scope);
    // The engine's own mesh helpers (how buffers are given back, since build 1179), with only the upload stood in for.
    {const upload=scope.GLCore.createMeshBuffers;vm.runInContext(read('js/engine/glcore.js'),scope);scope.GLCore=Object.assign(scope.window.GLCore,{createMeshBuffers:upload});}
    for(const f of ['js/simulation/rng.js','js/simulation/math.js','js/simulation/island.js','js/engine/texgen.js'])vm.runInContext(read(f),scope);
    scope.TexGen=scope.window.TexGen;
    vm.runInContext(read('js/engine/grass.js'),scope);
    // A context that can draw instanced (WebGL 2's own call), and that hands out and takes back buffers.
    const gl={deleteBuffer:b=>deleted.push(b),createBuffer:()=>++id,bindBuffer:()=>{},bufferData:(_t,data)=>lists.push(data.length),
        drawElementsInstanced:()=>{},vertexAttribDivisor:()=>{}};
    const renderer={gl,graphicsQuality:'cinematic',_halfH:25,
        cameraTarget:{x:0,z:0},terrain:{size:800,seed:'arena',resources:[]},buildings:[],tex:{white:{}},_theme:'summer',_cull:()=>false};
    const later=(ms=400)=>{clock.t+=ms;};
    return {G:scope.window.EngineGrass,GLCore:scope.GLCore,renderer,deleted,lists,clock,later};
}
const plain=v=>JSON.parse(JSON.stringify(v));
test('grass is reproducible, themed and finite, and the one tuft fits a 16-bit mesh',()=>{
    const {G}=setup();const m=plain(G.instances('seed',0,0,'summer',390,[]));
    assert.deepEqual(m,plain(G.instances('seed',0,0,'summer',390,[])));
    assert.notDeepEqual(m,plain(G.instances('other',0,0,'summer',390,[])));
    for(const theme of ['summer','winter','desert']){
        const list=G.instances('seed',0,0,theme,390,[]);
        assert.ok(list.tufts.every(Number.isFinite));
        assert.equal(list.tufts.length%4,0);
        if(theme!=='summer')assert.ok(list.tufts.length<m.tufts.length/2);
    }
    const tuft=G.tuftMesh();
    assert.equal(tuft.indices.length,G.INDICES_PER_TUFT);
    assert.ok(tuft.positions.every(Number.isFinite)&&tuft.normals.every(Number.isFinite));
    assert.ok(tuft.indices.every(i=>i>=0&&i<tuft.positions.length/3&&i<65536));
    // Base corners at the ground, tips up to a unit: the shader stretches a tuft from its base.
    const ys=tuft.positions.filter((_,i)=>i%3===1);
    assert.equal(Math.min(...ys),0.018);assert.equal(Math.max(...ys),1);
    assert.ok(ys.every(y=>y===0.018||y>0.5),'a corner is a base corner or a tip: the shader tells them apart at 0.1');
    assert.ok(tuft.uvs.every(v=>v>=0),'no corner of a tuft is marked as a pebble');
});
test('grass excludes building/resource footprints and the beach',()=>{
    const {G}=setup();
    const blockers=[{x:12,z:12,ex:20,ez:20}];
    assert.equal(G.instances('seed',0,0,'summer',390,blockers).tufts.length,0);
    assert.equal(G.instances('seed',30,30,'summer',390,[]).tufts.length,0);
});

test('dry ground generates no grass; green areas have dense low cover that takes the ground\'s colour',()=>{
    const {G}=setup();
    assert.equal(G.instances('seed',0,0,'summer',390,[],()=>0).tufts.length,0);
    const list=G.instances('seed',0,0,'summer',390,[],()=>1).tufts;
    assert.equal(list.length/4,G.TUFTS);
    for(let i=0;i<list.length;i+=4){
        assert.ok(list[i]>=0&&list[i]<=G.TILE&&list[i+1]>=0&&list[i+1]<=G.TILE,'a tuft stands in its tile');
        // The last two are the height times the cosine and the sine of the turn.
        const height=Math.hypot(list[i+2],list[i+3]);
        assert.ok(height>=0.16-1e-9&&height<=0.58+1e-9,'height '+height);
    }
    // The colour is read where the tuft stands: the shader makes the map's coordinate from
    // the placed corner, and the renderer tells it how wide the map is.
    const shader=read('js/engine/atmosphere.js');
    assert.match(shader,/if \(uInstanced > 0\.5\) vUv = stone \? vec2\(-1\.0, stoneShade\) : local\.xz \/ uInstanceWorld \+ 0\.5;/);
    assert.match(read('js/engine/gamerenderer.js'),/gl\.uniform1f\(this\.prog\.uniforms\.uInstanceWorld, TexGen\.TERRAIN_WORLD\);/);
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
    for(const f of ['js/simulation/rng.js','js/simulation/math.js','js/simulation/island.js','js/engine/texgen.js'])vm.runInContext(read(f),scope);
    scope.TexGen=scope.window.TexGen;
    vm.runInContext(read('js/engine/gamerenderer.js'),scope);
    const r=Object.create(scope.window.EngineRenderer.prototype),uploads=[];
    r.gl={createTexture:()=>({}),bindTexture:()=>{},pixelStorei:()=>{},texParameteri:()=>{},
        texImage2D:(...args)=>uploads.push(Array.from(args.at(-1)))};
    const fow={numTiles:2,visibilityVersion:1,fogGrid:new Float32Array([0,1,2,0])};
    r.game={fogOfWar:fow};r._syncFog();
    assert.deepEqual(uploads,[[0,255,255,0]]);
    fow.fogGrid[2]=1;fow.visibilityVersion++;r._syncFog();
    assert.deepEqual(uploads[1],[0,255,255,0],'leaving sight does not hide grass fragments');
});
test('the tiles obey upload, draw and cache budgets on both tiers and give back all buffers',()=>{
    const {G,renderer:r,deleted,later}=setup();const grass=new G.Grass(r);
    const frame=()=>{later();return grass.frame();};
    for(let f=0;f<20;f++){
        frame();
        // The frame's time budget (8 ms right after a cut, 4 ms after) bounds the uploads.
        assert.ok(r.grassStats.uploaded>=1||grass.cache.size>=G.MAX_VISIBLE||f>0);
        assert.ok(r.grassStats.uploaded<=8,'uploads per frame stay within the budget: '+r.grassStats.uploaded);
        assert.ok(r.grassStats.patches<=G.MAX_VISIBLE);
        assert.ok(r.grassStats.tufts<=G.MAX_VISIBLE*G.TUFTS*3);
        // One draw a tile for its tufts, and one for its pebbles where it has any.
        assert.ok(r.grassStats.batches<=r.grassStats.patches*2);
    }
    assert.ok(grass.cache.size>0);
    const near=r.grassStats.tufts;r._halfH=70;frame();assert.ok(r.grassStats.tufts<near);
    r._halfH=80;assert.ok(frame().length>0);
    r._halfH=90;frame();const wide=r.grassStats.tufts;
    r._halfH=125;assert.ok(frame().length>0);assert.ok(r.grassStats.tufts<wide);
    r._halfH=160;assert.equal(frame().length,0);
    // Low has no grass. (The renderer throws the tiles away when the tier changes: a tier sows its own.)
    r._halfH=25;r.graphicsQuality='low';assert.equal(frame().length,0);
    r.graphicsQuality='cinematic';
    for(let f=0;f<240;f++){r.cameraTarget.x=(f%8)*70-280;r.cameraTarget.z=(Math.floor(f/8)%8)*70-280;frame();}
    assert.ok(grass.cache.size<=G.MAX_CACHED);assert.ok(deleted.length>0);
    // A tile owns its list of tufts and, if it has pebbles, theirs; the two meshes are the grass's own.
    const buffers=[...grass.cache.values()].reduce((n,t)=>n+1+(t.stones?1:0),0)+8,before=deleted.length;grass.dispose();
    assert.equal(deleted.length-before,buffers);assert.equal(grass.cache.size,0);
});

test('the default tier has grass since build 1202: fewer tiles, half the tufts, one layer, no pebbles',()=>{
    const high=setup(),mid=setup();
    for(const s of [high,mid]){s.grass=new s.G.Grass(s.renderer);s.grass.cover=(x,z)=>(Math.sin(x*.3)+Math.sin(z*.3))*.25+.5;}
    mid.renderer.graphicsQuality='balanced';
    for(let f=0;f<60;f++){for(const s of [high,mid]){s.later();s.last=s.grass.frame();}}
    const H=high.renderer.grassStats,M=mid.renderer.grassStats,T=high.G.TIERS;
    assert.deepEqual(Object.keys(T),['cinematic','balanced']);
    assert.ok(mid.last.length>0,'the default tier draws grass');
    assert.ok(M.patches<=T.balanced.visible&&M.patches<H.patches);
    assert.equal(M.batches,M.patches,'one draw a tile: no pebbles');
    assert.ok([...mid.grass.cache.values()].every(t=>t.counts.length===1&&!t.stones),'one layer, no pebbles');
    assert.ok([...high.grass.cache.values()].some(t=>t.counts.length===3),'High adds the denser layers close by');
    assert.ok(M.tufts<H.tufts/3,'well under High: '+M.tufts+' against '+H.tufts);
    // Half of each tile's first layer, where the tile is at full height.
    const full=[...mid.grass.cache.values()].filter(t=>t.tufts.instances===Math.floor(t.counts[0]*.5));
    assert.ok(full.length>=3,'the tiles round the camera are at full height: '+full.length);
    assert.ok(mid.last.every(e=>e.vegetation&&e.noShadow&&e.buf.instance),'grass entries are instanced, cast nothing and sway');
});

test('a cut fills faster than one tile a frame, and new tiles grow in instead of popping',()=>{
    const {G,renderer:r,later}=setup();const grass=new G.Grass(r);grass.cover=()=>1;r._halfH=110;
    const first=grass.frame();
    assert.ok(r.grassStats.uploaded>1,'right after a cut, several tiles a frame: '+r.grassStats.uploaded);
    assert.ok([...grass.cache.values()].every(t=>t.counts.length===1),'a wide view builds base layers only');
    assert.equal(first.length,0,'nothing pops up at full height the frame it is built');
    const fresh=[...grass.cache.values()][0];
    later(150);grass.frame();const half=fresh.tufts.instances;
    later(400);grass.frame();const full=fresh.tufts.instances;
    assert.ok(half>0&&half<full,'it grows in: '+half+' then '+full);
});
test('resource clearings are circular, half-width, and refill after depletion or removal',()=>{
    const {G,renderer:r,deleted}=setup();r.cameraTarget={x:8,z:8};r._cull=(x,z)=>x!==8||z!==8;
    const node={x:8,z:8,type:'wood',amount:100};r.terrain.resources=[node];
    const grass=new G.Grass(r);grass.cover=()=>1;grass.frame();
    let tile=grass.cache.get('0:0');
    assert.equal(JSON.parse(tile.signature)[0].radius,1.05);
    const sparse=tile.counts[0];
    node.amount=0;grass.frame();
    tile=grass.cache.get('0:0');assert.ok(tile.counts[0]>sparse);
    // The old tile's list went back to the card (one buffer: with full cover it has no pebbles).
    assert.equal(deleted.length,1);assert.ok(r.grassStats.uploaded<=3);
    node.amount=100;node.type='gold';grass.frame();
    assert.equal(JSON.parse(grass.cache.get('0:0').signature)[0].radius,1.8);
    r.terrain.resources=[];grass.frame();
    assert.equal(grass.cache.get('0:0').counts[0],G.TUFTS);
    const list=G.instances('circle',0,0,'summer',390,[{x:8,z:8,radius:3}],()=>1).tufts;
    let corner=false;
    for(let i=0;i<list.length;i+=4){
        const x=list[i]-8,z=list[i+1]-8;
        assert.ok(x*x+z*z>=9-1e-9);
        if(Math.abs(x)<3&&Math.abs(z)<3)corner=true;
    }
    assert.ok(corner,'grass fills the corners outside the circular clearing');
});
test('new construction invalidates affected grass and leaves other patches cached',()=>{
    const {G,renderer:r,deleted}=setup();const grass=new G.Grass(r);
    grass.frame();
    r.buildings.push({health:100,x:12,z:12,_grassFootprint:{ex:20,ez:20}});
    grass.frame();assert.ok(deleted.length>=1);
    const tile=grass.cache.get('0:0');if(tile)assert.ok(tile.counts.every(n=>n===0));
    assert.ok(grass.cache.size>0);
});

test('the town is held against the tiles only when it has changed, not every frame',()=>{
    const {G,renderer:r,later}=setup();const grass=new G.Grass(r);grass.cover=()=>1;
    let reads=0;const watch=list=>{list.filter=function(f){reads++;return Array.prototype.filter.call(this,f);};return list;};
    r.buildings=watch([{health:100,x:40,z:40,_grassFootprint:{ex:4,ez:4}}]);
    // Until every tile in view is sown, the tiles still missing are held against the town as they are made.
    for(let i=0;i<200;i++){later();grass.frame();}
    assert.ok(reads>0&&grass.cache.size>=G.MAX_VISIBLE);
    reads=0;for(let i=0;i<10;i++){later();grass.frame();}
    assert.equal(reads,0,'ten frames of a town that stands still: its buildings are not listed once');
    const before=grass.cache.get('2:2').counts[0];
    // A building goes up: listed once, in that frame, and the tiles it touches are sown again.
    r.buildings.push({health:100,x:8,z:8,_grassFootprint:{ex:3,ez:3}});
    later();grass.frame();assert.equal(reads,1);
    assert.ok(grass.cache.get('0:0').counts[0]<G.TUFTS,'grass keeps off the new building');
    assert.equal(grass.cache.get('2:2').counts[0],before,'a tile it does not touch is kept');
    reads=0;later();grass.frame();assert.equal(reads,0);
    // It falls: the same.
    r.buildings[1].health=0;later();grass.frame();assert.equal(reads,1);
    later();grass.frame();assert.equal(grass.cache.get('0:0').counts[0],G.TUFTS);
});

test('three lush layers are one list, the denser ones after the first, and they go at wider zoom',()=>{
    const {G,renderer:r,later}=setup();
    const layers=[0,1,2].map(layer=>G.instances('seed',0,0,'summer',390,[],()=>1,layer).tufts);
    for(const l of layers)assert.equal(l.length/4,G.TUFTS);
    assert.notDeepEqual(plain(layers[0]),plain(layers[1]));
    assert.ok(Math.max(...layers[0].map((_,i)=>i%4===2?Math.hypot(layers[0][i],layers[0][i+1]):0))>.4);
    const grass=new G.Grass(r);grass.cover=()=>1;
    for(let i=0;i<40;i++){later();grass.frame();}
    const tile=grass.cache.get('0:0');
    assert.deepEqual(plain(tile.counts),[G.TUFTS,G.TUFTS*2,G.TUFTS*3],'a close tile has sown all three');
    assert.equal(tile.list.length,G.TUFTS*3*4);
    assert.equal(tile.tufts.instances,G.TUFTS*3,'and draws them all, in one draw');
    assert.equal(r.grassStats.batches,r.grassStats.patches);
    assert.ok(r.grassStats.tufts>r.grassStats.patches*G.TUFTS);
    r._halfH=60;later();grass.frame();
    assert.equal(tile.tufts.instances,G.TUFTS,'from further off the draw stops after the first layer');
    assert.ok(r.grassStats.tufts<=r.grassStats.patches*G.TUFTS,'no tile draws past its first layer');
});

test('dry-ground pebbles are tiny, static-tagged and deterministic, and drawn only from close by',()=>{
 const {G,renderer:r,later}=setup();
 const args=['pebbles',0,0,'desert',390,[],()=>0,0,true];
 const m=G.instances(...args);assert.ok(m.stones.length>0);assert.deepEqual(plain(m),plain(G.instances(...args)));
 assert.equal(m.tufts.length,0);assert.ok(m.stones.length/4<=G.TUFTS);
 for(let i=0;i<m.stones.length;i+=4){
  const across=Math.hypot(m.stones[i+2],m.stones[i+3])*G.STONE_RADIUS;
  assert.ok(across>=.055&&across<=.14,'a pebble is 5 to 14 cm: '+across);
 }
 assert.equal(G.instances('pebbles',0,0,'winter',390,[],()=>0,0,true).stones.length,0);
 assert.equal(G.instances('pebbles',0,0,'desert',390,[],()=>0,1,true).stones.length,0);
 assert.equal(G.instances('pebbles',0,0,'desert',390,[{x:8,z:8,ex:20,ez:20}],()=>0,0,true).stones.length,0);
 assert.equal(G.instances('pebbles',0,0,'desert',390,[],()=>0,0,false).stones.length,0,'a tier without pebbles sows none');
 // The one pebble: twelve triangles, low, every corner marked static, a flat top first.
 const s=G.stoneMesh();
 assert.equal(s.indices.length,36);assert.ok(s.normals.every(Number.isFinite));
 for(let i=0;i<s.positions.length;i+=3)assert.ok(s.positions[i+1]>=.005&&s.positions[i+1]<=.1);
 for(let i=0;i<s.uvs.length;i+=2)assert.equal(s.uvs[i],-1);
 const height=s.positions[1];
 for(let v=0;v<6;v++){assert.equal(s.positions[v*3+1],height);assert.ok(s.normals[v*3+1]>.99);}
 // In the frame: a tile's pebbles are a draw of their own, left out from where they are under a pixel.
 const grass=new G.Grass(r);grass.cover=()=>0;r._theme='desert';
 for(let i=0;i<30;i++){later();grass.frame();}
 assert.equal(r.grassStats.patches,0,'dry ground draws no tufts, and with no tufts drawn a tile is skipped');
 grass.dispose();grass.cover=(x)=>x>0?.5:0;
 for(let i=0;i<30;i++){later();grass.frame();}
 assert.ok(r.grassStats.batches>r.grassStats.patches,'pebbles are drawn close by');
 r._halfH=G.PEBBLE_HALF_H;later();grass.frame();
 assert.equal(r.grassStats.batches,r.grassStats.patches,'and not from the height where they are under a pixel');
});

test('clutter beyond the old 100-unit radius fades within the expanded circle',()=>{
 const {G,renderer:r,later}=setup();r._cull=(x,z)=>x!==120||z!==8;
 const grass=new G.Grass(r);grass.cover=()=>1;
 grass.frame();later();
 const entries=grass.frame();assert.ok(entries.length>0);
 const tile=grass.cache.get('7:0');assert.ok(tile);
 assert.ok(tile.tufts.instances<tile.counts[0]);
 r.cameraTarget.x=-40;assert.equal(grass.frame().length,0,'outside the 150-unit circle');
});

// ---- instancing (build 1202) ------------------------------------------------------------
function recorder(extra={}){
    const calls=[];let id=0;
    const gl=new Proxy(Object.assign({TRIANGLES:4,UNSIGNED_SHORT:5123,ARRAY_BUFFER:34962,ELEMENT_ARRAY_BUFFER:34963,STATIC_DRAW:35044,FLOAT:5126},extra),{
        get:(t,k)=>k in t?t[k]:(typeof k==='string'&&!k.startsWith('_')?(t[k]=(...a)=>{calls.push([k,...a]);return k.startsWith('create')?{id:++id}:undefined;}):undefined),
        set:(t,k,v)=>{t[k]=v;return true;},has:(t,k)=>k in t});
    return {gl,calls};
}
function glcore(){const scope={window:{}};vm.createContext(scope);vm.runInContext(read('js/engine/glcore.js'),scope);return scope.window.GLCore;}

test('an instanced mesh shares its mesh\'s buffers, owns its list, and is drawn once for each entry',()=>{
    const G=glcore(),{gl,calls}=recorder({drawElementsInstanced:(...a)=>calls.push(['drawElementsInstanced',...a]),vertexAttribDivisor:(...a)=>calls.push(['vertexAttribDivisor',...a]),
        createVertexArray:()=>({}),bindVertexArray:()=>{},deleteVertexArray:()=>{}});
    const mesh={position:{p:1},normal:{n:1},uv:{u:1},bone:null,index:{i:1},count:36};
    const list=G.createInstances(gl,mesh,new Float32Array(40));
    assert.equal(list.instances,10);assert.equal(list.capacity,10);assert.ok(list.shared);
    assert.equal(list.position,mesh.position);assert.equal(list.index,mesh.index);assert.equal(list.count,36);
    const program={attribs:{aPosition:0,aNormal:1,aUv:2,aBone:3,aInstance:4}};
    calls.length=0;G.drawMesh(gl,program,list);
    assert.deepEqual(calls.find(c=>c[0]==='vertexAttribPointer'&&c[1]===4).slice(1,3),[4,4],'four numbers an entry');
    assert.deepEqual(calls.find(c=>c[0]==='vertexAttribDivisor').slice(1),[4,1],'one entry a drawing, not one a corner');
    assert.deepEqual(calls.at(-1),['drawElementsInstanced',4,36,5123,0,10]);
    // Fewer entries: just a shorter way into the list. Never past its end.
    list.instances=3;calls.length=0;G.drawMesh(gl,program,list);
    assert.deepEqual(calls,[['drawElementsInstanced',4,36,5123,0,3]],'the array remembers where the buffers are');
    list.instances=99;calls.length=0;G.drawMesh(gl,program,list);assert.equal(calls[0][5],10);
    list.instances=0;calls.length=0;G.drawMesh(gl,program,list);assert.equal(calls.length,0,'nothing to draw is no draw');
    // A longer list is sent again whole.
    G.setInstances(gl,list,new Float32Array(80));assert.equal(list.instances,20);assert.equal(list.capacity,20);
    // A plain mesh under the same program says it has no list (where there are no arrays the setting would be left over).
    const plainMesh={position:{},normal:{},uv:{},bone:null,index:{},count:6};
    calls.length=0;G.drawMesh(gl,program,plainMesh);
    assert.ok(calls.some(c=>c[0]==='disableVertexAttribArray'&&c[1]===4));
    assert.deepEqual(calls.find(c=>c[0]==='vertexAttribDivisor').slice(1),[4,0]);
    assert.equal(calls.at(-1)[0],'drawElements');
    // Given back: the list and its arrays, not the mesh it placed.
    calls.length=0;G.deleteMeshBuffers(gl,list);
    assert.deepEqual(calls.filter(c=>c[0]==='deleteBuffer').map(c=>c[1]),[list.instance]);
});

test('without instancing nothing instanced is drawn, and there is no grass',()=>{
    const G=glcore(),calls=[],gl={getExtension:()=>null,drawElements:()=>calls.push(['drawElements'])};
    assert.equal(G.instancingOf(gl),null);
    const list={position:{},normal:{},uv:{},bone:null,index:{},count:36,shared:true,instance:{},instances:5,capacity:5};
    calls.length=0;G.drawMesh(gl,{attribs:{aPosition:0}},list);
    assert.ok(!calls.some(c=>/^draw/.test(c[0])));
    // WebGL 1 with the extension: its own calls.
    const ext={vertexAttribDivisorANGLE:()=>{},drawElementsInstancedANGLE:(...a)=>calls.push(['ANGLE',...a])};
    const inst=G.instancingOf({TRIANGLES:4,UNSIGNED_SHORT:5123,getExtension:n=>n==='ANGLE_instanced_arrays'?ext:null});assert.ok(inst);inst.draw(36,7);
    assert.deepEqual(calls.at(-1),['ANGLE',4,36,5123,0,7]);
    const {G:Grass,renderer:r}=setup();delete r.gl.drawElementsInstanced;r.gl.getExtension=()=>null;
    const grass=new Grass.Grass(r);assert.equal(grass.can,false);assert.equal(grass.frame().length,0);
});

test('the shader places an instanced tuft by its entry and leaves every other mesh as it was',()=>{
    const s=read('js/engine/atmosphere.js');
    assert.match(s,/attribute vec4 aInstance;\s+uniform float uInstanced, uInstanceWorld;/);
    // A tuft keeps its base and is stretched from there; a pebble is scaled whole; both are turned and set down.
    assert.match(s,/float size = length\(aInstance\.zw\);\s+if \(stone\) p \*= size;\s+else if \(p\.y > 0\.1\) \{ p\.y \*= size; p\.xz \*= size; \}\s+float c = aInstance\.z \/ size, s = aInstance\.w \/ size;/);
    assert.doesNotMatch(s.slice(s.indexOf('if (uInstanced > 0.5) {'),s.indexOf('vec4 world = uModel * local;')),/\b(cos|sin)\(aInstance/,'no angle is worked out for each corner');
    assert.match(s,/local\.xyz = vec3\(c\*p\.x \+ s\*p\.z \+ aInstance\.x, p\.y, c\*p\.z - s\*p\.x \+ aInstance\.y\);/);
    // The sway and the tip's lighter green go by the placed height, not the one tuft's.
    assert.match(s,/vGrassTip = clamp\(\(\(uInstanced > 0\.5 \? local\.y : aPosition\.y\)-0\.018\) \/ 0\.562, 0\.0, 1\.0\);/);
    const r=read('js/engine/gamerenderer.js');
    assert.match(r,/const inst = obj\.buf\.instance \? 1 : 0;\s+if \(inst !== instanced\) \{ gl\.uniform1f\(U\.uInstanced, inst\); instanced = inst; \}/);
    // Every tier that has grass draws it, and a change of tier begins afresh.
    assert.match(r,/if \(!inset && typeof EngineGrass !== 'undefined' && EngineGrass\.TIERS\[this\.graphicsQuality\]\) \{/);
    assert.match(r,/if \(this\._grass\) \{ this\._grass\.dispose\(\); this\._grass = null; \}\s+EngineAtmosphere\.disposeShadowTarget/);
});

test('the frame meter counts an instanced draw as one draw and all its triangles',()=>{
    const scope={window:{},performance:{now:()=>0}};vm.createContext(scope);vm.runInContext(read('js/engine/perf.js'),scope);
    const drawn=[];
    const gl={TRIANGLES:4,TRIANGLE_STRIP:5,TRIANGLE_FAN:6,drawElements(){},drawArrays(){},drawElementsInstanced(...a){drawn.push(a);},getExtension:()=>null};
    const real=gl.drawElementsInstanced;
    const meter=new scope.window.EnginePerf.Meter(gl);
    meter.setDetail(true);
    meter.frameBegin(0);gl.drawElementsInstanced(4,36,5123,0,1000);gl.drawElements(4,6,5123,0);meter.frameEnd();
    assert.equal(meter.draws,2);assert.equal(meter.tris,12*1000+2);
    assert.deepEqual(drawn,[[4,36,5123,0,1000]],'the draw still reaches the card');
    meter.setDetail(false);
    assert.equal(gl.drawElementsInstanced,real,'and the context has its own call back');
});

// ---- gusts (build 1203) -----------------------------------------------------------------
test('gusts travel across the grass with the wind, and between gusts it flutters as it always did',()=>{
    const s=read('js/engine/atmosphere.js');
    // A front is a wave along the wind that moves forward in time, its line bent by a slow wave across it.
    assert.match(s,/const vec2 wind = vec2\(0\.866, 0\.5\);\s+float along = dot\(world\.xz, wind\), across = dot\(world\.xz, vec2\(-wind\.y, wind\.x\)\);\s+float front = sin\(along\*0\.09 - uGrassTime\*0\.8 \+ 1\.7\*sin\(across\*0\.031 \+ uGrassTime\*0\.1\)\);/);
    assert.match(s,/vGust = uGust \* smoothstep\(0\.3, 1\.0, front\);/);
    // In a gust: a lean with the wind and a harder flutter. With no gust (vGust 0) what is left is the flutter of old.
    assert.match(s,/world\.xz \+= \(vec2\(0\.045,0\.025\)\*flutter\*\(1\.0 \+ 0\.8\*vGust\) \+ wind\*0\.12\*vGust\) \* bend;/);
    assert.match(s,/float flutter = sin\(world\.x\*0\.17 \+ world\.z\*0\.11 \+ uGrassTime\*1\.3\)\s+\+ 0\.45\*sin\(world\.x\*0\.37 - world\.z\*0\.23 \+ uGrassTime\*2\.1\);/);
    assert.match(s,/float bend = vGrassTip\*vGrassTip\*uModel\[1\]\[1\];/);
    // The same phase a moment later is further along the wind: about nine units a second, seventy from front to front.
    const speed=0.8/0.09,apart=2*Math.PI/0.09;
    assert.ok(speed>8&&speed<10&&apart>60&&apart<80);
    const front=(along,t)=>Math.sin(along*0.09-t*0.8);
    assert.ok(Math.abs(front(30,2)-front(30+speed*3,5))<1e-9);
    // The clock wraps every twenty pi seconds: every factor of it is a tenth, so nothing jumps then.
    const factors=[...s.matchAll(/uGrassTime\*([0-9.]+)/g)].map(m=>Number(m[1]));
    assert.ok(factors.length>=4);
    for(const f of factors)assert.ok(Math.abs(f*10-Math.round(f*10))<1e-9,'a factor of '+f+' would jump at the wrap');
    assert.match(read('js/engine/gamerenderer.js'),/gl\.uniform1f\(this\.prog\.uniforms\.uGrassTime,\(now\/1000\)%\(Math\.PI\*20\)\);/);
    // Bent over, the blades are paler toward the tip; pebbles and everything else are untouched.
    assert.match(s,/if \(uVegetation > 0\.5\) base \*= mix\(0\.90,1\.06,vGrassTip\) \* \(1\.0 \+ 0\.15\*vGust\*vGrassTip\);/);
    assert.match(s,/vGust = 0\.0;\s+if \(uVegetation > 0\.5 && vPebble < 0\.5\) \{/);
    // Both shaders name the varying alike.
    assert.equal((s.match(/varying mediump float vGust;|varying mediump float vGrassTip, vPebble, vGust;/g)||[]).length,2);
});

test('a viewer who asked for less motion gets no gusts',()=>{
    assert.match(read('js/engine/gamerenderer.js'),/gl\.uniform1f\(this\.prog\.uniforms\.uGust,this\._reducedMotion\?0:1\);/);
});
