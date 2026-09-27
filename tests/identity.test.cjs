'use strict';
// Seat-true colours (review #12): a seat wears its civilization's colour unless another
// seat shares the civilization; then its seat badge's (seat 0: charcoal).
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

function load(players) {
    const scope = { console, game: { aiManager: { aiPlayers: players } } };
    vm.createContext(scope);
    for (const f of ['js/simulation/rng.js', 'js/simulation/math.js', 'js/civilizations.js', 'js/identity.js'])
        vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), scope);
    vm.runInContext('globalThis.__W = WarIdentity; globalThis.__civ = getCivilization; globalThis.__badge = getTeamBadge;', scope);
    return { W: scope.__W, civ: scope.__civ, badge: scope.__badge, scope };
}
const hex = n => '#' + n.toString(16).padStart(6, '0');

test('distinct civilizations keep their own colours', () => {
    const { W, civ } = load([{ id: 'a', seat: 0, civilization: 'greek' }, { id: 'b', seat: 1, civilization: 'persian' }]);
    assert.equal(W.color('a'), civ('greek').color);
    assert.equal(W.color('b'), civ('persian').color);
});

test('a shared civilization: every seat wears its badge, seat 0 in charcoal', () => {
    const { W, badge } = load([{ id: 'a', seat: 0, civilization: 'greek' }, { id: 'b', seat: 1, civilization: 'greek' },
        { id: 'c', seat: 2, civilization: 'greek' }, { id: 'd', seat: 3, civilization: 'persian' }]);
    assert.equal(W.color('a'), W.CHARCOAL);
    assert.equal(W.hex('b'), badge(1).fill.toLowerCase());
    assert.equal(W.hex('c'), badge(2).fill.toLowerCase());
    assert.notEqual(W.color('b'), W.color('c'), 'three Greeks, three colours');
    // The one Persian too: Persian tomato sat right beside seat 2's red.
    assert.equal(W.hex('d'), badge(3).fill.toLowerCase());
    assert.equal(new Set(['a', 'b', 'c', 'd'].map(id => W.color(id))).size, 4, 'four seats, four colours');
});

test('the analyzer names the seats of a recording; null goes back to the live match', () => {
    const { W, civ } = load([{ id: 'live', seat: 0, civilization: 'yamato' }]);
    W.use([{ id: 'r1', seat: 0, civ: 'egyptian' }, { id: 'r2', seat: 1, civ: 'egyptian' }]);
    assert.equal(W.color('r1'), W.CHARCOAL);
    assert.equal(W.color('live', 'yamato', 0), W.CHARCOAL, 'the recording shares a civilization: every seat is a badge');
    W.use(null);
    assert.equal(W.color('live'), civ('yamato').color);
});

test('every place a seat is coloured asks the same function', () => {
    const ui = fs.readFileSync(path.join(root, 'js/ui.js'), 'utf8');
    const renderer = fs.readFileSync(path.join(root, 'js/engine/gamerenderer.js'), 'utf8');
    const game = fs.readFileSync(path.join(root, 'js/game.js'), 'utf8');
    assert.ok((renderer.match(/WarIdentity\.color\(/g) || []).length >= 2, 'units and buildings');
    assert.match(game, /WarIdentity\.hex\(ai\.id/, 'the minimap');
    for (const where of ['const colorHex = this.identityHex(ai.id', 'this.legibleColor(this.identityHex(lead.id', 'this.identityHex(ent.owner'])
        assert.ok(ui.includes(where), where);
});
