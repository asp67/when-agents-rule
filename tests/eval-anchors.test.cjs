// The anchor seats (Scale v4): tools/eval/anchors.cjs plays deterministic baseline policies
// against the rule-based brain and scores them with the same WarEval ledger a model uses.
const test = require('node:test'), assert = require('node:assert/strict');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const WarEval = require(path.join(root, 'js/eval/ledger.js'));
const { ANCHORS, playOne, summarize, report } = require(path.join(root, 'tools/eval/anchors.cjs'));

const played = {};
const play = async anchor => played[anchor] || (played[anchor] = await playOne({ anchor, seed: 'anchor-1', minutes: 3, roundSec: 30, civs: ['greek', 'persian'] }));
const seatOf = r => WarEval.profileOf(r.text).seats.find(s => s.name === r.anchor);

test('a seat that does nothing scores near zero and is still ranked in the match', async () => {
    const r = await play('do-nothing'), s = seatOf(r);
    assert.deepEqual([r.rounds, s.decisions, s.grounding.judged, s.grounding.score, s.macro.score], [6, 6, 0, 0, 0]);
    assert.ok(s.strategy.samples >= 30 && s.strategy.powerShare > 0 && s.strategy.powerShare < 0.5);
    assert.deepEqual([s.strategy.final, s.strategy.rank, s.strategy.of], [true, 2, 2]);
    assert.ok(s.index.value < 10, 'do-nothing WAR Score ' + s.index.value);
    const rival = WarEval.profileOf(r.text).seats.find(x => x.name === 'rule-based');
    assert.deepEqual([rival.decisions, rival.strategy.rank, rival.index.value], [0, 1, null]);
});

test('a seat that only waits has zero rated commands and cannot farm Grounding or WAR Score', async () => {
    const s = seatOf(await play('wait-only'));
    assert.deepEqual([s.grounding.judged, s.grounding.ok, s.grounding.waits, s.grounding.rated, s.grounding.score], [6, 6, 6, 0, 0]);
    assert.deepEqual([s.macro.score, Array.from(s.versatility.orders)], [0, ['wait']]);
    assert.equal(s.index.of, 5);
    assert.ok(s.index.value < 10, 'wait-only WAR Score ' + s.index.value);
});

test('a seat that states a plan and only waits scores like wait-only (no free plan credit)', async () => {
    const s = seatOf(await play('plan-only'));
    assert.equal(s.plan.statements, 1);
    assert.equal(s.plan.standing.steps.length, 5);
    assert.deepEqual([s.grounding.score, s.macro.score, s.index.of], [0, 0, 5]);
    assert.ok(s.index.value < 10, 'plan-only WAR Score ' + s.index.value);
});

test('safe-spam (valid assign_workers cycling) cannot game Macro, Spatial, or Tactical', async () => {
    const s = seatOf(await play('safe-spam'));
    assert.equal(s.grounding.rated, 6);
    assert.equal(s.grounding.score, 100);
    assert.equal(s.macro.score, 0, 'safe worker shuffling earns 0 Macro');
    assert.ok(s.spatial.score <= 15, 'no exploration beyond starting Town Center fog: ' + s.spatial.score);
    assert.ok(s.tactical.score <= 5, 'zero activity gate keeps neutral tactical at 0: ' + s.tactical.score);
    assert.ok(s.index.value < 25, 'safe-spam WAR Score ' + s.index.value);
});

test('random-valid names only what its state shows: refused for the world\'s reasons, never invalid', async () => {
    const r = await play('random-valid'), s = seatOf(r);
    assert.ok(s.grounding.judged >= 6, 'only ' + s.grounding.judged + ' commands judged');
    assert.equal(s.grounding.invalid, 0);
    assert.ok(s.grounding.avoidable > 0, 'a random seat that is never refused is not random');
    assert.ok(s.index.value < 35, 'random-valid WAR Score ' + s.index.value);
    const again = await playOne({ anchor: 'random-valid', seed: 'anchor-1', minutes: 3, roundSec: 30, civs: ['greek', 'persian'] });
    assert.equal(again.text, r.text);
});

test('the summary is one row per anchor, averaged over its matches, in WarEval.SCORED', async () => {
    const matches = [];
    for (const a of ANCHORS) matches.push(await play(a));
    const sum = summarize(matches);
    assert.deepEqual(Object.keys(sum), ['do-nothing', 'wait-only', 'plan-only', 'safe-spam', 'random-valid']);
    for (const a of ANCHORS) {
        assert.equal(sum[a].matches, 1);
        assert.equal(sum[a].index, seatOf(played[a]).index.value);
        for (const k of WarEval.SCORED) assert.equal(sum[a][k], seatOf(played[a])[k].score, a + ' ' + k);
    }
    const text = report(sum);
    assert.match(text, /^ANCHOR +matches +decisions +commands rated +valid +eliminated +grounding +macro +spatial +tactical +strategy +WAR Score +of parts/);
    assert.match(text, /safe-spam +1 +6 +6 +100\.0 %/);
});

test('docs/SCORING.md matches WarEval constants and documents all Scale v4 anchors and pillars', () => {
    const fs = require('node:fs');
    const doc = fs.readFileSync(path.join(root, 'docs/SCORING.md'), 'utf8').replace(/\s+/g, ' ');
    assert.ok(doc.includes('Scale `' + WarEval.SCALE + '`') || doc.includes('scale `' + WarEval.SCALE + '`'));
    assert.deepEqual([WarEval.RESPONSE_WINDOW, WarEval.RESPONSE_RADIUS, WarEval.HOME_RADIUS, WarEval.LEAD_FACTOR, WarEval.LEAD_SECONDS], [3, 50, 110, 1.25, 300]);
    assert.deepEqual(WarEval.WEIGHTS, { grounding: 0.20, macro: 0.25, spatial: 0.15, tactical: 0.15, strategy: 0.25 });
    for (const sym of ['RESPONSE_WINDOW = 3', 'RESPONSE_RADIUS = 50', 'HOME_RADIUS = 110', 'WARMUP_SEC', 'DRIFT_MIN_DECISIONS = 16']) {
        assert.ok(doc.includes(sym), 'SCORING.md missing ' + sym);
    }
    for (const a of ANCHORS) assert.ok(doc.includes('| `' + a + '` |'), 'SCORING.md missing anchor ' + a);
    for (const part of ['**Grounding**', '**Macro & Agency**', '**Spatial & Fog**', '**Tactical & Combat**', '**Dominance**']) {
        assert.ok(doc.includes('| ' + part + ' |'), 'SCORING.md missing pillar ' + part);
    }
    assert.equal(WarEval.SCORED.length, 5);
});
