// EnginePerf -- the frame-time instrument (overhaul step F1).
//
// Three small things that know nothing about the game:
//   summary   median, slow tail and maximum of a list of numbers
//   Meter     what every drawn frame cost: the gap since the one before, the time spent
//             building and submitting it and, with detail on, its draw calls, its
//             triangles and its time on the GPU
//   Overlay   the on-screen readout behind ?perf=1
//
// The Meter always runs in its light form -- two numbers a frame -- so the picture can be
// judged without anyone having asked for it first. Counting draws wraps two GL calls and
// GPU time needs a timer query, so those are on only while someone is looking.
(function (root) {
    const EnginePerf = {};
    const RING = 600;            // ten seconds at 60 frames a second
    const STALL_MS = 1000;       // a longer gap is a tab that was away, not a slow frame
    const SLOW_MS = 33.4;        // a frame that missed 30 a second

    const quantile = (sorted, q) => {
        if (!sorted.length) return 0;
        const i = (sorted.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
        return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
    };
    // Median and slow tail rather than an average: one long frame is what a viewer
    // notices, and an average hides exactly that.
    EnginePerf.summary = (values) => {
        const s = Array.from(values).filter(Number.isFinite).sort((a, b) => a - b);
        if (!s.length) return { n: 0, median: 0, p95: 0, p99: 0, max: 0, mean: 0 };
        return { n: s.length, median: quantile(s, 0.5), p95: quantile(s, 0.95), p99: quantile(s, 0.99),
            max: s[s.length - 1], mean: s.reduce((a, b) => a + b, 0) / s.length };
    };

    // One timer interface over the two extensions that exist: WebGL 1 hangs the calls on
    // the extension object, WebGL 2 on the context. Null where the browser offers neither.
    function gpuTimer(gl) {
        if (!gl || !gl.getExtension) return null;
        const two = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
        const ext = gl.getExtension(two ? 'EXT_disjoint_timer_query_webgl2' : 'EXT_disjoint_timer_query');
        if (!ext) return null;
        const disjoint = () => gl.getParameter(ext.GPU_DISJOINT_EXT);
        return two ? {
            create: () => gl.createQuery(), drop: q => gl.deleteQuery(q), disjoint,
            begin: q => gl.beginQuery(ext.TIME_ELAPSED_EXT, q), end: () => gl.endQuery(ext.TIME_ELAPSED_EXT),
            ready: q => gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE),
            value: q => gl.getQueryParameter(q, gl.QUERY_RESULT)
        } : {
            create: () => ext.createQueryEXT(), drop: q => ext.deleteQueryEXT(q), disjoint,
            begin: q => ext.beginQueryEXT(ext.TIME_ELAPSED_EXT, q), end: () => ext.endQueryEXT(ext.TIME_ELAPSED_EXT),
            ready: q => ext.getQueryObjectEXT(q, ext.QUERY_RESULT_AVAILABLE_EXT),
            value: q => ext.getQueryObjectEXT(q, ext.QUERY_RESULT_EXT)
        };
    }

    class Meter {
        constructor(gl) {
            this.gl = gl || null;
            this.interval = new Float32Array(RING);   // ms from one frame's start to the next
            this.build = new Float32Array(RING);      // ms spent building and submitting a frame
            this.gpu = new Float32Array(RING);        // ms the GPU reports for a frame
            this.reset();
            this.detail = false;
            this._timer = null;
            this._pending = [];
            this._open = false;
        }

        reset() {
            this.nInterval = 0; this.nBuild = 0; this.nGpu = 0;
            this.frames = 0; this.stalls = 0;
            this.draws = 0; this.tris = 0;            // of the last finished frame
            this._draws = 0; this._tris = 0;
            this._last = -1; this._t0 = 0;           // -1: no frame yet
            this.lastInterval = 0;                    // 0 when the last gap was a stall
        }

        // Draw calls, triangles and GPU time. Off by default: see the header.
        setDetail(on) {
            on = !!on;
            if (on === this.detail) return;
            this.detail = on;
            const gl = this.gl;
            if (!gl) return;
            if (on) {
                const self = this, de = gl.drawElements, da = gl.drawArrays;
                const own = Object.prototype.hasOwnProperty.call(gl, 'drawElements');
                const tris = (mode, count) => mode === gl.TRIANGLES ? count / 3
                    : (mode === gl.TRIANGLE_STRIP || mode === gl.TRIANGLE_FAN) ? Math.max(0, count - 2) : 0;
                gl.drawElements = function (mode, count, type, offset) {
                    self._draws++; self._tris += tris(mode, count);
                    return de.call(gl, mode, count, type, offset);
                };
                gl.drawArrays = function (mode, first, count) {
                    self._draws++; self._tris += tris(mode, count);
                    return da.call(gl, mode, first, count);
                };
                // Back to the context's own methods, not to a copy of them.
                this._unwrap = () => {
                    if (own) { gl.drawElements = de; gl.drawArrays = da; }
                    else { delete gl.drawElements; delete gl.drawArrays; }
                };
                this._timer = gpuTimer(gl);
            } else {
                if (this._unwrap) { this._unwrap(); this._unwrap = null; }
                this._closeQuery();
                if (this._timer) for (const q of this._pending) this._timer.drop(q);
                this._pending.length = 0;
                this._timer = null;
            }
        }

        get gpuSupported() { return !!this._timer; }

        _closeQuery() {
            if (this._open && this._timer) { try { this._timer.end(); } catch (e) {} }
            this._open = false;
        }

        // Results arrive a frame or two late. A disjoint reading is one the driver
        // itself says not to trust (a power-state change mid-query), so it is dropped.
        _collect() {
            const tm = this._timer;
            if (!tm) return;
            while (this._pending.length && tm.ready(this._pending[0])) {
                const q = this._pending.shift();
                if (!tm.disjoint()) this.gpu[this.nGpu++ % RING] = tm.value(q) / 1e6;
                tm.drop(q);
            }
        }

        frameBegin(now) {
            if (this._open) this._closeQuery();       // the frame before threw half-way
            const gap = this._last >= 0 ? now - this._last : 0;
            this._last = now;
            const hidden = typeof document !== 'undefined' && document.hidden;
            if (gap > 0 && gap <= STALL_MS && !hidden) {
                this.interval[this.nInterval++ % RING] = gap;
                this.lastInterval = gap;
            } else {
                if (gap > STALL_MS) this.stalls++;
                this.lastInterval = 0;
            }
            this._draws = 0; this._tris = 0;
            if (this._timer) {
                this._collect();
                if (this._pending.length < 8) {
                    const q = this._timer.create();
                    this._timer.begin(q);
                    this._pending.push(q);
                    this._open = true;
                }
            }
            this._t0 = (typeof performance !== 'undefined' ? performance : Date).now();
        }

        frameEnd() {
            const t = (typeof performance !== 'undefined' ? performance : Date).now();
            this.build[this.nBuild++ % RING] = t - this._t0;
            this._closeQuery();
            this.draws = this._draws; this.tris = this._tris;
            this.frames++;
        }

        _take(ring, n) { return Array.from(ring.subarray(0, Math.min(n, RING))); }

        stats() {
            const gaps = this._take(this.interval, this.nInterval);
            const interval = EnginePerf.summary(gaps);
            return {
                frames: this.frames, stalls: this.stalls, interval,
                fps: interval.median ? 1000 / interval.median : 0,
                slow: gaps.filter(v => v > SLOW_MS).length,
                build: EnginePerf.summary(this._take(this.build, this.nBuild)),
                gpu: this.nGpu ? EnginePerf.summary(this._take(this.gpu, this.nGpu)) : null,
                draws: this.draws, tris: this.tris
            };
        }

        // The newest gaps, oldest first, for the readout's strip.
        recent(count) {
            const n = Math.min(count, this.nInterval, RING), out = new Array(n);
            for (let i = 0; i < n; i++) out[i] = this.interval[(this.nInterval - n + i) % RING];
            return out;
        }
    }

    // The readout. English only and unstyled by the theme on purpose: it is an
    // instrument, like ?dir=1, not part of what a viewer is shown.
    class Overlay {
        constructor(meter, describe) {
            this.meter = meter;
            this.describe = describe || (() => '');
            const el = document.createElement('div');
            el.className = 'perf-readout';
            el.style.cssText = 'position:fixed;left:50%;bottom:10px;transform:translateX(-50%);z-index:99990;'
                + 'padding:7px 10px 6px;border-radius:6px;background:rgba(14,13,11,.86);color:#ece3cf;'
                + 'font:12px/1.45 ui-monospace,Consolas,Menlo,monospace;white-space:pre;pointer-events:none;'
                + 'box-shadow:0 0 0 1px rgba(208,157,84,.35)';
            this.text = document.createElement('div');
            this.strip = document.createElement('canvas');
            this.strip.width = 300; this.strip.height = 34;
            this.strip.style.cssText = 'display:block;margin-top:5px;width:300px;height:34px';
            el.appendChild(this.text); el.appendChild(this.strip);
            document.body.appendChild(el);
            this.el = el;
            this._timer = setInterval(() => this.update(), 250);
            this.update();
        }

        static text(s, tail) {
            const ms = v => (v >= 100 ? v.toFixed(0) : v.toFixed(1));
            const big = v => v >= 1e6 ? (v / 1e6).toFixed(2) + 'M' : v >= 1e4 ? (v / 1e3).toFixed(0) + 'k' : String(Math.round(v));
            if (!s.interval.n) return 'frame  no frames measured yet' + (tail ? '\n' + tail : '');
            return 'frame  ' + ms(s.interval.median) + ' ms   p95 ' + ms(s.interval.p95) + '   p99 ' + ms(s.interval.p99)
                + '   max ' + ms(s.interval.max) + '   ' + s.fps.toFixed(0) + ' fps'
                + '\nbuild  ' + ms(s.build.median) + ' ms   GPU ' + (s.gpu ? ms(s.gpu.median) + ' ms' : 'n/a')
                + '   ' + big(s.draws) + ' draws   ' + big(s.tris) + ' tris'
                + '\nslow   ' + s.slow + ' of ' + s.interval.n + ' over 33 ms' + (s.stalls ? '   ' + s.stalls + ' stalls' : '')
                + (tail ? '\n' + tail : '');
        }

        update() {
            this.text.textContent = Overlay.text(this.meter.stats(), this.describe());
            const c = this.strip.getContext('2d'), w = this.strip.width, h = this.strip.height;
            const y = ms => h - Math.min(h, ms / 50 * h);          // the strip tops out at 50 ms
            c.clearRect(0, 0, w, h);
            c.fillStyle = 'rgba(255,255,255,.05)'; c.fillRect(0, 0, w, h);
            const gaps = this.meter.recent(w);
            for (let i = 0; i < gaps.length; i++) {
                const v = gaps[i];
                c.fillStyle = v > SLOW_MS ? '#e0685a' : v > 20 ? '#d09d54' : '#63b9a7';
                c.fillRect(w - gaps.length + i, y(v), 1, h - y(v));
            }
            c.fillStyle = 'rgba(236,227,207,.35)';
            c.fillRect(0, y(16.7), w, 1); c.fillRect(0, y(SLOW_MS), w, 1);
        }

        remove() { clearInterval(this._timer); this.el.remove(); }
    }

    EnginePerf.Meter = Meter;
    EnginePerf.Overlay = Overlay;
    EnginePerf.RING = RING;
    EnginePerf.SLOW_MS = SLOW_MS;

    root.EnginePerf = EnginePerf;
    if (typeof module !== 'undefined' && module.exports) module.exports = EnginePerf;
})(typeof window !== 'undefined' ? window : globalThis);
