// What the analyzer's re-simulation shows besides the units (asp67, b1032): the world's
// own match clock for the daylight, its fights for the strategic layer's battle rings,
// the rules' renderer calls replayed on the stage's entities, and a picked decision that
// stays picked.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const { Realm } = require('../tools/bench/realm.cjs');
const WarResim = require('../js/resim.js');

test('the scene carries the match clock, the rules clock and the fights, ids as plain arrays', () => {
    const m = new Realm({ seed: 7 });
    const [a, b] = m.startFixture(['greek', 'persian']);
    m.addBuilding(a, 'town_center', -120, 0); m.addBuilding(b, 'town_center', 120, 0);
    for (let i = 0; i < 4; i++) { m.addUnit(a, 'militia', -2, i * 2); m.addUnit(b, 'militia', 2, i * 2); }
    const ca = m.scripted(a); m.scripted(b);
    m.command(ca, 'attack_target', { targetX: 2, targetZ: 3, reason: 'fight' });
    const replay = Object.create(WarResim.Replay.prototype);
    replay.game = m.game;
    m.run(2000);
    const s1 = replay.scene();
    m.run(4000);
    const s2 = replay.scene();
    assert.ok(s2.matchMs > s1.matchMs && s1.matchMs > 0, 'the match clock runs: ' + s1.matchMs + ' -> ' + s2.matchMs);
    assert.equal(s2.simNow, m.game.simNow());
    assert.ok(s2.battles.length >= 1, 'the fight is there');
    const side = Object.values(s2.battles[0].sides)[0], kind = Object.values(side.involved)[0];
    assert.ok(Array.isArray(kind.ids) && kind.ids.length > 0, 'ids cross the worker boundary as an array');
    assert.doesNotThrow(() => JSON.stringify(s2), 'posted as a message: plain data');
});

function ui() {
    const scope = vm.createContext({ console, t: k => k, document: { getElementById: () => null } });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/ui.js'), 'utf8') + '\nthis.UI = UIManager;', scope);
    return Object.create(scope.UI.prototype);
}

test("the rules' renderer calls are replayed on the stage's own entities", () => {
    const u = ui(), calls = [];
    const rec = name => (...args) => calls.push([name, ...args]);
    u.game = { renderer: { spawnProjectile: rec('proj'), flashHit: rec('hit'), spawnDust: rec('dust'), spawnBattleRing: rec('ring') } };
    const soldier = { id: 5, x: 1, z: 1 }, tower = { id: 7, x: 9, z: 9 };
    const rs = { ents: new Map([['u5', soldier], ['b7', tower]]) };
    u.anResimFx(rs, [
        { k: 'proj', from: { x: 9, y: 4.6, z: 9 }, to: { x: 1, y: 1, z: 1 }, kind: 'stone', shooter: { id: 7, b: true } },
        { k: 'hit', e: { id: 5, b: false, x: 1, z: 1 } },
        { k: 'hit', e: { id: 99, b: false, x: 3, z: 4 } },   // gone by this frame: its ring stays
        { k: 'dust', x: 2, y: 1.2, z: 2, count: 6, color: 1 },
        { k: 'ring', x: 5, z: 6 },
    ]);
    assert.deepEqual(calls.map(c => c[0]), ['proj', 'hit', 'ring', 'dust', 'ring']);
    assert.equal(calls[0][4], tower, 'the shooter is the stage tower');
    assert.equal(calls[1][1], soldier, 'the flash is on the stage soldier');
    assert.deepEqual(calls[2].slice(1), [3, 4]);
    u.anResimFx(rs, null);
    assert.equal(calls.length, 5, 'a landing after a jump shows nothing it skipped');
});

test('the daylight runs on the world clock, and a picked decision stays picked at its step', () => {
    const u = ui();
    u.game = {};
    u.anRender = () => {};
    u.anResimIntents = () => {};
    const a = { order: [{ _sec: 30 }, { _sec: 5 }, { _sec: 40 }], cursor: 0, seek(i) { this.cursor = i; } };
    u.analyzer = a;
    // Two seats' decisions landed at step 10 (the second was asked earlier: _sec 5).
    const rs = { marks: [{ step: 10, idx: 0 }, { step: 10, idx: 1 }, { step: 20, idx: 2 }], step: 12, matchMs: 61000 };
    rs.markAt = new Map(rs.marks.map(m => [m.idx, m.step]));
    u.anResimFollow(rs);
    assert.equal(u.game._environmentSeconds, 61, 'from the match clock, not the decisions');
    assert.equal(a.cursor, 0, 'the reader picked the first of the two at step 10: kept');
    a.cursor = 2;
    u.anResimFollow(rs);
    assert.equal(a.cursor, 1, 'a pick the world has not reached yet gives way to where the world is');
    rs.step = 25; rs.matchMs = 62000;
    u.anResimFollow(rs);
    assert.deepEqual([a.cursor, u.game._environmentSeconds], [2, 62]);
});

// asp67, 3 Oct 2026 (b1046): the analyzer's auto camera zoomed out of a long settlement fight
// in waves, to the whole island. Each frame's scene names a unit's target as a plain copy,
// and the director added every copy to the fight -- frozen, never dying -- and a unit gone
// from the scene kept its last health, so the director never let go of it either.
test('the replay director sees stage entities: one target, not a copy per frame, and the dead are dead', () => {
    const scope = vm.createContext({ console, t: k => k, document: { getElementById: () => null }, location: { search: '' } });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/director.js'), 'utf8')
        + fs.readFileSync(path.join(__dirname, '../js/ui.js'), 'utf8') + '\nthis.UI = UIManager; this.D = Director;', scope);
    scope.createUnit = (type, x, z, owner) => ({ type, x, z, owner, health: 100, attack: 10, range: 1, speed: 1 });
    const u = Object.create(scope.UI.prototype);
    const noop = () => {};
    u.game = { renderer: { _yaw: 0, addUnit: noop, killUnit: noop, removeUnit: noop, addBuilding: noop, killBuilding: noop, removeBuilding: noop },
        terrain: { size: 800 }, isPlayerEliminated: () => false };
    const rs = { ents: new Map(), speed: 1 };
    u._anResim = rs;
    const world = u.anDirectorWorld(rs);
    const d = rs.director = new scope.D(world);
    let now = 1e6;
    const unit = (id, x, extra = {}) => Object.assign({ id, type: 'warrior', x, z: 0, health: 100, isMoving: false, isAttacking: false,
        isHarvesting: false, isBuilding: false, carryingResource: 0, attackTimer: 0, carryingResourceType: null,
        targetX: null, targetZ: null, task: null, attackTarget: null }, extra);
    const frame = (x, withVictim) => {
        const prey = unit('prey', x + 1), hunter = unit('hunter', x, { isAttacking: true, attackTarget: { id: 'prey', x: x + 1, z: 0, health: 100, owner: 'b' } });
        const seats = [{ id: 'a', seat: 0, civilization: 'greek', epoch: 'stone', units: [hunter].concat(withVictim ? [unit('victim', 2, { health: 30 })] : []), buildings: [] },
                       { id: 'b', seat: 1, civilization: 'persian', epoch: 'stone', units: [prey], buildings: [] }];
        u.anResimDraw(rs, { seats, nodes: [], battles: [], simNow: now }, null);
        now += 100; d.scanThreats(now);
    };
    for (let i = 0; i <= 50; i++) frame(i, i < 10);          // the fight walks 50 across the ground; the victim dies at frame 10
    const f = d.liveFights(now).find(x => x.active || x.imminent);
    assert.ok(f, 'the fight is seen');
    const stage = new Set(rs.ents.values());
    const parts = [...f.encounter.participants];
    assert.ok(parts.every(p => stage.has(p) || p.health <= 0), 'every participant is a stage entity');
    assert.equal(parts.filter(p => p.health > 0).length, 2, 'the hunter and its prey, once each: ' + parts.length);
    assert.ok(f.r < 5, 'framed on the fight where it is now: r=' + f.r);
});
