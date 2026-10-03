'use strict';
// Re-simulate an arena transcript (review #9, WAR side) in the reference realm: rebuild
// the match from its header and apply every step-stamped input in order, checking the
// state hash each one recorded. The logic is js/resim.js, shared with the analyzer's
// "Re-simulated" mode; this is its Node driver.
//
//   node tools/bench/transcript-replay.cjs <transcript.jsonl>
const fs = require('node:fs');
const path = require('node:path');
const { createMatch } = require('./realm.cjs');
const WarResim = require(path.join(__dirname, '../../js/resim.js'));

function parse(text) { return text.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean); }

async function replayTranscript(recs, { sources = null } = {}) {
    const header = WarResim.header(recs), inputs = WarResim.inputs(recs);
    const refusal = WarResim.refusal(header, inputs);
    if (refusal) return { ok: false, problem: refusal };
    const spec = WarResim.spec(header);
    const realm = await createMatch({ kind: 'arena', seats: spec.setup, seed: spec.seed, difficulty: spec.difficulty }, sources ? { sources } : {});
    const replay = new WarResim.Replay(realm.game, header, inputs, ms => realm.advance(ms));
    if (replay.ok) replay.to(replay.lastInputStep);
    if (replay.ok) return { ok: true, inputs: inputs.length, checked: replay.checked, steps: replay.step };
    // At a checkpoint the digest names what differs; the replay's own values for those
    // entities are what the recording disagrees with (b1048).
    const detail = replay.detail ? replay.detail.entries.slice(0, 20).map(e => {
        const seat = e.seat && realm.game.aiManager.aiPlayers.find(p => p.id === e.seat);
        const list = seat && (e.part === 'unit' ? seat.units : e.part === 'building' ? seat.buildings : null);
        const ent = list && e.key != null && list.find(x => String(x.handle != null && e.part === 'unit' ? x.handle : x.id) === String(e.key));
        const now = ent ? Object.fromEntries(['type', 'x', 'z', 'health', 'task', 'isMoving', 'isAttacking', 'targetX', 'targetZ', 'attackTimer', 'carryingResource', 'harvestAmount']
            .filter(k => ent[k] !== undefined).map(k => [k, ent[k]])) : null;
        return Object.assign({}, e, now ? { replay: now } : {});
    }) : null;
    return { ok: false, problem: replay.problem, divergedAt: replay.divergedAt, checked: replay.checked, detail };
}

if (require.main === module) {
    const file = process.argv[2];
    replayTranscript(parse(fs.readFileSync(file, 'utf8'))).then(v => {
        console.log(v.ok ? `re-simulated: ${v.checked} inputs, every state hash matches (step ${v.steps})` : 'NOT re-simulated: ' + v.problem);
        if (v.detail) v.detail.forEach(d => console.log('  ' + JSON.stringify(d)));
        process.exitCode = v.ok ? 0 : 1;
    }, e => { console.error(e.message); process.exitCode = 1; });
}

module.exports = { replayTranscript, parse };
