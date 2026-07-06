// Rule-based AI for computer opponents.
//
// Design goals (rewrite):
//  - FAIR vs LLM players: the rule-based AI is fog-limited just like the models.
//    It only harvests resources it has DISCOVERED (vision), only attacks enemies
//    it can currently SEE (or remembered enemy buildings / always-visible wonders),
//    and must scout to find more. Age-ups and research run through the SAME timed
//    game systems the models/human use (no instant ages, no double-speed research).
//  - DEADLOCK-FREE: a single priority pass each think, every step gated by its own
//    affordability/availability check so nothing oscillates or spends into deficit.
//    Resources are never lost to a failed building placement (position is found
//    BEFORE spending). Workers never strand: they gather the most-needed known
//    resource, and a spare scout is sent out when something needed isn't discovered.
class AIManager {
    constructor(game) {
        this.game = game;
        this.aiPlayers = [];
        this.thinkTimer = 0;
        this.thinkInterval = 2000; // Run the decision pass every 2s.
        this.openAIControlled = new Set();
    }

    markAsOpenAIControlled(aiPlayerId) {
        this.openAIControlled.add(aiPlayerId);
    }

    addAIPlayer(civilization, difficulty = 'medium') {
        const resources = new ResourceManager();
        resources.food = 200;
        resources.wood = 200;
        resources.stone = 100;
        resources.gold = 50;
        const ai = {
            id: 'ai_' + Math.random().toString(36).substr(2, 9),
            civilization: civilization,
            difficulty: difficulty,
            resources: resources,
            units: [],
            buildings: [],
            age: 'stone',
            state: 'economic',
            stateTimer: 0,
            buildQueue: [],
            attackTarget: null,
            lastThink: Date.now(),
            workerHarvestBonus: 1.0,
            trainSpeedBonus: 1.0,
            techCostMultiplier: 1.0,
            buildingHealthMultiplier: 1.0,
            pendingBuildings: [],
            researchedTechs: {},
            unlockedBuildings: {},
            unlockedUnits: {},
            currentResearch: null,
            currentAgeUpgrade: null,
            _knownResIdx: new Set(),       // fog: resource node indices discovered
            _knownEnemyBuildings: new Set()// fog: enemy buildings discovered (static, remembered)
        };
        this.aiPlayers.push(ai);
        return ai;
    }

    update(deltaTime) {
        // Discovery is throttled to 4 Hz. Per-frame it was O(players × nodes × units)
        // hypot checks (~100k/sec on easy maps) for no benefit: the rule-based brain
        // only THINKS every 2s and the LLMs every 1.5s+, so a 250ms discovery
        // latency is invisible to every consumer while cutting the cost ~15×.
        this.discoveryTimer = (this.discoveryTimer || 0) + deltaTime;
        if (this.discoveryTimer >= 250) {
            this.discoveryTimer = 0;
            this.aiPlayers.forEach(ai => {
                // Exploration bitmap for EVERY player (LLM ones too — their own
                // discovery runs only when they take a turn, which would miss the
                // ground their units sweep while marching between turns).
                if (this.game.markExploration) this.game.markExploration(ai);
                if (this.openAIControlled.has(ai.id)) return;
                this.updateDiscovery(ai);
            });
        }

        this.thinkTimer += deltaTime;
        if (this.thinkTimer >= this.thinkInterval) {
            this.thinkTimer = 0;
            this.think();
        }
    }

    think() {
        this.aiPlayers.forEach(ai => {
            if (this.openAIControlled.has(ai.id)) return;
            this.runTurn(ai);
        });
    }

    // ---- Fog of war (same vision ranges the models/human use) -----------------
    isVisibleTo(ai, x, z) {
        for (const u of ai.units) {
            if (u.health <= 0) continue;
            const range = this.game.unitVision(u); // cavalry sees 50% farther
            if (Math.hypot(u.x - x, u.z - z) <= range) return true;
        }
        for (const b of ai.buildings) {
            if (b.health <= 0) continue;
            const range = b.type === 'tower' ? 20 : 12;
            if (Math.hypot(b.x - x, b.z - z) <= range) return true;
        }
        return false;
    }

    updateDiscovery(ai) {
        if (!ai._knownResIdx) ai._knownResIdx = new Set();
        if (!ai._knownEnemyBuildings) ai._knownEnemyBuildings = new Set();
        const res = (this.game.terrain && this.game.terrain.resources) || [];
        for (let i = 0; i < res.length; i++) {
            if (ai._knownResIdx.has(i)) continue;
            const r = res[i];
            if (this.isVisibleTo(ai, r.x, r.z)) ai._knownResIdx.add(i);
        }
        // Remember enemy buildings once seen (buildings are static).
        for (const other of this.enemyOwners(ai)) {
            for (const b of other.buildings) {
                if (b.health <= 0) { ai._knownEnemyBuildings.delete(b); continue; }
                if (!ai._knownEnemyBuildings.has(b) && this.isVisibleTo(ai, b.x, b.z)) {
                    ai._knownEnemyBuildings.add(b);
                }
            }
        }
    }

    enemyOwners(ai) {
        const owners = [];
        if (this.game.player) owners.push(this.game.player);
        this.aiPlayers.forEach(o => { if (o !== ai) owners.push(o); });
        return owners;
    }

    // ---- Per-turn priority brain ---------------------------------------------
    runTurn(ai) {
        const r = ai.resources;
        const workers = ai.units.filter(u => u.type === 'worker');
        // Support units (priests) are medics, not fighters — commandArmy must not
        // march them into battle (matters for demoted LLM players who own some).
        const military = ai.units.filter(u => u.type !== 'worker' && u.unitType !== 'support');
        const popFree = Math.max(0, r.maxPopulation - r.population);
        const enemyWonder = this.knownEnemyWonder(ai);

        // Keep the workforce productive: free finished scouts, put idle workers on
        // the most-needed resource, and break single-resource starvation deadlocks.
        this.manageWorkers(ai);

        // 1) POPULATION: don't choke. Build a house when nearly capped (and below
        //    the hard cap), so workers/military can keep being trained.
        if (popFree <= 2 && r.maxPopulation < MAX_POPULATION_CAP &&
            ai.buildings.filter(b => b.type === 'house').length < 6) {
            this.buildStructure(ai, 'house');
        }

        // 2) ECONOMY: grow the worker base toward a target while there is pop room.
        if (workers.length < 14 && popFree > 0) {
            const tc = ai.buildings.find(b => b.type === 'town_center' && !b.underConstruction && !b.isProducing);
            if (tc) this.trainUnit(ai, 'worker', tc);
        }

        // 3) FOOD SECURITY: a couple of farms once the base is going, so food never
        //    dries up (farms regenerate and their builder becomes the farmer).
        if (workers.length >= 5 && ai.buildings.filter(b => b.type === 'farm').length < 4) {
            this.buildStructure(ai, 'farm');
        }

        // 4) RESEARCH: start one affordable tech (the GAME advances + completes it).
        this.maybeStartResearch(ai);

        // 5) ADVANCE AGE: when affordable and the economy can support it (the GAME
        //    runs the timed upgrade — no instant ages).
        this.maybeAdvanceAge(ai, workers.length);

        // 6) MILITARY BUILDINGS: a barracks first; stable/archery once unlocked.
        this.ensureMilitaryBuildings(ai);

        // 7) TRAIN MILITARY once the economy is on its feet (or immediately if a
        //    rival Wonder must be answered).
        if (popFree > 0 && (workers.length >= 8 || enemyWonder)) {
            this.trainMilitary(ai);
        }

        // 8) WONDER: in the Iron age with a real army and the resources, build it.
        if (ai.age === 'iron' && military.length >= 6) this.maybeBuildWonder(ai);

        // 9) COMMAND THE ARMY: rush a rival Wonder, attack visible enemies, or push
        //    scouts/forces into the dark to find them.
        this.commandArmy(ai, military, enemyWonder);

        // 10) Keep revealing the map (esp. when a needed resource isn't discovered).
        this.exploreMap(ai);
    }

    // ---- Workers / resources (fog-limited) -----------------------------------
    neededResourceType(ai) {
        const r = ai.resources;
        if (r.food < 200) return 'food'; // food gates workers, age-ups and military
        const stock = { food: r.food, wood: r.wood, gold: r.gold, stone: r.stone };
        let best = 'wood', bestVal = Infinity;
        for (const t of ['food', 'wood', 'gold', 'stone']) {
            if (stock[t] < bestVal) { bestVal = stock[t]; best = t; }
        }
        return best;
    }

    // Nearest DISCOVERED node (optionally of a type) with anything left.
    findKnownResource(ai, unit, type) {
        const res = (this.game.terrain && this.game.terrain.resources) || [];
        let nearest = null, minDist = Infinity;
        ai._knownResIdx.forEach(idx => {
            const r = res[idx];
            if (!r || r.amount <= 0) return;
            if (type && r.type !== type) return;
            const d = Math.hypot(r.x - unit.x, r.z - unit.z);
            if (d < minDist) { minDist = d; nearest = r; }
        });
        return nearest;
    }

    // Send a worker to harvest a specific node (mirrors the game's own redirect:
    // clears any in-progress harvest/carry so the move-then-harvest cycle restarts).
    sendWorkerToResource(worker, node) {
        worker.task = 'harvesting';
        worker.harvestTarget = node;
        worker.isHarvesting = false;
        worker.carryingResource = false;
        worker.harvestAmount = 0;
        worker.isMoving = true;
        worker.targetX = node.x + (Math.random() - 0.5) * 2;
        worker.targetZ = node.z + (Math.random() - 0.5) * 2;
    }

    // Keep the workforce productive every think:
    //  (a) free workers whose scouting leg is over so they rejoin the economy,
    //  (b) put genuinely idle workers on the most-needed discovered resource,
    //  (c) break single-resource starvation by rebalancing busy harvesters.
    manageWorkers(ai) {
        // (a) Without this, a worker once sent to explore keeps the 'scouting' task
        //     forever (it's excluded from harvesting) and never works again.
        ai.units.forEach(w => {
            if (w.type !== 'worker' || w.task !== 'scouting') return;
            w._scoutTicks = (w._scoutTicks || 0) + 1;
            if (!w.isMoving || w._scoutTicks > 6) { w.task = null; w._scoutTicks = 0; }
        });
        this.assignWorkersToHarvest(ai);
        this.rebalanceWorkers(ai);
    }

    assignWorkersToHarvest(ai) {
        const idleWorkers = ai.units.filter(w => w.type === 'worker' &&
            !w.isMoving && !w.isHarvesting && !w.carryingResource && !w.isBuilding &&
            w.task !== 'building' && w.task !== 'farm_work' && w.task !== 'scouting');
        if (!idleWorkers.length) return;
        const wantType = this.neededResourceType(ai);
        idleWorkers.forEach(worker => {
            // Prefer the needed type among DISCOVERED nodes; fall back to any known
            // node. If nothing is discovered yet, the worker waits — exploreMap will
            // scout to reveal resources (fair: the models face the same fog).
            const target = this.findKnownResource(ai, worker, wantType) || this.findKnownResource(ai, worker, null);
            if (!target) return;
            this.sendWorkerToResource(worker, target);
        });
    }

    // Deadlock breaker: if we're critically short of a resource that has a known
    // node but too few (or no) workers on it, pull ONE worker off a well-stocked
    // resource and send it there. One move per think keeps it stable, never thrashy.
    // This is what stops a base from starving on food (and so being unable to train,
    // research or build) while every worker mines a huge wood/stone node.
    rebalanceWorkers(ai) {
        const r = ai.resources;
        const types = ['food', 'wood', 'stone', 'gold'];
        const threshold = { food: 150, wood: 120, stone: 60, gold: 60 };
        const minWhenShort = { food: 2, wood: 2, stone: 1, gold: 1 };

        // Group active harvesters by the resource they're gathering.
        const byType = { food: [], wood: [], stone: [], gold: [] };
        ai.units.forEach(w => {
            if (w.type !== 'worker') return;
            if (w.task !== 'harvesting' && w.task !== 'carrying') return;
            if (w.isBuilding || w.farmRef) return;
            const t = w.harvestTarget && w.harvestTarget.type;
            if (byType[t]) byType[t].push(w);
        });

        for (const t of types) {
            if (r[t] >= threshold[t]) continue;            // not short
            if (byType[t].length >= minWhenShort[t]) continue; // already staffed enough
            const center = ai.buildings[0] || { x: 0, z: 0 };
            if (!this.findKnownResource(ai, center, t)) continue; // exploreMap will scout it
            // Donor: the type with the most harvesters that is itself NOT short and can
            // spare one (stays at/above its own minimum).
            let donorType = null, donorCount = 0;
            for (const dt of types) {
                if (dt === t || r[dt] < threshold[dt]) continue;
                if (byType[dt].length > donorCount && byType[dt].length > minWhenShort[dt]) {
                    donorCount = byType[dt].length; donorType = dt;
                }
            }
            if (!donorType) continue;
            // Prefer a donor not currently hauling goods (don't waste a trip).
            const pool = byType[donorType];
            const donor = pool.find(w => !w.carryingResource) || pool[pool.length - 1];
            if (!donor) continue;
            const node = this.findKnownResource(ai, donor, t);
            if (!node) continue;
            this.sendWorkerToResource(donor, node);
            return; // one reassignment per think
        }
    }

    // Send ONE spare unit to scout an unexplored frontier so resources/enemies get
    // revealed. More eager when a NEEDED resource type is still undiscovered (so the
    // economy isn't stuck). Prefers idle military, then a genuinely idle worker.
    exploreMap(ai) {
        const want = this.neededResourceType(ai);
        const haveWanted = !!this.findKnownResource(ai, ai.buildings[0] || { x: 0, z: 0 }, want);
        const interval = haveWanted ? 8 : 2; // scout urgently if we can't find what we need
        ai._exploreTimer = (ai._exploreTimer || 0) + 1;
        if (ai._exploreTimer < interval) return;

        const idleMilitary = ai.units.find(u => u.type !== 'worker' && u.unitType !== 'support' &&
            !u.isAttacking && !u.attackTarget && !u.attackMove && !u.isMoving);
        const idleWorker = ai.units.find(u => u.type === 'worker' &&
            !u.isMoving && !u.isHarvesting && !u.carryingResource && !u.isBuilding &&
            !u.farmRef && u.task !== 'building' && u.task !== 'farm_work');
        const scout = idleMilitary || idleWorker;
        if (!scout) return;

        ai._exploreTimer = 0;
        const half = (this.game.terrain ? this.game.terrain.size : 800) / 2 - 40;
        // Head for the least-explored map ninth (the same 3×3 summary the LLMs
        // see) with jitter so successive scouts spread within the section —
        // controller-type parity. Golden-angle fan-out remains as the fallback
        // when no exploration data exists yet or the whole map is known.
        const sec = this.game.leastExploredSection ? this.game.leastExploredSection(ai) : null;
        let tx, tz;
        if (sec && sec.pct < 100) {
            tx = sec.x + (Math.random() - 0.5) * 160;
            tz = sec.z + (Math.random() - 0.5) * 160;
        } else {
            ai._scoutAngle = (ai._scoutAngle == null) ? Math.random() * Math.PI * 2 : ai._scoutAngle + 2.399963;
            ai._scoutRadius = Math.min(half, (ai._scoutRadius || 60) + 40);
            const c = ai.buildings[0] || { x: 0, z: 0 };
            tx = c.x + Math.cos(ai._scoutAngle) * ai._scoutRadius;
            tz = c.z + Math.sin(ai._scoutAngle) * ai._scoutRadius;
        }
        scout.task = scout.type === 'worker' ? 'scouting' : null;
        scout.isMoving = true;
        scout.targetX = Math.max(-half, Math.min(half, tx));
        scout.targetZ = Math.max(-half, Math.min(half, tz));
    }

    // ---- Research (delegated to the game's timed system) ----------------------
    maybeStartResearch(ai) {
        if (ai.currentResearch) return; // the game advances/completes it
        const civ = getCivilization(ai.civilization);
        const techs = civ.techTree || {};
        const ageOrder = ['stone', 'neolithic', 'bronze', 'iron'];
        const curAge = ageOrder.indexOf(ai.age);

        const available = Object.keys(techs).filter(id => {
            const tech = techs[id];
            if (ai.researchedTechs[id]) return false;
            if (tech.requiredAge && ageOrder.indexOf(tech.requiredAge) > curAge) return false;
            if (tech.requires && tech.requires.some(req => !ai.researchedTechs[req])) return false;
            if (tech.researchAt === 'town_center') return ai.buildings.some(b => b.type === 'town_center' && !b.underConstruction);
            if (tech.researchAt === 'market') return ai.buildings.some(b => b.type === 'market' && !b.underConstruction);
            return false;
        });
        // Unlock techs first (they open new buildings/units), then the rest.
        available.sort((a, b) => (techs[b].unlocks ? 1 : 0) - (techs[a].unlocks ? 1 : 0));

        for (const id of available) {
            const tech = techs[id];
            const mult = ai.techCostMultiplier || 1;
            const cost = {
                food: Math.floor((tech.cost.food || 0) * mult),
                wood: Math.floor((tech.cost.wood || 0) * mult),
                stone: Math.floor((tech.cost.stone || 0) * mult),
                gold: Math.floor((tech.cost.gold || 0) * mult)
            };
            if (!this.canAfford(ai, cost)) continue;
            this.spend(ai, cost);
            ai.currentResearch = { techId: id, progress: 0, duration: tech.researchTime || 15000 };
            return; // one research at a time
        }
    }

    // ---- Age advancement (delegated to the game's timed system) ---------------
    maybeAdvanceAge(ai, workerCount) {
        if (ai.currentAgeUpgrade) return;
        const next = this.getNextAge(ai.age);
        if (!next) return;
        // Don't bankrupt the economy advancing — keep a worker base going first.
        if (workerCount < 6) return;
        // Shared cost table (civilizations.js) — identical for every player type.
        const cost = AGE_COSTS[next];
        if (!cost || !this.canAfford(ai, cost)) return;
        this.spend(ai, cost);
        ai.currentAgeUpgrade = { targetAge: next, progress: 0, duration: 30000 };
    }

    // ---- Military buildings + training ---------------------------------------
    ensureMilitaryBuildings(ai) {
        const has = (type) => ai.buildings.some(b => b.type === type);
        if (!has('barracks')) { this.buildStructure(ai, 'barracks'); return; }
        if (ai.researchedTechs['horseback'] && !has('stable')) { this.buildStructure(ai, 'stable'); return; }
        if (ai.researchedTechs['longbow'] && !has('archery_range')) { this.buildStructure(ai, 'archery_range'); return; }
        // A defensive tower once we have stone to spare.
        if (!has('tower') && ai.resources.stone >= 120) this.buildStructure(ai, 'tower');
    }

    trainMilitary(ai) {
        const trainers = ai.buildings.filter(b => b.canTrain && b.type !== 'town_center' &&
            !b.underConstruction && !b.isProducing);
        trainers.forEach(building => {
            const unitType = this.getUnitToTrain(ai, building);
            if (unitType) this.trainUnit(ai, unitType, building);
        });
    }

    getUnitToTrain(ai, building) {
        switch (building.type) {
            case 'barracks':      return ai.age === 'iron' ? 'champion' : (ai.age === 'bronze' ? 'warrior' : 'militia');
            case 'archery_range': return ai.age === 'iron' ? 'elite_archer' : (ai.age === 'neolithic' || ai.age === 'bronze' ? 'archer' : null);
            case 'stable':        return ai.age === 'iron' ? 'heavy_cavalry' : (ai.age === 'bronze' ? 'cavalry' : 'scout_cavalry');
            default:              return null;
        }
    }

    // ---- Combat (fog-limited targeting) --------------------------------------
    knownEnemyWonder(ai) {
        // Wonders are always visible to everyone (existential threat).
        for (const other of this.enemyOwners(ai)) {
            const w = other.buildings.find(b => b.isWonder && b.health > 0);
            if (w) return w;
        }
        return null;
    }

    // Targets the AI is allowed to act on: visible enemy units, remembered enemy
    // buildings (still alive), and any enemy wonder (always visible).
    visibleEnemyTargets(ai) {
        const out = new Set();
        for (const other of this.enemyOwners(ai)) {
            other.units.forEach(u => { if (u.health > 0 && this.isVisibleTo(ai, u.x, u.z)) out.add(u); });
            other.buildings.forEach(b => { if (b.health > 0 && b.isWonder) out.add(b); });
        }
        ai._knownEnemyBuildings.forEach(b => { if (b && b.health > 0) out.add(b); else ai._knownEnemyBuildings.delete(b); });
        return [...out];
    }

    commandArmy(ai, military, enemyWonder) {
        if (!military.length) return;
        // Only commit the army when it's a real force, unless a Wonder must be razed.
        const ready = military.length >= 8 || (enemyWonder && military.length >= 1);
        if (!ready) return;

        const origin = military[0];
        // A rival Wonder outranks everything.
        let target = enemyWonder;
        if (!target) {
            let minD = Infinity;
            for (const e of this.visibleEnemyTargets(ai)) {
                const d = this.distance(origin, e);
                if (d < minD) { minD = d; target = e; }
            }
        }

        if (target) {
            military.forEach(unit => {
                unit.isAttacking = true;
                unit.attackTarget = target;
                unit.attackMove = { x: target.x, z: target.z };
                unit.attackTimer = 0;
                unit.isMoving = true;
                unit.targetX = target.x;
                unit.targetZ = target.z;
            });
        } else {
            // No enemy discovered yet: march the army outward (attack-move) to find
            // one, engaging anything it meets — fair, same as a model that must scout.
            // Commit to ONE destination per leg: only pick a new heading once the army
            // has reached its current target (or has been stuck on it too long). Re-
            // rolling the angle every think made the whole army pivot in unison without
            // ever arriving — covering no ground.
            const half = (this.game.terrain ? this.game.terrain.size : 800) / 2 - 60;
            const base = ai.buildings[0] || origin;
            // Army centroid, to tell when this leg is done.
            let cx = 0, cz = 0;
            military.forEach(u => { cx += u.x; cz += u.z; });
            cx /= military.length; cz /= military.length;

            ai._armyScoutTicks = (ai._armyScoutTicks || 0) + 1;
            const arrived = ai._armyScoutTarget &&
                this.distance({ x: cx, z: cz }, ai._armyScoutTarget) < 25;
            const stuck = ai._armyScoutTicks > 12; // ~24s without arriving → new leg

            let newLeg = false;
            if (!ai._armyScoutTarget || arrived || stuck) {
                // Fan out from the base with the golden angle and a growing radius so
                // repeated legs sweep the whole map instead of circling one ring.
                ai._armyScoutAngle = (ai._armyScoutAngle == null) ? Math.random() * Math.PI * 2 : ai._armyScoutAngle + 2.399963;
                ai._armyScoutRadius = Math.min(half, (ai._armyScoutRadius || 90) + 60);
                ai._armyScoutTarget = {
                    x: Math.max(-half, Math.min(half, base.x + Math.cos(ai._armyScoutAngle) * ai._armyScoutRadius)),
                    z: Math.max(-half, Math.min(half, base.z + Math.sin(ai._armyScoutAngle) * ai._armyScoutRadius))
                };
                ai._armyScoutTicks = 0;
                newLeg = true;
            }

            const tgt = ai._armyScoutTarget;
            military.forEach(unit => {
                if (unit.isAttacking && unit.attackTarget) return; // already engaged
                // Mid-leg, leave units that are already marching alone (no per-think
                // reset); only (re)issue the order on a new leg or to idle stragglers.
                if (!newLeg && unit.isMoving) return;
                unit.isAttacking = true;
                unit.attackTarget = null;
                unit.attackMove = { x: tgt.x, z: tgt.z };
                unit.isMoving = true;
                unit.targetX = tgt.x;
                unit.targetZ = tgt.z;
            });
        }
    }

    // ---- Wonder -------------------------------------------------------------
    maybeBuildWonder(ai) {
        const wonderDef = this.getWonderForCiv(ai.civilization);
        if (!wonderDef) return;
        if (ai.buildings.some(b => b.isWonder)) return;
        const ageOrder = ['stone', 'neolithic', 'bronze', 'iron'];
        if (ageOrder.indexOf(ai.age) < ageOrder.indexOf(wonderDef.requiredAge || 'iron')) return;
        if (!this.canAfford(ai, wonderDef.cost)) return;

        const tc = ai.buildings.find(b => b.type === 'town_center');
        if (!tc) return;
        // Find a clear spot BEFORE spending (no leak on failure).
        const pos = this.findBuildPosition(ai, tc, wonderDef.id, true);
        if (!pos) return;
        this.spend(ai, wonderDef.cost);
        const wonder = createBuilding(wonderDef.id, pos.x, pos.z, ai.id, ai.civilization, { underConstruction: true, age: ai.age });
        ai.buildings.push(wonder);
        this.game.renderer.addBuilding(wonder);
        this.game.assignBuilderTo(ai, wonder, { forceBorrow: true });
    }

    // ---- Generic build / train (no resource leaks) ---------------------------
    // Returns a valid {x,z} near the town centre or null — WITHOUT spending.
    findBuildPosition(ai, tc, buildingType, isWonder) {
        for (let attempts = 0; attempts < 24; attempts++) {
            const x = tc.x + (Math.random() - 0.5) * 60;
            const z = tc.z + (Math.random() - 0.5) * 60;
            let valid = true;
            const others = [...ai.buildings];
            if (this.game.player) others.push(...this.game.player.buildings);
            for (const b of others) {
                if (Math.hypot(b.x - x, b.z - z) < (isWonder ? 12 : 9)) { valid = false; break; }
            }
            if (valid && this.game.isTooCloseToResource && this.game.isTooCloseToResource(x, z, buildingType, isWonder)) valid = false;
            if (valid && this.game.clampToMap) {
                const c = this.game.clampToMap(x, z);
                if (Math.abs(c.x - x) > 0.5 || Math.abs(c.z - z) > 0.5) valid = false; // off-map
            }
            if (valid) return { x, z };
        }
        return null;
    }

    buildStructure(ai, buildingType) {
        const def = getBuildingDef(buildingType);
        if (!def) return;
        // Don't start a second of a one-per-build type already under construction.
        if (ai.buildings.some(b => b.type === buildingType && b.underConstruction)) return;
        if (!this.canAfford(ai, def.cost)) return;

        const tc = ai.buildings.find(b => b.type === 'town_center');
        if (!tc) return;
        const pos = this.findBuildPosition(ai, tc, buildingType, false);
        if (!pos) return; // no spot — DON'T spend (was a resource leak before)

        this.spend(ai, def.cost);
        const building = createBuilding(buildingType, pos.x, pos.z, ai.id, ai.civilization, { underConstruction: true, age: ai.age });
        ai.buildings.push(building);
        this.game.renderer.addBuilding(building);
        this.game.assignBuilderTo(ai, building, { forceBorrow: true });
    }

    trainUnit(ai, unitType, building) {
        if (!building || building.underConstruction || building.isProducing) return;
        const unitDef = getUnitDef(unitType);
        if (!unitDef || !unitDef.cost) return;
        // Respect the population cap (build houses to raise it; never overflow).
        if (ai.resources.population >= ai.resources.maxPopulation) return;
        if (!this.canAfford(ai, unitDef.cost)) return;

        this.spend(ai, unitDef.cost);
        building.isProducing = true;
        building.productionDuration = 5000;
        building.productionProgress = 0;
        building.productionType = unitType;
    }

    // ---- Small helpers -------------------------------------------------------
    canAfford(ai, cost) {
        const r = ai.resources;
        return r.food >= (cost.food || 0) && r.wood >= (cost.wood || 0) &&
               r.stone >= (cost.stone || 0) && r.gold >= (cost.gold || 0);
    }

    spend(ai, cost) {
        const r = ai.resources;
        r.food -= (cost.food || 0);
        r.wood -= (cost.wood || 0);
        r.stone -= (cost.stone || 0);
        r.gold -= (cost.gold || 0);
    }

    getWonderForCiv(civId) {
        const civ = getCivilization(civId);
        if (!civ || !civ.uniqueBuildings) return null;
        return civ.uniqueBuildings.find(b => b.type === 'wonder') || null;
    }

    getNextAge(currentAge) {
        const ages = ['stone', 'neolithic', 'bronze', 'iron'];
        const idx = ages.indexOf(currentAge);
        return idx < ages.length - 1 ? ages[idx + 1] : null;
    }

    distance(a, b) {
        return Math.hypot(a.x - b.x, a.z - b.z);
    }
}
