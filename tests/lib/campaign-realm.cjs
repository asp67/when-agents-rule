'use strict';
// The campaign's own start path (Game.startGame) in a bare realm, for the tests that
// need a human seat next to the rule-based or model seats. The realm stands in for the
// page with no camera to place and no timers to resize the canvas on, so those are lent
// here; the rules that follow are the game's.
function startCampaign(realm, playerCiv, opponents) {
    const g = realm.game, r = g.renderer;
    realm.lend({ setTimeout: () => 0, clearTimeout() {} });
    r.camera = r.camera || {};
    if (!r.camera.position) r.camera.position = { set() {} };
    if (typeof r.camera.lookAt !== 'function') r.camera.lookAt = () => {};
    r.cameraTarget = r.cameraTarget || {};
    if (typeof r.cameraTarget.set !== 'function') r.cameraTarget.set = () => {};
    g.spectatorMode = false;
    g.player.civilization = playerCiv;
    g.startGame('campaign', opponents.length, opponents.map(o => (typeof o === 'string' ? { civ: o, type: 'ki' } : o)));
    return g;
}

module.exports = { startCampaign };
