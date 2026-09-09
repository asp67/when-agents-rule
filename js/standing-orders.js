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
    issue(owner,units,to,options={}) {
        const g={owner,units:units.slice(),to:{...to},from:this.center(units),mode:options.mode||'march',
            token:units[0]._orderToken,shape:options.formation||null,pace:options.matchSpeed||'',
            attack:!!options.attack,order:options.attack||options.target?'attack_target':'move_units',
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
        for(const u of units){
            const slot=g.slots.get(u);
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
    releaseTarget(g,u) {
        if(u.attackTarget){
            if(!g.blocked.has(u))g.blocked.set(u,new Map());
            g.blocked.get(u).set(u.attackTarget,{until:this.time+5000,
                distance:Math.hypot(u.x-u.attackTarget.x,u.z-u.attackTarget.z)});
        }
        u.attackTarget=null;u.isAttacking=false;this.game.clearRetaliation(u);g.chases.delete(u);
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
            // Visibility depends on the owner, not the attacker. Share its scan
            // across the formation instead of repeating it for every soldier.
            const visibility=new Map();
            const visible=e=>{if(!visibility.has(e))visibility.set(e,this.visible(g,e));return visibility.get(e);};
            if(g.target&&this.visible(g,g.target)&&g.target.health<=0)g.target=null;
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
                (e===g.target||g.targets!=='military'||(e.type!=='worker'&&e.unitType!=='support'&&e.attack>0));
            const withinLeash=(e,retaining=false)=>{
                const radius=retaining?StandingOrders.CHASE_RADIUS:StandingOrders.ACQUIRE_RADIUS;
                const route=retaining?StandingOrders.ROUTE_CHASE_RADIUS:StandingOrders.ROUTE_ACQUIRE_RADIUS;
                return routeDistance(e)<=route&&Math.hypot(e.x-anchor.x,e.z-anchor.z)<=radius
                    &&Math.hypot(e.x-center.x,e.z-center.z)<=radius;
            };
            const eligible=(u,e)=>{
                if(!valid(e))return false;
                if(e===g.target)return true; // deliberate attacks may pursue their named target
                return !g.blocked.get(u)?.has(e)&&withinLeash(e);
            };
            const candidates=(g.attack?enemies.concat(this.game.getAllBuildings()):enemies).filter(e=>eligible(null,e));
            if(g.target&&eligible(null,g.target)&&!candidates.includes(g.target))candidates.unshift(g.target);
            let fighting=false;
            for(const u of units){
                if(g.mode==='scout'||u.unitType==='support'||!(u.attack>0)){
                    if(u.attackTarget)this.releaseTarget(g,u);continue;
                }
                let target=u.attackTarget;
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
                    if(!valid(target)||(target!==g.target&&(escaped||tooFar||stalled))){this.releaseTarget(g,u);target=null;}
                }
                if(!target){
                    let best=Math.max(36,(u.range||1)+24);
                    for(const e of candidates){
                        const d=Math.hypot(e.x-u.x,e.z-u.z);
                        if(d<best&&eligible(u,e)){best=d;target=e;}
                    }
                }
                if(target){
                    fighting=true;u.attackTarget=target;u.isAttacking=true;
                    u.formationOffset=null;u.formationAxis=null;u.formationGroup=null;u.marchSpeed=null;
                } else if(u.isAttacking){u.isAttacking=false;this.game.clearRetaliation(u);}
            }
            if(fighting){
                if(!g.fighting){g.anchor=center;g.fighting=true;}
                // Non-engaging members wait nearby; priests still heal in range.
                for(const u of units)if(!u.attackTarget){
                    const slot=g.slots.get(u),dx=(slot?.x??g.to.x)-g.leg.x,dz=(slot?.z??g.to.z)-g.leg.z;
                    const hold=this.game.clampSlot(g.anchor.x+dx,g.anchor.z+dz);
                    u.targetX=hold.x;u.targetZ=hold.z;u.isMoving=Math.hypot(u.x-hold.x,u.z-hold.z)>1;
                }
            }else{
                if(g.fighting){g.fighting=false;this.reform(g,g.to);}
                // Arrival does not erase the order. Patrol waits for every survivor,
                // including the slowest priest, before reversing the route.
                const arrived=units.every(u=>{const s=g.slots.get(u);return s&&Math.hypot(u.x-s.x,u.z-s.z)<=1.6;});
                if(arrived&&g.target&&!this.visible(g,g.target))g.target=null;
                if(arrived&&g.mode==='patrol'&&Math.hypot(g.to.x-g.from.x,g.to.z-g.from.z)>2){
                    [g.to,g.from]=[g.from,g.to];this.reform(g,g.to);
                }else for(const u of units){
                    const slot=g.slots.get(u);if(!slot)continue;
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
