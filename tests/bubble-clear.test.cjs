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

test('a bubble on free ground stays where it is', () => {
    const bx = { x: 800, w: 200, h: 40 };
    assert.deepEqual({ ...IL.clear(bx, 500, [LOG, CHART, MAP], view) }, { x: 800, y: 500 });
});

test('a bubble on a panel goes beside it, toward the middle of the view, as before', () => {
    const bx = { x: 1400, w: 200, h: 40 }, p = IL.clear(bx, 950, [LOG, CHART, MAP], view);
    assert.deepEqual({ ...p }, { x: CHART.left - 6 - 100, y: 950 }, 'left of the chart: the chart stands right of the middle');
    const q = IL.clear({ x: 200, w: 200, h: 40 }, 500, [LOG, CHART, MAP], view);
    assert.deepEqual({ ...q }, { x: LOG.right + 6 + 100, y: 500 }, 'right of the decisions');
    // Off the minimap the way leads onto the chart's ground, and on past it.
    const r = IL.clear({ x: 1800, w: 200, h: 40 }, 950, [LOG, CHART, MAP], view);
    assert.ok(![LOG, CHART, MAP].some(panel => over(rect({ w: 200, h: 40 }, r), panel)), JSON.stringify(r));
});

test('with a panel on either side of it, a bubble goes above the one it stood on', () => {
    // A strip along the bottom, left of the chart, as broadcast mode has it.
    const STRIP = { left: 32, right: 1260, top: 960, bottom: 1040 };
    const bx = { x: 1400, w: 300, h: 60 }, panels = [STRIP, CHART, MAP];
    const p = IL.clear(bx, 1000, panels, view);
    assert.ok(!panels.some(panel => over(rect(bx, p), panel)), 'on no panel: ' + JSON.stringify(p));
    assert.ok(p.y < 1000, 'it went up to get there');
    assert.ok(Math.hypot(p.x - 1400, p.y - 1000) < 320, 'and not far: ' + JSON.stringify(p));
    // Standing on the chart alone, with the strip beside it: straight up.
    const onChart = IL.clear({ x: 1450, w: 300, h: 60 }, 1050, [CHART, { left: 32, right: 1268, top: 900, bottom: 1070 }, MAP], view);
    assert.deepEqual({ ...onChart }, { x: 1450, y: CHART.top - 6 + 18 }, 'its bottom a gap above the chart');
    // The old way, for the record: left of the chart is the strip, right of the strip is the chart.
    const old = (b, y) => { let x = b.x; for (let pass = 0; pass < 2; pass++) for (const q of panels) {
        if (!(y - 18 - b.h < q.bottom && y - 18 > q.top && x - b.w / 2 < q.right && x + b.w / 2 > q.left)) continue;
        x = (q.left + q.right) / 2 < view.vw / 2 ? q.right + 6 + b.w / 2 : q.left - 6 - b.w / 2; } return { x, y }; };
    assert.ok(panels.some(panel => over(rect(bx, old(bx, 1000)), panel)), 'which left it on one of them');
});

test('a narrow window: no bubble is left on a panel while there is room above it', () => {
    // 1024 wide: the decisions end at 221, the chart runs 438-738, the minimap from 862.
    const v = { vw: 1024, pad: 6, lift: 18, top: 60 };
    const panels = [{ left: 9, right: 221, top: 9, bottom: 759 }, { left: 438, right: 738, top: 552, bottom: 752 }, { left: 862, right: 1011, top: 586, bottom: 758 }];
    let n = 0;
    for (const w of [120, 240, 320]) for (let x = 20; x < 1024; x += 30) for (let y = 300; y <= 780; y += 30) {
        const bx = { x, w, h: 48 }, p = IL.clear(bx, y, panels, v), r = rect(bx, p);
        n++;
        // The decisions fill the left edge top to bottom: there is no "above" them, and a
        // bubble wider than the gap beside them has nowhere to go. Everything else is kept clear.
        assert.ok(!panels.slice(1).some(panel => over(r, panel)), `w ${w} at ${x},${y} -> ${JSON.stringify(p)}`);
        assert.ok(r.top >= v.top - 1, 'not above the top bar');
    }
    assert.ok(n > 1000);
});

test('a bubble is not sent above the top of the view to get off a panel', () => {
    const tall = { left: 600, right: 1300, top: 70, bottom: 1070 }, left = { left: 0, right: 590, top: 0, bottom: 1080 }, right = { left: 1310, right: 1920, top: 0, bottom: 1080 };
    const p = IL.clear({ x: 900, w: 200, h: 40 }, 500, [left, tall, right], view);
    assert.ok(p.y - 18 - 40 >= view.top - 1 || p.y === 500, 'it stays in the view: ' + JSON.stringify(p));
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
});

test('the page asks for the panels that are shown, fixed ones included, and the second camera', () => {
    const ui = read('js/ui.js');
    const list = /const panels = \[([^\]]+)\]/.exec(ui)[1];
    for (const id of ['aiDecisionLog', 'spectatorLeaderboard', 'minimap', 'transcriptViewer', 'unitInfo', 'benchMatrix', 'raceChart', 'compareStrip', 'secondCam'])
        assert.ok(list.includes("'" + id + "'"), id + ' is an obstacle');
    const filter = ui.slice(ui.indexOf('const panels = ['), ui.indexOf('const panels = [') + 500);
    assert.match(filter, /el\.offsetWidth > 0 && \(el\.offsetParent !== null \|\| getComputedStyle\(el\)\.position === 'fixed'\)/);
    assert.match(ui, /IntentLayer\.clear\(bx, y, panels, view\)/);
});

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
