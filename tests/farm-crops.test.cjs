'use strict';
// Fields grow their crop as plants (1 Oct 2026, asp67): bronze-age fields scattered,
// iron-age fields evenly filled; rice for the Yamato, wheat for everyone else.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const scope = { window: {} }; vm.createContext(scope);
for (const file of ['math3d', 'mesh', 'buildings']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/engine/' + file + '.js'), 'utf8'), scope);
const { EngineBuildings, EngineMesh } = scope.window;

test('the crop follows the age and the civilization', () => {
    const crops = (age, civ) => EngineBuildings.parts('farm', { age, civ }).filter(p => p.kind === 'crops');
    for (const civ of ['greek', 'egyptian', 'persian', 'yamato']) {
        const kind = civ === 'yamato' ? 'rice' : 'wheat';
        for (const [age, layout] of [['bronze', 'scatter'], ['iron', 'rows']]) {
            const c = crops(age, civ);
            assert.equal(c.length, 1, civ + ' ' + age + ' has its crop');
            assert.deepEqual([c[0].args[0], c[0].args[1], c[0].tex], [layout, kind, 'crop_' + kind], civ + ' ' + age);
        }
        for (const age of ['stone', 'neolithic']) assert.equal(crops(age, civ).length, 0, 'no planted crop before the bronze age');
    }
});

test('a crop mesh is valid, stays on its field, and the evenly filled one is denser', () => {
    const n = {};
    for (const layout of ['scatter', 'rows']) for (const crop of ['rice', 'wheat']) {
        const m = EngineMesh.crops(layout, crop, 7), verts = m.positions.length / 3;
        assert.ok(m.positions.every(Number.isFinite) && m.normals.every(Number.isFinite) && m.uvs.every(Number.isFinite));
        assert.equal(m.uvs.length / 2, verts);
        assert.ok(m.indices.every(i => i >= 0 && i < verts), layout + ' ' + crop + ' indices in range');
        for (let i = 0; i < m.positions.length; i += 3) {
            assert.ok(Math.abs(m.positions[i]) <= 3.5 && Math.abs(m.positions[i + 2]) <= 3.5, 'on the 7x7 field');
            assert.ok(m.positions[i + 1] >= 0 && m.positions[i + 1] < 1.2, 'above the soil, crop height');
        }
        n[layout + crop] = m.indices.length;
    }
    assert.ok(n.rowsrice > n.scatterrice * 1.5 && n.rowswheat > n.scatterwheat * 1.5, 'evenly filled is denser: ' + JSON.stringify(n));
});
