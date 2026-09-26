// Portable math (js/simulation/math.js, review #6 step 6). Rule code computes
// distances and angles through WarMath, built from the operations IEEE 754 fixes to the
// last bit, so every engine agrees. It follows the algorithms Node's V8 uses (fdlibm for
// sin, cos and atan2; V8's own hypot), so on Node -- which runs these tests -- it must
// equal Math exactly, and a headless match is unchanged by it. Browsers now compute
// Node's bits too; Chrome 152's own sin, cos and atan2 already differed from Node's in
// the last bit for a few percent of inputs.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const W = require('../js/simulation/math.js');

test('rule code uses no engine-dependent Math function outside its named exemptions', () => {
    const ctx = vm.createContext({});
    for (const f of ['js/sha256.js', 'js/conditions.js']) vm.runInContext(read(f), ctx);
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

test('on Node every WarMath function equals Math to the last bit', () => {
    let s = 7;
    const rnd = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
    const scales = [1e-9, 1, 4, 800, 1e4, 1.5e6];
    for (const k of scales) for (let i = 0; i < 20000; i++) {
        const a = (rnd() - 0.5) * k, b = (rnd() - 0.5) * k;
        for (const [name, w, m] of [['sin', W.sin(a), Math.sin(a)], ['cos', W.cos(a), Math.cos(a)],
                                    ['atan2', W.atan2(a, b), Math.atan2(a, b)], ['hypot', W.hypot(a, b), Math.hypot(a, b)]]) {
            if (!Object.is(w, m)) assert.fail(`${name}(${a}${name === 'sin' || name === 'cos' ? '' : ', ' + b}) = ${w}, Math gives ${m}`);
        }
    }
    const special = [0, -0, 1, -1, 0.5, Math.PI, -Math.PI / 2, Math.PI / 4, 3 * Math.PI / 2, 1e-300, 5e-324, 1e300, Infinity, -Infinity, NaN];
    // sin and cos match V8 up to fdlibm's medium range, |x| < 2^20 * pi/2 (about 1.6
    // million radians). Past it V8 switches to an exact multi-precision reduction with a
    // 66-word table of 2/pi, which this module does not carry: it reduces with % instead,
    // deterministic but not V8's bits. No rule angle comes near; this pins the boundary.
    const MEDIUM = 1647099;
    for (const a of special) {
        if (Math.abs(a) < MEDIUM || !Number.isFinite(a)) {
            assert.ok(Object.is(W.sin(a), Math.sin(a)), 'sin ' + a);
            assert.ok(Object.is(W.cos(a), Math.cos(a)), 'cos ' + a);
        } else {
            assert.ok(Number.isFinite(W.sin(a)) && Math.abs(W.sin(a)) <= 1, 'sin stays a sine past the medium range');
            assert.equal(W.sin(a), W.sin(a));
        }
        for (const b of special) {
            assert.ok(Object.is(W.atan2(a, b), Math.atan2(a, b)), `atan2 ${a} ${b}`);
            assert.ok(Object.is(W.hypot(a, b), Math.hypot(a, b)), `hypot ${a} ${b}`);
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
