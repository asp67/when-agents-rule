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
// tactical response (is the next order aimed at a threat it was shown) and strategy (does
// its play turn into winning); beside them, the range it used and efficiency (what a
// decision cost). Over the scored parts an Index, their plain mean. docs/SCORING.md.
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
        + (p.unreadable ? ', ' + p.unreadable + ' unreadable lines' : '')];
    // A file from build 1162 on carries the profile it was shown with. Scored again here,
    // it should say the same; where it does not, the scoring has changed since.
    if (p.recorded) out.push('The file carries its own profile, scale ' + p.recorded.scale + ': '
        + (WarEval.sameProfile(JSON.parse(JSON.stringify(WarEval.publicProfile(p))), p.recorded) ? 'scored again here, it is the same.'
            : 'scored again here on scale ' + p.scale + ', it differs. The numbers below are this build\'s.'));
    out.push('');
    out.push(table([['GROUNDING', 'score', 'valid', 'ok', 'of which waits', 'avoidable', 'invalid', 'repeated', 'contended', 'not judged']].concat(
        p.seats.map(s => { const g = s.grounding; return [name(s), fix(g.score, 0), pct(g.rate), g.ok, g.waits, g.avoidable, g.invalid, g.repeated, g.contended, g.unjudged]; }))));
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
    out.push('', table([['FOLLOW-THROUGH', 'score', 'steps followed', 'carried out', 'of which late', 'in part', 'dropped', 'open', 'decisions to act', 'commitments met', 'orders serving the plan']].concat(
        p.seats.map(s => { const h = s.follow; return [name(s), fix(h.score, 0), h.steps, fix(h.acted), fix(h.late), fix(h.part), fix(h.dropped), fix(h.pending),
            fix(h.decisionsToAct, 1), of(h.commitmentsMet, h.commitments), of(h.ordersServing, h.ordersUnderPlan)]; }))));
    const r = WarEval.READER.heldOut;
    out.push('', 'A step is followed if it is new and names something checkable; acted on means an order that worked carried it out, within '
        + WarEval.FOLLOW_WINDOW + ' decisions or later while it still stood in the plan (late).',
        'Dropped: taken out of the plan with no order behind it, or left undone when the match ended. Open: still standing in the plan.',
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
    const place = g => g.rank == null ? '-' : g.rank + ' of ' + g.of;
    out.push('', table([['STRATEGY', 'score', 'placed', 'share of power', 'even split', 'time ahead', 'clear lead', 'battles', 'destroyed : lost', 'ages reached']].concat(
        p.seats.map(s => { const g = s.strategy; return [name(s), fix(g.score, 0), place(g), pct(g.powerShare), pct(g.evenShare), pct(g.leadShare),
            g.clearLeadAt == null ? 'never' : 'from ' + clock(g.clearLeadAt) + (g.converted == null ? '' : g.converted ? ', won' : ', not won'),
            g.battles, g.destroyed + ' : ' + g.lost, g.ages.map(a => a.age + ' ' + clock(a.sec)).join(', ') || '-']; }))));
    out.push('', 'Strategy is the mean of placement, share of power against an even split (half again as much is full marks) and the share of battle losses that were',
        'the other side\'s. A clear lead is ' + WarEval.LEAD_FACTOR + ' times the next seat\'s power held for ' + WarEval.LEAD_SECONDS + ' seconds. Power is the game\'s own power score, unchanged.');
    out.push('', table([['RANGE USED', 'unit types', 'buildings', 'technologies', 'kinds of order']].concat(
        p.seats.map(s => { const v = s.versatility; return [name(s), v.units.length, v.buildings.length, v.techs.length, v.orders.length]; }))));
    out.push('', 'Used with success. Facts, not a score: range counts for nothing until it can be tied to where it helped.');
    out.push('', table([['EFFICIENCY', 'decisions', 'latency median', 'p90', 'tokens in', 'out', 'out per ok command', 'commands per decision', 'missed rounds']].concat(
        p.seats.map(s => { const e = s.efficiency, t = e.tokens; return [name(s), s.decisions, secs(e.latencyMs && e.latencyMs.median), secs(e.latencyMs && e.latencyMs.p90),
            t ? fix(t.promptMedian) : 'not reported', t ? fix(t.completionMedian) : '-', t ? fix(t.completionPerOk) : '-', fix(e.commandsPerDecision, 2), e.missedRounds]; }))));
    out.push('', table([['INDEX', 'mean', 'of', 'grounding', 'plan as followed', 'tactical', 'strategy']].concat(
        p.seats.map(s => [name(s), fix(s.index.value, 1), s.index.of + ' parts', fix(s.grounding.score, 0), fix(s.index.plan, 0), fix(s.tactical.score, 0), fix(s.strategy.score, 0)]))));
    out.push('', 'The Index is the mean of the parts that have a score. A plan counts as far as it was followed: planning times follow-through, as one part.',
        'One match is one sample: compare models on the parts, over several matches.');
    out.push('', 'Score scale ' + p.scale + ': provisional. valid = ok of ok + avoidable + invalid, with waits left out (a wait can never be refused);',
        'contended commands are left out of both.');
    return out.join('\n');
}

async function main(argv) {
    const json = argv.includes('--json'), files = argv.filter(a => !a.startsWith('--'));
    if (!files.length || argv.includes('--help') || argv.includes('-h')) {
        console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 13).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
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
