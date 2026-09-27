'use strict';
// Re-simulate an arena transcript (review #9, WAR side): rebuild the match from its
// header -- map seed, difficulty, the seats and their styles -- and apply every
// step-stamped input line in order, checking the state hash each one recorded. A match
// that reaches every hash is certified: the rules produce the recorded world from the
// recorded inputs alone. It stops at the first difference and names the step.
//
//   node tools/bench/transcript-replay.cjs <transcript.jsonl>
//
// Inputs (js/openai-ai.js noteInput): observe {turnCount} -- a request's state committed;
// batch {envelope} -- a seat's answer run; speed {speed}; demote. Only arena transcripts
// carry them, and only from the build that records them.
const fs = require('node:fs');
const { createMatch } = require('./realm.cjs');

function parse(text) { return text.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean); }

async function replayTranscript(recs, { sources = null } = {}) {
    const header = recs.find(r => r && r.type === 'match');
    if (!header) return { ok: false, problem: 'no match header' };
    if (header.mode && header.mode !== 'arena') return { ok: false, problem: 'only arena matches are re-simulated' };
    const inputs = recs.filter(r => r.type === 'input').sort((a, b) => a.step - b.step || a.seq - b.seq);
    if (!inputs.length) return { ok: false, problem: 'this transcript records no inputs (recorded before inputs were)' };
    const players = header.players || [];
    const setup = players.map(p => ({ civ: p.civ, type: 'ki', ...(p.model === 'ki' && p.profile ? { profile: p.profile } : {}) }));
    const realm = await createMatch({ kind: 'arena', seats: setup, seed: header.mapSeed, difficulty: header.difficulty || 'easy' }, sources ? { sources } : {});
    const g = realm.game, mgr = g.openAIAIManager;
    if (header.wonderRequired) g.wonderRequired = header.wonderRequired;
    // The same seeded ids, or this is not the same match.
    const ids = realm.seats.map(s => s.id), recorded = players.map(p => p.id);
    if (JSON.stringify(ids) !== JSON.stringify(recorded)) return { ok: false, problem: `the rebuilt seats are not the recorded ones (${ids} vs ${recorded})` };
    const controllers = new Map();
    players.forEach((p, i) => { if (p.model !== 'ki') controllers.set(p.id, realm.scripted(realm.seats[i])); });
    let checked = 0;
    for (const r of inputs) {
        const ahead = r.step - g.clock.stepNo;
        if (ahead < 0) return { ok: false, problem: `input ${r.seq} is at step ${r.step}, behind the world (${g.clock.stepNo})`, checked };
        if (ahead) realm.advance(ahead * 50);
        if (g.clock.stepNo !== r.step) return { ok: false, problem: `the match ended at step ${g.clock.stepNo}, before input ${r.seq} at step ${r.step}`, checked };
        const c = r.playerId ? controllers.get(r.playerId) : null;
        if (r.playerId && !c && r.kind !== 'demote') return { ok: false, problem: `input ${r.seq} names seat ${r.playerId}, which no model played`, checked };
        if (r.kind === 'observe') { c.turnCount = r.turnCount || 0; mgr.buildGameStateJSON(c); }
        else if (r.kind === 'batch') { if (r.turnCount != null) c.turnCount = r.turnCount; mgr.executeTurn(c, r.envelope); }
        else if (r.kind === 'speed') g.setSimSpeed(r.speed);
        else if (r.kind === 'demote') mgr.demoteToRuleBased(c);
        else return { ok: false, problem: 'unknown input kind ' + r.kind, checked };
        if (r.stateHash && g.stateHash() !== r.stateHash) return { ok: false, problem: `diverged at step ${r.step} (input ${r.seq}, ${r.kind})`, divergedAt: r.step, checked };
        checked++;
    }
    return { ok: true, inputs: inputs.length, checked, steps: g.clock.stepNo };
}

if (require.main === module) {
    const file = process.argv[2];
    replayTranscript(parse(fs.readFileSync(file, 'utf8'))).then(v => {
        console.log(v.ok ? `re-simulated: ${v.checked} inputs, every state hash matches (step ${v.steps})` : 'NOT re-simulated: ' + v.problem);
        process.exitCode = v.ok ? 0 : 1;
    }, e => { console.error(e.message); process.exitCode = 1; });
}

module.exports = { replayTranscript, parse };
