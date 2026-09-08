const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const scope={window:{}};vm.createContext(scope);
for(const file of ['math3d','mesh','buildings'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../js/engine/'+file+'.js'),'utf8'),scope);
test('courtyard props stay outside the building and leave the central entrance clear',()=>{
 const foot={ex:6,ez:5};
 for(const civ of ['greek','egyptian','persian','yamato'])for(const type of ['house','town_center','market']){
  const dressing=scope.window.EngineBuildings.settlement(type,civ,foot);
  assert.ok(dressing.parts.length<=10);
  for(const p of dressing.parts){
   const mesh=scope.window.EngineMesh[p.kind](...p.args);
   assert.ok(mesh.positions.every(Number.isFinite));
   assert.ok(Array.from(p.m).every(Number.isFinite));
   assert.ok(p.m[12]<-foot.ex+.5,'props remain beside the wall, away from the doorway');
  }
  assert.equal(!!dressing.fire,type!=='market');
 }
 for(const type of ['farm','tower','barracks','wonder'])assert.equal(scope.window.EngineBuildings.settlement(type,'greek',foot).parts.length,0);
});

test('entrance lamps vary by era, have finite geometry and stand clear of doors and hitching rails',()=>{
 const foot={ex:6,ez:5};
 for(const civ of ['greek','egyptian','persian','yamato'])for(const age of ['stone','neolithic','bronze','iron']){
  const lamp=scope.window.EngineBuildings.entranceLamp('stable',age,civ,foot);
  assert.equal(lamp.early,['stone','neolithic'].includes(age));
  assert.ok(lamp.light[0]<-1.1&&lamp.light[0]>-3.5);
  if(lamp.early)assert.ok(lamp.light[2]>foot.ez);
  else {
   assert.ok(lamp.mount&&Math.abs(lamp.light[2]-lamp.mount.z-.32)<1e-6);
   assert.ok(lamp.parts.every(p=>p.m[13]>.5),'later lamps have no ground posts or bases');
  }
  assert.ok(lamp.parts.length<=8);
  for(const p of lamp.parts){
   assert.ok(scope.window.EngineMesh[p.kind](...p.args).positions.every(Number.isFinite));
   assert.ok(Array.from(p.m).every(Number.isFinite));
  }
 }
 assert.equal(scope.window.EngineBuildings.entranceLamp('farm','iron','greek',foot).parts.length,0);
});

test('later lamps find a supported facade on every cultural building, including open temples',()=>{
 for(const civ of ['greek','egyptian','persian','yamato'])for(const age of ['bronze','iron'])
 for(const type of scope.window.EngineBuildings.TYPES.filter(t=>t!=='farm')){
  const lamp=scope.window.EngineBuildings.entranceLamp(type,age,civ,{ex:8,ez:8});
  assert.ok(lamp.mount,`${civ} ${age} ${type} needs a supported mount`);
 }
});

test('town centers support both sides and wonders retain paired freestanding lamps',()=>{
 for(const civ of ['greek','egyptian','persian','yamato'])for(const side of [-1,1]){
  const tc=scope.window.EngineBuildings.entranceLamp('town_center','iron',civ,{ex:8,ez:8},undefined,side);
  assert.ok(tc.light&&Math.sign(tc.light[0])===side);
  const wonder=scope.window.EngineBuildings.entranceLamp('wonder','iron',civ,{ex:8,ez:8},undefined,side,true);
  assert.ok(wonder.light&&Math.sign(wonder.light[0])===side);
  assert.ok(wonder.parts.some(p=>p.m[13]<.1),'wonder lamp retains a grounded base');
 }
});
