// Charts to share (build 1226): a match, or a season group, as one picture.
//
// asp67's list of 22 November 2026: "Build shareable visual summaries: generate clean,
// high-contrast scatter plots (e.g. Intelligence/Win Rate vs. Speed, or Win Rate vs.
// Token Efficiency) and replayable state/heatmaps. These are highly shareable on Reddit,
// GitHub and YouTube."
//
// What this file makes is one SVG, 1600 x 900, that stands by itself: its own background,
// its own title, its own legend, the scale it was scored on and the source's address. No
// stylesheet, no font file, nothing fetched, so it reads the same pasted anywhere, and the
// page can turn it into a PNG by drawing it on a canvas.
//   - the scatter: one point a model, the score upward and what it cost to the right. A
//     round point is a raw model, a diamond an agent harness. Where a point stands for
//     several matches, a whisker runs from its lowest match to its highest: a mean is
//     never shown without its spread;
//   - the order map (a match only): where on the map each seat sent its orders, a square
//     a seat, a cell the brighter the more orders went there.
// It draws what it is given. Which numbers those are is the caller's (js/eval/bench-view.js
// for a match, js/season-page.js for a season group), and every word comes in as a label,
// so the picture is in the language of the page. No DOM here: Node tests read the SVG.
(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.WarShare = api;
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const W = 1600, H = 900;
    const FONT = "'Segoe UI', 'Helvetica Neue', Arial, sans-serif";
    const INK = { back: '#0c0f14', panel: '#141922', grid: '#2a3140', axis: '#8d97a8', text: '#f3efe2', soft: '#aeb6c4', gold: '#f2c46a' };
    const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const f1 = v => (Math.round(v * 10) / 10).toFixed(1);
    const cut = (s, n) => { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

    // How long a decision took, in seconds, for the speed axis. For a raw model it is the
    // request's own round trip. For an agent harness the game can only time "state handed
    // over" to "turn ended", and a harness that keeps working between its turns ends a turn
    // in milliseconds: in the shipped samples one harness has a median of 13 ms beside
    // answers of 100 s. That is not a thinking time, and a picture made to be passed on must
    // not show it as the fastest model: under HARNESS_MIN_MS a harness has no speed here.
    const HARNESS_MIN_MS = 1000;
    function speedOf(latencyMs, harness) {
        if (latencyMs == null || !isFinite(latencyMs) || latencyMs <= 0) return null;
        if (harness && latencyMs < HARNESS_MIN_MS) return null;
        return latencyMs / 1000;
    }

    // An axis from zero: an end at a round number at or above the largest value, and five
    // steps or so to it.
    function axis(max) {
        if (!(max > 0) || !isFinite(max)) return { top: 1, ticks: [0, 1] };
        const raw = max / 5, mag = Math.pow(10, Math.floor(Math.log10(raw))), n = raw / mag;
        const step = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
        const top = Math.ceil(max / step - 1e-9) * step, ticks = [];
        for (let v = 0; v <= top + step / 2; v += step) ticks.push(Math.round(v / mag * 1000) / 1000 * mag);
        return { top, ticks };
    }
    const tickText = v => Math.abs(v) >= 1000 ? (v / 1000).toFixed(v % 1000 ? 1 : 0) + 'k' : String(Math.round(v * 100) / 100);

    // The scatter inside a box. points: [{ name, x, y, ink, harness, lo, hi, note }]; a point
    // without an x or a y cannot be placed and is returned in `left`, to be named under the
    // plot. yTop is the scale's end (100 for a score or a share).
    function scatter(points, { x0, y0, w, h, xLabel, yLabel, yTop = 100 }) {
        const on = points.filter(p => p.x != null && isFinite(p.x) && p.y != null && isFinite(p.y)), left = points.filter(p => !on.includes(p));
        const ax = axis(Math.max(0, ...on.map(p => p.x)) * 1.08), ay = axis(yTop);
        const X = v => x0 + (v / ax.top) * w, Y = v => y0 + h - (v / ay.top) * h;
        let s = `<rect x="${x0}" y="${y0}" width="${w}" height="${h}" fill="${INK.panel}" rx="6"/>`;
        for (const v of ay.ticks) s += `<line x1="${x0}" x2="${x0 + w}" y1="${f1(Y(v))}" y2="${f1(Y(v))}" stroke="${INK.grid}" stroke-width="1"/>`
            + `<text x="${x0 - 14}" y="${f1(Y(v) + 7)}" text-anchor="end" font-size="20" fill="${INK.axis}">${tickText(v)}</text>`;
        for (const v of ax.ticks) s += `<line x1="${f1(X(v))}" x2="${f1(X(v))}" y1="${y0}" y2="${y0 + h}" stroke="${INK.grid}" stroke-width="1"/>`
            + `<text x="${f1(X(v))}" y="${y0 + h + 30}" text-anchor="middle" font-size="20" fill="${INK.axis}">${tickText(v)}</text>`;
        s += `<text x="${x0 + w / 2}" y="${y0 + h + 68}" text-anchor="middle" font-size="24" fill="${INK.soft}">${esc(xLabel)}</text>`
            + `<text transform="translate(${x0 - 74} ${y0 + h / 2}) rotate(-90)" text-anchor="middle" font-size="24" fill="${INK.soft}">${esc(yLabel)}</text>`;
        // Labels: beside their point, to its left where the right edge is near, and pushed
        // apart where two would lie on each other.
        const placed = on.map(p => ({ p, px: X(p.x), py: Y(p.y) })).sort((a, b) => a.py - b.py || a.px - b.px);
        const labels = [];
        for (const q of placed) {
            const leftSide = q.px > x0 + w - 300;
            let ly = q.py + 8;
            for (const o of labels) if (Math.abs(o.ly - ly) < 30 && Math.abs(o.px - q.px) < 320 && o.leftSide === leftSide) ly = o.ly + 30;
            labels.push({ px: q.px, ly, leftSide });
            q.ly = Math.min(y0 + h - 8, ly); q.leftSide = leftSide;
        }
        for (const q of placed) {
            const p = q.p, ink = p.ink || '#cccccc', r = 15;
            // From the lowest match to the highest, where the point is a mean of several.
            if (p.lo != null && p.hi != null && p.hi > p.lo) s += `<line class="whisker" x1="${f1(q.px)}" x2="${f1(q.px)}" y1="${f1(Y(p.lo))}" y2="${f1(Y(p.hi))}" stroke="${ink}" stroke-width="4" opacity="0.75"/>`
                + `<line x1="${f1(q.px - 9)}" x2="${f1(q.px + 9)}" y1="${f1(Y(p.lo))}" y2="${f1(Y(p.lo))}" stroke="${ink}" stroke-width="4" opacity="0.75"/>`
                + `<line x1="${f1(q.px - 9)}" x2="${f1(q.px + 9)}" y1="${f1(Y(p.hi))}" y2="${f1(Y(p.hi))}" stroke="${ink}" stroke-width="4" opacity="0.75"/>`;
            s += p.harness
                ? `<path class="pt is-harness" d="M${f1(q.px)} ${f1(q.py - r - 3)}L${f1(q.px + r + 3)} ${f1(q.py)}L${f1(q.px)} ${f1(q.py + r + 3)}L${f1(q.px - r - 3)} ${f1(q.py)}Z" fill="${ink}" stroke="#ffffff" stroke-width="3"/>`
                : `<circle class="pt is-raw" cx="${f1(q.px)}" cy="${f1(q.py)}" r="${r}" fill="${ink}" stroke="#ffffff" stroke-width="3"/>`;
            const tx = q.leftSide ? q.px - 26 : q.px + 26, anchor = q.leftSide ? 'end' : 'start';
            s += `<text x="${f1(tx)}" y="${f1(q.ly)}" text-anchor="${anchor}" font-size="24" font-weight="600" fill="${INK.text}" stroke="${INK.panel}" stroke-width="5" paint-order="stroke">${esc(cut(p.name, 30))}`
                + (p.note ? `<tspan font-size="18" font-weight="400" fill="${INK.soft}"> ${esc(p.note)}</tspan>` : '') + '</text>';
        }
        return { svg: s, left, xTop: ax.top };
    }

    // Where a seat's orders went: an n x n grid over the map. orders: [{ x, z }] in world
    // units with the map's middle at 0; size is the map's side.
    function grid(orders, size, n = 14) {
        const cells = new Array(n * n).fill(0);
        let most = 0, placed = 0;
        if (!(size > 0)) return { n, cells, most, placed };
        for (const o of orders || []) {
            if (o.x == null || o.z == null) continue;
            const cx = Math.floor((o.x + size / 2) / size * n), cz = Math.floor((o.z + size / 2) / size * n);
            if (cx < 0 || cz < 0 || cx >= n || cz >= n) continue;
            const v = ++cells[cz * n + cx];
            placed++;
            if (v > most) most = v;
        }
        return { n, cells, most, placed };
    }
    function heat(seats, { x0, y0, w, h, title, none }) {
        let s = `<text x="${x0}" y="${y0 + 22}" font-size="24" fill="${INK.soft}">${esc(title)}</text>`;
        const cols = seats.length <= 1 ? 1 : seats.length <= 4 ? 2 : 3, rows = Math.ceil(seats.length / cols), gap = 26;
        const side = Math.floor(Math.min((w - gap * (cols - 1)) / cols, (h - 44 - rows * 34 - gap * (rows - 1)) / rows));
        seats.forEach((seat, i) => {
            const gx = x0 + (i % cols) * (side + gap), gy = y0 + 44 + Math.floor(i / cols) * (side + gap + 34), g = seat.grid, c = side / g.n;
            s += `<text x="${gx}" y="${gy + 20}" font-size="20" font-weight="600" fill="${esc(seat.ink || INK.text)}">${esc(cut(seat.name, Math.max(8, Math.floor(side / 12))))}</text>`
                + `<rect x="${gx}" y="${gy + 30}" width="${side}" height="${side}" fill="${INK.panel}" stroke="${INK.grid}" stroke-width="2"/>`;
            if (!g.most) { s += `<text x="${gx + side / 2}" y="${gy + 30 + side / 2 + 6}" text-anchor="middle" font-size="18" fill="${INK.axis}">${esc(none)}</text>`; return; }
            for (let k = 0; k < g.cells.length; k++) {
                if (!g.cells[k]) continue;
                s += `<rect class="cell" x="${f1(gx + (k % g.n) * c)}" y="${f1(gy + 30 + Math.floor(k / g.n) * c)}" width="${f1(c)}" height="${f1(c)}" fill="${esc(seat.ink || '#cccccc')}" opacity="${(0.22 + 0.78 * g.cells[k] / g.most).toFixed(2)}"/>`;
            }
        });
        return s;
    }

    // The picture. spec: { title, sub, x: label, y: label, yTop, points, heat: { title, none,
    // seats: [{ name, ink, grid }] } | null, legend: { raw, harness, whisker }, notShown:
    // label for points that could not be placed, foot: [left, right] }.
    function card(spec) {
        const withHeat = !!(spec.heat && spec.heat.seats && spec.heat.seats.length);
        const plot = scatter(spec.points || [], { x0: 150, y0: 170, w: withHeat ? 850 : 1370, h: 560, xLabel: spec.x, yLabel: spec.y, yTop: spec.yTop || 100 });
        const any = (spec.points || []).length - plot.left.length;
        const L = spec.legend || {}, hasHarness = (spec.points || []).some(p => p.harness), hasRaw = (spec.points || []).some(p => !p.harness), hasWhisker = (spec.points || []).some(p => p.lo != null && p.hi != null && p.hi > p.lo);
        let leg = '', lx = 150;
        const item = (mark, text) => { leg += mark(lx) + `<text x="${lx + 30}" y="141" font-size="20" fill="${INK.soft}">${esc(text)}</text>`; lx += 54 + String(text).length * 11; };
        if (L.raw && hasRaw) item(x => `<circle cx="${x + 12}" cy="134" r="9" fill="${INK.soft}" stroke="#ffffff" stroke-width="2"/>`, L.raw);
        if (L.harness && hasHarness) item(x => `<path d="M${x + 12} 122L${x + 24} 134L${x + 12} 146L${x} 134Z" fill="${INK.soft}" stroke="#ffffff" stroke-width="2"/>`, L.harness);
        if (L.whisker && hasWhisker) item(x => `<line x1="${x + 12}" x2="${x + 12}" y1="121" y2="147" stroke="${INK.soft}" stroke-width="4"/><line x1="${x + 4}" x2="${x + 20}" y1="121" y2="121" stroke="${INK.soft}" stroke-width="4"/><line x1="${x + 4}" x2="${x + 20}" y1="147" y2="147" stroke="${INK.soft}" stroke-width="4"/>`, L.whisker);
        const missing = plot.left.length && spec.notShown ? `<text x="150" y="826" font-size="18" fill="${INK.axis}">${esc(spec.notShown + ' ' + plot.left.map(p => p.name).join(', '))}</text>` : '';
        const foot = spec.foot || [];
        return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="${FONT}">`
            + `<rect width="${W}" height="${H}" fill="${INK.back}"/>`
            + `<rect width="${W}" height="8" fill="${INK.gold}"/>`
            + `<text x="60" y="68" font-size="42" font-weight="700" fill="${INK.text}">${esc(cut(spec.title, 70))}</text>`
            + `<text x="60" y="104" font-size="22" fill="${INK.soft}">${esc(cut(spec.sub, 150))}</text>`
            + leg + (any || !spec.empty ? plot.svg : `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" font-size="28" fill="${INK.soft}">${esc(spec.empty)}</text>`) + missing
            + (withHeat ? heat(spec.heat.seats, { x0: 1060, y0: 148, w: 480, h: 640, title: spec.heat.title, none: spec.heat.none }) : '')
            + `<line x1="60" x2="${W - 60}" y1="846" y2="846" stroke="${INK.grid}" stroke-width="1"/>`
            + `<text x="60" y="876" font-size="20" fill="${INK.soft}">${esc(cut(foot[0], 90))}</text>`
            + `<text x="${W - 60}" y="876" text-anchor="end" font-size="20" fill="${INK.axis}">${esc(cut(foot[1], 110))}</text>`
            + '</svg>';
    }

    return { W, H, INK, HARNESS_MIN_MS, speedOf, axis, scatter, grid, heat, card };
});
