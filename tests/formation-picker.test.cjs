const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
function setup(){
 let now=1000,id=0;const timers=new Map(),listeners=new Map(),shown=[],orders=[];
 const document={addEventListener:(k,f)=>listeners.set(k,f),removeEventListener:(k,f)=>{if(listeners.get(k)===f)listeners.delete(k);}};
 const scope=vm.createContext({document,Date:{now:()=>now},Math,setTimeout:f=>{timers.set(++id,f);return id;},clearTimeout:i=>timers.delete(i)});
 const source=fs.readFileSync(path.join(__dirname,'../js/ui.js'),'utf8');
 vm.runInContext(source.slice(0,source.indexOf('    // EINE'))+'}\nthis.UI=UIManager;',scope);
 const units=[1,2].map(id=>({id,owner:'player',type:'warrior',unitType:'infantry',health:100}));
 const game={gameStarted:true,player:{units},renderer:{selectedUnits:units}},ui=Object.create(scope.UI.prototype);ui.game=game;
 ui.showPlayerFormationPicker=(e,f,u)=>shown.push({e,f,u});const target={},event={clientX:100,clientY:100,target};
 const issue=(shape,u)=>orders.push({shape,u});
 return {ui,game,units,event,issue,orders,shown,timers,listeners,advance:ms=>now+=ms,flush:()=>{for(const f of [...timers.values()])f();}};
}
test('double right-click issues one unformed order and never opens the picker',()=>{
 const h=setup();h.ui.choosePlayerFormation(h.event,h.issue);assert.equal(h.orders.length,0);assert.equal(h.shown.length,0);
 h.advance(200);h.ui.choosePlayerFormation({...h.event,clientX:102},h.issue);h.flush();
 assert.equal(h.orders.length,1);assert.equal(h.orders[0].shape,'');assert.equal(h.orders[0].u.length,2);
 assert.equal(h.shown.length,0);assert.equal(h.timers.size,0);assert.equal(h.listeners.size,0);
});
test('a single click opens the picker; distant clicks and changed selections are not doubles',()=>{
 const h=setup();h.ui.choosePlayerFormation(h.event,h.issue);h.advance(351);h.flush();
 assert.equal(h.shown.length,1);assert.equal(h.orders.length,0);
 h.ui.choosePlayerFormation(h.event,h.issue);h.advance(100);h.ui.choosePlayerFormation({...h.event,clientX:130},h.issue);
 assert.equal(h.orders.length,0);h.flush();assert.equal(h.shown.length,2);
 h.ui.choosePlayerFormation(h.event,h.issue);h.game.renderer.selectedUnits=[h.units[0]];h.advance(100);h.ui.choosePlayerFormation(h.event,h.issue);
 assert.equal(h.orders.length,1);assert.equal(h.orders[0].shape,undefined);h.flush();assert.equal(h.shown.length,2);
});
test('Escape, another mouse button and explicit cancellation dismiss the pending picker',()=>{
 for(const how of ['escape','left','cancel']){
  const h=setup();h.ui.choosePlayerFormation(h.event,h.issue);
  if(how==='escape')h.listeners.get('keydown')({key:'Escape'});
  else if(how==='left')h.listeners.get('pointerdown')({button:0,target:h.event.target});else h.ui.closeFormationPicker();
  h.flush();assert.equal(h.shown.length,0);assert.equal(h.orders.length,0);assert.equal(h.listeners.size,0);
 }
});
test('workers and single fighters order immediately; touch formation selection has no double-click delay',()=>{
 const h=setup();h.units.forEach(u=>u.type='worker');h.ui.choosePlayerFormation(h.event,h.issue);
 assert.equal(h.orders.length,1);assert.equal(h.timers.size,0);
 h.units.forEach(u=>u.type='warrior');h.ui.choosePlayerFormation({...h.event,fromTouch:true},h.issue);
 assert.equal(h.shown.length,1);assert.equal(h.timers.size,0);
});
