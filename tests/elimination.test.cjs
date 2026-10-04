const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
function setup(){
 const scope={console:{log(){}},getBuildingDef:()=>({cost:{stone:100}}),
  getUnitDefFor:(_,id)=>id==='scout_cavalry'?{tier:'neolithic',cost:{food:100,gold:50}}:null,
  getCivilization:()=>({name:'Yamato',color:1})};
 vm.createContext(scope);
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../js/game.js'),'utf8'),scope);
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../js/openai-ai.js'),'utf8'),scope);
 const game=Object.create(vm.runInContext('Game.prototype',scope));
 const funds={food:200,gold:100,stone:0};
 const ai={id:'a',civilization:'yamato',age:'iron',units:[],buildings:[],resources:{hasResources:cost=>Object.entries(cost).every(([k,v])=>(funds[k]||0)>=v)}};
 const stable={owner:'a',type:'stable',health:50,underConstruction:true};
 const worker={owner:'a',type:'worker',health:50,task:'building',buildTarget:stable};
 ai.units.push(worker);ai.buildings.push(stable);
 const manager=Object.create(vm.runInContext('OpenAIAIManager.prototype',scope));
 Object.assign(manager,{game,askFinalWord(){},abortLanes(){},commitDecision(){},decisionLog:[],maxLogEntries:400});
 const controller={aiPlayer:ai,id:'a'};controller.seat=controller;
 return {game,ai,stable,worker,funds,manager,controller};
}
test('last finished trainer can fall while a staffed affordable stable keeps the player active',()=>{
 const h=setup();const old={type:'stable',health:100};h.ai.buildings.push(old);
 assert.equal(h.game.isPlayerEliminated(h.ai),false);
 old.health=0;
 assert.equal(h.manager.isControllerDefeated(h.controller),false);
 h.stable.underConstruction=false;h.worker.task=null;
 assert.equal(h.game.isPlayerEliminated(h.ai),false);
 assert.equal(h.controller.defeated,undefined);
});
// The rule since 1 Oct 2026 (asp67): out once nothing on the field can fight or build, and
// no building can actively produce such a unit (unfinished, or unable to pay for one).
test('a site counts while any worker could finish it; with no worker, or no site and no means, the seat is out',()=>{
 for(const [label,change,out] of [
  ['its builder dead',h=>h.worker.health=0,true],
  ['the site destroyed and nothing affordable',h=>h.stable.health=0,true],
  ['its builder idle: it can still finish it',h=>h.worker.task='idle',false],
  ['its builder on another job',h=>h.worker.buildTarget={},false],
  ['no gold for a unit yet: the site still stands',h=>h.funds.gold=0,false],
 ]){const h=setup();change(h);assert.equal(h.game.isPlayerEliminated(h.ai),out,label);}
});
test('paid military production keeps a penniless player alive until the unit emerges',()=>{
 const h=setup();h.ai.units=[];h.stable.underConstruction=false;
 h.stable.isProducing=true;h.stable.productionType='scout_cavalry';h.funds.food=h.funds.gold=0;
 assert.equal(h.game.isPlayerEliminated(h.ai),false);
 h.stable.isProducing=false;h.ai.units.push({type:'scout_cavalry',health:100});
 assert.equal(h.game.isPlayerEliminated(h.ai),false);
 h.ai.units[0].health=0;assert.equal(h.game.isPlayerEliminated(h.ai),true);
});
test('retired controller cannot become alive again when old construction finishes',()=>{
 const h=setup();h.worker.health=0;assert.equal(h.manager.isControllerDefeated(h.controller),true);
 h.manager.markDefeated(h.controller);
 h.stable.underConstruction=false;
 assert.equal(h.controller.defeated,true);assert.equal(h.game.isPlayerEliminated(h.ai),true);
 const winner={units:[{type:'warrior',health:100}],buildings:[]};
 h.game.aiManager={aiPlayers:[h.ai,winner]};let result;
 h.game.endArena=(ai,reason)=>result={ai,reason};h.game.checkArenaEnd(50);
 assert.equal(result.ai,winner);assert.equal(result.reason,'last_standing');
});
test('active construction prevents premature arena victory; losing the builder allows it',()=>{
 const h=setup(),winner={units:[{type:'warrior',health:100}],buildings:[]};
 h.game.aiManager={aiPlayers:[h.ai,winner]};let result;
 h.game.endArena=(ai,reason)=>result={ai,reason};h.game.checkArenaEnd(50);
 assert.equal(result,undefined);assert.equal(h.ai._eliminated,undefined);
 h.worker.health=0;h.game.checkArenaEnd(50);
 assert.equal(result.ai,winner);assert.equal(h.ai._eliminated,true);
});
test('a defeated seat cannot win through a leftover wonder',()=>{
 const h=setup();h.ai._eliminated=true;h.ai.buildings.push({isWonder:true,health:100});h.ai._wonderHold=599999;
 const winner={units:[{type:'warrior',health:100}],buildings:[]};h.game.aiManager={aiPlayers:[h.ai,winner]};
 let result;h.game.endArena=(ai,reason)=>result={ai,reason};h.game.checkArenaEnd(100);
 assert.equal(result.ai,winner);assert.equal(result.reason,'last_standing');
});

test('opponent snapshots expose defeat independently of discovery, including human opponents',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../js/openai-ai.js'),'utf8');
 const start=source.indexOf('const met = ai._metRivals');
 const end=source.indexOf('// --- Threats',start);
 const opponents=(game,ai)=>new Function('game','ai','memory',source.slice(start,end)+'return aiOpponents;')(game,ai,ai);
 const h=setup(),viewer={id:'viewer',_metRivals:new Set(['known'])};
 const known={id:'known',civilization:'greek',age:'bronze',units:[{type:'warrior',health:100}],buildings:[]};
 h.ai._eliminated=true;
 h.game.seatLabel=o=>o.id;h.game.spectatorMode=false;h.game.unitMemoryTally=()=>null;
 h.game.player={id:'player',civilization:'persian',age:'iron',units:[],buildings:[],_eliminated:true};
 h.game.aiManager={aiPlayers:[viewer,h.ai,known]};
 const rows=opponents(h.game,viewer);
 assert.equal(rows.length,3);
 assert.deepEqual(rows[0],{id:'a',civilization:'yamato',age:'iron',discovered:false,defeated:true});
 assert.deepEqual(rows[1],{id:'known',civilization:'greek',age:'bronze',discovered:true,defeated:false,population:1,buildings:0});
 assert.equal(rows[2].defeated,true);assert.equal(rows[2].discovered,false);
 assert.equal('population' in rows[2],false);assert.equal('buildings' in rows[2],false);
 viewer._metRivals.add('a');const discovered=opponents(h.game,viewer)[0];
 assert.equal(discovered.defeated,true);assert.equal(discovered.discovered,true);
});

// 1 Oct 2026: an unfinished Town Center kept a seat in the match with no one building it,
// and a priest -- which can neither fight nor build -- counted as an army.
test('an unfinished Town Center keeps a seat in only while it has a worker; a Town Center needs a worker or food',()=>{
 const h=setup();h.ai.buildings=[];h.funds.food=h.funds.gold=h.funds.stone=0;
 const tc={owner:'a',type:'town_center',health:300,underConstruction:true};h.ai.buildings.push(tc);
 h.worker.buildTarget=tc;h.worker.task='harvesting';
 assert.equal(h.game.isPlayerEliminated(h.ai),false,'a worker who could finish it keeps the seat in');
 h.worker.health=0;
 assert.equal(h.game.isPlayerEliminated(h.ai),true,'no one left to finish it: out');
 tc.underConstruction=false;
 assert.equal(h.game.isPlayerEliminated(h.ai),true,'a finished Town Center with no worker and no food: out');
 h.funds.food=50;
 assert.equal(h.game.isPlayerEliminated(h.ai),false,'it can train a worker: in');
 h.funds.food=0;h.worker.health=50;
 assert.equal(h.game.isPlayerEliminated(h.ai),false,'a worker can gather into it: in');
});

test('priests and towers are no army; a paid unit in training is',()=>{
 const g=setup();g.ai.buildings=[{type:'tower',health:500}];g.ai.units=[{type:'priest',unitType:'support',health:80}];g.funds.food=g.funds.gold=0;
 assert.equal(g.game.isPlayerEliminated(g.ai),true,'priests and a tower cannot play on');
 g.ai.units.push({type:'warrior',unitType:'infantry',health:40});
 assert.equal(g.game.isPlayerEliminated(g.ai),false,'a soldier can');
 g.ai.units.pop();g.ai.buildings.push({type:'town_center',health:900,isProducing:true,productionType:'worker'});
 assert.equal(g.game.isPlayerEliminated(g.ai),false,'a worker already paid for is on its way');
});

// asp67, 4 Oct 2026 (b1054): GLM had lost every building but an archery range, with the bank
// for archers and not one population slot, and was kept in the match. Producing needs room.
test('a trainer and a full bank do not keep a seat in without a population slot', async () => {
    const { createMatch } = require('../tools/bench/realm.cjs');
    const m = await createMatch({ kind: 'board', seed: 'no-room', seats: [
        { civ: 'egyptian', age: 'bronze', buildings: [['archery_range', 0, 0]], resources: { food: 2000, wood: 2000, stone: 0, gold: 500 } },
        { civ: 'greek', age: 'bronze', buildings: [['town_center', 200, 0]] }] });
    const g = m.game, ai = m.seats[0];
    g.recomputeMaxPopulation(ai);
    assert.equal(ai.resources.maxPopulation, 0, 'no house, no Town Center: no slot');
    assert.equal(g.canAffordAnyMilitary(ai), true, 'it can pay for archers');
    assert.equal(g.isPlayerEliminated(ai), true, 'and still it cannot play');
    // A house gives room: in again.
    m.addBuilding(ai, 'house', 20, 0);
    g.recomputeMaxPopulation(ai);
    assert.equal(g.isPlayerEliminated(ai), false, 'with a slot, the range can train');
});

test('without room, a worker who can build a house it may build keeps the seat in', async () => {
    const { createMatch } = require('../tools/bench/realm.cjs');
    const m = await createMatch({ kind: 'board', seed: 'no-room-b', seats: [
        { civ: 'egyptian', age: 'bronze', buildings: [['archery_range', 0, 0]], units: [['worker', 5, 5]],
          resources: { food: 2000, wood: 2000, stone: 0, gold: 500 } },
        { civ: 'greek', age: 'bronze', buildings: [['town_center', 200, 0]] }] });
    const g = m.game, ai = m.seats[0];
    g.recomputeMaxPopulation(ai);
    ai.researchedTechs = ai.researchedTechs || {};
    delete ai.researchedTechs.house;
    assert.equal(g.isPlayerEliminated(ai), true, 'a worker and no way to raise the cap: out');
    ai.researchedTechs.house = true;
    assert.equal(g.isPlayerEliminated(ai), false, 'it may build a house: it can climb back');
});
