// ============================================================================
// The spectator DIRECTOR.
//
// The job is a match recorded end to end that nobody has to steer and nobody
// switches off: never a dead frame, never a missed fight.
//
// What was here before returned {x, z, zoom} every frame and the renderer eased
// toward it. Two things followed from that one shape, and they were the whole
// problem. There was no yaw and no pitch, so the angle never changed in a match
// — it read as one unbroken shot from one fixed compass bearing. And because
// every frame nudged toward the newest point, every change of subject was a PAN:
// crossing the map meant seconds of empty grass at constant speed. Dead air, on
// purpose, between everything worth seeing.
//
// So this chooses SHOTS. A shot is a subject, a pose, a motion and a duration,
// and it is held. Between shots we CUT — instant, free, and read as intent —
// while movement happens only INSIDE a shot, where it means something: tracking
// a marching army, easing in on a construction site.
//
// Three rules the rest follows from:
//
//   Cut between scenes, move within them.
//   Compose with depth — put something worth seeing BEYOND the subject.
//   Let rhythm follow tension: 3.5s in a brawl, 10s establishing a camp.
//
// Yaw snaps to eight compass angles. Free rotation frames each shot better and
// costs the viewer their sense of which way the board faces, which is exactly
// what a four-camp comparison needs. Eight is enough for every shot here to look
// distinct and few enough that the map still has a north.
//
// CAMERA CONVENTION, measured rather than assumed (dimetricView):
//   eye = target + dist * (sin yaw, cos yaw)
// so the camera LOOKS along -(sin yaw, cos yaw). Everything below composes with
// one helper, yawAlong(dx, dz) = atan2(-dx, -dz): "put the camera behind this
// vector and look up it." Behind a marching army, past a tower at what it is
// shooting, over a worker camp at the enemy town on the horizon — one rule, and
// behind a scout walking into fog it has not lifted yet.
// ============================================================================

const DIR_YAW_STEP = Math.PI / 4;          // eight compass angles
const DIR_SETTLE_MS = 400;                 // held frame after a cut, before tracking
const DIR_MIN_SHOT_MS = 1500;              // no interrupt before this
const DIR_INTERRUPT_MARGIN = 35;           // how much better a rival shot must be
const DIR_OVERVIEW_EVERY = 75000;          // the "how is everyone doing" beat
const DIR_RECENT = 6;                      // shots remembered for anti-repeat
// How long before the camera will cut to another first-contact. An army walking past
// an enemy camp trips the detector once per rival entity it passes -- without this the
// shot list is a strobe of near-identical two-unit stares. One every twenty seconds is
// often enough to catch the meetings and rare enough that each one still reads as an
// event. Per PAIR of seats as well, so two rivals meeting repeatedly on one border do
// not crowd out a third pair meeting for the first time.
const DIR_CONTACT_COOLDOWN_MS = 20000;
const DIR_CONTACT_PAIR_COOLDOWN_MS = 45000;

// dur: [min, max] ms. pitch: elevation in radians (0.26 ~ 15deg, 0.6 ~ 34deg).
// track: the target follows the subject while the shot runs.
// push: fraction the frame tightens over the shot — life without motion sickness.
// pan: radians of yaw drift ACROSS the shot. Fights only, and deliberately.
//
// The economy half of a match wants what it already has: no panning, a slow tighten,
// a good fixed angle, the overview beat. It is slow play and the camera should be
// slow with it. A fight is the opposite and often lasts seconds -- so those shots cut
// fast, and each one arcs a few degrees while it runs, because a static frame of a
// melee is flat and six degrees of movement is what makes it read as depth. The cut
// still LANDS on a compass angle; the drift happens after, inside the shot.
const DIR_SHOTS = {
    selected:  { dur: [9000, 9000],   pitch: 0.42, track: true,  push: 0 },
    brawl:     { dur: [2200, 3400],   pitch: 0.44, track: true,  push: 0.06, pan: 0.11 },
    pov:       { dur: [4000, 6000],   pitch: 0.24, track: false, push: 0 },
    // Pitch is SCOUT's, not a lower one of its own. Nearly every contact is cut to
    // from the scout shot -- it is the same unit, one second later, having found
    // somebody -- and arriving at a different elevation made a continuation read as a
    // jump to somewhere else. Short duration still: a near miss IS short, and holding
    // it past the moment turns a discovery into two units standing about.
    contact:   { dur: [3000, 4200],   pitch: 0.28, track: true,  push: 0.05 },
    wonder:    { dur: [6000, 8000],   pitch: 0.34, track: false, push: 0.10 },
    follow:    { dur: [6000, 9000],   pitch: 0.36, track: true,  push: 0 },
    walk:      { dur: [5000, 7000],   pitch: 0.25, track: true,  push: 0 },
    scout:     { dur: [6000, 8000],   pitch: 0.28, track: true,  push: 0 },
    site:      { dur: [5000, 7000],   pitch: 0.40, track: false, push: 0.12 },
    economy:   { dur: [6000, 8000],   pitch: 0.46, track: false, push: 0.05 },
    establish: { dur: [7000, 10000],  pitch: 0.58, track: false, push: 0.05 },
    compare:   { dur: [4000, 5000],   pitch: 0.52, track: false, push: 0 },
    overview:  { dur: [7000, 9000],   pitch: 0.50, track: false, push: 0 }
};

class Director {
    constructor(game) {
        this.game = game;
        // TIMELAPSE. Every duration here is in CAPTURE seconds, and a video sped up
        // 8x in post is watched in SCREEN seconds -- so an eight-second shot becomes
        // a one-second flicker and a careful cut becomes a stutter. Nothing about the
        // pacing is wrong; it simply cannot know what happens to the footage later.
        //
        // ?lapse=8 says what happens to it. Every hold multiplies, so eight seconds
        // on screen means sixty-four seconds of capture, and the rhythm you tuned at
        // 1x is the rhythm that survives the edit. The interrupt margin doubles as
        // well: a thirty-second skirmish is a four-second glance after the speed-up,
        // and chopping a timelapse for it costs more than it shows.
        //
        // Settable live (game._director.lapse = 8) so a recording can change pace at
        // the half without a reload -- which is the whole point of an eight-minute
        // video whose first half is an economy and whose second half is a war.
        const m = /[?&]lapse=(\d+(?:\.\d+)?)/.exec(location.search);
        this.lapse = m ? Math.max(1, Math.min(32, parseFloat(m[1]))) : 1;
        this.shot = null;            // { type, key, score, until, pose, subject, born }
        this.recent = [];            // [key] of the last DIR_RECENT shots
        this.lastSeen = new Map();   // playerId -> when we last showed them
        this.lastOverview = 0;
        this.compareQueue = [];      // bases still to visit in a compare sweep
        this._prevAge = new Map();   // playerId -> age, for age-up detection
        this._prevHp = new Map();    // building -> health, for "under attack"
        this._sites = new Set();     // building ids already shown as sites
        this.debugRows = [];
        this._nextEval = 0;
    }

    reset() {
        this.shot = null;
        this.recent = [];
        this.compareQueue = [];
        this._shotNo = {};
    }

    // ---- geometry ----------------------------------------------------------
    // "Stand behind this vector and look up it." The one composition primitive.
    yawAlong(dx, dz) {
        return Math.atan2(-dx, -dz);
    }
    // Shortest signed distance between two angles. Comparing raw radians would call
    // 359 degrees and 1 degree a two-turn difference.
    angleGap(a, b) {
        let d = a - b;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        return d;
    }
    snapYaw(a) {
        const s = Math.round(a / DIR_YAW_STEP) * DIR_YAW_STEP;
        return ((s % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    }
    centroid(list) {
        if (!list || !list.length) return null;
        let x = 0, z = 0;
        for (const u of list) { x += u.x; z += u.z; }
        return { x: x / list.length, z: z / list.length };
    }
    spread(list, c) {
        let r = 0;
        for (const u of list) r = Math.max(r, Math.hypot(u.x - c.x, u.z - c.z));
        return r;
    }

    livePlayers() {
        const g = this.game;
        return (g.aiManager ? g.aiManager.aiPlayers : []).filter(a => !g.isPlayerEliminated(a));
    }

    // The most interesting thing that is NOT this subject, for the horizon. A shot
    // of workers is a shot of workers; the same shot with a rival's town beyond it
    // is the state of the match. Prefers an enemy town centre, then any enemy
    // building, and gives up rather than aiming at nothing in particular.
    horizonFor(owner, from) {
        let best = null, bestD = Infinity;
        for (const ai of this.livePlayers()) {
            if (ai === owner) continue;
            const tc = ai.buildings.find(b => b.type === 'town_center' && b.health > 0)
                || ai.buildings.find(b => b.health > 0);
            if (!tc) continue;
            const d = Math.hypot(tc.x - from.x, tc.z - from.z);
            // Not the nearest outright: something 60 units away is not "the distance".
            if (d > 90 && d < bestD) { bestD = d; best = tc; }
        }
        return best;
    }

    // Where a group is headed, from its own move orders rather than sampled
    // velocity — a marching army carries targetX/targetZ, and reading the order
    // is both cheaper and steadier than differencing positions across frames.
    heading(units) {
        let dx = 0, dz = 0, n = 0;
        for (const u of units) {
            if (u.targetX == null || u.targetZ == null) continue;
            const ax = u.targetX - u.x, az = u.targetZ - u.z;
            if (Math.hypot(ax, az) < 6) continue;      // arrived; not marching
            dx += ax; dz += az; n++;
        }
        if (!n) return null;
        const L = Math.hypot(dx, dz) || 1;
        return { x: dx / L, z: dz / L, marching: n };
    }

    // A lone unit a long way from home and still going: a scout.
    //
    // NOT task === 'scouting'. That flag is set only for WORKERS --
    //     scout.task = scout.type === 'worker' ? 'scouting' : null
    // because its job is keeping a worker out of the harvest rota, and a champion
    // needs no such excuse. So the flag misses every military scout, which is the
    // common case. Geometry catches both: alone, far from its own town, moving,
    // and not on an errand.
    //
    // Excluding the errands matters. A worker walking to a distant node or out to
    // build a house looks identical from a distance, and neither is exploration --
    // though a worker explicitly marked scouting stays eligible whatever else it
    // is carrying.
    scoutOf(ai) {
        const home = ai.buildings.find(b => b.type === 'town_center' && b.health > 0) || ai.buildings[0];
        if (!home) return null;
        let best = null, bestD = 110;          // nearer than this is just the suburbs
        for (const u of ai.units) {
            if (u.health <= 0 || !u.isMoving) continue;
            if (u.targetX == null || u.targetZ == null) continue;
            if (u.task !== 'scouting') {
                if (u.harvestTarget || u.isHarvesting || u.isBuilding) continue;
                if (u.task === 'harvesting' || u.task === 'carrying'
                    || u.task === 'building' || u.task === 'farm_work') continue;
            }
            // Alone means ALONE: zero company, not "no crowd". Two together going
            // somewhere is a raid and follow/walk owns it -- but each of a pair sees
            // exactly ONE companion, so a "more than one" test waves every pair
            // through calling itself a scout.
            let near = 0;
            for (const o of ai.units) {
                if (o === u || o.health <= 0) continue;
                if (Math.hypot(o.x - u.x, o.z - u.z) < 30) { near++; break; }
            }
            if (near) continue;
            const d = Math.max(Math.hypot(u.x - home.x, u.z - home.z),
                               Math.hypot(u.targetX - home.x, u.targetZ - home.z));
            if (d > bestD) { bestD = d; best = u; }
        }
        return best;
    }

    // Combat events, grouped into separate FIGHTS.
    //
    // They used to be averaged into a single centroid, which is only correct when
    // there is one battle. With two, the mean lands between them -- usually on empty
    // ground -- and because a brawl shot TRACKS its subject, every event arriving
    // from one side dragged the frame that way and the next event dragged it back.
    // That is the yo-yo: not the director changing its mind, but one shot aimed at
    // the midpoint of two things happening 300 units apart.
    //
    // Single-link clustering at 95 units: close enough that one melee stays one
    // fight, far enough apart that a raid on a base is not merged with a skirmish
    // across the valley.
    fights(now) {
        const ev = (this.game._combatEvents || []).filter(e => now - e.t < 6000);
        const out = [];
        for (const e of ev) {
            const w = 1 - (now - e.t) / 6000;
            let f = null;
            for (const c of out) { if (Math.hypot(c.x - e.x, c.z - e.z) <= 95) { f = c; break; } }
            if (!f) { out.push({ x: e.x, z: e.z, sx: e.x * w, sz: e.z * w, w, n: 1, r: 0 }); continue; }
            f.n++; f.w += w; f.sx += e.x * w; f.sz += e.z * w;
            f.x = f.sx / f.w; f.z = f.sz / f.w;
            f.r = Math.max(f.r, Math.hypot(e.x - f.x, e.z - f.z));
        }
        return out;
    }

    // WHAT is being hit, not just whether something is. A Wonder under attack is the
    // match being decided; a town centre is a player being ended; a hut is a hut. They
    // all scored the same, so a skirmish with more swings in it could outrank the
    // assault that settled the game.
    siegeAt(f) {
        let best = null, w = 0;
        for (const [b, hp] of this._prevHp) {
            if (!b || b.health == null || b.health >= hp) continue;
            if (Math.hypot(b.x - f.x, b.z - f.z) > f.r + 70) continue;
            const v = b.isWonder ? 55 : (b.type === 'town_center' ? 40 : 22);
            if (v > w) { w = v; best = b; }
        }
        // Remembered for six seconds, because _prevHp only shows a DROP -- it compares
        // against the last look, so a building is "under attack" in the instant a blow
        // lands and not in the gaps between them. Read literally, an assault flickers
        // on and off several times a second, and the framing rule that keeps the
        // besieged building out of the way flickers with it: the camera would swing
        // right around the back the moment nobody happened to be swinging.
        const memo = (this._siege = this._siege || new Map());
        const key = Math.round(f.x / 70) + ':' + Math.round(f.z / 70);
        const now = Date.now();
        if (best) { memo.set(key, { b: best, w, until: now + 6000 }); return { b: best, w }; }
        const held = memo.get(key);
        if (held && held.until > now && held.b && held.b.health > 0) return { b: held.b, w: held.w };
        if (held) memo.delete(key);
        return { b: null, w: 0 };
    }

    // How built-up the ground is. A fight among buildings is a fight FOR something and
    // reads as one on screen -- rooftops, walls, a town to lose -- where the same
    // number of swings in open grass is two crowds bumping into each other.
    townAt(f) {
        let n = 0;
        for (const ai of this.livePlayers()) {
            for (const b of ai.buildings) {
                if (b.health > 0 && Math.hypot(b.x - f.x, b.z - f.z) <= 70) n++;
            }
        }
        return n;
    }

    // ---- candidates --------------------------------------------------------
    candidates(now) {
        const g = this.game, out = [];
        const push = (type, key, score, make) => out.push({ type, key, score, make });

        // A fight is the show -- and each fight is its OWN candidate, so two at once
        // compete for the camera instead of averaging into the empty ground between
        // them. Keyed by where it is happening, coarsely, so the same battle keeps its
        // identity across shots while a different one is a different subject.
        for (const f of this.fights(now)) {
            const key = 'fight:' + Math.round(f.x / 70) + ':' + Math.round(f.z / 70);
            const siege = this.siegeAt(f);
            const town = this.townAt(f);
            push('brawl', key,
                 100 + Math.min(45, f.n * 3) + siege.w + Math.min(18, town * 3), () => {
                // A MONOTONIC count per fight, not a count of the last six shots. The
                // window saturates during a long battle -- every slot already holds this
                // key, so the number stopped changing and the "new" shot came back on
                // the SAME angle. All that moved was the six degrees of pan snapping
                // back to its start, which is not a cut and not a hold: it is a stutter.
                // Counting the fight's own shots means every return is a real angle.
                this._shotNo = this._shotNo || {};
                const nth = (this._shotNo[key] = (this._shotNo[key] || 0) + 1);
                // Where to stand. With a building under attack the answer is not "any
                // of four sides": stand OPPOSITE it, so the thing being fought over sits
                // BEYOND the melee rather than between the camera and it. A town centre
                // is tall and wide and will happily fill the frame with roof while the
                // fight happens behind it. Vary within a quarter-turn of that so the
                // coverage still changes without ever swinging around the back.
                const facing = siege.b
                    ? this.yawAlong(siege.b.x - f.x, siege.b.z - f.z)
                    : Math.PI / 4;
                const vary = siege.b ? ((nth % 3) - 1) * (Math.PI / 4) : (nth % 4) * (Math.PI / 2);
                return {
                    x: f.x, z: f.z,
                    yaw: this.snapYaw(facing + vary),
                    halfH: Math.max(24, Math.min(90, f.r * 1.5 + 18)),
                    subject: { kind: 'point', x: f.x, z: f.z, combat: true, key }
                };
            });
        }

        for (const ai of this.livePlayers()) {
            const bs = ai.buildings.filter(b => b.health > 0);
            const mil = ai.units.filter(u => u.health > 0 && u.type !== 'worker');
            const wrk = ai.units.filter(u => u.health > 0 && u.type === 'worker');

            // Something of theirs is being hit: show it from ITS side, looking out at
            // what is doing the hitting. The most dramatic shot in the game and the
            // cheapest to compose.
            for (const b of bs) {
                const prev = this._prevHp.get(b);
                this._prevHp.set(b, b.health);
                if (prev == null || b.health >= prev) continue;
                const threat = this.nearestEnemyTo(ai, b);
                if (!threat) continue;
                push('pov', 'pov:' + (b.id || b.type) , 92 + (b.isWonder ? 12 : 0), () => {
                    const dx = threat.x - b.x, dz = threat.z - b.z;
                    const L = Math.hypot(dx, dz) || 1;
                    return {
                        // Sit the building in the near frame and look past it.
                        x: b.x + (dx / L) * 14, z: b.z + (dz / L) * 14,
                        yaw: this.snapYaw(this.yawAlong(dx, dz)),
                        halfH: Math.max(26, Math.min(70, L * 0.9 + 20)),
                        subject: { kind: 'ent', ent: b }
                    };
                });
            }

            // A Wonder is a countdown everyone can see. Worth its own beat.
            const wonder = bs.find(b => b.isWonder);
            if (wonder) {
                push('wonder', 'wonder:' + ai.id, 78, () => {
                    const h = this.horizonFor(ai, wonder);
                    return {
                        x: wonder.x, z: wonder.z,
                        yaw: this.snapYaw(h ? this.yawAlong(h.x - wonder.x, h.z - wonder.z) : 0),
                        halfH: 48, subject: { kind: 'ent', ent: wonder }
                    };
                });
            }

            // An army crossing the map. Two ways to shoot it, alternating: a wide
            // frame that holds the army AND where it is going, and a low one just
            // behind them, which is what walking with them looks like.
            const cluster = g._biggestArmyCluster ? g._biggestArmyCluster(ai) : null;
            if (cluster && cluster.length >= 2) {
                const head = this.heading(cluster);
                if (head && head.marching >= 2) {
                    const c = this.centroid(cluster);
                    const wide = this.recent.filter(k => k.startsWith('march:' + ai.id)).length % 2 === 0;
                    push(wide ? 'follow' : 'walk', 'march:' + ai.id, 58 + Math.min(20, cluster.length * 2), () => ({
                        x: c.x, z: c.z,
                        yaw: this.snapYaw(this.yawAlong(head.x, head.z)),
                        halfH: wide ? Math.max(40, this.spread(cluster, c) * 1.6 + 30) : 20,
                        subject: { kind: 'units', units: cluster }
                    }));
                }
            }

            // Exploration is most of what a model does early and none of it was
            // ever on camera: one unit, walking into the dark, which is the shot the
            // whole "walk along behind them" idea was about. Framed from behind and
            // looking up its heading, so the screen shows what it is about to find
            // rather than where it has been.
            const scout = this.scoutOf(ai);
            if (scout) {
                push('scout', 'scout:' + ai.id, 64, () => {
                    const dx = scout.targetX - scout.x, dz = scout.targetZ - scout.z;
                    const far = Math.hypot(dx, dz) > 6;
                    return {
                        x: scout.x, z: scout.z,
                        yaw: this.snapYaw(far ? this.yawAlong(dx, dz) : 0),
                        halfH: 26, subject: { kind: 'units', units: [scout] }
                    };
                });
            }

            // Something new going up, shown once, with a slow push in.
            const site = [...bs].reverse().find(b => b.underConstruction && !this._sites.has(b.id || b));
            if (site) {
                push('site', 'site:' + (site.id || bs.length), 48, () => {
                    this._sites.add(site.id || site);
                    const h = this.horizonFor(ai, site);
                    return {
                        x: site.x, z: site.z,
                        yaw: this.snapYaw(h ? this.yawAlong(h.x - site.x, h.z - site.z) : Math.PI / 4),
                        halfH: 34, subject: { kind: 'ent', ent: site }
                    };
                });
            }

            // The economy, which is most of what an RTS actually is: a real crowd of
            // gatherers, with a rival's town on the horizon so the shot says who is
            // ahead rather than just "here are some workers".
            if (wrk.length >= 4) {
                const c = this.centroid(wrk);
                push('economy', 'eco:' + ai.id, 32 + Math.min(14, wrk.length), () => {
                    const h = this.horizonFor(ai, c);
                    return {
                        x: c.x, z: c.z,
                        yaw: this.snapYaw(h ? this.yawAlong(h.x - c.x, h.z - c.z) : 0),
                        halfH: Math.max(34, Math.min(80, this.spread(wrk, c) * 1.3 + 26)),
                        subject: { kind: 'units', units: wrk }
                    };
                });
            }

            // The fallback, and the old behaviour: their town. Still worth showing,
            // just no longer the only thing on the menu.
            const tc = bs.find(b => b.type === 'town_center') || bs[0];
            if (tc) {
                push('establish', 'base:' + ai.id, 26, () => {
                    const h = this.horizonFor(ai, tc);
                    return {
                        x: tc.x, z: tc.z,
                        yaw: this.snapYaw(h ? this.yawAlong(h.x - tc.x, h.z - tc.z) : Math.PI / 4),
                        halfH: 62, subject: { kind: 'ent', ent: tc }
                    };
                });
            }

            // An age-up is a fact worth comparing everyone on, so it starts a sweep.
            const age = this._prevAge.get(ai.id);
            this._prevAge.set(ai.id, ai.age);
            if (age && age !== ai.age) this.compareQueue = this.livePlayers().slice();
        }

        // Two seats walking into each other. Not a fight -- a fight is already the
        // highest-scoring thing here -- but the moment BEFORE one, which is otherwise
        // invisible: a scout cresting onto somebody's border, two armies finding each
        // other in open ground. game.detectContacts() maintains this feed for the
        // CONTACT lines the models read; the camera is its second reader, and it asks a
        // slightly different question -- near misses count, whether or not anybody
        // actually looked.
        //
        // Scored to lose to a brawl and beat everything else, which is the rule asp67
        // set: battle footage overrides, nothing else does.
        // Only what is still true. A viewer's entries stand until that viewer is
        // scanned again -- about a second at four seats, longer at more -- so without an
        // age check the camera can cut to a meeting that finished while it waited its
        // turn in the round-robin.
        const feed = (g._contactFeed || []).filter(c =>
            c && c.mine && c.target && (now - (c.at || 0)) < 3000);
        if (feed.length && now - (this._lastContactShot || 0) > DIR_CONTACT_COOLDOWN_MS * this.lapse) {
            this._contactPairAt = this._contactPairAt || {};
            for (const c of feed) {
                const pair = [c.viewer.id, c.other.id].sort().join('~');
                if (now - (this._contactPairAt[pair] || 0) < DIR_CONTACT_PAIR_COOLDOWN_MS * this.lapse) continue;
                const mine = c.mine, them = c.target;
                if (mine.health <= 0 || them.health <= 0) continue;
                push('contact', 'contact:' + pair, 90, () => {
                    this._lastContactShot = now;
                    this._contactPairAt[pair] = now;
                    const dx = them.x - mine.x, dz = them.z - mine.z;
                    const L = Math.hypot(dx, dz) || 1;
                    return {
                        // Framed on OUR unit and looking up the gap, so the rival comes
                        // into the shot as it closes rather than the pair being framed
                        // as equals from a distance that fits them both.
                        //
                        // This used to sit a third of the way along the gap and open the
                        // frame wide enough to hold both -- up to halfH 80 against the
                        // scout shot's 26, so the cut FROM a scout was a three-fold pull
                        // back at the exact moment the interesting thing had just been
                        // found. Nudged toward the rival rather than centred on it, and
                        // held near the scout's own framing.
                        // Opened BETWEEN them, not on our unit: at a hundred units of
                        // gap a frame centred on the scout leaves the thing it just
                        // found off the top of the screen, and a shot about a meeting
                        // with one party missing is a shot of somebody staring at grass.
                        // The shot TRACKS our unit, so it eases onto the scout over the
                        // next second anyway while the rival closes -- the midpoint is
                        // where it starts, not where it stays.
                        x: mine.x + dx * 0.5,
                        z: mine.z + dz * 0.5,
                        yaw: this.snapYaw(this.yawAlong(dx, dz)),
                        // 26 is the scout shot's exact value; this opens a little with
                        // the gap and stops well short of where it was.
                        halfH: Math.max(26, Math.min(42, 24 + L * 0.22)),
                        subject: { kind: 'ent', ent: mine }
                    };
                });
                break;   // one contact shot offered at a time, the closest
            }
        }

        // The comparison beats: a sweep of every camp at an IDENTICAL pose, and a
        // periodic pull back to the whole island. Both exist for the same reason —
        // four economies are only legible against each other.
        if (this.compareQueue.length) {
            const ai = this.compareQueue[0];
            const tc = ai.buildings.find(b => b.type === 'town_center' && b.health > 0);
            if (tc) {
                push('compare', 'cmp:' + ai.id, 84, () => {
                    this.compareQueue.shift();
                    return { x: tc.x, z: tc.z, yaw: 0, halfH: 90, subject: { kind: 'ent', ent: tc } };
                });
            } else this.compareQueue.shift();
        }
        if (now - this.lastOverview > DIR_OVERVIEW_EVERY * this.lapse) {
            push('overview', 'overview', 88, () => {
                this.lastOverview = now;
                const size = (g.terrain && g.terrain.size) || 800;
                return { x: 0, z: 0, yaw: 0, halfH: size * 0.62, subject: { kind: 'point', x: 0, z: 0 } };
            });
        }
        return out;
    }

    nearestEnemyTo(owner, b) {
        let best = null, bestD = 260;
        for (const ai of this.livePlayers()) {
            if (ai === owner) continue;
            for (const u of ai.units) {
                if (u.health <= 0) continue;
                const d = Math.hypot(u.x - b.x, u.z - b.z);
                if (d < bestD) { bestD = d; best = u; }
            }
        }
        return best;
    }

    // ---- scoring -----------------------------------------------------------
    // Novelty and fairness are the difference between a director and a loop. The
    // old tour rotated strictly, which is fair and predictable in the boring way;
    // this pays for airtime nobody has had lately and charges for repeats.
    adjust(c, now) {
        let s = c.score;
        const repeats = this.recent.filter(k => k === c.key).length;
        // A battle that is STILL GOING is not a repeat, it is a continuation. The flat
        // penalty took a live siege from 100 to 22 after three shots and handed the
        // camera to the whole-map overview at 88 -- the least useful thing on screen
        // while a town is being taken. Live action decays, but only so far; it stops
        // being a candidate at all when the fighting stops, which is the honest way
        // for it to end.
        const live = c.type === 'brawl' || c.type === 'pov';
        s -= live ? Math.min(24, repeats * 8) : repeats * 26;
        const owner = c.key.split(':')[1];
        if (owner) {
            const seen = this.lastSeen.get(owner) || 0;
            s += Math.min(22, (now - seen) / 4000);
        }
        return s;
    }

    // ---- the loop ----------------------------------------------------------
    update(now) {
        const g = this.game;

        // The spectator picked something: that outranks every opinion here.
        if (g._camFollow) {
            const pos = g._resolveCamSubject(g._camFollow);
            if (pos) {
                if (!this.shot || this.shot.type !== 'selected') {
                    this.shot = this.begin('selected', 'selected', 999, {
                        x: pos.x, z: pos.z, yaw: this.snapYaw(g.renderer._yaw),
                        halfH: g._subjectZoom(g._camFollow), subject: g._camFollow
                    }, now);
                }
            } else g._camFollow = null;
        }

        const expired = !this.shot || now >= this.shot.until;
        if (expired || now >= this._nextEval) {
            this._nextEval = now + 500;
            const cands = this.candidates(now)
                .map(c => ({ ...c, adj: this.adjust(c, now) }))
                .sort((a, b) => b.adj - a.adj);
            this.debugRows = cands.slice(0, 6);
            const top = cands[0];
            if (top) {
                const age = this.shot ? now - this.shot.born : Infinity;
                const margin = DIR_INTERRUPT_MARGIN * (this.lapse > 1 ? 2 : 1);
                const better = !this.shot
                    || expired
                    || (age > DIR_MIN_SHOT_MS * this.lapse && top.adj > this.shot.score + margin);
                if (better && (!this.shot || this.shot.type !== 'selected' || expired)) {
                    const pose = top.make();
                    if (pose) this.shot = this.begin(top.type, top.key, top.adj, pose, now);
                }
            }
        }
        if (!this.shot) return null;

        const spec = DIR_SHOTS[this.shot.type] || DIR_SHOTS.establish;
        const held = now - this.shot.born;

        // Track the subject — but only after the frame has been held long enough to
        // read. Moving the instant we cut is how a cut turns into a lurch.
        if (spec.track && held > DIR_SETTLE_MS * this.lapse) {
            const p = this.shot.subject ? g._resolveCamSubject(this.shot.subject) : null;
            if (p) { this.shot.pose.x = p.x; this.shot.pose.z = p.z; }
            else if (this.shot.subject && this.shot.subject.combat) {
                // Follow the NEAREST fight, not the mean of every fight on the map.
                // Tracking the global centroid is what made a two-battle map swing the
                // camera between them for the whole shot.
                let best = null, bd = 140;
                for (const f of this.fights(now)) {
                    const d = Math.hypot(f.x - this.shot.pose.x, f.z - this.shot.pose.z);
                    if (d < bd) { bd = d; best = f; }
                }
                if (best) { this.shot.pose.x = best.x; this.shot.pose.z = best.z; }
            }
        }
        // The arc. Only shots that declare a pan get one, so the economy half stays
        // still. Direction alternates per shot, or a run of cuts around one fight would
        // all sweep the same way and read as one long drift instead of several angles.
        if (spec.pan && held > DIR_SETTLE_MS * this.lapse) {
            const k2 = Math.min(1, (held - DIR_SETTLE_MS * this.lapse) / (2000 * this.lapse));
            this.shot.pose.yaw = this.shot.pose.yaw0 + this.shot.panDir * spec.pan * k2;
        }
        // A slow tighten over the shot. Small on purpose: enough that the frame is
        // alive, not enough to notice as movement.
        const k = spec.push ? (1 - spec.push * Math.min(1, held / (this.shot.until - this.shot.born))) : 1;

        const cut = !this.shot.cutDone;
        this.shot.cutDone = true;
        return {
            x: this.shot.pose.x, z: this.shot.pose.z,
            yaw: this.shot.pose.yaw, pitch: spec.pitch,
            halfH: this.shot.pose.halfH * k,
            cut
        };
    }

    begin(type, key, score, pose, now) {
        const spec = DIR_SHOTS[type] || DIR_SHOTS.establish;
        const dur = (spec.dur[0] + Math.random() * (spec.dur[1] - spec.dur[0])) * this.lapse;
        this.recent.push(key);
        if (this.recent.length > DIR_RECENT) this.recent.shift();
        const owner = key.split(':')[1];
        if (owner) this.lastSeen.set(owner, now);

        // Which way the arc goes. It used to alternate every shot, which is right when
        // every shot is a new angle and wrong the moment two land on the same one: the
        // camera then drifts left, snaps back, drifts right, snaps back -- a see-saw
        // built out of two shots that should have been one. So the direction turns
        // around only when the SCENE does, and a shot that lands on the same angle and
        // the same place as the one before it is not a new scene at all: it carries the
        // drift forward from where it got to, and does not cut.
        const prev = this.shot;
        const same = prev && prev.key === key
            && Math.abs(this.angleGap(pose.yaw, prev.pose.yaw0)) < 0.02
            && Math.hypot(pose.x - prev.pose.x, pose.z - prev.pose.z) < 30;
        pose.yaw0 = same ? prev.pose.yaw : pose.yaw;   // no snap-back on a continuation
        if (same) pose.yaw = prev.pose.yaw;
        return { type, key, score, pose, subject: pose.subject, born: now,
                 until: now + dur, cutDone: !!same,
                 panDir: prev ? (same ? prev.panDir : -prev.panDir) : 1 };
    }

    // ---- ?dir=1 ------------------------------------------------------------
    // Tuning a director blind is guesswork: every shot looks defensible on its own
    // and only the ranking explains why the boring one won. This shows the ranking.
    renderDebug(now) {
        let el = document.getElementById('dirDebug');
        if (!el) {
            el = document.createElement('div');
            el.id = 'dirDebug';
            el.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:9998;padding:8px 10px;'
                + 'background:rgba(11,16,23,0.92);color:#cfe;border:1px solid #4ecca3;border-radius:7px;'
                + 'font:11px/1.5 ui-monospace,Menlo,Consolas,monospace;white-space:pre;pointer-events:none';
            document.body.appendChild(el);
        }
        const s = this.shot;
        const left = s ? Math.max(0, Math.round((s.until - now) / 100) / 10) : 0;
        el.textContent = 'SHOT  ' + (s ? s.type + '  ' + s.key + '  ' + left + 's left' : '(none)')
            + (this.lapse > 1 ? '   [lapse ' + this.lapse + 'x -> ' + (Math.round(left / this.lapse * 10) / 10)
                                + 's on screen]' : '') + '\n'
            + (s ? 'pose  yaw ' + Math.round((s.pose.yaw * 180 / Math.PI)) + '°  halfH '
                 + Math.round(s.pose.halfH) + '\n' : '')
            + this.debugRows.map(c => '  ' + String(Math.round(c.adj)).padStart(4) + '  ' + c.type + '  ' + c.key).join('\n');
    }
}
