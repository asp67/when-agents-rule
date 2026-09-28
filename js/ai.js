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
// A visibility test for ONE owner, built once for a BATCH of questions asked against a
// board that does not move while the batch runs (a single synchronous loop: every node
// on the map, every rival unit). The linear check scans every unit and building of the
// owner per question; discovery asks it for every node and every rival entity, several
// times a second, and it was 58% of the platform's headless CPU.
//
// Each eye (a unit or a finished building) is filed under every grid cell its sight
// disc can reach, padded by one unit so float rounding can never leave a cell out. A
// question then tests only the eyes filed under its own cell, with EXACTLY the original
// expression -- Math.hypot for AIManager.isVisibleTo, sqrt(dx*dx + dz*dz) for the
// harness's isPositionVisibleToAI -- and the same rules about dead units and
// construction sites, so every answer is bit-identical to the linear scan. Built per
// batch, never cached across one: nothing can move between build and use.
//
// `harness` selects isPositionVisibleToAI's rules: sqrt, dead units still count,
// construction sites skipped. Otherwise isVisibleTo's: hypot, the living only.
function buildVisionTest(game, ai, harness) {
    const CELL = 20, cells = new Map();
    const key = (cx, cz) => cx * 65536 + cz;
    const file = (x, z, r, eye) => {
        const x0 = Math.floor((x - r - 1) / CELL), x1 = Math.floor((x + r + 1) / CELL);
        const z0 = Math.floor((z - r - 1) / CELL), z1 = Math.floor((z + r + 1) / CELL);
        for (let cx = x0; cx <= x1; cx++) for (let cz = z0; cz <= z1; cz++) {
            const k = key(cx, cz);
            const list = cells.get(k);
            if (list) list.push(eye); else cells.set(k, [eye]);
        }
    };
    for (const u of (ai && ai.units) || []) {
        if (!harness && u.health <= 0) continue;
        const r = game.unitVision(u);
        if (r > 0) file(u.x, u.z, r, { x: u.x, z: u.z, r });
    }
    for (const b of (ai && ai.buildings) || []) {
        if (harness ? b.underConstruction : b.health <= 0) continue;
        const r = game.buildingVision(b);
        if (r > 0) file(b.x, b.z, r, { x: b.x, z: b.z, r });
    }
    return (x, z) => {
        const list = cells.get(key(Math.floor(x / CELL), Math.floor(z / CELL)));
        if (!list) return false;
        for (const e of list) {
            if (harness) {
                const dx = e.x - x, dz = e.z - z;
                if (Math.sqrt(dx * dx + dz * dz) <= e.r) return true;
            } else if (WarMath.hypot(e.x - x, e.z - z) <= e.r) return true;
        }
        return false;
    };
}

// Anchor tiers (review #7): the same brain in a few named styles, so a model can be
// measured against more than one fixed opponent. Every number the brain decides by is
// here; `standard` holds exactly the values it always had, so a standard seat plays
// bit for bit as before. The others differ ONLY in these numbers and in two switches:
// `pick` (what to train) and `prey` (what to attack). None sees more than any seat does:
// every choice still reads the same fog-limited knowledge.
//
// An anchor is a yardstick for ONE build of the rules. It is not contract-identical:
// a rules change can move any tier, so a result against one is keyed to the core hash
// it was played under, and the tiers are ordered by calibration (seat-swapped pairs,
// tools/anchor-calibration.cjs, docs/ANCHORS.md), never by what their names promise.
//
//   thinkMs      how often it decides (per seat; the brain's reaction time)
//   workers      worker target            farms      farm target
//   houses       house limit              militaryAt workers before soldiers are trained
//   attackAt     army size it commits     wonderArmy army size before it builds a Wonder
//   towers       tower count              towerStone stone in hand before a tower
//   reserve      once its army is attackAt strong, keeps the next age's cost untouched
//                by more soldiers and towers: an army first, then the age
//   pick         'ladder': every trainer, best unit of the age
//                'counter': only the building whose units beat what it has SEEN most of
//   prey         'nearest': the nearest target it knows of
//                'workers': the nearest enemy worker it can see, before anything else
const AI_PROFILES = Object.freeze({
    standard: Object.freeze({ thinkMs: 2000, workers: 14, farms: 4, houses: 6, militaryAt: 8, attackAt: 8, wonderArmy: 6, towers: 1, towerStone: 120, reserve: false, pick: 'ladder', prey: 'nearest' }),
    turtle:   Object.freeze({ thinkMs: 2000, workers: 18, farms: 6, houses: 6, militaryAt: 10, attackAt: 20, wonderArmy: 10, towers: 3, towerStone: 120, reserve: true, pick: 'ladder', prey: 'nearest' }),
    legion:   Object.freeze({ thinkMs: 2000, workers: 14, farms: 4, houses: 6, militaryAt: 8, attackAt: 12, wonderArmy: 8, towers: 1, towerStone: 120, reserve: false, pick: 'counter', prey: 'nearest' }),
    raider:   Object.freeze({ thinkMs: 1000, workers: 10, farms: 3, houses: 6, militaryAt: 5, attackAt: 4, wonderArmy: 6, towers: 0, towerStone: 120, reserve: false, pick: 'ladder', prey: 'workers' })
});
const AI_PROFILE_IDS = Object.keys(AI_PROFILES);

// What beats what: the combat multiplier's hard counters (Game.combatMultiplier).
const COUNTER_OF = Object.freeze({ infantry: 'ranged', ranged: 'cavalry', cavalry: 'infantry' });

class AIManager {
    constructor(game) {
        this.game = game;
        this.aiPlayers = [];
        this.openAIControlled = new Set();
    }

    static profileIds() { return AI_PROFILE_IDS.slice(); }
    profileOf(ai) { return AI_PROFILES[ai && ai.profile] || AI_PROFILES.standard; }

    markAsOpenAIControlled(aiPlayerId) {
        this.openAIControlled.add(aiPlayerId);
    }

    addAIPlayer(civilization, difficulty = 'medium', profile = 'standard') {
        const resources = new ResourceManager();
        resources.food = 200;
        resources.wood = 200;
        resources.stone = 100;
        resources.gold = 50;
        const ai = {
            // Seeded, like unit ids: the same match gives its players the same ids. Keyed
            // to no seat, because the seat is assigned after this.
            id: (this.game && this.game.rand) ? WarRng.id('ai_', () => this.game.rand(null, 'player-id'))
                : 'ai_' + Math.random().toString(36).substr(2, 9), // rng-exempt: no game at all (fixtures, tools)
            civilization: civilization,
            difficulty: difficulty,
            // The anchor style this seat plays when the brain has it (AI_PROFILES).
            profile: AI_PROFILES[profile] ? profile : 'standard',
            // Its own think clock, born at zero with the seat: the brain's beat belongs
            // to the seat, so it neither leaks from the last match nor ties tiers
            // with different reaction times together.
            thinkTimer: 0,
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
            this.discoveryTimer -= 250;   // carry the remainder: cadence-proof
            this.aiPlayers.forEach(ai => {
                // Exploration bitmap for EVERY player (LLM ones too — their own
                // discovery runs only when they take a turn, which would miss the
                // ground their units sweep while marching between turns).
                if (this.game.markExploration) this.game.markExploration(ai);
                // First-contact memory (gates rival army/building counts).
                if (this.game.updateRivalContacts) this.game.updateRivalContacts(ai);
                if (this.openAIControlled.has(ai.id)) return;
                this.updateDiscovery(ai);
            });
            // The human is a viewer too (campaign): its contacts gate the
            // opponents footer the same way.
            if (this.game.updateRivalContacts && !this.game.spectatorMode && this.game.player) {
                this.game.updateRivalContacts(this.game.player);
            }
            // Who just laid eyes on whom. On the discovery beat rather than a beat of
            // its own: a sighting between two 250ms samples is a unit that moved less
            // than a third of its own vision radius, so nothing is missed that a finer
            // scan would have caught, and everything else here already runs at 4Hz.
            if (this.game.detectContacts) this.game.detectContacts();
        }

        this.advanceThink(deltaTime);
    }

    // Each seat's think clock, in seat order. Every clock runs, a model's seat too: one
    // demoted to the brain mid-match then thinks on its own beat from the moment it is
    // handed over, as it always has.
    advanceThink(deltaTime) {
        for (const ai of this.aiPlayers) {
            const every = this.profileOf(ai).thinkMs;
            ai.thinkTimer = (ai.thinkTimer || 0) + deltaTime;
            if (ai.thinkTimer < every) continue;
            ai.thinkTimer -= every;   // carry the remainder: cadence-proof
            if (!this.openAIControlled.has(ai.id)) this.runTurn(ai);
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
            if (WarMath.hypot(u.x - x, u.z - z) <= range) return true;
        }
        for (const b of ai.buildings) {
            if (b.health <= 0) continue;
            const range = this.game.buildingVision(b); // 0 while under construction
            if (range > 0 && WarMath.hypot(b.x - x, b.z - z) <= range) return true;
        }
        return false;
    }

    updateDiscovery(ai) {
        if (!ai._knownResIdx) ai._knownResIdx = new Set();
        if (!ai._knownEnemyBuildings) ai._knownEnemyBuildings = new Set();
        const res = (this.game.terrain && this.game.terrain.resources) || [];
        const see = buildVisionTest(this.game, ai);   // one batch: nothing moves inside it
        for (let i = 0; i < res.length; i++) {
            if (ai._knownResIdx.has(i)) continue;
            const r = res[i];
            if (see(r.x, r.z)) ai._knownResIdx.add(i);
        }
        // Remember enemy buildings once seen (buildings are static).
        for (const other of this.enemyOwners(ai)) {
            for (const b of other.buildings) {
                if (b.health <= 0) { ai._knownEnemyBuildings.delete(b); continue; }
                if (!ai._knownEnemyBuildings.has(b) && see(b.x, b.z)) {
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
        const P = this.profileOf(ai);
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
            ai.buildings.filter(b => b.type === 'house').length < P.houses) {
            this.buildStructure(ai, 'house');
        }

        // 2) ECONOMY: grow the worker base toward a target while there is pop room.
        if (workers.length < P.workers && popFree > 0) {
            const tc = ai.buildings.find(b => b.type === 'town_center' && !b.underConstruction && !b.isProducing);
            if (tc) this.trainUnit(ai, 'worker', tc);
        }

        // 3) FOOD SECURITY: a couple of farms once the base is going, so food never
        //    dries up (farms regenerate and their builder becomes the farmer).
        if (workers.length >= 5 && ai.buildings.filter(b => b.type === 'farm').length < P.farms) {
            this.buildStructure(ai, 'farm');
        }

        // 4) RESEARCH HOSTS: the buildings techs are researched AT. Before research,
        //    so a host finished this tick is available to it immediately.
        this.ensureResearchBuildings(ai);

        // 5) RESEARCH: start one affordable tech (the GAME advances + completes it).
        this.maybeStartResearch(ai);

        // 6) ADVANCE AGE: when affordable and the economy can support it (the GAME
        //    runs the timed upgrade — no instant ages).
        this.maybeAdvanceAge(ai, workers.length);

        // 7) MILITARY BUILDINGS: a barracks first; stable/archery once unlocked.
        this.ensureMilitaryBuildings(ai);

        // 8) TRAIN MILITARY once the economy is on its feet (or immediately if a
        //    rival Wonder must be answered).
        if (popFree > 0 && (workers.length >= P.militaryAt || enemyWonder)) {
            this.trainMilitary(ai);
        }

        // 8) WONDER: in the Iron age with a real army and the resources, build it.
        if (ai.age === 'iron' && military.length >= P.wonderArmy) this.maybeBuildWonder(ai);

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
            const d = WarMath.hypot(r.x - unit.x, r.z - unit.z);
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
        worker.targetX = node.x + (this.game.rand(worker, 'node-spot') - 0.5) * 2;
        worker.targetZ = node.z + (this.game.rand(worker, 'node-spot') - 0.5) * 2;
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
        // Head for the least-explored map tile (the same 7×7 summary the LLMs
        // see) with jitter so successive scouts spread within the ~114-unit
        // tile — controller-type parity. Golden-angle fan-out remains as the
        // fallback when no exploration data exists yet or the whole map is known.
        const sec = this.game.leastExploredSection ? this.game.leastExploredSection(ai) : null;
        let tx, tz;
        if (sec && sec.pct < 100) {
            tx = sec.x + (this.game.rand(ai, 'scout') - 0.5) * 100;
            tz = sec.z + (this.game.rand(ai, 'scout') - 0.5) * 100;
        } else {
            ai._scoutAngle = (ai._scoutAngle == null) ? this.game.rand(ai, 'scout') * Math.PI * 2 : ai._scoutAngle + 2.399963;
            ai._scoutRadius = Math.min(half, (ai._scoutRadius || 60) + 40);
            const c = ai.buildings[0] || { x: 0, z: 0 };
            tx = c.x + WarMath.cos(ai._scoutAngle) * ai._scoutRadius;
            tz = c.z + WarMath.sin(ai._scoutAngle) * ai._scoutRadius;
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
            // Generic host check: the tech's researchAt building must stand
            // finished — covers town_center, academy AND temple research.
            const at = tech.researchAt || 'town_center';
            return ai.buildings.some(b => b.type === at && !b.underConstruction);
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


    // Research hosts. maybeStartResearch only offers a tech whose researchAt building
    // stands finished, and this player only ever built houses, farms and military — so
    // every tech hosted anywhere else was unreachable for the whole match. Between a
    // third and half of each civ's tree, depending on the civ, including iron_working and
    // the armour upgrades. It even researched the ACADEMY unlock (that one is hosted at
    // the town centre, and unlock techs sort first) and then never built the thing it had
    // just paid to unlock.
    //
    // Gated in the caller, like stable and archery_range above: buildStructure checks
    // cost and spacing but not requiresTech or requiredAge, so asking here is what keeps
    // this player inside the same rules a model plays by.
    ensureResearchBuildings(ai) {
        // Declared here, not borrowed: ageOrder is a local inside maybeStartResearch,
        // so referencing it from another method throws at RUN time and passes a syntax
        // check clean.
        const AGES = ['stone', 'neolithic', 'bronze', 'iron'];
        const has = (type) => ai.buildings.some(b => b.type === type);
        const canBuild = (type) => {
            const def = (typeof getBuildingDef === 'function') ? getBuildingDef(type) : null;
            if (!def || has(type)) return false;
            if (def.requiresTech && !ai.researchedTechs[def.requiresTech]) return false;
            const need = (typeof effectiveBuildingAge === 'function')
                ? effectiveBuildingAge(ai.civilization, def) : (def.requiredAge || 'stone');
            return AGES.indexOf(ai.age) >= AGES.indexOf(need);
        };
        // The academy first: it hosts far more techs than the temple, and the unlock is
        // already researched by the time it becomes legal.
        if (canBuild('academy')) { this.buildStructure(ai, 'academy'); return; }
        // The temple hosts one tech per civ and trains priests, so it also puts healers
        // on the field — a real gain, and the reason it comes second rather than never.
        if (canBuild('temple')) this.buildStructure(ai, 'temple');
    }
    // ---- Military buildings + training ---------------------------------------
    ensureMilitaryBuildings(ai) {
        const has = (type) => ai.buildings.some(b => b.type === type);
        if (!has('barracks')) { this.buildStructure(ai, 'barracks'); return; }
        if (ai.researchedTechs['horseback'] && !has('stable')) { this.buildStructure(ai, 'stable'); return; }
        if (ai.researchedTechs['longbow'] && !has('archery_range')) { this.buildStructure(ai, 'archery_range'); return; }
        // Defensive towers once we have stone to spare (standard: one).
        const P = this.profileOf(ai);
        if (ai.buildings.filter(b => b.type === 'tower').length < P.towers && ai.resources.stone >= P.towerStone
            && (!P.reserve || this.spareFor(ai, getBuildingDef('tower').cost))) this.buildStructure(ai, 'tower');
    }

    // A profile with `reserve` saves for the next age: soldiers and towers may only
    // spend what lies above that age's price. Nothing is held back while an upgrade
    // runs, in the last age, before the worker base an age-up waits for anyway, or
    // before its army is the size it attacks with -- saving from the first soldier on
    // left a turtle with no army at all, waiting on stone it never gathered.
    spareFor(ai, cost) {
        const next = this.getNextAge(ai.age), age = next && AGE_COSTS[next];
        if (!age || ai.currentAgeUpgrade) return true;
        if (ai.units.filter(u => u.type === 'worker').length < 6) return true;
        if (ai.units.filter(u => u.type !== 'worker' && u.unitType !== 'support').length < this.profileOf(ai).attackAt) return true;
        const r = ai.resources;
        return ['food', 'wood', 'stone', 'gold'].every(k => r[k] - (cost[k] || 0) >= (age[k] || 0));
    }

    trainMilitary(ai) {
        const P = this.profileOf(ai);
        let trainers = ai.buildings.filter(b => b.canTrain && b.type !== 'town_center' &&
            !b.underConstruction && !b.isProducing);
        // Counter-pick: the class that beats what this seat has seen most of, from the
        // buildings that train it. Until it has seen an army, or has no such building,
        // it trains like everyone else.
        if (P.pick === 'counter') {
            const want = this.counterClass(ai);
            const fit = want && trainers.filter(b => this.classOfTrainer(ai, b) === want);
            if (fit && fit.length) trainers = fit;
        }
        trainers.forEach(building => {
            const unitType = this.getUnitToTrain(ai, building);
            if (!unitType) return;
            if (P.reserve) {
                const def = getUnitDefFor(ai.civilization, unitType);
                if (def && def.cost && !this.spareFor(ai, def.cost)) return;
            }
            this.trainUnit(ai, unitType, building);
        });
    }

    // The combat class a building would train now (infantry, ranged, cavalry...).
    classOfTrainer(ai, building) {
        const unitType = this.getUnitToTrain(ai, building);
        const def = unitType && getUnitDefFor(ai.civilization, unitType);
        return def ? def.type : null;
    }

    // What beats the enemy army this seat knows of. Read from visibleEnemyTargets only
    // -- the same fog-limited sight every other choice uses -- and remembered from the
    // last time it saw an army, the way a player remembers what came at them.
    counterClass(ai) {
        const seen = { infantry: 0, ranged: 0, cavalry: 0 };
        let any = false;
        for (const e of this.visibleEnemyTargets(ai)) {
            if (e.unitType in seen) { seen[e.unitType]++; any = true; }
        }
        if (any) ai._seenArmy = seen;
        const mix = ai._seenArmy;
        if (!mix) return null;
        let most = null;
        for (const k of ['infantry', 'ranged', 'cavalry']) if (mix[k] > 0 && (!most || mix[k] > mix[most])) most = k;
        return most ? COUNTER_OF[most] : null;
    }

    getUnitToTrain(ai, building) {
        // Preferred picks per age, best first — but only what THIS building
        // actually offers (civ exclusions and uniques reshape the list: Egypt's
        // stable fields chariots, not generic cavalry). If nothing from the
        // ladder is offered, take the building's last option — uniques append
        // after the standard tiers, so that is the most advanced one.
        const ladders = {
            barracks: ai.age === 'iron' ? ['champion', 'warrior', 'militia'] : (ai.age === 'bronze' ? ['warrior', 'militia'] : ['militia']),
            archery_range: ai.age === 'iron' ? ['elite_archer', 'crossbowman', 'archer'] : ['archer'],
            stable: ai.age === 'iron' ? ['heavy_cavalry', 'cavalry', 'scout_cavalry'] : (ai.age === 'bronze' ? ['cavalry', 'scout_cavalry'] : ['scout_cavalry'])
        };
        const ladder = ladders[building.type];
        if (!ladder) return null;
        const opts = building.trainOptions || [];
        for (const id of ladder) if (opts.includes(id)) return id;
        return opts.length ? opts[opts.length - 1] : null;
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
        const out = new Set(), see = buildVisionTest(this.game, ai);
        for (const other of this.enemyOwners(ai)) {
            other.units.forEach(u => { if (u.health > 0 && see(u.x, u.z)) out.add(u); });
            other.buildings.forEach(b => { if (b.health > 0 && b.isWonder) out.add(b); });
        }
        ai._knownEnemyBuildings.forEach(b => { if (b && b.health > 0) out.add(b); else ai._knownEnemyBuildings.delete(b); });
        return [...out];
    }

    commandArmy(ai, military, enemyWonder) {
        if (!military.length) return;
        // Only commit the army when it's a real force, unless a Wonder must be razed.
        const P = this.profileOf(ai);
        const ready = military.length >= P.attackAt || (enemyWonder && military.length >= 1);
        if (!ready) return;

        const origin = military[0];
        // A rival Wonder outranks everything.
        let target = enemyWonder;
        if (!target) {
            const known = this.visibleEnemyTargets(ai);
            // A raider goes for the economy: the nearest worker it can see, if any.
            const prey = P.prey === 'workers' ? known.filter(e => e.type === 'worker') : [];
            let minD = Infinity;
            for (const e of (prey.length ? prey : known)) {
                const d = this.distance(origin, e);
                if (d < minD) { minD = d; target = e; }
            }
        }

        if (target) {
            military.forEach(unit => {
                // Already on it: leave the unit alone. Re-issuing the same order every
                // 2 s think reset attackTimer mid-swing and re-aimed units already in
                // melee at the target's centre, which cost the rule-based army about a
                // fifth of its damage in a measured 10v10 -- a self-handicap for the
                // baseline every model is compared against, and for Campaign.
                if (unit.isAttacking && unit.attackTarget === target) return;
                this.game.clearRetaliation(unit); // explicit order overrides the reflex
                unit.isAttacking = true;
                unit.attackTarget = target;
                unit.attackMove = { x: target.x, z: target.z };
                unit.attackTimer = 0;
                unit.isMoving = true;
                unit.targetX = target.x;
                unit.targetZ = target.z;
            });
            // Priests escort the assault as healers (never engage) — same as the
            // human and LLM attack paths.
            this.game.escortSupportUnits(ai.units, target.x, target.z);
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

            // Stuck means no longer getting closer, not slow. It used to mean 12 thinks
            // (24 s) on the leg, and an army walks about 85 units in that time, so no
            // leg longer than that was ever finished: the army turned round short of
            // every far target, milled within ~120 units of home, and two rule-based
            // seats played 45 minutes without meeting. Now a leg is given up only
            // after ~6 thinks in which the army got no closer than it had already been.
            const left = ai._armyScoutTarget ? this.distance({ x: cx, z: cz }, ai._armyScoutTarget) : Infinity;
            if (left < (ai._armyScoutBest == null ? Infinity : ai._armyScoutBest) - 5) {
                ai._armyScoutBest = left;
                ai._armyScoutTicks = 0;
            } else {
                ai._armyScoutTicks = (ai._armyScoutTicks || 0) + 1;
            }
            const arrived = ai._armyScoutTarget && left < 25;
            const stuck = ai._armyScoutTicks > 6;

            let newLeg = false;
            if (!ai._armyScoutTarget || arrived || stuck) {
                // A tile given up on is not chosen again: unexplored because it cannot
                // be walked to (water, a corner), it would stay the least explored and
                // hold the army against it for the rest of the match.
                if (stuck && !arrived && ai._armyScoutTarget && ai._armyScoutTarget.tile) {
                    (ai._armyLegSkip = ai._armyLegSkip || {})[ai._armyScoutTarget.tile] = true;
                }
                // The least-explored map tile it knows of, nearest first: the same 7x7
                // summary the models are shown, so the army searches with no more than a
                // model knows. A blind sweep with 15-unit sight could cross the map for
                // half an hour and never pass a rival's base.
                const leg = this.armyLeg(ai, { x: cx, z: cz }, half);
                if (leg) {
                    ai._armyScoutTarget = leg;
                } else {
                    // No exploration data (or the whole map is known): fan out from the
                    // base with the golden angle and a growing radius, out to the far
                    // side of the map. The target is clamped onto the map either way.
                    ai._armyScoutAngle = (ai._armyScoutAngle == null) ? this.game.rand(ai, 'army-scout') * Math.PI * 2 : ai._armyScoutAngle + 2.399963;
                    ai._armyScoutRadius = Math.min(4 * half, (ai._armyScoutRadius || 90) + 60);
                    ai._armyScoutTarget = {
                        x: Math.max(-half, Math.min(half, base.x + WarMath.cos(ai._armyScoutAngle) * ai._armyScoutRadius)),
                        z: Math.max(-half, Math.min(half, base.z + WarMath.sin(ai._armyScoutAngle) * ai._armyScoutRadius))
                    };
                }
                ai._armyScoutTicks = 0;
                ai._armyScoutBest = null;
                newLeg = true;
            }

            const tgt = ai._armyScoutTarget;
            military.forEach(unit => {
                if (unit.isAttacking && unit.attackTarget) return; // already engaged
                // Mid-leg, leave units that are already marching alone (no per-think
                // reset); only (re)issue the order on a new leg or to idle stragglers.
                if (!newLeg && unit.isMoving) return;
                this.game.clearRetaliation(unit);
                unit.isAttacking = true;
                unit.attackTarget = null;
                unit.attackMove = { x: tgt.x, z: tgt.z };
                unit.isMoving = true;
                unit.targetX = tgt.x;
                unit.targetZ = tgt.z;
            });
        }
    }

    // The army's next search leg: the centre of the least-explored tile of this seat's
    // exploration summary, the nearest of equals, skipping tiles it gave up on; null
    // without a summary or when no such tile is left. Row order breaks exact ties, so
    // it is deterministic.
    armyLeg(ai, from, half) {
        const g = this.game;
        if (!g.explorationSummary || !g.EXPLORE_TILES) return null;
        const sum = g.explorationSummary(ai), T = g.EXPLORE_TILES;
        const size = (g.terrain && g.terrain.size) || 800, tile = size / T;
        const skip = ai._armyLegSkip || {};
        let best = null;
        for (let r = 0; r < T; r++) for (let c = 0; c < T; c++) {
            const pct = sum[r][c];
            if (!(pct < 100) || skip[r + ',' + c]) continue;
            const x = Math.max(-half, Math.min(half, (c + 0.5) * tile - size / 2));
            const z = Math.max(-half, Math.min(half, (r + 0.5) * tile - size / 2));
            const d = WarMath.hypot(x - from.x, z - from.z);
            if (!best || pct < best.pct || (pct === best.pct && d < best.d)) best = { x, z, pct, d, tile: r + ',' + c };
        }
        return best ? { x: best.x, z: best.z, tile: best.tile } : null;
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
    // One candidate judged in place: far enough from own + player buildings, not
    // inside a resource node's clearance, and on solid map ground.
    isClearBuildSpot(ai, buildingType, isWonder, x, z) {
        const others = [...ai.buildings];
        if (this.game.player) others.push(...this.game.player.buildings);
        for (const b of others) {
            const gap = Game.buildingGap(isWonder ? 12 : 9, buildingType, isWonder, b);
            if (WarMath.hypot(b.x - x, b.z - z) < gap) return false;
        }
        if (this.game.isTooCloseToResource && this.game.isTooCloseToResource(x, z, buildingType, isWonder)) return false;
        if (this.game.clampToMap) {
            const c = this.game.clampToMap(x, z);
            if (Math.abs(c.x - x) > 0.5 || Math.abs(c.z - z) > 0.5) return false; // off-map
        }
        return true;
    }

    // Returns a valid {x,z} near the town centre or null — WITHOUT spending.
    findBuildPosition(ai, tc, buildingType, isWonder) {
        for (let attempts = 0; attempts < 24; attempts++) {
            const x = tc.x + (this.game.rand(ai, 'build-site') - 0.5) * 60;
            const z = tc.z + (this.game.rand(ai, 'build-site') - 0.5) * 60;
            if (this.isClearBuildSpot(ai, buildingType, isWonder, x, z)) return { x, z };
        }
        // A Wonder doesn't give up with the centre block: late-game bases fill the
        // whole 60-box, so sweep expanding rings (out to ~90 units) and take the
        // first clear spot — same widening a Wonder gets via build_structure.
        if (isWonder) {
            for (let radius = 14; radius <= 90; radius += 8) {
                const steps = Math.max(8, Math.round((2 * Math.PI * radius) / 12));
                const a0 = this.game.rand(ai, 'build-site') * Math.PI * 2;
                for (let s = 0; s < steps; s++) {
                    const ang = a0 + (s / steps) * 2 * Math.PI;
                    const x = tc.x + WarMath.cos(ang) * radius;
                    const z = tc.z + WarMath.sin(ang) * radius;
                    if (this.isClearBuildSpot(ai, buildingType, isWonder, x, z)) return { x, z };
                }
            }
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
        // Unique units (horse_carriage, hoplite, …) have no UNIT_DEFS entry.
        const unitDef = getUnitDefFor(ai.civilization, unitType);
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
        return WarMath.hypot(a.x - b.x, a.z - b.z);
    }
}
