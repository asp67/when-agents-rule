'use strict';
// Build 1229 (asp67, 22 November 2026): "are the simple shadow circles not removed when
// switching to cinematic?" They were not: under real shadows the round disc beneath a unit, a
// tree or a building stayed at 55 %, on top of the shadow that was cast. Held here: the disc
// fades out as the real shadows fade in and is then not drawn at all, and it is whole again
// where there are no real shadows (Simple lighting, and the far view).
const test = require('node:test'), assert = require('node:assert/strict');
const vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

function load() {
    const scope = { window: {}, console, performance: { now: () => 1000 } }; scope.window.window = scope.window; vm.createContext(scope);
    for (const f of ['js/simulation/rng.js', 'js/simulation/math.js', 'js/simulation/island.js']) vm.runInContext(read(f), scope);
    for (const f of ['math3d', 'mesh', 'texgen', 'buildings', 'units', 'atmosphere']) vm.runInContext(read('js/engine/' + f + '.js'), scope);
    scope.window.GLCore = { createMeshBuffers: () => ({}), createShadowBuffers: () => ({}), deleteMeshBuffers() {}, drawMesh() {} };
    vm.runInContext('Object.assign(globalThis, window);' + read('js/engine/gamerenderer.js'), scope);
    return vm.runInContext('window.EngineRenderer', scope);
}

test('a round shadow disc is gone where real shadows are at full strength, and whole where there are none', () => {
    const R = load(), src = read('js/engine/gamerenderer.js');
    assert.equal(R.DISC_UNDER_SHADOW, 1);
    // How much of a disc is shown, as the draw pass works it out.
    const line = src.match(/const discShow = (.+?), disc = this\.tex\.shadow;/);
    assert.ok(line, 'the draw pass works out how much of a disc is shown');
    const shown = strength => vm.runInNewContext(line[1].replace('this._shadowStrength', String(strength)), { Math, EngineRenderer: R });
    assert.deepEqual([shown(0), shown(0.5), shown(1)], [1, 0.5, 0]);
    // The real shadows are at full strength up to a view height of 100 and gone from 160: the disc mirrors that.
    const strength = src.match(/this\._shadowStrength = target && this\.visualStyle !== 'classic'\s*\? (Math\.max\(0,Math\.min\(1,\(160-this\._halfH\)\/60\)\)) : 0;/);
    assert.ok(strength, 'no real shadows in Simple lighting, and none without a shadow target');
    const at = half => shown(vm.runInNewContext(strength[1].replace('this._halfH', String(half)), { Math }));
    assert.deepEqual([at(20), at(100), at(130), at(160), at(240)], [0, 0, 0.5, 1, 1]);
    // It is the disc's own alpha, and a disc that is not shown costs no draw.
    assert.match(src, /const a = \(obj\.alpha == null \? 1 : obj\.alpha\) \* \(obj\.tex === disc \? discShow : 1\);/);
    assert.match(src, /for \(const obj of list\) \{\s+if \(discShow <= 0 && obj\.tex === disc\) continue;/);
    assert.doesNotMatch(src, /_shadowStrength\*\.45/);
});

test('the discs themselves are still built: Simple lighting and the far view need them', () => {
    const units = read('js/engine/units.js'), buildings = read('js/engine/buildings.js'), src = read('js/engine/gamerenderer.js');
    assert.match(units, /const shadow = \(arr, r\) => part\(arr, 'disc', \[r, 14\], 'shadow', \{ y: 0\.05, blend: true \}\);/);
    assert.match(buildings, /const shadow = \(arr, r\) => part\(arr, 'disc', \[r, 18\], 'shadow', \{ y: 0\.06, blend: true \}\);/);
    assert.ok((src.match(/add\('disc', \[[\d.]+, 14\], 'shadow'/g) || []).length >= 3, 'under trees and rocks too');
});
