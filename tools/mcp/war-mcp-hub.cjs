#!/usr/bin/env node
// WAR MCP hub (docs/MCP-ARENA.md). One local process that lets any agent harness play a
// WAR seat over MCP, on the harness's own subscription: WAR never sees an API key.
//
//   node war-mcp-hub.cjs                         HTTP on 127.0.0.1:8765
//   node war-mcp-hub.cjs --port 9000             another port (0: any free one)
//   node war-mcp-hub.cjs --stdio --token <seat>  MCP on stdin/stdout for a harness that
//                                                only starts servers itself; forwards to
//                                                the running hub
//
// Harness side:  POST /mcp/<seat-token>   MCP (JSON-RPC 2.0) over Streamable HTTP, plain
//                                         JSON answers, no session id (stateless)
// Page side:     ws://127.0.0.1:8765/page the WAR arena page, which runs and records the
//                                         match; the hub only relays
// Anyone:        GET /status              is the hub up, is a page connected
//
// Dependency-free on purpose: a hand-written MCP server, HTTP from node:http and a minimal
// WebSocket (RFC 6455 text frames). It binds 127.0.0.1 only.
'use strict';
const http = require('http'), crypto = require('crypto'), fs = require('fs'), path = require('path');

const VERSION = '0.1.0';
const PROTOCOLS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const TOKEN_RE = /^[A-Za-z0-9_-]{8,64}$/;

function arg(name, fallback) {
    const i = process.argv.indexOf('--' + name);
    return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}
const PORT = Number(arg('port', process.env.WAR_MCP_PORT || 8765));
// How long wait_for_turn holds a call before answering "still waiting" (b-design: ~25 s,
// under the 30 s tool timeouts harnesses default to).
const WAIT_MS = Number(arg('wait-ms', 25000));
const ACTION_MS = Number(arg('action-ms', 30000));
// Pages allowed to drive seats: WAR's public site and local servers. A web page from any
// other origin could otherwise open /page and pose as the arena (DNS rebinding).
const ALLOWED_ORIGINS = [/^https:\/\/asp67\.github\.io$/, /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/]
    .concat((arg('allow-origin', '') || '').split(',').filter(Boolean).map(o => new RegExp('^' + o.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$')));
// No Origin: a harness (not a browser). A browser always sends one; "null" (a file:// page) is refused.
const originOk = o => !o || ALLOWED_ORIGINS.some(re => re.test(o));

const TOOLS_FILE = path.join(__dirname, 'war-tools.json');
const GAME = JSON.parse(fs.readFileSync(TOOLS_FILE, 'utf8'));
const GAME_NAMES = new Set(GAME.tools.map(t => t.name));

// How to play, the same three steps everywhere they are told (the play prompt, join's
// answer): a harness that joined and then sat "analysing the tools" (asp67, Hermes,
// 26 Oct) had been told what happened, never what to do next. Every answer below ends
// with the next call.
const LOOP = [
    '1. Call wait_for_turn. When it is your turn it returns the game state (your first turn also brings the rules of the game). While it answers "waiting", call it again at once.',
    `2. Give up to ${GAME.maxCommandsPerTurn} game commands with the game tools (train_unit, build_structure, assign_workers, move_units, attack_target, ...). The plan tool is free and does not count.`,
    '3. Call end_turn. Then go back to step 1.'
].join('\n');
const KICKOFF = [
    'You are playing a seat in WAR ("When Agents Rule"), a real-time strategy game, against other players. You decide every move yourself.',
    'First call join. Then play this loop until wait_for_turn reports that the match is over:',
    LOOP,
    'Do not stop to explain or to ask the user anything: keep calling the tools until the match is over.'
].join('\n');
const NEXT_WAIT = 'Your next action: call wait_for_turn now.';

const META_TOOLS = [
    { name: 'join', description: 'Claim your seat in the waiting arena. Call this first. Returns the rules of the game for your seat.',
      inputSchema: { type: 'object', properties: {}, required: [] } },
    { name: 'wait_for_turn', description: 'Wait for your turn. Returns the game state when it is your turn, '
        + '{"waiting": true} if it is not yet (call again), or {"matchOver": true} when the match has ended. '
        + 'Calling it while your turn is open ends that turn.',
      inputSchema: { type: 'object', properties: {}, required: [] } },
    { name: 'end_turn', description: `End your turn. Up to ${GAME.maxCommandsPerTurn} game commands per turn; plan does not count.`,
      inputSchema: { type: 'object', properties: {}, required: [] } },
    { name: 'get_rules', description: 'The rules of the game for your seat again (after you joined).',
      inputSchema: { type: 'object', properties: {}, required: [] } },
    { name: 'final_word', description: 'Only when the match has ended and wait_for_turn handed you its final message: '
        + 'your answer to it, in your own words. Nothing is executed; it is recorded with the match.',
      inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'Your final word on the match.' } }, required: ['text'] } }
];

// What the harnesses do, one line each, in the hub's window (--quiet turns it off): the
// first harness to sit idle after join could only be guessed at.
const QUIET = process.argv.includes('--quiet') || process.argv.includes('--stdio');
function log(token, text) {
    if (QUIET) return;
    const d = new Date(), p = n => String(n).padStart(2, '0');
    const s = seats.get(token);
    console.log(`${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}  ${s && s.seat != null ? 'seat ' + s.seat : String(token).slice(0, 10)}  ${text}`);
}

// ---- state -------------------------------------------------------------------------
// One page at a time (the newest wins). Seats are keyed by token.
// Any number of WAR pages (two tabs, a spectator window): each seat belongs to the page
// that listed it last, and only that page hears about it. With one page allowed, the newest
// replacing the older, two open pages knocked each other off every two seconds as each
// reconnected, and the setup's dot flipped between "ready" and "hub not running" (asp67,
// 26 Oct: the second page was a preview left open in the developer's browser).
const pages = new Set();          // { send(obj), close() }
const seats = new Map();         // token -> seat
function seat(token) {
    let s = seats.get(token);
    if (!s) seats.set(token, s = { token, listed: false, seat: null, name: '', rules: '',
        seen: false, joined: false, pendingTurn: null, turn: null, commands: 0, waiters: [], over: null });
    return s;
}
const pendingActions = new Map();  // id -> { resolve, timer }
let nextId = 1;

// A message about a seat goes to the page that listed it.
function toPage(obj) {
    const s = obj && obj.token ? seats.get(obj.token) : null;
    if (s && s.page && pages.has(s.page)) s.page.send(obj);
}

function fromPage(msg, pg) {
    switch (msg && msg.type) {
        case 'arena': {
            // The seats this page's arena waits for. Seats it listed before and no longer
            // does are released; other pages' seats are not touched. The rules a seat was
            // sent with its turns stay: a page reconnecting mid-match lists no rules.
            const listed = new Set();
            for (const p of msg.seats || []) {
                if (!TOKEN_RE.test(p.token || '')) continue;
                const s = seat(p.token);
                Object.assign(s, { listed: true, page: pg, seat: p.seat, name: p.name || '', rules: p.rules || s.rules || '', over: null });
                listed.add(p.token);
                if (s.seen) toPage({ type: 'harness', token: s.token, connected: true });
                if (s.joined) toPage({ type: 'join', token: s.token });
            }
            for (const s of seats.values()) if (s.page === pg && !listed.has(s.token)) release(s);
            break;
        }
        case 'turn': {
            const s = seats.get(msg.token);
            if (!s || !s.listed) return;
            if (msg.rules) s.rules = msg.rules;   // the seat's system prompt, for get_rules
            s.pendingTurn = { turn: msg.turn, state: typeof msg.state === 'string' ? msg.state : JSON.stringify(msg.state) };
            // Only to a wait still listening: one its harness gave up on is gone already.
            let w;
            while ((w = s.waiters.shift())) if (w.alive()) { w(deliverTurn(s)); break; }
            break;
        }
        case 'turn_over': {           // the page closed the turn (round timeout)
            const s = seats.get(msg.token);
            if (s && s.turn && s.turn.turn === msg.turn) { s.turn = null; s.commands = 0; }
            break;
        }
        case 'result': {
            const p = pendingActions.get(msg.id);
            if (p) { clearTimeout(p.timer); pendingActions.delete(msg.id); p.resolve(String(msg.text == null ? '' : msg.text)); }
            break;
        }
        case 'final': {             // the match has ended for this seat: its closing message
            const s = seats.get(msg.token);
            if (!s) return;
            s.over = s.over || { final: true };
            s.final = String(msg.text || '');
            s.turn = s.pendingTurn = null;
            for (const w of s.waiters.splice(0)) if (w.alive()) w(textResult(JSON.stringify(overResult(s))));
            s.joined = false;
            log(s.token, 'match over: final message sent');
            break;
        }
        case 'over': {
            const s = seats.get(msg.token);
            if (!s) return;
            s.over = Object.assign(msg.result || {}, s.final != null ? { final: true } : {});
            s.turn = s.pendingTurn = null;
            for (const w of s.waiters.splice(0)) if (w.alive()) w(textResult(JSON.stringify(overResult(s))));
            // The harness is told to stop, so it is no longer playing: the next arena waits
            // for it to join again rather than showing the seat ready (asp67, 26 Oct).
            s.joined = false;
            log(s.token, 'match over');
            break;
        }
        case 'close':
            for (const s of seats.values()) if (s.page === pg) release(s);
            break;
    }
}

// The end of the match. With a closing message (the same one a library seat gets: the final
// state, the match in numbers, the question), the harness answers it with final_word.
const overResult = s => s.final
    // Ends with how to answer: Sonnet 5.5 in Claude Code answered the first one in its chat,
    // which the game cannot read (asp67, 27 Oct); OpenCode's DeepSeek used final_word.
    ? { matchOver: true, result: s.over,
        finalMessage: s.final + '\n\nANSWER BY CALLING final_word WITH YOUR TEXT. The game cannot read a reply in the chat.',
        next: 'This is your final message. Answer it by calling final_word with your thoughts; nothing will be executed. Then stop playing.' }
    : { matchOver: true, result: s.over, next: 'The match is over. Stop playing: there is nothing more to do.' };
// A page let go of the seat (closed, reloaded, or a new arena without it). Its harness stays
// joined, still in its wait_for_turn loop: when a page lists the seat again it is ready at once.
function release(s) { s.listed = false; s.page = null; s.turn = s.pendingTurn = null; }
function deliverTurn(s) {
    const t = s.pendingTurn; s.pendingTurn = null;
    s.turn = { turn: t.turn }; s.commands = 0;
    log(s.token, `turn ${t.turn} delivered`);
    return textResult(`IT IS YOUR TURN. Read the state below, give up to ${GAME.maxCommandsPerTurn} game commands with the game tools, then call end_turn.\n\n` + t.state);
}

// ---- MCP ---------------------------------------------------------------------------
const textResult = (text, isError) => ({ content: [{ type: 'text', text: String(text) }], ...(isError ? { isError: true } : {}) });

async function callTool(token, name, args, signal) {
    const s = seat(token);
    if (name === 'get_rules') return s.joined ? textResult(s.rules || '(no rules sent)') : textResult('Call join first.', true);
    if (name === 'join') {
        if (!pages.size) return textResult('No WAR arena is open. Open the arena setup in WAR, pick this seat, and call join again.', true);
        if (!s.listed || !pages.has(s.page)) return textResult('The open arena does not use this seat. Pick it in the WAR arena setup, then call join again.', true);
        s.joined = true;
        toPage({ type: 'join', token });
        return textResult((s.rules ? s.rules + '\n\n' : '')
            + `You have joined as seat ${s.seat != null ? s.seat : '?'}. This is how you play, until the match is over:\n`
            + LOOP + '\nDo not stop to explain or to ask: keep calling the tools. ' + NEXT_WAIT);
    }
    // After the end every call hears it, joined or not: a harness busy when the match
    // ended got "Call join first" for its end_turn and rejoined to find out (asp67, 26 Oct).
    if (name === 'final_word') {
        if (s.final == null) return textResult('There is no final message to answer.' + (s.over ? ' The match is over: stop playing.' : ''));
        toPage({ type: 'final_word', token, text: String((args && args.text) || '') });
        s.final = null;
        log(token, 'final word given');
        return textResult('Thank you: your final word is recorded with the match. The match is over: stop playing.');
    }
    if (s.over && name !== 'join' && name !== 'get_rules') return textResult(JSON.stringify(overResult(s)));
    if (!s.joined) return textResult('Call join first.', true);
    if (name === 'wait_for_turn') {
        if (s.over) return textResult(JSON.stringify(overResult(s)));
        if (s.turn) { toPage({ type: 'end_turn', token, turn: s.turn.turn }); s.turn = null; }
        if (s.pendingTurn) return deliverTurn(s);
        // A harness may give up on the call before the hub answers (its own timeout
        // shorter than WAIT_MS): the wait is dropped then, so no turn is handed to a
        // request nobody reads -- that turn would be lost, and the harness wait forever.
        return new Promise(resolve => {
            const w = r => { clearTimeout(timer); resolve(r); };
            w.alive = () => !(signal && signal.aborted);
            if (signal) signal.addEventListener('abort', () => { clearTimeout(timer); s.waiters = s.waiters.filter(x => x !== w); resolve(null); log(token, 'gave up waiting'); }, { once: true });
            const timer = setTimeout(() => { s.waiters = s.waiters.filter(x => x !== w);
                resolve(textResult(JSON.stringify({ waiting: true, next: s.listed ? 'Not your turn yet. Call wait_for_turn again now.'
                    : 'No WAR arena has this seat open right now (the page was closed or reloaded). Call wait_for_turn again to wait for it.' }))); }, WAIT_MS);
            s.waiters.push(w);
        });
    }
    if (name === 'end_turn') {
        if (!s.turn) return textResult('It is not your turn. ' + NEXT_WAIT, true);
        toPage({ type: 'end_turn', token, turn: s.turn.turn });
        s.turn = null;
        return textResult('Turn ended. ' + NEXT_WAIT);
    }
    if (!GAME_NAMES.has(name)) return textResult(`Unknown tool "${name}".`, true);
    if (!s.turn) return textResult('It is not your turn. ' + NEXT_WAIT, true);
    const counts = !GAME.free.includes(name);
    if (counts && s.commands >= GAME.maxCommandsPerTurn)
        return textResult(`[ERROR] You have given ${GAME.maxCommandsPerTurn} commands this turn. Your next action: call end_turn.`, true);
    if (counts) s.commands++;
    const id = nextId++;
    const text = await new Promise(resolve => {
        const timer = setTimeout(() => { pendingActions.delete(id); resolve('[ERROR] The arena did not answer in time.'); }, ACTION_MS);
        pendingActions.set(id, { resolve, timer });
        toPage({ type: 'action', id, token, turn: s.turn.turn, name, args: args || {} });
    });
    return textResult(text, /^\[ERROR\]/.test(text));
}

async function rpc(token, msg, signal) {
    const { id, method, params } = msg || {};
    if (msg && method === 'tools/call') log(token, 'calls ' + (params && params.name) + (params && params.arguments && Object.keys(params.arguments).length ? ' ' + JSON.stringify(params.arguments).slice(0, 120) : ''));
    else if (msg && method && method !== 'ping') log(token, method + (method === 'initialize' && params && params.clientInfo ? ' from ' + params.clientInfo.name : ''));
    const reply = result => ({ jsonrpc: '2.0', id, result });
    const fail = (code, message) => ({ jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message } });
    if (!msg || msg.jsonrpc !== '2.0' || typeof method !== 'string') return fail(-32600, 'Invalid Request');
    if (id === undefined) return null;   // a notification: nothing to answer
    const s = seat(token);
    if (!s.seen) { s.seen = true; if (s.listed) toPage({ type: 'harness', token, connected: true }); }
    switch (method) {
        case 'initialize': {
            const asked = params && params.protocolVersion;
            return reply({ protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
                capabilities: { tools: {}, prompts: {} }, serverInfo: { name: 'war-mcp-hub', version: VERSION }, instructions: KICKOFF });
        }
        case 'server/discover':
            return reply({ capabilities: { tools: {}, prompts: {} }, serverInfo: { name: 'war-mcp-hub', version: VERSION }, instructions: KICKOFF });
        case 'ping': return reply({});
        case 'tools/list': return reply({ tools: META_TOOLS.concat(GAME.tools) });
        case 'tools/call': {
            if (!params || typeof params.name !== 'string') return fail(-32602, 'Invalid params: name');
            return reply(await callTool(token, params.name, params.arguments, signal));
        }
        case 'prompts/list': return reply({ prompts: [{ name: 'play', description: 'Join this WAR seat and play the match to its end.' }] });
        case 'prompts/get':
            if (!params || params.name !== 'play') return fail(-32602, 'Unknown prompt');
            return reply({ description: 'Play this WAR seat', messages: [{ role: 'user', content: { type: 'text', text: KICKOFF } }] });
        default: return fail(-32601, 'Method not found: ' + method);
    }
}

// ---- HTTP --------------------------------------------------------------------------
function cors(req, res) {
    const o = req.headers.origin;
    if (o && originOk(o)) {
        res.setHeader('Access-Control-Allow-Origin', o);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Private-Network', 'true');
        res.setHeader('Access-Control-Allow-Headers', 'content-type, mcp-protocol-version, accept');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    }
}
function json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); }

const server = http.createServer((req, res) => {
    cors(req, res);
    if (req.headers.origin && !originOk(req.headers.origin)) return json(res, 403, { error: 'origin not allowed' });
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/status' && req.method === 'GET')
        return json(res, 200, { hub: 'war-mcp-hub', version: VERSION, page: pages.size > 0, pages: pages.size,
            seats: [...seats.values()].filter(s => s.listed).map(s => ({ seat: s.seat, harness: s.seen, joined: s.joined })) });
    const m = /^\/mcp\/([^/]+)\/?$/.exec(url.pathname);
    if (!m) return json(res, 404, { error: 'not found' });
    const token = m[1];
    if (!TOKEN_RE.test(token)) return json(res, 404, { error: 'unknown seat address' });
    if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }); return res.end(); }
    let body = '';
    const gone = new AbortController();
    res.on('close', () => { if (!res.writableFinished) gone.abort(); });
    req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', async () => {
        let msg;
        try { msg = JSON.parse(body); } catch (e) { return json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
        try {
            if (Array.isArray(msg)) {
                const out = (await Promise.all(msg.map(x => rpc(token, x, gone.signal)))).filter(Boolean);
                if (!out.length) { res.writeHead(202); return res.end(); }
                return json(res, 200, out);
            }
            const out = await rpc(token, msg, gone.signal);
            if (!out) { res.writeHead(202); return res.end(); }
            json(res, 200, out);
        } catch (e) {
            json(res, 500, { jsonrpc: '2.0', id: msg && msg.id, error: { code: -32603, message: String(e && e.message || e) } });
        }
    });
});

// ---- WebSocket for the page (RFC 6455, text frames only) ---------------------------
server.on('upgrade', (req, socket) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname !== '/page' || !originOk(req.headers.origin) || !req.headers['sec-websocket-key']) {
        socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return;
    }
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    const send = obj => {
        const data = Buffer.from(JSON.stringify(obj));
        const head = data.length < 126 ? Buffer.from([0x81, data.length])
            : data.length < 65536 ? Buffer.from([0x81, 126, data.length >> 8, data.length & 255])
            : (() => { const b = Buffer.alloc(10); b[0] = 0x81; b[1] = 127; b.writeBigUInt64BE(BigInt(data.length), 2); return b; })();
        if (!socket.destroyed) socket.write(Buffer.concat([head, data]));
    };
    const me = { send, close: () => socket.destroy() };
    if (!QUIET) console.log('WAR page connected');
    pages.add(me);
    send({ type: 'hello', hub: 'war-mcp-hub', version: VERSION, maxCommandsPerTurn: GAME.maxCommandsPerTurn });
    let buf = Buffer.alloc(0), parts = [];
    socket.on('data', chunk => {
        buf = Buffer.concat([buf, chunk]);
        for (;;) {
            if (buf.length < 2) return;
            const fin = buf[0] & 0x80, op = buf[0] & 0x0f, masked = buf[1] & 0x80;
            let len = buf[1] & 0x7f, off = 2;
            if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
            else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
            const mask = masked ? buf.slice(off, off + 4) : null; if (masked) off += 4;
            if (buf.length < off + len) return;
            let payload = buf.slice(off, off + len);
            if (mask) { payload = Buffer.from(payload); for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3]; }
            buf = buf.slice(off + len);
            if (op === 0x8) { socket.end(); return; }
            if (op === 0x9) { socket.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload])); continue; }
            if (op === 0x1 || op === 0x0) {
                parts.push(payload);
                if (fin) { const text = Buffer.concat(parts).toString('utf8'); parts = []; try { fromPage(JSON.parse(text), me); } catch (e) { /* ignore a bad frame */ } }
            }
        }
    });
    socket.on('close', () => { if (pages.delete(me)) { fromPage({ type: 'close' }, me); if (!QUIET) console.log('WAR page disconnected'); } });
    socket.on('error', () => {});
});

// ---- stdio fallback ----------------------------------------------------------------
function stdioMode(token) {
    if (!TOKEN_RE.test(token || '')) { console.error('war-mcp-hub --stdio needs --token <seat-token>'); process.exit(2); }
    let buf = '';
    const post = line => new Promise(resolve => {
        const req = http.request({ host: '127.0.0.1', port: PORT, path: '/mcp/' + token, method: 'POST', headers: { 'Content-Type': 'application/json' } }, res => {
            let out = ''; res.on('data', c => out += c); res.on('end', () => resolve(out));
        });
        req.on('error', e => resolve(JSON.stringify({ jsonrpc: '2.0', id: (() => { try { return JSON.parse(line).id; } catch (x) { return null; } })(),
            error: { code: -32603, message: 'The WAR MCP hub is not running on port ' + PORT + ': start it with node war-mcp-hub.cjs' } })));
        req.end(line);
    });
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', async chunk => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
            if (!line) continue;
            const out = await post(line);
            if (out) process.stdout.write(out.trim() + '\n');
        }
    });
}

if (require.main === module) {
    if (process.argv.includes('--stdio')) stdioMode(arg('token'));
    else server.listen(PORT, '127.0.0.1', () => {
        const port = server.address().port;
        console.log(`WAR MCP hub ${VERSION} on http://127.0.0.1:${port}`);
        console.log(`  seat addresses: http://127.0.0.1:${port}/mcp/<seat-token>   (from the WAR model library)`);
        console.log('  leave this window open while you play; Ctrl+C stops the hub');
    });
}
module.exports = { server, KICKOFF, VERSION };
