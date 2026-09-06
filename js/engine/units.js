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
        badgeParts(shape, { y, z, r, lenFill, lenRim }).forEach(e => p.push(e));
    };

    const oval = (p, tex, x, y, z, sx, sy, sz, extra = {}) =>
        part(p,'sphere',Math.max(sx,sy,sz)<.11?[1,8,5]:[1,12,8],tex,{x,y,z,sx,sy,sz,...extra});

    // Large, readable faces in the miniature-soldier style. +Z is forward.
    const face = (p,x,y,z,s=1,beard=false) => {
        oval(p,'skin',x,y,z,.225*s,.235*s,.20*s);
        oval(p,'skin',x,y-.005*s,z+.196*s,.048*s,.057*s,.05*s);
        for(const side of [-1,1]) {
            oval(p,'bark',x+side*.079*s,y+.038*s,z+.185*s,.018*s,.024*s,.014*s);
            part(p,'box',[.067*s,.022*s,.02*s],'bark',
                {x:x+side*.078*s,y:y+.085*s,z:z+.182*s,rz:side*-.13});
        }
        if(beard) {
            oval(p,'leather',x,y-.15*s,z+.085*s,.177*s,.10*s,.13*s);
            oval(p,'skin',x,y-.075*s,z+.183*s,.08*s,.028*s,.028*s);
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
            } else if(kind==='priest') part(p,'cylinder',[S(.065),S(.15),S(.29),10],'bark',{x,y:y+S(.24),z});
            else part(p,'cylinder',[S(.025),S(.37),S(.18),16],'thatch',{x,y:y+S(.20),z});
        } else if(civ==='persian') {
            part(p,'cylinder',[S(.09),S(.23),S(.25),12],'cloth',{x,y:y+S(.24),z,team:true});
            oval(p,'cloth',x,y+S(.37),z,S(.10),S(.06),S(.10),{team:true});
        } else if(!military) {
            if(kind==='priest') dome('cloth',true);
            else part(p,'cylinder',[S(.025),S(.35),S(.17),12],'thatch',{x,y:y+S(.20),z});
        }
    };

    const cape = (p,y=1.25,z=-.22,s=1) => {
        // Flared cloth mantle; folds carry a silhouette from the rear view too.
        part(p,'frustum',[.64*s,.09*s,.40*s,.065*s,.72*s],'cloth',
            {y:y-.72*s,z:z-.13*s,rx:.12,team:true});
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
            oval(p,'leather',side*.13,.13,.055,.115,.115,.19,{bone});
            const arm=side<0?'armL':'armR';
            part(p,'cylinder',[.10,.085,.42,10],opts.sleeves||'leather',
                {x:side*.34,y:1.0,rz:side*.10,bone:arm});
            oval(p,'skin',side*.37,.77,.045,.09,.11,.095,{bone:arm});
        }
        part(p,'cylinder',[.24,.31,.65,12],'cloth',{y:.98,sz:.78,team:true});
        part(p,'cylinder',[.259,.267,.075,12],'leather',{y:.88,sz:.8});
        part(p,'box',[.08,.065,.045],'gold',{y:.88,z:.22});
        face(p,0,1.49,0,1,opts.beard);
        badge(p,opts.badge,1.08,0,.087,.57,.54);
    };

    // The HORSE, rebuilt joint by joint (shared by every cavalry tier). All
    // numbers are solved so parts EMBED in their parent instead of floating:
    // leg tops sink into the body underside, the neck root sits inside the
    // chest sphere, the head overlaps the neck top, the tail roots inside the
    // rump. +Z is forward; positive rx leans a cylinder's +Y axis toward +Z.
    // Neck/head/ears/mane/muzzle share bone 'head' (walk nod); legs carry
    // their hooves on the same bone so they swing as one limb.
    const horse = (p, tier) => {
        shadow(p, 1.05);
        part(p, 'sphere', [1, 10, 7], 'leather', { y: 0.86, sx: 0.30, sy: 0.34, sz: 0.62 });            // barrel
        part(p, 'sphere', [1, 8, 6], 'leather', { y: 0.92, z: 0.48, sx: 0.26, sy: 0.30, sz: 0.30 });    // chest
        part(p, 'sphere', [1, 8, 6], 'leather', { y: 0.90, z: -0.44, sx: 0.27, sy: 0.31, sz: 0.34 });   // rump
        const leg = (x, z, bone) => {
            part(p, 'cylinder', [0.045, 0.06, 0.62, 5], 'leather', { x, y: 0.36, z, bone });            // top embeds at y 0.67
            part(p, 'cylinder', [0.065, 0.07, 0.09, 5], 'bark', { x, y: 0.075, z, bone });              // hoof
        };
        leg(-0.16, 0.46, 'legFL'); leg(0.16, 0.46, 'legFR');
        leg(-0.16, -0.46, 'legBL'); leg(0.16, -0.46, 'legBR');
        part(p, 'cylinder', [0.085, 0.14, 0.5, 6], 'leather', { y: 1.18, z: 0.62, rx: 0.6, bone: 'head' });   // neck: root (0,0.97,0.48) in chest, top (0,1.39,0.76)
        oval(p,'leather',0,1.43,.86,.11,.12,.21,{rx:.25,bone:'head'});           // head, overlaps neck top
        oval(p,'leather',0,1.38,1.02,.09,.085,.13,{rx:.25,bone:'head'});
        for(const side of [-1,1]) oval(p,'bark',side*.095,1.47,.91,.013,.018,.023,{bone:'head'});          // muzzle
        part(p, 'cylinder', [0, 0.028, 0.09, 4], 'bark', { x: -0.05, y: 1.56, z: 0.80, bone: 'head' });       // ears
        part(p, 'cylinder', [0, 0.028, 0.09, 4], 'bark', { x: 0.05, y: 1.56, z: 0.80, bone: 'head' });
        part(p, 'box', [0.045, 0.44, 0.10], 'bark', { y: 1.25, z: 0.53, rx: 0.6, bone: 'head' });             // mane strip on the neck's back edge
        part(p, 'cylinder', [0.05, 0.02, 0.5, 4], 'bark', { y: 0.79, z: -0.85, rx: -2.6 });                   // tail: roots at (0,1.0,-0.72) inside the rump
        part(p, 'box', [0.4, 0.07, 0.46], 'cloth', { y: 1.16, z: 0.02, team: true });                          // saddle blanket
        if (tier >= 2) part(p, 'box', [0.22, 0.09, 0.28], 'leather', { y: 1.22 });                             // saddle seat
        if (tier >= 3) {
            // barding: chamfron on the face, chest plate, flank plates
            part(p, 'box', [0.13, 0.05, 0.26], 'iron', { y: 1.52, z: 0.88, rx: 0.25, bone: 'head' });
            part(p, 'box', [0.34, 0.3, 0.08], 'iron', { y: 0.98, z: 0.74, rx: 0.25 });
            part(p, 'box', [0.06, 0.26, 0.6], 'iron', { x: -0.29, y: 0.94 });
            part(p, 'box', [0.06, 0.26, 0.6], 'iron', { x: 0.29, y: 0.94 });
        }
    };

    // How much war a unit wears: 1 = levy/light, 2 = the line trooper,
    // 3 = elite. Derived from the specific unit id (see TIER below) so
    // militia / warrior / champion stop sharing one body.
    const builders = {
        worker: (o = {}) => {
            const p = [];
            humanoid(p, { badge: o.badge });
            headgear(p, o.civ, 'civil', 0, 1.5, 0);
            part(p, 'cylinder', [0.028, 0.028, 0.55, 4], 'bark', { x: 0.37, y: 0.86, z: 0.08, bone: 'armR' });
            part(p, 'box', [0.06, 0.18, 0.26], 'iron', { x: 0.37, y: 1.1, z: 0.18, bone: 'armR' }); // axe head
            return p;
        },
        infantry: (o = {}) => {
            const tier=o.tier||2, p=[];
            humanoid(p,{badge:o.badge,beard:o.civ==='persian'});
            headgear(p,o.civ,tier===1?'civil':'military',0,1.49,0);
            if(tier===1) {
                part(p,'cylinder',[.075,.045,.65,9],'wood',{x:.37,y:1.00,z:.14,rx:.35,bone:'armR'});
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
                part(p,'cylinder',[.036,.036,.20,8],'leather',{x:.37,y:.83,z:.16,bone:'armR'});
                part(p,'box',[.26,.055,.075],'iron',{x:.37,y:.95,z:.16,bone:'armR'});
                // Diamond-section blade catches both sides of the light.
                part(p,'cylinder',[0,.075,.69,4],'iron',{x:.37,y:1.32,z:.16,sy:1,sz:.34,bone:'armR'});
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
            humanoid(p, { sleeves: 'leather', badge: o.badge });
            if(tier>=2) shoulders(p,'leather');
            if (tier >= 2) headgear(p, o.civ, 'military', 0, 1.47, 0);
            else if (o.civ) headgear(p, o.civ, 'civil', 0, 1.5, 0);
            else part(p, 'sphere', [1, 8, 6], 'leather', { y: 1.53, sx: 0.18, sy: 0.11, sz: 0.18 }); // generic cap
            if (tier === 2) {
                // crossbow held level: stock, iron lath across it, stirrup nose —
                // a horizontal weapon reads instantly against the archer's tall stave
                part(p, 'box', [0.05, 0.06, 0.6], 'wood', { x: 0.36, y: 1.05, z: 0.3, bone: 'armR' });
                part(p, 'cylinder', [0.022, 0.022, 0.5, 4], 'iron', { x: 0.36, y: 1.07, z: 0.52, rz: Math.PI / 2, bone: 'armR' });
                part(p, 'box', [0.05, 0.1, 0.05], 'iron', { x: 0.36, y: 1.0, z: 0.56, bone: 'armR' });
            } else {
                part(p, 'cylinder', [0.026, 0.026, tier >= 3 ? 1.3 : 1.15, 4], 'wood', { x: -0.37, y: 0.95, z: 0.14, rz: 0.14, bone: 'armL' }); // bow stave
                if (tier >= 3) part(p, 'cylinder', [0.032, 0.032, 0.36, 4], 'gold', { x: -0.37, y: 0.95, z: 0.14, rz: 0.14, bone: 'armL' }); // gilt grip
            }
            part(p, 'cylinder', [0.07, 0.09, 0.5, 5], 'bark', { x: 0.1, y: 1.12, z: -0.28, rz: 0.5 }); // quiver
            if (tier >= 3) cape(p);
            return p;
        },
        priest: (o = {}) => {
            const p=[];
            humanoid(p,{badge:o.badge,sleeves:'cloth',beard:true});
            part(p,'cylinder',[.235,.37,.83,14],'cloth',{y:.51,sz:.85});
            part(p,'frustum',[.18,.035,.15,.035,.85],'cloth',{y:.12,z:.27,team:true});
            cape(p,1.25,-.23,1.12);
            headgear(p,o.civ,'priest',0,1.49,0);
            part(p,'cylinder',[.035,.035,1.42,10],'wood',{x:.37,y:.83,z:.10,bone:'armR'});
            oval(p,'gold',.37,1.59,.10,.10,.13,.10,{bone:'armR'});
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
                face(p,0,1.41,-1.18,.75);
                headgear(p, o.civ, 'military', 0, 1.44, -1.18, 0.75);                                          // helmet
                part(p, 'cylinder', [0.045, 0.055, 0.36, 4], 'skin', { x: 0.18, y: 1.22, z: -1.02, rz: 0.2, rx: 0.3 });
                part(p, 'cylinder', [0.018, 0.018, 1.5, 4], 'wood', { x: 0.24, y: 1.32, z: -0.8, rx: 0.5 });   // spear
                part(p, 'cylinder', [0, 0.028, 0.12, 4], 'iron', { x: 0.24, y: 1.98, z: -0.44, rx: 0.5 });     // spear tip
                return p;
            }
            const tier = o.tier || 2;
            const p = [];
            horse(p, tier);
            // rider: torso seated over the blanket, legs hugging the barrel
            part(p, 'cylinder', [0.16, 0.2, 0.46, 6], 'cloth', { y: 1.47, team: true });
            badge(p, o.badge, 1.52, 0, 0.07, 0.48, 0.45); // rider chest — torso r≈0.18 here
            part(p, 'cylinder', [0.05, 0.06, 0.4, 4], 'leather', { x: -0.28, y: 1.18, z: 0.05, rz: -0.35 });
            part(p, 'cylinder', [0.05, 0.06, 0.4, 4], 'leather', { x: 0.28, y: 1.18, z: 0.05, rz: 0.35 });
            face(p,0,1.85,0,.8);
            if(tier>=2) {
                oval(p,'iron',0,1.59,0,.20,.12,.18);
                cape(p,1.68,-.16,.7);
                oval(p,'iron',-.24,1.66,0,.12,.09,.15);
                oval(p,'iron',.24,1.66,0,.12,.09,.15,{bone:'armR'});
            }
            headgear(p, o.civ, tier === 1 ? 'civil' : 'military', 0, 1.88, 0, 0.8);
            part(p, 'cylinder', [0.05, 0.06, 0.4, 4], tier >= 3 ? 'leather' : 'skin', { x: 0.24, y: 1.55, z: 0.04, rz: 0.15, bone: 'armR' });
            if (tier === 1) {
                // scout: a short javelin, bareback but for the blanket
                part(p, 'cylinder', [0.016, 0.016, 1.1, 4], 'wood', { x: 0.3, y: 1.52, z: 0.2, rx: 0.4, bone: 'armR' });
            } else if (tier === 2) {
                part(p, 'cylinder', [0.02, 0.02, 1.6, 4], 'wood', { x: 0.32, y: 1.55, z: 0.2, rx: 0.4, bone: 'armR' }); // spear
            } else {
                // heavy: a true lance with an iron tip and a team pennant
                part(p, 'cylinder', [0.028, 0.028, 1.9, 4], 'wood', { x: 0.32, y: 1.55, z: 0.2, rx: 0.4, bone: 'armR' });
                part(p, 'cylinder', [0, 0.03, 0.14, 4], 'iron', { x: 0.32, y: 2.29, z: 0.61, rx: 0.4, bone: 'armR' });
                part(p, 'box', [0.05, 0.16, 0.22], 'cloth', { x: 0.32, y: 2.2, z: 0.62, team: true, bone: 'armR' });
            }
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
            legFL: [-0.16, 0.67, 0.46], legFR: [0.16, 0.67, 0.46],
            legBL: [-0.16, 0.67, -0.46], legBR: [0.16, 0.67, -0.46],
            armR: [0.24, 1.72, 0.04],
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
        return b ? b(o) : [];
    };

    // Material/ownership/bone are all part of the batch key. Team and badge
    // colours stay per instance; cached geometry can be shared across seats.
    EngineUnits.batches = parts => {
        const groups=new Map();
        for(const p of parts) {
            const key=JSON.stringify([p.tex,p.team,p.accent,p.bone,p.blend]);
            if(!groups.has(key)) groups.set(key,{...p,parts:[]});
            groups.get(key).parts.push(p);
        }
        return [...groups.values()].map(group=>({...group,mesh:window.EngineMesh.mergeParts(group.parts)}));
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
                swing('legFL', m3.rotationX(s * 0.55)); swing('legBR', m3.rotationX(s * 0.55));
                swing('legFR', m3.rotationX(-s * 0.55)); swing('legBL', m3.rotationX(-s * 0.55));
                swing('head', m3.rotationX(Math.sin(t * 7 + phase + 1) * 0.07)); // the trot nod
                bob = Math.abs(s) * 0.06;
            } else if (anim === 'attack') {
                // couch the spear forward
                const s = Math.sin(t * 7.5 + phase);
                swing('armR', m3.rotationX(-0.3 - Math.max(0, s) * 0.5));
            } else { // idle: a slow grazing bow of the neck
                swing('head', m3.rotationX(Math.max(0, Math.sin(t * 0.9 + phase)) * 0.12));
            }
        } else if (anim === 'walk') {
            const s = Math.sin(t * 6.5 + phase);
            swing('legL', m3.rotationX(s * 0.55)); swing('legR', m3.rotationX(-s * 0.55));
            swing('armL', m3.rotationX(-s * 0.35)); swing('armR', m3.rotationX(s * 0.35));
            bob = Math.abs(Math.cos(t * 6.5 + phase)) * 0.04;
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
