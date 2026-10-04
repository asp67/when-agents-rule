'use strict';
// The match chronicle (review #11): what happened, told from the game's own records --
// contact, the fight and how it ended, a building lost and to whom, an elimination, an
// age, a Wonder's countdown -- without changing the match it reads.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createMatch } = require('../tools/bench/realm.cjs');

const ROOT = path.resolve(__dirname, '..');

async function board({ farGuard = false } = {}) {
    const m = await createMatch({ kind: 'board', seed: 'chronicle', seats: [
        { civ: 'greek', age: 'bronze', buildings: [['town_center', -250, 0]],
          units: Array.from({ length: 10 }, (_, i) => ['warrior', -30 + (i % 5) * 3, (Math.floor(i / 5) - 0.5) * 4]) },
        // farGuard: a warrior far off keeps Persia in the match while its house falls (since
        // b1053 an eliminated seat's buildings leave with it, so the house must fall first).
        { civ: 'persian', age: 'bronze', buildings: [['house', 30, 0]],
          units: [['warrior', 26, 4], ['warrior', 26, -4]].concat(farGuard ? [['warrior', 250, -250, { tag: 'far' }]] : []) },
        { civ: 'egyptian', age: 'bronze', buildings: [['town_center', 250, 250]], units: [['worker', 245, 250]] },
    ] });
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/chronicle.js'), 'utf8'), m.context, { filename: 'js/chronicle.js' });
    const chr = vm.runInContext('new MatchChronicle(game)', m.context);
    const told = [];
    chr.subscribe(e => told.push(e));
    const run = ms => { for (let t = 0; t < ms; t += 250) { m.advance(250); chr.update(); } };
    return { m, chr, told, run };
}

test('a fight is told from contact to its end, with the building lost, who took it, and the elimination', async () => {
    const { m, chr, told, run } = await board({ farGuard: true });
    const [a, b] = m.seats;
    run(250);   // the starting position is the baseline, not news
    assert.deepEqual(told, []);
    const before = m.snapshot ? JSON.stringify(m.snapshot()) : null;
    m.command(m.controllers[0], 'attack_target', { targetX: 30, targetZ: 0 });
    run(90000);
    // Then its last soldier falls, far away: the elimination.
    m.tags.far.health = 0; m.game.destroyTarget(m.tags.far);
    run(2000);
    const kinds = told.map(e => e.kind);
    assert.ok(kinds.includes('contact'), kinds.join());
    const contact = told.find(e => e.kind === 'contact');
    assert.deepEqual([...contact.seats].sort(), [a.id, b.id].sort());
    assert.ok(kinds.includes('clash'));
    const lost = told.find(e => e.kind === 'building-lost');
    assert.ok(lost, kinds.join());
    assert.equal(lost.building, 'house');
    assert.deepEqual(Array.from(lost.seats), [b.id, a.id]);
    assert.equal(lost.by, a.id, 'the destroy path recorded who did it');
    const elim = told.find(e => e.kind === 'elimination');
    assert.ok(elim && elim.seats[0] === b.id && elim.weight === 3);
    // The battle, once it went quiet: each side's count as the ledger kept it.
    const battle = told.find(e => e.kind === 'battle');
    assert.ok(battle, kinds.join());
    assert.equal(battle.sides[b.id].lost >= 2, true, JSON.stringify(battle.sides));
    assert.ok(battle.sides[a.id].involved >= 2);
    // In order of the match clock, each told once.
    assert.deepEqual(told.map(e => e.t), [...told.map(e => e.t)].sort((x, y) => x - y));
    assert.equal(told.filter(e => e.kind === 'elimination').length, 1);
    assert.equal(told.filter(e => e.kind === 'contact').length, 1, 'once per pair, whoever saw whom first');
    assert.ok(before !== undefined);
    assert.equal(chr.entries.length, told.length);
});

test('an age and a Wonder\'s countdown are told; the chronicle changes nothing in the match', async () => {
    const { m, told, run } = await board();
    const g = m.game, [a] = m.seats;
    run(250);
    const hashBefore = g.stateHash();
    // Reading alone, over some steps: the state is the same as with no chronicle at all.
    const twin = await createMatch({ kind: 'board', seed: 'chronicle', seats: [
        { civ: 'greek', age: 'bronze', buildings: [['town_center', -250, 0]],
          units: Array.from({ length: 10 }, (_, i) => ['warrior', -30 + (i % 5) * 3, (Math.floor(i / 5) - 0.5) * 4]) },
        { civ: 'persian', age: 'bronze', buildings: [['house', 30, 0]], units: [['warrior', 26, 4], ['warrior', 26, -4]] },
        { civ: 'egyptian', age: 'bronze', buildings: [['town_center', 250, 250]], units: [['worker', 245, 250]] },
    ] });
    twin.advance(250);
    assert.equal(twin.game.stateHash(), hashBefore);
    run(5000); twin.advance(5000);
    assert.equal(g.stateHash(), twin.game.stateHash(), 'the chronicle only reads');

    a.age = 'iron';
    g.wonderRequired = 150;
    m.addBuilding(a, 'akropolis', -200, 60);   // the Greek Wonder
    run(100000);
    const kinds = told.map(e => e.kind);
    const age = told.find(e => e.kind === 'age');
    assert.ok(age && age.age === 'iron' && age.seats[0] === a.id);
    const raised = told.find(e => e.kind === 'wonder-raised');
    assert.ok(raised && raised.building === 'akropolis' && raised.required === 150, kinds.join());
    const countdown = told.filter(e => e.kind === 'wonder-countdown').map(e => e.seconds);
    assert.deepEqual(countdown, [120, 60], 'told as it crosses each mark, once');
});

test('speed and pause are told; a transcript receives every entry as a chronicle line', async () => {
    const { m, told, run } = await board();
    const g = m.game, lines = [];
    g.openAIAIManager.transcripts = { matchId: 'x', noteMatch: e => lines.push(e) };
    run(250);
    g.setSimSpeed(2);
    run(250);
    g.pauseState = 'paused';
    run(250);
    g.pauseState = 'running';
    run(250);
    assert.deepEqual(told.map(e => e.kind), ['speed', 'pause', 'resume']);
    assert.equal(told[0].speed, 2);
    assert.equal(lines.filter(e => e.type === 'chronicle').length, 3, 'beside the match_event the speed change writes itself');
});

test('the step that ends the match is told too: the elimination that ended it', async () => {
    const m = await createMatch({ kind: 'board', seed: 'chronicle-end', seats: [
        { civ: 'greek', age: 'bronze', buildings: [['town_center', -250, 0]],
          units: Array.from({ length: 10 }, (_, i) => ['warrior', -30 + (i % 5) * 3, (Math.floor(i / 5) - 0.5) * 4]) },
        { civ: 'persian', age: 'bronze', buildings: [['house', 30, 0]], units: [['warrior', 26, 4]] },
    ] });
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/chronicle.js'), 'utf8'), m.context, { filename: 'js/chronicle.js' });
    const chr = vm.runInContext('new MatchChronicle(game)', m.context);
    m.advance(250); chr.update();
    m.command(m.controllers[0], 'attack_target', { targetX: 30, targetZ: 0 });
    for (let t = 0; t < 90000 && m.game.gameStarted; t += 250) { m.advance(250); chr.update(); }
    assert.equal(m.game.gameStarted, false, 'the match ended');
    chr.update(); chr.update();
    const kinds = chr.entries.map(e => e.kind);
    // Eliminated with its last unit, house still standing: the step that ended the match,
    // told only by the pass after the end.
    assert.ok(kinds.includes('elimination'), kinds.join());
    assert.equal(kinds.filter(k => k === 'elimination').length, 1);
});

test('captions for a recording: WebVTT on the wall clock, shifted by the offset, plain text only', async () => {
    const { m } = await board();
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/ui.js'), 'utf8') + '\n;globalThis.__UI = UIManager;', m.context);
    const ui = Object.create(m.context.__UI.prototype);
    ui.game = m.game;
    // Markup in, text out, as a browser's textContent does.
    m.context.document.createElement = () => { let text = ''; return { set innerHTML(h) { text = String(h).replace(/<[^>]*>/g, ''); }, get textContent() { return text; } }; };
    const [a, b] = m.seats;
    const entries = [
        { kind: 'contact', seats: [a.id, b.id], weight: 2, at: 61000, t: 61 },
        { kind: 'clash', seats: [a.id, b.id], weight: 1, at: 62000, t: 62 },       // detail: no caption
        { kind: 'elimination', seats: [b.id], weight: 3, at: 64000, t: 64 },
    ];
    const vtt = ui.chronicleVtt(entries, 1000, 7.5);
    const lines = vtt.split('\n');
    assert.equal(lines[0], 'WEBVTT');
    // 60 s after the start, plus 7.5 s of video before it; the first cue ends where the next begins.
    assert.equal(lines[2], '00:01:07.500 --> 00:01:10.500');
    assert.equal(lines[5], '00:01:10.500 --> 00:01:15.500');
    assert.equal(vtt.split('-->').length - 1, 2, 'the clash is a detail, not a caption');
    assert.ok(!/[<>]/.test(vtt.replace(/-->/g, '')), 'no markup reaches a player');
    assert.equal(ui.chronicleVtt([], 0), 'WEBVTT\n\n');
});

// asp67, 3 Oct 2026: the fight's card said a side "lost 3 of 0". The count was of what
// STRUCK in the fight; a side cut down without a blow back (buildings, unarmed units)
// was in no count. It now counts what was struck as well, so nothing is lost "of 0".
test('a side that loses what never struck back is counted with it, never "of 0"', async () => {
    const m = await createMatch({ kind: 'board', seed: 'chronicle-raid', seats: [
        { civ: 'greek', age: 'bronze', buildings: [['town_center', -250, 0]],
          units: Array.from({ length: 6 }, (_, i) => ['warrior', -20 + (i % 3) * 3, (Math.floor(i / 3) - 0.5) * 4]) },
        { civ: 'persian', age: 'bronze', buildings: [['town_center', 250, 0], ['house', 20, 0], ['house', 26, 6]] },
    ] });
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/chronicle.js'), 'utf8'), m.context, { filename: 'js/chronicle.js' });
    const chr = vm.runInContext('new MatchChronicle(game)', m.context), told = [];
    chr.subscribe(e => told.push(e));
    const run = ms => { for (let t = 0; t < ms; t += 250) { m.advance(250); chr.update(); } };
    const [, b] = m.seats;
    run(250);
    m.command(m.controllers[0], 'attack_target', { targetX: 22, targetZ: 3 });
    run(120000);
    const battle = told.find(e => e.kind === 'battle' && e.sides[b.id] && e.sides[b.id].lost > 0);
    assert.ok(battle, told.map(e => e.kind).join());
    const side = battle.sides[b.id];
    assert.ok(side.involved >= side.lost, 'lost ' + side.lost + ' of ' + side.involved);
});
