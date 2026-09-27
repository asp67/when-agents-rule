'use strict';
// war-scenario-v1: a WAR Bench scenario (review #8 step 3). One JSON file per scenario,
// under benchmarks/scenarios/<family>/<id>.json:
//
//   schema      "war-scenario-v1"
//   id, family, title
//   objective   what the model is told, in place of the default prompt's victory
//               paragraph (OpenAIAIManager.scenarioSystemPrompt). {{tag.x}}, {{tag.z}},
//               {{point:name.x}} and {{point:name.z}} are replaced by positions AFTER the
//               variant's transform, so the text always matches the board.
//   rounds      how many rounds the subject gets. A round is: observe, decide, execute,
//               then exactly ROUND_MS of simulated time (the frozen driver).
//   board       createMatch's board config; seat 0 is the SUBJECT (the seat scored),
//               seat 1 the RIVAL. Entities may carry fields.tag to be named below.
//   points      named places: {"ford": [0, 0]}.
//   rival       the rival's orders: [{round, action, params}], run through the same
//               executor a model's commands go through.
//   success     {when: "any" | "end", predicate}: "any" ends the episode the first time
//               the predicate holds after a round; "end" asks only after the last.
//   failure     optional predicate; true after any round ends the episode failed.
//   invariant   optional {from, predicate}: must hold after every round from `from` on.
//   variants    names from VARIANTS (the square's eight symmetries).
//   reference   a proven solution, [{round, commands: [{action, params}]}]. Tests play it
//               in every variant and require success; they also require that doing
//               nothing fails, so no scenario is solved by standing still.
//
// Everything is data: predicates are a small closed JSON language evaluated here, never
// code, so a scenario can be read, diffed and checked without running anything.
const fs = require('node:fs');
const path = require('node:path');
const { createMatch } = require('./realm.cjs');
const { classify } = require('./taxonomy.cjs');

const SCHEMA = 'war-scenario-v1';
const ROUND_MS = 10000;
// How long a seat may take to answer one round: the declared ceiling of the protocol.
// It is told to the seat (clock.secondsToAnswer) and enforced exactly (the request is
// aborted at it); an answer that misses it is an empty round, never a retry.
const CEILING_MS = 120000;

// The eight symmetries of the square map. A variant moves every coordinate in the
// scenario the same way -- entities, points, rival orders, predicates, reference -- so
// it is the same problem seen from another side.
const VARIANTS = Object.freeze({
    identity: (x, z) => [x, z],
    rot90: (x, z) => [-z, x],
    rot180: (x, z) => [-x, -z],
    rot270: (x, z) => [z, -x],
    mirrorX: (x, z) => [-x, z],
    mirrorZ: (x, z) => [x, -z],
    diagonal: (x, z) => [z, x],
    antidiagonal: (x, z) => [-z, -x],
});

// ---- Validation --------------------------------------------------------------------
const OPS = ['>=', '>', '==', '<', '<=', '!='];
const OWNERS = ['subject', 'rival'];
function checkPredicate(p, where, s) {
    const fail = msg => { throw new Error(`${s.id}: ${where}: ${msg}`); };
    if (!p || typeof p !== 'object' || Array.isArray(p)) fail('a predicate is an object');
    const keys = Object.keys(p);
    if (keys.length !== 1 && !('count' in p)) fail('one operator per predicate: ' + keys.join(', '));
    if ('all' in p || 'any' in p) {
        const list = p.all || p.any;
        if (!Array.isArray(list) || !list.length) fail('all/any take a non-empty list');
        list.forEach((q, i) => checkPredicate(q, `${where}.${'all' in p ? 'all' : 'any'}[${i}]`, s));
    } else if ('not' in p) checkPredicate(p.not, where + '.not', s);
    else if ('destroyed' in p || 'alive' in p) {
        const tag = p.destroyed || p.alive;
        if (!tagOf(s, tag)) fail('unknown tag ' + tag);
    } else if ('eliminated' in p) {
        if (!OWNERS.includes(p.eliminated)) fail('eliminated takes subject or rival');
    } else if ('count' in p) {
        const extra = keys.filter(k => !['count', 'op', 'value'].includes(k));
        if (extra.length) fail('unknown keys ' + extra.join(', '));
        const c = p.count;
        if (!OWNERS.includes(c.owner)) fail('count.owner is subject or rival');
        if (!['unit', 'building'].includes(c.kind)) fail('count.kind is unit or building');
        const bad = Object.keys(c).filter(k => !['owner', 'kind', 'type', 'class', 'near'].includes(k));
        if (bad.length) fail('unknown count keys ' + bad.join(', '));
        if (c.near) {
            const n = c.near;
            if (!(n.r > 0)) fail('near needs a radius r');
            if (n.point != null ? !(s.points && s.points[n.point]) : n.tag != null ? !tagOf(s, n.tag) : !(Number.isFinite(n.x) && Number.isFinite(n.z)))
                fail('near needs a known point, a known tag, or x and z');
        }
        if (!OPS.includes(p.op) || !Number.isFinite(p.value)) fail('count needs op (' + OPS.join(' ') + ') and a numeric value');
    } else fail('unknown operator ' + keys[0]);
}
function tagOf(s, tag) {
    for (const seat of s.board.seats) for (const e of [...(seat.units || []), ...(seat.buildings || [])])
        if (e[3] && e[3].tag === tag) return e;
    return null;
}
function validate(s) {
    const fail = msg => { throw new Error(`${s && s.id || '?'}: ${msg}`); };
    if (!s || s.schema !== SCHEMA) fail('schema must be ' + SCHEMA);
    for (const k of ['id', 'family', 'title', 'objective']) if (typeof s[k] !== 'string' || !s[k]) fail('missing ' + k);
    if (!Number.isInteger(s.rounds) || s.rounds < 1 || s.rounds > 60) fail('rounds is 1..60');
    if (!s.board || !Array.isArray(s.board.seats) || s.board.seats.length !== 2) fail('board has two seats: subject, rival');
    if (!s.success || !['any', 'end'].includes(s.success.when)) fail('success.when is any or end');
    checkPredicate(s.success.predicate, 'success', s);
    if (s.failure) checkPredicate(s.failure, 'failure', s);
    if (s.invariant) {
        if (!Number.isInteger(s.invariant.from)) fail('invariant.from is a round');
        checkPredicate(s.invariant.predicate, 'invariant', s);
    }
    if (!Array.isArray(s.variants) || !s.variants.length) fail('variants: at least one');
    for (const v of s.variants) if (!VARIANTS[v]) fail('unknown variant ' + v);
    if (!Array.isArray(s.reference) || !s.reference.length) fail('a reference solution is required');
    for (const r of [...s.reference, ...(s.rival || [])]) if (!Number.isInteger(r.round) || r.round < 1 || r.round > s.rounds) fail('an order round is outside 1..rounds');
    const known = new Set(Object.keys(s.points || {}));
    for (const m of s.objective.matchAll(/\{\{(point:)?([A-Za-z0-9_-]+)\.(x|z)\}\}/g))
        if (m[1] ? !known.has(m[2]) : !tagOf(s, m[2])) fail('objective names unknown ' + (m[1] ? 'point ' : 'tag ') + m[2]);
    return s;
}

function load(file) { return validate(JSON.parse(fs.readFileSync(file, 'utf8'))); }
// Every scenario under a directory (benchmarks/scenarios by default), sorted by id.
function loadAll(dir = path.join(__dirname, '../../benchmarks/scenarios')) {
    const out = [];
    for (const fam of fs.readdirSync(dir).sort()) {
        const d = path.join(dir, fam);
        if (!fs.statSync(d).isDirectory()) continue;
        for (const f of fs.readdirSync(d).sort()) if (f.endsWith('.json')) out.push(load(path.join(d, f)));
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
}

// ---- Variants ----------------------------------------------------------------------
// The scenario with every coordinate moved by the variant. Pure data in, data out.
function instantiate(s, variant = 'identity') {
    const f = VARIANTS[variant];
    if (!f) throw new Error('unknown variant ' + variant);
    const c = JSON.parse(JSON.stringify(s));
    const move = e => { const [x, z] = f(e[1], e[2]); e[1] = x; e[2] = z; };
    for (const seat of c.board.seats) { (seat.units || []).forEach(move); (seat.buildings || []).forEach(move); }
    for (const k of Object.keys(c.points || {})) c.points[k] = f(c.points[k][0], c.points[k][1]);
    const moveParams = p => {
        if (p && Number.isFinite(p.targetX) && Number.isFinite(p.targetZ)) [p.targetX, p.targetZ] = f(p.targetX, p.targetZ);
    };
    (c.rival || []).forEach(o => moveParams(o.params));
    (c.reference || []).forEach(r => r.commands.forEach(o => moveParams(o.params)));
    const movePred = p => {
        if (!p || typeof p !== 'object') return;
        if (p.count && p.count.near && Number.isFinite(p.count.near.x)) [p.count.near.x, p.count.near.z] = f(p.count.near.x, p.count.near.z);
        for (const k of ['all', 'any']) if (p[k]) p[k].forEach(movePred);
        if (p.not) movePred(p.not);
    };
    movePred(c.success.predicate); movePred(c.failure); if (c.invariant) movePred(c.invariant.predicate);
    c.variant = variant;
    return c;
}

// ---- Predicates --------------------------------------------------------------------
function evaluate(p, w) {
    if (p.all) return p.all.every(q => evaluate(q, w));
    if (p.any) return p.any.some(q => evaluate(q, w));
    if (p.not) return !evaluate(p.not, w);
    if (p.destroyed != null) return gone(w.tags[p.destroyed], w);
    if (p.alive != null) return !gone(w.tags[p.alive], w);
    if (p.eliminated) return !!w.game.isPlayerEliminated(w.seat(p.eliminated));
    if (p.count) {
        const c = p.count, owner = w.seat(c.owner);
        let list = Array.from(c.kind === 'unit' ? owner.units : owner.buildings).filter(e => e.health > 0);
        if (c.type) list = list.filter(e => e.type === c.type);
        if (c.class === 'military') list = list.filter(e => e.type !== 'worker' && e.unitType !== 'support');
        else if (c.class === 'worker') list = list.filter(e => e.type === 'worker');
        else if (c.class) list = list.filter(e => e.unitType === c.class);
        if (c.near) {
            const at = c.near.point != null ? { x: w.points[c.near.point][0], z: w.points[c.near.point][1] }
                : c.near.tag != null ? w.tags[c.near.tag] : c.near;
            list = list.filter(e => Math.hypot(e.x - at.x, e.z - at.z) <= c.near.r);
        }
        const n = list.length, v = p.value;
        return { '>=': n >= v, '>': n > v, '==': n === v, '<': n < v, '<=': n <= v, '!=': n !== v }[p.op];
    }
    throw new Error('unknown predicate');
}
function gone(e, w) {
    if (!e) return true;
    if (!(e.health > 0)) return true;
    const owners = [w.seat('subject'), w.seat('rival')];
    return !owners.some(o => o.units.includes(e) || o.buildings.includes(e));
}

// ---- Episodes ----------------------------------------------------------------------
// The objective text with its placeholders filled from the board as it now stands.
function objectiveText(inst, tags) {
    return inst.objective.replace(/\{\{(point:)?([A-Za-z0-9_-]+)\.(x|z)\}\}/g, (m, isPoint, name, axis) => {
        const v = isPoint ? inst.points[name][axis === 'x' ? 0 : 1] : tags[name][axis];
        return String(Math.round(v));
    });
}
// {"$id": "tag"} anywhere in params becomes that entity's id.
function resolve(v, tags) {
    if (Array.isArray(v)) return v.map(x => resolve(x, tags));
    if (v && typeof v === 'object') {
        if (typeof v.$id === 'string') {
            if (!tags[v.$id]) throw new Error('unknown tag ' + v.$id);
            return tags[v.$id].id;
        }
        return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolve(x, tags)]));
    }
    return v;
}

// A fresh episode of `scenario` in `variant`: the started realm, both seats and a world
// view for the predicates. Nothing has been observed or ordered yet.
//
// The protocol is turn-based lockstep with ROUND_MS slices, and the seat's state says
// so exactly as an arena lockstep seat's does (clock.secondsToAnswer from the ceiling,
// clock.worldSecondsPerRound). The slice budget is unbounded here because the episode
// itself drives the world, a round at a time, through the frozen stepper.
async function begin(scenario, variant = 'identity', options = {}) {
    const inst = instantiate(scenario, variant);
    const { ceilingMs = CEILING_MS, ...realmOptions } = options;
    const realm = await createMatch({ kind: 'board', seed: inst.board.seed || inst.id, seats: inst.board.seats }, realmOptions);
    const mgr = realm.game.openAIAIManager;
    mgr.turnBased = true;
    mgr.roundTimeoutMs = () => ceilingMs;
    mgr.requestAbortMs = () => ceilingMs;
    realm.game._lockstep = { sliceMs: ROUND_MS, budget: Infinity };
    const [subject, rival] = realm.seats, [cs, cr] = realm.controllers;
    const world = { game: realm.game, tags: realm.tags, points: inst.points || {},
        seat: who => (who === 'subject' ? subject : rival) };
    return { inst, realm, mgr, subject, rival, subjectController: cs, rivalController: cr, world,
        objective: objectiveText(inst, realm.tags), ceilingMs };
}

// Play one episode. `policy(turn)` returns the subject's answer for a round -- a list of
// commands, or a whole envelope ({commands, objective, plan}) as a model's reply parses
// to, or null for no answer -- where turn = {round, state, episode} and state is exactly
// what a model would be sent this round (observed and committed, as a model turn does).
// Returns the outcome and a per-round log: what was ordered, what the executor
// answered, what held afterwards.
// `options.onRoundEnd(entry, episode)` is called after each round's step (bundles use
// it to record the world's hash); everything else in options goes to begin().
async function play(scenario, variant, policy, options = {}) {
    const { onRoundEnd = null, ...beginOptions } = options;
    const ep = await begin(scenario, variant, beginOptions);
    const { inst, realm, mgr, subjectController: cs, rivalController: cr, world } = ep;
    const log = [];
    // Each command's outcome code, as the executor drains it for the transcript. Read
    // by wrapping the drain on this episode's manager; nothing it does changes.
    let heard = [];
    const take = mgr.takeOutcomes.bind(mgr);
    mgr.takeOutcomes = c => { const list = take(c); if (c === cs) heard.push(...list); return list; };
    let outcome = null, round = 0;
    for (round = 1; round <= inst.rounds && !outcome; round++) {
        const state = mgr.buildGameStateJSON(cs);
        const answer = await policy({ round, state, episode: ep });
        const envelope = Array.isArray(answer) ? { commands: resolve(answer, realm.tags) } : (answer || { commands: [] });
        const commands = Array.isArray(envelope.commands) ? envelope.commands : [];
        const rivalOrders = (inst.rival || []).filter(o => o.round === round).map(o => resolve(o, realm.tags));
        // The two seats act in an order that rotates by round, as turn-based rounds do,
        // so neither side always moves first.
        const entry = { round, commands, results: null, rival: [] };
        const subjectActs = () => {
            if (!commands.length && envelope.objective === undefined && envelope.plan === undefined) { entry.results = null; return; }
            cs.lastActionResult = null;
            heard = [];
            mgr.executeTurn(cs, envelope);
            entry.results = cs.lastActionResult;
            entry.outcomes = heard.map(o => ({ action: o.action, code: o.code, verdict: o.verdict, class: classify(o) }));
        };
        const rivalActs = () => { for (const o of rivalOrders) { mgr.executeAction(cr, { action: o.action, params: o.params }); entry.rival.push(cr.lastActionResult); } };
        if (round % 2) { rivalActs(); subjectActs(); } else { subjectActs(); rivalActs(); }
        // The round's decision-log entries, held per seat in lockstep, go in now -- the
        // first half of flushRound, whose second half (running queued answers) the
        // episode has just done itself.
        for (const c of [cs, cr]) for (const k of ['pendingControl', 'pendingLog']) {
            if (c[k] && c[k].length) { for (const e of c[k]) mgr.commitDecision(e); c[k] = []; }
        }
        realm.advance(ROUND_MS);
        entry.simMs = realm.game.clock.simMs;
        if (inst.failure && evaluate(inst.failure, world)) outcome = 'failure';
        else if (inst.invariant && round >= inst.invariant.from && !evaluate(inst.invariant.predicate, world)) outcome = 'failure';
        else if (inst.success.when === 'any' && evaluate(inst.success.predicate, world)) outcome = 'success';
        else if (!realm.game.gameStarted) outcome = evaluate(inst.success.predicate, world) ? 'success' : 'failure';
        entry.after = outcome || 'running';
        log.push(entry);
        if (onRoundEnd) onRoundEnd(entry, ep);
    }
    if (!outcome) outcome = evaluate(inst.success.predicate, world) ? 'success' : 'failure';
    return { id: inst.id, family: inst.family, variant: inst.variant, outcome, rounds: log.length, log };
}

// The scenario's own proven solution, as a policy -- read from the episode's instance,
// whose coordinates the variant has already moved.
const referencePolicy = () => ({ round, episode }) => {
    const r = (episode.inst.reference || []).find(x => x.round === round);
    return r ? r.commands : [];
};
// Doing nothing at all.
const noopPolicy = () => () => [];

module.exports = { SCHEMA, ROUND_MS, CEILING_MS, VARIANTS, validate, load, loadAll, instantiate, evaluate, begin, play,
                   referencePolicy, noopPolicy };
