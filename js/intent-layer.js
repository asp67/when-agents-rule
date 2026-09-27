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
// shorter cap would edit the model's words -- one bubble per seat, newest wins.
// ---------------------------------------------------------------------------
class IntentLayer {
    constructor(game) {
        this.game = game;
        this.intents = [];              // { seat, color, from, to, marker, born, id }
        this.bubbles = new Map();       // seat id -> { text, anchor, born }
        this.seen = new WeakSet();      // turn log entries already drawn
        this._started = false;
    }

    static get LIFE_MS() { return 6000; }
    static get REASON_MAX() { return 160; }
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
        const h = turn && typeof turn.outcome === 'string' ? turn.outcome : '';
        if (!h) return null;
        const parts = h.split(/\n(?=Command \d+\/\d+: )/);
        const lines = parts.length < 2 && !/^Command \d+\/\d+: /.test(h) ? [h] : parts.map(x => x.replace(/^Command \d+\/\d+: /, ''));
        const line = lines.length === 1 ? lines[0] : lines[i];
        return line == null ? null : String(line).startsWith('[ERROR]');
    }

    static reasonText(reason) {
        const r = String(reason || '').replace(/\s+/g, ' ').trim();
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
    poll(now = Date.now()) {
        const g = this.game, ctrls = (g.openAIAIManager && g.openAIAIManager.aiControllers) || [];
        const fresh = [];
        for (const c of ctrls) {
            const log = c.turnLog || [];
            if (!this._started) { log.forEach(t => this.seen.add(t)); continue; }
            for (const t of log) if (!this.seen.has(t)) { this.seen.add(t); fresh.push({ c, t }); }
        }
        this._started = true;
        fresh.forEach(({ c, t }, k) => this.add(c.aiPlayer, t, now + k * 600));
        this.intents = this.intents.filter(i => now - i.born < IntentLayer.LIFE_MS);
        for (const [id, b] of this.bubbles) if (now - b.born >= IntentLayer.LIFE_MS) this.bubbles.delete(id);
        return fresh.length;
    }

    add(ai, turn, born) {
        if (!ai) return;
        const color = this.colorOf(ai);
        let reason = '', anchor = null, reasonIndex = 0;
        (turn.toolCalls || []).forEach((call, index) => {
            let p = {};
            try { p = JSON.parse(call.args || '{}') || {}; } catch (e) { return; }
            const to = this.target(p), from = to ? this.origin(ai, call.name, p) : null;
            if (to) this.intents.push({ seat: ai.id, color, from, to, marker: !from, born, action: call.name, turn, index });
            if (!reason && p.reason) { reason = IntentLayer.reasonText(p.reason); anchor = from || to; reasonIndex = index; }
        });
        if (!reason) return;
        if (!anchor) {
            const tc = (ai.buildings || []).find(b => b.type === 'town_center' && b.health > 0);
            anchor = tc ? { x: tc.x, z: tc.z } : this.centroid(ai.units);
        }
        if (anchor) this.bubbles.set(ai.id, { text: reason, anchor, born, color, turn, index: reasonIndex });
    }

    // Screen geometry for this frame: the arrows and markers as SVG, the bubbles as
    // positioned boxes. `project(x, z)` returns {x, y} or null (behind the camera).
    frame(project, now = Date.now()) {
        const shapes = [], bubbles = [];
        for (const i of this.intents) {
            if (now < i.born) continue;
            const age = (now - i.born) / IntentLayer.LIFE_MS;
            const to = project(i.to.x, i.to.z);
            if (!to) continue;
            const from = i.from ? project(i.from.x, i.from.z) : null;
            // A refused order is still what the model asked for, drawn as refused: grey,
            // crossed out, never as a live move.
            const refused = IntentLayer.rejected(i.turn, i.index) === true;
            shapes.push({ color: refused ? '#9aa4b1' : i.color, opacity: Math.max(0, 1 - age), from, to, marker: i.marker, refused });
        }
        for (const [seat, b] of this.bubbles) {
            if (now < b.born) continue;
            const at = project(b.anchor.x, b.anchor.z);
            if (at) bubbles.push({ seat, text: b.text, color: b.color, x: at.x, y: at.y, opacity: Math.max(0, 1 - (now - b.born) / IntentLayer.LIFE_MS),
                refused: IntentLayer.rejected(b.turn, b.index) === true });
        }
        return { shapes, bubbles };
    }
}

if (typeof module !== 'undefined' && module.exports) module.exports = IntentLayer;
