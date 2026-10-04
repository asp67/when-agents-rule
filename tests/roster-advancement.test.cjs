// The roster's advancement rules have to close on themselves.
//
// Two tables decide what a soldier can become: BUILDING_TRAIN_TIERS (what a host can turn out
// at each age) and UNIT_UPGRADE_PATHS (what a veteran morphs into when its owner ages up).
// Nothing links them, so a unit can be added to one and forgotten in the other — which would
// produce either a veteran that can never advance again, or an upgrade into a unit no building
// can produce. Both read as a live gameplay bug and neither shows up until someone is annoyed
// by it twenty turns later.
//
// Assertions are computed from the shipped functions and tables, never from the text of the
// files: the point is the relationship between the rules, not their spelling.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const scope = {
  console: { log() {}, warn() {}, error() {} },
  Math, JSON, Object, Array, String, Number, Boolean, Set, Map, RegExp, Error,
};
vm.createContext(scope);
for (const f of ['js/civilizations.js', 'js/units.js', 'js/buildings.js'])
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), scope, { filename: f });

// The executor's own lookup, loaded for the reachability question at the bottom of this file.
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'resources.js'), 'utf8'), scope, { filename: 'js/resources.js' });
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'i18n.js'), 'utf8'), scope, { filename: 'js/i18n.js' });
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'game.js'), 'utf8')
  .split('\nconst WAR_PRIVATE_HOST')[0], scope, { filename: 'js/game.js' });
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'openai-ai.js'), 'utf8'), scope, { filename: 'js/openai-ai.js' });
const requiredBuildingForUnit = vm.runInContext('OpenAIAIManager', scope).prototype.requiredBuildingForUnit;

const CIVS = [...vm.runInContext('Object.keys(CIVILIZATIONS)', scope)];
const AGES = ['stone', 'neolithic', 'bronze', 'iron'];
const HOSTS = ['town_center', 'barracks', 'archery_range', 'stable', 'temple'];

// Earliest age at which each unit type can be produced, across every civ (unique units train
// at their own host and have their own tier) and every host.
const producible = vm.runInContext(`(function () {
  const AGES = ${JSON.stringify(AGES)}, HOSTS = ${JSON.stringify(HOSTS)};
  const civs = Object.keys(CIVILIZATIONS);
  const earliest = {};
  const where = {};
  for (const civ of civs) for (const host of HOSTS) for (let i = 0; i < AGES.length; i++) {
    for (const id of (getTrainOptionsForBuilding(host, AGES[i], civ) || [])) {
      if (earliest[id] === undefined || i < earliest[id]) earliest[id] = i;
      (where[id] = where[id] || new Set()).add(host);
    }
  }
  const out = {};
  for (const id of Object.keys(earliest)) out[id] = { age: earliest[id], hosts: [...where[id]] };
  return { out, paths: UNIT_UPGRADE_PATHS };
})()`, scope);

const UNITS = Object.keys(producible.out);
const PATHS = producible.paths;

test('the two tables actually loaded before anything is asserted', () => {
  // Guard the fixture itself: if the loaders ever stop resolving, every test below would
  // pass on empty sets.
  assert.ok(UNITS.length >= 10, 'expected a roster, found ' + UNITS.length);
  assert.ok(Object.keys(PATHS).length >= 4, 'expected upgrade paths, found ' + Object.keys(PATHS).length);
});

test('the shared roster closes on itself', () => {
    // Scope: units any civ can train from a normal host (BUILDING_TRAIN_TIERS), independent of
    // the civ-unique question, which is its own test below. Every one of these that can be
    // fielded before the last age must have an upgrade path, or a veteran of it is a dead end.
    //
    // Scoped this way on purpose, and once it was not: an earlier version skipped anything a
    // civ claims as a unique, which silently dropped archer and cavalry — Persia's "uniques"
    // are those two STANDARD ids — and the test then passed with archer's path deleted
    // entirely. Mutation-checked since; deleting `archer:` must fail here.
    const shared = JSON.parse(vm.runInContext(`JSON.stringify(
        [...new Set(Object.values(BUILDING_TRAIN_TIERS).flatMap(byAge =>
            Object.values(byAge).flat()))])`, scope));
    const stuck = shared
        .filter(id => producible.out[id] && producible.out[id].age < AGES.length - 1 && !PATHS[id])
        .map(id => `${id} (trainable from ${AGES[producible.out[id].age]})`);
    assert.deepEqual(stuck, [], 'a veteran of these can never advance again: ' + stuck.join(', '));
});

test('veteran advancement differs by civilization — recorded, not endorsed', () => {
    // Exactly what the shipped tables do to each civ's signature units at an age-up:
    //
    //   Persian  archer -> crossbowman, cavalry -> heavy cavalry    advance for free
    //          heavy cavalry                                        (nothing above it)
    //   Egyptian priest, slinger, horse carriage                   stay as recruited
    //   Greek    hoplite, phalanx                                  stay as recruited
    //   Yamato   samurai, archer ship                              stay as recruited
    //
    // Persia's "uniques" are the STANDARD ranged and cavalry ids, so they inherit the upgrade
    // paths; the other three civs own distinct unit types that appear nowhere in
    // UNIT_UPGRADE_PATHS. On one island at one moment, one seat's veterans walk into the iron
    // age upgraded at no cost and three seats' do not — and nothing model-facing says the free
    // upgrade happens at all (the only "upgrade" a model is told about is the upgrade_age
    // ACTION, not what it then does to the army). Whether uniques should advance too, or the
    // advancement should be advertised, is a balance call nobody has made; see
    // docs/QUALITY_REVIEW.md. Asserted as one complete table so that ANY change to it —
    // including the sensible-looking fix — has to come with that section rewritten.
    const table = JSON.parse(vm.runInContext(`JSON.stringify(
        Object.fromEntries(Object.entries(CIVILIZATIONS).map(([civ, c]) => [civ,
            (c.uniqueUnits || []).map(u => u.id + (UNIT_UPGRADE_PATHS[u.id] ? ' ADVANCES' : ''))]))
    )`, scope));
    assert.deepEqual(table, {
        egyptian: ['priest', 'slinger', 'horse_carriage'],
        greek: ['hoplite', 'phalanx'],
        persian: ['archer ADVANCES', 'cavalry ADVANCES', 'heavy_cavalry'],
        yamato: ['samurai', 'archer_ship'],
    });
});

test('every upgrade target is something a building can actually make', () => {
    const dangling = [];
    for (const [from, byAge] of Object.entries(PATHS)) {
        for (const to of Object.values(byAge)) {
            if (!producible.out[to]) dangling.push(`${from} -> ${to}`);
        }
    }
    assert.deepEqual(dangling, [], 'upgrade paths naming units no host produces at any age: ' + dangling.join(', '));
});

test('no upgrade walks a unit backwards, or fires before its target can exist', () => {
    // An entry equal to the unit's own type is how the table spells "still me at this age"
    // (militia at neolithic and bronze), which is harmless. What must not happen is a morph
    // into a unit that is not producible yet at the age the morph fires, or into a cheaper
    // tier than the unit it replaces.
    const wrong = [];
    for (const [from, byAge] of Object.entries(PATHS)) {
        for (const [age, to] of Object.entries(byAge)) {
            if (to === from) continue;
            const fromAge = producible.out[from], toAge = producible.out[to];
            if (!fromAge || !toAge) continue;
            if (AGES.indexOf(age) < toAge.age)
                wrong.push(`${from} -> ${to} at ${age}, but ${to} is only producible from ${AGES[toAge.age]}`);
            if (toAge.age < fromAge.age)
                wrong.push(`${from} (from ${AGES[fromAge.age]}) would downgrade into ${to} (from ${AGES[toAge.age]})`);
        }
    }
    assert.deepEqual(wrong, [], wrong.join('; '));
});

test('every unit a civilization declares as unique can actually be trained', () => {
    // Reachability, judged the way the executor judges it: `requiredBuildingForUnit`
    // (openai-ai.js:547) answers from the shared tier table, then the civ's own trainAt,
    // then a building's static trainOptions. Null means no host claims the unit, and
    // executeTrainUnit then refuses with "no finished building can train it" — a path whose
    // comment says outright it "is only reached for unique units with no tier mapping".
    //
    // One unit in the shipped roster lands there: Yamato's archer_ship. Nothing in the
    // codebase references it except the civilizations.js entry that declares it (no dock
    // building exists), so it is unreachable content rather than a live bug — nothing can be
    // charged for it and nothing can order it, but a civ card that ever renders
    // uniqueUnits would promise a unit no building can produce. Naming it here is the point:
    // give it a host, drop it from the roster, or add it to this list with a reason.
    const unreachable = [];
    for (const civ of CIVS) {
        const ids = vm.runInContext(`(CIVILIZATIONS[${JSON.stringify(civ)}].uniqueUnits || []).map(u => u.id)`, scope);
        for (const id of ids) if (!requiredBuildingForUnit.call(null, id, civ)) unreachable.push(civ + '/' + id);
    }
    assert.deepEqual(unreachable, ['yamato/archer_ship'],
        'a civ declares a unique unit no host can produce: ' + unreachable.join(', '));
});
