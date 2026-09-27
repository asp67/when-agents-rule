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
    return replay.ok
        ? { ok: true, inputs: inputs.length, checked: replay.checked, steps: replay.step }
        : { ok: false, problem: replay.problem, divergedAt: replay.divergedAt, checked: replay.checked };
}

if (require.main === module) {
    const file = process.argv[2];
    replayTranscript(parse(fs.readFileSync(file, 'utf8'))).then(v => {
        console.log(v.ok ? `re-simulated: ${v.checked} inputs, every state hash matches (step ${v.steps})` : 'NOT re-simulated: ' + v.problem);
        process.exitCode = v.ok ? 0 : 1;
    }, e => { console.error(e.message); process.exitCode = 1; });
}

module.exports = { replayTranscript, parse };
