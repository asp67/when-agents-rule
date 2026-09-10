// Persistent group intent. Combat remains in Game.updateCombat; this layer only
// chooses nearby visible targets and restores the same formation/march machinery.
class StandingOrders {
    static get ACQUIRE_RADIUS() { return 48; }
    static get CHASE_RADIUS() { return 64; }
    static get ROUTE_ACQUIRE_RADIUS() { return 36; }
    static get ROUTE_CHASE_RADIUS() { return 48; }
    static get BOUNDARY_GRACE_MS() { return 900; }
    static get STALL_MS() { return 5000; }
    constructor(game, manager) { this.game=game;this.manager=manager;this.groups=new Set();this.time=0;this.scan=0; }
    members(g) {
        const owned=new Set(g.owner.units);
        return g.units.filter(u=>u.health>0&&u._standingOrder===g&&u._orderToken===g.token&&!u.task&&owned.has(u));
    }
    center(units) {
        const median=key=>{const a=units.map(u=>u[key]).sort((a,b)=>a-b);return a[Math.floor(a.length/2)]||0;};
        return {x:median('x'),z:median('z')};
    }
    visible(g,e) {
        if(!e||e.owner===g.owner.id)return false;
        return g.owner.id==='player'?!!this.game.fogOfWar?.isPositionVisible(e.x,e.z)
            : !!this.game.aiManager?.isVisibleTo(g.owner,e.x,e.z);
    }
    retaliate(victim,attacker) {
        const g=victim?._standingOrder;
        if(!g||!this.groups.has(g)||victim._orderToken!==g.token
            ||!attacker||attacker.health<=0||!this.visible(g,attacker))return;
        // Incoming damage overrides movement intent, even scouting. Towers take
        // priority over mobile attackers; equal-priority threats queue so each
        // incoming hit does not pull the army onto a different target.
        g.threats=(g.threats||[]).filter(e=>e.health>0);
        if(!g.threats.includes(attacker)){
            if(attacker.type==='tower'&&g.threats[0]?.type!=='tower')g.threats.unshift(attacker);
            else g.threats.push(attacker);
        }
        const focus=g.threats[0],units=this.members(g);
        for(const u of units){
            if(u.unitType==='support'||u.type==='worker'||!(u.attack>0))continue;
            // Another hit on an ally is not evidence that THIS soldier can now
            // catch the attacker. Keep failed-chase protection until the normal
            // retry scan sees a closer/in-range opportunity. Towers still win.
            if(focus.type!=='tower'&&g.blocked.get(u)?.has(focus)
                &&!(focus===attacker&&Math.hypot(u.x-focus.x,u.z-focus.z)<=this.game.attackRangeAgainst(u,focus)))continue;
            if(!g.fighting){g.anchor=this.center(units);g.fighting=true;}
            if(u.attackTarget!==focus)g.chases.delete(u);
            g.blocked.get(u)?.delete(focus);
            this.game.clearRetaliation(u);
            u.attackTarget=focus;u.isAttacking=true;
            u.formationOffset=null;u.formationAxis=null;u.formationGroup=null;u.marchSpeed=null;
        }
    }
    issue(owner,units,to,options={}) {
        const g={owner,units:units.slice(),to:{...to},from:this.center(units),mode:options.mode||'march',
            token:units[0]._orderToken,shape:options.formation||null,pace:options.matchSpeed||'',
            attack:!!(options.attack||options.target),order:options.attack||options.target?'attack_target':'move_units',
            targets:options.targets||'any',target:options.target||null,slots:new Map(),blocked:new Map(),chases:new Map(),fighting:false};
        for(const u of units){u._standingOrder=g;u._orderToken=g.token;this.game.clearRetaliation(u);u.attackTarget=null;u.isAttacking=false;u.attackMove=null;}
        this.groups.add(g);this.reform(g,g.to);
        // Reassigned members leave the old formation immediately.
        for(const old of this.groups)if(old!==g)this.prune(old);
        return g;
    }
    prune(g) {
        const live=this.members(g);
        const remaining=new Set(live);
        for(const u of g.units)if(!remaining.has(u)&&u._standingOrder===g)u._standingOrder=null;
        if(!live.length){this.groups.delete(g);return false;}
        if(live.length!==g.units.length){
            g.units=live;
            for(const u of g.chases.keys())if(!remaining.has(u))g.chases.delete(u);
            for(const u of g.blocked.keys())if(!remaining.has(u))g.blocked.delete(u);
            this.reform(g,g.to,g.fighting);
        }
        return true;
    }
    placeSlots(units,to,offsets) {
        // Reserve distinct resting places. Sending an unformed army to one point
        // makes the mover fight friendly separation forever. Keep its free pace,
        // but give it a compact footprint with support in the ranged ranks.
        const loose=offsets?null:this.manager.formationSlots(units,'block').slots;
        const desired=units.map(u=>{
            const off=offsets?.get(u)||{x:loose.get(u).r,z:-loose.get(u).f};
            return {x:to.x+off.x,z:to.z+off.z};
        });
        const legal=p=>{
            const clamped=this.game.clampSlot(p.x,p.z);
            return Math.hypot(p.x-clamped.x,p.z-clamped.z)<.01;
        };
        // Prefer translating the entire shape onto nearby open ground over
        // flattening several ranks onto the same building or shoreline boundary.
        for(let ring=0;ring<=16;ring++){
            const count=ring?16:1;
            for(let k=0;k<count;k++){
                const angle=k*Math.PI*2/count,dx=Math.cos(angle)*ring*3,dz=Math.sin(angle)*ring*3;
                const slots=desired.map(p=>({x:p.x+dx,z:p.z+dz}));
                if(slots.every(legal))return new Map(units.map((u,i)=>[u,slots[i]]));
            }
        }
        // A cramped village may have no room for the whole shape. Allocate nearby
        // open places individually, still reserving enough space for separation.
        const placed=[];
        for(const p of desired){
            let chosen=null;
            for(let i=0;i<1024;i++){
                const radius=2*Math.sqrt(i),angle=i*2.399963229728653;
                const q={x:p.x+Math.cos(angle)*radius,z:p.z+Math.sin(angle)*radius};
                if(legal(q)&&placed.every(s=>Math.hypot(q.x-s.x,q.z-s.z)>=1.8)){chosen=q;break;}
            }
            placed.push(chosen||this.game.clampSlot(p.x,p.z));
        }
        return new Map(units.map((u,i)=>[u,placed[i]]));
    }
    reform(g,to,preserveCombat=false) {
        const units=this.members(g);if(!units.length)return;
        const form=this.manager.applyFormation(this.game,units,to.x,to.z,g.shape);
        this.manager.applyMatchSpeed(units,g.pace||(form.applied?'slowestUnit':''));
        g.slots=this.placeSlots(units,to,form.offsets);g.leg={...to};
        g.holdSlots=null;
        g.supportSlots=null;g.supportAnchor=null;
        g.settled=false;
        for(const u of units){
            const slot=g.slots.get(u);
            u._formationPatient=null;u._patientStand=null;
            u._healingFormation=null;
            // Repack the surviving formation, but do not interrupt valid fights.
            // The new slots become their return positions when combat ends.
            if(preserveCombat&&u.isAttacking&&u.attackTarget?.health>0){
                u.formationOffset=null;u.formationAxis=null;u.formationGroup=null;u.marchSpeed=null;
                continue;
            }
            u.targetX=slot.x;u.targetZ=slot.z;
            u._moveOrderTo=slot;u.attackMove=null;u.attackTarget=null;u.isAttacking=false;
            u.isMoving=Math.hypot(u.x-slot.x,u.z-slot.z)>1;
            u.formationOffset=null; // use formationAim on the generic mover, not target pursuit
            this.game.clearRetaliation(u);
        }
        if(!preserveCombat)g.chases.clear();
    }
    releaseTarget(g,u,target=u.attackTarget) {
        if(target){
            if(!g.blocked.has(u))g.blocked.set(u,new Map());
            g.blocked.get(u).set(target,{until:this.time+5000,
                distance:Math.hypot(u.x-target.x,u.z-target.z)});
        }
        u.attackTarget=null;u.isAttacking=false;this.game.clearRetaliation(u);g.chases.delete(u);
    }
    supportPosition(g,u,units,fallback) {
        // The standing order owns support movement as well as combat movement.
        // Keep one patient until healed/lost; nearest-patient scans every slice
        // otherwise turn a priest around whenever two soldiers pass each other.
        const fighters=units.filter(p=>p.attackTarget&&p.unitType!=='support');
        const army=this.center(fighters.length?fighters:units);
        const valid=p=>p&&p!==u&&g.owner.units.includes(p)&&p.owner===u.owner&&p.health>0
            &&p.health<p.maxHealth&&(Math.hypot(p.x-u.x,p.z-u.z)<24
                ||(units.includes(p)&&Math.hypot(p.x-army.x,p.z-army.z)<=StandingOrders.CHASE_RADIUS));
        let patient=u._formationPatient;
        if(!valid(patient)){
            patient=g.owner.units.filter(valid).sort((a,b)=>Math.hypot(a.x-u.x,a.z-u.z)-Math.hypot(b.x-u.x,b.z-u.z))[0];
            u._formationPatient=patient||null;u._patientStand=null;
        }
        if(!patient)return fallback;
        // Already close enough: stand still and channel, do not march into the
        // patient's collision radius. Replan only when the patient moves away.
        if(Math.hypot(patient.x-u.x,patient.z-u.z)<=3.3)return {x:u.x,z:u.z};
        const old=u._patientStand;
        if(old&&Math.hypot(old.px-patient.x,old.pz-patient.z)<1)return old;
        const angle=Math.atan2(u.z-patient.z,u.x-patient.x);
        for(let i=0;i<16;i++){
            const a=angle+i*Math.PI/8;
            const x=patient.x+Math.cos(a)*2.8,z=patient.z+Math.sin(a)*2.8;
            const p=this.game.clampSlot(x,z);
            if(Math.hypot(p.x-x,p.z-z)>.01)continue;
            u._patientStand={x,z,px:patient.x,pz:patient.z};return u._patientStand;
        }
        return fallback;
    }
    update(dt) {
        this.time+=dt;this.scan+=dt;
        // Membership changes invalidate intent on the next simulation slice, even
        // between scans. A new worker assignment must never be overwritten here.
        for(const g of this.groups)this.prune(g);
        if(this.scan<150)return;this.scan=0;
        const enemies=this.game.getAllUnits();
        for(const g of this.groups){
            const units=g.units,center=this.center(units);
            if(g.threats)g.threats=g.threats.filter(e=>e.health>0&&this.visible(g,e));
            const focus=g.threats?.[0];
            // Visibility depends on the owner, not the attacker. Share its scan
            // across the formation instead of repeating it for every soldier.
            const visibility=new Map();
            const visible=e=>{if(!visibility.has(e))visibility.set(e,this.visible(g,e));return visibility.get(e);};
            if(g.target&&this.visible(g,g.target)&&g.target.health<=0){
                g.target=null;
                // The named objective may have drawn the army far beyond its
                // original combat anchor. Continue the assault around arrival,
                // with normal local chase limits, rather than the departure point.
                if(g.fighting){g.anchor=center;g.holdSlots=null;}
            }
            for(const [u,targets]of g.blocked){
                // Time alone must not restart the same hopeless chase. Re-arm
                // when the enemy is meaningfully closer (or back in striking range).
                for(const [e,retry]of targets){
                    const distance=Math.hypot(u.x-e.x,u.z-e.z);
                    if(e.health<=0||(retry.until<=this.time&&visible(e)&&
                        (distance<=this.game.attackRangeAgainst(u,e)+1||distance<=retry.distance-6)))targets.delete(e);
                }
                if(!targets.size)g.blocked.delete(u);
            }
            if(g.target&&this.visible(g,g.target)&&g.target.health>0){
                const to={x:g.target.x,z:g.target.z};
                if(!g.fighting&&Math.hypot(to.x-g.leg.x,to.z-g.leg.z)>6)this.reform(g,to);
                g.to=to;
            }
            if(g.mode==='guard'&&Math.hypot(center.x-g.to.x,center.z-g.to.z)<12)g.atPost=true;
            const anchor=g.fighting?g.anchor:center;
            const routeDistance=e=>{
                if(g.mode==='guard'&&g.atPost)return Math.hypot(e.x-g.to.x,e.z-g.to.z);
                if(g.mode!=='patrol')return 0;
                const dx=g.to.x-g.from.x,dz=g.to.z-g.from.z;
                const t=Math.max(0,Math.min(1,((e.x-g.from.x)*dx+(e.z-g.from.z)*dz)/(dx*dx+dz*dz||1)));
                return Math.hypot(e.x-g.from.x-t*dx,e.z-g.from.z-t*dz);
            };
            const valid=e=>e&&e.health>0&&visible(e)&&
                (e===focus||e===g.target||g.targets!=='military'||(e.type!=='worker'&&e.unitType!=='support'&&e.attack>0));
            const withinLeash=(e,retaining=false)=>{
                const radius=retaining?StandingOrders.CHASE_RADIUS:StandingOrders.ACQUIRE_RADIUS;
                const route=retaining?StandingOrders.ROUTE_CHASE_RADIUS:StandingOrders.ROUTE_ACQUIRE_RADIUS;
                return routeDistance(e)<=route&&Math.hypot(e.x-anchor.x,e.z-anchor.z)<=radius
                    &&Math.hypot(e.x-center.x,e.z-center.z)<=radius;
            };
            const eligible=(u,e)=>{
                if(!valid(e))return false;
                if(e===focus)return e.type==='tower'||!g.blocked.get(u)?.has(e);
                if(e===g.target)return true;
                return !g.blocked.get(u)?.has(e)&&withinLeash(e);
            };
            const candidates=(g.attack?enemies.concat(this.game.getAllBuildings()):enemies).filter(e=>eligible(null,e));
            if(g.target&&eligible(null,g.target)&&!candidates.includes(g.target))candidates.unshift(g.target);
            // Engagement belongs to the group. The old per-soldier acquisition
            // radius stranded the far wing: near ranks started fighting, while
            // distant ranks were told to hold forever instead of closing in.
            // Keep the formation on distant approaches, but once a fighter can
            // engage, let all capable members join the same local battle.
            const engaging=g.fighting||units.some(u=>u.unitType!=='support'&&u.attack>0
                &&candidates.some(e=>eligible(u,e)&&Math.hypot(e.x-u.x,e.z-u.z)<Math.max(36,(u.range||1)+24)));
            let fighting=false;
            for(const u of units){
                if((g.mode==='scout'&&!focus)||u.unitType==='support'||!(u.attack>0)){
                    if(u.attackTarget)this.releaseTarget(g,u);continue;
                }
                let target=u.attackTarget;
                if(focus&&valid(focus)&&eligible(u,focus))target=focus;
                if(target){
                    const distance=Math.hypot(u.x-target.x,u.z-target.z);
                    let chase=g.chases.get(u);
                    if(!chase||chase.target!==target){chase={target,sample:distance,sampledAt:this.time,at:this.time};g.chases.set(u,chase);}
                    const inRange=distance<=this.game.attackRangeAgainst(u,target)+.5;
                    // Measure recent progress, not the best distance ever reached:
                    // a short detour must not poison the rest of a productive chase.
                    if(inRange)chase.at=this.time;
                    if(this.time-chase.sampledAt>=750){
                        if(distance<chase.sample-.25)chase.at=this.time;
                        chase.sample=distance;chase.sampledAt=this.time;
                    }
                    if(withinLeash(target,true))chase.outsideAt=null;
                    else if(chase.outsideAt==null)chase.outsideAt=this.time;
                    const escaped=chase.outsideAt!=null&&this.time-chase.outsideAt>=StandingOrders.BOUNDARY_GRACE_MS;
                    const tooFar=Math.hypot(target.x-anchor.x,target.z-anchor.z)>StandingOrders.CHASE_RADIUS*1.5;
                    const stalled=!inRange&&this.time-chase.at>=StandingOrders.STALL_MS;
                    const bounded=target===focus?target.type!=='tower':target!==g.target;
                    const defendingInRange=target===focus&&distance<=this.game.attackRangeAgainst(u,target);
                    if(!valid(target)||(bounded&&!defendingInRange&&(escaped||tooFar||stalled))){this.releaseTarget(g,u,target);target=null;}
                }
                if(!target){
                    let best=engaging?Infinity:Math.max(36,(u.range||1)+24);
                    for(const e of candidates){
                        if(g.mode==='scout'&&e!==focus)continue;
                        const d=Math.hypot(e.x-u.x,e.z-u.z);
                        if(d<best&&eligible(u,e)){best=d;target=e;}
                    }
                }
                if(target){
                    fighting=true;u.attackTarget=target;u.isAttacking=true;
                    u.formationOffset=null;u.formationAxis=null;u.formationGroup=null;u.marchSpeed=null;
                } else if(u.isAttacking){u.isAttacking=false;this.game.clearRetaliation(u);}
            }
            // If no member can productively pursue the mobile threat, it has been
            // driven off. Keep individual retry protection, but release the shared
            // emergency so the original assignment can resume.
            if(focus&&focus.type!=='tower'&&!units.some(u=>u.attackTarget===focus))g.threats.shift();
            if(fighting){
                if(!g.fighting){g.anchor=center;g.fighting=true;}
                // Non-engaging members wait nearby; priests still heal in range.
                // Reserve legal, distinct places once per engagement/repack. A
                // clamped point per member can collapse several ranks onto one
                // building edge, while old march axes steer away from the hold.
                if(!g.holdSlots){
                    const offsets=new Map(units.map(u=>{const s=g.slots.get(u);
                        return [u,{x:(s?.x??g.leg.x)-g.leg.x,z:(s?.z??g.leg.z)-g.leg.z}];}));
                    g.holdSlots=this.placeSlots(units,g.anchor,offsets);
                }
                // Priests travel with the active ranged ranks, even with no
                // wounded patient. The old engagement anchor is a chase boundary,
                // not a place to leave support while an assault advances.
                const support=units.filter(u=>u.unitType==='support');
                if(support.length){
                    const fighters=units.filter(u=>u.attackTarget&&u.unitType!=='support');
                    const ranged=fighters.filter(u=>u.range>1);
                    const escorts=ranged.length?ranged:fighters;
                    const body=this.center(escorts),enemy=this.center(escorts.map(u=>u.attackTarget));
                    const dx=enemy.x-body.x,dz=enemy.z-body.z,d=Math.hypot(dx,dz)||1;
                    const rear={x:body.x-dx/d*3,z:body.z-dz/d*3};
                    if(!g.supportSlots||!g.supportAnchor||Math.hypot(rear.x-g.supportAnchor.x,rear.z-g.supportAnchor.z)>2){
                        g.supportSlots=this.placeSlots(support,rear,null);g.supportAnchor=rear;
                    }
                }
                for(const u of units)if(!u.attackTarget){
                    const hold=u.unitType==='support'?this.supportPosition(g,u,units,g.supportSlots.get(u)):g.holdSlots.get(u);
                    u.formationOffset=null;u.formationAxis=null;u.formationGroup=null;u.marchSpeed=null;
                    u.targetX=hold.x;u.targetZ=hold.z;u.isMoving=Math.hypot(u.x-hold.x,u.z-hold.z)>(u.unitType==='support'?.3:1);
                }
            }else{
                if(g.fighting){g.fighting=false;this.reform(g,g.to);}
                // Arrival does not erase the order. Patrol waits for every survivor,
                // including the slowest priest, before reversing the route.
                const arrived=units.every(u=>{const s=g.slots.get(u);return s&&Math.hypot(u.x-s.x,u.z-s.z)<=1.6;});
                if(arrived&&g.mode!=='patrol')g.settled=true;
                if(arrived&&g.target&&!this.visible(g,g.target))g.target=null;
                if(arrived&&g.mode==='patrol'&&Math.hypot(g.to.x-g.from.x,g.to.z-g.from.z)>2){
                    [g.to,g.from]=[g.from,g.to];this.reform(g,g.to);
                }else for(const u of units){
                    const slot=g.slots.get(u);if(!slot)continue;
                    if(u.unitType==='support'){
                        // Healing may interrupt slot travel too. Otherwise a priest
                        // endlessly recovering its slot never gets to help anyone.
                        // This branch owns the whole trip, including the return;
                        // ordinary slot recovery must not recall it between heals.
                        const hold=this.supportPosition(g,u,units,slot);
                        if(u._formationPatient||u._healingFormation){
                            if(!u._healingFormation)u._healingFormation={
                                formationOffset:u.formationOffset,formationAxis:u.formationAxis,
                                formationGroup:u.formationGroup,marchSpeed:u.marchSpeed};
                            if(!u._formationPatient){
                                // Rejoin the moving ranks now, not only once at the
                                // final destination. Normal lane/pace recovery lets
                                // a returning priest catch up without overtaking.
                                Object.assign(u,u._healingFormation);u._healingFormation=null;
                                u.targetX=slot.x;u.targetZ=slot.z;
                                u.isMoving=Math.hypot(u.x-slot.x,u.z-slot.z)>.5;
                                continue;
                            }
                            u.formationOffset=null;u.formationAxis=null;u.formationGroup=null;u.marchSpeed=null;
                            u.targetX=hold.x;u.targetZ=hold.z;
                            u.isMoving=Math.hypot(u.x-hold.x,u.z-hold.z)>.3;
                            continue;
                        }
                    }
                    if(!u.isMoving&&Math.hypot(u.x-slot.x,u.z-slot.z)>1.6){u.targetX=slot.x;u.targetZ=slot.z;u.isMoving=true;}
                }
            }
        }
    }
    summary(owner) {
        return [...this.groups].filter(g=>g.owner===owner).flatMap(g=>{
            const units=this.members(g);if(!units.length)return [];
            return [{order:g.order,mode:g.mode,
                unitIds:units.map(u=>u.handle),to:[Math.round(g.to.x),Math.round(g.to.z)],
                ...(g.mode==='patrol'?{from:[Math.round(g.from.x),Math.round(g.from.z)]}:{}),
                ...(g.targets==='military'?{targets:'military'}:{}),
                ...(g.mode==='march'&&!g.fighting&&units.some(u=>u.isMoving)?{secondsRemaining:Math.max(...units.map(u=>this.manager.travelEtaSec(u,g.to.x,g.to.z)))}:{})}];
        });
    }
}
Game.prototype.setStandingOrder=function(manager,owner,units,to,options){
    if(!this._standingOrders)this._standingOrders=new StandingOrders(this,manager);
    return this._standingOrders.issue(owner,units,to,options);
};
