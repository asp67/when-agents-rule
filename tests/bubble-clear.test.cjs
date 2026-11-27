// The order bubbles and the panels over the map (builds 1306 and 1307).
//  - The Race Chart card follows the UI size, as the minimap beside it does.
//  - A bubble that would stand on a panel is moved beside it; where neither side is free
//    it goes above. The old way moved it from one panel onto the next and back.
//  - A panel fixed to the window counts as a panel. A fixed element has no offsetParent,
//    and the list asked for one: the unit card and the comparison strip were never on it.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

const ctx = vm.createContext({ console });
vm.runInContext(read('js/intent-layer.js') + '\nthis.IL = IntentLayer;', ctx);
const IL = ctx.IL;
const view = { vw: 1920, pad: 6, lift: 18, top: 60 };
// A bubble's rectangle as it is drawn: centred on x, its bottom `lift` above its point.
const rect = (bx, p) => ({ left: p.x - bx.w / 2, right: p.x + bx.w / 2, top: p.y - 18 - bx.h, bottom: p.y - 18 });
const over = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

// The bottom of a 1920 x 1080 arena as measured in the browser: the decisions on the left,
// the chart left of the minimap.
const LOG = { left: 14, right: 346, top: 14, bottom: 1066 }, CHART = { left: 1274, right: 1634, top: 864, bottom: 1064 }, MAP = { left: 1667, right: 1900, top: 797, bottom: 1064 };

test('the Race Chart card follows the UI size', () => {
    const css = read('css/styles.css');
    const rule = /\.race-chart \{([^}]*)\}/.exec(css)[1];
    assert.match(rule, /zoom: var\(--ui-scale, 1\);/, 'scaled as a whole, like the minimap beside it');
    assert.match(rule, /width: min\(360px, calc\(30vw \/ var\(--ui-scale, 1\)\)\)/, 'its share of the window is counted in unscaled units');
    assert.match(rule, /right: calc\(var\(--mm-edge\) \+ var\(--mm-canvas\) \+ var\(--mm-gut\) \+ 44px\)/, 'left of the minimap, by the minimap\'s own measures');
    // Everything that makes room for the card counts its width the same way.
    assert.equal((css.match(/min\(360px, 30vw\)/g) || []).length, 0, 'no unscaled copy of the width is left');
    assert.equal((css.match(/min\(360px, 30vw \/ var\(--ui-scale, 1\)\)/g) || []).length, 2);
    assert.match(css, /@media \(max-width: 1100px\) \{ \.race-chart \{ width: min\(300px, calc\(100vw \/ var\(--ui-scale, 1\) - /);
});
