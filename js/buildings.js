// Hard ceiling on population for every player. Houses raise the cap up to here
// and no further — beyond this you must delete units to make room.
const MAX_POPULATION_CAP = 100;

// Base durations in milliseconds
const WORKER_TRAIN_TIME = 5000;  // 5 seconds to train a worker
const BASE_RESEARCH_TIME = WORKER_TRAIN_TIME * 3;  // 15 seconds for simple stone age research
const BASE_BUILD_TIME = WORKER_TRAIN_TIME * 2;  // 10 seconds for building construction
const AGE_UPGRADE_TIME = BASE_RESEARCH_TIME * 2;  // 30 seconds for age upgrade

// Building definitions - exported for use in other modules
const BUILDING_DEFS = {
    town_center: {
        id: 'town_center',
        name: 'Dorfzentrum',
        cost: { food: 100, wood: 100, stone: 100, gold: 100 },
        health: 1000,
        type: 'economic',
        canTrain: true,
        trainOptions: ['worker'],
        canResearch: true,
        researchOptions: [], // Filled dynamically from civ techTree (researchAt: 'town_center')
        requiredAge: 'stone',
        description: 'Zentrale Gebäude - baut Dorfbewohner, forscht Altsteinzeit-Technologien',
        buildTime: BASE_BUILD_TIME * 1.5  // 15 seconds to build
    },
    house: {
        id: 'house',
        name: 'Haus',
        cost: { food: 30, wood: 20, stone: 0, gold: 0 },
        health: 300,
        type: 'economic',
        popBonus: 5,
        requiredAge: 'stone',
        requiresTech: 'house',
        description: 'Erhöht das Bevölkerungslimit um 5 (benötigt Forschung: Haus)',
        buildTime: BASE_BUILD_TIME * 0.5  // 5 seconds to build
    },
    temple: {
        id: 'temple',
        name: 'Tempel',
        cost: { food: 100, wood: 100, stone: 150, gold: 100 },
        health: 800,
        type: 'religious',
        canTrain: true,
        trainOptions: ['priest'],
        canResearch: true, // hosts temple research (Heilkunde)
        requiredAge: 'bronze',
        description: 'Ausbildung von Priestern',
        buildTime: BASE_BUILD_TIME * 2  // 20 seconds to build
    },
    barracks: {
        id: 'barracks',
        name: 'Kaserne',
        cost: { food: 50, wood: 150, stone: 0, gold: 0 },
        health: 800,
        type: 'military',
        canTrain: true,
        trainOptions: [], // Filled dynamically based on age
        requiredAge: 'stone',
        requiresTech: 'barracks',
        description: 'Ausbildung von Infanterie (benötigt Forschung: Kaserne)',
        buildTime: BASE_BUILD_TIME * 1.5  // 15 seconds to build
    },
    stable: {
        id: 'stable',
        name: 'Stall',
        cost: { food: 100, wood: 100, stone: 0, gold: 50 },
        health: 700,
        type: 'military',
        canTrain: true,
        trainOptions: [], // Filled dynamically based on age
        requiredAge: 'neolithic',
        requiresTech: 'horseback',  // Requires horseback riding tech
        // No tech name in the text: the unlocking tech differs per civ (Persia's
        // Horse Breeding vs Egypt's Horse carriage) — menus append it dynamically.
        description: 'Ausbildung von Kavallerie',
        buildTime: BASE_BUILD_TIME * 1.5  // 15 seconds to build
    },
    archery_range: {
        id: 'archery_range',
        name: 'Bogenschützenstand',
        cost: { food: 50, wood: 100, stone: 50, gold: 0 },
        health: 600,
        type: 'military',
        canTrain: true,
        trainOptions: [], // Filled dynamically based on age
        requiredAge: 'neolithic',
        requiresTech: 'longbow',  // Requires longbow tech
        description: 'Ausbildung von Bogenschützen (benötigt Langbogen)',
        buildTime: BASE_BUILD_TIME * 1.2  // 12 seconds to build
    },
    market: {
        id: 'market',
        name: 'Markt',
        cost: { food: 100, wood: 100, stone: 100, gold: 50 },
        health: 700,
        type: 'economic',
        canResearch: true,
        researchOptions: [], // Filled dynamically from civ techTree (researchAt: 'market')
        requiredAge: 'neolithic',
        requiresTech: 'marketTech',  // Requires market tech from town_center
        description: 'Handel und Forschung fortgeschrittener Technologien',
        buildTime: BASE_BUILD_TIME * 1.5  // 15 seconds to build
    },
    farm: {
        id: 'farm',
        name: 'Farm',
        cost: { food: 50, wood: 50, stone: 0, gold: 0 },
        health: 400,
        type: 'economic',
        requiredAge: 'stone',
        requiresTech: 'farm',
        description: 'Produziert Nahrung (benötigt Forschung: Farm)',
        buildTime: BASE_BUILD_TIME * 0.8  // 8 seconds to build
    },
    tower: {
        id: 'tower',
        name: 'Wachtturm',
        cost: { food: 50, wood: 50, stone: 100, gold: 0 },
        health: 600,
        type: 'defense',
        attack: 10,
        range: 18,   // tripled: a real deterrent zone, matching the long vision
        requiredAge: 'stone',
        description: 'Verteidigungsturm',
        buildTime: BASE_BUILD_TIME * 1.2  // 12 seconds to build
    }
};

// Unit tiers per age for military buildings. INVARIANT: a unit appears here
// no earlier than its def `tier` — the age on its build card and the age its
// field-upgrade path fires. The table used to run an age ahead (champions and
// crossbowmen trainable in bronze under an "Iron age" card label).
const BUILDING_TRAIN_TIERS = {
    barracks: {
        stone: ['militia'],
        neolithic: ['militia'],
        bronze: ['militia', 'warrior'],
        iron: ['militia', 'warrior', 'champion']
    },
    stable: {
        neolithic: ['scout_cavalry'],
        bronze: ['scout_cavalry', 'cavalry'],
        iron: ['scout_cavalry', 'cavalry', 'heavy_cavalry']
    },
    archery_range: {
        neolithic: ['archer'],
        bronze: ['archer'],
        iron: ['archer', 'crossbowman', 'elite_archer']
    }
};

// Unit upgrade paths: when advancing ages, old units upgrade to new ones
const UNIT_UPGRADE_PATHS = {
    // Infantry (barracks)
    militia: { neolithic: 'militia', bronze: 'warrior', iron: 'warrior' },
    warrior: { bronze: 'warrior', iron: 'champion' },
    // Cavalry (stable)
    scout_cavalry: { bronze: 'scout_cavalry', iron: 'cavalry' },
    cavalry: { iron: 'heavy_cavalry' },
    // Ranged (archery_range)
    archer: { bronze: 'archer', iron: 'crossbowman' }
};

function getTrainOptionsForBuilding(buildingType, age, civilization) {
    const tiers = BUILDING_TRAIN_TIERS[buildingType];
    if (!tiers) return [];
    // Get the highest tier available for current age
    const ageOrder = ['stone', 'neolithic', 'bronze', 'iron'];
    const currentIdx = ageOrder.indexOf(age);
    let result = [];
    for (let i = 0; i <= currentIdx; i++) {
        const a = ageOrder[i];
        if (tiers[a]) {
            result = tiers[a]; // Overwrite with each tier, keeping the latest (superset)
        }
    }
    // Civ-unique units train here too (e.g. Egypt's horse carriage at the
    // stable): append any unique whose trainAt matches and whose tier age is
    // reached. Copy first — `result` aliases the shared tier table. A civ's
    // excludedUnits then drop standard entries it fields uniquely (Egypt
    // rides chariots, not generic cavalry).
    if (civilization && typeof getCivilization === 'function') {
        const civ = getCivilization(civilization);
        const uniques = (civ && civ.uniqueUnits) || [];
        for (const u of uniques) {
            if (u.trainAt !== buildingType) continue;
            if (u.tier && ageOrder.indexOf(u.tier) > currentIdx) continue;
            if (!result.includes(u.id)) result = result.slice().concat(u.id);
        }
        if (civ && civ.excludedUnits && civ.excludedUnits.length) {
            result = result.filter(id => !civ.excludedUnits.includes(id));
        }
    }
    return result;
}

// The age a civilization can ACTUALLY build this at: the def's own requiredAge
// or, if its unlocking tech comes later in that civ's tree (Egypt's bronze-age
// horse carriage vs the stable's neolithic), the tech's requiredAge. Keeps the
// build menu and the LLM state honest per civ.
function effectiveBuildingAge(civilization, buildingDef) {
    const order = ['stone', 'neolithic', 'bronze', 'iron'];
    let idx = Math.max(0, order.indexOf(buildingDef.requiredAge || 'stone'));
    if (buildingDef.requiresTech && typeof getCivilization === 'function') {
        const civ = getCivilization(civilization);
        const tech = (civ && civ.techTree) ? civ.techTree[buildingDef.requiresTech] : null;
        if (tech && tech.requiredAge) idx = Math.max(idx, order.indexOf(tech.requiredAge));
    }
    return order[idx];
}

function getBuildingDef(id) {
    return BUILDING_DEFS[id] || null;
}
