// An explicitly labelled, playable art-direction scenario. It never uses saved
// model endpoints and does not change the standard arena/campaign starting rules.
Game.SHOWCASE_CIVILIZATIONS = Object.freeze(['greek','egyptian','yamato','persian']);
Game.showcaseCivilization = value => Game.SHOWCASE_CIVILIZATIONS.includes(value) ? value : 'greek';

Game.SHOWCASE_TERRAINS = Object.freeze(['summer','winter','desert']);
Game.SHOWCASE_AGES = Object.freeze(['stone','neolithic','bronze','iron']);
Game.showcaseTerrain = value => Game.SHOWCASE_TERRAINS.includes(value) ? value : 'summer';
Game.showcaseAge = value => Game.SHOWCASE_AGES.includes(value) ? value : 'iron';
Game.SHOWCASE_TIMES = Object.freeze({noon:0,dusk:150,night:360,dawn:570});
Game.showcaseTime = value => Object.hasOwn(Game.SHOWCASE_TIMES,value) ? value : 'noon';

Game.prototype.startVisualShowcase = function (civilization, terrain, age, time) {
    if (this.gameStarted) return;
    this._showcaseCivilization=Game.showcaseCivilization(civilization);
    this._showcaseTerrain=Game.showcaseTerrain(terrain);
    this._showcaseAge=Game.showcaseAge(age);
    this._showcaseTime=Game.showcaseTime(time);
    this._showcaseLightSeconds=window.EngineAtmosphere.previewTime(this._showcaseTerrain,this._showcaseTime);
    this.player.civilization=this._showcaseCivilization;
    this.spectatorMode = false;
    document.body.classList.remove('spectator-mode');
    this.startGame('campaign', 1, null, true);
};

Game.prototype.prepareVisualShowcase = function () {
    const r=this.renderer, player=this.player, civ=player.civilization;
    const age=this._showcaseAge || 'iron';
    if(age!=='stone')this.completeAgeUpgrade(age);
    Object.assign(player.resources,{food:1600,wood:1600,stone:900,gold:700,maxPopulation:30});
    const center=player.buildings.find(b=>b.type==='town_center');
    const x=center.x,z=center.z;
    const plan=[['house',-20,12],['house',-32,-7],['house',22,13],['house',33,-5],
        ['barracks',-24,32],['archery_range',24,32],
        ['farm',-44,21],['farm',-44,37],['tower',44,30],
        ['stable',-25,54],['academy',25,54]];
    if(['bronze','iron'].includes(age))plan.push(['temple',0,-24]);
    if(age==='iron') {
        const wonder=getCivilization(civ).uniqueBuildings.find(b=>b.type==='wonder');
        if(wonder)plan.push([wonder.id,0,80]);
    }
    for(const [type,dx,dz] of plan) {
        const building=createBuilding(type,x+dx,z+dz,'player',civ,{age});
        if(!building) continue;
        this.terrain.clearResourcesNear(building.x,building.z,this.resourceClearance(type,building.isWonder)+3);
        player.buildings.push(building);r.addBuilding(building);
    }
    player.units.forEach((unit,i)=>{ unit.x=x-7+i*3;unit.z=z+12; });
    const roster=age==='iron'?['militia','warrior','champion','archer','crossbowman','elite_archer',
        'scout_cavalry','cavalry','heavy_cavalry','priest','worker','worker']
        : age==='bronze'?['warrior','archer','cavalry','priest','worker','worker']
        : ['militia','archer','scout_cavalry','worker','worker'];
    for(let i=0;i<roster.length;i++) {
        const unit=createUnit(roster[i],x-8+(i%4)*4,z+23+Math.floor(i/4)*4,'player',civ,age);
        if(unit) { player.units.push(unit);r.addUnit(unit); }
    }
    this.updateMilitaryTrainOptions();
    player.resources.updatePopulation(player.units.length);
    r.cameraTarget.set(x,0,z+22);
    r._yaw=-Math.PI/7;r._pitch=Math.atan(.65);r._halfH=62;
    const label=document.createElement('div');
    label.className='visual-showcase-label';
    label.innerHTML=`<span data-i18n="art.showcase"></span><small data-i18n="art.showcaseHint"></small>
        <label for="showcaseCivilization" data-i18n="art.civilization"></label>
        <select id="showcaseCivilization">${Game.SHOWCASE_CIVILIZATIONS.map(id=>
            `<option value="${id}" data-i18n="civ.${id}.name"></option>`).join('')}</select>
        <label for="showcaseTerrain" data-i18n="art.terrain"></label>
        <select id="showcaseTerrain">${Game.SHOWCASE_TERRAINS.map(id=>
            `<option value="${id}" data-i18n="art.terrain.${id}"></option>`).join('')}</select>
        <label for="showcaseAge" data-i18n="art.age"></label>
        <select id="showcaseAge">${Game.SHOWCASE_AGES.map(id=>
            `<option value="${id}" data-i18n="age.${id}"></option>`).join('')}</select>
        <label for="showcaseTime" data-i18n="art.time"></label>
        <select id="showcaseTime">${Object.keys(Game.SHOWCASE_TIMES).map(id=>
            `<option value="${id}" data-i18n="art.time.${id}"></option>`).join('')}</select>
        <div class="showcase-tools"><button type="button" data-showcase-load data-i18n="art.loadCivilization"></button>
        <button type="button" data-showcase-workers data-i18n="art.workers"></button></div>
        <details class="showcase-sound"><summary data-i18n="audio.test"></summary>
            <small data-i18n="audio.testHint"></small>
            <div class="showcase-sound-buttons">${['step','snow','gravel','hoof','hoofSnow','hoofGravel','bow','crossbow','impact','steel','stone','crackle','chop','harvest','mine','build','built','research','trained','collapse','wonderLost','heal','command','commandAction','start','elimination','victory','defeat','warning'].map(kind=>
                `<button type="button" data-sound-sample="${kind}" data-i18n="audio.sample.${kind}"></button>`).join('')}</div>
            <small data-sound-status role="status"></small>
        </details>`;
    label.querySelector('#showcaseCivilization').value=civ;
    label.querySelector('#showcaseTerrain').value=this._showcaseTerrain || 'summer';
    label.querySelector('#showcaseAge').value=age;
    label.querySelector('#showcaseTime').value=this._showcaseTime || 'noon';
    label.querySelector('#showcaseTime').addEventListener('change',event=>{
        this._showcaseTime=Game.showcaseTime(event.target.value);
        this._showcaseLightSeconds=window.EngineAtmosphere.previewTime(this._showcaseTerrain,this._showcaseTime);
        const url=new URL(location.href);
        url.searchParams.set('time',this._showcaseTime);
        window.history.replaceState(null,'',url.href);
    });
    label.querySelector('[data-showcase-load]').addEventListener('click',()=>
        this.loadShowcaseCivilization(label.querySelector('#showcaseCivilization').value,
            label.querySelector('#showcaseTerrain').value,label.querySelector('#showcaseAge').value));
    label.querySelector('[data-showcase-workers]').addEventListener('click',()=>this.focusShowcaseWorkers());
    label.querySelectorAll('[data-sound-sample]').forEach(button=>button.addEventListener('click',async()=>{
        button.disabled=true;
        const status=label.querySelector('[data-sound-status]');
        try { await this.sound.audition(button.dataset.soundSample); status.textContent=''; }
        catch (_) { status.textContent=t('audio.unavailable'); }
        finally {
            button.disabled=false;
            const toggle=document.querySelector('.audio-popover input[type="checkbox"]');
            if(toggle)toggle.checked=!this.sound.enabled;
        }
    }));
    document.getElementById('gameScreen').appendChild(label);
    if(typeof applyI18n==='function') applyI18n();
};

// Switching starts a fresh demo on the same map for a like-for-like comparison.
Game.prototype.loadShowcaseCivilization = function (civilization, terrain=this._showcaseTerrain, age=this._showcaseAge) {
    if(!this._showcaseCivilization) return;
    const url=new URL(location.href);
    url.searchParams.set('showcase','1');
    url.searchParams.set('civ',Game.showcaseCivilization(civilization));
    url.searchParams.set('terrain',Game.showcaseTerrain(terrain));
    url.searchParams.set('age',Game.showcaseAge(age));
    url.searchParams.set('time',Game.showcaseTime(this._showcaseTime));
    // Replace this demo rather than stacking a history entry for every civ.
    this.sound?.preserveForNavigation();
    location.replace(url.href);
};

// A reload is our clean game reset. Remove demo routing first, otherwise every
// Back/Main menu action immediately starts the showcase again on window.load.
Game.prototype.reloadToMenu = function () {
    this.sound?.preserveForNavigation();
    const url=new URL(location.href);
    if(this._showcaseCivilization || url.searchParams.get('showcase')==='1') {
        url.searchParams.delete('showcase');
        url.searchParams.delete('civ');
        url.searchParams.delete('terrain');
        url.searchParams.delete('age');
        url.searchParams.delete('time');
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
        const params=new URLSearchParams(location.search);
        game.startVisualShowcase(params.get('civ'),params.get('terrain'),params.get('age'),params.get('time'));
    }
});
