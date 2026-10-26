// Building clearance (js/simulation/position-rules.js). A unit walking straight at a
// building's centre was pushed straight back along its own path: its step and the push
// cancelled ~3 from the centre and it stood there, walking, for good (b1110: a guard on the
// far side of its tower, sent at a trebuchet on the same line, never left). Off the line it
// always slid round.
const test = require('node:test'), assert = require('node:assert/strict');
const { Realm } = require('../tools/bench/realm.cjs');

test('a unit marching dead-centre at a building goes round it', () => {
    for (const z of [0, 0.3]) {
        const m = new Realm({ seed: 3 });
        const [a, b] = m.startFixture(['greek', 'egyptian']);
        m.addBuilding(a, 'town_center', -300, 0); m.addBuilding(b, 'town_center', 300, 0);
        const cb = m.scripted(b); m.scripted(a);
        m.addBuilding(b, 'tower', 0, 0);
        const u = m.addUnit(b, 'champion', 7, z);
        m.command(cb, 'move_units', { mode: 'march', unitIds: [u.handle], targetX: -58, targetZ: z, reason: 'through the tower' });
        m.run(20000);
        assert.ok(Math.hypot(u.x + 58, u.z - z) < 1, 'z ' + z + ': arrived, at (' + u.x.toFixed(1) + ', ' + u.z.toFixed(1) + ')');
    }
});

// asp67's match of 25 October (22:00), at 62:16: "a greek Phalanx and Crossbowman get stuck at a
// tower. One tries to round the tower to the left and one to the right each nudging each other
// back again in an endless stalemate, preventing the formation from advancing." A guard body
// around its own tower, sent to a post past it: each slid round by the sideways part of its own
// step, two of them toward each other. Now each goes round on its own side of the line from the
// tower to where it is going. Before: 17 of 36 bodies left a unit at the tower's back.
test('a body behind a tower, sent past it, gets every unit round', () => {
    for (const seed of [1, 2, 3, 4, 6]) for (const shape of ['line', 'block', 'wedge']) {
        const m = new Realm({ seed });
        const [a, b] = m.startFixture(['greek', 'egyptian']);
        m.addBuilding(a, 'town_center', -300, 0); m.addBuilding(b, 'town_center', 300, 0);
        const ca = m.scripted(a); m.scripted(b);
        m.addBuilding(a, 'tower', 0, 0);
        const types = ['phalanx', 'phalanx', 'phalanx', 'crossbowman', 'crossbowman', 'phalanx', 'crossbowman', 'phalanx', 'crossbowman', 'phalanx'];
        const units = types.map((t, i) => { const ang = (-110 - i * 9 - seed * 2) * Math.PI / 180, r = 4.6 + (i % 3) * 1.4; return m.addUnit(a, t, Math.cos(ang) * r, Math.sin(ang) * r); });
        m.command(ca, 'move_units', { mode: 'guard', unitIds: units.map(u => u.handle), targetX: 30, targetZ: 19, formation: shape, matchSpeed: 'slowestUnit', reason: 'past the tower' });
        m.run(40000);
        const grp = units[0]._standingOrder;
        const left = units.filter(u => Math.hypot(u.x - grp.slots.get(u).x, u.z - grp.slots.get(u).z) > 3);
        assert.equal(left.length, 0, 'seed ' + seed + ' ' + shape + ': left at the tower: ' + left.map(u => u.type + ' (' + u.x.toFixed(1) + ', ' + u.z.toFixed(1) + ')').join(', '));
    }
});

// asp67's match of 26 October (11:37): four workers sent to build twitched for good 3.7 from
// one of their own houses, between them and the site. A builder walks straight at its site
// (game.updateWorkerTasks, State 4), not at its targetX, which still held an old job's
// destination; the push round the house read that and never fired.
test('a builder walking to a site behind a house goes round it, whatever its old targetX', () => {
    for (const seed of [1, 2]) {
        const m = new Realm({ seed });
        const [a, b] = m.startFixture(['roman', 'egyptian']);
        m.addBuilding(a, 'town_center', -300, 0); m.addBuilding(b, 'town_center', 300, 0);
        m.scripted(a); m.scripted(b);
        m.addBuilding(a, 'house', 0, 0);
        const site = m.addBuilding(a, 'house', -10, 0, { underConstruction: true, health: 10, buildProgress: 0 });
        const w = m.addUnit(a, 'worker', 12, (seed - 2.5) * 0.05);
        Object.assign(w, { targetX: 30, targetZ: 40, task: 'building', buildTarget: site, isMoving: false });
        m.run(20000);
        assert.ok(Math.hypot(w.x - site.x, w.z - site.z) <= 3.6 || !site.underConstruction,
            'seed ' + seed + ': reached the site, not left at (' + w.x.toFixed(2) + ', ' + w.z.toFixed(2) + ')');
    }
});
