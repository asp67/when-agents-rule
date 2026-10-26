// The arena page's side of the WAR MCP hub (tools/mcp/war-mcp-hub.cjs, docs/MCP-ARENA.md).
// An MCP seat is played by an agent harness on its own subscription; this page still runs,
// renders and records the match. The link sends the seat its turn -- the same text a
// library seat is sent -- and gathers the commands its harness gives until end_turn.
// OpenAIAIManager turns them into the same tool calls a library seat's reply carries, so
// everything after that (parsing, the round, the executor, the transcript) is shared.
//
// Commands do not run when the harness sends them. As for every seat in a turn-based
// round, they run together when the round closes, and their results come with the seat's
// next turn; the harness is told "queued" meanwhile.
class WarMcpLink {
    constructor(base = 'http://127.0.0.1:8765') {
        this.base = base.replace(/\/+$/, '');
        this.ws = null;
        this.wanted = false;
        this.hubUp = false;
        this.seats = [];               // [{ token, seat, name }]
        this.state = new Map();        // token -> { harness, joined }
        this.turns = new Map();        // token -> { turn, calls, resolve, reject, counted }
        this.rulesSent = new Set();    // tokens whose harness has had the rules
        this.listeners = new Set();
        this.maxCommands = 3;
        this._retry = null;
    }
    static get FREE() { return ['plan']; }

    // One link per hub address for the whole page, shared by the arena setup (its dots)
    // and the running match (its turns): the harness that joined in the setup is the
    // one the match plays with.
    static shared(base = 'http://127.0.0.1:8765') {
        const key = String(base).replace(/\/+$/, '');
        const all = WarMcpLink._all || (WarMcpLink._all = new Map());
        let link = all.get(key);
        if (!link) { link = new WarMcpLink(key); all.set(key, link); link.connect(); }
        return link;
    }

    // Status for the arena setup's dots: listeners get (token, {hub, harness, joined}).
    onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
    status(token) {
        const s = this.state.get(token) || {};
        return { hub: this.hubUp, harness: !!s.harness, joined: !!s.joined };
    }
    _changed(token) {
        const tokens = token ? [token] : this.seats.map(s => s.token);
        for (const t of tokens) for (const fn of this.listeners) { try { fn(t, this.status(t)); } catch (e) { /* a listener's fault stays its own */ } }
    }

    connect() {
        this.wanted = true;
        if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) return;
        let ws;
        try { ws = new WebSocket(this.base.replace(/^http/, 'ws') + '/page'); }
        catch (e) { this._reconnect(); return; }
        this.ws = ws;
        ws.onopen = () => { this.hubUp = true; this._sendArena(); this._changed(); };
        ws.onmessage = e => { let m; try { m = JSON.parse(e.data); } catch (x) { return; } this._fromHub(m); };
        ws.onclose = () => {
            const was = this.hubUp; this.hubUp = false;
            if (this.ws === ws) this.ws = null;
            if (was) this._changed();
            this._reconnect();
        };
        ws.onerror = () => { /* onclose follows */ };
    }
    close() {
        this.wanted = false;
        clearTimeout(this._retry);
        if (this.ws) { try { this._send({ type: 'close' }); this.ws.close(); } catch (e) { /* already gone */ } }
        this.ws = null; this.hubUp = false;
    }
    _reconnect() {
        if (!this.wanted) return;
        clearTimeout(this._retry);
        this._retry = setTimeout(() => this.connect(), 2000);
    }
    _send(obj) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj)); }
    _sendArena() { this._send({ type: 'arena', seats: this.seats.map(s => ({ token: s.token, seat: s.seat, name: s.name })) }); }

    // The MCP seats the arena waits for. Re-sent whenever the hub (re)connects.
    setSeats(seats) {
        this.seats = (seats || []).map(s => ({ token: s.token, seat: s.seat, name: s.name || '' }));
        for (const s of this.seats) if (!this.state.has(s.token)) this.state.set(s.token, { harness: false, joined: false });
        this._sendArena();
        this._changed();
    }

    _fromHub(m) {
        if (m.type === 'hello') { if (m.maxCommandsPerTurn) this.maxCommands = m.maxCommandsPerTurn; return; }
        if (m.type === 'harness' || m.type === 'join') {
            const s = this.state.get(m.token) || {};
            if (m.type === 'harness') s.harness = true; else { s.harness = true; s.joined = true; }
            this.state.set(m.token, s);
            this._changed(m.token);
            return;
        }
        if (m.type === 'action') {
            const t = this.turns.get(m.token);
            if (!t || t.turn !== m.turn) { this._send({ type: 'result', id: m.id, text: '[ERROR] That turn has closed. Call wait_for_turn.' }); return; }
            t.calls.push({ name: m.name, args: m.args || {} });
            const free = WarMcpLink.FREE.includes(m.name);
            if (!free) t.counted++;
            // Each answer ends with the next step (asp67: a harness that joined then sat idle).
            const left = this.maxCommands - t.counted;
            const next = left > 0 ? `You can give ${left} more, or call end_turn.` : 'Your next action: call end_turn.';
            this._send({ type: 'result', id: m.id, text: free
                ? `OK - ${m.name} noted. Give your commands, or call end_turn.`
                : `Queued (${t.counted}/${this.maxCommands}): ${m.name}. It runs when the round closes, together with every other player's commands; its result comes with your next turn. ${next}` });
            return;
        }
        if (m.type === 'end_turn') {
            const t = this.turns.get(m.token);
            if (t && t.turn === m.turn) { this.turns.delete(m.token); t.resolve(t.calls); }
        }
    }

    // One turn: send the seat its text, resolve with the harness's calls at end_turn.
    // `rules` (the seat's system prompt) goes with the seat's first turn, and to the hub
    // for get_rules. Aborting (a missed round, the match ending) tells the hub the turn
    // is over and rejects as fetch would.
    playTurn(token, turn, text, rules, signal) {
        return new Promise((resolve, reject) => {
            const prev = this.turns.get(token);
            if (prev) prev.reject(new Error('superseded by a newer turn'));
            const t = { turn, calls: [], counted: 0, resolve, reject };
            this.turns.set(token, t);
            const first = !this.rulesSent.has(token);
            if (first) this.rulesSent.add(token);
            const body = (first && rules ? 'RULES OF THE GAME (your system prompt; get_rules shows them again):\n\n' + rules + '\n\n---\n\n' : '') + text;
            this._send({ type: 'turn', token, turn, state: body, rules: rules || '' });
            if (signal) {
                const stop = () => {
                    if (this.turns.get(token) !== t) return;
                    this.turns.delete(token);
                    this._send({ type: 'turn_over', token, turn });
                    const e = new Error('aborted'); e.name = 'AbortError';
                    reject(e);
                };
                if (signal.aborted) stop(); else signal.addEventListener('abort', stop, { once: true });
            }
        });
    }

    over(token, result) { this._send({ type: 'over', token, result: result || {} }); }
}
if (typeof window !== 'undefined') window.WarMcpLink = WarMcpLink;
if (typeof module !== 'undefined' && module.exports) module.exports = WarMcpLink;
