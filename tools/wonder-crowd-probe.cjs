'use strict';
// Probe (29 Sep 2026): a group of melee/mounted units ordered at a Wonder from one side.
// Each unit's blows landed, heading reversals, and closest approach to the centre.
//   node tools/wonder-crowd-probe.cjs [unitType] [count] [civ]
const { createMatch } = require('./bench/realm.cjs');
const [unitType = 'scout_cavalry', count = '8', civ = 'egyptian'] = process.argv.slice(2);
const WONDERS = { egyptian: 'pyramid', greek: 'akropolis', persian: 'firetemple', yamato: 'shrine' };
(async () => {
    const W = { x: 100, z: 0 }, n = Number(count);
    const units = Array.from({ length: n }, (_, i) => [unitType, W.x - 40, W.z - (n - 1) * 1.5 + i * 3, { tag: 'u' + i }]);
    const m = await createMatch({ kind: 'board', seed: 'wonder-crowd', seats: [
        { civ: civ === 'greek' ? 'persian' : 'greek', age: 'iron', buildings: [['town_center', -300, 0]], units },
        { civ, age: 'iron', buildings: [['town_center', 300, 250], [WONDERS[civ], W.x, W.z, { tag: 'w' }]] },
    ] });
    const w = m.tags.w, c = m.controllers[0], us = units.map((_, i) => m.tags['u' + i]);
    const blows = new Map(us.map(u => [u, 0])), flips = new Map(us.map(u => [u, 0])), minD = new Map(us.map(u => [u, Infinity]));
    const last = new Map(us.map(u => [u, { x: u.x, z: u.z, dir: null }]));
    const hit = m.game.recordBattleDamage.bind(m.game);
    m.game.recordBattleDamage = (a, t, d) => { if (t === w && blows.has(a)) blows.set(a, blows.get(a) + 1); return hit(a, t, d); };
    m.command(c, 'attack_target', { targetId: w.id, unitIds: us.map(u => Number(u.handle)) });
    for (let i = 0; i < 600; i++) {   // 30 s
        m.advance(50);
        for (const u of us) {
            const l = last.get(u), dx = u.x - l.x, dz = u.z - l.z;
            if (Math.hypot(dx, dz) > 1e-3) { const dir = Math.atan2(dz, dx); if (l.dir != null) { let d = Math.abs(dir - l.dir); if (d > Math.PI) d = 2 * Math.PI - d; if (d > 2.5) flips.set(u, flips.get(u) + 1); } l.dir = dir; }
            l.x = u.x; l.z = u.z; minD.set(u, Math.min(minD.get(u), Math.hypot(u.x - w.x, u.z - w.z)));
        }
    }
    const reach = m.game.attackRangeAgainst(us[0], w);
    console.log(civ, WONDERS[civ], unitType, 'x' + n, 'reach', reach.toFixed(2), 'wonder damage', Math.round(w.maxHealth - w.health));
    us.forEach((u, i) => console.log('  #' + i, 'blows', String(blows.get(u)).padStart(3), 'reversals', String(flips.get(u)).padStart(3), 'closest', minD.get(u).toFixed(2),
        'now', Math.hypot(u.x - w.x, u.z - w.z).toFixed(2), 'at', (Math.round(Math.atan2(u.z - w.z, u.x - w.x) * 180 / Math.PI)) + '°'));
})().catch(e => { console.error(e); process.exit(1); });
