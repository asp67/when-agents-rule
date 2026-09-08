const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
function setup(href){
 const calls=[],events={},stored={};
 const scope={console,URL,URLSearchParams,document:{},WAR_DEMO_ONLY:false,
  location:{href,search:new URL(href).search,replace:url=>calls.push(['replace',url]),reload:()=>calls.push(['reload'])},
  sessionStorage:{setItem:(k,v)=>stored[k]=v},
  window:{addEventListener:(name,fn)=>events[name]=fn}};
 vm.createContext(scope);
 const root=path.resolve(__dirname,'..');
 // Load the actual class and showcase extension without constructing the engine.
 const source=fs.readFileSync(path.join(root,'js/game.js'),'utf8');
 vm.runInContext(source.slice(0,source.indexOf('\nconst WAR_PRIVATE_HOST')) || source,scope);
 vm.runInContext(fs.readFileSync(path.join(root,'js/showcase.js'),'utf8'),scope);
 const game=vm.runInContext('Object.create(Game.prototype)',scope);
 game.renderer={};scope.game=game;
 return {scope,game,calls,events,stored};
}

test('switching civilization replaces the current showcase history entry',()=>{
 const {game,calls}=setup('http://localhost:8080/game/?full=1#view');
 game._showcaseCivilization='greek';game.loadShowcaseCivilization('egyptian');
 assert.equal(calls[0][0],'replace');
 const url=new URL(calls[0][1]);assert.equal(url.searchParams.get('civ'),'egyptian');
 assert.equal(url.searchParams.get('showcase'),'1');assert.equal(url.searchParams.get('full'),'1');assert.equal(url.hash,'#view');
});

test('Back leaves every civilization and reload cannot reopen the showcase',()=>{
 for(const civ of ['greek','egyptian','yamato','persian']){
  const {game,calls,stored}=setup(`http://localhost:8080/game/?showcase=1&civ=${civ}&full=1#view`);
  game._showcaseCivilization=civ;game.gameStarted=true;game.spectatorMode=false;
  game.confirmCancelGame();assert.equal(game.gameStarted,false);assert.equal(stored.altertum_return,'start');
  assert.equal(calls[0][0],'replace');assert.equal(calls[0][1],'http://localhost:8080/game/?full=1#view');
  const next=setup(calls[0][1]);let starts=0;next.game.startVisualShowcase=()=>starts++;
  next.events.load();assert.equal(starts,0,'clean destination stays in the menu');
 }
});

test('Main menu clears direct-link routing even after the demo ends',()=>{
 const {game,calls}=setup('http://localhost:8080/?showcase=1&civ=persian');
 game.reloadToMenu();assert.deepEqual(calls,[['replace','http://localhost:8080/']]);
});

test('ordinary campaigns and arenas retain their existing return destinations',()=>{
 for(const spectatorMode of [false,true]){
  const {game,calls,stored}=setup('http://localhost:8080/?full=1');
  game.spectatorMode=spectatorMode;game.confirmCancelGame();
  assert.deepEqual(calls,[['reload']]);assert.equal(stored.altertum_return,spectatorMode?'arena':'mode');
 }
});

test('showcase selectors preserve terrain and age in the URL and menu clears them',()=>{
 const {game,calls}=setup('http://localhost:5173/?showcase=1&civ=greek');
 game._showcaseCivilization='greek';game.loadShowcaseCivilization('yamato','winter','bronze');
 const url=new URL(calls[0][1]);assert.equal(url.searchParams.get('terrain'),'winter');assert.equal(url.searchParams.get('age'),'bronze');
 const next=setup(url.href);next.game.reloadToMenu();assert.equal(next.calls[0][1],'http://localhost:5173/');
});
