// The published contract, checked against the records the game actually wrote.
//
// `game-state-schema.json` is what a third party integrating with this harness reads, and it is
// hand-maintained: nothing generates it and nothing enforced that it matched the payload until now.
// That is not hypothetical — the audit that produced it found `ordersInProgress` being emitted on
// every turn of the last two matches and declared nowhere, which is how the last several sessions
// found the "0 emitted-but-undeclared" claim to be true of the sample they checked and false of the
// newest one. A contract that is only verified against one old file is not verified.
//
// Checked against the NEWEST shipped sample, deliberately. The older ones are history: they were
// written by earlier builds, and `2026-08-26` legitimately lacks `population` and `nodes` and
// carries `discoveredNodesOnMap`, which was renamed away. Pinning those to today's schema would
// mean either a lie or a fixture that never changes; what has to hold is that the schema describes
// what the shipped game emits NOW.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'game-state-schema.json'), 'utf8'));

const sampleFiles = fs.readdirSync(path.join(ROOT, 'samples')).filter(f => f.endsWith('.jsonl')).sort();
const newest = sampleFiles[sampleFiles.length - 1];

function statesIn(absPath) {
  const out = [];
  for (const line of fs.readFileSync(absPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch (e) { continue; }   // the final line can be a truncation
    if (rec && typeof rec === 'object' && rec.state && typeof rec.state === 'object') out.push(rec.state);
  }
  return out;
}

const states = statesIn(path.join(ROOT, 'samples', newest));

test('there is a newest sample and it carries real states', () => {
  // Guards the rest of the file: a missing or unreadable samples directory would let every
  // assertion below pass on an empty set.
  assert.ok(sampleFiles.length >= 4, 'expected the shipped samples, found ' + sampleFiles.length);
  assert.ok(states.length >= 50, 'expected a real match in ' + newest + ', found ' + states.length + ' states');
});

test('every $ref in the schema resolves', () => {
  // Resolved as real JSON pointers, not as "#/$defs/name" only. The file uses both styles: the
  // shared vocabulary lives in $defs, while a sub-schema reused between two fields points at the
  // other field directly (threats.enemyWonders.items -> properties.enemyBuildings.items), and
  // battles declares a local `definitions.side` that draft-04 pointer syntax reaches. A resolver
  // that understands only $defs reports three valid refs as dangling — which an earlier revision
  // of this test did, loudly, and was wrong.
  const resolve = (ptr) => {
    if (!ptr.startsWith('#/')) return null;
    let node = schema;
    for (let seg of ptr.slice(2).split('/')) {
      seg = decodeURIComponent(seg.replace(/~1/g, '/').replace(/~0/g, '~'));
      if (node == null) return null;
      node = Array.isArray(node) ? node[Number(seg)] : node[seg];
    }
    return node === undefined ? null : node;
  };
  const dangling = [];
  (function walk(node, at) {
    if (Array.isArray(node)) return node.forEach((n, i) => walk(n, at + '/' + i));
    if (!node || typeof node !== 'object') return;
    if (typeof node.$ref === 'string' && resolve(node.$ref) === null) dangling.push(at + ' -> ' + node.$ref);
    for (const [k, v] of Object.entries(node)) if (k !== '$ref') walk(v, at + '/' + k);
  })(schema, '#');
  assert.deepEqual(dangling, [], 'schema references that lead nowhere: ' + dangling.join(', '));
});

test('the newest match emits every field the schema calls required', () => {
  const required = schema.required || [];
  const missing = new Map();
  for (const st of states) {
    for (const key of required) {
      if (!(key in st)) missing.set(key, (missing.get(key) || 0) + 1);
    }
  }
  assert.equal(missing.size, 0, 'required fields absent from ' + newest + ': '
    + [...missing].map(([k, n]) => `${k} (${n} of ${states.length} turns)`).join(', '));
});

test('the newest match emits nothing the schema does not declare', () => {
  const declared = new Set(Object.keys(schema.properties || {}));
  const extra = new Map();
  for (const st of states)
    for (const key of Object.keys(st))
      if (!declared.has(key)) extra.set(key, (extra.get(key) || 0) + 1);
  assert.equal(extra.size, 0,
    'the payload carries fields no reader was told about: '
    + [...extra].map(([k, n]) => `${k} (${n} of ${states.length} turns)`).join(', ')
    + ' — declare them in game-state-schema.json or stop emitting them');
});

test('the nested shapes the schema promises hold in real records', () => {
  // There is no JSON Schema validator in a dependency-free repo, so the handful of nested
  // promises that matter most are checked by hand — these are the ones a model has to index into,
  // and a missing key here is a model reading `undefined` where the docs promise a number.
  const bad = [];
  for (const [i, st] of states.entries()) {
    for (const o of st.ordersInProgress || []) {
      if (typeof o.order !== 'string') bad.push(`turn ${i}: ordersInProgress[].order is ${typeof o.order}`);
      if (!Array.isArray(o.to) || o.to.length !== 2 || !o.to.every(Number.isFinite))
        bad.push(`turn ${i}: ordersInProgress[].to is ${JSON.stringify(o.to)}`);
      if (o.secondsRemaining !== undefined && typeof o.secondsRemaining !== 'number')
        bad.push(`turn ${i}: secondsRemaining is ${typeof o.secondsRemaining}`);
      if (o.unitIds !== undefined && !o.unitIds.every(Number.isInteger))
        bad.push(`turn ${i}: unitIds has non-integers`);
      if (o.units === undefined && o.unitIds === undefined)
        bad.push(`turn ${i}: an order with neither a unit count nor unit ids: ${JSON.stringify(o)}`);
    }
    // The key lists are READ FROM THE SCHEMA, not restated here. Restating them means the test
    // checks the records against the test's own opinion, so tightening the schema would not be
    // verified against real data and loosening it would not be noticed; read from the schema, a
    // promise added to the file has to hold in the records the game actually wrote.
    const battleKeys = (((schema.properties.battles || {}).items || {}).required) || [];
    for (const b of st.battles || [])
      for (const k of battleKeys)
        if (!(k in b)) bad.push(`turn ${i}: battles[] missing "${k}"`);
    const costKeys = (((schema.$defs.cost || {}).required) || Object.keys((((schema.$defs.cost || {}).properties) || {})));
    const costTypes = ((schema.$defs.cost || {}).properties) || {};
    const checkCost = (c, where) => {
      if (!c || typeof c !== 'object') return bad.push(`${where}: cost missing`);
      for (const k of costKeys) {
        const t = (costTypes[k] || {}).type || 'number';
        // 18,461 cost-shaped objects in this one record and not one non-integer among them, so
        // the schema's `integer` is asserted as an integer rather than diluted to "a number".
        if (t === 'integer' && !Number.isInteger(c[k])) bad.push(`${where}: cost.${k} is ${JSON.stringify(c[k])}, schema says integer`);
        else if (t === 'number' && typeof c[k] !== 'number') bad.push(`${where}: cost.${k} is ${typeof c[k]}`);
        else if (t !== 'integer' && t !== 'number' && c[k] === undefined) bad.push(`${where}: cost.${k} missing`);
      }
    };
    for (const [host, byAge] of Object.entries((st.units && st.units.trainable) || {}))
      for (const [age, list] of Object.entries(byAge)) (list || []).forEach(u => checkCost(u.cost, `units.trainable.${host}.${age}.${u.id}`));
    for (const [j, bl] of ((st.buildings || {}).buildable || []).entries())
      checkCost(bl.cost, `buildings.buildable[${j}].${bl.type || bl.id || '?'}`);
  }
  assert.deepEqual(bad.slice(0, 12), [], `${bad.length} shape violations in ${newest}, first few:\n  ` + bad.slice(0, 12).join('\n  '));
});
