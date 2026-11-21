// The anchor seats (overhaul step C6): tools/eval/anchors.cjs plays seats that cannot
// play against the rule-based brain and scores them with the ledger a model is scored
// with. Held here, on matches of a few minutes: that each anchor is what it says it is,
// and that its decisions arrive at the ledger as a model's would.
const test = require('node:test'), assert = require('node:assert/strict');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const WarEval = require(path.join(root, 'js/eval/ledger.js'));
const { ANCHORS, playOne, summarize, report } = require(path.join(root, 'tools/eval/anchors.cjs'));

const played = {};
const play = async anchor => played[anchor] || (played[anchor] = await playOne({ anchor, seed: 'anchor-1', minutes: 3, roundSec: 30, civs: ['greek', 'persian'] }));
const seatOf = r => WarEval.profileOf(r.text).seats.find(s => s.name === r.anchor);

test('a seat that does nothing has nothing to be judged on, and is still in the match', async () => {
    const r = await play('do-nothing'), s = seatOf(r);
    assert.deepEqual([r.rounds, s.decisions, s.grounding.judged, s.grounding.score, s.planning.score], [6, 6, 0, null, 0]);
    // The match's own sampler wrote its power down every five seconds, and the results rank it.
    assert.ok(s.strategy.samples >= 30 && s.strategy.powerShare > 0 && s.strategy.powerShare < 0.5);
    assert.deepEqual([s.strategy.final, s.strategy.rank, s.strategy.of], [true, 2, 2]);
    // The rule-based seat is in the profile with a strategy row and nothing else to score.
    const rival = WarEval.profileOf(r.text).seats.find(x => x.name === 'rule-based');
    assert.deepEqual([rival.decisions, rival.strategy.rank, rival.index.value], [0, 1, null]);
});

test('a seat that only waits is always valid: the anchor that shows what a rate alone is worth', async () => {
    const s = seatOf(await play('wait-only'));
    assert.deepEqual([s.grounding.judged, s.grounding.ok, s.grounding.score, s.planning.score, Array.from(s.versatility.orders)], [6, 6, 100, 0, ['wait']]);
});

test('a seat that states a plan and never acts has a plan and no follow-through', async () => {
    const s = seatOf(await play('plan-only'));
    assert.deepEqual([s.planning.statements, s.planning.steps, s.planning.concrete, s.planning.coverage], [1, 5, 5, 1]);
    // Six decisions in, its five steps are still open: nothing acted on, and too early to call them dropped.
    assert.deepEqual([s.follow.steps, s.follow.acted, s.follow.pending, s.follow.score], [5, 0, 5, null]);
});

test('random-valid names only what its state shows: refused for the world\'s reasons, never invalid', async () => {
    const r = await play('random-valid'), s = seatOf(r);
    assert.ok(s.grounding.judged >= 6, 'only ' + s.grounding.judged + ' commands judged');
    assert.equal(s.grounding.invalid, 0);
    assert.ok(s.grounding.avoidable > 0, 'a random seat that is never refused is not random');
    assert.deepEqual([s.planning.score, s.follow.score], [0, 0]);
    // The same seed plays the same match.
    const again = await playOne({ anchor: 'random-valid', seed: 'anchor-1', minutes: 3, roundSec: 30, civs: ['greek', 'persian'] });
    assert.equal(again.text, r.text);
});

test('the summary is one row per anchor, averaged over its matches, in the scorer\'s own parts', async () => {
    const matches = [];
    for (const a of ANCHORS) matches.push(await play(a));
    const sum = summarize(matches);
    assert.deepEqual(Object.keys(sum), ['do-nothing', 'wait-only', 'plan-only', 'random-valid']);
    for (const a of ANCHORS) {
        assert.equal(sum[a].matches, 1);
        assert.equal(sum[a].index, seatOf(played[a]).index.value);
        for (const k of WarEval.SCORED) assert.equal(sum[a][k], seatOf(played[a])[k].score, a + ' ' + k);
    }
    const text = report(sum);
    assert.match(text, /ANCHOR +matches +decisions +commands judged +valid +eliminated +grounding +planning +follow +tactical +strategy +Index +of parts/);
    assert.match(text, /do-nothing +1 +6 +0 +- +0 +- +0/);
});

test('the scoring document quotes what the code holds', () => {
    const fs = require('node:fs');
    const doc = fs.readFileSync(path.join(root, 'docs/SCORING.md'), 'utf8').replace(/\s+/g, ' ');
    const r = WarEval.READER.heldOut, pct = v => (v * 100).toFixed(1) + ' %';
    assert.ok(doc.includes(`On the ${r.steps} it was never adjusted against, ${pct(r.precision)} of what it reports is in the step, and it finds ${pct(r.recall)} of what is`));
    assert.ok(doc.includes(`against ${WarEval.READER.steps} plan steps`));
    assert.ok(doc.includes('Scale `' + WarEval.SCALE + '`') || doc.includes('scale `' + WarEval.SCALE + '`'));
    assert.deepEqual([WarEval.FOLLOW_WINDOW, WarEval.RESPONSE_WINDOW, WarEval.LEAD_FACTOR, WarEval.LEAD_SECONDS], [10, 3, 1.25, 300]);
    for (const said of ['within ten decisions', 'within three decisions', 'a quarter more power than the next seat, held five minutes']) assert.ok(doc.includes(said), said);
    // Every anchor the tool plays is in the document's table, and every scored part has its row.
    for (const a of ANCHORS) assert.ok(doc.includes('| ' + a + ' |'), a);
    for (const part of ['**Grounding**', '**Planning**', '**Follow-through**', '**Tactical**', '**Strategy**']) assert.ok(doc.includes('| ' + part + ' |'), part);
    assert.equal(WarEval.SCORED.length, 5);
});
