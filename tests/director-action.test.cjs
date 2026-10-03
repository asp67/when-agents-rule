const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function setup(speed = 1, lapse = 1) {
    const scope = { console, location: { search: '?lapse=' + lapse } };
    vm.createContext(scope);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/director.js'), 'utf8'), scope);
    const Director = vm.runInContext('Director', scope);
    const players = ['a', 'b', 'c', 'd'].map(id => ({ id, units: [], buildings: [], age: 'stone' }));
    const game = { aiManager: { aiPlayers: players }, isPlayerEliminated: () => false,
        effectiveSimSpeed: () => speed, terrain: { size: 800 }, renderer: { _yaw: 0 },
        _resolveCamSubject: s => s?.kind === 'ent' && s.ent.health > 0 ? s.ent : null,
        _subjectZoom: () => 30 };
    const director = new Director(game);
    const update = director.update.bind(director);
    director.update = now => {
        const pose = update(now);
        director.measureCoverage({ canvas: { clientWidth: 1000, clientHeight: 800 },
            worldToScreen: (x, y, z) => ({ x: 500 + (x - pose.x) * 10, y: 400 + (z - pose.z) * 10 }) }, now);
        return pose;
    };
    director.lastOverview = 100000;
    for (const p of players) p.buildings.push({ owner: p.id, id: p.id + '-tc', type: 'town_center',
        x: -300, z: -300, health: 1000 });
    function duel(x = 0, pair = 0, gap = 1) {
        const target = { id: 'target-' + pair, owner: players[pair + 1].id,
            type: 'warrior', x: x + gap, z: 0, health: 100, speed: 1, attack: 10 };
        const attacker = { id: 'attacker-' + pair, owner: players[pair].id,
            type: 'warrior', x, z: 0, health: 100, attack: 10, range: 1, speed: 1,
            isAttacking: true, attackTarget: target, isMoving: gap > 1.5,
            targetX: target.x, targetZ: 0 };
        players[pair].units.push(attacker); players[pair + 1].units.push(target);
        return { attacker, target };
    }
    function hit(d, at, damage = 10) {
        director.observeCombat(d.attacker, d.target, damage, at, d.target.x, d.target.z);
    }
    return { director, game, players, duel, hit };
}

test('fresh damage interrupts a new ambient shot on the next frame, including timelapse', () => {
    for (const lapse of [1, 8]) {
        const { director: d, duel, hit } = setup(1, lapse);
        d.update(100000);
        const fight = duel(); hit(fight, 100001);
        const pose = d.update(100017);
        assert.equal(d.shot.type, 'brawl'); assert.equal(pose.cut, true);
        assert.ok(Math.abs(pose.x) < 10);
        assert.equal(d.encounters[0].firstCovered - d.encounters[0].firstHit, 16);
    }
});

test('an approaching attack gets coverage before the first hit and keeps its encounter identity', () => {
    const { director: d, duel, hit } = setup();
    const f = duel(0, 0, 7);
    d.update(100000);
    assert.equal(d.shot.type, 'imminent');
    const key = d.shot.key;
    assert.ok(d.shot.pose.x > f.attacker.x && d.shot.pose.x < f.target.x);
    f.attacker.x = 6; f.attacker.isMoving = false;
    hit(f, 101000); d.update(101001);
    assert.equal(d.shot.type, 'brawl'); assert.equal(d.shot.key, key);
});

test('distant orders, retreating enemies and idle neighbours do not predict a fight', () => {
    for (const mode of ['distant', 'retreat', 'idle']) {
        const { director: d, duel } = setup();
        const f = duel(0, 0, mode === 'distant' ? 300 : 7);
        if (mode === 'retreat') Object.assign(f.target, { isMoving: true, targetX: 100, targetZ: 0, speed: 3 });
        if (mode === 'idle') Object.assign(f.attacker, { isAttacking: false, isMoving: false });
        d.update(100000);
        assert.notEqual(d.shot.type, 'imminent'); assert.notEqual(d.shot.type, 'brawl');
    }
});

test('attack-move predicts nearby combat without an assigned attack target', () => {
    const { director: d, duel } = setup();
    const f = duel(0, 0, 7);
    f.attacker.attackTarget = null; f.attacker.attackMove = { x: 100, z: 0 };
    d.update(100000); assert.equal(d.shot.type, 'imminent');
});

test('prediction uses effective simulation speed', () => {
    for (const speed of [1, 4]) {
        const { director: d, duel } = setup(speed);
        duel(0, 0, 20); d.update(100000);
        assert.equal(d.shot.type === 'imminent', speed === 4);
    }
});

test('finished fighting cannot block a new short encounter between the same players', () => {
    const { director: d, duel, hit } = setup();
    const first = duel(); hit(first, 100000); d.update(100000);
    const oldKey = d.shot.key;
    first.target.health = 0; first.attacker.isAttacking = false;
    const next = duel(300); hit(next, 100100); d.update(100101);
    assert.notEqual(d.shot.key, oldKey); assert.ok(d.shot.pose.x > 290);
});

test('equal simultaneous fights do not strobe and a decisive siege can interrupt', () => {
    const { director: d, duel, hit, players } = setup();
    const first = duel(); hit(first, 100000); d.update(100000);
    const key = d.shot.key;
    const second = duel(300, 2); hit(second, 100010); d.update(100011);
    assert.equal(d.shot.key, key);
    Object.assign(second.target, { isWonder: true, health: 15, type: 'wonder' });
    players[3].buildings.push(second.target);
    hit(second, 100020, 20); d.update(100021);
    assert.notEqual(d.shot.key, key); assert.equal(d.shot.priority, 3);
});

test('manual follow is respected during urgent combat', () => {
    const { director: d, game, duel, hit, players } = setup();
    game._camFollow = { kind: 'ent', ent: players[0].buildings[0] };
    d.update(100000); const f = duel(); hit(f, 100010); d.update(100020);
    assert.equal(d.shot.type, 'selected');
    d.update(110000); assert.equal(d.shot.type, 'selected');
});

test('coverage records missed and covered encounters and expires entity references', () => {
    const { director: d, duel, hit } = setup();
    const a = duel(); hit(a, 100000); d.update(100000); d.update(100100);
    const b = duel(300, 2); hit(b, 100110); d.update(100111);
    a.target.health = 0; b.target.health = 0;
    a.attacker.isAttacking = b.attacker.isAttacking = false;
    d.update(104000);
    assert.equal(d.encounters.length, 0); assert.equal(d.coverage.length, 2);
    assert.equal(d.coverage[0].latencyMs, 0); assert.ok(d.coverage[0].visibleMs > 0);
    assert.equal(d.coverage[1].firstCovered, null);
});

test('stale damage stops qualifying as combat even when both units survive', () => {
    const { director: d, duel, hit } = setup();
    const f = duel(); hit(f, 100000); d.update(100000);
    f.attacker.isAttacking = false; d.update(101600);
    assert.equal(d.fights(101600).length, 0, 'aftermath does not count as live combat');
    d.update(102100);
    assert.notEqual(d.shot.type, 'brawl');
});

test('coverage requires both combatants inside the rendered viewport', () => {
    const { director: d, duel, hit } = setup();
    const f = duel(); hit(f, 100000); d.candidates(100000);
    const renderer = { canvas: { clientWidth: 1000, clientHeight: 800 },
        worldToScreen: x => ({ x: x === f.target.x ? 1100 : 500, y: 400 }) };
    d.measureCoverage(renderer, 100001);
    assert.equal(d.encounters[0].firstCovered, null);
    renderer.worldToScreen = () => ({ x: 500, y: 400 });
    d.measureCoverage(renderer, 100100);
    assert.equal(d.encounters[0].firstCovered, 100100);
});

test('the game sends every hit to the director even when visual pings are throttled', () => {
    const source = fs.readFileSync(path.join(__dirname, '../js/game.js'), 'utf8');
    const scope = { console };
    vm.createContext(scope);
    vm.runInContext(source, scope);
    const Game = vm.runInContext('Game', scope);
    const calls = [];
    const game = Object.create(Game.prototype);
    Object.assign(game, { _actionCam: true, spectatorMode: true,
        _director: { observeCombat: (...args) => calls.push(args) },
        renderer: { spawnBattleRing() {} } });
    const attacker = { id: 'a' }, target = { id: 'b' };
    game.notifyCombat(0, 0, attacker, target, 10);
    game.notifyCombat(0, 0, attacker, target, 20);
    assert.equal(calls.length, 2); assert.equal(game._combatEvents.length, 1);
    assert.equal(calls[1][0], attacker); assert.equal(calls[1][1], target);
    assert.equal(calls[1][2], 20);
});

test('sustained damage is aggregated without forcing a full evaluation on every frame', () => {
    const { director: d, duel, hit } = setup();
    const f = duel(); hit(f, 100000); d.update(100000);
    const next = d._nextEval;
    for (let t = 100001; t < 100050; t++) hit(f, t);
    assert.equal(d._nextEval, next);
});

test('battle aftermath stays for two viewer seconds after the last strike, even after shot expiry',()=>{
 for(const speed of [1,4])for(const lapse of [1,8]){
  const {director:d,duel,hit}=setup(speed,lapse);
  const f=duel();hit(f,100000);d.update(100001);const shot=d.shot;
  hit(f,100100);f.target.health=0;f.attacker.isAttacking=false;shot.until=100101;
  d.update(100200);assert.equal(d.shot,shot);
  d.update(102099);assert.equal(d.shot,shot);
  d.update(102200);assert.notEqual(d.shot,shot);
 }
});

test('an off-scene fight immediately interrupts the aftermath pause',()=>{
 const {director:d,duel,hit}=setup();const f=duel();hit(f,100000);d.update(100001);
 const oldKey=d.shot.key;hit(f,100100);f.target.health=0;f.attacker.isAttacking=false;
 d.update(100200);assert.equal(d.shot.key,oldKey);
 const other=duel(250,2);hit(other,100201);const pose=d.update(100217);
 assert.notEqual(d.shot.key,oldKey);assert.equal(d.shot.type,'brawl');assert.equal(pose.cut,true);
});

test('while a decision bubble is read the camera holds, and only a battle cuts away', () => {
    const { director: d, game, duel, hit } = setup();
    let reading = true;
    game.ui = { intentBubblesInView: () => reading };
    d.update(100000);
    const shot = d.shot;
    assert.ok(shot && shot.priority < 2, 'a calm shot to start with');
    // It runs out while a bubble is up: held on, not cut.
    shot.until = 100001;
    d.update(100200); d.update(100400);
    assert.equal(d.shot, shot, 'held while the bubble is read');
    // The bubble goes: the shot may end.
    reading = false;
    d.update(100700);
    assert.notEqual(d.shot, shot, 'free again once nothing is being read');
    // A battle cuts through a reading hold at once.
    reading = true;
    d.update(101000);
    const calm = d.shot;
    const fight = duel(); hit(fight, 101001);
    const pose = d.update(101017);
    assert.notEqual(d.shot, calm);
    assert.equal(d.shot.type, 'brawl'); assert.equal(pose.cut, true);
});

test('a reading hold is capped, so a busy base cannot keep the camera', () => {
    const { director: d, game } = setup();
    game.ui = { intentBubblesInView: () => true };
    d.update(100000);
    const shot = d.shot;
    shot.until = shot.planned = 100001;
    d.update(100001 + 19000);
    assert.equal(d.shot, shot, 'still held inside the cap');
    d.update(100001 + 20500);
    assert.notEqual(d.shot, shot, 'released past it');
});

test('a calm shot is not replaced by a better calm one before five seconds', () => {
    const { director: d } = setup();
    d.update(100000);
    const shot = d.shot;
    // Make whatever is on screen look poor next to the rest, without letting it end.
    shot.until = 200000;
    const adj = d.adjust.bind(d);
    d.adjust = (c, now) => c.key === shot.key ? -1000 : adj(c, now);
    d.update(103000);
    assert.equal(d.shot, shot, 'held at three seconds');
    d.update(105200);
    assert.notEqual(d.shot, shot, 'replaced after five');
});

// Close-ups (b1010, asp67's framing from a posed preview): one unit, low, from in front at
// a three-quarter angle, aimed at its chest so the face sits in the upper third.
test('a calm close-up frames one worker at chest height from in front, and comes once in a while', () => {
    const { director: d, game, players } = setup();
    game.renderer = { _yaw: 0, unitFacing: () => 0 };
    const w = { owner: 'a', type: 'worker', x: 100, z: 100, health: 40, isHarvesting: true, isMoving: false };
    players[0].units.push(w);
    const now = 200000;
    const c = d.candidates(now).find(x => x.type === 'closeup');
    assert.ok(c, 'a close-up is offered');
    const pose = c.make();
    assert.deepEqual([pose.closeup, pose.halfH, pose.lookY, +pose.yaw.toFixed(2)], [true, 3.6, 1.0, 0.6], 'front three-quarter, chest height, a quarter of the screen');
    assert.equal(pose.subject.units[0], w);
    assert.equal(d.candidates(now + 20000).some(x => x.type === 'closeup'), false, 'not again within 30 s');
    assert.ok(d.candidates(now + 31000).some(x => x.type === 'closeup'), 'again after 30 s');
});

test('a harvester close-up keeps the camera where the shot began; other close-ups carry no eye', () => {
    const { director: d, game, players } = setup();
    game.renderer = { _yaw: 0, unitFacing: () => 0 };
    const w = { owner: 'a', type: 'worker', x: 100, z: 100, health: 40, isHarvesting: true, isMoving: false };
    players[0].units.push(w);
    const pose = d.candidates(200000).find(x => x.type === 'closeup').make();
    const p = 0.17, dist = pose.halfH / Math.tan(10 * Math.PI / 180);
    const want = [100 + Math.cos(p) * Math.sin(pose.yaw) * dist, pose.lookY + Math.sin(p) * dist, 100 + Math.cos(p) * Math.cos(pose.yaw) * dist];
    assert.ok(pose.eye.every((v, i) => Math.abs(v - want[i]) < 1e-6), 'the eye of the opening frame: ' + pose.eye + ' vs ' + want);
    const builder = { owner: 'a', type: 'worker', x: 100, z: 100, health: 40, isBuilding: true, isMoving: false };
    players[0].units.length = 0; players[0].units.push(builder);
    const d2 = setup(); d2.game.renderer = game.renderer; d2.players[0].units.push(builder);
    const other = d2.director.candidates(200000).find(x => x.type === 'closeup').make();
    assert.equal(other.eye, undefined, 'a builder is followed as before');
});

test('a close-up looks past what stands in front of its subject, and skips one it cannot see', () => {
    const { director: d, game, players } = setup();
    game.renderer = { _yaw: 0, unitFacing: () => 0 };
    const w = { owner: 'a', type: 'worker', x: 100, z: 100, health: 40, isHarvesting: true, isMoving: false };
    players[0].units.push(w);
    const tree = a => ({ type: 'wood', amount: 100, x: 100 + Math.sin(a) * 3, z: 100 + Math.cos(a) * 3 });
    game.terrain.resources = [tree(0.6)];   // the woodcutter's tree, right where the camera would look from
    let pose = d.closeupPose(w);
    assert.ok(pose && Math.abs(pose.yaw - 0.6) > 0.5, 'the other side: ' + (pose && pose.yaw));
    game.terrain.resources = [0.6, -0.6, 1.2, -1.2].map(tree);
    assert.equal(d.closeupPose(w), null, 'every side blocked: no close-up of it');
    assert.equal(d.candidates(300000).some(x => x.type === 'closeup'), false);
});

test('a fight gets a fighter close up once it has been shown twice, and the pose carries the aim', () => {
    const { director: d, game, duel, hit } = setup();
    game.renderer = { _yaw: 0, unitFacing: () => 1 };
    const f = duel(); hit(f, 100001);
    d.update(100017);
    assert.equal(d.shot.type, 'brawl');
    const key = d.shot.key;
    assert.equal(d.candidates(100100).some(x => x.type === 'clash'), false, 'not on the first look');
    d._shotNo[key] = 2;
    const c = d.candidates(100200).find(x => x.type === 'clash');
    assert.ok(c, 'after two shots of it');
    assert.equal(c.priority, d.candidates(100200).find(x => x.key === key).priority, 'as urgent as its fight');
    const pose = c.make();
    assert.equal(pose.closeup, true);
    assert.equal(pose.subject.units[0].isAttacking, true, 'a fighter');
    d.shot = d.begin('clash', c.key, d.adjust(c, 100300), pose, 100300); d.shot.priority = c.priority;   // as update() takes it
    const out = d.update(100310);
    assert.deepEqual([out.closeup, out.lookY], [true, 1.0], 'the renderer is told to aim at the chest');
    assert.equal(d.update(101500).closeup, true, 'and it is held: the fight does not take the camera straight back');
    assert.equal(d.candidates(100400).some(x => x.type === 'clash'), false, 'not again so soon');
});

// asp67, 3 Oct 2026 (b1046): in a long fight for a settlement the camera zoomed out in waves
// to the furthest zoom. Everyone who ever struck or was struck stayed in the fight until
// they died, so the frame grew to hold the workers gone back to their nodes.
test('a long fight frames who is fighting now, not everyone who ever took part', () => {
    const { director: d, duel, hit, players } = setup();
    d.update(100000);
    const fight = duel();
    const passer = { id: 'passer', owner: 'c', type: 'warrior', x: 0.5, z: 1, health: 100, attack: 10, range: 1, speed: 1 };
    players[2].units.push(passer);
    hit(fight, 100001);
    d.observeCombat(passer, fight.target, 10, 100001, fight.target.x, fight.target.z);
    let t = 100001;
    for (let i = 0; i < 300; i++) {           // fifteen seconds: the duel goes on, the passer walks 300 away
        t += 50; passer.x += 1;
        if (i % 10 === 0) hit(fight, t);
        d.update(t);
    }
    const f = d.liveFights(t).find(x => x.active);
    assert.ok(f, 'the duel is still a fight');
    assert.ok(f.r < 5, 'framed on the duel, not on the passer 300 away: r=' + f.r);
    assert.ok(d.fightHalf(f) <= 30, 'a tight frame: ' + d.fightHalf(f));
    assert.equal(d.fightHalf({ r: 1000 }), 90, 'and a fight\'s frame has a ceiling');
});

// asp67, 3 Oct 2026 (b1047): in a siege the camera "zoomed out in waves" to the whole island.
// Between blows a siege does not count as a fight, and an age-up's compare sweep (half-height
// 90) and the overview (the island) cut in, one after the other.
test('the compare sweep and the overview wait out a fight, then come once it is calm', () => {
    const { director: d, duel, hit, players } = setup();
    d.update(100000);
    const fight = duel();
    hit(fight, 100001);
    d.update(100017);
    assert.equal(d.shot.type, 'brawl');
    d.lastOverview = 0;                                  // the overview is due
    d.compareQueue = players.slice();                    // and an age-up queued the sweep
    fight.attacker.isAttacking = false; fight.attacker.attackTarget = null; fight.target.x += 40;   // a gap between blows
    const wide = new Set();
    for (let t = 100100; t < 109000; t += 250) { d.update(t); wide.add(d.shot.type); }
    assert.ok(!wide.has('overview') && !wide.has('compare'), 'nothing wide within ten seconds of a blow: ' + [...wide]);
    for (let t = 111100; t < 140000; t += 250) { d.update(t); wide.add(d.shot.type); }
    assert.ok(wide.has('overview') && wide.has('compare'), 'deferred, not dropped: ' + [...wide]);
});

test('the overview fits the island to the screen', () => {
    const { director: d, game } = setup();
    game.renderer.wholeMapHalf = pitch => { assert.ok(pitch > 0.3 && pitch < 0.7); return 321; };
    d.lastOverview = 0;
    let half = null;
    for (let t = 100000; t < 130000 && half == null; t += 250) { const p = d.update(t); if (d.shot.type === 'overview') half = p.halfH; }
    assert.equal(half, 321);
});
