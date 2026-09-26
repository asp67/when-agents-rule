#!/usr/bin/env node
// Paired run: does replaying a model's hidden reasoning as its visible past reply
// change what it does? (roadmap #3c; zero dependencies, Node 18+)
//
// When a reply carries tool calls and no text, the rolling history replays the first
// 600 characters of its REASONING as the assistant text of that past turn (policy
// "reasoning"). The platform stores nothing there (policy "content"). This script
// rebuilds real requests from a recorded transcript through WAR's own sendToOpenAI --
// same system prompt, same state, same history, same tool results -- once per policy,
// so the ONLY difference between the two arms is that assistant text. It checks that
// before sending anything.
//
// Usage:
//   node tools/paired-history.cjs --file samples/<match>.jsonl --seat <playerId|model substring>
//        --endpoint http://host:port/v1 --model <served id>
//        [--turns 40] [--history 6] [--repeats 2] [--temperature 0.6] [--seed 1234]
//        [--max-tokens 8192] [--out results.jsonl] [--dry-run]
// A bearer key, if the endpoint needs one, is read from the WAR_PAIRED_KEY environment
// variable so it never lands in shell history.
//
// --dry-run builds both requests for every sampled turn and verifies they differ only
// in the replayed assistant text, without contacting any endpoint.
'use strict';
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const ROOT = path.resolve(__dirname, '..');

function args() {
    const a = {}, v = process.argv.slice(2);
    for (let i = 0; i < v.length; i++) {
        if (!v[i].startsWith('--')) continue;
        const k = v[i].slice(2), next = v[i + 1];
        if (next === undefined || next.startsWith('--')) a[k] = true; else { a[k] = next; i++; }
    }
    return a;
}

function loadHarness(fetchImpl) {
    const scope = { console: { log() {}, warn() {}, error() {} }, fetch: fetchImpl, Response, Headers,
        AbortController, setTimeout, clearTimeout, TextEncoder, TextDecoder, URL };
    vm.createContext(scope);
    for (const f of ['js/civilizations.js', 'js/buildings.js', 'js/units.js', 'js/openai-ai.js'])
        vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), scope, { filename: f });
    return vm.runInContext('OpenAIAIManager', scope);
}

// The two policies under test, for a recorded reply.
const POLICIES = {
    reasoning: a => String((a && (a.content || a.reasoning)) || ''),
    content: a => String((a && a.content) || ''),
};
const trim = s => s.replace(/\s+/g, ' ').trim().slice(0, 600);

function logEntry(Manager, m, prev, policy) {
    const calls = ((prev.assistant && prev.assistant.tool_calls) || []).map((c, i) => {
        const fn = c.function || {};
        const a = typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments || {});
        try { JSON.parse(a); } catch (e) { return null; }
        return a.length > 1200 ? null : { id: c.id || ('call_' + prev.turn + '_' + i), name: fn.name || 'unknown', args: a };
    }).filter(Boolean);
    return { user: m.buildCompactState(prev.state), assistant: trim(POLICIES[policy](prev.assistant)),
             toolCalls: calls.length ? calls : null, outcome: prev.harnessResult || null };
}

function controllerFor(Manager, m, seat, history, opts) {
    const model = { endpoint: opts.endpoint, model: opts.model, provider: 'openai', maxTokens: opts.maxTokens,
        temperature: opts.temperature, contextSize: opts.contextSize, language: 'en', _reqOpts: {},
        auth: opts.key ? { type: 'bearer', key: opts.key } : { type: 'none' },
        extraBody: opts.seed != null ? { seed: opts.seed } : null };
    const c = { id: seat.playerId, aiPlayer: { id: seat.playerId, civilization: seat.civ, seat: seat.seat },
        model, stats: m.newStats(), turnLog: history, conversationHistory: [], objective: '', plan: [] };
    c.seat = c; c.lanes = [c];
    m.aiControllers = [c];
    return c;
}

async function main() {
    const a = args();
    if (!a.file || !a.seat || (!a['dry-run'] && (!a.endpoint || !a.model))) {
        console.error('usage: see the header of tools/paired-history.cjs'); process.exit(2);
    }
    const rows = fs.readFileSync(a.file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    const header = rows.find(r => r.type === 'match') || {};
    const turns = rows.filter(r => !r.type && r.state && (r.playerId === a.seat || String(r.model || '').includes(a.seat)));
    if (!turns.length) { console.error('no turns for seat ' + a.seat); process.exit(2); }
    const seat = { playerId: turns[0].playerId, civ: turns[0].civ, seat: turns[0].seat };
    const H = Number(a.history || 6), N = Number(a.turns || 40), R = Number(a.repeats || 2);
    const opts = { endpoint: a.endpoint || 'http://127.0.0.1:1/v1', model: a.model || 'dry-run', key: process.env.WAR_PAIRED_KEY || null,
        maxTokens: Number(a['max-tokens'] || 8192), temperature: a.temperature != null ? Number(a.temperature) : 0.6,
        seed: a.seed != null ? Number(a.seed) : 1234, contextSize: Number(a.context || 65536) };
    // Only turns whose history actually differs between the policies are informative.
    const eligible = [];
    for (let i = H; i < turns.length; i++) {
        const prev = turns.slice(i - H, i);
        if (prev.some(p => POLICIES.reasoning(p.assistant) !== POLICIES.content(p.assistant))) eligible.push(i);
    }
    const step = Math.max(1, Math.floor(eligible.length / N));
    const picked = eligible.filter((_, k) => k % step === 0).slice(0, N);
    console.error(`seat ${seat.playerId} (${turns[0].model}): ${turns.length} turns, ${eligible.length} eligible, ${picked.length} sampled`);
    if (!a['dry-run']) console.error(opts.key
        ? `key: set (${opts.key.length} characters)`
        : 'key: NOT set -- WAR_PAIRED_KEY is empty in this shell; a hosted endpoint will answer 401');

    let captured = null;
    const realFetch = globalThis.fetch;
    const Manager = loadHarness(async (url, init) => {
        captured = { request: JSON.parse(init.body) };
        if (a['dry-run']) {
            const body = JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'dry run', tool_calls: [] }, finish_reason: 'stop' }], usage: {} });
            captured.response = JSON.parse(body);
            return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
        }
        const t0 = Date.now(), res = await realFetch(url, init), text = await res.text();
        try { captured.response = JSON.parse(text); } catch (e) { captured.response = { raw: text.slice(0, 500) }; }
        captured.status = res.status; captured.ms = Date.now() - t0;
        return new Response(text, { status: res.status, headers: res.headers });
    });
    const game = { difficulty: header.difficulty || 'easy', spectatorMode: true, simSpeed: 1,
        aiManager: { aiPlayers: (header.players || [{}, {}]).map(() => ({})) } };

    async function run(i, policy) {
        const m = new Manager(game);
        const history = turns.slice(i - H, i).map(p => logEntry(Manager, m, p, policy));
        const c = controllerFor(Manager, m, seat, history, opts);
        captured = null;
        try { await m.sendToOpenAI(c, turns[i].state); } catch (e) { /* recorded below */ }
        return captured;
    }
    const metrics = cap => {
        const msg = cap && cap.response && cap.response.choices && cap.response.choices[0] && cap.response.choices[0].message || {};
        const calls = msg.tool_calls || [], usage = (cap && cap.response && cap.response.usage) || {};
        const valid = calls.filter(c => { try { JSON.parse(c.function.arguments || '{}'); return Manager.ACTION_NAMES.has(c.function.name) || c.function.name === 'plan'; } catch (e) { return false; } }).length;
        return { status: cap && cap.status, ms: cap && cap.ms, toolCalls: calls.length, validCalls: valid, noTool: calls.length ? 0 : 1,
                 first: calls[0] ? calls[0].function.name : null, contentChars: String(msg.content || '').length,
                 reasoningChars: String(msg.reasoning_content || msg.reasoning || '').length,
                 completionTokens: usage.completion_tokens || null, promptTokens: usage.prompt_tokens || null,
                 finish: cap && cap.response && cap.response.choices && cap.response.choices[0] && cap.response.choices[0].finish_reason };
    };
    // The two arms must differ ONLY in the replayed assistant text.
    const onlyAssistantDiffers = (x, y) => {
        const strip = r => JSON.stringify(Object.assign({}, r, { messages: r.messages.map(mm => mm.role === 'assistant' ? { role: 'assistant', tool_calls: mm.tool_calls } : mm) }));
        return strip(x) === strip(y) && JSON.stringify(x) !== JSON.stringify(y);
    };

    const out = a.out ? fs.createWriteStream(a.out) : null;
    const pairs = [];
    for (const i of picked) {
        for (let r = 0; r < (a['dry-run'] ? 1 : R); r++) {
            const A = await run(i, 'reasoning'), B = await run(i, 'content');
            if (!A || !B) { console.error(`turn ${turns[i].turn}: no request built`); continue; }
            // A failed request is not a data point. Stop at the first one and show what
            // the server said, rather than spending the whole budget on errors.
            for (const [arm, cap] of [['reasoning', A], ['content', B]]) {
                if (!a['dry-run'] && cap.status !== 200) {
                    const said = cap.response && (cap.response.error ? JSON.stringify(cap.response.error) : cap.response.raw);
                    console.error(`turn ${turns[i].turn} (${arm}): HTTP ${cap.status} -- ${String(said || '').slice(0, 300)}`);
                    console.error('Stopped: fix the key, endpoint or model id and run again.');
                    process.exit(1);
                }
            }
            if (!onlyAssistantDiffers(A.request, B.request)) { console.error(`turn ${turns[i].turn}: arms differ beyond the assistant text -- aborting`); process.exit(1); }
            const row = { turn: turns[i].turn, repeat: r, reasoning: metrics(A), content: metrics(B) };
            pairs.push(row);
            if (out) out.write(JSON.stringify(row) + '\n');
            console.error(`turn ${row.turn}#${r}: reasoning ${row.reasoning.toolCalls} calls, content ${row.content.toolCalls} calls`);
        }
    }
    if (out) out.end();
    if (a['dry-run']) { console.log(JSON.stringify({ dryRun: true, pairs: pairs.length, verified: 'arms differ only in the replayed assistant text' })); return; }

    // Paired summary with an exact two-sided sign test.
    const sign = (key) => {
        let up = 0, down = 0;
        pairs.forEach(p => { const d = (p.content[key] || 0) - (p.reasoning[key] || 0); if (d > 0) up++; else if (d < 0) down++; });
        const n = up + down, k = Math.min(up, down);
        let p = 0; for (let j = 0; j <= k; j++) { let c = 1; for (let q = 0; q < j; q++) c = c * (n - q) / (q + 1); p += c; }
        return { contentHigher: up, reasoningHigher: down, ties: pairs.length - n, p: n ? Math.min(1, 2 * p / Math.pow(2, n)) : 1 };
    };
    const mean = (arm, key) => pairs.reduce((s, p) => s + (p[arm][key] || 0), 0) / Math.max(1, pairs.length);
    const summary = { pairs: pairs.length, seat: turns[0].model, model: a.model,
        noToolRate: { reasoning: mean('reasoning', 'noTool'), content: mean('content', 'noTool') },
        toolCalls: { reasoning: mean('reasoning', 'toolCalls'), content: mean('content', 'toolCalls'), sign: sign('toolCalls') },
        validCalls: { sign: sign('validCalls') },
        contentChars: { reasoning: mean('reasoning', 'contentChars'), content: mean('content', 'contentChars'), sign: sign('contentChars') },
        completionTokens: { reasoning: mean('reasoning', 'completionTokens'), content: mean('content', 'completionTokens'), sign: sign('completionTokens') },
        sameFirstAction: pairs.filter(p => p.reasoning.first === p.content.first).length / Math.max(1, pairs.length) };
    console.log(JSON.stringify(summary, null, 2));
}
main().catch(e => { console.error(e); process.exit(1); });
