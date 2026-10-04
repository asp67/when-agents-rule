// A seeded match has to replay, and that promise lives in 62 call sites.
//
// What is pinned here, in descending strength:
//
//   1. the seeded generator itself — same seed, same stream, and no seed means no stream
//   2. the delegation Game.rand / Game.randJitter perform onto it
//   3. that the simulation files contain no unseeded Math.random draw except the two places
//      that mint session-unique identifiers, which must NOT be reproducible
//
// Number 3 is an allowlist over source text, which this suite otherwise avoids on purpose
// (asserting how code is spelled tests the diff, not the behaviour). It earns its place because
// the property it protects is invisible otherwise: one new `Math.random()` in a hot path does not
// change distributions, does not fail a gameplay test, and quietly makes every "same seed, same
// match" claim in docs/QUALITY_REVIEW.md false. A draw that must be seeded has to be routed
// through game.rand(); a draw that must NOT be seeded (an id) is added here with its reason.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const scope = {
  console: { log() {}, warn() {}, error() {} },
  Math, JSON, Date, Object, Array, String, Number, Boolean, Set, Map, RegExp, Error, Promise,
  isNaN, parseInt, parseFloat, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {},
  performance: { now: () => 0 }, localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  document: undefined,
};
vm.createContext(scope);
// One list, from js/manifest.js — upstream's fix for every harness keeping its own copy, and
// the reason this file died on `WarRng is not defined`: the hand-rolled list predated
// js/simulation/rng.js, where the keyed draws now live. game.js has no page tail any more
// (start-up moved to js/boot.js), so the whole file loads here and nothing is cut with a split.
vm.runInContext('globalThis.window = globalThis', scope);   // texgen's module pattern
for (const f of ['js/manifest.js'].concat(require('../js/manifest.js').vm))
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), scope, { filename: f });

const TerrainManager = vm.runInContext('TerrainManager', scope);
const Game = vm.runInContext('Game', scope);

// The real generator, without building a map: _initRand is the whole seeding step.
const streamFor = (seed) => {
  const t = Object.create(TerrainManager.prototype);
  t.seed = seed;
  t._initRand();
  return t;
};

test('one seed is one stream, and a different seed is a different stream', () => {
  const draw = (t) => Array.from({ length: 40 }, () => t.rand());
  const a = draw(streamFor('DETERM-42')), b = draw(streamFor('DETERM-42')), c = draw(streamFor('DETERM-43'));
  assert.deepEqual(a, b, 'the same seed produced two different streams — nothing downstream can be reproducible');
  assert.notDeepEqual(a, c, 'two different seeds produced the same stream, so the seed is not reaching the generator');
  for (const v of a) assert.ok(v >= 0 && v < 1, 'rand() must stay in [0,1): got ' + v);
});

test('an unseeded terrain is Math.random, so the default game is untouched by all this', () => {
  const t = streamFor('');
  assert.equal(t.rand, Math.random, 'no seed must fall through to Math.random (terrain.js:89) — this is why '
    + 'routing the sim through game.rand() cannot change an unseeded match');
  assert.equal(streamFor(null).rand, Math.random);
});

test('Game.rand is a keyed draw: one seed, and a value that depends on what was drawn for', () => {
  // The shape this test pinned is gone, deliberately. Our side had ONE stream: Game.rand() read
  // terrain.rand directly and randJitter(k) was (rand()-0.5)*k. Upstream kept the promise and
  // strengthened it — a draw depends on the match seed, the key (seat + purpose) and how many
  // times THAT key has drawn, never on the global draw order (js/simulation/rng.js), and the
  // ~50 park-and-spread call sites pass a purpose where they asked for jitter. Both halves were
  // reaching for "a seed is a match"; this is the stronger version, so what is asserted here is
  // what the new shape actually owes. The last block is the one a single stream could not pass.
  const seeded = (seed) => { const g = Object.create(Game.prototype); g.mapSeed = seed; return g; };
  const draws = (g, purpose, n) => Array.from({ length: n }, () => g.rand(null, purpose));

  const a = seeded('DETERM-42'), b = seeded('DETERM-42'), c = seeded('DETERM-43');
  const aa = draws(a, 'spread', 40);
  assert.deepEqual(aa, draws(b, 'spread', 40), 'one seed and one key gave two different sequences');
  assert.notDeepEqual(aa, draws(c, 'spread', 40), 'two seeds gave the same sequence, so the seed never reaches the key');
  for (const v of aa) assert.ok(v >= 0 && v < 1, 'a keyed draw left [0,1): ' + v);

  // A game with no map yet (the headless harnesses, and any call before the world exists) must
  // answer rather than throw, exactly as the old delegation did with no terrain.
  const bare = Object.create(Game.prototype);
  assert.equal(typeof bare.rand(null, 'spread'), 'number', 'rand has to work before a map seed exists');

  // Drawing on another key between two of mine must not move mine: that is what lets two
  // machines replay one transcript seat by seat instead of in step with each other's noise.
  const x = seeded('DETERM-7'), y = seeded('DETERM-7');
  const mine = [];
  for (let i = 0; i < 5; i++) { mine.push(x.rand(null, 'spread')); x.rand(null, 'something-else'); }
  assert.deepEqual(mine, draws(y, 'spread', 5), 'a draw on another key moved this key, so replay is not position-independent');
});

test('the simulation draws its randomness through the game, apart from id minting', () => {
  const ALLOWED = {
    // Session-unique identifiers: reproducibility here would be a bug, not a feature — two
    // matches in one page would mint the same seat/unit ids. Deliberately outside the stream.
    'js/game.js': [
      "return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);",   // camera subject key
    ],
    'js/ai.js': [
      "id: 'ai_' + Math.random().toString(36).substr(2, 9),",                             // seat id
    ],
    'js/openai-ai.js': [],
  };
  const offenders = [];
  for (const f of Object.keys(ALLOWED)) {
    const lines = fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n');
    lines.forEach((line, idx) => {
      if (!line.includes('Math.random')) return;
      const t = line.trim();
      if (t.startsWith('//') || t.startsWith('*')) return;           // prose may name it
      // `// rng-exempt: <reason>` is the marker both halves of this fork invented, and
      // upstream's code already carries it on the one draw with no game to ask (a fixture
      // seat's id). Honouring it keeps the marker meaningful and the allowlist a last resort.
      if (line.includes('rng-exempt:')) return;
      if (ALLOWED[f].some(a => line.includes(a))) return;
      // The delegation itself is allowed to mention Math.random as the fallback.
      if (f === 'js/game.js' && t.startsWith('return ((')) return;
      offenders.push(`${f}:${idx + 1}: ${t.slice(0, 88)}`);
    });
  }
  assert.deepEqual(offenders, [],
    'unseeded randomness in a simulation file means a seeded match stops replaying. Route it '
    + 'through the keyed draw (WarRng / game.rand(who, purpose)), mark the line '
    + '// rng-exempt: <reason>, or add it to the allowlist below with a reason:\n  '
    + offenders.join('\n  '));
});
