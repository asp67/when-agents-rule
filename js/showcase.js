// An explicitly labelled, playable art-direction scenario. It never uses saved
// model endpoints and does not change the standard arena/campaign starting rules.
Game.prototype.startVisualShowcase = function () {
    if (this.gameStarted) return;
    this.player.civilization = 'greek';
    this.spectatorMode = false;
    document.body.classList.remove('spectator-mode');
    this.startGame('campaign', 1, null, true);
};

Game.prototype.prepareVisualShowcase = function () {
    const r=this.renderer, player=this.player;
    this.completeAgeUpgrade('iron');
    Object.assign(player.resources,{food:1600,wood:1600,stone:900,gold:700,maxPopulation:30});
    const center=player.buildings.find(b=>b.type==='town_center');
    const x=center.x,z=center.z;
    const plan=[['house',-20,12],['house',-32,-7],['house',22,13],['house',33,-5],
        ['temple',0,-24],['barracks',-24,32],['archery_range',24,32],
        ['farm',-44,21],['farm',-44,37],['tower',44,30]];
    for(const [type,dx,dz] of plan) {
        const building=createBuilding(type,x+dx,z+dz,'player','greek',{age:'iron'});
        if(!building) continue;
        this.terrain.clearResourcesNear(building.x,building.z,this.resourceClearance(type)+3);
        player.buildings.push(building);r.addBuilding(building);
    }
    player.units.forEach((unit,i)=>{ unit.x=x-7+i*3;unit.z=z+12; });
    for(let i=0;i<12;i++) {
        const unit=createUnit(i<8?'champion':'archer',x-8+(i%4)*4,z+23+Math.floor(i/4)*4,'player','greek','iron');
        if(unit) { player.units.push(unit);r.addUnit(unit); }
    }
    this.updateMilitaryTrainOptions();
    player.resources.updatePopulation(player.units.length);
    r.cameraTarget.set(x,0,z+4);
    r._yaw=-Math.PI/7;r._pitch=Math.atan(.65);r._halfH=48;
    const label=document.createElement('div');
    label.className='visual-showcase-label';
    label.innerHTML='<span data-i18n="art.showcase"></span><small data-i18n="art.showcaseHint"></small>';
    document.getElementById('gameScreen').appendChild(label);
    if(typeof applyI18n==='function') applyI18n();
};

window.addEventListener('load',()=>{
    if(new URLSearchParams(location.search).get('showcase')==='1' && !WAR_DEMO_ONLY && game && game.renderer) {
        game.startVisualShowcase();
    }
});
