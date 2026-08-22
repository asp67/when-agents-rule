// LLM harness for non-human players: builds each model's per-turn game-state JSON,
// shapes provider-specific requests (OpenAI / Anthropic / Ollama / Google), parses
// the ONE action per reply, executes it, and feeds the outcome back next turn.
// Controllers come from the setup screen via initFromSetup (Arena and Campaign).

class OpenAIAIManager {
    static _formationSeq = 0;
    constructor(game) {
        this.game = game;
        this.aiControllers = []; // One per AI player
        this.currentControllerIndex = 0;
        this.turnInterval = 1500; // Small breather between a model's own turns. The real
                                  // limiter is each model's own latency, so a fast model
                                  // naturally takes more turns — its speed is an intended
                                  // advantage. Each model runs its own pipeline (see update()).
        this.requestTimeout = 180000; // Abort a model request after this many ms. Generous so
                                      // slower local models (Ollama) get a chance; very large or
                                      // reasoning models on modest hardware may still exceed it —
                                      // use a smaller/faster model for the real-time arena.
        // Turn-based mode (see updateTurnBased). Off = independent pipelines, latency
        // is a real advantage. On = every seat reads the same board and every move
        // lands at the same instant, so the decision budget is identical and only
        // judgement varies.
        this.turnBased = false;
        this._roundPhase = 'ask';   // 'ask' -> 'wait' -> 'ask'
        this._roundNo = 0;          // stamped on each question; a reply from an older
                                    // round answers a board that is already gone
        this._roundStartedAt = 0;
        this._roundEndedAt = 0;
        this.pendingRequests = new Map(); // controllerId -> Promise
        this._orderSeq = 0; // monotonic token stamped on a unit each time it gets a new
                            // move/attack order, so a deferred attack-arrival report can
                            // tell which units are still on that order vs reassigned.
        this._stopped = false; // set true when the match ends/restarts: aborts in-flight
                               // requests and makes any late resolution a no-op, so the
                               // previous match's models can't mutate the next one.
        this.decisionLog = []; // Array of { timestamp, playerId, civName, action, reason }
        this.maxLogEntries = 400; // keep a deep decision history for the spectator log
        this.maxHistoryEntries = 400; // how many past moves we RETAIN in memory; how
                                 // many are actually SENT is chosen per turn by budget.
    }

    // Per-controller behavior metrics (reset each match)
    // Was this optional parameter actually SUPPLIED?
    //
    // A key present but blank is the model omitting it, not setting it — models
    // routinely send "from": "" or "targetX": " " to mean "no preference", having
    // been told the field is optional. The trim has to happen BEFORE the emptiness
    // test, which is where this kept going wrong: `v !== ''` passes a single space
    // through, and then "from" fails an enum it never meant to answer. For
    // coordinates it was worse than an error — Number(" ") is 0 and finite, so a
    // blank targetX was silently accepted as the map centre.
    static given(v) {
        return !(v === undefined || v === null || (typeof v === 'string' && v.trim() === ''));
    }

    // How many food/wood nodes each Town Center contributes to "nearestNodes".
    // Stone and gold ignore it — they are scarce enough to list whole.
    static get NEAREST_PER_ANCHOR() { return 10; }

    // The tool surface. Two tools, because a turn is two different things: up to
    // MAX_COMMANDS_PER_TURN actions, and at most one standing plan.
    //
    // The action VOCABULARY is not repeated here. It lives in the system prompt and
    // nowhere else, because a second copy is a second thing to forget -- the same
    // drift that cost us "pop" in blockedBy this morning. The schema says what shape
    // a call has; the prompt says which actions exist.
    // Every action the dispatcher accepts, with its parameters. THE source: the tool
    // schemas below are generated from it, and a test holds it against the switch in
    // executeAction, so a case added there without an entry here fails loudly instead
    // of quietly becoming an action no model is ever offered.
    //
    // "reason" is on every one of them and is not decoration: it is what the decision
    // log shows a spectator, and the only place a model explains itself in its own
    // words.
    static get ACTIONS() {
        const S = (d) => ({ type: 'string', description: d });
        const N = (d) => ({ type: 'number', description: d });
        const I = (d) => ({ type: 'integer', description: d });
        const XZ = { targetX: N('Map X. Always together with targetZ.'),
                     targetZ: N('Map Z. Always together with targetX.') };
        const WHO = { units: { type: 'object', description: 'Object of {"type": count}, e.g. {"champion":3}, or a category like {"infantry":5}. Omit for the whole army.' },
                      unitIds: { type: 'array', items: { type: 'integer' }, description: 'Exact unit ids from friendlyUnits. Wins over "units" when both are given.' },
                      matchSpeed: S('Optional. "slowestUnit" holds the whole group to its slowest member so they arrive together instead of strung out. Omit to let every unit run at its own speed, which is faster for the quick ones and arrives piecemeal.'),
                      formation: S('Optional shape for the MARCH. Every shape keeps the shooters out of the contact rank and the cavalry on the wings. "line" — two ranks of melee, shooters behind, the widest front. "wedge" — a filled triangle, melee at the point. "block" — four to five deep, melee across the front, shooters on both flanks behind it. "screen" — melee ranks, an empty rank, then the shooters. Dropped on contact — it governs the approach, not the fight. Implies matchSpeed "slowestUnit".') };
        return [
            ['train_unit', 'Train one unit at a building that can produce it.',
             Object.assign({ unitType: S('Unit id from units.trainable.') }, XZ), ['unitType']],
            ['research_tech', 'Start researching one technology.',
             { techId: S('Tech id from research.available.') }, ['techId']],
            ['upgrade_age', 'Advance to the next age. Costs are in epoch.nextEpochCost.', {}, []],
            ['build_structure', 'Place a new building. A worker is pulled to build it.',
             Object.assign({ buildingType: S('Building type from buildings.buildable.') }, XZ), ['buildingType']],
            ['assign_workers', 'Move workers onto a resource.',
             Object.assign({ resourceType: S('food|wood|stone|gold|farm — what they should gather.'),
                             count: I('How many. Default 3, max 20.'),
                             from: S('food|wood|stone|gold|farm|idle — where to TAKE them. Omit to take idle first, then your largest stockpile.'),
                             allowSpill: { type: 'boolean', description: 'Default true: also move workers carrying a load, which is then lost.' } }, XZ), ['resourceType']],
            ['repair_building', 'Send workers to repair a damaged building. Omit the coordinates to repair the most damaged one.',
             Object.assign({ count: I('How many workers. Default 1, max 5.') }, XZ), []],
            ['explore', 'Send a unit to scout a map tile.',
             { tile: S('Tile label from map.exploration, e.g. "C5" — column A-G, row 1-7.'),
               unitType: S('Which unit type to send. Optional.'),
               unitIds: { type: 'array', items: { type: 'integer' }, description: 'Exact unit ids to send. Optional.' } }, ['tile']],
            ['move_units', 'Move units to a position.',
             Object.assign({}, XZ, WHO), ['targetX', 'targetZ']],
            ['attack_target', 'Attack a unit or building by id, or attack-move to a position. Coordinates start a march — do not reissue it while they are still marching.',
             Object.assign({ targetId: I('Id from enemyUnits/enemyBuildings. Use this OR targetX/targetZ.') }, XZ, WHO), []],
            ['delete_unit', 'Delete your own units, e.g. to free population.',
             { unitType: S('Type from friendlyUnits. Default worker.'), count: I('How many. Default 1, max 20.') }, []],
            ['destroy_building', 'Demolish one of your own buildings.',
             Object.assign({ buildingType: S('Type from friendlyBuildings.') }, XZ), ['buildingType']],
            ['wait', 'Do nothing this turn. Every turn needs a call; this is the one that means "none".', {}, []]
        ].map(([name, description, params, required]) => ({ name, description, params, required }));
    }

    // The action list as the prompt shows it, generated from ACTIONS. Names and
    // parameters only: what each one MEANS is in the tool schema the model already
    // receives, and writing it twice is how a list drifts from the code it describes.
    static actionsBrief() {
        return OpenAIAIManager.ACTIONS.map(a => {
            const keys = Object.keys(a.params || {});
            if (!keys.length) return a.name + ': (no parameters)';
            const req = a.required || [];
            return a.name + ': ' + keys.map(k => k + (req.indexOf(k) >= 0 ? '' : '?')).join(', ');
        }).join('\n');
    }

    static get ACTION_NAMES() {
        if (!OpenAIAIManager._actionNames) {
            OpenAIAIManager._actionNames = new Set(OpenAIAIManager.ACTIONS.map(a => a.name));
        }
        return OpenAIAIManager._actionNames;
    }

    static get TOOLS() {
        const reason = { type: 'string', description: 'One line, in your own words, why you are doing this.' };
        const tools = OpenAIAIManager.ACTIONS.map(a => ({
            type: 'function',
            function: {
                name: a.name,
                description: a.description,
                parameters: {
                    type: 'object',
                    properties: Object.assign({}, a.params, { reason }),
                    required: a.required
                }
            }
        }));
        tools.push({ type: 'function', function: {
            name: 'plan',
            description: 'State your standing objective and plan. At most once per turn, '
                + 'and only when something changed — both persist across turns.',
            parameters: { type: 'object', properties: {
                objective: { type: 'string', description: 'One line.' },
                plan: { type: 'array', items: { type: 'string' },
                        description: 'Up to ' + OpenAIAIManager.PLAN_MAX_STEPS + ' short steps.' }
            }, required: [] } } });
        return tools;
    }

    // Which protocols this harness can offer tools on TODAY. Anthropic, Google and
    // Ollama all support tool calling in their own shapes; until those shapes are
    // built, a seat there keeps answering in the prompt's JSON and is not judged
    // against a contract it was never offered.
    // How THIS seat is supposed to answer, in one sentence, for use inside error
    // messages. Three different seats need three different answers, and getting it
    // wrong is not cosmetic: small models copy our notation straight back, so an
    // error telling a tool seat to "reply with ONE raw JSON object and no tool call"
    // is a wrong answer we dictated ourselves.
    static howToAnswer(controller) {
        const m = (controller && controller.model) || {};
        // ...and a model whose endpoint has REFUSED the tools array is in the same
        // position as a provider that never had one: the JSON is not a fallback for
        // it any more, it is the only channel it has.
        const tools = OpenAIAIManager.toolsSupported(OpenAIAIManager.resolveProvider(m))
            && !(m._reqOpts && m._reqOpts.omitTools);
        const json = '{"action":"wait","params":{"reason":"..."}}';
        if (!tools) return 'Reply with ONE raw JSON object, e.g. ' + json + '.';
        // The "nothing worth doing" hole, closed. A 9B seat ended 28 of 53 turns with
        // finish_reason "stop" after a median of 162 output tokens: it was not running
        // out of room, it thought briefly, judged the turn not worth a move and said
        // nothing at all. "Use the tools" gave it no way to express that, and wait
        // exists for precisely this. Stating it is the contract described accurately,
        // not a hint — every turn needs a call, including the empty one.
        const call = 'Call an action tool — up to '
            + OpenAIAIManager.MAX_COMMANDS_PER_TURN + ' action calls per turn, any mix of them ("plan" is '
            + 'extra and does not count). EVERY turn needs at least one call: '
            + 'if nothing is worth doing, call it with {"action":"wait","params":{"reason":"..."}} — '
            + 'staying silent forfeits the turn instead of skipping it.';
        return m.toolFallback
            ? call + ' If a call will not go through, one raw JSON object per action also works, e.g. ' + json + '.'
            : call;
    }

    static toolsSupported(provider) {
        return provider === 'openai' || provider === 'ollama'
            || provider === 'anthropic' || provider === 'google';
    }

    // The same two tools in each provider's dialect, all derived from TOOLS so the
    // schema exists once. Anthropic calls the schema input_schema; Google wraps
    // everything in functionDeclarations and wants no "type: function"; Ollama takes
    // the OpenAI shape unchanged.
    static toolsFor(provider) {
        const T = OpenAIAIManager.TOOLS;
        if (provider === 'anthropic') {
            return T.map(t => ({ name: t.function.name, description: t.function.description,
                                 input_schema: t.function.parameters }));
        }
        if (provider === 'google') {
            return [{ functionDeclarations: T.map(t => ({
                name: t.function.name, description: t.function.description,
                parameters: t.function.parameters })) }];
        }
        return T;   // openai-compatible and Ollama
    }

    // A provider's tool calls in the OpenAI shape, so envelopeFromToolCalls never has
    // to learn a second one. Anthropic puts them in the content blocks as tool_use
    // with an "input" object; Google as parts with functionCall{name,args}. Both hand
    // over OBJECTS rather than JSON strings, which is strictly better -- there is no
    // string left for a missing brace to ruin.
    static toolCallsFrom(provider, data) {
        try {
            if (provider === 'anthropic') {
                const blocks = Array.isArray(data.content) ? data.content : [];
                const out = blocks.filter(b => b && b.type === 'tool_use')
                    .map(b => ({ id: b.id, type: 'function',
                                 function: { name: b.name, arguments: b.input } }));
                return out.length ? out : null;
            }
            if (provider === 'google') {
                const cand = (data.candidates || [])[0];
                const parts = (cand && cand.content && cand.content.parts) || [];
                const out = parts.filter(p => p && p.functionCall)
                    .map(p => ({ type: 'function',
                                 function: { name: p.functionCall.name, arguments: p.functionCall.args } }));
                return out.length ? out : null;
            }
        } catch (e) { /* a recording or parsing fault must never cost the turn */ }
        return null;
    }

    // Tool calls -> the envelope everything downstream already handles. Same trick as
    // the flat-JSON extractor: build the shape here, and executeTurn, normalizeCommands,
    // the transcript's "parsed" field and the analyzer all stay untouched.
    //
    // arguments is a JSON STRING the model wrote, so it can break exactly the way an
    // inline object breaks. A broken one costs its own call and nothing else -- which
    // is the whole reason for going this way.
    static envelopeFromToolCalls(calls) {
        const cmds = [];
        const head = {};
        let broken = 0;
        for (const call of (calls || [])) {
            const fn = (call && call.function) || {};
            const name = String(fn.name || '').trim();
            let args = fn.arguments;
            if (typeof args === 'string') {
                try { args = JSON.parse(args); }
                catch (e) { broken++; continue; }
            }
            if (!args || typeof args !== 'object') { broken++; continue; }
            if (name === 'plan') {
                if (head.objective === undefined && typeof args.objective === 'string') head.objective = args.objective;
                if (head.plan === undefined && Array.isArray(args.plan)) head.plan = args.plan;
            } else if (OpenAIAIManager.ACTION_NAMES.has(name)) {
                // The tool NAME is the action. Everything else in the call is its
                // parameters, so nothing has to be unwrapped and nothing can disagree
                // about which action was meant.
                cmds.push({ action: name, params: args });
            } else if (typeof args.action === 'string') {
                // The old single-"action" shape, still accepted: a model that wraps
                // {action, params} meant the same thing, and refusing it would fail a
                // seat over a habit rather than over a decision.
                cmds.push({ action: args.action, params: args.params || args });
            } else {
                broken++;
            }
        }
        for (let i = 0; i < broken; i++) cmds.push({ action: null, _unparsed: true });
        if (!cmds.length && head.objective === undefined && head.plan === undefined) {
            return { envelope: null, broken };
        }
        return { envelope: Object.assign({ commands: cmds }, head), broken };
    }

    // No tool call came back. Two very different faults look identical from here, and
    // they have different fixes: the MODEL did not call one, or the SERVER did not
    // recognise the call it made. The raw reply tells them apart -- tool syntax sitting
    // in the content means the model called and the parser missed it, which is a wrong
    // --tool-call-parser on vLLM or a chat template without a tool section on
    // llama.cpp. Saying which one saves an evening of looking in the wrong place.
    static toolSyntaxInText(text) {
        const t = String(text || '');
        if (!t) return null;
        const marker = [/<tool_call>/i, /<\/tool_call>/i, /<function[_ ]?call/i, /\bfunctools\[/i,
                        /"name"\s*:\s*"(?:action|plan)"/i, /<\|tool[_▁]call/i];
        const hit = marker.filter(re => re.test(t));
        return hit.length ? t.match(hit[0])[0].slice(0, 40) : null;
    }

    // ONE answer to "what is this worker doing". The state summary
    // (workers.onWood, workers.idle, ...) and assign_workers' "from" filter both read
    // it, because they were written separately and have now drifted twice.
    //
    // First over farms: counting only the task put a worker WALKING to a farm into
    // onFood here and into "farm" there, so the state advertised food workers the
    // executor would not hand over -- 22 rejected calls in a single match.
    //
    // Then over carryingResourceType. Seven places in game.js clear
    // carryingResource and leave the type string set, including the stop block in
    // moveUnits, which is exactly what puts a worker into the idle pool. Reading the
    // type WITHOUT the load as a gate turned such a worker into a wood gatherer for
    // the executor while the state still called it idle -- so a model asking for the
    // idle worker the state had just published was told there were none.
    //
    // The gate is the load, never the label. Returns exactly one of:
    //   'building' 'scouting' 'farm' 'food' 'wood' 'stone' 'gold' 'idle' 'moving'
    static workerJob(game, u) {
        if (!u || u.type !== 'worker') return null;
        if (u.task === 'building' || u.isBuilding) return 'building';
        // Before every gathering test, and in the same order the candidate filter
        // in executeAssignWorkers rejects them: builders, then fighters. A worker
        // hitting back has no task, so isIdleWorker() -- which looks at no combat
        // flag -- called it idle and workers.idle offered a hand that could not be
        // taken. Counting it here as what it is costs the economy tallies nothing
        // they were entitled to and tells the model something it could not see at
        // all: that its villagers are under attack.
        if (u.isAttacking || u.attackTarget || u.attackMove) return 'fighting';
        if (u.task === 'scouting') return 'scouting';
        if (u.task === 'farm_work' || u.farmRef) return 'farm';
        const carrying = !!(u.carryingResource || u.task === 'carrying');
        if (carrying || u.task === 'harvesting' || u.isHarvesting || u.harvestTarget) {
            const rt = (u.harvestTarget && u.harvestTarget.type) || u.carryingResourceType;
            return (rt === 'food' || rt === 'wood' || rt === 'stone' || rt === 'gold')
                ? rt
                : 'moving';   // job not resolved yet (in transit)
        }
        return (game && game.isIdleWorker && game.isIdleWorker(u)) ? 'idle' : 'moving';
    }

    newStats() {
        return {
            requests: 0,          // requests that returned or definitively failed
            latencies: [],        // ms per request that produced a response
            timeouts: 0,
            networkErrors: 0,
            contextOverflows: 0,  // request too big for the model's context (lost turn; endpoint fine)
            rateLimited: 0,       // 429 RESPONSES seen, retried or not (endpoint fine; the ACCOUNT is going too fast)
            rateLimitLost: 0,      // ...of those, TURNS the retry could not save. Two counters because one
                                   // cannot answer both questions: "how much am I being throttled" and "how
                                   // many turns did it actually cost me". A recovered 429 costs nothing.
            promptTokens: 0,      // cumulative token usage as reported by the provider
            completionTokens: 0,  // (0/0 when the endpoint doesn't report usage)
            parseFails: 0,        // response unusable: empty, truncated, or parser crashed
            truncatedReplies: 0,  // ...of those, cut off mid-JSON by the output-token cap
            noActionReturns: 0,   // model answered in prose with NO JSON action — nothing executed
            actionsAttempted: 0,  // actions handed to executeAction
            turnsExecuted: 0,     // turns that ran at least one command. actionsAttempted
                                  // divided by this is commands-per-turn — reported beside
                                  // the success rate, never folded INTO it: a seat that
                                  // sends one safe command must not outrank one that sends
                                  // three and gets two right.
            actionsSucceeded: 0,  // executed OK
            actionsRejected: 0,   // understood but failed on a gate the state had SHOWN
                                  // the model — an avoidable mistake, and the only kind
                                  // successRate counts
            actionsContended: 0,  // understood but failed on something the state cannot
                                  // honestly forewarn (see UNFOREWARNED). Not scored:
                                  // held out of successRate's denominator entirely
            invalidActions: 0,    // unknown action name
            roundsMissed: 0,      // turn-based: rounds that resolved without this seat
                                  // because its answer ran past the deadline. A latency
                                  // fact, never an action — successRate cannot see it
            reasonsGiven: 0,      // decisions that included a non-empty reason
            actionCounts: {},     // attempted action name -> count
            workersTrained: 0     // train_unit attempts whose unitType was "worker".
                                  // actionCounts is keyed by action NAME, and since
                                  // villagers moved into train_unit that key alone can
                                  // no longer tell an economy move from a military one.
        };
    }

    // ---- Helpers for clear, complete error feedback to the model ----
    costString(cost) {
        const parts = [];
        ['food', 'wood', 'stone', 'gold'].forEach(r => { if (cost && cost[r]) parts.push(`${cost[r]} ${r}`); });
        return parts.length ? parts.join(', ') : 'nothing';
    }
    // Record a structured, localizable version of the outcome the decision log will
    // show in the MODEL's language. The English string the caller RETURNS is
    // unchanged and still goes to the model verbatim — this is display-only
    // metadata, read once per action in executeAction. Covered outcomes call this
    // right before returning; uncovered ones don't, and the log falls back to the
    // English text. See ui.renderOutcome / I18N_OUTCOMES.
    outcome(code, params) { this._pendingOutcome = { code, params: params || {} }; return true; }

    // Rejections the state cannot honestly forewarn, and which therefore must not count
    // against a model. Every OTHER rejection is now a gate the model was shown before it
    // acted — blockedBy, a published tally, or a rule in the system prompt — so trying
    // anyway is a real mistake and belongs in successRate. These four are not:
    //   trainerBusy        a trainer exists but is mid-production; flips every ~5s
    //   noWorkerIdleBuild  workers exist, all building or fighting; churns constantly
    //   noClearSpot        a placement search the model has no way to run
    //   assignAllCarrying  who is carrying a load is deliberately unpublished — it is
    //                      stale by the time an answer arrives (the carryingX lesson)
    // Each is something we CHOSE not to publish because publishing it would be a lie by
    // the time the model read it. Scoring a model for not knowing it would restore, in
    // the metric, exactly the unfairness the state was fixed to remove.
    //
    // A code that is not listed counts as avoidable. A metric that quietly forgives what
    // nobody has classified flatters every model equally and hides its own drift; being
    // counted is the error that gets noticed and fixed. Any new rejection outcome added
    // below must be triaged here.
    static get UNFOREWARNED() {
        // targetGone: the id WAS in the state this seat read, and the thing died while
        // it was thinking. Nothing in any snapshot could have warned it.
        // orderedUnitsGone: the same case seen from the other end. The HANDLES were in
        // friendlyUnits in the state this seat read, and every one of those units died
        // while it was thinking. A snapshot cannot forewarn that either.
        // assignIdleRaced: workers.idle said N when this seat read the state and says 0
        // now. Idle is the one worker pool that empties itself -- a dry node makes a
        // worker idle until the next pass reassigns it, 0.2-2s later -- so a seat that
        // asked for idle hands answered a true number that expired while it thought.
        return new Set(['trainerBusy', 'noWorkerIdleBuild', 'noClearSpot', 'assignAllCarrying',
                        'targetGone', 'orderedUnitsGone', 'assignIdleRaced']);
    }
    haveString(ai) {
        const r = ai.resources;
        return `${Math.floor(r.food)} food, ${Math.floor(r.wood)} wood, ${Math.floor(r.stone)} stone, ${Math.floor(r.gold)} gold`;
    }
    // Stock as a {food,wood,stone,gold} object — the localized log renders it as
    // language-neutral emoji, so no resource words to translate.
    haveObj(ai) {
        const r = ai.resources;
        return { food: Math.floor(r.food), wood: Math.floor(r.wood), stone: Math.floor(r.stone), gold: Math.floor(r.gold) };
    }
    // Convert a worker "pulledFrom" label map (idle / scouting / repairing / farming
    // / spare / "from wood") into the {idle,scout,repair,farm,spare,<resource>} shape
    // the log localizes (resource keys → the resource word, the rest → a pull label).
    pulledCounts(pulledFrom) {
        const out = {};
        Object.keys(pulledFrom || {}).forEach(k => {
            const key = k === 'scouting' ? 'scout' : k === 'repairing' ? 'repair' : k === 'farming' ? 'farm'
                : k.startsWith('from ') ? k.slice(5) : k;
            out[key] = (out[key] || 0) + pulledFrom[k];
        });
        return out;
    }
    // Which building type trains a given unit (for precise "build X first" messages)
    requiredBuildingForUnit(unitType, civilization = null) {
        if (unitType === 'worker') return 'town_center';
        if (typeof BUILDING_TRAIN_TIERS !== 'undefined') {
            for (const bld of Object.keys(BUILDING_TRAIN_TIERS)) {
                for (const list of Object.values(BUILDING_TRAIN_TIERS[bld])) {
                    if (Array.isArray(list) && list.includes(unitType)) return bld;
                }
            }
        }
        // Civ-unique units (Greek hoplite, Egypt's horse carriage) are NOT in the
        // shared tier table — they carry their own trainAt. Without this the staged
        // research→build→advance error chain was skipped for exactly the units a
        // model is least likely to understand, and they fell through to a bare
        // "no building available" instead.
        if (civilization && typeof getCivilization === 'function') {
            const u = ((getCivilization(civilization) || {}).uniqueUnits || [])
                .find(x => x.id === unitType);
            if (u && u.trainAt) return u.trainAt;
        }
        // Priests and workers come from buildings with a static trainOptions list
        // rather than an age-tiered one.
        if (typeof BUILDING_DEFS !== 'undefined') {
            for (const bld of Object.keys(BUILDING_DEFS)) {
                const def = getBuildingDef(bld);
                if (def && Array.isArray(def.trainOptions) && def.trainOptions.includes(unitType)) return bld;
            }
        }
        return null;
    }

    // ---- Map grid ("A1".."G7") -------------------------------------------------
    // Columns A..G run west→east (x), rows 1..7 north→south (z). One label instead
    // of a (row, col) pair or a pair of coordinate arrays: every intermediate form
    // we tried invited a transposition that was legal, silent and wrong — a mirrored
    // target is still a valid map position, so nothing could ever report it.
    tileLabel(row, col) {
        return String.fromCharCode(65 + col) + (row + 1);
    }

    // "c5" / "C5" → {row, col}, or null. Deliberately strict about SHAPE (letter then
    // digit) so "5C" fails loudly rather than being quietly reinterpreted.
    parseTile(label, T) {
        const m = /^\s*([A-Za-z])\s*(\d+)\s*$/.exec(String(label || ''));
        if (!m) return null;
        const col = m[1].toUpperCase().charCodeAt(0) - 65;
        const row = parseInt(m[2], 10) - 1;
        if (!(col >= 0 && col < T && row >= 0 && row < T)) return null;
        return { row, col };
    }

    // Which tile is this world position in?
    tileAt(game, x, z) {
        return game.tileLabelAt(x, z);
    }

    // The tiles this player actually holds, busiest first, for error messages that
    // want to anchor the model ("your bases are in D1, G7"). Never a centroid: with
    // two bases that averages to a tile it owns nothing in.
    baseTilesString(ai, game) {
        const counts = {};
        (ai.buildings || []).forEach(b => {
            const k = this.tileAt(game, b.x, b.z);
            counts[k] = (counts[k] || 0) + 1;
        });
        const tiles = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
        return tiles.length ? tiles.join(', ') : '(you hold no tiles — you have no buildings left)';
    }

    // A point inside tile {row,col}, inset so the scout sits well within the tile
    // rather than straddling its border. Random rather than the centre on purpose:
    // one stop reveals only a few percent of a 114-unit tile, so repeated explores
    // of the same tile need to land in different parts of it to fill it in.
    pointInTile(game, row, col, inset, owner) {
        const T = game.EXPLORE_TILES || 7;
        const size = (game.terrain && game.terrain.size) || 800;
        const cell = size / T, half = size / 2;

        // Aim at the DARKEST cell this owner has in the tile, not at a random point in
        // it. The old aim was inset by the scout's own vision radius so it never stood
        // near an edge -- which put a tile's corner cells out of reach, since from an
        // inset corner the corner itself is vision*sqrt(2) away. One match sent 91
        // scouts at C5 and left it stuck at 34 of 36 cells for three hours of game
        // time, every reply ending "expect to send scouts there again".
        //
        // This is not the harness playing. The model asked to explore C5; walking to
        // the part of C5 it has not seen is what that order MEANS, where a random point
        // mostly re-swept ground it already had.
        //
        // Unwalkable cells are skipped: a scout aimed into the sea is held at the
        // shoreline by keepUnitsAshore and would leave that cell dark forever, which is
        // the same loop wearing different clothes.
        const G = game.EXPLORE_GRID || 42;
        const S = Math.max(1, Math.round(G / T));
        const cw = size / G;
        const seen = owner && owner._explored;
        if (seen) {
            let bestVal = Infinity, cands = [];
            for (let z = row * S; z < (row + 1) * S; z++) {
                for (let x = col * S; x < (col + 1) * S; x++) {
                    const cx = -half + (x + 0.5) * cw, cz = -half + (z + 0.5) * cw;
                    if (game.terrain && game.terrain.isWalkable && !game.terrain.isWalkable(cx, cz)) continue;
                    const v = seen[z * G + x] || 0;
                    if (v < bestVal) { bestVal = v; cands = [[cx, cz]]; }
                    else if (v === bestVal) cands.push([cx, cz]);
                }
            }
            // bestVal >= 1 means every reachable cell is already seen; fall through to
            // the old behaviour so a re-sweep for enemies still spreads out.
            if (cands.length && bestVal < 1) {
                const [cx, cz] = cands[Math.floor(Math.random() * cands.length)];
                // Jitter inside the cell so two scouts at one cell do not stack.
                return game.clampToMap(cx + (Math.random() - 0.5) * cw * 0.6,
                                       cz + (Math.random() - 0.5) * cw * 0.6);
            }
        }
        const pad = Math.min(inset || 0, cell / 2 - 1);
        const x0 = col * cell - half + pad, x1 = (col + 1) * cell - half - pad;
        const z0 = row * cell - half + pad, z1 = (row + 1) * cell - half - pad;
        return game.clampToMap(x0 + Math.random() * (x1 - x0), z0 + Math.random() * (z1 - z0));
    }

    // Every unit this civilization can EVER train: the id, the building that makes
    // it, and the earliest age it appears. Mirrors buildingTrains() deliberately —
    // per-age tier options first, static trainOptions as the fallback — so the
    // vocabulary we ADVERTISE cannot drift from the one the executor ACCEPTS.
    // Civ uniques and exclusions come along for free, because
    // getTrainOptionsForBuilding already resolves both (Egypt fields horse
    // carriages and NO generic cavalry; a model could not have known that).
    trainableUnitsFor(civilization) {
        const ageOrder = ['stone', 'neolithic', 'bronze', 'iron'];
        // town_center is in here because the executor has always accepted
        // {"unitType":"worker"} — buildingTrains() special-cases it — while this list
        // advertised only the military hosts. The one action that could reach a
        // villager was therefore the only one a model was told about. Exactly the
        // drift the comment above warns against, on the line that warns about it.
        const hosts = ['town_center', 'barracks', 'archery_range', 'stable', 'temple'];
        const seen = new Map();
        const civTree = ((typeof getCivilization === 'function'
            ? getCivilization(civilization) : null) || {}).techTree || {};
        hosts.forEach(bt => {
            const def = (typeof getBuildingDef === 'function') ? getBuildingDef(bt) : null;
            // A host this civilization can NEVER build advertises units it can never
            // train. Greece has no "horseback" tech, so it has no stable — yet this
            // list handed a Greek player scout_cavalry, cavalry and heavy_cavalry, and
            // trainableListString repeated them inside the very error that refuses one.
            // buildableStructures has always applied this filter; the unit vocabulary
            // never did, which is the same advertise/accept drift pointing outward.
            if (def && def.requiresTech && !civTree[def.requiresTech]) return;
            const floor = (def && def.requiredAge) || 'stone';
            ageOrder.forEach(age => {
                // A unit can't predate the building that trains it: the temple is a
                // bronze-age structure, so its priest is bronze, not stone.
                if (ageOrder.indexOf(age) < ageOrder.indexOf(floor)) return;
                let opts = (typeof getTrainOptionsForBuilding === 'function')
                    ? getTrainOptionsForBuilding(bt, age, civilization) : null;
                if (!opts || !opts.length) opts = (def && def.trainOptions) || [];
                opts.forEach(id => { if (!seen.has(id)) seen.set(id, { id, at: bt, age }); });
            });
        });
        return [...seen.values()];
    }

    // The trainable vocabulary as one line, grouped by the building that makes it.
    // This is what an [ERROR] owes the model when it guesses a unit name wrong.
    trainableListString(ai) {
        const list = this.trainableUnitsFor(ai.civilization);
        if (!list.length) return 'Your civilization trains no units.';
        const byHost = {};
        list.forEach(u => { (byHost[u.at] = byHost[u.at] || []).push(u.id); });
        const parts = Object.entries(byHost).map(([host, ids]) => `at ${host} — ${ids.join(', ')}`);
        return `Your civilization can train: ${parts.join('; ')}.`;
    }

    // Earliest age at which a unit can be trained (scans the train tiers). Lets us
    // tell the model to ADVANCE when a unit is gated to a later epoch.
    minAgeForUnit(unitType) {
        if (typeof BUILDING_TRAIN_TIERS === 'undefined') return null;
        const order = ['stone', 'neolithic', 'bronze', 'iron'];
        for (const bld of Object.keys(BUILDING_TRAIN_TIERS)) {
            const tiers = BUILDING_TRAIN_TIERS[bld];
            for (const age of order) {
                if (tiers[age] && tiers[age].includes(unitType)) return age;
            }
        }
        return null;
    }

    // True if a finished building of the right type/age can produce this unit.
    buildingTrains(b, unitType, age, civilization) {
        if (b.type === 'town_center') return unitType === 'worker';
        let opts = (typeof getTrainOptionsForBuilding === 'function') ? getTrainOptionsForBuilding(b.type, age, civilization || b.civilization) : null;
        if (!opts || !opts.length) opts = b.trainOptions || [];
        return opts.includes(unitType);
    }

    // --- Timing helpers: the model can't see the on-screen progress bars, so we
    // tell it how long timed actions take and how much is left. ---
    // Every duration the model is told is REAL seconds, not game seconds.
    //
    // The two were the same until the speed control existed, and then quietly stopped
    // being: matchSeconds, averageSecondsBetweenTurns and secondsToAnswer are all
    // measured with Date.now(), while build, research, travel and the Wonder hold are
    // game time. At 2x a model was told "60s to build" and given a turn every 10s, and
    // planned six turns of work into the three it actually had.
    //
    // Real seconds is the right unit to normalise ON, because it is the clock the
    // model's own cadence runs on — turn-counting is what these numbers are FOR.
    // effectiveSimSpeed, not simSpeed, so the Wonder lock is reflected: once one
    // stands the game really is back to 1x and everything really does take longer.
    realSecs(gameMs) {
        const sp = (this.game && this.game.effectiveSimSpeed) ? this.game.effectiveSimSpeed() : 1;
        return Math.max(0, Math.ceil((gameMs || 0) / 1000 / (sp || 1)));
    }

    secsLeft(progress, duration) {
        return this.realSecs((duration || 0) - (progress || 0));
    }
    // Seconds for a unit to walk to (tx,tz). Matches the game loop's speed*3 u/s.
    // Hold a group to its slowest member, or release it. Returns what to tell the model.
    //
    // Optional on purpose. Skipping it is not an oversight to be corrected -- it buys a
    // faster arrival for the quick half of a force and pays for it by arriving piecemeal,
    // and choosing that is a real decision about a real trade. The harness does not make
    // it; it just does what was asked and says which was done.
    //
    // The slowest is computed from `speed`, never from moveSpeedOf: reading the effective
    // speed would let one held march set the pace for the next one, and a force that was
    // slowed once would keep slowing itself for the rest of the game.
    // ---- Marching formations -------------------------------------------------
    // Slots in MARCH-RELATIVE coordinates: +f is the direction of travel, +r is to
    // its right. Rotated into world space by the caller, so a shape is defined once
    // and works whichever way the army is pointed.
    //
    // MARCH ONLY. The shape governs where each unit is heading while it walks and is
    // dropped the moment it is close enough to fight -- holding ranks through a melee
    // would need re-forming logic, a way to report the formation's state back, and a
    // whole second argument about what "holding" means when half the rank is dead.
    // Distance between neighbouring slots. Chosen by looking at twenty real units
    // standing in each shape rather than at the arithmetic, because a number of world
    // units means nothing until two soldiers are that far apart on screen.
    //
    // Three constants have to stay in order here:
    //   SEPARATION_DIST         1.2  same-owner units shove each other below this
    //   FORMATION_SPACING       2    where neighbours are placed
    //   UNIT_BUILDING_CLEARANCE 4.5  how far a building pushes a unit out
    //
    // 2 sits 1.67x above the shove threshold, so a formed-up body never fights its own
    // separation -- which is the pinned-and-vibrating failure, manufactured on purpose.
    // It reads as a cohort rather than a scattering.
    //
    // What made 2 look wrong at first was not the distance. It was cavalry standing
    // shoulder to shoulder INSIDE a rank of foot, which no army has ever done; the
    // horse went to the wings and the spacing stopped being the problem. Worth
    // remembering before anyone widens this again to fix a look.
    //
    // At 4 the shapes were needlessly large -- a twenty-man line was 20 wide, wider
    // than most gaps between buildings, which is why lines snagged on clearance rings.
    static get FORMATION_SPACING() { return 2; }
    // "ranged_back" was the name of a shape and, to a model reading a list, the name
    // of the only shape that keeps its shooters out of the fight. Across 46 saved
    // transcripts it took 56% of every formation ever chosen, line took 41%, block one
    // pick, and wedge was never chosen ONCE. It did not win an argument about tactics;
    // it won because the other three sounded like they were missing something.
    //
    // They are not, and now they really are not: every shape keeps the shooters out of
    // the contact rank and puts the horse on the wings. What this one alone has is the
    // GAP -- an empty rank between the melee and the shooters -- so it is named for
    // that. A screen is a body put in front of another to keep it out of the first
    // clash, which is the whole idea.
    // Gates that mean "not yet", as against "not right now". A unit whose only
    // problem is money is still a trainable unit; one with no building to train it in
    // is not, however rich you are.
    static get STRUCTURAL_BLOCKS() { return ['age', 'tech', 'host', 'alreadyBuilt']; }

    // Partition a state list (array, or the units' host->age->entries object) into the
    // things that can be ordered and the things that cannot, keyed { <openName>, blocked }.
    static splitByBlock(src, openName) {
        const isBlocked = e => (e.blockedBy || []).some(b => OpenAIAIManager.STRUCTURAL_BLOCKS.indexOf(b) >= 0);
        const strip = e => { const o = Object.assign({}, e); if (!(o.blockedBy || []).length) delete o.blockedBy; return o; };
        if (Array.isArray(src)) {
            return { [openName]: src.filter(e => !isBlocked(e)).map(strip),
                     blocked:    src.filter(isBlocked) };
        }
        const open = {}, blocked = {};
        Object.entries(src || {}).forEach(([host, byAge]) => {
            Object.entries(byAge || {}).forEach(([age, list]) => {
                const o = list.filter(e => !isBlocked(e)).map(strip);
                const b = list.filter(isBlocked);
                if (o.length) ((open[host] = open[host] || {})[age] = o);
                if (b.length) ((blocked[host] = blocked[host] || {})[age] = b);
            });
        });
        return { [openName]: open, blocked };
    }

    static get FORMATIONS() { return ['line', 'wedge', 'block', 'screen']; }

    // Old name, still answered. A model that learned "ranged_back" from anywhere gets
    // the shape rather than an error, and the transcripts already recorded under it
    // stay readable by the code that reads the new ones.
    static get FORMATION_ALIASES() { return { ranged_back: 'screen' }; }

    formationSlots(units, shape) {
        const S = OpenAIAIManager.FORMATION_SPACING;
        const out = new Map();
        // The engine's own ranged test, not a list of unit names: range > 1 is what
        // updateCombat uses to decide who shoots and who closes, so "ranged" here and
        // "ranged" there cannot come to mean different things.
        const isRanged = u => ((u && u.range) || 0) > 1;
        // A priest has range 3, so the test above already calls it ranged -- but it is
        // the one ranged unit that must never be shot at, and every shape fills its
        // ranged group front-first. Sorting support to the END of that group is what
        // makes "ranged" and "rearmost" the same sentence for them, in every shape,
        // without a second rule per shape to keep in step with the first.
        const isSupport = u => !!(u && u.unitType === 'support');
        // Horse is its own arm. Every shape here sorted by "can it shoot", which put
        // cavalry shoulder to shoulder inside a rank of foot -- the one detail that
        // made a formed-up body look wrong on screen. They ride on the WINGS, level
        // with the front: what it looks like in every painting of a battle line, and
        // what their speed is actually for.
        const isCav = u => !!(u && u.unitType === 'cavalry');
        let cav   = units.filter(isCav);
        let melee = units.filter(u => !isRanged(u) && !isCav(u));
        const shot  = units.filter(isRanged)
            .sort((a, b) => (isSupport(a) ? 1 : 0) - (isSupport(b) ? 1 : 0));
        // Wings need a body to flank. An all-horse force has no foot to stand beside,
        // so there the horse IS the line and takes the shape it would otherwise escort.
        if (!melee.length) { melee = cav; cav = []; }
        const bodyN = melee.length + shot.length;

        // Fill `list` into `rows` ranks starting at rank `from`, centred on the axis of
        // march. Front rank first, so a half-filled formation is short at the BACK
        // rather than ragged at the front where it meets somebody.
        const ranks = (list, rows, from) => {
            if (!list.length) return 0;
            // Depth is asked for, width is earned. Three ranks of three men is a block;
            // three ranks of ONE man is a queue, and a queue is what a small force got,
            // because the rank count was taken literally however few there were to fill
            // it. A single file is the worst possible shape here: it is the longest way
            // to route a group past a building ring, and it is the shape that was seen
            // snagging on exclusion zones. So the requested depth is capped by what the
            // numbers can actually fill at a decent frontage.
            const useRows = Math.max(1, Math.min(rows,
                Math.ceil(list.length / OpenAIAIManager.FORMATION_MIN_WIDTH)));
            const w = Math.ceil(list.length / useRows);
            list.forEach((u, i) => {
                const row = Math.floor(i / w), col = i % w;
                // Each rank centres on its OWN count, so a short back rank sits behind
                // the middle of the one in front instead of hanging off its left.
                const inRow = Math.min(w, list.length - row * w);
                out.set(u, { f: -(from + row) * S, r: (col - (inRow - 1) / 2) * S });
            });
            return Math.ceil(list.length / w);   // ranks actually laid, not asked for
        };

        if (shape === 'line') {
            // Two deep. One rank is the widest front a given number of units can have,
            // which is what put outer slots into the sea and across half a village; two
            // halves the width for a shape that still reads as a line.
            //
            // Those two ranks are the MELEE, and the shooters form up behind them. What
            // stood here laid the whole army out in array order and never looked at what
            // anything was, so who screened whom came down to the order units happened
            // to sit in -- list the shooters first and both priests stood in the rank
            // that takes the charge. Same order, same shape, different casualties, and
            // nothing the model could see or control. A line is a line of TROOPS.
            const meleeRows = ranks(melee, 2, 0);
            ranks(shot, 2, meleeRows || 0);
        } else if (shape === 'wedge') {
            // A FILLED triangle, point forward: rank k holds k+1. Melee fills from the
            // point back, so the tip is what closes; the shooters land in the wide rear
            // ranks, which is where a triangle has room for them anyway.
            const order = melee.concat(shot);
            let i = 0, k = 0;
            while (i < order.length) {
                const wide = Math.min(k + 1, order.length - i);
                for (let j = 0; j < wide; j++) {
                    out.set(order[i + j], { f: -k * S, r: (j - (wide - 1) / 2) * S });
                }
                i += wide; k++;
            }
        } else if (shape === 'block') {
            // Deep and square-ish, with the shooters on BOTH flanks and the melee in
            // the middle: a column that can be hit from either side and answers with
            // its own edges. Five deep once there are enough to fill it, four below.
            const depth = bodyN >= 20 ? 5 : 4;
            const cols = Math.max(1, Math.ceil(bodyN / depth));
            // Column order from the outside in, so the shooters -- laid first -- take
            // the flanks and the melee fills what is left, the middle.
            const mid = (cols - 1) / 2;
            const byEdge = Array.from({ length: cols }, (_, c) => c)
                .sort((a, b) => Math.abs(b - mid) - Math.abs(a - mid));
            // Row 0 is the CONTACT rank and belongs to the melee across its whole
            // width, flanks included. Shooters take the flank columns from row 1 back.
            // Filling the flanks from row 0 put archers at the corners of the front
            // face, which is the first thing anything charging the block reaches -- the
            // shooters were on the flanks and in the contact line at the same time, and
            // only the second half of that was intended.
            // Row 0 is the CONTACT rank and belongs to the melee across its whole
            // width, flanks included; the shooters hold the flank columns from row 1
            // back. Filling the flanks from row 0 put archers on the corners of the
            // front face -- the first thing anything charging the block reaches. They
            // were on the flanks AND in the contact line, and only one of those was
            // the intention.
            const edge = Math.max(...Array.from({ length: cols }, (_, c) => Math.abs(c - mid)));
            const isFlank = (c) => Math.abs(Math.abs(c - mid) - edge) < 1e-6;
            const front = Array.from({ length: cols }, (_, c) => c)
                .sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid))   // fill middle out
                .map(c => ({ c, row: 0 }));
            const behind = [];
            byEdge.forEach(c => { for (let row = 1; row < depth; row++) behind.push({ c, row }); });
            // Front to back, not column by column. Seats are laid out per column for
            // the outside-in ordering, but FILLED per row -- otherwise a body that does
            // not divide evenly leaves its empty seats wherever the last column happens
            // to be, which for the inner region is the middle. A block with a hole
            // punched through the centre of it is worse than one that is short at the
            // back, and the back is where a short rank belongs.
            const rowFirst = (a, b) => a.row - b.row || Math.abs(a.c - mid) - Math.abs(b.c - mid);
            const flank = behind.filter(s => isFlank(s.c)).sort(rowFirst);
            const inner = behind.filter(s => !isFlank(s.c)).sort(rowFirst);
            // Melee mans the front, then the middle; shooters take the flanks. Each
            // queue falls back to the other so a lopsided force still fills the shape
            // instead of leaving holes -- a melee-poor army gets a thinner melee front,
            // which is an honest picture of what it has rather than a hidden failure.
            const mQ = melee.slice(), sQ = shot.slice();
            const place = (u, s) => { if (u && s) out.set(u, { f: -s.row * S, r: (s.c - mid) * S }); };
            front.forEach(s => place(mQ.shift() || sQ.shift(), s));
            flank.forEach(s => place(sQ.shift() || mQ.shift(), s));
            inner.forEach(s => place(mQ.shift() || sQ.shift(), s));
        } else if (shape === 'screen') {
            // Three ranks of melee, an empty rank, three of shot. The gap is the point:
            // it is what stops the shooters being caught in the first contact, and it
            // is why this is not just "block with the archers at the back".
            const meleeRows = ranks(melee, 3, 0);
            ranks(shot, 3, (meleeRows || 0) + 1);
            // Everyone shoots, or nobody does: one body is not two, and a model that
            // asked for a screen and a firing line should be told it got one of them.
            if (!melee.length || !shot.length) {
                return { slots: out, degenerate: shot.length ? 'every unit is ranged' : 'no ranged units' };
            }
        } else {
            return { slots: null };
        }
        // Two columns of horse, one either side of whatever the body turned out to be,
        // starting level with its front rank. Placed AFTER the shape rather than inside
        // it, so all four shapes get wings from one rule instead of four.
        if (cav.length) {
            let maxR = 0;
            out.forEach(v => { maxR = Math.max(maxR, Math.abs(v.r)); });
            const lane = maxR + S;
            const left = Math.ceil(cav.length / 2);
            cav.forEach((u, i) => {
                const onLeft = i < left;
                out.set(u, { f: -(onLeft ? i : i - left) * S, r: (onLeft ? -1 : 1) * lane });
            });
        }
        return { slots: out };
    }

    // Put a force into `shape` for the march to (tx, tz). Facing is the group's own
    // centroid toward the destination, so the shape is oriented by where it is going
    // rather than by any fixed compass direction. Returns per-unit world offsets.
    applyFormation(game, units, tx, tz, shape) {
        const want = OpenAIAIManager.FORMATION_ALIASES[String(shape || '').trim()]
            || String(shape || '').trim();
        if (!units || !units.length) return { applied: false, note: '' };
        if (!want) { units.forEach(u => { u.formationOffset = null; u.formationAxis = null; u.formationGroup = null; }); return { applied: false, note: '' }; }
        if (OpenAIAIManager.FORMATIONS.indexOf(want) < 0) {
            units.forEach(u => { u.formationOffset = null; u.formationAxis = null; u.formationGroup = null; });
            return { applied: false, bad: want,
                     note: ` (formation "${want}" is not a shape — valid: ${OpenAIAIManager.FORMATIONS.join(', ')}; this order marched unformed.)` };
        }
        const { slots, degenerate } = this.formationSlots(units, want);
        if (!slots) { units.forEach(u => { u.formationOffset = null; u.formationAxis = null; u.formationGroup = null; }); return { applied: false, note: '' }; }

        let cx = 0, cz = 0;
        units.forEach(u => { cx += u.x; cz += u.z; });
        cx /= units.length; cz /= units.length;
        let dx = tx - cx, dz = tz - cz;
        const d = Math.hypot(dx, dz);
        // Already standing on the destination: no direction to face, so no rotation to
        // apply. Point north rather than dividing by zero.
        if (d < 0.001) { dx = 0; dz = -1; } else { dx /= d; dz /= d; }
        // Right of the march direction.
        const rx = -dz, rz = dx;

        // One id for this body of troops, stamped on every member below. It is the
        // only thing that still says "these march together" once the order has been
        // given, and measureFormationLead needs it to know whose place a unit is out of.
        const gid = ++OpenAIAIManager._formationSeq;

        const offsets = new Map();
        units.forEach(u => {
            const s = slots.get(u) || { f: 0, r: 0 };
            offsets.set(u, { x: s.f * dx + s.r * rx, z: s.f * dz + s.r * rz });
            // The axis the lanes run along, so each unit can correct sideways into its
            // own lane immediately instead of drifting into it over the whole march.
            u.formationAxis = { x: dx, z: dz };
            u.formationGroup = gid;
        });
        const extra = degenerate ? ` (${degenerate}, so it is a single rank)` : '';
        return { applied: true, shape: want, offsets,
                 note: ` Marching in ${want} formation${extra}, ${units.length} unit(s) abreast of the line of advance.` };
    }

    // Narrowest a rank may be before depth is traded away for frontage.
    static get FORMATION_MIN_WIDTH() { return 3; }

    applyMatchSpeed(units, matchSpeed) {
        const want = String(matchSpeed || '').trim();
        if (!units || !units.length) return { applied: false, note: '' };
        if (!want) {                                   // no request: release any prior hold
            units.forEach(u => { u.marchSpeed = null; });
            return { applied: false, note: '' };
        }
        if (want !== 'slowestUnit') {
            // SAY so. An unknown value that is quietly dropped hands back exactly the
            // reply a correct one would have produced minus one clause, and a model has
            // no way to tell "ignored" from "done" -- it reads the order as matched and
            // plans around an arrival that is not coming. The one thing it needs is the
            // spelling, so give it the spelling.
            units.forEach(u => { u.marchSpeed = null; });
            return { applied: false, bad: want,
                     note: ` (matchSpeed "${want}" is not a value — the only one is "slowestUnit"; this order was NOT speed-matched and the units will arrive strung out.)` };
        }
        let slow = null, setter = null;
        units.forEach(u => {
            const s = (u && u.speed) || 1.0;
            if (slow === null || s < slow) { slow = s; setter = u; }
        });
        if (slow === null) return { applied: false, note: '' };
        units.forEach(u => { u.marchSpeed = slow; });
        // Name the pace AND who set it. "Matched speed" alone leaves a model unable to
        // tell a held march from an ignored parameter, and unable to see that one
        // crossbowman is what its cavalry is waiting for.
        return { applied: true, speed: slow, setter,
                 note: ` Matched to the slowest: all marching at ${slow} (${(setter && setter.type) || 'unit'} pace) so they arrive together.` };
    }

    travelEtaSec(unit, tx, tz) {
        // The speed it will ACTUALLY walk at, override included -- an ETA quoted from the
        // natural speed of a unit being held to a slower pace is a number that will not
        // happen, and the reply is the only clock the model has.
        const g = this.game;
        const base = (g && g.moveSpeedOf) ? g.moveSpeedOf(unit) : ((unit && unit.speed) || 1.0);
        const sp = ((base || 1.0) * 3) || 3;
        const d = Math.hypot(((unit && unit.x) || 0) - tx, ((unit && unit.z) || 0) - tz);
        return Math.max(1, this.realSecs((d / sp) * 1000));
    }

    // fetch() with an abort timeout so unreachable endpoints fail fast
    async fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
        return OpenAIAIManager.fetchWithTimeout(url, options, timeoutMs);
    }

    static async fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
            return await fetch(url, { ...options, signal: ctrl.signal });
        } finally {
            clearTimeout(t);
        }
    }

    // ----------------------------------------------------------------
    // Flexible authentication for any OpenAI-compatible endpoint.
    // auth = { type: 'none'|'bearer'|'header'|'basic'|'oauth', ...creds }
    // ----------------------------------------------------------------
    static async buildAuthHeaders(auth, provider = 'openai') {
        const headers = { 'Content-Type': 'application/json' };
        const a = auth || { type: 'none' };

        // Resolve a single primary credential string from the common auth types.
        const primaryKey = async () => {
            if (a.type === 'bearer') return (a.key || '').trim();
            if (a.type === 'oauth') {
                let token = (a.accessToken || '').trim();
                if (!token && a.tokenUrl && a.clientId) token = await OpenAIAIManager.fetchOAuthToken(a);
                return token;
            }
            return '';
        };
        const applyCustomHeaders = () => {
            if (a.type === 'header') (a.headers || []).forEach(h => { if (h && h.name) headers[h.name] = h.value || ''; });
        };

        // Anthropic Messages API: key goes in x-api-key, plus version + browser-access.
        //
        // AND in Authorization, because "Anthropic dialect" is not the same thing as
        // "api.anthropic.com". Anthropic itself authenticates with x-api-key; every
        // local or proxied server that SPEAKS the dialect -- Unsloth Studio, OpenRouter,
        // LiteLLM -- authenticates with a bearer token, and this branch used to send
        // x-api-key only and return before the bearer case could run. Measured against
        // Unsloth's /v1/messages: x-api-key alone is a 401, on every turn, for the whole
        // match. Sending both costs one header and is ignored by whichever server does
        // not want it; sending one costs the seat.
        if (provider === 'anthropic') {
            headers['anthropic-version'] = '2023-06-01';
            headers['anthropic-dangerous-direct-browser-access'] = 'true';
            const key = await primaryKey();
            if (key) {
                headers['x-api-key'] = key;
                if (!headers['Authorization']) headers['Authorization'] = `Bearer ${key}`;
            }
            applyCustomHeaders();
            return headers;
        }

        // Google Gemini: key in x-goog-api-key header (works on generativelanguage API).
        if (provider === 'google') {
            const key = await primaryKey();
            if (key) headers['x-goog-api-key'] = key;
            applyCustomHeaders();
            return headers;
        }

        // OpenAI-compatible (OpenAI, vLLM, LM Studio, LiteLLM, Together, Groq,
        // OpenRouter, DeepSeek, …) and Ollama: standard bearer/basic/header/oauth.
        if (!a.type || a.type === 'none') return headers;
        if (a.type === 'bearer') {
            if (a.key) headers['Authorization'] = `Bearer ${a.key}`;
        } else if (a.type === 'basic') {
            const raw = `${a.username || ''}:${a.password || ''}`;
            headers['Authorization'] = 'Basic ' + (typeof btoa === 'function' ? btoa(raw) : raw);
        } else if (a.type === 'header') {
            applyCustomHeaders();
        } else if (a.type === 'oauth') {
            const token = await primaryKey();
            if (token) headers['Authorization'] = `Bearer ${token}`;
        }
        return headers;
    }

    // ----------------------------------------------------------------
    // Provider adapters — speak OpenAI, Anthropic, Ollama, and Google
    // natively so any major inference endpoint works without a proxy.
    // ----------------------------------------------------------------
    static stripSlash(u) { return (u || '').replace(/\/+$/, ''); }
    static ollamaRoot(endpoint) {
        return OpenAIAIManager.stripSlash(OpenAIAIManager.stripSlash(endpoint).replace(/\/(v1|api)$/i, ''));
    }
    static detectProvider(endpoint = '') {
        const e = endpoint.toLowerCase();
        if (e.includes('anthropic.com')) return 'anthropic';
        if (e.includes('generativelanguage.googleapis') || e.includes('/v1beta')) return 'google';
        if (/:11434(\/|$)/.test(e) || e.includes('/api/chat') || e.includes('ollama')) return 'ollama';
        return 'openai';
    }
    static resolveProvider(model) {
        const p = (model && model.provider) || 'auto';
        return p === 'auto' ? OpenAIAIManager.detectProvider((model && model.endpoint) || '') : p;
    }

    // What each provider applies when we send nothing, so the input can show the value
    // you would actually get instead of the word "provider's". These are the providers'
    // DOCUMENTED API defaults, not something probed — a specific model can differ, and an
    // Ollama Modelfile can override all three, which the hint says.
    //
    // null means there is no single honest number: real OpenAI has no top_k at all,
    // Anthropic applies no top_p/top_k unless asked, and Google's topK varies by model.
    // Those keep the generic placeholder rather than being given a number we would be
    // making up.
    static samplingDefaults(provider) {
        switch (provider) {
            case 'anthropic': return { temperature: '1', topP: null, topK: null };
            case 'ollama':    return { temperature: '0.8', topP: '0.9', topK: '40' };
            case 'google':    return { temperature: '1', topP: '0.95', topK: null };
            default:          return { temperature: '1', topP: '1', topK: null };
        }
    }

    // Extended thinking, which every provider spells differently and gates differently.
    // One stored field per model, read against the resolved provider, because a model
    // entry has exactly one provider — and a value left over from a different one is
    // ignored rather than sent as nonsense.
    //
    //   openai     reasoning_effort: minimal | low | medium | high
    //   anthropic  thinking: { type: 'enabled', budget_tokens: N }
    //   google     generationConfig.thinkingConfig: { thinkingBudget: N }  (0 off, -1 auto)
    //   ollama     think: true | false
    static reasoningFor(provider, raw) {
        if (raw === '' || raw == null) return null;
        const s = String(raw).trim().toLowerCase();
        if (provider === 'openai') {
            // Two different things share this branch. OpenAI's own reasoning models take
            // reasoning_effort; a Qwen served through vLLM or SGLang ignores that entirely
            // and gates thinking on chat_template_kwargs.enable_thinking. "openai-
            // compatible" is a wire format, not a single vendor, so the control offers
            // both and the value picks which one is sent.
            if (OpenAIAIManager.REASONING_EFFORTS.includes(s)) return { kind: 'effort', value: s };
            if (s === 'on' || s === 'true') return { kind: 'enableThinking', value: true };
            if (s === 'off' || s === 'false') return { kind: 'enableThinking', value: false };
            return null;
        }
        if (provider === 'ollama') {
            if (s === 'on' || s === 'true') return { kind: 'think', value: true };
            if (s === 'off' || s === 'false') return { kind: 'think', value: false };
            return null;
        }
        const n = parseInt(s, 10);
        if (!isFinite(n)) return null;
        // Google takes 0 to switch thinking off and -1 to let the model decide, so its
        // floor is different from Anthropic's, which has a documented 1024 minimum.
        if (provider === 'google') return { kind: 'budget', value: Math.max(-1, n) };
        return { kind: 'budget', value: Math.max(OpenAIAIManager.ANTHROPIC_MIN_THINKING, n) };
    }
    // Everything about a seat that changes how it played, and nothing that identifies or
    // authenticates it. A transcript is meant to be handed to someone else, so this is a
    // WHITELIST: a field is absent unless it was named here, which means a setting added
    // later is missing from the record rather than a credential leaking into it.
    //
    // Deliberately absent:
    //   auth      — keys, tokens, passwords, headers. Never, in any form.
    //   endpoint  — private hostnames and, for some providers, a key in the query string.
    //               "servedBy" below carries what a reader actually needs from it -- WHO
    //               served the seat -- without the host, the port or the path.
    //
    // extraBody is free-form text the user typed, which is exactly where a stray key ends
    // up, so its values are redacted by name rather than trusted.
    // Ask an endpoint who is serving it. Never throws and never blocks a match: a
    // match that cannot start because a probe timed out would be a recording feature
    // costing a measurement, which is the wrong way round.
    // ---- What can this endpoint actually do? --------------------------------
    //
    // Not inferred from the URL. detectProvider matches an address, which is a guess
    // that holds until somebody runs vLLM on a custom port behind a proxy, or next
    // month's server ships -- and a wrong guess here is a seat that answers in a
    // format we cannot read, reported to its owner as a broken model.
    //
    // So ASK, and remember. Every stack publishes what it can do; no two agree on
    // where, and none of them is OpenAI, which publishes nothing at all:
    //
    //   llama.cpp  GET /props            -> chat_template_caps AND the whole Jinja
    //                                       template. The richest of the three.
    //   SGLang     GET /get_server_info  -> tool_call_parser / reasoning_parser BY
    //                                       NAME. A null parser means tool calls come
    //                                       back as unparsed text -- an operator's
    //                                       misconfiguration we can see before a match
    //                                       rather than after a forfeited turn.
    //   vLLM       GET /version          -> only that it is vLLM. It exposes 25 routes
    //                                       and not one of them names its tool parser.
    //                                       What it does have is /v1/chat/completions
    //                                       /render, which returns the token ids of the
    //                                       prompt it WOULD build -- ground truth, and
    //                                       better than any self-description.
    //   Ollama     GET /api/version, then POST /api/show -> capabilities: [tools, ...]
    //
    // Never throws, never blocks. An unknown stack returns nulls and everything carries
    // on exactly as before -- the probe can only ever ADD knowledge, so a server we have
    // never seen degrades to today's behaviour instead of to an error.
    static async probeCapabilities(conn, timeoutMs = 5000) {
        const out = { stack: null, tools: null, parallelTools: null, toolParser: null,
                      reasoningControl: null, contextLength: null, probedAt: Date.now(), note: null };
        try {
            const raw = OpenAIAIManager.stripSlash((conn && conn.endpoint) || '');
            if (!raw) return out;
            const root = OpenAIAIManager.stripSlash(raw.replace(/\/(v1|api)$/i, ''));
            let headers = { 'Content-Type': 'application/json' };
            try {
                const auth = (conn && conn.auth) || (conn && conn.apiKey ? { type: 'bearer', key: conn.apiKey } : { type: 'none' });
                headers = await OpenAIAIManager.buildAuthHeaders(auth, 'openai');
            } catch (e) { /* an unauthenticated probe is still worth trying */ }

            const get = async (path, opts) => {
                try {
                    const r = await OpenAIAIManager.fetchWithTimeout(root + path,
                        Object.assign({ method: 'GET', headers }, opts || {}), timeoutMs);
                    if (!r || !r.ok) return null;
                    return await r.json();
                } catch (e) { return null; }
            };

            // What a template LETS you steer is not what a server accepts: a model whose
            // template has no reasoning_effort cannot be dialled down at any layer, and
            // knowing that up front is worth more than a sweep that discovers it slowly.
            const fromTemplate = (tpl) => {
                if (!tpl || typeof tpl !== 'string') return null;
                if (/reasoning_effort/.test(tpl)) return 'reasoning_effort';
                if (/enable_thinking/.test(tpl)) return 'enable_thinking';
                return null;
            };

            const props = await get('/props');
            if (props && props.chat_template_caps) {
                const c = props.chat_template_caps || {};
                out.stack = 'llama.cpp';
                out.tools = !!c.supports_tools && !!c.supports_tool_calls;
                out.parallelTools = !!c.supports_parallel_tool_calls;
                out.reasoningControl = fromTemplate(props.chat_template);
                const g = props.default_generation_settings || {};
                out.contextLength = g.n_ctx || null;
                out.note = out.tools ? null : 'template declares no tool support';
                return out;
            }

            const si = await get('/get_server_info');
            if (si && Object.prototype.hasOwnProperty.call(si, 'tool_call_parser')) {
                out.stack = 'sglang';
                out.toolParser = si.tool_call_parser || null;
                out.tools = !!si.tool_call_parser;
                out.parallelTools = out.tools ? null : false;   // not declared; unknown when on
                out.reasoningControl = si.reasoning_parser ? 'reasoning_effort' : null;
                out.contextLength = si.context_length || null;
                out.note = out.tools ? null
                    : 'no --tool-call-parser configured: tool calls will arrive as plain text';
                return out;
            }

            const ver = await get('/version');
            if (ver && ver.version) {
                out.stack = 'vllm';
                // It will not name its parser, but it does state the window, and a seat
                // configured past it overflows every turn for a reason nobody can see.
                const mods = await get('/v1/models');
                const first = mods && mods.data && mods.data[0];
                if (first && first.max_model_len) out.contextLength = first.max_model_len;
                // It will not say. Tools are assumed present because the OpenAI route is,
                // and the handshake settles it if it matters; the render route is noted
                // because it is how the template can be read when we need the truth.
                out.tools = null;
                out.note = 'vLLM names no tool parser; use /v1/chat/completions/render to read the prompt';
                return out;
            }

            const oll = await get('/api/version');
            if (oll && oll.version) {
                out.stack = 'ollama';
                try {
                    const r = await OpenAIAIManager.fetchWithTimeout(root + '/api/show',
                        { method: 'POST', headers, body: JSON.stringify({ model: (conn && conn.model) || '' }) }, timeoutMs);
                    const show = (r && r.ok) ? await r.json() : null;
                    const caps = (show && show.capabilities) || [];
                    out.tools = caps.length ? caps.indexOf('tools') >= 0 : null;
                    out.reasoningControl = caps.indexOf('thinking') >= 0 ? 'think' : null;
                } catch (e) { /* the version alone still identifies the stack */ }
                return out;
            }
        } catch (e) { /* a probe that fails tells us nothing, and that is allowed */ }
        return out;
    }

    static async probeServedBy(conn) {
        try {
            const prov = OpenAIAIManager.resolveProvider(conn);
            if (prov !== 'openai') return prov;   // the others name themselves
            const r = await OpenAIAIManager.testConnection(
                conn.endpoint, conn.auth || (conn.apiKey ? { type: 'bearer', key: conn.apiKey } : { type: 'none' }),
                prov, 6000);
            if (!r || !r.ok) return null;
            // Prefer the entry for the model this seat actually plays; fall back to the
            // endpoint-wide value. On an aggregator the two differ and the specific one
            // is the one worth keeping.
            const id = String(conn.model || '').replace(/^models\//, '');
            return (r.ownedById && r.ownedById[id]) || r.servedBy || null;
        } catch (e) { return null; }
    }

    static publicModelSettings(conn, slot, sharedPrompt, servedBy) {
        const out = {
            provider: OpenAIAIManager.resolveProvider(conn),
            // The protocol above is not the service: vLLM, llama.cpp, LM Studio,
            // OpenRouter and Groq all speak "openai". This is what the server calls
            // itself, so a result can be read as (model x stack) rather than as a
            // property of the model alone. null = the endpoint did not say.
            servedBy: servedBy || null,
            maxTokens: conn.maxTokens || null,
            contextBudget: conn.contextSize || null,
            minimizeTokens: !!conn.minimizeTokens,
            // Recorded because it changes what a number MEANS: a seat allowed to fall
            // back is scored on a softer contract than one that is not.
            toolFallback: !!conn.toolFallback,
            language: conn.language || 'en'
        };
        ['temperature', 'topP', 'topK', 'minP', 'presencePenalty', 'repetitionPenalty']
            .forEach(k => { if (conn[k] != null) out[k] = conn[k]; });
        if (conn.reasoning) out.reasoning = conn.reasoning;
        if (conn.extraBody) out.extraBody = OpenAIAIManager.redactSecrets(conn.extraBody);
        // Only when it DIFFERS from the shared template, which the match header carries
        // once. Every slot's systemPrompt is populated — it falls back to the template —
        // so storing it unconditionally would repeat several KB per seat and still not
        // say which seats were actually customised.
        //
        // The template itself is recorded because promptVersion cannot stand in for it:
        // that string is bumped when the BUILT-IN default changes, and says nothing about
        // a user who edited the prompt on the setup screen. Two matches can share a
        // version and have been given different instructions.
        const p = slot && slot.systemPrompt;
        if (p && p.trim() && p.trim() !== String(sharedPrompt || '').trim()) out.systemPrompt = p;
        return out;
    }

    // The model id as it may be PUBLISHED. Local backends take a file path where an
    // API takes a name, and a path carries the operator's username and folder layout
    // into a file meant to be handed to someone else — found in a published sample as
    // C:\\Users\\<name>\\ggufmodels\\Ornith-1.0-9B-Q8_0.gguf, 149 times over.
    //
    // Only the basename survives, which is the part that answers the question the id
    // exists to answer: WHICH model played. Nothing is redacted here — a reader still
    // gets a usable identifier, just not a tour of the machine.
    //
    // A slash alone is NOT a path: aggregator ids look like "anthropic/claude-opus-5"
    // and must survive untouched. The marks of a real path are a backslash, a leading
    // slash or tilde, or a drive letter.
    static publicModelId(id) {
        const s = String(id == null ? '' : id).trim();
        if (!s) return s;
        const looksLikePath = /\\/.test(s) || /^[~/]/.test(s) || /^[A-Za-z]:[\\/]/.test(s);
        if (!looksLikePath) return s;
        const base = s.split(/[\\/]/).filter(Boolean).pop();
        return base || s;
    }

    // Values under a key that looks like a credential are replaced, not dropped, so the
    // reader can see that something was set without being handed it.
    //
    // The name test alone caught "thinking_token_budget": 2000 — "token" as a unit
    // of measure, not as a password — and would equally have hidden max_tokens or
    // num_speculative_tokens. That cost is real: a transcript that redacts its own
    // sampling parameters cannot be reproduced from, which is most of what it is for.
    //
    // Exempting NUMBERS looked like the fix and was not. A self-hosted endpoint takes
    // whatever key its owner invents, and {"api_key": 12345678} — unquoted, so a JSON
    // number — is an entirely ordinary thing to type. "No credential is a number" is
    // false the moment the credential is chosen by the person writing the config.
    //
    // So the exemption is a WHITELIST of parameter names, the same principle as
    // publicModelSettings above: a name that is not listed here is redacted, which means
    // a parameter added later is missing from the record rather than a credential
    // leaking into it. Value type is not consulted at all — nothing about a value
    // distinguishes a budget from a key someone chose to make numeric.
    //
    // Names are compared with separators and case removed, so thinking_token_budget,
    // thinkingTokenBudget and thinking-token-budget are one entry.
    static get SAFE_PARAM_NAMES() {
        return new Set([
            'thinkingtokenbudget', 'tokenbudget', 'maxtokens', 'mintokens',
            'maxnewtokens', 'maxcompletiontokens', 'maxprompttokens',
            'numspeculativetokens', 'maxtokenstosample'
        ]);
    }

    static redactSecrets(obj) {
        const SECRET = /key|token|secret|password|passwd|auth|bearer|credential/i;
        const safe = (k) => OpenAIAIManager.SAFE_PARAM_NAMES.has(String(k).replace(/[^a-z0-9]/gi, '').toLowerCase());
        const walk = (v) => {
            if (!v || typeof v !== 'object') return v;
            if (Array.isArray(v)) return v.map(walk);
            const o = {};
            Object.keys(v).forEach(k => {
                o[k] = (SECRET.test(k) && !safe(k)) ? '[redacted]' : walk(v[k]);
            });
            return o;
        };
        return walk(obj);
    }

    static get REASONING_EFFORTS() { return ['minimal', 'low', 'medium', 'high']; }

    // How many plan steps a model may keep. Stated in the prompt AND enforced on the
    // way in from this one place, because a cap advertised as one number and applied as
    // another is the quiet kind of lie: the model would write the tenth step, be told
    // nothing, and read back a plan missing its ending.
    //
    // Raised 5 -> 10 on measurement, not taste. Across 2825 plans in seven matches the
    // length histogram piled up hard against the ceiling: 37.8% of ALL plans were
    // exactly five steps, and per model it was minimax 94% at the cap, deepseek 94%,
    // Sonnet 90%, grok 86% — while gpt-oss averaged 1.3 steps and never once reached
    // it. Weak planners decay smoothly and never touch the limit; strong ones sit on
    // it. One model was already returning 5.24 steps on average and being cut. That is
    // a cap that binds only the models whose planning is worth reading.
    //
    // The price, measured against real token counts rather than guessed: the plan is
    // echoed once per turn and is NOT stored in conversation history, so it does not
    // compound — about +86 prompt tokens on a median 15,913 (+0.5%) and +83 completion
    // tokens on a median 563 (+15%), roughly +1% of a match's tokens overall. The real
    // cost is latency, since completion is generated serially: about +1.7s a turn for a
    // mid-speed endpoint, which at a 30s round deadline moves ~1.5% of turns past it.
    // Those now surface honestly as missed rounds rather than as invented unreliability.
    static get PLAN_MAX_STEPS() { return 10; }

    // How many commands one reply may carry. The game does not stop while a model
    // thinks: the slowest seat in the last match sat 43s between turns, so its orders
    // landed on a board 43 seconds older than the one it read. A short queue lets a slow
    // seat express a whole beat of play — build, then assign, then scout — instead of
    // spending three stale turns on it.
    //
    // Three, not more, for two measured reasons. The commands run in ORDER against a
    // board that each one changes, and the model cannot see between them; 29% of every
    // error in the last match was already a resource or population gate, which is
    // exactly the class that compounds when you spend before you look. And the reply
    // stays cheap: an action object is 38 tokens against a mean reply of 811, so three
    // of them add about 9% output — nowhere near the cap that truncates a turn.
    static get MAX_COMMANDS_PER_TURN() { return 3; }

    // How long to wait for a closing statement: the SAME budget a move gets. The 60s
    // it used to be was a compromise from before the skip button existed — a spectator
    // had to sit out whatever it cost, so it was kept short. Now nobody is trapped by
    // it, and a seat that thinks for three minutes on every move has no reason to be
    // cut off after one when finally asked an open question. Nothing waits on the
    // answer either: the summary is already on screen and the recorder files a late
    // one in the right place.
    finalWordTimeoutMs() { return this.requestAbortMs(); }

    // Does this parsed object order anything? Every acceptance gate in the parser used
    // to ask for a truthy .action, which a reply carrying only a "commands" list does
    // not have — so the batched shape parsed perfectly and was then thrown away as a
    // no-action turn. One predicate, used at every gate, so the two shapes cannot drift
    // apart again.
    static ordersSomething(p) {
        if (!p || typeof p !== 'object') return false;
        if (p.action) return true;
        return Array.isArray(p.commands) && p.commands.length > 0;
    }

    // Keys the passthrough may not touch. Everything else is fair game — the point of the
    // escape hatch is the parameters this file does NOT model, and there will always be
    // more of those than it can chase. But these carry the conversation itself and the
    // routing, and overwriting one does not customise the request, it breaks it.
    static get EXTRA_BODY_PROTECTED() {
        return ['messages', 'contents', 'model', 'system', 'systemInstruction', 'stream'];
    }

    // Merge a user-supplied object into a built body. Shallow at the top level, one level
    // deep for plain objects, so {"options":{"repeat_penalty":1.1}} adds to Ollama's
    // options rather than replacing num_ctx and the rest along with it.
    static mergeExtraBody(body, extra) {
        if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return body;
        Object.keys(extra).forEach(k => {
            if (OpenAIAIManager.EXTRA_BODY_PROTECTED.includes(k)) return;
            const v = extra[k], cur = body[k];
            const plain = x => x && typeof x === 'object' && !Array.isArray(x);
            body[k] = (plain(v) && plain(cur)) ? Object.assign({}, cur, v) : v;
        });
        return body;
    }
    // A 429, or a body that says so in words. Some gateways answer 200-with-an-error or
    // dress a quota refusal as a 503, so the text is checked too — but only for phrases
    // that cannot mean anything else.
    static isRateLimited(status, errorText) {
        if (status === 429) return true;
        if (status !== 503 && status !== 500) return false;
        return /rate.?limit|too many requests|quota exceeded|overloaded/i.test(String(errorText || ''));
    }

    // How long to wait before the one retry. Retry-After is authoritative when the
    // server sends it (seconds, or an HTTP date), otherwise a short default. Clamped at
    // both ends: zero would just re-hit the limit, and a server asking for two minutes
    // must not park a seat past a round deadline it cannot see.
    static retryAfterMs(headers, fallbackMs) {
        let ms = fallbackMs;
        try {
            const raw = headers && typeof headers.get === 'function' ? headers.get('Retry-After') : null;
            if (raw != null && String(raw).trim() !== '') {
                const secs = Number(raw);
                if (isFinite(secs)) ms = secs * 1000;
                else { const when = Date.parse(String(raw)); if (isFinite(when)) ms = when - Date.now(); }
            }
        } catch (e) { /* header unreadable — use the fallback */ }
        if (!isFinite(ms) || ms < 250) ms = 250;
        return Math.min(ms, OpenAIAIManager.RATE_LIMIT_MAX_WAIT_MS);
    }
    static get RATE_LIMIT_MAX_WAIT_MS() { return 8000; }

    static get ANTHROPIC_MIN_THINKING() { return 1024; }

    // Anthropic requires max_tokens to EXCEED the thinking budget, and the budget to be
    // at least 1024 — so a small reply cap makes thinking impossible rather than merely
    // cramped. Returns the budget to send, or null when the two settings cannot both be
    // honoured. The UI warns about the same condition; this is the backstop that stops a
    // request we already know will 400.
    static anthropicThinkingBudget(budget, maxTokens) {
        const room = (maxTokens || 0) - 1;
        const b = Math.min(budget, room);
        return b >= OpenAIAIManager.ANTHROPIC_MIN_THINKING ? b : null;
    }

    // Some endpoints REJECT a parameter rather than ignoring it, and say which in the
    // 400. OpenAI's reasoning models are the live case: they refuse max_tokens and want
    // max_completion_tokens, and refuse any temperature but the default. A model pointed
    // at one of those failed every single turn — total failure, not degraded play.
    //
    // Matched on the endpoint's own words, not on the model id. Gateways and Azure
    // deployments proxy these models under arbitrary names, so a name pattern would miss
    // exactly the setups people actually run, and would also mislabel an innocent model
    // called "o3-custom" on a server that is perfectly happy with max_tokens. The cost is
    // one rejected request the first time; the flag is then remembered for the match.
    //
    // Returns the flags to ADD, or null when the error is not one we know how to fix —
    // in which case it must surface unchanged rather than be retried blindly.
    // {} in the normal case, so spreading it adds nothing to the record. An object
    // rather than a value because the field should be ABSENT when there is nothing to
    // say, not present and null on every one of thousands of rows.
    static emptyReplyRaw(norm, usage, data) {
        try {
            const c = (norm && norm.content) || '', r = (norm && norm.reasoning) || '';
            if (c.trim() || r.trim()) return {};
            const out = (usage && usage.completion) || 0;
            if (!out) return {};   // nothing generated either: that is a real empty turn
            const ch = (data && Array.isArray(data.choices)) ? data.choices[0] : null;
            return { emptyRaw: ch
                ? JSON.stringify(ch).slice(0, 1200)
                : 'no choices[]; top-level keys: ' + Object.keys(data || {}).join(',') };
        } catch (e) { return {}; }
    }

    static adaptToApiError(opts, errorText, model) {
        const e = String(errorText || '');
        const add = {};
        // The three non-OpenAI parameters, same send-then-learn rule as top_k below:
        // they go out because most LOCAL endpoints take them, and the first endpoint
        // that says no gets them dropped for the rest of the match. Without this a
        // single filled-in field would cost every turn of a match against a hosted
        // provider, which is the failure the whole mechanism exists to prevent.
        [['omitMinP', /min_p|minP/i],
         ['omitPresencePenalty', /presence_penalty/i],
         ['omitRepetitionPenalty', /repetition_penalty/i]].forEach(([flag, re]) => {
            if (!opts[flag] && re.test(e)
                && /unsupported|not support|unrecognized|unknown|extra|not permitted|is not supported|must be/i.test(e)) {
                add[flag] = true;
            }
        });
        if (!opts.useMaxCompletionTokens && /max_completion_tokens/i.test(e)) {
            add.useMaxCompletionTokens = true;
        }
        // Only when the complaint is ABOUT temperature — "unsupported value", "does not
        // support", "only the default (1)". A 400 that merely mentions the word while
        // objecting to something else must not silently drop a setting the user chose.
        if (!opts.omitTemperature && /temperature/i.test(e)
            && /unsupported|not support|only the default|must be|is not supported/i.test(e)) {
            add.omitTemperature = true;
        }
        // Same family of model refuses top_p as well. Without this, exposing top_p would
        // hand back the exact failure adaptToApiError was written to end.
        if (!opts.omitTopP && /top_p|topP/i.test(e)
            && /unsupported|not support|only the default|must be|is not supported/i.test(e)) {
            add.omitTopP = true;
        }
        // Real OpenAI answers "Unrecognized request argument supplied: top_k".
        if (!opts.omitTopK && /top_k|topK/i.test(e)
            && /unsupported|not support|unrecognized|unknown|extra|not permitted|is not supported/i.test(e)) {
            add.omitTopK = true;
        }
        // A non-reasoning model refuses the thinking parameter outright. Same rule:
        // stop sending it, say so in the library, do not guess from the model name.
        if (!opts.omitReasoning && /reasoning_effort|thinkingConfig|thinkingBudget|chat_template_kwargs|enable_thinking|\bthinking\b|\bthink\b/i.test(e)
            && /unsupported|not support|unrecognized|unknown|extra|not permitted|is not supported|invalid/i.test(e)) {
            add.omitReasoning = true;
        }
        // A model that cannot take tools AT ALL is not a parameter to drop, it is a
        // different contract: Ollama answers "<model> does not support tools" and
        // refuses the request outright, so the model never even loads. Dropping the
        // tools array is only survivable when the seat is allowed to answer in raw
        // JSON -- without that it would act with no channel at all and forfeit every
        // turn in silence, which is strictly worse than a visible error. So the switch
        // is thrown only for a fallback seat; for the others the error carries the
        // hint (see hintForApiError) naming the setting that would make it playable.
        if (!opts.omitTools && model && model.toolFallback
            && /\btools?\b/i.test(e)
            && /does not support|not supported|unsupported|does not accept/i.test(e)) {
            add.omitTools = true;
        }
        return Object.keys(add).length ? add : null;
    }

    // Turn an endpoint's refusal into an instruction the OPERATOR can act on. The raw
    // body is kept verbatim in front of it -- this only appends the missing half, which
    // is which switch in the model library answers that particular complaint.
    static hintForApiError(errorText, model) {
        const e = String(errorText || '');
        if (/\btools?\b/i.test(e) && /does not support|not supported|unsupported|does not accept/i.test(e)) {
            // Only worth saying when the operator can still act on it. With the flag
            // already set this same 400 is adapted away instead of thrown, so the
            // remaining case is always the one that needs the switch thrown.
            if (!(model && model.toolFallback)) {
                return 'no tool support -- enable "Tool fallback" for this model.';
            }
        }
        return '';
    }

    // Build {url, body} for one chat turn. `turns` is the user/assistant history
    // (no system message); the system prompt is passed separately.
    static buildChatRequest(provider, endpoint, modelId, systemPrompt, turns, opts = {}) {
        const built = OpenAIAIManager._buildChatRequest(provider, endpoint, modelId, systemPrompt, turns, opts);
        // Last word to the passthrough, so it can correct anything modelled above it.
        OpenAIAIManager.mergeExtraBody(built.body, opts.extraBody);
        return built;
    }

    static _buildChatRequest(provider, endpoint, modelId, systemPrompt, turns, opts = {}) {
        // Left undefined when unset so each branch can OMIT it. Sending a hard-coded 0.7
        // for every model was the old behaviour and it silently overrode whatever default
        // the provider had chosen for that model.
        const temperature = opts.temperature != null ? Number(opts.temperature) : undefined;
        const topP = opts.topP != null ? Number(opts.topP) : undefined;
        const topK = opts.topK != null ? Number(opts.topK) : undefined;
        const minP = opts.minP != null ? Number(opts.minP) : undefined;
        const presencePenalty = opts.presencePenalty != null ? Number(opts.presencePenalty) : undefined;
        const repetitionPenalty = opts.repetitionPenalty != null ? Number(opts.repetitionPenalty) : undefined;
        const maxTokens = opts.maxTokens != null ? opts.maxTokens : 2000;
        const model = modelId || 'default';
        // Only ever add a key we actually have a value for.
        const put = (obj, key, val) => { if (val !== undefined && !Number.isNaN(val)) obj[key] = val; return obj; };
        const reasoning = opts.omitReasoning ? null : OpenAIAIManager.reasoningFor(provider, opts.reasoning);
        // Anthropic forbids temperature, top_p and top_k while extended thinking is on.
        // Suppressed here rather than left to 400, and the library says so on the card so
        // it does not look like the settings were quietly ignored.
        const thinkingSuppressesSampling = (provider === 'anthropic' && reasoning && reasoning.kind === 'budget');

        if (provider === 'anthropic') {
            return {
                url: OpenAIAIManager.stripSlash(endpoint) + '/messages',
                body: (() => {
                    const b = {
                        model, max_tokens: maxTokens,
                        system: systemPrompt,
                        // Anthropic carries tool results as a tool_result BLOCK inside a
                        // user message, not as its own role. That dialect is not written
                        // here because it cannot be tested from this machine, and an
                        // unverified wire format in a benchmark is worse than an honest
                        // older one — so the turns are flattened to the prose form every
                        // provider was served before the tool channel existed. Worth
                        // noting the gap is smaller than it looks: Anthropic's results
                        // ARE user-turn content, so prose-in-a-user-turn is already close
                        // to native for it, and OpenAI-style was the one being mistreated.
                        messages: OpenAIAIManager.toolTurnsForAnthropic(turns)
                    };
                    if (!opts.omitTools) b.tools = OpenAIAIManager.toolsFor('anthropic');
                    if (thinkingSuppressesSampling) {
                        const budget = OpenAIAIManager.anthropicThinkingBudget(reasoning.value, maxTokens);
                        if (budget != null) { b.thinking = { type: 'enabled', budget_tokens: budget }; return b; }
                        // No room for a legal budget: send an ordinary request rather than
                        // one that is certain to be rejected, and let the sampling through.
                    }
                    put(b, 'temperature', opts.omitTemperature ? undefined : temperature);
                    put(b, 'top_p', opts.omitTopP ? undefined : topP);
                    put(b, 'top_k', opts.omitTopK ? undefined : topK);
                    return b;
                })()
            };
        }
        if (provider === 'ollama') {
            return {
                url: OpenAIAIManager.ollamaRoot(endpoint) + '/api/chat',
                body: {
                    model, stream: false,
                    ...(opts.omitTools ? {} : { tools: OpenAIAIManager.toolsFor('ollama') }),
                    ...(reasoning && reasoning.kind === 'think' ? { think: reasoning.value } : {}),
                    keep_alive: -1, // never auto-unload: the arena drives the model continuously
                    // Cap the context to a user-configurable size (default 32768).
                    // Ollama otherwise loads the model's FULL context (e.g. 128k for
                    // llama3.2), whose KV cache bloats VRAM and spills the model onto
                    // the CPU — making every turn crawl and time out. Lower this on
                    // smaller GPUs; raise it if your game state is large and you have
                    // the VRAM.
                    // Ollama spells the third one repeat_penalty, not repetition_penalty.
                    // Built by hand rather than by nesting six put() calls, which was
                    // already hard to read at three.
                    options: (() => {
                        const o = { num_predict: maxTokens,
                                    num_ctx: (opts.numCtx && opts.numCtx > 0) ? opts.numCtx : 32768 };
                        put(o, 'temperature', opts.omitTemperature ? undefined : temperature);
                        put(o, 'top_p', opts.omitTopP ? undefined : topP);
                        put(o, 'top_k', topK);
                        put(o, 'min_p', minP);
                        put(o, 'presence_penalty', presencePenalty);
                        put(o, 'repeat_penalty', repetitionPenalty);
                        return o;
                    })(),
                    // Ollama's native chat API takes the same role:"tool" message the
                    // OpenAI route does, so the same renderer serves both.
                    messages: [{ role: 'system', content: systemPrompt },
                               ...OpenAIAIManager.toolTurnsForOpenAI(turns, true)]
                }
            };
        }
        if (provider === 'google') {
            return {
                url: OpenAIAIManager.stripSlash(endpoint) + `/models/${encodeURIComponent(model)}:generateContent`,
                body: {
                    ...(opts.omitTools ? {} : { tools: OpenAIAIManager.toolsFor('google') }),
                    systemInstruction: { parts: [{ text: systemPrompt }] },
                    // Google wants functionCall/functionResponse parts. Not written here
                    // for the same reason as Anthropic above: untestable from this
                    // machine, so it keeps the prose form rather than an unverified one.
                    contents: OpenAIAIManager.flattenToolTurns(turns)
                        .map(t => ({ role: t.role === 'assistant' ? 'model' : 'user', parts: [{ text: String(t.content) }] })),
                    generationConfig: (() => {
                        const g = put(put(put({ maxOutputTokens: maxTokens },
                            'temperature', opts.omitTemperature ? undefined : temperature),
                            'topP', opts.omitTopP ? undefined : topP), 'topK', topK);
                        if (reasoning && reasoning.kind === 'budget') g.thinkingConfig = { thinkingBudget: reasoning.value };
                        return g;
                    })()
                }
            };
        }
        // openai-compatible (default). This is the path that reaches llama.cpp, vLLM,
        // SGLang, LM Studio, OpenRouter and everything behind it — which is to say very
        // nearly everything — so it is the one that gets the protocol properly.
        const body = {
            model,
            messages: [{ role: 'system', content: systemPrompt },
                       ...OpenAIAIManager.toolTurnsForOpenAI(turns)]
        };
        // Reasoning models on the real OpenAI API rename the reply cap and refuse any
        // temperature but the default. Both flags are set by adaptToApiError after the
        // endpoint has said so itself, never guessed from the model name.
        body[opts.useMaxCompletionTokens ? 'max_completion_tokens' : 'max_tokens'] = maxTokens;
        if (!opts.omitTemperature) put(body, 'temperature', temperature);
        if (!opts.omitTopP) put(body, 'top_p', topP);
        // "openai-compatible" is not only OpenAI. vLLM, Groq, LM Studio, LiteLLM and
        // OpenRouter all accept top_k here and are a large part of who runs this; real
        // OpenAI is the one that does not. So it goes out by default and adaptToApiError
        // drops it for that endpoint the first time it is refused — the same
        // send-then-learn rule the rest of this file uses, rather than punishing every
        // local gateway for one provider's omission.
        if (!opts.omitTopK) put(body, 'top_k', topK);
        // Extensions rather than OpenAI parameters: vLLM, llama.cpp, LM Studio and
        // OpenRouter accept them, the hosted majors do not. put() drops an undefined,
        // so an untouched field costs a seat nothing -- and if an endpoint does refuse
        // one, adaptToApiError below learns it from the reply, exactly like top_k.
        if (!opts.omitMinP) put(body, 'min_p', minP);
        if (!opts.omitPresencePenalty) put(body, 'presence_penalty', presencePenalty);
        if (!opts.omitRepetitionPenalty) put(body, 'repetition_penalty', repetitionPenalty);
        // The tool surface goes out on every request. Not a toggle: a seat that cannot
        // work them is a finding, and hiding the contract would hide the finding. The
        // parse side decides what to do when nothing comes back.
        if (!opts.omitTools) {
            body.tools = OpenAIAIManager.TOOLS;
            body.tool_choice = 'auto';
        }
        if (reasoning && reasoning.kind === 'effort') body.reasoning_effort = reasoning.value;
        // Qwen and friends. Merged rather than assigned: a raw extra body may also carry
        // chat_template_kwargs, and clobbering it would lose whatever else was in there.
        if (reasoning && reasoning.kind === 'enableThinking') {
            body.chat_template_kwargs = Object.assign({}, body.chat_template_kwargs,
                { enable_thinking: reasoning.value });
        }
        // If this "OpenAI-compatible" endpoint is actually an Ollama server (user
        // pointed at :11434 / picked OpenAI-compat), ask it to keep the model
        // resident so it isn't unloaded between turns. Only do this for detected
        // Ollama hosts — real OpenAI (and stricter gateways) reject unknown params.
        if (OpenAIAIManager.detectProvider(endpoint) === 'ollama') body.keep_alive = -1;
        return {
            url: OpenAIAIManager.stripSlash(endpoint) + '/chat/completions',
            body
        };
    }

    // Normalize any provider's response to { content, reasoning, tool_calls, finish_reason }.
    static normalizeResponse(provider, data) {
        if (provider === 'anthropic') {
            const blocks = Array.isArray(data.content) ? data.content : [];
            return {
                content: blocks.filter(b => b.type === 'text').map(b => b.text).join('\n'),
                reasoning: blocks.filter(b => b.type === 'thinking').map(b => b.thinking || '').join('\n'),
                tool_calls: OpenAIAIManager.toolCallsFrom('anthropic', data),
                finish_reason: data.stop_reason
            };
        }
        if (provider === 'ollama') {
            const msg = data.message || {};
            return { content: msg.content, reasoning: msg.thinking, tool_calls: msg.tool_calls, finish_reason: data.done_reason };
        }
        if (provider === 'google') {
            const cand = (data.candidates || [])[0];
            const parts = (cand && cand.content && cand.content.parts) || [];
            return { content: parts.map(p => p.text || '').join(''), reasoning: null,
                     tool_calls: OpenAIAIManager.toolCallsFrom('google', data),
                     finish_reason: cand && cand.finishReason };
        }
        const message = (data.choices && data.choices[0] && data.choices[0].message) || {};
        // Two spellings, and only one of them was read. OpenRouter and some gateways
        // say "reasoning"; llama.cpp and vLLM say "reasoning_content" — the OpenAI
        // convention their reasoning parsers follow. Reading only the first meant a
        // llama.cpp seat recorded reasoning 0 on every turn while the server was
        // faithfully sending thousands of characters of it, and the loss looked like
        // a server fault worth chasing rather than a field name worth reading.
        return { content: message.content,
                 reasoning: message.reasoning || message.reasoning_content,
                 tool_calls: message.tool_calls,
                 finish_reason: data.choices && data.choices[0] && data.choices[0].finish_reason };
    }

    // "The reply hit the output cap", spelled differently by every provider:
    // OpenAI and Ollama say "length", Anthropic "max_tokens", Google "MAX_TOKENS".
    // Matching only "length" (as the first cut of this check did) silently misses
    // two of the four and reports their truncations as ordinary malformed JSON.
    static hitTokenCap(finishReason) {
        return /^(length|max_tokens)$/i.test(String(finishReason || ''));
    }

    // The provider's OWN usage object, verbatim. extractUsage reduces it to a
    // prompt/completion pair, which drops reasoning-token accounting and anything
    // provider-specific — exactly the fields wanted when a reply stops far short of
    // the cap that was asked for.
    static rawUsage(provider, data) {
        if (!data) return null;
        if (provider === 'ollama') {
            const { prompt_eval_count, eval_count, done_reason } = data;
            return (prompt_eval_count != null || eval_count != null)
                ? { prompt_eval_count, eval_count, done_reason } : null;
        }
        return data.usage || data.usageMetadata || null;
    }

    // Pull token usage out of a provider response (field names differ everywhere).
    // Returns { prompt, completion } or null when the provider didn't report usage.
    static extractUsage(provider, data) {
        try {
            if (provider === 'anthropic' && data.usage) {
                return { prompt: data.usage.input_tokens || 0, completion: data.usage.output_tokens || 0 };
            }
            if (provider === 'ollama') {
                if (data.prompt_eval_count != null || data.eval_count != null) {
                    return { prompt: data.prompt_eval_count || 0, completion: data.eval_count || 0 };
                }
                return null;
            }
            if (provider === 'google' && data.usageMetadata) {
                return { prompt: data.usageMetadata.promptTokenCount || 0, completion: data.usageMetadata.candidatesTokenCount || 0 };
            }
            if (data.usage) { // openai-compatible
                return { prompt: data.usage.prompt_tokens || 0, completion: data.usage.completion_tokens || 0 };
            }
        } catch (e) {}
        return null;
    }

    // OAuth2 client-credentials grant. Token is cached on the auth object.
    static async fetchOAuthToken(auth) {
        const now = Date.now();
        if (auth._token && auth._tokenExp && now < auth._tokenExp) return auth._token;
        const body = new URLSearchParams();
        body.set('grant_type', 'client_credentials');
        body.set('client_id', auth.clientId || '');
        if (auth.clientSecret) body.set('client_secret', auth.clientSecret);
        if (auth.scope) body.set('scope', auth.scope);
        const resp = await OpenAIAIManager.fetchWithTimeout(auth.tokenUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body
        }, 8000);
        if (!resp.ok) throw new Error(`OAuth token request failed (HTTP ${resp.status})`);
        const data = await resp.json();
        if (!data.access_token) throw new Error('OAuth response had no access_token');
        auth._token = data.access_token;
        auth._tokenExp = now + ((data.expires_in || 3600) - 60) * 1000;
        return auth._token;
    }

    // Probe an endpoint: returns { ok, models:[], error }. Used by the setup UI's
    // "Test connection" button so beginners can verify auth and pick a model.
    // Failures return { ok:false, errorCode, errorDetail?, error } — errorCode maps
    // to an ar.err.* i18n key so the UI shows the message in the active GUI language
    // (these used to be hardcoded German regardless of language); `error` stays an
    // English fallback for logs/non-UI callers.
    static async testConnection(endpoint, auth, provider = 'auto', timeoutMs = 9000) {
        if (!endpoint) return { ok: false, errorCode: 'noEndpoint', error: 'No endpoint URL set.' };
        const prov = provider === 'auto' ? OpenAIAIManager.detectProvider(endpoint) : provider;
        let headers;
        try {
            headers = await OpenAIAIManager.buildAuthHeaders(auth, prov);
        } catch (e) {
            const detail = (e && e.message) || String(e);
            return { ok: false, errorCode: 'authFailed', errorDetail: detail, error: 'Authentication failed: ' + detail };
        }
        // Each provider lists models from a different path.
        const url = prov === 'ollama'
            ? OpenAIAIManager.ollamaRoot(endpoint) + '/api/tags'
            : OpenAIAIManager.stripSlash(endpoint) + '/models';
        try {
            const resp = await OpenAIAIManager.fetchWithTimeout(url, { headers, mode: 'cors' }, timeoutMs);
            if (!resp.ok) {
                const detail = `${resp.status} ${resp.statusText || ''}`.trim();
                const code = (resp.status === 401 || resp.status === 403) ? 'httpAuth' : 'http';
                return { ok: false, errorCode: code, errorDetail: detail, error: 'HTTP ' + detail, provider: prov };
            }
            const data = await resp.json();
            let models;
            const contextById = {};
            const ownedById = {};
            if (prov === 'ollama') {
                models = (data.models || []).map(m => m.name || m.model).filter(Boolean);
                // /api/tags doesn't carry context length; the ↺ button does /api/show.
            } else {
                const list = data.data || data.models || [];
                models = list.map(m => (typeof m === 'string' ? m : (m.id || m.name))).filter(Boolean)
                    .map(id => id.replace(/^models\//, '')); // strip Google's "models/" prefix
                // Capture each model's context window when the endpoint reports it
                // (field name varies: OpenRouter/vLLM/LM Studio/Google all differ).
                list.forEach(m => {
                    if (!m || typeof m !== 'object') return;
                    const id = String(m.id || m.name || '').replace(/^models\//, '');
                    // llama.cpp nests it: {"id":…,"owned_by":"llamacpp","meta":{"n_ctx":64000,
                    // "n_ctx_train":262144}}. Every path below was a TOP-LEVEL one, so a
                    // llama.cpp model reported nothing at all -- contextById stayed empty,
                    // maxContext stayed null, hardMax became Infinity, and the one guard
                    // that clamps a hand-set budget to what the server can actually serve
                    // was absent on exactly the endpoints most likely to be mis-set.
                    //
                    // meta.n_ctx is already PER SLOT: a server started with 128k and
                    // --parallel 2 reports 64000 here, not 128000. So nothing needs
                    // dividing, and /slots or /props would only re-fetch this same number.
                    //
                    // n_ctx_train is deliberately NOT a fallback. That is what the model
                    // was TRAINED to handle (262144 for this one), not what this server
                    // allocated -- taking it as the ceiling would license a budget four
                    // times larger than the slot, which is worse than having no ceiling.
                    const ctx = m.context_length || m.max_model_len || m.context_window ||
                                m.max_context_length || m.n_ctx || m.inputTokenLimit ||
                                (m.meta && m.meta.n_ctx) ||
                                (m.limits && (m.limits.context_length || m.limits.max_context_tokens));
                    if (id && ctx && Number(ctx) >= 512) contextById[id] = Number(ctx);
                    // WHO is serving, not which protocol it speaks. The list was already
                    // being walked for the context window; this field sits right beside it.
                    if (id && typeof m.owned_by === 'string' && m.owned_by.trim()) {
                        ownedById[id] = m.owned_by.trim();
                    }
                });
            }
            // One value for the whole endpoint when every model agrees, which is the
            // normal case for a local server. A gateway serving many vendors disagrees,
            // and then the per-model map is the honest answer and the summary stays null.
            const eigner = Object.values(ownedById);
            const einig = eigner.length && eigner.every(x => x === eigner[0]) ? eigner[0] : null;
            // Anthropic and Google ARE the service; Ollama speaks its own protocol and is
            // already distinguishable. Only the openai-compatible crowd needs asking.
            const servedBy = (prov === 'openai') ? einig : prov;
            return { ok: true, models, provider: prov, contextById, ownedById, servedBy };
        } catch (e) {
            if (e && e.name === 'AbortError') {
                return { ok: false, errorCode: 'timeout', error: 'Timed out — endpoint unreachable.', provider: prov };
            }
            const detail = (e && e.message) || String(e);
            // fetch() reports CORS rejection, connection refused, DNS failure and a
            // dropped tunnel as the SAME opaque "Failed to fetch" — deliberately, so
            // a page cannot probe the network by reading error types. That left this
            // message guessing out loud ("CORS? Endpoint offline?") and sent people
            // hunting for CORS problems they did not have.
            //
            // A no-cors request cannot be rejected BY cors: the browser returns an
            // opaque response instead. So if this second attempt resolves, the server
            // answered and the first failure was the CORS policy; if it throws too,
            // nothing is listening. It is a simple GET with no custom headers, so it
            // says nothing about whether the KEY is right — only whether the host is
            // there.
            let reachable = false;
            try {
                await OpenAIAIManager.fetchWithTimeout(url, { mode: 'no-cors' }, 4000);
                reachable = true;
            } catch (_) { /* genuinely unreachable */ }
            return reachable
                ? { ok: false, errorCode: 'cors', errorDetail: detail, provider: prov,
                    error: 'The endpoint answered but the browser blocked the response (CORS).' }
                : { ok: false, errorCode: 'offline', errorDetail: detail, provider: prov,
                    error: 'No response from the endpoint — it is not reachable.' };
        }
    }

    // Best-effort fallback table of known context windows, keyed by id substring.
    // Used when an endpoint doesn't report a model's context length.
    static knownContextWindow(modelId, provider) {
        const id = (modelId || '').toLowerCase();
        const tbl = [
            [/claude/, 200000],
            [/gpt-4o|gpt-4\.1|gpt-4-turbo|gpt-4-(?:1106|0125|0613-preview)|o1|o3|o4/, 128000],
            [/gpt-4/, 8192],
            [/gpt-3\.5/, 16385],
            [/gemini-1\.5|gemini-2|gemini-exp/, 1000000],
            [/gemini/, 32768],
            [/llama-?3|llama3/, 8192],
            [/mixtral|mistral/, 32768],
            [/qwen/, 32768],
            [/phi/, 16384],
            [/deepseek/, 65536]
        ];
        for (const [re, v] of tbl) if (re.test(id)) return v;
        if (provider === 'anthropic') return 200000; // all current Claude models
        return null;
    }

    // Ask an Ollama server for a model's trained context length (/api/show).
    static async fetchOllamaContext(endpoint, model, auth) {
        try {
            const headers = await OpenAIAIManager.buildAuthHeaders(auth || { type: 'none' }, 'ollama');
            const resp = await OpenAIAIManager.fetchWithTimeout(
                OpenAIAIManager.ollamaRoot(endpoint) + '/api/show',
                { method: 'POST', headers, mode: 'cors', body: JSON.stringify({ name: model }) }, 8000);
            if (!resp.ok) return null;
            const d = await resp.json();
            const mi = d.model_info || {};
            for (const k in mi) { if (/\.context_length$/.test(k) && Number(mi[k]) >= 512) return Number(mi[k]); }
            return null;
        } catch (e) { return null; }
    }

    // ----------------------------------------------------------------
    // 2. Initialize from setup (per-player config; used by Arena AND Campaign)
    // ----------------------------------------------------------------
    // (The legacy models.json round-robin path — loadModels/initAndAssign/
    //  assignModelsToAIPlayers — became unreachable once Campaign switched to
    //  explicit per-opponent configs and was removed.)
    async initFromSetup(setup) {
        this.aiControllers = [];

        // Read the round mode from the saved arena config. A manager is built fresh per
        // match, so the flag has to be pulled in here or every new match silently
        // reverts to independent pipelines — which is a different benchmark.
        this.turnBased = !!(this.game && this.game.ui && this.game.ui.turnBasedEnabled
            && this.game.ui.turnBasedEnabled());
        this._roundTimeoutMs = (this.game && this.game.ui && this.game.ui.roundTimeoutMs)
            ? this.game.ui.roundTimeoutMs() : OpenAIAIManager.ROUND_TIMEOUT_DEFAULT_MS;
        this._roundPhase = 'ask';
        this._roundNo = 0;
        this._roundStartedAt = 0;
        this._roundEndedAt = 0;

        // Two seats on the same model share a display name, so it is suffixed #1/#2.
        // This used to run AFTER the controllers were built, ~120 lines below — by which
        // time the transcript header had already been written with the raw names. The
        // file then contradicted itself: a results block ranking "gpt-oss #1" and "#2"
        // over a header listing "gpt-oss" twice, so every reader of the header saw two
        // seats wearing one name. Named once, here, ahead of both — and outside the
        // recorder's guard, so it cannot go stale from a previous match.
        const displayName = i => {
            const c = setup[i].connection;
            return c ? (c.name || c.model || `Player ${i + 1}`) : `Player ${i + 1}`;
        };
        const nameTally = {};
        setup.forEach((s2, i) => { const n = displayName(i); nameTally[n] = (nameTally[n] || 0) + 1; });
        const nameSeen = {};
        this._seatNames = setup.map((s2, i) => {
            const n = displayName(i);
            if (nameTally[n] < 2) return n;
            nameSeen[n] = (nameSeen[n] || 0) + 1;
            return `${n} #${nameSeen[n]}`;
        });
        // Transcript recording, always on. begin() purges whatever the previous match
        // left behind, so a crash or a "Hauptmenü" reload (which cannot be relied on to
        // finish an async delete during unload) still yields a clean slate here.
        if (typeof TranscriptRecorder !== 'undefined') {
            this.transcripts = this.transcripts || new TranscriptRecorder();
            const stamp = new Date();
            const pad = n => String(n).padStart(2, '0');
            const matchId = `match-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}`
                + `-${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}`;
            const sharedPrompt = (this.game.ui && this.game.ui._arenaConfig
                && this.game.ui._arenaConfig.prompt) || null;
            // Asked once per seat, all at the same time, before the header is written.
            // Six seconds worst case for the whole match, and a failure is a null.
            const bedient = await Promise.all(setup.map(s => s.connection
                ? OpenAIAIManager.probeServedBy(s.connection) : Promise.resolve(null)));
            await this.transcripts.begin(matchId, setup.map((s, i) => {
                const ai = this.game.aiManager.aiPlayers[i];
                const c = s.connection;
                return {
                    id: ai && ai.id, civilization: s.civ, seat: ai && ai.seat,
                    // The model ID as configured, and NOTHING else. It used to fall back
                    // to the display name, so a seat with no id recorded "RTX ornith:9b"
                    // in a field called model while the request had actually said
                    // "default" and let the endpoint choose — a reader would take the
                    // nickname for an id. With an aggregator in front (OpenRouter,
                    // Ollama, LiteLLM) the id is the only thing that says WHICH of
                    // hundreds of models played, so it must not be guessable-looking
                    // when it is absent. null means none was configured.
                    model: c ? (OpenAIAIManager.publicModelId(c.model) || null) : 'ki',
                    // The name the results block will use, so the two agree.
                    name: c ? this._seatNames[i] : null,
                    settings: c ? OpenAIAIManager.publicModelSettings(c, s, sharedPrompt, bedient[i]) : null
                };
            }), {
                systemPrompt: sharedPrompt,
                // The conditions a result has to be read against. Two runs with
                // different values here are not comparable, and six months from now
                // this line is the only thing that will say which was which.
                mapSeed: (this.game.terrain && this.game.terrain.seed) || null,
                difficulty: this.game.difficulty || null,
                mapSize: (this.game.terrain && this.game.terrain.size) || null,
                turnBased: !!this.turnBased,
                roundTimeoutMs: this.turnBased ? this.roundTimeoutMs() : null,
                simSpeed: this.game.simSpeed || 1,
                wonderRequired: this.game.wonderRequired || null,
                promptVersion: (this.game.ui && this.game.ui.ARENA_PROMPT_VERSION) || null
            });
        }

        for (let i = 0; i < setup.length; i++) {
            const ai = this.game.aiManager.aiPlayers[i];
            const playerSetup = setup[i];

            if (playerSetup.type === 'ki') {
                // Rule-based AI, no LLM controller needed
                console.log(`[OpenAIAI] Player ${i + 1} (${ai.civilization}): Using rule-based AI`);
                continue;
            }

            // LLM player. New setup carries a `connection` (endpoint + auth + model);
            // fall back to the legacy flat fields for safety.
            const conn = playerSetup.connection || {
                name: playerSetup.name,
                endpoint: playerSetup.endpoint,
                model: playerSetup.model,
                provider: playerSetup.provider,
                auth: playerSetup.apiKey ? { type: 'bearer', key: playerSetup.apiKey } : { type: 'none' }
            };

            const modelInfo = {
                id: `openai-ai-${i}`,
                name: (this._seatNames && this._seatNames[i]) || conn.name || conn.model || `Player ${i + 1}`,
                endpoint: conn.endpoint,
                provider: conn.provider || 'auto',
                auth: conn.auth || { type: 'none' },
                model: conn.model || 'default',
                // null anywhere below means "do not send it" — the provider's own default
                // then applies. That is not the same as sending a number that happens to
                // match it: an endpoint that rejects a parameter rejects it at any value,
                // and reasoning models reject temperature outright (see adaptToApiError).
                temperature: (conn.temperature == null) ? null : conn.temperature,
                topP: (conn.topP == null) ? null : conn.topP,
                topK: (conn.topK == null) ? null : conn.topK,
                minP: (conn.minP == null) ? null : conn.minP,
                presencePenalty: (conn.presencePenalty == null) ? null : conn.presencePenalty,
                repetitionPenalty: (conn.repetitionPenalty == null) ? null : conn.repetitionPenalty,
                reasoning: conn.reasoning == null ? '' : conn.reasoning,
                extraBody: conn.extraBody || null,
                maxTokens: conn.maxTokens || 2000, // per-model cap on reply length (default 2000)
                contextSize: conn.contextSize || null, // context budget (tokens); also Ollama num_ctx (null = 32768)
                maxContext: conn.maxContext || null, // model's real max context — hard ceiling for the budget
                minimizeTokens: !!conn.minimizeTokens, // true = compact one-line history (Option A)
                toolFallback: !!conn.toolFallback, // true = accept inline JSON when no tool call arrives
                language: conn.language || 'en', // language the model reasons/answers in (independent of GUI)
                libraryId: conn.libraryId != null ? conn.libraryId : null,
                customSystemPrompt: playerSetup.systemPrompt || null
            };

            // If no explicit model was chosen, discover one from the endpoint
            // (provider-aware: OpenAI /models, Anthropic /models, Ollama /api/tags).
            if (!conn.model || conn.model === 'default') {
                try {
                    const probe = await OpenAIAIManager.testConnection(conn.endpoint, modelInfo.auth, modelInfo.provider, 6000);
                    if (probe.ok && probe.models && probe.models.length) {
                        modelInfo.model = probe.models[0];
                        if (!conn.name) modelInfo.name = probe.models[0];
                    }
                } catch (err) {
                    console.warn(`[OpenAIAI] Could not discover models from ${conn.endpoint}:`, err.message);
                }
            }

            const controller = {
                id: ai.id,
                aiPlayer: ai,
                model: modelInfo,
                lastTurnTime: 0,
                turnCount: 0,
                pending: false,
                paused: false, // spectator can pause a model (e.g. when it runs out of quota)
                conversationHistory: [], // Stores {action, result} for feedback loop
                turnLog: [], // Rolling multi-turn pairs {user, assistant} for Option C
                _pendingTurnUser: null, // compact state for THIS turn, stored after the reply
                lastActionResult: null, // Most recent action result for next turn
                pendingAdvice: [], // Spectator advice to inject into the next prompt
                objective: '', // Model-authored standing goal ("why"), persists until it changes it
                plan: [], // Model-authored short ordered sub-goals, persists until rewritten
                pendingArrivalMessages: [], // deferred attack outcomes, delivered on arrival
                pendingAttackReports: [], // open attack-move orders awaiting an arrival verdict
                stats: this.newStats() // Behavior/performance metrics for the summary
            };

            this.aiControllers.push(controller);
            console.log(`[OpenAIAI] Assigned model "${modelInfo.name}" (${modelInfo.endpoint}) to AI "${ai.civilization}" (${ai.id})`);
        }

        // Two seats can legitimately run the SAME library entry — one OpenRouter key,
        // (Colliding names were suffixed #1/#2 before the header was written, above.)

        console.log(`[OpenAIAI] Initialized ${this.aiControllers.length} LLM controllers from Arena setup`);
    }

    // ----------------------------------------------------------------
    // 3. Build COMPACT game state JSON for a specific AI player
    //    Target: < 25,000 tokens (server limit: 32,000)
    // ----------------------------------------------------------------
    buildGameStateJSON(controller) {
        const ai = controller.aiPlayer;
        const game = this.game;
        const civ = getCivilization(ai.civilization);
        const ages = ['stone', 'neolithic', 'bronze', 'iron'];
        const ageOrder = ages;
        const currentAgeIndex = ageOrder.indexOf(ai.age);

        // --- Player identity ---
        const playerObj = {
            id: ai.id,
            civilization: ai.civilization,
            // The same German source string, sent every turn of every match. Kept as
            // a field (dropping it would change the state's shape for no gain) but
            // translated into the model's own language.
            civilizationName: (civ?.name && typeof tgIn === 'function')
                ? tgIn((controller.model && controller.model.language) || 'en', civ.name)
                : (civ?.name || ai.civilization),
            isHuman: false
        };

        // --- Epoch --- (costs come from the shared AGE_COSTS table in civilizations.js)
        const nextEpoch = currentAgeIndex < ages.length - 1 ? ages[currentAgeIndex + 1] : null;

        const epochObj = {
            currentEpoch: ai.age,
            nextEpoch: nextEpoch,
            nextEpochCost: nextEpoch ? AGE_COSTS[nextEpoch] : null,
            upgradeInProgress: ai.currentAgeUpgrade ? {
                targetEpoch: ai.currentAgeUpgrade.targetAge,
                progressPercent: Math.round((ai.currentAgeUpgrade.progress / ai.currentAgeUpgrade.duration) * 100),
                secondsRemaining: this.secsLeft(ai.currentAgeUpgrade.progress, ai.currentAgeUpgrade.duration)
            } : null
        };

        // --- Resources ---
        const resourcesObj = {
            food: Math.floor(ai.resources.food),
            wood: Math.floor(ai.resources.wood),
            stone: Math.floor(ai.resources.stone),
            gold: Math.floor(ai.resources.gold),
            population: ai.resources.population,
            maxPopulation: ai.resources.maxPopulation,
            populationFree: ai.resources.maxPopulation - ai.resources.population,
            // Hard ceiling — houses raise maxPopulation only up to this value.
            populationHardCap: (typeof MAX_POPULATION_CAP !== 'undefined') ? MAX_POPULATION_CAP : 100
        };

        // --- Battle report: losses, kills and raids since a while back ---
        // (game.logPlayerEvent feeds this; without it deaths between turns were
        // completely invisible to the model.)
        //
        // Read LATE — see the node-exhaustion check further down, which logs an event of
        // its own while building this same state. Snapshotting here, where this section
        // reads, put that event one turn behind the number that caused it: the model
        // would see stone fall to zero with no explanation, and only be told why on the
        // following turn. Which is the exact frame that confused one in the first place.
        // This expired by DISPLACEMENT only — the last 8 of a 14-slot ring, with no
        // notion of age — which fails at both ends. The busy end was already known and
        // worked around: notices evicted by newer ones before the owner's next turn,
        // which is why building losses were moved into their own ledger. The quiet end
        // was not. One match left "your last discovered food node has been emptied" in
        // this list for THIRTY-TWO MINUTES, still labelled as news at "2755s ago",
        // beside a discoveredNodesOnMap.food that by then read 8. True when it fired,
        // false for most of the match it was shown in — and worse than never sending
        // it, because the model had no reason to distrust the one channel that exists
        // to tell it what changed.
        //
        // Keyed on the player's OWN turns, so it survives exactly as long as it is news
        // to THAT player: nothing expires before they have had a turn to read it, and
        // nothing outlives the turn after. Two rather than one so an event landing just
        // after a state was built is still seen. A wall-clock window cannot express
        // this — turn length belongs to the model, not to the game.
        // Expiry is per ENTRY now, not one window for everything: e.ttl state-builds,
        // defaulting to the 2 this has always used. A CONTACT asks for 1, because a
        // sighting repeated next turn reads as a second sighting of the same scout.
        const buildRecentEvents = () => {
            const seq = ai._turnSeq = (ai._turnSeq || 0) + 1;
            return (ai.events || []).filter(e => (e.seq || 0) >= seq - (e.ttl || 2)).slice(-8).map(e =>
                `${Math.max(0, Math.round((Date.now() - e.at) / 1000))}s ago: ${e.text}`);
        };

        // --- Battles: what actually happened in the fighting ---
        // A model cannot watch a fight — it decides between snapshots. Each entry is
        // ONE engagement (clustered by location), CUMULATIVE since it began, so the
        // same battle grows turn over turn instead of arriving as fragments. Only
        // engagements this player took part in; the numbers are stated and never
        // interpreted — "their 2 heavy cavalry dealt 1800 to my 3 archers" IS the
        // counter lesson, and drawing it is the model's job, not the harness's.
        const battleNow = Date.now();
        const sideJson = (side) => {
            const involved = {};
            Object.entries(side.involved).forEach(([type, e]) => {
                const o = { n: e.ids.size };
                if (e.dmgUnits > 0) o.dmgUnits = Math.round(e.dmgUnits);
                if (e.dmgBuildings > 0) o.dmgBuildings = Math.round(e.dmgBuildings);
                if (e.healed > 0) o.healed = Math.round(e.healed);
                involved[type] = o;
            });
            const out = { involved };
            if (Object.keys(side.lost).length) out.lost = side.lost;
            return out;
        };
        const battles = (game._battles || [])
            .filter(b => b.sides[ai.id])
            .slice(-3)
            .map(b => {
                const enemy = Object.keys(b.sides)
                    .filter(oid => oid !== ai.id)
                    .map(oid => {
                        const foe = (game.aiManager && game.aiManager.aiPlayers.find(a => a.id === oid)) ||
                                    (oid === 'player' ? game.player : null);
                        return Object.assign({ owner: game.seatLabel(foe || oid) }, sideJson(b.sides[oid]));
                    });
                const quiet = battleNow - b.lastAt;
                const ongoing = quiet < Game.BATTLE_QUIET_MS;
                return {
                    at: [Math.round(b.x), Math.round(b.z)],
                    ongoing,
                    // Entries are held for two minutes so a slow model still gets a
                    // turn to read them — far too long for "not ongoing" to carry it
                    // alone, since that says the same at 11 seconds and at 110. Only
                    // present once the fight has ended, so a live one pays nothing.
                    ...(ongoing ? {} : { endedSecondsAgo: Math.round(quiet / 1000) }),
                    secondsElapsed: Math.max(0, Math.round((b.lastAt - b.startedAt) / 1000)),
                    you: sideJson(b.sides[ai.id]),
                    enemy
                };
            });

        // --- Bonuses (only non-default) ---
        const bonusesObj = {};
        if (ai.workerHarvestBonus !== 1.0) bonusesObj.harvest = ai.workerHarvestBonus;
        if (ai.attackBonus !== 1.0) bonusesObj.attack = ai.attackBonus;
        if (ai.healthBonus !== 1.0) bonusesObj.health = ai.healthBonus;
        if (ai.miningBonus !== 1.0) bonusesObj.mining = ai.miningBonus;
        if (ai.techCostMultiplier !== 1.0) bonusesObj.techCostMult = ai.techCostMultiplier;

        // --- Map summary (NO fog grid - too large) ---
        // The world is a square centred on (0,0). Coordinates run from -size/2 to
        // +size/2 on both axes; the model needs this to scout the whole map for
        // enemies rather than only its own corner.
        const halfMap = Math.round(game.terrain.size / 2);
        const mapObj = {
            size: game.terrain.size,
            bounds: { minX: -halfMap, maxX: halfMap, minZ: -halfMap, maxZ: halfMap },
            yourSpawnArea: this.getAIBuildingCenter(ai),
            // Which tiles you occupy, and how many buildings sit in each. Was a single
            // yourBaseTile derived from getAIBuildingCenter — a CENTROID, so a player
            // holding D1 and G7 was told "E4", a tile it has nothing in. Averaging
            // positions only names a real place when there is exactly one cluster;
            // with a second base, or a base rebuilt after the first fell, it points
            // at empty ground between them.
            // How many nodes of each type are STILL on the map, right now. Compare
            // against "discoveredNodesOnMap" (what you have found) to judge whether more
            // scouting is worth it — and watch it fall to see the world running dry.
            //
            // This replaces the prose biome brief the prompt used to carry. That line
            // said "food is scarce"; the difficulty preset it described is literally a
            // multiplier on these counts — 98 food instead of 392 on a winter map, 49
            // and half the stone on a desert one. The number says the same thing, and
            // unlike the sentence it keeps saying it as the match wears on.
            nodesLeftOnMap: Object.assign({}, (game.terrain && game.terrain.nodesLeftOnMap) ? game.terrain.nodesLeftOnMap() : {}),
            yourBaseTiles: (() => {
                const out = {};
                ai.buildings.forEach(b => {
                    const k = this.tileAt(game, b.x, b.z);
                    out[k] = (out[k] || 0) + 1;
                });
                return out;
            })(),
            // Percent of each tile this player has ever seen, keyed by the same label
            // explore() takes: column A..G west→east, row 1..7 north→south.
            //
            // Was a 7x7 matrix plus two coordinate-edge arrays. That asked the model
            // to find a cell by position, pair [row][col] with the right axis array,
            // and do the arithmetic — and a transposition produced a mirrored target
            // that was still a legal map position, so it returned OK and the scout
            // walked somewhere pointless. Nothing could report it. One label per tile
            // removes the pairing, the arithmetic and the silent failure together.
            exploration: (() => {
                const seen = game.explorationSummary(ai);
                const T = seen.length || 1;
                const out = {};
                for (let r = 0; r < T; r++) {
                    for (let c = 0; c < T; c++) out[this.tileLabel(r, c)] = seen[r][c];
                }
                return out;
            })()
        };

        // --- Resources: what you know exists, and the nodes worth walking to ---
        //
        // This was one array of every node ever scouted. On a fully explored map that
        // is 1231 entries and 18,900 tokens — 95% of the whole state, re-sent every
        // turn forever, and 300 copies alive in the transcript ring. Two questions
        // were being asked of it and only two: "is more scouting worth it", which a
        // COUNT answers, and "where do I send this worker", which only the near ones
        // answer. The rest was paid for and never used.
        //
        // Nothing is taken away: assign_workers still resolves any discovered node by
        // coordinate (discoveredNodesOfType sees them all), so a remembered far node
        // stays targetable — it just is not recited every turn.
        if (!ai._knownResIdx) ai._knownResIdx = new Set();
        const discoveredNodesOnMap = { food: 0, wood: 0, stone: 0, gold: 0 };
        const byType = { food: [], wood: [], stone: [], gold: [] };
        if (game.terrain && game.terrain.resources) {
            game.terrain.resources.forEach((res, idx) => {
                const k = this.knownAmount(ai, res, idx, game);
                if (!k.known) return;        // undiscovered → hidden, must scout
                // Depleted as far as THIS player knows. A node it watched run dry
                // drops out; one a rival emptied out of sight stays listed at its
                // last-seen amount until someone looks again — the disappearance
                // would otherwise report enemy activity through fog.
                if (k.amount <= 0 || !byType[res.type]) return;
                discoveredNodesOnMap[res.type]++;
                byType[res.type].push({
                    type: res.type,
                    x: Math.round(res.x),
                    z: Math.round(res.z),
                    amount: k.amount
                });
            });
        }
        // The moment a type drops to zero, said out loud — computed HERE, from the very
        // number the model reads, and not from game.discoveredNodeCounts even though that
        // already detects the same crossing for the results graph. The two do not mean the
        // same thing: the graph counts LIVE amounts, this counts what THIS player knows,
        // and the difference is deliberate — a node a rival drains out of your sight stays
        // listed here at its last-seen amount. Firing from the live count would have
        // announced "your last known stone was exhausted" while the field directly beside
        // it still showed a node, which is worse than saying nothing.
        //
        // Why say it at all: a model watched its own stone count fall to zero while its
        // workers were returning stone, and concluded the harness had lost track of a node
        // rather than that the node was gone. A number that changes with no event behind
        // it is indistinguishable from a bug. Same lesson as the destroyed building.
        //
        // A fact, not a nudge — where to look next stays the model's call.
        const prevCounts = ai._lastNodeCounts;
        ai._lastNodeCounts = Object.assign({}, discoveredNodesOnMap);
        if (prevCounts) {
            ['food', 'wood', 'stone', 'gold'].forEach(k => {
                if (prevCounts[k] > 0 && discoveredNodesOnMap[k] === 0 && game.logPlayerEvent) {
                    // Says NODES, and only nodes. The first wording claimed "nothing you
                    // have discovered still holds food", which is plainly false beside two
                    // farms holding 300 each — listed in the very same state. This event
                    // knows one thing and must not speak for the rest of the economy.
                    // Naming the field ties the event to the number that moved, which is
                    // the whole point of having it.
                    game.logPlayerEvent(ai, `Your last discovered ${k} node has been emptied — discoveredNodesOnMap.${k} is now 0.`);
                }
            });
        }
        // Nearest per TOWN CENTER, not globally nearest: with two bases the ten
        // closest overall can all sit around one of them and leave the other blind.
        // Anchored on Town Centers because that is exactly what assign_workers picks
        // when given no coordinates — so this lists the nodes the harness would
        // choose anyway, instead of the 1231 it would not.
        const tcAnchors = ai.buildings.filter(b => b.type === 'town_center' && !b.underConstruction);
        const anchors = tcAnchors.length ? tcAnchors
            : (ai.buildings.length ? [ai.buildings[0]] : (ai.units.length ? [ai.units[0]] : []));
        const nearby = new Map();
        // Stone and gold in FULL: 58 nodes between them on a whole map, and they are
        // the scarce ones — "where is the gold" is the question least worth truncating.
        byType.stone.concat(byType.gold).forEach(n => nearby.set(n.x + ',' + n.z, n));
        anchors.forEach(a => ['food', 'wood'].forEach(ty => {
            byType[ty]
                .map(n => ({ n, d: Math.hypot(a.x - n.x, a.z - n.z) }))
                .sort((p, q) => p.d - q.d)
                .slice(0, OpenAIAIManager.NEAREST_PER_ANCHOR)
                .forEach(({ n }) => nearby.set(n.x + ',' + n.z, n));
        }));
        const nearestNodes = [...nearby.values()];

        // --- Buildings (compact: friendly buildings with essentials + busy/idle) ---
        // Research and age-up are player-level in the engine (ai.currentResearch /
        // ai.currentAgeUpgrade) — attribute each to ONE finished host building so a
        // researching/advancing structure reads as busy. A building is BUSY when it
        // is producing a unit, still under construction, or hosting research/age-up;
        // otherwise it is idle (free to take a new order).
        let researchHostType = null;
        if (ai.currentResearch) {
            const rt = (civ?.techTree || {})[ai.currentResearch.techId];
            researchHostType = (rt && rt.researchAt) || 'town_center';
        }
        const ageUpActive = !!ai.currentAgeUpgrade; // hosted at a Town Center
        let researchAssigned = false, ageAssigned = false;

        const bSummary = { total: 0, idle: 0, busy: 0, underConstruction: 0, producing: 0, researching: 0, advancingAge: 0, farmsUnmanned: 0, byType: {} };

        // Seconds a finished Wonder must be held. Needed by BOTH the owner's view of
        // its own wonder and every rival's view of it — one definition, because the
        // two countdowns are the same clock read from opposite sides.
        const required = (game.wonderRequired || 600);
        const friendlyBuildings = ai.buildings.map(b => {
            const constructing = !!b.underConstruction;
            const producing = !!b.isProducing && !constructing;
            // Age-up and tech research are DIFFERENT tasks that can run AT THE SAME
            // TIME (executeResearchTech only guards on currentResearch, executeUpgradeAge
            // only on currentAgeUpgrade). They used to share the "researching" label, so
            // a Town Center advancing an epoch reported activity "researching" while
            // research.current was null — models read that as a contradiction and sat
            // waiting for a research that did not exist. Kept apart now, each bound to
            // ONE host building, each carrying its own countdown below.
            let researching = false, advancing = false;
            if (!constructing) {
                if (ageUpActive && !ageAssigned && b.type === 'town_center') { advancing = true; ageAssigned = true; }
                else if (researchHostType && !researchAssigned && b.type === researchHostType) { researching = true; researchAssigned = true; }
            }
            const busy = constructing || producing || researching || advancing;
            const activity = constructing ? 'under_construction'
                : producing ? 'producing'
                : advancing ? 'advancing_age'
                : researching ? 'researching' : 'idle';

            const obj = {
                type: b.type,
                x: Math.round(b.x),
                z: Math.round(b.z),
                healthPct: Math.round((b.health / b.maxHealth) * 100),
                state: constructing ? 'under_construction' : 'complete',
                busy: busy,
                activity: activity,
                producing: producing ? b.productionType : null
            };
            if (producing) {
                obj.producingSecondsRemaining = this.secsLeft(b.productionProgress, b.productionDuration);
            }
            if (constructing) {
                obj.buildPct = Math.round(Math.min(1, (b.buildProgress || 0) / (b.buildTime || 10000)) * 100);
                obj.buildSecondsRemaining = this.secsLeft(b.buildProgress, b.buildTime);
            }
            // Say WHAT the host is busy with and WHEN it frees up, right here — a
            // model asking "when can this Town Center train again" should not have to
            // cross-reference research.current / epoch.upgradeInProgress to find out.
            if (researching && ai.currentResearch) {
                obj.researchingTech = ai.currentResearch.techId;
                obj.researchSecondsRemaining = this.secsLeft(ai.currentResearch.progress, ai.currentResearch.duration);
            }
            if (advancing && ai.currentAgeUpgrade) {
                obj.advancingTo = ai.currentAgeUpgrade.targetAge;
                obj.ageSecondsRemaining = this.secsLeft(ai.currentAgeUpgrade.progress, ai.currentAgeUpgrade.duration);
            }
            if (b.isWonder) {
                obj.wonder = true;
                // The owner used to get this boolean and nothing else, while every
                // rival was handed secondsUntilEnemyWins — the same clock, ticking on
                // ai._wonderHold, read only for the other side. So the one player whose
                // victory was running was the only one who could not see it.
                const held = constructing ? 0 : Math.round((ai._wonderHold || 0) / 1000);
                obj.secondsUntilYouWin = constructing ? null : Math.max(0, required - held);
                // And they were not told the rule that makes them a target. Every OTHER
                // building they own is fog-protected, so a model may reasonably infer
                // its Wonder is hidden too, tuck it in a corner, and be punished for a
                // belief the state invited. Stating the fact is not advice: what to do
                // about being visible is still entirely theirs to work out.
                obj.revealedToAll = true;
            }
            if (b.type === 'farm') {
                obj.food = Math.floor(b.foodAmount || 0);
                // A farm grows food ONLY while a worker mans it. "busy"/"activity"
                // above describe production and research, which a farm never does —
                // so they always read "idle" and say NOTHING about whether it works.
                // This flag is the farm's real status, straight from the same
                // predicate the simulation gates regrowth on.
                obj.farmed = !!game.farmFarmer(b);
            }

            // accumulate the aggregate
            bSummary.total++;
            bSummary.byType[b.type] = (bSummary.byType[b.type] || 0) + 1;
            if (constructing) bSummary.underConstruction++;
            if (producing) bSummary.producing++;
            if (researching) bSummary.researching++;
            if (advancing) bSummary.advancingAge++;
            if (busy) bSummary.busy++; else bSummary.idle++;
            // Standing idle costs nothing; a farm standing UNMANNED costs food every
            // second, and nothing else in this summary would ever say so.
            if (b.type === 'farm' && !constructing && !game.farmFarmer(b)) bSummary.farmsUnmanned++;

            return obj;
        });

        // Enemy buildings (compact: type + position). Buildings are static, so once
        // DISCOVERED they are remembered (ai._knownEnemyBuildings) and stay listed
        // even after your units look away — with "visible:false" marking a remembered
        // (last-seen) one vs a currently-in-sight "visible:true". A WONDER is an
        // existential threat and is ALWAYS revealed to everyone (ignores fog).
        if (!ai._knownEnemyBuildings) ai._knownEnemyBuildings = new Set();
        const enemyBuildings = [];
        const enemyWonders = [];
        game.getAllBuildings().forEach(bldg => {
            if (ai.buildings.includes(bldg)) return;
            if (bldg.health <= 0) { ai._knownEnemyBuildings.delete(bldg); return; } // destroyed
            const isWonder = bldg.isWonder;
            const seenNow = isWonder || this.isPositionVisibleToAI(ai, bldg.x, bldg.z, game);
            if (seenNow) ai._knownEnemyBuildings.add(bldg);          // discover/refresh
            if (!seenNow && !ai._knownEnemyBuildings.has(bldg)) return; // never discovered → hidden
            const entry = {
                id: bldg.id, // stable target handle for attack_target(params.targetId)
                type: bldg.type,
                x: Math.round(bldg.x),
                z: Math.round(bldg.z),
                owner: game.seatLabel(bldg.owner),
                healthPct: Math.round((bldg.health / bldg.maxHealth) * 100),
                visible: !!seenNow
            };
            if (isWonder) {
                entry.isWonder = true;
                const ownerAi = game.aiManager.aiPlayers.find(a => a.buildings.includes(bldg));
                const held = bldg.underConstruction ? 0 : Math.round(((ownerAi && ownerAi._wonderHold) || 0) / 1000);
                entry.state = bldg.underConstruction ? 'under_construction' : 'complete';
                entry.secondsUntilEnemyWins = bldg.underConstruction ? null : this.realSecs(Math.max(0, required - held) * 1000);
                enemyWonders.push(entry);
            }
            enemyBuildings.push(entry);
        });

        // --- Units (compact: friendly units with type + position + action) ---
        // How a worker's JOB reads as an ACTION, for the cases where the chain below
        // would otherwise have said "idle" without asking.
        const JOB_ACTION = { fighting: 'attacking', building: 'building', scouting: 'scouting',
                             farm: 'farm_work', food: 'harvesting', wood: 'harvesting',
                             stone: 'harvesting', gold: 'harvesting', moving: 'moving' };
        const friendlyUnits = ai.units.map(u => {
            let action = 'idle';
            if (u.isAttacking) action = 'attacking';
            else if (u.task === 'harvesting') action = 'harvesting';
            else if (u.task === 'carrying' || u.carryingResource) action = 'returning';
            else if (u.task === 'building') action = 'building';
            else if (u.task === 'farm_work') action = 'farm_work';
            else if (u.isMoving) action = 'moving';
            // On a WORKER "idle" is not decoration: it names a source
            // assign_workers accepts, and a model reads it as "this one is free".
            // The chain above never asked isIdleWorker, so it drifted both ways --
            // a worker walking with no job read as "moving" although it IS free,
            // and one retaliating, or holding a stale harvestTarget, read as "idle"
            // although it is not. Let the classifier the executor uses decide, and
            // fall back to what IT found rather than to the word "idle".
            if (u.type === 'worker') {
                const job = OpenAIAIManager.workerJob(this.game, u);
                if (job === 'idle') action = 'idle';
                else if (action === 'idle') action = JOB_ACTION[job] || 'moving';
            }

            return {
                // The one thing that makes a unit addressable. Without it "move a
                // crossbowman" resolves to whichever is nearest the DESTINATION, which is
                // the opposite of what you want when the point is to fetch a wounded one.
                id: u.handle,
                type: u.type,
                x: Math.round(u.x),
                z: Math.round(u.z),
                healthPct: Math.round((u.health / u.maxHealth) * 100),
                action: action
            };
        });

        // --- Worker breakdown: a live tally of what your villagers are doing, so the
        //     model can rebalance the economy at a glance (counts workers only). ---
        //     "onX" counts EVERY worker whose job is X, at any point in the gather
        //     cycle — walking out, at the node, or carrying a load home. It used to
        //     count only those standing on a node, with the whole return leg dumped
        //     into an unattributed "returning" bucket, so three workers all on wood
        //     read as harvestingWood 1 / returning 2. The staffing figure a model
        //     rebalances from was understating itself by however long the walk is.
        //
        //     There was a "carryingX" here too — how many of each were holding a load
        //     — so a model could work out how many moved for free. It was removed
        //     because it cannot survive the trip: a gather round trip runs 12-32s and
        //     a reply takes 1.6-36s, so by the time the action lands the figure is a
        //     whole cycle old and describes different workers. Spilling is decided at
        //     EXECUTION now, via assign_workers' allowSpill, where the truth is known.
        const wk = {
            total: 0, idle: 0, building: 0, onFarms: 0, scouting: 0, moving: 0,
            fighting: 0, onFood: 0, onWood: 0, onStone: 0, onGold: 0
        };
        // Field names differ from the job names (onFarms, onWood); the JOB is decided
        // in one place -- see OpenAIAIManager.workerJob -- and only the naming lives here.
        const WK_FIELD = { building: 'building', scouting: 'scouting', farm: 'onFarms',
                           food: 'onFood', wood: 'onWood', stone: 'onStone',
                           gold: 'onGold', idle: 'idle', moving: 'moving',
                           fighting: 'fighting' };
        ai.units.forEach(u => {
            if (u.type !== 'worker') return;
            wk.total++;
            wk[WK_FIELD[OpenAIAIManager.workerJob(this.game, u)] || 'moving']++;
        });
        // What this snapshot PROMISED, kept for the executor. workers.idle flickers:
        // a worker whose node runs dry is idle until the next pass puts it on another
        // one, and measured on a six-worker seat that is 0.2-2s at a time, non-zero in
        // 28% of samples. A seat that reads "idle: 3", thinks for eight seconds and
        // asks for idle hands is not making a mistake -- it is answering a state that
        // expired while it thought, which is the definition of a contended turn and
        // not of a rejected one.
        if (controller) controller._sentIdle = wk.idle;

        // Enemy units (very compact)
        const enemyUnits = [];
        game.getAllUnits().forEach(unit => {
            if (ai.units.includes(unit)) return;
            const vis = this.isPositionVisibleToAI(ai, unit.x, unit.z, game);
            if (!vis) return;
            enemyUnits.push({
                id: unit.id, // target handle for attack_target(params.targetId); units move, so prefer this over stale coordinates
                type: unit.type,
                x: Math.round(unit.x),
                z: Math.round(unit.z),
                owner: game.seatLabel(unit.owner)
            });
        });

        // --- Research (compact) ---
        const techs = civ?.techTree || {};

        // Researched tech IDs only
        const researchedTechIds = Object.keys(techs).filter(tid => ai.researchedTechs[tid]);

        // Current research
        const currentResearch = ai.currentResearch ? {
            techId: ai.currentResearch.techId,
            progressPercent: Math.round((ai.currentResearch.progress / ai.currentResearch.duration) * 100),
            secondsRemaining: this.secsLeft(ai.currentResearch.progress, ai.currentResearch.duration)
        } : null;

        // Available techs. Already filtered to what is researchable in principle —
        // not yet researched, age reached, prerequisites done — so the gates that can
        // still stand are the host building and the price. "host" was never reported:
        // a tech researched at a Market appeared here whether or not a Market existed,
        // and executeResearchTech refuses on exactly that. Same shape as the other two
        // vocabularies, so one reading habit covers all three.
        const availableTechs = Object.keys(techs)
            .filter(tid => {
                const t = techs[tid];
                if (ai.researchedTechs[tid]) return false;
                if (ageOrder.indexOf(t.requiredAge) > currentAgeIndex) return false;
                if (t.requires) {
                    for (const req of t.requires) {
                        if (!ai.researchedTechs[req]) return false;
                    }
                }
                return true;
            })
            .map(tid => {
                const t = techs[tid];
                const costMult = ai.techCostMultiplier || 1;
                const cost = {
                    food: Math.floor((t.cost.food || 0) * costMult),
                    wood: Math.floor((t.cost.wood || 0) * costMult),
                    stone: Math.floor((t.cost.stone || 0) * costMult),
                    gold: Math.floor((t.cost.gold || 0) * costMult)
                };
                const at = t.researchAt || 'town_center';
                const blockedBy = [];
                if (!ai.buildings.some(b => b.type === at && !b.underConstruction)) blockedBy.push('host');
                if (!ai.resources.hasResources(cost)) blockedBy.push('cost');
                return { id: tid, cost, researchAt: t.researchAt, blockedBy };
            });

        const researchObj = {
            researched: researchedTechIds,
            current: currentResearch,
            available: availableTechs
        };

        // --- Unlocked content ---
        // `units` used to be Object.keys(ai.unlockedUnits) and was structurally
        // always empty: exactly one tech in the whole game declares a unit unlock,
        // so for three civs out of four the field could never populate. It was the
        // only thing resembling a vocabulary for train_unit, and it never had one.
        // trainableUnits (below) replaces it with the real per-civ list.
        const unlockedContent = {
            buildings: Object.keys(ai.unlockedBuildings || {})
        };

        // Every buyable thing — tech, unit, structure — is described the same way: its
        // PRICE, which is a constant of the world, and the gates standing in the way
        // right now. An empty blockedBy means you can order it this turn.
        //
        // The price stays because it is what a plan is made of: "missing 50 gold" is
        // true for one tick, "costs 100 gold" is true all match, and only the second
        // lets a model work out what three of them would come to. The gates are here
        // because otherwise the only way to learn one is to attempt the buy and be
        // rejected — and rejections are SCORED (successRate is the heaviest term in
        // soundness), so the harness would be manufacturing the mistake it marks down.
        //
        // One list, not a boolean per gate: canAfford, readyToBuild, readyToTrain and
        // researched were each derivable from the others, and fields that must agree
        // are how a contract drifts apart.
        //
        // Gate names: "age" (epoch not reached), "tech" (unlock tech not researched),
        // The list in the prompt is presented as CLOSED, so it has to be complete: a
        // model that reads it as exhaustive and then meets an unlisted code has been
        // given wrong information by us, not made a mistake of its own. "pop" was
        // missing for months -- 187 occurrences in one 81-turn match, every one of them
        // a unit the seat could not train because it sat at the population cap.
        //
        // Emitted anywhere in trainableUnits / buildableStructures / research.available:
        //   age  tech  host  pop  cost  alreadyBuilt
        // "host" (no finished building that trains/researches it), "alreadyBuilt" (the
        // Wonder, one per player), "pop" (at the population cap), "cost" (cannot pay).
        //
        // "pop" was left out of the first version on the grounds that population is
        // already in resources and the model can compare two numbers itself. That proved
        // too much — cost is equally derivable, and cost is listed. A match settled it:
        // one seat spent 227 of its 474 turns being told "Population limit reached" by
        // the executor while trainableUnits told it, on those same turns, that nothing at
        // all stood in the way. Half a model's match spent on a gate the state denied.
        // In that same match the Market techs DID say blockedBy ["host"] and the seat
        // ignored them 21 times: where the state warns, the error is the model's; where
        // it stays quiet, the error is ours.
        //
        // Still absent, and for a reason that does hold: whether a trainer is free this
        // instant. Production runs about five seconds and turns arrive every four, so a
        // snapshot of "busy" is stale before the answer comes back. The population cap is
        // not like that — it persists until a house finishes.
        const costOf = (cost) => ({
            food: (cost && cost.food) || 0, wood: (cost && cost.wood) || 0,
            stone: (cost && cost.stone) || 0, gold: (cost && cost.gold) || 0
        });
        const tooPoor = (cost) => !(cost && ai.resources.hasResources(cost));
        const standing = (type) => ai.buildings.some(b => b.type === type && !b.underConstruction);

        // Both vocabularies list everything the civ can EVER field, not only what is
        // reachable this minute, because a plan needs to see what it is building toward.
        // That only works if each entry also says what stands in the way — a list of the
        // possible, priced but ungated, invites exactly the rejected call the prices
        // were added to prevent.
        const AGES = ['stone', 'neolithic', 'bronze', 'iron'];
        const ageReached = (need) => AGES.indexOf(ai.age) >= AGES.indexOf(need || 'stone');
        const atPopCap = (ai.resources.population || 0) >= (ai.resources.maxPopulation || 0);

        // --- Trainable units: the vocabulary for train_unit's "unitType" ---
        // Nested building → age → [{id, cost, blockedBy}]. The id stays a field of its
        // own rather than being folded into the token: an early version wrote
        // "militia(stone)" as one string to save a nesting level, and models duly
        // passed that whole string as the unitType — the harness had invented a token
        // that looked copyable and wasn't. An object with an explicit "id" cannot be
        // mistaken for one.
        const trainableUnits = {};
        this.trainableUnitsFor(ai.civilization).forEach(u => {
            const host = (trainableUnits[u.at] = trainableUnits[u.at] || {});
            const def = (typeof getUnitDefFor === 'function') ? getUnitDefFor(ai.civilization, u.id) : null;
            const blockedBy = [];
            // Structural gates first, money last — the order the executor reports them.
            if (!ageReached(u.age)) blockedBy.push('age');
            if (!standing(u.at)) blockedBy.push('host');
            // Units are the only thing that consumes population; buildings never do,
            // which is why this gate exists here and not in buildableStructures. Mirrors
            // the executor's own check exactly (>=, one head per unit).
            if (atPopCap) blockedBy.push('pop');
            if (tooPoor(def && def.cost)) blockedBy.push('cost');
            (host[u.age] = host[u.age] || []).push({
                id: u.id, cost: costOf(def && def.cost), blockedBy
            });
        });

        // --- Buildable structures for THIS civ (some civs lack e.g. the stable) ---
        // Only lists what your civilization can EVER build; if a type is missing,
        // your civ does not have it (don't waste turns trying).
        const stdBuildings = ['town_center', 'house', 'farm', 'barracks', 'archery_range', 'stable', 'academy', 'tower', 'temple'];
        const buildableStructures = stdBuildings.map(t => {
            const def = (typeof getBuildingDef === 'function') ? getBuildingDef(t) : null;
            if (!def) return null;
            const reqTech = def.requiresTech || null;
            const civSupports = !reqTech || !!techs[reqTech];
            if (!civSupports) return null; // civ can never build this
            const techDone = !reqTech || !!ai.researchedTechs[reqTech];
            // requiredAge is the CIV-effective age (unlock tech may come later
            // than the def's own age — Egypt's stable is bronze, not neolithic).
            const reqAge = (typeof effectiveBuildingAge === 'function') ? effectiveBuildingAge(ai.civilization, def) : (def.requiredAge || 'stone');
            const blockedBy = [];
            if (!ageReached(reqAge)) blockedBy.push('age');
            if (!techDone) blockedBy.push('tech');
            if (tooPoor(def.cost)) blockedBy.push('cost');
            return { type: t, requiredAge: reqAge, requiresTech: reqTech, cost: costOf(def.cost), blockedBy };
        }).filter(Boolean);

        // The Wonder belongs in this list. It was in no vocabulary at all: a model's
        // entire knowledge of the win condition it can BUILD was the goal line and a
        // zero-parameter action, so its price, the age it needs, and even the name of
        // the thing were discoverable only by trying.
        //
        // Advertised as "wonder", not as this civ's id. The ids differ per
        // civilization — akropolis, pyramid, firetemple, shrine — so publishing them
        // would make the SAME move a different call for each seat, and a seat with an
        // obscure id a harder one. Every seat now sends build_structure "wonder".
        // builtAs carries the id it will answer to once it stands, because that is
        // what friendlyBuildings will call it and the two must be connectable.
        const wDef = this.wonderDefFor(ai.civilization);
        if (wDef) {
            const wAge = wDef.requiredAge || 'iron';
            const wBlocked = [];
            if (!ageReached(wAge)) wBlocked.push('age');
            if (ai.buildings.some(b => b.isWonder)) wBlocked.push('alreadyBuilt');
            if (tooPoor(wDef.cost)) wBlocked.push('cost');
            buildableStructures.push({
                type: 'wonder', builtAs: wDef.id, requiredAge: wAge, requiresTech: null,
                isWonder: true, cost: costOf(wDef.cost), blockedBy: wBlocked
            });
        }

        // --- Buildings you have LOST recently ---
        //
        // Replaces "pendingBuildings", which read ai.pendingBuildings — a field only
        // ever populated on the HUMAN player's two-step place-a-building flow. Models
        // call createBuilding directly, so it was [] for every model on every turn,
        // and a model hunting for a Wonder it had started reasoned its way through
        // that empty array before giving up.
        //
        // What it was actually looking for is this: a building it was told it started
        // had been destroyed, and destruction leaves no trace in a snapshot. Held for
        // the same window as the battle ledger — one constant, because it is the same
        // question ("what did I miss between turns?") — and filtered by age HERE so a
        // quiet map cannot serve a stale entry.
        const recentLosses = (ai._lostBuildings || [])
            .filter(l => battleNow - l.at <= Game.BATTLE_KEEP_MS)
            .map(l => Object.assign(
                { type: l.type },
                l.wonder ? { wonder: true } : {},
                { x: l.x, z: l.z, secondsAgo: Math.round((battleNow - l.at) / 1000) },
                l.to ? { to: l.to } : {}
            ));

        // --- Opponents: ALL rivals — rule-based ones and, in campaign, the human
        // too (the old list was built from LLM controllers only, leaving blind
        // spots for everyone else). Epochs are PUBLIC: heralds announce age-ups.
        // Army/building counts are scouting rewards — they appear only after
        // FIRST CONTACT (this player has seen any unit or building of that
        // rival; see game.updateRivalContacts).
        const met = ai._metRivals || new Set();
        const aiOpponents = [];
        const pushRival = (o, key) => {
            const entry = { id: game.seatLabel(o), civilization: o.civilization, age: o.age, discovered: met.has(key) };
            if (entry.discovered) {
                // NOT "units", and not "unitsTotal" either. The tools taught a vocabulary
                // — "units" are the fighting ones (attack_target refuses workers outright)
                // and "workers" are the villagers — and then this field used the same word
                // for everything a rival owns. A model reading "59 units" as 59 soldiers
                // was applying OUR rule correctly; we were the ones breaking it. Any name
                // containing "units" keeps that door open.
                //
                // "population" is the word the game already uses for exactly this, and the
                // seat reads its own as resources.population — so the two are directly
                // comparable, in the vocabulary the model already holds.
                entry.population = o.units.length;
                entry.buildings = o.buildings.length;
            }
            aiOpponents.push(entry);
        };
        game.aiManager.aiPlayers.forEach(o => { if (o !== ai) pushRival(o, o.id); });
        if (!game.spectatorMode && game.player) pushRival(game.player, 'player');

        // --- Threats (what is attacking YOU right now — go defend!) ---
        const nowMs = Date.now();
        const underAttack = [];
        const scanHit = (ent, kind) => {
            if (!ent || ent.health <= 0) return;
            if (!ent._lastDamageTime || nowMs - ent._lastDamageTime > 6000) return;
            const atk = ent._lastAttacker;
            underAttack.push({
                kind, type: ent.type, x: Math.round(ent.x), z: Math.round(ent.z),
                healthPct: Math.round((ent.health / ent.maxHealth) * 100),
                attackerAt: atk ? { x: Math.round(atk.x), z: Math.round(atk.z), owner: game.seatLabel(atk.owner) } : null
            });
        };
        ai.buildings.forEach(b => scanHit(b, 'building'));
        ai.units.forEach(u => scanHit(u, 'unit'));
        const threatsObj = {
            underAttack: underAttack,                       // your stuff currently taking fire — defend it
            enemyWonders: enemyWonders                       // existential: destroy these or you lose
        };

        // --- Clock ---
        //
        // The prompt tells a model "TIME PASSES between turns" and the state is full
        // of seconds — buildSecondsRemaining, secondsUntilEnemyWins, secondsAgo — but
        // nothing said how long a turn IS, so none of them could be converted into
        // decisions. A 40s build is thirteen turns for a 3s seat and one turn for a
        // 37s seat; both were told "40". That is not strategy separating them.
        //
        // An AVERAGE rather than the last gap: one retry or one long reasoning burst
        // makes a single sample useless to plan on. And no derived "turnsRemaining" —
        // that is the model's arithmetic to do, and it would bake in an assumption
        // that cadence holds when a slowing endpoint is exactly when it does not.
        const clockObj = {
            matchSeconds: Math.max(0, Math.round(
                (battleNow - ((game._timeline && game._timeline.t0) || battleNow)) / 1000))
        };
        const gaps = (controller && controller.turnGaps) || [];
        // Omitted on the first turn: no interval has been observed yet, and seeding it
        // from the configured breather would be a guess wearing a measurement's clothes.
        if (gaps.length) {
            clockObj.averageSecondsBetweenTurns =
                Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length / 1000);
        }
        // Turn-based only, where a deadline actually exists. Publishing it is what lets
        // a model spend its thinking budget deliberately; enforcing it silently only
        // punished models for not guessing a number we already knew. Absent in
        // real-time mode rather than reported as null or infinity — there is no
        // deadline there, and a field that answers a question the mode never asks is
        // one more thing to reason past.
        if (this.turnBased) clockObj.secondsToAnswer = Math.round(this.roundTimeoutMs() / 1000);

        // --- Game stats ---
        const gameStatsObj = {
            // wonderTimer/wonderHeld were dropped: they read game.wonderTimer and
            // game.wonderHeld, which belong to the HUMAN player's wonder — and
            // checkWinConditions returns early in spectator mode, so in an arena they
            // were permanently 0 and false for every seat. Tokens spent every turn to
            // imply a clock that never moved. The owner's real clock now rides on its
            // own wonder as secondsUntilYouWin.
            // NOT realSecs. Every other duration is converted to real seconds at the
            // speed currently running, which is right for them -- but this one describes
            // a clock that can only ever tick at 1x, because anyWonderStanding() forces
            // the match back to 1x the moment a Wonder exists. Quoting it at 4x told a
            // model it had to hold for 150s; it spent its economy on that promise, the
            // Wonder went up, the speed dropped, and the requirement became 600s. A
            // number invalidated by the one act it exists to describe.
            wonderRequired: required,
            opponents: aiOpponents
        };

        // Every target id this seat is being SHOWN this turn. When an attack later
        // fails with "not found", this is what separates a target that DIED in the
        // seconds the model spent thinking — which the state cannot forewarn and must
        // not be scored — from an id that was invented or dragged in from a stale turn,
        // which is a real mistake. Recorded here because this object is the only thing
        // the model saw.
        if (controller) {
            controller._shownTargetIds = new Set(
                [].concat(enemyUnits || [], enemyBuildings || [])
                  .map(e => String(e && e.id)).filter(x => x && x !== 'undefined'));
            // High-water marks, for the closing question only. Recorded here because
            // this is the one place a seat's whole picture is already assembled, which
            // is cheaper than re-reading the recorder at match end -- and it costs a
            // handful of comparisons on a path that just built several arrays.
            const pk = controller._peak
                || (controller._peak = { buildings: 0, units: 0, workers: 0, pop: 0, maxPop: 0, at: 0 });
            const nb = (friendlyBuildings || []).length, nu = (friendlyUnits || []).length;
            if (nb > pk.buildings || nu > pk.units) {
                pk.at = (clockObj && clockObj.matchSeconds) || pk.at;
            }
            if (nb > pk.buildings) pk.buildings = nb;
            if (nu > pk.units) pk.units = nu;
            if ((wk.total || 0) > pk.workers) pk.workers = wk.total || 0;
            if ((resourcesObj.population || 0) > pk.pop) {
                pk.pop = resourcesObj.population;
                pk.maxPop = resourcesObj.maxPopulation;
            }
        }
        return {
            player: playerObj,
            clock: clockObj,
            epoch: epochObj,
            resources: resourcesObj,
            recentEvents: buildRecentEvents(),
            // Omitted entirely in peacetime — this rides the per-turn channel, so a
            // quiet game should pay nothing for it.
            ...(battles.length ? { battles } : {}),
            bonuses: bonusesObj,
            map: mapObj,
            discoveredNodesOnMap: discoveredNodesOnMap,
            nearestNodes: nearestNodes,
            friendlyBuildings: friendlyBuildings,
            buildings: bSummary,
            enemyBuildings: enemyBuildings,
            friendlyUnits: friendlyUnits,
            workers: wk,
            enemyUnits: enemyUnits,
            research: researchObj,
            unlockedContent: unlockedContent,
            // A list called "trainable" that holds things you cannot train is a lie the
            // model plans from, and the state is the worst place to keep one. Split on
            // the STRUCTURAL gates -- age, tech, host, alreadyBuilt -- which is what
            // separates "not yet possible" from "possible, not right now".
            //
            // cost and pop stay on the available side, wearing their blockedBy. They
            // change every few seconds, and a list that shuffled entries in and out as
            // resources ticked would be a worse lie than the one being fixed.
            units: OpenAIAIManager.splitByBlock(trainableUnits, 'trainable'),
            buildings: OpenAIAIManager.splitByBlock(buildableStructures, 'buildable'),
            // Omitted in peacetime, like "battles": a match where nothing has been
            // destroyed should pay nothing for the field.
            ...(recentLosses.length ? { recentLosses } : {}),
            threats: threatsObj,
            gameStats: gameStatsObj
        };
    }

    // Helper: get center position of AI's buildings
    getAIBuildingCenter(ai) {
        if (ai.buildings.length === 0) return { x: 0, z: 0 };
        let sx = 0, sz = 0;
        ai.buildings.forEach(b => { sx += b.x; sz += b.z; });
        return { x: Math.round(sx / ai.buildings.length), z: Math.round(sz / ai.buildings.length) };
    }

    // ----------------------------------------------------------------
    // 4. Helper: Compute fog grid for AI
    // ----------------------------------------------------------------
    computeAIFogGrid(ai, game, numTiles) {
        const mapSize = game.terrain.size;
        const gridSize = 2;
        const halfSize = mapSize / 2;
        const grid = new Uint8Array(numTiles * numTiles); // 0=hidden, 1=explored, 2=visible

        // Vision ranges
        const unitVisionRange = 15;
        const buildingVisionRange = 12;
        const towerVisionRange = 60;

        // Reveal around AI's units
        ai.units.forEach(unit => {
            const range = unit.unitType === 'cavalry' ? unitVisionRange * 1.2 : unitVisionRange;
            this.revealGridArea(grid, numTiles, unit.x, unit.z, range, halfSize, gridSize, 2);
        });

        // Reveal around AI's buildings — FINISHED ones only. A construction plot
        // grants no vision (same rule as the human fog): a tower's 60-radius
        // sweep is the reward for completing it, not for placing the stakes.
        ai.buildings.forEach(bldg => {
            if (bldg.underConstruction) return;
            this.revealGridArea(grid, numTiles, bldg.x, bldg.z, game.buildingVision(bldg), halfSize, gridSize, 2);
        });

        // Mark visible as explored (simplified - in real game this decays)
        // For AI we keep visible tiles as 2, rest as 0

        return grid;
    }

    revealGridArea(grid, numTiles, x, z, range, halfSize, gridSize, value) {
        const gx = Math.floor((x + halfSize) / gridSize);
        const gz = Math.floor((z + halfSize) / gridSize);
        const gridRange = Math.ceil(range / gridSize);

        for (let dx = -gridRange; dx <= gridRange; dx++) {
            for (let dz = -gridRange; dz <= gridRange; dz++) {
                const nx = gx + dx;
                const nz = gz + dz;
                if (nx < 0 || nx >= numTiles || nz < 0 || nz >= numTiles) continue;
                const dist = Math.sqrt(dx * dx + dz * dz) * gridSize;
                if (dist > range) continue;
                const idx = nz * numTiles + nx;
                if (grid[idx] < value) grid[idx] = value;
            }
        }
    }

    // ----------------------------------------------------------------
    // 5. Helper: Check if position is visible to AI
    // ----------------------------------------------------------------
    isPositionVisibleToAI(ai, x, z, game) {
        const buildingVisionRange = 12;
        const towerVisionRange = 60;

        // Check against AI units
        for (const unit of ai.units) {
            const range = game.unitVision(unit); // cavalry sees 50% farther
            const dx = unit.x - x;
            const dz = unit.z - z;
            if (Math.sqrt(dx * dx + dz * dz) <= range) return 'visible';
        }

        // Check against AI buildings (finished only — plots don't see)
        for (const bldg of ai.buildings) {
            if (bldg.underConstruction) continue;
            const range = game.buildingVision(bldg);
            const dx = bldg.x - x;
            const dz = bldg.z - z;
            if (Math.sqrt(dx * dx + dz * dz) <= range) return 'visible';
        }

        return null;
    }

    isAIOwned(building, ai) {
        return ai.buildings.includes(building);
    }

    isAIUnitOwned(unit, ai) {
        return ai.units.includes(unit);
    }

    // ----------------------------------------------------------------
    // 6. Helper: Get unit action JSON
    // ----------------------------------------------------------------
    getUnitActionJSON(unit) {
        let actionType = 'idle';
        const target = null;
        const targetPosition = null;
        const harvestInfo = null;
        const buildInfo = null;

        if (unit.isAttacking) {
            actionType = 'attacking';
        } else if (unit.task === 'harvesting') {
            actionType = unit.isMoving ? 'moving' : 'harvesting';
        } else if (unit.task === 'carrying' || unit.carryingResource) {
            actionType = 'returning_resources';
        } else if (unit.task === 'building') {
            actionType = 'building';
        } else if (unit.task === 'farm_work') {
            actionType = 'farm_work';
        } else if (unit.isMoving) {
            actionType = 'moving';
        }

        return {
            type: actionType,
            target: target,
            targetPosition: unit.isMoving ? {
                x: Math.round(unit.targetX * 10) / 10,
                z: Math.round(unit.targetZ * 10) / 10
            } : null,
            harvestInfo: unit.carryingResource || unit.task === 'harvesting' ? {
                resourceType: unit.carryingResourceType || (unit.harvestTarget ? unit.harvestTarget.type : 'food'),
                carriedAmount: unit.harvestAmount || 0,
                maxCarry: unit.maxHarvest || 15
            } : null,
            buildInfo: unit.task === 'building' && unit.buildTarget ? {
                buildingType: unit.buildTarget.type,
                progress: unit.buildProgress || 0,
                duration: 5000,
                progressPercent: Math.round(((unit.buildProgress || 0) / 5000) * 100)
            } : null
        };
    }

    // ----------------------------------------------------------------
    // 7. Canonical system prompt (SINGLE SOURCE OF TRUTH)
    // ----------------------------------------------------------------
    // The one and only default prompt text. The Arena/Campaign setup UI shows and
    // stores THIS text (ui.getArenaDefaultPrompt delegates here), per-slot edits
    // override it, and buildSystemPrompt() falls back to it — so the prompt the
    // user reads in the textarea is exactly the prompt the harness serves.
    // Placeholders resolved at match time: {{civilization}}, {{bonus}}, {{players}}.
    // {{terrain}} (the preset's summer/winter/desert brief) is still SUBSTITUTED, so a
    // hand-edited prompt may use it, but the default no longer spends tokens on it.
    //
    // Design: rules of the WORLD, not a strategy recipe. The prompt states what
    // exists, what things do and how they interact; the live state JSON says what
    // is possible right now; action results correct mistakes. Strategy (build
    // orders, target priority, timing) is deliberately left to the model — that
    // is what the benchmark measures.
    static defaultSystemPrompt() {
        return `You ARE {{civilization}}, one of {{players}} rival commanders in a real-time strategy game on a square 800x800 map. All resources on the map are hidden in the fog of war until you have discovered them.
Every other player is your enemy. No human plays for you: you command by issuing actions. Your unique bonus: {{bonus}}.

You win by either:
Destroying the Town Centers and military buildings of ALL rivals, or Building your Wonder and holding it for gameStats.wonderRequired seconds.

The LAST message carries your CURRENT state as JSON; decide from it and issue one to ${OpenAIAIManager.MAX_COMMANDS_PER_TURN} actions. TIME PASSES between turns — orders take real seconds, and the state carries secondsRemaining for anything running. Work already under way continues on its own and does not occupy your turn; re-issuing it wastes the turn.

- You never SEE a fight; it happens between your turns. "battles" reports each engagement, cumulative: both sides' composition, damage dealt to units and to buildings, priests' healing, and losses. Losing produces no error, so this is the only place you learn what beat you.
- Priests never fight. They march with an attack and heal wounded units from the back on their own.
- Idle military auto-defend your home between turns, so you need not micro every raid. Auto-defense only repels; it never wins the game.
- "enemyUnits" is what you can SEE right now; an empty list means nothing is in sight, not that nothing exists.
- Resource nodes hold a finite amount and disappear when emptied.
- "nearestNodes" lists the 10 nearest food/wood per Town Center and every stone/gold node — of the ones you have DISCOVERED. A type missing from it is one you have not scouted, not one the map lacks.
- "recentEvents" is the harness telling you what became of your orders since last turn — a node that ran dry under your workers, a building finished, a scout that arrived. Read it before repeating an order.
- A "CONTACT" line is a rival unit or building coming into your sight, and "CONTACT LOST" is one leaving it, each with where it was. Both are moments, and both are gone from this list next turn — what they MEAN is yours to carry. A sighting and a loss of the same unit are two positions in order, which is a heading: follow it back and it points at where that unit came from. Something roaming far from anywhere you have looked is a direction worth scouting. A "CONTACT LOST" also means your knowledge of that position is now old — it is where the unit WAS, not where it is.
- "threats" carries "underAttack" (what is being hit right now) and "enemyWonders" — the only warning you get that a rival is going for the Wonder win.
- "recentLosses" is what you lost since last turn, and to whom.
- "bonuses" is your civilisation's effect as a number: {"harvest": 1.25} means your workers carry 25% more per trip.
- "discoveredNodesOnMap" counts what you have FOUND, per resource. A zero means unscouted, not absent.
- "gameStats.opponents[].population" counts EVERYTHING a discovered rival owns, villagers included — the same measure as your own "resources.population", and NOT an army size. Everywhere else in these tools "units" means fighters and "workers" means villagers; this one number does not follow that rule, which is why it is not called units.
- "unlockedContent" lists the BUILDINGS you may now place; "research.researched" lists the TECHS you hold. They are not the same list and neither follows from the other by name: longbow unlocks the archery range, horseback unlocks the stable.

ACT BY CALLING THE TOOLS. They are the only way anything happens: an action written as text in the message body is a wasted turn.

YOUR BUDGET IS ${OpenAIAIManager.MAX_COMMANDS_PER_TURN} ACTION CALLS PER TURN — any mix of the action tools, not ${OpenAIAIManager.MAX_COMMANDS_PER_TURN} of each. Three different tools, or the same one three times, both count as three.
  EVERY turn needs at least one call. When nothing is worth doing, call "wait" — staying silent forfeits the turn instead of skipping it.
  Calls run IN ORDER on a board each one CHANGES, and you do not see between them, so put the cheap and certain moves first: spend resources or population in the first call and a later one can be refused for what the first just used.
  Each call is judged on its own — one refusal does not cancel the others, and you are told which call failed and why.
  Every action tool takes a "reason": one line, in your own words. It is what a spectator reads, and the only place you explain yourself.

"plan" is EXTRA and does not count against those ${OpenAIAIManager.MAX_COMMANDS_PER_TURN}. At most once per turn, and only when something changed: objective is one line, plan up to ${OpenAIAIManager.PLAN_MAX_STEPS} short steps. Both persist across turns, so simply do not call it to keep what you already have.

VALID ACTIONS & PARAMETERS (? = optional; each tool's own schema describes what they mean)
Note: targetX and targetZ must ALWAYS be provided together.
"units" and "buildings" each split in two: "units.trainable" / "buildings.buildable" are what you can order now, and "units.blocked" / "buildings.blocked" are what you cannot, each entry carrying "blockedBy" ("age", "tech", "host", "alreadyBuilt") and, for buildings, "requiresTech" and "requiredAge". Entries on the open side carry "cost", and a "blockedBy" of "cost" or "pop" when that is all that stands in the way.

${OpenAIAIManager.actionsBrief()}

PARAMETER CONSTRAINTS:
unitIds: An ARRAY of ids from friendlyUnits, e.g. [183, 12]. Moves or attacks EXACTLY those units and nothing else; "units" is ignored when it is given. Ids are never reused, so one that is gone means that unit died. Use it when WHICH unit matters — "units" picks whichever are nearest the target, which is the wrong end when you are fetching a wounded one.
units: An OBJECT of {"type": count}. Valid types: unit IDs (e.g., {"champion":3}) OR categories ({"infantry":5}). Categories work ONLY here, never in train_unit. Omit for whole army. Never an array. move_units also accepts {"worker":N} when named explicitly — that is how you place a unit on an exact spot; attack_target never takes workers.
matchSpeed: Only "slowestUnit", and only on move_units and attack_target. Allows your units to walk in unison until they reach the fight.`;
    }

    // ----------------------------------------------------------------
    // 8. Build system prompt
    // ----------------------------------------------------------------
    // A directive appended to the system prompt telling the model which language
    // to think/answer in. The action JSON (keys, action names, enums) must stay
    // English so parsing still works. Empty for English (the default).
    languageDirective(controller) {
        const lang = (controller && controller.model && controller.model.language) || 'en';
        if (lang === 'en') return '';
        const names = { de: 'German (Deutsch)', es: 'Spanish (Español)', zh: 'Simplified Chinese (简体中文)' };
        const name = names[lang];
        if (!name) return '';
        return `\n\n## Language\nThink and write ALL natural-language text — especially every "reason" field — in ${name}. BUT keep the response a valid JSON object and keep all JSON keys, action names and enum values EXACTLY as specified (in English). Only the free-text values are translated.`;
    }

    buildSystemPrompt(ai) {
        const civ = getCivilization(ai.civilization);
        const controller = this.aiControllers.find(c => c.id === ai.id);
        const langDirective = this.languageDirective(controller);

        // The setup UI always passes a prompt (the canonical default, or the
        // user's per-slot edit); the static default is the safety net. Either
        // way the SAME placeholder resolution applies, so custom prompts can
        // use {{civilization}}/{{bonus}}/{{players}}/{{terrain}} too.
        const base = (controller && controller.model?.customSystemPrompt)
            ? controller.model.customSystemPrompt
            : OpenAIAIManager.defaultSystemPrompt();

        // The map's character, per difficulty preset. Same principle as the rest of
        // the prompt: state what the world IS, never what to do about it. The food
        // presets differ by 8x between Summer and Desert, and bushes alone cannot
        // reach the Iron age on Desert — noticing that and reaching for farms is
        // precisely the adaptation the arena is meant to measure, so it is not
        // spelled out here.
        const TERRAIN_BRIEF = {
            easy:   'The playing field is a summer valley: food and wood are both abundant.',
            medium: 'The playing field is a winter valley: food is scarce; wood and stone are normal.',
            hard:   'The playing field is a desert valley: food and wood are both extremely scarce, and stone is half as common.'
        };
        const terrain = TERRAIN_BRIEF[(this.game && this.game.difficulty)] || TERRAIN_BRIEF.easy;

        // Players in THIS match: all AI players, plus the human in campaign mode.
        const players = ((this.game && this.game.aiManager && this.game.aiManager.aiPlayers.length) || 0)
            + ((this.game && !this.game.spectatorMode) ? 1 : 0);

        // Both of these used to hand the model GERMAN, in the first two sentences it
        // reads, in every match: civ.name is the German source string ("Ägypter",
        // "Griechen", "Perser") and bonus.description is a German sentence
        // ("Technologie 30% günstiger"). Nothing pointed it out because every in-match
        // reply is JSON with English keys, and that format anchors the language all by
        // itself -- so the leak only ever surfaced in the ONE free-form answer of a
        // match. In match-20260811 four seats ran the same 9B model with language 'en'
        // and one answered its closing statement entirely in German, quoting its own
        // bonus line back word for word. Which seat mirrors it is chance; all four were
        // being fed it.
        //
        // The civ is now the ID. That is what state.player.civilization says, what
        // ownerName answers, and what every reference to a rival already looks like --
        // one name for one thing, and no mapping to learn between the prompt and the
        // state. The bonus is translated into the MODEL's language (not the UI's, which
        // is a different setting entirely and belongs to whoever is watching).
        const modelLang = (controller && controller.model && controller.model.language) || 'en';
        const intoModelLang = (str) => (str && typeof tgIn === 'function') ? tgIn(modelLang, str) : str;
        // A seat with the inline-JSON fallback switched on is told so, because the
        // section above now says the tools are the ONLY way anything happens -- true
        // for every other seat and false for this one. Leaving it out would hand a
        // model an instruction it cannot follow (that is why the switch is on) and
        // none it can. Appended per seat rather than put in the shared template: for
        // everyone else the sentence would be a licence to ignore the contract, which
        // is exactly what cost the last match.
        const fallbackHint = (controller && controller.model && controller.model.toolFallback)
            ? '\n\nIF TOOL CALLING FAILS FOR YOU: this seat also accepts the same two shapes written as raw JSON objects in your reply text, one object per line — '
              + '{"action": "<ActionName>", "params": { … }} and {"objective": "<1 line>", "plan": ["<step>"]}. '
              + 'Calling the tools is still the primary channel; use this only when a call does not go through.'
            : '';

        return base
            .replace(/\{\{civilization\}\}/g, ai.civilization)
            .replace(/\{\{bonus\}\}/g, intoModelLang(civ?.bonus?.description) || 'None')
            .replace(/\{\{players\}\}/g, String(players || 2))
            .replace(/\{\{terrain\}\}/g, terrain)
            + fallbackHint + langDirective;
    }


    // A compact but FAITHFUL summary of a turn's state, kept for Option C's replayed
    // history. The CURRENT turn always sends the full state JSON — this is only the
    // memory of PAST turns, so we distil the high-signal fields (resources, economy,
    // army, research, known nodes, enemy presence, and threats) rather than blindly
    // truncating the JSON (which dropped exactly the important late sections like
    // threats and enemy wonders). Bounded so many turns fit the budget.
    buildCompactState(gs) {
        if (!gs || typeof gs !== 'object') {
            try { return JSON.stringify({ pastTurnRecap: true, raw: String(gs).slice(0, 160) }); } catch (e) { return '{"pastTurnRecap":true}'; }
        }
        const r = gs.resources || {}, ep = gs.epoch || {}, wk = gs.workers || {}, b = gs.buildings || {}, th = gs.threats || {};
        const fu = Array.isArray(gs.friendlyUnits) ? gs.friendlyUnits : [];
        // Already counts. This used to tally a 1231-entry array on every recap.
        const dn = gs.discoveredNodesOnMap;
        const nodes = Object.assign({ food: 0, wood: 0, stone: 0, gold: 0 },
            (dn && typeof dn === 'object' && !Array.isArray(dn)) ? dn : {});
        // The keys mirror the FULL state schema (resources / workers / buildings /
        // research / threats), so the model reads this past-turn recap exactly like
        // the live state it already knows — no new shorthand to learn. "pastTurnRecap"
        // flags it as condensed memory; counts replace the long per-entity arrays.
        const recap = {
            pastTurnRecap: true,
            epoch: {
                currentEpoch: ep.currentEpoch || (gs.player && gs.player.age) || 'unknown',
                advancingTo: ep.upgradeInProgress ? ep.upgradeInProgress.targetEpoch : null
            },
            resources: { food: r.food, wood: r.wood, stone: r.stone, gold: r.gold, population: r.population, maxPopulation: r.maxPopulation },
            // Mirrors the live state's key names. The recap kept reading the old
            // harvesting* keys after the split and would have replayed four
            // undefineds into every past turn.
            workers: {
                total: wk.total, onFood: wk.onFood, onWood: wk.onWood,
                onStone: wk.onStone, onGold: wk.onGold,
                onFarms: wk.onFarms, building: wk.building, idle: wk.idle, scouting: wk.scouting
            },
            militaryUnitCount: fu.filter(u => u.type !== 'worker').length,
            buildingsByType: b.byType || {},
            buildingsUnderConstruction: b.underConstruction || 0,
            currentResearch: gs.research && gs.research.current ? gs.research.current.techId : null,
            discoveredResourceNodeCounts: nodes,
            enemySeen: {
                // Deliberately avoids "units" for the same reason: this counts whatever
                // enemy figures are in view, fighters and villagers alike, and it is a
                // different number from gameStats.opponents[].population.
                entitiesVisible: Array.isArray(gs.enemyUnits) ? gs.enemyUnits.length : 0,
                buildings: Array.isArray(gs.enemyBuildings) ? gs.enemyBuildings.length : 0
            },
            threats: {
                underAttack: Array.isArray(th.underAttack) ? th.underAttack.length : 0,
                enemyWonders: (Array.isArray(th.enemyWonders) ? th.enemyWonders : []).map(w => ({ state: w.state, secondsUntilEnemyWins: w.secondsUntilEnemyWins }))
            }
        };
        let s;
        try { s = JSON.stringify(recap); } catch (e) { s = '{"pastTurnRecap":true}'; }
        const MAX = 1200;
        return s.length > MAX ? s.slice(0, MAX - 1) + '…' : s;
    }

    // OPTION A: compressed one-line move history, newest kept, filled to `budget`
    // tokens, then rendered oldest-first. Returns '' when there's nothing to show.
    buildMoveHistoryText(controller, budget, est) {
        const hist = (controller.conversationHistory || []).filter(e => e && e.action && e.result);
        if (!hist.length || budget < 80) return '';
        const trim = (s) => { s = String(s).replace(/^\[ERROR\]\s*/, '').replace(/^OK\s*-\s*/, '').trim(); return s.length > 200 ? s.slice(0, 197) + '…' : s; };
        const header = `Your recent moves THIS match (oldest first) — keep a consistent strategy, finish multi-step plans you started, and learn from the results:\n`;
        let used = est(header);
        const picked = [];
        for (let i = hist.length - 1; i >= 0; i--) {
            const e = hist[i];
            const status = e.failed ? 'FAILED' : 'OK';
            const why = e.reason ? ` ("${String(e.reason).slice(0, 120)}")` : '';
            const line = `${e.action}${why} -> ${status}: ${trim(e.result)}`;
            const cost = est(line) + 1;
            if (used + cost > budget && picked.length) break; // always keep at least one
            used += cost; picked.push(line);
        }
        picked.reverse();
        return header + picked.map((l, i) => `${i + 1}. ${l}`).join('\n');
    }

    // OPTION C: rolling user/assistant pairs from the turn log, newest kept, filled to
    // `budget` tokens, returned oldest-first and flattened into chat turns.
    buildRollingTurns(controller, budget, est) {
        const log = controller.turnLog || [];
        if (!log.length || budget < 80) return [];
        const picked = [];
        let used = 0;
        for (let i = log.length - 1; i >= 0; i--) {
            const p = log[i];
            const cost = est(p.user) + est(p.assistant) + est(p.outcome || '') + 16;
            if (used + cost > budget && picked.length) break;
            used += cost; picked.push(p);
        }
        picked.reverse();
        const turns = [];
        picked.forEach((p, j) => {
            // The OUTCOME of the previous turn's action is observed right before this
            // turn's state, so the model sees the consequence of each decision (e.g.
            // "REJECTED: no idle worker"), not just the decisions. This is what stops it
            // repeating a rejected command once the window fills.
            //
            // WHERE it is threaded depends on how the model answered. A turn that came
            // back as tool calls is answered in the TOOL channel; one that came back as
            // prose is answered as prose in the user turn, exactly as before.
            //
            // The evidence is the turn itself, which is why this needs no capability
            // negotiation and cannot guess wrong: a server that delivered tool_calls
            // demonstrably speaks the protocol, and one that did not, demonstrably does
            // not. Nothing is inferred from a URL and nothing has to be asked.
            //
            // It matters because a model trained on the tool loop attends to role:"tool"
            // as the channel the environment speaks in, while prose in a user turn is
            // just more prompt. Told "REJECTED: no idle worker" as narration, a
            // tool-trained model may weigh it as context; told the same thing as the
            // RESULT OF THE CALL IT MADE, it is being answered. The harness was partly
            // measuring whether a model reads narration, which is not the skill under
            // test.
            const prev = j > 0 ? picked[j - 1] : null;
            const prevOutcome = prev ? prev.outcome : null;
            const prevViaTools = !!(prev && prev.toolCalls && prev.toolCalls.length);

            if (prevOutcome && prevViaTools) {
                // Every call must be answered: an OpenAI-compatible server rejects a
                // conversation with a tool_call left dangling. The harness produces ONE
                // outcome per turn (up to three actions resolve into a single reply), so
                // the first call carries it and the rest point at it rather than
                // repeating several hundred characters per extra call.
                turns.push({ role: 'tool', results: prev.toolCalls.map((c, k) => ({
                    id: c.id, name: c.name,
                    content: k === 0 ? String(prevOutcome)
                                     : '(covered by the result of ' + prev.toolCalls[0].name + ' above)'
                })) });
            }
            const userContent = ((prevOutcome && !prevViaTools)
                ? `RESULT of your previous action: ${prevOutcome}

` : '') + p.user;
            turns.push({ role: 'user', content: userContent });
            // The assistant turn carries the calls it actually made, so the exchange the
            // model is shown is the one that happened rather than a prose retelling of
            // it. Providers that cannot render them fall back to the text.
            if (p.toolCalls && p.toolCalls.length) {
                turns.push({ role: 'assistant', content: p.assistant || null, toolCalls: p.toolCalls });
            } else {
                turns.push({ role: 'assistant', content: p.assistant || '(no reply)' });
            }
        });

        // The MOST RECENT turn's calls have to be answered too, and nothing above does
        // it: the loop answers picked[j-1] when it reaches turn j, so the last one is
        // always left open. Its result is not missing -- the caller has always put it in
        // the current user message as prose -- but an assistant message carrying
        // tool_calls followed by a user message is a protocol violation, and a strict
        // OpenAI-compatible server rejects the whole request rather than the turn.
        //
        // That is a whole-match failure from a dangling id, so it is answered here and
        // the caller is told (via _prevViaTools on the controller) not to repeat it as
        // prose. Found by asserting the invariant -- every called id answered, no answer
        // without a call -- rather than by watching requests fail.
        const last = picked[picked.length - 1];
        if (last && last.toolCalls && last.toolCalls.length) {
            const text = last.outcome
                || '(this action had not resolved when the next state was built)';
            turns.push({ role: 'tool', results: last.toolCalls.map((c, k) => ({
                id: c.id, name: c.name,
                content: k === 0 ? String(text)
                                 : '(covered by the result of ' + last.toolCalls[0].name + ' above)'
            })) });
        }
        return turns;
    }

    // Did the last recorded turn answer with tool calls? The caller needs this BEFORE it
    // builds the current user message, to decide whether the previous result belongs in
    // that message as prose or has already been delivered through the tool channel --
    // and it cannot wait for buildRollingTurns, whose budget depends on that message's
    // length. Saying it twice is not harmless: the model would read one outcome as two
    // events, one of them unattributed.
    lastTurnUsedTools(controller) {
        const log = (controller && controller.turnLog) || [];
        const last = log[log.length - 1];
        return !!(last && last.toolCalls && last.toolCalls.length);
    }

    // Render the neutral turn list into OpenAI's tool protocol. Separate from the request
    // builder so the same turns can be FLATTENED instead for providers whose dialect is
    // not implemented here — the alternative is four hand-written dialects, two of which
    // nobody on this machine can test, inside the thing used to measure models.
    // `objectArgs` is the one place OpenAI and Ollama disagree, and it is not
    // cosmetic: OpenAI carries function arguments as a JSON STRING, Ollama's native API
    // wants the parsed OBJECT. Send a string to /api/chat and it answers
    //   400 "Value looks like object, but can't find closing '}' symbol"
    // which reads like malformed JSON and is in fact well-formed JSON in the wrong
    // shape. Caught by replaying one real exchange against all four servers; three
    // accepted it and this one did not.
    static toolTurnsForOpenAI(turns, objectArgs) {
        const out = [];
        const args = (s) => {
            if (!objectArgs) return s;
            try { return JSON.parse(s || '{}'); } catch (e) { return {}; }
        };
        (turns || []).forEach(t => {
            if (t.role === 'tool' && Array.isArray(t.results)) {
                // tool_name alongside the id: Ollama pairs a result to its call by NAME
                // and ignores tool_call_id, OpenAI does the reverse. Sending both costs a
                // few bytes and means one renderer serves both.
                t.results.forEach(r => out.push({
                    role: 'tool', tool_call_id: r.id, tool_name: r.name, content: String(r.content)
                }));
                return;
            }
            if (t.role === 'assistant' && t.toolCalls && t.toolCalls.length) {
                out.push({
                    role: 'assistant',
                    content: t.content || null,
                    tool_calls: t.toolCalls.map(c => ({
                        id: c.id, type: 'function',
                        function: { name: c.name, arguments: args(c.args) }
                    }))
                });
                return;
            }
            out.push({ role: t.role, content: String(t.content == null ? '' : t.content) });
        });
        return out;
    }

    // Anthropic's own dialect: calls are tool_use BLOCKS inside the assistant turn and
    // outcomes are tool_result blocks inside a user turn, paired by tool_use_id.
    //
    // This was left unwritten on purpose -- the comment in the anthropic branch said an
    // unverified wire format is worse than an honest older one, and nothing on this
    // machine could verify it. Unsloth Studio serves /v1/messages locally, so that
    // precondition is gone and the dialect can be written and checked instead of guessed.
    //
    // The merge pass at the end is not tidiness. Anthropic requires the roles to
    // ALTERNATE, and a tool_result user turn lands directly before the next user turn --
    // two user messages in a row, which is a 400. Merging their block lists is what the
    // real clients do, and it is invisible to the model: one turn carrying the outcomes
    // and the new orders, exactly as a person would write it.
    static toolTurnsForAnthropic(turns) {
        const out = [];
        (turns || []).forEach(t => {
            if (t.role === 'tool' && Array.isArray(t.results) && t.results.length) {
                out.push({ role: 'user', content: t.results.map(r => ({
                    type: 'tool_result', tool_use_id: r.id, content: String(r.content) })) });
                return;
            }
            if (t.role === 'assistant' && t.toolCalls && t.toolCalls.length) {
                const blocks = [];
                if (t.content) blocks.push({ type: 'text', text: String(t.content) });
                t.toolCalls.forEach(c => {
                    // args ride as a JSON STRING everywhere else; Anthropic wants the
                    // object. A call whose arguments will not parse still has to appear,
                    // or the tool_result answering it has no tool_use to pair with.
                    let input = {};
                    try { input = JSON.parse(c.args || '{}'); } catch (e) { input = {}; }
                    blocks.push({ type: 'tool_use', id: c.id, name: c.name, input });
                });
                out.push({ role: 'assistant', content: blocks });
                return;
            }
            out.push({ role: t.role === 'assistant' ? 'assistant' : 'user',
                       content: String(t.content == null ? '' : t.content) });
        });
        const merged = [];
        out.forEach(m => {
            const prev = merged[merged.length - 1];
            if (!prev || prev.role !== m.role) { merged.push(m); return; }
            const asBlocks = (c) => Array.isArray(c) ? c : [{ type: 'text', text: String(c) }];
            prev.content = asBlocks(prev.content).concat(asBlocks(m.content));
        });
        return merged;
    }

    // ...and the universal floor. Anything that cannot speak the protocol gets the
    // conversation it got before this existed: outcomes as prose in the user turn, calls
    // described in the assistant turn. Not a degraded mode to apologise for -- it is what
    // every provider has been served since the beginning, and it is why an unimplemented
    // dialect costs nothing instead of breaking a seat.
    static flattenToolTurns(turns) {
        const out = [];
        (turns || []).forEach(t => {
            if (t.role === 'tool' && Array.isArray(t.results)) {
                // EVERY result, not just the first. A turn is up to three calls and the
                // seats average close to that, so reporting results[0] threw away two
                // outcomes in three -- and the model was left to infer what its second
                // and third orders had done from the next game state alone.
                if (t.results.length) {
                    out.push({ role: 'user', content: t.results.length === 1
                        ? `RESULT of your previous action: ${t.results[0].content}`
                        : t.results.map((r, i) => `RESULT ${i + 1}/${t.results.length}`
                            + ` (${r.name}): ${r.content}`).join('\n') });
                }
                return;
            }
            if (t.role === 'assistant' && t.toolCalls && t.toolCalls.length) {
                const said = t.toolCalls.map(c => `${c.name}(${c.args})`).join(' ');
                out.push({ role: 'assistant', content: (t.content ? t.content + ' ' : '') + said });
                return;
            }
            out.push({ role: t.role, content: String(t.content == null ? '' : t.content) });
        });
        return out;
    }

    // ----------------------------------------------------------------
    // 9. Send request to OpenAI endpoint
    // ----------------------------------------------------------------
    async sendToOpenAI(controller, gameState) {
        const model = controller.model;
        const ai = controller.aiPlayer;

        const systemPrompt = this.buildSystemPrompt(ai);

        // Assemble ONE coherent, chronological user message per turn. We rebuild the
        // model's context from scratch each turn (the providers here are stateless),
        // so the ordering must read as a single continuous session:
        //   recent moves (oldest -> newest)  ->  current state (LAST)  ->  advice.
        // (Previously the current state was placed FIRST and the history AFTER it,
        // which scrambled past/present and made the model answer a stale old result.)
        // ---- Rolling context sized to the model's context budget ----------------
        // The history window now scales with each model's context budget instead of a
        // fixed 20 moves, so big-context models actually remember more of the match.
        // Clamp the configured budget to the model's REAL max context if we discovered
        // it, so a too-high setting can't overflow.
        const hardMax = (model.maxContext && model.maxContext >= 512) ? model.maxContext : Infinity;
        const budget = Math.min(hardMax, (model.contextSize && model.contextSize >= 512) ? model.contextSize : 32768);
        const reserve = (model.maxTokens || 2000) + 1500;        // leave room for the reply + margin
        // Only use a conservative SLICE of the window for the prompt. We can't run the
        // model's tokenizer client-side, and dense JSON / non-English text tokenizes well
        // under 3.5 chars/token — overestimating capacity overflows the real limit and the
        // provider returns a 400 ("maximum context length …"), losing the turn. So we
        // estimate at a pessimistic ~3 chars/token AND keep a big headroom. `_ctxShrink`
        // ratchets this down further if an overflow ever still happens (self-healing).
        const shrink = controller._ctxShrink || 1;
        const inputBudget = Math.max(2000, Math.floor((budget - reserve) * 0.8 * shrink));
        const est = (s) => Math.ceil(String(s || '').length / 3); // conservative ~3 chars/token

        // (0) Standing objective/plan — frames every turn (sent in the present message).
        const head = [];
        if ((controller.objective && controller.objective.trim()) || (controller.plan && controller.plan.length)) {
            let s = `YOUR STANDING OBJECTIVE (you set this; it persists until you change it via the "objective"/"plan" fields on any action — update it as your plan evolves):`;
            if (controller.objective && controller.objective.trim()) s += `\nGoal: ${controller.objective}`;
            if (controller.plan && controller.plan.length) {
                s += `\nPlan: ` + controller.plan.map((p, i) => `(${i + 1}) ${p}`).join('  ');
            }
            head.push(s);
        }

        // (tail) Everything framing the PRESENT turn: deferred attack outcomes, a note
        // on an unparseable previous reply, the current state JSON, and spectator advice.
        const tailNow = [];
        if (controller.pendingArrivalMessages && controller.pendingArrivalMessages.length) {
            const msgs = controller.pendingArrivalMessages;
            controller.pendingArrivalMessages = [];
            tailNow.push(`RESULTS OF YOUR EARLIER ATTACK ORDER(S) — your units have now arrived:\n` + msgs.map(m => `- ${m}`).join('\n'));
        }
        // A completed rival Wonder is a live loss timer, restated beside the state each
        // turn because a reply can take ~30s and the number moves the whole time.
        //
        // It used to shout — "⚠️ URGENT — YOU LOSE IN Ns … Send your ENTIRE army to
        // attack_target it THIS turn and keep them on it until it falls." That was the
        // harness playing the decisive turn of the match, every turn, on the one
        // decision that ends games. The countdown, the position, the targetId and the
        // HP are facts and stay; what to do about them is the whole thing being
        // measured. The consequence is stated as the RULE it is, not as a command.
        const enemyWonders = (gameState.threats && gameState.threats.enemyWonders) || [];
        const liveWonders = enemyWonders.filter(w => w.state === 'complete' && w.secondsUntilEnemyWins != null);
        if (liveWonders.length) {
            const worst = liveWonders.reduce((a, b) => (a.secondsUntilEnemyWins <= b.secondsUntilEnemyWins ? a : b));
            // The seat id, not the civ: a controlled benchmark runs four seats on the
            // SAME civ, so "greek has completed a Wonder" would name three rivals at
            // once. This is the id already carried by threats.enemyWonders[].owner and
            // gameStats.opponents[].id, so it can be joined with everything else.
            const who = worst.owner || 'a rival';
            tailNow.push(`${who} has completed a Wonder at (${worst.x}, ${worst.z}) [targetId "${worst.id}", ${worst.healthPct}% HP]. If it still stands in ${worst.secondsUntilEnemyWins}s, ${who} wins the match.`);
        }
        const lastHistResult = controller.conversationHistory.length ? String(controller.conversationHistory[controller.conversationHistory.length - 1].result) : null;
        // "choose the single best action for THIS turn" stood here, in the LAST
        // message, on every turn of every match. The system prompt has allowed three
        // commands since July; this line never learned, and it is the more persuasive
        // of the two by position alone -- last thing read, repeated hundreds of times.
        // Models were paraphrasing it back verbatim ("I need to find the single best
        // move") and then sending one command a turn. Measured over one match: the two
        // large seats ignored it and averaged 2.5 commands a turn, while the two small
        // ones followed it and sent one on 80% and 89% of their turns.
        //
        // It is the same fault as the Wonder countdown four lines above -- the harness
        // deciding the shape of a turn rather than describing the board -- and it sat
        // directly underneath that comment for a month. How many things to do is part
        // of what is being measured.
        tailNow.push(`Here is your CURRENT game state. Decide what to do on THIS turn.\n\nGame State JSON:\n${JSON.stringify(gameState, null, 2)}`);
        if (controller.pendingAdvice && controller.pendingAdvice.length) {
            const advice = controller.pendingAdvice.join(' ');
            controller.pendingAdvice = [];
            tailNow.push(`SPECTATOR ADVICE (a human observer suggests — weigh it, you still decide): ${advice}`);
        }

        // Remember a compact snapshot of THIS turn; after the reply it becomes one
        // rolling history pair (Option C) so the next turn can replay it cheaply.
        controller._pendingTurnUser = this.buildCompactState(gameState);

        // ...and the FULL state for the transcript. Stored as the object rather than
        // the assembled prompt text on purpose: replayed history means the message
        // sent on turn N contains turns 1..N-1, so recording the whole payload every
        // turn would be quadratic — by turn 200 you would have written turn 1 two
        // hundred times. Keeping the per-turn delta lets any turn's full context be
        // reconstructed on demand instead.
        controller._transcriptState = gameState;

        // The result of the immediately previous action (rejection reason, parse error,
        // or OK + detail). The model MUST see this every turn or it will happily repeat
        // a rejected command forever.
        const prevResult = controller.lastActionResult || null;

        let turns;
        if (model.minimizeTokens) {
            // OPTION A — minimize tokens: a single user message whose embedded move
            // history is compressed to one line each, filled to the remaining budget.
            const fixed = [...head, ...tailNow].join('\n\n');
            const histBudget = inputBudget - est(systemPrompt) - est(fixed);
            const histText = this.buildMoveHistoryText(controller, histBudget, est);
            const parts = [...head];
            if (histText) parts.push(histText);
            // The move history already carries action outcomes; only surface a separate
            // note for a previous reply that isn't in it (e.g. an unparseable response).
            if (prevResult && prevResult !== lastHistResult) {
                parts.push(`Note on your previous response: ${prevResult}`);
            }
            parts.push(...tailNow);
            turns = [{ role: 'user', content: parts.join('\n\n') }];
        } else {
            // OPTION C — full multi-turn rolling conversation. Past pairs carry their
            // OUTCOMES (threaded in buildRollingTurns), and the present turn always
            // states the result of the previous action so a rejected command is never
            // silently repeated. The stable system-prompt prefix stays cacheable.
            const preface = [...head];
            // Prose only when the tool channel did not already carry it. A turn answered
            // with tool calls gets its result as the answer to those calls; repeating it
            // here would show the model the same outcome twice, once as a reply and once
            // as narration.
            if (prevResult && !this.lastTurnUsedTools(controller)) {
                preface.push(`RESULT of your PREVIOUS action — learn from it; do NOT repeat a rejected action, fix the cause first: ${prevResult}`);
            }
            const currentUser = [...preface, ...tailNow].join('\n\n');
            const pairBudget = inputBudget - est(systemPrompt) - est(currentUser);
            const pastTurns = this.buildRollingTurns(controller, pairBudget, est);
            turns = [...pastTurns, { role: 'user', content: currentUser }];
        }

        // Which protocol does this endpoint speak? (auto-detected when set to 'auto')
        const provider = OpenAIAIManager.resolveProvider(model);
        console.log(`[OpenAIAI] ${ai.id}: provider=${provider}, turns=${turns.length}`);

        // Outside the try on purpose: the catch needs it, and `reqStart` below is
        // block-scoped to the try. Without an elapsed time a network failure is
        // undiagnosable — "Failed to fetch" reads the same whether a proxy cut the
        // connection at a fixed 100 s or the wifi blinked once.
        const tStart = Date.now();
        try {
            // Build provider-specific auth headers + request (url, body).
            const auth = model.auth || (model.apiKey ? { type: 'bearer', key: model.apiKey } : { type: 'none' });
            let headers;
            try {
                headers = await OpenAIAIManager.buildAuthHeaders(auth, provider);
            } catch (authErr) {
                console.error(`[OpenAIAI] Auth failed for ${ai.id}:`, authErr);
                headers = { 'Content-Type': 'application/json' };
            }

            // Request-shape flags live on the model config, so once an endpoint has
            // told us what it wants, every later turn of the match gets it right first
            // time. They are not persisted to the library: re-learning costs one request
            // per match and cannot go stale when a provider changes its mind.
            model._reqOpts = model._reqOpts || {};
            const reqOpts = () => Object.assign(
                { temperature: model.temperature, topP: model.topP, topK: model.topK,
                  minP: model.minP, presencePenalty: model.presencePenalty,
                  repetitionPenalty: model.repetitionPenalty,
                  reasoning: model.reasoning, extraBody: model.extraBody,
                  maxTokens: model.maxTokens, numCtx: model.contextSize },
                model._reqOpts);
            // Learned refusals are worth keeping past the match: the library shows them,
            // so "this endpoint does not take top_k" survives as an observation rather
            // than being rediscovered at the cost of one request every single match.
            model._onLearn = model._onLearn || ((flags) => {
                if (this.game && this.game.ui && this.game.ui.noteModelRejection) {
                    this.game.ui.noteModelRejection(model.libraryId, flags);
                }
            });

            const reqStart = Date.now();
            let response, apiUrl, body;
            // At most two passes: the second only happens when the endpoint named a
            // parameter we know how to change. Anything else surfaces unchanged.
            // Three passes, but the two reasons to spend one are independent: a
            // parameter the endpoint refuses (learned once, below) and a rate limit.
            // Tracked as booleans rather than by attempt number, so a 429 on the first
            // pass cannot eat the one chance to adapt a bad parameter.
            let rateRetried = false, adapted = false;
            for (let attempt = 0; attempt < 3; attempt++) {
                const req = OpenAIAIManager.buildChatRequest(
                    provider, model.endpoint, model.model || 'default', systemPrompt, turns, reqOpts());
                apiUrl = req.url; body = req.body;
                console.log(`[OpenAIAI] Sending ${provider} request to ${apiUrl} for ${ai.id}`);

                // Abort the request if the endpoint is slow/dead so the controller
                // never gets stuck "pending" for the rest of the match. The handle is
                // stored on the controller so stop() can abort it when the match ends.
                controller._answeredVia = null;   // per attempt, never carried over
                const controllerAbort = new AbortController();
                controller._abort = controllerAbort;
                controller._deadlineAbort = false;   // cleared per attempt; set only by noteRoundMissed
                controller._abortReason = null;      // ...and this only by the three harness aborts
                const hardAbortMs = this.requestAbortMs();
                const timeoutId = setTimeout(() => controllerAbort.abort(), hardAbortMs);
                try {
                    response = await fetch(apiUrl, {
                        method: 'POST',
                        headers: headers,
                        mode: 'cors',
                        body: JSON.stringify(body),
                        signal: controllerAbort.signal
                    });
                } catch (fetchErr) {
                    if (fetchErr.name === 'AbortError') {
                        // Two very different aborts land here. Reporting the request
                        // timeout for both produced "timed out after 180s" about a
                        // request that was thirty seconds old, because the round
                        // deadline — not this timeout — had fired.
                        if (controller._deadlineAbort) {
                            throw new Error(`round deadline reached after ${Math.round(this.roundTimeoutMs() / 1000)}s — the harness cancelled the request`);
                        }
                        // Three other places abort this same handle — demoteToRuleBased,
                        // markDefeated and stop() — and none of them is a timeout. Saying
                        // so anyway put "timed out after 180s" on a request that had run
                        // 87 s, in the transcript AND in the model's next prompt: the
                        // harness blaming a model for its own bookkeeping.
                        if (controller._abortReason) {
                            const why = controller._abortReason;
                            controller._abortReason = null;
                            throw new Error(`the harness cancelled this request (${why}) after ${Math.round((Date.now() - tStart) / 1000)}s — not a model timeout`);
                        }
                        throw new Error(`timed out after ${Math.round(hardAbortMs / 1000)}s`);
                    }
                    throw fetchErr;
                } finally {
                    clearTimeout(timeoutId);
                }
                if (response.ok) break;

                const errorText = await response.text();

                // RATE LIMIT. Not a broken endpoint and not a bad parameter — the
                // account is simply going too fast, which is precisely what happens when
                // several seats share one key. Worth its own handling because the shape
                // of this harness's traffic invites it: turn-based asks every seat in the
                // same millisecond (measured at 95-99% of requests inside 250ms of
                // another), so a burst limit does not cost one seat a turn, it costs the
                // whole round — every seat 429s together and the round flushes empty.
                //
                // One retry, because a second would push a seat past a deadline it
                // cannot see and turn a recoverable blip into a missed round anyway.
                if (OpenAIAIManager.isRateLimited(response.status, errorText) && !rateRetried) {
                    rateRetried = true;
                    if (controller.stats) controller.stats.rateLimited = (controller.stats.rateLimited || 0) + 1;
                    const waitMs = OpenAIAIManager.retryAfterMs(response.headers, 1200);
                    console.warn(`[OpenAIAI] ${ai.id}: rate limited (${response.status}) — retrying once in ${waitMs}ms`);
                    await new Promise(r => setTimeout(r, waitMs));
                    // The round may have moved on while we waited. Retrying into a
                    // question nobody is asking any more wastes a call and can only
                    // produce an answer roundStillOpen would throw away.
                    if (this._stopped || controller._deadlineAbort) {
                        throw new Error(`rate limited (${response.status}); the round moved on during backoff`);
                    }
                    continue;
                }

                const fix = (response.status === 400 && !adapted)
                    ? OpenAIAIManager.adaptToApiError(model._reqOpts, errorText, model) : null;
                // Hint FIRST: the spectator log truncates at 90 characters, and a
                // provider's error body will happily eat all of them on its own.
                const hint = !fix ? OpenAIAIManager.hintForApiError(errorText, model) : '';
                if (!fix) throw new Error(hint
                    ? `API error (${response.status}): ${hint} Server said: ${errorText}`
                    : `API error (${response.status}): ${errorText}`);
                adapted = true;
                Object.assign(model._reqOpts, fix);
                try { model._onLearn(fix); } catch (e) { /* display only */ }
                console.warn(`[OpenAIAI] ${ai.id}: endpoint rejected a parameter, retrying with`,
                    Object.keys(fix).join(', '));
            }

            const data = await response.json();
            const norm = OpenAIAIManager.normalizeResponse(provider, data);
            // Token accounting: latency tells you speed, this tells you COST.
            const usage = OpenAIAIManager.extractUsage(provider, data);
            if (usage && controller.stats) {
                controller.stats.promptTokens += usage.prompt;
                controller.stats.completionTokens += usage.completion;
            }
            // A reply cut short is worth saying out loud, with the numbers needed to
            // tell WHOSE limit did it. If the provider reports far fewer completion
            // tokens than we asked for, the cap was applied upstream (a proxy or a
            // server-side default), not by us — and if the JSON is cut while the
            // finish reason is NOT the cap, nothing capped it and the transport
            // truncated the body. Those need opposite fixes, so don't guess.
            const askedMax = model.maxTokens || 2000;
            if (OpenAIAIManager.hitTokenCap(norm && norm.finish_reason)) {
                console.warn(`[OpenAIAI] ${ai.id}: reply stopped at a token cap — we asked max_tokens=${askedMax}, ` +
                    `provider reported completion=${usage ? usage.completion : 'n/a'}, content=${((norm && norm.content) || '').length} chars. ` +
                    `A completion far below the ask means the cap came from the endpoint, not from here.`);
            }
            const result = this.parseResponse(norm, controller);

            // Transcript: the exchange VERBATIM, for after-the-fact analysis. Separate
            // from turnLog below, which trims the reply to 600 chars, keeps content or
            // reasoning but never both, and stores the compact state rather than the
            // full one the model actually received. A pure observer — wrapped so a
            // recording fault can never cost a model its move.
            try {
                if (this.transcripts && controller._transcriptState != null) {
                    this.transcripts.record(controller.aiPlayer && controller.aiPlayer.id, {
                        at: Date.now(),
                        latencyMs: Date.now() - reqStart,
                        state: controller._transcriptState,
                        assistant: {
                            content: norm ? norm.content : null,
                            reasoning: norm ? norm.reasoning : null,
                            tool_calls: norm ? norm.tool_calls : null,
                            finish_reason: norm ? norm.finish_reason : null
                        },
                        parsed: result || null,
                        tokens: usage ? { prompt: usage.prompt, completion: usage.completion } : null,
                        // What we ASKED for, beside what came back. A truncation is
                        // only diagnosable as a pair: the cap we set is upstream of
                        // every explanation for why the reply stopped.
                        // publicModelId, not model.model: the REQUEST carried the full path
                        // (the endpoint needs it), the RECORD of it does not.
                        request: { maxTokens: askedMax, provider, model: OpenAIAIManager.publicModelId(model.model) || 'default' },
                        usageRaw: OpenAIAIManager.rawUsage(provider, data),
                        contentChars: ((norm && norm.content) || '').length,
                        // Which channel actually carried the move. Makes "does this
                        // model use the tools at this provider" a column instead of a
                        // guess -- and shows at once when a seat is living on the
                        // fallback rather than on the contract.
                        answeredVia: controller._answeredVia || null,
                        // Only when the reply came back empty although tokens were
                        // BILLED. Then the tokens existed and something between the
                        // server and us dropped them -- a model cannot write 940 tokens
                        // of nothing. Two such turns across every transcript so far, and
                        // both times the record could say only "nothing", never "what
                        // instead", which leaves the one question that decides the case
                        // -- did the split into reasoning and content go wrong? -- with
                        // no evidence at all.
                        //
                        // choices[0] and not the whole body: on an unfamiliar gateway the
                        // rest may hold anything, and this is written to a file that gets
                        // handed to other people. Without choices, only the KEY NAMES go
                        // in, never the values.
                        ...OpenAIAIManager.emptyReplyRaw(norm, usage, data)
                    });
                }
                controller._transcriptState = null;
            } catch (e) { console.warn('[transcript] capture failed', e); }

            // Record this exchange for the rolling multi-turn history (Option C):
            // the compact state we showed + the model's (trimmed) reply.
            if (controller._pendingTurnUser != null) {
                const replyText = (norm && (norm.content || norm.reasoning)) ? String(norm.content || norm.reasoning) : '';
                // The CALLS, not just the prose. A tool result has to name the call it
                // answers, and the id only exists here -- one line further on the reply is
                // a 600-character string and the ids are gone. Kept trimmed: the arguments
                // are echoed back to the model as its own words, so they are worth having
                // exactly, but a runaway argument blob must not grow the history without
                // bound.
                const calls = (norm && Array.isArray(norm.tool_calls)) ? norm.tool_calls : [];
                const toolCalls = calls.map((c, i) => {
                    const fn = (c && c.function) || {};
                    const args = typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments || {});
                    return {
                        // Some servers omit the id entirely. The protocol needs one to pair
                        // the answer with the call, so an absent id gets a synthetic one
                        // rather than an undefined that would break the pairing silently.
                        id: (c && c.id) || ('call_' + (controller.turnLog.length) + '_' + i),
                        name: fn.name || 'unknown',
                        args: String(args || '{}').slice(0, 1200)
                    };
                });
                controller.turnLog.push({
                    user: controller._pendingTurnUser,
                    assistant: replyText.replace(/\s+/g, ' ').trim().slice(0, 600),
                    toolCalls: toolCalls.length ? toolCalls : null,
                    outcome: null // filled by recordAction once this turn's action resolves
                });
                controller._pendingTurnUser = null;
                if (controller.turnLog.length > 400) controller.turnLog = controller.turnLog.slice(-400);
            }

            // Behavior metrics: time-to-answer + parse outcome
            const s = controller.stats;
            if (s) {
                s.requests++;
                s.latencies.push(Date.now() - reqStart);
                // WHEN, not just how long. A seat whose endpoint dies mid-match leaves
                // no other trace of the moment it went quiet: its turns simply stop
                // appearing, which is invisible on a card that only counts them.
                s.lastAnswerAt = Date.now();
            }

            // Stamp the harness's answer onto the transcript. executeAction does this
            // for every turn that RUNS — but a reply that never parsed never reaches
            // it, so the turns whose failure most needs explaining were the only ones
            // showing a blank where the answer goes. Every early return below routes
            // through here so none can forget.
            const stampResult = (msg) => {
                try {
                    if (this.transcripts) {
                        this.transcripts.noteResult(controller.aiPlayer && controller.aiPlayer.id, msg);
                    }
                } catch (e) { /* recording must never break a turn */ }
                return null;
            };

            // The model ANSWERED, but with prose and no JSON action anywhere.
            // Fair-eval rule: nothing is executed and nothing is guessed (the old
            // keyword inference laundered format failures into valid-looking
            // moves). Counted separately from parse failures — the endpoint and
            // the reply are fine, the model just didn't issue an action.
            if (result && result.noAction) {
                this.registerNoActionReturn(controller,
                    OpenAIAIManager.hitTokenCap(norm && norm.finish_reason), askedMax);
                controller._failStreak = 0;
                return stampResult(controller.lastActionResult);
            }

            // The model DID issue an action and the JSON carrying it broke. That is a
            // format fault it can fix, so unlike a prose reply it gets told — and it
            // counts as a parse failure, which formatOk already subtracts.
            if (result && result.malformed) {
                if (s) {
                    s.parseFails++;
                    if (result.truncated) s.truncatedReplies = (s.truncatedReplies || 0) + 1;
                }
                controller.lastActionResult = result.truncated
                    ? `[ERROR] Your reply was CUT OFF before the JSON closed — you ran out of output tokens, so nothing was executed. Keep "reason", "objective" and "plan" to one short sentence each and always close the JSON.`
                    : `[ERROR] Your reply contained an "action" but was not valid JSON, so nothing was executed.${result.why ? ` The parser stopped here: ${result.why}.` : ''}${result.near ? ` Your reply up to that point ended: ...${result.near}` : ''}`;
                const lastMalformed = controller.turnLog[controller.turnLog.length - 1];
                if (lastMalformed && lastMalformed.outcome == null) lastMalformed.outcome = controller.lastActionResult;
                controller._failStreak = 0;
                return stampResult(controller.lastActionResult);
            }

            if (s && !result) s.parseFails++;

            // If parsing failed, store error feedback for next turn — and stamp it as
            // the OUTCOME of the turn pair we just pushed, so the rolling multi-turn
            // history (Option C) replays the failure too instead of a blind null.
            if (!result) {
                // Three unrelated failures used to share one sentence, and that sentence
                // told the model to "use the execute_action tool" -- a tool that appears
                // NOWHERE else in this codebase. The prompt asks for a raw JSON object.
                // A model cannot comply with an instruction to call something that does
                // not exist, and small models copy our notation back verbatim, so a
                // wrong name in an error is a wrong name in the next reply.
                //
                // The empty case is the one that matters. A 9B seat returned nothing on
                // 20 of its ~100 turns, every time with the completion budget exhausted:
                // it spent 8192 tokens deliberating and never wrote a character. That is
                // a LENGTH failure. Telling it to fix its JSON is advice it cannot act
                // on, because it never got as far as producing any.
                //
                // finish_reason is the provider's own word for it, so no guessing from
                // token arithmetic. Its absence is not proof of the opposite -- some
                // endpoints omit it -- hence the plainer empty-reply message as fallback.
                const rawReply = String((norm && (norm.content || norm.reasoning)) || '');
                const cappedOut = OpenAIAIManager.hitTokenCap(norm && norm.finish_reason);
                controller.lastActionResult = rawReply.trim()
                    ? `[ERROR] Your last reply could not be parsed, so nothing was executed. ${OpenAIAIManager.howToAnswer(controller)}`
                    : (cappedOut
                        ? `[ERROR] You returned NOTHING: your reply hit the output limit of ${askedMax} tokens before a single character of answer was written, so nothing was executed. Your thinking is spent from that same budget. Decide faster and keep "reason", "objective" and "plan" to one short sentence each — a bare {"action":"wait","params":{"reason":"thinking"}} beats an empty turn.`
                        : `[ERROR] You returned an EMPTY reply, so nothing was executed. ${OpenAIAIManager.howToAnswer(controller)}`);
                const lastTurn = controller.turnLog[controller.turnLog.length - 1];
                if (lastTurn && lastTurn.outcome == null) lastTurn.outcome = controller.lastActionResult;
                stampResult(controller.lastActionResult);
            }

            controller._failStreak = 0; // endpoint reachable (parse problems aside)
            return result;
        } catch (err) {
            console.error(`[OpenAIAI] Request failed for ${ai.id}:`, err);
            // Context-length overflow (provider 400). The endpoint is FINE — our prompt
            // was just too big for this model. Ratchet the budget down so subsequent
            // turns fit, and DON'T count it as an endpoint failure (no demotion).
            // Every server words this differently and the ratchet only fires on a match,
            // so a phrasing missing from here is not a smaller bug than the overflow --
            // it IS the overflow, repeating every turn, filed as an endpoint fault.
            // OpenAI-family says "context length"/"maximum context"; llama.cpp says
            // neither, it says the request "exceeds the available context size" or that
            // the "input is too large to process". Those two cost a llama.cpp seat the
            // self-heal entirely: it would overflow, get counted against its reliability,
            // and overflow again on identical terms next turn.
            if (/context length|context window|maximum context|context size|exceeds the available context|input is too large|prompt is too long|too many tokens|reduce the length/i.test(err.message || '')) {
                controller._ctxShrink = Math.max(0.25, (controller._ctxShrink || 1) * 0.7);
                console.warn(`[OpenAIAI] ${ai.id}: context overflow — shrinking budget to ${Math.round(controller._ctxShrink * 100)}% and retrying next turn.`);
                controller.lastActionResult = `[ERROR] Your previous request was too large for the model's context and was dropped; the history window has been trimmed. Continue normally.`;
                // Count it — a lost turn is a lost turn. Tracked separately from
                // network errors (the endpoint is fine, our prompt was too big) so
                // the reliability metric stays honest without demoting the model.
                if (controller.stats) {
                    controller.stats.requests++;
                    controller.stats.contextOverflows = (controller.stats.contextOverflows || 0) + 1;
                }
                return null;
            }
            // OUR deadline, not their endpoint. Same standing as a context overflow
            // directly above: a lost turn caused by the harness, counted visibly and
            // kept out of the reliability score entirely.
            //
            // It used to be charged as an endpoint failure, and which KIND depended on
            // whether the provider had sent response headers yet — an HTTP detail that
            // says nothing about the model. In one match the same event was filed 44
            // times as "network error" for a seat behind an aggregator (headers early,
            // body streaming) and 3 times as "timeout" for a local seat (headers only
            // once generation finished). The first lost 12 points of reliability; the
            // second was labelled "Frequent timeouts" having never timed out.
            //
            // roundsMissed already counted this in noteRoundMissed, and it is the
            // honest number: the seat was asked and did not answer in time.
            if (controller._deadlineAbort) {
                controller._deadlineAbort = false;
                if (controller.stats) controller.stats.requests++;
                return null;
            }
            // A rate limit that outlived its retry. Counted where it can be seen and
            // acted on — split the key, slow the tempo — but kept out of the endpoint's
            // reliability, which is meant to answer "can this model be reached", not
            // "did the operator run four seats through one key".
            if (/rate limited \(|API error \(429\)/.test(err.message || '')) {
                if (controller.stats) {
                    controller.stats.requests++;
                    controller.stats.rateLimited = (controller.stats.rateLimited || 0) + 1;
                    // The turn is gone. It has to be subtracted from "answered" as well,
                    // or a seat that was throttled off the board reads as having replied
                    // to every question it was asked.
                    controller.stats.rateLimitLost = (controller.stats.rateLimitLost || 0) + 1;
                }
                controller.lastActionResult = `[ERROR] The endpoint refused this turn with a rate limit and the retry did not clear it. Nothing was executed; continue normally.`;
                return null;
            }
            // Behavior metrics: classify the failure
            const s = controller.stats;
            if (s) {
                s.requests++;
                if (/timed out/i.test(err.message)) s.timeouts++;
                else {
                    s.networkErrors++;
                    // Kept so the card can say WHEN they die, not just how many. A
                    // tight cluster names the culprit; a spread exonerates it.
                    (s.networkAtMs = s.networkAtMs || []).push(Date.now() - tStart);
                }
            }
            // In a PLAYER game (not the arena benchmark), an unreachable endpoint
            // hands this opponent to the rule-based AI so the player still faces a
            // real opponent. The arena keeps failures as-is (they're part of the eval).
            controller._failStreak = (controller._failStreak || 0) + 1;
            if (!this.game.spectatorMode && controller._failStreak >= 2) {
                this.demoteToRuleBased(controller);
                return null;
            }
            // On file as a MARKER, the same way a missed round is. Until now a request
            // that never came back left NOTHING in the transcript — record() only runs
            // once a response exists — so a match ruined by a proxy read afterwards as a
            // match with fewer turns, and the elapsed time that identifies the culprit
            // was nowhere at all.
            if (this.transcripts) {
                try {
                    const t0 = (this.game && this.game._timeline && this.game._timeline.t0) || Date.now();
                    this.transcripts.note(ai && ai.id, {
                        type: 'request_failed',
                        at: Date.now(),
                        round: this._roundNo,
                        matchSeconds: Math.max(0, Math.round((Date.now() - t0) / 1000)),
                        elapsedMs: Date.now() - tStart,
                        message: String(err && err.message || err).slice(0, 200)
                    });
                } catch (e) { /* recording must never cost a turn */ }
            }

            // Log network failures to decision log
            const civ = getCivilization(ai.civilization);
            const civName = civ?.name || ai.civilization;
            const colorHex = '#' + (civ?.color || 0xffffff).toString(16).padStart(6, '0');
            this.pushDecisionFor(ai, {
                playerId: ai.id,
                civName: civName,
                color: colorHex,
                action: 'request_failed',
                // The elapsed time is the whole diagnosis. Failures clustered at one
                // value are something between the browser and the model cutting the
                // connection — Cloudflare's tunnel gives up at 100 s by default and
                // reports it as a plain fetch failure; scattered values are a real
                // network fault.
                reason: `Request to model failed after ${Math.round((Date.now() - tStart) / 1000)}s: ${err.message.substring(0, 90)}`,
                params: {}, failed: true
            });
            return null;
        }
    }

    // A reply arrived but carried no JSON action: count it as its own outcome
    // (a valid RETURN — it keeps its latency — but a wasted turn) and tell the
    // model unambiguously that nothing was done.
    registerNoActionReturn(controller, cappedOut, askedMax) {
        const s = controller.stats;
        if (s) s.noActionReturns = (s.noActionReturns || 0) + 1;

        // RAN OUT OF ROOM outranks every other reading of a silent turn, and it has to
        // be said first because it is the only one the model can act on. A reasoning
        // model that spends its whole budget thinking arrives here looking exactly like
        // one that chatted instead of calling a tool -- no tool call, a reply that will
        // not parse -- and was told "you called no tool at all", which is true and
        // useless: it never got as far as calling anything, and it cannot fix its
        // formatting when formatting was never the problem.
        //
        // The other message that says this properly is one branch over, and unreachable
        // from here: it fires only on an EMPTY reply, and a model that filled 8000
        // tokens with reasoning has a very non-empty one.
        //
        // The one fact the model does not otherwise have is that thinking is charged to
        // the same budget as the answer. Nothing tells it the size of that budget --
        // max_tokens is applied to the stream and never appears in the prompt -- so
        // this is the only channel through which it can learn the shape of the limit
        // it keeps hitting.
        if (cappedOut) {
            if (s) s.cappedOutTurns = (s.cappedOutTurns || 0) + 1;
            controller.lastActionResult =
                `[ERROR] NO ACTION: you hit the output limit of ${askedMax || 'the configured'} tokens before writing a tool call, so the turn was forfeited. `
                + `Your reasoning is spent from that SAME budget -- it is not free, and there is no separate allowance for it. `
                + `Think in fewer words, decide sooner, and call a tool while you still have room. `
                + `If you are unsure, {"action":"wait","params":{"reason":"..."}} costs almost nothing and keeps the turn.`;
            const cappedTurn = controller.turnLog[controller.turnLog.length - 1];
            if (cappedTurn && cappedTurn.outcome == null) cappedTurn.outcome = controller.lastActionResult;
            return;
        }
        // Two faults look identical from here and have different fixes. When tool
        // syntax was found in the raw reply the model DID call and the server missed
        // it -- a wrong --tool-call-parser on vLLM, or a chat template without a tool
        // section on llama.cpp. That is an operator's problem, and saying so keeps a
        // model from being told to fix something it did correctly.
        const miss = controller._toolContractMiss;
        controller._toolContractMiss = null;
        if (miss) {
            controller.lastActionResult = (typeof miss === 'string')
                ? `[ERROR] NO ACTION: your reply carried tool-call syntax (${miss}) but the server did not deliver it as a tool call, so nothing could be executed. This is a SERVER setting, not your mistake — the operator has to fix the tool-call parser or the chat template.`
                : `[ERROR] NO ACTION was taken this turn: you called no tool at all. ${OpenAIAIManager.howToAnswer(controller)}`;
        } else if (controller._planOnly) {
            // A plan-only turn is not a malformed one. The model worked a tool
            // correctly and simply issued no move, and it is told exactly that --
            // the plan itself is kept, not thrown away with the message.
            controller._planOnly = false;
            controller.lastActionResult = `[ERROR] NO ACTION was taken this turn: you called "plan" but never "action", so your objective and plan were saved and nothing was done. ${OpenAIAIManager.howToAnswer(controller)}`;
        } else controller.lastActionResult = `[ERROR] NO ACTION was taken this turn: nothing executable arrived. ${OpenAIAIManager.howToAnswer(controller)} Plain prose wastes the turn.`;
        const lastTurn = controller.turnLog[controller.turnLog.length - 1];
        if (lastTurn && lastTurn.outcome == null) lastTurn.outcome = controller.lastActionResult;
    }

    // ----------------------------------------------------------------
    // 10. Parse LLM response (primary: plain JSON, fallback: tool_calls)
    // ----------------------------------------------------------------
    // `norm` is the provider-normalized shape: { content, reasoning, tool_calls, finish_reason }
    parseResponse(norm, controller) {
        const ai = controller.aiPlayer;
        const civ = getCivilization(ai.civilization);
        const civName = civ?.name || ai.civilization;
        const colorHex = '#' + (civ?.color || 0xffffff).toString(16).padStart(6, '0');

        const logFailure = (reason) => {
            this.pushDecisionFor(ai, {
                playerId: ai.id,
                civName: civName,
                color: colorHex,
                action: 'tool_call_failed',
                reason: `Tool call could not be interpreted: ${reason}`,
                params: {}, failed: true
            });
        };

        // The model replied in prose without any JSON action: the decision log
        // shows the model's OWN words under a no-action tag — not a guessed move,
        // not a parse error.
        const logNoAction = (text) => {
            this.pushDecisionFor(ai, {
                playerId: ai.id,
                civName: civName,
                color: colorHex,
                action: 'no_action_provided',
                reason: String(text).replace(/\s+/g, ' ').trim().slice(0, 220),
                params: {}, failed: true
            });
        };

        // A reply that CONTAINS an action but would not parse is a MALFORMED action,
        // not prose — the model decided, and the JSON carrying the decision broke.
        // Logged under its own tag because "no action provided" was simply untrue,
        // and an untrue log entry is worse than none.
        const logMalformed = (text, cut) => {
            this.pushDecisionFor(ai, {
                playerId: ai.id,
                civName: civName,
                color: colorHex,
                action: cut ? 'reply_truncated' : 'malformed_action',
                reason: String(text).replace(/\s+/g, ' ').trim().slice(0, 220),
                params: {}, failed: true
            });
        };

        try {
            const message = norm || {};
            if (message.content == null && message.reasoning == null && !message.tool_calls) {
                console.warn(`[OpenAIAI] No message content in response`);
                logFailure('No message content in response');
                return null;
            }

            console.log(`[OpenAIAI] Response for ${ai.civilization}:`, {
                has_content: !!message.content,
                has_reasoning: !!message.reasoning,
                finish_reason: message.finish_reason,
                content_preview: (message.content || '').substring(0, 200)
            });

            // 1) tool_calls — the contract, and therefore FIRST. A reply carrying
            //    both used the channel it was offered; letting content win would
            //    score it as though it had ignored the tools. EVERY call is read:
            //    taking only [0] would throw away two of three actions.
            const toolCalls = message.tool_calls;
            if (toolCalls && toolCalls.length > 0) {
                const vonTools = OpenAIAIManager.envelopeFromToolCalls(toolCalls);
                if (vonTools.broken) controller._toolArgsBroken = vonTools.broken;
                if (OpenAIAIManager.ordersSomething(vonTools.envelope)) {
                    controller._answeredVia = 'tool_call';
                    return vonTools.envelope;
                }
                // Calls arrived but not one carried a usable action: that is a
                // malformed action, not silence, and it is logged as one.
                // "plan" alone is a real answer: the model set its standing goal and
                // chose no move. Discarding the envelope threw the plan away too and
                // then told the model its reply held no valid JSON, which was untrue
                // twice over.
                const e = vonTools.envelope;
                if (e && (e.objective !== undefined || e.plan !== undefined)) {
                    controller._answeredVia = 'tool_call';
                    controller._planOnly = true;
                    return e;
                }
                logMalformed(JSON.stringify(toolCalls).slice(0, 220), false);
                return { noAction: true };
            }

            // 2) Tools were offered and nothing came back. Whether the inline JSON
            //    below is even looked at is the seat's own setting, and OFF is the
            //    default on purpose: a seat that quietly falls back keeps playing
            //    while its operator never learns the parser does not fit, which is
            //    the harness compensating for a fault instead of showing it.
            const vertrag = OpenAIAIManager.toolsSupported(
                OpenAIAIManager.resolveProvider(controller.model || {}));
            if (vertrag && !(controller.model && controller.model.toolFallback)) {
                const marker = OpenAIAIManager.toolSyntaxInText(message.content || message.reasoning);
                controller._toolContractMiss = marker || true;
                logMalformed('no tool call' + (marker ? ' (server did not parse: ' + marker + ')' : ''), false);
                return { noAction: true };
            }
            controller._answeredVia = 'content';

            // 3) Structured JSON in content; then in reasoning. Reasoning models
            //    (e.g. Qwen3) leave content empty and put the answer in
            //    message.reasoning, so we must look there too.
            let parsed = this.extractActionFromText(message.content);
            if (!parsed) parsed = this.extractActionFromText(message.reasoning);
            if (OpenAIAIManager.ordersSomething(parsed)) {
                console.log(`[OpenAIAI] Parsed action:`, parsed);
                return parsed;
            }

            // 3) Prose with NO JSON action anywhere. The old harness guessed an
            //    action from keywords here — charitable, but unfair: other
            //    agentic harnesses aren't that forgiving, and acting on inferred
            //    intent laundered format failures into valid-looking moves. Now:
            //    log the model's own words, execute nothing, report a no-action
            //    turn (counted separately in the results).
            const freeText = (message.content || message.reasoning || '').toString().trim();
            if (freeText) {
                // Split BEFORE the prose verdict. Silence is the right answer to a
                // model that chose not to act; it is the wrong answer to one whose
                // JSON broke, which then repeats the same fault every turn with
                // nothing to correct. Saying "your JSON was malformed" is the error
                // channel doing its job, not a crutch — the same call as the
                // bracket-stripping hint executeAction already gives.
                // An opening brace AND an "action" key: that is a JSON attempt, not
                // prose. The quote class has to include CURLY quotes — a model that
                // smart-quotes its keys is the commonest way to produce unparseable
                // JSON, and matching only straight quotes sent exactly that case
                // down the prose path, which is the bug this split exists to fix.
                const looksLikeAction = freeText.includes('{') &&
                    /["'“”‘’]?\s*action\s*["'“”‘’]?\s*:/i.test(freeText);
                if (looksLikeAction) {
                    const cut = OpenAIAIManager.hitTokenCap(message.finish_reason);
                    // Hand back the parser's OWN complaint. "Not valid JSON" invites a
                    // model to rewrite a shape it already had right; the position and
                    // the token it choked on point at the one character to fix. A
                    // stray unescaped quote inside "plan" is the common case and looks
                    // nothing like a shape error from the inside.
                    let why = '', near = '';
                    if (!cut) {
                        const cands = this.findJsonObjects(freeText);
                        const raw = cands.length ? cands[cands.length - 1] : freeText;
                        try { JSON.parse(raw); } catch (e) { why = String((e && e.message) || e).slice(0, 160); }
                        // The text the parser had already accepted when it stopped. This
                        // replaces a sentence that used to GUESS the cause — it named
                        // unescaped quotes, and across a 165-turn match not one of the 52
                        // failures was a quote: every one was a single missing '}' closing
                        // a command object, which the guess pointed away from. An excerpt
                        // cannot be wrong about which character broke it, and it covers
                        // the quote case too, by showing the quote.
                        const at = /position (\d+)/.exec(why);
                        if (at) {
                            const i = Math.min(raw.length, parseInt(at[1], 10));
                            near = raw.slice(Math.max(0, i - 70), i);
                        }
                    }
                    console.warn(`[OpenAIAI] Malformed action JSON${cut ? ' — reply hit the output-token cap' : ''}, nothing executed:`,
                        freeText.slice(0, 160));
                    logMalformed(freeText, cut);
                    return { malformed: true, truncated: cut, why, near };
                }
                console.warn(`[OpenAIAI] Reply without JSON action — nothing executed:`, freeText.substring(0, 160));
                logNoAction(freeText);
                return { noAction: true };
            }

            // Truncated reasoning model with no usable output (OpenAI 'length',
            // Anthropic 'max_tokens', Google 'MAX_TOKENS').
            if (['length', 'max_tokens', 'MAX_TOKENS'].includes(message.finish_reason)) {
                logFailure('Response truncated (token limit) before an action was produced');
                return null;
            }

            console.warn(`[OpenAIAI] Could not extract action from response`);
            logFailure('No valid JSON found in response');
            return null;
        } catch (err) {
            // NOTE: log only what's in scope. Referencing an undefined identifier here
            // used to throw a ReferenceError INSIDE this catch, which escaped into
            // sendToOpenAI's catch and was miscounted as an endpoint failure — enough
            // of those could demote a perfectly healthy model to rule-based.
            console.error('[OpenAIAI] Failed to parse response:', err, norm);
            logFailure('Unexpected error parsing response');
            return null;
        }
    }

    // ----------------------------------------------------------------
    // 10a. Helper: Extract a valid action object from arbitrary model text
    //      Handles plain JSON, markdown fences, and JSON embedded anywhere
    //      in prose / chain-of-thought (picks the LAST valid action object).
    // ----------------------------------------------------------------
    extractActionFromText(text) {
        if (!text || typeof text !== 'string') return null;
        const t = text.trim();
        if (!t) return null;

        // Direct parse
        try {
            const p = JSON.parse(t);
            if (OpenAIAIManager.ordersSomething(p)) return p;
        } catch (e) { /* fall through */ }

        // Balanced-brace scan, and now EVERY top-level object counts, in order --
        // one per action is the documented shape. Taking only the last one was right
        // while a turn was a single object; it would throw away two of three now.
        //
        // The envelope is assembled HERE rather than further down on purpose: what
        // executeTurn, normalizeCommands and the transcript's "parsed" field see keeps
        // exactly the shape they already handle, so nothing downstream -- the analyzer
        // included -- has to learn a second one, and transcripts recorded before this
        // stay readable by the same code that reads the new ones.
        const objs = this.findJsonObjects(t);
        const cmds = [];
        const head = {};
        let brokenAfter = 0;
        for (const raw of objs) {
            let p = null;
            try { p = JSON.parse(raw); }
            catch (e) {
                try { p = JSON.parse(this.fixJsonString(raw)); } catch (e2) { p = null; }
            }
            if (!p || typeof p !== 'object') {
                // Counted only once a real command has been read. Before that, "nothing
                // parsed" is the honest verdict, and the caller's message names the
                // parser position -- worth more than a vague note about a fragment.
                if (cmds.length && /["']?(?:action|commands)["']?\s*:/.test(raw)) brokenAfter++;
                continue;
            }
            // The undocumented wrapper stays welcome: an extra frame is not a mistake,
            // and 3,719 recorded replies are shaped that way.
            if (Array.isArray(p.commands)) {
                p.commands.forEach(c => { if (c && typeof c.action === 'string') cmds.push(c); });
            } else if (typeof p.action === 'string') {
                cmds.push(p);
            }
            // First one wins: a model that states its objective twice meant it once.
            if (head.objective === undefined && typeof p.objective === 'string') head.objective = p.objective;
            if (head.plan === undefined && Array.isArray(p.plan)) head.plan = p.plan;
        }
        if (cmds.length) {
            // Named, not dropped. A silently skipped fragment is the harness deciding
            // for the model, and it would never learn which object it broke.
            for (let i = 0; i < brokenAfter; i++) cmds.push({ action: null, _unparsed: true });
            if (cmds.length === 1 && head.objective === undefined && head.plan === undefined) return cmds[0];
            return Object.assign({ commands: cmds }, head);
        }

        // Markdown code fence
        const fence = t.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
        if (fence && fence[1]) {
            const inner = this.extractActionFromText(fence[1]);
            if (inner) return inner;
        }
        return null;
    }

    // Return every balanced top-level { ... } substring (string-aware).
    findJsonObjects(text) {
        const objs = [];
        let from = 0, versuche = 0;
        // Restart instead of running to the end. One object that never closes used to
        // take every later one with it: its missing brace left the depth counter above
        // zero, the next object's brace only raised it further, and from there nothing
        // was emitted at all. That is what made one bad brace cost a whole turn even
        // when the reply carried three separate objects.
        //
        // Nothing is repaired here. A span that does not close is DROPPED and the scan
        // begins again at the next {. Every object handed back is still fully balanced
        // and still has to parse on its own -- the broken one stays broken and stays
        // reported.
        while (from < text.length && versuche < 64) {
            versuche++;
            const auf = text.indexOf('{', from);
            if (auf < 0) break;
            const ende = OpenAIAIManager.balancedEnd(text, auf);
            if (ende < 0) { from = auf + 1; continue; }   // schliesst nicht: naechstes { versuchen
            objs.push(text.slice(auf, ende + 1));
            from = ende + 1;
        }
        return objs;
    }

    // Index of the } that closes the { at `start`, or -1 when it never closes.
    // String-aware, because a brace inside a "reason" is text and not structure --
    // and reasons are where these models put their braces most often.
    static balancedEnd(text, start) {
        let depth = 0, inStr = false, esc = false;
        for (let i = start; i < text.length; i++) {
            const ch = text[i];
            if (inStr) {
                if (esc) esc = false;
                else if (ch === '\\') esc = true;
                else if (ch === '"') inStr = false;
                continue;
            }
            if (ch === '"') { inStr = true; continue; }
            else if (ch === '{') depth++;
            else if (ch === '}') { depth--; if (depth === 0) return i; }
        }
        return -1;
    }

    // ----------------------------------------------------------------
    // 10b. Helper: Fix common JSON issues
    // ----------------------------------------------------------------
    fixJsonString(jsonStr) {
        let fixed = jsonStr;
        // Remove trailing commas before } or ]
        fixed = fixed.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');
        // Fix unquoted keys: "key": -> "key": (already quoted) or key: -> "key":
        fixed = fixed.replace(/(\w+)\s*:/g, '"$1":');
        // Remove single-line comments
        fixed = fixed.replace(/\/\/.*$/gm, '');
        // Remove multi-line comments
        fixed = fixed.replace(/\/\*[\s\S]*?\*\//g, '');
        return fixed;
    }

    // ----------------------------------------------------------------
    // 11. Execute the parsed action for the AI player
    // ----------------------------------------------------------------
    // One reply, one to MAX_COMMANDS_PER_TURN commands. The single-action shape stays
    // exactly as valid as it ever was — a bare {"action":"wait"} is a complete reply —
    // so this is additive and a model that ignores it loses nothing.
    //
    // Commands run IN ORDER against the live board, which each one changes. That is the
    // honest arrangement: a model that spends its stone on a tower and then orders a
    // wall it can no longer afford is told so, on that command, and keeps the tower.
    // The alternative — validating all three against the state the model read — would
    // let impossible combinations through and lie about what happened.
    executeTurn(controller, envelope) {
        const cmds = this.normalizeCommands(envelope);
        if (!cmds.length) {
            // executeAction returns immediately when there is no "action", so a
            // plan-only envelope would lose its objective there. Taken here instead.
            if (envelope && (envelope.objective !== undefined || envelope.plan !== undefined)) {
                if (typeof envelope.objective === 'string' && envelope.objective.trim()) {
                    controller.objective = envelope.objective.trim();
                }
                if (Array.isArray(envelope.plan) && envelope.plan.length) {
                    controller.plan = envelope.plan.slice(0, OpenAIAIManager.PLAN_MAX_STEPS);
                }
                if (controller._planOnly) { this.registerNoActionReturn(controller); return; }
            }
            this.executeAction(controller, envelope); return;
        }
        if (cmds.length === 1) {
            // Nothing to combine: leave the single-command path byte-for-byte as it was,
            // including its transcript stamp, its feedback wording and its own counting.
            this.executeAction(controller, cmds[0]);
            return;
        }
        // Counted once for the whole turn, before _batch is set — executeAction skips
        // its own count while a batch is running, so this is the only increment.
        if (controller.stats) controller.stats.turnsExecuted++;
        controller._batch = { results: [] };
        try {
            for (const c of cmds) {
                if (this._stopped || controller.defeated) break;
                if (!c || typeof c.action !== 'string' || !c.action.trim()) {
                    // Counted, not skipped in silence. A malformed entry is a real
                    // mistake and the only way the model learns is being told which one.
                    if (controller.stats) controller.stats.invalidActions++;
                    controller._batch.results.push(c && c._unparsed
                        ? '[ERROR] One of your calls could not be parsed, so that action was skipped — the others ran. Send complete arguments per call.'
                        : '[ERROR] Not a command object: an action needs an "action" name as a string.');
                    continue;
                }
                try { this.executeAction(controller, c); }
                catch (err) {
                    console.error('[OpenAIAI] Command failed for ' + controller.id + ':', err);
                    controller._batch.results.push('[ERROR] That command could not be carried out.');
                }
            }
        } finally {
            const results = controller._batch.results;
            controller._batch = null;
            // Numbered, so the model can tell WHICH of its commands failed. An
            // unlabelled list of three answers is a puzzle, not feedback — and the
            // position is the whole point when the second failed because the first
            // spent the resource.
            const combined = results.map((r, i) =>
                'Command ' + (i + 1) + '/' + results.length + ': ' + r).join('\n');
            controller.lastActionResult = combined;
            if (controller.turnLog && controller.turnLog.length) {
                const lastTurn = controller.turnLog[controller.turnLog.length - 1];
                if (lastTurn && lastTurn.outcome == null) lastTurn.outcome = combined;
            }
            try {
                if (this.transcripts) this.transcripts.noteResult(
                    controller.aiPlayer && controller.aiPlayer.id, combined);
            } catch (e) { /* recording must never break a turn */ }
        }
    }

    // What did this reply actually order? Returns [] when the reply carries no command
    // list at all, which means the caller should treat it as the single-action shape.
    normalizeCommands(envelope) {
        if (!envelope || typeof envelope !== 'object') return [];
        const raw = envelope.commands;
        if (!Array.isArray(raw) || !raw.length) return [];
        const out = raw.slice(0, OpenAIAIManager.MAX_COMMANDS_PER_TURN);
        // objective and plan are properties of the TURN, not of any one command, and
        // they are absorbed inside executeAction. Carried onto the first command so a
        // batched reply keeps its standing goal — without this the feature would go
        // silently dead for exactly the models that used the new shape.
        const first = out[0];
        if (first && typeof first === 'object') {
            const carried = Object.assign({}, first);
            if (envelope.objective !== undefined && carried.objective === undefined) carried.objective = envelope.objective;
            if (envelope.plan !== undefined && carried.plan === undefined) carried.plan = envelope.plan;
            out[0] = carried;
        }
        return out;
    }
    executeAction(controller, actionData) {
        const ai = controller.aiPlayer;
        const game = this.game;

        // Counted here rather than in executeTurn so the single-action path — which
        // reaches executeAction directly — is in the denominator too.
        if (controller.stats && !controller._batch) controller.stats.turnsExecuted++;
        if (!actionData || !actionData.action) {
            console.warn(`[OpenAIAI] No action data for ${ai.id}`);
            controller.lastActionResult = `[ERROR] No valid action data received.`;
            return;
        }

        const { action, params } = actionData;
        const civ = getCivilization(ai.civilization);
        const civName = civ?.name || ai.civilization;
        const colorHex = '#' + (civ?.color || 0xffffff).toString(16).padStart(6, '0');
        console.log(`[OpenAIAI] ${ai.id} (${ai.civilization}) executing: ${action}`, params?.reason || '');
        
        // Track action result for feedback
        let actionResult = null;

        // Log the decision (kept as a reference so we can flag it if it fails)
        const logEntry = {
            timestamp: Date.now(),
            playerId: ai.id,
            civName: civName,
            color: colorHex,
            action: action,
            reason: params?.reason || '',
            params: params || {},
            failed: false,
            error: null
        };
        // The log renders this entry's outcome body in the MODEL's language; record
        // which language, and clear any structured outcome from the previous action.
        logEntry.lang = (controller && controller.model && controller.model.language) || 'en';
        this._pendingOutcome = null;
        this.decisionLog.unshift(logEntry);
        // Trim log
        if (this.decisionLog.length > this.maxLogEntries) {
            this.decisionLog = this.decisionLog.slice(0, this.maxLogEntries);
        }

        // Persist the model's standing objective/plan if it set one this turn. These
        // live on the controller and are replayed at the TOP of every prompt, so a
        // multi-step intent (and its surviving sub-goals) outlasts the move history.
        // Wholesale-replace semantics: the model rewrites them when they change.
        //
        // Read from BOTH placements. The prompt called these "params" while its Format
        // line showed only action/params — so models put them beside "action", which is
        // the more natural JSON shape and what every reply in testing did. Reading
        // params.* alone discarded them in silence: no error, no log, the objective
        // simply never existed. This feature had never once fired for those models.
        const src = actionData || {};
        const objRaw = (params && params.objective !== undefined) ? params.objective : src.objective;
        const planRaw = (params && params.plan !== undefined) ? params.plan : src.plan;
        if (typeof objRaw === 'string' && objRaw.trim()) {
            controller.objective = objRaw.trim().slice(0, 300);
        }
        // A plan sent as one string is kept as a single step rather than dropped. Its
        // intent is unambiguous; splitting "[1] a, [2] b" into steps would be the
        // harness inventing structure the model did not commit to.
        const planArr = Array.isArray(planRaw) ? planRaw
            : (typeof planRaw === 'string' && planRaw.trim()) ? [planRaw] : null;
        if (planArr) {
            controller.plan = planArr
                .filter(s => typeof s === 'string' && s.trim())
                .slice(0, OpenAIAIManager.PLAN_MAX_STEPS)
                .map(s => s.trim().slice(0, 120));
        }

        // Behavior metrics: count the attempted action
        if (controller.stats) {
            const st = controller.stats;
            st.actionsAttempted++;
            // Key by a STRING always. An object here was used as a key directly, so a
            // model that sent {"action":{"type":"assign_workers",...}} put a chip
            // reading "[object Object]" in the results next to the real actions — a
            // shape error wearing the costume of an action the game has.
            st.actionCounts[typeof action === 'string' ? action : '(malformed)'] =
                (st.actionCounts[typeof action === 'string' ? action : '(malformed)'] || 0) + 1;
            // Counted as ATTEMPTED, matching actionCounts — the eco/military split is
            // about what the model chose to do, not whether it could afford it.
            if (action === 'train_unit' && String(params && params.unitType).toLowerCase() === 'worker') {
                st.workersTrained++;
            }
            if (params && typeof params.reason === 'string' && params.reason.trim()) st.reasonsGiven++;
        }

        switch (action) {
            case 'train_unit':
                if (params?.unitType) {
                    actionResult = this.executeTrainUnit(ai, game, params.unitType, params || {});
                } else {
                    actionResult = `[ERROR] train_unit requires "unitType" parameter.`;
                }
                break;

            case 'research_tech':
                if (params?.techId) {
                    actionResult = this.executeResearchTech(ai, game, params.techId);
                } else {
                    actionResult = `[ERROR] research_tech requires "techId" parameter.`;
                }
                break;

            case 'upgrade_age':
                actionResult = this.executeUpgradeAge(ai, game);
                break;

            case 'build_structure':
                if (params?.buildingType) {
                    actionResult = this.executeBuildStructure(ai, game, params.buildingType, params?.targetX, params?.targetZ);
                } else {
                    actionResult = `[ERROR] build_structure requires "buildingType" parameter.`;
                }
                break;

            case 'move_units':
                if (params?.targetX !== undefined && params?.targetZ !== undefined) {
                    actionResult = this.executeMoveUnits(ai, game, params.units, params.targetX, params.targetZ, params.unitIds, params.matchSpeed, params.formation);
                } else {
                    actionResult = `[ERROR] move_units requires "targetX" and "targetZ" parameters.`;
                }
                break;

            case 'attack_target':
                if (params?.targetId) {
                    actionResult = this.executeAttackTarget(ai, game, params.targetId, params.units, params.unitIds, params.matchSpeed, params.formation);
                } else if (params?.targetX !== undefined && params?.targetZ !== undefined) {
                    actionResult = this.executeAttackPosition(ai, game, params.targetX, params.targetZ, params.units, params.unitIds, params.matchSpeed, params.formation);
                } else {
                    actionResult = `[ERROR] attack_target requires "targetId" or ("targetX" and "targetZ") parameters.`;
                }
                break;

            case 'assign_workers':
                actionResult = this.executeAssignWorkers(ai, game, params || {});
                break;

            case 'repair_building':
                actionResult = this.executeRepairBuilding(ai, game, params || {});
                break;

            case 'explore':
                actionResult = this.executeExplore(ai, game, params || {});
                break;

            case 'delete_unit':
                actionResult = this.executeDeleteUnit(ai, game, params || {});
                break;

            case 'destroy_building':
                if (params?.buildingType) {
                    actionResult = this.executeDestroyBuilding(ai, game, params.buildingType, params?.targetX, params?.targetZ);
                } else {
                    actionResult = `[ERROR] destroy_building requires "buildingType" parameter.`;
                }
                break;

            case 'wait':
                actionResult = `OK - Waited this turn.`;
                break;

            default: {
                // The commonest miss by far: the model copies the action list's
                // notation into the JSON — "wait()" rather than "wait". The name is
                // right and only the punctuation is wrong, so say exactly that
                // instead of a flat "unknown", which reads as "that action does not
                // exist" and sends a model hunting for a different one.
                // An object here means the reply was wrapped one level too deep — the
                // whole action put in "action", or a bare params bag. "[object Object]"
                // told the model none of that and sent it looking for a different action
                // name, which was never the problem.
                if (action && typeof action === 'object') {
                    const inner = !Array.isArray(action) && typeof action.action === 'string' ? action.action : null;
                    const type = !Array.isArray(action) && typeof action.type === 'string' ? action.type : null;
                    actionResult = `[ERROR] "action" must be the action NAME as a string, not ${Array.isArray(action) ? 'an array' : 'an object'}. `
                        + (inner ? `You nested the whole reply inside it — send {"action":"${inner}","params":{...}} at the top level. `
                           : type ? `You sent {"type":"${type}",...} — the key is "action", and its parameters go in "params". `
                           : `Send {"action":"<name>","params":{...}}. `)
                        + `Received: ${JSON.stringify(action).slice(0, 120)}`;
                    break;
                }
                const bare = String(action).replace(/\s*\(.*\)\s*$/, '').trim();
                const KNOWN = ['train_unit', 'research_tech', 'upgrade_age',
                    'build_structure', 'assign_workers',
                    'repair_building', 'explore', 'move_units', 'attack_target',
                    'delete_unit', 'destroy_building', 'wait'];
                actionResult = (bare !== action && KNOWN.includes(bare))
                    ? `[ERROR] Unknown action "${action}". You meant "${bare}" — the "action" value is the bare name with NO brackets or parameter list. Send {"action":"${bare}","params":{...}} and put the parameters in "params".`
                    : `[ERROR] Unknown action: ${action}. Valid actions: ${KNOWN.join(', ')}.`;
                break;
            }
        }

        // Safety net: EVERY action must yield a feedback string so the model always
        // learns the outcome and can't silently repeat a no-op. If a handler ever
        // returns nothing, synthesize a result instead of dropping it (which would
        // leave the model with no idea its command did anything).
        if (actionResult == null || actionResult === '') {
            actionResult = `[ERROR] Action "${action}" produced no result.`;
        }

        // Behavior metrics + flag the log entry if the action was rejected.
        // _pendingOutcome is cleared at the top of this method and not consumed until
        // below, so the code read here always belongs to THIS action.
        if (actionResult) {
            const rejected = actionResult.startsWith('[ERROR]');
            const code = String((this._pendingOutcome && this._pendingOutcome.code) || '')
                .replace(/^log\.out\./, '');
            if (controller.stats) {
                const st = controller.stats;
                if (rejected) {
                    // "not a string" is an invented shape rather than an invented name,
                    // but both are the model failing to produce a callable action, and
                    // neither is a rejected game move. Same bucket.
                    if (/Unknown action/i.test(actionResult)
                        || /must be the action NAME as a string/i.test(actionResult)) st.invalidActions++;
                    else if (OpenAIAIManager.UNFOREWARNED.has(code)) st.actionsContended++;
                    else st.actionsRejected++;
                } else {
                    st.actionsSucceeded++;
                }
            }
            if (rejected) {
                logEntry.failed = true;
                logEntry.error = actionResult.replace(/^\[ERROR\]\s*/, '');
            }
        }

        // Store a COMPACT, human-readable record of this decision for the feedback
        // loop: the action, the model's own stated reason, and the outcome. One
        // short sentence per move keeps a long history affordable
        // while preserving the "why" across a multi-step plan.
        if (actionResult) {
            logEntry.result = actionResult; // so the spectator log can show the outcome
            // Attach the structured outcome a covered handler recorded, for the log's
            // model-language rendering (the English `result`/`error` remain the fallback).
            if (this._pendingOutcome) {
                logEntry.outcomeCode = this._pendingOutcome.code;
                logEntry.outcomeParams = this._pendingOutcome.params;
                this._pendingOutcome = null;
            }
            controller.conversationHistory.push({
                action: action,
                reason: (params && params.reason) ? String(params.reason) : '',
                result: actionResult,
                failed: !!logEntry.failed
            });
            // Retain a deep history (bounded for memory). How MUCH of it is actually
            // sent each turn is decided at request time by the model's context budget
            // (buildMoveHistoryText), not by this cap.
            if (controller.conversationHistory.length > this.maxHistoryEntries) {
                controller.conversationHistory = controller.conversationHistory.slice(-this.maxHistoryEntries);
            }
            controller.lastActionResult = actionResult;
            // One command of several: executeTurn owns the turn-level bookkeeping and
            // stamps the combined answer once at the end. noteResult SEALS the turn, so
            // a second call here would find nothing open and commands 2 and 3 would
            // vanish from the transcript without a word.
            if (controller._batch) { controller._batch.results.push(actionResult); return; }
            // Attach this outcome to the matching rolling-history turn (Option C) so the
            // multi-turn replay shows the result of each past decision, not just the
            // decision — otherwise the model can't tell a command keeps being rejected.
            if (controller.turnLog && controller.turnLog.length) {
                const lastTurn = controller.turnLog[controller.turnLog.length - 1];
                if (lastTurn && lastTurn.outcome == null) lastTurn.outcome = actionResult;
            }
            // Same for the transcript: the harness's answer is the other half of the
            // exchange, and it arrives after the reply was recorded.
            try {
                if (this.transcripts) this.transcripts.noteResult(
                    controller.aiPlayer && controller.aiPlayer.id, actionResult);
            } catch (e) { /* recording must never break a turn */ }
        }
    }


    // ----------------------------------------------------------------
    // 12b. The last word
    // ----------------------------------------------------------------
    // One closing question per seat, asked once: when it is knocked out, or when the
    // match ends for whoever is still standing. Its answer is recorded and nothing else
    // — it is never parsed, never executed, and never scored.
    //
    // Not scored is the whole point, and it cuts both ways. A model that writes a
    // paragraph of reflection must not be charged for the tokens in its format fidelity,
    // and a model that answers a farewell with one more attack order must not be charged
    // for an action that could never have run. Both are worth reading; only one of them
    // is a sentence. So this path touches controller.stats nowhere at all.
    //
    // Deliberately NOT announced in the system prompt. A model meeting this question
    // cold tells you more than one that has been told to expect it — and it keeps the
    // prompt, and its version, exactly where they were.
    // What this seat lived through, for the closing question only.
    //
    // A defeated player is handed a snapshot of its own wreckage and nothing else, and
    // models read that as never having started. In one match three of four wrote
    // exactly that -- one of them while it had commanded a 59-unit army twenty minutes
    // earlier, and another while six of its buildings were still standing. The state is
    // honest; it is just the last frame of a film nobody was shown.
    //
    // Its OWN history only. Naming what the rivals had would be omniscience it never
    // scouted, and a post-mortem written from what a player actually knew is worth more
    // than one written from our records -- "I was fighting partially blind" is a real
    // observation, and it only appears if the model is reasoning from its own view.
    //
    // Nothing here is scored: the closing word carries no weight in any metric.
    matchHistoryText(controller, ai) {
        const tl = this.game && this.game._timeline;
        const mmss = v => Math.floor(v / 60) + ':' + String(Math.max(0, Math.round(v % 60))).padStart(2, '0');
        // Models quote our wording back verbatim, so '1 buildings' would end up in a
        // published post-mortem.
        const pl = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
        const pk = controller && controller._peak;
        const lines = [];
        if (pk && (pk.buildings || pk.units)) {
            lines.push(`- Peak: ${pl(pk.buildings, 'building')}, ${pl(pk.units, 'unit')}, ${pl(pk.workers, 'worker')}`
                + (pk.pop ? `, population ${pk.pop}/${pk.maxPop || '?'}` : '')
                + ` \u2014 around ${mmss(pk.at || 0)}.`);
        }
        lines.push(`- At the end: ${pl((ai.buildings || []).length, 'building')}, ${pl((ai.units || []).length, 'unit')}.`);
        if (tl) {
            const ages = (tl.ages || []).filter(e => e.id === ai.id);
            lines.push(ages.length
                ? `- Ages reached: ${ages.map(e => `${e.age} at ${mmss(e.t)}`).join(', ')}.`
                : `- Ages reached: none \u2014 you finished in the ${ai.age} age you started in.`);
            const won = (tl.wonders || []).filter(e => e.id === ai.id);
            if (won.length) lines.push(`- Your Wonder: ${won.map(e => `${e.event} at ${mmss(e.t)}`).join(', ')}.`);
            const dry = (tl.exhausted || []).filter(e => e.id === ai.id);
            if (dry.length) lines.push(`- Your discovered nodes ran out: ${dry.map(e => `${e.type} at ${mmss(e.t)}`).join(', ')}.`);
        }
        if (!lines.length) return '';
        return 'YOUR MATCH IN NUMBERS \u2014 you lived through this; the state above is only the final moment.\n'
            + lines.join('\n');
    }

    async askFinalWord(controller, kind, extra) {
        if (!controller || controller._finalWordAsked) return null;
        controller._finalWordAsked = true;
        const model = controller.model, ai = controller.aiPlayer;
        if (!model || !ai || !model.endpoint) return null;

        // The board it is looking at as it answers. A bare "you lost" invites a bare
        // reply; the state it lost ON is what makes the answer worth keeping.
        //
        // Kept as the OBJECT as well as the rendered text. The model has always been
        // shown this -- it is why a closing statement can quote its own final food pile
        // to the last digit -- but it was rendered, sent and dropped, so the transcript
        // ended at the last MOVE and the analyzer's final frame was a board minutes
        // short of the ending it is captioned with. Recording it costs one state per
        // seat, once, and makes the last frame the actual last frame.
        let stateText = '', stateJson = null;
        try {
            stateJson = this.buildGameStateJSON(controller);
            stateText = this.buildCompactState(stateJson) || '';
        }
        catch (e) { /* a closing question is not worth failing over */ }

        // The civ ID, not getCivilization().name: that name is the German source string
        // ("Ägypter"), while ai.civilization is exactly what the model has been reading
        // in you.civilization all match. Model-facing text uses the identifier the model
        // holds — the same reason ownerName answers with the seat id.
        const who = ai.civilization;
        const head = (kind === 'defeated')
            ? `THE MATCH IS OVER FOR YOU. You have been defeated as ${who}: your Town Centers and the means to rebuild them are gone.`
            : `THE MATCH HAS ENDED. ${extra && extra.won ? `You WON as ${who}.` : `You did not win. ${extra && extra.winner ? `${extra.winner} took it.` : ''}`}`;
        const ask = [head,
            'This is the final message you will receive; the game is closing and NOTHING you reply will be executed.',
            'No action is expected and none will be carried out. There is nothing to play for and nothing to score.',
            'If you have anything to say about how this went — what you were trying to do, what beat you, what you would',
            'do differently — say it now, in your own words. Answer however you like.'].join(' ');
        const history = this.matchHistoryText(controller, ai);
        const turns = [{ role: 'user',
            content: (stateText ? stateText + '\n\n' : '') + (history ? history + '\n\n' : '') + ask }];

        const provider = OpenAIAIManager.resolveProvider(model);
        const auth = model.auth || (model.apiKey ? { type: 'bearer', key: model.apiKey } : { type: 'none' });
        let headers;
        try { headers = await OpenAIAIManager.buildAuthHeaders(auth, provider); }
        catch (e) { headers = { 'Content-Type': 'application/json' }; }
        const reqOpts = Object.assign({
            temperature: model.temperature, topP: model.topP, topK: model.topK,
            reasoning: model.reasoning, extraBody: model.extraBody,
            maxTokens: model.maxTokens, numCtx: model.contextSize
        }, model._reqOpts || {});
        const req = OpenAIAIManager.buildChatRequest(
            provider, model.endpoint, model.model || 'default', this.buildSystemPrompt(ai), turns, reqOpts);

        // Its OWN abort handle, NOT controller._abort. endArena calls stop() immediately,
        // which aborts whatever handle each controller holds — hanging this on the same
        // one would have it cancel itself at exactly the moment it is asked.
        const abort = new AbortController();
        // Reachable from outside, so the wait can be abandoned. The handle was private
        // and the only way out was the timeout, which is the right bound for an ending
        // somebody wanted and far too long for one they are escaping.
        (this._finalWordAborts || (this._finalWordAborts = [])).push(abort);
        const timer = setTimeout(() => abort.abort(), this.finalWordTimeoutMs());
        const t0 = Date.now();
        let text = '', tokens = null, error = null;
        try {
            const res = await fetch(req.url, {
                method: 'POST', headers,
                body: JSON.stringify(req.body), signal: abort.signal
            });
            if (!res.ok) {
                error = 'HTTP ' + res.status;
            } else {
                const data = await res.json();
                const norm = OpenAIAIManager.normalizeResponse(provider, data);
                text = String((norm && (norm.content || norm.reasoning)) || '').trim();
                // extractUsage, not norm.usage: field names differ per provider and that
                // static is where the mapping already lives (input_tokens, promptTokenCount,
                // prompt_tokens...). Reading norm.usage recorded null for every provider.
                tokens = OpenAIAIManager.extractUsage(provider, data) || null;
            }
        } catch (e) {
            error = (e && e.name === 'AbortError') ? 'no answer within '
                + Math.round(this.finalWordTimeoutMs() / 1000) + 's' : String(e && e.message || e);
        } finally {
            clearTimeout(timer);
        }

        // On file as a MARKER, like a missed round: note() appends without touching the
        // turn counter, so a closing statement can never be mistaken for a move or
        // inflate the decision count. finish() writes the tail under its own key and
        // exportBlob orders header -> turns -> tail, so this lands in the right place
        // whether it arrives before or after the summary.
        try {
            if (this.transcripts) {
                this.transcripts.note(ai.id, {
                    type: 'final_word', kind, at: Date.now(),
                    latencyMs: Date.now() - t0,
                    outcome: (kind === 'defeated') ? 'defeated' : ((extra && extra.won) ? 'won' : 'lost'),
                    text: text || null, tokens: tokens || null, error: error || null,
                    // Same shape and same key as every turn's snapshot, so anything that
                    // already reads a state off a record reads this one without knowing
                    // it is the last.
                    state: stateJson || null,
                    // The seconds this board is FROM. A final_word is not a turn and
                    // carries no turn number, so without this the analyzer can only file
                    // it at the moment the request returned -- which is however long the
                    // model took to write its closing statement, not when the match ended.
                    matchSeconds: (stateJson && stateJson.clock && stateJson.clock.matchSeconds != null)
                        ? stateJson.clock.matchSeconds : null
                });
            }
        } catch (e) { /* recording must never break the ending */ }

        // Keep it for the summary. It went to the transcript and nowhere else, so the
        // only way to read a model's last word was to export the match and open the
        // analyzer -- for the one screen everybody actually looks at, at the moment they
        // are most curious about it. endArena now waits for these before showing the
        // summary, so it is on hand by the time the cards render.
        controller._finalWord = {
            text: text || null,
            outcome: (kind === 'defeated') ? 'defeated' : ((extra && extra.won) ? 'won' : 'lost'),
            error: error || null
        };

        if (text) {
            console.log(`[OpenAIAI] final word from ${ai.id}: ${text.slice(0, 200)}`);
            const c2 = getCivilization(ai.civilization);
            this.decisionLog.unshift({
                timestamp: Date.now(), playerId: ai.id,
                civName: (c2 && c2.name) || ai.civilization,
                color: '#' + (((c2 && c2.color) ?? 0xffffff)).toString(16).padStart(6, '0'),
                action: 'final_word', reason: text.slice(0, 400), params: {}, failed: false,
                lang: model.language
            });
            if (this.decisionLog.length > this.maxLogEntries) this.decisionLog = this.decisionLog.slice(0, this.maxLogEntries);
        }
        return text || null;
    }

    // Ask every seat that has not been asked yet. Returns a promise so a caller can
    // wait, but nothing has to: the recorder places a late answer correctly either way.
    // Drop every closing question still in flight. Used when a match is ended because
    // an endpoint is misbehaving: the answers are not worth waiting on precisely
    // because the thing being asked is the thing that is broken.
    cancelFinalWords() {
        const list = this._finalWordAborts || [];
        this._finalWordAborts = [];
        list.forEach(a => { try { a.abort(); } catch (e) { /* already settled */ } });
        return list.length;
    }

    collectFinalWords(reason, winnerAi, onProgress) {
        const pend = (this.aiControllers || []).filter(c => c && !c._finalWordAsked);
        const total = pend.length;
        let done = 0;
        // Fired once up front with (0, total) so a caller can decide whether there is
        // anything worth showing a wait for at all -- an all-rule-based match asks
        // nobody, and a note about closing statements would be a lie there.
        const tick = () => { if (onProgress) { try { onProgress(done, total); } catch (e) {} } };
        tick();
        const jobs = pend.map(c => {
            const won = !!(winnerAi && c.aiPlayer === winnerAi);
            const winner = winnerAi ? this.game.ownerName(winnerAi) : null;
            return this.askFinalWord(c, 'ended', { won, winner, reason })
                .catch(e => { console.warn('[OpenAIAI] final word failed', e); return null; })
                .then(v => { done++; tick(); return v; });
        });
        return Promise.all(jobs);
    }
    // ----------------------------------------------------------------
    // 12. Action implementations
    // ----------------------------------------------------------------
    // Advice tailored to whether houses can still help or the hard cap is reached.
    popCapAdvice(ai) {
        const cap = (typeof MAX_POPULATION_CAP !== 'undefined') ? MAX_POPULATION_CAP : 100;
        if (ai.resources.maxPopulation >= cap) {
            return `Hard population cap ${cap} reached; houses and Town Centers do not raise it further. delete_unit frees a slot.`;
        }
        return `maxPopulation is raised by houses (+5) and Town Centers (+10), to a hard cap of ${cap}. delete_unit frees a slot.`;
    }

    // Log the population rejection with the RIGHT advice: at the hard cap, houses
    // and Town Centers are useless and only delete_unit frees a slot. Mirrors the
    // branch in popCapAdvice above so the log never contradicts what the model was
    // told. (The localized log line used to flatten both cases into "build houses",
    // which read as bad advice at 100/100 even though the model's English text was
    // correct.)
    popCapOutcome(ai) {
        const cap = (typeof MAX_POPULATION_CAP !== 'undefined') ? MAX_POPULATION_CAP : 100;
        const hard = ai.resources.maxPopulation >= cap;
        this.outcome(hard ? 'log.out.populationHardCap' : 'log.out.populationLimit',
            { pop: Math.floor(ai.resources.population), max: ai.resources.maxPopulation, cap });
    }

    // Pick which finished, non-busy building actually trains the unit. If the model
    // gave params.targetX/targetZ, prefer the FREE trainer nearest that spot — so it
    // can direct production to a specific structure (a 2nd Town Center by a far
    // resource, a particular barracks…). If the structure nearest those coords is
    // busy, fall back to the next free one and say so. No coords → first free.
    chooseTrainer(freeList, finishedOfType, params) {
        const tx = Number(params && params.targetX), tz = Number(params && params.targetZ);
        if (!Number.isFinite(tx) || !Number.isFinite(tz)) return { b: freeList[0], note: '' };
        const nearestIn = (list) => list.reduce((best, b) => {
            const d = Math.hypot(b.x - tx, b.z - tz);
            return (!best || d < best.d) ? { b, d } : best;
        }, null);
        const chosen = nearestIn(freeList);
        const requested = nearestIn(finishedOfType);
        const redirected = requested && chosen && requested.b !== chosen.b && requested.b.isProducing;
        return { b: chosen.b, note: redirected ? ' (the structure nearest your coordinates was busy, so the next free one was used)' : '' };
    }

    // Every trainable thing comes through here, villagers included. A worker is a unit
    // whose building happens to be the Town Center, and the validation chain below
    // already read it that way — requiredBuildingForUnit('worker') has always returned
    // 'town_center' and buildingTrains() has always accepted it there.
    executeTrainUnit(ai, game, unitType, params = {}) {
        const civ = getCivilization(ai.civilization);
        const unitDef = getUnitDefFor(ai.civilization, unitType);
        if (!unitDef) {
            console.log(`[OpenAIAI] ${ai.id}: Unknown unit type "${unitType}"`);
            this.outcome('log.out.unknownUnit', { unitType });
            // Categories are legal in the "units" parameter of move_units/attack_target
            // but never here, and only "cavalry" happens to also be a real id — so a
            // model that generalised from {"cavalry":5} lands on "infantry" and used to
            // get back nothing at all. Name the whole vocabulary instead.
            // A model that has read move_units/attack_target sometimes brings their
            // {"type": count} map here, and "[object Object]" told it nothing about what
            // it had done. Name the shape and the one id it clearly meant.
            if (unitType && typeof unitType === 'object') {
                const keys = Array.isArray(unitType) ? unitType : Object.keys(unitType);
                const first = keys.length ? String(keys[0]) : null;
                this.outcome('log.out.unknownUnit', { unitType: first || 'object' });
                return `[ERROR] "unitType" must be ONE unit id as a string, not ${Array.isArray(unitType) ? 'an array' : 'an object'}. `
                    + (first ? `You sent ${JSON.stringify(unitType)} — send "unitType": "${first}" and put how many in "count" if you need more than one. ` : '')
                    + `The {"type": count} shape belongs to "units" in move_units and attack_target, never here. ${this.trainableListString(ai)}`;
            }
            const cats = ['infantry', 'ranged', 'cavalry', 'support'];
            const catNote = cats.includes(String(unitType).toLowerCase())
                ? ` "${unitType}" is a unit CATEGORY: those work only in the "units" parameter of move_units/attack_target, never in train_unit, which needs one exact unit id.`
                : '';
            // "militia(stone)" — the age carried along from the state listing. Name
            // the bare id rather than making the model work it out.
            const stripped = String(unitType).replace(/\s*\(.*\)\s*$/, '').trim();
            const parenNote = (stripped !== String(unitType) && getUnitDefFor(ai.civilization, stripped))
                ? ` Pass just "${stripped}" — "units.trainable" groups ids under the age they need; the age is not part of the id.`
                : '';
            return `[ERROR] Unknown unit type "${unitType}".${catNote}${parenNote} ${this.trainableListString(ai)} See "units.trainable" and "units.blocked" for the age each one needs.`;
        }

        const ageOrder = ['stone', 'neolithic', 'bronze', 'iron'];
        const reqB = this.requiredBuildingForUnit(unitType, ai.civilization); // 'barracks' | 'stable' | 'archery_range' | 'temple' | null
        const rightType = (b) => reqB ? (b.type === reqB) : false;

        // Validation follows the advancement chain so the message always points at
        // the EARLIEST unmet step: Research → Build → Advance → Population → Resources.
        if (reqB) {
            const finishedOfType = ai.buildings.filter(b => rightType(b) && !b.underConstruction);

            // 1) RESEARCH / BUILD: no finished building of the right type yet.
            if (finishedOfType.length === 0) {
                if (ai.buildings.some(b => rightType(b) && b.underConstruction)) {
                    this.outcome('log.out.buildingUnderConstr', { building: reqB, unitType });
                    return `[ERROR] ${reqB}: still under construction.`;
                }
                // Owning no Town Center is not the same as not having got round to a
                // barracks yet: it ends worker production outright, and the way back is
                // a build order an EXISTING worker has to carry out. The generic
                // "you have not built one yet" below would bury all of that.
                if (reqB === 'town_center') {
                    const tcDef = (typeof getBuildingDef === 'function') ? getBuildingDef('town_center') : null;
                    const costStr = tcDef ? this.costString(tcDef.cost) : '100 food, 100 wood, 100 stone, 100 gold';
                    this.outcome('log.out.noTCTrain', {});
                    return `[ERROR] worker: requires a Town Center. You have none. town_center costs ${costStr}.`;
                }
                const bdef = getBuildingDef(reqB);
                const tech = bdef && bdef.requiresTech;
                const civTree = civ.techTree || {};
                if (tech && !civTree[tech]) {
                    this.outcome('log.out.civCannotTrain', { unitType, building: reqB });
                    return `[ERROR] Your civilization cannot train ${unitType} — it has no ${reqB} (no "${tech}" technology). Train a different unit class (barracks=infantry, archery_range=archers, stable=cavalry; see "buildableStructures").`;
                }
                if (tech && !ai.researchedTechs[tech]) {
                    this.outcome('log.out.unitBuildingNotUnlocked', { unitType, building: reqB, tech });
                    return `[ERROR] ${unitType}: requires ${reqB}, not unlocked. Prerequisite: tech "${tech}".`;
                }
                this.outcome('log.out.unitBuildingNotBuilt', { unitType, building: reqB });
                return `[ERROR] ${unitType}: requires ${reqB}, not built.`;
            }

            // 2) ADVANCE: the building exists but the unit is gated to a later epoch.
            if (!this.buildingTrains(finishedOfType[0], unitType, ai.age, ai.civilization)) {
                const minAge = this.minAgeForUnit(unitType);
                if (minAge && ageOrder.indexOf(minAge) > ageOrder.indexOf(ai.age)) {
                    this.outcome('log.out.unitNeedsAge', { unitType, minAge, age: ai.age });
                    return `[ERROR] ${unitType}: requires ${minAge} age. Current age: ${ai.age}.`;
                }
                this.outcome('log.out.buildingCannotTrainTier', { building: reqB, unitType });
                return `[ERROR] Your ${reqB} cannot train ${unitType} at your current tier. Check what it can produce for your age.`;
            }
        }

        // From here a finished, age-capable building exists. Trainers for this unit:
        const trainers = ai.buildings.filter(b => !b.underConstruction && this.buildingTrains(b, unitType, ai.age, ai.civilization));
        if (trainers.length === 0) {
            // Only reached for unique units with no tier mapping (reqB null).
            this.outcome('log.out.noBuildingTrains', { unitType });
            return `[ERROR] ${unitType}: no finished building can train it. Trained at: barracks (infantry), archery_range (archers), stable (cavalry), temple (priest).`;
        }

        // 3) POPULATION (structural train-time gate).
        if (ai.resources.population >= ai.resources.maxPopulation) {
            console.log(`[OpenAIAI] ${ai.id}: Population limit reached (${ai.resources.population}/${ai.resources.maxPopulation})`);
            this.popCapOutcome(ai);
            return `[ERROR] Population limit reached (${ai.resources.population}/${ai.resources.maxPopulation}). ${this.popCapAdvice(ai)}`;
        }

        // 4) BUSY: a trainer exists but all are mid-production (transient).
        const freeTrainers = trainers.filter(b => !b.isProducing);
        if (freeTrainers.length === 0) {
            const tName = trainers[0].type;
            this.outcome('log.out.trainerBusy', { building: tName });
            return `[ERROR] ${tName}: all busy producing.`;
        }

        // 5) RESOURCES.
        if (!ai.resources.hasResources(unitDef.cost)) {
            console.log(`[OpenAIAI] ${ai.id}: Cannot afford ${unitType}`);
            this.outcome('log.out.cannotAfford', { whatName: unitDef.name, need: unitDef.cost, have: this.haveObj(ai) });
            return `[ERROR] Cannot afford ${unitType} (needs ${this.costString(unitDef.cost)}). You have ${this.haveString(ai)}.`;
        }

        // TRAIN — at the structure the model targeted (params.targetX/Z), else the
        // first free one; a busy targeted structure falls back to the next free.
        const { b: free, note } = this.chooseTrainer(freeTrainers, trainers, params);
        ai.resources.spendResources(unitDef.cost);
        free.isProducing = true;
        free.productionType = unitType;
        free.productionDuration = 5000;
        free.productionProgress = 0;
        console.log(`[OpenAIAI] ${ai.id}: Training ${unitType} at ${free.name} (${Math.round(free.x)}, ${Math.round(free.z)})`);
        this.outcome('log.out.trainUnit', { unitName: unitDef.name, x: Math.round(free.x), z: Math.round(free.z) });
        // free.type, not free.name: name is the LOCALISED display string, so this line
        // was handing models "at Dorfzentrum" while every other message about the same
        // building — including the busy error two steps up — calls it "town_center".
        // The type is the id the model already reads in trainableUnits and writes in
        // build_structure, so it is the one word that is copyable in both directions.
        return `OK - Training ${unitType} at ${free.type} (${Math.round(free.x)}, ${Math.round(free.z)}) (~${this.realSecs(free.productionDuration || 5000)}s to produce; that building is busy until it finishes).${note}`;
    }

    // Six techs used to be camelCase while every other identifier in the game -- ten
    // buildings, eleven units, twenty other techs -- joined its words with an
    // underscore. One namespace, two spellings, and the only way to know which applied
    // to a given word was to have seen it. Renamed; the old spellings still resolve, so
    // a model that learned them from an older transcript is not punished for our
    // inconsistency. Same courtesy the formation rename got.
    static get TECH_ALIASES() {
        return { ironWorking: 'iron_working', cavalryTraining: 'cavalry_training',
                 bronzeArmor: 'bronze_armor', cavalryArmor: 'cavalry_armor',
                 lamellarArmor: 'lamellar_armor', phalanxArmor: 'phalanx_armor' };
    }

    executeResearchTech(ai, game, techId) {
        const civ = getCivilization(ai.civilization);
        techId = OpenAIAIManager.TECH_ALIASES[techId] || techId;
        const tech = civ?.techTree?.[techId];
        if (!tech) {
            console.log(`[OpenAIAI] ${ai.id}: Unknown tech "${techId}"`);
            const ageOrder = ['stone', 'neolithic', 'bronze', 'iron'];
            const nextAge = ageOrder[ageOrder.indexOf(ai.age) + 1] || null;
            const ageNote = nextAge
                ? ` To advance to the next age use upgrade_age (NOT research_tech) — your next epoch is "${nextAge}" (see "epoch.nextEpoch"/"epoch.nextEpochCost").`
                : ` You are already in the final age ("${ai.age}").`;
            // Age transitions ("NeolithicToBronze", "advance_to_bronze", …) are not
            // techs. No word boundaries — they don't fire inside camelCase or across "_".
            const ageLike = /age|epoch|advance|stone|neolithic|bronze|iron/i.test(String(techId));
            if (ageLike) {
                this.outcome('log.out.notAResearchTech', { techId });
                return `[ERROR] "${techId}" is not a research tech — advancing AGES is a separate action.${ageNote} For actual technologies, use an exact ID from "research.available".`;
            }
            // Building names are the other near-miss. Several unlock techs ARE named
            // after their building (house, farm, barracks, academy), which teaches the
            // pattern — so a model reaches for "stable" or "temple" too, where the
            // tech is called something else entirely or does not exist. The age branch
            // above has caught its own near-miss for a while; this is the same idea.
            const asBuilding = (typeof getBuildingDef === 'function') ? getBuildingDef(String(techId)) : null;
            if (asBuilding) {
                const need = asBuilding.requiresTech;
                const how = need
                    ? (civ?.techTree?.[need]
                        ? `Its unlock tech is "${need}" — research that, then build_structure "${techId}".`
                        : `Your civilization has no tech for it, so it cannot build a ${techId}.`)
                    : `It needs no tech — build_structure "${techId}" directly (check its age in "buildableStructures").`;
                this.outcome('log.out.techIsBuilding', { techId, need: need || '-' });
                return `[ERROR] "${techId}" is a BUILDING, not a technology. ${how} See "buildableStructures" for the age and unlock tech of every structure.`;
            }
            this.outcome('log.out.unknownTech', { techId });
            return `[ERROR] Unknown tech "${techId}". Use an exact tech ID from "research.available".${ageNote}`;
        }

        if (ai.researchedTechs[techId]) {
            console.log(`[OpenAIAI] ${ai.id}: Tech "${techId}" already researched`);
            this.outcome('log.out.alreadyResearched', { techId });
            return `[ERROR] Tech "${techId}" already researched! Check "research.researched" list before researching.`;
        }

        if (ai.currentResearch) {
            console.log(`[OpenAIAI] ${ai.id}: Already researching a tech`);
            this.outcome('log.out.alreadyResearching', { techId: ai.currentResearch.techId });
            return `[ERROR] research_tech: "${ai.currentResearch.techId}" already running. One at a time; secondsRemaining in "research.current".`;
        }

        // Check age requirement
        const ageOrder = ['stone', 'neolithic', 'bronze', 'iron'];
        if (ageOrder.indexOf(tech.requiredAge) > ageOrder.indexOf(ai.age)) {
            console.log(`[OpenAIAI] ${ai.id}: Tech "${techId}" requires ${tech.requiredAge}`);
            this.outcome('log.out.techNeedsAge', { techId, reqAge: tech.requiredAge, age: ai.age });
            return `[ERROR] ${techId}: requires ${tech.requiredAge} age. Current age: ${ai.age}.`;
        }

        // Check prerequisites
        if (tech.requires) {
            for (const req of tech.requires) {
                if (!ai.researchedTechs[req]) {
                    console.log(`[OpenAIAI] ${ai.id}: Missing prerequisite "${req}" for "${techId}"`);
                    this.outcome('log.out.missingPrereq', { req, techId });
                    return `[ERROR] ${techId}: unmet prerequisite "${req}".`;
                }
            }
        }

        // Check we have the FINISHED building this tech is researched at —
        // generic, so temple research works like town_center and academy.
        const hostType = tech.researchAt || 'town_center';
        if (!ai.buildings.some(b => b.type === hostType && !b.underConstruction)) {
            console.log(`[OpenAIAI] ${ai.id}: Need a finished ${hostType} to research "${techId}"`);
            if (hostType === 'academy') {
                this.outcome('log.out.researchedElsewhere', { techName: tech.name, hostName: (getBuildingDef(hostType) || {}).name || hostType });
                return `[ERROR] ${techId}: researched at ${hostType}. None finished.`;
            }
            this.outcome('log.out.researchedElsewhere', { techName: tech.name, hostName: (getBuildingDef(hostType) || {}).name || hostType });
            return `[ERROR] ${techId}: researched at ${hostType}. None finished.`;
        }

        const costMultiplier = ai.techCostMultiplier || 1;
        const adjustedCost = {
            food: Math.floor((tech.cost.food || 0) * costMultiplier),
            wood: Math.floor((tech.cost.wood || 0) * costMultiplier),
            stone: Math.floor((tech.cost.stone || 0) * costMultiplier),
            gold: Math.floor((tech.cost.gold || 0) * costMultiplier)
        };

        if (!ai.resources.hasResources(adjustedCost)) {
            console.log(`[OpenAIAI] ${ai.id}: Cannot afford tech "${techId}"`);
            this.outcome('log.out.cannotAfford', { whatName: tech.name, need: adjustedCost, have: this.haveObj(ai) });
            return `[ERROR] Cannot afford tech "${techId}" (needs ${this.costString(adjustedCost)}). You have ${this.haveString(ai)}.`;
        }

        ai.resources.spendResources(adjustedCost);
        ai.currentResearch = {
            techId: techId,
            progress: 0,
            duration: tech.researchTime || 15000
        };
        console.log(`[OpenAIAI] ${ai.id}: Researching "${tech.name}" (${techId})`);
        const researchSecs = this.realSecs(tech.researchTime || 15000);
        this.outcome('log.out.researchStarted', { techName: tech.name, secs: researchSecs });
        return `OK - Researching "${techId}" — ~${researchSecs}s to complete. Only one tech at a time; don't re-issue until "research.current" is empty (it shows secondsRemaining).`;
    }

    executeUpgradeAge(ai, game) {
        const ages = ['stone', 'neolithic', 'bronze', 'iron'];
        const currentIdx = ages.indexOf(ai.age);
        if (currentIdx >= ages.length - 1) {
            console.log(`[OpenAIAI] ${ai.id}: Already at max age`);
            this.outcome('log.out.maxAge', {});
            return `[ERROR] Already at max age (Iron Age).`;
        }

        if (ai.currentAgeUpgrade) {
            console.log(`[OpenAIAI] ${ai.id}: Already upgrading age`);
            this.outcome('log.out.alreadyUpgrading', { age: ai.currentAgeUpgrade.targetAge });
            return `[ERROR] upgrade_age: already advancing to "${ai.currentAgeUpgrade.targetAge}".`;
        }

        const nextAge = ages[currentIdx + 1];
        // Shared cost table (civilizations.js) — identical for every player type.
        const cost = AGE_COSTS[nextAge];
        if (!ai.resources.hasResources(cost)) {
            console.log(`[OpenAIAI] ${ai.id}: Cannot afford upgrade to ${nextAge}`);
            this.outcome('log.out.cannotAfford', { age: nextAge, need: cost, have: this.haveObj(ai) });
            return `[ERROR] Cannot afford the upgrade to ${nextAge} (needs ${this.costString(cost)}). You have ${this.haveString(ai)}.`;
        }

        ai.resources.spendResources(cost);
        ai.currentAgeUpgrade = {
            targetAge: nextAge,
            progress: 0,
            duration: 30000
        };
        console.log(`[OpenAIAI] ${ai.id}: Upgrading to ${nextAge}`);
        const ageSecs = this.realSecs(ai.currentAgeUpgrade.duration || 30000);
        this.outcome('log.out.ageUpStarted', { age: nextAge, secs: ageSecs });
        return `OK - Advancing to the ${nextAge} age — ~${ageSecs}s to complete. Keep developing meanwhile; "epoch.upgradeInProgress" shows secondsRemaining, so don't re-issue upgrade_age until it is done.`;
    }

    // The civ's Wonder, or null. Its id differs per civilization (akropolis, pyramid,
    // firetemple, shrine) and it lives in uniqueBuildings rather than BUILDING_DEFS,
    // so getBuildingDef() alone can never find it.
    wonderDefFor(civilization) {
        const civ = (typeof getCivilization === 'function') ? getCivilization(civilization) : null;
        return ((civ && civ.uniqueBuildings) || []).find(b => b.type === 'wonder') || null;
    }

    // getBuildingDef, plus the Wonder. "wonder" is accepted as an alias for whichever
    // id this civ uses: the state advertises the real id (so the thing you build and
    // the thing you then own are called the same), but a model that reads the goal
    // line and reaches for the generic word is not wrong enough to refuse.
    buildingDefFor(ai, buildingType) {
        const direct = (typeof getBuildingDef === 'function') ? getBuildingDef(buildingType) : null;
        if (direct) return direct;
        const w = this.wonderDefFor(ai.civilization);
        if (w && (buildingType === 'wonder' || buildingType === w.id)) return w;
        return null;
    }

    executeBuildStructure(ai, game, buildingType, targetX, targetZ) {
        // A renamed building still RESOLVES, so that old transcripts keep rendering — but
        // it must not be buildable, or the dead id leaks into new recordings and the model
        // is rewarded for guessing it. Say what it became; that is the whole correction.
        const legacy = (typeof LEGACY_BUILDING_IDS === 'object' && LEGACY_BUILDING_IDS)
            ? LEGACY_BUILDING_IDS[String(buildingType || '').toLowerCase()] : null;
        if (legacy) {
            this.outcome('log.out.renamedBuilding', { from: buildingType, to: legacy });
            return `[ERROR] ${buildingType}: unknown type, renamed to "${legacy}". Current names in "buildableStructures".`;
        }
        const buildingDef = this.buildingDefFor(ai, buildingType);
        // Resolve an alias to the real id up front, so every message below — and the
        // building that ends up in friendlyBuildings — uses one name for one thing.
        if (buildingDef && buildingDef.type === 'wonder') buildingType = buildingDef.id;
        const isWonderBuild = !!(buildingDef && buildingDef.type === 'wonder');
        if (!buildingDef) {
            console.log(`[OpenAIAI] ${ai.id}: Unknown building "${buildingType}"`);
            this.outcome('log.out.unknownBuilding', { buildingType });
            // NOT unlockedContent.buildings: that lists only what you have ALREADY
            // unlocked and is empty on turn 1, so the old message sent the model to
            // an empty array. buildableStructures is the complete list, with each
            // type's required age and unlock tech.
            return `[ERROR] Unknown building "${buildingType}". Use a "type" from "buildableStructures" — it lists every structure your civilization can build, with the age and unlock tech each needs.`;
        }

        // ADVANCE first: a building gated to a later epoch can't be built yet. (Most
        // age-gated buildings also need a tech, but some — e.g. the temple — only
        // need the age, so check it before the tech/resource steps.)
        const ageOrder = ['stone', 'neolithic', 'bronze', 'iron'];
        // effectiveBuildingAge resolves a def's age against the civ's unlock tech. The
        // Wonder has no unlock tech and is not in BUILDING_DEFS, so ask it only about
        // the buildings it knows and take the Wonder's own requiredAge as given.
        const effAge = (!isWonderBuild && typeof effectiveBuildingAge === 'function')
            ? effectiveBuildingAge(ai.civilization, buildingDef)
            : (buildingDef.requiredAge || 'iron');
        if (effAge && ageOrder.indexOf(ai.age) < ageOrder.indexOf(effAge)) {
            console.log(`[OpenAIAI] ${ai.id}: ${buildingType} needs ${effAge}`);
            this.outcome('log.out.buildingNeedsAge', { buildingType, effAge, age: ai.age });
            return `[ERROR] ${buildingType}: requires ${effAge} age. Current age: ${ai.age}.`;
        }

        // RESEARCH next: the building's enabling tech.
        if (buildingDef.requiresTech && !ai.researchedTechs[buildingDef.requiresTech]) {
            console.log(`[OpenAIAI] ${ai.id}: Need tech "${buildingDef.requiresTech}" for ${buildingType}`);
            const civTree = getCivilization(ai.civilization).techTree || {};
            // Some civilizations simply do not have the tech (e.g. no stable). Say so
            // clearly so the model stops retrying and switches strategy.
            if (!civTree[buildingDef.requiresTech]) {
                this.outcome('log.out.civCannotBuild', { buildingType, tech: buildingDef.requiresTech });
                return `[ERROR] Your civilization cannot build ${buildingType} — it has no "${buildingDef.requiresTech}" technology. Use a different building. See "buildableStructures" for what you CAN build (e.g. barracks for infantry, archery_range for archers).`;
            }
            this.outcome('log.out.buildNeedsTech', { tech: buildingDef.requiresTech, buildingType });
            return `[ERROR] ${buildingType}: unmet prerequisite: tech "${buildingDef.requiresTech}". Researchable techs in "research.available".`;
        }

        // One Wonder per player, whether it is finished or still going up.
        if (isWonderBuild && ai.buildings.some(b => b.isWonder)) {
            this.outcome('log.out.alreadyWonder', {});
            return `[ERROR] You are already building or holding a Wonder.`;
        }

        if (!ai.resources.hasResources(buildingDef.cost)) {
            console.log(`[OpenAIAI] ${ai.id}: Cannot afford ${buildingType}`);
            this.outcome('log.out.cannotAfford', { whatName: buildingDef.name, need: buildingDef.cost, have: this.haveObj(ai) });
            return `[ERROR] Cannot afford ${buildingType} (needs ${this.costString(buildingDef.cost)}). You have ${this.haveString(ai)}.`;
        }

        // Find placement position
        let x, z;
        const townCenters = ai.buildings.filter(b => b.type === 'town_center');
        const tc = townCenters[0] || null;
        if (targetX !== undefined && targetZ !== undefined) {
            x = targetX;
            z = targetZ;
            // The SAME limit keepUnitsAshore holds units to, so a site is buildable
            // exactly where a worker can stand. Nothing checked this: placement only
            // tested gaps to other buildings and clearance around resource nodes, so a
            // house could be founded in the sea and the worker sent to build it would
            // walk to the shoreline and stop there forever, with no error to read.
            //
            // Answered rather than clamped. Quietly moving the building would teach the
            // model that (410, 350) worked, and it would keep aiming there.
            const T = game.terrain;
            if (T && T.isWalkable && !T.isWalkable(x, z)) {
                const lim = Math.round(T.landLimit(x, z));
                const cheb = Math.round(Math.max(Math.abs(x), Math.abs(z)));
                this.outcome('log.out.offMap', { x: Math.round(x), z: Math.round(z), lim });
                return `[ERROR] Cannot build at (${Math.round(x)}, ${Math.round(z)}): that spot is outside the playable map, so no worker can reach it. Land reaches max(|x|,|z|) = ${lim} on that bearing; your target is ${cheb}.`;
            }
        } else if (tc) {
            // Default: a ring around the town centre, so buildings spread out.
            // Roughly double the old radius so bases occupy a larger footprint.
            const ang = Math.random() * Math.PI * 2;
            const rad = isWonderBuild ? (Math.random() - 0.5) * 20 : 18 + Math.random() * 28;
            x = tc.x + Math.cos(ang) * rad;
            z = tc.z + Math.sin(ang) * rad;
        } else {
            this.outcome('log.out.noTCPlacement', {});
            return `[ERROR] No Town Center found for placement reference.`;
        }

        // Validate position: keep walkable gaps between buildings AND an exclusion
        // zone around resource nodes (so harvesters can still reach them).
        let spot = this.findClearSpot(ai, game, buildingType, isWonderBuild, x, z);
        // A Wonder is not refused while the map still has room for it. By the time one
        // is affordable the base is usually full, and the nudge search gives up inside
        // it — so sweep widening rings out to ~90 units and take the first clear spot.
        // Losing the win condition to "your base is crowded" is not a decision the
        // harness should be making for anyone.
        if (!spot && isWonderBuild && tc) {
            outer:
            for (let radius = 14; radius <= 90; radius += 8) {
                const steps = Math.max(8, Math.round((2 * Math.PI * radius) / 12));
                const a0 = Math.random() * Math.PI * 2;
                for (let s = 0; s < steps; s++) {
                    const ang = a0 + (s / steps) * 2 * Math.PI;
                    const cx = tc.x + Math.cos(ang) * radius;
                    const cz = tc.z + Math.sin(ang) * radius;
                    if (this.isSpotClear(ai, game, buildingType, true, cx, cz)) { spot = { x: cx, z: cz }; break outer; }
                }
            }
        }
        if (!spot) {
            console.log(`[OpenAIAI] ${ai.id}: Could not find valid position for ${buildingType}`);
            this.outcome('log.out.noClearSpot', { buildingType });
            return `[ERROR] ${buildingType}: no clear spot near (${Math.round(x)}, ${Math.round(z)}). Occupied by buildings or resource nodes.`;
        }
        ({ x, z } = spot);

        // Decide who will build it BEFORE spending. Only idle workers build; a busy
        // worker is borrowed (and resumes its task) only when at the population cap.
        // forceBorrow: like the rule-based AI, a busy harvester is pulled to build
        // and returns to its old task afterwards. Without it, LLM players whose
        // workers were all gathering had their builds rejected while rule-based
        // rivals borrowed freely — an unfair asymmetry between controller types.
        const pick = game.pickBuilder(ai, { x, z }, { forceBorrow: true });
        if (pick.error === 'no_workers') {
            this.outcome('log.out.noWorkersBuild', { buildingType });
            return `[ERROR] You have no workers to build ${buildingType}.`;
        }
        if (pick.error === 'no_idle') {
            this.outcome('log.out.noWorkerIdleBuild', { buildingType });
            return `[ERROR] ${buildingType}: no worker available. All are constructing or fighting; neither is ever pulled.`;
        }

        // Measured before applyBuilder sends it walking, and reported below when it is
        // material: the reply used to quote the build time alone, so a builder with a
        // long trek ahead of it was announced as "~25s" and then took minutes, with
        // nothing in the answer to explain the gap.
        const walkSecs = pick.worker ? this.travelEtaSec(pick.worker, x, z) : 0;
        ai.resources.spendResources(buildingDef.cost);
        // Place a construction site and send the chosen worker to build it (pop bonus
        // is granted on completion via game.completeConstruction).
        const building = createBuilding(buildingType, x, z, ai.id, ai.civilization, { underConstruction: true, age: ai.age });
        ai.buildings.push(building);
        game.renderer.addBuilding(building);
        game.applyBuilder(pick, building);

        console.log(`[OpenAIAI] ${ai.id}: Started ${buildingDef.name} at (${Math.round(x)}, ${Math.round(z)})`);
        const secs = this.realSecs(building.buildTime || 10000);
        this.outcome('log.out.buildStarted', { buildingName: buildingDef.name, x: Math.round(x), z: Math.round(z), secs });
        // The old build_wonder reply ended "defend it, rivals will rush it!" — an order
        // with an exclamation mark. The hold time is the part that was a fact.
        const tail = (walkSecs >= 5 ? ` The builder is ~${walkSecs}s of walking away, so construction begins after it arrives.` : '')
            + (isWonderBuild
            // Raw seconds, for the same reason as gameStats.wonderRequired above: by
            // the time this sentence is true the match is already back at 1x.
            ? ` This is your Wonder: once complete it must stand for ${(game.wonderRequired || 600)}s for you to win the match.`
            : '');
        return pick.restore
            ? `OK - Construction of "${buildingType}" started at (${Math.round(x)}, ${Math.round(z)}); a worker was pulled off ${(pick && pick.wasDoing) || 'its task'} to build (~${secs}s) and will return afterwards${pick && pick.wasDoing === 'scouting' ? ' — that scout will NOT reach the tile you sent it to' : ''}.${tail}`
            : `OK - Construction of "${buildingType}" started at (${Math.round(x)}, ${Math.round(z)}); an idle worker is building it (~${secs}s).${tail}`;
    }

    // Placement validation: nudge (x, z) until it keeps a walkable gap to EVERY
    // existing building (11 to Town Centers/Wonders, 9 otherwise) and stays outside
    // every live resource node's clearance ring. Up to 40 nudge attempts; returns
    // {x, z} or null. The Wonder used to skip validation entirely and could land on
    // top of the base.
    findClearSpot(ai, game, buildingType, isWonderBuild, x, z) {
        const reqGap = b => (b.type === 'town_center' || b.isWonder) ? 11 : 9;
        const resClr = game.resourceClearance(buildingType, isWonderBuild);
        let valid = false;
        let attempts = 0;
        while (!valid && attempts < 40) {
            valid = true;
            const allBuildings = [...ai.buildings, ...game.player.buildings, ...game.aiManager.aiPlayers.flatMap(a => a.buildings)];
            for (const b of allBuildings) {
                const dx = x - b.x;
                const dz = z - b.z;
                const need = reqGap(b);
                const d = Math.sqrt(dx * dx + dz * dz);
                if (d < need) {
                    valid = false;
                    const dd = d || 1;
                    x = b.x + (dx / dd) * (need + 1) + (Math.random() - 0.5) * 3;
                    z = b.z + (dz / dd) * (need + 1) + (Math.random() - 0.5) * 3;
                    break;
                }
            }
            // Ashore. The nudges above push a candidate away from buildings and
            // nodes with no idea where the coast is, so a crowded base could walk a
            // site straight off the edge on its own -- the explicit-target check
            // upstream would never see it, because the model never named this spot.
            const T = game.terrain;
            if (valid && T && T.isWalkable && !T.isWalkable(x, z)) {
                valid = false;
                if (T.clampToLand) {
                    const c = T.clampToLand(x, z);
                    // A little inland of the waterline, not exactly on it, so the next
                    // pass has room to nudge without falling straight back out.
                    x = c.x * 0.98; z = c.z * 0.98;
                }
            }
            if (!valid) { attempts++; continue; }
            // Resource exclusion: shove the candidate out of any node's clearance ring.
            const nodes = (game.terrain && game.terrain.resources) || [];
            for (const r of nodes) {
                if (r.amount !== undefined && r.amount <= 0) continue;
                const dx = x - r.x;
                const dz = z - r.z;
                const d = Math.sqrt(dx * dx + dz * dz);
                if (d < resClr) {
                    valid = false;
                    const dd = d || 1;
                    x = r.x + (dx / dd) * (resClr + 1) + (Math.random() - 0.5) * 3;
                    z = r.z + (dz / dd) * (resClr + 1) + (Math.random() - 0.5) * 3;
                    break;
                }
            }
            attempts++;
        }
        return valid ? { x, z } : null;
    }

    // One candidate, judged in place (no nudging): far enough from every building,
    // outside every live node's clearance ring, and on solid map ground.
    // Constants mirror findClearSpot — keep the two in sync.
    isSpotClear(ai, game, buildingType, isWonderBuild, x, z) {
        if (game.clampToMap) {
            const c = game.clampToMap(x, z);
            if (Math.abs(c.x - x) > 0.5 || Math.abs(c.z - z) > 0.5) return false; // off-map
        }
        const reqGap = b => (b.type === 'town_center' || b.isWonder) ? 11 : 9;
        const allBuildings = [...ai.buildings, ...game.player.buildings, ...game.aiManager.aiPlayers.flatMap(a => a.buildings)];
        for (const b of allBuildings) {
            if (Math.hypot(x - b.x, z - b.z) < reqGap(b)) return false;
        }
        const resClr = game.resourceClearance(buildingType, isWonderBuild);
        for (const r of (game.terrain && game.terrain.resources) || []) {
            if (r.amount !== undefined && r.amount <= 0) continue;
            if (Math.hypot(x - r.x, z - r.z) < resClr) return false;
        }
        return true;
    }

    // Resolve an optional { type: count } selection into concrete units for a
    // move/attack order. No map → the WHOLE army (all non-worker units). With a
    // map, take the `count` units of each named type CLOSEST to (dx,dz) — clamp
    // to what the player actually owns and skip types it doesn't, reporting the
    // delta in `note`; never hard-fail on a too-big count or an unowned type.
    // Types match a unit's specific id-type ("champion") OR its category
    // ("cavalry"), like delete_unit. Support units (priests) are split out so
    // callers escort them rather than send them to fight. Because the no-map
    // case returns every priest in `support`, escortSupportUnits(sel.support,…)
    // escorts the whole clergy on a full-army order and only the named priests
    // on a detachment — no special-casing needed.
    selectOrderedUnits(ai, unitsMap, dx, dz, ids) {
        // Workers are a THIRD bucket, not combat: move_units takes them along, attack
        // never does. Naming "worker" explicitly is how a model puts a unit on an
        // exact spot now that explore works in whole tiles — but omitting "units"
        // still means the army alone, so a bare move order never drags the economy
        // across the map.
        const split = (arr) => ({
            combat: arr.filter(u => u.type !== 'worker' && u.unitType !== 'support'),
            support: arr.filter(u => u.type !== 'worker' && u.unitType === 'support'),
            workers: arr.filter(u => u.type === 'worker')
        });
        // Explicit handles win outright. "the nearest N of this type" cannot express
        // "that one", which is how a model that had correctly found its dying crossbowman
        // and an idle healer ended up moving a different, healthy crossbowman that was
        // already standing at the temple — and reissuing the same order, because nothing
        // in the reply said which unit had moved.
        if (Array.isArray(ids) && ids.length) {
            const byHandle = new Map();
            ai.units.forEach(u => { if (u.health > 0) byHandle.set(Number(u.handle), u); });
            const picked = [], missing = [];
            ids.forEach(raw => {
                const n = Number(raw);
                const u = byHandle.get(n);
                if (u) { if (!picked.includes(u)) picked.push(u); } else missing.push(raw);
            });
            let note = '';
            // A handle is never reused, so an unknown one is a unit that DIED rather than
            // a different unit wearing its number. Say that, instead of quietly moving
            // whoever happens to be nearby.
            if (missing.length) note = ` (no longer yours or already dead: ${missing.join(', ')})`;
            // missing/alive travel with the selection so a caller can tell "some of the
            // named units died" from "all of them did". They are different situations
            // and only one of them is the model's mistake.
            return Object.assign(split(picked), { note, missing, alive: picked.length });
        }
        const hasMap = unitsMap && typeof unitsMap === 'object' && !Array.isArray(unitsMap) && Object.keys(unitsMap).length > 0;
        if (!hasMap) return Object.assign(split(ai.units.filter(u => u.type !== 'worker' && u.health > 0)), { note: '' });
        const live = ai.units.filter(u => u.health > 0);

        const chosen = new Set();
        const clamped = [], skipped = [];
        for (const rawType of Object.keys(unitsMap)) {
            const type = String(rawType).trim().toLowerCase();
            const want = Math.floor(Number(unitsMap[rawType]));
            if (!Number.isFinite(want) || want <= 0) { skipped.push(`${rawType} (bad count)`); continue; }
            const pool = live.filter(u => !chosen.has(u) &&
                ((u.type || '').toLowerCase() === type || (u.unitType || '').toLowerCase() === type));
            if (!pool.length) { skipped.push(`${rawType} (own none)`); continue; }
            pool.sort((a, b) => Math.hypot(a.x - dx, a.z - dz) - Math.hypot(b.x - dx, b.z - dz));
            const take = Math.min(want, pool.length);
            if (want > pool.length) clamped.push(`${rawType} ${want}->${pool.length}`);
            for (let i = 0; i < take; i++) chosen.add(pool[i]);
        }
        let note = '';
        if (clamped.length) note += ` (clamped to what you own: ${clamped.join(', ')})`;
        if (skipped.length) note += ` (skipped: ${skipped.join(', ')})`;
        return Object.assign(split([...chosen]), { note });
    }

    // "crossbowman #183 from (305, -30)" for one unit; a capped list for several. Capped
    // because a whole-army order can carry ninety units and the point is that the model
    // can check the pick, not that it re-reads its own roster.
    describeMoved(units) {
        if (!units.length) return '0 unit(s)';
        if (units.length === 1) {
            const u = units[0];
            return `${u.type} #${u.handle} from (${Math.round(u.x)}, ${Math.round(u.z)})`;
        }
        const CAP = 6;
        const shown = units.slice(0, CAP).map(u => `${u.type} #${u.handle}`).join(', ');
        const rest = units.length - CAP;
        return `${units.length} unit(s) — ${shown}${rest > 0 ? `, and ${rest} more` : ''}`;
    }

    // Human-readable tally of a player's non-worker force, for mismatch feedback.
    // Every handle the model named is dead. That is the targetGone situation exactly:
    // the ids WERE in friendlyUnits in the state this seat read, and the units died
    // while it was thinking, so no snapshot could have warned it.
    //
    // Deliberately does NOT suggest dropping unitIds to send whatever is left. The
    // model named those units; the ones still standing may be reserved for a different
    // order in the same turn, and auto-substituting is the harness deciding who fights.
    // Idle military auto-defend anyway. It states the facts and stops.
    orderedUnitsGone(ai, missing) {
        this.outcome('log.out.orderedUnitsGone', { ids: missing.join(', ') });
        return `[ERROR] Every unit you named is gone: ${missing.join(', ')} died between the state you read `
             + `and this command. Nothing was executed and this does not count against you. Handles are never `
             + `reused, so one that is missing always means that unit died. Your surviving military: `
             + `${this.forceComposition(ai)}.`;
    }

    // Did the model name handles, and did every one of them turn out to be gone?
    allNamedUnitsGone(unitIds, sel) {
        return Array.isArray(unitIds) && unitIds.length > 0
            && sel && (sel.alive === 0) && (sel.missing || []).length > 0;
    }

    forceComposition(ai) {
        const counts = {};
        ai.units.forEach(u => { if (u.type !== 'worker' && u.health > 0) counts[u.type] = (counts[u.type] || 0) + 1; });
        const parts = Object.entries(counts).map(([t, n]) => `${t}×${n}`);
        return parts.length ? parts.join(', ') : '(no military)';
    }

    executeMoveUnits(ai, game, unitsMap, targetX, targetZ, unitIds, matchSpeed, formation) {
        // Validate the destination first so bad coords never strand units at NaN.
        const mx = Number(targetX), mz = Number(targetZ);
        if (!Number.isFinite(mx) || !Number.isFinite(mz)) {
            this.outcome('log.out.moveNeedsCoords', {});
            return `[ERROR] move_units needs numeric "targetX" and "targetZ" (map coordinates inside map.bounds). Got targetX=${JSON.stringify(targetX)}, targetZ=${JSON.stringify(targetZ)}.`;
        }
        // Keep the destination on solid ground (no marching into the ocean).
        ({ x: targetX, z: targetZ } = game.clampToMap(mx, mz));

        // Optional {type:count} detachment; a move order repositions the whole
        // named force, priests included (they come along on a move as always).
        const sel = this.selectOrderedUnits(ai, unitsMap, targetX, targetZ, unitIds);
        const unitsToMove = [...sel.combat, ...sel.support, ...sel.workers];
        if (unitsToMove.length === 0) {
            if (this.allNamedUnitsGone(unitIds, sel)) return this.orderedUnitsGone(ai, sel.missing);
            const ownsMilitary = ai.units.some(u => u.type !== 'worker' && u.health > 0);
            if (ownsMilitary) {
                this.outcome('log.out.moveNoMatch', {});
                return `[ERROR] move_units matched none of your units${sel.note}. Name unit types you actually own (e.g. {"champion":3}, or {"worker":1} to place a worker exactly), or omit "units" to move your whole army. Your military: ${this.forceComposition(ai)}.`;
            }
            // Two different mistakes shared one sentence. A model that NAMED a type
            // it no longer owns was told how omitting "units" behaves — advice about
            // a call it did not make. One asked for {"militia":1} with its last
            // militia dead and got a lecture on omission while 93 workers stood idle
            // beside it, which was the only piece of the answer that mattered.
            const named = (unitsMap && Object.keys(unitsMap).length > 0)
                || (Array.isArray(unitIds) && unitIds.length > 0);
            const workers = ai.units.filter(u => u.type === 'worker' && u.health > 0).length;
            const alt = workers
                ? `Name {"worker":N} to move workers instead — you have ${workers}`
                : `Train military units first`;
            this.outcome('log.out.noMilitaryMove', {});
            return named
                ? `[ERROR] move_units matched none of your units: you have no military units left${sel.note}. ${alt}.`
                : `[ERROR] You have no military units to move — omitting "units" moves your army, and you have none. ${alt}.`;
        }

        // A shape only holds if everyone keeps pace, so asking for one asks for the
        // pace too -- unless the model said otherwise, in which case it said otherwise.
        const form = this.applyFormation(game, unitsToMove, targetX, targetZ, formation);
        const pace = this.applyMatchSpeed(unitsToMove, matchSpeed || (form.applied ? 'slowestUnit' : ''));

        let eta = 0;
        unitsToMove.forEach(unit => {
            game.clearRetaliation(unit);
            // A worker may be carrying, mid-harvest, or standing on a farm. Setting
            // task=null alone would leave the farm's assignedWorker pointing at a unit
            // that has walked away, so the farm would look manned and grow nothing.
            if (unit.type === 'worker') this.releaseUnitForOrders(unit);
            unit.isMoving = true;
            // Each unit walks to its OWN slot, so the group arrives as a shape rather
            // than as everybody converging on one point. Clamped: a slot off the edge
            // of the map is not somewhere a unit can stand.
            const off = form.offsets && form.offsets.get(unit);
            const dest = off ? game.clampSlot(targetX + off.x, targetZ + off.z) : { x: targetX, z: targetZ };
            unit.targetX = dest.x;
            unit.targetZ = dest.z;
            // Measured to the SLOT, which is the trip this unit is actually making.
            eta = Math.max(eta, this.travelEtaSec(unit, dest.x, dest.z));
            unit.formationOffset = null;   // a plain move has no target to approach
            unit.formationGroup = null;
            unit.isAttacking = false;
            unit.attackTarget = null;
            unit.attackMove = null;
            unit.task = null;
            unit._orderToken = ++this._orderSeq; // new order → leaves any prior attack report
        });

        console.log(`[OpenAIAI] ${ai.id}: Moving ${unitsToMove.length} units to (${Math.round(targetX)}, ${Math.round(targetZ)})`);
        this.outcome('log.out.moveUnits', { count: unitsToMove.length, x: Math.round(targetX), z: Math.round(targetZ), eta });
        // Naming the units is what makes a wrong pick VISIBLE. Without it the reply for
        // moving the wrong crossbowman and the right one are the same sentence, so a model
        // has no way to notice and simply reissues.
        return `OK - Moving ${this.describeMoved(unitsToMove)} to (${Math.round(targetX)}, ${Math.round(targetZ)})${sel.note}${form.note}${pace.note} — ~${eta}s to arrive; let them march before re-issuing.`;
    }

    executeAttackTarget(ai, game, targetId, unitsMap, unitIds, matchSpeed, formation) {
        // Find target in all units and buildings
        let target = null;
        target = game.getAllUnits().find(u => (u.id || '') === targetId);
        if (!target) {
            target = game.getAllBuildings().find(b => (b.id || '') === targetId);
        }

        if (!target) {
            // Was it there when the model decided? The state it answered is the only
            // fair reference. A unit it read, aimed at, and lost while it was thinking
            // is the harness's timing, not the model's error — the old message even
            // told it to go and read the very list it had just read correctly.
            const ctrl = this.aiControllers.find(c => c.aiPlayer === ai);
            const wasShown = !!(ctrl && ctrl._shownTargetIds && ctrl._shownTargetIds.has(String(targetId)));
            if (wasShown) {
                console.log(`[OpenAIAI] ${ai.id}: Target "${targetId}" died before the order landed`);
                this.outcome('log.out.targetGone', { targetId });
                return `[ERROR] That target was gone before your order landed — it died in the seconds between the state you read and this command. Nothing was executed and this does not count against you. Targets you can see may die while you think. targetId names one exact entity; targetX/targetZ sends an attack-move that fights whatever is there.`;
            }
            console.log(`[OpenAIAI] ${ai.id}: Target "${targetId}" not found`);
            this.outcome('log.out.targetNotFound', { targetId });
            return `[ERROR] Target "${targetId}" not found. ${this.attackTargetHint(ai, game)}`;
        }

        // Friendly-fire guard: a model must not attack its own units/buildings.
        if (this.isOwnedByAI(target, ai)) {
            console.log(`[OpenAIAI] ${ai.id}: Refused self-attack on "${target.name || target.type}"`);
            this.outcome('log.out.targetIsOwn', { target: target.name || target.type });
            return `[ERROR] Target "${target.name || target.type}" is your own ${target.type}. You cannot attack your own units or buildings. ${this.attackTargetHint(ai, game)}`;
        }

        // Optional {type:count} detachment closest to the target; no map → the
        // whole combat force. Support units are split out to escort, not fight.
        const sel = this.selectOrderedUnits(ai, unitsMap, target.x, target.z, unitIds);
        const unitsToAttack = sel.combat;

        if (unitsToAttack.length === 0) {
            if (this.allNamedUnitsGone(unitIds, sel)) return this.orderedUnitsGone(ai, sel.missing);
            console.log(`[OpenAIAI] ${ai.id}: No units to attack with`);
            const ownsCombat = ai.units.some(u => u.type !== 'worker' && u.unitType !== 'support' && u.health > 0);
            if (ownsCombat) {
                this.outcome('log.out.attackNoMatch', {});
                return `[ERROR] attack matched none of your COMBAT units${sel.note}. Name types you own (e.g. {"champion":3}) or omit "units" to send your whole army. Your military: ${this.forceComposition(ai)}. ${this.attackTargetHint(ai, game)}`;
            }
            const priestNote = ai.units.some(u => u.unitType === 'support')
                ? ' Priests never fight — on an attack they escort your army and heal, but you have no COMBAT units to send.' : '';
            this.outcome('log.out.noMilitaryAttack', {});
            return `[ERROR] No military units available to attack.${priestNote} ${this.attackTargetHint(ai, game)}`;
        }

        // The clergy marches in the shape with everyone else. They are still split out
        // of unitsToAttack -- a priest never engages -- but a body that walks together
        // has to be SHAPED together, and escorting them separately left them wandering
        // to a random spot within two units of the target while the army formed up.
        const marching = unitsToAttack.concat((sel.support || []).filter(u => u && u.health > 0));
        const form = this.applyFormation(game, marching, target.x, target.z, formation);
        const pace = this.applyMatchSpeed(marching, matchSpeed || (form.applied ? 'slowestUnit' : ''));
        unitsToAttack.forEach(unit => {
            game.clearRetaliation(unit); // a fresh model order overrides the reflex
            unit.isAttacking = true;
            unit.attackTarget = target;
            // These units aim at the TARGET, not at targetX, so a slot cannot be baked
            // into a destination the way a plain move's is. It rides along instead and
            // updateCombat aims at target+slot until the unit is close enough to fight,
            // where it is dropped -- the shape is the approach and nothing more.
            unit.formationOffset = (form.offsets && form.offsets.get(unit)) || null;
            // attack-move: if the target dies or slips away, keep pushing to its
            // last position and aggro whatever's nearby (enemies move).
            unit.attackMove = { x: target.x, z: target.z };
            unit.attackTimer = 0;
            unit.isMoving = true;
            unit.targetX = target.x;
            unit.targetZ = target.z;
            unit.task = null;
            unit._orderToken = ++this._orderSeq; // new order → leaves any prior attack report
        });
        // Priests march along as healers (never engage) — the whole clergy on a
        // full-army order, only the named priests on a detachment.
        const escorted = game.escortSupportUnits(sel.support, target.x, target.z);
        const escortNote = escorted ? ` ${escorted} priest(s) escort to heal (they stand back, never engage).` : '';

        console.log(`[OpenAIAI] ${ai.id}: ${unitsToAttack.length} units attacking "${target.name || target.type}"`);
        this.outcome('log.out.attackDispatched', { count: unitsToAttack.length, target: target.name || target.type });
        // "attacking" was a lie for as long as the walk takes. Setting isAttacking only
        // gives the order; the units then cross the map, and a model told "37 units
        // attacking" reads the absence of damage as a tough enemy rather than as an army
        // that has not arrived. The position branch of this same action has always said
        // "attack-moving (~Ns)" and promised a verdict on arrival — this one said the
        // fight had started.
        //
        // Same threshold the arrival resolver uses (ENGAGE = 30), so "engaging" here and
        // "engaged" there mean the same thing.
        const nearest = unitsToAttack.reduce((best, u) => {
            const d = Math.hypot(u.x - target.x, u.z - target.z);
            return (best === null || d < best.d) ? { u, d } : best;
        }, null);
        const inContact = nearest && nearest.d <= 30;
        if (inContact) {
            this.outcome('log.out.attackEngaging', { count: unitsToAttack.length, target: target.name || target.type });
            return `OK - ${unitsToAttack.length} unit(s) engaging "${target.name || target.type}" — they are already in contact range.${sel.note}${pace.note}${escortNote}`;
        }
        // The LAST unit to arrive, not the NEAREST one. Quoting the closest unit's eta
        // for a force spread across the map promises the moment the fight STARTS as
        // though it were the moment the army is there -- and a model that reissues on
        // that clock is reissuing at its vanguard while the rest is still walking.
        const eta = unitsToAttack.reduce((m, u) => Math.max(m, this.travelEtaSec(u, target.x, target.z)), 0);
        this.outcome('log.out.attackMarching', { count: unitsToAttack.length, target: target.name || target.type, eta });
        return `OK - ${unitsToAttack.length} unit(s) ORDERED to attack "${target.name || target.type}" and now MARCHING there (~${eta}s). They have not fought anything yet. You will be told when they arrive — don't re-issue this attack meanwhile.${sel.note}${form.note}${pace.note}${escortNote}`;
    }

    executeAttackPosition(ai, game, targetX, targetZ, unitsMap, unitIds, matchSpeed, formation) {
        const controller = this.aiControllers.find(c => c.aiPlayer === ai);

        const mx = Number(targetX), mz = Number(targetZ);
        if (!Number.isFinite(mx) || !Number.isFinite(mz)) {
            this.outcome('log.out.attackNeedsCoords', {});
            return `[ERROR] attack needs numeric "targetX"/"targetZ" (or a "targetId"). Got targetX=${JSON.stringify(targetX)}, targetZ=${JSON.stringify(targetZ)}. ${this.attackTargetHint(ai, game)}`;
        }
        // Keep the attack-move objective on solid ground.
        ({ x: targetX, z: targetZ } = game.clampToMap(mx, mz));
        // clampToMap keeps orders on solid ground, but it did so SILENTLY: a model
        // asking for (400, 100) -- a legal coordinate on the 800x800 map it is told
        // about -- was answered "moving to (370, 100)" with no account of the
        // difference, and could only conclude it had been misunderstood. The margin is
        // real and stays; being quiet about it does not.
        const offNote = (Math.abs(targetX - mx) > 0.5 || Math.abs(targetZ - mz) > 0.5)
            ? ` Your (${Math.round(mx)}, ${Math.round(mz)}) lies outside the area units may be sent to, so the nearest point inside it was used.`
            : '';

        // Optional {type:count} detachment closest to the destination; no map →
        // the whole combat force. Support units split out to escort, not fight.
        const sel = this.selectOrderedUnits(ai, unitsMap, targetX, targetZ, unitIds);
        const unitsToAttack = sel.combat;
        if (unitsToAttack.length === 0) {
            if (this.allNamedUnitsGone(unitIds, sel)) return this.orderedUnitsGone(ai, sel.missing);
            const ownsCombat = ai.units.some(u => u.type !== 'worker' && u.unitType !== 'support' && u.health > 0);
            if (ownsCombat) {
                this.outcome('log.out.attackNoMatch', {});
                return `[ERROR] attack matched none of your COMBAT units${sel.note}. Name types you own (e.g. {"champion":3}) or omit "units" to send your whole army. Your military: ${this.forceComposition(ai)}. ${this.attackTargetHint(ai, game)}`;
            }
            const priestNote = ai.units.some(u => u.unitType === 'support')
                ? ' Priests never fight — on an attack they escort your army and heal, but you have no COMBAT units to send.' : '';
            this.outcome('log.out.noMilitaryAttack', {});
            return `[ERROR] No military units available to attack.${priestNote} ${this.attackTargetHint(ai, game)}`;
        }

        // INSTANT checks on what sits AT the designated coordinates. Friendly target
        // and resource node are rejected immediately (no move). Empty space and a
        // valid enemy both dispatch the army and report the verdict ON ARRIVAL.
        const HIT = 8, RES = 5;
        let atSpot = null, nd = HIT;
        for (const e of [...game.getAllUnits(), ...game.getAllBuildings()]) {
            if (e.health <= 0) continue;
            const d = Math.hypot(e.x - targetX, e.z - targetZ);
            if (d <= nd) { nd = d; atSpot = e; }
        }
        if (atSpot && this.isOwnedByAI(atSpot, ai)) {
            this.outcome('log.out.attackOwnGround', { x: Math.round(targetX), z: Math.round(targetZ), type: atSpot.type });
            return `[ERROR] (${Math.round(targetX)}, ${Math.round(targetZ)}) is on your own ${atSpot.type}. You cannot attack your own units/buildings. ${this.attackTargetHint(ai, game)}`;
        }
        if (!atSpot) {
            const res = (game.terrain && game.terrain.resources) || [];
            const node = res.find(r => r.amount > 0 && Math.hypot(r.x - targetX, r.z - targetZ) <= RES);
            if (node) {
                this.outcome('log.out.attackResourceNode', { x: Math.round(targetX), z: Math.round(targetZ), res: node.type });
                return `[ERROR] (${Math.round(targetX)}, ${Math.round(targetZ)}) is a ${node.type} resource node, not an attack target. Workers gather it with assign_workers. ${this.attackTargetHint(ai, game)}`;
            }
        }

        // Seed an initial target if an enemy is already near the spot; either way the
        // units attack-MOVE to the location and engage whatever they meet on the way.
        const token = ++this._orderSeq;
        let nearest = null, minDist = 40;
        for (const entity of [...game.getAllUnits(), ...game.getAllBuildings()]) {
            if (this.isOwnedByAI(entity, ai) || entity.health <= 0) continue;
            const d = Math.hypot(entity.x - targetX, entity.z - targetZ);
            if (d < minDist) { minDist = d; nearest = entity; }
        }
        const form = this.applyFormation(game, unitsToAttack, targetX, targetZ, formation);
        const pace = this.applyMatchSpeed(unitsToAttack, matchSpeed || (form.applied ? 'slowestUnit' : ''));
        unitsToAttack.forEach(unit => {
            game.clearRetaliation(unit); // a fresh model order overrides the reflex
            unit.isAttacking = true;
            unit.attackTarget = nearest || null;
            const off = (form.offsets && form.offsets.get(unit)) || null;
            // Both branches need it: attackMove for the march when nothing is in the
            // way, formationOffset for the approach when something already is.
            const am = off ? game.clampSlot(targetX + off.x, targetZ + off.z) : { x: targetX, z: targetZ };
            unit.attackMove = { x: am.x, z: am.z };
            unit.formationOffset = off;
            unit.attackTimer = 0;
            unit.isMoving = true;
            unit.targetX = (nearest ? nearest.x : am.x);
            unit.targetZ = (nearest ? nearest.z : am.z);
            unit.task = null;
            unit._orderToken = token;
        });
        if (controller) {
            controller.pendingAttackReports = controller.pendingAttackReports || [];
            controller.pendingAttackReports.push({ token, tx: targetX, tz: targetZ, units: unitsToAttack.slice(), startTime: Date.now() });
        }
        // Priests march along as healers (never engage) — the whole clergy on a
        // full-army order, only the named priests on a detachment.
        const escorted = game.escortSupportUnits(sel.support, targetX, targetZ);
        const escortNote = escorted ? ` ${escorted} priest(s) escort to heal (they stand back, never engage).` : '';

        // The LAST unit to arrive, not the first one in the list. This quoted
        // unitsToAttack[0], so a mixed force was promised its scout cavalry's eta and
        // the model read the missing damage as a tough enemy rather than as an army
        // still walking -- the same lie "units attacking" used to tell, one field over.
        // move_units has always taken the max; these two now agree.
        const eta = unitsToAttack.reduce((m, u) => Math.max(m, this.travelEtaSec(u, targetX, targetZ)), 0);
        this.outcome('log.out.attackMoving', { count: unitsToAttack.length, x: Math.round(targetX), z: Math.round(targetZ), eta });
        return `OK - ${unitsToAttack.length} unit(s) attack-moving to (${Math.round(targetX)}, ${Math.round(targetZ)}) (~${eta}s).${sel.note}${form.note}${pace.note}${escortNote}${offNote} You will be told on arrival whether they engaged an enemy or found no valid target there — don't re-issue this attack meanwhile.`;
    }

    // Each frame, resolve open attack-move orders once the units arrive/engage and
    // queue the verdict for the model's NEXT prompt (and the spectator log).
    updateAttackReports(now) {
        const ARRIVE = 7, ENGAGE = 30, MAXWAIT = 120000;
        for (const controller of this.aiControllers) {
            const reports = controller.pendingAttackReports;
            if (!reports || !reports.length) continue;
            const ai = controller.aiPlayer;
            for (let i = reports.length - 1; i >= 0; i--) {
                const r = reports[i];
                // The verdict already reaches the MODEL synchronously — it is drained
                // into the next prompt as "RESULTS OF YOUR EARLIER ATTACK ORDER(S)".
                // The code/params here are for the spectator LOG, which could not use
                // the executeAction outcome side-channel because this resolves on a
                // later tick; without them the arrival line was the last one stuck in
                // English while the rest of the log spoke the model's language.
                const resolve = (msg, failed, code, params) => {
                    controller.pendingArrivalMessages = controller.pendingArrivalMessages || [];
                    controller.pendingArrivalMessages.push(msg);
                    this.logArrival(ai, msg, failed, {
                        lang: (controller.model && controller.model.language) || 'en', code, params
                    });
                    reports.splice(i, 1);
                };
                const onOrder = r.units.filter(u => u.health > 0 && ai.units.includes(u) && u._orderToken === r.token);
                if (onOrder.length === 0) {
                    if (r.units.every(u => u.health <= 0)) {
                        resolve(`Your attack force sent to (${Math.round(r.tx)}, ${Math.round(r.tz)}) was destroyed before arriving.`, true,
                            'log.out.attackDestroyedEnRoute', { x: Math.round(r.tx), z: Math.round(r.tz) });
                    } else {
                        reports.splice(i, 1); // those units got a new order — report superseded
                    }
                    continue;
                }
                const eng = onOrder.find(u => u.isAttacking && u.attackTarget && u.attackTarget.health > 0);
                if (eng) {
                    const tg = eng.attackTarget;
                    // "an enemy worker (ai_vrfbnoj58)" -- that id is the OWNER's, but a
                    // bare parenthetical after a unit type reads as the unit's own id, and
                    // it is exactly the shape targetId takes. Models copy whatever looks
                    // copyable, so this was an invitation to attack a player id. Labelled.
                    resolve(`Your attack force reached (${Math.round(r.tx)}, ${Math.round(r.tz)}) and ENGAGED an enemy ${tg.type}${tg.owner ? ` owned by ${this.game.seatLabel(tg.owner)}` : ''}.`, false,
                        'log.out.attackEngaged', { x: Math.round(r.tx), z: Math.round(r.tz), target: tg.type });
                    continue;
                }
                const arrived = onOrder.some(u => Math.hypot(u.x - r.tx, u.z - r.tz) <= ARRIVE) || onOrder.every(u => !u.isMoving);
                if (arrived) {
                    const enemyNear = [...this.game.getAllUnits(), ...this.game.getAllBuildings()]
                        .some(e => e.health > 0 && !this.isOwnedByAI(e, ai) && Math.hypot(e.x - r.tx, e.z - r.tz) <= ENGAGE);
                    if (enemyNear) resolve(`Your attack force reached (${Math.round(r.tx)}, ${Math.round(r.tz)}); an enemy is there and they are engaging.`, false,
                        'log.out.attackContact', { x: Math.round(r.tx), z: Math.round(r.tz) });
                    else resolve(`[ERROR] Your attack force reached (${Math.round(r.tx)}, ${Math.round(r.tz)}) but found NO valid target — the spot is empty (the enemy moved or was already destroyed). ${this.attackTargetHint(ai, this.game)}`, true,
                        'log.out.attackEmpty', { x: Math.round(r.tx), z: Math.round(r.tz) });
                    continue;
                }
                if (now - r.startTime > MAXWAIT) {
                    resolve(`Your attack force did not reach (${Math.round(r.tx)}, ${Math.round(r.tz)}) in time (blocked or fighting along the way).`, true,
                        'log.out.attackTooSlow', { x: Math.round(r.tx), z: Math.round(r.tz) });
                }
            }
        }
    }

    // Add a deferred attack outcome to the spectator decision log.
    logArrival(ai, msg, failed, extra = {}) {
        const civ = getCivilization(ai.civilization);
        const entry = {
            timestamp: Date.now(), playerId: ai.id,
            civName: civ?.name || ai.civilization,
            color: '#' + ((civ?.color ?? 0xffffff)).toString(16).padStart(6, '0'),
            // NOT 'attack_target'. An arrival resolves on a later tick and is a
            // RESULT, but writing a command's action name here gave it a command's
            // label in the log -- so a turn of three commands showed four "Attack
            // launched" style rows and looked like the three-command cap had been
            // broken. Its own name, the way 'advice' has one.
            action: 'attack_result', reason: '', result: msg, params: {},
            failed: !!failed, error: failed ? msg.replace(/^\[ERROR\]\s*/, '') : null,
            lang: extra.lang || 'en'
        };
        if (extra.code) { entry.outcomeCode = extra.code; entry.outcomeParams = extra.params || {}; }
        this.decisionLog.unshift(entry);
        if (this.decisionLog.length > this.maxLogEntries) this.decisionLog = this.decisionLog.slice(0, this.maxLogEntries);
    }

    // Resources are hidden until SCOUTED. Update the AI's discovery memory and
    // return the discovered (visible-or-remembered) nodes of a given type.
    // Short summary of what this AI has ACTUALLY discovered, by type — used to
    // ground a rejected harvest/assign so the model stops chasing a resource it
    // only imagines (it cannot see the rendered map; only "discoveredNodesOnMap").
    discoveredResourceSummary(ai, game) {
        const counts = {};
        const list = (game.terrain && game.terrain.resources) || [];
        list.forEach((res, idx) => {
            // Believed amount, so this summary agrees with discoveredNodesOnMap rather than
            // naming a type the state does not list (or omitting one it does).
            const k = this.knownAmount(ai, res, idx, game);
            if (k.known && k.amount > 0) {
                counts[res.type] = (counts[res.type] || 0) + 1;
            }
        });
        const parts = ['food', 'wood', 'stone', 'gold']
            .filter(t => counts[t])
            .map(t => `${t} (${counts[t]})`);
        return parts.length ? parts.join(', ') : 'nothing yet';
    }

    // How much this player BELIEVES is in a node. Live while the node is in sight,
    // otherwise the amount as last seen.
    //
    // Reading the live amount for a node out of sight leaked: a rival draining a
    // remembered node showed up as the number ticking down, and emptying it made the
    // node vanish from the list — enemy activity, in a place the player cannot see,
    // for free. Fog has to mean the contents are stale too, not just the position.
    knownAmount(ai, res, idx, game) {
        if (!ai._knownResIdx) ai._knownResIdx = new Set();
        if (!ai._knownResAmt) ai._knownResAmt = Object.create(null);
        if (this.isPositionVisibleToAI(ai, res.x, res.z, game)) {
            ai._knownResIdx.add(idx);
            ai._knownResAmt[idx] = Math.floor(res.amount);   // refresh what we can see
            return { amount: Math.floor(res.amount), visible: true, known: true };
        }
        const known = ai._knownResIdx.has(idx);
        return {
            amount: known ? (ai._knownResAmt[idx] != null ? ai._knownResAmt[idx] : Math.floor(res.amount)) : 0,
            visible: false, known
        };
    }

    discoveredNodesOfType(ai, game, resourceType) {
        const out = [];
        const list = (game.terrain && game.terrain.resources) || [];
        list.forEach((res, idx) => {
            const k = this.knownAmount(ai, res, idx, game);
            // BELIEVED amount, not the live one: otherwise a node the state still
            // lists (because the player last saw it full) would be refused here as
            // "not discovered", and the model gets two contradictory answers.
            if (k.known && res.type === resourceType && k.amount > 0) out.push(res);
        });
        return out;
    }

    // True only if a unit is ACTIVELY fighting a live target (so we must not pull it
    // off to scout). A unit merely marching to a stale attack-move objective — no
    // living target — is NOT fighting and may be redirected; otherwise a cavalry
    // with a leftover attack flag was skipped and explore silently picked a worker,
    // leaving the cavalry standing still while move_units (no such filter) worked.
    isInCombat(u) {
        return !!(u && u.isAttacking && u.attackTarget && u.attackTarget.health > 0);
    }

    // Pick the best scout. A free MILITARY unit is the right scout — it doesn't cost
    // you economy and (cavalry especially) is fast with extra vision. So:
    //   1) an idle cavalry unit (fastest + widest sight),
    //   2) any other idle military unit (not in combat),
    //   3) an idle worker, 4) a non-building worker,
    //   5) last resort: any non-combat unit, then anything at all.
    // Workers are only used when no military is free — and military that is busy
    // fighting is never pulled.
    //
    // If `preferredType` is given (a unit id like "scout_cavalry" OR a category
    // like "cavalry"), an idle unit of that type is chosen when one exists; if
    // none is free we fall back to the automatic logic below.
    // Which turn is this seat on? Used to tell "free" from "already sent scouting by
    // an earlier command in THIS turn", which are different things and used not to be.
    _turnOf(ai) {
        const c = this.aiControllers.find(x => x.aiPlayer === ai);
        return c ? c.turnCount : -1;
    }

    // A reply may carry three explore commands. pickScout used to answer all three with
    // the SAME unit -- best scout, then best scout again -- so command 2 quietly
    // retargeted the unit command 1 had just sent west, and command 3 retargeted it
    // again. The model reads three OKs and believes three tiles are being swept; one
    // unit is walking north. Observed live across several models.
    //
    // A unit already sent this turn is therefore not available to the next command. Not
    // the harness choosing: it is refusing to silently undo an order the model has
    // already been told succeeded.
    pickScout(ai, preferredType = null) {
        const turn = this._turnOf(ai);
        const notSentYet = (u) => u._exploreTurn !== turn;
        if (preferredType) {
            const pt = String(preferredType).trim().toLowerCase();
            const ofType = ai.units.filter(u =>
                (u.type || '').toLowerCase() === pt || (u.unitType || '').toLowerCase() === pt);
            const ofTypeFree = ofType.filter(notSentYet);
            if (ofTypeFree.length) {
                // The model explicitly named this unit, so honor it even if it is
                // fighting — but still prefer a non-fighting one of that type first.
                const free = ofTypeFree.filter(u => !this.isInCombat(u));
                const pool = free.length ? free : ofTypeFree;
                const idle = pool.find(u => u.type === 'worker' ? this.game.isIdleWorker(u) : !u.isMoving);
                return idle || pool[0];
            }
            // requested type isn't present → fall through to the automatic pick
        }

        // Priests are excluded from the auto-pick: a healer wandering the dark
        // alone is a wasted (and soon dead) medic. Explicit unitType still wins.
        const idleMilitary = ai.units.filter(u => u.type !== 'worker' && u.unitType !== 'support' && !this.isInCombat(u) && notSentYet(u));
        const cav = idleMilitary.find(u => u.unitType === 'cavalry');
        if (cav) return cav;
        if (idleMilitary.length) return idleMilitary[0];

        const idleWorker = ai.units.find(u => u.type === 'worker' && this.game.isIdleWorker(u) && notSentYet(u));
        if (idleWorker) return idleWorker;
        const freeWorker = ai.units.find(u => u.type === 'worker' && u.task !== 'building' && !u.isBuilding && notSentYet(u));
        if (freeWorker) return freeWorker;

        return ai.units.find(u => u.unitType !== 'support' && !this.isInCombat(u) && notSentYet(u)) ||
               ai.units.find(u => u.type !== 'worker' && u.unitType !== 'support' && notSentYet(u)) || null;
    }

    // Did `scout` satisfy the model's explicit unit choice? (id or category match)
    scoutMatchesChoice(scout, preferredType) {
        if (!preferredType || !scout) return true; // no choice made → nothing to satisfy
        const pt = String(preferredType).trim().toLowerCase();
        return (scout.type || '').toLowerCase() === pt || (scout.unitType || '').toLowerCase() === pt;
    }

    // Strip a unit of its current job (harvesting/farm/combat) so it can cleanly
    // take a new order. Critically clears isHarvesting + harvest timers — leaving
    // those set made a pulled worker keep "harvesting" instead of scouting/moving.
    releaseUnitForOrders(u) {
        if (!u) return;
        if (u.farmRef && u.farmRef.assignedWorker === u) u.farmRef.assignedWorker = null;
        u.farmRef = null;
        u.harvestTarget = null;
        u.isHarvesting = false;
        u.harvestTimer = 0;
        u.harvestAmount = 0;
        u.carryingResource = false;
        u.isAttacking = false;
        u.attackTarget = null;
        u.attackMove = null;
        u._origTarget = null;  // retaliation ladder ends with the combat job
        u._retalQueue = null;
        u.marchSpeed = null;   // a new job walks at its own speed, not the last march's
        u.formationOffset = null;
        u.formationGroup = null;
        u._orderToken = ++this._orderSeq; // reassigned → drops out of any prior attack report
    }

    // dispatchScoutToward lived here: it auto-picked a frontier tile and sent a scout
    // when the model called explore() bare, or named a resource it had never found.
    // Removed — map.exploration gives the model the same grid this used, so choosing
    // where to look is its job. game.leastExploredSection() survives for the
    // rule-based AI, which still scouts on its own.

    // Without a finished Town Center gathered goods can never be delivered —
    // say so instead of letting the model burn turns on pointless harvesting.
    noTownCenterAdvice(ai) {
        if (ai.buildings.some(b => b.type === 'town_center' && !b.underConstruction)) return null;
        const tcDef = (typeof getBuildingDef === 'function') ? getBuildingDef('town_center') : null;
        const costStr = tcDef ? Object.entries(tcDef.cost || {}).filter(([, v]) => v > 0).map(([k, v]) => `${v} ${k}`).join(', ') : 'its cost';
        this.outcome('log.out.noTCWorkers', {});
        return `[ERROR] No finished Town Center. Gathered resources are delivered to a Town Center; none are banked without one. town_center costs ${costStr}.`;
    }

    // executeHarvestResource lived here. Removed: it was assign_workers with the
    // options taken away — one worker, no count, and the targetX/targetZ the prompt
    // advertised were never even passed to it, so a model aiming at a chosen node
    // silently got the one nearest its worker. assign_workers already prefers idle
    // workers (workerPullRank scores idle 0), so nothing it guaranteed was lost.

    // Normalize/validate a gatherable resource type. Returns the canonical lower-
    // case type ('food'|'wood'|'stone'|'gold') or null if it isn't a real resource
    // — so a stray "house"/"barracks" is rejected instead of triggering a pointless
    // "no house discovered, scouting…" reply.
    normalizeResourceType(resourceType) {
        const rt = (resourceType || '').toString().trim().toLowerCase();
        return ['food', 'wood', 'stone', 'gold'].includes(rt) ? rt : null;
    }

    nearestNodeTo(unit, nodes) {
        let best = null, bd = Infinity;
        nodes.forEach(n => { const d = Math.hypot(n.x - unit.x, n.z - unit.z); if (d < bd) { bd = d; best = n; } });
        return best || nodes[0];
    }

    // Reassign workers OFF their current tasks onto a new job (harvest a type).
    // assign_workers {"resourceType":"farm"} — put workers back on UNMANNED farms.
    // A farm regrows food only while a hand stands on it, and pulling every worker
    // onto one resource is a legitimate call that silently darkens every farm you
    // own. Before this there was no way to SEE that (a farm's "activity" always
    // reads "idle") and no way to undo it: farms were only ever staffed by the
    // worker who built one, or by the idle-worker sweep — which never fires while
    // every hand is busy. Same pull triage as the resource path, so a rescue
    // disturbs the economy exactly as predictably as any other reassignment.
    executeAssignFarmers(ai, game, params) {
        const noTC = this.noTownCenterAdvice(ai);
        if (noTC) return noTC;

        const farms = ai.buildings.filter(b => b.type === 'farm' && !b.underConstruction && b.health > 0);
        if (farms.length === 0) {
            const site = ai.buildings.some(b => b.type === 'farm' && b.underConstruction);
            this.outcome(site ? 'log.out.farmUnderConstr' : 'log.out.noFinishedFarms', {});
            return site
                ? `[ERROR] Your farm is still under construction — the worker building it stays on as its farmer once it finishes. Nothing to staff yet.`
                : `[ERROR] You own no finished farms. Build one with build_structure {"buildingType":"farm"} (needs the "farm" research); its builder stays on as the farmer. Farms regrow food indefinitely — berry bushes do not.`;
        }
        const open = farms.filter(f => !game.farmFarmer(f));
        if (open.length === 0) {
            this.outcome('log.out.farmAllManned', { count: farms.length });
            return `OK - All ${farms.length} of your farm(s) are already manned; nothing to do. A farm only regrows food while its worker stands on it.`;
        }

        // Which farm first? An explicit target picks one; otherwise the shortest
        // delivery loop wins — same rule as the resource path.
        const gaveX = OpenAIAIManager.given(params.targetX);
        const gaveZ = OpenAIAIManager.given(params.targetZ);
        if (gaveX || gaveZ) {
            const tx = Number(params.targetX), tz = Number(params.targetZ);
            if (!gaveX || !gaveZ || !Number.isFinite(tx) || !Number.isFinite(tz)) {
                this.outcome('log.out.farmNeedsCoords', {});
                return `[ERROR] assign_workers to "farm" takes BOTH numeric "targetX" and "targetZ" (one of your farms in "buildings"), or neither — then your unmanned farms are staffed nearest-Town-Center first.`;
            }
            open.sort((a, b) => Math.hypot(a.x - tx, a.z - tz) - Math.hypot(b.x - tx, b.z - tz));
        } else {
            const tcs = ai.buildings.filter(b => b.type === 'town_center' && !b.underConstruction);
            const dTC = f => tcs.reduce((m, tc) => Math.min(m, Math.hypot(f.x - tc.x, f.z - tc.z)), Infinity);
            open.sort((a, b) => dTC(a) - dTC(b));
        }
        const want = Math.max(1, Math.min(params.count || open.length, open.length));

        // Never cannibalize a farm to feed a farm, and never take a builder or a
        // fighter — the same exclusions the resource path applies.
        const isFighting = u => u.isAttacking || u.attackTarget || u.attackMove;
        const candidates = ai.units.filter(u =>
            u.type === 'worker' && u.health > 0 &&
            u.task !== 'building' && !u.isBuilding && !isFighting(u) && !u.farmRef);
        if (candidates.length === 0) {
            const building = ai.units.filter(u => u.type === 'worker' && (u.task === 'building' || u.isBuilding)).length;
            const fighting = ai.units.filter(u => u.type === 'worker' && isFighting(u)).length;
            this.outcome('log.out.noWorkersForFarms', { open: open.length });
            return `[ERROR] No workers can be spared for your ${open.length} unmanned farm(s): ${building} are constructing, ${fighting} are fighting (neither is ever pulled), and the rest already man farms.`;
        }
        const rank = u => game.workerPullRank(ai, u);
        candidates.sort((a, b) => rank(a) - rank(b));

        let manned = 0;
        const pulledFrom = {};
        for (const f of open.slice(0, want)) {
            const w = candidates[manned];
            if (!w) break;
            const r = rank(w);
            const label = r === 0 ? 'idle' : r === 5 ? 'scouting' : r === 6 ? 'repairing'
                : (w.harvestTarget ? `from ${w.harvestTarget.type}` : 'spare');
            pulledFrom[label] = (pulledFrom[label] || 0) + 1;
            w._formerTask = null;
            w.task = 'farm_work';
            w.farmRef = f;
            f.assignedWorker = w;
            w.harvestTarget = null;
            w.buildTarget = null;
            w.repairTarget = null;
            w.isHarvesting = false;
            w.carryingResource = false;
            w.harvestAmount = 0;
            w.isMoving = true;
            w.targetX = f.x + (Math.random() - 0.5) * 3;
            w.targetZ = f.z + (Math.random() - 0.5) * 3;
            manned++;
        }
        const src = Object.entries(pulledFrom).map(([k, n]) => `${n} ${k}`).join(', ');
        const left = open.length - manned;
        const short = left > 0 ? ` ${left} farm(s) still stand unmanned — you ran out of spare workers.` : '';
        this.outcome('log.out.farmManned', { count: manned, pulled: this.pulledCounts(pulledFrom), left: Math.max(0, open.length - manned) });
        return `OK - Sent ${manned} worker(s) to man ${manned} farm(s) — pulled: ${src}. Each regrows food only while its worker stays on it.${short}`;
    }

    executeAssignWorkers(ai, game, params) {
        // "farm" is a JOB, not a node type: it staffs your own farms rather than
        // sending workers to a spot on the map. Routed before normalizeResourceType
        // so the gatherable vocabulary stays
        // exactly food|wood|stone|gold.
        const raw = String(params.resourceType || '').toLowerCase().trim();
        if (raw === 'farm' || raw === 'farms') return this.executeAssignFarmers(ai, game, params);

        const resourceType = this.normalizeResourceType(params.resourceType);
        if (!resourceType) {
            this.outcome('log.out.assignNeedsResource', {});
            return `[ERROR] assign_workers requires a "resourceType": food|wood|stone|gold to gather, or "farm" to man your own farms. (To construct a building, use build_structure instead.)`;
        }
        const noTC = this.noTownCenterAdvice(ai);
        if (noTC) return noTC;
        const count = Math.max(1, Math.min(params.count || 3, 20));

        // Discovered nodes? If not, nothing is reassigned — and no scout goes out on
        // the model's behalf: a failed action must not quietly play a turn for it.
        const discovered = this.discoveredNodesOfType(ai, game, resourceType);
        if (discovered.length === 0) {
            const have = this.discoveredResourceSummary(ai, game);
            this.outcome('log.out.notDiscovered', { res: resourceType });
            return `[ERROR] ${resourceType}: none discovered. Discovered so far: ${have}. A resource exists for you only once one of your units has seen it.`;
        }

        // Which node? Explicit targetX/targetZ picks the discovered node nearest
        // that point; otherwise the node nearest ANY finished Town Center wins —
        // the shortest delivery loop is the fastest economy.
        const gaveX = OpenAIAIManager.given(params.targetX);
        const gaveZ = OpenAIAIManager.given(params.targetZ);
        let node;
        let nodeNote;
        if (gaveX || gaveZ) {
            const tx = Number(params.targetX), tz = Number(params.targetZ);
            if (!gaveX || !gaveZ || !Number.isFinite(tx) || !Number.isFinite(tz)) {
                this.outcome('log.out.assignNeedsCoords', { res: resourceType });
                return `[ERROR] assign_workers takes BOTH numeric "targetX" and "targetZ" (a ${resourceType} node from "nearestNodes", or any other you have scouted), or neither — then the node nearest your Town Center is used.`;
            }
            node = this.nearestNodeTo({ x: tx, z: tz }, discovered);
            nodeNote = 'nearest your target';
        } else {
            const tcs = ai.buildings.filter(b => b.type === 'town_center' && !b.underConstruction);
            let bd = Infinity;
            node = discovered[0];
            for (const n of discovered) {
                for (const tc of tcs) {
                    const d = Math.hypot(n.x - tc.x, n.z - tc.z);
                    if (d < bd) { bd = d; node = n; }
                }
            }
            nodeNote = 'nearest your Town Center';
        }

        // Pull order, cheapest disruption first: idle hands, then gatherers from
        // Optional SOURCE. Omitted, the triage below picks as it always has (idle
        // first, then the fattest stockpile down). Given, the MODEL chooses where the
        // workers come from — which is what makes workers.onX worth reading at all:
        // deciding to thin out food is worth nothing if the pick then takes them
        // off gold. It is parsed here, above the candidate filter, because the filter
        // needs to know what was asked for before it can decide who is eligible.
        // Same classifier as the state summary -- see OpenAIAIManager.workerJob. Only
        // these six are addressable sources; builders, scouts and workers in transit
        // map to null and stay out of every pool, which is also what the candidate
        // filter above already enforces for builders and fighters.
        const FROM_JOB = { farm: 'farm', food: 'food', wood: 'wood',
                           stone: 'stone', gold: 'gold', idle: 'idle' };
        const whereFrom = u => FROM_JOB[OpenAIAIManager.workerJob(game, u)] || null;
        const FROMS = ['food', 'wood', 'stone', 'gold', 'farm', 'idle'];
        const rawFrom = OpenAIAIManager.given(params.from)
            ? String(params.from).toLowerCase().trim() : null;
        const from = rawFrom === 'farms' ? 'farm' : rawFrom;
        if (from !== null && !FROMS.includes(from)) {
            this.outcome('log.out.assignBadFrom', {});
            return `[ERROR] assign_workers "from" is where workers are TAKEN FROM and must be one of ${FROMS.join('|')} — omit it to use ingame worker selection, which takes idle workers first, then your largest stockpile. Got ${JSON.stringify(params.from)}.`;
        }
        // Same source and destination is only a no-op WITHOUT coordinates. With them the
        // model is naming a NODE — take the workers already on gold and move them to the
        // gold deposit nearest this point — which is a relocation, and the only way to
        // express one. This rejected exactly that: a model moving six gold workers off a
        // node at (341,27) onto one at (-124,103) to cut the walk, which is a better
        // decision than most, was told it wanted a job they already had. And the advice
        // made it worse: omitting "from" takes idle workers first and then the largest
        // stockpile, which is not the far-node crew it was trying to move.
        const relocating = OpenAIAIManager.given(params.targetX) || OpenAIAIManager.given(params.targetZ);
        if (from !== null && from === resourceType && !relocating) {
            this.outcome('log.out.assignFromSame', { res: resourceType });
            return `[ERROR] "from" and "resourceType" are both "${resourceType}" with no target, which would move workers onto the job they already have. A move needs somewhere to move to: "targetX"/"targetZ" for a different ${resourceType} node, or a "from" that differs from "resourceType".`;
        }

        // Triage, when the model does not name a source: idle workers first, then
        // the fattest stockpile down to the leanest (surplus labor is the most
        // expendable), then scouts, then repairers, then farmers — steady food is
        // the last thing to cannibalize. Builders and fighting workers (also by
        // auto-retaliation) are never pulled, nor are workers already on the
        // requested resource: assign_workers ADDS to it.
        //
        // Except when the model asked for a relocation. "from gold, to gold, at
        // (x,z)" means move the gold crew to a different gold node, and the crew it
        // means is precisely the one this filter drops — so the pool came out empty
        // BY CONSTRUCTION, and the diagnosis below then blamed the only other
        // exclusions it knew about and reported six walking miners as "constructing
        // or fighting". Letting the guard through without this was fixing the lock
        // and leaving the door.
        const isFighting = u => u.isAttacking || u.attackTarget || u.attackMove;
        const onSameRes = u => (u.task === 'harvesting' || u.task === 'carrying')
            && u.harvestTarget && u.harvestTarget.type === resourceType;
        const sameNodeMove = relocating && from !== null && from === resourceType;
        let candidates = ai.units.filter(u =>
            u.type === 'worker' && u.health > 0 &&
            u.task !== 'building' && !u.isBuilding && !isFighting(u) &&
            (sameNodeMove || !onSameRes(u)));
        if (candidates.length === 0) {
            // Not a blocker when they are the ones being moved — reporting them as
            // one would name a reason that did not apply.
            const already = sameNodeMove ? 0 : ai.units.filter(u => u.type === 'worker' && onSameRes(u)).length;
            const building = ai.units.filter(u => u.type === 'worker' && (u.task === 'building' || u.isBuilding)).length;
            const fighting = ai.units.filter(u => u.type === 'worker' && isFighting(u)).length;
            this.outcome('log.out.noWorkersReassign', { already, res: resourceType, building, fighting });
            return `[ERROR] No workers could be reassigned: ${already} already harvest ${resourceType}, ${building} are constructing, ${fighting} are fighting (builders and fighting workers are never pulled).`;
        }

        if (from !== null) {
            const pool = candidates.filter(u => whereFrom(u) === from);
            if (!pool.length) {
                const onIt = ai.units.filter(u => u.type === 'worker' && whereFrom(u) === from).length;
                // Name the field that ACTUALLY exists. This was built as
                // "workers.on" + capitalise(from), which is right for the four
                // resources and wrong for the other two: it produced workers.onIdle
                // and workers.onFarm, neither of which is in the state. A model sent
                // to check a field that does not exist has nowhere to go.
                const FIELD = { food: 'onFood', wood: 'onWood', stone: 'onStone',
                                gold: 'onGold', farm: 'onFarms', idle: 'idle' };
                // And say which of the two situations it is. "0 are on it, and none of
                // those can be pulled" read as two separate reasons and left the real
                // one — that there is simply nobody there — impossible to pick out.
                // Did the state this seat read promise them? Only "idle" can evaporate
                // on its own; the four resources and the farms do not empty themselves
                // between the snapshot and the order.
                // The controller is not a parameter here; found the way pushDecisionFor
                // finds it, from the player this action belongs to.
                const ctl = (this.aiControllers || []).find(x => x.aiPlayer === ai);
                const promised = (from === 'idle' && ctl && ctl._sentIdle > 0) ? ctl._sentIdle : 0;
                const why = promised
                    ? `the ${promised} idle worker(s) your state showed were picked up again before this order landed`
                    : onIt === 0
                    ? `you have no workers on "${from}" (workers.${FIELD[from]} is 0)`
                    : `all ${onIt} of them are constructing or fighting, and those are never pulled`;
                this.outcome(promised ? 'log.out.assignIdleRaced' : 'log.out.assignFromEmpty',
                             { from, res: resourceType, had: promised });
                return `[ERROR] No workers could be taken from "${from}": ${why}. Omitting "from" uses ingame worker selection, which takes idle workers first, then your largest stockpile.`;
            }
            candidates = pool;   // STRICT: an explicit source is not quietly widened
        }

        // Spilling is a POLICY the model states and the harness applies here, where
        // the truth is known. It cannot be planned from the state: a gather round trip
        // runs 12-32s and a reply takes 1.6-36s, so any count of who is carrying is a
        // whole cycle stale by the time the order arrives, describing different
        // workers. What the model CAN say is what it wants done when the moment comes.
        const carrying = u => !!(u.carryingResource || u.task === 'carrying');
        let allowSpill = true;
        if (OpenAIAIManager.given(params.allowSpill)) {
            const v = typeof params.allowSpill === 'string'
                ? params.allowSpill.trim().toLowerCase() : params.allowSpill;
            if (v === true || v === 'true') allowSpill = true;
            else if (v === false || v === 'false') allowSpill = false;
            else {
                this.outcome('log.out.assignBadSpill', {});
                return `[ERROR] assign_workers "allowSpill" must be true or false. true (the default) moves the workers you asked for even if some are carrying a load, which is lost. false moves only workers not carrying anything right now, and moves fewer if that is all there are. Got ${JSON.stringify(params.allowSpill)}.`;
            }
        }
        if (!allowSpill) {
            const free = candidates.filter(u => !carrying(u));
            if (!free.length) {
                const held = candidates.length;
                this.outcome('log.out.assignAllCarrying', { n: held, res: resourceType });
                return `[ERROR] Nobody could be moved without losing a load: all ${held} available worker(s) are carrying one right now. "allowSpill": true takes them anyway and loses what they hold.`;
            }
            candidates = free;
        }

        // Tier policy lives in game.workerPullRank — the same triage that picks
        // builders, so every kind of pull disturbs the economy the same way. Within a
        // tier, take the ones NOT carrying first: reassigning destroys a full load, and
        // an empty-handed worker at the same node costs nothing to move. The tiers
        // used to rank a loaded worker and an empty one identically, so a request for
        // three could destroy three loads while three empty ones stood beside them.
        // This runs on LIVE state, which is why it works where a state count could not.
        const rank = u => game.workerPullRank(ai, u);
        const loaded = u => carrying(u) ? 1 : 0;
        candidates.sort((a, b) => (rank(a) - rank(b)) || (loaded(a) - loaded(b)));

        let moved = 0;
        const pulledFrom = {};
        const spilled = {};      // resource -> amount destroyed by pulling a loaded worker
        for (const w of candidates) {
            if (moved >= count) break;
            const r = rank(w);
            const label = r === 0 ? 'idle' : r === 5 ? 'scouting' : r === 6 ? 'repairing' : r === 7 ? 'farming' : `from ${w.harvestTarget.type}`;
            pulledFrom[label] = (pulledFrom[label] || 0) + 1;
            // A carried load is destroyed by the reassignment. Sorted last, so this
            // only happens once the free workers run out — but it is a real cost and
            // the model can only learn it from being told.
            if ((w.carryingResource || w.task === 'carrying') && w.harvestAmount > 0) {
                const rt = w.carryingResourceType || (w.harvestTarget && w.harvestTarget.type) || 'resources';
                spilled[rt] = (spilled[rt] || 0) + w.harvestAmount;
            }
            if (w.farmRef && w.farmRef.assignedWorker === w) w.farmRef.assignedWorker = null;
            w.farmRef = null;
            w._formerTask = null;
            w.task = 'harvesting';
            w.harvestTarget = node;
            w.buildTarget = null;
            w.repairTarget = null;
            w.isMoving = true;
            w.targetX = node.x + (Math.random() - 0.5) * 2;
            w.targetZ = node.z + (Math.random() - 0.5) * 2;
            w.isHarvesting = false;
            w.carryingResource = false;
            w.harvestAmount = 0;
            moved++;
        }
        const src = Object.entries(pulledFrom).map(([k, n]) => `${n} ${k}`).join(', ');
        const short = moved < count
            ? (!allowSpill
                ? ` Fewer than requested: only ${moved} were empty-handed at that moment, and "allowSpill": false left the rest gathering.`
                : from !== null
                    ? ` Fewer than requested: only ${moved} could be taken from "${from}".`
                    : ` Fewer than requested: the others are constructing or fighting (never pulled), already on ${resourceType}, or you don't have that many workers.`)
            : '';
        // What the reassignment actually COST. Workers carrying a load drop it, and
        // the free ones are taken first — so this only appears when more were asked
        // for than were empty-handed, with allowSpill left at its default. The amount
        // is the fact; noticing that allowSpill:false would have avoided it is the
        // play, and that is the model's to make.
        // "Dropped" was wrong and teachable-wrong: it implies the load is lying on the
        // ground and could be fetched. It is destroyed (harvestAmount = 0), and a model
        // reading "dropped" could reasonably send someone back for it.
        const spillTxt = Object.keys(spilled).length
            ? ` Returning workers spilled ${Object.entries(spilled).map(([r, n]) => `${n} ${r}`).join(', ')} they were carrying.`
            : '';
        // Gathering is a ROUND TRIP: walk out, gather, carry it back to a Town Center.
        // The state gives node coordinates and nothing about what distance costs, and
        // models were picking far nodes as if delivery were free. Report the haul on
        // the turn the choice is made — cheaper than an eta on every node every turn,
        // and it lands exactly where the decision happens.
        const tcs = ai.buildings.filter(b => b.type === 'town_center' && !b.underConstruction);
        const nearTC = tcs.reduce((best, b) => {
            const d = Math.hypot(b.x - node.x, b.z - node.z);
            return (!best || d < best.d) ? { b, d } : best;
        }, null);
        const haul = nearTC ? ` Each load is a ~${Math.max(1, Math.round(nearTC.d / (3 * 1.0)))}s walk back to your nearest Town Center.` : '';
        this.outcome('log.out.reassigned', { count: moved, res: resourceType, x: Math.round(node.x), z: Math.round(node.z), near: (gaveX || gaveZ) ? 'target' : 'tc', pulled: this.pulledCounts(pulledFrom) });
        return `OK - Reassigned ${moved} worker(s) to harvest ${resourceType} at (${Math.round(node.x)}, ${Math.round(node.z)}) — the node ${nodeNote} — pulled: ${src}.${spillTxt}${haul}${short}`;
    }

    // Put workers on fixing a damaged own building (free; uses the build task's
    // machinery — game.assignWorkersToBuilding routes to task 'repairing').
    executeRepairBuilding(ai, game, params) {
        const damaged = ai.buildings.filter(b => !b.underConstruction && b.health > 0 && b.health < b.maxHealth);
        if (damaged.length === 0) {
            this.outcome('log.out.nothingToRepair', {});
            return `[ERROR] None of your buildings are damaged — nothing to repair. (Construction SITES are finished automatically by the worker build_structure assigned.)`;
        }
        let target;
        const gaveX = OpenAIAIManager.given(params.targetX);
        const gaveZ = OpenAIAIManager.given(params.targetZ);
        if (gaveX || gaveZ) {
            const tx = Number(params.targetX), tz = Number(params.targetZ);
            if (!gaveX || !gaveZ || !Number.isFinite(tx) || !Number.isFinite(tz)) {
                this.outcome('log.out.repairNeedsCoords', {});
                return `[ERROR] repair_building needs BOTH numeric "targetX" and "targetZ" (of YOUR damaged building), or omit both to repair your most damaged one.`;
            }
            let best = null, bd = Infinity;
            damaged.forEach(b => {
                const d = Math.hypot(b.x - tx, b.z - tz);
                if (d < bd) { bd = d; best = b; }
            });
            if (!best || bd > 12) {
                const list = damaged.map(b => `${b.type} at (${Math.round(b.x)}, ${Math.round(b.z)}) ${Math.round(b.health / b.maxHealth * 100)}% HP`).join('; ');
                this.outcome('log.out.noDamagedNear', { x: Math.round(tx), z: Math.round(tz) });
                return `[ERROR] No damaged building of yours near (${Math.round(tx)}, ${Math.round(tz)}). Damaged now: ${list}.`;
            }
            target = best;
        } else {
            target = damaged.reduce((a, b) => (a.health / a.maxHealth <= b.health / b.maxHealth ? a : b));
        }
        const count = Math.max(1, Math.min(params.count || 1, 5));
        const workers = ai.units
            .filter(u => u.type === 'worker' && u.health > 0 && u.task !== 'building' && !u.isBuilding)
            .sort((a, b) => Math.hypot(a.x - target.x, a.z - target.z) - Math.hypot(b.x - target.x, b.z - target.z))
            .slice(0, count);
        if (workers.length === 0) {
            this.outcome('log.out.noWorkersRepair', {});
            return `[ERROR] No workers available to repair (all are constructing).`;
        }
        workers.forEach(w => {
            if (w.farmRef && w.farmRef.assignedWorker === w) w.farmRef.assignedWorker = null;
            w.farmRef = null;
        });
        const mode = game.assignWorkersToBuilding(workers, target);
        if (!mode) { this.outcome('log.out.repairFailed', {}); return `[ERROR] Could not start the repair (the building may have just been destroyed).`; }
        const pct = Math.round(target.health / target.maxHealth * 100);
        const barrier = game.repairBarrierMsLeft ? game.repairBarrierMsLeft(target) : 0;
        const barrierNote = barrier > 0
            ? ` NOTE: it is still under fire — repairs are locked until 10s after the LAST hit; the workers wait on site and start automatically.`
            : '';
        this.outcome('log.out.repairStarted', { count: workers.length, type: target.type, x: Math.round(target.x), z: Math.round(target.z), pct });
        return `OK - ${workers.length} worker(s) repairing your ${target.type} at (${Math.round(target.x)}, ${Math.round(target.z)}), currently ${pct}% HP.${barrierNote} They idle when it is fully repaired — reassign them to resources afterwards.`;
    }

    executeExplore(ai, game, params) {
        const T = game.EXPLORE_TILES || 7;
        const lastCol = String.fromCharCode(64 + T);
        // Optional: name a unit to scout with (id like "scout_cavalry" or a category
        // like "cavalry"/"worker"); omit it to auto-pick the best scout.
        // move_units and attack_target take {type: count}, so a model writing
        // {"worker": 1} here is using the vocabulary as taught. It used to be handed to
        // String(), which yields "[object Object]" -- and that went straight into the
        // reply the model reads, ninety-one times in one match, inside the sentence
        // meant to explain which scout it got instead. Accept the map, take the type.
        const rawType = params.unitType;
        const preferredType = (rawType && typeof rawType === 'object' && !Array.isArray(rawType))
            ? (Object.keys(rawType)[0] || null)
            : (rawType ? String(rawType).trim() : null);
        const raw = params.tile;
        const gave = OpenAIAIManager.given(raw);

        // Coordinates used to be the input here. Catch them by name: a model that
        // sends targetX/targetZ has the right intent and the wrong shape, and saying
        // so beats a generic "tile required".
        if (!gave && (params.targetX !== undefined || params.targetZ !== undefined)) {
            this.outcome('log.out.exploreNeedsTile', {});
            return `[ERROR] explore takes a map "tile", not coordinates. Pass one label from "map.exploration" — column A-${lastCol} then row 1-${T}, e.g. "tile":"C5". Your tiles: ${this.baseTilesString(ai, game)}.`;
        }
        if (!gave) {
            this.outcome('log.out.exploreNeedsTile', {});
            return `[ERROR] explore needs a "tile": one label from "map.exploration" — column A-${lastCol} then row 1-${T}, e.g. "tile":"C5". "map.exploration" gives the percent of each tile you have already seen. Your tiles: ${this.baseTilesString(ai, game)}.`;
        }

        const t = this.parseTile(raw, T);
        if (!t) {
            this.outcome('log.out.exploreBadTile', { tile: String(raw) });
            return `[ERROR] "${raw}" is not a map tile. Use a COLUMN LETTER then a ROW NUMBER: A-${lastCol} and 1-${T}, e.g. "C5" (not "5C", and not coordinates). The tiles and how much of each you have seen are in "map.exploration".`;
        }

        // Explicit handles win outright, exactly as they do for move_units and
        // attack_target. Models reached for this unprompted -- six times across 394
        // explores, with reasons like "Militia #11 idle at base" -- and the parameter
        // was dropped without a word, which is the vocabulary being inconsistent rather
        // than the model being wrong.
        const turn = this._turnOf(ai);
        const ids = (Array.isArray(params.unitIds) && params.unitIds.length) ? params.unitIds : null;
        let scout = null, named = null;
        if (ids) {
            const byHandle = new Map();
            ai.units.forEach(u => { if (u.health > 0) byHandle.set(Number(u.handle), u); });
            const picked = [], missing = [];
            ids.forEach(raw => {
                const u = byHandle.get(Number(raw));
                if (u) { if (!picked.includes(u)) picked.push(u); } else missing.push(raw);
            });
            // Every handle dead is the same situation attack_target already recognises:
            // they were in the state this seat read and died while it was thinking.
            if (!picked.length) return this.orderedUnitsGone(ai, missing);
            scout = picked.find(u => u._exploreTurn !== turn) || null;
            if (!scout) {
                this.outcome('log.out.exploreAlreadySent', {});
                return `[ERROR] ${picked.length === 1 ? 'That unit is' : 'Those units are'} already scouting `
                     + `this turn on an earlier command, so nothing was sent. Name a different unit, or send `
                     + `this tile next turn.`;
            }
            named = missing.length ? ` (no longer yours or already dead: ${missing.join(', ')})` : '';
        } else {
            scout = this.pickScout(ai, preferredType);
        }
        if (!scout) {
            // Distinguish "you own nothing that can scout" from "the one that could is
            // already going somewhere else this turn". The second used to read as the
            // first, which is a different problem with a different answer.
            const anyLeft = ai.units.some(u => u.health > 0 && u.unitType !== 'support' && u._exploreTurn === turn);
            this.outcome('log.out.noUnitExplore', {});
            return anyLeft
                ? `[ERROR] Every unit that could scout is already going somewhere else this turn on an earlier `
                  + `command, so nothing was sent. One explore per free unit per turn; name unitIds to choose who goes.`
                : `[ERROR] No unit available to explore.`;
        }
        const wasBusy = scout.type === 'worker' && !this.game.isIdleWorker(scout);
        const missedChoice = preferredType && !this.scoutMatchesChoice(scout, preferredType);

        // Aim somewhere inside the tile, inset by the scout's own sight radius so it
        // reveals ground rather than hugging the border.
        const vision = game.unitVision ? game.unitVision(scout) : 15;
        const { x: tx, z: tz } = this.pointInTile(game, t.row, t.col, vision, ai);
        const eta = this.travelEtaSec(scout, tx, tz);
        this.releaseUnitForOrders(scout); // cleanly drop any harvest/farm/combat job
        scout.task = scout.type === 'worker' ? 'scouting' : null;
        scout.isMoving = true;
        scout.targetX = tx;
        scout.targetZ = tz;
        scout._exploreTurn = turn;   // a later command this turn must not retarget it

        // Report what the tile is at NOW. A tile is ~114 units across and a scout
        // sees ~15, so one pass moves it a few percent: without this the model sends
        // a scout, sees the number barely move, and concludes explore did nothing.
        const sum = game.explorationSummary ? game.explorationSummary(ai) : null;
        const pct = (sum && sum[t.row] && sum[t.row][t.col]) | 0;
        const label = this.tileLabel(t.row, t.col);
        const pulled = wasBusy ? ' (no worker was idle, so one was pulled off gathering — give it a job again once it arrives)' : '';
        const choiceNote = missedChoice ? ` (no idle "${preferredType}" was free, so your ${scout.type} was used instead)` : '';
        // WHICH unit went. With several explores in one turn the model has to be able to
        // tell them apart, and the handle is the name it already uses everywhere else.
        const who = scout.handle != null ? ` #${scout.handle}` : '';
        this.outcome('log.out.exploreSent', { tile: label, pct, eta });
        return `OK - Sent your ${scout.type}${who}${named || ''} to scout tile ${label} (~${eta}s to arrive). ${label} is ${pct}% explored so far; one pass uncovers only part of a tile, so expect to send scouts there again.${pulled}${choiceNote}`;
    }

    executeDeleteUnit(ai, game, params) {
        const raw = (params.unitType || 'worker').toString().trim();
        const type = raw.toLowerCase();
        const count = Math.max(1, Math.min(params.count || 1, 20));

        // Match on either the unit id ("militia") OR its category ("infantry"),
        // case-insensitively — the model often passes the category or a label it
        // saw rather than the exact id.
        let pool = ai.units.filter(u =>
            (u.type || '').toLowerCase() === type ||
            (u.unitType || '').toLowerCase() === type);

        if (pool.length === 0) {
            // Honest, actionable feedback: tell the model exactly what it owns.
            const counts = {};
            ai.units.forEach(u => { counts[u.type] = (counts[u.type] || 0) + 1; });
            const have = Object.entries(counts).map(([t, n]) => `${t}×${n}`).join(', ') || '(no units)';
            this.outcome('log.out.noUnitDelete', { raw, have });
            return `[ERROR] You have no "${raw}" unit to delete. Your units: ${have}. Pass one of those "type" values (the "type" field shown for each unit in "friendlyUnits").`;
        }

        // Cull the least valuable first: idle workers before working ones, and
        // otherwise the weakest unit (lowest attack + HP) so you keep your best.
        pool.sort((a, b) => {
            if (a.type === 'worker' && b.type === 'worker') {
                return (this.game.isIdleWorker(a) ? 0 : 1) - (this.game.isIdleWorker(b) ? 0 : 1);
            }
            const sa = (a.attack || 0) + (a.maxHealth || 0);
            const sb = (b.attack || 0) + (b.maxHealth || 0);
            return sa - sb;
        });

        let removed = 0;
        const removedTypes = {};
        for (let i = 0; i < pool.length && removed < count; i++) {
            removedTypes[pool[i].type] = (removedTypes[pool[i].type] || 0) + 1;
            game.deleteOwnUnit(pool[i]);
            removed++;
        }
        const what = Object.entries(removedTypes).map(([t, n]) => `${n} ${t}`).join(', ');
        this.outcome('log.out.deleted', { what });
        return `OK - Deleted ${what}, freeing population.`;
    }

    executeDestroyBuilding(ai, game, buildingType, targetX, targetZ) {
        let pool = ai.buildings.filter(b => b.type === buildingType);
        if (pool.length === 0) {
            this.outcome('log.out.noBuildingDestroy', { buildingType });
            // Say what you DO own, the way delete_unit does — destroy_building acts on
            // your OWN structures, so the answer is always in friendlyBuildings.
            const counts = {};
            ai.buildings.forEach(b => { counts[b.type] = (counts[b.type] || 0) + 1; });
            const have = Object.entries(counts).map(([t, n]) => `${t}×${n}`).join(', ') || '(none)';
            return `[ERROR] You have no "${buildingType}" to destroy. Your buildings: ${have}. Pass one of those "type" values (the "type" field shown for each entry in "friendlyBuildings"). To attack an ENEMY building use attack_target instead.`;
        }
        let victim = pool[0];
        if (targetX !== undefined && targetZ !== undefined) {
            let bd = Infinity;
            pool.forEach(b => { const d = Math.hypot(b.x - targetX, b.z - targetZ); if (d < bd) { bd = d; victim = b; } });
        }
        const wasTC = victim.type === 'town_center';
        const remainingTC = ai.buildings.filter(b => b.type === 'town_center').length;
        if (wasTC && remainingTC <= 1) {
            this.outcome('log.out.refuseDestroyLastTC', {});
            return `[ERROR] Refusing to destroy your last Town Center — that would eliminate you.`;
        }
        game.destroyOwnBuilding(victim);
        this.outcome('log.out.destroyed', { buildingType, x: Math.round(victim.x), z: Math.round(victim.z) });
        return `OK - Destroyed your ${buildingType} at (${Math.round(victim.x)}, ${Math.round(victim.z)}).`;
    }

    isOwnedByAI(entity, ai) {
        return entity.owner === ai.id ||
               ai.units.includes(entity) ||
               ai.buildings.includes(entity);
    }

    // Has this AI actually discovered any enemy worth attacking? Mirrors the
    // fog-of-war filtering used to build the game state: an enemy counts only if
    // it is currently visible — EXCEPT enemy wonders, which are always revealed
    // to everyone, so a known wonder counts even with zero scouting.
    hasVisibleEnemies(ai, game) {
        // Remembered enemy buildings (discovered earlier, still alive) are valid
        // targets even when not currently in sight.
        if (ai._knownEnemyBuildings) {
            for (const b of ai._knownEnemyBuildings) {
                if (b && b.health > 0 && !this.isOwnedByAI(b, ai)) return true;
            }
        }
        for (const b of game.getAllBuildings()) {
            if (this.isOwnedByAI(b, ai)) continue;
            if (b.health <= 0) continue;
            if (b.isWonder || this.isPositionVisibleToAI(ai, b.x, b.z, game)) return true;
        }
        for (const u of game.getAllUnits()) {
            if (this.isOwnedByAI(u, ai)) continue;
            if (u.health <= 0) continue;
            if (this.isPositionVisibleToAI(ai, u.x, u.z, game)) return true;
        }
        return false;
    }

    // Shared guidance appended to attack errors so the model's next step is always
    // actionable: how to LIST the valid, already-discovered targets — or scout if
    // none are known yet. "enemyUnits"/"enemyBuildings" only ever contain enemies
    // you have already discovered (fog hides the rest).
    attackTargetHint(ai, game) {
        return this.hasVisibleEnemies(ai, game)
            ? 'To list valid targets, read "enemyUnits" and "enemyBuildings" in the game state — those are the enemies you have DISCOVERED (each with an "id", its x,z and owner). Attack one of those coordinates, or pass its exact "id" as params.targetId.'
            : 'No known enemy units or buildings. "enemyUnits" and "enemyBuildings" list only what one of your own units has seen.';
    }

    // ----------------------------------------------------------------
    // 13. Independent per-model update loop
    //     Every controller runs its OWN pipeline: it fires its next request
    //     as soon as its previous one returns (plus a small breather), fully
    //     concurrent with the others. No global turn order and no concurrency
    //     cap — so a faster model genuinely takes more turns. That speed is a
    //     real, intended advantage when comparing models.
    // ----------------------------------------------------------------
    // ---- Turn-based rounds -----------------------------------------------------
    // Off, seats run independent pipelines and a faster model genuinely takes more
    // turns — a real advantage, and an intended one when the question is "which model
    // plays this better in real time".
    //
    // On, the match becomes a board game played on a moving board. Every live seat is
    // handed the SAME state at the same instant and thinks in parallel; the match keeps
    // running while they do; and every answer is held until the LAST one arrives, then
    // applied together. So each seat gets exactly one move per round no matter how long
    // it took, and answering in 3s buys no earlier effect than answering in 30s.
    // Decisions-per-game-second becomes identical for every seat and latency stops
    // being the variable. A round costs the SLOWEST seat's reply, not the sum.
    //
    // The board is deliberately NOT frozen while seats think. Freezing would make every
    // move land on exactly the state it was chosen for, but it also means a 30s round
    // buys 5s of game — a match would take hours of wall clock, and a spectator watches
    // a still image. Running on costs both accuracy equally: all four read the same
    // snapshot and all four act on it the same number of seconds later.
    // Default only. The real value is per-match and set on the setup screen — a fixed
    // ceiling locked slow local models out of turn-based mode altogether, which is the
    // one mode where their slowness is supposed to stop mattering.
    static get ROUND_TIMEOUT_DEFAULT_MS() { return 90000; }
    static get ROUND_TIMEOUT_MIN_MS() { return 10000; }
    static get ROUND_TIMEOUT_MAX_MS() { return 900000; }
    roundTimeoutMs() {
        const n = Number(this._roundTimeoutMs);
        return (isFinite(n) && n > 0) ? n : OpenAIAIManager.ROUND_TIMEOUT_DEFAULT_MS;
    }

    // The hard abort for ONE model request. In turn-based mode the round deadline is
    // the authority, because it is the number we hand the model in
    // clock.secondsToAnswer and the one noteRoundMissed enforces. A fixed 180s below
    // that cut seats off while their own state promised them 240 -- the harness
    // contradicting itself, and the model paying for the difference with the turn.
    //
    // The margin matters: the round deadline must fire FIRST so the abort is reported
    // as what it is. Without it the two would race, and a missed round could be
    // announced as "timed out" -- which reads as a dead endpoint and sends anyone
    // debugging it after the wrong thing entirely.
    //
    // Real-time mode has no deadline, so the fixed guard stands: there the timeout is
    // the only thing stopping a dead endpoint from hanging a seat for the whole match.
    requestAbortMs() {
        if (!this.turnBased) return this.requestTimeout;
        return Math.max(this.requestTimeout, this.roundTimeoutMs() + 15000);
    }

    // A seat ran past the round deadline. Three things follow, and the first is the one
    // that was missing: the model is TOLD. It reads this on its next turn, alongside the
    // deadline itself in clock.secondsToAnswer, so it can decide to think less — which
    // it cannot do about a limit nobody mentioned.
    //
    // The in-flight request is aborted rather than left to land. Not aborting would
    // measure the seat's true latency, which is worth something, but each round would
    // then ask again while the last one was still running and a genuinely slow endpoint
    // would stack requests without bound. The cost is that this turn's latency is
    // censored at the timeout instead of recorded.
    //
    // It is NOT an action, so it never touches actionsAttempted or successRate. Missing
    // a deadline is a latency fact, and the mode exists precisely to stop latency being
    // scored as judgement.
    noteRoundMissed(controller) {
        const secs = Math.round(this.roundTimeoutMs() / 1000);
        if (controller.stats) controller.stats.roundsMissed = (controller.stats.roundsMissed || 0) + 1;
        // Flag it BEFORE aborting: the rejection this causes is about to surface in
        // sendToOpenAI's catch, which otherwise cannot tell our own scissors from a
        // failing endpoint and used to bill the model for both.
        controller._deadlineAbort = true;
        try { if (controller._abort) controller._abort.abort(); } catch (e) { /* already settled */ }
        const msg = `[TIMEOUT] Your answer did not arrive within ${secs}s of the state being sent, so this round was played without you. Every round gives every player the same ${secs}s; see clock.secondsToAnswer.`;
        controller.conversationHistory.push({
            action: 'round_missed', reason: '', result: msg, failed: true
        });
        const civ = getCivilization(controller.aiPlayer.civilization);
        this.decisionLog.unshift({
            timestamp: Date.now(), playerId: controller.aiPlayer.id,
            civName: civ?.name || controller.aiPlayer.civilization,
            color: '#' + ((civ?.color ?? 0xffffff)).toString(16).padStart(6, '0'),
            action: 'round_missed', reason: '', params: {}, failed: true,
            // The ROUND this belongs to. A miss is logged when the deadline expires,
            // which is `secs` after the round opened — by then the other seats have long
            // since acted and later rounds have scrolled past, so the entry sits nowhere
            // near the turn it explains and reads as a seat skipped in silence. The
            // number is the only thing that pairs them up again.
            round: this._roundNo,
            error: msg.replace(/^\[TIMEOUT\]\s*/, ''), lang: controller.model && controller.model.language,
            outcomeCode: 'log.out.roundMissed', outcomeParams: { secs, round: this._roundNo }
        });
        // Every other writer trims; this one did not, so a long match let the log grow
        // past its own cap through exactly the entries worth keeping least.
        if (this.decisionLog.length > this.maxLogEntries) this.decisionLog = this.decisionLog.slice(0, this.maxLogEntries);
        // On file as a MARKER, not a turn. record() would increment the turn counter and
        // make a skipped round indistinguishable from a move, inflating turnsFor() and
        // the decision count with it — so note() appends without touching either.
        //
        // The absence was unreadable in the other direction too. One seat in a real match
        // had 871 seconds between snapshots, and nothing on file said whether it had been
        // asked twenty times and missed them all or simply thought once. Those are
        // opposite conclusions about a model, and a transcript meant to be handed on
        // should not leave the reader to guess between them.
        if (this.transcripts) {
            const t0 = (this.game && this.game._timeline && this.game._timeline.t0) || Date.now();
            this.transcripts.note(controller.aiPlayer && controller.aiPlayer.id, {
                type: 'round_missed',
                at: Date.now(),
                round: this._roundNo,
                // Same clock as every state snapshot and the timeline graph, so a reader
                // can place the gap on the curve without converting anything.
                matchSeconds: Math.max(0, Math.round((Date.now() - t0) / 1000)),
                deadlineSeconds: secs,
                note: msg
            });
        }
    }

    // Is the question this answer was given to still the one on the table? Both halves
    // are load-bearing: the number catches an answer overtaken by a later round, and
    // the phase catches the round that resolved WITHOUT this seat — a timeout flush
    // leaves the number untouched, so the number alone would let that answer through.
    roundStillOpen(round) { return this._roundPhase === 'wait' && round === this._roundNo; }

    updateTurnBased(now, pausing) {
        const live = this.aiControllers.filter(c => {
            if (this.isControllerDefeated(c)) { if (!c.defeated) this.markDefeated(c); return false; }
            return !c.paused;
        });
        if (!live.length) return;

        if (this._roundPhase === 'wait') {
            if (live.some(c => c.pending)) {
                if (now - this._roundStartedAt <= this.roundTimeoutMs()) return;
                // One unreachable endpoint must not stall the other three: release
                // them, let the round resolve, and the slow seat simply misses it.
                // Missing seats are told so on their next turn — a deadline enforced
                // in silence is one a model cannot budget against.
                live.filter(c => c.pending).forEach(c => this.noteRoundMissed(c));
                live.forEach(c => { c.pending = false; });
            }
            this.flushRound(live);
            this._roundPhase = 'ask';
            this._roundEndedAt = now;
            return;
        }
        // A pause asked for mid-round is honoured HERE, at the boundary: the round that
        // was already asked has just flushed above, and the next one is simply not
        // opened. Pausing therefore always lands between rounds, never inside one.
        if (pausing) return;
        // The same breather real-time turns get, so four fast endpoints cannot spin
        // rounds quicker than the game can show them.
        if (this._roundEndedAt && now - this._roundEndedAt < this.turnInterval) return;
        this._roundNo++;
        this._roundStartedAt = now;
        this._roundPhase = 'wait';
        // Clearing first matters for a seat that was paused mid-round: its answer to a
        // question two rounds old must not be waiting in the queue when it comes back.
        live.forEach(c => { c.queuedAction = null; this.startTurn(c, now); });
    }

    // Where a round takes effect. Every move runs here, back to back, with no
    // simulation in between — that is what makes them simultaneous, and it is the
    // whole point of the mode. JS still has to run them in SOME order, and the first
    // mover wins a contested build spot, so the order rotates by round instead of
    // permanently favouring seat one.
    flushRound(live) {
        // Held failures first, so a seat that contributed nothing still appears in its
        // round rather than vanishing from it.
        for (const c of live) {
            if (!c.pendingLog || !c.pendingLog.length) continue;
            for (const e of c.pendingLog) this.commitDecision(e);
            c.pendingLog = [];
        }
        const queued = live.filter(c => c.queuedAction);
        if (queued.length > 1) queued.push(...queued.splice(0, this._roundNo % queued.length));
        for (const c of queued) {
            const action = c.queuedAction;
            c.queuedAction = null;
            if (this._stopped || c.defeated) continue;
            try { this.executeTurn(c, action); }
            catch (err) { console.error(`[OpenAIAI] Queued action failed for ${c.id}:`, err); }
        }
    }

    async update(deltaTime) {
        if (this.aiControllers.length === 0) return;
        const now = Date.now();

        // Continuously record what each model has discovered. Discovery used to be
        // sampled only at a model's own turn, but the fog reveals as units MOVE — so
        // a scout could sweep past a node (revealing it on the map) and move on
        // between turns, leaving the model thinking it never found it. Scan a few
        // times a second so "seen on the map" always equals "known to the model".
        if (this._stopped) return; // match ended/restarted — issue no more turns

        // PAUSE, in two beats. Beat one: stop opening anything new but keep updating,
        // so answers already in flight arrive and — in turn-based — the round they
        // belong to still flushes. Beat two: once no seat is waiting on a reply and no
        // reply is waiting to be applied, the world is genuinely idle and freezes.
        //
        // Returning early on the press instead would strand every queued move: in
        // turn-based they sit in queuedAction and only flushRound can spend them, so
        // the gate has to let the round finish rather than jump the fence.
        const pausing = !!(this.game && this.game.pauseState !== 'running');
        if (pausing) {
            const busy = this.aiControllers.some(c => c.pending || c.queuedAction);
            if (!busy) {
                this.game.pauseState = 'paused';
                if (this.game.ui && this.game.ui.updateSimSpeedButton) this.game.ui.updateSimSpeedButton();
                return;   // no messages sent, no turns issued, no time passing
            }
        }

        this.updateResourceDiscovery(now);
        this.updateEnemyBuildingDiscovery();
        this.updateAttackReports(now);

        if (this.turnBased) { this.updateTurnBased(now, pausing); return; }

        for (const controller of this.aiControllers) {
            if (this.isControllerDefeated(controller)) {                       // lost its last Town Center
                if (!controller.defeated) this.markDefeated(controller);       // stop it (once)
                continue;
            }
            if (controller.paused) continue;                                  // spectator paused it
            if (pausing) continue;                                            // pause requested: open nothing new
            if (controller.pending) continue;                                 // own pipeline busy
            if (now - controller.lastTurnTime < this.turnInterval) continue;  // small breather
            this.startTurn(controller, now);
        }
    }

    // A defeated model must stop sending requests. "Defeated" uses the SAME rule as
    // arena win detection (game.isPlayerEliminated): no army, no military building it
    // can afford to produce from, and no Town Center nor the means to rebuild one — so
    // controller-stop and the last-player-standing check never disagree.
    isControllerDefeated(controller) {
        const ai = controller && controller.aiPlayer;
        if (!ai) return true;
        if (this.game && typeof this.game.isPlayerEliminated === 'function') {
            return this.game.isPlayerEliminated(ai);
        }
        return ai.units.length === 0 && ai.buildings.length === 0; // fallback
    }

    // Player game only: an LLM opponent whose endpoint is unreachable is handed to
    // the rule-based AI so the human still has a real opponent. Removes the LLM
    // controller and lets aiManager drive that player from now on.
    demoteToRuleBased(controller) {
        if (controller._demoted) return;
        controller._demoted = true;
        const ai = controller.aiPlayer;
        this.aiControllers = this.aiControllers.filter(c => c !== controller);
        controller._abortReason = 'handed to the rule-based AI';
        try { if (controller._abort) controller._abort.abort(); } catch (e) { /* settled */ }
        controller.pending = false;
        if (ai) {
            this.game.aiManager.openAIControlled.delete(ai.id); // rule-based brain takes over
            const civ = getCivilization(ai.civilization);
            this.decisionLog.unshift({
                timestamp: Date.now(), playerId: ai.id,
                civName: civ?.name || ai.civilization,
                color: '#' + ((civ?.color ?? 0xffffff)).toString(16).padStart(6, '0'),
                action: 'fallback_rule_based', reason: '', params: {}, failed: true, error: null, isControl: true
            });
            if (this.decisionLog.length > this.maxLogEntries) this.decisionLog = this.decisionLog.slice(0, this.maxLogEntries);
        }
        if (this.game.ui && this.game.ui.updateOpponentsPanel) this.game.ui.updateOpponentsPanel();
        console.log(`[OpenAIAI] ${ai && ai.id}: endpoint unreachable — handed to the rule-based AI.`);
    }

    // Permanently retire a defeated controller: abort its in-flight request, mark it
    // so any late resolution is dropped, and note it once in the spectator log.
    markDefeated(controller) {
        controller.defeated = true;
        // Before the abort below, and deliberately fire-and-forget: this seat is out, so
        // nothing in the match is waiting on its answer.
        try { this.askFinalWord(controller, 'defeated'); } catch (e) { /* never block a retirement */ }
        controller._abortReason = 'seat defeated';
        try { if (controller._abort) controller._abort.abort(); } catch (e) { /* already settled */ }
        controller.pending = false;
        controller.pendingAttackReports = [];
        controller.pendingArrivalMessages = [];
        const ai = controller.aiPlayer;
        if (ai) {
            const civ = getCivilization(ai.civilization);
            this.decisionLog.unshift({
                timestamp: Date.now(), playerId: ai.id,
                civName: civ?.name || ai.civilization,
                color: '#' + ((civ?.color ?? 0xffffff)).toString(16).padStart(6, '0'),
                action: 'defeated', reason: '', params: {}, failed: true, error: null, isControl: true
            });
            if (this.decisionLog.length > this.maxLogEntries) this.decisionLog = this.decisionLog.slice(0, this.maxLogEntries);
        }
        console.log(`[OpenAIAI] ${controller.id} defeated — controller stopped.`);
    }

    // Halt this manager for good: abort in-flight requests and make any late
    // resolution a no-op. Called when a match ends or a new one starts, so the
    // previous match's slow requests can't spend more quota or spawn stray units
    // into the next match's shared scene.
    stop() {
        this._stopped = true;
        for (const c of this.aiControllers) {
            c._abortReason = 'match stopped';
            try { if (c._abort) c._abort.abort(); } catch (e) { /* already settled */ }
            c.pending = false;
            c.pendingAttackReports = [];     // drop unresolved arrival reports
            c.pendingArrivalMessages = [];   // and any undelivered verdicts
        }
        this.pendingRequests.clear();
    }

    // Persistently remember every resource node any of a model's units/buildings
    // has had within vision range (matches the fog-of-war the spectator sees).
    // Runs EVERY frame, in lockstep with the fog reveal — a 500ms sample used to
    // miss a fast unit that only grazed a node's vision radius for a moment, so
    // the node showed on the map (fog reveals per-frame) but never entered the
    // model's known set. The `.has(idx)` skip keeps this cheap: each node is
    // distance-checked only until it is first discovered, then skipped forever.
    updateResourceDiscovery(now) {
        const resources = (this.game.terrain && this.game.terrain.resources) || [];
        if (!resources.length) return;
        for (const controller of this.aiControllers) {
            const ai = controller.aiPlayer;
            if (!ai) continue;
            if (!ai._knownResIdx) ai._knownResIdx = new Set();
            for (let idx = 0; idx < resources.length; idx++) {
                if (ai._knownResIdx.has(idx)) continue;        // already known — skip
                const r = resources[idx];
                if (this.isPositionVisibleToAI(ai, r.x, r.z, this.game)) ai._knownResIdx.add(idx);
            }
        }
    }

    // Persistently remember every ENEMY BUILDING a model has seen (buildings are
    // static, so a discovered base should stay known even after your units look
    // away — just like resources). Enemy UNITS are deliberately NOT remembered:
    // they move, so a stale position would mislead. Runs every frame; drops a
    // remembered building once it is destroyed/removed.
    updateEnemyBuildingDiscovery() {
        const all = this.game.getAllBuildings();
        for (const controller of this.aiControllers) {
            const ai = controller.aiPlayer;
            if (!ai) continue;
            if (!ai._knownEnemyBuildings) ai._knownEnemyBuildings = new Set();
            for (const b of all) {
                if (ai.buildings.includes(b)) continue;            // own building
                if (b.health <= 0) { ai._knownEnemyBuildings.delete(b); continue; } // gone
                if (ai._knownEnemyBuildings.has(b)) continue;      // already known
                if (b.isWonder || this.isPositionVisibleToAI(ai, b.x, b.z, this.game)) {
                    ai._knownEnemyBuildings.add(b);
                }
            }
        }
    }

    // Spectator pause/resume: a paused model issues no more requests (useful when a
    // model has exhausted its API quota). Returns the new paused state.
    setPaused(aiId, paused) {
        const controller = this.aiControllers.find(c => c.id === aiId);
        if (!controller) return null;
        controller.paused = !!paused;
        const ai = controller.aiPlayer;
        const civ = ai ? getCivilization(ai.civilization) : null;
        this.decisionLog.unshift({
            timestamp: Date.now(),
            playerId: aiId,
            civName: civ?.name || (ai ? ai.civilization : aiId),
            color: '#' + ((civ?.color ?? 0xffffff)).toString(16).padStart(6, '0'),
            action: paused ? 'paused' : 'resumed',
            reason: '',
            params: {},
            failed: false,
            error: null,
            isControl: true
        });
        if (this.decisionLog.length > this.maxLogEntries) this.decisionLog = this.decisionLog.slice(0, this.maxLogEntries);
        console.log(`[OpenAIAI] ${aiId} ${paused ? 'paused' : 'resumed'} by spectator`);
        return controller.paused;
    }

    isPaused(aiId) {
        const controller = this.aiControllers.find(c => c.id === aiId);
        return !!(controller && controller.paused);
    }

    // Queue spectator advice for a model; injected into its next prompt.
    addAdvice(aiId, text) {
        const controller = this.aiControllers.find(c => c.id === aiId);
        if (!controller) return false;
        const t = String(text || '').trim();
        if (!t) return false;
        if (!controller.pendingAdvice) controller.pendingAdvice = [];
        const advice = t.slice(0, 400);
        controller.pendingAdvice.push(advice);
        console.log(`[OpenAIAI] Advice queued for ${aiId}: ${advice}`);

        // Surface it in the decision log so the spectator can SEE that their advice
        // was queued (it is attached to this model's next prompt).
        const ai = controller.aiPlayer;
        const civ = ai ? getCivilization(ai.civilization) : null;
        this.decisionLog.unshift({
            timestamp: Date.now(),
            playerId: aiId,
            civName: civ?.name || (ai ? ai.civilization : aiId),
            color: '#' + ((civ?.color ?? 0xffffff)).toString(16).padStart(6, '0'),
            action: 'advice',
            reason: advice,
            params: {},
            failed: false,
            error: null,
            isAdvice: true
        });
        if (this.decisionLog.length > this.maxLogEntries) {
            this.decisionLog = this.decisionLog.slice(0, this.maxLogEntries);
        }
        return true;
    }

    // A harness result the model never asked to be published early.
    //
    // A reply that FAILS is known the moment it lands; a reply that succeeds is not
    // applied until every seat has answered. Logging each at its own moment put a fast
    // seat's rejection eighty seconds ahead of the round it belonged to, sitting alone
    // between two blocks -- and read, reasonably, as that seat being served first.
    // Nothing was executed early; only the log said so.
    //
    // In turn-based mode a failure is therefore held with its round and released by
    // flushRound, beside the commands it belongs next to, sharing their timestamp.
    // Real-time has no rounds and is untouched: there, "when it happened" IS the round.
    //
    // The moment the reply actually arrived is not lost -- the transcript records it
    // per turn as latencyMs, which is where a fairness question should be answered
    // anyway, rather than from the spacing of a viewer's log.
    pushDecisionFor(ai, entry) {
        const c = (this.aiControllers || []).find(x => x.aiPlayer === ai);
        if (this.turnBased && c) { (c.pendingLog || (c.pendingLog = [])).push(entry); return; }
        this.commitDecision(entry);
    }

    // Stamped HERE, not where the entry was built: a held entry that kept its arrival
    // time would land in the right block wearing a timestamp eighty seconds older than
    // its neighbours, which is the same false impression in smaller print.
    commitDecision(entry) {
        entry.timestamp = Date.now();
        this.decisionLog.unshift(entry);
        if (this.decisionLog.length > this.maxLogEntries) {
            this.decisionLog = this.decisionLog.slice(0, this.maxLogEntries);
        }
    }

    // Fire a single turn for one controller on its own independent pipeline.
    startTurn(controller, now = Date.now()) {
        // Real turn-to-turn cadence, MEASURED before lastTurnTime is overwritten.
        // This is the model's own thinking time plus the breather plus any scheduling
        // delay it met — the only number that converts the state's seconds into
        // decisions, and it differs ~12x between a 1.6s seat and a 36s one. Kept as a
        // short rolling window rather than a lifetime mean: a cadence that degrades
        // (a slowing endpoint, a growing context) should be reflected, not averaged
        // away against turns from ten minutes ago.
        if (controller.lastTurnTime) {
            const gaps = controller.turnGaps || (controller.turnGaps = []);
            gaps.push(now - controller.lastTurnTime);
            if (gaps.length > 10) gaps.shift();
        }
        controller.lastTurnTime = now;
        controller.turnCount++;
        controller.pending = true;
        // Anything still held here belongs to a round that has already resolved without
        // it -- the same reason a late ANSWER is dropped rather than replayed. The stats
        // already counted it; only the log line goes.
        controller.pendingLog = [];

        console.log(`[OpenAIAI] Turn #${controller.turnCount} for ${controller.id} (${controller.aiPlayer.civilization})`);

        const gameState = this.buildGameStateJSON(controller);
        const askedInRound = this._roundNo;

        const promise = this.sendToOpenAI(controller, gameState)
            .then(actionData => {
                if (this._stopped || controller.defeated) return; // ended or defeated mid-flight — drop it
                if (!actionData) {
                    console.warn(`[OpenAIAI] No action returned for ${controller.id}`);
                    return;
                }
                if (this.turnBased) {
                    // Hold it for flushRound. Arriving first must not mean taking
                    // effect first. An answer to a round that has already resolved
                    // (this seat timed out and the others moved on without it) is
                    // dropped rather than replayed onto a board it never saw.
                    if (this.roundStillOpen(askedInRound)) controller.queuedAction = actionData;
                    return;
                }
                this.executeTurn(controller, actionData);
            })
            .catch(err => {
                console.error(`[OpenAIAI] Turn failed for ${controller.id}:`, err);
            })
            .finally(() => {
                controller.pending = false;
                this.pendingRequests.delete(controller.id);
            });

        this.pendingRequests.set(controller.id, promise);
    }
}


