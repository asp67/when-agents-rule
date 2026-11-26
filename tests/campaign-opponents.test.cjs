// The campaign's opponents play by the arena's rules (b1270). Two things the arena's
// start and end did and the campaign's did not: an opponent got no civilization bonus
// (the effect was applied to the human alone), and an opponent's Wonder could never win
// (the countdown only ran in spectator mode, so a model that built and held one got
// nothing and its secondsUntilYouWin never moved).
const test = require('node:test'), assert = require('node:assert/strict');
const { Realm } = require('../tools/bench/realm.cjs');
const { startCampaign } = require('./lib/campaign-realm.cjs');

test('every opponent starts with its civilization\'s bonus, as the human does', () => {
    const m = new Realm({ seed: 12 });
    const g = startCampaign(m, 'greek', ['persian', 'yamato', 'roman', 'viking', 'maya']);
    const by = Object.fromEntries(g.aiManager.aiPlayers.map(a => [a.civilization, a]));
    assert.equal(by.persian.workerHarvestBonus, 1.2);
    assert.equal(by.yamato.techCostMultiplier, 0.7);
    assert.equal(by.roman.workerBuildSpeedBonus, 1.3);
    assert.equal(by.viking.raidBonus, 0.25);
    assert.equal(by.maya.farmBonus, 0.3);
    assert.equal(g.player.buildingHealthMultiplier, 1.3, 'the human\'s own, as before');
});

test('the human\'s bonus does not outlive its match', () => {
    const m = new Realm({ seed: 12 });
    let g = startCampaign(m, 'viking', ['greek']);
    assert.equal(g.player.raidBonus, 0.25);
    g = startCampaign(m, 'maya', ['greek']);
    assert.ok(!g.player.raidBonus, 'a Maya after a Viking raids at no bonus');
    assert.equal(g.player.farmBonus, 0.3);
    g = startCampaign(m, 'greek', ['persian']);
    assert.ok(!g.player.farmBonus);
});

test('an opponent that holds its Wonder for the countdown wins the campaign', () => {
    const m = new Realm({ seed: 12 });
    const g = startCampaign(m, 'greek', ['egyptian']);
    const ai = g.aiManager.aiPlayers[0];
    let defeat = 0, victory = 0;
    g.ui.showDefeat = () => { defeat++; }; g.ui.showVictory = () => { victory++; };
    g.wonderRequired = 10;
    ai.age = 'iron';
    const tc = ai.buildings[0];
    m.addBuilding(ai, 'pyramid', tc.x + 30, tc.z);
    m.run(5000);
    assert.equal(g.gameStarted, true, 'half the countdown');
    assert.ok(ai._wonderHold > 0, 'and it is counted');
    m.run(g.wonderHoldMs());
    assert.equal(g.gameStarted, false);
    assert.equal(defeat, 1); assert.equal(victory, 0);
});

test('a Wonder that falls in time wins nothing', () => {
    const m = new Realm({ seed: 12 });
    const g = startCampaign(m, 'greek', ['egyptian']);
    const ai = g.aiManager.aiPlayers[0];
    g.wonderRequired = 10;
    const tc = ai.buildings[0];
    const wonder = m.addBuilding(ai, 'pyramid', tc.x + 30, tc.z);
    m.run(4000);
    wonder.health = 0; g.destroyTarget(wonder, null);
    m.run(g.wonderHoldMs() + 2000);
    assert.equal(g.gameStarted, true);
    assert.equal(ai._wonderHold || 0, 0);
});
