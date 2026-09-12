const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
function setup(){
 const scope=vm.createContext({console,getCivilization:()=>({uniqueBuildings:[],techTree:{},bonuses:{}})});
 for(const file of ['buildings','units','openai-ai'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../js/'+file+'.js'),'utf8'),scope);
 const Manager=vm.runInContext('OpenAIAIManager',scope),m=new Manager({});
 const ai={id:'a',civilization:'greek',age:'iron',researchedTechs:{tower:true},units:[],buildings:[],resources:{hasResources:()=>true,spendResources(){spent++;}}};
 let spent=0;const added=[];
 const game={player:{buildings:[]},aiManager:{aiPlayers:[]},resourceClearance:()=>5,
  renderer:{addBuilding:b=>added.push(b)},pickBuilder:()=>({worker:{}}),applyBuilder(){}};
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
