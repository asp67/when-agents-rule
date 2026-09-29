// ---------------------------------------------------------------------------
// The intent layer (review #11): what each model just ordered, drawn where it points,
// with the model's own reason beside it.
//
// It reads each seat's turn log -- the tool calls as the model sent them -- and changes
// nothing. Targets are resolved exactly or not at all:
//
//   targetId        the entity with that id, if it still stands
//   tile            the centre of that tile of the 7x7 map grid the models are shown
//   targetX/targetZ that point
//   unitIds         the seat's own units by the handles it was shown (friendlyUnits)
//   units omitted   the whole army, as the tool defines it
//   units {type:n}  where the units of that type stand (the executor picks which)
//
// An arrow is drawn only when both ends resolve; a target with no known origin (an
// explore with no unit named: the harness picks the scout) gets a marker alone. The
// reason is shown verbatim up to 160 characters -- the median reason is about 100, so a
// shorter cap would edit the model's words. Every ring has its own bubble: the reason
// that command gave, or the command's name when it gave none.
//
// A plan is not a command and points nowhere: it is shown whole -- objective and every
// step -- in a bubble on the edge of the view, three times as long as a turn's bubbles,
// two at most (29 Sep 2026).
// ---------------------------------------------------------------------------
class IntentLayer {
    constructor(game) {
        this.game = game;
        this.intents = [];              // { seat, color, from, to, marker, born, id }
        this.bubbles = [];              // { seat, text, anchor, born, life, ... }, one per ring
        this.plans = [];                // { seat, objective, steps, born, life, slot, ... }, two at most
        this.seen = new WeakSet();      // turn log entries already drawn
        this._started = false;
    }

    // How long a turn stays up: long enough to read what it says. Every bubble and its
    // marks hold fully visible and then fade over the same last FADE_MS, so no bubble
    // fades faster than another.
    static get LIFE_MS() { return 6000; }
    static get LIFE_MAX_MS() { return 11000; }
    static get FADE_MS() { return 1200; }
    static lifeFor(text) { return Math.min(IntentLayer.LIFE_MAX_MS, Math.max(IntentLayer.LIFE_MS, 4500 + 45 * String(text || '').length)); }
    static alpha(now, born, life) {
        const age = now - born;
        if (age < 0 || age >= life) return 0;
        return age < life - IntentLayer.FADE_MS ? 1 : (life - age) / IntentLayer.FADE_MS;
    }
    // A plan stays three times as long as a turn's bubbles would for the same text, and
    // outlives its seat's later turns: it is what the seat is working to, not one move.
    static get PLAN_LIFE_FACTOR() { return 3; }
    static get PLAN_MAX() { return 2; }
    static planSteps(p) {
        const raw = Array.isArray(p.plan) ? p.plan : (typeof p.plan === 'string' ? [p.plan] : []);
        return raw.map(x => String(x == null ? '' : x).replace(/\s+/g, ' ').trim()).filter(Boolean);
    }
    static get REASON_MAX() { return 160; }
    static get BUBBLE_W() { return 260; }   // screen px: a bubble's widest (its CSS max-width)

    // Bubbles that would cover each other are stacked upward instead. Each box stands on
    // its point: `y` is its bottom, `h` its height, `w` its width, `x` its centre. Boxes
    // are placed in order; a box that meets one already placed moves up above it, as
    // often as it takes. Returns each box's bottom.
    //
    // Width counts in full. Testing only a fixed 150 px sideways let two 260 px bubbles
    // 150-260 px apart overlap, and the later one covered the earlier one's reason.
    //
    // `minTop` is the highest a box's top may go. A box that would climb past it goes
    // below the one it meets instead -- bubbles resting on the top edge of the view pile
    // downward. The number of moves per box is capped, so a crowded edge cannot loop.
    static stack(boxes, gap = 4, minTop = -Infinity) {
        const placed = [];
        return boxes.map(b => {
            // Once a box has gone down it keeps going down: turning back up would meet the
            // box it just left and swing between the two.
            let y = b.y, hit, moves = 0, down = false;
            while (moves++ < 60 && (hit = placed.find(o => Math.abs(o.x - b.x) < (o.w + b.w) / 2 && y - b.h < o.y && o.y - o.h < y))) {
                const up = hit.y - hit.h - gap;
                if (!down && up - b.h >= minTop) y = up;
                else { down = true; y = hit.y + b.h + gap; }
            }
            placed.push({ x: b.x, y, w: b.w, h: b.h });
            return y;
        });
    }
    static get GRID() { return 7; }

    // The seat's colour, as its badge shows it. Seat 0 wears charcoal, which vanishes on
    // the map, so a dark fill is drawn in the badge's rim colour for dark backgrounds.
    colorOf(ai) {
        const b = typeof getTeamBadge === 'function' ? getTeamBadge(ai && ai.seat) : null;
        if (!b) return '#e9c46a';
        const hex = String(b.fill || '').replace('#', '');
        const lum = hex.length === 6 ? (0.2126 * parseInt(hex.slice(0, 2), 16) + 0.7152 * parseInt(hex.slice(2, 4), 16) + 0.0722 * parseInt(hex.slice(4, 6), 16)) : 255;
        if (lum < 70) return (typeof teamBadgeRimOnDark === 'function' ? teamBadgeRimOnDark(b) : b.rim) || '#bbbbbb';
        return b.fill;
    }

    // Was command `i` of this turn refused? The harness answers a turn with one line per
    // command ("Command 2/3: [ERROR] ..."), filled in once the commands have run. Until
    // then nothing is known, and nothing is claimed.
    static rejected(turn, i) {
        const line = IntentLayer.outcomeLine(turn, i);
        return line == null ? null : line.startsWith('[ERROR]');
    }
    // The harness's answer to command `i` of a turn, or null until it has answered.
    static outcomeLine(turn, i) {
        const h = turn && typeof turn.outcome === 'string' ? turn.outcome : '';
        if (!h) return null;
        const parts = h.split(/\n(?=Command \d+\/\d+: )/);
        const lines = parts.length < 2 && !/^Command \d+\/\d+: /.test(h) ? [h] : parts.map(x => x.replace(/^Command \d+\/\d+: /, ''));
        const line = lines.length === 1 ? lines[0] : lines[i];
        return line == null ? null : String(line);
    }

    // Where an explore really goes. The model names a tile; the harness walks the scout
    // to the least-seen walkable part of it (pointInTile), which the viewer cannot work
    // out -- it does not know what the seat had seen. The answer names the unit it sent
    // ("OK - Sent your worker #4 ..."), and that unit carries the exact target, so once
    // the answer is in, the ring moves there, and a path is drawn from the unit if the
    // order had none. Tried once per mark: a refused explore keeps its tile.
    aimExplore(i) {
        if (i.action !== 'explore' || i._aimed) return;
        const line = IntentLayer.outcomeLine(i.turn, i.index);
        if (line == null) return;          // not answered yet: try again next poll
        i._aimed = true;
        const m = /^OK - Sent your .*?#(\d+)/.exec(line);
        const ai = m && ((this.game.aiManager && this.game.aiManager.aiPlayers) || []).find(a => a.id === i.seat);
        const u = ai && (ai.units || []).find(x => x.health > 0 && String(x.handle) === m[1]);
        if (!u || !Number.isFinite(u.targetX) || !Number.isFinite(u.targetZ)) return;
        i.to.x = u.targetX; i.to.z = u.targetZ;   // the bubble's anchor is this same point
        if (!i.from) {
            i.from = { x: u.x, z: u.z }; i.marker = false;
            const b = this.bubbles.find(x => x.seat === i.seat && x.turn === i.turn && x.index === i.index);
            if (b) b.from = i.from;
        }
    }

    static reasonText(reason) {
        let r = String(reason || '').replace(/\s+/g, ' ').trim();
        // A reason that swallowed broken tool-call markup is shown up to the first tag.
        const tag = r.search(/<\/?(?:tool_call|arg_key|arg_value)>/);
        if (tag >= 0) r = r.slice(0, tag).trim() + ' …';
        if (!r) return '';
        return r.length > IntentLayer.REASON_MAX ? r.slice(0, IntentLayer.REASON_MAX - 1).trimEnd() + '…' : r;
    }

    tileCentre(label) {
        const m = /^([A-G])([1-7])$/i.exec(String(label || '').trim());
        if (!m) return null;
        const size = (this.game.terrain && this.game.terrain.size) || 800, cell = size / IntentLayer.GRID;
        const col = m[1].toUpperCase().charCodeAt(0) - 65, row = Number(m[2]) - 1;
        return { x: -size / 2 + (col + 0.5) * cell, z: -size / 2 + (row + 0.5) * cell };
    }

    entity(id) {
        if (id == null || id === '') return null;
        const g = this.game, all = [].concat(g.getAllUnits ? g.getAllUnits() : [], g.getAllBuildings ? g.getAllBuildings() : []);
        return all.find(e => e && e.health > 0 && (e.id === id || String(e.id) === String(id))) || null;
    }

    centroid(list) {
        const live = (list || []).filter(u => u && u.health > 0);
        if (!live.length) return null;
        return { x: live.reduce((a, u) => a + u.x, 0) / live.length, z: live.reduce((a, u) => a + u.z, 0) / live.length };
    }

    // The units a command moves, or null when the tool leaves the choice to the harness.
    origin(ai, name, p) {
        const own = (ai.units || []).filter(u => u.health > 0);
        if (Array.isArray(p.unitIds) && p.unitIds.length) {
            const ids = new Set(p.unitIds.map(String));
            return this.centroid(own.filter(u => ids.has(String(u.handle)) || ids.has(String(u.id))));
        }
        if (name === 'explore') return null;
        if (p.units && typeof p.units === 'object') {
            const types = Object.keys(p.units);
            return this.centroid(own.filter(u => types.includes(u.type) || types.includes(u.unitType)));
        }
        if (['attack_target', 'move_units', 'march'].includes(name)) return this.centroid(own.filter(u => u.type !== 'worker'));
        return null;
    }

    target(p) {
        if (p.targetId != null && p.targetId !== '') { const e = this.entity(p.targetId); return e ? { x: e.x, z: e.z } : null; }
        if (p.tile) return this.tileCentre(p.tile);
        if (Number.isFinite(Number(p.targetX)) && Number.isFinite(Number(p.targetZ)) && p.targetX !== '' && p.targetZ !== '')
            return { x: Number(p.targetX), z: Number(p.targetZ) };
        return null;
    }

    // Read every seat's newest turns. `stagger` spaces the bubbles of turns that landed
    // together (a turn-based round flushing) so each can be read.
    //
    // In a turn-based match an answer is held until every seat has answered and the round
    // is played (flushRound); the decisions log and captions wait for it, and so does this.
    // A held answer is its seat's answerContext._logTurn until the round takes it. One the
    // round drops is taken out of the turn log, so it is never drawn at all.
    poll(now = Date.now()) {
        const g = this.game, mgr = g.openAIAIManager, ctrls = (mgr && mgr.aiControllers) || [];
        const held = new Set();
        if (mgr && mgr.turnBased) for (const c of ctrls) if (c.answerContext && c.answerContext._logTurn) held.add(c.answerContext._logTurn);
        const fresh = [];
        for (const c of ctrls) {
            const log = c.turnLog || [];
            if (!this._started) { log.forEach(t => this.seen.add(t)); continue; }
            for (const t of log) if (!this.seen.has(t) && !held.has(t)) { this.seen.add(t); fresh.push({ c, t }); }
        }
        this._started = true;
        fresh.forEach(({ c, t }, k) => this.add(c.aiPlayer, t, now + k * 600));
        for (const i of this.intents) this.aimExplore(i);
        this.intents = this.intents.filter(i => now - i.born < i.life);
        this.bubbles = this.bubbles.filter(b => now - b.born < b.life);
        this.plans = this.plans.filter(q => now - q.born < q.life);
        return fresh.length;
    }

    // One turn at a time per seat: a new turn replaces the seat's last one. Every command
    // gets its own bubble, saying the reason it gave -- or, when it gave none, naming the
    // command -- so the map carries what the decisions log lists. A command that points at a
    // place gets a ring there and its bubble on it. One that points nowhere (train without a
    // rally point, research, age up, wait) gets its bubble at the building that carries it
    // out, and no ring: it names no place. Measured 28 Sep 2026: 132 of 372 turns had lost
    // such commands, only the first reason of a placeless turn was shown, over its base.
    // Everything of one turn shares one life, so it all fades together.
    add(ai, turn, born) {
        if (!ai) return;
        const color = this.colorOf(ai);
        // The bubble's band: the badge's own colour, as the leaderboard shows it. The
        // bubble is light parchment, so no dark colour needs lifting there.
        const tb = typeof getTeamBadge === 'function' ? getTeamBadge(ai.seat) : null;
        const band = (tb && tb.fill) || color;
        const marks = [], quiet = [];
        let plan = null, commands = 0;
        (turn.toolCalls || []).forEach(call => {
            if (!call || !call.name) return;
            // The harness answers the game commands only ("Command k/n" leaves the plan
            // out), so a command's index counts commands, not calls. Counting calls put
            // every refusal one command late whenever the plan came first.
            const index = call.name === 'plan' ? -1 : commands++;
            let p = {};
            try { p = JSON.parse(call.args || '{}') || {}; } catch (e) { return; }
            if (call.name === 'plan') {
                const objective = String(p.objective == null ? '' : p.objective).replace(/\s+/g, ' ').trim();
                const steps = IntentLayer.planSteps(p);
                if (objective || steps.length) plan = { objective, steps };
                return;
            }
            const reason = IntentLayer.reasonText(p.reason);
            const name = String(call.name).replace(/_/g, ' ') + (p.tile ? ' ' + p.tile : '');
            const to = this.target(p);
            if (!to) {
                const at = this.home(ai, call.name, p);
                if (at) quiet.push({ anchor: at, action: call.name, params: p, index, text: reason || name, summary: !reason });
                return;
            }
            const from = this.origin(ai, call.name, p);
            marks.push({ from, to, marker: !from, action: call.name, params: p, turn, index, text: reason || name, summary: !reason, tall: this.onStructure(call.name, p) });
        });
        if (plan) this.addPlan(ai, plan, born, color, band);
        if (!marks.length && !quiet.length) return;   // nothing to show
        const life = IntentLayer.lifeFor(marks.concat(quiet).reduce((t, m) => m.text.length > t.length ? m.text : t, ''));
        this.intents = this.intents.filter(i => i.seat !== ai.id);
        this.bubbles = this.bubbles.filter(b => b.seat !== ai.id);
        for (const m of marks) {
            this.intents.push(Object.assign({ seat: ai.id, color, born, life }, m));
            this.bubbles.push({ seat: ai.id, text: m.text, anchor: m.to, from: m.from, born, life, color, band, turn, index: m.index, summary: m.summary, action: m.action, params: m.params, tall: m.tall });
        }
        for (const q of quiet) {
            this.bubbles.push({ seat: ai.id, text: q.text, anchor: q.anchor, born, life, color, band, turn, index: q.index, summary: q.summary, action: q.action, params: q.params, tall: !!q.anchor.building });
        }
    }

    // A seat's new plan replaces its own last one; otherwise a third plan replaces the
    // oldest on screen, taking its place on the edge so the other stays where it is.
    addPlan(ai, plan, born, color, band) {
        this.plans = this.plans.filter(q => born - q.born < q.life);
        const text = [plan.objective].concat(plan.steps).join(' ');
        const entry = { seat: ai.id, objective: plan.objective, steps: plan.steps, born, color, band,
            life: IntentLayer.PLAN_LIFE_FACTOR * IntentLayer.lifeFor(text) };
        let old = this.plans.find(q => q.seat === ai.id);
        if (!old && this.plans.length >= IntentLayer.PLAN_MAX) old = this.plans.reduce((a, q) => (q.born < a.born ? q : a));
        if (old) { entry.slot = old.slot; this.plans.splice(this.plans.indexOf(old), 1); }
        else entry.slot = [0, 1].find(k => !this.plans.some(q => q.slot === k));
        this.plans.push(entry);
    }

    // Does a command's ring lie on a building or a resource? Its bubble then stands a
    // bubble higher, clear of the ring and of what it marks: a site being built, a
    // resource being gathered, a building attacked or repaired by id.
    onStructure(name, p) {
        if (name === 'build_structure' || name === 'assign_workers') return true;
        if (p.targetId == null || p.targetId === '') return false;
        const e = this.entity(p.targetId), g = this.game;
        return !!(e && (g.getAllBuildings ? g.getAllBuildings() : []).includes(e));
    }

    // Where a command that points at no place is shown: the building that carries it out
    // (the one that trains the unit, the one the tech is researched at), else the Town
    // Center, else the seat's units.
    home(ai, name, p) {
        const alive = (ai.buildings || []).filter(b => b && b.health > 0);
        let at = null;
        if (name === 'train_unit' && p.unitType) {
            // A live building knows its options; a military one's definition lists none (they
            // follow the age), so ask the table the build menu asks; the Town Center's workers
            // are in its definition. An unknown age (a viewer's frame) takes every tier.
            const nonEmpty = a => (Array.isArray(a) && a.length ? a : null);
            const trains = b => nonEmpty(b.trainOptions)
                || (typeof getTrainOptionsForBuilding === 'function' ? nonEmpty(getTrainOptionsForBuilding(b.type, ai.age || 'iron', ai.civilization)) : null)
                || (typeof getBuildingDef === 'function' ? (getBuildingDef(b.type) || {}).trainOptions || [] : []);
            at = alive.find(b => trains(b).includes(p.unitType)) || null;
        }
        if (name === 'research_tech' && p.techId && typeof getCivilization === 'function') {
            const tech = ((getCivilization(ai.civilization) || {}).techTree || {})[p.techId];
            if (tech && tech.researchAt) at = alive.find(b => b.type === tech.researchAt) || null;
        }
        const b = at || alive.find(x => x.type === 'town_center');
        return b ? { x: b.x, z: b.z, building: true } : this.centroid((ai.units || []).filter(u => u.health > 0));
    }

    // The marks as they sit in the world, for the renderer to lay on the ground: a ring
    // at each target (grey and crossed when refused), and a path from the units to it.
    worldMarks(now = Date.now()) {
        const out = [];
        for (const i of this.intents) {
            const alpha = IntentLayer.alpha(now, i.born, i.life);
            if (!(alpha > 0)) continue;
            const refused = IntentLayer.rejected(i.turn, i.index) === true;
            out.push({ from: i.from, to: i.to, marker: i.marker, refused, alpha, color: refused ? '#9aa4b1' : i.color, action: i.action });
        }
        return out;
    }

    // Where a bubble stands. On its ring when the ring is in view. When it is not, but
    // the path to it is, the bubble slides along the path to the point nearest the centre
    // of the view -- so a camera following the units (or cutting to part of a long march)
    // still shows what they were told and why, instead of an arrow with no clue on it.
    // `view` is { focus: {x, z} the camera looks at, w, h } in screen pixels; without it
    // the bubble stays on its ring.
    static anchorFor(b, project, view) {
        const at = project(b.anchor.x, b.anchor.z);
        if (!view || !b.from) return at;
        const inView = p => p && p.x >= 0 && p.x <= view.w && p.y >= 0 && p.y <= view.h;
        if (inView(at)) return at;
        const ax = b.from.x, az = b.from.z, dx = b.anchor.x - ax, dz = b.anchor.z - az, len2 = dx * dx + dz * dz;
        if (!(len2 > 0)) return at;
        const t = Math.max(0, Math.min(1, ((view.focus.x - ax) * dx + (view.focus.z - az) * dz) / len2));
        const onPath = project(ax + dx * t, az + dz * t);
        return inView(onPath) ? onPath : at;
    }

    // Screen geometry for this frame: the bubbles as positioned boxes (and, for tests and
    // any screen-space use, the marks), and the plans on the edges. `project(x, z)`
    // returns {x, y} or null.
    //
    // A seat's bubbles whose points are all out of view would each rest on the edge and
    // crowd it; with a `view` they become one card, the calls listed in the turn's order,
    // standing where the first of them would. A bubble whose point is in view keeps its
    // own place: that is where its command goes.
    //
    // A bubble on a building or a resource (`lift`) stands its own height higher, so its
    // bottom is where its top would have been, clear of the ring and of the thing ringed.
    frame(project, now = Date.now(), view = null) {
        const shapes = [], bubbles = [];
        for (const i of this.intents) {
            const opacity = IntentLayer.alpha(now, i.born, i.life);
            if (!(opacity > 0)) continue;
            const to = project(i.to.x, i.to.z);
            if (!to) continue;
            const from = i.from ? project(i.from.x, i.from.z) : null;
            // A refused order is still what the model asked for, drawn as refused: grey,
            // crossed out, never as a live move.
            const refused = IntentLayer.rejected(i.turn, i.index) === true;
            shapes.push({ color: refused ? '#9aa4b1' : i.color, opacity, from, to, marker: i.marker, refused });
        }
        const inView = pt => !!(view && pt && pt.x >= 0 && pt.x <= view.w && pt.y >= 0 && pt.y <= view.h);
        // Its size estimated from its text (a name line, then the reason wrapped at about
        // 40 characters) at the widest a bubble gets. The page re-stacks with the sizes it
        // actually drew (ui.drawIntentOverlay); this is the estimate for anything that has
        // no page.
        const lines = text => 1 + Math.ceil(String(text).length / 40);
        const out = [];
        for (const b of this.bubbles) {
            const opacity = IntentLayer.alpha(now, b.born, b.life);
            if (!(opacity > 0)) continue;
            const at = IntentLayer.anchorFor(b, project, view);
            if (!at) continue;
            const h = 16 + 15 * lines(b.text);
            // Lifted only while it stands on its own point: slid along a path or resting
            // on an edge, it covers nothing.
            const onPoint = !view || inView(project(b.anchor.x, b.anchor.z));
            out.push({ seat: b.seat, text: b.text, color: b.color, band: b.band || b.color, x: at.x, y: at.y, ay: at.y, w: IntentLayer.BUBBLE_W, h, opacity, summary: !!b.summary,
                action: b.action || null, params: b.params || null, lift: !!b.tall && onPoint, away: !!view && !inView(at),
                refused: IntentLayer.rejected(b.turn, b.index) === true });
        }
        const merged = new Set();
        for (const b of out) {
            if (merged.has(b)) continue;
            const away = b.away ? out.filter(o => o.away && o.seat === b.seat) : [b];
            if (away.length < 2) { bubbles.push(b); continue; }
            away.forEach(o => merged.add(o));
            bubbles.push({ seat: b.seat, text: away.map(o => o.text).join(' '), color: b.color, band: b.band, x: b.x, y: b.y, ay: b.ay,
                w: IntentLayer.BUBBLE_W, h: 16 + 15 * away.reduce((n, o) => n + lines(o.text), 0), opacity: Math.max(...away.map(o => o.opacity)),
                summary: false, action: null, params: null, lift: false, away: true, refused: false,
                lines: away.map(o => ({ text: o.text, summary: o.summary, action: o.action, params: o.params, refused: o.refused })) });
        }
        IntentLayer.stack(bubbles.map(b => ({ x: b.x, y: b.ay - (b.lift ? b.h : 0), w: b.w, h: b.h }))).forEach((y, k) => { bubbles[k].y = y; });
        const plans = this.plans.map(q => ({ seat: q.seat, objective: q.objective, steps: q.steps, color: q.color, band: q.band || q.color,
            slot: q.slot, opacity: IntentLayer.alpha(now, q.born, q.life) })).filter(q => q.opacity > 0).sort((a, b) => a.slot - b.slot);
        return { shapes, bubbles, plans };
    }
}

if (typeof module !== 'undefined' && module.exports) module.exports = IntentLayer;
