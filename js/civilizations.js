// Civilizations data with unique bonuses, units, and technologies
// Research locations:
//   town_center  - Dorfzentrum (Altsteinzeit techs)
//   town_center  - Dorfzentrum (Jungsteinzeit techs: Markt)
//   market       - Markt (alle späteren Techs)
//
// Tech format:
//   researchAt: 'town_center' | 'market'  (building that can research this tech)
//   requiredAge: 'stone' | 'neolithic' | 'bronze' | 'iron'
//   requires: ['techId']  (prerequisite techs)
//   unlocks: { unitTypes: ['cavalry'], buildings: ['stable'] }  (what this tech unlocks)
//   bonus: { attack: +2, health: +10, speed: +0.1, range: +1, harvestRate: +0.25 }  (stat bonuses applied to matching units)
//   appliesTo: 'infantry' | 'cavalry' | 'ranged' | 'worker' | 'all' | 'all_military'  (which unit types get the bonus)

// SINGLE SOURCE OF TRUTH for epoch-advance costs. Referenced by the human menu
// (ui.js), the human charge path (game.js), the rule-based AI (ai.js) and the LLM
// harness (openai-ai.js state + action handler). These previously drifted apart —
// the human menu showed/gated on HIGHER costs than everyone actually paid, which
// broke the fair-arena premise. Never redefine these locally.
const AGE_COSTS = {
    neolithic: { food: 1000, wood: 800,  stone: 0,    gold: 0 },
    bronze:    { food: 2000, wood: 1500, stone: 400,  gold: 200 },
    iron:      { food: 4000, wood: 3000, stone: 1000, gold: 600 }
};

const CIVILIZATIONS = {
    egyptian: {
        name: "Ägypter",
        color: 0xffd700,
        bonus: {
            name: "Pyramide",
            description: "+50% Wandstärke für alle Gebäude",
            effect: (game) => {
                game.buildingHealthMultiplier = 1.5;
            }
        },
        // Egypt's stable fields chariots only — the generic cavalry line
        // belongs to the horse-breeding civilizations.
        excludedUnits: ['scout_cavalry', 'cavalry', 'heavy_cavalry'],
        uniqueUnits: [
            {
                id: 'priest',
                name: 'Priester',
                cost: { food: 50, wood: 0, stone: 0, gold: 30 },
                health: 60,
                speed: 1.2,
                attack: 3,
                range: 3,
                type: 'support',
                tier: 'bronze',  // mirrors the shared def — getUnitDefFor returns THIS one
                description: 'Heilt andere Einheiten in der Nähe'
            },
            {
                id: 'slinger',
                name: 'Schleuderer',
                cost: { food: 60, wood: 20, stone: 0, gold: 0 },
                health: 45,
                speed: 1.0,
                attack: 6,
                range: 6,
                type: 'ranged',
                tier: 'neolithic',
                trainAt: 'archery_range',
                description: 'Starker Bogenschütze'
            },
            {
                id: 'horse_carriage',
                name: 'Pferdewagen',
                cost: { food: 60, wood: 20, stone: 40, gold: 40 },
                health: 100,
                speed: 2.0,
                attack: 8,
                range: 2,
                type: 'cavalry',
                tier: 'bronze',      // trainable from the Bronze age on…
                trainAt: 'stable',   // …at the stable (unlocked by the horseback tech)
                description: 'Speerkämpfer im Wagen hinter dem Pferd'
            }
        ],
        // WONDER COSTS ARE ONE VECTOR, NOT FOUR (see every civ's uniqueBuildings).
        // Equal SUMS are not equal prices: the map carries 270k food across 540
        // nodes (and farms regrow, so food is renewable) and 191k wood across 638
        // nodes, but only 36k stone across 36 nodes and 36k gold across just 18.
        // Gold and stone are the hard caps; food and wood are not. So a wonder
        // wanting 4000 gold and 2000 wood cost FAR more than one wanting 2000 gold
        // and 4000 wood, though both sum to 6000 — and the old table lived that
        // bug: by the raw sum Persia's Fire Temple was the bargain at 14500, but
        // weighted by scarcity it was DEARER than Yamato's, because 4000 of it was
        // gold. Weighted prices ran 6701 (Yamato) to 9973 (Greece), a 49% spread,
        // and disagreed with the sum about who was cheapest.
        //
        // No fixed weighting can fix that — scarcity moves with difficulty, tier
        // and map. An IDENTICAL vector makes the weighting irrelevant: the same
        // bill cannot be unfairly shaped. {4500, 4500, 4000, 2500} = 15500 is the
        // rounded average of the four the designers already chose, so overall
        // wonder difficulty is unchanged; only the unfairness is gone.
        //
        // Egypt alone pays ~6.5% more, and pays it PROPORTIONALLY (x1.06-x1.067 on
        // every resource) so the surcharge cannot smuggle a harder MIX back in.
        // It earns that as the only civ with an economy tech suite — Agriculture
        // and Mining (+25% harvest each) plus Pottery — while Greece and Persia
        // have no worker techs at all and Yamato has only move speed.
        uniqueBuildings: [
            {
                id: 'pyramid',
                name: 'Pyramide',
                cost: { food: 4800, wood: 4800, stone: 4250, gold: 2650 }, // 16500
                health: 1500,
                type: 'wonder',
                requiredAge: 'iron',
                buildTime: 60000,
                description: 'Weltwunder - im Bau ~60s, danach 180s halten zum Sieg!'
            }
        ],
        techTree: {
            // === Altsteinzeit - am Dorfzentrum ===
            house: {
                name: 'Haus',
                cost: { food: 50, wood: 100, stone: 0, gold: 0 },
                researchAt: 'town_center',
                requiredAge: 'stone',
                requires: [],
                description: 'Schaltet Haus-Bau frei (+5 Bevölkerung)',
                researchTime: 15000,  // 15 seconds
                unlocks: { buildings: ['house'] }
            },
            farm: {
                name: 'Farm',
                cost: { food: 100, wood: 50, stone: 0, gold: 0 },
                researchAt: 'town_center',
                requiredAge: 'stone',
                requires: [],
                description: 'Schaltet Farm-Bau frei (Nahrungsproduktion)',
                researchTime: 15000,  // 15 seconds
                unlocks: { buildings: ['farm'] }
            },
            barracks: {
                name: 'Kaserne',
                cost: { food: 100, wood: 150, stone: 0, gold: 0 },
                researchAt: 'town_center',
                requiredAge: 'stone',
                requires: [],
                description: 'Schaltet Kaserne-Bau frei (Infanterie-Ausbildung)',
                researchTime: 15000,  // 15 seconds
                unlocks: { buildings: ['barracks'] }
            },
            agriculture: {
                name: 'Landwirtschaft',
                cost: { food: 100, wood: 50, stone: 0, gold: 0 },
                researchAt: 'town_center',
                requiredAge: 'stone',
                requires: ['farm'],
                description: 'Dorfbewohner ernten +25% mehr',
                researchTime: 15000,  // 15 seconds
                bonus: { harvestRate: 0.25 },
                appliesTo: 'worker'
            },
            pottery: {
                name: 'Töpferei',
                cost: { food: 80, wood: 40, stone: 0, gold: 0 },
                researchAt: 'town_center',
                requiredAge: 'stone',
                requires: [],
                description: 'Dorfbewohner bauen +25% schneller',
                researchTime: 15000,  // 15 seconds
                bonus: { buildSpeed: 0.25 },
                appliesTo: 'worker'
            },
            longbow: {
                name: 'Langbogen',
                cost: { food: 50, wood: 100, stone: 0, gold: 0 },
                researchAt: 'town_center',
                requiredAge: 'stone',
                requires: [],
                description: 'Schaltet Bogenschützenstand frei',
                researchTime: 15000,  // 15 seconds
                unlocks: { buildings: ['archery_range'] }
            },
            // === Jungsteinzeit - am Dorfzentrum ===
            marketTech: {
                name: 'Marktplatz',
                cost: { food: 200, wood: 150, stone: 0, gold: 0 },
                researchAt: 'town_center',
                requiredAge: 'neolithic',
                requires: [],
                description: 'Schaltet Markt frei für weitere Forschung',
                unlocks: { buildings: ['market'] }
            },
            // === Jungsteinzeit - am Markt ===
            mining: {
                name: 'Bergbau',
                cost: { food: 50, wood: 50, stone: 50, gold: 0 },
                researchAt: 'market',
                requiredAge: 'neolithic',
                requires: ['marketTech'],
                description: 'Steinabbau +25% effizienter',
                researchTime: 20000,  // 20 seconds
                bonus: { harvestRate: 0.25 },
                appliesTo: 'worker'
            },
            archery: {
                name: 'Bogenschützen-Ausbildung',
                cost: { food: 100, wood: 100, stone: 0, gold: 50 },
                researchAt: 'market',
                requiredAge: 'neolithic',
                requires: [],
                description: 'Bogenschützen +2 Angriff',
                researchTime: 20000,  // 20 seconds
                bonus: { attack: 2 },
                appliesTo: 'ranged'
            },
            // === Bronzezeit - am Markt ===
            bronzeArmor: {
                name: 'Bronzerüstung',
                cost: { food: 0, wood: 0, stone: 150, gold: 100 },
                researchAt: 'market',
                requiredAge: 'bronze',
                requires: [],
                description: 'Alle Militäreinheiten +15 Gesundheit',
                researchTime: 25000,  // 25 seconds
                bonus: { health: 15 },
                appliesTo: 'all_military'
            },
            // Reuses the id 'horseback' on purpose: the stable's requiresTech and
            // every unlock gate key on that id, so Egypt's late chariot route
            // works through the exact same plumbing as Persia's and Yamato's.
            horseback: {
                name: 'Pferdewagen',
                cost: { food: 200, wood: 150, stone: 0, gold: 50 },
                researchAt: 'market',
                requiredAge: 'bronze',
                requires: ['marketTech'],
                description: 'Schaltet Stall und Pferdewagen frei',
                researchTime: 20000,  // 20 seconds
                unlocks: { buildings: ['stable'], unitTypes: ['horse_carriage'] }
            },
            // === Bronzezeit - am Tempel ===
            healing: {
                name: 'Heilkunde',
                cost: { food: 150, wood: 0, stone: 0, gold: 100 },
                researchAt: 'temple',
                requiredAge: 'bronze',
                requires: [],
                description: 'Stellt die volle Heilkraft der Priester wieder her',
                researchTime: 20000,
                bonus: { healPower: 0.2 }
            },
            // === Eisenzeit - am Markt ===
            ironWorking: {
                name: 'Eisenverarbeitung',
                cost: { food: 0, wood: 0, stone: 200, gold: 200 },
                researchAt: 'market',
                requiredAge: 'iron',
                requires: ['bronzeArmor'],
                description: 'Alle Militäreinheiten +3 Angriff',
                researchTime: 30000,  // 30 seconds
                bonus: { attack: 3 },
                appliesTo: 'all_military'
            }
        }
    },
    greek: {
        name: "Griechen",
        color: 0x4169e1,
        bonus: {
            name: "Akropolis",
            description: "Alle Gebäude haben +30% mehr Gesundheit",
            effect: (game) => {
                game.buildingHealthMultiplier = 1.3;
            }
        },
        uniqueUnits: [
            {
                id: 'hoplite',
                name: 'Hoplite',
                cost: { food: 80, wood: 0, stone: 50, gold: 30 },
                health: 150,
                speed: 0.9,
                attack: 10,
                range: 1,
                type: 'infantry',
                tier: 'neolithic',
                trainAt: 'barracks',
                description: 'Schwerer Infanterist mit Schild'
            },
            {
                id: 'phalanx',
                name: 'Phalanx',
                cost: { food: 60, wood: 0, stone: 40, gold: 20 },
                health: 100,
                speed: 0.8,
                attack: 8,
                range: 2,
                type: 'infantry',
                tier: 'bronze',
                trainAt: 'barracks',
                description: 'Speerträger, stark gegen Kavallerie'
            }
        ],
        uniqueBuildings: [
            {
                id: 'akropolis',
                name: 'Akropolis',
                // Shared wonder vector — see the Egyptian block for why. Its 1500
                // used to become 1950 through Akropolis; wonders are exempt now,
                // so this number is what actually stands on the field.
                cost: { food: 4500, wood: 4500, stone: 4000, gold: 2500 }, // 15500
                health: 1500,
                type: 'wonder',
                requiredAge: 'iron',
                buildTime: 60000,
                description: 'Weltwunder - im Bau ~60s, danach 180s halten zum Sieg!'
            }
        ],
        techTree: {
            // === Altsteinzeit - am Dorfzentrum ===
            house: {
                name: 'Haus',
                cost: { food: 50, wood: 100, stone: 0, gold: 0 },
                researchAt: 'town_center',
                requiredAge: 'stone',
                requires: [],
                description: 'Schaltet Haus-Bau frei (+5 Bevölkerung)',
                researchTime: 15000,
                unlocks: { buildings: ['house'] }
            },
            farm: {
                name: 'Farm',
                cost: { food: 100, wood: 50, stone: 0, gold: 0 },
                researchAt: 'town_center',
                requiredAge: 'stone',
                requires: [],
                description: 'Schaltet Farm-Bau frei (Nahrungsproduktion)',
                researchTime: 15000,
                unlocks: { buildings: ['farm'] }
            },
            barracks: {
                name: 'Kaserne',
                cost: { food: 100, wood: 150, stone: 0, gold: 0 },
                researchAt: 'town_center',
                requiredAge: 'stone',
                requires: [],
                description: 'Schaltet Kaserne-Bau frei (Infanterie-Ausbildung)',
                researchTime: 15000,
                unlocks: { buildings: ['barracks'] }
            },
            falx: {
                name: 'Falx-Schwerter',
                cost: { food: 100, wood: 100, stone: 0, gold: 0 },
                researchAt: 'town_center',
                requiredAge: 'stone',
                requires: ['barracks'],
                description: 'Infanterie +3 Angriff',
                researchTime: 15000,
                bonus: { attack: 3 },
                appliesTo: 'infantry'
            },
            farsight: {
                name: 'Weitblick',
                cost: { food: 100, wood: 50, stone: 0, gold: 30 },
                researchAt: 'town_center',
                requiredAge: 'stone',
                requires: [],
                description: 'Alle Einheiten +20% Sichtweite',
                researchTime: 20000,
                bonus: { visionRange: 0.2 },
                appliesTo: 'all_units'
            },
            longbow: {
                name: 'Langbogen',
                cost: { food: 50, wood: 100, stone: 0, gold: 0 },
                researchAt: 'town_center',
                requiredAge: 'stone',
                requires: [],
                description: 'Schaltet Bogenschützenstand frei',
                researchTime: 15000,
                unlocks: { buildings: ['archery_range'] }
            },
            // === Jungsteinzeit - am Dorfzentrum ===
            marketTech: {
                name: 'Marktplatz',
                cost: { food: 200, wood: 150, stone: 0, gold: 0 },
                researchAt: 'town_center',
                requiredAge: 'neolithic',
                requires: [],
                description: 'Schaltet Markt frei für weitere Forschung',
                researchTime: 20000,
                unlocks: { buildings: ['market'] }
            },
            // === Jungsteinzeit - am Markt ===
            philosophy: {
                name: 'Philosophie',
                cost: { food: 200, wood: 0, stone: 0, gold: 150 },
                researchAt: 'market',
                requiredAge: 'neolithic',
                requires: ['marketTech'],
                description: 'Alle Militäreinheiten +10% Gesundheit (+10 HP)',
                researchTime: 20000,
                bonus: { health: 10 },
                appliesTo: 'all_military'
            },
            // === Bronzezeit - am Markt ===
            democracy: {
                name: 'Demokratie',
                cost: { food: 300, wood: 0, stone: 0, gold: 200 },
                researchAt: 'market',
                requiredAge: 'bronze',
                requires: ['philosophy'],
                description: 'Dorfzentrum -50% Ausbildzeit',
                researchTime: 25000,
                bonus: { trainSpeed: 0.5 },
                appliesTo: 'town_center'
            },
            phalanxArmor: {
                name: 'Phalanx-Rüstung',
                cost: { food: 0, wood: 50, stone: 150, gold: 100 },
                researchAt: 'market',
                requiredAge: 'bronze',
                requires: [],
                description: 'Infanterie +20 Gesundheit',
                researchTime: 25000,
                bonus: { health: 20 },
                appliesTo: 'infantry'
            },
            // === Bronzezeit - am Tempel ===
            healing: {
                name: 'Heilkunde',
                cost: { food: 150, wood: 0, stone: 0, gold: 100 },
                researchAt: 'temple',
                requiredAge: 'bronze',
                requires: [],
                description: 'Stellt die volle Heilkraft der Priester wieder her',
                researchTime: 20000,
                bonus: { healPower: 0.2 }
            },
            // === Eisenzeit - am Markt ===
            ironWorking: {
                name: 'Eisenverarbeitung',
                cost: { food: 0, wood: 0, stone: 200, gold: 200 },
                researchAt: 'market',
                requiredAge: 'iron',
                requires: ['phalanxArmor'],
                description: 'Alle Militäreinheiten +3 Angriff',
                researchTime: 30000,
                bonus: { attack: 3 },
                appliesTo: 'all_military'
            }
        }
    },
    persian: {
        name: "Perser",
        color: 0xff6347,
        bonus: {
            name: "Satrapie",
            description: "Dorfbewohner sammeln 20% mehr Ressourcen",
            effect: (game) => {
                game.workerHarvestBonus = 1.2; // +20% carried per trip (applied ONCE, to the amount)
            }
        },
        // Persia rides where the others march. It is the only civ with no
        // infantry tech whatsoever — its champion never gains a point of attack
        // or health — so the cavalry line IS its high-tier army, and it is
        // priced below everyone else's to earn that role: 150 against the shared
        // rider's 170, 270 against the shared heavy cavalry's 310 and a
        // champion's 350. Every entry repeats its shared `tier`: getUnitDefFor
        // returns THESE defs now, and the age gates read the tier off them.
        uniqueUnits: [
            {
                id: 'archer',
                name: 'Persischer Bogenschütze',
                cost: { food: 70, wood: 30, stone: 0, gold: 0 },
                health: 50,
                speed: 1.1,
                attack: 7,
                range: 7.5,
                type: 'ranged',
                tier: 'neolithic',
                description: 'Schneller Bogenschütze'
            },
            {
                id: 'cavalry',
                name: 'Kavallerist',
                // health was 120 against the shared rider's 140 at an identical
                // price — the cavalry civ silently fielded the worst horsemen in
                // the game, because the charge read the shared def and the spawn
                // read this one. Back to parity, and cheaper.
                cost: { food: 110, wood: 0, stone: 0, gold: 40 },
                health: 140,
                speed: 2.0,
                attack: 12,
                range: 1,
                type: 'cavalry',
                tier: 'bronze',
                description: 'Schneller Reiter'
            },
            {
                id: 'heavy_cavalry',
                name: 'Kataphrakt',
                cost: { food: 160, wood: 0, stone: 40, gold: 70 },
                health: 200,
                speed: 1.8,
                attack: 18,
                range: 1,
                type: 'cavalry',
                tier: 'iron',
                description: 'Gepanzerter Reiter, Persiens Elite'
            }
        ],
        uniqueBuildings: [
            {
                id: 'firetemple',
                name: 'Feuertempel',
                // Shared wonder vector — see the Egyptian block for why. Its gold
                // fell 4000 -> 2500: on a map with 18 gold nodes that was the
                // heaviest wonder in the game, not the cheapest as the sum claimed.
                cost: { food: 4500, wood: 4500, stone: 4000, gold: 2500 }, // 15500
                health: 1500,
                type: 'wonder',
                requiredAge: 'iron',
                buildTime: 60000,
                description: 'Weltwunder - im Bau ~60s, danach 180s halten zum Sieg!'
            }
        ],
        techTree: {
            // === Altsteinzeit - am Dorfzentrum ===
            house: {
                name: 'Haus',
                cost: { food: 50, wood: 100, stone: 0, gold: 0 },
                researchAt: 'town_center',
                requiredAge: 'stone',
                requires: [],
                description: 'Schaltet Haus-Bau frei (+5 Bevölkerung)',
                researchTime: 15000,
                unlocks: { buildings: ['house'] }
            },
            farm: {
                name: 'Farm',
                cost: { food: 100, wood: 50, stone: 0, gold: 0 },
                researchAt: 'town_center',
                requiredAge: 'stone',
                requires: [],
                description: 'Schaltet Farm-Bau frei (Nahrungsproduktion)',
                researchTime: 15000,
                unlocks: { buildings: ['farm'] }
            },
            barracks: {
                name: 'Kaserne',
                cost: { food: 100, wood: 150, stone: 0, gold: 0 },
                researchAt: 'town_center',
                requiredAge: 'stone',
                requires: [],
                description: 'Schaltet Kaserne-Bau frei (Infanterie-Ausbildung)',
                researchTime: 15000,
                unlocks: { buildings: ['barracks'] }
            },
            horseback: {
                name: 'Pferdezucht',
                cost: { food: 150, wood: 100, stone: 0, gold: 0 },
                researchAt: 'town_center',
                requiredAge: 'stone',
                requires: [],
                description: 'Schaltet Stall und Kavallerie frei',
                researchTime: 15000,
                unlocks: { buildings: ['stable'] }
            },
            longbow: {
                name: 'Langbogen',
                cost: { food: 50, wood: 100, stone: 0, gold: 0 },
                researchAt: 'town_center',
                requiredAge: 'stone',
                requires: [],
                description: 'Schaltet Bogenschützenstand frei',
                researchTime: 15000,
                unlocks: { buildings: ['archery_range'] }
            },
            // === Jungsteinzeit - am Dorfzentrum ===
            marketTech: {
                name: 'Marktplatz',
                cost: { food: 200, wood: 150, stone: 0, gold: 0 },
                researchAt: 'town_center',
                requiredAge: 'neolithic',
                requires: [],
                description: 'Schaltet Markt frei für weitere Forschung',
                researchTime: 20000,
                unlocks: { buildings: ['market'] }
            },
            // === Jungsteinzeit - am Markt ===
            cavalryTraining: {
                name: 'Kavallerie-Ausbildung',
                cost: { food: 150, wood: 50, stone: 0, gold: 100 },
                researchAt: 'market',
                requiredAge: 'neolithic',
                requires: ['horseback'],
                description: 'Kavallerie +2 Angriff, +10 Gesundheit',
                researchTime: 20000,
                bonus: { attack: 2, health: 10 },
                appliesTo: 'cavalry'
            },
            // === Bronzezeit - am Markt ===
            cavalryArmor: {
                name: 'Kavallerie-Rüstung',
                cost: { food: 0, wood: 0, stone: 200, gold: 150 },
                researchAt: 'market',
                requiredAge: 'bronze',
                requires: ['cavalryTraining'],
                description: 'Kavallerie +25 Gesundheit',
                researchTime: 25000,
                bonus: { health: 25 },
                appliesTo: 'cavalry'
            },
            // Persia's ONE all_military tech. It had none at all, and health is
            // the only armour in this game — so its infantry and archers never
            // grew a single hit point while every rival's attack climbed every
            // age, i.e. they got relatively WEAKER over a match. Priced at
            // Egypt's Bronze Armor exactly: identical effect, identical bill.
            immortals: {
                name: 'Unsterbliche',
                cost: { food: 0, wood: 0, stone: 150, gold: 100 },
                researchAt: 'market',
                requiredAge: 'bronze',
                requires: [],
                description: 'Alle Militäreinheiten +15 Gesundheit',
                researchTime: 25000,
                bonus: { health: 15 },
                appliesTo: 'all_military'
            },
            // === Bronzezeit - am Tempel ===
            healing: {
                name: 'Heilkunde',
                cost: { food: 150, wood: 0, stone: 0, gold: 100 },
                researchAt: 'temple',
                requiredAge: 'bronze',
                requires: [],
                description: 'Stellt die volle Heilkraft der Priester wieder her',
                researchTime: 20000,
                bonus: { healPower: 0.2 }
            },
            archery: {
                name: 'Bogenschützen-Ausbildung',
                cost: { food: 100, wood: 100, stone: 0, gold: 50 },
                researchAt: 'market',
                requiredAge: 'bronze',
                requires: [],
                description: 'Bogenschützen +2 Angriff',
                researchTime: 25000,
                bonus: { attack: 2 },
                appliesTo: 'ranged'
            },
            // === Eisenzeit - am Markt ===
            siege: {
                name: 'Belagerungswaffen',
                cost: { food: 0, wood: 200, stone: 150, gold: 200 },
                researchAt: 'market',
                requiredAge: 'iron',
                requires: ['archery'],
                description: 'Bogenschützen +2 Reichweite, +3 Angriff',
                researchTime: 30000,
                bonus: { range: 2, attack: 3 },
                appliesTo: 'ranged'
            }
        }
    },
    yamato: {
        name: "Yamato",
        color: 0xff69b4,
        bonus: {
            name: "Schrein",
            description: "Technologie 30% günstiger",
            effect: (game) => {
                game.techCostMultiplier = 0.7;
            }
        },
        uniqueUnits: [
            {
                id: 'samurai',
                name: 'Samurai',
                cost: { food: 100, wood: 50, stone: 0, gold: 50 },
                health: 130,
                speed: 1.3,
                attack: 14,
                range: 1,
                type: 'infantry',
                tier: 'bronze',
                trainAt: 'barracks',
                description: 'Elitewarrior mit starkem Schwert'
            },
            {
                id: 'archer_ship',
                name: 'Bogenschiffs',
                cost: { food: 150, wood: 150, stone: 0, gold: 50 },
                health: 200,
                speed: 1.5,
                attack: 8,
                range: 6,
                type: 'ranged',
                description: 'Schiff mit Bogenschützen'
            }
        ],
        uniqueBuildings: [
            {
                id: 'shrine',
                name: 'Schrein',
                // Shared wonder vector — see the Egyptian block for why.
                cost: { food: 4500, wood: 4500, stone: 4000, gold: 2500 }, // 15500
                health: 1500,
                type: 'wonder',
                requiredAge: 'iron',
                buildTime: 60000,
                description: 'Weltwunder - im Bau ~60s, danach 180s halten zum Sieg!'
            }
        ],
        techTree: {
            // === Altsteinzeit - am Dorfzentrum ===
            house: {
                name: 'Haus',
                cost: { food: 50, wood: 100, stone: 0, gold: 0 },
                researchAt: 'town_center',
                requiredAge: 'stone',
                requires: [],
                description: 'Schaltet Haus-Bau frei (+5 Bevölkerung)',
                researchTime: 15000,
                unlocks: { buildings: ['house'] }
            },
            farm: {
                name: 'Farm',
                cost: { food: 100, wood: 50, stone: 0, gold: 0 },
                researchAt: 'town_center',
                requiredAge: 'stone',
                requires: [],
                description: 'Schaltet Farm-Bau frei (Nahrungsproduktion)',
                researchTime: 15000,
                unlocks: { buildings: ['farm'] }
            },
            barracks: {
                name: 'Kaserne',
                cost: { food: 100, wood: 150, stone: 0, gold: 0 },
                researchAt: 'town_center',
                requiredAge: 'stone',
                requires: [],
                description: 'Schaltet Kaserne-Bau frei (Infanterie-Ausbildung)',
                researchTime: 15000,
                unlocks: { buildings: ['barracks'] }
            },
            bushido: {
                name: 'Bushido',
                cost: { food: 150, wood: 0, stone: 0, gold: 100 },
                researchAt: 'town_center',
                requiredAge: 'stone',
                requires: ['barracks'],
                description: 'Alle Militäreinheiten +15% Angriff (+2 ATK)',
                researchTime: 15000,
                bonus: { attack: 2 },
                appliesTo: 'all_military'
            },
            // === Bronzezeit - am Tempel ===
            healing: {
                name: 'Heilkunde',
                cost: { food: 150, wood: 0, stone: 0, gold: 100 },
                researchAt: 'temple',
                requiredAge: 'bronze',
                requires: [],
                description: 'Stellt die volle Heilkraft der Priester wieder her',
                researchTime: 20000,
                bonus: { healPower: 0.2 }
            },
            speed: {
                name: 'Schnelle Hände',
                cost: { food: 100, wood: 100, stone: 0, gold: 0 },
                researchAt: 'town_center',
                requiredAge: 'stone',
                requires: [],
                description: 'Dorfbewohner +20% Bewegungsgeschwindigkeit',
                researchTime: 15000,
                bonus: { speed: 0.2 },
                appliesTo: 'worker'
            },
            longbow: {
                name: 'Langbogen',
                cost: { food: 50, wood: 100, stone: 0, gold: 0 },
                researchAt: 'town_center',
                requiredAge: 'stone',
                requires: [],
                description: 'Schaltet Bogenschützenstand frei',
                researchTime: 15000,
                unlocks: { buildings: ['archery_range'] }
            },
            // === Jungsteinzeit - am Dorfzentrum ===
            marketTech: {
                name: 'Marktplatz',
                cost: { food: 200, wood: 150, stone: 0, gold: 0 },
                researchAt: 'town_center',
                requiredAge: 'neolithic',
                requires: [],
                description: 'Schaltet Markt frei für weitere Forschung',
                researchTime: 20000,
                unlocks: { buildings: ['market'] }
            },
            // === Jungsteinzeit - am Markt ===
            horseback: {
                name: 'Pferdezucht',
                cost: { food: 150, wood: 100, stone: 0, gold: 0 },
                researchAt: 'market',
                requiredAge: 'neolithic',
                requires: ['marketTech'],
                description: 'Schaltet Stall und Kavallerie frei',
                unlocks: { buildings: ['stable'] }
            },
            // === Bronzezeit - am Markt ===
            armor: {
                name: 'Schwertrüstung',
                cost: { food: 0, wood: 100, stone: 150, gold: 150 },
                researchAt: 'market',
                requiredAge: 'bronze',
                requires: ['bushido'],
                description: 'Infanterie +20 Gesundheit',
                bonus: { health: 20 },
                appliesTo: 'infantry'
            },
            // Yamato's two all_military techs (Bushido, Iron Working) are BOTH
            // attack, and Sword Armor covers infantry only — so its archers and
            // cavalry never grew a hit point, and health is the only armour in
            // this game. Same effect and same bill as Egypt's Bronze Armor; the
            // Shrine's -30% still comes off on top, as it does for every Yamato
            // tech.
            lamellarArmor: {
                name: 'Lamellenrüstung',
                cost: { food: 0, wood: 0, stone: 150, gold: 100 },
                researchAt: 'market',
                requiredAge: 'bronze',
                requires: [],
                description: 'Alle Militäreinheiten +15 Gesundheit',
                researchTime: 25000,
                bonus: { health: 15 },
                appliesTo: 'all_military'
            },
            // === Eisenzeit - am Markt ===
            ironWorking: {
                name: 'Eisenverarbeitung',
                cost: { food: 0, wood: 0, stone: 200, gold: 200 },
                researchAt: 'market',
                requiredAge: 'iron',
                requires: ['armor'],
                description: 'Alle Militäreinheiten +3 Angriff',
                bonus: { attack: 3 },
                appliesTo: 'all_military'
            }
        }
    }
};

// Default civilization (fallback)
const DEFAULT_CIV = {
    name: "Völker",
    color: 0x888888,
    bonus: null,
    uniqueUnits: [],
    uniqueBuildings: [],
    techTree: {}
};

function getCivilization(id) {
    return CIVILIZATIONS[id] || DEFAULT_CIV;
}

// Team badges — the per-SEAT ownership marks (building flags, unit chests,
// UI chips). Civ colors can't tell players apart once two seats pick the same
// civilization, so ownership gets its own channel keyed by seat: arena slot
// order; in campaign the human is seat 0, opponents follow. Each seat pairs a
// COLOR with a SHAPE (double-coded, so it survives color blindness and any
// backdrop), and every fill ships with a contrast rim — white-on-gold (and
// charcoal-on-shadow) is unreadable without one. Entries 5-6 only ever appear
// in 5-6 player campaigns. Shape names are interpreted by
// EngineUnits.badgeParts (world) and ui.teamDotHtml (chips).
const TEAM_BADGES = [
    { fill: '#222222', rim: '#FFFFFF', shape: 'circle' },   // charcoal
    { fill: '#FFFFFF', rim: '#222222', shape: 'square' },   // white
    { fill: '#009E60', rim: '#FFFFFF', shape: 'triangle' }, // emerald
    { fill: '#E0F7FA', rim: '#222222', shape: 'diamond' },  // ice blue
    { fill: '#7B1FA2', rim: '#FFFFFF', shape: 'star' },     // purple
    { fill: '#FF8F00', rim: '#222222', shape: 'cross' }     // amber
];

function getTeamBadge(seat) {
    if (seat == null || seat < 0) return null;
    return TEAM_BADGES[seat % TEAM_BADGES.length];
}
