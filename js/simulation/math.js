// ---------------------------------------------------------------------------
// Portable math for rule code.
//
// The language fixes + - * / and sqrt to the last bit (IEEE 754), but leaves hypot,
// sin, cos, atan2, exp, log and pow to each engine: Chrome, Firefox and Safari may
// differ in the last bit, and in a simulation a last-bit difference in one distance
// can decide which unit reaches a target first, and from there the fight. A match
// recorded in one browser would then not replay in another.
//
// These are built from the exact operations only, so every engine computes the same
// bits. They follow V8's hypot and fdlibm's sin, cos and atan2; on x64 Node they equal
// Math to the last bit. Engines do not even agree with themselves: measured on 27
// September 2026, Chrome 152 differs from x64 Node 24 in the last bit for 2-18% of sin,
// cos and atan2 inputs, and the SAME Node 24.14.1 on ARM64 differs from x64 for about
// 0.5% -- so the browser, a Windows machine and the ARM64 server could each compute a
// different match. Through this module they compute the same bits, fingerprinted in
// tests/portable-math.test.cjs on both architectures. Rule code must use them;
// the same test rejects Math.hypot and the trig functions in rule files, except on a
// line marked "// math-exempt: <why>" (a texture painter, say).
// ---------------------------------------------------------------------------
var WarMath = (function () {
    // Captured once. Rule code runs these a hundred times a step, and inside a Node vm
    // context (the Platform's headless server, the test harness) every read of the
    // global Math goes through a slow lookup: measured, it made WarMath.hypot sixty
    // times slower there than outside and doubled a whole simulation step.
    // The same holds for Infinity and NaN, which are globals too.
    const sqrt = Math.sqrt, INF = Infinity, NAN = NaN;
    const abs = v => (v < 0 ? -v : v + 0);   // + 0 turns -0 into 0, as Math.abs does
    // A double's two 32-bit halves, through one shared buffer. Which half is "high"
    // depends on the machine's byte order, checked once, so every machine reads the
    // same bits. (A DataView fixes the order itself but made rule steps twice as slow.)
    const f64 = new Float64Array(1), i32 = new Int32Array(f64.buffer), u32 = new Uint32Array(f64.buffer);
    const HI = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1 ? 1 : 0, LO = 1 - HI;
    const high = x => { f64[0] = x; return i32[HI]; };
    const low = x => { f64[0] = x; return u32[LO]; };
    const withHigh = (hi, lo) => { i32[HI] = hi; u32[LO] = lo; return f64[0]; };

    // V8's Math.hypot: normalised by the largest term, Kahan-compensated. With two
    // terms the compensation is exactly zero after the first (0 + s is s, and
    // (s - 0) - s is 0), so this straight line gives the same bits as V8's loop --
    // and allocates nothing, which matters at a hundred calls a step.
    function hypot(a, b) {
        const x = abs(a), y = abs(b);
        if (x !== x || y !== y) return (x === INF || y === INF) ? INF : NAN;
        const max = x > y ? x : y;
        if (max === INF) return INF;
        if (max === 0) return 0;
        const n = x / max, m = y / max;
        return sqrt(n * n + m * m) * max;
    }

    // fdlibm kernels on [-pi/4, pi/4]; y is the tail of the reduced argument.
    const S1 = -1.66666666666666324348e-01, S2 = 8.33333333332248946124e-03, S3 = -1.98412698298579493134e-04,
          S4 = 2.75573137070700676789e-06, S5 = -2.50507602534068634195e-08, S6 = 1.58969099521155010221e-10;
    function kSin(x, y, iy) {
        if ((high(x) & 0x7fffffff) < 0x3e400000 && (x | 0) === 0) return x;
        const z = x * x, v = z * x, r = S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)));
        return iy === 0 ? x + v * (S1 + z * r) : x - ((z * (0.5 * y - v * r) - y) - v * S1);
    }
    const C1 = 4.16666666666666019037e-02, C2 = -1.38888888888741095749e-03, C3 = 2.48015872894767294178e-05,
          C4 = -2.75573143513906633035e-07, C5 = 2.08757232129817482790e-09, C6 = -1.13596475577881948265e-11;
    function kCos(x, y) {
        const ix = high(x) & 0x7fffffff;
        if (ix < 0x3e400000 && (x | 0) === 0) return 1;
        const z = x * x, r = z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))));
        if (ix < 0x3fd33333) return 1 - (0.5 * z - (z * r - x * y));
        const qx = ix > 0x3fe90000 ? 0.28125 : withHigh(ix - 0x00200000, 0);
        const hz = 0.5 * z - qx, a = 1 - qx;
        return a - (hz - (z * r - x * y));
    }

    // x - n*pi/2 as a head and tail, for |x| up to 2^20 * pi/2 (fdlibm's medium
    // range, about 1.6 million radians). Beyond it -- far past any angle a match computes,
    // and where V8 switches to an exact multi-precision reduction -- the argument is
    // first brought down with %, which is exact, by the double nearest 2*pi.
    const invpio2 = 6.36619772367581382433e-01, pio2_1 = 1.57079632673412561417e+00, pio2_1t = 6.07710050650619224932e-11,
          pio2_2 = 6.07710050630396597660e-11, pio2_2t = 2.02226624879595063154e-21, pio2_3 = 2.02226624871116645580e-21,
          pio2_3t = 8.47842766036889956997e-32;
    const npio2_hw = [0x3FF921FB, 0x400921FB, 0x4012D97C, 0x401921FB, 0x401F6A7A, 0x4022D97C, 0x4025FDBB, 0x402921FB,
        0x402C463A, 0x402F6A7A, 0x4031475C, 0x4032D97C, 0x40346B9C, 0x4035FDBB, 0x40378FDB, 0x403921FB, 0x403AB41B,
        0x403C463A, 0x403DD85A, 0x403F6A7A, 0x40407E4C, 0x4041475C, 0x4042106C, 0x4042D97C, 0x4043A28C, 0x40446B9C,
        0x404534AC, 0x4045FDBB, 0x4046C6CB, 0x40478FDB, 0x404858EB, 0x404921FB];
    function remPio2(x, y) {
        let hx = high(x), ix = hx & 0x7fffffff;
        if (ix <= 0x3fe921fb) { y[0] = x; y[1] = 0; return 0; }
        if (ix < 0x4002d97c) {
            if (hx > 0) {
                let z = x - pio2_1;
                if (ix !== 0x3ff921fb) { y[0] = z - pio2_1t; y[1] = (z - y[0]) - pio2_1t; }
                else { z -= pio2_2; y[0] = z - pio2_2t; y[1] = (z - y[0]) - pio2_2t; }
                return 1;
            }
            let z = x + pio2_1;
            if (ix !== 0x3ff921fb) { y[0] = z + pio2_1t; y[1] = (z - y[0]) + pio2_1t; }
            else { z += pio2_2; y[0] = z + pio2_2t; y[1] = (z - y[0]) + pio2_2t; }
            return -1;
        }
        if (ix > 0x413921fb) { x = x % 6.283185307179586; hx = high(x); ix = hx & 0x7fffffff; if (ix <= 0x3fe921fb) { y[0] = x; y[1] = 0; return 0; } }
        let t = abs(x);
        const n = (t * invpio2 + 0.5) | 0, fn = n;
        let r = t - fn * pio2_1, w = fn * pio2_1t;
        if (n < 32 && ix !== npio2_hw[n - 1]) {
            y[0] = r - w;
        } else {
            const j = ix >> 20;
            y[0] = r - w;
            let i = j - ((high(y[0]) >> 20) & 0x7ff);
            if (i > 16) {
                t = r; w = fn * pio2_2; r = t - w; w = fn * pio2_2t - ((t - r) - w); y[0] = r - w;
                i = j - ((high(y[0]) >> 20) & 0x7ff);
                if (i > 49) { t = r; w = fn * pio2_3; r = t - w; w = fn * pio2_3t - ((t - r) - w); y[0] = r - w; }
            }
        }
        y[1] = (r - y[0]) - w;
        if (hx < 0) { y[0] = -y[0]; y[1] = -y[1]; return -n; }
        return n;
    }

    const y = [0, 0];
    function sin(x) {
        const ix = high(x) & 0x7fffffff;
        if (ix <= 0x3fe921fb) return kSin(x, 0, 0);
        if (ix >= 0x7ff00000) return x - x;
        switch (remPio2(x, y) & 3) {
            case 0: return kSin(y[0], y[1], 1);
            case 1: return kCos(y[0], y[1]);
            case 2: return -kSin(y[0], y[1], 1);
            default: return -kCos(y[0], y[1]);
        }
    }
    function cos(x) {
        const ix = high(x) & 0x7fffffff;
        if (ix <= 0x3fe921fb) return kCos(x, 0);
        if (ix >= 0x7ff00000) return x - x;
        switch (remPio2(x, y) & 3) {
            case 0: return kCos(y[0], y[1]);
            case 1: return -kSin(y[0], y[1], 1);
            case 2: return -kCos(y[0], y[1]);
            default: return kSin(y[0], y[1], 1);
        }
    }

    // fdlibm atan and atan2.
    const atanhi = [4.63647609000806093515e-01, 7.85398163397448278999e-01, 9.82793723247329054082e-01, 1.57079632679489655800e+00];
    const atanlo = [2.26987774529616870924e-17, 3.06161699786838301793e-17, 1.39033110312309984516e-17, 6.12323399573676603587e-17];
    const aT = [3.33333333333329318027e-01, -1.99999999998764832476e-01, 1.42857142725034663711e-01, -1.11111104054623557880e-01,
        9.09088713343650656196e-02, -7.69187620504482999495e-02, 6.66107313738753120669e-02, -5.83357013379057348645e-02,
        4.97687799461593236017e-02, -3.65315727442169155270e-02, 1.62858201153657823623e-02];
    function atan(x) {
        const hx = high(x), ix = hx & 0x7fffffff;
        let id;
        if (ix >= 0x44100000) {
            if (ix > 0x7ff00000 || (ix === 0x7ff00000 && low(x) !== 0)) return x + x;
            return hx > 0 ? atanhi[3] + atanlo[3] : -atanhi[3] - atanlo[3];
        }
        if (ix < 0x3fdc0000) {
            if (ix < 0x3e200000) return x;
            id = -1;
        } else {
            x = abs(x);
            if (ix < 0x3ff30000) {
                if (ix < 0x3fe60000) { id = 0; x = (2 * x - 1) / (2 + x); }
                else { id = 1; x = (x - 1) / (x + 1); }
            } else if (ix < 0x40038000) { id = 2; x = (x - 1.5) / (1 + 1.5 * x); }
            else { id = 3; x = -1 / x; }
        }
        const z = x * x, w = z * z;
        const s1 = z * (aT[0] + w * (aT[2] + w * (aT[4] + w * (aT[6] + w * (aT[8] + w * aT[10])))));
        const s2 = w * (aT[1] + w * (aT[3] + w * (aT[5] + w * (aT[7] + w * aT[9]))));
        if (id < 0) return x - x * (s1 + s2);
        const r = atanhi[id] - ((x * (s1 + s2) - atanlo[id]) - x);
        return hx < 0 ? -r : r;
    }
    const pi = 3.1415926535897931160e+00, pi_o_2 = 1.5707963267948965580e+00, pi_o_4 = 7.8539816339744827900e-01,
          pi_lo = 1.2246467991473531772e-16, tiny = 1.0e-300;
    function atan2(yv, x) {
        if (x !== x || yv !== yv) return x + yv;
        const hx = high(x), lx = low(x), hy = high(yv), ly = low(yv);
        const ix = hx & 0x7fffffff, iy = hy & 0x7fffffff;
        if (((hx - 0x3ff00000) | lx) === 0) return atan(yv);
        let m = ((hy >> 31) & 1) | ((hx >> 30) & 2);
        if ((iy | ly) === 0) {
            if (m === 0 || m === 1) return yv;
            return m === 2 ? pi + tiny : -pi - tiny;
        }
        if ((ix | lx) === 0) return hy < 0 ? -pi_o_2 - tiny : pi_o_2 + tiny;
        if (ix === 0x7ff00000) {
            if (iy === 0x7ff00000) return [pi_o_4 + tiny, -pi_o_4 - tiny, 3 * pi_o_4 + tiny, -3 * pi_o_4 - tiny][m];
            return [0, -0, pi + tiny, -pi - tiny][m];
        }
        if (iy === 0x7ff00000) return hy < 0 ? -pi_o_2 - tiny : pi_o_2 + tiny;
        const k = (iy - ix) >> 20;
        let z;
        if (k > 60) { z = pi_o_2 + 0.5 * pi_lo; m &= 1; }
        else if (hx < 0 && k < -60) z = 0;
        else z = atan(abs(yv / x));
        switch (m) {
            case 0: return z;
            case 1: return -z;
            case 2: return pi - (z - pi_lo);
            default: return (z - pi_lo) - pi;
        }
    }

    // A small whole power by repeated multiplication: exact wherever the result is.
    function powInt(base, n) { let r = 1; for (let i = 0; i < n; i++) r *= base; return r; }

    return Object.freeze({ hypot, sin, cos, atan2, powInt });
})();
if (typeof module !== 'undefined' && module.exports) module.exports = WarMath;
