// The ?perf= switch and the frame benchmark (overhaul step F1).
//
//   ?perf=1      the live readout over whatever the page is showing: frame time with its
//                slow tail, draw calls, triangles and GPU time (js/engine/perf.js)
//   ?perf=bench  the scripted fly-through below
//
// The fly-through draws the same frames on every machine: one late-game moment of a
// shipped match, at 1920x1080 whatever the window is, along a fixed camera path, once per
// graphics tier. Each frame is timed from the first call that builds it to the moment the
// GPU has finished it -- reading one pixel back forces that wait -- so the number is what
// a frame COSTS, not how often the display asked for one. A machine that holds 60 a
// second shows 16.7 ms between frames whether a frame costs 3 ms or 15; only the cost
// says how much room is left, and only the cost can be compared before and after a
// graphics change.
//
// The scene is every unit and building the four seats had at that moment, standing on
// that match's island as it is generated today, with every forest up and nothing hidden.
// It is drawn, not played: nothing moves, so two runs draw exactly the same thing.
const WarPerfBench = {
    VERSION: 1,
    SCENE: { file: '2026-10-05_gpt6.1-sol-claude-sonnet5.5-deepseek-v4.1-glm5.3_99min.jsonl', sec: 2071 },
    SIZE: { w: 1920, h: 1080 },
    FRAMES: 120,      // measured frames per leg
    RUN: 12,          // drawn back to back before the page gets the thread again
    WARMUP: 30,       // unmeasured frames at the start of a pass: the tier's buffers get built here
    PASSES: [
        { id: 'low', tier: 'low', style: 'cinematic', label: 'Low' },
        { id: 'balanced', tier: 'balanced', style: 'cinematic', label: 'Balanced' },
        { id: 'high', tier: 'cinematic', style: 'cinematic', label: 'High' },
        { id: 'high-film', tier: 'cinematic', style: 'film', label: 'High, Cinematic light' },
    ],
    last: null,
    running: false,

    // Five shots, each a pose at k = 0 and at k = 1. Built from where the towns are in
    // the scene, so the path follows the match rather than fixed coordinates.
    legs(renderer) {
        const towns = new Map();
        for (const b of renderer.buildings) {
            const t = towns.get(b.owner) || { x: 0, z: 0, n: 0 };
            t.x += b.x; t.z += b.z; t.n++;
            towns.set(b.owner, t);
        }
        const byness = [...towns.values()].map(t => ({ x: t.x / t.n, z: t.z / t.n, n: t.n })).sort((a, b) => b.n - a.n);
        const A = byness[0] || { x: 0, z: 0 }, B = byness[1] || A;
        const tilt = Math.atan(0.5), q = Math.PI / 4;
        const whole = renderer.wholeMapHalf(tilt);
        return [
            { id: 'overview', light: 'noon', from: { x: 0, z: 0, half: whole, yaw: 0, pitch: tilt }, to: { x: 0, z: 0, half: whole, yaw: 0.5, pitch: tilt } },
            { id: 'town', light: 'noon', from: { x: A.x, z: A.z, half: 70, yaw: q - 0.4, pitch: tilt }, to: { x: A.x, z: A.z, half: 70, yaw: q + 0.4, pitch: tilt } },
            { id: 'close-up', light: 'noon', from: { x: A.x, z: A.z, half: 40, yaw: q, pitch: 0.52 }, to: { x: A.x, z: A.z, half: 14, yaw: q, pitch: 0.52 } },
            { id: 'crossing', light: 'dusk', from: { x: A.x, z: A.z, half: 55, yaw: q, pitch: tilt }, to: { x: B.x, z: B.z, half: 55, yaw: q, pitch: tilt } },
            { id: 'night town', light: 'night', from: { x: B.x, z: B.z, half: 45, yaw: q + 0.4, pitch: tilt }, to: { x: B.x, z: B.z, half: 45, yaw: q - 0.4, pitch: tilt } },
        ];
    },

    pose(renderer, leg, k) {
        const mix = (a, b) => a + (b - a) * k;
        renderer.cameraTarget.set(mix(leg.from.x, leg.to.x), 0, mix(leg.from.z, leg.to.z));
        renderer._halfH = mix(leg.from.half, leg.to.half);
        renderer._yaw = mix(leg.from.yaw, leg.to.yaw);
        renderer._pitch = mix(leg.from.pitch, leg.to.pitch);
        renderer._lookY = 0;
    },

    async buildScene() {
        const ui = game.ui, r = game.renderer;
        const res = await fetch('samples/' + this.SCENE.file);
        if (!res.ok) throw new Error('The benchmark scene could not be loaded (HTTP ' + res.status + ').');
        const a = new TranscriptAnalyzer(ui);
        a.load(await res.text(), this.SCENE.file);
        a.union = true;
        let rec = null;
        for (const o of a.order) if (o.playerId && o.state && o._sec <= this.SCENE.sec) rec = o;
        if (!rec) throw new Error('The benchmark scene has no turn at ' + this.SCENE.sec + ' s.');
        ui.analyzer = a;
        ui._anFramed = true;                       // the path below does the framing
        r.poseSource = null; r.ageSource = null;
        r.replayMode = true;
        game.spectatorMode = true;
        ui.anBuildStage(rec);
        // A spectator's island: every forest standing, nothing under fog. The transcript
        // only holds the nodes a seat had found, and a recorded position is exact only
        // on the map as it was generated then.
        game.fogOfWar = null;
        const clear = r.buildings.map(b => ({ x: b.x, z: b.z, r: b.isWonder ? 16 : 9 }));
        let trees = 0;
        for (const node of game.terrain.resources || []) {
            if (!node.mesh) continue;
            const show = !clear.some(c => Math.hypot(c.x - node.x, c.z - node.z) < c.r);
            if (node.mesh.trunk) { node.mesh.trunk.visible = show; node.mesh.leaves.visible = show; }
            else node.mesh.visible = show;
            if (show) trees++;
        }
        return { file: this.SCENE.file, sec: rec._sec, units: r.units.length, buildings: r.buildings.length, nodes: trees };
    },

    machine() {
        const gl = game.renderer.gl, dbg = gl.getExtension('WEBGL_debug_renderer_info');
        return {
            gpu: String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)),
            webgl: gl.warVersion || 1,
            arrays: !!GLCore.vaoOf(gl),
            cores: navigator.hardwareConcurrency || null,
            pixelRatio: window.devicePixelRatio || 1,
            screen: (screen.width || 0) + 'x' + (screen.height || 0),
            browser: navigator.userAgent
        };
    },

    // One pass: a tier and a light style, all five legs.
    async pass(p, legs, onProgress) {
        const r = game.renderer, gl = r.gl, meter = r.perf;
        const lightAt = name => EngineAtmosphere.previewTime(r._theme || 'summer', name);
        const yieldNow = () => new Promise(done => {
            const ch = new MessageChannel();
            ch.port1.onmessage = () => done();
            ch.port2.postMessage(0);
        });
        const px = new Uint8Array(4);
        const frame = () => {
            const t0 = performance.now();
            r.renderFrame();
            const t1 = performance.now();
            gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);   // wait for the GPU
            return { cost: performance.now() - t0, build: t1 - t0 };
        };
        r.setGraphicsQuality(p.tier);
        r.visualStyle = p.style;                   // not setVisualStyle: that would save it
        this.pose(r, legs[0], 0);
        game._environmentSeconds = lightAt(legs[0].light);
        for (let i = 0; i < this.WARMUP; i++) { frame(); if (i % 10 === 9) await yieldNow(); }
        meter.reset();
        const all = { cost: [], build: [], draws: [], tris: [] }, perLeg = [];
        for (const leg of legs) {
            game._environmentSeconds = lightAt(leg.light);
            const mine = { cost: [], draws: [], tris: [] };
            // Frames are drawn back to back, in short runs with a pause between. The page
            // puts a picture on screen whenever it gets the thread back, and a frame
            // measured across that moment waits for the display's refresh: with a pause
            // after every frame the costs came out as multiples of the refresh interval.
            // So the first frame after a pause is drawn and thrown away.
            let i = 0;
            while (i < this.FRAMES) {
                this.pose(r, leg, i / (this.FRAMES - 1));
                frame();
                const started = performance.now();
                do {
                    this.pose(r, leg, i / (this.FRAMES - 1));
                    const f = frame();
                    all.cost.push(f.cost); all.build.push(f.build); all.draws.push(meter.draws); all.tris.push(meter.tris);
                    mine.cost.push(f.cost); mine.draws.push(meter.draws); mine.tris.push(meter.tris);
                    i++;
                } while (i < this.FRAMES && i % this.RUN !== 0 && performance.now() - started < 150);
                await yieldNow();
            }
            const c = EnginePerf.summary(mine.cost);
            perLeg.push({ id: leg.id, light: leg.light, median: c.median, p95: c.p95,
                draws: Math.round(EnginePerf.summary(mine.draws).median), tris: Math.round(EnginePerf.summary(mine.tris).median) });
            if (onProgress) onProgress(p, leg);
        }
        // GPU readings trail the frames they belong to: a few more frames bring them in.
        for (let i = 0; i < 4; i++) { frame(); await yieldNow(); }
        const gpu = meter.stats().gpu;
        const cost = EnginePerf.summary(all.cost);
        return {
            id: p.id, label: p.label, tier: p.tier, style: p.style, frames: all.cost.length,
            // Frames per second over the whole path: frames drawn over the time they took.
            cost, fps: cost.mean ? 1000 / cost.mean : 0,
            build: EnginePerf.summary(all.build),
            gpu: gpu ? { median: gpu.median, p95: gpu.p95, n: gpu.n } : null,
            draws: { median: Math.round(EnginePerf.summary(all.draws).median), max: Math.max(...all.draws) },
            tris: { median: Math.round(EnginePerf.summary(all.tris).median), max: Math.max(...all.tris) },
            legs: perLeg
        };
    },

    async run(onProgress) {
        if (this.running) return null;
        this.running = true;
        const r = game.renderer, before = { tier: r.graphicsQuality, style: r.visualStyle, held: r.holdFrames, pin: r._pinnedSize };
        try {
            r.holdFrames = true;
            r.perf.setDetail(true);
            r.pinRenderSize(this.SIZE.w, this.SIZE.h);
            const scene = await this.buildScene();
            const legs = this.legs(r);
            const passes = [];
            for (const p of this.PASSES) passes.push(await this.pass(p, legs, onProgress));
            const report = {
                kind: 'war-perf/' + this.VERSION, build: UIManager.buildVersion(), at: new Date().toISOString(),
                size: this.SIZE.w + 'x' + this.SIZE.h, framesPerLeg: this.FRAMES,
                scene, machine: this.machine(), passes
            };
            this.last = report;
            return report;
        } finally {
            r.setGraphicsQuality(before.tier);
            r.visualStyle = before.style;
            r.holdFrames = before.held;
            r.pinRenderSize(before.pin ? before.pin.w : 0, before.pin ? before.pin.h : 0);
            this.running = false;
        }
    },

    // ---- the page around it -------------------------------------------------
    // The comparison with the run before is made on the mean: the path mixes light and
    // heavy shots, and a median taken across them moves when two frames swap sides.
    text(report, previous) {
        const ms = v => v.toFixed(v >= 100 ? 0 : 2), pad = (v, n) => String(v).padStart(n);
        const lines = ['WAR frame benchmark  build ' + report.build + '  ' + report.size + '  ' + report.at,
            report.machine.gpu,
            'scene: ' + report.scene.units + ' units, ' + report.scene.buildings + ' buildings, ' + report.scene.nodes + ' resource nodes',
            '',
            'ms per frame'.padEnd(24) + '    mean  median    p95    p99    fps  build    GPU  draws    tris' + (previous ? '  vs last' : '')];
        for (const p of report.passes) {
            const old = previous && previous.passes.find(o => o.id === p.id);
            lines.push(p.label.padEnd(24) + pad(ms(p.cost.mean), 8) + pad(ms(p.cost.median), 8) + pad(ms(p.cost.p95), 7)
                + pad(ms(p.cost.p99), 7) + pad(p.fps.toFixed(0), 7) + pad(ms(p.build.median), 7)
                + pad(p.gpu ? ms(p.gpu.median) : 'n/a', 7) + pad(p.draws.median, 7) + pad(Math.round(p.tris.median / 1000) + 'k', 8)
                + (old ? pad((p.cost.mean / old.cost.mean > 1 ? '+' : '') + ((p.cost.mean / old.cost.mean - 1) * 100).toFixed(1) + ' %', 9) : ''));
        }
        const legs = report.passes[0] ? report.passes[0].legs.map(l => l.id) : [];
        lines.push('', 'median per shot'.padEnd(24) + legs.map(id => pad(id, 12)).join(''));
        for (const p of report.passes) lines.push(p.label.padEnd(24) + p.legs.map(l => pad(ms(l.median), 12)).join(''));
        lines.push('', 'A frame is timed from the first call that builds it until the GPU has finished it.',
            'build = the part spent in the page; GPU = what the graphics card reports for itself.');
        return lines.join('\n');
    },

    // Runs can only be compared when they drew the same thing.
    comparable(a, b) {
        return !!(a && b && a.kind === b.kind && a.size === b.size && a.framesPerLeg === b.framesPerLeg
            && a.scene.file === b.scene.file && a.scene.sec === b.scene.sec && a.machine.gpu === b.machine.gpu);
    },

    async page() {
        const stage = document.createElement('div');
        stage.id = 'perfStage';
        stage.style.cssText = 'position:fixed;inset:0;z-index:99980;background:#0b0b0a';
        const style = document.createElement('style');
        style.textContent = '#perfStage canvas{width:100%!important;height:100%!important;object-fit:contain}'
            + '#perfPanel{position:fixed;left:14px;top:14px;z-index:99985;max-width:calc(100vw - 28px);padding:12px 14px;'
            + 'border-radius:8px;background:rgba(14,13,11,.9);color:#ece3cf;box-shadow:0 0 0 1px rgba(208,157,84,.4);'
            + 'font:13px/1.5 ui-monospace,Consolas,Menlo,monospace}'
            + '#perfPanel pre{margin:8px 0 0;font:inherit;white-space:pre;overflow:auto}'
            + '#perfPanel button,#perfPanel a{margin:10px 8px 0 0;padding:5px 10px;border-radius:5px;border:1px solid rgba(208,157,84,.6);'
            + 'background:transparent;color:#ece3cf;font:inherit;cursor:pointer;text-decoration:none;display:inline-block}'
            + '#perfPanel button:hover,#perfPanel a:hover{background:rgba(208,157,84,.18)}';
        document.head.appendChild(style);
        document.body.appendChild(stage);
        stage.appendChild(document.getElementById('gameCanvas'));
        const panel = document.createElement('div');
        panel.id = 'perfPanel';
        document.body.appendChild(panel);
        const home = () => { const u = new URL(location.href); u.searchParams.delete('perf'); return u.href; };
        const say = text => { panel.textContent = text; };
        // Nothing draws between runs: left to itself the page would redraw this scene at
        // the display's rate, and the next run would start on a warm machine.
        game.renderer.holdFrames = true;
        game.renderer.pinRenderSize(this.SIZE.w, this.SIZE.h);
        const go = async () => {
            let previous = null;
            try { previous = JSON.parse(localStorage.getItem('warPerfLast') || 'null'); } catch (e) {}
            const total = this.PASSES.length * 5;
            let done = 0;
            say('WAR frame benchmark\nLoading the scene ...');
            let report;
            try {
                report = await this.run((p, leg) => {
                    done++;
                    say('WAR frame benchmark\n' + p.label + ' - ' + leg.id + '  (' + done + ' of ' + total + ')\nKeep this window in front until it finishes.');
                });
            } catch (e) {
                console.error('[perf] benchmark failed', e);
                say('WAR frame benchmark\nIt stopped: ' + (e && e.message || e));
                return;
            }
            if (!this.comparable(report, previous)) previous = null;
            try { localStorage.setItem('warPerfLast', JSON.stringify(report)); } catch (e) {}
            panel.textContent = '';
            const pre = document.createElement('pre');
            pre.textContent = this.text(report, previous);
            panel.appendChild(pre);
            const button = (label, act) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.onclick = act; panel.appendChild(b); return b; };
            button('Save report', () => {
                const a = document.createElement('a');
                a.href = URL.createObjectURL(new Blob([JSON.stringify(report, null, 1)], { type: 'application/json' }));
                a.download = 'war-perf-b' + report.build + '-' + report.at.slice(0, 19).replace(/[:T]/g, '-') + '.json';
                a.click();
                setTimeout(() => URL.revokeObjectURL(a.href), 1000);
            });
            const copy = button('Copy table', () => navigator.clipboard.writeText(pre.textContent).then(
                () => { copy.textContent = 'Copied'; }, () => { copy.textContent = 'Copy failed'; }));
            button('Run again', go);
            const back = document.createElement('a');
            back.href = home(); back.textContent = 'Back to the game';
            panel.appendChild(back);
        };
        await go();
    }
};

window.addEventListener('load', () => {
    if (typeof game === 'undefined' || !game || !game.renderer || !game.renderer.perf) return;
    const mode = new URLSearchParams(location.search).get('perf');
    if (mode === 'bench') { WarPerfBench.page(); return; }
    if (mode !== '1') return;
    const r = game.renderer;
    r.perf.setDetail(true);
    const names = { cinematic: 'High', balanced: 'Balanced', low: 'Low' };
    WarPerfBench.overlay = new EnginePerf.Overlay(r.perf, () => (r.qualityChoice === 'auto' ? 'Auto: ' : '') + (names[r.graphicsQuality] || r.graphicsQuality)
        + '   ' + r.canvas.width + 'x' + r.canvas.height
        + (r.renderScale && r.renderScale !== 1 ? '   x' + r.renderScale.toFixed(2) : ''));
});
