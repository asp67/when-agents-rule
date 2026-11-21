#!/usr/bin/env node
// The evaluation profile of a recorded match, from its transcript and nothing else
// (overhaul step C1; zero dependencies, Node 18+). The same ledger the page feeds line by
// line during a match (js/eval/ledger.js), fed here from a file.
//
//   node tools/eval/war-eval.cjs samples/<match>.jsonl            a table per match
//   node tools/eval/war-eval.cjs a.jsonl b.jsonl --json           the full profiles as JSON
//
// Reported so far: grounding (were the commands valid when issued), planning (a live,
// concrete plan, restated after a shock), follow-through (does it do what its plan says),
// tactical response (is the next order aimed at a threat it was shown) and, beside them,
// efficiency (what a decision cost). Strategy and versatility follow in a later step.
'use strict';
const fs = require('node:fs'), path = require('node:path'), readline = require('node:readline');
const WarEval = require(path.join(__dirname, '..', '..', 'js', 'eval', 'ledger.js'));

// Line by line, as the lines would land in a match: a 12 MB file never sits in memory whole.
async function profileFile(file) {
    const ledger = WarEval.createLedger();
    const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of rl) ledger.addLine(line);
    return ledger.profile();
}

const pct = v => v == null ? '-' : (v * 100).toFixed(1) + ' %';
const fix = (v, d = 0) => v == null ? '-' : v.toFixed(d);
const secs = ms => ms == null ? '-' : ms < 1000 ? Math.round(ms) + ' ms' : (ms / 1000).toFixed(1) + ' s';
function table(rows) {
    const width = rows[0].map((_, c) => Math.max(...rows.map(r => String(r[c]).length)));
    return rows.map(r => r.map((v, c) => c === 0 ? String(v).padEnd(width[c]) : String(v).padStart(width[c])).join('  ')).join('\n');
}

function report(file, p) {
    const m = p.match || {}, name = s => s.name || s.model || s.id;
    const out = [path.basename(file),
        'build ' + (m.build == null ? 'not recorded' : m.build) + ', prompt ' + (m.promptVersion || 'not recorded')
        + ', ' + p.seats.length + ' seats, ' + p.seats.reduce((n, s) => n + s.decisions, 0) + ' decisions'
        + (p.unreadable ? ', ' + p.unreadable + ' unreadable lines' : ''), ''];
    out.push(table([['GROUNDING', 'score', 'valid', 'ok', 'avoidable', 'invalid', 'repeated', 'contended', 'not judged']].concat(
        p.seats.map(s => { const g = s.grounding; return [name(s), fix(g.score, 0), pct(g.rate), g.ok, g.avoidable, g.invalid, g.repeated, g.contended, g.unjudged]; }))));
    if (p.seats.some(s => !s.grounding.judged && s.grounding.unjudged))
        out.push('', 'No command outcomes in this file: they are recorded from build 1023 on, so grounding cannot be read from it.');
    const worst = p.seats.filter(s => s.grounding.mistakes.length);
    if (worst.length) {
        out.push('', 'Most frequent mistakes');
        for (const s of worst) out.push('  ' + name(s) + ': ' + s.grounding.mistakes.slice(0, 4).map(x => x.code + ' ' + x.n).join(', '));
    }
    const clock = sec => sec == null ? '-' : Math.floor(sec / 60) + ':' + String(Math.round(sec) % 60).padStart(2, '0');
    out.push('', table([['PLANNING', 'score', 'plan stated', 'changed', 'first plan', 'decisions under a plan', 'checkable steps', 'restated after a shock']].concat(
        p.seats.map(s => { const g = s.planning; return [name(s), fix(g.score, 0), g.statements, g.revisions,
            g.firstAt ? clock(g.firstAt.sec) + ' (decision ' + g.firstAt.decision + ')' : 'never', pct(g.coverage),
            g.steps ? g.concrete + ' of ' + g.steps : '-', g.shocks.n ? g.shocks.revised + ' of ' + g.shocks.n : 'no shock']; }))));
    const of = (a, b) => a == null ? '-' : a + ' of ' + b;
    out.push('', table([['FOLLOW-THROUGH', 'score', 'steps followed', 'acted on', 'dropped', 'of which late', 'pending', 'decisions to act', 'commitments met', 'orders serving the plan']].concat(
        p.seats.map(s => { const h = s.follow; return [name(s), fix(h.score, 0), h.steps, fix(h.acted), fix(h.dropped), fix(h.late), fix(h.pending),
            fix(h.decisionsToAct, 1), of(h.commitmentsMet, h.commitments), of(h.ordersServing, h.ordersUnderPlan)]; }))));
    const r = WarEval.READER.heldOut;
    out.push('', 'A step is followed if it is new and names something checkable; acted on means an order that worked carried it out within '
        + WarEval.FOLLOW_WINDOW + ' decisions.',
        'The step reader, on ' + r.steps + ' steps read by hand that it was never adjusted against: ' + pct(r.precision) + ' of what it reports is in the step, and it finds '
        + pct(r.recall) + ' of what is.');
    out.push('', table([['TACTICAL RESPONSE', 'score', 'attacks shown', 'answered at once', 'within 3 decisions', 'cost a building', 'held', 'rival Wonders', 'attacked']].concat(
        p.seats.map(s => { const g = s.tactical; return [name(s), fix(g.score, 0), g.episodes, fix(g.atOnce), fix(g.answered), fix(g.lost), fix(g.held), g.wonders, fix(g.wonderAnswered)]; }))));
    out.push('', 'An answer is an order that worked and is aimed at the threat: an attack or a march to it, the threatened units moved out, a tower or a repair there.',
        'Training more soldiers is not one. A seat that was shown no threat has no score.');
    const shown = p.seats.filter(s => s.tactical.list.length);
    if (shown.length) {
        out.push('', 'Threats, at the moment each seat was first shown them');
        for (const s of shown) out.push('  ' + name(s) + ': ' + s.tactical.list.map(e => clock(e.sec) + ' #' + e.turn + ' ' + (e.kind === 'wonder' ? 'rival Wonder' : e.what.join('+'))
            + (e.answeredAfter == null ? ' (no answer' : e.answeredAfter === 0 ? ' (answered' : ' (answered ' + e.answeredAfter + ' later')
            + (e.outcome === 'lost' ? ', lost)' : ')')).join(', '));
        out.push('  #n is the n-th decision of that seat: ?match=' + ((p.match && p.match.matchId) || '<match id>') + '&seat=<seat number>&turn=<n> opens it in the analyzer.');
    }
    out.push('', table([['EFFICIENCY', 'decisions', 'latency median', 'p90', 'tokens in', 'out', 'out per ok command', 'commands per decision', 'missed rounds']].concat(
        p.seats.map(s => { const e = s.efficiency, t = e.tokens; return [name(s), s.decisions, secs(e.latencyMs && e.latencyMs.median), secs(e.latencyMs && e.latencyMs.p90),
            t ? fix(t.promptMedian) : 'not reported', t ? fix(t.completionMedian) : '-', t ? fix(t.completionPerOk) : '-', fix(e.commandsPerDecision, 2), e.missedRounds]; }))));
    out.push('', 'Score scale ' + p.scale + ': provisional. valid = ok of ok + avoidable + invalid; contended commands are left out of both.');
    return out.join('\n');
}

async function main(argv) {
    const json = argv.includes('--json'), files = argv.filter(a => !a.startsWith('--'));
    if (!files.length || argv.includes('--help') || argv.includes('-h')) {
        console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 11).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
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
