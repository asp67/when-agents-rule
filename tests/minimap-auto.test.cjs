const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
function setup(){
 const scope={location:{search:''}};vm.createContext(scope);
 const source=fs.readFileSync(path.join(__dirname,'../js/game.js'),'utf8');
 vm.runInContext(source.slice(0,source.indexOf('\nconst WAR_PRIVATE_HOST')),scope);
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../js/director.js'),'utf8'),scope);
 const g=vm.runInContext('Object.create(Game.prototype)',scope);let paints=0;
 Object.assign(g,{_actionCam:true,spectatorMode:true,aiManager:{aiPlayers:[{id:'a',seat:0},{id:'b',seat:1}]},updateMinimap(){paints++;}});
 scope.testGame=g;g._director=vm.runInContext('new Director(testGame)',scope);
 const shot=(type,key,subject)=>{g._director.shot=g._director.begin(type,key,10,{x:0,z:0,yaw:0,halfH:30,subject},1000);g.followMinimapFogToShot();};
 return {g,shot,paints:()=>paints};
}
test('auto minimap follows seats, clears for overview, and releases a manual filter on the next shot',()=>{
 const {g,shot,paints}=setup();
 shot('establish','town:a');assert.equal(g.minimapFogSeat,0);
 const count=paints();g.followMinimapFogToShot();assert.equal(paints(),count);
 g._minimapFogManual=true;g.minimapFogSeat=1;g.followMinimapFogToShot();assert.equal(g.minimapFogSeat,1);
 shot('overview','overview');assert.equal(g.minimapFogSeat,null);
 shot('establish','town:b');assert.equal(g.minimapFogSeat,1);
 shot('brawl','engagement:1');assert.equal(g.minimapFogSeat,null);
});
test('selected subjects resolve their player even with an unchanged selected key',()=>{
 const {g,shot}=setup();
 shot('selected','selected',{kind:'units',units:[{owner:'a',health:10}]});assert.equal(g.minimapFogSeat,0);
 shot('selected','selected',{kind:'ent',ent:{owner:'b',health:10}});assert.equal(g.minimapFogSeat,1);
 shot('selected','selected',{kind:'units',units:[{owner:'a',health:10},{owner:'b',health:10}]});assert.equal(g.minimapFogSeat,null);
 g._actionCam=false;g.minimapFogSeat=0;shot('overview','overview');assert.equal(g.minimapFogSeat,0);
});

