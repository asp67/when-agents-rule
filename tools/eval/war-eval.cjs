#!/usr/bin/env node
// The evaluation profile of a recorded match, from its transcript and nothing else
// (Scale v4; zero dependencies, Node 18+). The same ledger the page feeds line by
// line during a match (js/eval/ledger.js), fed here from a file.
//
//   node tools/eval/war-eval.cjs samples/<match>.jsonl            a table per match
//   node tools/eval/war-eval.cjs a.jsonl b.jsonl --json           the full profiles as JSON
//
// Scale v4 pillars: grounding (20%), macro & agency (25%), spatial (15%), tactical (15%),
// and dominance (25%), combined into the fixed-weight WAR Score. Cognitive cost (tokens
// and latency) and early-to-late drift sit beside the score, never inside it. docs/SCORING.md.
'use strict';
const fs = require('node:fs'), path = require('node:path'), readline = require('node:readline');
const WarEval = require(path.join(__dirname, '..', '..', 'js', 'eval', 'ledger.js'));

async function profileFile(file) {
    const ledger = WarEval.createLedger();
    const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of rl) ledger.addLine(line);
    return ledger.profile();
}

const pct = v => v == null ? '-' : (v * 100).toFixed(1) + ' %';
const fix = (v, d = 0) => v == null ? '-' : v.toFixed(d);
const secs = ms => ms == null ? '-' : ms < 1000 ? Math.round(ms) + ' ms' : (ms / 1000).toFixed(1) + ' s';
const signedPp = v => v == null ? '-' : (v > 0 ? '+' : '') + v.toFixed(1) + ' pp';
function table(rows) {
    const width = rows[0].map((_, c) => Math.max(...rows.map(r => String(r[c]).length)));
    return rows.map(r => r.map((v, c) => c === 0 ? String(v).padEnd(width[c]) : String(v).padStart(width[c])).join('  ')).join('\n');
}

function report(file, p) {
    const m = p.match || {}, name = s => s.name || s.model || s.id;
    const clock = sec => sec == null ? '-' : Math.floor(sec / 60) + ':' + String(Math.round(sec) % 60).padStart(2, '0');
    const out = [path.basename(file),
        'mode ' + (m.mode || 'realtime') + ', build ' + (m.build == null ? 'not recorded' : m.build)
        + ', prompt ' + (m.promptVersion || 'not recorded')
        + ', ' + p.seats.length + ' seats, ' + p.seats.reduce((n, s) => n + s.decisions, 0) + ' decisions'
        + (p.unreadable ? ', ' + p.unreadable + ' unreadable lines' : '')];
    if (p.recorded) out.push('The file carries its own profile, scale ' + p.recorded.scale + ': '
        + (WarEval.sameProfile(JSON.parse(JSON.stringify(WarEval.publicProfile(p))), p.recorded) ? 'scored again here, it is the same.'
            : 'scored again here on scale ' + p.scale + ', it differs. The numbers below are this build\'s.'));

    out.push('', table([['GROUNDING (20%)', 'score', 'valid', 'ok', 'waits', 'constraint', 'reference', 'repeated', 'contended', 'unjudged']].concat(
        p.seats.map(s => { const g = s.grounding; return [name(s), fix(g.score, 1), pct(g.rate), g.okNonWait != null ? g.okNonWait : g.ok - g.waits, g.waits, g.constraint, g.reference, g.repeated, g.contended, g.unjudged]; }))));
    if (p.seats.some(s => !s.grounding.judged && s.grounding.unjudged))
        out.push('', 'No command outcomes in this file: they are recorded from build 1023 on, so grounding cannot be read from it.');
    const worst = p.seats.filter(s => s.grounding.mistakes.length);
    if (worst.length) {
        out.push('', 'Most frequent mistakes');
        for (const s of worst) out.push('  ' + name(s) + ': ' + s.grounding.mistakes.slice(0, 4).map(x => x.code + ' ' + x.n).join(', '));
    }

    out.push('', table([['MACRO & AGENCY (25%)', 'score', 'dev', 'ops', 'agency', 'idle%', 'bw util', 'parallel@2+', 'passiveW', 'justW', '3/2/1/J/P']].concat(
        p.seats.map(s => {
            const x = s.macro || {}, b = x.batch || {};
            const dist = b.total ? [b.three, b.two, b.one, b.justified0, b.passive0].join('/') : '-';
            return [name(s), fix(x.score, 1), fix(x.devScore, 0), fix(x.opsScore, 0), fix(x.agencyScore, 0), pct(x.avgIdle), pct(x.bwUtil), pct(x.parallelRate), x.passiveWaits || 0, x.justifiedWaits || 0, dist];
        }))));

    out.push('', table([['SPATIAL & FOG (15%)', 'score', 'explored', 'rivals', 'spatial orders', 'spatial errors']].concat(
        p.seats.map(s => {
            const sp = s.spatial || {};
            return [name(s), fix(sp.score, 1), sp.maxExplored == null ? '-' : sp.maxExplored.toFixed(1) + ' %',
                sp.opponents ? (sp.discovered + '/' + sp.opponents) : '-', sp.spatialOrders || 0, sp.spatialErrors || 0];
        }))));

    out.push('', table([['TACTICAL & COMBAT (15%)', 'score', 'battles', 'destroyed', 'lost', 'razed', 'bldLost', 'homeRaids', 'atOnce', 'wonders', 'wAns']].concat(
        p.seats.map(s => {
            const ta = s.tactical || {};
            return [name(s), fix(ta.score, 1), ta.battles || 0, fix(ta.destroyed, 1), ta.unitsLost != null ? ta.unitsLost : '-', ta.bldRazed || 0, ta.bldLost || 0, ta.episodes || 0, fix(ta.atOnce), ta.wonders || 0, fix(ta.wonderAnswered)];
        }))));

    const place = g => g.rank == null ? '-' : g.rank + ' of ' + g.of;
    out.push('', table([['DOMINANCE (25%)', 'score', 'placed', 'trajDom', 'power share', 'even split', 'time ahead', 'clear lead', 'ages']].concat(
        p.seats.map(s => {
            const g = s.strategy;
            return [name(s), fix(g.score, 1), place(g), fix(g.trajDom, 1), pct(g.powerShare), pct(g.evenShare), pct(g.leadShare),
                g.clearLeadAt == null ? 'never' : 'from ' + clock(g.clearLeadAt) + (g.converted == null ? '' : g.converted ? ', won' : ', lost'),
                g.ages.map(a => a.age + ' ' + clock(a.sec)).join(', ') || '-'];
        }))));

    out.push('', table([['WAR SCORE', 'score', 'warmup', 'of', 'grounding', 'macro', 'spatial', 'tactical', 'dominance']].concat(
        p.seats.map(s => [name(s), fix(s.index.value, 1), s.warmup ? 'early' : '-', s.index.of + '/' + s.index.parts,
            fix(s.grounding.score, 1), fix(s.macro.score, 1), fix(s.spatial.score, 1), fix(s.tactical.score, 1), fix(s.strategy.score, 1)]))));

    out.push('', table([['COST & DRIFT', 'decisions', 'medLat', 'p90', 'tok/dec', 'out/ok', 'ok/think-m', 'errDrift', 'idleDrift', 'latRatio']].concat(
        p.seats.map(s => {
            const e = s.efficiency || {}, d = s.drift;
            return [name(s), s.decisions, secs(e.latencyMs && e.latencyMs.median), secs(e.latencyMs && e.latencyMs.p90),
                e.tokensPerDecision == null ? 'not reported' : fix(e.tokensPerDecision, 0),
                e.outputPerValidOrder == null ? '-' : fix(e.outputPerValidOrder, 0),
                e.effectiveOrdersPerMin == null ? '-' : fix(e.effectiveOrdersPerMin, 1),
                d ? signedPp(d.errDeltaPp) : '-', d ? signedPp(d.idleDeltaPp) : '-',
                d && d.latencyRatio != null ? d.latencyRatio.toFixed(2) + 'x' : '-'];
        }))));

    out.push('', table([['RANGE USED', 'unit types', 'buildings', 'technologies', 'kinds of order']].concat(
        p.seats.map(s => { const v = s.versatility; return [name(s), v.units.length, v.buildings.length, v.techs.length, v.orders.length]; }))));

    out.push('', 'Score scale ' + p.scale + '. Weights: 20% Grounding + 25% Macro & Agency + 15% Spatial + 15% Tactical + 25% Dominance. Warmup when < 5m and < 15 rated commands.');
    return out.join('\n');
}

async function main(argv) {
    const json = argv.includes('--json'), files = argv.filter(a => !a.startsWith('--'));
    if (!files.length || argv.includes('--help') || argv.includes('-h')) {
        console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 12).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
        process.exitCode = files.length ? 0 : 2;
        return;
    }
    const all = [];
    for (const file of files) {
        if (!fs.existsSync(file)) { console.error('No such file: ' + file); process.exitCode = 1; continue; }
        const profile = await profileFile(file);
        all.push(Object.assign({ file: path.basename(file) }, profile));
        if (!json) console.log((all.length > 1 ? '\n' : '') + report(file, profile));
    }
    if (json) console.log(JSON.stringify(files.length === 1 ? all[0] : all, null, 1));
}

if (require.main === module) main(process.argv.slice(2));
module.exports = { profileFile, report };
