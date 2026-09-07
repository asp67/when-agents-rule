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
    vm.runInContext(source.slice(0, source.indexOf('\nconst WAR_PRIVATE_HOST')), scope);
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
