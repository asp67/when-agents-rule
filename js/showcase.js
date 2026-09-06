// An explicitly labelled, playable art-direction scenario. It never uses saved
// model endpoints and does not change the standard arena/campaign starting rules.
Game.SHOWCASE_CIVILIZATIONS = Object.freeze(['greek','egyptian','yamato','persian']);
Game.showcaseCivilization = value => Game.SHOWCASE_CIVILIZATIONS.includes(value) ? value : 'greek';

Game.prototype.startVisualShowcase = function (civilization) {
    if (this.gameStarted) return;
    this._showcaseCivilization=Game.showcaseCivilization(civilization);
    this.player.civilization=this._showcaseCivilization;
    this.spectatorMode = false;
    document.body.classList.remove('spectator-mode');
    this.startGame('campaign', 1, null, true);
};

Game.prototype.prepareVisualShowcase = function () {
    const r=this.renderer, player=this.player, civ=player.civilization;
    this.completeAgeUpgrade('iron');
    Object.assign(player.resources,{food:1600,wood:1600,stone:900,gold:700,maxPopulation:30});
    const center=player.buildings.find(b=>b.type==='town_center');
    const x=center.x,z=center.z;
    const plan=[['house',-20,12],['house',-32,-7],['house',22,13],['house',33,-5],
        ['temple',0,-24],['barracks',-24,32],['archery_range',24,32],
        ['farm',-44,21],['farm',-44,37],['tower',44,30]];
    for(const [type,dx,dz] of plan) {
        const building=createBuilding(type,x+dx,z+dz,'player',civ,{age:'iron'});
        if(!building) continue;
        this.terrain.clearResourcesNear(building.x,building.z,this.resourceClearance(type)+3);
        player.buildings.push(building);r.addBuilding(building);
    }
    player.units.forEach((unit,i)=>{ unit.x=x-7+i*3;unit.z=z+12; });
    const roster=['militia','warrior','champion','archer','crossbowman','elite_archer',
        'scout_cavalry','cavalry','heavy_cavalry','priest','worker','worker'];
    for(let i=0;i<roster.length;i++) {
        const unit=createUnit(roster[i],x-8+(i%4)*4,z+23+Math.floor(i/4)*4,'player',civ,'iron');
        if(unit) { player.units.push(unit);r.addUnit(unit); }
    }
    this.updateMilitaryTrainOptions();
    player.resources.updatePopulation(player.units.length);
    r.cameraTarget.set(x,0,z+4);
    r._yaw=-Math.PI/7;r._pitch=Math.atan(.65);r._halfH=48;
    const label=document.createElement('div');
    label.className='visual-showcase-label';
    label.innerHTML=`<span data-i18n="art.showcase"></span><small data-i18n="art.showcaseHint"></small>
        <label for="showcaseCivilization" data-i18n="art.civilization"></label>
        <div class="showcase-tools"><select id="showcaseCivilization">${Game.SHOWCASE_CIVILIZATIONS.map(id=>
            `<option value="${id}" data-i18n="civ.${id}.name"></option>`).join('')}</select>
        <button type="button" data-showcase-load data-i18n="art.loadCivilization"></button></div>
        <button type="button" data-showcase-workers data-i18n="art.workers"></button>`;
    label.querySelector('select').value=civ;
    label.querySelector('[data-showcase-load]').addEventListener('click',()=>
        this.loadShowcaseCivilization(label.querySelector('select').value));
    label.querySelector('[data-showcase-workers]').addEventListener('click',()=>this.focusShowcaseWorkers());
    document.getElementById('gameScreen').appendChild(label);
    if(typeof applyI18n==='function') applyI18n();
};

// Switching starts a fresh demo on the same map for a like-for-like comparison.
Game.prototype.loadShowcaseCivilization = function (civilization) {
    if(!this._showcaseCivilization) return;
    const url=new URL(location.href);
    url.searchParams.set('showcase','1');
    url.searchParams.set('civ',Game.showcaseCivilization(civilization));
    // Replace this demo rather than stacking a history entry for every civ.
    location.replace(url.href);
};

// A reload is our clean game reset. Remove demo routing first, otherwise every
// Back/Main menu action immediately starts the showcase again on window.load.
Game.prototype.reloadToMenu = function () {
    const url=new URL(location.href);
    if(this._showcaseCivilization || url.searchParams.get('showcase')==='1') {
        url.searchParams.delete('showcase');
        url.searchParams.delete('civ');
        location.replace(url.href);
    } else location.reload();
};

Game.prototype.focusShowcaseWorkers = function () {
    if(!this._showcaseCivilization) return;
    const workers=this.player.units.filter(u=>u.type==='worker' && u.health>0).slice(0,3);
    if(!workers.length) return;
    const r=this.renderer;
    this.disableActionCam();
    ++r._cameraMoveId;
    r.cameraTarget.set(workers.reduce((sum,u)=>sum+u.x,0)/workers.length,0,
        workers.reduce((sum,u)=>sum+u.z,0)/workers.length);
    r._halfH=10;
    r._clampTarget();
};

window.addEventListener('load',()=>{
    if(new URLSearchParams(location.search).get('showcase')==='1' && !WAR_DEMO_ONLY && game && game.renderer) {
        game.startVisualShowcase(new URLSearchParams(location.search).get('civ'));
    }
});
