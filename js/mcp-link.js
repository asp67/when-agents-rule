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
        this.finals = new Map();       // token -> resolve(text|null): a closing message out
        this.rulesSent = new Set();    // tokens whose harness has had the rules
        this.hubWatch = false;         // the setup assistant follows the hub
        this.pausedSeats = new Set();  // tokens the user paused in the arena
        this.clients = new Map();      // harness name -> { name, version, at }: who connected
        this.checks = [];              // [{ name, at }]: check_connection calls seen
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
        return { hub: this.hubUp, harness: !!s.harness, joined: !!s.joined, checked: !!s.checked, client: s.client || '' };
    }
    // The setup assistant follows the hub: which harnesses connect (by the name each sends)
    // and which pass check_connection -- before any seat is chosen, on the shared address.
    // Listeners hear these as the token '*'.
    watchHub() { this.hubWatch = true; this._send({ type: 'watch' }); }
    unwatchHub() { this.hubWatch = false; this._send({ type: 'unwatch' }); }
    // How long the seat's harness has made no call to the hub, or null before its first.
    // A harness in its loop calls at least every wait (~25 s), so a silence longer than a
    // round means it has stopped, is asking its user something, or is still thinking.
    quietMs(token) {
        // Only from a hub that reports every call (0.2.0 on): an older one never does, and
        // every harness would look quiet -- idle, and away from the rounds -- after one round.
        if (!this.sawCall) return null;
        const s = this.state.get(token);
        return s && s.lastCall ? Math.max(0, Date.now() - s.lastCall) : null;
    }
    // Whether the seat's harness took the last turn sent to it: quiet since, it is thinking
    // over that turn, not gone. Null from a hub that does not say (before 0.3.2).
    tookLastTurn(token) {
        if (!this.sawTook) return null;
        const s = this.state.get(token);
        return !!(s && s.sentAt && s.tookAt >= s.sentAt);
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
        // What the seats' harnesses are doing is the hub's to say: it answers the seat list
        // with every seat whose harness is in or joined. Kept from before, a restarted hub
        // -- which knows no harness yet -- left the dots green (asp67, 27 Oct).
        ws.onopen = () => {
            this.hubUp = true;
            for (const s of this.state.values()) { s.harness = false; s.joined = false; }
            this._sendArena();
            if (this.hubWatch) this._send({ type: 'watch' });
            for (const token of this.pausedSeats) this._send({ type: 'paused', token, paused: true });
            this._changed();
        };
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
        if (m.type === 'client') {
            this.clients.set(String(m.name || ''), { name: String(m.name || ''), version: String(m.version || ''), at: Date.now() });
            this._changed('*');
            return;
        }
        if (m.type === 'check') {
            this.checks.push({ name: String(m.name || ''), at: Date.now() });
            this._changed('*');
            return;
        }
        if (m.type === 'call') {
            this.sawCall = true;
            const s = this.state.get(m.token);
            if (s) s.lastCall = Date.now();
            return;
        }
        if (m.type === 'took') {
            this.sawTook = true;
            const s = this.state.get(m.token);
            if (s) s.tookAt = Date.now();
            return;
        }
        if (m.type === 'harness' || m.type === 'join') {
            const s = this.state.get(m.token) || {};
            s.lastCall = Date.now();
            if (m.type === 'harness') s.harness = true; else { s.harness = true; s.joined = true; if (m.client) s.client = String(m.client); }
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
        if (m.type === 'final_word') {
            const f = this.finals.get(m.token);
            if (f) { this.finals.delete(m.token); f(String(m.text || '')); }
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
    playTurn(token, turn, text, rules, signal, timing) {
        return new Promise((resolve, reject) => {
            const prev = this.turns.get(token);
            if (prev) prev.reject(new Error('superseded by a newer turn'));
            const t = { turn, calls: [], counted: 0, resolve, reject };
            this.turns.set(token, t);
            const st = this.state.get(token) || {};
            st.sentAt = Date.now();   // by time: a seat's turn number can repeat after a missed round
            this.state.set(token, st);
            const first = !this.rulesSent.has(token);
            if (first) this.rulesSent.add(token);
            const body = (first && rules ? 'RULES OF THE GAME (your system prompt; get_rules shows them again):\n\n' + rules + '\n\n---\n\n' : '') + text;
            // timing: { msLeft, roundMs } -- the hub tells the harness how long it has.
            this._send(Object.assign({ type: 'turn', token, turn, state: body, rules: rules || '' }, timing || {}));
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

    // The match is over for the seat: the hub tells its harness to stop, so it is no longer
    // joined, and the next arena waits for it to join again -- here as on the hub.
    // The user paused or resumed the seat: the hub tells its harness so, and refuses what
    // it sends meanwhile instead of queuing it.
    setPaused(token, paused) {
        if (paused) this.pausedSeats.add(token); else this.pausedSeats.delete(token);
        this._send({ type: 'paused', token, paused: !!paused });
    }

    over(token, result) {
        this._send({ type: 'over', token, result: result || {} });
        const s = this.state.get(token);
        if (s && s.joined) { s.joined = false; this._changed(token); }
    }

    // The closing message at the end of a match -- the one a library seat is asked -- and
    // the harness's answer, given with its final_word tool. null if it gives none before
    // the signal (askFinalWord's own time limit) aborts.
    finalWord(token, text, signal) {
        return new Promise(resolve => {
            const prev = this.finals.get(token);
            if (prev) prev(null);
            this.finals.set(token, resolve);
            this.turns.delete(token);
            this._send({ type: 'final', token, text: String(text || '') });
            const s = this.state.get(token);
            if (s && s.joined) { s.joined = false; this._changed(token); }
            if (signal) {
                const stop = () => { if (this.finals.get(token) === resolve) { this.finals.delete(token); resolve(null); } };
                if (signal.aborted) stop(); else signal.addEventListener('abort', stop, { once: true });
            }
        });
    }
}
if (typeof window !== 'undefined') window.WarMcpLink = WarMcpLink;
if (typeof module !== 'undefined' && module.exports) module.exports = WarMcpLink;
