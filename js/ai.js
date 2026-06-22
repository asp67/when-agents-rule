// AI system for computer opponents
class AIManager {
    constructor(game) {
        this.game = game;
        this.aiPlayers = [];
        this.thinkTimer = 0;
        this.thinkInterval = 2000; // Think every 2 seconds
        this.openAIControlled = new Set(); // Set of AI player IDs controlled by OpenAI
    }

    // Mark an AI player as controlled by OpenAI (skip rule-based AI for it)
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
            state: 'economic', // economic, military, wonder
            stateTimer: 0,
            buildQueue: [],
            attackTarget: null,
            lastThink: Date.now(),
            workerHarvestBonus: 1.0,
            trainSpeedBonus: 1.0,
            techCostMultiplier: 1.0,
            buildingHealthMultiplier: 1.0,
            pendingBuildings: [],
            researchedTechs: {},  // Track researched techs (one-time purchase)
            unlockedBuildings: {},  // Buildings unlocked by techs
            unlockedUnits: {},       // Units unlocked by techs
            currentResearch: null    // { techId, progress, duration }
        };
        this.aiPlayers.push(ai);
        return ai;
    }

    update(deltaTime) {
        this.thinkTimer += deltaTime;
        
        if (this.thinkTimer >= this.thinkInterval) {
            this.thinkTimer = 0;
            this.think();
        }
    }

    think() {
        this.aiPlayers.forEach(ai => {
            // Skip AI players controlled by OpenAI
            if (this.openAIControlled.has(ai.id)) return;

            // A rival Wonder is existential: switch to military so we train & march on it.
            const enemyWonder = this.game.getAllBuildings().some(b => b.isWonder && b.health > 0 && !ai.buildings.includes(b));
            if (enemyWonder) ai.state = 'military';

            // Assign idle workers to harvest
            this.assignWorkersToHarvest(ai);

            // Occasionally send a spare unit to scout, revealing the map (and enemies).
            this.exploreMap(ai);
            
            // Decide what to do based on current state
            switch (ai.state) {
                case 'economic':
                    this.economicStrategy(ai);
                    break;
                case 'military':
                    this.militaryStrategy(ai);
                    break;
                case 'wonder':
                    this.wonderStrategy(ai);
                    break;
            }

            // Check if we should change state
            ai.stateTimer++;
            if (ai.stateTimer > 20) {
                ai.stateTimer = 0;
                this.decideState(ai);
            }
        });
    }

    decideState(ai) {
        // Check if we should build wonder
        const wonderDef = this.getWonderForCiv(ai.civilization);
        if (wonderDef && ai.resources.food >= wonderDef.cost.food * 0.8 && 
            ai.resources.wood >= wonderDef.cost.wood * 0.8) {
            ai.state = 'wonder';
            return;
        }

        // Check if we should upgrade age
        const nextAge = this.getNextAge(ai.age);
        if (nextAge && this.canAffordAgeUpgrade(ai, nextAge)) {
            this.upgradeAge(ai, nextAge);
        }
        
        // Research techs
        this.researchTechs(ai);

        // Decide between economic and military
        const militaryUnits = ai.units.filter(u => u.type !== 'worker').length;
        const workers = ai.units.filter(u => u.type === 'worker').length;
        
        if (militaryUnits < 5 || workers < 8) {
            ai.state = 'economic';
        } else if (ai.resources.food > 300 && ai.resources.wood > 200) {
            ai.state = 'military';
        } else {
            ai.state = 'economic';
        }
    }

    researchTechs(ai) {
        const civ = getCivilization(ai.civilization);
        const techs = civ.techTree || {};
        const ageOrder = ['stone', 'neolithic', 'bronze', 'iron'];
        const currentAgeIndex = ageOrder.indexOf(ai.age);
        
        // If AI is currently researching, update progress
        if (ai.currentResearch) {
            ai.currentResearch.progress += this.thinkInterval;
            if (ai.currentResearch.progress >= ai.currentResearch.duration) {
                const tech = techs[ai.currentResearch.techId];
                ai.researchedTechs[ai.currentResearch.techId] = true;
                
                // Apply unlocks
                if (tech?.unlocks) {
                    if (tech.unlocks.buildings) {
                        for (const bldg of tech.unlocks.buildings) {
                            ai.unlockedBuildings[bldg] = true;
                        }
                    }
                }
                
                // Apply stat bonuses
                if (tech?.bonus) {
                    if (tech.bonus.harvestRate && tech.appliesTo === 'worker') {
                        ai.workerHarvestBonus = (ai.workerHarvestBonus || 1) + tech.bonus.harvestRate;
                    }
                    if (tech.bonus.trainSpeed) {
                        ai.trainSpeedBonus = (ai.trainSpeedBonus || 1) + tech.bonus.trainSpeed;
                    }
                    if (tech.appliesTo === 'all_military' || tech.appliesTo === 'infantry' || 
                        tech.appliesTo === 'cavalry' || tech.appliesTo === 'ranged') {
                        ai.units.forEach(unit => {
                            if (unit.type === 'worker') return;
                            const matches = tech.appliesTo === 'all_military' || tech.appliesTo === unit.unitType;
                            if (matches) {
                                if (tech.bonus.attack) unit.attack += tech.bonus.attack;
                                if (tech.bonus.health) {
                                    unit.health = Math.min(unit.health + tech.bonus.health, unit.maxHealth + tech.bonus.health);
                                    unit.maxHealth += tech.bonus.health;
                                }
                                if (tech.bonus.range) unit.range += tech.bonus.range;
                            }
                        });
                    }
                }
                
                this.updateAITrainOptions(ai);
                ai.currentResearch = null;
            }
            return; // Already researching, don't start new research
        }
        
        // Get available techs for current age
        const availableTechs = Object.keys(techs).filter(techId => {
            const tech = techs[techId];
            if (ai.researchedTechs[techId]) return false; // Already researched
            
            // Check age requirement
            if (tech.requiredAge) {
                const requiredAgeIndex = ageOrder.indexOf(tech.requiredAge);
                if (requiredAgeIndex > currentAgeIndex) return false;
            }
            
            // Check prerequisites
            if (tech.requires && tech.requires.length > 0) {
                for (const req of tech.requires) {
                    if (!ai.researchedTechs[req]) return false;
                }
            }
            
            // Check if we have the building to research this tech
            if (tech.researchAt === 'town_center') {
                return ai.buildings.some(b => b.type === 'town_center');
            } else if (tech.researchAt === 'market') {
                return ai.buildings.some(b => b.type === 'market');
            }
            
            return false;
        });
        
        // Prioritize unlock techs first (horseback, longbow, marketTech), then stat bonuses
        availableTechs.sort((a, b) => {
            const aTech = techs[a];
            const bTech = techs[b];
            const aUnlocks = aTech.unlocks ? 1 : 0;
            const bUnlocks = bTech.unlocks ? 1 : 0;
            return bUnlocks - aUnlocks; // Unlock techs first
        });
        
        // Try to research affordable techs
        for (const techId of availableTechs) {
            const tech = techs[techId];
            const costMultiplier = ai.techCostMultiplier || 1;
            const adjustedCost = {
                food: Math.floor((tech.cost.food || 0) * costMultiplier),
                wood: Math.floor((tech.cost.wood || 0) * costMultiplier),
                stone: Math.floor((tech.cost.stone || 0) * costMultiplier),
                gold: Math.floor((tech.cost.gold || 0) * costMultiplier)
            };
            
            if (ai.resources.food >= adjustedCost.food &&
                ai.resources.wood >= adjustedCost.wood &&
                ai.resources.stone >= adjustedCost.stone &&
                ai.resources.gold >= adjustedCost.gold) {
                
                // Research the tech (start progress)
                ai.resources.food -= adjustedCost.food;
                ai.resources.wood -= adjustedCost.wood;
                ai.resources.stone -= adjustedCost.stone;
                ai.resources.gold -= adjustedCost.gold;
                
                ai.currentResearch = {
                    techId: techId,
                    progress: 0,
                    duration: tech.researchTime || 15000
                };
                
                break; // Research one tech per think cycle
            }
        }
    }

    updateAITrainOptions(ai) {
        ai.buildings.forEach(building => {
            const options = getTrainOptionsForBuilding(building.type, ai.age);
            if (options.length > 0) {
                building.trainOptions = options;
            }
        });
    }

    assignWorkersToHarvest(ai) {
        const workers = ai.units.filter(u => u.type === 'worker');
        // A worker walking to a build site is not "isMoving"/"isBuilding" yet, so
        // also exclude anyone already assigned to build or tend a farm.
        const idleWorkers = workers.filter(w => !w.isMoving && !w.isHarvesting && !w.carryingResource &&
            !w.isBuilding && w.task !== 'building' && w.task !== 'farm_work');
        
        // What does the economy need most right now? Food gates workers, age-ups AND
        // military, so keep it flowing; otherwise gather the scarcest resource. Without
        // this the AI just grabbed the nearest node (often all wood) and could STARVE —
        // food stuck at 0, unable to train, advance or go military.
        const wantType = this.neededResourceType(ai);

        idleWorkers.forEach(worker => {
            // Prefer the needed resource type (anywhere on the map); fall back to the
            // nearest node of any type if none of that type is left.
            const nearestResource = this.findNearestResourceOfType(worker, wantType) || this.findNearestResource(worker);
            if (nearestResource) {
                worker.task = 'harvesting';
                worker.harvestTarget = nearestResource;
                worker.isMoving = true;
                worker.targetX = nearestResource.x + (Math.random() - 0.5) * 2;
                worker.targetZ = nearestResource.z + (Math.random() - 0.5) * 2;
                worker.carryingResource = false;
                worker.harvestAmount = 0;
            }
        });
    }

    // Periodically dispatch ONE spare scout toward an unexplored frontier so the map
    // (and any hidden resources/enemies) gets revealed. Prefers an idle military unit
    // so the economy is never disturbed; falls back to a genuinely idle worker only if
    // no military is free. Throttled so it doesn't thrash a unit every tick.
    exploreMap(ai) {
        ai._exploreTimer = (ai._exploreTimer || 0) + 1;
        if (ai._exploreTimer < 8) return;

        const idleMilitary = ai.units.find(u => u.type !== 'worker' &&
            !u.isAttacking && !u.attackTarget && !u.attackMove && !u.isMoving);
        const idleWorker = ai.units.find(u => u.type === 'worker' &&
            !u.isMoving && !u.isHarvesting && !u.carryingResource && !u.isBuilding &&
            !u.farmRef && u.task !== 'building' && u.task !== 'farm_work');
        const scout = idleMilitary || idleWorker;
        if (!scout) return; // nothing to spare — try again next tick (keep workers gathering)

        ai._exploreTimer = 0;
        const half = (this.game.terrain ? this.game.terrain.size : 800) / 2 - 40;
        scout.task = scout.type === 'worker' ? 'scouting' : null;
        scout.isMoving = true;
        scout.targetX = (Math.random() - 0.5) * 2 * half;
        scout.targetZ = (Math.random() - 0.5) * 2 * half;
    }

    // Which resource the economy should gather next. Food gates workers, age-ups and
    // military, so keep a buffer of it; once food is comfortable, gather the scarcest
    // of the four so wood/stone/gold also come in for buildings and units.
    neededResourceType(ai) {
        const r = ai.resources;
        if (r.food < 200) return 'food';
        const stock = { food: r.food, wood: r.wood, gold: r.gold, stone: r.stone };
        let best = 'wood', bestVal = Infinity;
        for (const t of ['food', 'wood', 'gold', 'stone']) {
            if (stock[t] < bestVal) { bestVal = stock[t]; best = t; }
        }
        return best;
    }

    // Nearest node of a specific type with anything left (no distance cap), or null.
    findNearestResourceOfType(unit, type) {
        if (!this.game.terrain || !this.game.terrain.resources) return null;
        let nearest = null, minDist = Infinity;
        this.game.terrain.resources.forEach(resource => {
            if (resource.amount <= 0 || resource.type !== type) return;
            const d = Math.hypot(resource.x - unit.x, resource.z - unit.z);
            if (d < minDist) { minDist = d; nearest = resource; }
        });
        return nearest;
    }

    findNearestResource(unit) {
        if (!this.game.terrain || !this.game.terrain.resources) return null;

        let nearest = null;
        let minDist = Infinity;

        // No distance cap: take the nearest node with anything left, ANYWHERE on the
        // map. Capping at 50 stranded workers (idle forever) once the home cluster ran
        // dry; without it they walk out to the next deposit — gathering from, and
        // revealing, the rest of the map instead of deadlocking.
        this.game.terrain.resources.forEach(resource => {
            if (resource.amount <= 0) return;
            const dx = resource.x - unit.x;
            const dz = resource.z - unit.z;
            const dist = Math.sqrt(dx * dx + dz * dz);
            if (dist < minDist) {
                minDist = dist;
                nearest = resource;
            }
        });

        return nearest;
    }

    economicStrategy(ai) {
        // Train workers if we have town centers and can afford them
        const townCenters = ai.buildings.filter(b => b.type === 'town_center');
        const workers = ai.units.filter(u => u.type === 'worker').length;
        
        townCenters.forEach(tc => {
            if (!tc.isProducing && workers < 15 && ai.resources.food >= 50) {
                this.trainUnit(ai, 'worker', tc);
            }
        });

        // Build farms if low on food and we have enough workers
        if (ai.resources.food < 200 && workers >= 5) {
            const farms = ai.buildings.filter(b => b.type === 'farm').length;
            if (farms < 5 && ai.resources.wood >= 50) {
                this.buildStructure(ai, 'farm');
            }
        }

        // Build houses for population
        if (ai.units.length >= 8) {
            const houses = ai.buildings.filter(b => b.type === 'house').length;
            if (houses < 3 && ai.resources.wood >= 20) {
                this.buildStructure(ai, 'house');
            }
        }

        // Build market for trading (only if marketTech is researched)
        if (ai.buildings.filter(b => b.type === 'market').length === 0 && 
            ai.researchedTechs['marketTech'] &&
            ai.resources.food >= 100 && ai.resources.wood >= 100) {
            this.buildStructure(ai, 'market');
        }
        
        // Build stable if horseback tech is researched
        if (ai.buildings.filter(b => b.type === 'stable').length === 0 && 
            ai.researchedTechs['horseback'] &&
            ai.resources.food >= 100 && ai.resources.wood >= 100 && ai.resources.gold >= 50) {
            this.buildStructure(ai, 'stable');
        }
        
        // Build archery range if longbow tech is researched
        if (ai.buildings.filter(b => b.type === 'archery_range').length === 0 && 
            ai.researchedTechs['longbow'] &&
            ai.resources.food >= 50 && ai.resources.wood >= 100 && ai.resources.stone >= 50) {
            this.buildStructure(ai, 'archery_range');
        }
    }

    militaryStrategy(ai) {
        // Build military buildings if we don't have them
        const barracks = ai.buildings.filter(b => b.type === 'barracks');
        if (barracks.length === 0 && ai.resources.wood >= 150 && ai.resources.food >= 50) {
            this.buildStructure(ai, 'barracks');
            return;
        }

        const archeryRanges = ai.buildings.filter(b => b.type === 'archery_range');
        if (archeryRanges.length === 0 && ai.researchedTechs['longbow'] && 
            ai.resources.wood >= 100 && ai.resources.stone >= 50) {
            this.buildStructure(ai, 'archery_range');
            return;
        }
        
        const stables = ai.buildings.filter(b => b.type === 'stable');
        if (stables.length === 0 && ai.researchedTechs['horseback'] && 
            ai.resources.food >= 100 && ai.resources.wood >= 100 && ai.resources.gold >= 50) {
            this.buildStructure(ai, 'stable');
            return;
        }

        // Train military units
        const militaryBuildings = ai.buildings.filter(b => b.canTrain && b.type !== 'town_center');
        militaryBuildings.forEach(building => {
            if (!building.isProducing) {
                // Train appropriate units based on age and tech requirements
                const unitType = this.getUnitToTrain(ai, building);
                if (unitType) {
                    this.trainUnit(ai, unitType, building);
                }
            }
        });

        // Attack once we have an army — OR immediately (even a tiny force) if a rival
        // Wonder exists, since a finished Wonder loses the game for everyone else.
        const militaryUnits = ai.units.filter(u => u.type !== 'worker');
        const enemyWonder = this.game.getAllBuildings().some(b => b.isWonder && b.health > 0 && !ai.buildings.includes(b));
        if (militaryUnits.length >= 8 || (enemyWonder && militaryUnits.length >= 1)) {
            this.attackPlayer(ai, militaryUnits);
        }
    }

    getUnitToTrain(ai, building) {
        // Train appropriate units based on building type and age
        switch (building.type) {
            case 'barracks':
                if (ai.age === 'iron') return 'warrior';
                return 'militia';
            case 'archery_range':
                if (ai.age === 'iron') return 'elite_archer';
                return 'archer';
            case 'stable':
                if (ai.age === 'iron') return 'heavy_cavalry';
                return 'scout_cavalry';
            default:
                return null;
        }
    }

    attackPlayer(ai, militaryUnits) {
        if (!militaryUnits.length) return;
        const origin = militaryUnits[0];

        // Gather all enemy entities: the human (empty in spectator/arena) + other AIs.
        const enemyUnits = [];
        const enemyBuildings = [];
        if (this.game.player) {
            this.game.player.units.forEach(u => enemyUnits.push(u));
            this.game.player.buildings.forEach(b => enemyBuildings.push(b));
        }
        this.aiPlayers.forEach(other => {
            if (other === ai) return;
            other.units.forEach(u => enemyUnits.push(u));
            other.buildings.forEach(b => enemyBuildings.push(b));
        });

        // Priority 1: a rival WONDER is an existential threat — raze it above all else.
        let target = enemyBuildings.find(b => b.isWonder && b.health > 0) || null;
        // Otherwise hit the nearest enemy unit or building.
        if (!target) {
            let minDist = Infinity;
            const consider = (e) => {
                if (!e || e.health <= 0) return;
                const d = this.distance(origin, e);
                if (d < minDist) { minDist = d; target = e; }
            };
            enemyUnits.forEach(consider);
            enemyBuildings.forEach(consider);
        }

        if (target) {
            militaryUnits.forEach(unit => {
                unit.isAttacking = true;
                unit.attackTarget = target;
                unit.attackMove = { x: target.x, z: target.z }; // pursue + re-acquire nearby
                unit.attackTimer = 0;
                unit.isMoving = true;
                unit.targetX = target.x;
                unit.targetZ = target.z;
            });
        }
    }

    wonderStrategy(ai) {
        const wonderDef = this.getWonderForCiv(ai.civilization);
        if (!wonderDef) return;

        // Only one wonder at a time, and only from the required age (Iron)
        if (ai.buildings.some(b => b.isWonder)) return;
        const ageOrder = ['stone', 'neolithic', 'bronze', 'iron'];
        if (ageOrder.indexOf(ai.age) < ageOrder.indexOf(wonderDef.requiredAge || 'iron')) return;

        // Check if we can build wonder
        if (ai.resources.food >= wonderDef.cost.food &&
            ai.resources.wood >= wonderDef.cost.wood &&
            ai.resources.stone >= wonderDef.cost.stone &&
            ai.resources.gold >= wonderDef.cost.gold) {
            
            // Build wonder near town center
            const townCenters = ai.buildings.filter(b => b.type === 'town_center');
            if (townCenters.length > 0) {
                const tc = townCenters[0];
                const wonder = createBuilding(wonderDef.id, tc.x + 10, tc.z + 10, 'ai', ai.civilization, { underConstruction: true, age: ai.age });
                ai.buildings.push(wonder);
                this.game.renderer.addBuilding(wonder);
                this.game.assignBuilderTo(ai, wonder, { forceBorrow: true });
                
                // Deduct resources
                ai.resources.food -= wonderDef.cost.food;
                ai.resources.wood -= wonderDef.cost.wood;
                ai.resources.stone -= wonderDef.cost.stone;
                ai.resources.gold -= wonderDef.cost.gold;
            }
        }
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

    canAffordAgeUpgrade(ai, nextAge) {
        const ageCosts = {
            'neolithic': { food: 1000, wood: 800, stone: 0, gold: 0 },
            'bronze': { food: 2000, wood: 1500, stone: 400, gold: 200 },
            'iron': { food: 4000, wood: 3000, stone: 1000, gold: 600 }
        };
        
        const cost = ageCosts[nextAge];
        if (!cost) return false;
        
        return ai.resources.food >= cost.food &&
               ai.resources.wood >= cost.wood &&
               ai.resources.stone >= cost.stone &&
               ai.resources.gold >= cost.gold;
    }

    upgradeAge(ai, nextAge) {
        const ageCosts = {
            'neolithic': { food: 1000, wood: 800, stone: 0, gold: 0 },
            'bronze': { food: 2000, wood: 1500, stone: 400, gold: 200 },
            'iron': { food: 4000, wood: 3000, stone: 1000, gold: 600 }
        };
        
        const cost = ageCosts[nextAge];
        if (!cost) return;
        
        ai.resources.food -= cost.food;
        ai.resources.wood -= cost.wood;
        ai.resources.stone -= cost.stone;
        ai.resources.gold -= cost.gold;
        
        ai.age = nextAge;

        // Update train options for military buildings
        ai.buildings.forEach(building => {
            const options = getTrainOptionsForBuilding(building.type, nextAge);
            if (options.length > 0) {
                building.trainOptions = options;
            }
        });

        // Morph existing buildings to the new epoch (look + HP)
        if (this.game && this.game.morphBuildingsToAge) {
            this.game.morphBuildingsToAge(ai.buildings, nextAge);
        }
    }

    trainUnit(ai, unitType, building) {
        const unitDef = getUnitDef(unitType);
        if (!unitDef) return;

        // Check if AI has resources
        const cost = unitDef.cost;
        if (!cost) return;
        
        const canAfford = (
            ai.resources.food >= (cost.food || 0) &&
            ai.resources.wood >= (cost.wood || 0) &&
            ai.resources.stone >= (cost.stone || 0) &&
            ai.resources.gold >= (cost.gold || 0)
        );
        
        if (!canAfford) return;

        ai.resources.food -= cost.food || 0;
        ai.resources.wood -= cost.wood || 0;
        ai.resources.stone -= cost.stone || 0;
        ai.resources.gold -= cost.gold || 0;
        
        building.isProducing = true;
        building.productionDuration = 5000; // 5 seconds to train
        building.productionProgress = 0;
        building.productionType = unitType;
    }

    buildStructure(ai, buildingType) {
        const buildingDef = getBuildingDef(buildingType);
        if (!buildingDef) return;

        const cost = buildingDef.cost;
        const canAfford = (
            ai.resources.food >= (cost.food || 0) &&
            ai.resources.wood >= (cost.wood || 0) &&
            ai.resources.stone >= (cost.stone || 0) &&
            ai.resources.gold >= (cost.gold || 0)
        );
        
        if (!canAfford) return;

        ai.resources.food -= cost.food || 0;
        ai.resources.wood -= cost.wood || 0;
        ai.resources.stone -= cost.stone || 0;
        ai.resources.gold -= cost.gold || 0;

        // Find valid placement position near town center
        const townCenters = ai.buildings.filter(b => b.type === 'town_center');
        if (townCenters.length === 0) return;
        
        const tc = townCenters[0];
        let x, z, valid = false;
        let attempts = 0;
        while (!valid && attempts < 20) {
            // Spread buildings over a larger footprint (~2x the old area).
            x = tc.x + (Math.random() - 0.5) * 60;
            z = tc.z + (Math.random() - 0.5) * 60;
            valid = true;

            // Check against all buildings
            const allBuildings = [...ai.buildings, ...this.game.player.buildings];
            for (const b of allBuildings) {
                const dx = b.x - x;
                const dz = b.z - z;
                if (Math.sqrt(dx*dx + dz*dz) < 9) {
                    valid = false;
                    break;
                }
            }
            // Keep an exclusion zone around resource nodes (harvesters must reach them).
            if (valid && this.game.isTooCloseToResource(x, z, buildingType, false)) {
                valid = false;
            }
            attempts++;
        }

        if (!valid) return;

        const building = createBuilding(buildingType, x, z, 'ai', ai.civilization, { underConstruction: true, age: ai.age });
        ai.buildings.push(building);
        this.game.renderer.addBuilding(building);
        this.game.assignBuilderTo(ai, building, { forceBorrow: true });
    }

    distance(unit1, unit2) {
        const dx = unit1.x - unit2.x;
        const dz = unit1.z - unit2.z;
        return Math.sqrt(dx * dx + dz * dz);
    }
}
