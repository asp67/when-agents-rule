// The camera director starts each match knowing nothing of the last (build 1292). One
// director serves every match on the page; what it had shown and the ages it had seen were
// kept, keyed by ids the next match uses again.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');

function setup() {
    const scope = { console, location: { search: '' } };
    vm.createContext(scope);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/director.js'), 'utf8'), scope);
    const Director = vm.runInContext('Director', scope);
    let clock = 0;
    const seats = () => ['a', 'b'].map((id, i) => ({ id, units: [], age: 'stone',
        buildings: [{ owner: id, id: id + '-tc', type: 'town_center', x: i ? 300 : -300, z: 0, health: 1000 }] }));
    const game = { aiManager: { aiPlayers: seats() }, isPlayerEliminated: () => false, effectiveSimSpeed: () => 1,
        terrain: { size: 800 }, renderer: { _yaw: 0 }, simNow: () => clock,
        _resolveCamSubject: s => (s && s.kind === 'ent' && s.ent.health > 0 ? s.ent : null), _subjectZoom: () => 30 };
    return { d: new Director(game), game, seats, at: ms => { clock = ms; } };
}
// Frames of a quiet match, until the director has had time for every calm shot.
const watch = (d, from, frames = 400) => { for (let i = 0; i < frames; i++) d.update(from + i * 250); return from + frames * 250; };

test('a site going up under an id the last match used is shown again, and a seat back in the Stone Age starts no compare sweep', () => {
    const { d, game, seats, at } = setup();
    let now = 1000000;
    // Match one: a barracks goes up, and both seats reach the Bronze Age.
    game.aiManager.aiPlayers[0].buildings.push({ owner: 'a', id: 7, type: 'barracks', x: -280, z: 20, health: 50, underConstruction: true });
    at(1000); now = watch(d, now);
    assert.ok(d._sites.has(7), 'the site was shown in match one');
    for (const p of game.aiManager.aiPlayers) p.age = 'bronze';
    at(60000); d.update(now += 250);
    assert.ok(d._prevAge.get('a') === 'bronze');
    at(900000); now = watch(d, now, 40);

    // Match two on the same page: new seats under the same ids, the clock at zero again.
    game.aiManager.aiPlayers = seats();
    game.aiManager.aiPlayers[0].buildings.push({ owner: 'a', id: 7, type: 'tower', x: -260, z: -30, health: 50, underConstruction: true });
    at(0);
    d.update(now += 250);
    assert.equal(d.compareQueue.length, 0, 'no age changed: the seats are where every match starts');
    assert.equal(d.shot == null || d.shot.type !== 'compare', true);
    const fresh = !d._sites.has(7) || d.shot.type === 'site';
    assert.ok(fresh, 'the id is not remembered as shown');
    at(1000); watch(d, now);
    assert.ok(d._sites.has(7), 'and the new site gets its shot');
    assert.equal(d._prevAge.get('a'), 'stone');
});

test('within a match nothing is forgotten: the clock running on resets nothing', () => {
    const { d, game, at } = setup();
    let now = 1000000;
    game.aiManager.aiPlayers[0].buildings.push({ owner: 'a', id: 7, type: 'barracks', x: -280, z: 20, health: 50, underConstruction: true });
    at(1000); now = watch(d, now);
    assert.ok(d._sites.has(7));
    const seen = new Map(d.lastSeen);
    for (const ms of [2000, 2000, 50000, 50001]) { at(ms); d.update(now += 250); }   // a paused clock stands still: not a new match
    assert.ok(d._sites.has(7), 'a site is shown once');
    assert.ok(d.lastSeen.size >= seen.size);
});

test('a world without a match clock is watched as before', () => {
    const { d, game } = setup();
    delete game.simNow;
    assert.doesNotThrow(() => watch(d, 1000000, 20));
});
