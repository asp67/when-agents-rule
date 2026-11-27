// WarEval -- the evaluation ledger (Scale v4).
//
// What a model did, read from the transcript and from nothing else: the same lines,
// whether they arrive one at a time from a match in progress or from a file afterwards.
// That rule is what keeps a number shown live and a number published later from ever
// disagreeing, and it is why nothing in here reaches into the game or the harness. If
// it is not in the record, it is not scored.
//
// Scale v4 scores five fixed-weight, language-neutral pillars for every AI model seat:
//   grounding  (20%)  severity-weighted execution validity with Bayesian smoothing
//   macro      (25%)  economic development, operational hygiene, and situational batching
//   spatial    (15%)  map exploration, rival discovery, and spatial grounding
//   tactical   (15%)  home-asset raid defense and value-weighted combat exchange
//   strategy   (25%)  time-weighted Bradley-Terry power dominance and placement
// Plan text is kept purely as an unscored qualitative viewer (`plan`). Efficiency and
// early-to-late context drift sit beside the profile, never inside WAR Score.
(function (root) {
    'use strict';

    // Reference errors matching WarBench.CLASSES.reference so Node CLI and browser agree
    // identically even when js/bench-core.js is not loaded.
    const REFERENCE_CODES = new Set([
        'assignBadCarry', 'assignBadFrom', 'assignBadSpill', 'assignFromSame', 'assignNeedsCoords',
        'assignNeedsResource', 'attackNeedsCoords', 'attackNoMatch', 'civCannotBuild', 'civCannotTrain',
        'exploreBadTile', 'exploreNeedsTile', 'missingParam', 'exploreRouteTooLong', 'farmNeedsCoords',
        'moveBadMode', 'moveNeedsCoords', 'moveNoMatch', 'misnamedCoords', 'notAResearchTech',
        'notACommand', 'offMap', 'towerNearEnemyTC', 'siegeCannotAttack', 'renamedBuilding',
        'repairNeedsCoords', 'targetIsOwn', 'targetNotFound', 'targetOutOfSight', 'techIsBuilding',
        'unknownBuilding', 'unknownTech', 'unknownUnit', 'unparsedCall', 'rawToolMarkup'
    ]);

    const SPATIAL_ACTIONS = new Set(['attack_target', 'move_units', 'explore', 'build_structure', 'repair_building']);
    const SPATIAL_ERROR_CODES = new Set([
        'targetOutOfSight', 'offMap', 'exploreBadTile', 'exploreNeedsTile', 'exploreRouteTooLong',
        'moveNeedsCoords', 'attackNeedsCoords', 'farmNeedsCoords', 'repairNeedsCoords',
        'misnamedCoords', 'towerNearEnemyTC', 'notDiscovered', 'noTCPlacement', 'targetNotFound',
        'attackNoMatch', 'moveNoMatch', 'targetIsOwn', 'noDamagedNear'
    ]);

    const TRAINER_BUILDINGS = new Set([
        'town_center', 'barracks', 'archery_range', 'stable', 'siege_workshop', 'academy', 'temple'
    ]);

    const UNIT_TRAINER_MAP = Object.freeze({
        worker: 'town_center',
        militia: 'barracks', warrior: 'barracks', champion: 'barracks',
        phalanx: 'barracks', hoplite: 'barracks', immortal: 'barracks', berserker: 'barracks', huskarl: 'barracks',
        scout_cavalry: 'stable', cavalry: 'stable', heavy_cavalry: 'stable', war_chariot: 'stable', horse_carriage: 'stable',
        archer: 'archery_range', crossbowman: 'archery_range', elite_archer: 'archery_range',
        engineer: 'academy', trebuchet: 'academy',
        priest: 'temple'
    });

    const BLD_VALUE = { 'building-lost': 150, 'town-center-lost': 600, 'wonder-lost': 1000 };
    const BLD_COUNT = { 'building-lost': 1, 'town-center-lost': 4, 'wonder-lost': 6 };

    const WarEval = {
        VERSION: 1,
        SCALE: 'v4.1',
        SCORED: ['grounding', 'macro', 'spatial', 'tactical', 'strategy'],
        INDEX_PARTS: ['grounding', 'macro', 'spatial', 'tactical', 'strategy'],
        WEIGHTS: Object.freeze({ grounding: 0.20, macro: 0.25, spatial: 0.15, tactical: 0.15, strategy: 0.25 }),
        WARMUP_SEC: 300,
        WARMUP_RATED: 15,
        DRIFT_MIN_DECISIONS: 16,
        POST_ELIM_CAP_SEC: 300,
        LOOP_MIN: 3,
        STALL_MIN: 3,
        REPEAT_WINDOW: 2,
        RESPONSE_WINDOW: 3,
        RESPONSE_RADIUS: 50,
        HOME_RADIUS: 110,
        LEAD_FACTOR: 1.25,
        LEAD_SECONDS: 300,
        HISTORY_SEC: 30,
        HISTORY_FIELDS: [
            'decisions', 'index', 'grounding', 'macro', 'spatial', 'tactical', 'strategy',
            'commands', 'ok', 'rated', 'avoidable', 'invalid', 'repeated', 'passiveWaits',
            'promptTokens', 'completionTokens', 'thinkingMs'
        ],
        REFERENCE_CODES,
        SPATIAL_ACTIONS,
        SPATIAL_ERROR_CODES,
        classOf: o => {
            if (typeof WarBench !== 'undefined' && WarBench && typeof WarBench.classify === 'function') return WarBench.classify(o);
            if (!o || !o.code) return o && o.verdict === 'invalid' ? 'reference' : null;
            const code = String(o.code);
            if (REFERENCE_CODES.has(code)) return 'reference';
            return (o.verdict === 'avoidable' || o.verdict === 'invalid') ? 'constraint' : null;
        },
    };

    const SEAT_MARKERS = new Set(['round_missed', 'request_failed', 'request_cancelled', 'final_word', 'adaptation', 'intervention']);
    const VERDICTS = ['ok', 'avoidable', 'invalid', 'contended', 'harnessFault'];

    const num = v => (typeof v === 'number' && Number.isFinite(v)) ? v : null;
    const clamp01 = x => Math.max(0, Math.min(1, x));
    const round1 = x => Math.round(x * 10) / 10;
    const sum = values => values.reduce((a, b) => a + b, 0);

    function quantile(values, q) {
        if (!values.length) return null;
        const s = values.slice().sort((a, b) => a - b);
        const i = (s.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
        return s[lo] + (s[hi] - s[lo]) * (i - lo);
    }

    function commandsOf(parsed) {
        if (!parsed || typeof parsed !== 'object') return 0;
        if (Array.isArray(parsed.commands)) return parsed.commands.length;
        return parsed.action ? 1 : 0;
    }

    function commandList(parsed, outcomes, state) {
        const list = !parsed || typeof parsed !== 'object' ? [] : Array.isArray(parsed.commands) ? parsed.commands : (parsed.action ? [parsed] : []);
        let rivals = null, own = null;
        const place = (lists, id) => {
            for (const l of lists) for (const e of Array.isArray(l) ? l : []) {
                if (e && String(e.id) === String(id) && num(e.x) != null && num(e.z) != null) return e;
            }
            return null;
        };
        return list.map((c, i) => {
            const q = (c && c.params && typeof c.params === 'object') ? c.params : {}, o = outcomes ? outcomes[i] : null;
            const name = q.unitType != null ? q.unitType : q.buildingType != null ? q.buildingType : q.techId;
            const cmd = {
                action: String(c && c.action), name: name != null ? String(name) : null,
                x: num(q.targetX), z: num(q.targetZ),
                target: q.targetId != null ? String(q.targetId) : null,
                scouting: q.mode === 'scout', ok: o ? o.verdict === 'ok' : null
            };
            if (cmd.target && cmd.x == null && state) {
                rivals = rivals || [state.enemyUnits, state.enemyBuildings, state.threats && state.threats.enemyWonders];
                const e = place(rivals, cmd.target);
                if (e) { cmd.x = e.x; cmd.z = e.z; }
            }
            if (cmd.action === 'move_units' && Array.isArray(q.unitIds) && q.unitIds.length && state) {
                own = own || [state.friendlyUnits];
                const at = q.unitIds.map(id => place(own, id)).filter(Boolean);
                if (at.length) cmd.from = at.map(e => ({ x: e.x, z: e.z }));
            }
            return cmd;
        });
    }

    const near = (a, b, r) => a && b && a.x != null && b.x != null && Math.abs(a.x - b.x) <= r && Math.abs(a.z - b.z) <= r;

    // Filter underAttack to home assets only (buildings, workers, or units within HOME_RADIUS of any friendly building).
    function homeThreatOf(threats, friendlyBuildings) {
        const raw = Array.isArray(threats && threats.underAttack) ? threats.underAttack.filter(u => u && num(u.x) != null && num(u.z) != null) : [];
        if (!raw.length) return null;
        const blds = Array.isArray(friendlyBuildings) ? friendlyBuildings.filter(b => b && num(b.x) != null && num(b.z) != null) : [];
        const filtered = raw.filter(u => u.kind === 'building' || u.type === 'worker' || blds.some(b => Math.hypot(u.x - b.x, u.z - b.z) <= WarEval.HOME_RADIUS));
        if (!filtered.length) return null;
        return {
            targets: filtered.map(u => ({ kind: u.kind === 'building' ? 'building' : 'unit', type: String(u.type), x: u.x, z: u.z })),
            attackers: filtered.filter(u => u.attackerAt && num(u.attackerAt.x) != null && num(u.attackerAt.z) != null)
                .map(u => ({ x: u.attackerAt.x, z: u.attackerAt.z, owner: u.attackerAt.owner != null ? String(u.attackerAt.owner) : null })),
            undefended: filtered.some(u => u.noDefenders === true)
        };
    }

    function answers(cmd, points, R) {
        if (cmd.ok !== true) return false;
        const at = list => list.some(pt => near(cmd, pt, R));
        switch (cmd.action) {
            case 'attack_target': return at(points.attackers) || at(points.targets);
            case 'move_units': return !cmd.scouting && (at(points.attackers) || at(points.targets)
                || (cmd.from || []).some(u => points.targets.some(t => t.kind === 'unit' && near(u, t, R / 2))));
            case 'build_structure': return cmd.name === 'tower' && at(points.targets);
            case 'repair_building': return at(points.targets.filter(t => t.kind === 'building'));
            case 'assign_workers': return points.targets.some(t => t.type === 'worker');
        }
        return false;
    }

    function nthOfItsKind(cmds, at) {
        let n = 0;
        for (let i = 0; i <= at; i++) if (cmds[i].action === cmds[at].action) n++;
        return n;
    }

    // Raw qualitative plan container (no heuristic parsing or grading).
    function planOf(parsed) {
        if (!parsed || typeof parsed !== 'object') return null;
        const steps = Array.isArray(parsed.plan) && parsed.plan.length ? parsed.plan.map(s => String(s).trim()).filter(Boolean) : null;
        const objective = typeof parsed.objective === 'string' && parsed.objective.trim() ? parsed.objective.trim() : null;
        return steps || objective ? { objective, steps } : null;
    }

    function exploredPctOf(st) {
        const raw = (st.map && st.map.exploration != null) ? st.map.exploration : st.exploration;
        if (raw == null) return null;
        let total = 0, count = 0;
        if (Array.isArray(raw)) {
            for (const row of raw) {
                if (Array.isArray(row)) {
                    for (const v of row) if (typeof v === 'number' && Number.isFinite(v)) { total += v; count++; }
                } else if (typeof row === 'number' && Number.isFinite(row)) { total += row; count++; }
            }
        } else if (typeof raw === 'object') {
            for (const k in raw) {
                const v = raw[k];
                if (typeof v === 'number' && Number.isFinite(v)) { total += v; count++; }
            }
        }
        return count ? total / count : null;
    }

    function hasAnyTrainable(st) {
        const tr = st.units && st.units.trainable ? st.units.trainable : st.trainableUnits;
        if (!tr) return false;
        if (Array.isArray(tr)) return tr.length > 0;
        if (typeof tr === 'object') {
            for (const k in tr) {
                const v = tr[k];
                if (Array.isArray(v)) { if (v.length) return true; }
                else if (v && typeof v === 'object') {
                    for (const sub in v) if (Array.isArray(v[sub]) && v[sub].length) return true;
                }
            }
        }
        return false;
    }

    function costSum(cost) {
        if (!cost || typeof cost !== 'object') return 0;
        return (num(cost.food) || 0) + (num(cost.wood) || 0) + (num(cost.stone) || 0) + (num(cost.gold) || 0);
    }

    function canPay(res, cost) {
        if (!cost || typeof cost !== 'object') return true;
        return (res.food >= (num(cost.food) || 0))
            && (res.wood >= (num(cost.wood) || 0))
            && (res.stone >= (num(cost.stone) || 0))
            && (res.gold >= (num(cost.gold) || 0));
    }

    function computeStateFacts(st, homeThreat, maxCmds) {
        const blds = Array.isArray(st.friendlyBuildings) ? st.friendlyBuildings : null;
        const wObj = st.workers && typeof st.workers === 'object' ? st.workers : null;
        const pObj = st.population && typeof st.population === 'object' ? st.population : null;
        const rObj = st.resources && typeof st.resources === 'object' ? st.resources : null;
        const res = rObj ? {
            food: num(rObj.food) || 0, wood: num(rObj.wood) || 0,
            stone: num(rObj.stone) || 0, gold: num(rObj.gold) || 0
        } : null;
        const resTotal = res ? (res.food + res.wood + res.stone + res.gold) : null;
        const pop = pObj ? {
            used: num(pObj.used) || 0,
            cap: num(pObj.capacityNow),
            ceiling: num(pObj.capacityCeiling) || 100
        } : null;
        const workers = wObj ? { total: num(wObj.total) || 0, idle: num(wObj.idle) || 0 } : null;
        const techCount = st.research && Array.isArray(st.research.researched) ? st.research.researched.length : null;
        const exploredPct = exploredPctOf(st);
        const opps = st.gameStats && Array.isArray(st.gameStats.opponents) ? st.gameStats.opponents : null;
        const oppsTotal = opps ? opps.length : null;
        const oppsDiscovered = opps ? opps.filter(op => op && op.discovered === true).length : null;

        // Age progression & banking status
        const ep = st.epoch && typeof st.epoch === 'object' ? st.epoch : null;
        const hasNextAge = !!(ep && (ep.nextAge || ep.nextEpoch));
        const inProgress = !!(ep && ep.upgradeInProgress);
        const canAdvance = !!(ep && (ep.canAdvance === true
            || (hasNextAge && !inProgress && ep.nextEpochCost && res && canPay(res, ep.nextEpochCost))));
        const bankingTarget = (hasNextAge && !canAdvance && !inProgress)
            ? (ep.nextEpochCost ? costSum(ep.nextEpochCost) : 2000)
            : 0;
        const bankingForAge = !!(bankingTarget > 0 && (resTotal == null || resTotal < 1400));

        // Remnant / survival detection: when a seat has lost its Town Center and all production
        // buildings and cannot immediately rebuild a TC, hiding surviving units and calling wait
        // is legitimate guerrilla survival — not passive idling.
        const hasFinishedTC = blds ? blds.some(b => b && b.type === 'town_center' && (!b.state || b.state === 'complete')) : true;
        const hasProdBld = blds ? blds.some(b => b && (!b.state || b.state === 'complete') && TRAINER_BUILDINGS.has(String(b.type))) : true;
        const canRebuildTC = !!(workers && workers.total > 0 && res
            && res.food >= 100 && res.wood >= 100 && res.stone >= 100 && res.gold >= 100);
        const remnant = (blds != null) && !hasFinishedTC && !hasProdBld && !canRebuildTC;

        // Situational open fronts for parallel command batching (0..maxCmds)
        let open = 0;
        if (workers && workers.idle > 0 && (hasFinishedTC || canRebuildTC)) open++;
        if (pop && pop.cap != null && pop.cap > 0 && pop.cap < pop.ceiling && pop.used >= pop.cap - 1 && (res ? res.wood : 0) >= 50) open++;
        if (homeThreat && !remnant) open++;
        if (canAdvance) open++;
        if (!bankingForAge && st.research && !st.research.current && Array.isArray(st.research.available)) {
            const canTech = st.research.available.some(a => {
                if (!a || typeof a !== 'object') return false;
                if (a.canAfford === true) return true;
                if (a.canAfford === false) return false;
                if (Array.isArray(a.blockedBy) && a.blockedBy.length > 0) return false;
                return res ? canPay(res, a.cost) : false;
            });
            if (canTech) open++;
        }
        const idleTrainers = blds ? blds.filter(b => b && (!b.state || b.state === 'complete') && b.busy !== true && TRAINER_BUILDINGS.has(String(b.type))).length : 0;
        const headroom = pop && pop.cap != null ? Math.max(0, pop.cap - pop.used) : 0;
        if (!bankingForAge && idleTrainers > 0 && headroom > 0 && hasAnyTrainable(st) && (resTotal || 0) >= 120) {
            open += (idleTrainers >= 2 && headroom >= 2 && (resTotal || 0) >= 350) ? 2 : 1;
        }
        const cap = Math.max(1, maxCmds || 3);
        const openFronts = Math.min(cap, open);

        return {
            workers, pop, resTotal, bankingTarget,
            bldCount: blds ? blds.length : null,
            techCount, exploredPct, oppsTotal, oppsDiscovered, openFronts,
            hasFinishedTC, canRebuildTC, remnant
        };
    }

    // Snapshot-grounded stale-state reconciliation (mirrors OpenAIAIManager.isStaleAgainstSnapshot).
    // Evaluates each rejected command against the exact `o.state` snapshot the model received minus
    // any resources/pop/entities consumed by earlier commands in the SAME turn, so world drift during
    // 5–180s think windows is classified as `contended` (stale) while intra-turn self-conflicts and
    // genuinely hallucinated handles (`orderedUnitsGone` for IDs never in `o.state`) remain `avoidable`.
    function rawCommandList(parsed) {
        if (!parsed || typeof parsed !== 'object') return [];
        if (Array.isArray(parsed.commands)) return parsed.commands;
        if (Array.isArray(parsed.actions)) return parsed.actions;
        return parsed.action ? [parsed] : [];
    }

    function trainableIncludes(st, unitType) {
        if (!st || !unitType) return false;
        const tr = st.units && st.units.trainable ? st.units.trainable : st.trainableUnits;
        if (!tr) return false;
        const hit = x => x && (x === unitType || x.id === unitType || x.type === unitType);
        if (Array.isArray(tr)) return tr.some(hit);
        if (typeof tr === 'object') {
            for (const k in tr) {
                const v = tr[k];
                if (Array.isArray(v) && v.some(hit)) return true;
                if (v && typeof v === 'object') {
                    for (const sub in v) if (Array.isArray(v[sub]) && v[sub].some(hit)) return true;
                }
            }
        }
        return false;
    }

    function reconcileOutcomesWithState(st, parsed, outcomes) {
        if (!outcomes || !outcomes.length || !st || typeof st !== 'object') return outcomes;
        const rawCmds = rawCommandList(parsed);
        const hasFb = Array.isArray(st.friendlyBuildings);
        const hasFu = Array.isArray(st.friendlyUnits);
        const fb = hasFb ? st.friendlyBuildings : [];
        const fu = hasFu ? st.friendlyUnits : [];
        const eu = Array.isArray(st.enemyUnits) ? st.enemyUnits : [];
        const eb = Array.isArray(st.enemyBuildings) ? st.enemyBuildings : [];
        const pop = st.population && typeof st.population === 'object' ? st.population : null;
        const wk = st.workers && typeof st.workers === 'object' ? st.workers : null;

        const hasFinishedTC = hasFb && fb.some(b => b && b.type === 'town_center' && (!b.state || b.state === 'complete'));
        const unitCountByType = {};
        const unitHandles = new Set();
        let combatInState = 0;
        for (const u of fu) {
            if (!u) continue;
            const t = String(u.type || '').toLowerCase();
            if (t) unitCountByType[t] = (unitCountByType[t] || 0) + 1;
            if (u.id != null) unitHandles.add(String(u.id));
            if (u.handle != null) unitHandles.add(String(u.handle));
            if (t !== 'worker' && t !== 'priest' && t !== 'trebuchet') combatInState++;
        }
        const totalWorkers = wk && typeof wk.total === 'number' ? wk.total : (unitCountByType.worker || 0);
        const damagedBlds = fb.filter(b => b && b.healthPct != null && b.healthPct < 100);

        const prior = [];
        return outcomes.map((x, idx) => {
            const cmd = rawCmds[idx] || {};
            const p = (cmd && cmd.params && typeof cmd.params === 'object') ? cmd.params : (cmd || {});
            const action = x.action || (cmd && cmd.action ? String(cmd.action) : null);
            let verdict = x.verdict;
            let stale = !!x.stale;
            const code = x.code;

            if (verdict === 'avoidable' && code) {
                let isStale = false;
                switch (code) {
                    case 'populationLimit': {
                        if (pop && typeof pop.used === 'number' && typeof pop.capacityNow === 'number') {
                            const priorTrains = prior.filter(c => c.action === 'train_unit' && c.ok !== false)
                                .reduce((s, c) => s + Math.max(1, Number((c.params && c.params.count) || 1) || 1), 0);
                            isStale = (pop.used + priorTrains) < pop.capacityNow;
                        }
                        break;
                    }
                    case 'noTCTrain':
                    case 'noTCWorkers':
                        isStale = hasFinishedTC;
                        break;
                    case 'unitBuildingNotBuilt': {
                        const ut = p.unitType ? String(p.unitType) : null;
                        const mapped = ut ? UNIT_TRAINER_MAP[ut.toLowerCase()] : null;
                        isStale = !!(ut && (trainableIncludes(st, ut) || (mapped && hasFb && fb.some(b => b && b.type === mapped))));
                        break;
                    }
                    case 'buildingUnderConstr': {
                        const ut = p.unitType ? String(p.unitType) : null;
                        const mapped = ut ? UNIT_TRAINER_MAP[ut.toLowerCase()] : null;
                        isStale = !!(mapped && hasFb && fb.some(b => b && b.type === mapped && (!b.state || b.state === 'complete')));
                        break;
                    }
                    case 'nothingToRepair':
                    case 'noDamagedNear': {
                        if (damagedBlds.length > 0) {
                            if (code === 'nothingToRepair') isStale = true;
                            else {
                                const tx = Number(p.targetX), tz = Number(p.targetZ);
                                isStale = (Number.isFinite(tx) && Number.isFinite(tz))
                                    ? damagedBlds.some(b => b.x != null && b.z != null && Math.hypot(b.x - tx, b.z - tz) <= 60)
                                    : true;
                            }
                        }
                        break;
                    }
                    case 'noMilitaryMove':
                    case 'noMilitaryAttack':
                        isStale = combatInState > 0;
                        break;
                    case 'moveNoMatch':
                    case 'attackNoMatch': {
                        if (Array.isArray(p.unitIds) && p.unitIds.length) {
                            isStale = p.unitIds.some(id => unitHandles.has(String(id).replace(/^#/, '')));
                        } else if (p.units && typeof p.units === 'object') {
                            isStale = Object.keys(p.units).some(k => {
                                const t = String(k).trim().toLowerCase();
                                return (unitCountByType[t] || 0) > 0 || ((t === 'infantry' || t === 'cavalry' || t === 'ranged') && combatInState > 0);
                            });
                        }
                        break;
                    }
                    case 'noUnitExplore': {
                        if (Array.isArray(p.unitIds) && p.unitIds.length) isStale = p.unitIds.some(id => unitHandles.has(String(id).replace(/^#/, '')));
                        else if (p.unitType) isStale = (unitCountByType[String(p.unitType).trim().toLowerCase()] || 0) > 0;
                        else isStale = fu.length > 0;
                        break;
                    }
                    case 'noUnitDelete': {
                        if (!prior.some(c => c.action === 'delete_unit' && c.ok !== false)) {
                            const ut = String(p.unitType || 'worker').trim().toLowerCase();
                            isStale = (unitCountByType[ut] || 0) > 0;
                        }
                        break;
                    }
                    case 'noBuildingDestroy': {
                        if (!prior.some(c => c.action === 'destroy_building' && c.ok !== false)) {
                            const bt = p.buildingType ? String(p.buildingType) : null;
                            isStale = !!(bt && hasFb && fb.some(b => b && b.type === bt));
                        }
                        break;
                    }
                    case 'noWorkersBuild':
                    case 'noWorkersRepair':
                    case 'noWorkersReassign':
                    case 'noWorkersForFarms': {
                        const free = wk ? ((wk.idle || 0) + (wk.food || 0) + (wk.wood || 0) + (wk.gold || 0) + (wk.stone || 0)) : totalWorkers;
                        const priorW = prior.some(c => c.ok !== false && (c.action === 'assign_workers' || c.action === 'build_structure' || c.action === 'repair_building'));
                        isStale = totalWorkers > 0 && free > 0 && !priorW;
                        break;
                    }
                    case 'targetNotFound':
                    case 'targetOutOfSight': {
                        const tid = p.targetId != null ? String(p.targetId) : '';
                        if (tid) isStale = eu.some(u => u && String(u.id) === tid && u.visible !== false) || eb.some(b => b && String(b.id) === tid);
                        break;
                    }
                    case 'assignFromEmpty': {
                        const src = p.from || p.source;
                        const priorF = prior.some(c => c.action === 'assign_workers' && c.ok !== false);
                        isStale = !!(src && wk && typeof wk[src] === 'number' && wk[src] > 0 && !priorF);
                        break;
                    }
                    case 'alreadyResearching': {
                        const running = !!(st.research && st.research.current);
                        const priorR = prior.some(c => c.action === 'research_tech' && c.ok !== false);
                        isStale = !running && !priorR && st.research != null;
                        break;
                    }
                }
                if (isStale) {
                    verdict = 'contended';
                    stale = true;
                }
            } else if (verdict === 'contended' && code === 'orderedUnitsGone' && hasFu
                && Array.isArray(p.unitIds) && p.unitIds.length
                && !p.unitIds.some(id => unitHandles.has(String(id).replace(/^#/, '')))) {
                verdict = 'avoidable';
                stale = false;
            }

            prior.push({ action, params: p, ok: verdict === 'ok' });
            return stale ? { code, action, verdict, stale: true } : { code, action, verdict };
        });
    }

    const timelineOf = o => ({ samples: Array.isArray(o.samples) ? o.samples : [], ages: Array.isArray(o.ages) ? o.ages : [] });
    const resultsOf = o => ({
        ranking: (Array.isArray(o.ranking) ? o.ranking : []).map(r => ({ id: r.playerId, rank: num(r.rank), winner: !!r.isWinner })),
        profile: o.profile && typeof o.profile === 'object' ? o.profile : null
    });

    const LONG = { grounding: ['errors'], tactical: ['list'], plan: ['history', 'standing'] };
    WarEval.publicProfile = p => ({
        kind: p.kind, scale: p.scale,
        seats: p.seats.filter(s => s.decisions > 0).map(s => {
            const out = {
                id: s.id, seat: s.seat, civ: s.civ, name: s.name, model: s.model,
                decisions: s.decisions, warmup: !!s.warmup, index: s.index
            };
            for (const k of ['grounding', 'macro', 'spatial', 'tactical', 'strategy', 'versatility', 'efficiency', 'drift', 'plan']) {
                if (s[k] == null) { out[k] = null; continue; }
                out[k] = Object.assign({}, s[k]);
                for (const f of LONG[k] || []) delete out[k][f];
            }
            return out;
        })
    });
    WarEval.sameProfile = (a, b) => JSON.stringify(a) === JSON.stringify(b);

    class Ledger {
        constructor() {
            this.match = null;
            this.seats = new Map();
            this.lines = 0;
            this.unreadable = 0;
            this.timeline = null;
            this.results = null;
            this.battles = [];
            this.razings = [];
            this._preview = null;
            this.rev = 0;
        }

        _seat(o) {
            let s = this.seats.get(o.playerId);
            if (!s) {
                s = {
                    id: o.playerId, seat: null, civ: null, model: null, name: null,
                    maxCommands: (this.match && this.match.maxCommands) || 3,
                    turns: [], markers: {}, kinds: {}, harness: null
                };
                this.seats.set(o.playerId, s);
            }
            if (s.seat == null && o.seat != null) s.seat = o.seat;
            if (s.civ == null && (o.civ || o.civilization)) s.civ = o.civ || o.civilization;
            if (s.model == null && o.model) s.model = o.model;
            if (s.name == null && o.name) s.name = o.name;
            if (num(o.maxCommands) != null && num(o.maxCommands) > 0) s.maxCommands = num(o.maxCommands);
            if (!s.harness && o.settings && typeof o.settings === 'object') {
                if (num(o.settings.maxCommands) != null && num(o.settings.maxCommands) > 0) s.maxCommands = num(o.settings.maxCommands);
                s.harness = {
                    external: !!o.settings.harnessExternal,
                    kind: o.settings.harness != null ? String(o.settings.harness) : null,
                    provider: o.settings.provider != null ? String(o.settings.provider) : null
                };
            }
            return s;
        }

        addLine(text) {
            const line = String(text == null ? '' : text).trim();
            if (!line) return;
            let o;
            try { o = JSON.parse(line); } catch (e) { this.unreadable++; return; }
            this.add(o);
        }

        add(o) {
            if (!o || typeof o !== 'object') return;
            this.lines++;
            if (o.type === 'match') {
                const slice = num(o.lockstepSliceMs);
                this.match = {
                    matchId: o.matchId || null,
                    build: o.build != null ? o.build : null,
                    promptVersion: o.promptVersion || null,
                    turnBased: !!o.turnBased,
                    lockstepSliceMs: slice,
                    roundTimeoutMs: num(o.roundTimeoutMs),
                    mode: slice != null && slice > 0 ? 'lockstep' : 'realtime',
                    maxCommands: num(o.maxCommands) || 3
                };
                this.schema = o.schema != null ? String(o.schema) : null;
                this.mapSize = num(o.mapSize);
                for (const p of o.players || []) if (p && p.id) {
                    this._seat({
                        playerId: p.id, seat: p.seat, civ: p.civ, model: p.model, name: p.name,
                        maxCommands: num(p.maxCommands) || (p.settings && num(p.settings.maxCommands)) || this.match.maxCommands,
                        settings: p.settings
                    });
                }
                return;
            }
            if (o.type === 'timeline') { this.timeline = timelineOf(o); return; }
            if (o.type === 'results') { this.results = resultsOf(o); return; }
            if (o.type === 'chronicle') {
                if (o.kind === 'battle' && o.sides && typeof o.sides === 'object') {
                    this.battles.push({ t: num(o.t), sides: o.sides });
                } else if (o.kind === 'building-lost' || o.kind === 'town-center-lost' || o.kind === 'wonder-lost') {
                    this.razings.push({
                        kind: o.kind, t: num(o.t),
                        by: o.by != null ? String(o.by) : null,
                        owner: Array.isArray(o.seats) && o.seats[0] != null ? String(o.seats[0]) : (o.owner != null ? String(o.owner) : null)
                    });
                }
                return;
            }
            if (o.type) {
                if (!o.playerId || !SEAT_MARKERS.has(o.type)) return;
                const s = this._seat(o);
                s.markers[o.type] = (s.markers[o.type] || 0) + 1;
                if (o.kind != null) { const k = o.type + ':' + o.kind; s.kinds[k] = (s.kinds[k] || 0) + 1; }
                return;
            }
            if (!o.playerId) return;

            const tokens = o.tokens && typeof o.tokens === 'object' ? o.tokens : null;
            const st = o.state && typeof o.state === 'object' ? o.state : {};
            const clock = st.clock, threats = st.threats || {};
            const seat = this._seat(o);
            if (clock && num(clock.matchSeconds) != null && clock.matchSeconds > (this.lastSec || 0)) this.lastSec = clock.matchSeconds;

            const rawOutcomes = Array.isArray(o.outcomes) ? o.outcomes.map(x => ({
                code: x && x.code != null ? String(x.code) : null,
                action: x && x.action != null ? String(x.action) : null,
                verdict: x && VERDICTS.includes(x.verdict) ? x.verdict : 'unknown',
                stale: !!(x && x.stale)
            })) : null;
            const outcomes = reconcileOutcomesWithState(st, o.parsed, rawOutcomes);

            const homeThreat = homeThreatOf(threats, st.friendlyBuildings);
            const fallen = [];
            if (seat.watch && seat.watch.length) {
                const mine = Array.isArray(st.friendlyBuildings) ? st.friendlyBuildings : null;
                if (mine) seat.watch = seat.watch.filter(t => {
                    if (mine.some(b => b && String(b.type) === t.type && near(b, t, 3))) return true;
                    fallen.push(t); return false;
                });
                if (!homeThreat) seat.watch = [];
            }
            if (homeThreat) {
                for (const t of homeThreat.targets) {
                    if (t.kind === 'building' && !(seat.watch = seat.watch || []).some(w => w.type === t.type && near(w, t, 3))) {
                        seat.watch.push(t);
                    }
                }
            }

            const cmds = commandList(o.parsed, outcomes, st);
            const facts = computeStateFacts(st, homeThreat, seat.maxCommands);

            seat.turns.push({
                homeThreat, fallen,
                rivalWonders: Array.isArray(threats.enemyWonders) ? threats.enemyWonders.filter(w => w && w.id != null)
                    .map(w => ({ id: String(w.id), x: num(w.x), z: num(w.z), owner: w.owner != null ? String(w.owner) : null })) : [],
                cmds,
                plan: planOf(o.parsed),
                facts,
                turn: num(o.turn),
                via: o.answeredVia != null ? String(o.answeredVia) : null,
                sec: clock ? num(clock.matchSeconds) : null,
                latencyMs: num(o.latencyMs) > 0 ? o.latencyMs : null,
                prompt: tokens ? num(tokens.prompt) : null,
                completion: tokens ? num(tokens.completion) : null,
                commands: commandsOf(o.parsed),
                outcomes
            });
        }

        // Pillar 1 (20%): Execution Grounding — severity-weighted + Bayesian smoothed.
        _grounding(turns) {
            const count = { ok: 0, avoidable: 0, invalid: 0, contended: 0, harnessFault: 0, unknown: 0 };
            const codes = new Map();
            let unjudged = 0, repeated = 0, waits = 0, constraint = 0, reference = 0, stale = 0;
            const before = [], errors = [];
            for (const t of turns) {
                const mine = [];
                if (!t.outcomes) unjudged += t.commands;
                else {
                    unjudged += Math.max(0, t.commands - t.outcomes.length);
                    for (const x of t.outcomes) {
                        count[x.verdict]++;
                        if (x.stale) stale++;
                        if (x.verdict === 'ok' && x.action === 'wait') waits++;
                        if (x.verdict !== 'avoidable' && x.verdict !== 'invalid') continue;
                        const cls = (x.verdict === 'invalid' || WarEval.classOf(x) === 'reference') ? 'reference' : 'constraint';
                        if (cls === 'reference') reference++; else constraint++;
                        codes.set(x.code, (codes.get(x.code) || 0) + 1);
                        errors.push({ turn: t.turn, sec: t.sec, code: x.code, verdict: x.verdict, cls });
                        if (before.some(prev => prev.includes(x.code))) repeated++;
                        mine.push(x.code);
                    }
                }
                before.push(mine);
                if (before.length > WarEval.REPEAT_WINDOW) before.shift();
            }
            const mistakes = count.avoidable + count.invalid;
            const judged = count.ok + mistakes;
            const rated = judged - waits;
            const okNonWait = count.ok - waits;
            const rate = rated ? okNonWait / rated : null;
            const hallucinationRate = rated ? reference / rated : null;
            const constraintRate = rated ? constraint / rated : null;
            const repeatRate = mistakes ? repeated / mistakes : null;
            const recoveryRate = repeatRate == null ? null : 1 - repeatRate;
            const errWeight = 1.0 * constraint + 2.5 * reference + 1.5 * repeated;
            const score = (judged === 0 && unjudged > 0) ? null
                : rated === 0 ? 0
                : round1(100 * Math.exp(-4.5 * errWeight / (rated + 8)));
            return {
                judged, waits, rated, ok: count.ok, okNonWait, avoidable: count.avoidable, invalid: count.invalid,
                contended: count.contended, stale, harnessFault: count.harnessFault, unjudged,
                constraint, reference, repeated, rate, hallucinationRate, constraintRate,
                repeatRate, recoveryRate, errors,
                mistakes: [...codes.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
                    .map(([code, n]) => ({ code, n })),
                score
            };
        }

        // Pillar 2 (25%): Macro & Agency — dev targets, ops discipline, situational batching & passive waits.
        _macro(seat, until, okNonWaitCount) {
            const turns = seat.turns;
            if (!turns.length) return {
                score: null, devScore: null, opsScore: null, agencyScore: null, activityGate: null,
                avgIdle: null, popStallRate: null, avgFloatPenalty: null,
                maxWorkers: null, maxPop: null, maxBuildings: null, maxTechs: 0, ages: 0,
                bwUtil: null, parallelRate: null, passiveWaits: 0, justifiedWaits: 0,
                passiveWaitRate: null, justifiedWaitRate: null, okPerDecision: null,
                batch: { total: 0, passive0: 0, justified0: 0, one: 0, two: 0, three: 0, oppTurns: 0, multiOpp: 0, multiBatched: 0,
                    shares: { passive0: 0, justified0: 0, one: 0, two: 0, three: 0 } }
            };

            const tl = this.timeline || this._preview, id = seat.id;
            const ages = (tl ? tl.ages : []).filter(a => a && a.id === id && (until == null || a.t <= until)).length;
            let maxTurnSec = 0, maxEmpireSec = 0, remnantTurns = 0, maxWorkers = null, maxPop = null, maxBuildings = null, maxTechs = 0;
            let idleSum = 0, idleTurns = 0, popStalled = 0, popTurns = 0, floatSum = 0, resTurns = 0;
            let passiveWaits = 0, justifiedWaits = 0, one = 0, two = 0, three = 0;
            let oppSum = 0, prodUsedSum = 0, oppTurns = 0, multiOpp = 0, multiBatched = 0;

            for (const t of turns) {
                if (t.sec != null && t.sec > maxTurnSec) maxTurnSec = t.sec;
                const f = t.facts;
                if (f.remnant) remnantTurns++;
                else if (t.sec != null && t.sec > maxEmpireSec) maxEmpireSec = t.sec;
                if (f.workers) {
                    if (maxWorkers == null || f.workers.total > maxWorkers) maxWorkers = f.workers.total;
                    if (f.workers.total > 0 && (f.hasFinishedTC !== false || f.canRebuildTC)) {
                        idleSum += clamp01(f.workers.idle / f.workers.total);
                        idleTurns++;
                    }
                }
                if (f.pop) {
                    if (maxPop == null || f.pop.used > maxPop) maxPop = f.pop.used;
                    if (f.pop.cap != null && f.pop.cap > 0) {
                        popTurns++;
                        if (f.pop.cap < f.pop.ceiling && f.pop.used >= f.pop.cap) popStalled++;
                    }
                }
                if (f.bldCount != null && (maxBuildings == null || f.bldCount > maxBuildings)) maxBuildings = f.bldCount;
                if (f.techCount != null && f.techCount > maxTechs) maxTechs = f.techCount;
                if (f.resTotal != null && !f.remnant) {
                    const uncapped = !f.pop || f.pop.used < f.pop.ceiling;
                    const cap = f.bankingTarget > 1500 ? Math.min(4500, f.bankingTarget) : 1500;
                    floatSum += uncapped ? clamp01((f.resTotal - cap) / 3500) : 0;
                    resTurns++;
                }

                // Batching & agency
                const activeCmds = t.cmds.filter(c => c.action !== 'wait').length;
                let productiveOk = 0, sawAssign = false;
                for (const c of t.cmds) {
                    if (c.action === 'wait') continue;
                    if (t.outcomes && c.ok !== true) continue;
                    if (c.action === 'assign_workers') {
                        if (sawAssign) continue;
                        sawAssign = true;
                    }
                    productiveOk++;
                }

                if (activeCmds === 0) {
                    if (f.openFronts > 0) passiveWaits++;
                    else justifiedWaits++;
                } else if (activeCmds === 1) one++;
                else if (activeCmds === 2) two++;
                else three++;

                if (f.openFronts > 0) {
                    oppTurns++;
                    oppSum += f.openFronts;
                    prodUsedSum += Math.min(f.openFronts, productiveOk);
                }
                if (f.openFronts >= 2) {
                    multiOpp++;
                    if (productiveOk >= 2) multiBatched++;
                }
            }

            // Freeze empire development clock while in remnant hiding (with a 10-min anti-gaming floor)
            const clockSec = remnantTurns > 0
                ? Math.max(maxEmpireSec, Math.min(maxTurnSec || until || 0, 600))
                : (maxTurnSec || until || 0);
            const activeMin = Math.max(1, clockSec / 60);
            const workerTarget = Math.min(20, 4 + 0.6 * activeMin);
            const popTarget = Math.min(45, 5 + 1.3 * activeMin);
            const bldTarget = Math.min(14, 2 + 0.35 * activeMin);
            const techTarget = Math.min(12, 0.35 * activeMin);
            const ageTarget = Math.min(3, activeMin / 12);

            const devScore = 100 * (
                0.25 * clamp01(((maxWorkers != null ? maxWorkers : 3) - 3) / Math.max(1, workerTarget - 3)) +
                0.25 * clamp01(((maxPop != null ? maxPop : 3) - 3) / Math.max(1, popTarget - 3)) +
                0.20 * clamp01(((maxBuildings != null ? maxBuildings : 1) - 1) / Math.max(1, bldTarget - 1)) +
                0.15 * clamp01(maxTechs / Math.max(1, techTarget)) +
                0.15 * clamp01(ages / Math.max(0.5, ageTarget))
            );
            const activityGate = clamp01(devScore / 25);

            const avgIdle = idleTurns ? idleSum / idleTurns : 0;
            const popStallRate = popTurns ? popStalled / popTurns : 0;
            const avgFloatPenalty = resTurns ? floatSum / resTurns : 0;
            const opsScore = 0.50 * (100 * Math.exp(-4.5 * avgIdle))
                + 0.25 * (100 * (1 - popStallRate))
                + 0.25 * (100 * (1 - avgFloatPenalty));

            const n = turns.length;
            const bwUtil = oppSum ? prodUsedSum / oppSum : null;
            const parallelRate = multiOpp ? multiBatched / multiOpp : null;
            const passiveWaitRate = n ? passiveWaits / n : 0;
            const justifiedWaitRate = n ? justifiedWaits / n : 0;
            const agencyScore = 100 * (0.60 * (bwUtil == null ? 0 : bwUtil) + 0.40 * Math.exp(-3.5 * passiveWaitRate));
            const score = round1(0.40 * devScore + 0.30 * activityGate * opsScore + 0.30 * activityGate * agencyScore);

            return {
                score, devScore: round1(devScore), opsScore: round1(opsScore), agencyScore: round1(agencyScore), activityGate,
                avgIdle, popStallRate, avgFloatPenalty, activeMin: round1(activeMin), remnantTurns,
                idleSum, idleTurns, popStalled, popTurns, floatSum, resTurns, oppSum, prodUsedSum,
                maxWorkers, maxPop, maxBuildings, maxTechs, ages,
                bwUtil, parallelRate, passiveWaits, justifiedWaits, passiveWaitRate, justifiedWaitRate,
                okPerDecision: n && okNonWaitCount != null ? okNonWaitCount / n : null,
                batch: {
                    total: n, passive0: passiveWaits, justified0: justifiedWaits, one, two, three,
                    oppTurns, multiOpp, multiBatched,
                    shares: {
                        passive0: n ? passiveWaits / n : 0,
                        justified0: n ? justifiedWaits / n : 0,
                        one: n ? one / n : 0,
                        two: n ? two / n : 0,
                        three: n ? three / n : 0
                    }
                }
            };
        }

        // Pillar 3 (15%): Spatial & Fog Reasoning — map exploration, rival discovery, spatial command grounding.
        _spatial(seat, until) {
            const turns = seat.turns;
            if (!turns.length) return {
                score: null, maxExplored: null, discovered: 0, opponents: 0,
                spatialOrders: 0, spatialErrors: 0, expScore: null, discScore: null, spatialGround: null
            };
            let maxTurnSec = 0, maxEmpireSec = 0, remnantTurns = 0, maxExplored = null, discovered = 0, opponents = 0, spatialOrders = 0, spatialErrors = 0;
            for (const t of turns) {
                if (t.sec != null && t.sec > maxTurnSec) maxTurnSec = t.sec;
                const f = t.facts;
                if (f.remnant) remnantTurns++;
                else if (t.sec != null && t.sec > maxEmpireSec) maxEmpireSec = t.sec;
                if (f.exploredPct != null && (maxExplored == null || f.exploredPct > maxExplored)) maxExplored = f.exploredPct;
                if (f.oppsDiscovered != null && f.oppsDiscovered > discovered) discovered = f.oppsDiscovered;
                if (f.oppsTotal != null && f.oppsTotal > opponents) opponents = f.oppsTotal;
                for (const c of t.cmds) if (SPATIAL_ACTIONS.has(c.action)) spatialOrders++;
                for (const x of t.outcomes || []) {
                    if ((x.verdict === 'avoidable' || x.verdict === 'invalid') && SPATIAL_ERROR_CODES.has(x.code)) spatialErrors++;
                }
            }
            const clockSec = remnantTurns > 0
                ? Math.max(maxEmpireSec, Math.min(maxTurnSec || until || 0, 600))
                : (maxTurnSec || until || 0);
            const activeMin = Math.max(1, clockSec / 60);
            const expTarget = Math.min(55, 6 + 1.1 * activeMin);
            const expScore = maxExplored == null ? 0 : 100 * clamp01(Math.max(0, maxExplored - 2) / Math.max(1, expTarget - 2));
            const discWeight = clamp01((activeMin - 4) / 12);
            const discScore = opponents ? 100 * (discovered / opponents) : 50;
            const spatialGround = spatialOrders ? 100 * Math.exp(-5 * spatialErrors / (spatialOrders + 6)) : 0;
            const score = round1(0.55 * expScore + 0.25 * (discWeight * discScore + (1 - discWeight) * expScore) + 0.20 * spatialGround);
            return {
                score, maxExplored, discovered, opponents, spatialOrders, spatialErrors,
                expScore: round1(expScore), discScore: round1(discScore), spatialGround: round1(spatialGround)
            };
        }

        // Pillar 4 (15%): Tactical & Combat — home-asset threat defense + value-weighted combat exchange.
        _tactical(seat, until, activityGate) {
            const turns = seat.turns, id = seat.id, R = WarEval.RESPONSE_RADIUS, W = WarEval.RESPONSE_WINDOW;
            const judged = turns.some(t => t.cmds.some(c => c.ok != null));
            const episodes = [];
            let open = null;
            turns.forEach((t, i) => {
                if (t.homeThreat && !open && !(t.facts && t.facts.remnant)) {
                    open = {
                        kind: 'attack', decision: i + 1, turn: t.turn, sec: t.sec, targets: [], attackers: [],
                        by: null, undefended: false, answeredAfter: null, decisions: 0, lost: [], ended: false
                    };
                    episodes.push(open);
                }
                if (open) {
                    for (const f of t.fallen) open.lost.push(f.type);
                    if (!t.homeThreat) { open.ended = true; open = null; }
                }
                if (open) {
                    open.decisions++;
                    for (const x of t.homeThreat.targets) if (!open.targets.some(y => y.type === x.type && near(x, y, 3))) open.targets.push(x);
                    for (const x of t.homeThreat.attackers) {
                        if (!open.attackers.some(y => near(x, y, 3))) open.attackers.push(x);
                        if (!open.by && x.owner) open.by = x.owner;
                    }
                    if (t.homeThreat.undefended) open.undefended = true;
                }
                for (const e of episodes) {
                    const after = i - (e.decision - 1);
                    if (e.answeredAfter != null || after < 0 || after >= W) continue;
                    const ci = t.cmds.findIndex(c => answers(c, e, R));
                    if (ci < 0) continue;
                    e.answeredAfter = after;
                    e.answer = {
                        decision: i + 1, turn: t.turn, sec: t.sec, n: ci + 1,
                        k: nthOfItsKind(t.cmds, ci), action: t.cmds[ci].action, x: t.cmds[ci].x, z: t.cmds[ci].z
                    };
                }
            });
            const seen = new Set(), wonders = [];
            turns.forEach((t, i) => {
                for (const w of t.rivalWonders) if (!seen.has(w.id)) {
                    seen.add(w.id);
                    wonders.push({ kind: 'wonder', decision: i + 1, turn: t.turn, sec: t.sec, id: w.id, x: w.x, z: w.z, by: w.owner, answeredAfter: null });
                }
                for (const w of wonders) {
                    const after = i - (w.decision - 1);
                    if (w.answeredAfter != null || after >= W) continue;
                    const ci = t.cmds.findIndex(c => c.ok === true && c.action === 'attack_target' && (c.target === w.id || near(c, w, R)));
                    if (ci < 0) continue;
                    w.answeredAfter = after;
                    w.answer = {
                        decision: i + 1, turn: t.turn, sec: t.sec, n: ci + 1,
                        k: nthOfItsKind(t.cmds, ci), action: 'attack_target', x: t.cmds[ci].x, z: t.cmds[ci].z
                    };
                }
            });

            // Combat & razing exchange up to `until`
            const relevantBattles = this.battles.filter(b => until == null || !(b.t > until));
            const useVal = relevantBattles.some(b => b.sides && Object.values(b.sides).some(s => s && num(s.lostValue) != null));
            let fought = 0, destroyedHeads = 0, unitsLost = 0, destroyedEff = 0, lostEff = 0, bldRazed = 0, bldLost = 0;
            for (const b of relevantBattles) {
                if (!b.sides[id]) continue;
                fought++;
                const myHead = b.sides[id].lost || 0;
                unitsLost += myHead;
                lostEff += useVal ? (num(b.sides[id].lostValue) != null ? b.sides[id].lostValue : myHead * 80) : myHead;
                const otherKeys = Object.keys(b.sides).filter(k => k !== id);
                const split = Math.max(1, otherKeys.length);
                for (const k of otherKeys) {
                    const oHead = b.sides[k].lost || 0;
                    const oVal = num(b.sides[k].lostValue) != null ? b.sides[k].lostValue : oHead * 80;
                    destroyedHeads += oHead / split;
                    destroyedEff += (useVal ? oVal : oHead) / split;
                }
            }
            for (const r of this.razings) {
                if (until != null && r.t > until) continue;
                const wt = useVal ? (BLD_VALUE[r.kind] || 150) : (BLD_COUNT[r.kind] || 1);
                if (r.by === id && r.owner !== id) { bldRazed++; destroyedEff += wt; }
                if (r.owner === id) { bldLost++; lostEff += wt; }
            }

            const answered = episodes.filter(e => e.answeredAfter != null), atOnce = answered.filter(e => e.answeredAfter <= 1);
            const wonderAnswered = wonders.filter(w => w.answeredAfter != null);
            const list = episodes.map(e => ({
                kind: 'attack', decision: e.decision, turn: e.turn, sec: e.sec,
                what: [...new Set(e.targets.map(x => x.type))], by: e.by,
                decisions: e.decisions, undefended: e.undefended, answeredAfter: e.answeredAfter,
                at: e.attackers[0] ? { x: e.attackers[0].x, z: e.attackers[0].z } : e.targets[0] ? { x: e.targets[0].x, z: e.targets[0].z } : null,
                answer: e.answer || null,
                outcome: e.lost.length ? 'lost' : e.ended ? 'held' : 'open', lost: e.lost
            })).concat(wonders.map(w => ({
                kind: 'wonder', decision: w.decision, turn: w.turn, sec: w.sec, what: ['wonder'], by: w.by,
                answeredAfter: w.answeredAfter, at: w.x != null && w.z != null ? { x: w.x, z: w.z } : null, answer: w.answer || null
            }))).sort((a, b) => a.decision - b.decision);

            const g = clamp01(activityGate == null ? 0.5 : activityGate);
            const priorNum = (useVal ? 400 : 4) * g, priorDen = useVal ? 800 : 8;
            const homeDefScore = 100 * (atOnce.length + wonderAnswered.length + 1.5 * g) / (episodes.length + wonders.length + 3);
            const exchangeScore = 100 * (destroyedEff + priorNum) / (destroyedEff + lostEff + priorDen);
            const hasCombat = (destroyedEff + lostEff > 0) || (episodes.length + wonders.length > 0);
            const exchange = (destroyedEff + lostEff) > 0 ? destroyedEff / (destroyedEff + lostEff) : null;
            const destroyed = round1(destroyedHeads);

            const score = !turns.length ? null
                : round1(!judged ? exchangeScore : hasCombat ? (0.65 * exchangeScore + 0.35 * homeDefScore) : (50 * g));

            return {
                episodes: episodes.length,
                answered: judged ? answered.length : null,
                atOnce: judged ? atOnce.length : null,
                unanswered: judged ? (episodes.length - answered.length) : null,
                decisionsToAnswer: judged && answered.length ? quantile(answered.map(e => e.answeredAfter), 0.5) : null,
                lost: judged ? episodes.filter(e => e.lost.length).length : null,
                held: judged ? episodes.filter(e => !e.lost.length && e.ended).length : null,
                undefended: episodes.filter(e => e.undefended).length,
                wonders: wonders.length,
                wonderAnswered: judged ? wonderAnswered.length : null,
                battles: fought, destroyed, unitsLost, bldRazed, bldLost,
                destroyedEff: round1(destroyedEff), lostEff: round1(lostEff),
                exchange, valueWeighted: useVal,
                homeDefScore: round1(homeDefScore), exchangeScore: round1(exchangeScore),
                list, judged, score
            };
        }

        // Pillar 5 (25%): Strategic Dominance — time-weighted Bradley-Terry power dominance + placement.
        // Post-elimination horizon is capped at POST_ELIM_CAP_SEC (5 min) so an early-eliminated seat's
        // Dominance is penalized for dying early without depending on how slowly survivors stalemate.
        _strategy(seat, until) {
            const tl = this.timeline || this._preview, id = seat.id;
            const samples = (tl ? tl.samples : []).filter(x => x && x.p && x.p[id] && (until == null || x.t <= until));
            let lastAliveT = null, aliveSamples = 0;
            for (const x of samples) {
                const e = x.p[id];
                const isAlive = e.al !== undefined ? !!e.al : (e.pw || 0) > 0;
                if (isAlive) { aliveSamples++; lastAliveT = x.t; }
            }
            let share = 0, counted = 0, leading = 0, run = 0, clearAt = null, seats = 0, btNum = 0, btDen = 0;
            const step = samples.length > 1 ? Math.max(1, (samples[samples.length - 1].t - samples[0].t) / (samples.length - 1)) : 5;
            for (const x of samples) {
                const all = Object.keys(x.p), e = x.p[id], mine = e.pw || 0;
                const isAlive = e.al !== undefined ? !!e.al : mine > 0;
                const total = all.reduce((a, k) => a + (x.p[k].pw || 0), 0);
                const others = all.filter(k => k !== id);
                const othPws = others.map(k => x.p[k].pw || 0);
                const best = othPws.length ? Math.max(...othPws) : 0;
                seats = Math.max(seats, all.length);
                if (total > 0) {
                    counted++;
                    share += mine / total;
                    if (mine >= best) leading++;
                    run = all.length > 1 && mine >= best * WarEval.LEAD_FACTOR && mine > 0 ? run + 1 : 0;
                    if (clearAt == null && run * step >= WarEval.LEAD_SECONDS) clearAt = x.t;
                }
                if (othPws.length > 0) {
                    if (!isAlive && lastAliveT != null && x.t > lastAliveT + WarEval.POST_ELIM_CAP_SEC) continue;
                    const meanOth = sum(othPws) / othPws.length;
                    const ref = 0.5 * best + 0.5 * meanOth;
                    const dom = (mine === 0 && ref === 0) ? 0.5 : (mine === 0 ? 0 : (ref === 0 ? 1 : 1 / (1 + Math.pow(ref / mine, 1.5))));
                    const wtT = (!isAlive && lastAliveT != null) ? lastAliveT : (x.t || 0);
                    const wt = 1 + wtT / 300;
                    btNum += wt * dom;
                    btDen += wt;
                }
            }
            const powerShare = counted ? share / counted : null;
            const trajDom = btDen > 0 ? round1(100 * btNum / btDen) : null;

            let fought = 0, destroyedHeads = 0, lostHeads = 0;
            for (const b of this.battles) {
                if (!b.sides[id] || (until != null && b.t > until)) continue;
                fought++;
                lostHeads += b.sides[id].lost || 0;
                const otherKeys = Object.keys(b.sides).filter(k => k !== id);
                const split = Math.max(1, otherKeys.length);
                for (const k of otherKeys) destroyedHeads += (b.sides[k].lost || 0) / split;
            }
            const exchange = destroyedHeads + lostHeads ? destroyedHeads / (destroyedHeads + lostHeads) : null;
            const final = !!this.results && until == null, row = final ? this.results.ranking.find(r => r.id === id) : null;
            const n = final ? this.results.ranking.length : seats;
            const placement = row && row.rank != null && n > 1 ? (n - row.rank) / (n - 1) : null;
            const placementPct = placement != null ? 100 * placement : null;
            const score = trajDom == null ? (placementPct != null ? round1(placementPct) : null)
                : round1(placementPct != null ? (0.75 * trajDom + 0.25 * placementPct) : trajDom);

            return {
                final, rank: row ? row.rank : null, of: n || null, winner: row ? row.winner : null, placement,
                powerShare, evenShare: seats ? 1 / seats : null, leadShare: counted ? leading / counted : null, samples: counted,
                clearLeadAt: clearAt, converted: clearAt == null || !row ? null : row.rank === 1,
                battles: fought, destroyed: round1(destroyedHeads), lost: lostHeads, exchange,
                ages: (tl ? tl.ages : []).filter(a => a && a.id === id && (until == null || a.t <= until)).map(a => ({ age: a.age, sec: a.t })),
                trajDom,
                score,
                running: trajDom
            };
        }

        // Unscored qualitative plan tracker: stores latest objective/steps and plain change timestamps.
        _plan(turns) {
            const history = [];
            let standing = null, statements = 0;
            const same = (a, b) => String(a.objective || '').trim() === String(b.objective || '').trim()
                && (a.steps || []).length === (b.steps || []).length
                && (a.steps || []).every((s, i) => String(s).trim() === String((b.steps || [])[i]).trim());
            turns.forEach((t, i) => {
                if (!t.plan) return;
                statements++;
                const next = { objective: t.plan.objective, steps: t.plan.steps || [] };
                if (!standing || !same(standing, next)) {
                    history.push({ decision: i + 1, turn: t.turn, sec: t.sec, steps: next.steps });
                    standing = next;
                }
            });
            return {
                statements,
                revisions: Math.max(0, history.length - 1),
                firstAt: history.length ? history[0].decision : null,
                standing,
                history
            };
        }

        // Early-to-late long-horizon context drift once at least DRIFT_MIN_DECISIONS have been made.
        _drift(turns) {
            if (turns.length < WarEval.DRIFT_MIN_DECISIONS) return null;
            const mid = Math.floor(turns.length / 2);
            const halfStats = slice => {
                let rated = 0, bad = 0, idleSum = 0, idleN = 0;
                const lats = [], prompts = [];
                for (const t of slice) {
                    if (t.outcomes) {
                        for (const x of t.outcomes) {
                            if (x.verdict === 'ok' && x.action !== 'wait') rated++;
                            else if (x.verdict === 'avoidable' || x.verdict === 'invalid') { rated++; bad++; }
                        }
                    }
                    if (t.facts && t.facts.workers && t.facts.workers.total > 0) {
                        idleSum += clamp01(t.facts.workers.idle / t.facts.workers.total);
                        idleN++;
                    }
                    if (t.latencyMs != null) lats.push(t.latencyMs);
                    if (t.prompt != null) prompts.push(t.prompt);
                }
                return {
                    errRate: rated ? bad / rated : null,
                    idle: idleN ? idleSum / idleN : null,
                    latencyMs: lats.length ? quantile(lats, 0.5) : null,
                    prompt: prompts.length ? quantile(prompts, 0.5) : null
                };
            };
            const early = halfStats(turns.slice(0, mid)), late = halfStats(turns.slice(mid));
            return {
                decisions: turns.length,
                earlyErrRate: early.errRate,
                lateErrRate: late.errRate,
                errDeltaPp: (early.errRate != null && late.errRate != null) ? round1((late.errRate - early.errRate) * 100) : null,
                earlyIdle: early.idle,
                lateIdle: late.idle,
                idleDeltaPp: (early.idle != null && late.idle != null) ? round1((late.idle - early.idle) * 100) : null,
                earlyLatencyMs: early.latencyMs,
                lateLatencyMs: late.latencyMs,
                latencyRatio: (early.latencyMs && late.latencyMs) ? Math.round(100 * late.latencyMs / early.latencyMs) / 100 : null,
                earlyPrompt: early.prompt,
                latePrompt: late.prompt
            };
        }

        _versatility(seat) {
            const units = new Set(), buildings = new Set(), techs = new Set(), orders = new Set();
            for (const t of seat.turns) for (const c of t.cmds) {
                if (c.ok !== true) continue;
                orders.add(c.action);
                if (c.action === 'train_unit' && c.name && c.name !== 'worker') units.add(c.name);
                if (c.action === 'build_structure' && c.name) buildings.add(c.name);
                if (c.action === 'research_tech' && c.name) techs.add(c.name);
            }
            return { units: [...units].sort(), buildings: [...buildings].sort(), techs: [...techs].sort(), orders: [...orders].sort(), score: null };
        }

        // Duration-invariant cognitive cost and throughput metrics (never inside WAR Score).
        _efficiency(seat, okNonWait, indexVal) {
            const turns = seat.turns;
            const lat = turns.map(t => t.latencyMs).filter(v => v != null);
            const tok = turns.filter(t => t.prompt != null && t.completion != null);
            const commands = sum(turns.map(t => t.commands));
            const promptTotal = sum(tok.map(t => t.prompt));
            const completion = sum(tok.map(t => t.completion));
            const totalTok = promptTotal + completion;
            const thinkingMsTotal = sum(lat);
            const tokensPerDecision = tok.length ? totalTok / tok.length : null;
            const promptPerDecision = tok.length ? promptTotal / tok.length : null;
            const completionPerDecision = tok.length ? completion / tok.length : null;
            return {
                latencyMs: lat.length ? { median: quantile(lat, 0.5), p90: quantile(lat, 0.9), n: lat.length } : null,
                thinkingMsTotal,
                tokens: tok.length ? {
                    promptMedian: quantile(tok.map(t => t.prompt), 0.5),
                    completionMedian: quantile(tok.map(t => t.completion), 0.5),
                    promptTotal, completionTotal: completion, n: tok.length,
                    completionPerOk: okNonWait ? completion / okNonWait : null
                } : null,
                tokensPerDecision,
                promptPerDecision,
                completionPerDecision,
                outputPerValidOrder: tok.length && okNonWait ? completion / okNonWait : null,
                effectiveOrdersPerMin: (okNonWait != null && thinkingMsTotal > 0) ? okNonWait / (thinkingMsTotal / 60000) : null,
                scorePer10kTokPerDec: (indexVal != null && tokensPerDecision) ? indexVal / (tokensPerDecision / 10000) : null,
                commandsPerDecision: turns.length ? commands / turns.length : null,
                emptyDecisions: turns.filter(t => !t.commands).length,
                missedRounds: seat.markers.round_missed || 0,
                failedRequests: seat.markers.request_failed || 0,
                cancelledRequests: seat.markers.request_cancelled || 0
            };
        }

        _harness(s) {
            const h = s.harness, via = { tool_call: 0, content: 0, unknown: 0 };
            for (const t of s.turns) via[t.via === 'tool_call' || t.via === 'content' ? t.via : 'unknown']++;
            const kinds = type => Object.keys(s.kinds || {}).filter(k => k.startsWith(type + ':')).sort()
                .map(k => ({ kind: k.slice(type.length + 1), n: s.kinds[k] }));
            const adaptations = kinds('adaptation'), interventions = kinds('intervention'), m = /^war-transcript\/(\d+)/.exec(this.schema || '');
            return {
                known: !!h, external: h ? h.external : null, kind: h ? h.kind : null, provider: h ? h.provider : null,
                byToolCall: via.tool_call, fromProse: via.content, viaUnknown: via.unknown,
                adaptations, adapted: sum(adaptations.map(x => x.n)),
                interventions, intervened: sum(interventions.map(x => x.n)),
                recorded: !!m && Number(m[1]) >= 2
            };
        }

        // Decision inspector marks: loop, awareness, constraint, passive wait/stall, threat, refused.
        trace(id, classOf = WarEval.classOf) {
            const seat = this.seats.get(id);
            if (!seat) return null;
            const kindOf = x => {
                const c = classOf ? classOf(x) : null;
                return c === 'constraint' ? 'constraint' : (c === 'reference' || x.verdict === 'invalid') ? 'awareness' : 'refused';
            };
            const per = seat.turns.map(t => {
                const m = new Map();
                for (const x of t.outcomes || []) {
                    if (x.verdict !== 'avoidable' && x.verdict !== 'invalid') continue;
                    const key = x.action + ':' + x.code, was = m.get(key);
                    if (was) was.orders++; else m.set(key, { key, action: x.action, code: x.code, verdict: x.verdict, orders: 1 });
                }
                return m;
            });
            const marks = [], inLoop = per.map(() => new Set());
            per.forEach((m, i) => {
                for (const x of m.values()) {
                    if (inLoop[i].has(x.key)) continue;
                    let j = i, orders = 0;
                    while (j < per.length && per[j].has(x.key)) { orders += per[j].get(x.key).orders; j++; }
                    const t = seat.turns[i], n = j - i;
                    if (n >= WarEval.LOOP_MIN) {
                        for (let k = i; k < j; k++) inLoop[k].add(x.key);
                        const last = seat.turns[j - 1];
                        marks.push({
                            kind: 'loop', of: kindOf(x), decision: i + 1, turn: t.turn, sec: t.sec,
                            action: x.action, code: x.code, n, orders,
                            upTo: last.turn, upToSec: last.sec, open: j === per.length
                        });
                    } else marks.push({ kind: kindOf(x), decision: i + 1, turn: t.turn, sec: t.sec, action: x.action, code: x.code, orders: x.orders });
                }
            });

            // Passive wait turns & consecutive stall runs
            const isPassive = t => t.cmds.filter(c => c.action !== 'wait').length === 0 && t.facts && t.facts.openFronts >= 1;
            let pi = 0;
            while (pi < seat.turns.length) {
                if (!isPassive(seat.turns[pi])) { pi++; continue; }
                let pj = pi;
                while (pj < seat.turns.length && isPassive(seat.turns[pj])) pj++;
                const n = pj - pi;
                if (n >= WarEval.STALL_MIN) {
                    const t = seat.turns[pi], last = seat.turns[pj - 1];
                    marks.push({
                        kind: 'passive', decision: pi + 1, turn: t.turn, sec: t.sec, n,
                        openFronts: t.facts.openFronts, upTo: last.turn, upToSec: last.sec, open: pj === seat.turns.length
                    });
                } else {
                    for (let k = pi; k < pj; k++) {
                        const t = seat.turns[k];
                        marks.push({ kind: 'passive', decision: k + 1, turn: t.turn, sec: t.sec, n: 1, openFronts: t.facts.openFronts });
                    }
                }
                pi = pj;
            }

            const mine = this.profile().seats.find(x => x.id === id), tac = mine && mine.tactical;
            if (tac && tac.judged) for (const e of tac.list) {
                if (e.answeredAfter != null || seat.turns.length - e.decision + 1 < WarEval.RESPONSE_WINDOW) continue;
                marks.push({ kind: 'threat', decision: e.decision, turn: e.turn, sec: e.sec, threat: e });
            }
            marks.sort((a, b) => a.decision - b.decision);
            const counts = { loop: 0, constraint: 0, awareness: 0, passive: 0, threat: 0, refused: 0 };
            for (const m of marks) counts[m.kind] = (counts[m.kind] || 0) + 1;
            return { id, decisions: seat.turns.length, judged: seat.turns.some(t => t.outcomes), marks, counts };
        }

        orders(id) {
            const seat = this.seats.get(id);
            if (!seat) return null;
            const out = [];
            for (const t of seat.turns) for (const c of t.cmds) if (c.x != null && c.z != null && c.ok !== false) out.push({ x: c.x, z: c.z, sec: t.sec, action: c.action });
            return out;
        }

        profileAt(sec) {
            const key = this.lines + ':' + this.unreadable + ':' + this.rev + ':' + sec;
            if (this._past && this._pastKey === key) return this._past;
            this._pastKey = key;
            return this._past = this._work([...this.seats.values()].map(s => Object.assign({}, s, {
                turns: s.turns.filter(t => t.sec != null && t.sec <= sec)
            })), sec);
        }

        history(every = WarEval.HISTORY_SEC) { return this._history(every, null); }

        liveHistory(every = WarEval.HISTORY_SEC, budgetMs = 8) {
            if (!this._live || this._live.every !== every) this._live = { every, at: new Map(), pending: 0 };
            return this._history(every, this._live, budgetMs);
        }

        _history(every, live, budgetMs = 0) {
            const seats = [...this.seats.values()].filter(s => s.turns.length);
            let end = 0;
            for (const s of seats) for (const t of s.turns) if (t.sec != null && t.sec > end) end = t.sec;
            const tl = this.timeline || this._preview, last = tl && tl.samples && tl.samples.length ? num(tl.samples[tl.samples.length - 1].t) : null;
            if (last != null && last > end) end = last;
            const grid = [];
            for (let t = every; t < end; t += every) grid.push(t);
            const rows = (profile, t) => {
                const v = {};
                for (const p of profile.seats) {
                    if (!p.decisions) continue;
                    const all = this.seats.get(p.id).turns;
                    const turns = t == null ? all : all.filter(x => x.sec != null && x.sec <= t);
                    const g = p.grounding, m = p.macro;
                    v[p.id] = [
                        p.decisions, p.index.value,
                        g.score, m.score, p.spatial.score, p.tactical.score, p.strategy.score,
                        sum(turns.map(x => x.commands)),
                        g.ok, g.rated, g.avoidable, g.invalid, g.repeated, m.passiveWaits,
                        sum(turns.map(x => x.prompt || 0)),
                        sum(turns.map(x => x.completion || 0)),
                        sum(turns.map(x => x.latencyMs || 0))
                    ];
                }
                return v;
            };
            const sample = t => ({ t, v: rows(this.profileAt(t), t) });
            let samples;
            if (!live) {
                samples = grid.map(sample);
                // The last point is the profile itself, as on the live board below (b1285).
                // It was the blend "as of the last second" like every point before it,
                // without the placement only the result brings: each curve ended about
                // three points off the final score printed beside it, and the exported
                // history contradicted the profile of the same file.
                if (end > 0) samples.push({ t: end, v: rows(this.profile(), null) });
            } else {
                const clock = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
                const started = clock();
                let did = 0, waiting = 0;
                for (let i = grid.length - 1; i >= 0; i--) {
                    const t = grid[i];
                    let sig = '';
                    for (const s of seats) { let n = 0; for (const x of s.turns) if (x.sec != null && x.sec <= t) n++; sig += n + ','; }
                    let fights = 0, razes = 0, readings = 0;
                    for (const b of this.battles) if (!(b.t > t)) fights++;
                    for (const r of this.razings) if (!(r.t > t)) razes++;
                    if (tl && tl.samples) for (const x of tl.samples) if (x && x.t <= t) readings++;
                    sig += fights + ',' + razes + ',' + readings;
                    const kept = live.at.get(t);
                    if (kept && kept.sig === sig) continue;
                    if (!did || clock() - started < budgetMs) { live.at.set(t, { sig, s: sample(t) }); did++; }
                    else waiting++;
                }
                live.pending = waiting;
                samples = grid.map(t => live.at.get(t)).filter(Boolean).map(k => k.s);
                if (end > 0) samples.push({ t: end, v: rows(this.profile(), null) });
            }
            return {
                type: 'scores', kind: 'war-eval/' + WarEval.VERSION, scale: WarEval.SCALE,
                everySec: every, fields: WarEval.HISTORY_FIELDS.slice(),
                seats: seats.map(s => ({ id: s.id, seat: s.seat, civ: s.civ, name: s.name, model: s.model })), samples
            };
        }

        static series(scores, id) {
            if (!scores || !Array.isArray(scores.samples) || !Array.isArray(scores.fields)) return null;
            const rows = scores.samples.filter(s => s.v && s.v[id]);
            if (!rows.length) return null;
            const out = { t: rows.map(s => s.t) };
            scores.fields.forEach((f, i) => { out[f] = rows.map(s => s.v[id][i]); });
            return out;
        }

        profileWith(results, timeline) {
            const keep = [this.results, this.timeline];
            if (results) this.results = resultsOf(results);
            if (timeline) this.timeline = timelineOf(timeline);
            try { return this._work([...this.seats.values()]); }
            finally { this.results = keep[0]; this.timeline = keep[1]; }
        }

        preview(timeline) {
            if (this.timeline || !timeline || !Array.isArray(timeline.samples)) return;
            const n = timeline.samples.length;
            if (this._preview && this._previewN === n) return;
            this._preview = { samples: timeline.samples.slice(), ages: Array.isArray(timeline.ages) ? timeline.ages.slice() : [] };
            this._previewN = n; this.rev++;
        }

        profile() {
            if (this._profile && this._profileLines === this.lines + ':' + this.unreadable + ':' + this.rev) return this._profile;
            this._profileLines = this.lines + ':' + this.unreadable + ':' + this.rev;
            return this._profile = this._work([...this.seats.values()]);
        }

        _work(list, until) {
            const seats = list.map(s => {
                const grounding = this._grounding(s.turns);
                const okForMetrics = (grounding.judged === 0 && grounding.unjudged > 0) ? null : grounding.okNonWait;
                const macro = this._macro(s, until, okForMetrics);
                const spatial = this._spatial(s, until);
                const tactical = this._tactical(s, until, macro.activityGate);
                const strategy = this._strategy(s, until);

                let indexVal = null, ofCount = 0;
                if (s.turns.length) {
                    const part = {
                        grounding: grounding.score,
                        macro: macro.score,
                        spatial: spatial.score,
                        tactical: tactical.score,
                        strategy: strategy.score
                    };
                    let wSum = 0, vSum = 0;
                    for (const k of WarEval.SCORED) {
                        if (part[k] == null) continue;
                        const w = WarEval.WEIGHTS[k];
                        wSum += w; vSum += w * part[k]; ofCount++;
                    }
                    if (wSum > 0) indexVal = round1(vSum / wSum);
                }

                let maxSec = 0;
                for (const t of s.turns) if (t.sec != null && t.sec > maxSec) maxSec = t.sec;
                const warmup = s.turns.length > 0 && maxSec < WarEval.WARMUP_SEC && grounding.rated < WarEval.WARMUP_RATED;

                return {
                    id: s.id, seat: s.seat, civ: s.civ, model: s.model, name: s.name,
                    decisions: s.turns.length, warmup,
                    grounding, macro, spatial, tactical, strategy,
                    versatility: this._versatility(s),
                    efficiency: this._efficiency(s, okForMetrics, indexVal),
                    drift: this._drift(s.turns),
                    plan: this._plan(s.turns),
                    harness: this._harness(s),
                    index: { value: indexVal, of: ofCount, parts: WarEval.SCORED.length }
                };
            });
            seats.sort((a, b) => (a.seat == null ? 1e9 : a.seat) - (b.seat == null ? 1e9 : b.seat) || String(a.id).localeCompare(String(b.id)));
            return {
                kind: 'war-eval/' + WarEval.VERSION, scale: WarEval.SCALE,
                match: this.match, lines: this.lines, unreadable: this.unreadable,
                seats, recorded: (this.results && this.results.profile) || null
            };
        }
    }

    WarEval.Ledger = Ledger;
    WarEval.createLedger = () => new Ledger();
    WarEval.profileOf = text => {
        const ledger = new Ledger();
        for (const line of String(text || '').split(/\r?\n/)) ledger.addLine(line);
        return ledger.profile();
    };

    root.WarEval = WarEval;
    if (typeof module !== 'undefined' && module.exports) module.exports = WarEval;
})(typeof window !== 'undefined' ? window : globalThis);
