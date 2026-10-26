// Persistent group intent. Combat remains in Game.updateCombat; this layer only
// chooses nearby visible targets and restores the same formation/march machinery.
class StandingOrders {
    static get ACQUIRE_RADIUS() { return 48; }
    static get CHASE_RADIUS() { return 64; }
    static get ROUTE_ACQUIRE_RADIUS() { return 36; }
    static get ROUTE_CHASE_RADIUS() { return 48; }
    static get BOUNDARY_GRACE_MS() { return 900; }
    static get STALL_MS() { return 5000; }
    // A shot gives its shooter away. A tower reaches 18 and a soldier sees 15, so towers
    // (and anything else firing from the edge of sight) hit armies that could not see
    // them: the hit was ignored and the siege went on under the arrows, and a unit that
    // did turn on its shooter dropped it again as out of sight and walked back to its
    // slot, to be hit and turn again (29 Sep 2026, a live Platform match: 9 of 47
    // retaliations refused as "not visible", towers at 15-20). What hits a member is
    // seen by its group for this long after each hit -- a tower firing every 1.5 s stays
    // seen while it fires. A tower cannot move, so where it stands stays known until it
    // falls: a group sent at it no longer turns back halfway when it stops firing.
    // Nothing else is seen through the fog.
    static get REVEAL_MS() { return 3000; }
    // A tower drops out of a group's threats once it has not shot any member for this
    // long, no member stands in its range and no member is on its way to fight it (b1101,
    // b1103): three missed volleys at its 1.5 s cadence. Before b1101 a tower stayed a
    // threat for the life of the order.
    static get TOWER_FORGET_MS() { return 4500; }
    // Hold (asp67, b1044): guard with a short leash, so defenders stay under their
    // towers instead of running out after whatever shot them. At its post each unit
    // keeps to its own slot: it attacks unprovoked only what is within its own reach of
    // that slot, and answers an attacker only within HOLD_LEASH of it -- one attacking
    // the group, or (b1045) attacking anything else of its owner's, so that a militia
    // holding under a tower does not watch a swordsman take the tower down.
    //
    // Fixed, and one past the longest reach in the game. Ranged units are capped at the
    // tower's 18 (Game: a range bonus never takes one past BUILDING_DEFS.tower.range),
    // so anything that can hit a unit standing in its slot stands within 19 of it, and
    // nothing can shoot a holding unit from outside its answer. Shorter, and an archer
    // could shoot it from where it may not go. tests/hold-mode.test.cjs pins this
    // against the unit and building data: a range raised past it fails a test, not a match.
    static get HOLD_LEASH() { return 19; }
    // How long after being hit a worker under an order still answers its attacker (b1052):
    // the auto-defense's own window for "being attacked".
    static get WORKER_ANSWER_MS() { return 4000; }
    // Guard defends what is its owner's round its post (b1110, asp67: "units on hold to
    // stay on hold, but units on guard to guard units and buildings"). At its post a
    // guarding group goes after any enemy unit that has damaged one of its owner's units
    // or buildings within GUARD_RADIUS of the post, from within GUARD_RADIUS of what it hit
    // (a post is seldom on the tower's spot: measured from the post, an advanced trebuchet
    // at 58 from the tower stood beyond the guard 4 off it) -- a trebuchet included, which has no attack and so was never "military", and which
    // a guard at a tower watched throw its stones until the tower fell (both engines,
    // at 48 and, at its old reach of 70, 68). Then the group goes back to its post. A hit counts for
    // GUARD_ANSWER_MS: longer than a trebuchet's 6 s reload, so one is still answered
    // between its throws, and seen for as long. Hold is unchanged: HOLD_LEASH.
    static get GUARD_RADIUS() { return 60; }
    static get GUARD_ANSWER_MS() { return 7000; }
    constructor(game, manager) { this.game=game;this.manager=manager;this.groups=new Set();this.time=0;this.scan=0; }
    members(g) {
        const owned=new Set(g.owner.units);
        // An engineer on a trebuchet job stays a member (b1110): it returns to its slot.
        return g.units.filter(u=>u.health>0&&u._standingOrder===g&&u._orderToken===g.token&&(!u.task||Game.engineerBusy(u))&&owned.has(u));
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
    // Which of the group's threats THIS member answers (b1085, b1103, asp67): "If a group
    // gets attacked by a tower, the whole group retaliates. Only if units outside the
    // tower's reach take damage from other units, they retaliate against the damage
    // dealers first and when they are not taking any more damage ... they join the tower
    // fight." So: inside a tower's firing range, the tower. Outside it, the first mobile
    // threat in the queue within chase reach (the queue keeps alternating hits from
    // pulling a member to and fro). With none, the tower again -- the whole group's fight.
    // b1101 sent a member outside the range back to its order instead, and the group
    // stood at the tower's edge, halted by the fight, while the few inside the range fought
    // it alone and the rest were drawn in one volley at a time (16 Oct 2026). A tower is
    // left once it has stopped being a fight: see TOWER_FORGET_MS.
    threatFor(g,u,ok=()=>true) {
        const threats=(g.threats||[]).filter(e=>e&&e.health>0&&ok(e));
        const tower=threats.find(e=>e.type==='tower'&&WarMath.hypot(u.x-e.x,u.z-e.z)<=(e.range||6));
        if(tower)return tower;
        const mobile=threats.find(e=>e.type!=='tower'&&WarMath.hypot(u.x-e.x,u.z-e.z)<=StandingOrders.CHASE_RADIUS);
        return mobile||threats.find(e=>e.type==='tower')||threats[0]||null;
    }
    // Siege stand-off (b1110, asp67: "when a formation is ordered to attack a tower with
    // a trebuchet in the formation, make sure that until the trebuchet is destroyed, the
    // formation does not charge into the tower to be annihilated"). While the order's
    // target is a standing tower and a trebuchet of the group lives, the group forms up
    // around its trebuchets ("the soldiers need to stand at the trebuchet to defend it"),
    // never closer than SIEGE_STANDOFF beyond the tower's reach, on its line of approach;
    // each trebuchet takes a slot just inside its own reach; no member takes a tower as its target
    // or answers one -- mobile attackers are fought as ever. With the trebuchets gone,
    // the order is the tower again.
    static get SIEGE_STANDOFF() { return 6; }
    // Any group with a living trebuchet leaves towers to it (b1110, asp67: "formations
    // charging the tower when the treb is ordered to attack"). The stand-off above only
    // held an order aimed at a tower by its id; in asp67's match of 24 October (23:14) an
    // attack-move to a point 25 from a tower, three advanced trebuchets in the group, was
    // shot at, and the whole group charged the tower and died at its foot. Now no member
    // takes a tower as a target or answers one while a trebuchet of the group lives;
    // members in a tower's reach take its arrows. With the trebuchets gone, towers are
    // fought as ever.
    withSiege(g) {
        return !!(g&&g.units.some(u=>u.unitType==='siege'&&u.health>0&&u._standingOrder===g));
    }
    // The enemy tower guarding an attack-move's destination (b1110, asp67): one the
    // owner knows -- discovered or in sight -- within a trebuchet's reach of the point.
    // An attack-move with trebuchets had no tower target, so its soldiers fought the
    // buildings round the point under the tower's arrows (and, since b1110, without
    // answering it while a trebuchet lived) until the trebuchet fell: "the trebuchet
    // following them even driving through the firing range of the tower. All units kept
    // attacking buildings while being decimated by the tower."
    // And on the way (asp67: "that should also be true when on march, the trebuchet picks
    // up a tower in reach on route. Just like units attack villagers or soldiers on route
    // to an attack order"): a known tower within SIEGE_NOTICE beyond a trebuchet's reach
    // of where it rolls now -- known by discovery or in sight, the trebuchet's own tower
    // watch included, and asked again every scan, so one first seen on the way counts.
    // On every move but a scout's (asp67: "the attack order mechanic works for move unit
    // orders as well, since a trebuchet cannot really retaliate against a tower"): a
    // march, or a guard, hold or patrol on its way; at its post a guard or hold keeps it.
    // And on the way to besiege another (b1110, asp67's match of 25 October, 22:00, at
    // 72:10): two Roman advanced trebuchets marching to the stand-off of a tower they
    // had taken up on the way rolled past a second one at 4.7 -- a tower already the
    // target ended the search. A tower nearer the engines than the one they make for is
    // besieged first, and the order goes back to that one after (siegeResume, a stack).
    static get SIEGE_NOTICE() { return 6; }
    guardTower(g,see){
        if(!g||!this.withSiege(g))return null;
        const travelling=g.mode==='march'||((g.mode==='guard'||g.mode==='hold'||g.mode==='patrol')&&!g.atPost);
        if(!travelling)return null;
        const engines=g.units.filter(u=>u.unitType==='siege'&&u.health>0&&u._standingOrder===g);
        const reach=Math.max(...engines.map(u=>u.range||50));
        const toEngines=t=>Math.min(...engines.map(u=>WarMath.hypot(t.x-u.x,t.z-u.z)-(u.range||50)));
        const current=g.target&&g.target.type==='tower'&&g.target.health>0?g.target:null;
        // Already throwing at its tower: nothing draws the engines off it.
        if(current&&toEngines(current)<=0)return null;
        const queued=new Set((g.siegeResume||[]).map(b=>b.target).filter(Boolean));
        const dest=g.target?{x:g.target.x,z:g.target.z}:g.to;
        const known=t=>!!(g.owner._knownEnemyBuildings&&g.owner._knownEnemyBuildings.has(t))||(see?see(g,t):this.visible(g,t));
        let best=null,bd=Infinity;
        for(const t of this.game.getAllBuildings()){
            if(t.type!=='tower'||!(t.health>0)||t.underConstruction||t.owner===g.owner.id||t===current||queued.has(t))continue;
            const near=toEngines(t);
            const onRoute=near<=StandingOrders.SIEGE_NOTICE&&(!current||near<toEngines(current));
            const atPoint=!current&&g.attack&&WarMath.hypot(t.x-dest.x,t.z-dest.z)<=reach;
            if(!atPoint&&!onRoute)continue;
            // On the way, the nearest to the engines; else the one covering the point.
            const d=onRoute?near:1e6+WarMath.hypot(t.x-dest.x,t.z-dest.z);
            if(d<bd&&known(t)){bd=d;best=t;}
        }
        return best;
    }
    nextTower(g,see){
        const engines=g.units.filter(u=>u.unitType==='siege'&&u.health>0&&u._standingOrder===g);
        let best=null,bd=Infinity;
        for(const t of this.game.getAllBuildings()){
            if(t.type!=='tower'||!(t.health>0)||t.underConstruction||t.owner===g.owner.id)continue;
            const d=Math.min(...engines.map(u=>WarMath.hypot(t.x-u.x,t.z-u.z)-(u.watch||120)));
            if(d>0)continue;
            const from=WarMath.hypot(t.x-(g.target?g.target.x:g.to.x),t.z-(g.target?g.target.z:g.to.z));
            if(from<bd&&(see?see(g,t):this.visible(g,t))){bd=from;best=t;}
        }
        return best;
    }
    // ...which the order then besieges first, from where the group stands now, before
    // going on to its point: as an attack_target on the tower would (asp67: "The attack
    // order then needs to be translated into an attack tower order for the entire
    // formation"). Returns the tower, or null.
    besiegeGuard(g,see){
        const t=this.guardTower(g,see);if(!t)return null;
        (g.siegeResume||(g.siegeResume=[])).push({x:g.to.x,z:g.to.z,target:g.target||null});
        g.target=t;g.from=this.center(this.members(g));g.atPost=false;
        const so=this.siegeStandoff(g);
        if(so){const to=this.standoffTo(g,so);g.to=to;this.reform(g,to);}
        return t;
    }
    siegeStandoff(g) {
        const t=g&&g.target;
        if(!t||t.type!=='tower'||!(t.health>0))return null;
        const siege=g.units.filter(u=>u.unitType==='siege'&&u.health>0);
        return siege.length?{tower:t,siege}:null;
    }
    // Where the soldiers stand: BESIDE their trebuchets, level with them, to defend them
    // (asp67: "the soldiers need to stand at the trebuchet"), never within the tower's
    // reach plus SIEGE_STANDOFF. In the first draft they stood ON the trebuchets' line:
    // the engine's slot was the middle of the soldiers' formation, two engines shared one
    // slot, and the lot shoved each other about -- "a flock of hooligans, not a
    // formation" (asp67). Beside rather than behind or in front, so the infantry and the
    // engines march abreast and neither has to pass through the other: in front there
    // was no room when a trebuchet reached 27 (the tower 18), and behind, the army stood while
    // the engines rolled through it to the front.
    static get SIEGE_SPACING() { return 7; }
    static get SIEGE_FLANK() { return 9; }
    siegeLine(so) {
        return Math.min(...so.siege.map(u=>(u.range||50)-2));
    }
    standoffDist(so) {
        return Math.max((so.tower.range||18)+StandingOrders.SIEGE_STANDOFF,this.siegeLine(so));
    }
    // The soldiers' point: at standoffDist, beside the engines' row on the side the
    // soldiers already are, SIEGE_FLANK beyond its end.
    standoffTo(g,so){
        const t=so.tower,from=g.from||this.center(g.units),dist=this.standoffDist(so);
        const a0=WarMath.atan2(from.z-t.z,from.x-t.x);
        const men=g.units.filter(u=>u.health>0&&u.unitType!=='siege');
        const c=men.length?this.center(men):from;
        let d=WarMath.atan2(c.z-t.z,c.x-t.x)-a0;while(d>Math.PI)d-=2*Math.PI;while(d<-Math.PI)d+=2*Math.PI;
        const side=d<0?-1:1;
        const half=(so.siege.length-1)/2*StandingOrders.SIEGE_SPACING;
        const th=a0+side*(half+StandingOrders.SIEGE_FLANK)/dist;
        const p={x:t.x+WarMath.cos(th)*dist,z:t.z+WarMath.sin(th)*dist};
        return this.game.clampSlot?this.game.clampSlot(p.x,p.z):p;
    }
    // The trebuchets side by side on an arc round the tower at siegeLine, SIEGE_SPACING
    // apart, centred on the line of approach; in the order they already stand along it,
    // so none has to cross another.
    siegeSlots(g,so,units){
        const t=so.tower,from=g.from||this.center(g.units),line=this.siegeLine(so);
        const a0=WarMath.atan2(from.z-t.z,from.x-t.x);
        const ang=u=>{let d=WarMath.atan2(u.z-t.z,u.x-t.x)-a0;while(d>Math.PI)d-=2*Math.PI;while(d<-Math.PI)d+=2*Math.PI;return d;};
        const engines=so.siege.filter(u=>units.includes(u)).sort((p,q)=>ang(p)-ang(q)||p.id-q.id);
        const slots=new Map();
        engines.forEach((u,i)=>{
            const th=a0+(i-(engines.length-1)/2)*StandingOrders.SIEGE_SPACING/line;
            const p={x:t.x+WarMath.cos(th)*line,z:t.z+WarMath.sin(th)*line};
            slots.set(u,this.game.clampSlot?this.game.clampSlot(p.x,p.z):p);
        });
        return slots;
    }
    // The point at `dist` from the tower toward where the order started.
    standoffPoint(g,tower,dist) {
        const from=g.from||this.center(g.units);
        const dx=from.x-tower.x,dz=from.z-tower.z,d=WarMath.hypot(dx,dz)||1;
        return {x:tower.x+dx/d*dist,z:tower.z+dz/d*dist};
    }
    retaliate(victim,attacker) {
        const g=victim?._standingOrder;
        if(!g||!this.groups.has(g)||victim._orderToken!==g.token
            ||!attacker||attacker.health<=0)return;
        // A tower is seen while it shoots, and a while after (it may stand beyond sight).
        (g.revealed||(g.revealed=new Map())).set(attacker,this.time+(attacker.type==='tower'?StandingOrders.TOWER_FORGET_MS:StandingOrders.REVEAL_MS));
        if(attacker.type==='tower')(g.towerShots||(g.towerShots=new Map())).set(attacker,this.time);
        // Incoming damage overrides movement intent, even scouting. Towers take
        // priority over mobile attackers; equal-priority threats queue so each
        // incoming hit does not pull the army onto a different target.
        g.threats=(g.threats||[]).filter(e=>e.health>0);
        if(!g.threats.includes(attacker)){
            if(attacker.type==='tower'&&g.threats[0]?.type!=='tower')g.threats.unshift(attacker);
            else g.threats.push(attacker);
        }
        // Besieging with a trebuchet: a tower's arrows send nobody at it (b1110).
        if(attacker.type==='tower'&&this.withSiege(g))return;
        // A hit starts the decision for EVERY member, each from where it stands.
        const units=this.members(g);
        const now=this.game.simNow?this.game.simNow():0;
        for(const u of units){
            if(u.unitType==='support'||u.type==='worker'||!(u.attack>0))continue;
            if(Game.engineerKeepsBuilding(u,now))continue;   // builds on unless hit itself (b1110)
            const focus=this.threatFor(g,u);
            if(!focus)continue;
            // Another hit on an ally is not evidence that THIS soldier can now
            // catch the attacker. Keep failed-chase protection until the normal
            // retry scan sees a closer/in-range opportunity. Towers still win.
            if(focus.type!=='tower'&&g.blocked.get(u)?.has(focus)
                &&!(focus===attacker&&WarMath.hypot(u.x-focus.x,u.z-focus.z)<=this.game.attackRangeAgainst(u,focus)))continue;
            // A member far from the attacker is not pulled across the map to it -- not to
            // a tower either: a group can be spread wide (fresh troops sent to join a
            // fight), and one drawn 60 units toward a tower that had shot someone else
            // lost sight of it on the way and walked back.
            if(WarMath.hypot(u.x-focus.x,u.z-focus.z)>StandingOrders.CHASE_RADIUS)continue;
            // Holding: only a member whose own slot is within the leash of the attacker.
            if(g.mode==='hold'&&g.atPost){const s=g.slots.get(u)||u;
                if(WarMath.hypot(s.x-focus.x,s.z-focus.z)>StandingOrders.HOLD_LEASH)continue;}
            if(!g.fighting){g.anchor=this.fightAnchor(units,focus);g.fighting=true;}
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
    // Where a fight is anchored (b1110): the middle of the members near it, within a
    // chase of the first enemy fought. It was the middle of the whole group, which for a
    // group spread over the map -- one member at its post, the rest still walking from
    // home -- lay far from the fight: the leash, measured from there, released the enemy
    // the moment the fight began, and the member at the post stood idle while the
    // trebuchet beside it was destroyed (asp67's match of 24 October, 23:14). For a group
    // standing together it is the same point as before.
    fightAnchor(units,at){
        const near=units.filter(m=>m.health>0&&WarMath.hypot(m.x-at.x,m.z-at.z)<=StandingOrders.CHASE_RADIUS);
        return near.length?this.center(near):{x:at.x,z:at.z};
    }
    // A unit taken into a group that already marches (b1110: a trebuchet rolling off its
    // site into its engineer's formation). It takes a slot like any member, and a group
    // held to its slowest is held to the newcomer if it is slower.
    join(g,u) {
        if(!g||!u||!this.groups.has(g))return false;
        if(!g.units.includes(u))g.units.push(u);
        u._standingOrder=g;u._orderToken=g.token;
        if(g.pace==='slowestUnit'){
            const units=this.members(g),pace=Math.min(...units.map(m=>m.marchSpeed||m.speed||1));
            for(const m of units)m.marchSpeed=pace;
        }
        this.reform(g,g.to,g.fighting);
        return true;
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
    // Where the owner's OTHER groups already stand (b1086): their slots, for the members
    // still on them. A unit sent to a rally point on its own got the point itself as its
    // slot, and so did the next one, and the next: twenty single-unit orders to one spot
    // owned one spot, and friendly separation and the walk back to it shoved the crowd
    // about for as long as it stood there.
    reservedSlots(g) {
        const taken=[];
        if(!g)return taken;
        for(const o of this.groups){
            if(o===g||o.owner!==g.owner)continue;
            for(const [u,s] of o.slots)if(u.health>0&&u._standingOrder===o)taken.push(s);
        }
        return taken;
    }
    placeSlots(units,to,offsets,g=null) {
        const taken=this.reservedSlots(g);
        const free=p=>taken.every(s=>WarMath.hypot(p.x-s.x,p.z-s.z)>=1.8);
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
            return WarMath.hypot(p.x-clamped.x,p.z-clamped.z)<.01;
        };
        // Prefer translating the entire shape onto nearby open ground over
        // flattening several ranks onto the same building or shoreline boundary.
        for(let ring=0;ring<=16;ring++){
            const count=ring?16:1;
            for(let k=0;k<count;k++){
                const angle=k*Math.PI*2/count,dx=WarMath.cos(angle)*ring*3,dz=WarMath.sin(angle)*ring*3;
                const slots=desired.map(p=>({x:p.x+dx,z:p.z+dz}));
                if(slots.every(p=>legal(p)&&free(p)))return new Map(units.map((u,i)=>[u,slots[i]]));
            }
        }
        // A cramped village may have no room for the whole shape. Allocate nearby
        // open places individually, still reserving enough space for separation.
        const placed=[];
        for(const p of desired){
            let chosen=null;
            for(let i=0;i<1024;i++){
                const radius=2*Math.sqrt(i),angle=i*2.399963229728653;
                const q={x:p.x+WarMath.cos(angle)*radius,z:p.z+WarMath.sin(angle)*radius};
                if(legal(q)&&free(q)&&placed.every(s=>WarMath.hypot(q.x-s.x,q.z-s.z)>=1.8)){chosen=q;break;}
            }
            placed.push(chosen||this.game.clampSlot(p.x,p.z));
        }
        return new Map(units.map((u,i)=>[u,placed[i]]));
    }
    reform(g,to,preserveCombat=false) {
        const units=this.members(g);if(!units.length)return;
        const form=this.manager.applyFormation(this.game,units,to.x,to.z,g.shape);
        this.manager.applyMatchSpeed(units,g.pace||(form.applied?'slowestUnit':''));
        g.slots=this.placeSlots(units,to,form.offsets,g);g.leg={...to};
        // Besieging: the trebuchets side by side just inside their reach of the tower,
        // the soldiers behind them (b1110).
        const so=this.siegeStandoff(g);
        if(so)for(const [u,p] of this.siegeSlots(g,so,units))g.slots.set(u,p);
        g.holdSlots=null;
        g.supportSlots=null;g.supportAnchor=null;
        g.settled=false;
        for(const u of units){
            const slot=g.slots.get(u);
            if(Game.engineerBusy(u))continue;   // on a trebuchet job: back to its slot when done (b1110)
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
            u.isMoving=WarMath.hypot(u.x-slot.x,u.z-slot.z)>1;
            u.formationOffset=null; // use formationAim on the generic mover, not target pursuit
            this.game.clearRetaliation(u);
        }
        if(!preserveCombat)g.chases.clear();
    }
    // Guard (b1110): who has just damaged something of the owner's round the post is a
    // threat, and seen while it keeps at it. See GUARD_RADIUS.
    guardOwn(g) {
        const now=this.game.simNow?this.game.simNow():0,post=g.to,r=StandingOrders.GUARD_RADIUS;
        const mine=new Set(g.units);
        g.guarding=new Set();
        for(const v of g.owner.units.concat(g.owner.buildings||[])){
            const a=v._lastAttacker;
            if(!a||!(a.health>0)||!a.unitType||a.owner===g.owner.id||mine.has(v)||!(v.health>0)
                ||v._lastDamageTime==null||now-v._lastDamageTime>StandingOrders.GUARD_ANSWER_MS)continue;
            if(WarMath.hypot(v.x-post.x,v.z-post.z)>r||WarMath.hypot(a.x-v.x,a.z-v.z)>r)continue;
            g.guarding.add(a);
            (g.revealed||(g.revealed=new Map())).set(a,this.time+StandingOrders.REVEAL_MS);
            g.threats=(g.threats||[]).filter(e=>e.health>0);
            if(!g.threats.includes(a))g.threats.push(a);
        }
    }
    releaseTarget(g,u,target=u.attackTarget) {
        if(target){
            if(!g.blocked.has(u))g.blocked.set(u,new Map());
            g.blocked.get(u).set(target,{until:this.time+5000,
                distance:WarMath.hypot(u.x-target.x,u.z-target.z)});
        }
        u.attackTarget=null;u.isAttacking=false;this.game.clearRetaliation(u);g.chases.delete(u);
    }
    supportPosition(g,u,units,fallback) {
        // The standing order owns support movement as well as combat movement.
        // Keep one patient until healed/lost; nearest-patient scans every slice
        // otherwise turn a priest around whenever two soldiers pass each other.
        const fighters=units.filter(p=>p.attackTarget&&p.unitType!=='support');
        const army=this.center(fighters.length?fighters:units);
        // A patient under an enemy tower is not walked to unless the group is fighting that
        // tower (b1103, asp67): a priest whose patient died went on to the next wounded --
        // the next soldier under the tower -- and was shot there in turn.
        const covered=p=>{const t=this.game.enemyTowerCovering?.(u.owner,p.x,p.z);return !!t&&t!==g.target&&!g.threats?.includes(t);};
        const valid=p=>p&&p!==u&&g.owner.units.includes(p)&&p.owner===u.owner&&p.health>0&&p.unitType!=='siege'
            &&p.health<p.maxHealth&&(WarMath.hypot(p.x-u.x,p.z-u.z)<24
                ||(units.includes(p)&&WarMath.hypot(p.x-army.x,p.z-army.z)<=StandingOrders.CHASE_RADIUS))&&!covered(p);
        let patient=u._formationPatient;
        if(!valid(patient)){
            patient=g.owner.units.filter(valid).sort((a,b)=>WarMath.hypot(a.x-u.x,a.z-u.z)-WarMath.hypot(b.x-u.x,b.z-u.z))[0];
            u._formationPatient=patient||null;u._patientStand=null;
        }
        if(!patient)return fallback;
        // Already close enough: stand still and channel, do not march into the
        // patient's collision radius. Replan only when the patient moves away.
        const healRange=this.game.healingRange();
        if(WarMath.hypot(patient.x-u.x,patient.z-u.z)<=healRange-.2)return {x:u.x,z:u.z};
        // The stand is kept while it still REACHES the patient. Kept only while the patient
        // had moved less than 1, a soldier shuffling in a fight (0.7 outward) left the
        // priest on a stand 10.5 away -- a hair outside its reach -- healing no one while
        // it looked to be in range (1 Oct 2026).
        const old=u._patientStand;
        if(old&&WarMath.hypot(old.px-patient.x,old.pz-patient.z)<1
            &&(!StandingOrders.STAND_MUST_REACH||WarMath.hypot(old.x-patient.x,old.z-patient.z)<=healRange-.2))return old;
        const angle=WarMath.atan2(u.z-patient.z,u.x-patient.x);
        for(let i=0;i<16;i++){
            const a=angle+i*Math.PI/8;
            const x=patient.x+WarMath.cos(a)*(healRange-.7),z=patient.z+WarMath.sin(a)*(healRange-.7);
            const p=this.game.clampSlot(x,z);
            if(WarMath.hypot(p.x-x,p.z-z)>.01)continue;
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
        // One visibility grid per owner for this scan (buildVisionTest, ai.js): the same
        // answers as visible(), shared by every group that owner has. A scan moves no
        // unit, so the grid cannot go stale while it is used.
        const sight=new Map();
        const see=(g,e)=>{
            if(!e||e.owner===g.owner.id)return false;
            if(g.owner.id==='player'||typeof buildVisionTest!=='function'||!this.game.aiManager)return this.visible(g,e);
            let t=sight.get(g.owner);if(!t)sight.set(g.owner,t=buildVisionTest(this.game,g.owner));
            return t(e.x,e.z);
        };
        for(const g of this.groups){
            const units=g.units,center=this.center(units);
            // A tower cannot move: while a member stands in its range, or is on its way to
            // fight it, it stays known, seen or not (b1101, b1103).
            const towerFight=e=>units.some(u=>u.health>0&&(u.attackTarget===e||WarMath.hypot(u.x-e.x,u.z-e.z)<=(e.range||6)));
            if(g.revealed)for(const e of g.threats||[])if(e.type==='tower'&&e.health>0&&towerFight(e))
                g.revealed.set(e,this.time+StandingOrders.TOWER_FORGET_MS);
            if(g.revealed)for(const [e,until]of g.revealed)if(until<=this.time||e.health<=0)g.revealed.delete(e);
            if(g.mode==='guard'&&g.atPost)this.guardOwn(g);else g.guarding=null;
            const seen=e=>!!g.revealed?.has(e)||see(g,e);
            if(g.threats)g.threats=g.threats.filter(e=>e.health>0&&seen(e));
            // A tower that has stopped shooting the group, with nobody of it in range and
            // nobody on its way to fight it, is no longer this group's fight (b1101, b1103).
            if(g.threats?.some(e=>e.type==='tower'))g.threats=g.threats.filter(e=>e.type!=='tower'
                ||this.time-(g.towerShots?.get(e)??-Infinity)<StandingOrders.TOWER_FORGET_MS||towerFight(e));
            const focus=g.threats?.[0];
            // Visibility depends on the owner, not the attacker. Share its scan
            // across the formation instead of repeating it for every soldier.
            const visibility=new Map();
            const visible=e=>{if(!visibility.has(e))visibility.set(e,seen(e));return visibility.get(e);};
            // An attack on a tower moves on to the next (b1110, asp67: "a trebuchet with an
            // attack order and more than one tower in sight stops after destroying the first
            // target ... if a tower is destroyed and another is within viewing distance,
            // switch to that tower next"), as soldiers go on to the next building: the
            // nearest enemy tower in sight within a trebuchet's watch.
            if(!g.siegeResume?.length&&g.target&&g.target.type==='tower'&&!(g.target.health>0)&&this.withSiege(g)){
                const next=this.nextTower(g,see);
                if(next){g.target=next;g.from=this.center(this.members(g));
                    const so=this.siegeStandoff(g);if(so&&!g.fighting){const to=this.standoffTo(g,so);g.to=to;this.reform(g,to);}}
            }
            if(g.target&&see(g,g.target)&&g.target.health<=0){
                // A moving objective may die between scans. Guard its final
                // observed location rather than returning to the click location.
                if(g.mode==='guard'||g.mode==='hold'){
                    g.to={x:g.target.x,z:g.target.z};g.atPost=false;
                    if(!g.fighting)this.reform(g,g.to);
                }
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
                    const distance=WarMath.hypot(u.x-e.x,u.z-e.z);
                    if(e.health<=0||(retry.until<=this.time&&visible(e)&&
                        (distance<=this.game.attackRangeAgainst(u,e)+1||distance<=retry.distance-6)))targets.delete(e);
                }
                if(!targets.size)g.blocked.delete(u);
            }
            // A tower besieged on the way (b1110): fallen, the order goes back to what it
            // made for -- the tower it was going to besiege, or its point -- and besieges
            // the next one in its way, if any.
            if(g.siegeResume?.length&&!(g.target&&g.target.type==='tower'&&g.target.health>0)){
                let back=null;
                while(g.siegeResume.length){back=g.siegeResume.pop();if(!(back.target&&back.target.type==='tower')||back.target.health>0)break;}
                if(!g.siegeResume.length)g.siegeResume=null;
                g.target=back.target&&back.target.health>0?back.target:null;g.to={x:back.x,z:back.z};g.atPost=false;
                if(!g.fighting)this.reform(g,g.to);
            }
            this.besiegeGuard(g,see);
            const standoff=this.siegeStandoff(g),siegeIn=this.withSiege(g);
            // A tower target is followed seen or not (b1110): it stands still, and it shoots
            // farther (18) than a soldier sees (15). Besieging, the group stands off it; with
            // its trebuchets gone, it goes in from the stand-off, the tower out of its sight.
            if(g.target&&(g.target.type==='tower'||see(g,g.target))&&g.target.health>0){
                // The group stands off, or goes to the target.
                const to=standoff?this.standoffTo(g,standoff)
                    :{x:g.target.x,z:g.target.z};
                if(!g.fighting&&WarMath.hypot(to.x-g.leg.x,to.z-g.leg.z)>6)this.reform(g,to);
                g.to=to;
            }
            if((g.mode==='guard'||g.mode==='hold')&&!g.siegeResume?.length&&WarMath.hypot(center.x-g.to.x,center.z-g.to.z)<12)g.atPost=true;
            const anchor=g.fighting?g.anchor:center;
            // On the way to its post a holding group travels as a guard does; at the post
            // each unit answers only from its own slot (HOLD_LEASH).
            const holding=g.mode==='hold'&&g.atPost;
            // Attacking something of this owner's right now: a unit, a building, a farm.
            const aggressor=e=>{const t=e.attackTarget;return !!(t&&t.health>0&&t.owner===g.owner.id&&e.isAttacking!==false);};
            const holds=(u,e)=>{
                const s=g.slots.get(u)||u;
                const reach=(e===focus||g.threats?.includes(e)||aggressor(e))?StandingOrders.HOLD_LEASH:this.game.attackRangeAgainst(u,e)+1;
                return WarMath.hypot(e.x-s.x,e.z-s.z)<=reach;
            };
            const routeDistance=e=>{
                if((g.mode==='guard'||g.mode==='hold')&&g.atPost)return WarMath.hypot(e.x-g.to.x,e.z-g.to.z);
                if(g.mode!=='patrol')return 0;
                const dx=g.to.x-g.from.x,dz=g.to.z-g.from.z;
                const t=Math.max(0,Math.min(1,((e.x-g.from.x)*dx+(e.z-g.from.z)*dz)/(dx*dx+dz*dz||1)));
                return WarMath.hypot(e.x-g.from.x-t*dx,e.z-g.from.z-t*dz);
            };
            const threat=e=>!!(e&&g.threats?.includes(e));
            const valid=e=>e&&e.health>0&&!Game.hiddenSite(e)&&visible(e)&&
                (threat(e)||e===g.target||g.targets!=='military'||(e.type!=='worker'&&e.unitType!=='support'&&e.attack>0));
            // Near the group is near one of its members (b1110), not near the middle of
            // it. A group spread over the map -- one member at its post, the rest still
            // walking from home -- has its middle nowhere near anyone: in asp67's match of
            // 24 October (23:14) a champion holding at its post watched a phalanx 13.5
            // away destroy the trebuchet beside it, its three group-mates ~700 away
            // putting the group's centre out of reach of the fight.
            const live=units.filter(m=>m.health>0);
            const nearest=e=>{let d=Infinity;for(const m of live){const x=WarMath.hypot(e.x-m.x,e.z-m.z);if(x<d)d=x;}return d;};
            const withinLeash=(e,retaining=false)=>{
                const radius=retaining?StandingOrders.CHASE_RADIUS:StandingOrders.ACQUIRE_RADIUS;
                const route=retaining?StandingOrders.ROUTE_CHASE_RADIUS:StandingOrders.ROUTE_ACQUIRE_RADIUS;
                return routeDistance(e)<=route&&(!g.fighting||WarMath.hypot(e.x-anchor.x,e.z-anchor.z)<=radius)
                    &&nearest(e)<=radius;
            };
            // An order on a Wonder outranks everything but retaliation: the army marched
            // for the monument and ground its way there through every villager and
            // house within the leash, arriving late or not at all. Only the Wonder and
            // whatever attacks the group (focus) are fair game until it falls.
            const wonderRun=!!(g.target&&g.target.isWonder&&g.target.health>0);
            const eligible=(u,e)=>{
                if(!valid(e))return false;
                if(siegeIn&&e.type==='tower')return false;   // the trebuchets' work (b1110)
                // Besieging, nothing inside the tower's reach draws a soldier in, but what
                // attacks it (b1110): the houses round a besieged tower had.
                if(standoff&&!threat(e)&&WarMath.hypot(e.x-standoff.tower.x,e.z-standoff.tower.z)<=(standoff.tower.range||18)+2)return false;
                if(holding&&u&&!holds(u,e))return false;
                // A tower among the threats is the whole group's fight (b1103, threatFor);
                // b1101 had kept it to the members inside its firing range.
                if(threat(e))return e.type==='tower'||!g.blocked.get(u)?.has(e);
                if(e===g.target)return true;
                // A tower is not on an attack order's way (b1102, asp67): it guards, it
                // produces nothing, and a barracks or Town Center beside the route is worth
                // the time far more. It is fought as the order's target, or by the members in
                // its range once it shoots them (a threat, above) -- an army near it brawls
                // with it anyway. Until b1102 any tower within 48 of the route drew the group.
                if(e.type==='tower')return false;
                if(wonderRun)return false;
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
                &&candidates.some(e=>eligible(u,e)&&WarMath.hypot(e.x-u.x,e.z-u.z)<Math.max(36,(u.range||1)+24)));
            let fighting=false;
            for(const u of units){
                if(Game.engineerBusy(u))continue;   // building or mending a trebuchet (b1110)
                if((g.mode==='scout'&&!focus)||u.unitType==='support'||!(u.attack>0)){
                    if(u.attackTarget)this.releaseTarget(g,u);continue;
                }
                // A worker fights only for itself, under an order as without one (b1052): it
                // answers the unit that has just hit it, and nothing else. Held as soldiers
                // were, workers parked on "hold" walked up to rival workers and attacked
                // them -- and went on doing it after their seat was eliminated, its last
                // order still standing (asp67, 4 Oct; nobody had touched them).
                if(u.type==='worker'){
                    const atk=u._lastAttacker,now=this.game.simNow?this.game.simNow():0;
                    const answer=atk&&atk.health>0&&atk.unitType&&atk.owner!==u.owner&&u._lastDamageTime!=null
                        &&now-u._lastDamageTime<=StandingOrders.WORKER_ANSWER_MS
                        &&WarMath.hypot(atk.x-u.x,atk.z-u.z)<=Game.SELF_DEFENSE_LEASH;
                    if(answer){
                        if(u.attackTarget!==atk){u.attackTarget=atk;u.isAttacking=true;g.chases.delete(u);}
                        u.formationOffset=null;u.formationAxis=null;u.formationGroup=null;u.marchSpeed=null;
                        fighting=true;
                    }else if(u.attackTarget){u.attackTarget=null;u.isAttacking=false;this.game.clearRetaliation(u);g.chases.delete(u);}
                    continue;
                }
                let target=u.attackTarget;
                // Besieging: a member on a tower leaves it to the trebuchets (b1110).
                if(siegeIn&&target&&target.type==='tower'){
                    u.attackTarget=null;u.isAttacking=false;this.game.clearRetaliation(u);g.chases.delete(u);target=null;
                }
                // A target held from before is kept on a Wonder run only if it is the
                // Wonder or one of the group's live threats.
                if(wonderRun&&target&&target!==g.target&&!g.threats?.includes(target)){
                    u.attackTarget=null;u.isAttacking=false;this.game.clearRetaliation(u);g.chases.delete(u);target=null;
                }
                // Each member's own answer (threatFor), not one focus for the whole group.
                const mine=focus?this.threatFor(g,u,e=>valid(e)&&eligible(u,e)):null;
                // Guarding, one damaging the guarded ground is answered from any slot (b1110).
                if(mine&&(target===mine||g.guarding?.has(mine)
                    ||WarMath.hypot(u.x-mine.x,u.z-mine.z)<=StandingOrders.CHASE_RADIUS))target=mine;
                if(target){
                    const distance=WarMath.hypot(u.x-target.x,u.z-target.z);
                    let chase=g.chases.get(u);
                    if(!chase||chase.target!==target){chase={target,sample:distance,sampledAt:this.time,at:this.time,from:{x:u.x,z:u.z}};g.chases.set(u,chase);}
                    const inRange=distance<=this.game.attackRangeAgainst(u,target)+.5;
                    // Measure recent progress, not the best distance ever reached:
                    // a short detour must not poison the rest of a productive chase.
                    if(inRange)chase.at=this.time;
                    if(this.time-chase.sampledAt>=750){
                        if(distance<chase.sample-.25)chase.at=this.time;
                        chase.sample=distance;chase.sampledAt=this.time;
                    }
                    // Answering an attacker, a soldier is leashed to where IT took up the
                    // fight, not to the group's middle. The middle of a group spread across
                    // the map (fresh troops sent to join) lay far from the fighting, so a
                    // soldier 20 from the archer shooting it was told the archer had
                    // escaped, walked back toward the group, was shot, turned, and was told
                    // again -- 17 times in 150 s of a live Platform match (29 Sep 2026).
                    // Still leashed: a retreating attacker cannot lure it across the map.
                    const own=threat(target),fromDist=WarMath.hypot(target.x-chase.from.x,target.z-chase.from.z);
                    // Guarding, one still damaging what is guarded is in reach from any slot.
                    const guarded=own&&!!g.guarding?.has(target);
                    if(guarded||(own?fromDist<=StandingOrders.CHASE_RADIUS:withinLeash(target,true)))chase.outsideAt=null;
                    else if(chase.outsideAt==null)chase.outsideAt=this.time;
                    const escaped=chase.outsideAt!=null&&this.time-chase.outsideAt>=StandingOrders.BOUNDARY_GRACE_MS;
                    const tooFar=!guarded&&(own?fromDist:WarMath.hypot(target.x-anchor.x,target.z-anchor.z))>StandingOrders.CHASE_RADIUS*1.5;
                    const stalled=!inRange&&this.time-chase.at>=StandingOrders.STALL_MS;
                    const bounded=own?target.type!=='tower':target!==g.target;
                    const defendingInRange=own&&distance<=this.game.attackRangeAgainst(u,target);
                    const leftHold=holding&&!holds(u,target);
                    if(!valid(target)||leftHold||(bounded&&!defendingInRange&&(escaped||tooFar||stalled))){this.releaseTarget(g,u,target);target=null;}
                }
                if(!target){
                    // Joining the group's fight reaches as far as a chase may run, not across
                    // the map -- except for the order's own target, which every member is
                    // marching to anyway. In a group spread wide, a member 300 away picked
                    // the attacker, was at once too far from it to keep it, dropped it, and
                    // picked it again. Beyond the reach it marches on and joins on arrival.
                    let best=engaging?Infinity:Math.max(36,(u.range||1)+24);
                    for(const e of candidates){
                        if(g.mode==='scout'&&!threat(e))continue;
                        const d=WarMath.hypot(e.x-u.x,e.z-u.z);
                        if(engaging&&e!==g.target&&d>StandingOrders.CHASE_RADIUS*1.5)continue;
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
            // Any mobile threat in the queue -- not only its head, now that members answer
            // different ones -- that no member still pursues.
            if(g.threats)g.threats=g.threats.filter(e=>e.type==='tower'||units.some(u=>u.attackTarget===e));
            if(fighting){
                if(!g.fighting){const f=units.find(u=>u.attackTarget&&u.attackTarget.health>0);g.anchor=this.fightAnchor(units,f?f.attackTarget:center);g.fighting=true;}
                // Non-engaging members wait nearby; priests still heal in range.
                // Reserve legal, distinct places once per engagement/repack. A
                // clamped point per member can collapse several ranks onto one
                // building edge, while old march axes steer away from the hold.
                if(!g.holdSlots&&holding)g.holdSlots=new Map(units.map(u=>[u,g.slots.get(u)||{x:u.x,z:u.z}]));
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
                    const dx=enemy.x-body.x,dz=enemy.z-body.z,d=WarMath.hypot(dx,dz)||1;
                    const rear={x:body.x-dx/d*3,z:body.z-dz/d*3};
                    if(!g.supportSlots||!g.supportAnchor||WarMath.hypot(rear.x-g.supportAnchor.x,rear.z-g.supportAnchor.z)>2){
                        g.supportSlots=this.placeSlots(support,rear,null);g.supportAnchor=rear;
                    }
                }
                for(const u of units)if(!u.attackTarget&&!Game.engineerBusy(u)){
                    const hold=u.unitType==='support'?this.supportPosition(g,u,units,g.supportSlots.get(u)):g.holdSlots.get(u);
                    u.formationOffset=null;u.formationAxis=null;u.formationGroup=null;u.marchSpeed=null;
                    u.targetX=hold.x;u.targetZ=hold.z;u.isMoving=WarMath.hypot(u.x-hold.x,u.z-hold.z)>(u.unitType==='support'?.3:1);
                }
            }else{
                if(g.fighting){g.fighting=false;this.reform(g,g.to);}
                // Arrival does not erase the order. Patrol waits for every survivor,
                // including the slowest priest, before reversing the route.
                const arrived=units.every(u=>{const s=g.slots.get(u);return s&&WarMath.hypot(u.x-s.x,u.z-s.z)<=1.6;});
                if(arrived&&g.mode!=='patrol')g.settled=true;
                if(arrived&&g.target&&!see(g,g.target))g.target=null;
                if(arrived&&g.mode==='patrol'&&WarMath.hypot(g.to.x-g.from.x,g.to.z-g.from.z)>2){
                    [g.to,g.from]=[g.from,g.to];this.reform(g,g.to);
                }else for(const u of units){
                    const slot=g.slots.get(u);if(!slot||Game.engineerBusy(u))continue;
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
                                u.isMoving=WarMath.hypot(u.x-slot.x,u.z-slot.z)>.5;
                                continue;
                            }
                            u.formationOffset=null;u.formationAxis=null;u.formationGroup=null;u.marchSpeed=null;
                            u.targetX=hold.x;u.targetZ=hold.z;
                            u.isMoving=WarMath.hypot(u.x-hold.x,u.z-hold.z)>.3;
                            continue;
                        }
                    }
                    if(!u.isMoving&&WarMath.hypot(u.x-slot.x,u.z-slot.z)>1.6){u.targetX=slot.x;u.targetZ=slot.z;u.isMoving=true;}
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
                // A siege taken up on the way (b1110): which tower, and where the order goes after.
                ...(g.siegeResume?.length&&g.target&&g.target.health>0?{besieging:[Math.round(g.target.x),Math.round(g.target.z)],
                    then:[Math.round(g.siegeResume[0].x),Math.round(g.siegeResume[0].z)]}:{}),
                ...(g.mode==='march'&&!g.fighting&&units.some(u=>u.isMoving)?{secondsRemaining:Math.max(...units.map(u=>this.manager.travelEtaSec(u,g.to.x,g.to.z)))}:{})}];
        });
    }
}
// b1005's rule: a priest keeps its stand only while it reaches its patient. Switchable
// only so the Platform's build-896 parity test can compare against the old keeping rule,
// as it does with the old healing range; nothing in play turns it off.
StandingOrders.STAND_MUST_REACH=true;
Game.prototype.setStandingOrder=function(manager,owner,units,to,options){
    if(!this._standingOrders)this._standingOrders=new StandingOrders(this,manager);
    return this._standingOrders.issue(owner,units,to,options);
};
