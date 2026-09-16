const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
function fixture(){
 const scope={console:{log(){},warn(){},error(){}}};vm.createContext(scope);
 for(const name of ['civilizations','buildings','units','resources','game','ai','openai-ai']){
  let source=fs.readFileSync(path.join(__dirname,'../js/'+name+'.js'),'utf8');
  if(name==='game')source=source.split('\nconst WAR_PRIVATE_HOST')[0];vm.runInContext(source,scope);
 }
 return vm.runInContext(`(()=>{
  game=new Game();game.spectatorMode=true;game.renderer={killUnit(){},killBuilding(){},addUnit(){}};
  game.aiManager=new AIManager(game);game.openAIAIManager=new OpenAIAIManager(game);
  const ai=game.aiManager.addAIPlayer('greek');ai.age='bronze';
  game.renderer.units=ai.units;game.renderer.buildings=ai.buildings;
  Object.assign(ai.resources,{food:5000,wood:5000,stone:5000,gold:5000});
  const tc=createBuilding('town_center',0,0,ai.id,ai.civilization,{age:ai.age});ai.buildings.push(tc);
  game.recomputeMaxPopulation(ai);
  const add=type=>{const u=createUnit(type,20,20,ai.id,ai.civilization,ai.age);ai.units.push(u);ai.resources.updatePopulation(ai.units.length);return u;};
  return {game,ai,tc,add};
 })()`,scope);
}
test('casualties update population immediately, including repeated destruction',()=>{
 const {game,ai,add}=fixture();for(let i=0;i<14;i++)add('worker');for(let i=0;i<4;i++)add('warrior');
 const victims=ai.units.slice(0,14);
 for(const victim of victims){victim.health=0;game.destroyTarget(victim);assert.equal(ai.resources.population,ai.units.length);}
 game.destroyTarget(victims[0]);assert.equal(ai.resources.population,4);
 assert.equal(ai.units.filter(u=>u.type==='worker').length,0);
});
test('a casualty frees a training slot without waiting for a browser tick',()=>{
 const {game,ai,tc,add}=fixture();for(let i=0;i<10;i++)add('worker');
 assert.equal(ai.resources.population,ai.resources.maxPopulation);
 game.deleteOwnUnit(ai.units[0]);assert.equal(ai.resources.population,9);
 assert.match(game.openAIAIManager.executeTrainUnit(ai,game,'worker',{}),/^OK/);
 assert.equal(tc.isProducing,true);assert.equal(ai.resources.population,9);
 game.updateProduction(tc.productionDuration);assert.equal(ai.resources.population,10);assert.equal(ai.units.length,10);
});
test('destroying housing changes capacity without erasing surviving units',()=>{
 const {game,ai,tc,add}=fixture();for(let i=0;i<4;i++)add('warrior');tc.health=0;game.destroyTarget(tc);
 assert.equal(ai.resources.maxPopulation,0);assert.equal(ai.resources.population,4);assert.equal(ai.buildings.length,0);
});
