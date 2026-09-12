const assert=require('node:assert/strict');
module.exports=async function checkLightRange(page){
 const samples=await page.evaluate(()=>{
  const r=game.renderer,u=r.units.find(u=>u.type==='worker'),b=r.buildings.find(b=>b._engine?.fire&&b._engine?.lamps?.length);
  if(!u||!b)throw Error('A worker and a building with lamps/campfire are required');
  const saved={units:r.units,buildings:r.buildings,cull:r._cull,x:r.cameraTarget.x,z:r.cameraTarget.z,zoom:r._halfH,ux:u.x,uz:u.z,fow:game.fogOfWar};
  try{
   r.units=[u];r.buildings=[b];r._cull=()=>false;game.fogOfWar=null;u.x=b.x;u.z=b.z;
   const sample=(distance,zoom)=>{
    r.cameraTarget.x=b.x+distance;r.cameraTarget.z=b.z;r._halfH=zoom;
    r._assembleFrame(0,0,M3D.identity());
    const lights=b._engine.opaque.find(e=>e.localLights)?.localLights;
    return {worker:u._engine.lampLights?.[3]||0,lamps:lights?.[3]||0,fire:lights?.[b._engine.lamps.length*4+3]||0};
   };
   const position=EngineUnits.WORKER_LANTERN_POSITION,parts=EngineUnits.workerLantern(),flame=parts.find(p=>p.blend),lid=parts.find(p=>p.tex==='iron'&&p.kind==='cylinder'&&p.m[13]>position[1]);
   return {distance:[0,300,420,510,600].map(d=>sample(d,20)),zoom:[20,300,390,495,600].map(z=>sample(0,z)),right:position[0]<0,clearance:lid.m[13]-lid.args[2]/2-(flame.m[13]+flame.args[2]/2),flameDrawn:r._workerLampModel.some(p=>p.flame)};
  }finally{r.units=saved.units;r.buildings=saved.buildings;r._cull=saved.cull;r.cameraTarget.x=saved.x;r.cameraTarget.z=saved.z;r._halfH=saved.zoom;u.x=saved.ux;u.z=saved.uz;game.fogOfWar=saved.fow;}
 });
 assert.ok(samples.right&&samples.clearance>0&&samples.flameDrawn,'right hip and a separate flame below the lid');
 for(const axis of ['distance','zoom'])for(const source of ['worker','lamps','fire']){
  const values=samples[axis].map(s=>s[source]);assert.ok(values[0]>0,source+' must emit light');
  for(const i of [1,2])assert.ok(Math.abs(values[i]/values[0]-1)<.001,source+' retains full light beyond the previous cutoff');
  assert.ok(Math.abs(values[3]/values[0]-.5)<.001,source+' fades smoothly at the doubled midpoint');
  assert.equal(values[4],0,source+' ends at the doubled cutoff');
 }
 return samples;
};
