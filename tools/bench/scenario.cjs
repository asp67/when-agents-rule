'use strict';
// war-scenario-v1: a WAR Bench scenario (review #8 step 3), the Node host. The language
// itself -- validation, variants, predicates, partial measures, the round loop -- lives
// in js/bench-core.js (b1091), shared with the browser's Benchmark page; its header
// documents every field. This file adds what only Node does: reading scenarios from
// disk and building each episode's realm as a VM context.
const fs = require('node:fs');
const path = require('node:path');
const W = require('../../js/bench-core.js');
const { Realm } = require('./realm.cjs');

const DIR = path.join(__dirname, '../../benchmarks/scenarios');

function load(file) { return W.validate(JSON.parse(fs.readFileSync(file, 'utf8'))); }
// Every scenario under a directory (benchmarks/scenarios by default), sorted by id.
function loadAll(dir = DIR) {
    const out = [];
    for (const fam of fs.readdirSync(dir).sort()) {
        const d = path.join(dir, fam);
        if (!fs.statSync(d).isDirectory()) continue;
        for (const f of fs.readdirSync(d).sort()) if (f.endsWith('.json')) out.push(load(path.join(d, f)));
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
}

// A fresh realm per episode, on the files on disk or on a bundle's recorded `sources`.
const realmMaker = ({ sources = null } = {}) => () => new Realm({ seed: 1, sources });

// The episode functions with the Node realm filled in; everything else in options goes
// through to WarBench.begin / WarBench.play.
async function begin(scenario, variant = 'identity', options = {}) {
    const { ceilingMs, sources } = options;
    return W.begin(scenario, variant, { makeRealm: realmMaker({ sources }), ceilingMs });
}
async function play(scenario, variant, policy, options = {}) {
    const { sources, ...rest } = options;
    return W.play(scenario, variant, policy, Object.assign({ makeRealm: realmMaker({ sources }) }, rest));
}

module.exports = { SCHEMA: W.SCHEMA, ROUND_MS: W.ROUND_MS, CEILING_MS: W.CEILING_MS, VARIANTS: W.VARIANTS, DIR,
                   validate: W.validate, load, loadAll, instantiate: W.instantiate, evaluate: W.evaluate, measure: W.measure,
                   begin, play, referencePolicy: W.referencePolicy, noopPolicy: W.noopPolicy };
