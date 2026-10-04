// move_units mode "hold" (asp67, b1044): guard with a short leash, so defenders stay under
// their towers instead of running into the open after whatever shot them. At its post each
// unit keeps to its own slot: it attacks unprovoked only what is within its own reach, and
// answers an attacker only within HOLD_LEASH (19) of its slot.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const { createMatch } = require('../tools/bench/realm.cjs');

function setup(){
 const scope={console:{log(){}},BUILDING_DEFS:{town_center:{},tower:{}},towerPower:()=>({attack:10,arrows:1}),setTimeout:()=>{},Math};vm.createContext(scope);
 const read=p=>fs.readFileSync(path.join(__dirname,'../js/',p),'utf8');
 vm.runInContext(read('simulation/rng.js'),scope);vm.runInContext(read('simulation/math.js'),scope);vm.runInContext(read('game.js'),scope);
 vm.runInContext(read('openai-ai.js'),scope);vm.runInContext(read('standing-orders.js'),scope);
 const Game=vm.runInContext('Game',scope),Manager=vm.runInContext('OpenAIAIManager',scope),SO=vm.runInContext('StandingOrders',scope);
 const g=Object.create(Game.prototype);g.clock=Game.newClock();const m=Object.create(Manager.prototype),owner={id:'a',units:[],buildings:[]},enemy=[];
 let id=0;const unit=(type='warrior',x=0,z=0)=>({id:'u'+(++id),handle:id,type,unitType:type==='archer'?'ranged':'infantry',owner:'a',x,z,speed:1,health:100,maxHealth:100,attack:10,range:type==='archer'?12:1,_orderToken:1});
 Object.assign(g,{getAllUnits:()=>owner.units.concat(enemy),getAllBuildings:()=>[],clampSlot:(x,z)=>({x,z}),clampToMap:(x,z)=>({x,z}),
  renderer:{units:owner.units,updateUnitPosition(){},flashHit(){},spawnProjectile(){}},aiManager:{aiPlayers:[owner],isVisibleTo:()=>true},
  combatMultiplier:()=>1,recordBattleDamage(){},notifyCombat(){},destroyTarget:e=>e.health=0,resumeWorkerAfterCombat(){}});
 const issue=(mode,to={x:0,z:0},formation='line')=>g.setStandingOrder(m,owner,owner.units,to,{mode,formation});
 const scan=(n=1)=>{for(let i=0;i<n;i++)g._standingOrders.update(150);};
 const rival=(x,z=0,type='archer')=>{const e={...unit(type,x,z),owner:'b',health:10000};enemy.push(e);return e;};
 return {g,SO,owner,unit,rival,issue,scan};
}
// A group standing at its post (slots reached), so "at the post" holds from the start.
function posted(mode,n=1){
 const h=setup();for(let i=0;i<n;i++)h.owner.units.push(h.unit());
 const grp=h.issue(mode);for(const u of h.owner.units){const s=grp.slots.get(u);u.x=s.x;u.z=s.z;u.isMoving=false;}
 h.scan();return Object.assign(h,{grp});
}

test('the leash is 19, past every reach in the game -- a range raised beyond it fails here', async () => {
 const { SO } = setup();
 assert.equal(SO.HOLD_LEASH, 19);
 // Every unit of every civilization, with every range bonus its civilization can research,
 // measured the way combat measures it (attackRangeAgainst), and every building that shoots.
 const civs=['egyptian','greek','persian','yamato'];
 const m=await createMatch({kind:'board',seed:'hold-reach',seats:civs.map((civ,i)=>({civ,age:'iron',buildings:[['town_center',-300+200*i,0]]}))});
 const ctx=m.context,g=m.game,B=vm.runInContext('BUILDING_DEFS',ctx),U=vm.runInContext('UNIT_DEFS',ctx);
 let longest=0,who='';
 for(const civ of civs){
  const c=ctx.getCivilization(civ);
  const ids=new Set(Object.keys(U).concat(Object.keys(c.uniqueUnits||{})));
  const bonuses=Object.values(c.techTree||{}).filter(t=>t.bonus&&t.bonus.range);
  for(const id of ids){
   const u=ctx.createUnit(id,0,0,'x',civ,'iron');if(!u||!(u.attack>0))continue;
   for(const t of bonuses)g.applyBonusToOneUnit(t.bonus,t.appliesTo,u);
   const reach=g.attackRangeAgainst(u,{type:'warrior'});
   if(reach>longest){longest=reach;who=civ+' '+id;}
  }
 }
 assert.ok(longest>=15,'the scan found the archers: '+longest+' '+who);
 for(const [id,b] of Object.entries(B))if(b&&b.range>longest){longest=b.range;who=id;}
 assert.equal(longest,18,'today: the tower ('+who+')');
 assert.ok(longest<SO.HOLD_LEASH,`the longest reach (${longest}, ${who}) must stay under the hold leash -- raise HOLD_LEASH with it`);
});

test('guard runs out to an enemy passing by; hold lets it pass outside its reach', () => {
 for(const [mode,engages] of [['guard',true],['hold',false]]){
  const h=posted(mode),u=h.owner.units[0];
  const passer=h.rival(10,0,'warrior');h.scan();
  assert.equal(u.attackTarget===passer,engages,mode);
 }
});

test('hold attacks unprovoked what is within its own reach', () => {
 const h=posted('hold'),u=h.owner.units[0];
 const close=h.rival(u.x+1.5,u.z,'warrior');h.scan();
 assert.equal(u.attackTarget,close);
});

test('hold answers an attacker within 19 of its slot, and not one beyond', () => {
 const h=posted('hold'),u=h.owner.units[0];
 const far=h.rival(u.x+25,u.z);h.g.noteRetaliation(u,far);h.scan();
 assert.notEqual(u.attackTarget,far,'25 away: outside its answer');
 const near=h.rival(u.x+15,u.z);h.g.noteRetaliation(u,near);h.scan();
 assert.equal(u.attackTarget,near,'15 away: answered');
 // Guard, for comparison, answers the far one.
 const gd=posted('guard'),v=gd.owner.units[0];const f2=gd.rival(v.x+25,v.z);gd.g.noteRetaliation(v,f2);gd.scan();
 assert.equal(v.attackTarget,f2);
});

test('an attacker that backs off past the leash is let go, and the unit returns to its slot', () => {
 const h=posted('hold'),u=h.owner.units[0],slot=h.grp.slots.get(u);
 const kiter=h.rival(slot.x+15,slot.z);h.g.noteRetaliation(u,kiter);h.scan();
 assert.equal(u.attackTarget,kiter);
 u.x=slot.x+8;kiter.x=slot.x+22;h.scan(2);   // it chased, the archer stepped back
 assert.equal(u.attackTarget,null,'released at the leash');
 h.scan(3);assert.equal(h.grp.fighting,false);
 assert.deepEqual([u.targetX,u.targetZ],[slot.x,slot.z],'back to its own slot');
});

test('the leash is measured from each unit\'s own slot, not the middle of the group', () => {
 const h=posted('hold',9),units=h.owner.units;
 const slotX=u=>h.grp.slots.get(u).x;
 const end=units.reduce((a,b)=>slotX(b)>slotX(a)?b:a),mid=units.reduce((a,b)=>Math.abs(slotX(b))<Math.abs(slotX(a))?b:a);
 const s=h.grp.slots.get(end);
 assert.ok(s.x>=3,'a line wide enough to tell them apart: '+s.x);
 const raider=h.rival(s.x+17,s.z);   // 17 from the end of the line, more than 19 from its middle
 h.g.noteRetaliation(end,raider);h.scan();
 assert.equal(end.attackTarget,raider,'the unit it can reach answers');
 assert.notEqual(mid.attackTarget,raider,'the middle stays');
});

test('the mode is offered to the model and accepted by the executor', () => {
 const src=fs.readFileSync(path.join(__dirname,'../js/openai-ai.js'),'utf8');
 assert.match(src,/enum:\['march','scout','guard','hold','patrol'\]/);
 assert.match(src,/hold \(defend the destination from each unit's own spot/);
});

// b1045: a holding unit defends what it stands under, not only itself.
test('a swordsman on the tower draws in holding melee within 19; a raid 30 away does not', () => {
 const h=posted('hold'),u=h.owner.units[0],slot=h.grp.slots.get(u);
 const tower={id:'t1',type:'tower',owner:'a',x:slot.x+6,z:slot.z,health:500,maxHealth:500};h.owner.buildings.push(tower);
 const farm={id:'f1',type:'farm',owner:'a',x:slot.x-32,z:slot.z,health:200,maxHealth:200};h.owner.buildings.push(farm);
 const far=Object.assign(h.rival(slot.x-30,slot.z,'warrior'),{attackTarget:farm,isAttacking:true});
 h.scan();assert.notEqual(u.attackTarget,far,'the farm raid is 30 from its spot: not its fight');
 const hacker=Object.assign(h.rival(slot.x+5,slot.z,'warrior'),{attackTarget:tower,isAttacking:true});
 h.scan();assert.equal(u.attackTarget,hacker,'5 from its spot, hitting its tower: answered');
});

// b1045: "noDefenders" counted only the idle soldiers the auto-defense sends, so units under
// any standing order fighting the raider in front of it were reported as nobody.
test('noDefenders stays off while guards fight the raider, and is on when nobody does', async () => {
 const look=async guarded=>{
  const m=await createMatch({kind:'board',seed:'no-defenders',seats:[
   {civ:'greek',age:'bronze',buildings:[['town_center',-250,0],['house',0,0,{tag:'house'}]],units:guarded?[['warrior',6,6,{tag:'guard'}]]:[]},
   {civ:'persian',age:'bronze',buildings:[['town_center',250,0]],units:[['warrior',4,0,{tag:'raider'}]]}]});
  const c=m.controllers[0],house=m.tags.house,raider=m.tags.raider;
  if(guarded)assert.match(String(m.command(c,'move_units',{mode:'guard',targetX:6,targetZ:6})),/^OK/);
  raider.attackTarget=house;raider.isAttacking=true;
  m.advance(3000);
  const hit=m.game.openAIAIManager.buildGameStateJSON(c).threats.underAttack.find(t=>t.type==='house');
  return {hit,guardFighting:guarded&&!!m.tags.guard.attackTarget};
 };
 const alone=await look(false);
 assert.ok(alone.hit,'the house is reported hit');
 assert.equal(alone.hit.noDefenders,true,'nobody there');
 const held=await look(true);
 assert.ok(held.hit&&held.guardFighting,'the guard is fighting the raider');
 assert.equal(held.hit.noDefenders,undefined,'someone is: not "no defenders"');
});

// b1049: a mode that does not exist is refused with a code, not uncoded.
test('an unknown move mode is refused as moveBadMode', async () => {
    const m = await createMatch({ kind: 'board', seed: 'bad-mode', seats: [
        { civ: 'greek', age: 'bronze', buildings: [['town_center', -250, 0]], units: [['warrior', 0, 0]] },
        { civ: 'persian', age: 'bronze', buildings: [['town_center', 250, 0]] }] });
    const c = m.controllers[0], mgr = m.game.openAIAIManager;
    mgr.executeTurn(c, { commands: [{ action: 'move_units', params: { mode: 'attack', targetX: 10, targetZ: 0 } }] });
    const o = c._lastOutcome;
    assert.deepEqual([o.code, o.verdict], ['moveBadMode', 'avoidable']);
    assert.match(String(c.seat.lastActionResult), /mode must be march, scout, guard, hold or patrol/);
});

// b1051: two refusals that carried no code, seen in the 4 Oct match.
test('an attack with no target and an assignment with no resource are coded', async () => {
    const m = await createMatch({ kind: 'board', seed: 'coded-refusals', seats: [
        { civ: 'greek', age: 'bronze', buildings: [['town_center', -250, 0]], units: [['warrior', 0, 0], ['worker', -240, 0]] },
        { civ: 'persian', age: 'bronze', buildings: [['town_center', 250, 0]] }] });
    const c = m.controllers[0], mgr = m.game.openAIAIManager;
    mgr.executeTurn(c, { commands: [{ action: 'attack_target', params: { units: { warrior: 1 } } }] });
    assert.equal(c._lastOutcome.code, 'attackNeedsCoords');
    mgr.executeTurn(c, { commands: [{ action: 'assign_workers', params: { count: 1, from: 'idle' } }] });
    assert.equal(c._lastOutcome.code, 'assignNeedsResource', String(c.seat.lastActionResult));
});
