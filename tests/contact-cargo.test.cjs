// The contact scan feeds each seat's memory of enemy units (asp67, b1042): a unit is
// remembered as last seen -- where, how hurt, what it carried, and where this pass through
// sight began -- until the seat sees it die, kills it, or looks at its spot and finds it
// gone. It replaced CONTACT / CONTACT LOST lines, which a model had to carry itself.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
function setup(){
 const scope={console,BUILDING_DEFS:{}};vm.createContext(scope);
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../js/simulation/math.js'),'utf8'),scope);vm.runInContext(fs.readFileSync(path.join(__dirname,'../js/game.js'),'utf8'),scope);
 const Game=vm.runInContext('Game',scope),g=Object.create(Game.prototype);
 const eye={id:'eye',type:'warrior',x:0,z:0,health:100};
 const viewer={id:'a',units:[eye],buildings:[]};
 const rival={id:'b',units:[],buildings:[]};g.aiManager={aiPlayers:[viewer,rival]};
 g.unitVision=()=>20;g.buildingVision=()=>20;g.seatLabel=p=>typeof p==='string'?p:p.id;
 g.isPlayerEliminated=p=>!!p._eliminated;
 let clock=0;g.simNow=()=>clock;g.realSecsSince=at=>(clock-at)/1000;
 const logs=[];g.logPlayerEvent=(_,line)=>logs.push(line);
 const scan=(ms=1000)=>{clock+=ms;g._contactTurnIdx=1;g.detectContacts();};
 const list=()=>g.rememberedUnits(viewer);
 const one=id=>list().find(u=>u.id===id);
 const worker=(id,x=1,carrying='empty')=>({id,owner:'b',type:'worker',health:100,maxHealth:100,x,z:0,carryingResource:carrying!=='empty',carryingResourceType:carrying,harvestAmount:carrying==='empty'?0:10});
 const warrior=(id,x,z=0)=>({id,owner:'b',type:'warrior',health:100,maxHealth:100,x,z});
 const die=u=>{u.health=0;rival.units.splice(rival.units.indexOf(u),1);};
 return {g,eye,viewer,rival,logs,scan,list,one,worker,warrior,die};
}
test('observable cargo ignores stale type, task and destination',()=>{
 const {g,worker}=setup();const w=worker('w');w.carryingResourceType='gold';w.task='carrying';w.harvestTarget={type:'wood'};
 assert.equal(g.observedWorkerLoad(w),'empty');
 for(const type of ['food','wood','stone','gold'])assert.equal(g.observedWorkerLoad(worker('w',1,type)),type);
 assert.equal(g.observedWorkerLoad({type:'warrior'}),undefined);
});
test('a worker out of sight keeps its last visible cargo and position, with where it came into sight',()=>{
 const {rival,logs,scan,one,worker}=setup();const w=worker('w',1,'wood');rival.units=[w];scan();
 assert.deepEqual(JSON.parse(JSON.stringify(one('w'))),{id:'w',type:'worker',x:1,z:0,owner:'b',healthPct:100,carrying:'wood',visible:true});
 w.x=10;scan();w.x=30;w.carryingResource=false;w.harvestAmount=0;scan(3000);
 assert.deepEqual(JSON.parse(JSON.stringify(one('w'))),
  {id:'w',type:'worker',x:10,z:0,owner:'b',healthPct:100,carrying:'wood',visible:false,secondsAgo:3,sightedAt:[1,0]},
  'as last seen, the deposit unseen; from (1,0) to (10,0) is its heading');
 assert.equal(logs.length,0,'no CONTACT lines any more');
});
test('cargo picked up in sight is refreshed; coming back starts a new pass',()=>{
 const {rival,scan,one,worker}=setup();const w=worker('w');rival.units=[w];scan();
 w.carryingResource=true;w.harvestAmount=10;w.carryingResourceType='wood';scan();
 assert.equal(one('w').carrying,'wood');
 w.x=40;scan();w.x=5;scan();
 const u=one('w');assert.equal(u.visible,true);assert.equal(u.x,5);assert.equal(u.sightedAt,undefined,'the new pass began where it stands');
});
// asp67, 3 Oct 2026: a fight's enemies stand still; when the watcher died they vanished,
// and a model read the silence as their death.
test('an enemy that stood still is remembered when the view of it ends',()=>{
 const {g,viewer,rival,scan,list}=setup();
 rival.units=[1,2,3].map(i=>({id:'s'+i,owner:'b',type:'warrior',health:100,maxHealth:100,x:2,z:i}));scan();
 viewer.units=[{id:'far',type:'warrior',x:300,z:0,health:100}];scan();   // the watcher fell; a unit far off still looks
 assert.equal(list().length,3);
 assert.ok(list().every(u=>u.visible===false&&u.sightedAt===undefined));
 assert.deepEqual(JSON.parse(JSON.stringify(g.unitMemoryTally(viewer,'b').counts)),{warrior:3});
});
test('walking out of a watched view keeps its last spot',()=>{
 const {rival,scan,one,warrior}=setup();const w=warrior('w',5);rival.units=[w];scan();
 w.x=15;scan();w.x=60;scan();scan();scan();
 assert.deepEqual([one('w').x,one('w').visible,one('w').sightedAt.join()],[15,false,'5,0'],'its spot stays in sight, but it was never looked for there after going');
});
test('seen to die it is forgotten; dying unseen it is remembered',()=>{
 const {rival,scan,one,warrior,die}=setup();const a=warrior('a',5),b=warrior('b',8);rival.units=[a,b];scan();
 die(a);scan();
 assert.equal(one('a'),undefined,'died in sight');
 b.x=100;scan();die(b);scan();
 assert.equal(one('b').visible,false,'walked off, then died where nobody watched: unknown');
});
test('killed by the seat\'s own units it is forgotten, even out of sight',()=>{
 const {rival,scan,one,warrior,die}=setup();const w=warrior('w',5);rival.units=[w];scan();
 w.x=100;scan();w._lastAttacker={owner:'a'};die(w);scan();
 assert.equal(one('w'),undefined);
});
test('its spot seen again without it: off the list, still in the tally',()=>{
 const {g,eye,viewer,rival,scan,one,warrior}=setup();const w=warrior('w',5);rival.units=[w];scan();
 eye.x=300;scan();               // looked away: the spot is out of sight
 w.x=-500;                       // it left while nobody watched
 eye.x=0;scan();                 // back: the spot is empty
 assert.equal(one('w'),undefined);
 assert.deepEqual(JSON.parse(JSON.stringify(g.unitMemoryTally(viewer,'b'))),{counts:{warrior:1},newest:2,oldest:2});
});
test('fifty are listed, in sight first and then the newest; the rest stay remembered',()=>{
 const {g,viewer,rival,scan,list,warrior}=setup();
 rival.units=Array.from({length:60},(_,i)=>warrior('w'+i,i%2?-5:5,(i-30)/3));scan();
 rival.units.slice(0,40).forEach(u=>{u.x+=400;});scan();   // forty walk away, twenty stay
 const l=list();
 assert.equal(l.length,50);
 assert.ok(l.slice(0,20).every(u=>u.visible)&&l.slice(20).every(u=>!u.visible));
 assert.equal(g.unitMemoryTally(viewer,'b').counts.warrior,60);

});
test('a defeated owner\'s units out of sight are forgotten',()=>{
 const {rival,scan,list,warrior}=setup();const w=warrior('w',5);rival.units=[w];scan();
 w.x=100;rival._eliminated=true;scan();
 assert.equal(list().length,0);
});
