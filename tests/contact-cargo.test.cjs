const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
function setup(){
 const scope={console,BUILDING_DEFS:{}};vm.createContext(scope);
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../js/game.js'),'utf8').split('\nconst WAR_PRIVATE_HOST')[0],scope);
 const Game=vm.runInContext('Game',scope),g=Object.create(Game.prototype);
 const viewer={id:'a',units:[{id:'eye',type:'warrior',x:0,z:0,health:100}],buildings:[]};
 const rival={id:'b',units:[],buildings:[]};g.aiManager={aiPlayers:[viewer,rival]};
 g.unitVision=()=>20;g.buildingVision=()=>20;g.seatLabel=p=>typeof p==='string'?p:p.id;
 const logs=[];g.logPlayerEvent=(_,line)=>logs.push(line);
 const scan=()=>{g._contactTurnIdx=1;g.detectContacts();};
 const worker=(id,x=1,carrying='empty')=>({id,type:'worker',health:100,x,z:0,carryingResource:carrying!=='empty',carryingResourceType:carrying,harvestAmount:carrying==='empty'?0:10});
 return {g,viewer,rival,logs,scan,worker};
}
test('observable cargo ignores stale type, task and destination',()=>{
 const {g,worker}=setup();const w=worker('w');w.carryingResourceType='gold';w.task='carrying';w.harvestTarget={type:'wood'};
 assert.equal(g.observedWorkerLoad(w),'empty');
 for(const type of ['food','wood','stone','gold'])assert.equal(g.observedWorkerLoad(worker('w',1,type)),type);
 assert.equal(g.observedWorkerLoad({type:'warrior'}),undefined);
});
test('contact losses preserve last visible cargo and position after hidden deposit',()=>{
 const {rival,logs,scan,worker}=setup();const w=worker('w',1,'wood');rival.units=[w];scan();
 w.x=10;scan();w.x=30;w.carryingResource=false;w.harvestAmount=0;scan();
 assert.match(logs[0],/sighted at \(1, 0\), carrying wood/);
 assert.match(logs[1],/CONTACT LOST:.*last seen at \(10, 0\), carrying wood/);
 assert.equal(logs.length,2);
});
test('stationary pickup is reported and mixed loads are not grouped',()=>{
 const {rival,logs,scan,worker}=setup();const w=worker('w');rival.units=[w,worker('other',2,'food')];scan();
 assert.equal(logs.length,2);assert.ok(logs.some(l=>l.endsWith('empty-handed')));assert.ok(logs.some(l=>l.endsWith('carrying food')));
 w.carryingResource=true;w.harvestAmount=10;w.carryingResourceType='wood';scan();
 assert.equal(logs.length,3);assert.match(logs[2],/carrying wood/);scan();assert.equal(logs.length,3);
});
test('reappearing with changed cargo bypasses stationary contact suppression',()=>{
 const {rival,logs,scan,worker}=setup();const w=worker('w');rival.units=[w];scan();w.x=30;scan();
 w.x=1;w.carryingResource=true;w.harvestAmount=10;w.carryingResourceType='stone';scan();
 assert.equal(logs.length,2);assert.match(logs[1],/carrying stone/);
});
