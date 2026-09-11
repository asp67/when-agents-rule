const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const root=path.resolve(__dirname,'..');
function harness(spectator=false) {
    const calls={select:[],orders:[],inspect:[],boxes:0,hide:0,manual:0},timers=new Map();let id=0;
    const noop=()=>{},listeners={};
    const canvas={style:{},clientHeight:600,addEventListener:noop,
        getBoundingClientRect:()=>({left:0,top:0,right:1000,bottom:600,width:1000,height:600})};
    const window={addEventListener:(type,fn)=>(listeners[type]||=[]).push(fn)};
    const document={getElementById:()=>null};
    const game={spectatorMode:spectator,disableActionCam:()=>calls.manual++,
        spectatorPick:(x,y)=>calls.inspect.push([x,y]),selectUnit:u=>calls.select.push(u),
        updateUnitInfo:noop,moveUnits:(x,z)=>calls.orders.push([x,z]),player:{units:[]},
        ui:{choosePlayerFormation:(event,issue)=>issue(undefined,game.renderer.selectedUnits)}};
    const s={window,document,console,game,Date,TexGen:{TERRAIN_WORLD:1000,TERRAIN_LAND:417,TERRAIN_SEED:1},setTimeout:fn=>{timers.set(++id,fn);return id;},clearTimeout:i=>timers.delete(i)};
    vm.createContext(s);
    for(const file of ['js/engine/math3d.js','js/engine/gamerenderer.js','js/input.js'])vm.runInContext(fs.readFileSync(path.join(root,file),'utf8')+'\n'+(file==='js/input.js'?'this.InputManager=InputManager;':''),s);
    const r=Object.create(window.EngineRenderer.prototype),unit={owner:'player',type:'warrior',x:120,z:120};
    Object.assign(r,{canvas,renderer:{domElement:canvas},cameraTarget:{x:0,z:0},_halfH:34,_yaw:.3,_pitch:.6,_cameraMoveId:0,
        units:[unit],selectedUnits:[],getWorldPositionFromScreen:(x,y)=>({x,z:y}),pickUnitAt:()=>unit,
        getBuildingsAtPosition:()=>[],getUnitsAtPosition:()=>[],worldToScreen:()=>({x:120,y:120}),
        showSelectionBox:()=>calls.boxes++,hideSelectionBox:()=>calls.hide++,deselectAll:noop,
        selectMultipleUnits:units=>calls.select.push(...units),updateBuildingPreview:noop});
    game.renderer=r;
    const input=game.inputManager=new s.InputManager(r,game);
    const event=(x=100,y=100,button=0,target=canvas)=>({clientX:x,clientY:y,button,target,preventDefault:noop});
    const mouse=(phase,e)=>{
        r['onCanvasMouse'+phase](e);
        if(phase==='Down') input.onMouseDown(e);
        else for(const fn of listeners['mouse'+phase.toLowerCase()]||[])fn(e);
    };
    const touch=(points,changed=[])=>({touches:points.map(([x,y])=>({clientX:x,clientY:y})),changedTouches:changed.map(([x,y])=>({clientX:x,clientY:y})),preventDefault:noop});
    const hold=()=>{for(const [key,fn] of [...timers]){timers.delete(key);fn();}};
    return {s,r,input,game,calls,timers,canvas,event,mouse,touch,hold};
}
test('spectator mouse drag pans without box selection; a click still inspects',()=>{
    const h=harness(true);h.mouse('Down',h.event());h.mouse('Move',h.event(160,125));h.mouse('Up',h.event(160,125));
    assert.notEqual(h.r.cameraTarget.x,0);assert.equal(h.calls.boxes,0);assert.equal(h.calls.inspect.length,0);assert.equal(h.calls.orders.length,0);
    h.mouse('Down',h.event());h.mouse('Up',h.event(102,100));assert.deepEqual(h.calls.inspect,[[102,100]]);
});
test('campaign left drag selects the drawn group without panning',()=>{
    const h=harness();h.mouse('Down',h.event());h.mouse('Move',h.event(150,150));h.mouse('Up',h.event(150,150));
    assert.equal(h.calls.select.length,1);assert.ok(h.calls.boxes);assert.equal(h.r.cameraTarget.x,0);assert.equal(h.input.isDragging,false);
});
test('campaign right click orders once; a right drag, even returning to its start, only pans',()=>{
    const h=harness();h.mouse('Down',h.event(100,100,2));h.mouse('Up',h.event(100,100,2));assert.deepEqual(h.calls.orders,[[100,100]]);
    h.mouse('Down',h.event(100,100,2));h.mouse('Move',h.event(160,120,2));h.mouse('Move',h.event(100,100,2));h.mouse('Up',h.event(100,100,2));
    assert.equal(h.calls.orders.length,1);assert.ok(h.calls.manual);assert.equal(h.input.isRightDragging,false);
    // Diagonal movement must use the same radial threshold in both handlers.
    h.mouse('Down',h.event(100,100,2));h.mouse('Move',h.event(104,104,2));h.mouse('Up',h.event(104,104,2));
    assert.equal(h.calls.orders.length,1);
});
test('formation choice waits for confirmation and keeps the enemy clicked before it moved',()=>{
 const h=harness(),enemy={owner:'enemy',health:100,x:100,z:100};let confirm,attack;
 h.game.player.units=[{owner:'player'}];h.r.getUnitsAtPosition=()=>[enemy];
 h.game.ui.choosePlayerFormation=(event,issue)=>{confirm=issue;};
 h.game.attackTarget=(target,shape,units)=>{attack={target,shape,units};};
 h.mouse('Down',h.event(100,100,2));h.mouse('Up',h.event(100,100,2));
 assert.equal(attack,undefined);assert.equal(h.calls.orders.length,0);
 enemy.x=120;h.r.getUnitsAtPosition=()=>[];
 confirm('line',h.game.player.units);
 assert.equal(attack.target,enemy);assert.equal(attack.shape,'line');assert.equal(attack.units,h.game.player.units);
});

test('expanded right-click hit areas prefer the nearest eligible resource or enemy',()=>{
 const h=harness(),worker={owner:'player',type:'worker',health:100},enemy={owner:'b',x:103,z:100,health:100},building={owner:'b',x:106,z:100,health:100};
 h.game.player.units=[worker];let resource={x:100,z:100,amount:100},attacked=null;
 h.game.findResourceNodeAtPosition=()=>resource;h.game.attackTarget=t=>attacked=t;
 const hit={units:[enemy],buildings:[building],hidden:false};
 h.input.issueWorldCommand({x:100,z:100},h.event(),undefined,[worker],hit);
 assert.equal(attacked,null);assert.equal(h.calls.orders.length,1,'resource directly under click wins over nearby enemy');
 resource=null;h.input.issueWorldCommand({x:100,z:100},h.event(),undefined,[worker],hit);assert.equal(attacked,enemy);
 building.x=101;h.input.issueWorldCommand({x:100,z:100},h.event(),undefined,[worker],hit);assert.equal(attacked,building);
 const radii=[];h.r.getUnitsAtPosition=(x,z,r)=>{radii.push(r);return [];};h.r.getBuildingsAtPosition=(x,z,r)=>{radii.push(r);return [];};
 h.mouse('Down',h.event(100,100,2));h.mouse('Up',h.event(100,100,2));assert.deepEqual(radii,[4,7]);
});

test('campaign hand tool turns left drag into navigation without selecting or issuing orders',()=>{
    const h=harness();h.r.panMode=true;h.mouse('Down',h.event());h.mouse('Move',h.event(160,100));h.mouse('Up',h.event(160,100));
    assert.notEqual(h.r.cameraTarget.x,0);assert.equal(h.calls.select.length,0);assert.equal(h.calls.boxes,0);assert.equal(h.calls.orders.length,0);assert.equal(h.canvas.style.cursor,'grab');
    h.mouse('Down',h.event());h.mouse('Up',h.event());assert.equal(h.calls.select.length,1,'hand tool retains single-click selection');
});
test('one-finger dragging pans in both modes and never becomes a click/order on release',()=>{
    for(const spectator of [false,true]){const h=harness(spectator);
        h.r.onCanvasTouchStart(h.touch([[100,100]]));h.r.onCanvasTouchMove(h.touch([[160,120]]));h.r.onCanvasTouchEnd(h.touch([],[[160,120]]));
        assert.notEqual(h.r.cameraTarget.x,0);assert.equal(h.calls.select.length+h.calls.inspect.length+h.calls.orders.length,0);assert.equal(h.calls.boxes,0);assert.equal(h.timers.size,0);
    }
});
test('campaign touch tap selects and a stationary hold orders at release, without synthetic mouse duplicates',()=>{
    const h=harness();h.r.onCanvasTouchStart(h.touch([[100,100]]));h.r.onCanvasTouchEnd(h.touch([],[[102,101]]));assert.equal(h.calls.select.length,1);
    h.r.onCanvasTouchStart(h.touch([[200,200]]));h.hold();assert.equal(h.calls.orders.length,0);
    h.r.onCanvasTouchEnd(h.touch([],[[203,201]]));assert.deepEqual(h.calls.orders,[[203,201]]);
    h.mouse('Down',h.event(203,201));h.mouse('Up',h.event(203,201));assert.equal(h.calls.select.length,1);
});
test('dragging after a hold or adding a second finger cancels the pending campaign command',()=>{
    const h=harness();h.r.onCanvasTouchStart(h.touch([[100,100]]));h.hold();h.r.onCanvasTouchMove(h.touch([[150,100]]));h.r.onCanvasTouchEnd(h.touch([],[[150,100]]));
    assert.equal(h.calls.orders.length,0);
    h.r.onCanvasTouchStart(h.touch([[100,100]]));h.hold();h.r.onCanvasTouchStart(h.touch([[100,100],[200,100]]));
    const zoom=h.r._halfH;h.r.onCanvasTouchMove(h.touch([[80,100],[220,100]]));assert.ok(h.r._halfH<zoom);
    h.r.onCanvasTouchEnd(h.touch([[80,100]],[[220,100]]));h.r.onCanvasTouchEnd(h.touch([],[[80,100]]));
    assert.equal(h.calls.orders.length+h.calls.select.length,0);assert.equal(h.timers.size,0);
});
test('cancellation and off-canvas release clear gestures without selection or orders',()=>{
    const h=harness();h.r.onCanvasTouchStart(h.touch([[100,100]]));h.hold();h.r.cancelPointerGesture();h.r.onCanvasTouchEnd(h.touch([],[[100,100]]));
    assert.equal(h.calls.orders.length+h.calls.select.length,0);
    h.r._ignoreMouseUntil=0;h.mouse('Down',h.event(100,100,2));h.mouse('Move',h.event(1100,100,2,{}));h.mouse('Up',h.event(1100,100,2,{}));
    assert.equal(h.input.isRightDragging,false);assert.equal(h.r._panDrag,null);assert.equal(h.calls.orders.length,0);
    h.mouse('Down',h.event());h.game.spectatorMode=true;h.mouse('Move',h.event(150,150));h.mouse('Up',h.event(150,150));assert.equal(h.calls.boxes,0);
});
