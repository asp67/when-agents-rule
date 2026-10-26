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
        // +10 population per Town Center. The ResourceManager's base cap of 10 IS
        // the STARTING TC's contribution, so the mechanics stay symmetric with no
        // spawn-seeding: completeConstruction adds this for a newly built TC and
        // destroyTarget subtracts it for a destroyed one — the cap always reflects
        // 10 × (Town Centers owned), plus 5 per house.
        popBonus: 10,
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
    academy: {
        id: 'academy',
        name: 'Akademie',
        cost: { food: 100, wood: 100, stone: 100, gold: 50 },
        health: 700,
        type: 'economic',
        canResearch: true,
        researchOptions: [], // Filled dynamically from civ techTree (researchAt: 'academy')
        canTrain: true,      // the engineer, after Siege Engineering (b1110)
        trainOptions: [],    // filled from BUILDING_TRAIN_TIERS by age
        requiredAge: 'neolithic',
        requiresTech: 'academy',  // Requires academy tech from town_center
        description: 'Forschung fortgeschrittener Technologien',
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
        attack: 10,  // Stone-age baseline; TOWER_POWER ramps it per epoch
        range: 18,   // tripled: a real deterrent zone, matching the long vision
        requiredAge: 'stone',
        description: 'Verteidigungsturm',
        // 20 seconds (b1110, asp67): 12 put a tower up inside one model turn, so a
        // forward tower could never be contested while it was a site.
        buildTime: BASE_BUILD_TIME * 2
    },
    // A siege engine that answers towers and nothing else (b1110, asp67). Built by a
    // worker like any building, after Siege Engineering at the academy. It throws stone
    // at enemy towers and tower sites in reach, outranging them, and sees only enemy
    // towers (and 20 around each) within its watch radius -- plus the 20 around itself
    // every building sees. Weak (flat health, no age or civilization multiplier): it
    // must be guarded and repaired, and units are its counter. Built in the iron age it
    // is the advanced engine, never upgraded on age-up. Numbers in TREBUCHET_TIERS.
    trebuchet: {
        id: 'trebuchet',
        name: 'Tribok',
        cost: { food: 100, wood: 200, stone: 100, gold: 50 },
        health: 200,
        type: 'siege',
        attack: 150,
        range: 50,
        requiredAge: 'bronze',
        requiresTech: 'siege_engineering',
        description: 'Belagerungsmaschine: fertig ein Tribok auf Rädern (Geschwindigkeit 0,16), der im Stand Steine auf feindliche Türme wirft',
        buildTime: BASE_BUILD_TIME * 2  // 20 seconds to build
    },
    // The advanced engine's site (b1110, asp67: "allow both models per selection in iron
    // age, since a basic trebuchet is cheaper and might be the better choice"). Its own id:
    // 'advanced_trebuchet' is the unit it becomes, and a unit's type must never name a
    // building. 20% dearer than the simple one.
    trebuchet_advanced: {
        id: 'trebuchet_advanced',
        name: 'Schwerer Tribok',
        cost: { food: 120, wood: 240, stone: 120, gold: 60 },
        health: 400,
        type: 'siege',
        attack: 200,
        range: 60,
        requiredAge: 'iron',
        requiresTech: 'siege_engineering',
        description: 'Schwere Belagerungsmaschine (ab der Eisenzeit): fertig ein schwerer Tribok auf Rädern (Geschwindigkeit 0,32), der im Stand Steine auf feindliche Türme wirft',
        buildTime: BASE_BUILD_TIME * 2  // 20 seconds to build
    }
};

// The trebuchet's two engines (b1110, asp67). The simple one reaches 50 and the advanced
// one, built in the iron age, 60 (asp67; they reached 1.5x a tower's 18 and +20%, and a
// formation had no room to stand between the tower's reach and its engines'); they watch
// 1.5x a tower's sight (80) and +20%. The advanced one has double the health and speed and
// costs 20% more. Its reach was 70 for a while; at 60 it stands at 58, inside the 60 a
// guard defends round its post (StandingOrders.GUARD_RADIUS), as the simple one at 48 is:
// the iron age buys a faster, sturdier engine and more time throwing before the defenders
// arrive, not one no guard can answer (asp67). Health is flat.
const TREBUCHET_TIERS = {
    simple:   { health: 200, attack: 150, range: 50,   watch: 120, reloadMs: 6000, speed: 0.16, unit: 'simple_trebuchet' },
    advanced: { health: 400, attack: 200, range: 60,   watch: 144, reloadMs: 6000, speed: 0.32, unit: 'advanced_trebuchet' }
};
// How far around each enemy tower a trebuchet's watch reveals.
const TREBUCHET_TOWER_REVEAL = 20;

function trebuchetTier(age) {
    return age === 'iron' ? TREBUCHET_TIERS.advanced : TREBUCHET_TIERS.simple;
}
// The two trebuchet sites, and the engine each becomes: by the site's type, never the
// age it was built in -- in the iron age both can be chosen (b1110).
function isTrebuchetBuilding(type) {
    return type === 'trebuchet' || type === 'trebuchet_advanced';
}
function trebuchetTierOf(type) {
    return type === 'trebuchet_advanced' ? TREBUCHET_TIERS.advanced : TREBUCHET_TIERS.simple;
}

// What a building costs to place. Each trebuchet site carries its own price (b1110);
// kept as the one place every cost path asks, should a price ever depend on the age.
function buildingCost(def, age) {
    return def ? def.cost : null;
}

// Ids this game used to use, and what they are now. The alias exists so RECORDED data
// still resolves — a transcript from before v512 calls the academy a "market", and the
// analyzer builds entities straight out of those records — and for nothing else. An
// order to build one is refused by name (see executeBuildStructure): accepting it would
// write the dead id into new transcripts, and would quietly reward the very assumption
// the rename exists to remove, since "market" was only ever guessed by models expecting
// to trade with it.
const LEGACY_BUILDING_IDS = { market: 'academy' };
Object.keys(LEGACY_BUILDING_IDS).forEach(old => {
    BUILDING_DEFS[old] = BUILDING_DEFS[LEGACY_BUILDING_IDS[old]];
});

// Tower firepower per epoch. Its HP already rides the generic x1.5-per-age
// building multiplier, but firepower never scaled AT ALL — a flat 10 damage and
// a flat 5 arrows in every age. That inverted the tower: a stone watchtower
// suppressed an entire opening rush and killed a militia in 10.5s, while an iron
// one needed 30s to kill ONE champion. Arrows say how many attackers a volley
// can answer; damage keeps it lethal against the era's HP. Together these hold
// "time to kill one era-standard attacker" at a roughly flat 9-15s.
//
// Deliberately CIV-NEUTRAL: every attack tech declares appliesTo a UNIT class,
// and no civ owns a matching set — Persia has no all_military tech at all,
// Greece and Yamato have no ranged tech — so inheriting unit techs would freeze
// some civs' towers while doubling others'. Yamato's Bushido would also make
// STONE towers stronger, the opposite of the intent. Civ flavour already lives
// in tower HP through the civ bonus (Pyramide x1.5, Akropolis x1.3).
const TOWER_POWER = {
    stone:     { arrows: 2, attack: 10 },
    neolithic: { arrows: 3, attack: 12 },
    bronze:    { arrows: 4, attack: 15 },
    iron:      { arrows: 5, attack: 20 }
};

function towerPower(age) {
    return TOWER_POWER[age] || TOWER_POWER.stone;
}

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
    },
    // The engineer, behind Siege Engineering (b1110; its own requiresTech gate).
    academy: {
        bronze: ['engineer'],
        iron: ['engineer']
    }
};

// Unit upgrade paths: when advancing ages, old units upgrade to new ones
const UNIT_UPGRADE_PATHS = {
    // Infantry (barracks)
    militia: { neolithic: 'militia', bronze: 'warrior', iron: 'warrior' },
    warrior: { bronze: 'warrior', iron: 'champion' },
    // Cavalry (stable). The scout stays a scout all match (asp67, b1055): it is the
    // early-game scout, not a fighter, and it became cavalry at the Iron age -- for
    // Egypt and Greece cavalry they cannot even train.
    cavalry: { iron: 'heavy_cavalry' },
    // Ranged (archery_range)
    archer: { bronze: 'archer', iron: 'crossbowman' }
};

// A unit that needs a research of its own before it can be trained (b1060: the Maya's
// spotter, behind "scouting"). Every train path asks: the models' executor and their
// unit list, the rule-based AI, the player's train menu and command. Null when the
// unit has no such gate or the owner has researched it.
function unitTechMissing(owner, unitId) {
    const def = (typeof getUnitDefFor === 'function' && owner) ? getUnitDefFor(owner.civilization, unitId) : null;
    const tech = def && def.requiresTech;
    return tech && !(owner.researchedTechs && owner.researchedTechs[tech]) ? tech : null;
}

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
