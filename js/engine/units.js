// EngineUnits — procedural unit compositions + the cosmetic pose system.
// Same part contract as EngineBuildings ({kind, args, tex, m, blend, key}) with
// two extra fields: `team` (multiply the texture by the player color at draw
// time — the team-color mask) and `bone` (named limb). pose() returns per-bone
// matrices that swing limbs around their pivots for walk/harvest/attack cycles;
// parts without a bone stay rigid. Units are small on screen — silhouette,
// palette and team color do the work, so parts stay chunky and few.
(function () {
    const EngineUnits = {};
    const M = () => window.M3D;

    const part = (arr, kind, args, tex, t = {}) => {
        const m3 = M();
        let m = m3.translation(t.x || 0, t.y || 0, t.z || 0);
        if (t.ry) m = m3.multiply(m, m3.rotationY(t.ry));
        if (t.rx) m = m3.multiply(m, m3.rotationX(t.rx));
        if (t.rz) m = m3.multiply(m, m3.rotationZ(t.rz));
        if (t.sx || t.sy || t.sz) m = m3.multiply(m, m3.scaling(t.sx || 1, t.sy || 1, t.sz || 1));
        arr.push({
            kind, args, tex, m, blend: !!t.blend, team: !!t.team,
            accent: t.accent || null, // 'fill' | 'rim' — tinted per SEAT (team badge), not per civ
            bone: t.bone || null, key: kind + ':' + args.join(',')
        });
    };
    const shadow = (arr, r) => part(arr, 'disc', [r, 14], 'shadow', { y: 0.05, blend: true });

    // Team badge: the per-seat ownership MARK (color + shape) on chests and
    // flags, front AND back — each shape is a short prism pushed through the
    // host along Z, so its two caps read as the filled shape from either side;
    // a slightly wider, slightly recessed copy behind it is the contrast rim.
    // The renderer tints 'fill'/'rim' parts per SEAT (getTeamBadge), never per
    // civ — this is what tells two same-civ players apart at unit scale.
    //
    // Prism orientation: a box's length is already along Z, so `rz` alone spins
    // its cap in the view plane. A cylinder's axis is +Y, so polygonal caps
    // (triangle/star) go through rz(π/2)·[rx spin]·ry(π/2): part() applies
    // Rz first (tips +Y onto X, cap into the YZ plane), rx then ROLLS the cap
    // in its own plane, ry(π/2) finally lays the axis along Z. With vertex 0 at
    // angle 0, a 3-segment cap lands point-up with no roll at all.
    const HPI = Math.PI / 2;
    const badgeParts = (shape, o) => {
        const p = [];
        const y = o.y || 0, z = o.z || 0;
        const emit = (accent, R, L) => {
            switch (shape) {
                case 'square':
                    part(p, 'box', [R * 1.7, R * 1.7, L], 'white', { y, z, accent });
                    break;
                case 'diamond':
                    part(p, 'box', [R * 1.8, R * 1.8, L], 'white', { y, z, rz: Math.PI / 4, accent });
                    break;
                case 'triangle':
                    part(p, 'cylinder', [R * 1.4, R * 1.4, L, 3], 'white', { y, z, ry: HPI, rz: HPI, accent });
                    break;
                case 'star': // two thin diamonds crossed — reads as a 4-point sparkle
                    part(p, 'cylinder', [R * 1.6, R * 1.6, L, 4], 'white', { y, z, ry: HPI, rz: HPI, sz: 0.32, accent });
                    part(p, 'cylinder', [R * 1.6, R * 1.6, L, 4], 'white', { y, z, ry: HPI, rx: HPI, rz: HPI, sz: 0.32, accent });
                    break;
                case 'cross': // two bars at ±45°
                    part(p, 'box', [R * 0.9, R * 2.5, L], 'white', { y, z, rz: Math.PI / 4, accent });
                    part(p, 'box', [R * 0.9, R * 2.5, L], 'white', { y, z, rz: -Math.PI / 4, accent });
                    break;
                default: // circle
                    part(p, 'cylinder', [R, R, L, 12], 'white', { y, z, rx: HPI, accent });
            }
        };
        emit('rim', o.r * 1.35, o.lenRim);
        emit('fill', o.r, o.lenFill);
        return p;
    };
    // Shared with the building renderer: flag badges use the exact same shapes.
    EngineUnits.badgeParts = badgeParts;
    const badge = (p, shape, y, z, r, lenFill, lenRim) => {
        if(!shape)return;
        // Paint the existing torso/tabard rather than pushing a prism through it.
        const host=[...p].reverse().find(e=>e.tex==='cloth'&&e.team&&!e.bone
            &&Math.abs(e.m[12])<.01&&Math.abs(e.m[14]-z)<.3);
        if(host)host.badgePaint={y,width:r*4};
    };

    const oval = (p, tex, x, y, z, sx, sy, sz, extra = {}) =>
        part(p,'sphere',Math.max(sx,sy,sz)<.11?[1,8,5]:[1,12,8],tex,{x,y,z,sx,sy,sz,...extra});

    // Joined rider limbs: author endpoints, then orient a tapered cylinder along
    // them. The same joint coordinates serve both adjacent segments and their cap.
    const riderLimb = (p,name,tex,a,b,ra,rb,bone=null) => {
        const d=b.map((v,i)=>v-a[i]),length=Math.hypot(...d);
        part(p,'cylinder',[rb,ra,length,10],tex,{
            x:(a[0]+b[0])/2,y:(a[1]+b[1])/2,z:(a[2]+b[2])/2,
            ry:Math.atan2(d[0],d[2]),rx:Math.atan2(Math.hypot(d[0],d[2]),d[1]),bone
        });
        Object.assign(p[p.length-1],{riderLimb:name,jointStart:a,jointEnd:b});
    };

    // Stable cosmetic variants: the same recorded handle keeps its appearance
    // through redraws, age upgrades and replay, without touching simulation RNG.
    EngineUnits.appearanceVariant = (civ,identity='') => {
        let hash=0;
        for(const char of String(identity)) hash=(hash*31+char.charCodeAt(0))>>>0;
        return hash%(civ==='greek'?3:civ==='yamato'?2:1);
    };
    const hairMaterial = o => o.civ==='greek' ? ['hairBlack','hairBrown','hairBlond'][(o.variant||0)%3]
        : o.civ==='yamato' ? ['hairBrown','hairWhite'][(o.variant||0)%2] : 'hairBlack';

    // Large faces with a visible mouth under the moustache. These are stylized
    // cultural silhouettes, not ceremonial regalia or a historical uniform.
    const face = (p,x,y,z,s=1,o={}) => {
        const hair=hairMaterial(o);
        oval(p,'skin',x,y,z,.225*s,.235*s,.20*s);
        oval(p,'skin',x,y-.005*s,z+.196*s,.048*s,.057*s,.05*s);
        for(const side of [-1,1]) {
            oval(p,'hairBlack',x+side*.079*s,y+.038*s,z+.185*s,.018*s,.024*s,.014*s);
            part(p,'box',[.067*s,.022*s,.02*s],hair,
                {x:x+side*.078*s,y:y+.085*s,z:z+.182*s,rz:side*-.13});
        }
        // Lip surround keeps the dark mouth legible even inside a black beard.
        oval(p,'skin',x,y-.081*s,z+.203*s,.069*s,.022*s,.018*s);
        oval(p,'mouth',x,y-.079*s,z+.218*s,.053*s,.008*s,.008*s);
        if(o.civ==='yamato') {
            // Separated moustache and tapered chin beard, white or dark brown.
            for(const side of [-1,1]) oval(p,hair,x+side*.052*s,y-.050*s,z+.203*s,
                .061*s,.022*s,.030*s,{rz:side*-.22});
            oval(p,hair,x,y-.194*s,z+.13*s,.082*s,.110*s,.074*s);
        } else if(o.civ==='egyptian') {
            // Short, rounded natural chin growth; no long square royal false beard.
            oval(p,hair,x,y-.183*s,z+.115*s,.080*s,.075*s,.078*s);
            for(const side of [-1,1]) oval(p,hair,x+side*.042*s,y-.049*s,z+.202*s,.043*s,.014*s,.024*s);
        } else {
            const rich=o.civ==='persian';
            for(const side of [-1,1]) {
                oval(p,hair,x+side*.125*s,y-.112*s,z+.12*s,.078*s,.096*s,.085*s);
                oval(p,hair,x+side*.049*s,y-.047*s,z+.209*s,.060*s,.024*s,.033*s);
            }
            oval(p,hair,x,y-.194*s,z+.123*s,(rich?.155:.137)*s,(rich?.112:.098)*s,.104*s);
        }
    };

    // Each weapon is authored around its grip, then moved/tilted as ONE rigid
    // assembly before the arm pose. The bottom of a shaft cannot drift off the palm.
    const held = (p,name,bone,grip,build,pitch=.42) => {
        const pieces=[];build(pieces);
        const m=M(), outward=grip[0]<0?.12:-.12;
        const frame=m.multiply(m.translation(...grip),m.multiply(m.rotationX(pitch),m.rotationZ(outward)));
        for(const piece of pieces) {
            piece.m=m.multiply(frame,piece.m);
            piece.bone=bone;
            piece.attachment=name;piece.grip=grip;piece.gripFrame=frame;
            p.push(piece);
        }
    };

    const headgear = (p,civ,kind,x,y,z,s=1) => {
        const S=v=>v*s, military=kind==='military';
        y+=S(.075); // brow clears the eyes; the shell still overlaps the skull
        const dome=(tex,team=false)=>part(p,'dome',[1,16],tex,
            {x,y:y+S(.045),z,sx:S(.253),sy:S(.24),sz:S(.235),team});
        if(military && civ!=='egyptian') {
            dome('iron');
            oval(p,'iron',x,y-S(.085),z-S(.17),S(.20),S(.16),S(.075));
            part(p,'cylinder',[S(.252),S(.255),S(.055),16],'iron',{x,y:y+S(.044),z});
            // Rounded cheek guards frame the exposed face instead of hiding it.
            for(const side of [-1,1]) oval(p,'iron',x+side*S(.214),y-S(.08),z+S(.035),S(.048),S(.14),S(.16));
        }
        if(civ==='greek') {
            if(military) {
                // A curved sagittal plume, broad in profile like the reference.
                part(p,'dome',[1,16],'cloth',{x,y:y+S(.22),z:z-S(.025),sx:S(.047),sy:S(.24),sz:S(.33),team:true});
                part(p,'box',[S(.065),S(.04),S(.33)],'gold',{x,y:y+S(.225),z});
            } else part(p,'cylinder',[S(.222),S(.228),S(.045),12],kind==='priest'?'foliage':'cloth',
                {x,y:y+S(.085),z,team:kind!=='priest'});
        } else if(civ==='egyptian') {
            dome('cloth',true);
            for(const side of [-1,1]) oval(p,'cloth',x+side*S(.213),y-S(.07),z-S(.055),S(.067),S(.20),S(.16),{team:true});
            part(p,'cylinder',[S(.232),S(.235),S(.04),12],'gold',{x,y:y+S(.05),z});
            if(kind==='priest') part(p,'cylinder',[S(.105),S(.17),S(.19),12],'gold',{x,y:y+S(.29),z});
        } else if(civ==='yamato') {
            if(military) {
                part(p,'cylinder',[S(.235),S(.31),S(.12),12],'iron',{x,y:y-S(.04),z:z-S(.035)});
                for(const side of [-1,1]) part(p,'cylinder',[S(.014),S(.035),S(.20),8],'gold',
                    {x:x+side*S(.07),y:y+S(.21),z:z+S(.21),rz:side*-.55});
            } else if(kind==='priest') part(p,'cylinder',[S(.065),S(.15),S(.29),10],'bark',{x,y:y+S(.18),z});
            // Brim at head centre + .11: just above the .085-high eyebrows.
            else part(p,'cylinder',[S(.025),S(.37),S(.18),16],'thatch',{x,y:y+S(.125),z});
        } else if(civ==='persian') {
            // Unarmored heads need a lower cap; the military cap rests on its helmet.
            const lift=military?.24:.16;
            part(p,'cylinder',[S(.09),S(.23),S(.25),12],'cloth',{x,y:y+S(lift),z,team:true});
            oval(p,'cloth',x,y+S(lift+.13),z,S(.10),S(.06),S(.10),{team:true});
        } else if(!military) {
            if(kind==='priest') dome('cloth',true);
            else part(p,'cylinder',[S(.025),S(.35),S(.17),12],'thatch',{x,y:y+S(.20),z});
        }
    };

    const cape = (p,y=1.25,z=-.22,s=1) => {
        // Flared cloth mantle; folds carry a silhouette from the rear view too.
        part(p,'frustum',[.64*s,.09*s,.40*s,.065*s,.72*s],'cloth',
            {y:y-.72*s,z:z-.13*s,rx:.12,team:true});
        // Mark the broad fabric panel; the narrow edge folds stay plain cloth.
        p[p.length-1].capePaint={y:y-.34*s,width:.60*s};
        for(const side of [-1,1]) part(p,'cylinder',[.025*s,.045*s,.68*s,6],'cloth',
            {x:side*.19*s,y:y-.35*s,z:z-.09*s,rz:side*-.14,rx:.12,team:true});
    };
    const shoulders = (p,tex='iron',y=1.23,s=1) => {
        for(const side of [-1,1]) oval(p,tex,side*.33*s,y,0,.16*s,.115*s,.20*s,
            {bone:side<0?'armL':'armR'});
    };
    const humanoid = (p,opts={}) => {
        shadow(p,.72);
        for(const side of [-1,1]) {
            const bone=side<0?'legL':'legR';
            part(p,'cylinder',[.10,.115,.55,10],'leather',{x:side*.13,y:.37,bone});
            part(p,'shoe',[.23,.20,.38],'leather',{x:side*.13,z:.055,bone});
            const arm=side<0?'armL':'armR';
            part(p,'cylinder',[.10,.085,.42,10],opts.sleeves||'leather',
                {x:side*.34,y:1.0,rz:side*.10,bone:arm});
            oval(p,'skin',side*.37,.77,.045,.09,.11,.095,{bone:arm});
        }
        part(p,'cylinder',[.24,.31,.65,12],'cloth',{y:.98,sz:.78,team:true});
        part(p,'cylinder',[.259,.267,.075,12],'leather',{y:.88,sz:.8});
        part(p,'box',[.08,.065,.045],'gold',{y:.88,z:.22});
        face(p,0,1.49,0,1,opts);
        badge(p,opts.badge,1.08,0,.087,.57,.54);
    };

    // Symmetric horse anatomy around +Z. The neck, head, muzzle, ears and
    // bridle all share one pivot; paired legs begin straight beneath the body.
    const HORSE_HIP_Y=.88, HORSE_HALF_STANCE=.18, HORSE_LEG_BOTTOM=.05;
    const horse = (p,tier) => {
        shadow(p,1.05);
        oval(p,'leather',0,.90,0,.32,.34,.62);
        oval(p,'leather',0,.94,.44,.29,.32,.31);
        oval(p,'leather',0,.92,-.44,.30,.32,.31);
        const leg=(x,z,bone)=>{
            // Bury the entire top rim in the chest/rump, including at full
            // stride. Keep the hoof end at its original height on the ground.
            part(p,'cylinder',[.075,.060,HORSE_HIP_Y-HORSE_LEG_BOTTOM,9],'leather',
                {x,y:(HORSE_HIP_Y+HORSE_LEG_BOTTOM)/2,z,bone});
            oval(p,'leather',x,.33,z,.078,.095,.082,{bone});
            oval(p,'bark',x,.085,z+.018,.090,.075,.125,{bone});
        };
        leg(-HORSE_HALF_STANCE,.44,'legFL');leg(HORSE_HALF_STANCE,.44,'legFR');
        leg(-HORSE_HALF_STANCE,-.44,'legBL');leg(HORSE_HALF_STANCE,-.44,'legBR');
        oval(p,'leather',0,1.19,.55,.18,.35,.23,{rx:.38,bone:'head'});
        oval(p,'leather',0,1.48,.84,.17,.20,.29,{rx:.38,bone:'head'});
        oval(p,'leather',0,1.36,1.07,.14,.115,.18,{rx:.12,bone:'head'});
        for(const side of [-1,1]) {
            oval(p,'hairBlack',side*.152,1.52,.91,.019,.023,.026,{bone:'head'});
            oval(p,'hairBlack',side*.087,1.38,1.214,.022,.015,.017,{bone:'head'});
            part(p,'cylinder',[0,.052,.19,8],'leather',{x:side*.10,y:1.70,z:.70,rx:-.13,bone:'head'});
            // Bridle cheeks connect skull and muzzle; entirely on the head bone.
            part(p,'box',[.022,.032,.32],'bark',{x:side*.144,y:1.43,z:1.01,rx:.35,bone:'head'});
        }
        oval(p,'mouth',0,1.33,1.238,.082,.009,.008,{bone:'head'});
        oval(p,'bark',0,1.30,.40,.050,.27,.11,{rx:.38,bone:'head'});
        // A short forelock, rooted between the ears, replaces the detached mane bar.
        oval(p,'bark',0,1.66,.77,.062,.075,.105,{bone:'head'});
        part(p,'cylinder',[.065,.030,.47,8],'bark',{y:.77,z:-.79,rx:-2.9});
        part(p,'box',[.45,.07,.46],'cloth',{y:1.21,z:.02,team:true});
        if(tier>=2) part(p,'box',[.24,.075,.29],'leather',{y:1.25});
        if(tier>=3) {
            oval(p,'iron',0,1.58,.98,.12,.045,.20,{rx:.38,bone:'head'});
            oval(p,'iron',0,.98,.714,.25,.22,.055);
            for(const side of [-1,1]) oval(p,'iron',side*.30,.96,0,.035,.22,.47);
        }
    };

    // How much war a unit wears: 1 = levy/light, 2 = the line trooper,
    // 3 = elite. Derived from the specific unit id (see TIER below) so
    // militia / warrior / champion stop sharing one body.
    const builders = {
        worker: (o = {}) => {
            const p = [];
            humanoid(p, o);
            headgear(p, o.civ, 'civil', 0, 1.49, 0);
            held(p,'axe','armR',[.37,.77,.045],q=>{
                part(q,'cylinder',[.028,.028,.55,8],'wood',{y:.09});
                part(q,'box',[.065,.18,.25],'iron',{y:.33,z:.08});
            });
            return p;
        },
        infantry: (o = {}) => {
            const tier=o.tier||2, p=[];
            humanoid(p,o);
            headgear(p,o.civ,tier===1?'civil':'military',0,1.49,0);
            if(tier===1) {
                held(p,'club','armR',[.37,.77,.045],q=>
                    part(q,'cylinder',[.075,.045,.65,9],'wood',{y:.23}),.35);
            } else {
                shoulders(p);
                // Polished breastplate behind a team-colour tabard.
                oval(p,'iron',0,1.15,0,.27,.19,.235);
                part(p,'frustum',[.30,.04,.25,.04,.53],'cloth',{y:.67,z:.22,team:true});
                badge(p,o.badge,1.12,0,.08,.61,.58);
                cape(p);
                // Convex shield: rim, painted face and raised boss follow the left arm.
                const shieldX=-.43, shieldY=.99;
                oval(p,'iron',shieldX,shieldY,.19,.29,.37,.085,{bone:'armL'});
                oval(p,'cloth',shieldX,shieldY,.23,.247,.319,.072,{bone:'armL',team:true});
                oval(p,'iron',shieldX,shieldY,.29,.075,.075,.045,{bone:'armL'});
                held(p,'sword','armR',[.37,.77,.045],q=>{
                    part(q,'cylinder',[.036,.036,.20,8],'leather',{});
                    part(q,'box',[.26,.055,.075],'iron',{y:.12});
                    part(q,'cylinder',[0,.075,.69,4],'iron',{y:.48,sz:.34});
                });
                if(tier>=3) {
                    part(p,'cylinder',[.245,.25,.035,12],'gold',{y:1.28,sz:.80});
                    for(const side of [-1,1]) oval(p,'iron',side*.13,.38,.07,.105,.19,.09,{bone:side<0?'legL':'legR'});
                }
            }
            return p;
        },
        ranged: (o = {}) => {
            const tier = o.tier || 1;
            const p = [];
            humanoid(p, { ...o, sleeves: 'leather' });
            if(tier>=2) shoulders(p,'leather');
            if (tier >= 2) headgear(p, o.civ, 'military', 0, 1.47, 0);
            else if (o.civ) headgear(p, o.civ, 'civil', 0, 1.49, 0);
            else part(p, 'sphere', [1, 8, 6], 'leather', { y: 1.53, sx: 0.18, sy: 0.11, sz: 0.18 }); // generic cap
            if(tier===2) {
                held(p,'crossbow','armR',[.37,.77,.045],q=>{
                    part(q,'box',[.055,.065,.60],'wood',{y:.045,z:.17});
                    part(q,'cylinder',[.022,.022,.50,8],'iron',{y:.06,z:.39,rz:Math.PI/2});
                    part(q,'box',[.055,.10,.05],'iron',{z:.44});
                },-.22);
            } else {
                held(p,'bow','armL',[-.37,.77,.045],q=>{
                    part(q,'cylinder',[.026,.026,tier>=3?1.3:1.15,8],'wood',{y:.12});
                    if(tier>=3) part(q,'cylinder',[.034,.034,.16,8],'gold',{});
                });
            }
            part(p, 'cylinder', [0.07, 0.09, 0.5, 5], 'bark', { x: 0.1, y: 1.12, z: -0.28, rz: 0.5 }); // quiver
            if (tier >= 3) cape(p);
            return p;
        },
        priest: (o = {}) => {
            const p=[];
            humanoid(p,{...o,sleeves:'cloth'});
            part(p,'cylinder',[.235,.37,.83,14],'cloth',{y:.51,sz:.85});
            part(p,'frustum',[.18,.035,.15,.035,.85],'cloth',{y:.12,z:.27,team:true});
            cape(p,1.25,-.23,1.12);
            headgear(p,o.civ,'priest',0,1.49,0);
            held(p,'staff','armR',[.37,.77,.045],q=>{
                part(q,'cylinder',[.035,.035,1.42,10],'wood',{y:.07});
                oval(q,'gold',0,.83,0,.10,.13,.10);
            });
            return p;
        },
        cavalry: (o = {}) => {
            if (o.unit === 'horse_carriage') {
                // Egypt's chariot: a light horse pulling a two-wheeled cart with
                // a standing, helmeted spearman. Rider and cart are rigid; the
                // horse keeps its leg/head bones so the trot reads normally.
                const p = [];
                horse(p, 1);
                part(p, 'disc', [0.7, 12], 'shadow', { y: 0.05, z: -1.15, blend: true });
                part(p, 'cylinder', [0.035, 0.035, 0.86, 5], 'bark', { y: 0.34, z: -1.15, rz: Math.PI / 2 }); // axle
                part(p, 'cylinder', [0.34, 0.34, 0.08, 10], 'wood', { x: -0.42, y: 0.34, z: -1.15, rz: Math.PI / 2 });
                part(p, 'cylinder', [0.34, 0.34, 0.08, 10], 'wood', { x: 0.42, y: 0.34, z: -1.15, rz: Math.PI / 2 });
                part(p, 'box', [0.55, 0.34, 0.62], 'wood', { y: 0.66, z: -1.18 });          // cart tub
                part(p, 'box', [0.5, 0.14, 0.05], 'wood', { y: 0.87, z: -0.88 });           // front rail
                part(p, 'cylinder', [0.022, 0.022, 0.62, 4], 'bark', { x: -0.2, y: 0.5, z: -0.72, rx: 1.45 }); // hitch shafts
                part(p, 'cylinder', [0.022, 0.022, 0.62, 4], 'bark', { x: 0.2, y: 0.5, z: -0.72, rx: 1.45 });
                part(p, 'cylinder', [0.14, 0.17, 0.44, 6], 'cloth', { y: 1.06, z: -1.18, team: true });        // rider
                badge(p, o.badge, 1.10, -1.18, 0.06, 0.41, 0.38);                                              // rider chest badge
                face(p,0,1.41,-1.18,.75,o);
                headgear(p, o.civ, 'military', 0, 1.44, -1.18, 0.75);                                          // helmet
                for(const side of [-1,1]) {
                    const suffix=side<0?'L':'R', shoulder=[side*.18,1.24,-1.18];
                    const elbow=[side*.24,1.10,-1.12];
                    const hand=side<0?[-.20,1.10,-.91]:[.22,1.07,-1.04];
                    riderLimb(p,'upperArm'+suffix,'leather',shoulder,elbow,.070,.064);
                    oval(p,'leather',...elbow,.066,.067,.066);
                    riderLimb(p,'forearm'+suffix,'skin',elbow,hand,.061,.052);
                    oval(p,'skin',...hand,.065,.075,.067);
                }
                held(p,'chariot-spear',null,[.22,1.07,-1.04],q=>{
                    part(q,'cylinder',[.022,.022,1.35,8],'wood',{y:.555});
                    part(q,'cylinder',[0,.037,.14,6],'iron',{y:1.29});
                });
                return p;
            }
            const tier = o.tier || 2;
            const p = [];
            horse(p, tier);
            // A seated pelvis meets the saddle. Thighs wrap outward and forward
            // to the knees; calves hang outside the horse, with boots facing +Z.
            part(p, 'cylinder', [0.19, 0.22, 0.46, 12], 'cloth', { y: 1.47, team: true });
            badge(p, o.badge, 1.52, 0, 0.07, 0.48, 0.45); // rider chest — torso r≈0.18 here
            for(const side of [-1,1]) {
                const suffix=side<0?'L':'R',hip=[side*.14,1.32,-.08];
                const knee=[side*.37,1.10,.22],ankle=[side*.38,.81,.14];
                riderLimb(p,'thigh'+suffix,'leather',hip,knee,.105,.095);
                oval(p,'leather',...knee,.10,.10,.10);
                riderLimb(p,'calf'+suffix,'leather',knee,ankle,.085,.072);
                part(p,'shoe',[.20,.15,.32],'leather',{x:side*.38,y:.725,z:.22});
                if(tier>=3) oval(p,'iron',side*.37,1.11,.285,.080,.090,.040);
            }
            face(p,0,1.85,0,.8,o);
            if(tier>=2) {
                oval(p,'iron',0,1.59,0,.20,.12,.18);
                cape(p,1.68,-.16,.7);
            }
            headgear(p, o.civ, tier === 1 ? 'civil' : 'military', 0, 1.88, 0, 0.8);
            for(const side of [-1,1]) {
                const suffix=side<0?'L':'R',bone='arm'+suffix;
                const shoulder=[side*.25,1.66,0],elbow=[side*.34,1.46,.06];
                const hand=side<0?[-.29,1.40,.25]:[.35,1.31,.14];
                riderLimb(p,'upperArm'+suffix,'leather',shoulder,elbow,.092,.083,bone);
                oval(p,'leather',...elbow,.085,.085,.085,{bone});
                riderLimb(p,'forearm'+suffix,tier>=3?'leather':'skin',elbow,hand,.078,.068,bone);
                oval(p,'skin',...hand,.082,.090,.085,{bone});
                oval(p,tier>=2?'iron':'leather',...shoulder,.125,.10,.15,{bone});
            }
            held(p,tier===1?'javelin':tier===2?'spear':'lance','armR',[.35,1.31,.14],q=>{
                const length=tier===1?1.1:tier===2?1.3:1.45;
                part(q,'cylinder',[.025,.025,length,8],'wood',{y:length/2-.12});
                part(q,'cylinder',[0,.035,.14,6],'iron',{y:length-.05});
                if(tier>=3) part(q,'box',[.035,.16,.22],'cloth',{y:length-.21,z:.11,team:true});
            });
            return p;
        }
    };

    // Specific unit id → visual tier. Unlisted ids fall back per category
    // (ranged reads as the plain archer, everything else as the line trooper).
    // Uniques dress by their station: hoplite a trooper, phalanx/samurai elite.
    const TIER = {
        militia: 1, warrior: 2, champion: 3,
        archer: 1, crossbowman: 2, elite_archer: 3,
        scout_cavalry: 1, cavalry: 2, heavy_cavalry: 3,
        slinger: 1, hoplite: 2, phalanx: 3, samurai: 3, archer_ship: 1
    };

    // Limb pivots per type (unit-local space, before facing/world transforms).
    const HUMAN_PIVOTS = {
        legL: [-0.13, 0.68, 0], legR: [0.13, 0.68, 0],
        armL: [-0.34, 1.22, 0], armR: [0.34, 1.22, 0]
    };
    const PIVOTS = {
        worker: HUMAN_PIVOTS, infantry: HUMAN_PIVOTS, ranged: HUMAN_PIVOTS, priest: HUMAN_PIVOTS,
        cavalry: {
            legFL: [-HORSE_HALF_STANCE, HORSE_HIP_Y, 0.44], legFR: [HORSE_HALF_STANCE, HORSE_HIP_Y, 0.44],
            legBL: [-HORSE_HALF_STANCE, HORSE_HIP_Y, -0.44], legBR: [HORSE_HALF_STANCE, HORSE_HIP_Y, -0.44],
            armL: [-0.25, 1.66, 0], armR: [0.25, 1.66, 0],
            head: [0, 0.98, 0.5] // neck root — the walk nod swings the whole neck
        }
    };

    // opts.civ ('greek' | 'egyptian' | 'yamato' | 'persian') picks the cultural
    // headgear/accents; opts.unit (specific id like 'champion') picks the tier
    // dressing. Omit both for the generic look (engine-test).
    EngineUnits.parts = (type, opts) => {
        const o = { ...opts };
        if (o.tier == null) o.tier = TIER[o.unit] || (type === 'ranged' ? 1 : 2);
        const b = builders[type];
        const parts=b ? b(o) : [];
        if(o.badge)for(const p of parts)if(p.capePaint)p.badgePaint=p.capePaint;
        return parts;
    };

    // Material/ownership/bone are all part of the batch key. Team and badge
    // colours stay per instance; cached geometry can be shared across seats.
    EngineUnits.batches = parts => {
        const groups=new Map();
        for(const p of parts) {
            const key=JSON.stringify([p.tex,p.team,p.accent,p.bone,p.blend,!!p.badgePaint]);
            if(!groups.has(key)) groups.set(key,{...p,parts:[]});
            groups.get(key).parts.push(p);
        }
        return [...groups.values()].map(group=>{
            const mesh=window.EngineMesh.mergeParts(group.parts);
            if(group.badgePaint){
                let offset=0;
                for(const part of group.parts){
                const {y,width}=part.badgePaint;
                const count=window.EngineMesh[part.kind](...part.args).positions.length/3;
                // Project onto both sides of the actual torso surface. No overlay,
                // depth offset, floating cap or additional transparency pass.
                for(let i=offset;i<offset+count;i++){
                    mesh.uvs[i*2]=.5+mesh.positions[i*3]/width;
                    mesh.uvs[i*2+1]=.5+(y-mesh.positions[i*3+1])/width;
                }
                offset+=count;
                }
            }
            return {...group,mesh};
        });
    };

    // Per-type render metadata: health-bar height above the ground.
    EngineUnits.META = {
        worker: { barY: 2.15 }, infantry: { barY: 2.15 }, ranged: { barY: 2.15 },
        priest: { barY: 2.15 }, cavalry: { barY: 2.45 }
    };

    // Cosmetic animation: returns { mats, bob } — mats maps bone name → matrix
    // (rotation about that limb's pivot), bob is a world-Y offset for the body.
    // t is seconds; phase de-synchronizes crowds.
    EngineUnits.pose = (type, anim, t, phase = 0) => {
        const m3 = M();
        const P = PIVOTS[type] || {};
        const mats = {};
        let bob = 0;
        const swing = (bone, R) => {
            const pv = P[bone];
            if (pv) mats[bone] = m3.rotateAround(R, pv[0], pv[1], pv[2]);
        };
        if (type === 'cavalry') {
            if (anim === 'walk') {
                const s = Math.sin(t * 7 + phase);
                swing('legFL', m3.rotationX(s * 0.40)); swing('legBR', m3.rotationX(s * 0.40));
                swing('legFR', m3.rotationX(-s * 0.40)); swing('legBL', m3.rotationX(-s * 0.40));
                swing('head', m3.rotationX(Math.sin(t * 7 + phase + 1) * 0.035)); // the trot nod
                bob = Math.abs(s) * 0.035;
            } else if (anim === 'attack') {
                // couch the spear forward
                const s = Math.sin(t * 7.5 + phase);
                swing('armR', m3.rotationX(-0.3 - Math.max(0, s) * 0.5));
            } else { // idle: a slow grazing bow of the neck
                swing('head', m3.rotationX(Math.max(0, Math.sin(t * 0.9 + phase)) * 0.04));
            }
        } else if (anim === 'walk') {
            const s = Math.sin(t * 6.5 + phase);
            swing('legL', m3.rotationX(s * 0.55)); swing('legR', m3.rotationX(-s * 0.55));
            swing('armL', m3.rotationX(-s * 0.35)); swing('armR', m3.rotationX(s * 0.35));
            // Ground the lower sole throughout the stride instead of lifting both feet.
            const angle=Math.abs(s*.55);
            const soleY=.68+(-.02-.68)*Math.cos(angle)-(.055+.19*.8)*Math.sin(angle);
            bob=-.02-soleY;
        } else if (anim === 'harvest') {
            // overhead chop, weapon rides the same bone
            const s = Math.sin(t * 5.5 + phase);
            swing('armR', m3.rotationX(-0.55 - s * 0.75));
            swing('armL', m3.rotationX(-0.1 - s * 0.15));
        } else if (anim === 'attack') {
            // snappy slash: fast down-stroke, held wind-up
            const s = Math.sin(t * 7.5 + phase);
            swing('armR', m3.rotationX(-0.35 - Math.max(0, s) * 1.05));
            swing('armL', m3.rotationX(Math.min(0, s) * 0.2));
        } else { // idle: barely-there arm sway
            const s = Math.sin(t * 1.6 + phase);
            swing('armL', m3.rotationX(s * 0.06));
            swing('armR', m3.rotationX(-s * 0.06));
        }
        return { mats, bob };
    };

    EngineUnits.TYPES = Object.keys(builders);

    window.EngineUnits = EngineUnits;
})();
