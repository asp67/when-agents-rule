'use strict';
// WAR Bench baselines (review #8 step 5): the floor and the ceiling every model result
// is read between.
//
//   noop          answers nothing, every round
//   random-valid  one to three commands a round, each built only from names and places
//                 the state shows: unit types it owns or can train, buildings it can
//                 build, techs on offer, enemies in sight, tiles on the map. It may be
//                 refused for the world's reasons (cannot afford, busy, nobody free) --
//                 constraint errors -- but must never earn a reference error: it never
//                 names anything that is not there. tests/bench-baselines.test.cjs holds
//                 it to that across every scenario and variant.
//   scripted      the scenario's reference solution, which must score 100 %
//
// Seeded: the same scenario, variant and attempt give the same commands every time.
const S = require('./scenario.cjs');

// mulberry32 over a string hash: small, fully specified, independent of the realm's RNG.
function rngFor(key) {
    let h = 2166136261;
    for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619); }
    let a = h >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const pick = (r, list) => list[Math.floor(r() * list.length)];
const RESOURCES = ['food', 'wood', 'stone', 'gold'];
const MODES = ['march', 'scout', 'guard', 'patrol'];

// One command built from the state, or null when the chosen kind has nothing to name.
function randomCommand(r, st) {
    const b = (st.map && st.map.bounds) || { minX: -400, maxX: 400, minZ: -400, maxZ: 400 };
    const point = () => ({ targetX: Math.round(b.minX + 20 + r() * (b.maxX - b.minX - 40)),
                           targetZ: Math.round(b.minZ + 20 + r() * (b.maxZ - b.minZ - 40)) });
    const home = (st.map && st.map.yourSpawnArea) || { x: 0, z: 0 };
    const near = () => ({ targetX: Math.round(home.x + (r() - 0.5) * 60), targetZ: Math.round(home.z + (r() - 0.5) * 60) });
    const own = st.friendlyUnits || [];
    const military = own.filter(u => u.type !== 'worker' && u.type !== 'priest');
    const enemies = [...(st.enemyUnits || []), ...(st.enemyBuildings || [])].filter(e => e && e.id != null);
    const trainable = [];
    for (const byAge of Object.values((st.units && st.units.trainable) || {}))
        for (const list of Object.values(byAge)) for (const t of list) {
            const id = (t && typeof t === 'object') ? t.id : t;   // listed as {id, cost}
            if (id && !trainable.includes(id)) trainable.push(id);
        }
    const buildable = ((st.buildings && st.buildings.buildable) || []).map(x => x.type);
    const techs = ((st.research && st.research.available) || []).map(x => x.id);
    const tiles = Object.keys((st.map && st.map.exploration) || {});
    const select = () => {
        // Sometimes the whole army, sometimes a type it owns, sometimes exact ids.
        const k = r();
        if (k < 0.4 || !military.length) return {};
        if (k < 0.7) { const t = pick(r, military).type; return { units: { [t]: 1 + Math.floor(r() * 3) } }; }
        return { unitIds: military.filter(() => r() < 0.5).map(u => u.id).slice(0, 5).concat([pick(r, military).id]) };
    };
    const kinds = {
        train_unit: () => trainable.length ? { unitType: pick(r, trainable) } : null,
        build_structure: () => buildable.length ? Object.assign({ buildingType: pick(r, buildable) }, near()) : null,
        research_tech: () => techs.length ? { techId: pick(r, techs) } : null,
        upgrade_age: () => ({}),
        assign_workers: () => ({ resourceType: pick(r, RESOURCES), count: 1 + Math.floor(r() * 3) }),
        repair_building: () => ({}),
        explore: () => tiles.length ? { tile: pick(r, tiles) } : null,
        move_units: () => Object.assign({ mode: pick(r, MODES) }, point(), select()),
        attack_target: () => (enemies.length && r() < 0.6) ? Object.assign({ targetId: String(pick(r, enemies).id) }, select())
            : Object.assign(point(), select()),
        wait: () => ({}),
    };
    const action = pick(r, Object.keys(kinds));
    const params = kinds[action]();
    return params ? { action, params } : null;
}

function randomValidPolicy(key) {
    const r = rngFor('random-valid:' + key);
    return ({ state }) => {
        const n = 1 + Math.floor(r() * 3), out = [];
        for (let i = 0; i < n * 3 && out.length < n; i++) {
            const c = randomCommand(r, state);
            if (c) out.push(c);
        }
        return out;
    };
}

// The three baselines by name, as policy factories for runSuite.
const BASELINES = Object.freeze({
    noop: () => S.noopPolicy(),
    'random-valid': (s, v, a) => randomValidPolicy(`${s.id}/${v}/${a}`),
    scripted: () => S.referencePolicy(),
});

module.exports = { BASELINES, randomValidPolicy, rngFor };
