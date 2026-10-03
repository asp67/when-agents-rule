// ---------------------------------------------------------------------------
// Re-simulation from a transcript's inputs (review #9, WAR side).
//
// Since build 952 an arena transcript records every input that changes the world,
// stamped with its simulation step and a hash of the world just after it
// (OpenAIAIManager.noteInput). This file rebuilds the match from the header and
// applies those inputs in order, checking every hash. A match that reaches them all is
// certified: the rules produced the recorded world from the recorded inputs alone.
//
// One core for both places that re-simulate: tools/bench/transcript-replay.cjs in
// Node, and js/resim-worker.js behind the analyzer's "Re-simulated" mode. It holds no
// engine of its own; the caller brings a started arena and a way to advance it.
// ---------------------------------------------------------------------------
var WarResim = {
    header(recs) { return recs.find(r => r && r.type === 'match') || null; },
    // In (step, seq) order: a file's lines are flushed per buffer, not in order.
    inputs(recs) { return recs.filter(r => r && r.type === 'input').sort((a, b) => a.step - b.step || a.seq - b.seq); },

    // Why this transcript cannot be re-simulated, or null if it can.
    refusal(header, inputs) {
        if (!header) return 'no match header';
        if (header.mode && header.mode !== 'arena') return 'only arena matches are re-simulated';
        if (!inputs.length) return 'this transcript records no inputs (recorded before inputs were)';
        const lanes = inputs.some(r => r.lane != null && r.lane > 0);
        if (lanes) return 'a seat played with several lanes, which re-simulation does not cover yet';
        return null;
    },

    // The arena start spec: every seat rule-based, so nothing asks a model. The seats a
    // model played are then taken over by WarResim.seat, which only ever acts on inputs.
    // What differs between a recorded checkpoint digest and the world's (Game.stateDigest):
    // null when nothing, else { summary, entries } naming seat, entity and field group.
    digestDiff(rec, now) {
        const names = ['position', 'health', 'orders', 'timers/cargo'];
        const parse = s => new Map(String(s || '').split(',').filter(Boolean).map(x => { const i = x.lastIndexOf(':'); return [x.slice(0, i), x.slice(i + 1)]; }));
        const entries = [];
        if (rec.nodes !== now.nodes) entries.push({ part: 'nodes', what: 'resource node amounts' });
        for (const id of new Set(Object.keys(rec.seats || {}).concat(Object.keys(now.seats || {})))) {
            const a = (rec.seats || {})[id], b = (now.seats || {})[id];
            if (!a || !b) { entries.push({ seat: id, part: 'seat', what: a ? 'missing in the replay' : 'not recorded' }); continue; }
            if (a.r !== b.r) entries.push({ seat: id, part: 'resources', what: 'resources, age or research' });
            for (const [part, key] of [['unit', 'u'], ['building', 'b']]) {
                // A checkpoint without the detail: the seat's list as one hash.
                if (a[key] == null) {
                    if (a[key + 'h'] != null && a[key + 'h'] !== b[key + 'h']) entries.push({ seat: id, part, what: part + 's differ (the next detailed checkpoint names them)' });
                    continue;
                }
                const ma = parse(a[key]), mb = parse(b[key]);
                for (const [k, h] of ma) {
                    const g = mb.get(k);
                    if (g == null) entries.push({ seat: id, part, key: k, what: 'recorded, absent in the replay' });
                    else if (g !== h) entries.push({ seat: id, part, key: k,
                        what: names.filter((n, i) => h.slice(i * 2, i * 2 + 2) !== g.slice(i * 2, i * 2 + 2)).join(' + ') });
                }
                for (const k of mb.keys()) if (!ma.has(k)) entries.push({ seat: id, part, key: k, what: 'in the replay, not recorded' });
                const order = [...ma.keys()].filter(k => mb.has(k)).join() !== [...mb.keys()].filter(k => ma.has(k)).join();
                if (order) entries.push({ seat: id, part, what: 'the same ' + part + 's in a different order' });
            }
        }
        if (!entries.length) return null;
        const head = entries.slice(0, 3).map(e => [e.seat && e.seat.slice(-4), e.part, e.key, e.what].filter(Boolean).join(' ')).join('; ');
        return { summary: head + (entries.length > 3 ? ` (+${entries.length - 3} more)` : ''), entries };
    },

    spec(header) {
        return {
            setup: (header.players || []).map(p => Object.assign({ civ: p.civ, type: 'ki' },
                p.model === 'ki' && p.profile ? { profile: p.profile } : {})),
            seed: header.mapSeed, difficulty: header.difficulty || 'easy', turnBased: false,
        };
    },

    // A model seat with no model: the rule-based brain leaves it alone and the harness
    // never asks it (paused); it moves only by the inputs applied below. The same shape
    // as the bench realm's scripted seat.
    seat(game, ai) {
        const mgr = game.openAIAIManager;
        game.aiManager.markAsOpenAIControlled(ai.id);
        const c = {
            id: ai.id, aiPlayer: ai, model: { name: 'replay', model: 'replay', language: 'en' },
            lastTurnTime: 0, turnCount: 0, paused: true, conversationHistory: [], turnLog: [],
            _pendingTurnUser: null, lastActionResult: null, pendingAdvice: [], objective: '', plan: [],
            pendingAttackReports: [], stats: mgr.newStats(), lanes: [],
        };
        c.seat = c;
        mgr.aiControllers.push(c);
        return c;
    },
};

// A re-simulation in progress. `advance(ms)` moves the started arena's world by whole
// 50 ms steps (the frozen driver). `to(step)` applies every input up to that step,
// checking each hash, and leaves the world at `step`. It stops for good at the first
// difference; `problem` says why and `divergedAt` where.
WarResim.Replay = class {
    constructor(game, header, inputs, advance) {
        this.game = game; this.header = header; this.inputs = inputs; this.advance = advance;
        this.next = 0; this.checked = 0; this.problem = null; this.divergedAt = null; this.divergedSeq = null;
        this.lastInputStep = inputs.length ? inputs[inputs.length - 1].step : 0;
        this.seats = new Map();
        const players = header.players || [];
        const ais = game.aiManager.aiPlayers;
        const ids = ais.map(a => a.id), recorded = players.map(p => p.id);
        // The same seeded ids, or this is not the same match.
        if (JSON.stringify(ids) !== JSON.stringify(recorded)) {
            this.problem = `the rebuilt seats are not the recorded ones (${ids} vs ${recorded})`;
            return;
        }
        if (header.wonderRequired) game.wonderRequired = header.wonderRequired;
        game.wonderPace = header.wonderPace || 1;   // not recorded before build 1021, where it was 1
        players.forEach((p, i) => { if (p.model !== 'ki') this.seats.set(p.id, WarResim.seat(game, ais[i])); });
    }
    get step() { return this.game.clock.stepNo; }
    get ok() { return !this.problem; }
    get complete() { return this.ok && this.next >= this.inputs.length; }

    to(target) {
        const g = this.game, mgr = g.openAIAIManager;
        const fail = (problem, at = null) => { this.problem = problem; this.divergedAt = at; return false; };
        while (this.ok && this.next < this.inputs.length && this.inputs[this.next].step <= target) {
            const r = this.inputs[this.next];
            if (r.step < g.clock.stepNo) return fail(`input ${r.seq} is at step ${r.step}, behind the world (${g.clock.stepNo})`);
            if (r.step > g.clock.stepNo) this.advance((r.step - g.clock.stepNo) * 50);
            if (g.clock.stepNo !== r.step) return fail(`the match ended at step ${g.clock.stepNo}, before input ${r.seq} at step ${r.step}`);
            const c = r.playerId ? this.seats.get(r.playerId) : null;
            if (r.playerId && !c) return fail(`input ${r.seq} names seat ${r.playerId}, which no model played`);
            if (r.kind === 'observe') { c.turnCount = r.turnCount || 0; mgr.buildGameStateJSON(c); }
            else if (r.kind === 'batch') { if (r.turnCount != null) c.turnCount = r.turnCount; mgr.executeTurn(c, r.envelope); }
            else if (r.kind === 'speed') g.setSimSpeed(r.speed);
            else if (r.kind === 'demote') mgr.demoteToRuleBased(c);
            else if (r.kind === 'checkpoint') {
                // Nothing to apply: compare, finely, and say what differs (b1048).
                const diff = r.digest && g.stateDigest ? WarResim.digestDiff(r.digest, g.stateDigest()) : null;
                if (diff) { this.divergedSeq = r.seq; this.detail = diff; return fail(`diverged at step ${r.step} (checkpoint ${r.seq}): ${diff.summary}`, r.step); }
            }
            else return fail('unknown input kind ' + r.kind);
            if (r.stateHash && g.stateHash() !== r.stateHash) { this.divergedSeq = r.seq; return fail(`diverged at step ${r.step} (input ${r.seq}, ${r.kind})`, r.step); }
            this.checked++; this.next++;
        }
        if (this.ok && target > g.clock.stepNo && g.gameStarted) this.advance((target - g.clock.stepNo) * 50);
        return this.ok;
    }

    // The world at this step, as the analyzer draws it: every seat's units and
    // buildings with the fields the renderer reads, and the resource nodes.
    scene() {
        const g = this.game;
        return {
            step: g.clock.stepNo,
            // The match clock (real match time) for the stage's daylight, as the live
            // game's runs on it; and the rules' clock with the fights it tracks, for the
            // strategic layer's battle rings.
            matchMs: g.clock.matchMs, simNow: g.simNow(),
            battles: (g._battles || []).map(e => ({ x: e.x, z: e.z, lastAt: e.lastAt,
                sides: Object.fromEntries(Object.entries(e.sides || {}).map(([id, side]) => [id, { involved:
                    Object.fromEntries(Object.entries((side && side.involved) || {}).map(([k, v]) => [k, { ids: v && v.ids ? [...v.ids] : [] }])) }])) })),
            seats: g.aiManager.aiPlayers.map(ai => ({
                id: ai.id, seat: ai.seat, civilization: ai.civilization, epoch: ai.age || 'stone',
                eliminated: !!ai.eliminated,
                units: ai.units.filter(u => u.health > 0).map(u => ({
                    id: u.id, type: u.type, x: u.x, z: u.z, health: u.health,
                    isMoving: !!u.isMoving, isAttacking: !!u.isAttacking, isHarvesting: !!u.isHarvesting,
                    isBuilding: !!u.isBuilding, carryingResource: u.carryingResource || 0, attackTimer: u.attackTimer || 0,
                    carryingResourceType: u.carryingResourceType || null,
                    // Where it is going and what it is doing: the analyzer's director
                    // reads marches, scouts and threats from these (b1010).
                    targetX: u.isMoving && Number.isFinite(u.targetX) ? u.targetX : null,
                    targetZ: u.isMoving && Number.isFinite(u.targetZ) ? u.targetZ : null,
                    task: u.task || null,
                    attackTarget: u.attackTarget ? { x: u.attackTarget.x, z: u.attackTarget.z, health: u.attackTarget.health,
                        owner: u.attackTarget.owner, id: u.attackTarget.id } : null,
                })),
                buildings: ai.buildings.filter(b => b.health > 0).map(b => ({
                    // Its own epoch: an age-up restyles every building of the seat
                    // (morphBuildingsToAge), and the stage must follow that, not freeze
                    // each one at the age it had when first seen.
                    id: b.id, type: b.type, age: b.age || null, x: b.x, z: b.z, health: b.health,
                    underConstruction: !!b.underConstruction, buildProgress: b.buildProgress || 0,
                })),
            })),
            nodes: ((g.terrain && g.terrain.resources) || []).filter(n => n.amount > 0)
                .map(n => ({ type: n.type, x: n.x, z: n.z, amount: n.amount })),
        };
    }
};

if (typeof module !== 'undefined' && module.exports) module.exports = WarResim;
