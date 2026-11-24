'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadScripts(files, extra = {}) {
    const sb = Object.assign({
        console, Math, Date, JSON, Object, Array, Number, String, Boolean,
        Set, Map, RegExp, Error, Infinity, NaN, isFinite, isNaN,
        Promise, setTimeout, clearTimeout, setInterval, clearInterval
    }, extra);
    sb.globalThis = sb;
    sb.window = sb;
    for (const f of files) {
        vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), sb, { filename: f });
    }
    return sb;
}

const sb = loadScripts(['js/bench-core.js', 'js/eval/marks.js', 'js/eval/ledger.js', 'js/eval/season.js', 'js/mcp-link.js']);
const { WarEval, WarSeason, WarMcpLink } = sb;

// Extract OpenAIAIManager & UIManager static helpers cleanly
const aiSb = loadScripts([], {
    window: {}, document: {}, localStorage: { getItem: () => null, setItem: () => {} }
});
vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, '..', 'js/openai-ai.js'), 'utf8') + '\n;this.OpenAIAIManager = OpenAIAIManager;',
    aiSb, { filename: 'js/openai-ai.js' }
);
const OpenAIAIManager = aiSb.OpenAIAIManager;

const uiSb = loadScripts([], {
    window: {}, document: { getElementById: () => null, addEventListener: () => {}, readyState: 'complete' },
    navigator: { platform: 'Win32' }, location: { origin: 'http://127.0.0.1:8000', href: 'http://127.0.0.1:8000/' },
    localStorage: { getItem: () => null, setItem: () => {} }, t: k => k
});
vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, '..', 'js/ui.js'), 'utf8')
    + '\n' + fs.readFileSync(path.join(__dirname, '..', 'js/mcp-ui.js'), 'utf8')
    + '\n;this.UIManager = UIManager;',
    uiSb, { filename: 'js/ui.js' }
);
const UIManager = uiSb.UIManager;

// ---------------------------------------------------------------------------
// 1. Snapshot-grounded stale-state verification (live + retroactive WarEval)
// ---------------------------------------------------------------------------
test('stale-state: valid preconditions in o.state are forgiven as contended, intra-turn & true errors stay avoidable', () => {
    const state = {
        clock: { matchSeconds: 600 },
        population: { used: 23, capacityNow: 25, capacityCeiling: 100 },
        resources: { food: 400, wood: 400, stone: 200, gold: 200 },
        workers: { total: 10, idle: 1, food: 4, wood: 3, stone: 1, gold: 1 },
        friendlyBuildings: [
            { type: 'town_center', x: 0, z: 0, state: 'complete', healthPct: 75 },
            { type: 'barracks', x: 12, z: 0, state: 'complete', healthPct: 100 }
        ],
        friendlyUnits: [
            { id: 101, type: 'militia', x: 15, z: 0, healthPct: 100 },
            { id: 102, type: 'worker', x: 3, z: 0, healthPct: 100 }
        ],
        enemyUnits: [{ id: 'e-7', type: 'archer', x: 40, z: 0, visible: true }],
        enemyBuildings: [{ id: 'eb-3', type: 'tower', x: 60, z: 0 }],
        units: { trainable: [{ id: 'militia' }, { id: 'worker' }] },
        research: { current: null, researched: [], available: [] }
    };

    // Live helper checks
    assert.equal(OpenAIAIManager.isStaleAgainstSnapshot(state, 'train_unit', { unitType: 'militia' }, 'populationLimit', []), true);
    assert.equal(OpenAIAIManager.isStaleAgainstSnapshot(state, 'train_unit', { unitType: 'militia' }, 'unitBuildingNotBuilt', [], 'requires barracks, not built'), true);
    assert.equal(OpenAIAIManager.isStaleAgainstSnapshot(state, 'train_unit', { unitType: 'worker' }, 'noTCTrain', []), true);
    assert.equal(OpenAIAIManager.isStaleAgainstSnapshot(state, 'assign_workers', { resourceType: 'food' }, 'noTCWorkers', []), true);
    assert.equal(OpenAIAIManager.isStaleAgainstSnapshot(state, 'repair_building', { targetX: 0, targetZ: 0 }, 'nothingToRepair', []), true);
    assert.equal(OpenAIAIManager.isStaleAgainstSnapshot(state, 'move_units', { units: { militia: 1 }, targetX: 20, targetZ: 0 }, 'noMilitaryMove', []), true);
    assert.equal(OpenAIAIManager.isStaleAgainstSnapshot(state, 'attack_target', { targetId: 'e-7' }, 'targetOutOfSight', []), true);

    // Intra-turn self-fill of population cap stays avoidable!
    const priorTwoTrains = [
        { action: 'train_unit', params: { unitType: 'militia' }, ok: true },
        { action: 'train_unit', params: { unitType: 'militia' }, ok: true }
    ];
    assert.equal(OpenAIAIManager.isStaleAgainstSnapshot(state, 'train_unit', { unitType: 'militia' }, 'populationLimit', priorTwoTrains), false);

    // Hallucinated handle in orderedUnitsGone is caught!
    assert.equal(OpenAIAIManager.hasAnyShownFriendlyHandle(state, [101]), true);
    assert.equal(OpenAIAIManager.hasAnyShownFriendlyHandle(state, [999]), false);

    // Retroactive WarEval reconciliation produces identical verdicts
    const lines = [
        JSON.stringify({ type: 'match', matchId: 'm1', players: [{ id: 'ai_1', seat: 0, civ: 'greek', name: 'M1', model: 'm1' }] }),
        JSON.stringify({
            turn: 1, playerId: 'ai_1', seat: 0, civ: 'greek', name: 'M1', model: 'm1', state,
            parsed: {
                commands: [
                    { action: 'train_unit', params: { unitType: 'militia' } },
                    { action: 'train_unit', params: { unitType: 'worker' } },
                    { action: 'repair_building', params: { targetX: 0, targetZ: 0 } }
                ]
            },
            outcomes: [
                { n: 1, action: 'train_unit', code: 'populationLimit', verdict: 'avoidable' },
                { n: 2, action: 'train_unit', code: 'noTCTrain', verdict: 'avoidable' },
                { n: 3, action: 'repair_building', code: 'nothingToRepair', verdict: 'avoidable' }
            ]
        }),
        JSON.stringify({
            turn: 2, playerId: 'ai_1', seat: 0, civ: 'greek', name: 'M1', model: 'm1', state,
            parsed: {
                commands: [
                    { action: 'train_unit', params: { unitType: 'militia' } },
                    { action: 'move_units', params: { unitIds: [999], targetX: 10, targetZ: 10 } }
                ]
            },
            outcomes: [
                { n: 1, action: 'train_unit', code: 'trained', verdict: 'ok' },
                // Hallucinated handle 999 wrongly marked orderedUnitsGone -> caught as avoidable!
                { n: 2, action: 'move_units', code: 'orderedUnitsGone', verdict: 'contended' }
            ]
        })
    ].join('\n');

    const prof = WarEval.profileOf(lines);
    const g = prof.seats[0].grounding;
    assert.equal(g.stale, 3, 'all 3 stale drift errors reclassified as stale/contended');
    assert.equal(g.contended, 3);
    assert.equal(g.avoidable, 1, 'hallucinated orderedUnitsGone caught as avoidable');
    assert.equal(g.ok, 1);
});

// ---------------------------------------------------------------------------
// 2. Remnant-mode survival & post-elimination Dominance invariance
// ---------------------------------------------------------------------------
test('remnant mode: hiding without TC & calling wait is justified, not passiveWait or idle penalty', () => {
    const empireState = sec => ({
        clock: { matchSeconds: sec },
        population: { used: 12, capacityNow: 15, capacityCeiling: 100 },
        resources: { food: 200, wood: 200, stone: 100, gold: 100 },
        workers: { total: 8, idle: 0, food: 4, wood: 4 },
        friendlyBuildings: [{ type: 'town_center', x: 0, z: 0, state: 'complete', healthPct: 100 }],
        friendlyUnits: Array.from({ length: 12 }, (_, i) => ({ id: i + 1, type: i < 8 ? 'worker' : 'militia', x: 5, z: 5 })),
        research: { current: null, researched: ['agriculture'], available: [] },
        map: { exploration: [25, 25, 25, 25] },
        gameStats: { opponents: [{ discovered: true }] }
    });
    // Cornered remnant: TC destroyed, cap = 0, 2 workers hiding, cannot afford TC (<100 gold)
    const remnantState = sec => ({
        clock: { matchSeconds: sec },
        population: { used: 2, capacityNow: 0, capacityCeiling: 100 },
        resources: { food: 60, wood: 80, stone: 40, gold: 20 },
        workers: { total: 2, idle: 2 },
        friendlyBuildings: [],
        friendlyUnits: [{ id: 1, type: 'worker', x: 350, z: 350 }, { id: 2, type: 'worker', x: 355, z: 350 }],
        research: { current: null, researched: ['agriculture'], available: [] },
        map: { exploration: [25, 25, 25, 25] },
        gameStats: { opponents: [{ discovered: true }] }
    });

    const records = [
        { type: 'match', matchId: 'rem1', players: [{ id: 'ai_1', seat: 0, civ: 'greek', name: 'Survivor', model: 'm1' }] }
    ];
    for (let i = 1; i <= 5; i++) {
        records.push({
            turn: i, playerId: 'ai_1', seat: 0, civ: 'greek', name: 'Survivor', model: 'm1',
            state: empireState(i * 120),
            parsed: { commands: [{ action: 'train_unit', params: { unitType: 'worker' } }] },
            outcomes: [{ n: 1, action: 'train_unit', code: 'trained', verdict: 'ok' }]
        });
    }
    for (let i = 6; i <= 15; i++) {
        records.push({
            turn: i, playerId: 'ai_1', seat: 0, civ: 'greek', name: 'Survivor', model: 'm1',
            state: remnantState(600 + (i - 5) * 180),
            parsed: { commands: [{ action: 'wait', params: {} }] },
            outcomes: [{ n: 1, action: 'wait', code: 'waited', verdict: 'ok' }]
        });
    }

    const prof = WarEval.profileOf(records.map(r => JSON.stringify(r)).join('\n'));
    const m = prof.seats[0].macro;
    assert.equal(m.remnantTurns, 10);
    assert.equal(m.passiveWaits, 0, 'waiting while hiding without TC is never a passiveWait');
    assert.equal(m.justifiedWaits, 10);
    assert.equal(m.avgIdle, 0, 'TC-less stranded workers do not tank avgIdle');
    assert.ok(m.activeMin <= 10.5, `empire clock frozen around 10m during remnant hiding, got ${m.activeMin}`);
});

test('post-elimination dominance is invariant to how long survivors stalemate after death', () => {
    function buildMatch(totalSec) {
        const samples = [];
        for (let t = 0; t <= totalSec; t += 30) {
            const aliveA = t <= 600;
            samples.push({
                t,
                p: {
                    ai_1: { al: aliveA ? 1 : 0, pw: aliveA ? 400 : 0 },
                    ai_2: { al: 1, pw: 500 + t * 0.2 },
                    ai_3: { al: 1, pw: 500 + t * 0.15 }
                }
            });
        }
        return [
            { type: 'match', matchId: 'dom-' + totalSec, players: [
                { id: 'ai_1', seat: 0, civ: 'greek', name: 'A', model: 'a' },
                { id: 'ai_2', seat: 1, civ: 'persian', name: 'B', model: 'b' },
                { id: 'ai_3', seat: 2, civ: 'viking', name: 'C', model: 'c' }
            ] },
            { turn: 1, playerId: 'ai_1', seat: 0, civ: 'greek', name: 'A', model: 'a', state: { clock: { matchSeconds: 30 } }, parsed: { commands: [] }, outcomes: [] },
            { type: 'timeline', samples, ages: [] },
            { type: 'results', ranking: [{ playerId: 'ai_2', rank: 1, isWinner: true }, { playerId: 'ai_3', rank: 2 }, { playerId: 'ai_1', rank: 3 }] }
        ].map(r => JSON.stringify(r)).join('\n');
    }

    const shortAfter = WarEval.profileOf(buildMatch(1200)).seats.find(s => s.id === 'ai_1').strategy;
    const longStalemate = WarEval.profileOf(buildMatch(4200)).seats.find(s => s.id === 'ai_1').strategy;
    assert.equal(shortAfter.trajDom, longStalemate.trajDom, 'trajDom after death is invariant to survivor stalemate duration');
    assert.equal(shortAfter.score, longStalemate.score);
    assert.ok(shortAfter.trajDom < 45, 'dying early still clearly penalizes Dominance');
});

// ---------------------------------------------------------------------------
// 3. Pooled Series sufficient-statistic aggregation & Plackett-Luce rating
// ---------------------------------------------------------------------------
test('WarSeason.poolSeries pools raw counts across rounds & computes order-independent Plackett-Luce', () => {
    const m1 = {
        round: 1,
        seats: [
            {
                seriesKey: 'A', name: 'Alpha', model: 'alpha', seat: 0, civ: 'greek', rank: 1, of: 2,
                scores: { grounding: 100, macro: 85, spatial: 80, tactical: 70, strategy: 88, index: 85 },
                stats: { rated: 90, okNonWait: 90, constraint: 0, reference: 0, repeated: 0, devScore: 90, idleSum: 0, idleTurns: 50, popStalled: 0, popTurns: 50, floatSum: 0, resTurns: 50, oppSum: 100, prodUsedSum: 90, passiveWaits: 0, turns: 50, spatialOrders: 20, spatialErrors: 0, expScore: 80, discScore: 100, destroyedEff: 2000, lostEff: 500, valueWeighted: true, atOnce: 3, wonderAnswered: 0, episodes: 3, wonders: 0, tacJudged: true, strategyScore: 88 }
            },
            {
                seriesKey: 'B', name: 'Beta', model: 'beta', seat: 1, civ: 'persian', rank: 2, of: 2,
                scores: { grounding: 70, macro: 60, spatial: 50, tactical: 30, strategy: 20, index: 46 },
                stats: { rated: 90, okNonWait: 80, constraint: 10, reference: 0, repeated: 2, devScore: 60, idleSum: 5, idleTurns: 50, popStalled: 5, popTurns: 50, floatSum: 2, resTurns: 50, oppSum: 100, prodUsedSum: 55, passiveWaits: 5, turns: 50, spatialOrders: 20, spatialErrors: 2, expScore: 50, discScore: 50, destroyedEff: 500, lostEff: 2000, valueWeighted: true, atOnce: 1, wonderAnswered: 0, episodes: 4, wonders: 0, tacJudged: true, strategyScore: 20 }
            }
        ]
    };
    const m2 = {
        round: 2,
        seats: [
            {
                seriesKey: 'A', name: 'Alpha', model: 'alpha', seat: 1, civ: 'persian', rank: 1, of: 2,
                scores: { grounding: 60, macro: 75, spatial: 70, tactical: 50, strategy: 76, index: 67 },
                // Short match: only 10 rated actions with 2 errors -> pooled rate is 2/100, NOT mean(100,60)=80!
                stats: { rated: 10, okNonWait: 8, constraint: 2, reference: 0, repeated: 0, devScore: 80, idleSum: 0, idleTurns: 10, popStalled: 0, popTurns: 10, floatSum: 0, resTurns: 10, oppSum: 15, prodUsedSum: 14, passiveWaits: 0, turns: 10, spatialOrders: 4, spatialErrors: 0, expScore: 70, discScore: 100, destroyedEff: 400, lostEff: 300, valueWeighted: true, atOnce: 1, wonderAnswered: 0, episodes: 1, wonders: 0, tacJudged: true, strategyScore: 76 }
            },
            {
                seriesKey: 'B', name: 'Beta', model: 'beta', seat: 0, civ: 'greek', rank: 2, of: 2,
                scores: { grounding: 80, macro: 65, spatial: 55, tactical: 40, strategy: 28, index: 53 },
                stats: { rated: 10, okNonWait: 9, constraint: 1, reference: 0, repeated: 0, devScore: 65, idleSum: 1, idleTurns: 10, popStalled: 1, popTurns: 10, floatSum: 0, resTurns: 10, oppSum: 15, prodUsedSum: 9, passiveWaits: 1, turns: 10, spatialOrders: 4, spatialErrors: 0, expScore: 55, discScore: 50, destroyedEff: 300, lostEff: 400, valueWeighted: true, atOnce: 0, wonderAnswered: 0, episodes: 1, wonders: 0, tacJudged: true, strategyScore: 28 }
            }
        ]
    };

    const agg12 = WarSeason.poolSeries([m1, m2]);
    const agg21 = WarSeason.poolSeries([m2, m1]);
    const a = agg12.models.find(x => x.key === 'A');
    const b = agg12.models.find(x => x.key === 'B');
    const aRev = agg21.models.find(x => x.key === 'A');

    // Exact pooled grounding: 2 constraint errors across 100 rated commands -> 100 * exp(-4.5 * 2 / 108) = 92.0
    assert.equal(a.pooled.grounding, 92.0, 'pooled grounding weighs by total commands, not noisy short-match average');
    assert.ok(a.plRating > b.plRating, 'winner has higher Plackett-Luce rating');
    assert.equal(a.plRating, aRev.plRating, 'Plackett-Luce rating is 100% order-independent');
    assert.equal(a.pooled.index, aRev.pooled.index, 'pooled WAR score is 100% order-independent');
    assert.deepEqual(Array.from(a.civs), ['greek', 'persian']);
    assert.deepEqual(Array.from(a.seats), [0, 1]);
});

test('UIManager.rotateSeriesSetup shifts all seats & civs across rounds and mcpPlayLine reflects series count', () => {
    const base = [
        { type: 'llm', civ: 'greek', connection: { id: 'm1', name: 'Claude', mcpToken: 'seat-aaa11111' } },
        { type: 'llm', civ: 'persian', connection: { id: 'm2', name: 'Gemini', mcpToken: 'seat-bbb22222' } },
        { type: 'llm', civ: 'egyptian', connection: { id: 'm3', name: 'DeepSeek' } },
        { type: 'llm', civ: 'viking', connection: { id: 'm4', name: 'Qwen' } }
    ];
    const seenByPlayer = { Claude: { seats: new Set(), civs: new Set() }, Gemini: { seats: new Set(), civs: new Set() } };
    for (let r = 0; r < 4; r++) {
        const rot = UIManager.rotateSeriesSetup(base, r);
        assert.equal(rot.length, 4);
        rot.forEach((slot, idx) => {
            const nm = slot.connection.name;
            if (seenByPlayer[nm]) {
                seenByPlayer[nm].seats.add(idx);
                seenByPlayer[nm].civs.add(slot.civ);
            }
        });
    }
    assert.equal(seenByPlayer.Claude.seats.size, 4, 'Claude visits all 4 spawn corners');
    assert.equal(seenByPlayer.Claude.civs.size, 4, 'Claude plays all 4 civilizations');
    assert.equal(seenByPlayer.Gemini.seats.size, 4, 'Gemini visits all 4 spawn corners');
    assert.equal(seenByPlayer.Gemini.civs.size, 4, 'Gemini plays all 4 civilizations');

    // MCP start prompt adapts cleanly between 1-match and 4-match series
    const fakeUi = Object.create(UIManager.prototype);
    fakeUi._setupMode = 'arena';
    fakeUi._arenaConfig = { seriesCount: 1 };
    const singlePrompt = fakeUi.mcpPlayLine({ harness: 'claude-code', mcpToken: 'seat-aaa11111' });
    assert.ok(singlePrompt.includes('/goal play WAR'), 'single match keeps concise single-match /goal prompt');
    fakeUi._arenaConfig = { seriesCount: 4 };
    const seriesPrompt = fakeUi.mcpPlayLine({ harness: 'claude-code', mcpToken: 'seat-aaa11111' });
    assert.ok(seriesPrompt.includes('4-match WAR series') && seriesPrompt.includes('seriesContinues'), '4-match series instructs harness to keep playing across matches');
});

// ---------------------------------------------------------------------------
// 4. WarMcpLink series continuity (stays joined across rounds)
// ---------------------------------------------------------------------------
test('WarMcpLink stays joined on seriesContinues and resets rulesSent on prepareNextMatch', async () => {
    const sent = [];
    const link = new WarMcpLink('http://127.0.0.1:8765');
    link.ws = { readyState: 1, send: s => sent.push(JSON.parse(s)) };
    link.hubUp = true;
    link.setSeats([{ token: 'seat-test1234', seat: 1, name: 'Hermes' }]);
    link._fromHub({ type: 'join', token: 'seat-test1234', client: 'hermes' });
    link.rulesSent.add('seat-test1234');
    assert.equal(link.status('seat-test1234').joined, true);

    // Match 1 of 4 ends -> seriesContinues: true keeps seat joined!
    link.over('seat-test1234', { defeated: false }, { seriesContinues: true, series: { round: 1, nextRound: 2, total: 4 } });
    assert.equal(link.status('seat-test1234').joined, true, 'seat stays joined between series matches');
    assert.equal(sent[sent.length - 1].seriesContinues, true);

    // Preparing Match 2 clears rulesSent, notifies hub of rotated seat, and prepends a clear NEW MATCH banner on Turn 1
    link.prepareNextMatch('seat-test1234', 2, 2, 4, 'persian');
    assert.equal(link.rulesSent.has('seat-test1234'), false, 'rulesSent cleared so Match 2 sends fresh civ/rules');
    assert.equal(sent[sent.length - 1].type, 'series_next');
    assert.equal(sent[sent.length - 1].seat, 2);
    const pTurn = link.playTurn('seat-test1234', 1, 'STATE_R2', 'RULES_R2');
    const turnMsg = sent[sent.length - 1];
    assert.equal(turnMsg.type, 'turn');
    assert.match(turnMsg.state, /=== NEW MATCH STARTED: MATCH 2 OF 4 ===[\s\S]*Seat 2 playing as persian[\s\S]*RULES_R2[\s\S]*STATE_R2/);
    link._fromHub({ type: 'end_turn', token: 'seat-test1234', turn: 1 });
    await pTurn;

    // Final match ends -> seriesContinues: false disconnects joined flag
    link.over('seat-test1234', { defeated: false }, { seriesContinues: false });
    assert.equal(link.status('seat-test1234').joined, false, 'seat unjoins when final match ends');
});
