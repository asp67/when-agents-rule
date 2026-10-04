// The outcome taxonomy (tools/bench/taxonomy.cjs), checked against the harness both
// ways: every code the harness can emit has a class, every class names only codes that
// still exist, and the rejections that carry no code at all are counted -- a ratchet
// that may fall and must not rise.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { CLASSES, CLASS_OF, classify } = require('../tools/bench/taxonomy.cjs');

const SRC = fs.readFileSync(path.join(__dirname, '../js/openai-ai.js'), 'utf8');
// Codes not in the log.out.* namespace: the parser's and the executor's own.
// commandLimit: a command past the per-turn cap (b1044; it was emitted and unclassified).
const OWN = ['unparsedCall', 'notACommand', 'executionFailed', 'commandLimit'];

test('every code the harness emits is classified, and every classified code still exists', () => {
    const emitted = new Set([...SRC.matchAll(/log\.out\.([a-zA-Z]+)/g)].map(m => m[1]).concat(OWN));
    const mapped = new Set(Object.keys(CLASS_OF));
    const unmapped = [...emitted].filter(c => !mapped.has(c));
    const stale = [...mapped].filter(c => !emitted.has(c));
    assert.deepEqual(unmapped, [], 'codes with no class');
    assert.deepEqual(stale, [], 'classified codes the harness no longer has');
    for (const c of OWN) assert.ok(SRC.includes(`'${c}'`), c + ' is still a literal in the harness');
});

test('no code is in two classes, and "contended" is exactly the arena\'s UNFOREWARNED', () => {
    const all = Object.values(CLASSES).flat();
    assert.equal(new Set(all).size, all.length);
    const scope = vm.createContext({ console });
    vm.runInContext(SRC + ';globalThis.M = OpenAIAIManager;', scope);
    assert.deepEqual([...scope.M.UNFOREWARNED].sort(), [...CLASSES.contended].sort());
});

test('classify: a code decides; an OK without one is done; a rejection without one is uncoded', () => {
    assert.equal(classify({ code: 'cannotAfford', verdict: 'avoidable' }), 'constraint');
    assert.equal(classify({ code: 'unknownTech', verdict: 'avoidable' }), 'reference');
    assert.equal(classify({ code: null, verdict: 'ok' }), 'done');
    assert.equal(classify({ code: null, verdict: 'avoidable' }), 'uncoded');
    assert.equal(classify({ code: 'somethingNew', verdict: 'avoidable' }), 'unknown:somethingNew');
});

// A static count of "[ERROR]" returns with no outcome code set in the six lines above.
// It overcounts (a code set further up the same handler counts as missing), which fails
// safe. When one gains a code, lower the ceiling; it must never rise.
const UNCODED_CEILING = 4;
test(`uncoded [ERROR] returns in the harness: at most ${UNCODED_CEILING}`, () => {
    const lines = SRC.split(/\r?\n/);
    const uncoded = [];
    lines.forEach((l, i) => {
        if (!/return\s+[`'"]\[ERROR\]/.test(l)) return;
        if (!/outcome\(/.test(lines.slice(Math.max(0, i - 6), i + 1).join('\n'))) uncoded.push(i + 1);
    });
    assert.ok(uncoded.length <= UNCODED_CEILING, `${uncoded.length} uncoded [ERROR] returns (lines ${uncoded.join(', ')})`);
});
