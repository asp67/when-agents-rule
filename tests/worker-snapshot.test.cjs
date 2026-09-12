const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
function setup(){
 const scope={console,getCivilization:()=>({name:'Greeks',color:0x00ffff})};vm.createContext(scope);
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../js/game.js'),'utf8').split('\nconst WAR_PRIVATE_HOST')[0],scope);
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../js/openai-ai.js'),'utf8'),scope);
 const Game=vm.runInContext('Game',scope),Manager=vm.runInContext('OpenAIAIManager',scope);
 const game=Object.create(Game.prototype);game.isIdleWorker=u=>!u.task&&!u.isMoving;
 const ai={id:'a',civilization:'greek',units:[],buildings:[{type:'town_center',x:0,z:0}],resources:{food:100,wood:100,stone:100,gold:100}};
 const manager=new Manager(game),seat={aiPlayer:ai,model:{},stats:manager.newStats(),turnLog:[],conversationHistory:[]};seat.seat=seat;manager.aiControllers=[seat];
 const nodes=['food','wood','stone','gold'].map((type,i)=>({type,x:5+i*5,z:0,amount:100}));
 manager.discoveredNodesOfType=(_,__,type)=>nodes.filter(n=>n.type===type&&n.amount>0);
 const worker=(job='idle')=>{const u={id:ai.units.length+1,type:'worker',health:100,x:0,z:0,speed:3,task:null};
  if(['food','wood','stone','gold'].includes(job)){u.task='harvesting';u.harvestTarget=nodes.find(n=>n.type===job);}
  else if(job!=='idle')u.task=job;
  ai.units.push(u);return u;};
 const snapshot=(controller=seat)=>{manager.rememberWorkerPools(controller);controller._shownWorkers={};for(const {job}of controller._shownWorkerPools.values())controller._shownWorkers[job]=(controller._shownWorkers[job]||0)+1;controller._sentIdle=controller._shownWorkers.idle||0;};
 const finish=u=>{u.task=null;u.isMoving=false;u.isHarvesting=false;u.harvestTarget=null;u.isBuilding=false;u.buildTarget=null;};
 const assign=(from,to='gold',params={})=>manager.executeAssignWorkers(ai,game,{from,resourceType:to,count:1,...params});
 return {manager,seat,game,ai,nodes,worker,snapshot,finish,assign};
}

test('coordinate-only assignment uses a rounded known node and the observed worker pool',()=>{
 const h=setup(),w=h.worker('wood'),idle=h.worker();h.snapshot();h.finish(w);
 const food=h.nodes.find(n=>n.type==='food');food.x=86.3;food.z=-20.2;
 const params={count:1,from:'wood',targetX:86,targetZ:-20,whenCarrying:'deliverLoad'};
 assert.match(h.manager.executeAssignWorkers(h.ai,h.game,params),/^OK/);
 assert.equal(w.harvestTarget,food);assert.equal(idle.task,null);assert.equal(params.resourceType,undefined);
 assert.ok(!h.manager.constructor.ACTIONS.find(a=>a.name==='assign_workers').required.includes('resourceType'));
});

test('coordinate inference rejects unknown, ambiguous, partial and invalid coordinates without guessing from prose',()=>{
 const h=setup(),w=h.worker();h.snapshot();
 for(const params of [{targetX:100,targetZ:100,reason:'Gather food'}, {targetX:5}, {targetX:'5',targetZ:0}, {targetX:NaN,targetZ:0}])
  assert.match(h.manager.executeAssignWorkers(h.ai,h.game,params),/^\[ERROR\]/);
 h.nodes[1].x=h.nodes[0].x;
 assert.match(h.manager.executeAssignWorkers(h.ai,h.game,{targetX:5,targetZ:0}),/more than one resource type/);
 assert.equal(w.task,null);
});

test('known farm coordinates infer farm staffing; an explicit invalid resource type still fails',()=>{
 const h=setup(),w=h.worker();h.snapshot();
 const farm={type:'farm',health:100,x:30,z:20};h.ai.buildings.push(farm);h.game.farmFarmer=f=>f.assignedWorker;
 assert.match(h.manager.executeAssignWorkers(h.ai,h.game,{targetX:30,targetZ:20,resourceType:'sand'}),/^\[ERROR\]/);
 assert.match(h.manager.executeAssignWorkers(h.ai,h.game,{targetX:30,targetZ:20,count:1}),/^OK/);
 assert.equal(farm.assignedWorker,w);
});

test('a failed coordinate assignment does not reject neighboring native tool calls',()=>{
 const h=setup(),w=h.worker();h.snapshot();
 const call=(name,args)=>({type:'function',function:{name,arguments:JSON.stringify(args)}});
 const answer=h.manager.parseResponse({tool_calls:[call('assign_workers',{count:1,targetX:5,targetZ:0}),call('assign_workers',{targetX:100,targetZ:100}),call('wait',{})],finish_reason:'tool_calls'},h.seat);
 h.manager.executeTurn(h.seat,answer);
 assert.equal(w.harvestTarget,h.nodes[0]);
 assert.deepEqual(Array.from(h.manager.decisionLog,e=>e.failed),[false,true,false]);
 assert.equal(h.seat.stats.actionsSucceeded,2);assert.equal(h.seat.stats.actionsRejected,1);
 assert.equal(h.seat.stats.turnsExecuted,1);
 assert.match(h.seat.lastActionResult,/Command 3\/3: OK/);
});
for(const from of ['scouting','wood','food','stone','gold','moving'])test('reassigns the observed '+from+' worker after natural completion',()=>{
 const h=setup(),w=h.worker(from),other=h.worker();h.snapshot();h.finish(w);
 const to=from==='gold'?'wood':'gold';assert.match(h.assign(from,to),/^OK/);
 assert.equal(w.harvestTarget.type,to);assert.equal(other.task,null);
});
test('partially emptied pool includes finished workers without taking unrelated idle hands',()=>{
 const h=setup(),a=h.worker('wood'),b=h.worker('wood'),idle=h.worker();h.snapshot();h.finish(a);
 assert.match(h.assign('wood','gold',{count:3}),/^OK - Reassigned 2/);assert.equal(a.harvestTarget.type,'gold');assert.equal(b.harvestTarget.type,'gold');assert.equal(idle.task,null);
});
test('an absent observed source fails even if a worker later enters that live pool',()=>{
 const h=setup(),w=h.worker();h.snapshot();w.task='scouting';assert.match(h.assign('scouting'),/^\[ERROR\]/);assert.equal(w.task,'scouting');
});
test('dead, removed and newly created workers cannot substitute for observed workers',()=>{
 const h=setup(),a=h.worker('wood'),b=h.worker('wood');h.snapshot();a.health=0;h.ai.units=h.ai.units.filter(u=>u!==b);const fresh=h.worker('wood');
 assert.match(h.assign('wood'),/^\[ERROR\]/);assert.equal(fresh.harvestTarget.type,'wood');
});
test('a new explicit assignment cannot be undone by the old source snapshot, even after it ends',()=>{
 const h=setup(),w=h.worker('scouting');h.snapshot();h.finish(w);assert.match(h.assign('scouting','wood'),/^OK/);h.finish(w);
 assert.match(h.assign('scouting','gold'),/^\[ERROR\]/);assert.equal(w.task,null);
 h.snapshot();assert.match(h.assign('idle','gold'),/^OK/);
});
test('retaliating or building workers are protected until they are free',()=>{
 const h=setup(),w=h.worker('wood');h.snapshot();h.finish(w);w.isAttacking=true;assert.match(h.assign('wood'),/^\[ERROR\]/);
 w.isAttacking=false;w.task='building';w.isBuilding=true;assert.match(h.assign('wood'),/^\[ERROR\]/);
 h.finish(w);assert.match(h.assign('wood'),/^OK/);
});
test('carrying policy still applies to the observed worker',()=>{
 const h=setup(),w=h.worker('scouting');h.snapshot();h.finish(w);w.carryingResource=true;w.carryingResourceType='wood';w.harvestAmount=10;
 assert.match(h.assign('scouting','gold',{whenCarrying:'skipAssignment'}),/^\[ERROR\]/);assert.equal(w.harvestAmount,10);
 assert.match(h.assign('scouting','gold',{whenCarrying:'deliverLoad'}),/^OK/);assert.equal(w.harvestAmount,10);assert.equal(w._queuedAssign.resourceType,'gold');
 h.game.applyQueuedAssign(w);assert.equal(w.harvestTarget.type,'gold');assert.equal(w.harvestAmount,0);
});
test('completed builder is reassigned immediately; a busy builder remains queued',()=>{
 const h=setup(),a=h.worker('building'),b=h.worker('building');h.snapshot();h.finish(a);
 assert.match(h.assign('building','gold',{count:2}),/^OK/);assert.equal(a.harvestTarget.type,'gold');assert.equal(b.task,'building');assert.equal(b._queuedAssign.resourceType,'gold');
});
test('farm staffing honors the same observed source and does not steal unrelated workers',()=>{
 const h=setup(),idle=h.worker(),w=h.worker('scouting');h.snapshot();h.finish(w);
 const farm={type:'farm',health:100,x:1,z:1};h.ai.buildings.push(farm);h.game.farmFarmer=f=>f.assignedWorker;
 assert.match(h.assign('scouting','farm'),/^OK/);assert.equal(farm.assignedWorker,w);assert.equal(idle.task,null);
});
test('a queued turn uses its own frozen snapshot rather than a newer lane snapshot',()=>{
 const h=setup(),w=h.worker('scouting'),lane=Object.create(h.seat);h.snapshot(lane);
 const answer={_shownWorkerPools:lane._shownWorkerPools,_shownWorkers:lane._shownWorkers,_sentIdle:lane._sentIdle};
 h.finish(w);h.snapshot(lane);assert.equal(lane._shownWorkerPools.get(w).job,'idle');
 const actor=Object.assign(Object.create(lane),answer);let result;
 h.manager.executeAction=()=>{result=h.assign('scouting');};h.manager.executeTurn(actor,{commands:[{action:'assign_workers',params:{}}]});
 assert.match(result,/^OK/);assert.equal(w.harvestTarget.type,'gold');
});
