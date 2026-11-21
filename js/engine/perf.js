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
            this._timingFor = new Set();
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

        // GPU time on its own: a query per frame, cheap enough to leave on while the
        // quality governor needs it. `who` keeps two askers from switching each other off.
        setGpuTiming(on, who) {
            if (on) this._timingFor.add(who || 'caller'); else this._timingFor.delete(who || 'caller');
            if (!this.gl) return;
            if (this._timingFor.size && !this._timer) this._timer = gpuTimer(this.gl);
            else if (!this._timingFor.size && this._timer) {
                this._closeQuery();
                for (const q of this._pending) this._timer.drop(q);
                this._pending.length = 0;
                this._timer = null;
            }
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
            } else if (this._unwrap) { this._unwrap(); this._unwrap = null; }
            this.setGpuTiming(on, 'detail');
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

        // What the newest frames cost: the page's share and the GPU's, null where the
        // browser does not report it.
        recentCost(count) {
            const tail = (ring, n) => {
                const k = Math.min(count, n, RING), out = new Array(k);
                for (let i = 0; i < k; i++) out[i] = ring[(n - k + i) % RING];
                return out;
            };
            return { build: EnginePerf.summary(tail(this.build, this.nBuild)).median,
                gpu: this._timer && this.nGpu ? EnginePerf.summary(tail(this.gpu, this.nGpu)).median : null };
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

    // ---- the quality governor (overhaul step F2) -------------------------------------
    // Keeps the picture smooth on a machine nobody measured beforehand. It reads the gaps
    // between frames a window at a time and has two levers:
    //   resolution  cheap to change and hard to see: one small step is the first thing
    //               tried, the deeper ones are kept for the lightest tier
    //   tier        visible (shadows, grass), so it waits longer, starts sharp again at
    //               full resolution, and never comes back up on its own
    // Every step down is judged in the next window. One that bought nothing is undone: the
    // time is going somewhere graphics settings do not reach -- the simulation, a browser
    // holding the page to 30 a second on battery, a remote desktop. Where the browser
    // reports GPU time that is known beforehand and the step is never taken.
    // The resolution comes back when the picture has been smooth for a while; a raise that
    // does not hold is taken back at once and the next one waits twice as long.
    class Governor {
        constructor(opts) {
            const o = opts || {};
            this.scales = o.scales || [1, 0.85, 0.7, 0.6];
            this.tiers = o.tiers || ['cinematic', 'balanced', 'low'];
            this.slowMs = o.slowMs || 22;              // on average slower than 45 a second
            this.fastMs = o.fastMs || 18.5;            // holding 60
            this.windowMs = o.windowMs || 1500;
            this.minFrames = o.minFrames || 20;
            this.patience = o.patience || 2;           // slow windows before resolution moves
            this.tierPatience = o.tierPatience || 6;   // ...and before the tier does: nine seconds
            this.gentle = o.gentle == null ? 1 : o.gentle;   // resolution steps taken before the tier
            this.settleMs = o.settleMs || 600;         // a change rebuilds buffers: not a sample
            this.raiseAfterMs = o.raiseAfterMs || 20000;
            this.raiseMaxMs = o.raiseMaxMs || 300000;
            this.idleMs = o.idleMs || 60000;           // how long a lever that did not help rests
            this.idleMaxMs = o.idleMaxMs || 1800000;
            this.minGain = o.minGain || 0.08;
            this.judgeWindows = o.judgeWindows || 2;   // how long a step down is watched
            this.boundShare = o.boundShare || 0.6;     // of the gap spent on the frame itself
            this.costOf = o.costOf || null;            // () => { build, gpu } in ms, gpu may be null
            this.reset(o.tier, o.level);
        }

        reset(tier, level) {
            this.tierIndex = Math.max(0, this.tiers.indexOf(tier));
            this.level = Math.max(0, Math.min(this.scales.length - 1, level | 0));
            this._sum = 0; this._n = 0;
            this._slow = 0; this._fastSince = -1;
            this._quietUntil = 0;
            this._judge = null;                        // { lever, before } after a step down
            this._probe = 0;                           // windows left to watch after a raise
            this._resolutionRests = 0; this._tierRests = 0;
            this._resolutionIdle = this.idleMs; this._tierIdle = this.idleMs;
            this._raiseAfter = this.raiseAfterMs;
        }

        get scale() { return this.scales[this.level]; }
        get tier() { return this.tiers[this.tierIndex]; }

        // One frame's gap in ms; 0 for a frame that was not timed. Returns null, or what
        // to draw with from now on: { scale, tier, why }.
        frame(gapMs, now) {
            if (!(gapMs > 0) || now < this._quietUntil) return null;
            this._sum += gapMs; this._n++;
            if (this._sum < this.windowMs || this._n < this.minFrames) return null;
            const mean = this._sum / this._n;
            this._sum = 0; this._n = 0;
            return this._window(mean, now);
        }

        _changed(now, why) {
            this._quietUntil = now + this.settleMs;
            this._slow = 0; this._fastSince = -1;
            return { scale: this.scale, tier: this.tier, why };
        }

        _window(mean, now) {
            const slow = mean > this.slowMs, fast = mean < this.fastMs;
            const cost = this.costOf ? this.costOf() : null, known = !!cost && cost.gpu != null;

            if (this._judge) {
                // Two windows, not one: a single window on a busy machine is noise enough
                // to make a useless step look like a gain.
                const j = this._judge;
                j.sum += mean;
                if (--j.left > 0) return null;
                this._judge = null;
                const after = j.sum / this.judgeWindows;
                if (after > this.slowMs && 1 - after / j.before < this.minGain) {
                    // Each failure doubles the rest, so a picture that is slow for another
                    // reason does not lose and regain its shadows once a minute.
                    if (j.lever === 'resolution') {
                        this.level--;
                        this._resolutionRests = now + this._resolutionIdle;
                        this._resolutionIdle = Math.min(this.idleMaxMs, this._resolutionIdle * 2);
                    } else {
                        this.tierIndex--;
                        this.level = j.level;
                        this._tierRests = now + this._tierIdle;
                        this._tierIdle = Math.min(this.idleMaxMs, this._tierIdle * 2);
                    }
                    const out = this._changed(now, j.lever + ' did not help');
                    this._slow = 1;                    // still slow: the other lever is next
                    return out;
                }
                if (j.lever === 'resolution') this._resolutionIdle = this.idleMs;
                else {
                    this._tierIdle = this.idleMs;
                    this._resolutionRests = 0;         // a lighter tier: resolution may matter again
                    this._resolutionIdle = this.idleMs;
                }
            }
            if (this._probe) {
                if (slow) {
                    this._probe = 0;
                    this.level++;
                    this._raiseAfter = Math.min(this.raiseMaxMs, this._raiseAfter * 2);
                    return this._changed(now, 'raise did not hold');
                }
                if (--this._probe === 0) this._raiseAfter = this.raiseAfterMs;
            }

            if (slow) {
                this._fastSince = -1;
                // The frame itself is cheap: something else sets the pace.
                if (known && cost.build + cost.gpu < this.boundShare * mean) { this._slow = 0; return null; }
                if (++this._slow < this.patience) return null;
                const tierFree = this.tierIndex < this.tiers.length - 1 && now >= this._tierRests;
                // One small step of resolution first: the change nobody sees. After that a
                // lighter tier drawn sharp beats this one drawn coarse, so the deeper steps
                // are for when there is no lighter tier to go to.
                const depth = tierFree ? this.gentle : this.scales.length - 1;
                if (this.level < depth && now >= this._resolutionRests) {
                    this.level++;
                    this._judge = { lever: 'resolution', before: mean, left: this.judgeWindows, sum: 0 };
                    return this._changed(now, 'slow: resolution down');
                }
                // The tier is the visible lever: it waits for the picture to have been
                // slow for a while, not for one busy moment.
                if (tierFree && this._slow >= this.tierPatience) {
                    this._judge = { lever: 'tier', before: mean, level: this.level, left: this.judgeWindows, sum: 0 };
                    this.tierIndex++;
                    this.level = 0;
                    return this._changed(now, 'slow: tier down');
                }
                if (!tierFree) this._slow = 0;         // nothing left to give
                return null;
            }

            this._slow = 0;
            if (!fast) { this._fastSince = -1; return null; }
            if (this._fastSince < 0) this._fastSince = now;
            if (this.level > 0 && now - this._fastSince >= this._raiseAfter) {
                // With GPU time known, do not try a raise the numbers already rule out.
                const more = Math.pow(this.scales[this.level - 1] / this.scale, 2);
                if (known && cost.build + cost.gpu * more > this.fastMs * 0.9) return null;
                this.level--;
                this._probe = 2;
                return this._changed(now, 'smooth: resolution up');
            }
            return null;
        }
    }

    EnginePerf.Meter = Meter;
    EnginePerf.Governor = Governor;
    EnginePerf.Overlay = Overlay;
    EnginePerf.RING = RING;
    EnginePerf.SLOW_MS = SLOW_MS;

    root.EnginePerf = EnginePerf;
    if (typeof module !== 'undefined' && module.exports) module.exports = EnginePerf;
})(typeof window !== 'undefined' ? window : globalThis);
