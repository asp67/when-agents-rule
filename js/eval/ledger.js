// WarEval -- the evaluation ledger (overhaul step C1).
//
// What a model did, read from the transcript and from nothing else: the same lines,
// whether they arrive one at a time from a match in progress or from a file afterwards.
// That rule is what keeps a number shown live and a number published later from ever
// disagreeing, and it is why nothing in here reaches into the game or the harness. If
// it is not in the record, it is not scored.
//
// A ledger keeps a small digest of every decision and works the profile out on request.
// Every figure of a seat comes from that seat's own lines in the order it wrote them, so
// the order in which different seats' lines arrive changes nothing: a file lists one
// seat after another, a live match interleaves them, and both give the same profile.
//
// Six parts of the profile are filled, five of them scored:
//   grounding    were the commands valid when they were issued?
//   planning     does the seat keep a live, concrete plan, and restate it after a shock?
//   follow       does it do what its plan says?
//   tactical     when it is shown a threat, is its next order aimed at it?
//   strategy     does its play turn into winning?
//   versatility  the range it used, as facts: no score until "where it helps" has a rule
// and over the scored parts an Index, their plain mean, never to be shown without them.
//   efficiency   what did a decision cost? Shown beside the profile, never inside it.
(function (root) {
    'use strict';
    const WarEval = {
        VERSION: 1,
        // How raw rates become 0-100. 'v0' was the mapping proposed with the plan. 'v1' is
        // v0 after the anchor run (tools/eval/anchors.cjs, docs/SCORING.md): a wait is left
        // out of the Grounding rate, and a plan counts in the Index as far as it was followed.
        // 'v2' (asp67's first real match on the Bench view, 21 Nov 2026): a plan step is no
        // longer called dropped ten decisions after it was stated. It stays open while it
        // stands in the plan, and one carried out late is carried out.
        SCALE: 'v3',
        // What the Index is the mean of. 'plan' is Planning as far as it was followed.
        INDEX_PARTS: ['grounding', 'plan', 'tactical', 'strategy'],
        // A mistake made again inside this many decisions counts as repeated.
        REPEAT_WINDOW: 2,
        // A plan step is acted on if a command carries it out within this many decisions.
        FOLLOW_WINDOW: 10,
        // The scores over the match (build 1221): how many seconds lie between two samples
        // of the history, and what a seat's sample holds, in this order. Everything is as
        // it stood at that second: the scores of the profile, then what they were counted
        // from and what they cost so far. A score that could not be given yet is null.
        HISTORY_SEC: 30,
        HISTORY_FIELDS: ['decisions', 'index', 'grounding', 'planning', 'follow', 'tactical', 'strategy',
            'commands', 'ok', 'avoidable', 'invalid', 'repeated', 'promptTokens', 'completionTokens', 'thinkingMs'],
        // A threat is answered by an order aimed at it within this many decisions, counting
        // the one that was shown it; "at once" is that one or the next. An order is aimed at
        // a threat when it points within RESPONSE_RADIUS of an attacker or of what is attacked.
        RESPONSE_WINDOW: 3,
        RESPONSE_RADIUS: 40,
        // A clear lead is this much more power than the next seat, held for this long.
        LEAD_FACTOR: 1.25,
        LEAD_SECONDS: 300,
        // The parts of the profile that carry a score, in the order they are shown.
        SCORED: ['grounding', 'planning', 'follow', 'tactical', 'strategy'],
        // How well the step reader reads, measured on plan steps from the shipped matches
        // that were read by hand (tests/eval-reader-steps.json; tests/eval-reader.test.cjs
        // recomputes these and fails when they stop being true). `heldOut` is the half
        // the reader was never adjusted against: of the commitments it reports there,
        // `precision` are really in the step, and of those really in the steps it finds
        // `recall`. `checkable` is the same for "does the step commit to anything".
        READER: {
            readBy: 'Claude Fable 5.2', on: '2026-11-21', steps: 384,
            heldOut: { steps: 192, precision: 0.911, recall: 0.917, checkablePrecision: 0.976, checkableRecall: 0.960 },
            tuned: { steps: 192, precision: 0.953, recall: 0.923, checkablePrecision: 0.986, checkableRecall: 0.954 },
        },
    };

    // Lines about a seat that are not decisions. `input` lines name a seat too, but they
    // are the replay's record of what the engine was told, not something the model did.
    const SEAT_MARKERS = new Set(['round_missed', 'request_failed', 'request_cancelled', 'final_word']);
    // The harness's verdicts (OpenAIAIManager.verdictFor). Only the first three are the
    // model's own doing: `contended` was refused on something no state could have warned
    // of, `harnessFault` is the harness failing on a valid command.
    const VERDICTS = ['ok', 'avoidable', 'invalid', 'contended', 'harnessFault'];

    const num = v => (typeof v === 'number' && Number.isFinite(v)) ? v : null;
    const clamp01 = x => Math.max(0, Math.min(1, x));
    function quantile(values, q) {
        if (!values.length) return null;
        const s = values.slice().sort((a, b) => a - b);
        const i = (s.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
        return s[lo] + (s[hi] - s[lo]) * (i - lo);
    }
    const sum = values => values.reduce((a, b) => a + b, 0);

    function commandsOf(parsed) {
        if (!parsed || typeof parsed !== 'object') return 0;
        if (Array.isArray(parsed.commands)) return parsed.commands.length;
        return parsed.action ? 1 : 0;       // the single-command reply of early builds
    }

    // The commands of a decision as follow-through and tactical response need them: what
    // was ordered, the unit, building or technology it named, where it pointed, and
    // whether it worked. `ok` is null where no outcome was recorded.
    function commandList(parsed, outcomes, state) {
        const list = !parsed || typeof parsed !== 'object' ? [] : Array.isArray(parsed.commands) ? parsed.commands : (parsed.action ? [parsed] : []);
        let rivals = null, own = null;
        const place = (lists, id) => { for (const l of lists) for (const e of Array.isArray(l) ? l : []) if (e && String(e.id) === String(id) && num(e.x) != null && num(e.z) != null) return e; return null; };
        return list.map((c, i) => {
            const q = (c && c.params && typeof c.params === 'object') ? c.params : {}, o = outcomes ? outcomes[i] : null;
            const name = q.unitType != null ? q.unitType : q.buildingType != null ? q.buildingType : q.techId;
            const cmd = { action: String(c && c.action), name: name != null ? String(name) : null, x: num(q.targetX), z: num(q.targetZ),
                target: q.targetId != null ? String(q.targetId) : null, scouting: q.mode === 'scout', ok: o ? o.verdict === 'ok' : null };
            // A target named by its id points where the state showed that thing.
            if (cmd.target && cmd.x == null && state) {
                rivals = rivals || [state.enemyUnits, state.enemyBuildings, state.threats && state.threats.enemyWonders];
                const e = place(rivals, cmd.target);
                if (e) { cmd.x = e.x; cmd.z = e.z; }
            }
            // Units moved by their ids: where they stood, so pulling threatened people out can be told from marching elsewhere.
            if (cmd.action === 'move_units' && Array.isArray(q.unitIds) && q.unitIds.length && state) {
                own = own || [state.friendlyUnits];
                const at = q.unitIds.map(id => place(own, id)).filter(Boolean);
                if (at.length) cmd.from = at.map(e => ({ x: e.x, z: e.z }));
            }
            return cmd;
        });
    }
    // What the state said is under attack, and from where: null when nothing is.
    function threatOf(threats) {
        const list = Array.isArray(threats && threats.underAttack) ? threats.underAttack.filter(u => u && num(u.x) != null && num(u.z) != null) : [];
        if (!list.length) return null;
        return { targets: list.map(u => ({ kind: u.kind === 'building' ? 'building' : 'unit', type: String(u.type), x: u.x, z: u.z })),
            attackers: list.filter(u => u.attackerAt && num(u.attackerAt.x) != null && num(u.attackerAt.z) != null)
                .map(u => ({ x: u.attackerAt.x, z: u.attackerAt.z, owner: u.attackerAt.owner != null ? String(u.attackerAt.owner) : null })),
            undefended: list.some(u => u.noDefenders === true) };
    }
    const near = (a, b, r) => a && b && a.x != null && b.x != null && Math.abs(a.x - b.x) <= r && Math.abs(a.z - b.z) <= r;
    // Is this order aimed at the threat, or does it protect what is threatened?
    function answers(cmd, points, R) {
        if (cmd.ok !== true) return false;
        const at = list => list.some(pt => near(cmd, pt, R));
        switch (cmd.action) {
            case 'attack_target': return at(points.attackers) || at(points.targets);
            // Sending units to the fight, or taking the threatened ones out of it.
            case 'move_units': return !cmd.scouting && (at(points.attackers) || at(points.targets)
                || (cmd.from || []).some(u => points.targets.some(t => t.kind === 'unit' && near(u, t, R / 2))));
            case 'build_structure': return cmd.name === 'tower' && at(points.targets);
            case 'repair_building': return at(points.targets.filter(t => t.kind === 'building'));
        }
        return false;
    }
    // Does this command carry out that commitment of a plan step?
    // Which of a turn's orders of its own action an order is: the second train_unit of the
    // turn is 2. A decision card knows its seat, its turn and its action, and its place
    // among the cards of that turn; this is the same count from the transcript's side.
    function nthOfItsKind(cmds, at) {
        let n = 0;
        for (let i = 0; i <= at; i++) if (cmds[i].action === cmds[at].action) n++;
        return n;
    }
    function serves(cmd, check, vocab) {
        switch (check.kind) {
            case 'train': return cmd.action === 'train_unit' && cmd.name === check.name;
            // Researching what unlocks a building is the first half of building it.
            case 'build': return (cmd.action === 'build_structure' || cmd.action === 'research_tech') && cmd.name === check.name;
            case 'research': return cmd.action === 'research_tech' && cmd.name === check.name;
            case 'age': return cmd.action === 'upgrade_age';
            case 'wonder': return cmd.action === 'build_structure' && vocab.wonders.has(cmd.name);
            case 'attack': return cmd.action === 'attack_target';
            case 'explore': return cmd.action === 'explore' || (cmd.action === 'move_units' && cmd.scouting);
        }
        return false;
    }
    // The orders a plan step can be about. Assigning workers, repairing and waiting carry
    // out no step, so they are left out of "share of commands that serve the plan".
    const PLAN_ACTIONS = new Set(['train_unit', 'build_structure', 'research_tech', 'upgrade_age', 'attack_target', 'explore']);
    const aboutPlan = cmd => PLAN_ACTIONS.has(cmd.action) || (cmd.action === 'move_units' && cmd.scouting);

    // ---- planning (step C2) ---------------------------------------------------------
    // What a decision said about the plan, by the analyzer's own rule for "planned": a
    // non-empty list of steps, or an objective with text in it. null when it said nothing.
    function planOf(parsed) {
        if (!parsed || typeof parsed !== 'object') return null;
        const steps = Array.isArray(parsed.plan) && parsed.plan.length ? parsed.plan.map(s => String(s)) : null;
        const objective = typeof parsed.objective === 'string' && parsed.objective.trim() ? parsed.objective.trim() : null;
        return steps || objective ? { objective, steps } : null;
    }

    // The names a seat was shown: what it could train, build and research, and who it is
    // up against. A plan step is checkable when it names one of them, and only names the
    // seat itself was given count -- a step is never matched against a list it never saw.
    function everyValue(node, key, into, depth) {
        if (!node || typeof node !== 'object' || depth > 5) return;
        if (Array.isArray(node)) { for (const x of node) everyValue(x, key, into, depth + 1); return; }
        if (typeof node[key] === 'string') into.add(node[key]);
        for (const k in node) if (k !== 'cost' && node[k] && typeof node[k] === 'object') everyValue(node[k], key, into, depth + 1);
    }
    function learnNames(vocab, state) {
        if (!state || typeof state !== 'object') return;
        // `units` and `buildings` from build 1023 on; the two flat lists before that.
        everyValue(state.units && (state.units.trainable || state.units.blocked) ? state.units : state.trainableUnits, 'id', vocab.units, 0);
        const b = state.buildings && (state.buildings.buildable || state.buildings.blocked) ? state.buildings : state.buildableStructures;
        everyValue(b, 'type', vocab.buildings, 0);
        // What a Wonder is called in this seat's lists: its type, and the name it is built as.
        const wonders = node => { for (const x of Array.isArray(node) ? node : []) if (x && x.isWonder) { for (const k of ['type', 'builtAs']) if (typeof x[k] === 'string') vocab.wonders.add(x[k]); } };
        if (b && !Array.isArray(b)) { wonders(b.buildable); wonders(b.blocked); } else wonders(b);
        const r = state.research || {};
        for (const x of r.researched || []) if (typeof x === 'string') vocab.techs.add(x);
        everyValue(r.available, 'id', vocab.techs, 0);
        for (const o of (state.gameStats && state.gameStats.opponents) || []) {
            if (o && typeof o.id === 'string') vocab.opponents.add(o.id);
            if (o && typeof o.civilization === 'string') vocab.opponents.add(o.civilization);
        }
    }
    const plain = s => ' ' + String(s).toLowerCase().replace(/[_\-]/g, ' ').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim() + ' ';
    // ---- reading a plan step (step C3) -------------------------------------------
    // What a step commits its seat to, as kinds of command that could carry it out. An
    // empty list is a step nothing recorded could confirm: "stay flexible", "keep the
    // economy balanced".
    //
    // A name alone commits to nothing. "Assign workers to food" trains nobody, "attack the
    // Egyptian Town Center" builds no Town Center and "champion #36 scouts north" trains
    // no champion: the first version of this reader counted all three, and against 384
    // steps read by hand it was right about barely half of what it reported. So a unit
    // needs a word of production in front of it, a building a word of construction, an
    // attack a verb of attacking, and whatever belongs to a rival, is only where
    // something happens, or is already under way is left out. The measured hit and miss
    // rates are WarEval.READER; tests/eval-reader.test.cjs holds them to the labelled set.
    const READ = {
        make: new Set(('train trains training trained produce produces producing spam spamming mass massing massed recruit recruits recruiting pump pumping '
            + 'churn churning queue queues field fielding get add adds adding make more additional extra another fund spend then build builds building').split(' ')),
        // After the name: "archer spam", "archers flowing".
        makeAfter: new Set('spam flowing flow production'.split(' ')),
        raise: new Set(('build builds construct constructs add adds adding raise raises place places rebuild rebuilds replace establish research researching get expand more '
            + 'another second 2nd 3rd third two three additional new extra put erect start unlock then replenish').split(' ')),
        learn: new Set('research researching get unlock tech develop then start learn'.split(' ')),
        // Where something happens, not what is made: "train militia AT the barracks".
        place: new Set('at from in near by around under behind beside inside outside as onto on to toward towards against per across between for into of with'.split(' ')),
        // Words that may stand between a preposition or a verb and the name it governs.
        small: new Set('the my our a an both all idle new old main forward refuge second 2nd 3rd first two three its their his her this that every each surviving remaining'.split(' ')),
        rival: new Set('their enemy enemies rival rivals hostile opponent opponents'.split(' ')),
        strike: new Set(('attack attacks attacking raze razes destroy destroys destroying kill kills killing raiding strike strikes hunt hunts hunting '
            + 'eliminate eradicate crush demolish harass pressure engage counterattack disrupt interrupt charge conquer conquest target fight').split(' ')),
        // A unit or building followed by one of these is doing something or is being finished, not being made.
        busy: new Set(('scout scouts scouting sweep sweeps sweeping march marches marching guard guards guarding parked idle flee home cycling return returning '
            + 'finish finishes finishing finished construction complete completes manned hands producing training trains spits spit frees staffed repaired').split(' ')),
        seek: new Set('scout scouts scouting explore explores exploring find finds locate locates search sweep sweeps sweeping discover reveal recon'.split(' ')),
        no: new Set('no not never without dont cannot'.split(' ')),
        // Clauses that only watch something already under way.
        waiting: new Set('let wait monitor watch'.split(' ')),
        list: new Set('and or plus a an the then early first later mixed of both not one two three 2 3 2nd 3rd more some few'.split(' ')),
        // What people call the things in the lists.
        alias: { tc: 'town_center', tcs: 'town_center', housing: 'house' },
        // A rival by the name of its people or its land.
        lands: { greek: ['greece', 'greeks'], egyptian: ['egypt', 'egyptians'], persian: ['persia', 'persians'], roman: ['rome', 'romans'],
            viking: ['vikings'], maya: ['mayans', 'mayas'], yamato: ['yamatos', 'japan'] },
    };
    const AGES = new Set(['neolithic', 'bronze', 'iron']);
    const singular = w => w.endsWith('men') ? w.slice(0, -3) + 'man' : w.endsWith('ies') ? w.slice(0, -3) + 'y' : w.endsWith('es') && w.length > 4 ? [w.slice(0, -1), w.slice(0, -2)] : w.endsWith('s') ? w.slice(0, -1) : w;
    const sameWord = (word, name) => word === name || [].concat(singular(word)).includes(name);

    function checkable(step, vocab) {
        const out = [];
        const add = (kind, name) => { if (!out.some(k => k.kind === kind && k.name === name)) out.push({ kind, name }); };
        // Every name the seat was shown, longest first, so "scout cavalry" is not also "cavalry".
        const lexicon = [];
        for (const u of vocab.units) lexicon.push({ kind: 'train', name: u });
        for (const b of vocab.buildings) lexicon.push({ kind: vocab.wonders.has(b) ? 'wonder' : 'build', name: b });
        for (const w of vocab.wonders) if (!vocab.buildings.has(w)) lexicon.push({ kind: 'wonder', name: w });
        for (const x of vocab.techs) if (!vocab.buildings.has(x)) lexicon.push({ kind: 'research', name: x });
        for (const a in READ.alias) if (vocab.buildings.has(READ.alias[a])) lexicon.push({ kind: 'build', name: READ.alias[a], words: [a] });
        if (!lexicon.some(e => e.kind === 'wonder' && e.name === 'wonder')) lexicon.push({ kind: 'wonder', name: 'wonder' });
        for (const e of lexicon) if (!e.words) e.words = String(e.name).toLowerCase().split(/[_\- ]+/);
        lexicon.sort((a, b) => b.words.length - a.words.length);
        const rivals = new Set(READ.rival);
        for (const o of vocab.opponents) {
            const base = String(o).toLowerCase().split(/[_\- ]+/)[0];
            rivals.add(base); rivals.add(base + 's');
            for (const land of READ.lands[base] || []) rivals.add(land);
        }

        const clauses = String(step).toLowerCase().replace(/[’']s\b/g, '').replace(/[’']/g, '').split(/[;:.!?]\s|\s[-–—]\s|[;:]$/);
        for (const raw of clauses) {
            const w = raw.replace(/#/g, ' # ').replace(/[_\-\/+]/g, ' ').replace(/[^a-z0-9# ]/g, ' ').split(/\s+/).filter(Boolean);
            if (!w.length || READ.waiting.has(w[0])) continue;
            const denied = i => w.slice(Math.max(0, i - 4), i).some(x => READ.no.has(x)) || w.slice(Math.max(0, i - 3), i).includes('before');
            // Which words belong to a name the seat was shown.
            const found = [], taken = new Array(w.length).fill(false);
            for (const e of lexicon) for (let i = 0; i + e.words.length <= w.length; i++) {
                if (taken.slice(i, i + e.words.length).some(Boolean)) continue;
                if (!e.words.every((x, k) => k < e.words.length - 1 ? w[i + k] === x : sameWord(w[i + k], x))) continue;
                for (let k = 0; k < e.words.length; k++) taken[i + k] = true;
                found.push({ kind: e.kind, name: e.name, at: i, end: i + e.words.length });
            }
            // A clause that is nothing but names is a list of things to get: "academy + siege engineering + engineer".
            const bare = found.length > 0 && w.every((x, i) => taken[i] || READ.list.has(x) || READ.make.has(x) || /^\d+$/.test(x));
            const before = (i, set, reach) => { for (let k = i - 1; k >= Math.max(0, i - reach); k--) if (set.has(w[k]) && !taken[k]) return true; return false; };
            const CLAUSE = 99;
            // The word that governs a name, past any articles and counts in between.
            const governor = i => { let k = i - 1; while (k >= 0 && (READ.small.has(w[k]) || /^\d+$/.test(w[k]))) k--; return k >= 0 ? w[k] : ''; };
            const struck = i => w.slice(0, i).some(x => READ.strike.has(x));
            const forbidden = w.some(x => READ.no.has(x)) && w.indexOf(w.find(x => READ.no.has(x)));

            for (const f of found) {
                const next = w[f.end] || '', next2 = w[f.end + 1] || '';
                if (f.kind === 'wonder') continue;                       // read below, with the rest of the clause
                if (forbidden !== false && forbidden < f.at) continue;   // "do NOT build a tower before ..."
                if (before(f.at, rivals, 3) || struck(f.at)) continue;   // a rival's, or what is being attacked
                if (next === '#' || (READ.busy.has(next) && !taken[f.end])) continue;
                if (f.kind === 'train') {
                    if (f.name === 'worker') continue;                   // people are read below: they are mostly moved, not made
                    if (governor(f.at) === 'with') continue;             // "raid with archers": the ones it has
                    if (bare || before(f.at, READ.make, CLAUSE) || READ.makeAfter.has(next) || READ.makeAfter.has(next2) || READ.makeAfter.has(w[f.end + 2] || '')) { add('train', f.name); f.made = true; }
                } else if (f.kind === 'build') {
                    if (READ.place.has(governor(f.at)) && governor(f.at) !== 'with') continue;
                    if (before(f.at, new Set(['finish', 'complete', 'completing', 'finishing', 'repair', 'keep']), 3)) continue;
                    if (bare || before(f.at, READ.raise, CLAUSE)) add('build', f.name);
                } else if (f.kind === 'research') {
                    if (governor(f.at) === 'for') continue;
                    if (bare || before(f.at, READ.learn, CLAUSE) || next === 'research' || next === 'tech' || next === 'technology') add('research', f.name);
                }
            }

            const text = ' ' + w.join(' ') + ' ';
            // Training people: only with a word of production. They are mentioned far more often than they are made.
            if (/ (train\w*|produc\w*|pump\w*|spits?|recruit\w*|queue\w*|rebuild\w*|replenish\w*|grow\w*)( \w+){0,5}? (workers?|villagers?) /.test(text)
                || / (workers?|villagers?) production /.test(text) || / (workers?|villagers?) (up )?to \d+ /.test(text)
                // "Add villagers", "more workers": made, unless the clause is about where to put them.
                || (/ (add\w*|more|additional|extra) (workers?|villagers?) /.test(text)
                    && !/^ (assign|reassign|redirect|shift|move|send|pull|retask|rebalance|put) /.test(text))) add('train', 'worker');
            // Advancing an age: a verb of advancing or of saving up, aimed at the age.
            const age = '(the )?(next |neolithic |bronze |iron )(age )?', aim = '(to|toward|towards|for|into) ';
            if (new RegExp(' (advance\\w*|upgrade\\w*|reach\\w*|rush\\w*|go|tech|age up|bank\\w*|sav\\w+|stock\\w*|stockpile|gather\\w*|hold|work) (\\w+ ){0,6}?' + aim + age).test(text)
                || / age up | advance ages | (neolithic|bronze|iron) (age )?(upgrade|age up|advancement) | for age advancement | (to|toward|for) (the )?age up /.test(text)
                || / (reach\w*|hit) (the )?(neolithic|bronze|iron) /.test(text)
                || (AGES.has(w[0]) && (w[1] === 'at' || (w[1] === 'age' && w[2] === 'at')))
                || / late game (neolithic|bronze|iron) age /.test(text)) {
                if (!/ (once|after|when|until|upon) (the )?(age up|reaching) /.test(text) || / age up to | advance\w* to | upgrade\w* to /.test(text)) add('age', 'age');
            }
            // Its own Wonder: a word of building in front of it, or saving up for it.
            const wonderAt = found.filter(f => f.kind === 'wonder');
            if (wonderAt.length && !/ (fallback|only if|only then|consider|do not|never|dont) /.test(text) && !(forbidden !== false)) {
                for (const f of wonderAt) {
                    if (before(f.at, rivals, 3) || struck(f.at)) continue;
                    const g = governor(f.at);
                    if (before(f.at, new Set(['build', 'place', 'construct', 'start', 'raise', 'begin', 'erect']), 4) || g === 'for' || g === 'toward' || g === 'towards'
                        || (g === 'age' && w[f.at - 1] !== 'the') || w[f.end] === 'goes' || w[f.end] === 'near' || bare) add('wonder', 'wonder');
                }
            }
            // Attacking: a verb of attacking that is not denied, or an army sent at a rival.
            const verb = (x, i) => (x === 'raid' && (i === 0 || ['and', 'then', 'to'].includes(w[i - 1])))
                || (x === 'assault' && !['force', 'column', 'group', 'army', 'squad', 'corps'].includes(w[i + 1]));
            if (w.some((x, i) => (READ.strike.has(x) || verb(x, i)) && !denied(i) && !(taken[i])) || / march\w* on /.test(text)
                || (/ (army|force|forces|troops|units) /.test(text) && w.some((x, i) => rivals.has(x) && !READ.rival.has(x) && ['to', 'at', 'on', 'toward', 'against'].includes(governor(i))))
                || w.some((x, i) => (x === 'finish' || x === 'finishes') && rivals.has(w[i + 1] || ''))) add('attack', 'attack');
            // Exploring: a verb of looking, unless the scout is being called back.
            // Some peoples have a unit called "scout": where it was not read as one to train, the word is the verb.
            const unitWord = i => found.some(f => f.made && i >= f.at && i < f.end) || found.some(f => f.kind !== 'train' && i >= f.at && i < f.end);
            if (w.some((x, i) => READ.seek.has(x) && !unitWord(i) && w[i + 1] !== '#' && !before(i, new Set(['recall', 'recalls']), 4) && !denied(i))) add('explore', 'explore');
        }
        return out;
    }
    // Something in the state a plan could not have counted on. Read from what the MODEL
    // was shown, never from the world: a raid it was not told about is not a shock to it.
    const SHOCK_WINDOW = 3;                  // decisions a seat has to restate its plan
    const LOSS_FROM = 12, LOSS_SHARE = 0.75; // a quarter of its people gone since the last decision

    const timelineOf = o => ({ samples: Array.isArray(o.samples) ? o.samples : [], ages: Array.isArray(o.ages) ? o.ages : [] });
    const resultsOf = o => ({ ranking: (Array.isArray(o.ranking) ? o.ranking : []).map(r => ({ id: r.playerId, rank: num(r.rank), winner: !!r.isWinner })),
        profile: o.profile && typeof o.profile === 'object' ? o.profile : null });

    // The profile as an export carries it (step D8): every seat a model decided for, every
    // number, and none of the long lists behind them (each mistake, each plan change, each
    // threat). All of it can be worked out again from the transcript it travels in.
    const LONG = { grounding: ['errors'], planning: ['history', 'standing'], follow: ['standing', 'done', 'serving'], tactical: ['list'] };
    WarEval.publicProfile = p => ({ kind: p.kind, scale: p.scale, seats: p.seats.filter(s => s.decisions > 0).map(s => {
        const out = { id: s.id, seat: s.seat, civ: s.civ, name: s.name, model: s.model, decisions: s.decisions, index: s.index };
        for (const k of ['grounding', 'planning', 'follow', 'tactical', 'strategy', 'versatility', 'efficiency']) {
            out[k] = Object.assign({}, s[k]);
            for (const f of LONG[k] || []) delete out[k][f];
        }
        return out;
    }) });
    // Do two profiles say the same? Compared as they would be written to a file.
    WarEval.sameProfile = (a, b) => JSON.stringify(a) === JSON.stringify(b);

    class Ledger {
        constructor() {
            this.match = null;
            this.seats = new Map();          // playerId -> { id, seat, civ, model, name, turns: [], markers: {} }
            this.lines = 0;
            this.unreadable = 0;
            // What the match itself recorded: the five-second timeline and the results
            // arrive as its last lines, the battles as they happen.
            this.timeline = null; this.results = null; this.battles = [];
            this._preview = null; this.rev = 0;
        }

        _seat(o) {
            let s = this.seats.get(o.playerId);
            if (!s) {
                s = { id: o.playerId, seat: null, civ: null, model: null, name: null, turns: [], markers: {},
                    vocab: { units: new Set(), buildings: new Set(), techs: new Set(), opponents: new Set(), wonders: new Set(['wonder']) } };
                this.seats.set(o.playerId, s);
            }
            if (s.seat == null && o.seat != null) s.seat = o.seat;
            if (s.civ == null && (o.civ || o.civilization)) s.civ = o.civ || o.civilization;
            if (s.model == null && o.model) s.model = o.model;
            if (s.name == null && o.name) s.name = o.name;
            return s;
        }

        // One transcript line as text. A line that does not parse is counted and skipped:
        // a file cut short by a crash still reads up to the cut.
        addLine(text) {
            const line = String(text == null ? '' : text).trim();
            if (!line) return;
            let o;
            try { o = JSON.parse(line); } catch (e) { this.unreadable++; return; }
            this.add(o);
        }

        // One transcript record, already parsed.
        add(o) {
            if (!o || typeof o !== 'object') return;
            this.lines++;
            if (o.type === 'match') {
                this.match = { matchId: o.matchId || null, build: o.build != null ? o.build : null,
                    promptVersion: o.promptVersion || null };
                for (const p of o.players || []) if (p && p.id) this._seat({ playerId: p.id, seat: p.seat, civ: p.civ, model: p.model, name: p.name });
                return;
            }
            if (o.type === 'timeline') { this.timeline = timelineOf(o); return; }
            if (o.type === 'results') { this.results = resultsOf(o); return; }
            if (o.type === 'chronicle') {
                if (o.kind === 'battle' && o.sides && typeof o.sides === 'object') this.battles.push({ t: num(o.t), sides: o.sides });
                return;
            }
            if (o.type) {
                if (!o.playerId || !SEAT_MARKERS.has(o.type)) return;
                const s = this._seat(o);
                s.markers[o.type] = (s.markers[o.type] || 0) + 1;
                return;
            }
            if (!o.playerId) return;         // not a line of this format
            const tokens = o.tokens && typeof o.tokens === 'object' ? o.tokens : null;
            const st = o.state && typeof o.state === 'object' ? o.state : {};
            const clock = st.clock, threats = st.threats || {};
            const seat = this._seat(o);
            // How far the match has got, by the latest clock any seat was shown.
            if (clock && num(clock.matchSeconds) != null && clock.matchSeconds > (this.lastSec || 0)) this.lastSec = clock.matchSeconds;
            learnNames(seat.vocab, st);
            const outcomes = Array.isArray(o.outcomes) ? o.outcomes.map(x => ({ code: x && x.code != null ? String(x.code) : null,
                action: x && x.action != null ? String(x.action) : null,
                verdict: x && VERDICTS.includes(x.verdict) ? x.verdict : 'unknown' })) : null;
            // Buildings that were under attack are watched until the attack is over: one
            // that is no longer in the seat's own list has fallen.
            const threat = threatOf(threats), fallen = [];
            if (seat.watch && seat.watch.length) {
                const mine = Array.isArray(st.friendlyBuildings) ? st.friendlyBuildings : null;
                if (mine) seat.watch = seat.watch.filter(t => {
                    if (mine.some(b => b && String(b.type) === t.type && near(b, t, 3))) return true;
                    fallen.push(t); return false;
                });
                if (!threat) seat.watch = [];
            }
            if (threat) for (const t of threat.targets) if (t.kind === 'building' && !(seat.watch = seat.watch || []).some(w => w.type === t.type && near(w, t, 3))) seat.watch.push(t);
            seat.turns.push({
                threat, fallen,
                rivalWonders: Array.isArray(threats.enemyWonders) ? threats.enemyWonders.filter(w => w && w.id != null)
                    .map(w => ({ id: String(w.id), x: num(w.x), z: num(w.z), owner: w.owner != null ? String(w.owner) : null })) : [],
                cmds: commandList(o.parsed, outcomes, st),
                plan: planOf(o.parsed),
                // What the state showed that a plan could not have counted on.
                people: num(st.population ? st.population.used : (st.resources ? st.resources.population : null)),
                attacked: Array.isArray(threats.underAttack) && threats.underAttack.length > 0,
                wonders: Array.isArray(threats.enemyWonders) ? threats.enemyWonders.map(w => String(w && w.id)) : [],
                turn: num(o.turn),
                sec: clock ? num(clock.matchSeconds) : null,
                latencyMs: num(o.latencyMs) > 0 ? o.latencyMs : null,
                prompt: tokens ? num(tokens.prompt) : null,
                completion: tokens ? num(tokens.completion) : null,
                commands: commandsOf(o.parsed),
                // One { n, action, code, verdict } per command, written by the harness
                // from build 1023 on. Absent means nobody recorded what happened.
                outcomes
            });
        }

        // Were the commands valid when they were issued?
        _grounding(turns) {
            const count = { ok: 0, avoidable: 0, invalid: 0, contended: 0, harnessFault: 0, unknown: 0 };
            const codes = new Map();
            let unjudged = 0, repeated = 0, waits = 0;
            const before = [];               // the mistakes of the last decisions, newest last
            const errors = [];               // every mistake with the decision it was made in
            for (const t of turns) {
                const mine = [];
                if (!t.outcomes) unjudged += t.commands;
                else {
                    unjudged += Math.max(0, t.commands - t.outcomes.length);
                    for (const x of t.outcomes) {
                        count[x.verdict]++;
                        if (x.verdict === 'ok' && x.action === 'wait') waits++;
                        if (x.verdict !== 'avoidable' && x.verdict !== 'invalid') continue;
                        codes.set(x.code, (codes.get(x.code) || 0) + 1);
                        errors.push({ turn: t.turn, sec: t.sec, code: x.code, verdict: x.verdict });
                        if (before.some(prev => prev.includes(x.code))) repeated++;
                        mine.push(x.code);
                    }
                }
                before.push(mine);
                if (before.length > WarEval.REPEAT_WINDOW) before.shift();
            }
            // What the model could have got right: contended commands and the harness's
            // own failures leave both sides, as they do in the match results.
            //
            // A wait can never be refused, so it is no evidence of grounding either way:
            // it stays in the counts (they are the harness's own) and leaves the rate. A
            // seat that only waits has nothing to be rated on. (The wait-only anchor
            // scored 100 before this; among shipped matches waits were up to 27 % of a
            // seat's judged commands.)
            const mistakes = count.avoidable + count.invalid, judged = count.ok + mistakes;
            const rated = judged - waits;
            const rate = rated ? (count.ok - waits) / rated : null;
            return {
                judged, waits, rated, ok: count.ok, avoidable: count.avoidable, invalid: count.invalid,
                contended: count.contended, harnessFault: count.harnessFault, unjudged,
                rate, repeated, repeatRate: mistakes ? repeated / mistakes : null,
                errors,
                mistakes: [...codes.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
                    .map(([code, n]) => ({ code, n })),
                // One command in ten refused for a reason the state had shown is 0.
                score: rate == null ? null : Math.round(1000 * clamp01(1 - (1 - rate) * 10)) / 10
            };
        }

        // Does it keep a live, concrete plan?
        _planning(seat) {
            const turns = seat.turns, vocab = seat.vocab;
            const history = [], shocks = [];
            let standing = null, covered = 0, statements = 0, steps = 0, concrete = 0;
            let people = null, wasAttacked = false;
            const seenWonders = new Set();
            const same = (a, b) => plain(a.objective || '') === plain(b.objective || '')
                && a.steps.length === b.steps.length && a.steps.every((s, i) => plain(s) === plain(b.steps[i]));
            turns.forEach((t, i) => {
                // A shock is in the state the decision was GIVEN, so it comes before the
                // decision's own plan: restating the plan in that very reply answers it.
                if (people != null && t.people != null && people >= LOSS_FROM && t.people <= people * LOSS_SHARE) shocks.push({ at: i, kind: 'losses', revised: false });
                if (t.people != null) people = t.people;
                if (t.attacked && !wasAttacked) shocks.push({ at: i, kind: 'attacked', revised: false });
                wasAttacked = t.attacked;
                for (const id of t.wonders) if (!seenWonders.has(id)) { seenWonders.add(id); shocks.push({ at: i, kind: 'wonder', revised: false }); }

                if (t.plan) {
                    statements++;
                    // A statement that leaves one half out keeps that half as it stood.
                    const next = { objective: t.plan.objective != null ? t.plan.objective : (standing ? standing.objective : null),
                        steps: t.plan.steps || (standing ? standing.steps.map(s => s.text) : []) };
                    if (!standing || !same(next, { objective: standing.objective, steps: standing.steps.map(s => s.text) })) {
                        const known = new Set(standing ? standing.steps.map(s => plain(s.text)) : []);
                        standing = { decision: i + 1, turn: t.turn, sec: t.sec, objective: next.objective,
                            steps: next.steps.map(text => ({ text, fresh: !known.has(plain(text)), checks: checkable(text, vocab) })) };
                        history.push(standing);
                        for (const s of standing.steps) if (s.fresh) { steps++; if (s.checks.length) concrete++; }
                        for (const sh of shocks) if (!sh.revised && i - sh.at <= SHOCK_WINDOW) sh.revised = true;
                    }
                }
                if (standing) covered++;
            });
            const coverage = turns.length ? covered / turns.length : null;
            const concreteRate = steps ? concrete / steps : null;
            const answered = shocks.filter(s => s.revised).length;
            const kinds = { attacked: 0, wonder: 0, losses: 0 };
            for (const s of shocks) kinds[s.kind]++;
            // The plans themselves, for follow-through: not part of the profile.
            this._plans = history;
            return {
                // Every decision that stated a plan, and how many of those changed it.
                statements, revisions: history.length,
                firstAt: history.length ? { decision: history[0].decision, sec: history[0].sec } : null,
                coverage, steps, concrete, concreteRate,
                shocks: Object.assign({ n: shocks.length, revised: answered }, kinds),
                standing: standing ? { objective: standing.objective, since: standing.decision, turn: standing.turn, sec: standing.sec,
                    steps: standing.steps.map(s => ({ text: s.text, checkable: s.checks.length > 0 })) } : null,
                history: history.map(h => ({ decision: h.decision, turn: h.turn, sec: h.sec, steps: h.steps.length })),
                // v0: the mean of coverage, concrete steps and revision after a shock; a
                // seat no shock reached is held to its coverage for the third part. A seat
                // that never stated a plan has none, which is 0 and not a missing value.
                score: !turns.length ? null : !history.length ? 0
                    : Math.round(1000 * (coverage + (concreteRate || 0) + (shocks.length ? answered / shocks.length : coverage)) / 3) / 10
            };
        }

        // Does it do what its plan says? (step C3)
        //
        // Every NEW step that names something checkable is followed from the decision
        // that stated it. A step can commit to several things ("find and destroy their
        // Town Center": to look, and to attack). Each is carried out by an order that
        // worked, within FOLLOW_WINDOW decisions or at any later time while the step
        // still stands in the plan.
        //
        // The step is carried out ('acted') when ALL it commits to is. Until v3 the first
        // of them was enough: a seat that sent one scout was credited with "find and
        // destroy", and a plan read 4 of 4 three minutes into a match (asp67, 22 November
        // 2026). While it is open a step with something behind it is 'begun'; one that is
        // settled -- taken out of the plan, or the match over -- with only some of it
        // done is carried out 'in part' and counts for that share.
        _follow(seat, history, final = false) {
            const turns = seat.turns, vocab = seat.vocab, W = WarEval.FOLLOW_WINDOW, last = turns.length - 1;
            const judged = turns.some(t => t.cmds.some(c => c.ok != null));
            const tracked = [];
            history.forEach((h, hi) => h.steps.forEach(s => {
                if (!s.fresh || !s.checks.length) return;
                // Until which decision the step stood in the plan (exclusive).
                let until = turns.length;
                for (let j = hi + 1; j < history.length; j++)
                    if (!history[j].steps.some(x => plain(x.text) === plain(s.text))) { until = history[j].decision - 1; break; }
                tracked.push({ key: plain(s.text), text: s.text, at: h.decision - 1, until, checks: s.checks, met: new Set(), acted: null, full: null, by: null, parts: [] });
            }));
            let served = 0, underPlan = 0, hi = -1;
            // Every order that carried out a step of the plan that stood then, for the
            // decision cards (step D6): which decision, which order of it, which step.
            const serving = [];
            turns.forEach((t, i) => {
                while (hi + 1 < history.length && history[hi + 1].decision - 1 <= i) hi++;
                const standing = hi >= 0 ? history[hi] : null;
                for (let ci = 0; ci < t.cmds.length; ci++) {
                    const c = t.cmds[ci];
                    if (c.ok !== true) continue;
                    if (standing && aboutPlan(c)) {
                        underPlan++;
                        const step = standing.steps.findIndex(s => s.checks.some(k => serves(c, k, vocab)));
                        if (step >= 0) {
                            served++;
                            serving.push({ decision: i + 1, turn: t.turn, n: ci + 1, k: nthOfItsKind(t.cmds, ci), action: c.action, step: step + 1, of: standing.steps.length });
                        }
                    }
                    for (const s of tracked) {
                        if (s.at > i || (s.acted != null && s.met.size === s.checks.length)) continue;
                        const hit = s.checks.findIndex(k => serves(c, k, vocab));
                        if (hit < 0) continue;
                        // Carried out: within the window, whatever became of the plan since, or at
                        // any later time while the step still stood in it. A long-term step (an
                        // age, a raid once an army exists) takes as long as it takes.
                        if (i - s.at <= W || i < s.until) {
                            // An order may carry out a commitment that is already met (a second
                            // barracks): look for one of this step's that is not.
                            const fresh = s.checks.findIndex((k, n) => !s.met.has(n) && serves(c, k, vocab));
                            if (fresh < 0) continue;
                            // The order that carried this part out: which, when, and where it pointed.
                            const by = { decision: i + 1, turn: t.turn, sec: t.sec, n: ci + 1, action: c.action, name: c.name, x: c.x, z: c.z };
                            if (s.acted == null) { s.acted = i - s.at; s.by = by; }
                            s.met.add(fresh);
                            s.parts.push({ by, met: s.met.size });
                            if (s.met.size === s.checks.length) s.full = i - s.at;
                        }
                    }
                }
            });
            // Open while it stands in the plan, and for the window after it was stated. Dropped
            // when the seat took it out of its plan with no order behind it, or the match
            // ended with it undone. (Until v2 a step was dropped ten decisions after it was
            // stated, which struck out an age-up or a raid long before either was possible.)
            const state = s => {
                if (s.met.size === s.checks.length) return 'acted';
                const open = !final && (last - s.at < W || s.until >= turns.length);
                return open ? (s.met.size ? 'begun' : 'pending') : (s.met.size ? 'part' : 'dropped');
            };
            const count = { acted: 0, part: 0, dropped: 0, pending: 0, begun: 0 };
            for (const s of tracked) count[state(s)]++;
            const settled = tracked.filter(s => ['acted', 'part', 'dropped'].includes(state(s)));
            // Carried out, but more than the window after it was stated: reported, and counted as carried out.
            count.late = tracked.filter(s => s.full != null && s.full > W).length;
            const closed = settled.length;
            // A settled step counts for the share of what it committed to that was carried out.
            const credit = sum(settled.map(s => s.met.size / s.checks.length));
            const waits = tracked.filter(s => s.full != null).map(s => s.full);
            const commitments = sum(settled.map(s => s.checks.length));
            const met = sum(settled.map(s => s.met.size));
            const standing = history.length ? history[history.length - 1] : null;
            const byKey = new Map(tracked.map(s => [s.key, s]));       // the first statement of a step is the one followed
            for (const s of tracked) if (!byKey.has(s.key)) byKey.set(s.key, s);
            if (!judged) return { steps: tracked.length, acted: null, part: null, dropped: null, late: null, pending: null, begun: null, rate: null, decisionsToAct: null,
                commitments: null, commitmentsMet: null, ordersUnderPlan: null, ordersServing: null, servingRate: null, standing: null, judged, score: null };
            return {
                // pending: every step still open; begun: those of them with something carried out.
                steps: tracked.length, acted: count.acted, part: count.part, dropped: count.dropped, late: count.late,
                pending: count.pending + count.begun, begun: count.begun,
                rate: closed ? credit / closed : null,
                decisionsToAct: waits.length ? quantile(waits, 0.5) : null,
                // A step can commit to several things; this is how many of them were carried out.
                commitments, commitmentsMet: met,
                // Of the orders a plan can be about, given under a standing plan: how many carried out one of its steps.
                ordersUnderPlan: underPlan, ordersServing: served, servingRate: underPlan ? served / underPlan : null,
                // Those orders, one by one: decision and turn, the order's place among the
                // turn's orders (n) and among those of its own action (k), and the step of the
                // plan standing then that it carried out. Evidence only: no score reads it.
                serving,
                // Every part of a step that was carried out, with the order that did it (the
                // marks in the world): "met" of the step's "of" commitments stood done after it.
                done: [].concat(...tracked.map(s => s.parts.map(p => ({ text: s.text, stated: s.at + 1, decision: p.by.decision, turn: p.by.turn, sec: p.by.sec,
                    met: p.met, of: s.checks.length, by: { n: p.by.n, action: p.by.action, name: p.by.name, x: p.by.x, z: p.by.z } })))),
                // The standing plan, step by step, for the page.
                standing: standing ? standing.steps.map(s => {
                    const f = s.checks.length ? byKey.get(plain(s.text)) : null;
                    return { text: s.text, state: !s.checks.length ? 'uncheckable' : f ? state(f) : 'pending', after: f && f.full != null ? f.full : null,
                        met: f ? f.met.size : 0, of: s.checks.length };
                }) : null,
                judged,
                // The share of settled steps that were carried out. No plan, or a plan with
                // nothing checkable in it, earns nothing: 0. Nothing settled yet, or a file
                // that records no outcomes, is a dash.
                score: !turns.length || !judged ? null : !history.length ? 0
                    : !tracked.length ? (last >= W ? 0 : null) : closed ? Math.round(1000 * credit / closed) / 10 : null
            };
        }

        // When it is shown a threat, is its next order aimed at it? (step C4)
        //
        // An episode is the stretch of decisions whose state said something of the seat's
        // is under attack: it opens at the first such state, so a seat is never charged
        // for a raid it was not told about. It is answered by the first order that worked
        // and is aimed at the threat or protects what is threatened: an attack or a march
        // to where the attackers or their targets are, the threatened units moved out, a
        // tower raised or a building repaired there. Training more soldiers is not an
        // answer: it is aimed at nothing. A new rival Wonder is a threat of its own,
        // answered by an attack on it.
        _tactical(seat) {
            const turns = seat.turns, R = WarEval.RESPONSE_RADIUS, W = WarEval.RESPONSE_WINDOW;
            const judged = turns.some(t => t.cmds.some(c => c.ok != null));
            const episodes = [];
            let open = null;
            turns.forEach((t, i) => {
                if (t.threat && !open) {
                    open = { kind: 'attack', decision: i + 1, turn: t.turn, sec: t.sec, targets: [], attackers: [], by: null, undefended: false,
                        answeredAfter: null, decisions: 0, lost: [], ended: false };
                    episodes.push(open);
                }
                if (open) {
                    for (const f of t.fallen) open.lost.push(f.type);
                    if (!t.threat) { open.ended = true; open = null; }
                }
                if (open) {
                    open.decisions++;
                    for (const x of t.threat.targets) if (!open.targets.some(y => y.type === x.type && near(x, y, 3))) open.targets.push(x);
                    for (const x of t.threat.attackers) { if (!open.attackers.some(y => near(x, y, 3))) open.attackers.push(x); if (!open.by && x.owner) open.by = x.owner; }
                    if (t.threat.undefended) open.undefended = true;
                }
                // An answer counts inside the window even when the raid has already left
                // the state: it is aimed at where the seat last saw it.
                for (const e of episodes) {
                    const after = i - (e.decision - 1);
                    if (e.answeredAfter != null || after < 0 || after >= W) continue;
                    const ci = t.cmds.findIndex(c => answers(c, e, R));
                    if (ci < 0) continue;
                    e.answeredAfter = after;
                    e.answer = { decision: i + 1, turn: t.turn, sec: t.sec, n: ci + 1, k: nthOfItsKind(t.cmds, ci), action: t.cmds[ci].action, x: t.cmds[ci].x, z: t.cmds[ci].z };
                }
            });
            // A rival Wonder, from the decision that first showed it.
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
                    w.answer = { decision: i + 1, turn: t.turn, sec: t.sec, n: ci + 1, k: nthOfItsKind(t.cmds, ci), action: 'attack_target', x: t.cmds[ci].x, z: t.cmds[ci].z };
                }
            });
            const answered = episodes.filter(e => e.answeredAfter != null), atOnce = answered.filter(e => e.answeredAfter <= 1);
            const wonderAnswered = wonders.filter(w => w.answeredAfter != null);
            const chances = episodes.length + wonders.length;
            const list = episodes.map(e => ({ kind: 'attack', decision: e.decision, turn: e.turn, sec: e.sec, what: [...new Set(e.targets.map(x => x.type))], by: e.by,
                decisions: e.decisions, undefended: e.undefended, answeredAfter: e.answeredAfter,
                // Where the threat was (the attackers, as the seat was shown them, else what they hit) and the order that answered it.
                at: e.attackers[0] ? { x: e.attackers[0].x, z: e.attackers[0].z } : e.targets[0] ? { x: e.targets[0].x, z: e.targets[0].z } : null, answer: e.answer || null,
                outcome: e.lost.length ? 'lost' : e.ended ? 'held' : 'open', lost: e.lost }))
                .concat(wonders.map(w => ({ kind: 'wonder', decision: w.decision, turn: w.turn, sec: w.sec, what: ['wonder'], by: w.by, answeredAfter: w.answeredAfter,
                    at: w.x != null && w.z != null ? { x: w.x, z: w.z } : null, answer: w.answer || null })))
                .sort((a, b) => a.decision - b.decision);
            if (!judged) return { episodes: episodes.length, wonders: wonders.length, answered: null, atOnce: null, unanswered: null, wonderAnswered: null,
                decisionsToAnswer: null, lost: null, held: null, list, judged, score: null };
            return {
                episodes: episodes.length, answered: answered.length, atOnce: atOnce.length, unanswered: episodes.length - answered.length,
                decisionsToAnswer: answered.length ? quantile(answered.map(e => e.answeredAfter), 0.5) : null,
                // What became of the buildings that were attacked. Reported beside the answer,
                // not inside the score: holding a town is a matter of strength as well.
                lost: episodes.filter(e => e.lost.length).length, held: episodes.filter(e => !e.lost.length && e.ended).length,
                undefended: episodes.filter(e => e.undefended).length,
                wonders: wonders.length, wonderAnswered: wonderAnswered.length,
                // Every episode, with the moment the seat was first shown it.
                list, judged,
                // v0: the share of threats answered at once. No threat shown is a dash.
                score: !chances ? null : Math.round(1000 * (atOnce.length + wonderAnswered.length) / chances) / 10
            };
        }

        // What did a decision cost? Beside the profile, never inside it.
        _efficiency(seat, ok) {
            const turns = seat.turns;
            const lat = turns.map(t => t.latencyMs).filter(v => v != null);
            const tok = turns.filter(t => t.prompt != null && t.completion != null);
            const commands = sum(turns.map(t => t.commands));
            const completion = sum(tok.map(t => t.completion));
            return {
                latencyMs: lat.length ? { median: quantile(lat, 0.5), p90: quantile(lat, 0.9), n: lat.length } : null,
                // null where the seat's harness reports no usage (an MCP seat's does not).
                tokens: tok.length ? {
                    promptMedian: quantile(tok.map(t => t.prompt), 0.5), completionMedian: quantile(tok.map(t => t.completion), 0.5),
                    promptTotal: sum(tok.map(t => t.prompt)), completionTotal: completion, n: tok.length,
                    // Completion tokens for every command that worked. A seat that issues
                    // none has paid for nothing, which is not zero.
                    completionPerOk: ok ? completion / ok : null
                } : null,
                commandsPerDecision: turns.length ? commands / turns.length : null,
                emptyDecisions: turns.filter(t => !t.commands).length,
                missedRounds: seat.markers.round_missed || 0,
                failedRequests: seat.markers.request_failed || 0,
                cancelledRequests: seat.markers.request_cancelled || 0
            };
        }

        // The profile as it stood at an earlier moment of the match: every seat's decisions
        // up to that match second and nothing after. What the page compares "now" with.
        profileAt(sec) {
            const key = this.lines + ':' + this.unreadable + ':' + this.rev + ':' + sec;
            if (this._past && this._pastKey === key) return this._past;
            this._pastKey = key;
            return this._past = this._work([...this.seats.values()].map(s => Object.assign({}, s, { turns: s.turns.filter(t => t.sec != null && t.sec <= sec) })), sec);
        }

        // The scores over the whole match, to be written into the transcript as a line of
        // its own (asp67, 22 November 2026: "Scoring needs to be part of the transcript, so
        // that the score history is saved over the entire match and can be analyzed
        // later"). The profile as it stood every HISTORY_SEC seconds and at the end, a row
        // of numbers a seat (WarEval.HISTORY_FIELDS says which). Nothing in it is new
        // knowledge: it is profileAt() asked many times, so a reader who scores the file
        // arrives at the same rows, and a file from before this build has them worked out
        // on reading. It does not depend on the results line, which is written with it.
        history(every = WarEval.HISTORY_SEC) { return this._history(every, null); }
        // The timeline's readings, every five seconds: from the file's own line once it is
        // there, and until then as the page has shown them to the ledger (preview).
        power() { const tl = this.timeline || this._preview; return (tl && tl.samples) || []; }
        // The same for a match still being played, asked again at every decision (the
        // comparison board's graphs, build 1222). A sample is kept once it can no longer
        // change, and only the newest are worked out again. It can change for a while: a
        // seat's record carries the second its state was built at and arrives when the
        // seat has answered, which a slow one does minutes later. `settle` is how long.
        liveHistory(every = WarEval.HISTORY_SEC, settle = 600) {
            const key = every + ':' + settle;
            if (!this._live || this._live.key !== key) this._live = { key, at: new Map() };
            return this._history(every, this._live.at, settle);
        }
        _history(every, kept, settle = 0) {
            const seats = [...this.seats.values()].filter(s => s.turns.length);
            let end = 0;
            for (const s of seats) for (const t of s.turns) if (t.sec != null && t.sec > end) end = t.sec;
            const tl = this.power();
            if (tl.length && num(tl[tl.length - 1].t) > end) end = num(tl[tl.length - 1].t);
            const times = [];
            for (let t = every; t < end; t += every) times.push(t);
            if (end > 0) times.push(end);
            const sample = t => {
                const v = {};
                for (const p of this.profileAt(t).seats) {
                    if (!p.decisions) continue;
                    const turns = this.seats.get(p.id).turns.filter(x => x.sec != null && x.sec <= t), g = p.grounding;
                    v[p.id] = [p.decisions, p.index.value, g.score, p.planning.score, p.follow.score, p.tactical.score, p.strategy.score,
                        sum(turns.map(x => x.commands)), g.ok, g.avoidable, g.invalid, g.repeated,
                        sum(turns.map(x => x.prompt || 0)), sum(turns.map(x => x.completion || 0)), sum(turns.map(x => x.latencyMs || 0))];
                }
                return { t, v };
            };
            const samples = times.map(t => {
                if (!kept) return sample(t);
                const settled = t % every === 0 && t < end - settle;
                if (settled && kept.has(t)) return kept.get(t);
                const s = sample(t);
                if (settled) kept.set(t, s);
                return s;
            });
            return { type: 'scores', kind: 'war-eval/' + WarEval.VERSION, scale: WarEval.SCALE, everySec: every, fields: WarEval.HISTORY_FIELDS.slice(),
                seats: seats.map(s => ({ id: s.id, seat: s.seat, civ: s.civ, name: s.name, model: s.model })), samples };
        }
        // A seat's history as one list a field, from a 'scores' line or from history():
        // { t: [...], index: [...], grounding: [...], ... }. Null for a seat that is not in it.
        static series(scores, id) {
            if (!scores || !Array.isArray(scores.samples) || !Array.isArray(scores.fields)) return null;
            const rows = scores.samples.filter(s => s.v && s.v[id]);
            if (!rows.length) return null;
            const out = { t: rows.map(s => s.t) };
            scores.fields.forEach((f, i) => { out[f] = rows.map(s => s.v[id][i]); });
            return out;
        }

        // The profile as it will stand once the match's two closing lines are in the file
        // (step D8). The results line carries the profile, so the profile is worked out
        // before that line exists; a reader of the file then arrives at the same numbers.
        profileWith(results, timeline) {
            const keep = [this.results, this.timeline];
            if (results) this.results = resultsOf(results);
            if (timeline) this.timeline = timelineOf(timeline);
            try { return this._work([...this.seats.values()]); }
            finally { this.results = keep[0]; this.timeline = keep[1]; }
        }

        // The timeline as it stands while the match is still running. The file gets it
        // as one line at the end; until then the page hands over the same object the
        // line will be written from, and the line replaces it when it arrives.
        preview(timeline) {
            if (this.timeline || !timeline || !Array.isArray(timeline.samples)) return;
            const n = timeline.samples.length;
            if (this._preview && this._previewN === n) return;
            this._preview = { samples: timeline.samples.slice(), ages: Array.isArray(timeline.ages) ? timeline.ages.slice() : [] };
            this._previewN = n; this.rev++;
        }

        // Does its play turn into winning? (step C5)
        //
        // From what the match recorded about itself: the power score every five seconds,
        // the battles, and at the end the placement. Until the results are in, the score
        // rests on the first two and says it is not final.
        _strategy(seat, until) {
            const tl = this.timeline || this._preview, id = seat.id;
            const samples = (tl ? tl.samples : []).filter(x => x && x.p && x.p[id] && (until == null || x.t <= until));
            let share = 0, counted = 0, leading = 0, run = 0, clearAt = null, seats = 0;
            const step = samples.length > 1 ? Math.max(1, (samples[samples.length - 1].t - samples[0].t) / (samples.length - 1)) : 5;
            for (const x of samples) {
                const all = Object.keys(x.p), mine = x.p[id].pw || 0;
                const total = all.reduce((a, k) => a + (x.p[k].pw || 0), 0), best = Math.max(0, ...all.filter(k => k !== id).map(k => x.p[k].pw || 0));
                seats = Math.max(seats, all.length);
                if (!total) continue;
                counted++; share += mine / total;
                if (mine >= best) leading++;
                run = all.length > 1 && mine >= best * WarEval.LEAD_FACTOR && mine > 0 ? run + 1 : 0;
                if (clearAt == null && run * step >= WarEval.LEAD_SECONDS) clearAt = x.t;
            }
            const powerShare = counted ? share / counted : null;
            let fought = 0, destroyed = 0, lost = 0;
            for (const b of this.battles) {
                if (!b.sides[id] || (until != null && b.t > until)) continue;
                fought++; lost += b.sides[id].lost || 0;
                for (const k in b.sides) if (k !== id) destroyed += b.sides[k].lost || 0;
            }
            const exchange = destroyed + lost ? destroyed / (destroyed + lost) : null;
            const final = !!this.results && until == null, row = final ? this.results.ranking.find(r => r.id === id) : null;
            const n = final ? this.results.ranking.length : seats;
            const placement = row && row.rank != null && n > 1 ? (n - row.rank) / (n - 1) : null;
            const mean = list => { const have = list.filter(v => v != null); return have.length ? Math.round(1000 * have.reduce((a, b) => a + b, 0) / have.length) / 10 : null; };
            const power = powerShare == null || !seats ? null : clamp01(powerShare * seats / 1.5);
            return {
                final, rank: row ? row.rank : null, of: n || null, winner: row ? row.winner : null, placement,
                powerShare, evenShare: seats ? 1 / seats : null, leadShare: counted ? leading / counted : null, samples: counted,
                // A clear lead, and whether it was turned into the win.
                clearLeadAt: clearAt, converted: clearAt == null || !row ? null : row.rank === 1,
                battles: fought, destroyed, lost, exchange,
                ages: (tl ? tl.ages : []).filter(a => a && a.id === id && (until == null || a.t <= until)).map(a => ({ age: a.age, sec: a.t })),
                // v0: the mean of placement, share of power against an even split (half
                // again as much is full marks) and the share of battle losses that were
                // the other side's. A part the match gave no chance for is left out.
                // Without the placement it is the same number a running match shows.
                score: mean([placement, power, exchange]), running: mean([power, exchange])
            };
        }

        // The range a seat used with success. Facts only: breadth for its own sake earns
        // nothing, and the rule for "where it helps" is not written yet, so no score.
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

        // Worked out again only when a line has arrived since: the page asks once a
        // second, a match adds a line every few. Treat the result as read-only.
        profile() {
            if (this._profile && this._profileLines === this.lines + ':' + this.unreadable + ':' + this.rev) return this._profile;
            this._profileLines = this.lines + ':' + this.unreadable + ':' + this.rev;
            return this._profile = this._work([...this.seats.values()]);
        }

        _work(list, until) {
            const seats = list.map(s => {
                const grounding = this._grounding(s.turns), planning = this._planning(s);
                const out = { id: s.id, seat: s.seat, civ: s.civ, model: s.model, name: s.name,
                    decisions: s.turns.length, grounding, planning, follow: this._follow(s, this._plans, !!this.results && until == null), tactical: this._tactical(s),
                    strategy: this._strategy(s, until), versatility: this._versatility(s),
                    efficiency: this._efficiency(s, grounding.ok) };
                // The Index: the mean of the parts that have a score. A summary of the bars,
                // never a replacement for them; one match is one sample.
                //
                // A plan counts as far as it was followed: Planning and Follow-through enter
                // as ONE part, their product. Planning by itself measures the stated plan,
                // and a seat that states one and never plays it scored an Index of 52 as a
                // plain mean of five (the plan-only anchor). No plan is 0; a plan whose
                // follow-through cannot be read yet leaves the part out.
                // A seat no model decided for (a rule-based opponent) has a strategy row and no Index.
                const p = out.planning.score, f = out.follow.score;
                const plan = p == null ? null : p === 0 ? 0 : f == null ? null : Math.round(p * f / 10) / 10;
                const part = { grounding: out.grounding.score, plan, tactical: out.tactical.score, strategy: out.strategy.score };
                const have = s.turns.length ? WarEval.INDEX_PARTS.map(k => part[k]).filter(v => v != null) : [];
                out.index = { value: have.length ? Math.round(10 * have.reduce((a, b) => a + b, 0) / have.length) / 10 : null, of: have.length, parts: WarEval.INDEX_PARTS.length, plan };
                return out;
            });
            seats.sort((a, b) => (a.seat == null ? 1e9 : a.seat) - (b.seat == null ? 1e9 : b.seat) || String(a.id).localeCompare(String(b.id)));
            return { kind: 'war-eval/' + WarEval.VERSION, scale: WarEval.SCALE, match: this.match,
                lines: this.lines, unreadable: this.unreadable, seats,
                // The profile the file itself carries in its results line, if it does.
                recorded: (this.results && this.results.profile) || null };
        }
    }

    WarEval.Ledger = Ledger;
    // The step reader on its own, so it can be measured against steps read by hand.
    WarEval.checkable = checkable;
    WarEval.createLedger = () => new Ledger();
    // The profile of a whole transcript given as text.
    WarEval.profileOf = (text) => {
        const ledger = new Ledger();
        for (const line of String(text || '').split(/\r?\n/)) ledger.addLine(line);
        return ledger.profile();
    };

    root.WarEval = WarEval;
    if (typeof module !== 'undefined' && module.exports) module.exports = WarEval;
})(typeof window !== 'undefined' ? window : globalThis);
