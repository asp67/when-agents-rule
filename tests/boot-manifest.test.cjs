// The boot split and the manifest (review #6 step 8). The rules load in a bare VM with
// no browser at all; the page loads every rule file the manifest names, in its order;
// and js/game.js?v=N stays the build number both the update notice and the build
// stamp read -- existing installs look for exactly that tag.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const M = require('../js/manifest.js');
// A server deployment of the Platform carries no index.html (it serves its own pages),
// so the page tests skip there rather than fail.
const PAGE = fs.existsSync(path.join(root, 'index.html'));
const NO_PAGE = PAGE ? {} : { skip: 'no index.html in this checkout (a Platform server deploys without the WAR page)' };
const html = PAGE ? read('index.html') : '';
// Any version string: WAR numbers its builds, the Platform names its milestones.
const scripts = [...html.matchAll(/<script src="([^"?]+)(?:\?v=([^"]+))?"/g)].map(m => ({ file: m[1], v: m[2] }));

test('the rules load in a bare VM: no document, no location, nothing cut', () => {
    const context = vm.createContext({ console: { log() {}, warn() {}, error() {} } });
    vm.runInContext('globalThis.window = globalThis', context);   // texgen's module pattern
    for (const f of ['js/manifest.js'].concat(M.vm)) vm.runInContext(read(f), context, { filename: f });
    assert.equal(vm.runInContext('typeof Game.prototype.simulateStep', context), 'function');
    assert.equal(vm.runInContext('typeof game', context), 'undefined', 'no game is made: that is boot.js, in a browser');
    assert.doesNotMatch(read('js/game.js'), /WAR_PRIVATE_HOST|addEventListener\('load'/, 'start-up stays in boot.js');
});

test('the page loads every rule file, in the manifest order, and boot.js right after game.js', NO_PAGE, () => {
    const order = scripts.map(s => s.file);
    for (const f of M.rules.concat(M.harness, 'js/manifest.js', 'js/boot.js')) assert.ok(order.includes(f), f + ' is loaded by index.html');
    const pos = f => order.indexOf(f);
    for (let i = 1; i < M.vm.length; i++) assert.ok(pos(M.vm[i - 1]) < pos(M.vm[i]), `${M.vm[i - 1]} before ${M.vm[i]}`);
    assert.ok(pos('js/manifest.js') < pos('js/conditions.js'), 'the manifest before the fingerprint that reads it');
    assert.equal(pos('js/boot.js'), pos('js/game.js') + 1, 'boot.js directly after game.js, so its load handler comes first');
});

test('the build number: game.js?v=N, read the same way by the update notice and the stamp', NO_PAGE, t => {
    const anchor = scripts.find(s => s.file === 'js/game.js');
    if (!/^\d+$/.test(anchor.v || '')) return t.skip('this page versions its assets by milestone (' + anchor.v + '), not by build number');
    const ctx = vm.createContext({ console, window: {}, localStorage: null });
    vm.runInContext(read('js/update-notice.js') + '\nthis.WarUpdates = WarUpdates;', ctx);
    const fromNotice = ctx.WarUpdates.parseBuild(html);
    const tag = scripts.find(s => s.file === 'js/game.js');
    const scope = { t: k => k, document: { getElementById: () => null, querySelector: sel => /js\/game\.js/.test(sel) ? { getAttribute: () => tag.file + '?v=' + tag.v } : null } };
    vm.createContext(scope);
    vm.runInContext(read('js/ui.js') + '\nthis.UI = UIManager;', scope);
    assert.ok(Number.isSafeInteger(fromNotice) && fromNotice > 0);
    assert.equal(scope.UI.buildVersion(), fromNotice);
    const highest = Math.max(...scripts.filter(s => /^\d+$/.test(s.v || '')).map(s => Number(s.v)));
    assert.equal(fromNotice, highest, 'game.js carries the newest build: every change bumps it');
});
