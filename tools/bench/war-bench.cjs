#!/usr/bin/env node
'use strict';
// WAR Bench v0a, the command line (review #8). Keyless: v0a runs the baselines only.
//
//   node tools/bench/war-bench.cjs run --policy noop|random-valid|scripted
//        [--attempts N] [--variants identity,rot90,...] [--out run.warbench.jsonl.gz]
//   node tools/bench/war-bench.cjs run --model seat.json [--label "methodology preview"] ...
//        a model seat (v0b): {name, endpoint, model, provider, maxTokens, contextSize,
//        reqOpts: {temperature, extraBody, ...}} -- the declared config goes in the bundle
//   node tools/bench/war-bench.cjs calibrate --model seat.json
//        one real round at production size: status, latency, tokens, tool calls
//   node tools/bench/war-bench.cjs verify <bundle>        replay it on its own rules
//   node tools/bench/war-bench.cjs report <bundle> [--out report.html]
const fs = require('node:fs');
const path = require('node:path');
const S = require('./scenario.cjs');
const B = require('./bundle.cjs');
const { BASELINES } = require('./baselines.cjs');
const { modelPolicy } = require('./runner.cjs');

function args(argv) {
    const a = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i].startsWith('--')) a[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
        else a._.push(argv[i]);
    }
    return a;
}

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const pct = p => p == null ? '–' : (100 * p).toFixed(1) + '%';
const ci = w => w && w.p != null ? `${pct(w.p)} <span class="ci">[${pct(w.lo)}, ${pct(w.hi)}]</span> <span class="n">${w.k}/${w.n}</span>` : '–';

// A static, self-contained page for a bundle: no scripts, no network, only the numbers.
function reportHtml(lines, verification) {
    const recs = lines.map(l => JSON.parse(l));
    const head = recs[0], close = recs[recs.length - 1], sc = close.score;
    const episodes = recs.filter(r => r.type === 'end');
    const rows = obj => Object.entries(obj).map(([k, w]) => `<tr><td>${esc(k)}</td><td>${ci(w)}</td></tr>`).join('');
    const verdict = verification
        ? (verification.ok ? '<p class="ok">Verified: every episode replays identically on the rules embedded in this bundle.</p>'
            : `<p class="bad">Verification FAILED:</p><ul>${verification.problems.slice(0, 20).map(p => `<li>${esc(p)}</li>`).join('')}</ul>`)
        : '<p class="n">Not verified in this report. Run <code>war-bench verify</code>.</p>';
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>WAR Bench report</title>
<style>
:root { --bg:#fbfaf7; --fg:#1f1d1a; --muted:#6b665e; --line:#e3ded4; --ok:#1d7a3a; --bad:#b3261e; }
@media (prefers-color-scheme: dark) { :root { --bg:#161513; --fg:#ece8e1; --muted:#9d978d; --line:#34312c; --ok:#6fcf8b; --bad:#f2807a; } }
body { background:var(--bg); color:var(--fg); font:15px/1.5 system-ui, sans-serif; margin:0 auto; padding:24px 16px; max-width:860px; }
h1 { font-size:22px; margin:0 0 4px; } h2 { font-size:16px; margin:28px 0 8px; }
table { border-collapse:collapse; width:100%; } td, th { text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); }
.n, .ci { color:var(--muted); } .ok { color:var(--ok); } .bad { color:var(--bad); }
code { font-size:13px; } .grid { overflow-x:auto; }
</style></head><body>
<h1>WAR Bench report</h1>
<p class="n">Policy <b>${esc(head.policy.name)}</b> (${esc(head.policy.kind)}) · protocol ${esc(head.protocol.scenario)}, ${head.protocol.roundMs / 1000} s rounds, ${head.protocol.ceilingMs / 1000} s ceiling · core <code>${esc(head.coreHash.slice(0, 16))}</code> · harness <code>${esc(head.harnessHash.slice(0, 16))}</code></p>
${verdict}
<h2>Success</h2>
<table><tr><td>All ${sc.episodes} episodes</td><td>${ci(sc.success)}</td></tr>
${Object.entries(sc.passK).map(([k, v]) => `<tr><td>pass^${k}</td><td>${pct(v)}</td></tr>`).join('')}</table>
<h2>By family</h2><table>${rows(sc.byFamily)}</table>
<h2>By scenario</h2><table>${rows(sc.byScenario)}</table>
<h2>What became of each command</h2>
<table>${Object.entries(sc.classes).sort().map(([k, n]) => `<tr><td>${esc(k)}</td><td>${n}</td></tr>`).join('')}
<tr><td class="n">commands per round</td><td class="n">${sc.commandsPerRound.toFixed(2)}</td></tr></table>
<h2>Episodes</h2><div class="grid"><table><tr><th>Scenario</th><th>Variant</th><th>Attempt</th><th>Outcome</th><th>Rounds</th></tr>
${episodes.map(e => `<tr><td>${esc(e.id)}</td><td>${esc(e.variant)}</td><td>${e.attempt}</td><td class="${e.outcome === 'success' ? 'ok' : 'bad'}">${esc(e.outcome)}</td><td>${e.rounds}</td></tr>`).join('')}
</table></div>
<p class="n">Intervals are 95 % Wilson intervals. pass^k is the chance that k attempts at the same scenario and variant all succeed.</p>
</body></html>
`;
}

async function main() {
    const a = args(process.argv.slice(2));
    const cmd = a._[0];
    if (cmd === 'run') {
        const variants = a.variants ? String(a.variants).split(',') : null;
        let policy, name;
        if (a.model) {
            const cfg = JSON.parse(fs.readFileSync(a.model, 'utf8'));
            name = cfg.name;
            policy = { name, kind: 'model', config: cfg,
                       make: (s, v, att, wire) => modelPolicy(cfg, { fetchImpl: B.recordingFetch(globalThis.fetch, wire) }) };
        } else {
            name = a.policy;
            if (!BASELINES[name]) throw new Error('--policy is one of ' + Object.keys(BASELINES).join(', ') + ', or give --model');
            policy = { name, kind: 'baseline', make: BASELINES[name] };
        }
        const out = a.out || `${String(name).replace(/[^A-Za-z0-9._-]+/g, '-')}.warbench.jsonl.gz`;
        // Streamed as it is made (plain JSON lines), then gzipped whole at the end.
        const partial = out + '.partial.jsonl';
        fs.writeFileSync(partial, '');
        const t0 = Date.now();
        const lines = await B.record({ scenarios: S.loadAll(), variants, attempts: Number(a.attempts || 1), policy,
            label: a.label || (a.model ? 'methodology preview' : null),
            onLine: line => fs.appendFileSync(partial, line + '\n'),
            onEpisode: (r, i, n) => console.log(`[${i}/${n}] ${r.id}/${r.variant}/${r.attempt}: ${r.outcome} in ${r.rounds} rounds (${Math.round((Date.now() - t0) / 1000)} s)`) });
        B.write(lines, out);
        fs.unlinkSync(partial);
        const sc = JSON.parse(lines[lines.length - 1]).score;
        console.log(`${name}: ${sc.episodes} episodes, success ${pct(sc.success.p)} [${pct(sc.success.lo)}, ${pct(sc.success.hi)}] -> ${out}`);
    } else if (cmd === 'calibrate') {
        const cfg = JSON.parse(fs.readFileSync(a.model, 'utf8'));
        const s = S.loadAll().find(x => x.id === (a.scenario || 'recover-01'));
        const ep = await S.begin(s, 'identity');
        const wire = [];
        const policy = modelPolicy(cfg, { fetchImpl: B.recordingFetch(globalThis.fetch, wire) });
        const state = ep.mgr.buildGameStateJSON(ep.subjectController);
        const t = Date.now();
        const env = await policy({ round: 1, state, episode: ep });
        const ms = Date.now() - t, x = wire[0] || {};
        let usage = null, calls = 0, finish = null;
        try { const j = JSON.parse(x.response); usage = j.usage; finish = j.choices && j.choices[0].finish_reason; calls = ((j.choices && j.choices[0].message.tool_calls) || []).length; } catch (e) {}
        console.log(JSON.stringify({ seat: cfg.name, scenario: s.id, status: x.status, ms, finish, toolCalls: calls,
            commands: env && env.commands ? env.commands.map(c => c.action) : null,
            promptTokens: usage && usage.prompt_tokens, completionTokens: usage && usage.completion_tokens,
            lastResult: ep.subjectController.lastActionResult ? String(ep.subjectController.lastActionResult).slice(0, 160) : null }));
    } else if (cmd === 'verify') {
        const v = await B.verify(B.readLines(a._[1]));
        console.log(v.ok ? `verified: ${v.episodes} episodes replay identically (core ${v.coreHash.slice(0, 16)})` : 'FAILED:\n  ' + v.problems.join('\n  '));
        process.exitCode = v.ok ? 0 : 1;
    } else if (cmd === 'report') {
        const lines = B.readLines(a._[1]);
        const v = await B.verify(lines);
        const out = a.out || a._[1].replace(/\.warbench\.jsonl\.gz$/, '') + '.report.html';
        fs.writeFileSync(out, reportHtml(lines, v));
        console.log(`${v.ok ? 'verified' : 'NOT verified'}; report -> ${out}`);
    } else {
        console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(3, 9).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
        process.exitCode = cmd ? 1 : 0;
    }
}

if (require.main === module) main().catch(e => { console.error(e.message); process.exit(1); });
module.exports = { reportHtml };
