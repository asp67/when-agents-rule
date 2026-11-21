#!/usr/bin/env node
// Anchor seats for the evaluation profile (overhaul step C6; zero dependencies, Node 18+).
//
// What do the scorers give a seat that cannot play? Four such seats, each alone against
// the rule-based brain on the arena's own start path, in the reference realm:
//   do-nothing    answers every round with no command at all
//   wait-only     one `wait` a round: always valid, never anything else
//   plan-only     states one concrete plan in its first round, then only waits
//   random-valid  one to three commands a round, built only from names and places its
//                 state shows (WAR Bench's baseline, js/bench-core.js)
// Their decisions are written as transcript lines and read by the same ledger that
// scores a model (js/eval/ledger.js), so the numbers are what a model would have got
// for the same play. A scorer that pays one of these seats is paying for something
// other than playing: that is what this run is for.
//
//   node tools/eval/anchors.cjs [--minutes 30] [--seeds 2] [--round 30] [--jobs 4]
//        [--civs greek,persian] [--out anchors-eval.json]
//
// The run belongs to ONE build of the rules: it prints the core hash it was played under.
// Not in the run: battles (the chronicle is page code and is not loaded in the realm), so
// Strategy here rests on placement and share of power.
'use strict';
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const crypto = require('node:crypto'), { fork } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..', '..');
const WarEval = require(path.join(ROOT, 'js/eval/ledger.js'));

const ANCHORS = ['do-nothing', 'wait-only', 'plan-only', 'random-valid'];
const PLAN = { objective: 'Grow the economy, then defend the town',
    plan: ['Train workers', 'Build a house', 'Build a barracks', 'Train militia', 'Build a tower by the town center'] };

function args(v) {
    const a = {};
    for (let i = 0; i < v.length; i++) if (v[i].startsWith('--')) a[v[i].slice(2)] = (v[i + 1] && !v[i + 1].startsWith('--')) ? v[++i] : true;
    return a;
}

// The rules' fingerprint, as WarConditions.sourceHashes computes it in the page.
function coreHash() {
    const ctx = vm.createContext({});
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/manifest.js'), 'utf8') + ';globalThis.M=WarManifest', ctx);
    const lf = s => s.replace(/\r\n?/g, '\n');
    return crypto.createHash('sha256').update(ctx.M.rules.map(f => lf(fs.readFileSync(path.join(ROOT, f), 'utf8'))).join('\n')).digest('hex');
}

// The results screen's power score, lifted out of ui.js rather than copied.
function powerScore() {
    const src = fs.readFileSync(path.join(ROOT, 'js/ui.js'), 'utf8');
    const m = src.match(/\n    spectatorPowerScore\(ai\) \{\r?\n([\s\S]*?)\r?\n    \}\r?\n/);
    if (!m) throw new Error('spectatorPowerScore not found in js/ui.js');
    return new Function('ai', m[1]);
}

function policyFor(anchor, key, W) {
    if (anchor === 'do-nothing') return () => ({ commands: [] });
    if (anchor === 'wait-only') return () => ({ commands: [{ action: 'wait', params: {} }] });
    if (anchor === 'plan-only') return ({ round }) => Object.assign({ commands: [{ action: 'wait', params: {} }] }, round === 1 ? PLAN : null);
    if (anchor === 'random-valid') { const p = W.randomValidPolicy(key); return turn => ({ commands: p(turn) }); }
    throw new Error('unknown anchor ' + anchor);
}

// One match: the anchor in seat 0, the rule-based brain in seat 1. Resolves to the
// match as transcript lines (the header, a line per decision, results, timeline).
async function playOne({ anchor, seed, minutes, roundSec, civs }) {
    const { GoldenMatch } = require(path.join(ROOT, 'tests/sim/harness.cjs'));
    const W = require(path.join(ROOT, 'js/bench-core.js'));
    const power = powerScore();
    // The arena's pace (2 since build 1020), and a hidden tab's coarse ticks.
    const m = new GoldenMatch({ seed: 7, hidden: true, normalSpeed: 2 });
    await m.startArena({ seats: [{ civ: civs[0], type: 'ki', profile: 'standard' }, { civ: civs[1], type: 'ki', profile: 'standard' }], seed });
    const g = m.game, [subject, rival] = g.aiManager.aiPlayers, mgr = g.openAIAIManager;
    // The match's own five-second sampler writes the timeline; it asks the page for the power score.
    g.ui.spectatorPowerScore = power;
    const c = m.scripted(subject), policy = policyFor(anchor, anchor + '/' + seed, W);
    let heard = [];
    const take = mgr.takeOutcomes.bind(mgr);
    mgr.takeOutcomes = who => { const list = take(who); if (who === c) heard.push(...list); return list; };
    const lines = [JSON.stringify({ type: 'match', matchId: 'anchor-' + anchor + '-' + seed, players: [
        { id: subject.id, seat: 0, civ: civs[0], name: anchor, model: 'anchor:' + anchor },
        { id: rival.id, seat: 1, civ: civs[1], name: 'rule-based', model: 'rule-based' }] })];
    const rounds = Math.round(minutes * 60 / roundSec);
    let round = 0;
    for (round = 1; round <= rounds && g.gameStarted; round++) {
        c.turnCount = (c.turnCount || 0) + 1;
        const state = mgr.buildGameStateJSON(c);
        const envelope = policy({ round, state });
        heard = [];
        if (envelope.commands.length || envelope.plan) { c.lastActionResult = null; mgr.executeTurn(c, envelope); }
        for (const k of ['pendingControl', 'pendingLog']) if (c[k] && c[k].length) { for (const e of c[k]) mgr.commitDecision(e); c[k] = []; }
        lines.push(JSON.stringify({ turn: round, playerId: subject.id, name: anchor, state, parsed: envelope,
            outcomes: heard.map(o => ({ n: o.n, action: o.action, code: o.code, verdict: o.verdict })) }));
        m.run(roundSec * 1000);
    }
    // Ranked as the results screen ranks: a seat that is gone comes last, otherwise by power.
    const seats = [subject, rival].map(s => ({ id: s.id, out: g.isPlayerEliminated(s), power: power(s) }));
    seats.sort((a, b) => (a.out - b.out) || (b.power - a.power));
    const tie = !seats[0].out && !seats[1].out && seats[0].power === seats[1].power;
    lines.push(JSON.stringify({ type: 'results', ranking: seats.map((s, i) => ({ playerId: s.id, rank: tie ? 1 : i + 1, isWinner: i === 0 && !tie, power: s.power })) }));
    lines.push(JSON.stringify({ type: 'timeline', samples: g._timeline.samples, ages: g._timeline.ages }));
    return { anchor, seed, rounds: round - 1, ended: !g.gameStarted, eliminated: g.isPlayerEliminated(subject), text: lines.join('\n') };
}

const mean = list => { const have = list.filter(v => v != null); return have.length ? have.reduce((a, b) => a + b, 0) / have.length : null; };
const fix = (v, d = 0) => v == null ? '-' : v.toFixed(d);

// The anchors' profiles, averaged over their matches: {anchor: {grounding, ..., index, matches}}.
function summarize(matches) {
    const out = {};
    for (const a of ANCHORS) {
        const mine = matches.filter(x => x.anchor === a).map(x => Object.assign({}, x, { seat: WarEval.profileOf(x.text).seats.find(s => s.name === a) }));
        if (!mine.length) continue;
        const row = { matches: mine.length, decisions: mean(mine.map(x => x.seat.decisions)), eliminated: mine.filter(x => x.eliminated).length };
        for (const k of WarEval.SCORED) row[k] = mean(mine.map(x => x.seat[k].score));
        row.index = mean(mine.map(x => x.seat.index.value));
        row.parts = mean(mine.map(x => x.seat.index.of));
        row.commands = mean(mine.map(x => x.seat.grounding.rated));
        row.valid = mean(mine.map(x => x.seat.grounding.rate));
        row.powerShare = mean(mine.map(x => x.seat.strategy.powerShare));
        out[a] = row;
    }
    return out;
}

function table(rows) {
    const width = rows[0].map((_, c) => Math.max(...rows.map(r => String(r[c]).length)));
    return rows.map(r => r.map((v, c) => c === 0 ? String(v).padEnd(width[c]) : String(v).padStart(width[c])).join('  ')).join('\n');
}
function report(summary) {
    return table([['ANCHOR', 'matches', 'decisions', 'commands rated', 'valid', 'eliminated'].concat(WarEval.SCORED, ['Index', 'of parts'])].concat(
        Object.entries(summary).map(([a, r]) => [a, r.matches, fix(r.decisions), fix(r.commands), r.valid == null ? '-' : (r.valid * 100).toFixed(1) + ' %', r.eliminated]
            .concat(WarEval.SCORED.map(k => fix(r[k])), [fix(r.index, 1), fix(r.parts, 1)]))));
}

async function main() {
    const o = args(process.argv.slice(2));
    if (o.one) { process.send(await playOne(JSON.parse(o.one))); return; }
    if (o.help) { console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 22).map(l => l.replace(/^\/\/ ?/, '')).join('\n')); return; }
    const minutes = Number(o.minutes || 30), seeds = Number(o.seeds || 2), roundSec = Number(o.round || 30), jobs = Number(o.jobs || 4);
    const civs = String(o.civs || 'greek,persian').split(',');
    const games = [];
    for (const anchor of ANCHORS) for (let s = 1; s <= seeds; s++) games.push({ anchor, seed: 'anchor-' + s, minutes, roundSec, civs });
    const hash = coreHash();
    console.log(`core ${hash.slice(0, 16)}  ${games.length} matches, ${minutes} min each, a decision every ${roundSec} s, ${jobs} at a time`);
    const results = new Array(games.length);
    let next = 0, done = 0;
    await Promise.all(Array.from({ length: Math.min(jobs, games.length) }, async () => {
        while (next < games.length) {
            const k = next++;
            results[k] = await new Promise((resolve, reject) => {
                const child = fork(__filename, ['--one', JSON.stringify(games[k])], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
                child.once('message', resolve);
                child.once('exit', code => code && reject(new Error('match ' + k + ' exited ' + code)));
            });
            const r = results[k];
            console.log(`  [${++done}/${games.length}] ${r.anchor} ${r.seed}: ${r.rounds} decisions${r.eliminated ? ', eliminated' : ''}${r.ended ? ', match ended' : ''}`);
        }
    }));
    const summary = summarize(results);
    console.log('\n' + report(summary));
    console.log('\nScore scale ' + WarEval.SCALE + '. A dash is a part the match gave no chance for; the Index is the mean of the parts that have a score.');
    if (o.out) {
        fs.writeFileSync(o.out, JSON.stringify({ tool: 'eval-anchors', coreHash: hash, scale: WarEval.SCALE, minutes, seeds, roundSec, civs, summary,
            matches: results.map(r => ({ anchor: r.anchor, seed: r.seed, rounds: r.rounds, ended: r.ended, eliminated: r.eliminated })) }, null, 1));
        console.log('saved ' + o.out);
    }
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { ANCHORS, playOne, summarize, report, policyFor };
