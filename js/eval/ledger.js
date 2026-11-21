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
// Four parts of the profile are filled so far:
//   grounding    were the commands valid when they were issued?
//   planning     does the seat keep a live, concrete plan, and restate it after a shock?
//   follow       does it do what its plan says?
//   efficiency   what did a decision cost? Shown beside the profile, never inside it.
(function (root) {
    'use strict';
    const WarEval = {
        VERSION: 1,
        // How raw rates become 0-100. 'v0' is the mapping proposed with the plan, stated
        // so it can be argued with; calibration against anchors is a later step (C6).
        SCALE: 'v0',
        // A mistake made again inside this many decisions counts as repeated.
        REPEAT_WINDOW: 2,
        // A plan step is acted on if a command carries it out within this many decisions.
        FOLLOW_WINDOW: 10,
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
    function commandList(parsed, outcomes) {
        const list = !parsed || typeof parsed !== 'object' ? [] : Array.isArray(parsed.commands) ? parsed.commands : (parsed.action ? [parsed] : []);
        return list.map((c, i) => {
            const q = (c && c.params && typeof c.params === 'object') ? c.params : {}, o = outcomes ? outcomes[i] : null;
            const name = q.unitType != null ? q.unitType : q.buildingType != null ? q.buildingType : q.techId;
            return { action: String(c && c.action), name: name != null ? String(name) : null, x: num(q.targetX), z: num(q.targetZ),
                target: q.targetId != null ? String(q.targetId) : null, scouting: q.mode === 'scout', ok: o ? o.verdict === 'ok' : null };
        });
    }
    // Does this command carry out that commitment of a plan step?
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

    class Ledger {
        constructor() {
            this.match = null;
            this.seats = new Map();          // playerId -> { id, seat, civ, model, name, turns: [], markers: {} }
            this.lines = 0;
            this.unreadable = 0;
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
            learnNames(seat.vocab, st);
            const outcomes = Array.isArray(o.outcomes) ? o.outcomes.map(x => ({ code: x && x.code != null ? String(x.code) : null,
                verdict: x && VERDICTS.includes(x.verdict) ? x.verdict : 'unknown' })) : null;
            seat.turns.push({
                cmds: commandList(o.parsed, outcomes),
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
            let unjudged = 0, repeated = 0;
            const before = [];               // the mistakes of the last decisions, newest last
            for (const t of turns) {
                const mine = [];
                if (!t.outcomes) unjudged += t.commands;
                else {
                    unjudged += Math.max(0, t.commands - t.outcomes.length);
                    for (const x of t.outcomes) {
                        count[x.verdict]++;
                        if (x.verdict !== 'avoidable' && x.verdict !== 'invalid') continue;
                        codes.set(x.code, (codes.get(x.code) || 0) + 1);
                        if (before.some(prev => prev.includes(x.code))) repeated++;
                        mine.push(x.code);
                    }
                }
                before.push(mine);
                if (before.length > WarEval.REPEAT_WINDOW) before.shift();
            }
            // What the model could have got right: contended commands and the harness's
            // own failures leave both sides, as they do in the match results.
            const mistakes = count.avoidable + count.invalid, judged = count.ok + mistakes;
            const rate = judged ? count.ok / judged : null;
            return {
                judged, ok: count.ok, avoidable: count.avoidable, invalid: count.invalid,
                contended: count.contended, harnessFault: count.harnessFault, unjudged,
                rate, repeated, repeatRate: mistakes ? repeated / mistakes : null,
                mistakes: [...codes.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
                    .map(([code, n]) => ({ code, n })),
                // v0: one command in ten refused for a reason the state had shown is 0.
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
                standing: standing ? { objective: standing.objective, since: standing.decision, sec: standing.sec,
                    steps: standing.steps.map(s => ({ text: s.text, checkable: s.checks.length > 0 })) } : null,
                history: history.map(h => ({ decision: h.decision, sec: h.sec, steps: h.steps.length })),
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
        // that stated it. It is acted on when a command that worked carries out one of
        // its commitments within FOLLOW_WINDOW decisions, dropped when the window closes
        // without one, and pending while the window is still open. A step carried out
        // later, while it still stood in the plan, is counted as late: it stays dropped
        // for the score, and is reported so the window can be argued with.
        _follow(seat, history) {
            const turns = seat.turns, vocab = seat.vocab, W = WarEval.FOLLOW_WINDOW, last = turns.length - 1;
            const judged = turns.some(t => t.cmds.some(c => c.ok != null));
            const tracked = [];
            history.forEach((h, hi) => h.steps.forEach(s => {
                if (!s.fresh || !s.checks.length) return;
                // Until which decision the step stood in the plan (exclusive).
                let until = turns.length;
                for (let j = hi + 1; j < history.length; j++)
                    if (!history[j].steps.some(x => plain(x.text) === plain(s.text))) { until = history[j].decision - 1; break; }
                tracked.push({ key: plain(s.text), at: h.decision - 1, until, checks: s.checks, met: new Set(), acted: null, late: null });
            }));
            let served = 0, underPlan = 0, hi = -1;
            turns.forEach((t, i) => {
                while (hi + 1 < history.length && history[hi + 1].decision - 1 <= i) hi++;
                const standing = hi >= 0 ? history[hi] : null;
                for (const c of t.cmds) {
                    if (c.ok !== true) continue;
                    if (standing && aboutPlan(c)) {
                        underPlan++;
                        if (standing.steps.some(s => s.checks.some(k => serves(c, k, vocab)))) served++;
                    }
                    for (const s of tracked) {
                        if (s.at > i || (s.acted != null && s.met.size === s.checks.length)) continue;
                        const hit = s.checks.findIndex(k => serves(c, k, vocab));
                        if (hit < 0) continue;
                        if (i - s.at <= W) { if (s.acted == null) s.acted = i - s.at; s.met.add(hit); }
                        else if (s.acted == null && s.late == null && i < s.until) s.late = i - s.at;
                    }
                }
            });
            const state = s => s.acted != null ? 'acted' : last - s.at >= W ? (s.late != null ? 'late' : 'dropped') : 'pending';
            const count = { acted: 0, dropped: 0, late: 0, pending: 0 };
            for (const s of tracked) count[state(s)]++;
            const closed = count.acted + count.dropped + count.late;
            const waits = tracked.filter(s => s.acted != null).map(s => s.acted);
            const commitments = sum(tracked.filter(s => state(s) !== 'pending').map(s => s.checks.length));
            const met = sum(tracked.filter(s => state(s) !== 'pending').map(s => s.met.size));
            const standing = history.length ? history[history.length - 1] : null;
            const byKey = new Map(tracked.map(s => [s.key, s]));       // the first statement of a step is the one followed
            for (const s of tracked) if (!byKey.has(s.key)) byKey.set(s.key, s);
            if (!judged) return { steps: tracked.length, acted: null, dropped: null, late: null, pending: null, rate: null, decisionsToAct: null,
                commitments: null, commitmentsMet: null, ordersUnderPlan: null, ordersServing: null, servingRate: null, standing: null, judged, score: null };
            return {
                steps: tracked.length, acted: count.acted, dropped: count.dropped + count.late, late: count.late, pending: count.pending,
                rate: closed ? count.acted / closed : null,
                decisionsToAct: waits.length ? quantile(waits, 0.5) : null,
                // A step can commit to several things; this is how many of them were carried out.
                commitments, commitmentsMet: met,
                // Of the orders a plan can be about, given under a standing plan: how many carried out one of its steps.
                ordersUnderPlan: underPlan, ordersServing: served, servingRate: underPlan ? served / underPlan : null,
                // The standing plan, step by step, for the page.
                standing: standing ? standing.steps.map(s => {
                    const f = s.checks.length ? byKey.get(plain(s.text)) : null;
                    return { text: s.text, state: !s.checks.length ? 'uncheckable' : f ? state(f) : 'pending', after: f && f.acted != null ? f.acted : null };
                }) : null,
                judged,
                // v0: the share of followed steps that were acted on. No plan, or a plan with
                // nothing checkable in it, earns nothing: 0. Nothing closed yet, or a file
                // that records no outcomes, is a dash.
                score: !turns.length || !judged ? null : !history.length ? 0
                    : !tracked.length ? (last >= W ? 0 : null) : closed ? Math.round(1000 * count.acted / closed) / 10 : null
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

        // Worked out again only when a line has arrived since: the page asks once a
        // second, a match adds a line every few. Treat the result as read-only.
        profile() {
            if (this._profile && this._profileLines === this.lines + ':' + this.unreadable) return this._profile;
            const seats = [...this.seats.values()].map(s => {
                const grounding = this._grounding(s.turns), planning = this._planning(s);
                return { id: s.id, seat: s.seat, civ: s.civ, model: s.model, name: s.name,
                    decisions: s.turns.length, grounding, planning, follow: this._follow(s, this._plans), efficiency: this._efficiency(s, grounding.ok) };
            });
            seats.sort((a, b) => (a.seat == null ? 1e9 : a.seat) - (b.seat == null ? 1e9 : b.seat) || String(a.id).localeCompare(String(b.id)));
            this._profileLines = this.lines + ':' + this.unreadable;
            this._profile = { kind: 'war-eval/' + WarEval.VERSION, scale: WarEval.SCALE, match: this.match,
                lines: this.lines, unreadable: this.unreadable, seats };
            return this._profile;
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
