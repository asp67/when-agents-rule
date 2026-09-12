const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
function harness(storage=new Map()){
    const param=()=>{let value=0;return {get value(){return value;},set value(v){if(!Number.isFinite(v)||Math.abs(v)>3.402823466e38)throw new TypeError('AudioParam requires a finite float');value=v;},cancelScheduledValues(){},setTargetAtTime(v){this.value=v;},setValueAtTime(v){this.value=v;}};};
    const node=()=>({gain:param(),pan:param(),frequency:param(),playbackRate:param(),connect(){},disconnect(){},start(){},stop(){this.onended?.();}});
    let contexts=0,active=true,visible=true;
    const document={hidden:false,addEventListener(){},getElementById:()=>({classList:{contains:()=>active}})};
    class Context {
        constructor(){contexts++;this.currentTime=0;this.state='suspended';this.destination={};}
        createGain(){return node();}createStereoPanner(){return node();}createBiquadFilter(){return node();}createBufferSource(){return node();}
        createDynamicsCompressor(){return {...node(),threshold:param(),knee:param(),ratio:param(),attack:param(),release:param()};}
        createBuffer(channels,length,rate){const data=new Float32Array(length);return {getChannelData:()=>data,sampleRate:rate,duration:length/rate};}
        async resume(){this.state='running';}async suspend(){this.state='suspended';}
    }
    const sessionStorage={getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)};
    const scope=vm.createContext({window:{AudioContext:Context},document,sessionStorage,localStorage:{getItem(){return null;},setItem(){}},console,Math:Object.create(Math)});
    scope.Math.random=()=>{throw Error('Audio must not consume gameplay randomness');};
    vm.runInContext(fs.readFileSync(path.join(__dirname,'../js/audio.js'),'utf8')+'\nthis.WarAudio=WarAudio;',scope);
    const game={gameStarted:true,pauseState:'running',spectatorMode:false,fogOfWar:{isPositionCurrentlyVisible:()=>visible},renderer:{cameraTarget:{x:0,z:0},_halfH:65,_yaw:0,units:[],buildings:[]}};
    const sound=new scope.WarAudio(game);
    return {sound,game,document,scope,setVisible:v=>visible=v,setScreen:v=>active=v,contexts:()=>contexts};
}
test('footsteps follow grass, snow, sand and dry gravel patches for walkers and horses',()=>{
    const {sound:s,scope}=harness(),unit={x:20,z:0};
    assert.equal(s.footstepKind(unit,'summer'),'step');
    assert.equal(s.footstepKind(unit,'winter'),'snow');
    assert.equal(s.footstepKind(unit,'desert'),'snow');
    let cover=0;
    scope.TexGen={grassCoverSampler:()=>()=>cover};
    for(const theme of ['summer','winter','desert']) {
        assert.equal(s.footstepKind(unit,theme),'gravel');
        assert.equal(s.footstepKind({...unit,unitType:'cavalry'},theme),'hoofGravel');
    }
    cover=1;
    assert.equal(s.footstepKind(unit,'summer'),'step');
    assert.equal(s.footstepKind(unit,'desert'),'snow');
    assert.equal(s.footstepKind({...unit,unitType:'cavalry'},'desert'),'hoofSnow');
});
test('movement cadence follows effective speed while work sounds keep their timing',()=>{
    for(const [speed,pace] of [[1,1],[1.5,1.25],[2,1.5],[4,2]]) {
        for(const kind of ['step','snow','gravel','hoof','hoofSnow','hoofGravel','chop']) {
            const {sound:s,game}=harness();game.simSpeed=speed;
            const gap=kind==='chop'?1.1:(kind.startsWith('hoof')?.28:.42)/pace;
            assert.equal(s.allow(kind,{x:0,z:0},0),true);
            assert.equal(s.allow(kind,{x:0,z:0},gap-.001),false);
            assert.equal(s.allow(kind,{x:0,z:0},gap+.001),true);
        }
    }
    const {sound:s,game}=harness();game.simSpeed=4;game.effectiveSimSpeed=()=>1;
    assert.equal(s.movementCadence(),1);
});

test('audio starts off without allocating a context and synthesizes finite bounded buffers on opt-in',async()=>{
    const h=harness();assert.equal(h.sound.enabled,false);assert.equal(h.contexts(),0);
    await h.sound.setEnabled(true);assert.equal(h.contexts(),1);
    for(const choices of Object.values(h.sound.buffers))for(const buffer of choices){
        let peak=0;for(const n of buffer.getChannelData(0)){assert.ok(Number.isFinite(n));peak=Math.max(peak,Math.abs(n));}
        assert.ok(peak>0&&peak<1);
    }
    for(const [kind,dryDuration] of Object.entries({built:.425,research:.55,trained:.35,start:1.15,elimination:.9,victory:1.24,defeat:1.35,warning:.55})) {
        const buffer=h.sound.buffers[kind][0],data=buffer.getChannelData(0);
        assert.equal(buffer.sampleRate,20000);
        assert.ok(Math.abs(buffer.duration-(dryDuration+.48)*1.2)<2/buffer.sampleRate,kind);
        const tail=data.slice(Math.ceil(dryDuration*1.2*buffer.sampleRate));
        assert.ok(tail.some(v=>Math.abs(v)>.00001),kind+' has an audible echo tail');
        assert.equal(Math.abs(data[data.length-1]),0);
    }
    assert.equal(h.sound.buffers.command[0].duration,.65);
});
test('spectator captions only accompany admitted audible horns and carry specific completion details',async()=>{
 const h=harness(),s=h.sound,shown=[];h.game.spectatorMode=true;
 h.game.ui={showSpectatorSoundCaption:e=>shown.push(e)};
 const owner={civilization:'egyptian'},building={x:0,z:0,name:'House',civilization:'egyptian'};
 owner.buildings=[building];h.game.getOwnerByBuilding=()=>owner;
 s.completed('built',building);assert.equal(shown.length,0);
 await s.setEnabled(true);
 s.completed('built',{...building,x:999});assert.equal(shown.length,0);
 s.completed('built',{...building,mesh:{visible:false}});assert.equal(shown.length,0);
 s.completed('built',building);assert.equal(shown[0].name,'House');assert.equal(shown[0].civilization,'egyptian');
 s.completed('built',building);assert.equal(shown.length,1);
 s.completed('research',null,owner,{name:'Horseback riding'});assert.equal(shown[1].name,'Horseback riding');
 s.completed('trained',building,owner,{name:'Rider'});assert.equal(shown.length,2); // two-voice budget
 for(const v of [...s.voices])v.source.stop();s.ctx.currentTime+=2;
 s.levels.master=0;s.completed('trained',building,owner,{name:'Rider'});assert.equal(shown.length,2);
 s.levels.master=.5;s.levels.effects=0;s.notify('start',false,{});assert.equal(shown.length,2);
 for(const v of [...s.voices])v.source.stop();s.ctx.currentTime+=2;s.levels.effects=.6;
 s.completed('research',null,owner,{kind:'age',age:'iron'});assert.equal(shown[2].kind,'age');
 h.game.spectatorMode=false;s.notify('elimination',false,{civilization:'greek'});assert.equal(shown.length,3);
});

test('crossbow shots click while bows and tower volleys use the 50 percent louder bow release',()=>{
 const {sound:s}=harness(),heard=[],from={x:0,z:0};
 s.emit=(kind,position,gain)=>heard.push([kind,position,gain]);
 s.projectile(from,'arrow',{type:'crossbowman'});
 s.projectile(from,'arrow',{type:'archer'});
 s.projectile(from,'arrow');
 s.projectile(from,'stone');
 assert.deepEqual(heard,[['crossbow',from,.21],['bow',from,.21],['bow',from,.21]]);
});

test('sword infantry use steel clashes while clubs, mounted weapons and building hits retain their sounds',()=>{
 const {sound:s}=harness(),heard=[];s.enabled=true;s.emit=kind=>heard.push(kind);
 const unit={unitType:'infantry',x:0,z:0},building={type:'house',x:0,z:0};
 for(const type of ['militia','warrior','champion','cavalry','worker','archer'])s.combat({type},unit);
 s.combat({type:'champion'},building);
 assert.deepEqual(heard,['impact','steel','steel','impact','impact','impact','stone']);
});

test('hidden enemies and explored-only locations cannot emit sounds; spectators follow visible meshes',async()=>{
    const h=harness();await h.sound.setEnabled(true);h.setVisible(false);
    h.sound.emit('impact',{x:0,z:0},.5);assert.equal(h.sound.voices.size,0);
    h.game.spectatorMode=true;h.sound.emit('impact',{x:0,z:0,mesh:{visible:false}},.5);assert.equal(h.sound.voices.size,0);
    h.sound.emit('impact',{x:0,z:0},.5);assert.equal(h.sound.voices.size,1);
});
test('large battles are bounded by voice and wall-clock admission limits at any sim speed',async()=>{
    const h=harness();await h.sound.setEnabled(true);h.game.simSpeed=4;
    for(let i=0;i<500;i++)h.sound.emit('impact',{x:(i%7)*10-30,z:Math.floor(i/7)%7*10-30},.5);
    assert.ok(h.sound.voices.size<=14);assert.ok(h.sound.recent.length<=20);
    for(const voice of h.sound.voices)assert.ok(voice.source.playbackRate.value>.9&&voice.source.playbackRate.value<1.1);
});
test('camera cuts attenuate existing effects and zoomed-out scenes are quieter',async()=>{
    const h=harness();await h.sound.setEnabled(true);
    const s=h.sound,point={x:20,z:0};const near=s.spatial(point).gain;
    h.game.renderer._halfH=400;assert.ok(s.spatial(point).gain<near);
    h.game.renderer._halfH=65;s.emit('impact',point);const voice=[...s.voices][0];
    h.game.renderer.cameraTarget={x:500,z:500};s.update();assert.equal(voice.gain.gain.value,0);
});
test('pause, hidden tabs, menus, replay and disable silence audio without queued catch-up',async()=>{
    for(const mode of ['pause','hidden','menu','replay','disable']){
        const h=harness();await h.sound.setEnabled(true);h.sound.update();h.sound.emit('impact',{x:0,z:0});
        if(mode==='pause')h.game.pauseState='paused';
        if(mode==='hidden')h.document.hidden=true;
        if(mode==='menu')h.setScreen(false);
        if(mode==='replay')h.game.renderer.replayMode=true;
        if(mode==='disable')await h.sound.setEnabled(false);else h.sound.update();
        assert.equal(h.sound.master.gain.value,0,mode);assert.equal(h.sound.voices.size,0,mode);
        assert.equal(h.sound.cells.size,0,mode);
    }
});
test('only real moving groups generate steps, and a stationary unit does not',async()=>{
    const h=harness();await h.sound.setEnabled(true);
    const u={x:0,z:0,isMoving:true,unitType:'military'};h.game.renderer.units=[u];h.sound.update();
    h.sound.ctx.currentTime=.2;h.sound.update();assert.equal(h.sound.voices.size,0);
    u.x=1;h.sound.ctx.currentTime=.4;h.sound.update();assert.equal(h.sound.voices.size,1);
});
test('auditions are explicit showcase-only actions and do not move or damage entities',async()=>{
    const h=harness();await h.sound.audition('impact');assert.equal(h.contexts(),0);
    h.game._showcaseCivilization='greek';h.setVisible(false);
    await h.sound.audition('unknown');assert.equal(h.contexts(),0);
    const before=JSON.stringify(h.game.renderer);
    await h.sound.audition('impact');assert.equal(h.sound.enabled,false);assert.equal(h.contexts(),0);
    await h.sound.setEnabled(true);
    await h.sound.audition('impact');assert.equal(h.sound.enabled,true);assert.equal(h.sound.voices.size,1);
    assert.equal(JSON.stringify(h.game.renderer),before);
    h.game._showcaseCivilization=null;
    assert.equal(h.sound.visible({x:0,z:0,audioPreview:true}),false);
});

test('mute is shared across scenes, survives internal navigation, and resets on browser reload',async()=>{
 const storage=new Map(),first=harness(storage);await first.sound.setEnabled(true);
 first.setScreen(false);first.sound.update();assert.equal(first.sound.enabled,true);
 first.setScreen(true);first.sound.update();assert.equal(first.sound.enabled,true);
 first.sound.preserveForNavigation();const next=harness(storage);await Promise.resolve();
 assert.equal(next.sound.enabled,true);assert.equal(storage.size,0);
 const reload=harness(storage);assert.equal(reload.sound.enabled,false);assert.equal(reload.contexts(),0);
 await next.sound.setEnabled(false);next.sound.preserveForNavigation();
 const muted=harness(storage);assert.equal(muted.sound.enabled,false);assert.equal(muted.contexts(),0);
});
test('worker sounds require actual gathering, exclude travel/carrying and cover food farms',()=>{
    const {sound:s}=harness();
    const u={type:'worker',task:'harvesting',isHarvesting:true,harvestTarget:{type:'wood',amount:100}};
    for(const [resource,expected] of [['wood','chop'],['food','harvest'],['gold','mine'],['stone','mine']]){
        u.harvestTarget.type=resource;assert.equal(s.workerSound(u),expected);
    }
    for(const overrides of [{isMoving:true},{carryingResource:true},{isAttacking:true},{isHarvesting:false},{task:'building'},{harvestTarget:{type:'wood',amount:0}}])
        assert.equal(s.workerSound({...u,...overrides}),null);
    const farm={...u,task:'farm_work',farmRef:{health:100,foodAmount:20},harvestTimer:500};
    assert.equal(s.workerSound(farm),'harvest');
    for(const overrides of [{harvestTimer:0},{farmRef:{health:0,foodAmount:20}},{farmRef:{health:100,foodAmount:0}},{farmRef:{health:100,foodAmount:20,underConstruction:true}}])
        assert.equal(s.workerSound({...farm,...overrides}),null);
});
test('soft everyday samples have no sharp discontinuities or abrupt start',async()=>{
    const {sound:s}=harness();await s.setEnabled(true);
    for(const kind of ['step','snow','chop','harvest','mine','bow','impact','stone','build','built','research','trained'])for(const buffer of s.buffers[kind]){
        const data=buffer.getChannelData(0);let peak=0,jump=0;
        for(let i=1;i<data.length;i++){peak=Math.max(peak,Math.abs(data[i]));jump=Math.max(jump,Math.abs(data[i]-data[i-1]));}
        assert.equal(data[0],0);assert.ok(jump<.04,kind);assert.ok(peak>0&&peak<.5,kind);
    }
});
test('nearby gathering plays ambient work and respects the per-cell real-time cadence',async()=>{
    const h=harness();await h.sound.setEnabled(true);
    h.game.renderer.units=[{x:0,z:0,type:'worker',task:'harvesting',isHarvesting:true,harvestTarget:{type:'wood',amount:100}}];
    h.sound.update();assert.equal(h.sound.voices.size,1);
    const first=[...h.sound.voices][0];assert.ok(h.sound.buffers.chop.includes(first.source.buffer));
    first.source.stop();h.sound.ctx.currentTime=.2;h.sound.update();assert.equal(h.sound.voices.size,0);
    h.sound.ctx.currentTime=1.2;h.sound.update();assert.equal(h.sound.voices.size,1);
});

test('construction textures only play for workers actively building or repairing',()=>{
 const {sound:s}=harness(),site={health:20,maxHealth:100,underConstruction:true};
 const worker={type:'worker',task:'building',isBuilding:true,buildTarget:site};
 assert.equal(s.workerSound(worker),'build');
 for(const patch of [{isMoving:true},{isAttacking:true},{isBuilding:false},{buildTarget:{health:0}},{buildTarget:{health:100,maxHealth:100}}])
  assert.equal(s.workerSound({...worker,...patch}),null);
 assert.equal(s.workerSound({...worker,task:'repairing',repairTarget:{health:50,maxHealth:100}}),'build');
});

test('completion sounds obey mute, visibility and cadence and research uses an owned visible building',async()=>{
 const h=harness(),b={x:0,z:0,health:100};h.sound.completed('built',b);assert.equal(h.contexts(),0);
 await h.sound.setEnabled(true);h.sound.completed('built',b);h.sound.completed('built',b);assert.equal(h.sound.voices.size,1);
 h.setVisible(false);h.sound.completed('trained',b);assert.equal(h.sound.voices.size,1);
 h.setVisible(true);h.sound.completed('research',null,{buildings:[{...b,mesh:{visible:false}},b]});
 assert.equal(h.sound.voices.size,2);assert.equal([...h.sound.voices][1].notice,true);
 h.game.pauseState='paused';h.sound.completed('trained',b);assert.equal(h.sound.voices.size,2);
});

test('notifications have reserved capacity, own completions work off camera and outcomes survive match end',async()=>{
 const h=harness(),s=h.sound;h.game.player={};await s.setEnabled(true);s.update();
 for(let i=0;i<30;i++)s.emit('impact',{x:(i%5)*15-30,z:Math.floor(i/5)*15-30},.3);
 assert.equal([...s.voices].filter(v=>!v.notice).length,12);
 s.completed('research',null,h.game.player);s.completed('trained',{owner:'player',x:500,z:500});
 assert.equal([...s.voices].filter(v=>v.notice).length,2);
 s.notify('victory',true);h.game.gameStarted=false;h.setScreen(false);s.update();
 assert.equal(s.voices.size,1);assert.equal([...s.voices][0].persist,true);assert.ok(s.master.gain.value>0);
 await s.setEnabled(false);assert.equal(s.voices.size,0);assert.equal(s.ctx.state,'suspended');
});

test('non-positional notifications retain their volume and stay centred across camera moves and zoom',async()=>{
 const h=harness(),s=h.sound;await s.setEnabled(true);s.update();
 for(const kind of ['command','commandAction','start','elimination','victory','defeat','warning','research','trained','built','wonderLost']){
  h.game.renderer.cameraTarget={x:0,z:0};h.game.renderer._halfH=25;s.ctx.currentTime+=2;
  assert.equal(s.notify(kind),true);const near=[...s.voices][0],gain=near.gain.gain.value;
  assert.equal(near.pan,undefined,'notifications bypass spatial panning');
  h.game.renderer.cameraTarget={x:10000,z:-10000};h.game.renderer._halfH=1500;s.ctx.currentTime+=.2;s.update();
  assert.equal(near.gain.gain.value,gain,kind+' does not fade with camera movement');
  near.source.stop();s.ctx.currentTime+=2;s.notify(kind);
  const far=[...s.voices][0];assert.equal(far.gain.gain.value,gain,kind+' starts at the same volume when zoomed out');
  far.source.stop();
 }
});

test('hoofbeats match walking intensity including their faster cadence, without a hard strike',async()=>{
 const {sound:s}=harness();await s.setEnabled(true);
 const measure=kind=>{let energy=0,peak=0,jump=0;for(const b of s.buffers[kind]){
  const d=b.getChannelData(0);for(let i=0;i<d.length;i++){
   energy+=d[i]*d[i]/b.sampleRate;peak=Math.max(peak,Math.abs(d[i]));
   if(i)jump=Math.max(jump,Math.abs(d[i]-d[i-1]));
  }
 }return {energy:energy/4/(kind.startsWith('hoof')?.28:.42),peak,jump};};
 for(const [walk,horse] of [['step','hoof'],['snow','hoofSnow'],['gravel','hoofGravel']]) {
 const foot=measure(walk),hoof=measure(horse);
 assert.ok(hoof.energy/foot.energy>.7&&hoof.energy/foot.energy<1.3);
 assert.ok(hoof.peak<=foot.peak*1.1);assert.ok(hoof.jump<.04);
 }
});

test('worker slots skip cooldown groups and rotate to other nearby activities',async()=>{
 const h=harness(),s=h.sound;await s.setEnabled(true);
 h.game.renderer.units=Array.from({length:5},(_,i)=>({x:i*15,z:0,type:'worker',task:'harvesting',isHarvesting:true,harvestTarget:{type:i===4?'food':'wood',amount:100}}));
 s.update();assert.equal(s.voices.size,3);for(const v of [...s.voices])v.source.stop();
 s.ctx.currentTime=.2;s.update();assert.equal(s.voices.size,2);
 assert.ok([...s.voices].some(v=>s.buffers.harvest.includes(v.source.buffer)));
});

test('elimination and wonder warnings trigger only at transitions, not every tick',()=>{
 const h=harness(),s=h.sound,heard=[],wonder={isWonder:true,health:100};
 const owner={buildings:[wonder],_wonderHold:0};h.game.spectatorMode=true;h.game.aiManager={aiPlayers:[owner]};
 h.game.isPlayerEliminated=o=>!!o.gone;s.notify=kind=>heard.push(kind);
 s.matchEvents();s.matchEvents();assert.deepEqual(heard,['warning']);
 owner._wonderHold=540000;s.matchEvents();s.matchEvents();assert.deepEqual(heard,['warning','warning']);
 owner._wonderHold=570000;s.matchEvents();owner._wonderHold=590000;s.matchEvents();assert.equal(heard.length,4);
 owner.gone=true;s.matchEvents();s.matchEvents();assert.equal(heard.filter(k=>k==='elimination').length,1);
});

test('successful game completion hooks fire once, not while construction, training or research is pending',()=>{
 const scope=vm.createContext({console,Math,getCivilization:()=>({techTree:{test:{}}}),createUnit:()=>({health:100})});
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../js/game.js'),'utf8').split('\nconst WAR_PRIVATE_HOST')[0]+'\nthis.Game=Game;',scope);
 const g=Object.create(scope.Game.prototype),events=[];
 const owner={units:[],buildings:[],resources:{updatePopulation(){}},currentResearch:{techId:'test',duration:100,progress:0}};
 Object.assign(g,{player:owner,aiManager:{aiPlayers:[]},sound:{completed:(kind)=>events.push(kind)},renderer:{addUnit(){}},
  noteWonder(){},getOwnerByBuilding:()=>owner,recomputeMaxPopulation(){},getOwner:()=>owner});
 const site={type:'house',underConstruction:true,health:20,maxHealth:100};
 g.completeConstruction(site);g.completeConstruction(site);assert.deepEqual(events,['built']);
 const factory={owner:'player',x:0,z:0,isProducing:true,productionType:'worker',productionDuration:100,productionProgress:0};
 g.getAllBuildings=()=>[factory];g.updateProduction(50);assert.deepEqual(events,['built']);
 g.updateProduction(50);g.updateProduction(50);assert.deepEqual(events,['built','trained']);
 g.completeResearch=()=>{owner.currentResearch=null;};g.updateResearchProgress(50);assert.equal(events.length,2);
 g.updateResearchProgress(50);g.updateResearchProgress(50);assert.deepEqual(events,['built','trained','research']);
});

// Real Web Audio rejects NaN/Infinity; the old permissive fake hid this crash.
test('non-finite positions cannot abort combat audio or frame updates',async()=>{
 const {sound:s,game}=harness();await s.setEnabled(true);
 for(const value of [NaN,Infinity,-Infinity,undefined,'-252-2.5']){
  assert.doesNotThrow(()=>s.combat({type:'warrior'},{x:value,z:0}));
  assert.equal(s.voices.size,0);
 }
 const point={x:0,z:0};s.emit('impact',point);point.x=NaN;
 assert.doesNotThrow(()=>s.update());assert.equal([...s.voices][0].gain.gain.value,0);
 game.renderer.cameraTarget.x=NaN;s.ctx.currentTime+=1;
 assert.doesNotThrow(()=>s.update());assert.doesNotThrow(()=>s.emit('bow',{x:0,z:0}));
 assert.equal(s.enabled,true,'bad positions are silenced without disabling healthy audio');
});
test('bad volume and ramp values never reach Web Audio parameters',async()=>{
 const {sound:s}=harness();await s.setEnabled(true);
 assert.doesNotThrow(()=>s.emit('impact',{x:0,z:0},NaN));assert.equal(s.voices.size,0);
 assert.doesNotThrow(()=>s.ramp(s.master.gain,Infinity));assert(Number.isFinite(s.master.gain.value));
});

test('unexpected audio API failures mute sound without escaping to gameplay',async()=>{
 const {sound:s}=harness();await s.setEnabled(true);
 s.ctx.createStereoPanner=()=>{throw new TypeError('Simulated device failure');};
 assert.doesNotThrow(()=>s.combat({type:'warrior'},{x:0,z:0}));
 assert.equal(s.enabled,false);assert.equal(s.diagnostics.lastError.operation,'emit');
 assert.doesNotThrow(()=>s.update());
});
