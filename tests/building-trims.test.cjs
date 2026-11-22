// Build 1214, the open part of overhaul step A5: trims on the buildings themselves.
// The band and the shuttered windows were painted on the front and the back only, so every
// building had two blank walls. They go round all four now, each window on a sill; a wall
// of two floors has a row of windows to each floor (asp67, on seeing a first proposal with
// one row across the middle of the two-storey Roman house: "This building should have a top
// and bottom floor with windows. Then they would not be covered by the front shelter roof").
const test = require('node:test'), assert = require('node:assert/strict');
const vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

function buildings() {
    const scope = { window: {}, console }; scope.window.window = scope.window; vm.createContext(scope);
    for (const f of ['js/simulation/rng.js', 'js/simulation/math.js', 'js/simulation/island.js']) vm.runInContext(read(f), scope);
    for (const f of ['math3d', 'mesh', 'texgen', 'buildings', 'fx']) vm.runInContext(read('js/engine/' + f + '.js'), scope);
    return { B: scope.window.EngineBuildings, F: scope.window.EngineFx };
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
// A window's dark pane: where it is and which way its wall faces ('z' front and back, 'x' the sides).
const panes = parts => parts.filter(p => p.visualOnly && p.tint && near(p.tint[0], .15) && near(p.tint[1], .13) && p.args.includes(.70) && p.args.includes(.58))
    .map(p => ({ x: p.m[12], y: p.m[13], z: p.m[14], faces: near(p.args[2], .065) ? 'z' : 'x' }));
const sills = parts => parts.filter(p => p.visualOnly && p.args.includes(.76) && p.args.includes(.10) && p.args.includes(.17)).map(p => ({ x: p.m[12], y: p.m[13], z: p.m[14], tex: p.tex }));
const civs = ['egyptian', 'persian', 'yamato', 'roman', 'maya', 'viking'];

test('a wall of two floors has a row of windows to each floor; a wall of one floor has one row', () => {
    const { B } = buildings();
    const house = panes(B.parts('house', { age: 'iron', civ: 'roman' }));
    // The Roman insula: a wall from 0.4 to 4.4. Windows near 1.5 and 3.2 above the ground, none across the middle.
    const rows = [...new Set(house.map(w => +w.y.toFixed(2)))].sort((a, b) => a - b);
    assert.deepEqual(rows, [1.5, 3.2]);
    assert.equal(house.some(w => w.y > 1.9 && w.y < 2.9), false, 'none where the balcony and its roof hang');
    assert.ok(B.WINDOWS.twoFloors <= 4.0 && B.WINDOWS.twoFloors > 3.2);
    // Both side walls and the back: two windows to a floor. The front: the ground floor only,
    // beside the door and under the balcony; above it the house has shutters of its own.
    for (const side of [-1, 1]) assert.equal(house.filter(w => w.faces === 'x' && Math.sign(w.x) === side).length, 4);
    assert.equal(house.filter(w => w.faces === 'z' && w.z < 0).length, 4);
    const front = house.filter(w => w.faces === 'z' && w.z > 0);
    assert.equal(front.length, 2); assert.ok(front.every(w => near(w.y, 1.5, 1e-3) && Math.abs(w.x) > 1), 'beside the door, under the balcony');
    // One floor: the Roman barracks. One row, a touch above the wall's middle, on all four sides.
    const hall = panes(B.parts('barracks', { age: 'iron', civ: 'roman' }));
    assert.equal(new Set(hall.map(w => w.y.toFixed(2))).size, 1);
    for (const [faces, sign] of [['z', 1], ['z', -1], ['x', 1], ['x', -1]]) {
        const n = hall.filter(w => w.faces === faces && Math.sign(faces === 'z' ? w.z : w.x) === sign).length;
        assert.ok(n >= 1 && n <= 2, 'the ' + faces + (sign > 0 ? '+' : '-') + ' wall has ' + n);
    }
});

test('every window sits on a sill, of what its wall is of; the band goes round all four walls', () => {
    const { B } = buildings();
    let seen = 0;
    for (const civ of civs) for (const age of ['neolithic', 'bronze', 'iron']) for (const type of ['house', 'barracks', 'stable', 'archery_range', 'academy', 'market']) {
        const parts = B.parts(type, { age, civ }), w = panes(parts), s = sills(parts), name = [civ, age, type].join(' ');
        assert.equal(s.length, w.length, name + ': a sill to a window');
        for (const pane of w) assert.ok(s.some(q => near(q.y, pane.y - .42, 1e-3) && Math.hypot(q.x - pane.x, q.z - pane.z) < .1), name + ': right under it');
        if (!w.length) continue;
        seen++;
        // The band: a thin strip along the front and back (long in x) and along both sides (long in z).
        const band = parts.filter(p => p.visualOnly && near(p.args[1], .16) && (near(p.args[2], .065) || near(p.args[0], .065)));
        const along = band.filter(p => near(p.args[2], .065)).length, across = band.filter(p => near(p.args[0], .065)).length;
        assert.ok(along >= 2 && across === along, name + ': ' + along + ' along, ' + across + ' across');
        // Side walls have windows wherever nothing stands against them.
        assert.ok(w.some(q => q.faces === 'x') || type === 'house', name + ': windows in the side walls');
    }
    assert.ok(seen > 40, seen + ' looks have windows');
    // Stone under stone, a plank under timber.
    const timber = B.parts('house', { age: 'iron', civ: 'viking' }), stone = B.parts('barracks', { age: 'iron', civ: 'roman' });
    assert.ok(sills(timber).length > 0 && sills(timber).every(q => q.tex === 'wood'));
    assert.ok(sills(stone).length > 0 && sills(stone).every(q => q.tex === 'white'));
});

test('no window is set where something already sits, and what goes round the wall is not in its way', () => {
    const { B } = buildings();
    // The neolithic barracks wears a belt of logs round its wall: its windows stay.
    assert.ok(panes(B.parts('barracks', { age: 'neolithic', civ: 'roman' })).length >= 6);
    // The Greek house has an outside stair against one side wall: a shutter on the other side only.
    const greek = B.parts('house', { age: 'iron', civ: 'greek' });
    const side = greek.filter(p => p.visualOnly && p.tex === 'wood' && near(p.args[0], .06) && near(p.args[2], .60));
    assert.equal(side.length, 1); assert.ok(side[0].m[12] < 0, 'on the side without the stair');
    // Nothing a building had is gone: every part of every look that was there before is still there.
    // (Pinned by count for a few; the rule only ever adds, or leaves a window out.)
    assert.match(read('js/engine/buildings.js'), /if\(!monument&&!free\(p,place\(across,y-\.05,off\+\.25\),size\(\.38,\.46,\.22\)\)\)return;/);
    assert.match(read('js/engine/buildings.js'), /if\(own&&r\[0\]<=own\[0\]&&r\[3\]>=own\[3\]&&r\[2\]<=own\[2\]&&r\[5\]>=own\[5\]\)continue;/);
});

test('a Wonder keeps what it had; no building has more parts than may fall apart', () => {
    const { B, F } = buildings();
    assert.deepEqual(Array.from(B.MONUMENTS).sort(), ['akropolis', 'colosseum', 'el_castillo', 'firetemple', 'longhall', 'pyramid', 'shrine', 'wonder']);
    for (const type of B.MONUMENTS) for (const civ of civs.concat('greek')) {
        const parts = B.parts(type, { age: 'iron', civ });
        assert.equal(sills(parts).length, 0, type + ' ' + civ + ': no sills');
        assert.equal(panes(parts).filter(w => w.faces === 'x').length, 0, type + ' ' + civ + ': no side windows');
        assert.equal(parts.filter(p => p.visualOnly && near(p.args[0], .065) && near(p.args[1], .16)).length, 0, type + ' ' + civ + ': no side band');
    }
    let most = 0;
    for (const type of B.TYPES) if (!B.MONUMENTS.includes(type)) for (const civ of civs.concat('greek')) for (const age of ['stone', 'neolithic', 'bronze', 'iron']) {
        most = Math.max(most, B.parts(type, { age, civ }).length);
    }
    assert.ok(most <= F.BREAK_MAX_PARTS, 'the largest ordinary building has ' + most + ' parts');
    // Trims are for looks only: they never count toward a building's footprint.
    for (const p of B.parts('house', { age: 'iron', civ: 'roman' })) if (near(p.args[1] || 0, .10) && p.args.includes(.76)) assert.equal(p.visualOnly, true);
});
