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
