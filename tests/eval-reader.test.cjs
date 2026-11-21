// The step reader (overhaul step C3): what a plan step commits its seat to.
//
// tests/eval-reader-steps.json holds 384 plan steps drawn from the shipped matches (up
// to six per seat, evenly spaced over its new steps), each with the commitments a reader
// finds in it. They were read by Claude Fable 5.2 on 21 November 2026, by these rules: a
// commitment is something a later successful command could confirm; a unit or building
// that is only mentioned (a host building, a unit that is moving, anything of a rival's)
// is not one; "save for Y" commits to Y; "only if", "fallback" and "consider" commit to
// nothing, and neither does what is already under way.
//
// The odd-numbered steps are the half the reader was adjusted against, the even-numbered
// ones the half it never was. WarEval.READER states the rates on both; this test
// recomputes them, so a change to the reader that moves them has to say so.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const root = path.resolve(__dirname, '..');
const WarEval = require(path.join(root, 'js/eval/ledger.js'));
const steps = JSON.parse(fs.readFileSync(path.join(__dirname, 'eval-reader-steps.json'), 'utf8'));

const vocabs = new Map();
function vocabOf(file, seat) {
    if (!vocabs.has(file)) {
        const l = WarEval.createLedger(), by = new Map();
        for (const line of fs.readFileSync(path.join(root, 'samples', file), 'utf8').split('\n')) l.addLine(line);
        for (const s of l.seats.values()) if (!by.has(s.name || s.model || s.id)) by.set(s.name || s.model || s.id, s.vocab);
        vocabs.set(file, by);
    }
    return vocabs.get(file).get(seat);
}
function measure(part) {
    const t = { steps: 0, tp: 0, fp: 0, fn: 0, yes: 0, falseYes: 0, missedYes: 0 };
    steps.forEach((s, i) => {
        if ((i % 2 === 0 ? 'tuned' : 'heldOut') !== part) return;      // the first step is number 1: odd, tuned
        const vocab = vocabOf(s.file, s.seat);
        assert.ok(vocab, 'no such seat: ' + s.seat + ' in ' + s.file);
        const got = new Set(WarEval.checkable(s.text, vocab).map(c => c.kind + ':' + c.name)), want = new Set(s.commits);
        let tp = 0;
        for (const g of got) if (want.has(g)) tp++;
        t.steps++; t.tp += tp; t.fp += got.size - tp; t.fn += want.size - tp;
        if (got.size && want.size) t.yes++; else if (got.size) t.falseYes++; else if (want.size) t.missedYes++;
    });
    const r = v => Math.round(v * 1000) / 1000;
    return { steps: t.steps, precision: r(t.tp / (t.tp + t.fp)), recall: r(t.tp / (t.tp + t.fn)),
        checkablePrecision: r(t.yes / (t.yes + t.falseYes)), checkableRecall: r(t.yes / (t.yes + t.missedYes)) };
}

test('the labelled steps are the ones that were read, from matches that ship', () => {
    assert.equal(steps.length, WarEval.READER.steps);
    for (const s of steps) {
        assert.ok(fs.existsSync(path.join(root, 'samples', s.file)), s.file);
        for (const c of s.commits) assert.match(c, /^(train|build|research):[a-z_]+$|^(age:age|wonder:wonder|attack:attack|explore:explore)$/, s.text);
    }
});

test('on the half it was never adjusted against, the reader is as good as it says', () => {
    assert.deepEqual(measure('heldOut'), WarEval.READER.heldOut);
    assert.ok(WarEval.READER.heldOut.precision >= 0.9 && WarEval.READER.heldOut.recall >= 0.9);
});

test('and on the half it was adjusted against', () => {
    assert.deepEqual(measure('tuned'), WarEval.READER.tuned);
});

// ---- the rules, one example each ---------------------------------------------------------
const vocab = { units: new Set(['worker', 'militia', 'archer', 'champion', 'scout', 'scout_cavalry', 'priest']),
    buildings: new Set(['town_center', 'house', 'farm', 'barracks', 'archery_range', 'stable', 'tower', 'temple', 'wonder']),
    techs: new Set(['house', 'farm', 'barracks', 'archery', 'longbow', 'siege_engineering']),
    opponents: new Set(['egyptian-1', 'egyptian', 'greek-2', 'greek']), wonders: new Set(['wonder', 'akropolis']) };
const read = text => WarEval.checkable(text, vocab).map(c => c.kind + ':' + c.name).sort().join(' ');

test('a name alone commits to nothing: it takes a word of making, building or attacking', () => {
    assert.equal(read('Train militia and archers'), 'train:archer train:militia');
    assert.equal(read('Champion #36 scouts the north'), 'explore:explore');        // an existing unit, moving
    assert.equal(read('Raid with archers'), 'attack:attack');                      // the ones it has
    assert.equal(read('Assign idle workers to the food node'), '');                // people are moved far more often than made
    assert.equal(read('Train more workers'), 'train:worker');
    assert.equal(read('Keep the Town Center producing workers'), 'train:worker');
    assert.equal(read('Kill their workers first'), 'attack:attack');
    assert.equal(read('Build a house near the Town Center'), 'build:house');       // where, not what
    assert.equal(read('Train militia at the barracks'), 'train:militia');
    assert.equal(read('Train archers from the archery range'), 'train:archer');    // and "archery" is not the technology
    assert.equal(read('Research house, then farm and barracks'), 'build:barracks build:farm build:house');
    assert.equal(read('Research longbow'), 'research:longbow');
    assert.equal(read('Expand housing and raise a new TC'), 'build:house build:town_center');
    assert.equal(read('Stay flexible and keep the economy balanced'), '');
});

test('what belongs to a rival, or is being attacked, is not something to build or train', () => {
    assert.equal(read('Attack and destroy the Egyptian Town Center and barracks'), 'attack:attack');
    assert.equal(read('Clear the Greek archers from the forward camp'), '');       // no verb of attacking it knows: a miss, not a guess
    assert.equal(read('Scout the Egyptian base location'), 'explore:explore');     // naming a rival is not attacking it
    assert.equal(read('March the army on Greece'), 'attack:attack');
    assert.equal(read('Scout Egypt before considering an attack'), 'explore:explore');
    assert.equal(read('No attack until the towers stand'), '');
});

test('a list of names is a list of things to get', () => {
    assert.equal(read('Stable + scout cavalry early'), 'build:stable train:scout_cavalry');
    assert.equal(read('In bronze: temple, priests, champions'), 'build:temple train:champion train:priest');
    assert.equal(read('Scout cavalry'), 'train:scout_cavalry');                    // the unit, not the verb
});

test('ages and Wonders: aimed at, saved for, never merely mentioned', () => {
    assert.equal(read('Advance to the Bronze Age'), 'age:age');
    assert.equal(read('Bank 2000 food and 1500 wood for bronze'), 'age:age');
    assert.equal(read('Bronze at 2000f/1500w'), 'age:age');
    assert.equal(read('Their army is already in the iron age'), '');
    assert.equal(read('Build archers once age-up completes'), 'train:archer');
    assert.equal(read('Build the Akropolis next to the gold'), 'wonder:wonder');
    assert.equal(read('Save stone for the Wonder'), 'wonder:wonder');
    assert.equal(read('Wonder only if both rivals are broken'), '');
    assert.equal(read('Demolish the Egyptian Wonder'), 'attack:attack');
    assert.equal(read('Do NOT build a tower before the Wonder'), '');
});

test('what is already under way commits to nothing new', () => {
    assert.equal(read('Let the barracks and the longbow research finish'), '');
    assert.equal(read('Finish the second Town Center'), '');
    assert.equal(read('Recall the distant scout'), '');
});
