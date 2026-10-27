const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
function setup(){
 const scope=vm.createContext({console,getCivilization:()=>({uniqueBuildings:[],techTree:{},bonuses:{}})});
 for(const file of ['simulation/math','buildings','units','openai-ai'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../js/'+file+'.js'),'utf8'),scope);
 const Manager=vm.runInContext('OpenAIAIManager',scope),m=new Manager({});
 const ai={id:'a',civilization:'greek',age:'iron',researchedTechs:{tower:true},units:[],buildings:[],resources:{hasResources:()=>true,spendResources(){spent++;}}};
 let spent=0;const added=[];
 const game={player:{buildings:[]},aiManager:{aiPlayers:[]},resourceClearance:()=>5,
  renderer:{addBuilding:b=>added.push(b)},pickBuilder:()=>({worker:{}}),applyBuilder(){},rand:()=>0.5};
 m.couldBeBlindDuplicate=()=>false;m.blindDuplicateBuilding=()=>null;m.noteIdleTaken=()=>{};m.travelEtaSec=()=>0;
 return {m,ai,game,added,spent:()=>spent,build:(x,z)=>m.executeBuildStructure(ai,game,'tower',x,z)};
}
test('quoted building coordinates become numbers before placement and formation arithmetic',()=>{
 const h=setup();assert.match(h.build('-252','-162'),/^OK/);
 const b=h.added[0];assert.equal(b.x,-252);assert.equal(b.z,-162);
 assert.equal(b.x+-2.5,-254.5);assert.equal(b.z+2.5,-159.5);
 // A second nearby placement must nudge around the first using numeric arithmetic.
 assert.match(h.build('-250','-162'),/^OK/);
 const next=h.added[1];assert.ok(Number.isFinite(next.x)&&Number.isFinite(next.z));
 assert.ok(Math.hypot(next.x-b.x,next.z-b.z)>=9);
});
test('malformed or incomplete building coordinates fail before spending or creating a site',()=>{
 for(const [x,z]of [[NaN,0],[Infinity,0],['-252-2.5',0],[true,0],[[],0],[{},0],[10,undefined],[undefined,10],[' ',10]]){
  const h=setup();assert.match(h.build(x,z),/^\[ERROR\]/,String(x));assert.equal(h.spent(),0);assert.equal(h.added.length,0);
 }
});
// asp67's match of 27 October (00:30): Sonnet 5.5 sent {"x": "150", "z": "-348"} for its
// buildings 23 times. The names were ignored and the building placed near the Town Center
// with an OK, so it never learned them; with no Town Center left, "No Town Center found for
// placement reference" did not say what was missing. Both now name targetX and targetZ.
test('a position under another name is refused with the right names; with no Town Center the error asks for the position',()=>{
 const h=setup(),M=h.m.constructor;
 const err=M.misnamedCoordinates('build_structure',{buildingType:'house',x:'150',z:'-348'});
 assert.match(err,/^\[ERROR\] build_structure takes a position as "targetX" and "targetZ".*you sent "x" and "z", which are not its parameters\. Nothing was done\./);
 assert.match(err,/leave out every coordinate to build near your Town Center/);
 assert.match(M.misnamedCoordinates('move_units',{position:{x:1,z:2}}),/you sent "position", which is not one of its parameters/);
 assert.equal(M.misnamedCoordinates('build_structure',{buildingType:'house',targetX:1,targetZ:2,x:5}),null,'a stray x beside targetX changes nothing');
 assert.equal(M.misnamedCoordinates('build_structure',{buildingType:'house'}),null,'no position at all: placed near the Town Center');
 assert.equal(M.misnamedCoordinates('research_tech',{techId:'farm',x:3}),null,'an action without a position');
 // No Town Center and no position: the answer asks for the position.
 assert.match(h.m.executeBuildStructure(h.ai,h.game,'tower',undefined,undefined),/needs "targetX" and "targetZ" here: you have no Town Center/);
});
