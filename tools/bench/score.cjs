'use strict';
// A WAR Bench run, scored (review #8 step 6): success rates with Wilson intervals --
// overall, per family, per scenario -- pass^k for every k the attempts allow, and what
// became of every command, by outcome class. Plain data in, plain data out.
const { wilson, passHatK, cellsOf } = require('./stats.cjs');

function rate(results) {
    return wilson(results.filter(r => r.outcome === 'success').length, results.length);
}

function score(results) {
    const cells = cellsOf(results);
    const maxAttempts = Math.max(0, ...cells.map(c => c.n));
    const passK = {};
    for (let k = 1; k <= maxAttempts; k++) passK[k] = passHatK(cells, k);
    const by = key => {
        const out = {};
        for (const r of results) (out[r[key]] || (out[r[key]] = [])).push(r);
        return Object.fromEntries(Object.entries(out).sort().map(([k, rs]) => [k, rate(rs)]));
    };
    // Every command's fate. "uncoded" is a refusal the harness gave no code; it is
    // reported, never folded into another class.
    const classes = {};
    let commands = 0, rounds = 0;
    for (const r of results) {
        rounds += r.rounds;
        for (const e of r.log) for (const o of e.outcomes || []) { commands++; classes[o.class] = (classes[o.class] || 0) + 1; }
    }
    return {
        episodes: results.length, cells: cells.length,
        success: rate(results), passK,
        byFamily: by('family'), byScenario: by('id'),
        commands, commandsPerRound: rounds ? commands / rounds : 0, classes,
    };
}

module.exports = { score, rate };
