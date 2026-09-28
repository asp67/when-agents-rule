'use strict';
// move_units takes a map tile as well as coordinates. Coordinates win; the tile is the
// fallback when none are given, and the units go to its centre. Seen on the Platform on
// 28 Sep 2026: GLM-5.3 sent {"mode":"scout","tile":"G6","unitIds":[14]} twice, carrying
// explore's vocabulary over to a scout-mode march, and was refused for the shape.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMatch } = require('../tools/bench/realm.cjs');

async function setup() {
    const m = await createMatch({ kind: 'board', seed: 'move-tile', seats: [
        { civ: 'greek', age: 'neolithic', buildings: [['town_center', -100, 0]],
          units: [['militia', -90, 10, { tag: 'm' }]] },
        { civ: 'persian', age: 'neolithic', buildings: [['town_center', 300, -300]] },
    ] });
    const g = m.game, mgr = g.openAIAIManager, c = m.controllers[0], u = m.tags.m;
    const turn = params => {
        c.turnCount++;
        mgr.executeTurn(c, { commands: [{ action: 'move_units', params: Object.assign({ unitIds: [Number(u.handle)] }, params) }] });
        return String(c.seat.lastActionResult || '');
    };
    return { g, mgr, u, turn };
}

test('a tile alone sends the units to its centre', async () => {
    const { g, mgr, u, turn } = await setup();
    const res = turn({ mode: 'scout', tile: 'g6' });
    assert.doesNotMatch(res, /\[ERROR\]/, res);
    assert.match(res, /\(centre of tile G6\)$/);
    const centre = mgr.tileCentre(g, 'G6');
    const cell = 800 / 7;
    assert.ok(Math.abs(centre.x - (-400 + 6.5 * cell)) < 1e-9 && Math.abs(centre.z - (-400 + 5.5 * cell)) < 1e-9);
    assert.equal(g.tileLabelAt(centre.x, centre.z), 'G6', 'the centre lies in the tile named');
    assert.ok(Math.hypot(u._moveOrderTo.x - centre.x, u._moveOrderTo.z - centre.z) < 1, 'ordered to the centre');
});

test('coordinates win over a tile', async () => {
    const { u, turn } = await setup();
    const res = turn({ tile: 'G6', targetX: -60, targetZ: 40 });
    assert.doesNotMatch(res, /\[ERROR\]|centre of tile/, res);
    assert.ok(Math.hypot(u._moveOrderTo.x + 60, u._moveOrderTo.z - 40) < 1, 'went to the coordinates');
});

test('a bad tile and a missing destination are named', async () => {
    const { turn } = await setup();
    assert.match(turn({ tile: '6G' }), /\[ERROR\] "6G" is not a map tile\..*or give "targetX" and "targetZ"/);
    assert.match(turn({ mode: 'scout' }), /\[ERROR\] move_units requires "targetX" and "targetZ" parameters, or a "tile" label/);
});

test('the tool schema offers the tile and requires nothing', async () => {
    const { mgr } = await setup();
    const spec = mgr.constructor.ACTIONS.find(a => a.name === 'move_units');
    assert.ok(spec, 'move_units is an action');
    assert.equal(spec.params.tile.type, 'string');
    assert.deepEqual([...spec.required], []);
});
