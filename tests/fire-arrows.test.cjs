'use strict';
// Fire Arrows (academy, Iron Age, every civilization): ranged units +30% damage against
// buildings, and the arrows they shoot at buildings burn.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMatch } = require('../tools/bench/realm.cjs');

async function board(civ = 'greek', age = 'iron') {
    const m = await createMatch({ kind: 'board', seed: 'fire-arrows-' + civ, seats: [
        { civ, age, buildings: [['town_center', -200, 0], ['academy', -180, 30, { tag: 'academy' }]],
          units: [['archer', 0, 0, { tag: 'archer' }]], resources: { food: 1000, wood: 1000, stone: 1000, gold: 1000 } },
        { civ: 'persian', age: 'iron', buildings: [['town_center', 200, 0], ['house', 8, 0, { tag: 'house' }]],
          units: [['warrior', 0, 40, { tag: 'warrior' }]] },
    ] });
    const shots = [];
    const spawn = m.game.renderer.spawnProjectile;
    m.game.renderer.spawnProjectile = (from, to, kind, shooter) => { shots.push(kind); return spawn && spawn(from, to, kind, shooter); };
    return { m, g: m.game, shots };
}

test('every civilization can research it at the academy in the Iron Age, at the stated cost', async () => {
    for (const civ of ['egyptian', 'greek', 'persian', 'yamato']) {
        const { m } = await board(civ);
        const tech = m.context.getCivilization(civ).techTree.fire_arrows;
        assert.equal(tech.researchAt, 'academy');
        assert.equal(tech.requiredAge, 'iron');
        assert.deepEqual({ ...tech.cost }, { food: 50, wood: 100, stone: 80, gold: 100 });
        assert.equal(tech.name, 'Feuerpfeile');
    }
    // Offered to a model only in the Iron Age.
    const early = await board('greek', 'bronze');
    const say = r => JSON.stringify(r.m.game.openAIAIManager.buildGameStateJSON(r.m.controllers[0]).research || {});
    assert.doesNotMatch(say(early), /fire_arrows/);
    assert.match(say(await board('greek', 'iron')), /fire_arrows/);
});

test('researched, a ranged hit on a building does 30% more, and the arrow burns; units are hit as before', async () => {
    const base = await board(), fired = await board();
    // Research it the way a model would, and let it complete.
    const res = fired.m.command(fired.m.controllers[0], 'research_tech', { techId: 'fire_arrows' });
    assert.match(String(res), /^OK/);
    fired.m.advance(31000);
    assert.ok(fired.m.seats[0].researchedTechs.fire_arrows);
    const hit = async r => {
        const house = r.m.tags.house, before = house.health;
        r.m.command(r.m.controllers[0], 'attack_target', { targetId: house.id });
        r.m.advance(3050);   // three shots
        return before - house.health;
    };
    const plain = await hit(base), burning = await hit(fired);
    assert.ok(plain > 0);
    assert.ok(Math.abs(burning / plain - 1.3) < 1e-9, `x1.3 against buildings (${burning} vs ${plain})`);
    assert.ok(fired.shots.includes('fireArrow') && !fired.shots.includes('arrow'), 'fire arrows at the house');
    assert.ok(base.shots.includes('arrow') && !base.shots.includes('fireArrow'), 'plain arrows without the tech');
    // Against a unit: unchanged, and a plain arrow.
    const g = fired.g, archer = fired.m.tags.archer, warrior = fired.m.tags.warrior;
    assert.equal(g.combatMultiplier(archer, warrior), base.g.combatMultiplier(base.m.tags.archer, base.m.tags.warrior));
    // No building in reach now (an attack-march shoots what it passes).
    const owner = fired.m.seats[1], house = fired.m.tags.house;
    owner.buildings.splice(owner.buildings.indexOf(house), 1);
    g.renderer.removeBuilding(house);
    fired.shots.length = 0;
    // In sight: a unit out of sight cannot be named by id (b1042).
    warrior.x = archer.x; warrior.z = archer.z + 10;
    fired.m.command(fired.m.controllers[0], 'attack_target', { targetId: warrior.id });
    fired.m.advance(8000);
    assert.ok(fired.shots.length > 0 && fired.shots.every(k => k === 'arrow'), JSON.stringify(fired.shots) + ' ' + String(fired.m.seats[0].lastActionResult || fired.m.controllers[0].lastActionResult));
});

test('a new match starts without it, for the human player too', async () => {
    const { g } = await board();
    g.player.rangedBuildingBonus = 0.3;
    g.player.healPowerBonus = 0.2;
    assert.equal(g.rangedBuildingBonusOf({ owner: 'player' }), 0.3);
    // The arena start resets the player object's tech bonuses along with the rest.
    const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../js/game.js'), 'utf8');
    assert.equal(src.split('this.player.rangedBuildingBonus = 0;').length - 1, 2, 'both match starts');
});
