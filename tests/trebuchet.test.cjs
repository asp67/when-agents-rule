// The trebuchet, Siege Engineering and the tower rules of b1110 (asp67, 23 Oct 2026).
// A seat walked a chain of towers across the map and raised the last two 12 from the
// enemy Town Center, where they killed the workers at its door and every soldier its
// archery range trained. Now no tower may stand within 200 of an enemy Town Center on
// its side of the map, a tower takes 20 s to build, a building under construction shows
// how far along it is, and the trebuchet answers towers -- and nothing else.
const test = require('node:test'), assert = require('node:assert/strict');
const vm = require('node:vm');
const { Realm } = require('../tools/bench/realm.cjs');

function board(seed = 3) {
    const m = new Realm({ seed });
    const [a, b] = m.startFixture(['greek', 'egyptian']);
    a.age = 'bronze'; b.age = 'bronze';
    m.addBuilding(a, 'town_center', -150, 0);
    m.addBuilding(b, 'town_center', 150, 0);
    return { m, a, b, g: m.game, ca: m.scripted(a), cb: m.scripted(b) };
}
const ev = (m, src) => vm.runInContext(src, m.context);

test('Siege Engineering: every civilization researches it at the academy in the bronze age, and it unlocks the trebuchet', () => {
    const { m } = board();
    for (const civ of ['egyptian', 'greek', 'persian', 'yamato', 'roman', 'viking', 'maya']) {
        const t = ev(m, `getCivilization('${civ}').techTree.siege_engineering`);
        assert.ok(t, civ + ' has siege_engineering');
        assert.equal(t.researchAt, 'academy'); assert.equal(t.requiredAge, 'bronze');
        assert.deepEqual(Object.assign({}, t.cost), { food: 0, wood: 150, stone: 0, gold: 100 });
        assert.deepEqual(Array.from(t.unlocks.buildings), ['trebuchet', 'trebuchet_advanced']);
    }
    const def = ev(m, 'BUILDING_DEFS.trebuchet');
    assert.equal(def.requiresTech, 'siege_engineering');
    assert.equal(def.buildTime, 20000);
    assert.equal(ev(m, 'BUILDING_DEFS.tower.buildTime'), 20000, 'a tower takes 20 s too');
});

test('the trebuchet: flat health for every civilization; the advanced engine is its own site at +20% cost; never upgraded', () => {
    const { m } = board();
    const make = (civ, age) => ev(m, `createBuilding('${age === 'iron' ? 'trebuchet_advanced' : 'trebuchet'}', 0, 0, 'x', '${civ}', { age: '${age}' })`);
    for (const civ of ['greek', 'egyptian']) {
        const s = make(civ, 'bronze'), a = make(civ, 'iron');
        assert.equal(s.maxHealth, 200, civ + ': no civilization or age multiplier (twice the first 100, asp67)');
        assert.equal(s.range, 50); assert.equal(s.attack, 150); assert.equal(s.watch, 120); assert.equal(s.advanced, false);
        assert.equal(a.maxHealth, 400); assert.equal(a.range, 60); assert.equal(a.attack, 200); assert.equal(a.watch, 144); assert.equal(a.advanced, true);
    }
    assert.deepEqual(Object.assign({}, ev(m, `buildingCost(BUILDING_DEFS.trebuchet, 'bronze')`)), { food: 100, wood: 200, stone: 100, gold: 50 });
    assert.deepEqual(Object.assign({}, ev(m, `buildingCost(BUILDING_DEFS.trebuchet, 'iron')`)), { food: 100, wood: 200, stone: 100, gold: 50 }, 'the simple engine keeps its price in the iron age');
    assert.deepEqual(Object.assign({}, ev(m, `BUILDING_DEFS.trebuchet_advanced.cost`)), { food: 120, wood: 240, stone: 120, gold: 60 });
    assert.equal(ev(m, `BUILDING_DEFS.trebuchet_advanced.requiredAge`), 'iron');
    assert.deepEqual(Object.assign({}, ev(m, `buildingCost(BUILDING_DEFS.tower, 'iron')`)), Object.assign({}, ev(m, 'BUILDING_DEFS.tower.cost')));
    const s = make('greek', 'bronze');
    assert.equal(ev(m, 'upgradeBuildingToAge')(s, 'iron'), false, 'no age-up morph');
    assert.equal(s.maxHealth, 200); assert.equal(s.range, 50);
});

test('a trebuchet throws at the nearest enemy tower in reach every 6 s, and at nothing else', () => {
    const { m, a, b, g } = board();
    const treb = m.addBuilding(a, 'trebuchet', 0, 0);
    const near = m.addBuilding(b, 'tower', 25, 0), far = m.addBuilding(b, 'tower', 0, 40);   // 25 in reach, 40 beyond 27
    const soldier = m.addUnit(b, 'warrior', 10, 5);                                             // a unit in reach: never hit
    const house = m.addBuilding(b, 'house', -15, 10);                                           // a building in reach: never hit
    const hp = [near.health, far.health, soldier.health, house.health];
    m.run(9000);   // thrown at 6 s, landed ~2.5 s later
    assert.equal(near.health, hp[0] - 150, 'one stone, 150');
    assert.equal(far.health, hp[1], 'out of reach');
    assert.equal(soldier.health, hp[2], 'units are never hit');
    assert.equal(house.health, hp[3], 'nor any building but a tower');
    assert.equal(near._lastAttacker, treb, 'the hit is the tower owner\'s alarm');
    m.run(6000);
    assert.equal(near.health, hp[0] - 300, 'the next stone 6 s later');
});

test('a tower site begun in a trebuchet\'s reach is hit at once, and its builder is not', () => {
    const { m, a, b, g } = board();
    m.addBuilding(a, 'trebuchet', 0, 0);
    m.run(8000);   // loaded, with nothing to throw at
    const site = m.addBuilding(b, 'tower', 20, 0, { underConstruction: true, health: 270, buildProgress: 0 });
    const builder = m.addUnit(b, 'worker', 21, 2);
    const hp = builder.health;
    m.run(2400);   // thrown at once, landed on the site's tick
    const curve = () => site.maxHealth * (0.2 + 0.8 * Math.min(1, site.buildProgress / site.buildTime));
    assert.ok(curve() - site.health > 140, 'thrown at once, landed: ' + Math.round(site.health) + ' of ' + Math.round(curve()));
    assert.equal(builder.health, hp, 'the worker building it is not hit');
    // The damage stays while the worker builds on (b1110): its health is the curve less
    // the stone, not lifted back onto the curve.
    m.run(3000);
    assert.ok(site.underConstruction && curve() - site.health > 140, `still down by the stone: ${Math.round(site.health)} of ${Math.round(curve())}`);
});

test('the tower owner\'s soldiers answer a trebuchet that hits a tower', () => {
    const { m, a, b, g } = board();
    const treb = m.addBuilding(a, 'trebuchet', 0, 0);
    m.addBuilding(b, 'tower', 25, 0);
    const guard = m.addUnit(b, 'warrior', 60, 0);   // idle, within reach of the struck tower
    m.run(9500);
    assert.equal(guard.attackTarget, treb, 'auto-defense sends the local soldier at the engine');
});

test('a trebuchet sees 20 around itself and 20 around each enemy tower in its watch, and nothing between', () => {
    const { m, a, b, g } = board();
    const treb = m.addBuilding(a, 'trebuchet', 0, 0);
    const tower = m.addBuilding(b, 'tower', 100, 0), beyond = m.addBuilding(b, 'tower', 0, 130);   // 100 inside the 120 watch, 130 outside
    const see = (x, z) => g.aiManager.isVisibleTo(a, x, z);
    // Only the trebuchet's eyes: no units of seat a.
    a.units.length = 0;
    for (const bld of a.buildings) if (bld !== treb) bld.health = 0;
    assert.ok(see(15, 0), 'its own 20');
    assert.ok(see(100, 0) && see(115, 0), 'the watched tower and 20 around it');
    assert.ok(!see(50, 0), 'nothing between');
    assert.ok(!see(100, 30), 'nothing beyond 20 of the tower');
    assert.ok(!see(0, 130), 'a tower beyond its watch is not revealed');
    const circles = g.buildingSightCircles(treb);
    assert.equal(circles.length, 2);
});

test('no tower within 200 of an enemy Town Center on its side of the map; one nearer your own is allowed', () => {
    const { m, a, b, g, ca } = board();
    // Town Centers at -150 (a) and 150 (b): 300 apart.
    assert.ok(g.towerSiteBlockedBy(a.id, 40, 0), '110 from the enemy, 190 from home: refused');
    assert.equal(g.towerSiteBlockedBy(a.id, -10, 0), null, '160 from the enemy but nearer home: allowed');
    assert.equal(g.towerSiteBlockedBy(a.id, 0, 260), null, 'over 200 from the enemy: allowed');
    // A forward Town Center does not deny the other side towers at home.
    m.addBuilding(a, 'town_center', 20, 0);
    assert.equal(g.towerSiteBlockedBy(b.id, 120, 0), null, 'nearer its own Town Center: b may still fortify home');
    // The model is told why, and nothing is spent.
    Object.assign(a.resources, { food: 1000, wood: 1000, stone: 1000, gold: 1000 });
    m.addUnit(a, 'worker', 60, 5);
    const r = String(m.command(ca, 'build_structure', { buildingType: 'tower', targetX: 110, targetZ: 30, reason: 'creep' }));
    assert.match(r, /\[ERROR\] tower: .* from an enemy Town Center .* No tower may stand within 200 of an enemy Town Center on its side of the map\./);
    assert.equal(a.resources.stone, 1000, 'nothing spent');
});

test('an enemy building under construction carries its state and progress', () => {
    const { m, a, b, g } = board();
    const site = m.addBuilding(b, 'tower', 100, 0, { underConstruction: true, health: 300, buildProgress: 5000 });
    const done = m.addBuilding(b, 'barracks', 120, 30);
    const H = ev(m, 'OpenAIAIManager');
    const s = H.buildingSighting(site, g), d = H.buildingSighting(done, g);
    assert.equal(s.state, 'under_construction'); assert.equal(s.buildPct, 25);
    assert.equal(d.state, undefined); assert.equal(d.buildPct, undefined);
});

// The trebuchet on wheels (b1110, asp67): an iron-age trebuchet site rolls off as a
// unit. It moves at 0.08, joins formations as ranged, throws only while it stands, has
// no attack of its own, takes no population, is repaired by workers and not healed.
function ironBoard() {
    const b = board(); b.a.age = 'iron'; b.b.age = 'iron'; return b;
}
function mobile(b, x = 0, z = 0) {
    const { m, a, g } = b;
    const site = m.addBuilding(a, 'trebuchet_advanced', x, z, { underConstruction: true, health: 150, buildProgress: 20000 });
    site._drawRY = 1.2;
    g.completeConstruction(site);
    return { site, unit: a.units.find(u => u.type === 'advanced_trebuchet') };
}

test('a finished iron-age trebuchet becomes a unit on wheels where it stood, with the damage of the site', () => {
    const b = ironBoard(), { m, a, g } = b;
    const pop = a.resources.population;
    const { site, unit } = mobile(b, 10, 20);
    assert.ok(unit, 'a unit');
    assert.ok(!a.buildings.includes(site) && !g.getAllBuildings().includes(site), 'the site is gone');
    assert.equal(unit.type, 'advanced_trebuchet'); assert.equal(unit.unitType, 'siege'); assert.equal(unit.speed, 0.32); assert.equal(unit.attack, 0);
    assert.equal(unit.maxHealth, 400); assert.equal(unit.health, 150, 'the damage the site took');
    assert.equal(unit.x, 10); assert.equal(unit.z, 20); assert.equal(unit._spawnDir, 1.2, 'facing as the site did');
    assert.equal(unit.siegeAttack, 200); assert.equal(unit.range, 60); assert.equal(unit.watch, 144);
    assert.equal(a.resources.population, pop, 'no population');
    assert.equal(ev(m, 'Game').populationOf(a.units), a.units.filter(u => u.type !== 'advanced_trebuchet').length);
});

test('it throws only while it stands, at towers only, and never fights', () => {
    const b = ironBoard(), { m, a, g } = b;
    const { unit } = mobile(b);
    const tower = m.addBuilding(b.b, 'tower', 30, 0), enemy = m.addUnit(b.b, 'warrior', 8, 0);
    const hp = tower.health, ehp = enemy.health;
    unit.isMoving = true; unit.targetX = 5; unit.targetZ = 0;      // creeping east: no throw
    for (let i = 0; i < 140; i++) { m.run(50); unit.isMoving = true; unit.targetX = unit.x + 5; unit.targetZ = 0; }
    assert.equal(tower.health, hp, 'nothing thrown while moving');
    unit.isMoving = false; unit.targetX = unit.x; unit.targetZ = unit.z;
    m.run(3300);
    assert.equal(tower.health, hp - 200, 'a stone the moment it stands: it was loaded');
    assert.equal(unit.isAttacking, false, 'it never engages a unit');
});

// asp67 (b1110): "A built trebuchet needs to behave like a unit, so it needs to be added to
// formation." A bare order used to leave it at home, and seats moved it alone.
test('a bare order takes it along like any unit; in a formation it marches as ranged and sets the pace', () => {
    const b = ironBoard(), { m, a, g, ca } = b;
    const { unit } = mobile(b, -100, 0);
    const w = [0, 1, 2].map(i => m.addUnit(a, 'warrior', -100, 4 + i * 2));
    m.command(ca, 'move_units', { targetX: -40, targetZ: 0, reason: 'bare' });
    assert.ok(unit._standingOrder && unit._standingOrder === w[0]._standingOrder, 'a bare move order takes it along');
    const r = String(m.command(ca, 'move_units', { unitIds: [unit.handle, ...w.map(u => u.handle)], targetX: -40, targetZ: 0, formation: 'line', reason: 'named' }));
    assert.doesNotMatch(r, /\[ERROR\]/);
    assert.ok(unit._standingOrder && unit._standingOrder === w[0]._standingOrder, 'it marches with them');
    assert.equal(w[0].marchSpeed, 0.32, 'the formation goes at its pace');
    const slots = unit._standingOrder.slots;
    const ahead = s => (s.x - -100);   // the march runs +x
    assert.ok(ahead(slots.get(unit)) < Math.min(...w.map(u => ahead(slots.get(u)))), 'a ranged slot, behind the melee');
    const atk = String(m.command(ca, 'attack_target', { unitIds: [unit.handle], targetX: 50, targetZ: 0, reason: 'siege only' }));
    assert.match(atk, /A trebuchet does not attack/);
});

test('workers repair it, priests do not heal it, auto-defense never drafts it, techs never touch it, and it keeps no seat alive', () => {
    const b = ironBoard(), { m, a, g, ca } = b;
    const { unit } = mobile(b, 0, 0);
    unit.health = 120;
    const priest = m.addUnit(a, 'priest', 4, 0);
    m.run(3000);
    assert.equal(unit.health, 120, 'not healed');
    m.addUnit(a, 'worker', 5, 5);
    const r = String(m.command(ca, 'repair_building', { targetX: 0, targetZ: 0, reason: 'mend' }));
    assert.doesNotMatch(r, /\[ERROR\]/, r);
    m.run(4000);
    assert.ok(unit.health > 120, 'repaired: ' + unit.health);
    // An all-military attack tech gives it no weapon.
    g.applyBonusToOneUnit({ attack: 3, health: 15 }, 'all_military', unit);
    assert.equal(unit.attack, 0); assert.equal(unit.maxHealth, 400);
    // Auto-defense: a hit near it does not send it.
    const guard = m.addUnit(a, 'warrior', 2, 2), raider = m.addUnit(b.b, 'warrior', 3, 3);
    guard._lastDamageTime = g.simNow(); guard._lastAttacker = raider; guard.health -= 1;
    m.run(1000);
    assert.equal(unit.isAttacking, false); assert.equal(unit.attackTarget || null, null);
    // A seat with nothing but the engine left is not kept alive by it.
    const lone = { units: [unit], buildings: [], resources: a.resources, id: a.id, age: 'iron', civilization: a.civilization };
    assert.equal(g.isPlayerEliminated(lone), g.isPlayerEliminated({ ...lone, units: [] }), 'the engine counts for nothing here');
});

test('its watch rides with it: enemy towers within 144 and 20 around them', () => {
    const b = ironBoard(), { m, a, g } = b;
    const { unit } = mobile(b, 0, 0);
    a.units.length = 0; a.units.push(unit);
    for (const bld of a.buildings) bld.health = 0;
    m.addBuilding(b.b, 'tower', 140, 0);
    const see = (x, z) => g.aiManager.isVisibleTo(a, x, z);
    assert.ok(see(15, 0), 'its own 20');
    assert.ok(see(140, 0) && see(155, 0), 'the tower 140 off and 20 around it');
    assert.ok(!see(70, 0), 'nothing between');
});

// asp67, 23 Oct 2026 (b1110): "I am currently witnessing how one seat constantly destroys
// the building site of the other seat ... make it invisible to the enemy until it actually
// starts building", and "make sure that an attack order in the vicinity does not attack the
// building site coincidentally".
test('a trebuchet site no one has worked on is unseen and untouched by the enemy; the first swing reveals it', () => {
    const { m, a, b, g, cb } = board();
    const site = m.addBuilding(a, 'trebuchet', 40, 0, { underConstruction: true, health: 20, buildProgress: 0 });
    // The enemy stands right beside it, with an attack order passing it.
    const raiders = [0, 1, 2].map(i => m.addUnit(b, 'warrior', 46, i * 2));
    const r = String(m.command(cb, 'attack_target', { targetX: -60, targetZ: 0, reason: 'sweep west past it' }));
    assert.doesNotMatch(r, /\[ERROR\]/, r);
    m.run(4000);
    assert.equal(site.health, 20, 'the attack order passing by leaves it alone');
    assert.ok(raiders.every(u => u.attackTarget !== site));
    assert.equal(g.findNearestEnemyInRange(raiders[0], 30, true) === site, false, 'not acquired');
    const seen = b._knownEnemyBuildings && b._knownEnemyBuildings.has(site);
    assert.ok(!seen, 'not in what the enemy knows');
    const byId = String(m.command(cb, 'attack_target', { targetId: site.id, reason: 'guessed id' }));
    assert.match(byId, /\[ERROR\]/, 'its id names nothing for the enemy');
    // The first swing: from now on it is a site like any other.
    site.buildProgress = 50;
    assert.equal(ev(m, 'Game').hiddenSite(site), false);
    assert.equal(g.findNearestEnemyInRange(raiders[0], 30, true), site, 'now it can be found');
});

// The engineer (b1110, asp67): "maybe we should introduce an engineer unit, that is a weak
// melee fighting class but can build trebuchets ... a part of the natural formation".
test('the academy trains engineers only after Siege Engineering', () => {
    const { m, a, g, ca } = board();
    m.addBuilding(a, 'academy', -120, 30);
    Object.assign(a.resources, { food: 1000, wood: 1000, stone: 1000, gold: 1000 });
    for (const bld of a.buildings) if (bld.type === 'academy') bld.trainOptions = ev(m, `getTrainOptionsForBuilding('academy','bronze','greek')`);
    const before = String(m.command(ca, 'train_unit', { unitType: 'engineer', reason: 'too soon' }));
    assert.match(before, /\[ERROR\]/, before);
    a.researchedTechs.siege_engineering = true;
    const after = String(m.command(ca, 'train_unit', { unitType: 'engineer', reason: 'now' }));
    assert.doesNotMatch(after, /\[ERROR\]/, after);
    const def = ev(m, 'UNIT_DEFS.engineer');
    assert.deepEqual(Object.assign({}, def.cost), Object.assign({}, ev(m, 'UNIT_DEFS').militia.cost), 'the price of a militia');
    assert.deepEqual(Object.assign({}, def.cost), { food: 50, wood: 20, stone: 0, gold: 0 });
    assert.equal(def.health, 50); assert.equal(def.attack, 4); assert.equal(def.speed, 1.0); assert.equal(def.type, 'infantry');
    assert.match(ev(m, `getCivilization('greek').techTree.siege_engineering.description`), /Pionier/);
});

test('only an engineer builds a trebuchet: it leaves its formation, builds, and walks back to its slot', () => {
    const { m, a, g, ca } = board();
    a.researchedTechs.siege_engineering = true;
    Object.assign(a.resources, { food: 2000, wood: 2000, stone: 2000, gold: 2000 });
    const worker = m.addUnit(a, 'worker', -40, 0);
    // Without an engineer: refused, though a villager stands idle beside the spot.
    const none = String(m.command(ca, 'build_structure', { buildingType: 'trebuchet', targetX: -30, targetZ: 0, reason: 'no engineer' }));
    assert.match(none, /only an engineer builds a trebuchet/, none);
    const army = [0, 1, 2].map(i => m.addUnit(a, 'warrior', -60, i * 2));
    const eng = m.addUnit(a, 'engineer', -62, 6);
    m.command(ca, 'move_units', { unitIds: army.concat(eng).map(u => u.handle), targetX: -60, targetZ: 40, formation: 'line', reason: 'form up' });
    const grp = eng._standingOrder;
    const ahead = s => s.z;   // the march runs +z
    assert.ok(ahead(grp.slots.get(eng)) < Math.min(...army.map(u => ahead(grp.slots.get(u)))), 'the engineer marches in the rear');
    m.run(500);
    const r = String(m.command(ca, 'build_structure', { buildingType: 'trebuchet', targetX: -40, targetZ: 20, reason: 'siege' }));
    assert.match(r, /engineer #\d+ leaves its formation to build it/, r);
    const site = a.buildings.find(b => b.type === 'trebuchet');
    assert.ok(site && eng.task === 'building' && eng.buildTarget === site);
    assert.ok(worker.task !== 'building', 'no villager is sent');
    assert.equal(g.findOrphanedConstruction(a, worker), null, 'nor picks it up as an orphaned site');
    m.run(40000);   // walk there, 20 s of work
    assert.equal(site.underConstruction, false, 'built');
    assert.equal(eng.task, null, 'job done');
    m.run(30000);
    const slot = eng._standingOrder.slots.get(eng);
    assert.ok(Math.hypot(eng.x - slot.x, eng.z - slot.z) < 2, 'back in its slot');
});

test('engineers and villagers mend a trebuchet together', () => {
    const b = board(); b.a.age = 'iron'; b.b.age = 'iron';
    const { m, a, g, ca } = b;
    const site = m.addBuilding(a, 'trebuchet_advanced', 0, 0, { underConstruction: true, health: 200, buildProgress: 20000 });
    g.completeConstruction(site);
    const unit = a.units.find(u => u.type === 'advanced_trebuchet');
    unit.health = 80;
    const eng = m.addUnit(a, 'engineer', 6, 0), w = m.addUnit(a, 'worker', -6, 0);
    const r = String(m.command(ca, 'repair_building', { targetX: 0, targetZ: 0, count: 2, reason: 'mend' }));
    assert.match(r, /1 worker\(s\) and 1 engineer\(s\) repairing/, r);
    m.run(2000);
    assert.ok(unit.health > 80 + 100, 'two hands at 50/s: ' + unit.health);
});

// asp67: "Seats keep treating the trebuchet as a unit and thus expecting it to move ...
// add wheels to the simple trebuchet and let it move at the speed of the advanced
// trebuchet and double the speed of the advanced trebuchet." (b1110)
test('a bronze-age trebuchet rolls off as the simple engine on wheels at 0.16; the iron-age one at 0.32', () => {
    const { m, a, g } = board();   // bronze
    const site = m.addBuilding(a, 'trebuchet', 0, 0, { underConstruction: true, health: 100, buildProgress: 20000 });
    g.completeConstruction(site);
    const simple = a.units.find(u => u.unitType === 'siege');
    assert.equal(simple.type, 'simple_trebuchet');
    assert.equal(simple.speed, 0.16); assert.equal(simple.maxHealth, 200); assert.equal(simple.range, 50);
    assert.equal(simple.siegeAttack, 150); assert.equal(simple.watch, 120); assert.equal(simple.advanced, false);
    assert.equal(ev(m, 'UNIT_DEFS.advanced_trebuchet.speed'), 0.32);
    // What each engine becomes, and how fast it rolls.
    assert.equal(ev(m, `trebuchetTier('bronze').unit`), 'simple_trebuchet');
    assert.equal(ev(m, `trebuchetTier('iron').speed`), 0.32);
});

// asp67: "allow both models per selection in iron age, since a basic trebuchet is
// cheaper and might be the better choice in some occasions." (b1110)
test('in the iron age both engines can be chosen: a trebuchet site stays the simple engine', () => {
    const b = board(); b.a.age = 'iron';
    const { m, a, g } = b;
    for (const [type, unit, speed] of [['trebuchet', 'simple_trebuchet', 0.16], ['trebuchet_advanced', 'advanced_trebuchet', 0.32]]) {
        const site = m.addBuilding(a, type, 0, 0, { underConstruction: true, health: 50, buildProgress: 20000 });
        g.completeConstruction(site);
        const u = a.units.find(x => x.type === unit);
        assert.ok(u, type + ' becomes ' + unit);
        assert.equal(u.speed, speed);
    }
});

// asp67 (b1110): "after retaliation, the engineer needs to return to building the trebuchet".
test('an engineer attacked at its site fights back, then goes back to building the trebuchet', () => {
    for (const inFormation of [false, true]) {
        const { m, a, b, g, ca } = board();
        a.researchedTechs.siege_engineering = true;
        Object.assign(a.resources, { food: 2000, wood: 2000, stone: 2000, gold: 2000 });
        const eng = m.addUnit(a, 'engineer', -40, 0);
        if (inFormation) {
            const army = [0, 1].map(i => m.addUnit(a, 'warrior', -44, i * 2));
            m.command(ca, 'move_units', { unitIds: army.concat(eng).map(u => u.handle), targetX: -44, targetZ: 4, formation: 'line', reason: 'form' });
            m.run(3000);
        }
        const r = String(m.command(ca, 'build_structure', { buildingType: 'trebuchet', targetX: -40, targetZ: 16, reason: 'siege' }));
        assert.match(r, inFormation ? /engineer #\d+ leaves its formation to build it/ : /engineer #\d+ walks there from .* and stays by the trebuchet after/, r);
        const site = a.buildings.find(x => x.type === 'trebuchet');
        m.run(9000);   // there, and building
        assert.ok(site.buildProgress > 0, 'work has begun');
        const raider = m.addUnit(b, 'militia', eng.x + 6, eng.z);
        raider.health = 12; raider.isAttacking = true; raider.attackTarget = eng;
        let fought = false, buildingPose = false;
        for (let t = 0; t < 20000 && raider.health > 0; t += 250) {
            m.run(250); fought = fought || eng.isAttacking;
            // asp67: "it is literally standing in the open still showing the building
            // animation 60 units away from the build site" -- never while it fights.
            buildingPose = buildingPose || (eng.isAttacking && eng.isBuilding);
        }
        assert.ok(raider.health <= 0, 'the raider fell');
        assert.ok(fought, 'the engineer fought back');
        assert.ok(!buildingPose, 'no building pose while it fights');
        m.run(30000);
        assert.ok(!a.buildings.includes(site) && a.units.some(u => u.type === 'simple_trebuchet'),
            (inFormation ? 'in a formation' : 'on its own') + ': the trebuchet got built after the fight');
    }
});

// asp67 (b1110): "A trebuchet tower registers the damage at the moment the boulder leaves the
// trebuchet not at the moment it hits the tower, that needs fixing. Be aware the trebuchet
// could be destroyed in between so it still needs to register in this case."
test('a stone does its damage when it lands, even if its trebuchet is destroyed meanwhile', () => {
    const { m, a, b, g } = board();
    const treb = m.addBuilding(a, 'trebuchet', 0, 0);
    const tower = m.addBuilding(b, 'tower', 25, 0);
    const hp = tower.health;
    m.run(6050);   // the first throw
    assert.ok(g._boulders && g._boulders.length === 1, 'a stone is in the air');
    const s = g._boulders[0];
    assert.equal(tower.health, hp, 'nothing yet: it has not landed');
    assert.ok(Math.abs(s.landAt - treb._throwAt - (ev(m, 'Game').TREB_RELEASE_MS + ev(m, 'Game').boulderFlightMs(25))) < 1e-6, 'release plus flight');
    treb.health = 0; g.destroyTarget(treb);   // the engine falls while the stone flies
    m.run(3000);
    assert.equal(tower.health, hp - 150, 'it lands all the same');
    assert.equal(tower._lastAttacker, treb, 'credited to the engine that threw it');
    assert.equal(g._boulders.length, 0);
});

// asp67 (b1110): "when a formation is ordered to attack a tower with a trebuchet in the
// formation, make sure that until the trebuchet is destroyed, the formation does not
// charge into the tower to be annihilated."
test('a formation besieging a tower with a trebuchet stands off until the trebuchet is gone, then attacks', () => {
  for (const [siteType, unitType, speed] of [['trebuchet', 'simple_trebuchet', 0.16], ['trebuchet_advanced', 'advanced_trebuchet', 0.32]]) {
    const { m, a, b, g, ca } = board();
    const tower = m.addBuilding(b, 'tower', 0, 0);
    const site = m.addBuilding(a, siteType, -45, 0, { underConstruction: true, health: 100, buildProgress: 20000 });
    g.completeConstruction(site);
    const treb = a.units.find(u => u.type === unitType);
    assert.equal(treb.speed, speed, 'doubled');
    const army = [0, 1, 2, 3].map(i => m.addUnit(a, 'warrior', -48, (i - 1.5) * 2));
    const r = String(m.command(ca, 'attack_target', { targetId: tower.id, unitIds: army.concat(treb).map(u => u.handle), formation: 'line', reason: 'siege' }));
    assert.doesNotMatch(r, /\[ERROR\]/, r);
    assert.match(r, /they stand off out of its reach while the trebuchets throw/, r);
    const hp = tower.health, reach = tower.range || 18;
    let closest = Infinity, onTower = 0;
    for (let t = 0; t < 90000; t += 250) {
        m.run(250);
        for (const u of army) if (u.health > 0) {
            closest = Math.min(closest, Math.hypot(u.x - tower.x, u.z - tower.z));
            if (u.attackTarget === tower) onTower++;
        }
    }
    assert.ok(closest > reach, 'no soldier walked into the tower\'s reach: closest ' + closest.toFixed(1));
    assert.equal(onTower, 0, 'nor took the tower as its target');
    const d = Math.hypot(treb.x - tower.x, treb.z - tower.z);
    assert.ok(d <= treb.range && d > reach, 'the trebuchet stands in its own reach, out of the tower\'s: ' + d.toFixed(1));
    assert.ok(tower.health < hp - 600, 'its stones land: ' + Math.round(hp - tower.health) + ' damage');
    // asp67: "the soldiers need to stand at the trebuchet to defend it" -- beside it, not on
    // it: with the engine's slot in the middle of their formation the lot shoved each other
    // about, "a flock of hooligans, not a formation" (asp67).
    const live = army.filter(u => u.health > 0);
    const near = Math.min(...live.map(u => Math.hypot(u.x - treb.x, u.z - treb.z)));
    assert.ok(near <= 8, 'the soldiers stand at the trebuchet: the nearest ' + near.toFixed(1) + ' from it');
    assert.ok(near >= 3, 'beside it, none in its place: ' + near.toFixed(1));
    // The trebuchet falls: the order is the tower again.
    treb.health = 0; g.destroyTarget(treb);
    let went = false;
    for (let t = 0; t < 15000 && !went; t += 250) { m.run(250); went = army.some(u => u.health > 0 && u.attackTarget === tower) || !(tower.health > 0); }
    assert.ok(went, unitType + ': the soldiers go for the tower');
  }
});

// asp67's match of 23 October (b1110): a Viking trebuchet site stood at 86% for 45
// minutes after its engineer fell, while a new engineer idled 25 away.
test('an idle engineer finishes a trebuchet site whose engineer fell; one on an order 60 away does not', () => {
    for (const onOrder of [false, true]) {
        const { m, a, g, ca } = board();
        a.researchedTechs.siege_engineering = true;
        Object.assign(a.resources, { food: 2000, wood: 2000, stone: 2000, gold: 2000 });
        const first = m.addUnit(a, 'engineer', -40, 0);
        m.command(ca, 'build_structure', { buildingType: 'trebuchet', targetX: -40, targetZ: 12, reason: 'siege' });
        const site = a.buildings.find(x => x.type === 'trebuchet');
        m.run(9000);
        assert.ok(site.buildProgress > 0 && site.underConstruction, 'begun, not done');
        first.health = 0; g.destroyTarget(first);
        const progress = site.buildProgress;
        // Idle, 37 from the site; on an order, 60 -- beyond the 40 an engineer answers.
        const next = m.addUnit(a, 'engineer', onOrder ? -100 : -70, -10);
        if (onOrder) m.command(ca, 'move_units', { unitIds: [next.handle], targetX: -105, targetZ: -10, mode: 'guard', reason: 'stay' });

        m.run(40000);
        if (onOrder) {
            assert.equal(site.buildProgress, progress, 'an engineer on an order is left to it');
            assert.ok(a.buildings.includes(site));
        } else {
            assert.ok(!a.buildings.includes(site) && a.units.some(u => u.type === 'simple_trebuchet'), 'the idle engineer finished it');
        }
    }
});

// The same match: an attack_target to a point naming an advanced trebuchet was "matched
// to the slowest: all marching at 1 (engineer pace)", and the army reached the Wonder
// with the trebuchet 150 behind.
// The match of 24 October: an idle engineer was sent to a site at any distance, and each
// one the Vikings trained walked from their academy into the Greek base, 550 away, and
// died there -- four, one after another, none of them ordered.
test('an idle engineer far from a trebuchet site is never sent to it unasked', () => {
    const { m, a } = board();
    const site = m.addBuilding(a, 'trebuchet', -40, 200, { underConstruction: true, health: 20, buildProgress: 0 });
    const home = m.addUnit(a, 'engineer', -300, 0);
    m.run(20000);
    assert.ok(!home.task, 'not sent');
    assert.ok(Math.hypot(home.x - -300, home.z) < 1, 'still at home');
    assert.equal(site.buildProgress, 0);
});

test('an attack to a point paces its formation to the trebuchet it names, and says it goes along', () => {
    const b = ironBoard(), { m, a, ca } = b;
    const { unit } = mobile(b, -100, 0);
    const w = [0, 1, 2].map(i => m.addUnit(a, 'warrior', -100, 4 + i * 2));
    const r = String(m.command(ca, 'attack_target', { unitIds: [unit.handle, ...w.map(u => u.handle)], targetX: 100, targetZ: 0, matchSpeed: 'slowestUnit', reason: 'march' }));
    assert.match(r, /all marching at 0\.32 \(advanced_trebuchet pace\)/, r);
    assert.match(r, new RegExp('advanced_trebuchet #' + unit.handle + ' goes with them'), r);
    assert.ok(w.every(u => u.marchSpeed === 0.32), 'the fighters held to its pace');
    m.run(30000);
    const lead = Math.max(...w.map(u => u.x));
    assert.ok(lead - unit.x < 20, 'still together: fighters ' + lead.toFixed(1) + ', trebuchet ' + unit.x.toFixed(1));
});

// asp67 (b1110, with a screenshot): "Engineer is not leaving formation to build the
// trebuchet." The army's next order swept it back in as an infantryman and the job was
// dropped without a word. asp67: "Engineers should always finish build sites in their
// vicinity first before anything else, except retaliation."
test('an order that takes an engineer on a trebuchet job lets it finish first, then it joins', () => {
    for (const how of ['bare', 'infantry', 'ids', 'attack']) {
        const { m, a, ca } = board();
        a.researchedTechs.siege_engineering = true;
        Object.assign(a.resources, { food: 2000, wood: 2000, stone: 2000, gold: 2000 });
        const army = [0, 1, 2].map(i => m.addUnit(a, 'warrior', -60, i * 2));
        const eng = m.addUnit(a, 'engineer', -62, 6);
        m.command(ca, 'move_units', { unitIds: army.concat(eng).map(u => u.handle), targetX: -60, targetZ: 10, formation: 'line', reason: 'form' });
        m.run(15000);
        m.command(ca, 'build_structure', { buildingType: 'trebuchet', targetX: -30, targetZ: 10, reason: 'siege' });
        const site = a.buildings.find(x => x.type === 'trebuchet');
        const p = { targetX: -60, targetZ: 30, reason: 'regroup' };
        if (how === 'infantry') p.units = { infantry: 9 };
        if (how === 'ids') p.unitIds = army.concat(eng).map(u => u.handle);
        const r = String(m.command(ca, how === 'attack' ? 'attack_target' : 'move_units', p));
        assert.match(r, new RegExp('engineer #' + eng.handle + ' finishes its trebuchet first, then joins this order'), how + ': ' + r);
        assert.equal(eng.task, 'building', how + ': still on the job');
        m.run(40000);
        assert.ok(!a.buildings.includes(site) && a.units.some(u => u.type === 'simple_trebuchet'), how + ': the trebuchet got built');
        m.run(30000);
        assert.ok(eng._standingOrder && eng._standingOrder === army[0]._standingOrder, how + ': then it is in the order');
        assert.ok(Math.hypot(eng.x - -60, eng.z - 30) < 12, how + ': and at its place: ' + eng.x.toFixed(1) + ', ' + eng.z.toFixed(1));
    }
});

// asp67: "not build sites already being built. ... The closest engineer not already
// building starts to build. No extra order needed. But an engineer can be sent to a
// trebuchet build site with a repair or build order."
test('a trebuchet site nobody builds takes the closest free engineer within 40; a worked one takes nobody unasked', () => {
    for (const [off, worked] of [[30, false], [60, false], [30, true]]) {
        const { m, a, ca } = board();
        a.researchedTechs.siege_engineering = true;
        Object.assign(a.resources, { food: 2000, wood: 2000, stone: 2000, gold: 2000 });
        let site, builder = null;
        if (worked) {
            builder = m.addUnit(a, 'engineer', -40, 0);
            m.command(ca, 'build_structure', { buildingType: 'trebuchet', targetX: -40, targetZ: 10, reason: 'siege' });
            site = a.buildings.find(x => x.type === 'trebuchet');
        } else {
            site = m.addBuilding(a, 'trebuchet', -40, 10, { underConstruction: true, health: 20, buildProgress: 0 });
        }
        // Two engineers march past, `off` from the site at their nearest; the nearer one is first.
        const army = [0, 1].map(i => m.addUnit(a, 'warrior', -40 + off, -60 + i * 2));
        const near = m.addUnit(a, 'engineer', -40 + off, -64), far = m.addUnit(a, 'engineer', -40 + off + 4, -66);
        m.command(ca, 'move_units', { unitIds: army.concat(near, far).map(u => u.handle), targetX: -40 + off, targetZ: 80, reason: 'march past' });
        const took = new Set();
        for (let t = 0; t < 30000; t += 500) { m.run(500); for (const e of [near, far]) if (e.task === 'building' && e.buildTarget === site) took.add(e); }
        const label = off + ' off, ' + (worked ? 'worked' : 'unworked');
        if (!worked && off < 40) assert.deepEqual([...took], [near], label + ': the closest one builds it, alone');
        else assert.equal(took.size, 0, label + ': nobody leaves the march');
    }
});

test('build_structure or repair_building on a trebuchet site sends one more engineer', () => {
    for (const how of ['build_structure', 'repair_building']) {
        const { m, a, ca } = board();
        a.researchedTechs.siege_engineering = true;
        Object.assign(a.resources, { food: 2000, wood: 2000, stone: 2000, gold: 2000 });
        const first = m.addUnit(a, 'engineer', -40, 0);
        m.command(ca, 'build_structure', { buildingType: 'trebuchet', targetX: -40, targetZ: 10, reason: 'siege' });
        const site = a.buildings.find(x => x.type === 'trebuchet');
        const second = m.addUnit(a, 'engineer', -80, 0);
        m.command(ca, 'move_units', { unitIds: [second.handle], targetX: -80, targetZ: 0, mode: 'guard', reason: 'stand' });
        m.run(2000);
        assert.equal(second.task, null, 'not unasked');
        const wood = a.resources.wood;
        const r = String(m.command(ca, how, how === 'build_structure'
            ? { buildingType: 'trebuchet', targetX: -40, targetZ: 10, reason: 'help' }
            : { targetX: -40, targetZ: 10, reason: 'help' }));
        assert.match(r, new RegExp('engineer #' + second.handle), how + ': ' + r);
        assert.equal(second.task, 'building'); assert.equal(second.buildTarget, site);
        assert.equal(a.buildings.filter(x => x.type === 'trebuchet').length, 1, how + ': no second site');
        assert.equal(a.resources.wood, wood, how + ': nothing paid');
    }
});



// asp67: "engineers only build trebuchets, nothing else, villagers build everything except
// trebuchets. Engineers and villagers can repair trebuchets, buildings can only be repaired
// by villagers, that includes towers."
test('engineers build and mend trebuchets only; villagers build everything else and mend both', () => {
    const { m, a, ca } = board();
    a.researchedTechs.siege_engineering = true; a.researchedTechs.house = true;
    Object.assign(a.resources, { food: 2000, wood: 2000, stone: 2000, gold: 2000 });
    const e = m.addUnit(a, 'engineer', -40, 0);
    const tower = m.addBuilding(a, 'tower', -40, 10); tower.health = tower.maxHealth / 2;
    const r = String(m.command(ca, 'repair_building', { targetX: -40, targetZ: 10, reason: 'tower' }));
    assert.match(r, /Only villagers repair buildings; engineers mend trebuchets only/, r);
    assert.match(String(m.command(ca, 'build_structure', { buildingType: 'house', targetX: -60, targetZ: 20, reason: 'house' })), /no workers/);
    const barracks = m.addBuilding(a, 'barracks', -50, -20, { underConstruction: true, health: 20, buildProgress: 0 });
    m.run(5000);
    assert.equal(barracks.buildProgress, 0, 'an idle engineer leaves a barracks site alone');
    assert.ok(!e.task);
    const w = m.addUnit(a, 'worker', -30, 0);
    const site = m.addBuilding(a, 'trebuchet', -20, 0, { underConstruction: true, health: 20, buildProgress: 0 });
    m.run(500);
    assert.equal(e.buildTarget, site, 'the engineer takes the trebuchet site');
    assert.notEqual(w.buildTarget, site, 'the villager does not');
});

// asp67 (b1110): "An engineer actively building a trebuchet while not taking direct damage
// should finish the build first, before joining the tower retaliation event."
test('an engineer building a trebuchet out of a tower\'s reach builds on while its soldiers fight the tower', () => {
    for (const form of [false, true]) {
        const { m, a, b, ca } = board();
        a.researchedTechs.siege_engineering = true;
        Object.assign(a.resources, { food: 5000, wood: 5000, stone: 5000, gold: 5000 });
        const army = [0, 1, 2].map(i => m.addUnit(a, 'warrior', 20, i * 2));
        const eng = m.addUnit(a, 'engineer', 14, 4);
        if (form) { m.command(ca, 'move_units', { unitIds: army.concat(eng).map(u => u.handle), targetX: 20, targetZ: 4, formation: 'line', reason: 'form' }); m.run(4000); }
        m.command(ca, 'build_structure', { buildingType: 'trebuchet', targetX: 6, targetZ: 0, reason: 'siege' });
        const site = a.buildings.find(x => x.type === 'trebuchet');
        m.run(6000);
        m.addBuilding(b, 'tower', 36, 0);   // in reach of the soldiers, not of the engineer
        let fought = false;
        for (let t = 0; t < 20000 && a.buildings.includes(site); t += 250) { m.run(250); fought = fought || eng.isAttacking; }
        const label = form ? 'in a formation' : 'on its own';
        assert.ok(!fought, label + ': it never joined the fight');
        assert.ok(!a.buildings.includes(site) && a.units.some(u => u.type === 'simple_trebuchet'), label + ': the trebuchet got built');
    }
});

// asp67 (b1110): "Many times, while the trebuchet site is set, the enemy builds a tower right
// next to it. Creating a deadlock situation ... Towers can see and attack trebuchet building
// sites. A trebuchet building site only gets its cost applied after the first hitpoint has
// been added by the builder. Trebuchet building sites start at 0 HP instead of 20% HP."
function siegeSeat() {
    const b = board();
    b.a.researchedTechs.siege_engineering = true;
    Object.assign(b.a.resources, { food: 2000, wood: 2000, stone: 2000, gold: 2000 });
    return b;
}
const purse = r => [r.food, r.wood, r.stone, r.gold].map(Math.round);

test('a trebuchet site starts at 0 HP, is paid for when placed, and grows to full health', () => {
    const { m, a, ca } = siegeSeat();
    m.addUnit(a, 'engineer', -80, 0);
    const before = purse(a.resources);
    const r = String(m.command(ca, 'build_structure', { buildingType: 'trebuchet', targetX: -40, targetZ: 0, reason: 'siege' }));
    assert.match(r, /Its cost is returned if the site is destroyed before the engineer begins/, r);
    const site = a.buildings.find(x => x.type === 'trebuchet');
    assert.ok(site.health > 0 && site.health < 0.5, 'starts at 0: ' + site.health);
    const paid = [before[0] - 100, before[1] - 200, before[2] - 100, before[3] - 50];
    assert.deepEqual(purse(a.resources), paid, 'paid on placing, so it cannot be spent twice');
    m.run(40000);
    const engine = a.units.find(u => u.type === 'simple_trebuchet');
    assert.ok(engine, 'built');
    assert.equal(engine.health, engine.maxHealth, 'from nothing to full');
    assert.deepEqual(purse(a.resources), paid, 'paid once');
});

// asp67 (b1110): "An Engineer just approached a trebuchet building site, but the first stroke
// with his hammer did not build but destroy his civilization's trebuchet building site." The
// first draft took the cost when work began; the seat had spent it meanwhile, and the site was
// given up at the first stroke.
test('spending everything after placing a trebuchet site does not cost the site', () => {
    const { m, a, ca } = siegeSeat();
    m.addUnit(a, 'engineer', -60, 0);
    m.command(ca, 'build_structure', { buildingType: 'trebuchet', targetX: -40, targetZ: 0, reason: 'siege' });
    const site = a.buildings.find(x => x.type === 'trebuchet');
    Object.assign(a.resources, { food: 0, wood: 0, stone: 0, gold: 0 });   // spent elsewhere meanwhile
    m.run(40000);
    assert.ok(!a.buildings.includes(site) && a.units.some(u => u.type === 'simple_trebuchet'), 'built all the same');
});

test('an enemy tower destroys a trebuchet site in its reach; one not yet begun is paid back', () => {
    for (const begun of [false, true]) {
        const { m, a, b, g, ca } = siegeSeat();
        m.addUnit(a, 'engineer', begun ? -40 : -200, 0);
        const before = purse(a.resources);
        m.command(ca, 'build_structure', { buildingType: 'trebuchet', targetX: -40, targetZ: 0, reason: 'siege' });
        const site = a.buildings.find(x => x.type === 'trebuchet');
        if (begun) { m.run(8000); assert.ok(site.buildProgress > 0); }
        assert.equal(ev(m, 'Game').hiddenSite(site), !begun, begun ? 'begun: in plain sight' : 'unstarted: hidden from the enemy');
        m.addBuilding(b, 'tower', -40 + 12, 0);
        m.run(begun ? 16000 : 2000);
        assert.ok(!a.buildings.includes(site), (begun ? 'begun' : 'unstarted') + ': the tower destroyed it');
        const paid = [before[0] - 100, before[1] - 200, before[2] - 100, before[3] - 50];
        assert.deepEqual(purse(a.resources), begun ? paid : before, begun ? 'begun: the cost is gone' : 'unstarted: paid back in full');
        if (!begun) assert.ok((a.events || []).some(e => /destroyed before your engineer began it; its cost was returned/.test(e.text)), 'and said');
    }
});

// asp67's match of 24 October (12:18): the reply told an engineer trained at the academy, in no
// formation, that it "leaves its formation ... and returns to its place after"; it stayed by
// its finished trebuchet, 20 from an enemy tower, and was shot. And the prompt's "a site
// nobody is building takes your closest free engineer within 40" was read as "build_structure
// needs an engineer within 40", so the seat walked each engineer to the front alone first.
test('build_structure says where an engineer on no order comes from and that it stays; any distance is fine', () => {
    const { m, a, ca } = siegeSeat();
    const e = m.addUnit(a, 'engineer', -300, 0);
    const r = String(m.command(ca, 'build_structure', { buildingType: 'trebuchet', targetX: 0, targetZ: 0, reason: 'far' }));
    assert.match(r, /walks there from \(-300, 0\) to build it .* and stays by the trebuchet after/, r);
    assert.ok(r.includes('engineer #' + e.handle + ' walks there'), r);
    assert.doesNotMatch(r, /leaves its formation/);
    assert.equal(e.task, 'building', 'sent from 300 away');
    const prompt = ev(m, 'OpenAIAIManager').defaultSystemPrompt();
    assert.match(prompt, /build_structure sends your nearest free engineer from any distance/);
});

// asp67's match of 24 October (13:31): a seat asked train_unit for "trebuchet" and got the
// training list, with nothing pointing at build_structure.
test('train_unit for a trebuchet, either engine, or any building points to build_structure', () => {
    const { m, a, ca } = siegeSeat();
    const say = t => String(m.command(ca, 'train_unit', { unitType: t, reason: 'r' }));
    assert.match(say('trebuchet'), /"trebuchet" is a building: place it with build_structure, and your nearest free engineer builds it/);
    assert.match(say('house'), /"house" is a building: place it with build_structure\./);
    assert.match(say('simple_trebuchet'), /simple_trebuchet is not trained: it is what a finished "trebuchet" site becomes\. Place one with build_structure "trebuchet"/);
    assert.match(say('advanced_trebuchet'), /build_structure "trebuchet_advanced"/);
});

// asp67 (b1110): "A built trebuchet needs to behave like a unit, so it needs to be added to
// formation ... the seat moving the trebuchet as a single unit leaving it unprotected."
test('a trebuchet built by an engineer from a formation joins that formation, which then keeps its pace', () => {
    const { m, a, ca } = siegeSeat();
    const army = [0, 1, 2].map(i => m.addUnit(a, 'warrior', -60, i * 2));
    const eng = m.addUnit(a, 'engineer', -62, 6);
    m.command(ca, 'move_units', { unitIds: army.concat(eng).map(u => u.handle), targetX: -60, targetZ: 20, formation: 'line', matchSpeed: 'slowestUnit', reason: 'form' });
    m.run(3000);
    const r = String(m.command(ca, 'build_structure', { buildingType: 'trebuchet', targetX: -40, targetZ: 20, reason: 'siege' }));
    assert.match(r, /the finished trebuchet joins that formation|leaves its formation/, r);
    m.run(40000);
    const engine = a.units.find(u => u.type === 'simple_trebuchet');
    assert.ok(engine, 'built');
    const g = army[0]._standingOrder;
    assert.ok(g && engine._standingOrder === g, 'in the army\'s formation');
    assert.ok(g.slots.has(engine), 'with a slot of its own');
    assert.ok(army.every(u => u.marchSpeed === 0.16), 'the formation held to slowest now goes at its pace');
    // The next whole-army order takes it along.
    m.command(ca, 'move_units', { targetX: 0, targetZ: 60, reason: 'onward' });
    assert.ok(engine._standingOrder && engine._standingOrder === army[0]._standingOrder, 'it marches on with them');
});

// asp67's match of 24 October (15:14): an engineer walking from its formation to its site
// showed no action -- members of a standing group carry none -- and the seat, reading the
// site as unattended, sent a second engineer from its academy 700 away.
test('an engineer on a trebuchet job shows it in friendlyUnits, in a formation or not', () => {
    const { m, a, ca } = siegeSeat();
    const army = [0, 1, 2].map(i => m.addUnit(a, 'warrior', -60, i * 2));
    const eng = m.addUnit(a, 'engineer', -62, 6);
    m.command(ca, 'move_units', { unitIds: army.concat(eng).map(u => u.handle), targetX: -60, targetZ: 20, reason: 'form' });
    m.run(2000);
    m.command(ca, 'build_structure', { buildingType: 'trebuchet', targetX: 0, targetZ: 20, reason: 'siege' });
    const mgr = m.game.openAIAIManager, c = mgr.aiControllers.find(x => x.aiPlayer === a);
    const row = () => mgr.buildGameStateJSON(c).friendlyUnits.find(u => u.id === eng.handle);
    assert.equal(row().action, 'building', 'walking to its site from the formation');
    assert.equal(mgr.buildGameStateJSON(c).friendlyUnits.find(u => u.id === army[0].handle).action, undefined, 'its soldiers still report through ordersInProgress');
});

// asp67's match of 24 October (17:24): two archers and a trebuchet named in an attack, the archers
// dead by the time it landed, and the refusal spoke of the trebuchet alone; and a seat with no
// engineer left was told none was "free".
test('the refusals say which named units died, and tell "no engineer" from "none free"', () => {
    const b = ironBoard(), { m, a, g, ca } = b;
    const { unit } = mobile(b, -100, 0);
    const archer = m.addUnit(a, 'archer', -100, 6);
    archer.health = 0; g.destroyTarget(archer);
    const r = String(m.command(ca, 'attack_target', { unitIds: [archer.handle, unit.handle], targetX: 50, targetZ: 0, reason: 'r' }));
    assert.match(r, /A trebuchet does not attack/, r);
    assert.match(r, new RegExp('no longer yours or already dead: ' + archer.handle), r);
    a.researchedTechs.siege_engineering = true;
    Object.assign(a.resources, { food: 2000, wood: 2000, stone: 2000, gold: 2000 });
    m.addBuilding(a, 'trebuchet', -40, 40, { underConstruction: true, health: 0.01, buildProgress: 0 });
    const none = String(m.command(ca, 'build_structure', { buildingType: 'trebuchet', targetX: -40, targetZ: 40, reason: 'r' }));
    assert.match(none, /you have no engineer to send to it\. Train one at the academy/, none);
    const none2 = String(m.command(ca, 'repair_building', { targetX: -40, targetZ: 40, reason: 'r' }));
    assert.match(none2, /you have none\. Train one at the academy/, none2);
});

// asp67 (b1110): engineers ignore towers, and "an engineer approaching a formation and taking
// tower damage must then also not trigger the formation's retaliation. Else the entire
// formation leaves the build site and charges the tower to get wiped."
test('a tower shooting an engineer sends nobody at it: not the engineer, not its formation, not a draft', () => {
    {   // its formation
        const { m, a, b, ca } = siegeSeat();
        const army = [0, 1, 2].map(i => m.addUnit(a, 'warrior', -4 + i * 4, 45));
        const eng = m.addUnit(a, 'engineer', 0, 44);
        m.command(ca, 'move_units', { unitIds: army.concat(eng).map(u => u.handle), targetX: 0, targetZ: 45, mode: 'guard', reason: 'guard' });   // guard chases up to 64; hold would not reach
        m.run(3000);
        const tower = m.addBuilding(b, 'tower', 0, 0);
        eng.x = 0; eng.z = 12;   // wandered into the tower's reach, its soldiers outside it
        let charged = false, fought = false;
        for (let t = 0; t < 8000; t += 250) {
            m.run(250);
            charged = charged || army.some(u => u.attackTarget === tower);
            fought = fought || eng.attackTarget === tower;
        }
        assert.ok(!fought, 'the engineer did not turn on the tower');
        assert.ok(!charged, 'its formation did not charge the tower');
    }
    {   // building, idle soldiers near
        const { m, a, b, ca } = siegeSeat();
        const eng = m.addUnit(a, 'engineer', -40, 0);
        const idle = [0, 1].map(i => m.addUnit(a, 'warrior', -60, i * 3));
        m.command(ca, 'build_structure', { buildingType: 'trebuchet', targetX: -40, targetZ: 0, reason: 'siege' });
        m.run(3000);
        assert.ok(eng.isBuilding, 'building');
        const tower = m.addBuilding(b, 'tower', -40 + 14, 0);
        let fought = false, drafted = false;
        for (let t = 0; t < 6000 && eng.health > 0; t += 250) {
            m.run(250);
            fought = fought || eng.attackTarget === tower;
            drafted = drafted || idle.some(u => u.attackTarget === tower);
        }
        assert.ok(!fought, 'the engineer never attacked the tower');
        assert.ok(!drafted, 'no idle soldier was drafted against it');
    }
});

// asp67 (b1110): "formations charging the tower when the treb is ordered to attack". In the
// match of 24 October (23:14) an attack-move to a point 25 from a tower, three advanced
// trebuchets in the group, was shot at and charged the tower. The stand-off held only an
// order aimed at the tower by id.
test('a formation with a trebuchet leaves a tower that shoots it to the trebuchet, whatever its order', () => {
    const b = ironBoard(), { m, a, g, ca } = b;
    const tower = m.addBuilding(b.b, 'tower', 0, 0);
    const { unit } = mobile(b, -60, 0);
    const army = [0, 1, 2, 3].map(i => m.addUnit(a, 'warrior', -60, -6 + i * 4));
    // A scout order to a point inside the tower's reach (12), not at the tower. (An attack-move
    // or any other move there besieges the tower first since b1110, and is never shot: a known
    // tower in the trebuchet's reach on its way. A scout starts no fight, sieges included.)
    const r = String(m.command(ca, 'move_units', { unitIds: [unit.handle, ...army.map(u => u.handle)], targetX: -12, targetZ: 0, mode: 'scout', matchSpeed: 'slowestUnit', reason: 'scout by the tower' }));
    assert.doesNotMatch(r, /\[ERROR\]/, r);
    let shotAt = null, charged = false;
    for (let t = 0; t < 90000 && unit.health > 0; t += 250) {
        m.run(250);
        if (shotAt == null && army.some(u => u.health < u.maxHealth)) shotAt = t;
        charged = charged || army.some(u => u.attackTarget === tower);
        if (shotAt != null && t - shotAt > 3000) break;
    }
    assert.ok(shotAt != null, 'the tower shot the group');
    assert.ok(!charged, 'no member went for the tower while the trebuchet lived (the old rule charged it 44 s in)');
    unit.health = 0; g.destroyTarget(unit);
    let fought = false;
    for (let t = 0; t < 8000 && !fought && army.some(u => u.health > 0); t += 250) { m.run(250); fought = army.some(u => u.attackTarget === tower); }
    assert.ok(fought, 'with the trebuchet gone, the group fights the tower');
});


// asp67 (b1110), the match of 24 October (23:14), Greek move 136: "only one phalanx was at site
// and attacked the treb ... While the Maya warrior was standing idle the entire time. Only once
// the treb was destroyed, it joined the fight." The champion held at its post; its three
// group-mates were still ~700 away, and a group's leash was measured from its centre.
test('a holding unit at its post answers an enemy attacking the trebuchet beside it, its group-mates still far away', () => {
    const b = ironBoard(), { m, a, g, ca } = b;
    const { unit } = mobile(b, -49, -330);
    const champ = m.addUnit(a, 'champion', -55, -343);
    const late = [0, 1, 2].map(i => m.addUnit(a, 'crossbowman', -40 + i * 3, 330));   // still at home
    m.command(ca, 'move_units', { unitIds: [champ.handle, ...late.map(u => u.handle)], targetX: -55, targetZ: -345, mode: 'hold', reason: 'hold by the trebuchet' });
    m.run(2000);
    assert.ok(Math.hypot(champ.x - -55, champ.z - -345) < 6, 'the champion is at its post');
    const ph = m.addUnit(b.b, 'warrior', -46, -333);
    ph.isAttacking = true; ph.attackTarget = unit;
    let reacted = null;
    for (let t = 0; t < 6000 && unit.health > 0 && reacted == null; t += 250) { m.run(250); if (champ.attackTarget === ph) reacted = t; }
    assert.ok(reacted != null, 'the champion fought the attacker (it stood idle before b1110)');
});

// asp67 (b1110): "In case the army is waiting for a trebuchet to catch up with the formation,
// would it not be smarter to have the army just stand still until it caught up and then move
// along with the treb instead?" Held to 60% of the trebuchet's 0.16 the body crept at 0.1.
test('a formation waiting for its trebuchet stands until it has caught up, then marches with it', () => {
    const b = board(), { m, a, g, ca } = b;
    const site = m.addBuilding(a, 'trebuchet', -90, 0, { underConstruction: true, health: 200, buildProgress: 20000 });
    g.completeConstruction(site);
    const treb = a.units.find(u => u.type === 'simple_trebuchet');
    const army = [0, 1, 2, 3].map(i => m.addUnit(a, 'warrior', -60, -6 + i * 4));
    const r = String(m.command(ca, 'move_units', { unitIds: [treb.handle, ...army.map(u => u.handle)], targetX: 100, targetZ: 0, formation: 'line', matchSpeed: 'slowestUnit', reason: 'march together' }));
    // The reply says why the army stands (asp67), and its time is the whole march: the trebuchet's.
    assert.match(r, new RegExp('The others stand until simple_trebuchet #' + treb.handle + ' has caught up, then march at its pace'), r);
    const mgr = g.openAIAIManager, eta = Number(/~(\d+)s to arrive/.exec(r)[1]);
    assert.equal(eta, mgr.travelEtaSec(treb, treb._moveOrderTo.x, treb._moveOrderTo.z), 'the time to arrive is that of the trebuchet: ' + r);
    const front = () => Math.max(...army.map(u => u.x));
    m.run(3000);   // the body forms up; the trebuchet is still far behind it
    const x0 = front(), t0 = treb.x;
    m.run(10000);
    assert.ok(treb.x - t0 > 3, 'the trebuchet closes in: ' + (treb.x - t0).toFixed(1));
    assert.ok(front() - x0 < 1, 'the body stands while it does: moved ' + (front() - x0).toFixed(2));
    assert.ok(army.every(u => u._formWait), 'and is drawn standing, not walking on the spot');
    m.run(90000);
    assert.ok(front() > x0 + 10, 'once the trebuchet is in place they march on together: ' + (front() - x0).toFixed(1));
    assert.ok(Math.abs(front() - treb.x) < 25, 'still together: front ' + front().toFixed(1) + ', trebuchet ' + treb.x.toFixed(1));
});

// asp67 (b1110): "Formations with trebuchet need some love, currently they look like a flock of
// hooligans not a formation." Two engines shared one slot in the middle of the soldiers' line,
// were packed into the archers' ranks at a soldier's spacing, and the body stopped and started
// whenever one fell half a unit behind.
test('trebuchets march in a row of their own behind the body, and besiege side by side with the soldiers beside them', () => {
    const run = tower => {
        const b = board(), { m, a, g, ca } = b;
        const T = tower ? m.addBuilding(b.b, 'tower', 60, 0) : null;
        for (let i = 0; i < 2; i++) g.completeConstruction(m.addBuilding(a, 'trebuchet', -100, -6 + i * 8, { underConstruction: true, health: 200, buildProgress: 20000 }));
        const trebs = a.units.filter(u => u.type === 'simple_trebuchet');
        const army = [0, 1, 2, 3, 4].map(i => m.addUnit(a, 'warrior', -95, -10 + i * 4)).concat([0, 1, 2, 3].map(i => m.addUnit(a, 'archer', -100, -12 + i * 6)));
        const p = { unitIds: army.concat(trebs).map(u => u.handle), formation: 'line', matchSpeed: 'slowestUnit', reason: 'r' };
        m.command(ca, tower ? 'attack_target' : 'move_units', Object.assign(tower ? { targetId: T.id } : { targetX: 40, targetZ: 0 }, p));
        const grp = army[0]._standingOrder;
        const s0 = grp.slots.get(trebs[0]), s1 = grp.slots.get(trebs[1]);
        let starts = 0, was = false;
        for (let t = 0; t < 120000; t += 500) {
            m.run(500);
            const waiting = army.some(u => u._formWait);
            if (was && !waiting) starts++;
            was = waiting;
        }
        return { s0, s1, starts, trebs, army, grp };
    };
    const march = run(false);
    assert.ok(Math.hypot(march.s0.x - march.s1.x, march.s0.z - march.s1.z) >= 6.5, 'two engines, two places: ' + JSON.stringify([march.s0, march.s1]));
    const back = Math.min(...march.army.map(u => march.grp.slots.get(u).x));
    assert.ok(march.s0.x < back - 3 && march.s1.x < back - 3, 'their row is behind the last rank: ' + march.s0.x.toFixed(1) + ' vs ' + back.toFixed(1));
    assert.ok(march.starts <= 1, 'the body sets off once, it does not stop and go: ' + march.starts);
    const siege = run(true);
    assert.ok(Math.hypot(siege.s0.x - siege.s1.x, siege.s0.z - siege.s1.z) >= 6.5, 'side by side at the tower: ' + JSON.stringify([siege.s0, siege.s1]));
    assert.ok(siege.starts <= 1, 'no stop and go on the way to the tower either: ' + siege.starts);
});

// asp67 (b1110): "When a trebuchet is part of a formation and an attack coordinates call comes in,
// whenever a tower is within trebuchet reach around that attack position, it should attack the
// tower from the earliest available position on route to that coordinates. The attack order then
// needs to be translated into an attack tower order for the entire formation." Forty soldiers had
// fought the buildings round a point under a tower's arrows while their trebuchet stood by.
test('an attack-move whose point a known tower covers besieges the tower first, then goes on', () => {
    for (const known of [true, false]) {
        const b = board(), { m, a, g, ca } = b;
        const tower = m.addBuilding(b.b, 'tower', 60, 0), house = m.addBuilding(b.b, 'house', 52, 8);
        a._knownEnemyBuildings = new Set(known ? [tower, house] : [house]);
        // Unknown: beyond the trebuchet's own watch of enemy towers (120) as well.
        const x0 = known ? -60 : -80;
        g.completeConstruction(m.addBuilding(a, 'trebuchet', x0, 0, { underConstruction: true, health: 200, buildProgress: 20000 }));
        const treb = a.units.find(u => u.type === 'simple_trebuchet');
        const army = [0, 1, 2, 3, 4, 5].map(i => m.addUnit(a, 'warrior', x0 + 5, -10 + i * 4));
        const r = String(m.command(ca, 'attack_target', { unitIds: army.concat(treb).map(u => u.handle), targetX: 52, targetZ: 8, formation: 'line', matchSpeed: 'slowestUnit', reason: 'the houses' }));
        const grp = army[0]._standingOrder;
        if (!known) {
            assert.doesNotMatch(r, /covers that point/, 'a tower the seat never found is not besieged: ' + r);
            assert.ok(!grp.target, 'no target');
            continue;
        }
        assert.match(r, /A tower at \(60, 0\) covers that point within your trebuchets' reach: the army besieges it first/, r);
        assert.equal(grp.target, tower, 'the order is now on the tower');
        let closest = Infinity;
        for (let t = 0; t < 300000 && tower.health > 0 && treb.health > 0; t += 500) {
            m.run(500);
            for (const u of army) if (u.health > 0) closest = Math.min(closest, Math.hypot(u.x - tower.x, u.z - tower.z));
        }
        assert.ok(tower.health <= 0, 'the trebuchet brought the tower down');
        assert.ok(closest > (tower.range || 18), 'no soldier entered its reach meanwhile: ' + closest.toFixed(1));
        m.run(2000);
        assert.ok(!grp.siegeResume && Math.hypot(grp.to.x - 52, grp.to.z - 8) < 1, 'then the order goes on to its point: ' + JSON.stringify(grp.to));
    }
});

// asp67 (b1110): "that should also be true when on march, the trebuchet picks up a tower in reach
// on route ... translating the order to a siege situation until the threat is dealt with and then
// returning to the regular attack order."
test('a march with a trebuchet besieges a known tower it passes within reach of, then marches on', () => {
    for (const withTreb of [true, false]) {
        const b = board(), { m, a, g, ca } = b;
        const tower = m.addBuilding(b.b, 'tower', 20, 22);
        a._knownEnemyBuildings = new Set([tower]);
        const army = [0, 1, 2, 3, 4, 5].map(i => m.addUnit(a, 'warrior', -95, -10 + i * 4));
        let treb = null;
        if (withTreb) { g.completeConstruction(m.addBuilding(a, 'trebuchet', -100, 0, { underConstruction: true, health: 200, buildProgress: 20000 })); treb = a.units.find(u => u.type === 'simple_trebuchet'); }
        m.command(ca, 'move_units', { unitIds: army.concat(treb ? [treb] : []).map(u => u.handle), targetX: 140, targetZ: 0, formation: 'line', matchSpeed: 'slowestUnit', reason: 'past the tower' });
        const grp = army[0]._standingOrder;
        let besieged = false, closest = Infinity;
        for (let t = 0; t < 500000 && (withTreb ? tower.health > 0 && treb.health > 0 : army[0].x < 100); t += 500) {
            m.run(500);
            if (!besieged && grp.target === tower) {
                besieged = true;
                const row = g._standingOrders.summary(a).find(o => o.unitIds.includes(army[0].handle));
                assert.equal(JSON.stringify([row.besieging, row.then]), '[[20,22],[140,0]]', 'ordersInProgress says so: ' + JSON.stringify(row));
            }
            for (const u of army) if (u.health > 0) closest = Math.min(closest, Math.hypot(u.x - tower.x, u.z - tower.z));
        }
        if (!withTreb) { assert.ok(!besieged, 'without a trebuchet nothing changes'); continue; }
        assert.ok(besieged, 'the march turned into a siege of the tower');
        assert.ok(tower.health <= 0, 'which the trebuchet brought down');
        assert.ok(closest > (tower.range || 18), 'no soldier in its reach meanwhile: ' + closest.toFixed(1));
        m.run(2000);
        assert.ok(!grp.target && Math.hypot(grp.to.x - 140, grp.to.z) < 1, 'then the march goes on to its point: ' + JSON.stringify(grp.to));
    }
});

// asp67 (b1110): "a trebuchet with an attack order and more than one tower in sight stops after
// destroying the first target. This should mimic the unit attacking building functionality, if a
// tower is destroyed and another is within viewing distance, switch to that tower next."
test('an attack on a tower moves on to the next tower in the trebuchets\' sight', () => {
    const b = board(), { m, a, g, ca } = b;
    const t1 = m.addBuilding(b.b, 'tower', 40, 0), t2 = m.addBuilding(b.b, 'tower', 60, 40);
    g.completeConstruction(m.addBuilding(a, 'trebuchet', -50, 0, { underConstruction: true, health: 200, buildProgress: 20000 }));
    const treb = a.units.find(u => u.type === 'simple_trebuchet');
    const army = [0, 1, 2, 3].map(i => m.addUnit(a, 'warrior', -45, -6 + i * 4));
    m.command(ca, 'attack_target', { targetId: t1.id, unitIds: army.concat(treb).map(u => u.handle), formation: 'line', matchSpeed: 'slowestUnit', reason: 'the towers' });
    const grp = army[0]._standingOrder;
    let switched = false, closest = Infinity;
    for (let t = 0; t < 600000 && t2.health > 0 && treb.health > 0; t += 500) {
        m.run(500);
        switched = switched || (t1.health <= 0 && grp.target === t2);
        for (const u of army) if (u.health > 0) closest = Math.min(closest, ...[t1, t2].filter(x => x.health > 0).map(x => Math.hypot(u.x - x.x, u.z - x.z)));
    }
    assert.ok(t1.health <= 0, 'the first tower fell');
    assert.ok(switched, 'the order moved on to the second');
    assert.ok(t2.health <= 0, 'which fell too');
    assert.ok(closest > 18, 'no soldier in either tower\'s reach: ' + closest.toFixed(1));
});

// The 4-seat match of 25 October (15:44): two trebuchets, their escort dead, sent in a screen
// formation. The screen returned early for a body without both melee and shot ("no ranged
// units, so it is a single rank"), before the trebuchets' row was placed: they got no slots.
test('trebuchets alone in any formation shape get a row of their own', () => {
    for (const shape of ['line', 'wedge', 'block', 'screen']) {
        const b = ironBoard(), { m, a, g, ca } = b;
        for (const [t, x] of [['trebuchet', -60], ['trebuchet_advanced', -50]]) g.completeConstruction(m.addBuilding(a, t, x, 0, { underConstruction: true, health: 200, buildProgress: 20000 }));
        const tr = a.units.filter(u => u.unitType === 'siege');
        const r = String(m.command(ca, 'move_units', { unitIds: tr.map(u => u.handle), targetX: 0, targetZ: 40, formation: shape, matchSpeed: 'slowestUnit', reason: 'engines alone' }));
        assert.doesNotMatch(r, /no ranged units|every unit is ranged/, shape + ': ' + r);
        const grp = tr[0]._standingOrder, s0 = grp.slots.get(tr[0]), s1 = grp.slots.get(tr[1]);
        assert.ok(s0 && s1 && Math.hypot(s0.x - s1.x, s0.z - s1.z) >= 6.5, shape + ': two places apart: ' + JSON.stringify([s0, s1]));
    }
});

// asp67 (b1110): "I want units on hold to stay on hold, but units on guard to guard units and
// buildings. So if we change the range of an advanced trebuchet to 60 it would hold at 58 and be
// inside the new guards range which I would set to 60." Guards at a tower watched either engine
// throw until the tower fell: a trebuchet hits no unit of theirs, and has no attack to count as
// military. Now a guard goes for it, kills it and comes back; a hold stays put.
test('a guard at a tower goes for either trebuchet throwing at it, and returns; a hold stays', () => {
    for (const [site, unitType, reach] of [['trebuchet', 'simple_trebuchet', 50], ['trebuchet_advanced', 'advanced_trebuchet', 60]]) for (const mode of ['guard', 'hold']) {
        const b = ironBoard(), { m, a, g, cb } = b;
        const tower = m.addBuilding(b.b, 'tower', 0, 0);
        const guards = [0, 1, 2, 3].map(i => m.addUnit(b.b, 'champion', 4, -5 + i * 4));
        m.command(cb, 'move_units', { unitIds: guards.map(u => u.handle), targetX: 4, targetZ: 1, mode, targets: 'military', reason: 'the tower' });
        m.run(3000);
        const posts = guards.map(u => ({ x: u.x, z: u.z }));
        g.completeConstruction(m.addBuilding(a, site, -(reach - 2), 0.5, { underConstruction: true, health: 400, buildProgress: 20000 }));
        const treb = a.units.find(u => u.type === unitType);
        assert.equal(treb.range, reach, unitType + ' reaches ' + reach);
        let went = false;
        for (let t = 0; t < 60000 && treb.health > 0; t += 500) { m.run(500); went = went || guards.some(u => u.attackTarget === treb); }
        const label = unitType + ' at ' + (reach - 2) + ', ' + mode;
        if (mode === 'hold') {
            assert.ok(!went && treb.health > 0, label + ': nobody left the post');
            continue;
        }
        assert.ok(went && treb.health <= 0, label + ': the guard killed it (' + Math.round(treb.health) + ' left)');
        m.run(30000);
        const away = Math.max(...guards.map((u, i) => Math.hypot(u.x - posts[i].x, u.z - posts[i].z)));
        assert.ok(away < 8, label + ': back at the post: ' + away.toFixed(1));
        assert.ok(tower.health > 0, label + ': the tower stands');
    }
});

// asp67, on the match of 25 October (20:37): "a formation forming close to a trebuchet turns
// into a jitter dance until they form and stand to wait for the trebuchet". A member just
// behind the lead was switched between the body's pace and its own full speed at a fixed line,
// and its neighbours' separation shoved it across that line every few steps: an archer beside
// its trebuchet lunged one step at 1.1 in a body marching at 0.096, every 0.3 s. It closes on a
// ramp now (Game.FORMATION_CATCH_UP).
test('a formation marching with a trebuchet closes up without lurching', () => {
    const b = board(5), { m, a, g, ca } = b;
    g.completeConstruction(m.addBuilding(a, 'trebuchet', -120, 6, { underConstruction: true, health: 200, buildProgress: 20000 }));
    const treb = a.units.find(u => u.type === 'simple_trebuchet');
    const army = [];
    for (let i = 0; i < 6; i++) army.push(m.addUnit(a, 'warrior', -118 + (i % 3) * 2, -8 + i * 2));
    for (let i = 0; i < 5; i++) army.push(m.addUnit(a, 'archer', -122, -6 + i * 3));
    for (let i = 0; i < 3; i++) army.push(m.addUnit(a, 'scout_cavalry', -125, -4 + i * 3));
    m.command(ca, 'move_units', { unitIds: army.concat(treb).map(u => u.handle), targetX: 100, targetZ: 20, formation: 'block', matchSpeed: 'slowestUnit', reason: 'the march' });
    let lurches = 0;
    const prev = new Map(army.map(u => [u, { x: u.x, z: u.z }]));
    for (let t = 0; t < 1600; t++) {
        m.run(50);
        const step = army.map(u => Math.hypot(u.x - prev.get(u).x, u.z - prev.get(u).z));
        const median = step.slice().sort((p, q) => p - q)[step.length >> 1];
        // After ten seconds of forming up: a step four times the body's, while it marches.
        if (t > 200 && median > 0.001) lurches += step.filter(s => s > 4 * median && s > 0.05).length;
        for (const u of army) prev.set(u, { x: u.x, z: u.z });
    }
    assert.ok(lurches < 20, 'lurching steps: ' + lurches);
    const c = army.reduce((p, u) => ({ x: p.x + u.x / army.length, z: p.z + u.z / army.length }), { x: 0, z: 0 });
    assert.ok(Math.max(...army.map(u => Math.hypot(u.x - c.x, u.z - c.z))) < 8, 'formed up');
});

// asp67's match of 25 October (22:00), at 72:10: two Roman advanced trebuchets, marching to the
// stand-off of a tower taken up on the way, rolled past a second tower at 4.7 -- a tower already
// the order's target ended the search for others. And (asp67) "the attack order mechanic works
// for move unit orders as well, since a trebuchet cannot really retaliate against a tower".
test('a tower met on the way to besiege another is besieged first, then the first', () => {
    const b = board(), { m, a, g, ca } = b;
    const far = m.addBuilding(b.b, 'tower', 60, 0), near = m.addBuilding(b.b, 'tower', -40, 44);
    g.completeConstruction(m.addBuilding(a, 'trebuchet', -120, 0, { underConstruction: true, health: 200, buildProgress: 20000 }));
    const treb = a.units.find(u => u.type === 'simple_trebuchet');
    const army = [0, 1, 2].map(i => m.addUnit(a, 'warrior', -115, -4 + i * 4));
    m.command(ca, 'attack_target', { targetId: far.id, unitIds: army.concat(treb).map(u => u.handle), formation: 'line', matchSpeed: 'slowestUnit', reason: 'the far tower' });
    const grp = army[0]._standingOrder;
    let nearFirst = false, closest = Infinity;
    for (let t = 0; t < 600000 && far.health > 0 && treb.health > 0; t += 500) {
        m.run(500);
        if (grp.target === near && far.health > 0) nearFirst = true;
        if (near.health > 0) closest = Math.min(closest, Math.hypot(treb.x - near.x, treb.z - near.z));
    }
    assert.ok(nearFirst, 'the tower on the way became the target');
    assert.ok(closest > 18, 'the trebuchet never rolled into its reach: ' + closest.toFixed(1));
    assert.ok(near.health <= 0 && far.health <= 0, 'both fell: near ' + Math.round(near.health) + ', far ' + Math.round(far.health));
});

test('a move with a trebuchet, on guard, besieges a tower on its way, then goes to its post', () => {
    const b = board(), { m, a, g, ca } = b;
    const tower = m.addBuilding(b.b, 'tower', 0, 44);
    g.completeConstruction(m.addBuilding(a, 'trebuchet', -120, 0, { underConstruction: true, health: 200, buildProgress: 20000 }));
    const treb = a.units.find(u => u.type === 'simple_trebuchet');
    const army = [0, 1, 2].map(i => m.addUnit(a, 'warrior', -115, -4 + i * 4));
    m.command(ca, 'move_units', { mode: 'guard', unitIds: army.concat(treb).map(u => u.handle), targetX: 100, targetZ: 0, formation: 'line', matchSpeed: 'slowestUnit', reason: 'past the tower' });
    const grp = army[0]._standingOrder;
    let besieged = false, closest = Infinity;
    for (let t = 0; t < 600000 && tower.health > 0 && treb.health > 0; t += 500) {
        m.run(500);
        besieged = besieged || grp.target === tower;
        closest = Math.min(closest, Math.hypot(treb.x - tower.x, treb.z - tower.z));
    }
    assert.ok(besieged && tower.health <= 0, 'the tower was besieged and fell: ' + Math.round(tower.health));
    assert.ok(closest > 18, 'from out of its reach: ' + closest.toFixed(1));
    // Then on to its post, at the trebuchet's pace.
    assert.ok(!grp.siegeResume && Math.hypot(grp.to.x - 100, grp.to.z) < 1, 'the order is its post again: ' + JSON.stringify(grp.to));
    const cx = () => army.reduce((p, u) => p + u.x / army.length, 0), x0 = cx();
    m.run(60000);
    assert.ok(cx() - x0 > 20, 'and the group marches there: ' + (cx() - x0).toFixed(1));
});

// asp67's video of 26 October: a wedge standing for its simple trebuchet "twitching" -- in the
// replayed match (13:11, 48:50) ten of twelve soldiers flipped between the standing and the
// walking pose 73 times in one second. Members walking in stopped at one line, one rank
// behind the lead, and their neighbours' separation nudged them back over it; they stop now
// within half a rank and walk again only from two back (b1113).
test('a formation standing for its trebuchet forms up once, without flickering between poses', () => {
    for (const shape of ['wedge', 'block', 'line']) {
        const b = board(5), { m, a, g, ca } = b;
        g.completeConstruction(m.addBuilding(a, 'trebuchet', -112, 0, { underConstruction: true, health: 200, buildProgress: 20000 }));
        const treb = a.units.find(u => u.type === 'simple_trebuchet');
        const army = [];
        for (let i = 0; i < 12; i++) army.push(m.addUnit(a, i < 2 ? 'warrior' : 'archer', -100 + (i % 4) * 2, -6 + Math.floor(i / 4) * 3));
        m.command(ca, 'move_units', { unitIds: army.concat(treb).map(u => u.handle), targetX: 100, targetZ: 0, formation: shape, matchSpeed: 'slowestUnit', reason: 'with the trebuchet' });
        const flips = new Map(army.map(u => [u, 0])), pose = new Map();
        for (let t = 0; t < 160; t++) {   // 8 s: forming up and standing for the trebuchet
            m.run(50);
            for (const u of army) { if (pose.has(u) && pose.get(u) !== !!u._formWait) flips.set(u, flips.get(u) + 1); pose.set(u, !!u._formWait); }
        }
        const most = Math.max(...flips.values());
        assert.ok(most <= 2, shape + ': a member changed pose ' + most + ' times while the body formed up and waited');
        assert.ok(army.every(u => u._formWait), shape + ': and all stand for the trebuchet');
    }
});
