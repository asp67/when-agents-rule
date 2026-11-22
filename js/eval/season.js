// The season table (overhaul step C7): a model's evaluation profile across matches.
//
// One match is one sample. This file adds matches up, and only where adding is allowed:
//   - a seat's result joins the results of other seats with the SAME declared conditions
//     (WarConditions: core hash, contract family, rules, protocol) and the same scoring
//     scale. Everything else forms its own group, and groups are never mixed;
//   - a seat whose conditions were not recorded is listed and compared with nothing;
//   - a mean comes with its 95 % interval (Student's t over matches). One match has no
//     interval, and nothing is called ahead of anything unless both have at least two
//     matches and their intervals do not touch. A single match never makes a leader.
//
// Beside the means: head to head (who placed above whom when two models met), and paired
// differences for seat-swapped rematches. A swapped pair is two matches on the same map
// seed with the same civilization in every seat, in which two models traded seats. The
// mean of their difference over the two matches no longer contains what a seat, a spawn
// or a civilization was worth.
//
// An entry is what a match contributes: who sat where under which conditions, how each
// placed, and each model seat's scores. Built from a transcript (entryOf) or from the
// lines a finished match is about to write (entryFrom). No DOM, no storage: the page
// (js/season-page.js) and the command line (tools/eval/season.cjs) both stand on this.
(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.WarSeason = api;
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const PARTS = ['grounding', 'planning', 'follow', 'tactical', 'strategy', 'index'];
    // Two-sided 95 % points of Student's t, by degrees of freedom 1..30; beyond, 1.96.
    const T95 = [12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.160, 2.145, 2.131,
        2.120, 2.110, 2.101, 2.093, 2.086, 2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045, 2.042];
    const r1 = v => Math.round(v * 10) / 10;

    // The mean of some matches' scores with its interval. One value: a mean and no interval.
    // A score lives between 0 and 100 and a difference of two between -100 and 100; the
    // interval is cut there, since nothing outside can be the truth.
    function interval(values, lowest = 0, highest = 100) {
        const v = values.filter(x => typeof x === 'number' && isFinite(x)), n = v.length;
        if (!n) return { mean: null, lo: null, hi: null, n: 0, sd: null };
        const mean = v.reduce((a, b) => a + b, 0) / n;
        if (n < 2) return { mean: r1(mean), lo: null, hi: null, n, sd: null };
        const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (n - 1));
        const half = (T95[n - 2] || 1.96) * sd / Math.sqrt(n);
        return { mean: r1(mean), lo: r1(Math.max(lowest, mean - half)), hi: r1(Math.min(highest, mean + half)), n, sd: r1(sd) };
    }
    // Every match's value beside the mean (build 1225; asp67's list of 22 November 2026:
    // "Show variance, not just averages ... min/max/median. This prevents cherry-picked
    // highlights"): the lowest, the median and the highest match, and the values themselves
    // in the order they were played, so a mean cannot hide the one good match it rests on.
    function spread(values) {
        const v = values.filter(x => typeof x === 'number' && isFinite(x)), n = v.length;
        if (!n) return { n: 0, min: null, median: null, max: null, values: [] };
        const s = v.slice().sort((a, b) => a - b), mid = n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
        return { n, min: r1(s[0]), median: r1(mid), max: r1(s[n - 1]), values: v.map(r1) };
    }
    // Are two means apart? Only with an interval on both sides, and only if they do not touch.
    function separated(a, b) {
        return !!a && !!b && a.n >= 2 && b.n >= 2 && (a.lo > b.hi || b.lo > a.hi);
    }
    // A difference with its interval: apart from zero only if the interval excludes it.
    const apartFromZero = d => !!d && d.n >= 2 && (d.lo > 0 || d.hi < 0);

    const modelKey = s => String(s.name || '') + '\u0000' + String(s.model || '');

    // What one seat contributes, from its public profile.
    function seatOf(p, { rank, of, winner, cond, protocol, core, via }) {
        const e = p.efficiency || {}, ta = p.tactical || {}, g = p.grounding || {};
        return { id: p.id, seat: p.seat == null ? null : p.seat, civ: p.civ || null, name: p.name || null, model: p.model || null,
            // Who played the seat (build 1225): 'raw' for the model's own answers, 'harness' or
            // 'harness:<name>' for an agent framework over MCP, null where the file does not say.
            via: via || null,
            rank: rank == null ? null : rank, of: of == null ? null : of, winner: !!winner,
            cond: cond || null, protocol: protocol || null, core: core || null,
            decisions: p.decisions || 0,
            scores: { grounding: g.score, planning: p.planning.score, follow: p.follow.score, tactical: ta.score,
                strategy: p.strategy.score, index: p.index ? p.index.value : null },
            counts: { rated: g.rated == null ? null : g.rated, threats: (ta.episodes || 0) + (ta.wonders || 0), parts: p.index ? p.index.of : null },
            latencyMs: e.latencyMs ? e.latencyMs.median : null };
    }

    // An entry from the lines of a match: its header, its contract, its results (with the
    // ranking) and the public profile. `conditions` is WarConditions, the one rule.
    function entryFrom({ header, contract, results, profile, source = null, file = null }, { conditions }) {
        if (!header || !profile || !Array.isArray(profile.seats)) return null;
        const ranking = (results && Array.isArray(results.ranking)) ? results.ranking : [];
        const players = Array.isArray(header.players) ? header.players : [];
        const seats = profile.seats.map(p => {
            const row = ranking.find(r => r.playerId === p.id) || {};
            const c = conditions ? conditions.seat(header, contract, p.id) : null;
            const set = (players.find(x => x && x.id === p.id) || {}).settings;
            const via = !set || typeof set !== 'object' ? null : !set.harnessExternal ? 'raw' : 'harness' + (set.harness && set.harness !== 'other' ? ':' + set.harness : '');
            return seatOf(p, { via, rank: row.rank, of: ranking.length || null, winner: row.isWinner,
                cond: conditions ? conditions.id(c) : null, protocol: conditions ? conditions.protocolOf(header) : null,
                core: contract && contract.coreHash ? String(contract.coreHash).slice(0, 12) : null });
        });
        if (!seats.length) return null;
        return { v: 1, scale: profile.scale || null, matchId: header.matchId || null, at: header.startedAt || null,
            build: header.build == null ? null : header.build, promptVersion: header.promptVersion || null,
            mapSeed: header.mapSeed == null ? null : String(header.mapSeed), mapSize: header.mapSize || null,
            duration: (results && results.duration) || null, outcome: (results && results.outcome) || null,
            // Which civilization sat in which seat: with the map seed, what a rematch must share.
            layout: players.slice().sort((a, b) => (a.seat || 0) - (b.seat || 0)).map(p => p.civ || p.civilization || '?').join(','),
            players: players.length || ranking.length || seats.length, source, file, seats };
    }

    // An entry from a transcript's text, scored by this build. `evaluator` is WarEval.
    function entryOf(text, { evaluator, conditions, source = null, file = null }) {
        let header = null, contract = null, results = null, seen = 0;
        // The three lines wanted are the first two and one of the last few: the long
        // lines between (every turn's state) are not parsed a second time here.
        const lines = String(text || '').split('\n');
        for (let i = 0; i < lines.length && i < 8; i++) {
            if (!lines[i].startsWith('{"type":"match"') && !lines[i].startsWith('{"type":"contract"')) continue;
            try { const o = JSON.parse(lines[i]); if (o.type === 'match') header = o; else contract = o; } catch (e) { /* not this line */ }
        }
        for (let i = lines.length - 1; i >= 0 && seen < 12; i--) {
            if (!lines[i]) continue;
            seen++;
            if (!lines[i].startsWith('{"type":"results"')) continue;
            try { results = JSON.parse(lines[i]); } catch (e) { /* cut off */ }
            break;
        }
        if (!header) {
            // A file whose header is not its first line, or whose keys are in another order.
            for (const l of lines) {
                if (l.indexOf('"type"') < 0 || l.length > 200000) continue;
                let o; try { o = JSON.parse(l); } catch (e) { continue; }
                if (o.type === 'match' && !header) header = o;
                else if (o.type === 'contract' && !contract) contract = o;
                else if (o.type === 'results') results = o;
            }
        }
        if (!header) return null;
        return entryFrom({ header, contract, results, profile: evaluator.publicProfile(evaluator.profileOf(text)), source, file }, { conditions });
    }

    // Two matches are a seat-swapped pair for models a and b when the map, the
    // civilizations per seat and the players are the same, and a and b traded seats.
    function swapped(x, y, a, b) {
        if (!x.e.mapSeed || x.e.mapSeed !== y.e.mapSeed || x.e.layout !== y.e.layout || x.e.players !== y.e.players) return false;
        const xa = x.by.get(a), xb = x.by.get(b), ya = y.by.get(a), yb = y.by.get(b);
        return !!(xa && xb && ya && yb) && xa.seat != null && xb.seat != null && xa.seat === yb.seat && xb.seat === ya.seat && xa.seat !== xb.seat;
    }

    // Everything the table shows, from a list of entries. A match counted once, by its id.
    function table(entries) {
        const seen = new Set(), groups = new Map(), unrecorded = [], alone = [];
        let matches = 0;
        for (const e of entries || []) {
            if (!e || !Array.isArray(e.seats)) continue;
            const mid = e.matchId || (e.file ? 'file:' + e.file : null);
            if (mid && seen.has(mid)) continue;
            if (mid) seen.add(mid);
            matches++;
            for (const s of e.seats) {
                if (!s.cond) { unrecorded.push({ matchId: e.matchId, at: e.at, build: e.build, name: s.name, model: s.model, rank: s.rank, of: s.of, scores: s.scores, source: e.source }); continue; }
                const gid = s.cond + '/' + (e.scale || '?');
                let g = groups.get(gid);
                if (!g) groups.set(gid, g = { id: s.cond, scale: e.scale || null, protocol: s.protocol, core: s.core, builds: new Set(), prompts: new Set(), in: new Map() });
                if (e.build != null) g.builds.add(e.build);
                if (e.promptVersion) g.prompts.add(e.promptVersion);
                let m = g.in.get(mid || e);
                if (!m) g.in.set(mid || e, m = { e, by: new Map() });
                m.by.set(modelKey(s), s);          // one seat of a model per match; a second one replaces it in the pairings only
                (m.all || (m.all = [])).push(s);
            }
        }
        const out = [];
        for (const g of groups.values()) {
            const models = new Map();
            // In the order the matches were played, so the values and the places read as a history.
            const played = [...g.in.values()].sort((x, y) => (x.e.at || 0) - (y.e.at || 0));
            for (const m of played) for (const s of m.all) {
                const k = modelKey(s);
                let row = models.get(k);
                if (!row) models.set(k, row = { key: k, name: s.name, model: s.model, via: null, values: {}, matches: 0, firsts: 0, ranks: [] });
                row.matches++;
                if (row.via == null && s.via) row.via = s.via;
                if (s.rank === 1) row.firsts++;
                if (s.rank != null) row.ranks.push({ rank: s.rank, of: s.of == null ? null : s.of });
                for (const p of PARTS) if (s.scores[p] != null) (row.values[p] || (row.values[p] = [])).push(s.scores[p]);
            }
            const rows = [...models.values()].map(r => ({ key: r.key, name: r.name, model: r.model, via: r.via, matches: r.matches, firsts: r.firsts,
                // Every placement, oldest first: "first place twice" beside the two matches it finished last in.
                places: r.ranks,
                parts: Object.fromEntries(PARTS.map(p => [p, interval(r.values[p] || [])])),
                spread: Object.fromEntries(PARTS.map(p => [p, spread(r.values[p] || [])])) }));
            rows.sort((a, b) => (b.parts.index.mean == null ? -1 : b.parts.index.mean) - (a.parts.index.mean == null ? -1 : a.parts.index.mean) || String(a.name).localeCompare(String(b.name)));
            // Ahead on a part: apart from EVERY other model that has a value there.
            const leaders = {};
            for (const p of PARTS) {
                const have = rows.filter(r => r.parts[p].mean != null);
                const top = have.length > 1 ? have.find(r => have.every(o => o === r || (separated(r.parts[p], o.parts[p]) && r.parts[p].mean > o.parts[p].mean))) : null;
                leaders[p] = top ? top.key : null;
            }
            // Head to head: every pair of models that sat in the same match.
            const meets = new Map(), list = [...g.in.values()];
            for (const m of list) {
                const ks = [...m.by.keys()].sort();
                for (let i = 0; i < ks.length; i++) for (let j = i + 1; j < ks.length; j++) {
                    const a = m.by.get(ks[i]), b = m.by.get(ks[j]);
                    if (a.rank == null || b.rank == null) continue;
                    const id = ks[i] + '\u0001' + ks[j];
                    let h = meets.get(id);
                    if (!h) meets.set(id, h = { a: ks[i], b: ks[j], met: 0, aAhead: 0, bAhead: 0 });
                    h.met++;
                    if (a.rank < b.rank) h.aAhead++; else if (b.rank < a.rank) h.bAhead++;
                }
            }
            // Seat-swapped rematches: each match in at most one pair per two models, oldest first.
            list.sort((x, y) => (x.e.at || 0) - (y.e.at || 0));
            const swaps = [];
            for (const h of meets.values()) {
                const used = new Set(), diffs = Object.fromEntries(PARTS.map(p => [p, []]));
                let pairs = 0;
                for (let i = 0; i < list.length; i++) {
                    if (used.has(i)) continue;
                    for (let j = i + 1; j < list.length; j++) {
                        if (used.has(j) || !swapped(list[i], list[j], h.a, h.b)) continue;
                        used.add(i); used.add(j); pairs++;
                        for (const p of PARTS) {
                            const d = [list[i], list[j]].map(m => { const a = m.by.get(h.a).scores[p], b = m.by.get(h.b).scores[p]; return a == null || b == null ? null : a - b; });
                            if (d[0] != null && d[1] != null) diffs[p].push((d[0] + d[1]) / 2);
                        }
                        break;
                    }
                }
                if (pairs) swaps.push({ a: h.a, b: h.b, pairs, diff: Object.fromEntries(PARTS.map(p => [p, interval(diffs[p], -100, 100)])) });
            }
            // One model in one match under conditions nobody else shared: nothing to add up
            // and nothing to compare. Listed together, not as a table each.
            if (rows.length === 1 && g.in.size === 1) {
                const m = [...g.in.values()][0], s = m.all[0];
                alone.push({ cond: g.id, scale: g.scale, protocol: g.protocol, matchId: m.e.matchId, at: m.e.at, build: m.e.build, name: s.name, model: s.model,
                    rank: s.rank, of: s.of, scores: s.scores, source: m.e.source });
                continue;
            }
            out.push({ id: g.id, scale: g.scale, protocol: g.protocol, core: g.core, builds: [...g.builds].sort((a, b) => a - b), prompts: [...g.prompts].sort(),
                matches: g.in.size, models: rows, leaders, headToHead: [...meets.values()], swaps });
        }
        // The groups with the most to compare first.
        out.sort((a, b) => b.matches - a.matches || b.models.length - a.models.length || String(a.id).localeCompare(String(b.id)));
        unrecorded.sort((a, b) => (a.at || 0) - (b.at || 0));
        alone.sort((a, b) => (a.at || 0) - (b.at || 0));
        return { kind: 'war-season/1', matches, groups: out, alone, unrecorded };
    }

    const label = key => { const [name, model] = String(key).split('\u0000'); return name || model || '?'; };

    return { VERSION: 1, PARTS, interval, spread, separated, apartFromZero, modelKey, label, entryFrom, entryOf, table };
});
