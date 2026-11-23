// Evaluation marks in the world (overhaul step B4): js/eval/marks.js, the facts the ledger
// hands it (which order carried a plan step out, which answered a threat, and where), and
// the drawing in js/ui.js.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const WarEval = require(path.join(root, 'js/eval/ledger.js'));
const EvalMarks = require(path.join(root, 'js/eval/marks.js'));

// One decision of seat a: a plan, orders as [action, params, verdict], and what its state showed under attack.
const decision = (n, o = {}) => JSON.stringify({ turn: n, playerId: 'a', name: 'Seat a', seat: 0,
    parsed: Object.assign({ commands: (o.orders || []).map(x => ({ action: x[0], params: x[1] || {} })) }, o.plan ? { plan: o.plan } : null),
    outcomes: (o.orders || []).map((x, i) => ({ n: i + 1, action: x[0], code: 'c', verdict: x[2] || 'ok' })),
    state: { clock: { matchSeconds: n * 30 }, population: { used: 20 }, threats: { underAttack: o.attack || [], enemyWonders: o.wonders || [] },
        units: { trainable: { barracks: { stone: [{ id: 'militia' }] } } }, buildings: { buildable: [{ type: 'tower' }, { type: 'barracks' }] },
        friendlyBuildings: [{ type: 'barracks', x: 100, z: 100 }], gameStats: { opponents: [{ id: 'maya-2', civilization: 'maya' }] } } });
const raid = [{ kind: 'building', type: 'barracks', x: 100, z: 100, attackerAt: { x: 108, z: 102, owner: 'maya-2' } }];
const profileOf = lines => { const l = WarEval.createLedger(); lines.forEach(x => l.addLine(x)); return l.profile(); };
const plainOf = v => JSON.parse(JSON.stringify(v));

test('the ledger says which order answered a threat, and where the threat was', () => {
    const p = profileOf([
        decision(1, { orders: [['assign_workers']] }),
        decision(2, { attack: raid, orders: [['train_unit', { unitType: 'militia' }]] }),
        decision(3, { attack: raid, orders: [['assign_workers'], ['attack_target', { targetX: 105, targetZ: 100 }]] }),
        decision(4, { orders: [['assign_workers']] }),
        decision(5, { wonders: [{ id: 'w1', x: 400, z: 420, owner: 'maya-2' }], orders: [['attack_target', { targetId: 'w1' }]] }),
        decision(6, { attack: [{ kind: 'unit', type: 'worker', x: 50, z: 60 }], orders: [['assign_workers']] }),
        decision(7, { orders: [['wait']] }),
        decision(8, { attack: [{ kind: 'unit', type: 'worker', x: 90, z: 95 }], orders: [['wait']] })
    ]);
    const list = plainOf(p.seats[0].tactical.list);
    // The raid: where the attacker stood when the seat was shown it, and the attack that answered one decision later.
    assert.deepEqual([list[0].kind, list[0].at, list[0].answer], ['attack', { x: 108, z: 102 }, { decision: 3, turn: 3, sec: 90, n: 2, k: 1, action: 'attack_target', x: 105, z: 100 }]);
    // The rival Wonder, attacked by its id in the decision that showed it.
    assert.deepEqual([list[1].kind, list[1].at, list[1].answer.decision, list[1].answer.action], ['wonder', { x: 400, z: 420 }, 5, 'attack_target']);
    // Scale v4: assign_workers answers a raid on a worker, whereas waiting leaves the raid unanswered.
    assert.deepEqual([list[2].at, list[2].answer.action, list[2].answeredAfter], [{ x: 50, z: 60 }, 'assign_workers', 0]);
    assert.deepEqual([list[3].at, list[3].answer, list[3].answeredAfter], [{ x: 90, z: 95 }, null, null]);
});

test('a mark appears when the ledger reports a threat answer, once, and a first look only takes stock', () => {
    const l = WarEval.createLedger(), M = new EvalMarks();
    l.addLine(decision(1, { plan: ['Build a tower'], orders: [['build_structure', { buildingType: 'tower', targetX: 120, targetZ: 80 }]] }));
    // The page opens on a match already under way: what happened before is not replayed as marks.
    assert.deepEqual([M.poll(l.profile(), 1000), M.marks.length], [0, 0]);
    l.addLine(decision(2, { attack: raid, orders: [['train_unit', { unitType: 'militia' }], ['attack_target', { targetX: 105, targetZ: 100 }]] }));
    assert.equal(M.poll(l.profile(), 2000), 1);
    assert.deepEqual(plainOf(M.marks.map(m => [m.kind, m.id, m.by.action, m.born, m.life])),
        [['answer', 'a', 'attack_target', 2000, 8000]]);
    assert.deepEqual(plainOf([M.marks[0].to, M.marks[0].what, M.marks[0].wonder]), [{ x: 108, z: 102 }, ['barracks'], false]);
    // Looked at again, nothing is new; when their time is up they are gone.
    assert.deepEqual([M.poll(l.profile(), 3000), M.marks.length], [0, 1]);
    assert.deepEqual([M.poll(l.profile(), 10100), M.marks.length], [0, 0]);
    // EvalMarks.short still normalizes whitespace and truncates cleanly.
    assert.equal(EvalMarks.short('Build   a tower\nby the gate'), 'Build a tower by the gate');
    assert.equal(EvalMarks.short('x'.repeat(80)).length, 46);
    assert.ok(EvalMarks.short('x'.repeat(80)).endsWith('…'));
    assert.equal(WarEval.publicProfile(l.profile()).seats[0].tactical.list, undefined);
});

test('a battle plate needs two sides and a loss; marks hold, fade and are placed by the page', () => {
    const M = new EvalMarks();
    assert.equal(M.battle({ kind: 'battle', x: 10, z: 20, sides: { a: { involved: 4, lost: 0 }, b: { involved: 3, lost: 0 } } }, 0), false);   // nobody fell
    assert.equal(M.battle({ kind: 'battle', x: 10, z: 20, sides: { a: { involved: 4, lost: 2 } } }, 0), false);                              // one side is no battle
    assert.equal(M.battle({ kind: 'age', x: 10, z: 20, sides: { a: { lost: 1 }, b: { lost: 1 } } }, 0), false);
    assert.equal(M.battle({ kind: 'battle', x: 10, z: 20, sides: { a: { involved: 4, lost: 1 }, b: { involved: 6, lost: 5 } } }, 1000), true);
    M.marks.push({ kind: 'step', id: 'a', text: 'Build a tower', by: { action: 'build_structure', x: 5, z: 6 }, born: 1000, life: 8000 },
        { kind: 'step', id: 'gone', text: 'Train militia', by: { action: 'train_unit' }, born: 1000, life: 8000 },
        { kind: 'answer', id: 'a', to: { x: 900, z: 900 }, by: { action: 'attack_target' }, born: 1000, life: 8000 });
    const project = (x, z) => (x > 500 ? null : { x: x * 2, y: z * 2 });                       // far away is out of view
    const place = m => m.id === 'gone' ? null : m.kind === 'answer' ? { at: m.to, from: { x: 1, z: 1 } } : { at: { x: m.by.x, z: m.by.z }, from: null };
    const f = M.frame(project, place, 2000);
    // The plate stands on the battle, the tick on the site; a mark whose place is gone or out of view is not drawn.
    assert.deepEqual(f.map(m => [m.kind, m.x, m.y, m.opacity]), [['battle', 20, 40, 1], ['step', 10, 12, 1]]);
    assert.deepEqual(f[0].sides, [{ id: 'a', lost: 1, involved: 4 }, { id: 'b', lost: 5, involved: 6 }]);
    // Fully there until the last second and a half, then fading, then nothing.
    assert.deepEqual([EvalMarks.alpha(1000, 1000), EvalMarks.alpha(7400, 1000), EvalMarks.alpha(8250, 1000), EvalMarks.alpha(9000, 1000), EvalMarks.alpha(900, 1000)], [1, 1, 0.5, 0, 0]);
    assert.deepEqual(M.frame(project, place, 9100), []);
});

// The page: placing and drawing, on a stand-in for the SVG.
function ui() {
    const made = [];
    const node = tag => { const e = { tag, attrs: {}, children: [], textContent: '', setAttribute(k, v) { this.attrs[k] = String(v); },
        appendChild(c) { this.children.push(c); return c; }, insertBefore(c, ref) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); this.children.splice(this.children.indexOf(ref), 0, c); return c; } };
        made.push(e); return e; };
    const context = vm.createContext({ console, Date, WarEval, EvalMarks, t: (k, v) => k + (v ? JSON.stringify(v) : ''), tg: s => s,
        OpenAIAIManager: { MAX_COMMANDS_PER_TURN: 3 }, document: { getElementById: () => null, createElementNS: (ns, tag) => node(tag) } });
    vm.runInContext(fs.readFileSync(path.join(root, 'js/ui.js'), 'utf8') + '\nthis.UI = UIManager;', context);
    const u = Object.create(context.UI.prototype);
    u.legibleColor = c => c; u.identityHex = id => '#' + id; u.civNames = () => ({ greek: 'Greeks', maya: 'Maya' });
    const army = [{ type: 'militia', x: 10, z: 10, health: 5 }, { type: 'archer', x: 30, z: 10, health: 5 }, { type: 'worker', x: 500, z: 500, health: 5 }];
    u.game = { spectatorMode: true, gameStarted: true, renderer: { worldToScreen: (x, y, z) => ({ x, y: z }) },
        aiManager: { aiPlayers: [{ id: 'a', seat: 0, civilization: 'greek', units: army, buildings: [] }, { id: 'b', seat: 1, civilization: 'maya', units: [], buildings: [] }] } };
    const homes = [];
    u.intentLayer = { centroid: list => ({ x: list.reduce((a, q) => a + q.x, 0) / list.length, z: list.reduce((a, q) => a + q.z, 0) / list.length }),
        home: (ai, action, p) => { homes.push([action, p.unitType]); return { x: 77, z: 88 }; } };
    u.evalMarks = new EvalMarks();
    return { u, node, made, homes };
}
const texts = g => { const out = []; const walk = e => { if (e.tag === 'text') out.push(e.children.map(c => c.textContent).join('')); e.children.forEach(walk); }; walk(g); return out; };
const count = (g, cls) => { let n = 0; const walk = e => { if ((e.attrs.class || '').split(' ').includes(cls)) n++; e.children.forEach(walk); }; walk(g); return n; };

test('a tick stands where the step was carried out, and an answer runs from the fighters to the threat', () => {
    const { u, homes } = ui();
    // An order that named a place: there. One that named none: the building that carries it out.
    assert.deepEqual(plainOf(u.evalMarkPlace({ kind: 'step', id: 'a', by: { action: 'build_structure', name: 'tower', x: 124, z: 82 } })), { at: { x: 124, z: 82 }, from: null });
    assert.deepEqual(plainOf(u.evalMarkPlace({ kind: 'step', id: 'a', by: { action: 'train_unit', name: 'militia', x: null, z: null } })), { at: { x: 77, z: 88 }, from: null });
    assert.deepEqual(homes, [['train_unit', 'militia']]);
    // An attack sent: from where the fighting units stand (the worker is not one of them). A tower or a repair has no arrow.
    assert.deepEqual(plainOf(u.evalMarkPlace({ kind: 'answer', id: 'a', to: { x: 108, z: 102 }, by: { action: 'attack_target' } })), { at: { x: 108, z: 102 }, from: { x: 20, z: 10 } });
    assert.deepEqual(plainOf(u.evalMarkPlace({ kind: 'answer', id: 'a', to: { x: 108, z: 102 }, by: { action: 'build_structure' } })), { at: { x: 108, z: 102 }, from: null });
    // A seat that is no longer in the match has no place for a mark.
    assert.equal(u.evalMarkPlace({ kind: 'step', id: 'nobody', by: { action: 'train_unit' } }), null);
});

test('the three marks as drawn: a tick with the step, a dashed arrow with what it answers, a plate with each side\'s losses', () => {
    const { u, node } = ui();
    const now = Date.now();
    u.evalMarks.marks.push({ kind: 'step', id: 'a', text: 'Build a tower', by: { action: 'build_structure', x: 124, z: 82 }, born: now, life: 8000 },
        { kind: 'answer', id: 'a', to: { x: 108, z: 102 }, by: { action: 'attack_target' }, what: ['barracks'], wonder: false, born: now, life: 8000 },
        { kind: 'answer', id: 'a', to: { x: 400, z: 420 }, by: { action: 'attack_target' }, what: ['wonder'], wonder: true, born: now, life: 8000 });
    u.evalMarks.battle({ kind: 'battle', x: 200, z: 210, sides: { a: { involved: 4, lost: 1 }, b: { involved: 6, lost: 5 } } }, now);
    const svg = node('svg');
    u.drawEvalMarks(svg, 'ns');
    const g = svg.children[0];
    assert.deepEqual([g.attrs.class, g.children.length, g.children.map(c => c.attrs.class).join(' | ')], ['eval-marks', 4, 'eval-mark eval-step | eval-mark eval-answer | eval-mark eval-answer | eval-mark eval-battle']);
    assert.deepEqual(texts(g), ['mark.step Build a tower', 'Greeks mark.answer{"what":"barracks"}', 'Greeks mark.answerWonder', '⚔ mark.lost{"who":"Greeks","n":1} · mark.lost{"who":"Maya","n":5}']);
    assert.deepEqual([count(g, 'eval-tick'), count(g, 'eval-tick-mark'), count(g, 'eval-arrow'), count(g, 'eval-arrow-head'), count(g, 'is-battle')], [1, 1, 2, 2, 1]);
    // The arrow starts at the fighters and stops short of the threat, where its head sits.
    const arrow = g.children[1].children.find(c => c.attrs.class === 'eval-arrow');
    assert.deepEqual([arrow.attrs.x1, arrow.attrs.y1], ['20.0', '10.0']);
    assert.ok(Number(arrow.attrs.x2) < 108 && Number(arrow.attrs.y2) < 102);
    // Each side's loss is written in that seat's own colour.
    const plate = g.children[3].children.find(c => c.tag === 'text');
    assert.deepEqual(plate.children.filter(c => c.attrs.fill).map(c => c.attrs.fill), ['#a', '#b']);
    // Nothing to draw, or no match being watched: nothing is added to the overlay.
    const none = node('svg');
    u.game.gameStarted = false;
    u.drawEvalMarks(none, 'ns');
    assert.equal(none.children.length, 0);
});

test('the marks are part of the story layer: the Intent switch hides them, and the pieces are wired', () => {
    const src = fs.readFileSync(path.join(root, 'js/ui.js'), 'utf8'), html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    assert.match(src, /if \(r && r\.worldToScreen && this\.intentOn\(\)\) this\.drawEvalMarks\(svg, NS\);/);
    assert.match(src, /const ledger = !document\.hidden && this\.intentOn\(\) \? this\.evalLedger\(\) : null;\s+if \(ledger\) this\.evalMarks\.poll\(ledger\.profile\(\)\);/);
    assert.match(src, /if \(this\.evalMarks && this\.intentOn\(\)\) this\.evalMarks\.battle\(e\);/);
    // Bubbles keep off the Bench panels, the race chart and the comparison strip as they keep off the other panels.
    assert.match(src, /'unitInfo', 'benchMatrix', 'raceChart', 'compareStrip'\]/);
    assert.ok(html.includes('src="js/eval/marks.js?'), 'the marks file is loaded by the page');
    const context = vm.createContext({ window: {}, navigator: { language: 'en' }, localStorage: { getItem: () => null, setItem() {} },
        document: { documentElement: {}, querySelectorAll: () => [], addEventListener() {} } });
    vm.runInContext(fs.readFileSync(path.join(root, 'js/i18n.js'), 'utf8') + ';this.I = I18N;', context);
    for (const lang of ['en', 'de', 'es', 'zh']) for (const k of ['mark.step', 'mark.answer', 'mark.answerWonder', 'mark.lost']) assert.ok(k in context.I[lang], lang + ' lacks ' + k);
});

test('mark labels stand under their point and under one another, never on top of each other', () => {
    const { u, node } = ui();
    const now = Date.now();
    // Two plan steps carried out at the same Town Center, and a third at a building right beside it.
    u.evalMarks.marks.push({ kind: 'step', id: 'a', text: 'Train villagers without a pause', by: { action: 'train_unit', x: 100, z: 100 }, born: now, life: 8000 },
        { kind: 'step', id: 'a', text: 'Research house', by: { action: 'research_tech', x: 100, z: 100 }, born: now, life: 8000 },
        { kind: 'step', id: 'a', text: 'Build a tower', by: { action: 'build_structure', x: 130, z: 104 }, born: now, life: 8000 },
        { kind: 'answer', id: 'a', to: { x: 100, z: 100 }, by: { action: 'build_structure' }, what: ['town_center'], wonder: false, born: now, life: 8000 });
    const svg = node('svg');
    u.drawEvalMarks(svg, 'ns');
    const plates = [];
    const walk = e => { if ((e.attrs.class || '').startsWith('eval-plate')) plates.push({ x0: +e.attrs.x, x1: +e.attrs.x + +e.attrs.width, y0: +e.attrs.y, y1: +e.attrs.y + +e.attrs.height }); e.children.forEach(walk); };
    walk(svg);
    assert.equal(plates.length, 4);
    // Every plate is below its point (y 100 or 104 on this stand-in), where no intent bubble stands.
    assert.ok(plates.every(p => p.y0 >= 100), JSON.stringify(plates));
    // No two of them touch.
    for (let i = 0; i < plates.length; i++) for (let j = i + 1; j < plates.length; j++) {
        const a = plates[i], b = plates[j];
        assert.ok(a.x1 <= b.x0 || b.x1 <= a.x0 || a.y1 <= b.y0 || b.y1 <= a.y0, 'plates ' + i + ' and ' + j + ' overlap: ' + JSON.stringify([a, b]));
    }
    // The two steps at one building share one tick; the building beside it has its own.
    assert.equal(count(svg, 'eval-tick'), 2);
    assert.deepEqual(texts(svg).slice(0, 2), ['mark.step Train villagers without a pause', 'mark.step Research house']);
});
