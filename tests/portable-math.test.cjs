// Portable math (js/simulation/math.js, review #6 step 6). Rule code computes
// distances and angles through WarMath, built from the operations IEEE 754 fixes to the
// last bit, so every engine agrees. It follows fdlibm (sin, cos, atan2) and V8's hypot.
// On x64 Node it equals Math exactly; Chrome 152 and ARM64 Node each differ from that
// in the last bit for some inputs, which is exactly why rule code cannot use Math.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const W = require('../js/simulation/math.js');

test('rule code uses no engine-dependent Math function outside its named exemptions', () => {
    const ctx = vm.createContext({});
    for (const f of ['js/manifest.js', 'js/sha256.js', 'js/conditions.js']) vm.runInContext(read(f), ctx);
    const files = vm.runInContext('WarConditions.CORE_FILES.concat(WarConditions.HARNESS_FILE)', ctx);
    const banned = /(^|[^\w.])Math\.(hypot|sin|cos|tan|atan2|atan|asin|acos|sinh|cosh|tanh|asinh|acosh|atanh|exp|expm1|log|log1p|log2|log10|pow|cbrt)\(|[\w)\]]\s*\*\*\s*[\w(]/;
    const found = [];
    for (const f of files) read(f).split(/\r?\n/).forEach((line, i) => {
        const t = line.trim();
        if (t.startsWith('//') || t.startsWith('*')) return;
        const code = line.replace(/\/\/.*$/, '');
        if (banned.test(code) && !/math-exempt:/.test(line)) found.push(`${f}:${i + 1}: ${t}`);
    });
    assert.deepEqual(found, [], 'use WarMath.hypot/sin/cos/atan2, or mark the line "// math-exempt: <why>"');
});

// The property that matters: the same inputs give the same bits on every machine. A
// fingerprint of 480,000 outputs, pinned. It was recorded on x64 and matched on the
// DGX's ARM64 -- where Node's own Math did NOT match x64's (same Node 24.14.1: 659 sin,
// 381 cos and 112 atan2 inputs out of 120,000 differed in the last bit). How far the
// local Math agrees is reported, not asserted: that is a property of this engine build.
test('WarMath gives the same bits on every machine', t => {
    const crypto = require('node:crypto');
    let s = 7;
    const rnd = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
    const h = crypto.createHash('sha256'), f = new Float64Array(4), off = { sin: 0, cos: 0, atan2: 0, hypot: 0 };
    for (const k of [1e-9, 1, 4, 800, 1e4, 1.5e6]) for (let i = 0; i < 20000; i++) {
        const a = (rnd() - 0.5) * k, b = (rnd() - 0.5) * k;
        f[0] = W.sin(a); f[1] = W.cos(a); f[2] = W.atan2(a, b); f[3] = W.hypot(a, b);
        h.update(Buffer.from(f.buffer));
        if (!Object.is(f[0], Math.sin(a))) off.sin++;
        if (!Object.is(f[1], Math.cos(a))) off.cos++;
        if (!Object.is(f[2], Math.atan2(a, b))) off.atan2++;
        if (!Object.is(f[3], Math.hypot(a, b))) off.hypot++;
    }
    t.diagnostic(`${process.arch}: local Math differs from WarMath on ${JSON.stringify(off)} of 120000 each`);
    assert.equal(h.digest('hex').slice(0, 16), '1f1f84b0005facd6');
    // Special values follow the language's rules on every engine.
    const special = [0, -0, 1, -1, 0.5, Math.PI, -Math.PI / 2, Math.PI / 4, 3 * Math.PI / 2, 1e-300, 5e-324, 1e300, Infinity, -Infinity, NaN];
    for (const a of special) {
        for (const [w, m] of [[W.sin(a), Math.sin(a)], [W.cos(a), Math.cos(a)]]) {
            if (!Number.isFinite(a) || a === 0) assert.ok(Object.is(w, m), 'sin/cos special ' + a);
            else assert.ok(Number.isFinite(w) && Math.abs(w) <= 1, 'sin/cos stays in range at ' + a);
        }
        for (const b of special) {
            assert.ok(Object.is(W.hypot(a, b), Math.hypot(a, b)), `hypot ${a} ${b}`);
            if (a !== a || b !== b || a === 0 || b === 0 || !Number.isFinite(a) || !Number.isFinite(b))
                assert.ok(Object.is(W.atan2(a, b), Math.atan2(a, b)), `atan2 special ${a} ${b}`);
        }
    }
    for (let n = 0; n < 6; n++) assert.equal(W.powInt(1.5, n), Math.pow(1.5, n));
});

// Pinned values. On any engine the module must give exactly these: if one ever did
// not, it would be the module that is not portable, not the engine. (Chrome 152 gives
// the same for these through WarMath.)
test('pinned values', () => {
    assert.equal(W.sin(10000), -0.30561438888825215);
    assert.equal(W.cos(123.456), -0.5947139710921574);
    assert.equal(W.atan2(3, -4), 2.498091544796509);
    assert.equal(W.hypot(0.003, 0.004), 0.005);
    assert.equal(W.cos(2 * Math.PI), 1);
});
