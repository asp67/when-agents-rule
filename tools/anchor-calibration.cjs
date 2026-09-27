#!/usr/bin/env node
// Anchor calibration (review #7): plays the rule-based brain's styles (AI_PROFILES in
// js/ai.js) against each other and orders them by what happened, not by their names.
// Zero dependencies, Node 18+.
//
// Seat-swapped pairs: every pairing is played twice on the same map, with the same two
// civilizations in the same two seats, and only the styles trading places. Whatever a
// seat, a spawn or a civilization is worth then falls on both styles alike, and what
// is left is the style. Each map seed adds one more such pair.
//
// A match ends when the game ends it (an elimination, a Wonder) or at --minutes of
// simulated time. At the limit it is decided the way the arena's results screen ranks
// seats that are both still standing: by the power score (UIManager.
// spectatorPowerScore, read from ui.js itself so the two cannot drift apart). Closer
// than --margin percent is a draw.
//
// The ranking is a yardstick for ONE build of the rules: it is printed and saved with
// the core hash it was played under, and says nothing about any other.
//
// Usage:
//   node tools/anchor-calibration.cjs [--minutes 40] [--seeds 3] [--jobs 8]
//        [--profiles standard,turtle,legion,raider] [--civs greek,persian]
//        [--margin 5] [--out anchors.json]
'use strict';
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const crypto = require('node:crypto'), { fork } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');

function args() {
    const a = {}, v = process.argv.slice(2);
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
    const m = src.match(/\n    spectatorPowerScore\(ai\) \{\n([\s\S]*?)\n    \}\n/);
    if (!m) throw new Error('spectatorPowerScore not found in js/ui.js');
    return new Function('ai', m[1]);
}

// One match, in a worker process: seats [a, b] on map `seed`.
async function playOne({ a, b, seed, minutes, civs }) {
    const { GoldenMatch } = require(path.join(ROOT, 'tests/sim/harness.cjs'));
    const power = powerScore();
    const m = new GoldenMatch({ seed: 7, hidden: true });
    await m.startArena({ seats: [{ civ: civs[0], type: 'ki', profile: a }, { civ: civs[1], type: 'ki', profile: b }], seed });
    const g = m.game, seats = g.aiManager.aiPlayers;
    // Minute by minute until the game ends itself (an elimination or a Wonder; the
    // simulation stops there) or the limit is reached.
    let minute = 0;
    while (minute < minutes && g.gameStarted) { m.run(60000); minute++; }
    const out = seats.filter(s => g.isPlayerEliminated(s));
    const profiles = seats.map(s => s.profile);
    if (profiles[0] !== a || profiles[1] !== b) throw new Error('seat profiles not applied: ' + profiles);
    return {
        a, b, seed, minute, ended: !g.gameStarted,
        eliminated: out.map(s => s.profile),
        seats: seats.map(s => ({ profile: s.profile, civ: s.civilization, age: s.age, power: power(s),
            workers: s.units.filter(u => u.type === 'worker').length,
            military: s.units.filter(u => u.type !== 'worker').length, buildings: s.buildings.length })),
    };
}

function verdict(r, margin) {
    if (r.eliminated.length === 1) return r.eliminated[0] === r.a ? r.b : r.a;
    if (r.eliminated.length > 1) return null;
    const [pa, pb] = r.seats.map(s => s.power);
    if (Math.abs(pa - pb) * 100 <= margin * Math.max(pa, pb, 1)) return null;
    return pa > pb ? r.a : r.b;
}

async function main() {
    const o = args();
    if (o.one) { process.send(await playOne(JSON.parse(o.one))); return; }
    const profiles = String(o.profiles || 'standard,turtle,legion,raider').split(',');
    const civs = String(o.civs || 'greek,persian').split(',');
    const minutes = Number(o.minutes || 40), seeds = Number(o.seeds || 3), margin = Number(o.margin || 5);
    const jobs = Number(o.jobs || 8);
    const games = [];
    for (let s = 1; s <= seeds; s++) for (let i = 0; i < profiles.length; i++) for (let j = i + 1; j < profiles.length; j++) {
        games.push({ a: profiles[i], b: profiles[j], seed: 'anchor-' + s, minutes, civs });
        games.push({ a: profiles[j], b: profiles[i], seed: 'anchor-' + s, minutes, civs });   // the swap
    }
    const hash = coreHash();
    console.log(`core ${hash.slice(0, 16)}  ${games.length} matches, ${minutes} min each, ${jobs} at a time`);
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
            const r = results[k], w = verdict(r, margin);
            console.log(`  [${++done}/${games.length}] ${r.seed} ${r.a} v ${r.b}: ${w || 'draw'} (min ${r.minute}${r.eliminated.length ? ', elimination' : ''}; ` +
                r.seats.map(s => `${s.profile} ${s.age} p${s.power} w${s.workers} m${s.military}`).join(' | ') + ')');
        }
    }));

    // Points: a win is 1, a draw half to each. And the head-to-head table.
    const pts = Object.fromEntries(profiles.map(p => [p, 0])), played = Object.fromEntries(profiles.map(p => [p, 0]));
    const h2h = {};
    for (const r of results) {
        const w = verdict(r, margin);
        played[r.a]++; played[r.b]++;
        if (w) pts[w] += 1; else { pts[r.a] += 0.5; pts[r.b] += 0.5; }
        const key = [r.a, r.b].sort().join(' v ');
        (h2h[key] = h2h[key] || {})[w || 'draw'] = ((h2h[key] || {})[w || 'draw'] || 0) + 1;
    }
    const order = profiles.slice().sort((x, y) => pts[y] / played[y] - pts[x] / played[x]);
    console.log('\nstanding (points per game):');
    for (const p of order) console.log(`  ${p.padEnd(9)} ${pts[p].toFixed(1).padStart(5)} / ${played[p]}  ${(100 * pts[p] / played[p]).toFixed(0)}%`);
    console.log('head to head:');
    for (const [k, v] of Object.entries(h2h)) console.log(`  ${k.padEnd(20)} ${Object.entries(v).map(([w, n]) => w + ' ' + n).join(', ')}`);
    const record = { tool: 'anchor-calibration', coreHash: hash, contractIdentical: false, minutes, seeds, margin, civs,
                     order, points: pts, played, headToHead: h2h, matches: results };
    if (o.out) { fs.writeFileSync(o.out, JSON.stringify(record, null, 1)); console.log('saved ' + o.out); }
}

main().catch(e => { console.error(e); process.exit(1); });
