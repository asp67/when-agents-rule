'use strict';
// Build 1220 (asp67, 22 November 2026): "Auto change UI size on smaller screens to fit all
// elements." The UI size had three steps to pick from by hand. 'Auto' is now the default:
// the regular size where the window allows it, smaller by the same share where it does not.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const root = path.resolve(__dirname, '..');

function ui(saved, win = { innerWidth: 1920, innerHeight: 1080 }) {
    const store = saved ? { warViewPreferencesV1: JSON.stringify(saved) } : {}, set = [], listeners = {};
    const window = Object.assign({ addEventListener: (k, fn) => { (listeners[k] = listeners[k] || []).push(fn); } }, win);
    const context = vm.createContext({ console, JSON, Math, window, setTimeout: fn => { fn(); return 1; }, clearTimeout() {},
        localStorage: { getItem: k => store[k] || null, setItem: (k, v) => { store[k] = v; } },
        document: { body: { dataset: {} }, documentElement: { style: { setProperty: (k, v) => set.push([k, v]) } }, getElementById: () => null, querySelectorAll: () => [] } });
    vm.runInContext(fs.readFileSync(path.join(root, 'js/ui.js'), 'utf8') + '\nthis.UI = UIManager;', context);
    const u = Object.create(context.UI.prototype);
    return { u, U: context.UI, set, store, window, listeners };
}

test('the size the window allows: regular from 1600 x 900 up, smaller by the same share below, never under six tenths', () => {
    const { U } = ui();
    assert.deepEqual([U.UI_FIT.width, U.UI_FIT.height, U.UI_FIT.least], [1600, 900, 0.6]);
    for (const [w, h, want] of [[1920, 1080, 1], [2560, 1440, 1], [1600, 900, 1], [1366, 768, 0.85], [1280, 720, 0.8], [1536, 864, 0.96],
        [1280, 1024, 0.8], [1920, 720, 0.8], [1024, 768, 0.64], [800, 600, 0.6], [320, 480, 0.6]]) assert.equal(U.uiFit(w, h), want, w + ' x ' + h);
    assert.equal(U.uiFit(0, 0), 1, 'a window not measured yet is not shrunk');
});

test('auto is the default and follows the window; a size somebody picked stays', () => {
    // Nothing saved, a laptop window: 0.85 without anyone choosing it.
    const a = ui(null, { innerWidth: 1366, innerHeight: 768 });
    assert.equal(a.u.viewPreferences().uiScale, 'auto');
    assert.equal(a.u.uiScaleValue(), 0.85);
    a.u.applyViewPreferences();
    assert.deepEqual(a.set[a.set.length - 1], ['--ui-scale', '0.85']);
    assert.equal(a.u.zoomedPx(85), 100, 'a measured offset is divided back out by the same number');
    // The window is made smaller: the size follows, a moment after the resizing stops.
    assert.equal(a.listeners.resize.length, 1);
    a.window.innerWidth = 1280; a.window.innerHeight = 720;
    a.listeners.resize[0]();
    assert.deepEqual(a.set[a.set.length - 1], ['--ui-scale', '0.8']);
    a.u.applyViewPreferences();
    assert.equal(a.listeners.resize.length, 1, 'the window is watched once');
    // A saved 'regular' nobody picked was only the old default: it follows the window too.
    const old = ui({ uiScale: 'regular' }, { innerWidth: 1366, innerHeight: 768 });
    assert.equal(old.u.viewPreferences().uiScale, 'auto');
    // 'medium' and 'small' were always picked by hand, and stay; so does a 'regular' picked since.
    assert.equal(ui({ uiScale: 'small' }, { innerWidth: 1366, innerHeight: 768 }).u.uiScaleValue(), 0.72);
    assert.equal(ui({ uiScale: 'medium' }).u.uiScaleValue(), 0.85);
    const picked = ui({ uiScale: 'regular', uiScalePicked: true }, { innerWidth: 1280, innerHeight: 720 });
    assert.equal(picked.u.uiScaleValue(), 1);
    picked.listeners.resize = picked.listeners.resize || [];
    // Picking a size marks it as picked, and it is kept; auto can be picked back.
    const b = ui(null, { innerWidth: 1280, innerHeight: 720 });
    b.u.setUiScale('regular');
    assert.deepEqual([b.u.uiScaleValue(), JSON.parse(b.store.warViewPreferencesV1).uiScale, JSON.parse(b.store.warViewPreferencesV1).uiScalePicked], [1, 'regular', true]);
    b.u.setUiScale('auto'); assert.equal(b.u.uiScaleValue(), 0.8);
    b.u.setUiScale('huge'); assert.equal(b.u.viewPreferences().uiScale, 'auto', 'an unknown size changes nothing');
    // The menu offers it first, in all four languages.
    assert.match(fs.readFileSync(path.join(root, 'js/ui.js'), 'utf8'), /\['auto','regular','medium','small'\]\.map\(k=>`<option value="\$\{k\}">\$\{esc\(t\('art\.ui_'\+k\)\)\}<\/option>`\)/);
    assert.equal(fs.readFileSync(path.join(root, 'js/i18n.js'), 'utf8').split('"art.ui_auto":').length - 1, 4);
});
