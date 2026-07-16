// Unit definitions for all civilizations
const UNIT_DEFS = {
    worker: {
        id: 'worker',
        name: 'Dorfbewohner',
        cost: { food: 50, wood: 0, stone: 0, gold: 0 },
        health: 40,
        speed: 1.0,
        attack: 3,
        range: 0.5,
        type: 'worker',
        harvestRate: 1.0,
        buildSpeed: 1.0,
        description: 'Baut Gebäude und sammelt Ressourcen'
    },
    militia: {
        id: 'militia',
        name: 'Miliz',
        cost: { food: 50, wood: 20, stone: 0, gold: 0 },
        health: 70,
        speed: 1.1,
        attack: 7,
        range: 0.5,
        type: 'infantry',
        tier: 'stone',
        description: 'Grundlegende Infanterieeinheit'
    },
    warrior: {
        id: 'warrior',
        name: 'Krieger',
        cost: { food: 80, wood: 0, stone: 30, gold: 20 },
        health: 120,
        speed: 1.0,
        attack: 12,
        range: 0.5,
        type: 'infantry',
        tier: 'bronze',
        description: 'Starker Infanterist'
    },
    champion: {
        id: 'champion',
        name: 'Champion',
        cost: { food: 150, wood: 50, stone: 50, gold: 100 },
        health: 200,
        speed: 1.5,
        attack: 18,
        range: 0.5,
        type: 'infantry',
        tier: 'iron',
        description: 'Eliteeinheit'
    },
    archer: {
        id: 'archer',
        name: 'Bogenschütze',
        cost: { food: 60, wood: 30, stone: 0, gold: 0 },
        health: 40,
        speed: 1.0,
        attack: 6,
        range: 6,
        type: 'ranged',
        tier: 'neolithic',
        description: 'Fernkampf-Einheit'
    },
    crossbowman: {
        id: 'crossbowman',
        name: 'Armbrustschütze',
        cost: { food: 100, wood: 40, stone: 20, gold: 30 },
        health: 60,
        speed: 0.9,
        attack: 12,
        range: 6.75,
        type: 'ranged',
        tier: 'iron',
        description: 'Starker Fernkämpfer mit Armbrust'
    },
    elite_archer: {
        id: 'elite_archer',
        name: 'Elite-Bogenschütze',
        cost: { food: 150, wood: 60, stone: 30, gold: 50 },
        health: 80,
        speed: 1.1,
        attack: 16,
        range: 7.5,
        type: 'ranged',
        tier: 'iron',
        description: 'Elite Fernkampf-Einheit'
    },
    scout_cavalry: {
        id: 'scout_cavalry',
        name: 'Aufklärungskavallerie',
        cost: { food: 100, wood: 0, stone: 0, gold: 30 },
        health: 100,
        speed: 2.2,
        attack: 8,
        range: 0.5,
        type: 'cavalry',
        tier: 'neolithic',
        description: 'Schnelle Kavallerieeinheit'
    },
    cavalry: {
        id: 'cavalry',
        name: 'Reiter',
        cost: { food: 120, wood: 0, stone: 0, gold: 50 },
        health: 140,
        speed: 2.0,
        attack: 12,
        range: 0.5,
        type: 'cavalry',
        tier: 'bronze',
        description: 'Schwerer Reiter'
    },
    heavy_cavalry: {
        id: 'heavy_cavalry',
        name: 'Schwere Kavallerie',
        cost: { food: 180, wood: 0, stone: 50, gold: 80 },
        health: 200,
        speed: 1.8,
        attack: 18,
        range: 0.5,
        type: 'cavalry',
        tier: 'iron',
        description: 'Elite Kavallerie'
    },
    priest: {
        id: 'priest',
        name: 'Priester',
        cost: { food: 50, wood: 0, stone: 0, gold: 30 },
        health: 60,
        speed: 1.2,
        attack: 3,
        range: 3,
        type: 'support',
        tier: 'bronze',
        description: 'Heilt andere Einheiten in der Nähe'
    }
};

function getUnitDef(id) {
    return UNIT_DEFS[id] || null;
}

// The def a CIVILIZATION actually fields for `id`: its unique override wins over
// the shared entry, and unique-only ids (Egypt's horse_carriage) resolve too.
// EVERY cost/stat/label/tier lookup must come through here. The codebase used to
// split — unique-first when SPAWNING (createUnit) but shared-first when CHARGING
// (trainUnit, the LLM handler), DISPLAYING (the train card) and AGEING UP
// (upgradeFieldUnits) — so for any id present in BOTH tables the two disagreed:
// Persia was charged the shared archer's 90 but fielded its own 50 HP / 7 atk /
// 7.5 range one, and paid the shared cavalry's 170 for a unique carrying 20 LESS
// health. A unique must therefore repeat its shared entry's `tier`; the age gates
// read it from whatever this returns.
function getUnitDefFor(civilization, id) {
    const civ = (typeof getCivilization === 'function') ? getCivilization(civilization) : null;
    return ((civ && civ.uniqueUnits) || []).find(u => u.id === id) || getUnitDef(id);
}

// Create a unit instance
function createUnit(type, x, z, owner, civilization, age) {
    const civ = getCivilization(civilization);
    const unitDef = getUnitDefFor(civilization, type);
    if (!unitDef) return null;

    // Resolve the owner object once, up front: its seat drives the team badge
    // (the per-player ownership circle) and it feeds the bonus catch-up below.
    const ownerObj = (typeof game !== 'undefined' && game)
        ? (owner === 'player' ? game.player
            : (game.aiManager ? game.aiManager.aiPlayers.find(a => a.id === owner) : null))
        : null;

    const unit = {
        id: 'unit_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
        type: type,
        name: unitDef.name,
        x: x,
        z: z,
        health: unitDef.health,
        maxHealth: unitDef.health,
        speed: unitDef.speed,
        attack: unitDef.attack,
        range: unitDef.range,
        unitType: unitDef.type,
        owner: owner,
        civilization: civilization,
        color: civ.color, // Always use civilization color (important for spectator mode)
        seat: (ownerObj && ownerObj.seat != null) ? ownerObj.seat : null, // team badge (ownership circle)
        currentTier: age || 'stone', // Track the age/tier this unit was created at
        targetX: x,
        targetZ: z,
        isMoving: false,
        isAttacking: false,
        attackTarget: null,
        harvestTarget: null,
        harvestAmount: 0,
        maxHarvest: 15,
        isHarvesting: false,
        isBuilding: false,
        buildProgress: 0,
        selected: false,
        mesh: null,
        healthBar: null,
        harvestRate: unitDef.harvestRate || 1.0,
        buildSpeed: unitDef.buildSpeed || 1.0
    };

    // Researched bonuses (Quick Hands & co.) apply at spawn too — otherwise a
    // research quietly split the roster into boosted veterans and raw recruits.
    if (ownerObj && typeof game !== 'undefined' && game && game.applyResearchedBonusesToUnit) {
        game.applyResearchedBonusesToUnit(unit, ownerObj);
    }
    return unit;
}

// Create a building instance.
// options.underConstruction => starts as a construction site (low HP, not yet functional);
// a worker must build it up over buildingDef.buildTime before it works.
const BUILDING_AGE_ORDER = ['stone', 'neolithic', 'bronze', 'iron'];

// Max HP for a building of a given def/civ/age. Each epoch adds 50% over the
// previous one (×1.5 per age), rounded to the nearest 50 for clean numbers.
//
// WONDERS ARE EXEMPT FROM BOTH multipliers. A wonder is the win condition — you
// hold it for 180s under an all-hands assault — so its HP IS the endgame matchup
// and it gets balanced on its own terms, not as a side effect of a bonus meant
// for barracks. The civ health bonus used to land here and spread final wonder HP
// across 2.44x: Persia's Fire Temple stood at 800 while Greece's Akropolis stood
// at 1950, and the def said 800 and 1500. Now the number in the def is the number
// on the field, and every civ defends the same wall. Pyramide/Akropolis still
// govern every other building those civs own.
function buildingMaxHealth(buildingDef, civ, age) {
    if (buildingDef.type === 'wonder') return Math.max(50, buildingDef.health);
    const healthMultiplier = (civ && civ.bonus && civ.bonus.name === 'Pyramide') ? 1.5 :
                             (civ && civ.bonus && civ.bonus.name === 'Akropolis') ? 1.3 : 1.0;
    const idx = Math.max(0, BUILDING_AGE_ORDER.indexOf(age));
    return Math.max(50, Math.round(buildingDef.health * Math.pow(1.5, idx) * healthMultiplier / 50) * 50);
}

// Morph an existing building to a newer epoch: bump its age, rescale max HP
// (preserving the current damage ratio) and report whether anything changed so
// the caller can rebuild its mesh. Never downgrades; skips wonders.
function upgradeBuildingToAge(building, newAge) {
    if (!building || BUILDING_AGE_ORDER.indexOf(newAge) < 0) return false;
    if (BUILDING_AGE_ORDER.indexOf(newAge) <= BUILDING_AGE_ORDER.indexOf(building.age)) return false;
    const civ = getCivilization(building.civilization);
    const uniqueBuilding = civ.uniqueBuildings.find(b => b.id === building.type);
    const buildingDef = uniqueBuilding || BUILDING_DEFS[building.type];
    if (!buildingDef || buildingDef.type === 'wonder') return false;
    const ratio = building.maxHealth > 0 ? (building.health / building.maxHealth) : 1;
    building.age = newAge;
    building.maxHealth = buildingMaxHealth(buildingDef, civ, newAge);
    building.health = Math.max(1, Math.round(building.maxHealth * ratio));
    // A tower's bite morphs with the epoch too — not just its walls.
    if (building.type === 'tower' && typeof towerPower === 'function') {
        building.attack = towerPower(newAge).attack;
    }
    return true;
}

function createBuilding(type, x, z, owner, civilization, options) {
    const civ = getCivilization(civilization);
    const uniqueBuilding = civ.uniqueBuildings.find(b => b.id === type);
    const buildingDef = uniqueBuilding || BUILDING_DEFS[type];

    if (!buildingDef) return null;

    // Owner's seat → team badge (the ownership circle on the banner flag).
    const ownerObj = (typeof game !== 'undefined' && game)
        ? (owner === 'player' ? game.player
            : (game.aiManager ? game.aiManager.aiPlayers.find(a => a.id === owner) : null))
        : null;

    // The epoch this building is constructed in drives both its look and its HP.
    // Owners morph their buildings to the new epoch when they age up (see
    // upgradeBuildingToAge / game.morphBuildingsToAge).
    const age = (options && options.age && BUILDING_AGE_ORDER.includes(options.age)) ? options.age : 'stone';

    const underConstruction = !!(options && options.underConstruction);
    const maxHealth = buildingMaxHealth(buildingDef, civ, age);
    const buildTime = buildingDef.buildTime || 10000;

    return {
        id: 'building_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
        type: type,
        name: buildingDef.name,
        age: age, // epoch this building was constructed in (drives its look + HP)
        x: x,
        z: z,
        // Face the map center (doors sit on a mesh's +Z side), snapped to 90°
        // steps so walls stay parallel to the map edges. Purely visual —
        // collision gaps and vision are all radial.
        rotationY: Math.round(Math.atan2(-x, -z) / (Math.PI / 2)) * (Math.PI / 2),
        // Construction sites start partially built and ramp up as workers build them
        underConstruction: underConstruction,
        buildProgress: 0,
        buildTime: buildTime,
        isWonder: buildingDef.type === 'wonder',
        health: underConstruction ? Math.max(1, maxHealth * 0.2) : maxHealth,
        maxHealth: maxHealth,
        owner: owner,
        civilization: civilization,
        color: owner === 'player' ? 0x4ecca3 : 0xff4444,
        seat: (ownerObj && ownerObj.seat != null) ? ownerObj.seat : null, // team badge (ownership circle)
        selected: false,
        mesh: null,
        healthBar: null,
        canTrain: buildingDef.canTrain || false,
        canResearch: buildingDef.canResearch || false,
        trainOptions: buildingDef.trainOptions || [],
        researchOptions: buildingDef.researchOptions || [],
        productionQueue: [],
        isProducing: false,
        productionProgress: 0,
        productionTime: 0,
        productionDuration: 0,
        // Towers bite harder each epoch (TOWER_POWER), like their HP already does.
        attack: (type === 'tower' && typeof towerPower === 'function')
            ? towerPower(age).attack : (buildingDef.attack || 0),
        range: buildingDef.range || 0,
        // Farm-specific properties
        foodAmount: type === 'farm' ? 300 : 0,
        maxFoodAmount: type === 'farm' ? 300 : 0,
        regenTimer: type === 'farm' ? 0 : undefined,
        assignedWorker: type === 'farm' ? null : undefined
    };
}

// Building definitions are now in buildings.js
