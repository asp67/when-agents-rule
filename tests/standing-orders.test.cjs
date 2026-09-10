const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
function setup(){
 const scope={console:{log(){}},BUILDING_DEFS:{town_center:{},tower:{}},towerPower:()=>({attack:10,arrows:1}),setTimeout:()=>{},Math};vm.createContext(scope);
 const read=p=>fs.readFileSync(path.join(__dirname,'../js/',p),'utf8');
 vm.runInContext(read('game.js').split('\nconst WAR_PRIVATE_HOST')[0],scope);
 vm.runInContext(read('openai-ai.js'),scope);vm.runInContext(read('standing-orders.js'),scope);
 const Game=vm.runInContext('Game',scope),Manager=vm.runInContext('OpenAIAIManager',scope);
 const g=Object.create(Game.prototype),m=Object.create(Manager.prototype),owner={id:'a',units:[],buildings:[]},enemy=[];
 let id=0;const unit=(type='warrior',x=0,z=0,speed=1)=>({id:'u'+(++id),handle:id,type,unitType:type==='priest'?'support':'infantry',owner:'a',x,z,speed,health:100,maxHealth:100,attack:type==='priest'?0:10,range:type==='priest'?3:1,_orderToken:1});
 Object.assign(g,{getAllUnits:()=>owner.units.concat(enemy),getAllBuildings:()=>[],clampSlot:(x,z)=>({x,z}),clampToMap:(x,z)=>({x,z}),
  renderer:{units:owner.units,updateUnitPosition(){},flashHit(){},spawnProjectile(){}},aiManager:{aiPlayers:[owner],isVisibleTo:(_,x,z)=>owner.units.some(u=>Math.hypot(u.x-x,u.z-z)<=30)},
  combatMultiplier:()=>1,recordBattleDamage(){},notifyCombat(){},destroyTarget:e=>e.health=0,resumeWorkerAfterCombat(){}});
 const issue=(mode='march',to={x:100,z:0},options={})=>g.setStandingOrder(m,owner,owner.units,to,{mode,formation:'line',...options});
 const step=(ms=150,combat=false)=>{for(let n=0;n<ms;n+=50){g._standingOrders.update(50);g.measureFormationLead();g.updateUnitMovement(50);if(combat)g.updateCombat(50);}};
 const rival=(x,z=0)=>{const e={...unit('warrior',x,z),owner:'b',health:10000};enemy.push(e);return e;};
 return {g,m,owner,unit,enemy,rival,issue,step};
}
test('scout ignores visible enemies and continues its destination',()=>{
 const h=setup();h.owner.units.push(h.unit());h.rival(5);h.issue('scout');h.step(2000,true);
 assert.ok(h.owner.units[0].x>0);assert.equal(h.owner.units[0].attackTarget,null);
});
test('guard remains active after arrival and excludes hidden enemies',()=>{
 const h=setup();const u=h.unit();h.owner.units.push(u);const g=h.issue('guard',{x:0,z:0});
 const hidden=h.rival(100);h.step();assert.equal(u.attackTarget,null);
 hidden.x=10;h.step();assert.equal(u.attackTarget,hidden);
 hidden.health=0;h.step();assert.equal(g.fighting,false);assert.ok(g.slots.has(u));
 const next=h.rival(8);h.step();assert.equal(u.attackTarget,next);
});
test('incidental pursuit stops at its leash and restores the original destination',()=>{
 const h=setup();const u=h.unit();h.owner.units.push(u);const e=h.rival(10);const g=h.issue();h.step();assert.equal(u.attackTarget,e);
 e.x=50;h.step();assert.equal(u.attackTarget,null);assert.equal(g.fighting,false);assert.equal(g.to.x,100);assert.ok(u.isMoving);
});
test('an unproductive chase is dropped without suppressing an explicit target attack',()=>{
 for(const explicit of [false,true]){
  const h=setup();const u=h.unit();h.owner.units.push(u);const e=h.rival(12);h.issue('march',{x:80,z:0},explicit?{target:e}:{});
  for(let i=0;i<40;i++)h.g._standingOrders.update(150);
  assert.equal(u.attackTarget===e,explicit);
 }
});
test('patrol waits for the priest before reversing and continues repeatedly',()=>{
 const h=setup();h.owner.units.push(h.unit(),h.unit('priest',-8,0,.6));const g=h.issue('patrol',{x:10,z:0});
 const fighter=h.owner.units[0],priest=h.owner.units[1];Object.assign(fighter,g.slots.get(fighter));h.g._standingOrders.update(150);assert.equal(g.to.x,10);
 Object.assign(priest,g.slots.get(priest));h.g._standingOrders.update(150);assert.notEqual(g.to.x,10);
 for(const u of h.owner.units)Object.assign(u,g.slots.get(u));h.g._standingOrders.update(150);assert.equal(g.to.x,10);
});
test('regrouping reuses the slowdown that lets the slow priest catch up',()=>{
 const h=setup();const fast=h.unit('warrior',8,0,2),priest=h.unit('priest',0,0,.6);h.owner.units.push(fast,priest);const g=h.issue();
 const e=h.rival(12);h.step();e.health=0;h.step();assert.equal(g.fighting,false);
 h.g.measureFormationLead();assert.equal(fast.marchSpeed,.6);assert.ok(h.g.moveSpeedOf(fast,50)<.6);assert.equal(h.g.moveSpeedOf(priest,50),.6);
});
test('partial reassignment rebuilds only survivors and preserves the new order',()=>{
 const h=setup();const a=h.unit(),b=h.unit('priest');h.owner.units.push(a,b);const old=h.issue('guard',{x:0,z:0});
 b._orderToken=2;const fresh=h.g.setStandingOrder(h.m,h.owner,[b],{x:80,z:30},{mode:'scout'});
 assert.equal(old.units.length,1);assert.equal(b._standingOrder,fresh);assert.equal(old.mode,'guard');
 h.step();assert.equal(b.targetX,80);assert.equal(b.targetZ,30);
 a.health=0;h.step();assert.equal(h.g._standingOrders.groups.has(old),false);
});
test('state reports assignments once with membership and patrol endpoints, without engagement chatter',()=>{
 const h=setup();h.owner.units.push(h.unit(),h.unit('priest'));h.issue('patrol',{x:20,z:0});
 const rows=h.g._standingOrders.summary(h.owner);assert.equal(rows.length,1);assert.equal(rows[0].unitIds.length,2);assert.equal(rows[0].mode,'patrol');assert.ok(rows[0].from);assert.equal(rows[0].engaging,undefined);
});

test('priests occupy ranged slots in every shape, including after regrouping',()=>{
 for(const shape of ['line','wedge','block','screen']){
  const h=setup(),priest=h.unit('priest');
  const archers=Array.from({length:4},()=>({...h.unit(),type:'archer',range:12}));
  const melee=Array.from({length:8},()=>h.unit());
  h.owner.units.push(priest,...archers,...melee);
  const check=()=>{
   const {slots}=h.m.formationSlots(h.owner.units,shape);
   assert.equal(slots.size,h.owner.units.length);
   assert.ok(slots.get(priest).f<=Math.min(...archers.map(u=>slots.get(u).f)),shape);
   assert.ok(slots.get(priest).f<Math.max(...melee.map(u=>slots.get(u).f)),shape);
  };
  check();const g=h.issue('guard',{x:10,z:0},{formation:shape});
  const e=h.rival(12);h.step();assert.equal(priest.attackTarget,null);
  e.health=0;h.step();assert.equal(g.fighting,false);
  assert.ok(g.slots.has(priest));assert.ok(priest.formationGroup);check();
 }
});

test('patrol completes multiple legs through the real movement and formation slowdown',()=>{
 const h=setup();h.owner.units.push(h.unit('warrior',0,0,2),h.unit('priest',-3,0,.6));
 const g=h.issue('patrol',{x:20,z:0});let turns=0,previous=g.to.x;
 for(let i=0;i<600;i++){h.step(150);if(g.to.x!==previous){turns++;previous=g.to.x;}}
 assert.ok(turns>=2,`only ${turns} patrol turns`);
});

test('military target preference ignores workers and priests',()=>{
 const h=setup();const u=h.unit();h.owner.units.push(u);
 const worker=h.rival(3);worker.type='worker';
 const priest=h.rival(4);priest.unitType='support';priest.attack=0;
 const warrior=h.rival(10);h.issue('guard',{x:0,z:0},{targets:'military'});h.step();
 assert.equal(u.attackTarget,warrior);
});

test('a fresh economic order is never overwritten by the previous army assignment',()=>{
 const h=setup(),u=h.unit();h.owner.units.push(u);h.issue();
 u._orderToken++;u.task={type:'gather'};u.targetX=7;u.targetZ=8;h.step();
 assert.equal(u._standingOrder,null);assert.equal(u.targetX,7);assert.equal(u.targetZ,8);
 assert.equal(h.g._standingOrders.groups.size,0);
});

test('a visible named target updates the approach even when it moves only a little per scan',()=>{
 const h=setup();h.owner.units.push(h.unit());const e=h.rival(40);
 h.g.aiManager.isVisibleTo=()=>true;
 const g=h.issue('march',{x:40,z:0},{target:e});
 for(let i=0;i<10;i++){e.x++;h.g._standingOrders.update(150);}
 assert.ok(g.leg.x>40);assert.equal(g.to.x,50);
 e.health=0;h.g._standingOrders.update(150);
 assert.equal(h.g._standingOrders.summary(h.owner)[0].order,'attack_target');
});

test('siege attackers keep damaging buildings and wonders without a false stalled chase',()=>{
 for(const [isWonder,range] of [[false,1],[true,1],[false,12],[true,12]]){
  const h=setup(),u=h.unit();u.range=range;h.owner.units.push(u);
  const building={id:'building',owner:'b',type:isWonder?'monument':'town_center',isWonder,x:(range>1?range:1.5)+(isWonder?4.6:3.5)-.1,z:0,health:10000};
  h.g.getAllBuildings=()=>[building];h.issue('march',{x:20,z:0},{attack:true});
  for(let i=0;i<50;i++){
   h.g._standingOrders.update(150);h.g.updateCombat(150);
   assert.equal(u.attackTarget,building,`lost siege target at ${i*150}ms (wonder=${isWonder}, range=${range})`);
  }
  assert.ok(building.health<9950);
 }
});

test('one stalled pursuer does not make squadmates abandon their reachable target',()=>{
 const h=setup(),stuck=h.unit(),fighter=h.unit('warrior',11);h.owner.units.push(stuck,fighter);
 const e=h.rival(12);h.issue();
 for(let i=0;i<40;i++)h.g._standingOrders.update(150);
 assert.equal(stuck.attackTarget,null);assert.equal(fighter.attackTarget,e);
});

test('casualties and partial reassignment rebuild slots without resetting live fights',()=>{
 for(const reassign of [false,true]){
  const h=setup(),fighter=h.unit(),other=h.unit('warrior',2);h.owner.units.push(fighter,other);
  const target=h.rival(10);const g=h.issue();h.step();assert.equal(fighter.attackTarget,target);
  h.rival(fighter.x+.5); // now closer, but not a reason to abandon a living target
  if(reassign)other._orderToken++;else other.health=0;
  h.g._standingOrders.update(50);
  assert.equal(fighter.attackTarget,target);assert.equal(g.fighting,true);assert.equal(g.slots.size,1);
  h.g._standingOrders.update(150);assert.equal(fighter.attackTarget,target);
 }
});

test('an unformed army settles in distinct slots after combat instead of contesting one point',()=>{
 const h=setup();h.owner.units.push(...Array.from({length:10},(_,i)=>h.unit(i===9?'priest':'warrior',i*.1,0)));
 const e=h.rival(10),g=h.issue('march',{x:20,z:0},{formation:null});h.step();e.health=0;h.step(30000);
 assert.equal(g.fighting,false);
 const slots=[...g.slots.values()];
 for(let i=0;i<slots.length;i++)for(let j=0;j<i;j++)assert.ok(Math.hypot(slots[i].x-slots[j].x,slots[i].z-slots[j].z)>=1.8);
 assert.ok(h.owner.units.every(u=>!u.isMoving));
 // Let the renderer's friendly-separation rule act between simulation slices.
 for(let n=0;n<100;n++){
  for(let i=0;i<h.owner.units.length;i++)for(let j=0;j<i;j++){
   const a=h.owner.units[i],b=h.owner.units[j],dx=b.x-a.x,dz=b.z-a.z,d=Math.hypot(dx,dz);
   if(d<1.2&&d>.01){const push=(1.2-d)*.03; a.x-=dx/d*push;a.z-=dz/d*push;b.x+=dx/d*push;b.z+=dz/d*push;}
  }
  h.step();assert.ok(h.owner.units.every(u=>!u.isMoving));
 }
});

test('post-battle formation stays intact beside buildings and within map edges',()=>{
 for(const edge of [false,true]){
  const h=setup();h.owner.units.push(...Array.from({length:12},(_,i)=>h.unit(i===11?'priest':'warrior',i,0)));
  const building={type:'town_center',x:20,z:0,health:100};h.g.getAllBuildings=()=>[building];
  // Exercise the actual slot clamp with a building ring and a map boundary.
  delete h.g.clampSlot;
  if(edge)h.g.clampToMap=(x,z)=>({x:Math.min(20,x),z});
  const e=h.rival(10),g=h.issue('guard',{x:20,z:0});h.step();e.health=0;h.step(30000);
  assert.equal(g.fighting,false);assert.ok(h.owner.units.every(u=>!u.isMoving));
  const slots=[...g.slots.values()];
  for(const s of slots){assert.ok(Math.hypot(s.x-20,s.z)>=5);if(edge)assert.ok(s.x<=20);}
  for(let i=0;i<slots.length;i++)for(let j=0;j<i;j++)assert.ok(Math.hypot(slots[i].x-slots[j].x,slots[i].z-slots[j].z)>=1.8);
  assert.ok(h.owner.units.every(u=>u.formationGroup===h.owner.units[0].formationGroup));
 }
});

test('a pursuit continues beyond the acquisition boundary and tolerates brief outer-boundary crossings',()=>{
 const h=setup(),u=h.unit();h.owner.units.push(u);h.g.aiManager.isVisibleTo=()=>true;
 const e=h.rival(30);h.issue();h.g._standingOrders.update(150);assert.equal(u.attackTarget,e);
 for(const x of [49,55,63,65,63,65,63]){e.x=x;h.g._standingOrders.update(150);assert.equal(u.attackTarget,e);}
 e.x=70;for(let i=0;i<8;i++)h.g._standingOrders.update(150);
 assert.equal(u.attackTarget,null);
});

test('a failed chase does not restart on a timer without a better opportunity',()=>{
 const h=setup(),u=h.unit();h.owner.units.push(u);const e=h.rival(20);h.issue();
 for(let i=0;i<150;i++)h.g._standingOrders.update(150);
 assert.equal(u.attackTarget,null);
 e.x=12;h.g._standingOrders.update(150);assert.equal(u.attackTarget,e);
});

test('closing after a detour counts as progress without beating the old closest distance',()=>{
 const h=setup(),u=h.unit();h.owner.units.push(u);h.g.aiManager.isVisibleTo=()=>true;
 const e=h.rival(8);h.issue();h.g._standingOrders.update(150);
 e.x=30;
 for(let i=0;i<50;i++){if(i%5===0)e.x-=1;h.g._standingOrders.update(150);assert.equal(u.attackTarget,e);}
});

test('boundary grace does not grant attacks or tracking through lost vision',()=>{
 const h=setup(),u=h.unit();h.owner.units.push(u);const e=h.rival(15);h.issue();h.g._standingOrders.update(150);
 h.g.aiManager.isVisibleTo=()=>false;h.g._standingOrders.update(150);assert.equal(u.attackTarget,null);
});

test('a tower hitting even a priest instantly redirects every formation fighter until destroyed',()=>{
 const h=setup(),a=h.unit(),b=h.unit('archer',2),priest=h.unit('priest');b.range=12;
 h.owner.units.push(a,b,priest);const original=h.rival(8),tower=Object.assign(h.rival(15),{type:'tower'});
 const g=h.issue('march',{x:80,z:0},{target:original});h.step();
 h.g.noteRetaliation(priest,tower);
 assert.equal(a.attackTarget,tower);assert.equal(b.attackTarget,tower);assert.equal(priest.attackTarget,null);
 for(let i=0;i<60;i++)h.g._standingOrders.update(150);
 assert.equal(a.attackTarget,tower);assert.equal(b.attackTarget,tower);assert.equal(g.target,original);
 tower.health=0;h.g._standingOrders.update(150);assert.equal(a.attackTarget,original);
});

test('alternating tower volleys queue focus targets without ping-pong or stealing reassigned units',()=>{
 const h=setup(),a=h.unit(),b=h.unit('warrior',2);h.owner.units.push(a,b);
 const first=Object.assign(h.rival(12),{type:'tower'}),second=Object.assign(h.rival(14),{type:'tower'});
 h.issue('guard',{x:0,z:0});h.g.noteRetaliation(a,first);h.g.noteRetaliation(b,second);
 assert.equal(a.attackTarget,first);assert.equal(b.attackTarget,first);
 b._orderToken++;const other=h.g.setStandingOrder(h.m,h.owner,[b],{x:60,z:0},{mode:'scout'});
 first.health=0;h.g._standingOrders.update(150);assert.equal(a.attackTarget,second);assert.equal(b.attackTarget,null);assert.equal(b._standingOrder,other);
 second.health=0;h.g._standingOrders.update(150);assert.equal(a._standingOrder.fighting,false);assert.equal(a._standingOrder.mode,'guard');
});

test('scout orders defend against tower fire, then resume scouting',()=>{
 const h=setup(),u=h.unit();h.owner.units.push(u);const tower=Object.assign(h.rival(10),{type:'tower'});
 h.issue('scout');h.g.noteRetaliation(u,tower);h.step();assert.equal(u.attackTarget,tower);tower.health=0;h.step();assert.equal(u.attackTarget,null);assert.equal(u._standingOrder.mode,'scout');
});

test('an actual tower volley immediately redirects the formation before the next order scan',()=>{
 const h=setup(),a=h.unit(),b=h.unit('warrior',2),priest=h.unit('priest',4);
 h.owner.units.push(a,b,priest);
 const tower={id:'tower',type:'tower',owner:'b',x:8,z:0,health:1000,range:6};h.g.getAllBuildings=()=>[tower];
 h.issue('march',{x:50,z:0});h.g.updateTowerAttack(1500);
 assert.equal(priest.health,90);assert.equal(a.attackTarget,tower);assert.equal(b.attackTarget,tower);assert.equal(priest.attackTarget,null);
});

test('mobile retaliation overrides a siege, gives way to towers, and resumes the saved siege',()=>{
 const h=setup(),u=h.unit(),other=h.unit('warrior',1);h.owner.units.push(u,other);
 const original=Object.assign(h.rival(20),{type:'town_center'}),raider=h.rival(10),tower=Object.assign(h.rival(15),{type:'tower'});
 const g=h.issue('march',{x:20,z:0},{target:original});h.g.noteRetaliation(u,raider);
 assert.equal(other.attackTarget,raider);h.g.noteRetaliation(u,tower);assert.equal(other.attackTarget,tower);
 h.g.noteRetaliation(other,raider);assert.equal(u.attackTarget,tower);
 tower.health=0;h.g._standingOrders.update(150);assert.equal(u.attackTarget,raider);
 raider.health=0;h.g._standingOrders.update(150);assert.equal(u.attackTarget,original);assert.equal(g.target,original);
});

test('an uncatchable retaliatory threat is abandoned and the scout assignment resumes',()=>{
 const h=setup(),u=h.unit();h.owner.units.push(u);const raider=h.rival(20);
 const g=h.issue('scout',{x:80,z:0});h.g.noteRetaliation(u,raider);
 for(let i=0;i<50;i++)h.g._standingOrders.update(150);
 assert.equal(u.attackTarget,null);assert.equal(g.threats.length,0);assert.equal(g.fighting,false);
 assert.equal(g.to.x,80);assert.ok(u.isMoving);
 h.g.noteRetaliation(u,raider);assert.equal(u.attackTarget,null); // another hit cannot restart the same stalled chase
 raider.x=u.x+1;h.g.noteRetaliation(u,raider);assert.equal(u.attackTarget,raider); // immediate defense when reachable
});

test('formation priest does not alternate between its hold and a distant patient',()=>{
 const h=setup(),p=h.unit('priest'),w=h.unit('warrior',10);w.health=50;
 h.owner.units.push(p,w);h.g.getOwner=()=>h.owner;h.g.recordBattleHealing=()=>{};
 h.issue('guard',{x:0,z:0});p.isMoving=false;p.targetX=0;p.targetZ=0;
 h.g.updateHealing(50);assert.equal(p.isMoving,false);assert.equal(p.targetX,0);
 w.x=2;h.g.updateHealing(50);assert.ok(w.health>50,'still heals within reach');
 p._standingOrder=null;w.x=10;h.g.updateHealing(50);assert.equal(p.isMoving,true,'unassigned priests still approach patients');
});

test('combat hold releases old marching guidance and reserves separate places',()=>{
 const h=setup(),p=h.unit('priest'),w=h.unit();h.owner.units.push(p,w);
 const group=h.issue();h.rival(10);h.step();
 assert.equal(group.fighting,true);assert.equal(p.formationAxis,null);assert.equal(p.formationGroup,null);
 const hold=group.holdSlots.get(p);h.step();assert.equal(group.holdSlots.get(p),hold);
 assert.ok(Math.hypot(hold.x-group.holdSlots.get(w).x,hold.z-group.holdSlots.get(w).z)>1.8);
});

test('fast riders cannot overshoot a nearby resting slot or melee target',()=>{
 const h=setup(),u=h.unit('cavalry',0,0,20);h.owner.units.push(u);
 Object.assign(u,{isMoving:true,targetX:.7,targetZ:0});h.g.updateUnitMovement(100);
 assert.equal(u.x,.7);h.g.updateUnitMovement(100);assert.equal(u.isMoving,false);
 const e=h.rival(2.7);Object.assign(u,{isAttacking:true,attackTarget:e});h.g.updateCombat(100);
 assert.ok(u.x>=1.2&&u.x<=1.5);assert.equal(u.attackTarget,e);
});

test('named building assault continues through nearby buildings and units, then regroups',()=>{
 const h=setup(),u=h.unit();h.owner.units.push(u);
 const building=x=>({owner:'b',type:'town_center',x,z:0,health:100,maxHealth:100});
 const first=building(5),second=building(12),hidden=building(100);
 h.g.getAllBuildings=()=>[first,second,hidden];
 const group=h.issue('march',{x:5,z:0},{target:first});h.step();assert.equal(u.attackTarget,first);
 first.health=0;h.step();assert.equal(u.attackTarget,second);assert.equal(group.order,'attack_target');
 const worker=h.rival(15);worker.type='worker';second.health=0;h.step();assert.equal(u.attackTarget,worker);
 worker.health=0;h.step();assert.equal(u.attackTarget,null);assert.equal(group.fighting,false);
 assert.ok(u.formationGroup,'rebuilds formation when local targets are exhausted');
});

test('completing a distant named objective anchors continuation at the arrived army',()=>{
 const h=setup(),u=h.unit();h.owner.units.push(u);
 h.g.aiManager.isVisibleTo=()=>true;
 const first={owner:'b',type:'town_center',x:30,z:0,health:100};
 const next={...first,x:160},far={...first,x:240};h.g.getAllBuildings=()=>[first,next,far];
 const group=h.issue('march',{x:150,z:0},{target:first});h.step();assert.equal(u.attackTarget,first);
 u.x=145;first.x=150;first.health=0;h.step();assert.equal(u.attackTarget,next);assert.equal(group.anchor.x,145);
 next.health=0;h.step();assert.equal(u.attackTarget,null,'does not turn continuation into a map-wide hunt');
});

test('ordinary movement does not become an unsolicited building assault',()=>{
 const h=setup(),u=h.unit();h.owner.units.push(u);
 h.g.getAllBuildings=()=>[{owner:'b',type:'town_center',x:5,z:0,health:100}];
 h.issue();h.step();assert.equal(u.attackTarget,null);
});

test('formation priest reaches wounded comrades thirty units ahead and channels without reversing',()=>{
 const h=setup(),p=h.unit('priest',0,0,2),w=h.unit('warrior',30);w.health=20;
 h.owner.units.push(p,w);h.g.getOwner=()=>h.owner;h.g.recordBattleHealing=()=>{};h.g.renderer.spawnDust=()=>{};
 const group=h.issue();h.rival(31);let previous=0;
 for(let i=0;i<120;i++){
  h.step(50);h.g.updateHealing(50);
  assert.ok(p.x>=previous-.001,'priest must not return toward original hold');previous=p.x;
 }
 assert.ok(Math.hypot(p.x-w.x,p.z-w.z)<=3.5);assert.ok(w.health>20);assert.equal(p.attackTarget,null);
 assert.equal(group.fighting,true);
});

test('formation support keeps its patient and picks a legal nearby healing position',()=>{
 const h=setup(),p=h.unit('priest'),a=h.unit('warrior',30),b=h.unit('warrior',32);
 a.health=b.health=50;h.owner.units.push(p,a,b);const g=h.issue();g.anchor={x:0,z:0};
 h.g.clampSlot=(x,z)=>x<30?{x:35,z}:({x,z});
 const position=h.g._standingOrders.supportPosition(g,p,g.units,{x:0,z:0});
 assert.ok(position.x>=30);assert.ok(Math.hypot(position.x-a.x,position.z-a.z)<3.5);
 b.x=5;h.g._standingOrders.supportPosition(g,p,g.units,{x:0,z:0});assert.equal(p._formationPatient,a);
 a.health=100;h.g._standingOrders.supportPosition(g,p,g.units,{x:0,z:0});assert.equal(p._formationPatient,b);
});

test('healthy priests follow advancing ranged ranks and regroup only with the army',()=>{
 const h=setup(),p=h.unit('priest'),a=h.unit('archer',10);a.range=12;
 h.owner.units.push(p,a);const e=h.rival(20);h.g.aiManager.isVisibleTo=()=>true;
 const group=h.issue('march',{x:100,z:0},{target:e});h.step();
 const originalHold=group.holdSlots.get(p).x;
 a.x=60;e.x=70;h.step();assert.ok(p.targetX>50);assert.ok(p.targetX<60);
 assert.equal(p.formationGroup,null);assert.equal(p.attackTarget,null);
 a.health=50;h.step();assert.equal(p._formationPatient,a);
 a.health=100;h.step();assert.ok(p.targetX>50,'finishing healing must not send priest back');
 assert.notEqual(p.targetX,originalHold);
 e.health=0;h.step();assert.equal(group.fighting,false);assert.ok(p.formationGroup);
 assert.equal(p.targetX,group.slots.get(p).x);
});

test('settled block priest completes an out-of-range heal before returning to its rear slot',()=>{
 const h=setup(),p=h.unit('priest',0,0,2);
 const soldiers=Array.from({length:12},()=>h.unit());h.owner.units.push(...soldiers,p);
 h.g.getOwner=()=>h.owner;h.g.recordBattleHealing=()=>{};h.g.renderer.spawnDust=()=>{};
 const g=h.issue('guard',{x:40,z:0},{formation:'block'});
 for(const u of g.units){Object.assign(u,g.slots.get(u));u.isMoving=false;}
 const patient=soldiers.sort((a,b)=>Math.hypot(b.x-p.x,b.z-p.z)-Math.hypot(a.x-p.x,a.z-p.z))[0];
 assert.ok(Math.hypot(patient.x-p.x,patient.z-p.z)>3.5);patient.health=80;
 let distance=Math.hypot(patient.x-p.x,patient.z-p.z),healed=false;
 for(let i=0;i<600;i++){
  h.step(50);h.g.updateHealing(50);
  const next=Math.hypot(patient.x-p.x,patient.z-p.z);
  if(!healed&&patient.health<100)assert.ok(next<=distance+.001,'must not return to slot before healing finishes');
  distance=next;if(patient.health===100)healed=true;
 }
 assert.equal(healed,true);const slot=g.slots.get(p);
 assert.ok(Math.hypot(p.x-slot.x,p.z-slot.z)<.5);assert.equal(g.fighting,false);
});

test('a stopped formation priest heals nearby friendlies outside its order while another rank is late',()=>{
 const h=setup(),p=h.unit('priest',0,0,2),late=h.unit('warrior',-30,0,.1);
 h.owner.units.push(p,late);
 h.g.getOwner=()=>h.owner;h.g.recordBattleHealing=()=>{};h.g.renderer.spawnDust=()=>{};
 const group=h.issue('guard',{x:0,z:0});
 Object.assign(p,group.slots.get(p));p.isMoving=false;
 const patient=h.unit('warrior',p.x+10,p.z);patient.health=80;h.owner.units.push(patient);
 const enemy=h.rival(p.x+2,p.z);enemy.health=20;h.g.aiManager.isVisibleTo=()=>false;
 let healed=false;
 for(let i=0;i<400;i++){h.step(50);h.g.updateHealing(50);if(patient.health===100)healed=true;}
 assert.equal(healed,true);assert.equal(enemy.health,20);
 assert.equal(group.settled,false,'healing must not wait for the distant rank');
 assert.ok(Math.hypot(p.x-group.slots.get(p).x,p.z-group.slots.get(p).z)<.5);
 assert.ok(p.formationGroup,'restores formation guidance after the trip');
});

test('formation healing interrupts marching but does not chase distant unrelated patients',()=>{
 const h=setup(),p=h.unit('priest'),w=h.unit('warrior',2);h.owner.units.push(p,w);
 const group=h.issue('scout',{x:100,z:0});const patient=h.unit('warrior',10);patient.health=50;h.owner.units.push(patient);
 h.step(500);assert.equal(p._formationPatient,patient);assert.notEqual(p.targetX,group.slots.get(p).x);
 patient.x=200;const fallback={x:0,z:0};
 assert.equal(h.g._standingOrders.supportPosition(group,p,group.units,fallback),fallback);
});

test('every nearby formation priest approaches and contributes healing while the body slows',()=>{
 const h=setup(),p=h.unit('priest',0,0,2),q=h.unit('priest',-8,0,2),w=h.unit('warrior',1,0,3);
 h.owner.units.push(p,q,w);const group=h.issue('march',{x:100,z:0});
 const patient=h.unit('warrior',12);patient.health=10;h.owner.units.push(patient);
 const credit=new Map();h.g.getOwner=()=>h.owner;h.g.renderer.spawnDust=()=>{};
 h.g.recordBattleHealing=(u,hp)=>credit.set(u,(credit.get(u)||0)+hp);
 h.step(150);assert.equal(p._formationPatient,patient);assert.equal(q._formationPatient,patient);
 assert.ok(h.g.moveSpeedOf(w,50)<w.marchSpeed,'body slows for healing priests');
 for(let i=0;i<800;i++){h.step(50);h.g.updateHealing(50);}
 assert.ok(credit.get(p)>0);assert.ok(credit.get(q)>0);assert.equal(patient.health,100);
 assert.equal(p._healingFormation,null);assert.equal(q._healingFormation,null);
 assert.equal(p._standingOrder,group);assert.ok(p.formationGroup);assert.ok(q.formationGroup);
});

test('retaliation immediately closes toward the attacker instead of the old formation destination',()=>{
 const h=setup(),a=h.unit('warrior'),b=h.unit('warrior',-3);h.owner.units.push(a,b);
 h.issue('scout',{x:-100,z:0});const enemy=h.rival(8);
 h.g.noteRetaliation(a,enemy);const before=b.x;h.step(50,true);
 assert.equal(b.attackTarget,enemy);assert.ok(b.x>before);assert.equal(b.formationOffset,null);
});

test('live combat facing ignores an outward separation nudge but marching follows actual travel',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../js/engine/gamerenderer.js'),'utf8');
 const fragment=source.slice(source.indexOf('const facingTarget='),source.indexOf('let d = want - dir;',source.indexOf('const facingTarget=')));
 const facing=new Function('u','prev',fragment+'return want; }} return null;');
 const u={x:0,z:0,isMoving:true,isAttacking:true,attackTarget:{x:10,z:0,health:100}};
 assert.equal(facing(u,{x:1,z:0}),Math.PI/2);
 u.isAttacking=false;assert.equal(facing(u,{x:1,z:0}),-Math.PI/2);
});

test('repeated hits on an ally do not restart a defenders failed chase',()=>{
 const h=setup(),u=h.unit(),ally=h.unit('priest',20);h.owner.units.push(u,ally);
 h.g.aiManager.isVisibleTo=()=>true;const attacker=h.rival(22);const group=h.issue('scout');
 h.g.noteRetaliation(ally,attacker);h.g._standingOrders.update(150);
 attacker.x=130;h.g._standingOrders.update(150);assert.equal(u.attackTarget,null);
 for(let i=0;i<40;i++){
  h.g.noteRetaliation(ally,attacker);assert.equal(u.attackTarget,null,'incoming hits must not rearm the same failed chase');
  h.g._standingOrders.update(150);
 }
 assert.equal(group.fighting,false);
 attacker.x=u.x+1;h.g.noteRetaliation(ally,attacker);h.g._standingOrders.update(150);
 assert.equal(u.attackTarget,attacker,'a genuinely reachable threat can be engaged again');
});

test('reachable retaliation is not recalled by a distant old battle anchor',()=>{
 const h=setup(),u=h.unit(),ally=h.unit('priest');h.owner.units.push(u,ally);h.g.aiManager.isVisibleTo=()=>true;
 const attacker=h.rival(1);const group=h.issue();h.g.noteRetaliation(ally,attacker);
 group.anchor={x:-150,z:0};
 for(let i=0;i<20;i++){h.g._standingOrders.update(150);assert.equal(u.attackTarget,attacker);}
 attacker.x=120;h.g._standingOrders.update(150);assert.equal(u.attackTarget,null,'leash applies again when pursuit is necessary');
});

test('far wing joins the same siege as nearby ranks instead of waiting for the building to fall',()=>{
 for(const named of [true,false]){
  const h=setup(),near=h.unit('warrior',20),far=h.unit('warrior',-30);h.owner.units.push(near,far);
  h.g.aiManager.isVisibleTo=()=>true;
  const house={owner:'b',type:'town_center',x:25,z:0,health:1000};h.g.getAllBuildings=()=>[house];
  h.issue('march',{x:25,z:0},named?{target:house}:{attack:true});h.step();
  assert.equal(near.attackTarget,house);assert.equal(far.attackTarget,house);
  const before=far.x;h.step(1000,true);assert.ok(far.x>before);assert.ok(house.health>0);
 }
});

test('a distant explicit target preserves the approach formation until engagement begins',()=>{
 const h=setup(),a=h.unit(),b=h.unit('warrior',-10);h.owner.units.push(a,b);
 h.g.aiManager.isVisibleTo=()=>true;const house={owner:'b',type:'town_center',x:200,z:0,health:1000};
 h.g.getAllBuildings=()=>[house];h.issue('march',{x:200,z:0},{target:house});h.step();
 assert.equal(a.attackTarget,null);assert.equal(b.attackTarget,null);assert.ok(a.formationGroup);assert.ok(b.isMoving);
 a.x=170;h.step();assert.equal(a.attackTarget,house);assert.equal(b.attackTarget,house);
});

test('attack clocks advance under repeated outward separation nudges for melee and archers',()=>{
 for(const range of [1,12]){
  const h=setup(),u=h.unit();u.range=range;h.owner.units.push(u);
  const reach=range===1?1.5:range;const enemy=h.rival(reach+.01);h.issue('scout');h.g.noteRetaliation(u,enemy);
  for(let i=0;i<80;i++){
   h.g._standingOrders.update(50);h.g.updateCombat(50);
   u.x-=.03; // renderer separates crowded friendlies after each simulation frame
  }
  assert.ok(enemy.health<=9970,'must keep landing blows despite crowd nudges');
  assert.equal(u.attackTarget,enemy);
 }
});

test('sub-pixel range errors cannot freeze the attack timer on the spot',()=>{
 for(const range of [1,12]){
  const h=setup(),u=h.unit('warrior',100);u.range=range;h.owner.units.push(u);
  const reach=range===1?1.5:range,e=h.rival(100+reach+1e-12);
  Object.assign(u,{attackTarget:e,isAttacking:true});
  for(let i=0;i<40;i++)h.g.updateCombat(50);
  assert.equal(e.health,9980);assert.equal(u.isMoving,false);
 }
});
