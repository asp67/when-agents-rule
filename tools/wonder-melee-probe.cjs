'use strict';
// Probe (29 Sep 2026): a lone melee or mounted unit ordered at a Wonder, from eight
// directions -- the middle of each face and each corner -- for each civilization's Wonder.
// Reports damage dealt, where the unit ended, and how often its heading reversed.
//   node tools/wonder-melee-probe.cjs [unitType]
const { createMatch } = require('./bench/realm.cjs');
const unitType = process.argv[2] || 'scout_cavalry';
// --ring: the buildings that stood around Egypt's pyramid in a live Platform match
// (29 Sep 2026), at their offsets from its centre.
const RING = process.argv.includes('--ring') ? [['town_center', 22.9, 16.4], ['barracks', 13.4, 25.6], ['tower', 5.1, 18.3], ['tower', 18.1, -4.3], ['tower', -13.3, 9.9], ['tower', 2.6, -18], ['archery_range', -14.3, -10.1], ['barracks', -27.3, -2.1]] : [];
const ONLY = process.argv.includes('--ring') ? ['egyptian'] : null;
const WONDERS = { egyptian: 'pyramid', greek: 'akropolis', persian: 'firetemple', yamato: 'shrine' };
(async () => {
    for (const [civ, wonder] of Object.entries(WONDERS).filter(([c]) => !ONLY || ONLY.includes(c))) {
        const rows = [];
        for (let k = 0; k < 8; k++) {
            const a = k * Math.PI / 4, W = { x: 100, z: 0 };
            const m = await createMatch({ kind: 'board', seed: 'wonder-melee', seats: [
                { civ: civ === 'greek' ? 'persian' : 'greek', age: 'iron', buildings: [['town_center', -300, 0]],
                  units: [[unitType, W.x + Math.cos(a) * 40, W.z + Math.sin(a) * 40, { tag: 'u' }]] },
                { civ, age: 'iron', buildings: [[wonder, W.x, W.z, { tag: 'w' }], ...RING.map(([t, dx, dz]) => [t, W.x + dx, W.z + dz])].concat(RING.length ? [] : [['town_center', 300, 250]]) },
            ] });
            const u = m.tags.u, w = m.tags.w, c = m.controllers[0], hp0 = w.health;
            const towers = m.seats[1].buildings.filter(b => b.type === 'tower'), thp0 = towers.reduce((n, b) => n + b.health, 0);
            let aliveFor = 0;
            m.command(c, 'attack_target', { targetId: w.id, unitIds: [Number(u.handle)] });
            let flips = 0, lastDir = null, px = u.x, pz = u.z, minD = Infinity;
            for (let i = 0; i < 400; i++) {   // 20 s
                m.advance(50);
                const dx = u.x - px, dz = u.z - pz;
                if (Math.hypot(dx, dz) > 1e-4) {
                    const dir = Math.atan2(dz, dx);
                    if (lastDir != null) { let d = Math.abs(dir - lastDir); if (d > Math.PI) d = 2 * Math.PI - d; if (d > 2.5) flips++; }
                    lastDir = dir;
                }
                px = u.x; pz = u.z;
                minD = Math.min(minD, Math.hypot(u.x - w.x, u.z - w.z));
                if (u.health > 0) aliveFor += 50;
            }
            rows.push((k % 2 ? 'corner ' : 'face   ') + Math.round(a * 180 / Math.PI).toString().padStart(3) + '°: damage ' + String(Math.round(hp0 - w.health)).padStart(4)
                + '  closest ' + minD.toFixed(2) + '  reach ' + m.game.attackRangeAgainst(u, w).toFixed(2) + '  reversals ' + flips + '  towerDmg ' + Math.round(thp0 - towers.reduce((n, b) => n + Math.max(0, b.health), 0)) + '  alive ' + (aliveFor / 1000).toFixed(1) + 's  target ' + (u.attackTarget === w ? 'wonder' : u.attackTarget ? u.attackTarget.type : '-'));
        }
        console.log('== ' + civ + ' ' + wonder + ' (rotationY ' + (m => m)(0) + ')');
        console.log(rows.join('\n'));
    }
})().catch(e => { console.error(e); process.exit(1); });
