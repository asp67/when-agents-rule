const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const scope={window:{}};vm.createContext(scope);
vm.runInContext(fs.readFileSync(require('node:path').join(__dirname,'../js/engine/atmosphere.js'),'utf8'),scope);
const sun=[.96,.84,.66],sky=[.42,.60,.79],at=t=>scope.window.EngineAtmosphere.daylight(t,sun,sky);
test('day cycle preserves noon, stays readable at night and wraps continuously',()=>{
 assert.deepEqual(Array.from(at(0).sun),sun);assert.deepEqual(Array.from(at(0).sky),sky);
 assert.equal(at(360).night,1);assert.equal(at(720).night,0);
 for(let t=0;t<720;t+=.5){
  const a=at(t),b=at(t+.5);
  for(const key of ['sun','sky'])a[key].forEach((v,i)=>{
   assert.ok(Number.isFinite(v)&&v>=.07&&v<=1);
   assert.ok(Math.abs(v-b[key][i])<.015,'no sudden lighting step');
  });
 }
 assert.deepEqual(at(720),at(0));assert.deepEqual(at(720*100+180),at(180));
 assert.ok(at(180).sun[0]>at(180).sun[2],'warm dusk');
 assert.deepEqual(sun,[.96,.84,.66]);
});

test('real ticks keep ambient time at 1x while simulation accelerates, and freeze it on pause',()=>{
 const source=fs.readFileSync(require('node:path').join(__dirname,'../js/game.js'),'utf8');
 const context=vm.createContext({document:{hidden:true},Date:{now:()=>1000}});
 vm.runInContext(source.slice(0,source.indexOf('\nconst WAR_PRIVATE_HOST')),context);
 for(const speed of [1,1.5,2,4])for(const pauseState of ['running','paused']){
  const game=vm.runInContext('Object.create(Game.prototype)',context);
  const done=new Error('end of clock check');let simulated=0;
  Object.assign(game,{lastFrameTime:0,simSpeed:speed,pauseState,
   aiManager:{aiPlayers:[],update(){}},sampleTimeline(){},pruneBattles(){},
   anyWonderStanding:()=>false,simulateStep:ms=>simulated+=ms,
   keepUnitsAshore(){},checkWinConditions(){throw done;}});
  assert.throws(()=>game.tick(),error=>error===done);
  assert.equal(game._environmentSeconds,pauseState==='paused'?0:1);
  assert.equal(simulated,pauseState==='paused'?0:1000*speed);
 }
});

test('each season has the requested full-day, dusk, full-night and dawn durations',()=>{
 const atmosphere=scope.window.EngineAtmosphere;
 for(const [theme,want] of [['desert',[300,60,300,60]],['winter',[210,90,330,90]],['summer',[330,90,210,90]]]){
  const totals=[0,0,0,0],light=t=>atmosphere.daylight(t,sun,sky,theme);
  for(let t=.5;t<720;t++){
   const n=light(t).night;
   if(n<1e-10)totals[0]++;else if(n>1-1e-10)totals[2]++;
   else if(light(t+.1).night>n)totals[1]++;else totals[3]++;
  }
  assert.deepEqual(totals,want,theme);
  for(const phase of ['dusk','dawn']){
   const sample=light(atmosphere.previewTime(theme,phase));assert.ok(sample.night>0&&sample.night<1);
  }
  assert.equal(light(atmosphere.previewTime(theme,'night')).night,1);
  assert.deepEqual(light(720),light(0));
  for(let t=0;t<720;t+=.5)for(const key of ['sun','sky'])light(t)[key].forEach((v,i)=>assert.ok(Math.abs(v-light(t+.5)[key][i])<.02));
 }
});
