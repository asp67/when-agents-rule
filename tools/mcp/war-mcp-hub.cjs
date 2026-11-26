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

// 0.2.0: check_connection, and a page may watch the hub (the setup assistant).
// 0.3.0: the shared address /mcp -- one per computer, the seat chosen by join's code.
// 0.3.1: a seat the user paused hears so, and nothing it sends is queued.
// 0.3.2: the page hears when a turn is handed to the harness ("took").
// 0.3.3: multi-match Arena Series continuity (seriesContinues / series_next keeps seats joined across matches).
// 0.3.4: emit roundOver + matchOver:false between series matches so non-/goal harnesses never stop early.
// 0.3.5: a second page listing the same seats no longer takes them from the page playing them,
//        a page that lets go hands its seats to another page still listing them, and a turn
//        from a page lists its seat again. Harnesses hear when their page went away.
// 0.3.6: join and get_rules say when the rules come: with the seat's first turn. Both said
//        they return them, and before that turn the hub has none to return.
const VERSION = '0.3.6';
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
    'First call join, with your seat code if the message that told you to play gave one. Then play this loop until wait_for_turn reports that the match is over:',
    LOOP,
    'Do not stop to explain or to ask the user anything: keep calling the tools until the match is over.'
].join('\n');
const NEXT_WAIT = 'Your next action: call wait_for_turn now.';

const META_TOOLS = [
    { name: 'join', description: 'Claim your seat in the waiting arena. Call this first, with your seat code: it is in the message that told you to play. '
        + 'Returns how to play your turns. The rules of the game for your seat come with your first turn.',
      inputSchema: { type: 'object', properties: { code: { type: 'string',
          description: 'Your seat code, as the message that told you to play gave it (it starts with "seat-").' } }, required: [] } },
    { name: 'wait_for_turn', description: 'Wait for your turn. Returns the game state when it is your turn, '
        + '{"waiting": true} if it is not yet (call again), '
        + '{"roundOver": true, "matchOver": false, "seriesContinues": true} between matches of a multi-match series '
        + '(DO NOT STOP — call final_word if asked, then immediately call wait_for_turn for the next match), '
        + 'or {"matchOver": true} ONLY when the entire match or series has ended. '
        + 'Calling it while your turn is open ends that turn.',
      inputSchema: { type: 'object', properties: {}, required: [] } },
    { name: 'end_turn', description: `End your turn. Up to ${GAME.maxCommandsPerTurn} game commands per turn; plan does not count.`,
      inputSchema: { type: 'object', properties: {}, required: [] } },
    { name: 'get_rules', description: 'The rules of the game for your seat again. They first arrive with your first turn; before it there are none to return.',
      inputSchema: { type: 'object', properties: {}, required: [] } },
    { name: 'final_word', description: 'Only when the match has ended and wait_for_turn handed you its final message: '
        + 'your answer to it, in your own words. Nothing is executed; it is recorded with the match.',
      inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'Your final word on the match.' } }, required: ['text'] } },
    // The setup assistant's test (asp67, 27 Oct): a call that proves the harness reaches the
    // hub and may use its tools, and starts nothing -- join would set a harness polling for
    // turns, spending tokens until a match begins.
    { name: 'check_connection', description: 'Only for setting up: confirms that this harness reaches WAR and may use its tools. '
        + 'It is not a game command: it does nothing in a match.',
      inputSchema: { type: 'object', properties: {}, required: [] } }
];

// What the harnesses do, one line each, in the hub's window (--quiet turns it off): the
// first harness to sit idle after join could only be guessed at.
const QUIET = process.argv.includes('--quiet') || process.argv.includes('--stdio');
function log(token, text) {
    if (QUIET) return;
    const d = new Date(), p = n => String(n).padStart(2, '0');
    const s = seats.get(token);
    console.log(`${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}  ${s && s.seat != null ? 'seat ' + s.seat : String(token).startsWith('seat-') ? String(token).slice(0, 10) : String(token)}  ${text}`);
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
        seen: false, joined: false, pendingTurn: null, turn: null, commands: 0, waiters: [], over: null,
        listers: new Set(), player: null, lost: null });
    return s;
}
// Who holds a seat (0.3.5). `listers` are the pages whose arena lists the seat; `player` the
// page that sent its last turn -- the one running the match; `page` the one that hears about
// it: the player while it is connected, else the newest lister. asp67, 25 Nov 2026: a match
// ran in one tab, the same page opened in a second tab drew its arena setup -- the same saved
// seats -- and the hub gave both seats to it; that tab's reload released them, and the hub
// dropped every turn the first tab sent after. Both harnesses polled "no arena has this seat"
// to the end of the match.
const live = pg => !!pg && pages.has(pg);
// A page no longer lists the seat (it closed, reloaded, or its arena dropped it). The seat
// stays with the page playing it, or goes to another page still listing it; only with none
// left is it released.
function letGo(s, pg) {
    s.listers.delete(pg);
    const wasPlayer = s.player === pg;
    if (wasPlayer) s.player = null;
    if (s.page !== pg && !wasPlayer) return;
    const next = live(s.player) ? s.player : [...s.listers].filter(live).pop();
    if (wasPlayer) {                  // the match it was playing is gone with it
        if (s.turn || s.pendingTurn) s.lost = { at: Date.now() };
        s.turn = s.pendingTurn = null; s.closed = null;
    }
    if (next) { s.page = next; log(s.token, 'its page let go; another page that lists it has it now'); }
    else { if (s.turn || s.pendingTurn) s.lost = { at: Date.now() }; release(s); log(s.token, 'released: no WAR page lists it any more'); }
}
const pendingActions = new Map();  // id -> { resolve, timer }
let nextId = 1;

// A message about a seat goes to the page that listed it.
function toPage(obj) {
    const s = obj && obj.token ? seats.get(obj.token) : null;
    if (s && s.page && pages.has(s.page)) s.page.send(obj);
}
// What the setup assistant follows on a page that watches the hub: which harnesses got in
// touch (by the name each sends when it connects) and which passed check_connection. Never
// turns or actions: those belong to the page playing a seat, and a watcher answering one
// would race it.
const watchers = new Set();
const clients = new Map();        // harness name -> { name, version, at }
function tellWatchers(obj) { for (const pg of watchers) if (pages.has(pg)) pg.send(obj); }
function noteClient(info) {
    const name = String((info && info.name) || '').slice(0, 80);
    if (!name) return;
    const c = { name, version: String((info && info.version) || '').slice(0, 40), at: Date.now() };
    clients.set(name, c);
    tellWatchers(Object.assign({ type: 'client' }, c));
}

// ---- the shared address (asp67, 27 Oct) ----------------------------------------------
// One address per computer, http://127.0.0.1:8765/mcp, set up once in each harness. The seat
// is chosen by the code in the start message (join with code), and the harness's MCP session
// (Mcp-Session-Id) carries it from then on: deleting or adding a library entry no longer
// means another server in every harness. A seat's own address (/mcp/<code>) still works, for
// a harness that keeps no session and for the setups made before.
const sessions = new Map();       // session id -> { id, client, version, token, last }
const SESSION_MAX = 200;
function sessionFor(id) {
    if (!id) return null;
    let x = sessions.get(id);
    // An id the hub does not know (it was restarted) is adopted rather than refused: the
    // harness then hears "join with your seat code" and the code is still in its chat.
    if (!x) {
        x = { id, client: '', version: '', token: null, last: 0 };
        sessions.set(id, x);
        if (sessions.size > SESSION_MAX) {
            const oldest = [...sessions.values()].sort((a, b) => a.last - b.last)[0];
            if (oldest && oldest !== x) sessions.delete(oldest.id);
        }
    }
    x.last = Date.now();
    return x;
}
const joinWithCode = 'call join with your seat code: it is in the message that told you to play (it starts with "seat-").';
// A seat the user paused in the arena (asp67, 28 Oct): told, not left polling "not your turn
// yet" with no idea why, and nothing it sends is queued as if it would run.
const PAUSED = 'Your seat is paused by the user: the match goes on without you, and nothing you send now runs. '
    + 'Call wait_for_turn: it hands you the next turn once you are resumed.';

function fromPage(msg, pg) {
    switch (msg && msg.type) {
        case 'arena': {
            // The seats this page's arena waits for. Seats it listed before and no longer
            // does are released; other pages' seats are not touched. The rules a seat was
            // sent with its turns stay: a page reconnecting mid-match lists no rules.
            const listed = new Set();
            for (const p of msg.seats || []) {
                if (!TOKEN_RE.test(p.token || '')) { log(String(p.token || '?').slice(0, 20), 'not listed: not a seat code'); continue; }
                const s = seat(p.token);
                listed.add(p.token);
                s.listers.add(pg);
                // Another page is playing this seat: this one (a second tab, a preview) waits
                // behind it, and takes it only once that page lets go (0.3.5).
                if (live(s.player) && s.player !== pg) { log(s.token, 'listed by another page too; the page playing it keeps it'); continue; }
                Object.assign(s, { listed: true, page: pg, seat: p.seat, name: p.name || '', rules: p.rules || s.rules || '',
                    seriesTotal: p.seriesTotal > 1 ? p.seriesTotal : (s.seriesTotal || 1), over: null });
                if (s.seen) toPage({ type: 'harness', token: s.token, connected: true });
                if (s.joined) toPage({ type: 'join', token: s.token });
            }
            for (const s of seats.values()) if (s.listers.has(pg) && !listed.has(s.token)) letGo(s, pg);
            break;
        }
        case 'turn': {
            const s = seats.get(msg.token);
            if (!s) return;
            // A page sending a seat its turn is playing it: a seat released meanwhile (its
            // listing lost to another page's reload) is listed again, not its turns thrown
            // away for the rest of the match (0.3.5).
            if (!s.listed) { s.listed = true; log(s.token, 'listed again by the page sending its turn'); }
            s.listers.add(pg);
            // The page playing the seat owns it, whoever listed it last: a second WAR page
            // listing the same seats (an older tab, another setup) took them over, so the
            // harness's commands went to a page without the turn and its end_turn to nobody
            // -- every round missed (asp67, 27 Oct, ChatGPT and OpenCode "keep timing out").
            s.page = pg; s.player = pg;
            if (msg.rules) s.rules = msg.rules;   // the seat's system prompt, for get_rules
            // msLeft/roundMs: how much of the round is left as the page sends the turn. Kept
            // against the hub's own clock (`at`), so the time told is what is left on delivery
            // -- a turn waiting here while its harness sleeps is running out all the same.
            s.pendingTurn = { turn: msg.turn, state: typeof msg.state === 'string' ? msg.state : JSON.stringify(msg.state),
                msLeft: Number.isFinite(msg.msLeft) ? msg.msLeft : null, roundMs: Number.isFinite(msg.roundMs) ? msg.roundMs : null, at: Date.now() };
            // Only to a wait still listening: one its harness gave up on is gone already.
            let w;
            while ((w = s.waiters.shift())) if (w.alive()) { w(deliverTurn(s)); break; }
            break;
        }
        case 'paused': {              // the user paused or resumed the seat in the arena
            const s = seats.get(msg.token);
            if (!s) return;
            s.paused = !!msg.paused;
            if (!s.paused) s.closed = null;   // a turn closed by the pause is no "too late"
            log(s.token, s.paused ? 'paused by the user' : 'resumed by the user');
            break;
        }
        case 'turn_over': {           // the page closed the turn (round timeout)
            const s = seats.get(msg.token);
            if (!s) return;
            // Remembered, so commands arriving after it hear that they came too late rather
            // than a bare "not your turn" (asp67, 27 Oct: Hermes took 167 s of a 120 s round).
            if (s.turn && s.turn.turn === msg.turn) { s.closed = { turn: msg.turn, deliveredAt: s.turn.deliveredAt, roundMs: s.turn.roundMs, at: Date.now() }; s.turn = null; s.commands = 0; }
            // A turn never picked up is over too: handing it out later gives the harness a
            // state whose round has closed, and every command it sends is refused.
            if (s.pendingTurn && s.pendingTurn.turn === msg.turn) s.pendingTurn = null;
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
            s.seriesContinues = !!msg.seriesContinues;
            s.series = msg.series || null;
            s.turn = s.pendingTurn = null;
            for (const w of s.waiters.splice(0)) if (w.alive()) w(textResult(JSON.stringify(overResult(s))));
            if (!s.seriesContinues) s.joined = false;
            log(s.token, s.seriesContinues ? 'series round over: final message sent (continuing)' : 'match over: final message sent');
            break;
        }
        case 'over': {
            const s = seats.get(msg.token);
            if (!s) return;
            s.over = Object.assign(msg.result || {}, s.final != null ? { final: true } : {});
            s.seriesContinues = !!msg.seriesContinues;
            s.series = msg.series || null;
            s.turn = s.pendingTurn = null;
            const payload = overResult(s);
            let delivered = false;
            for (const w of s.waiters.splice(0)) if (w.alive()) { w(textResult(JSON.stringify(payload))); delivered = true; }
            if (s.seriesContinues) {
                // Keep joined for the next match in the series; once delivered without a pending final_word,
                // clear s.over so the harness's next wait_for_turn enters the wait queue for the next match.
                if (delivered && s.final == null) { s.over = null; s.seriesContinues = false; }
                log(s.token, 'series round over (staying joined for next match)');
            } else {
                // The harness is told to stop, so it is no longer playing: the next arena waits
                // for it to join again rather than showing the seat ready (asp67, 26 Oct).
                s.joined = false;
                log(s.token, 'match over');
            }
            break;
        }
        case 'series_next': {       // next match in an active Arena Series is starting
            const s = seats.get(msg.token);
            if (!s) return;
            s.over = null;
            s.final = null;
            s.seriesContinues = false;
            s.series = msg.series || null;
            s.turn = null;
            s.pendingTurn = null;
            s.commands = 0;
            s.closed = null;
            s.rules = '';
            if (msg.seat != null) s.seat = msg.seat;
            s.joined = true;
            log(s.token, `series next match${msg.series ? ` (${msg.series.round}/${msg.series.total})` : ''}, seat ${s.seat != null ? s.seat : '?'}`);
            break;
        }
        case 'watch':                  // the setup assistant follows the hub
            watchers.add(pg);
            for (const c of clients.values()) pg.send(Object.assign({ type: 'client' }, c));
            break;
        case 'unwatch':
            watchers.delete(pg);
            break;
        case 'close':
            for (const s of seats.values()) if (s.listers.has(pg) || s.page === pg || s.player === pg) letGo(s, pg);
            watchers.delete(pg);
            break;
    }
}

// The end of a match (or one round of a multi-match Arena Series).
// CRITICAL: When `s.seriesContinues` is true, emit `roundOver: true, matchOver: false`
// (NEVER `matchOver: true`!) so harnesses without /goal (like OpenCode, Codex, ChatGPT)
// do not terminate their loop between series rounds.
const overResult = s => {
    const ser = s.seriesContinues && s.series ? s.series : null;
    const tag = ser ? `Match ${ser.round}/${ser.total} ended; Match ${ser.nextRound || (ser.round + 1)}/${ser.total} starts next (rotated seat & civilization).` : 'This match ended; the next match in the series starts next.';
    if (s.final) {
        return {
            ...(s.seriesContinues ? { roundOver: true, matchOver: false, seriesContinues: true, series: s.series || null } : { matchOver: true }),
            result: s.over,
            finalMessage: s.final + '\n\nANSWER BY CALLING final_word WITH YOUR TEXT. The game cannot read a reply in the chat.',
            next: s.seriesContinues
                ? `${tag} Answer this closing message by calling final_word, then DO NOT STOP — immediately call wait_for_turn for the next match.`
                : 'This is your final message. Answer it by calling final_word with your thoughts; nothing will be executed. Then stop playing.'
        };
    }
    return {
        ...(s.seriesContinues ? { roundOver: true, matchOver: false, seriesContinues: true, series: s.series || null } : { matchOver: true }),
        result: s.over,
        next: s.seriesContinues
            ? `${tag} DO NOT STOP — call wait_for_turn now to play the next match.`
            : 'The match is over. Stop playing: there is nothing more to do.'
    };
};
// A page let go of the seat (closed, reloaded, or a new arena without it). Its harness stays
// joined, still in its wait_for_turn loop: when a page lists the seat again it is ready at once.
function release(s) { s.listed = false; s.page = null; s.turn = s.pendingTurn = null; }
function deliverTurn(s) {
    const t = s.pendingTurn; s.pendingTurn = null;
    s.turn = { turn: t.turn, deliveredAt: Date.now(), roundMs: t.roundMs }; s.commands = 0; s.closed = null; s.lost = null;
    const left = t.msLeft != null ? Math.max(0, Math.round((t.msLeft - (Date.now() - t.at)) / 1000)) : null;
    log(s.token, `turn ${t.turn} delivered` + (left != null ? `, ${left} s left` : ''));
    // The page tells a harness that is thinking over its turn from one that has stopped:
    // both are quiet, but only this one took the turn.
    toPage({ type: 'took', token: s.token, turn: t.turn });
    // The time left, as a fact: a harness that does not know the round is closing thinks
    // for three minutes of a two-minute round and loses the turn without knowing why.
    const time = left != null
        ? ` About ${left} s of this round are left${t.roundMs ? ` (a round is ${Math.round(t.roundMs / 1000)} s)` : ''}: commands that arrive after it closes are not run.`
        : '';
    return textResult(`IT IS YOUR TURN.${time} Read the state below, give up to ${GAME.maxCommandsPerTurn} game commands with the game tools, then call end_turn.\n\n` + t.state);
}
// A command or end_turn with no turn open. Not an error result: nothing broke, the turn is
// simply over -- and three error results in a row made Hermes pause the server for a
// minute, so it missed the next turn too (asp67, 27 Oct).
function noTurn(s) {
    // The page holding the seat went away mid-turn (0.3.5): said as what it was, not as the
    // harness speaking out of turn.
    if (s.lost || !s.listed) return textResult('Your turn was lost: the WAR page that had your seat was closed or reloaded, so this was not run. '
        + (s.listed ? NEXT_WAIT : 'Call wait_for_turn: it hands you the next turn as soon as a WAR page has your seat again.'));
    const c = s.closed;
    if (c) {
        const after = c.deliveredAt ? Math.round((Date.now() - c.deliveredAt) / 1000) : null;
        return textResult(`Too late: your turn closed before this arrived, because the round ran out`
            + (c.roundMs ? ` (a round is ${Math.round(c.roundMs / 1000)} s` + (after != null ? `; this came ${after} s after the turn was handed to you)` : ')') : '')
            + '. It was not run. ' + (s.pendingTurn ? 'Your next turn is waiting: call wait_for_turn now, and answer within the round.' : NEXT_WAIT));
    }
    return textResult('It is not your turn. ' + NEXT_WAIT);
}

// ---- MCP ---------------------------------------------------------------------------
const textResult = (text, isError) => ({ content: [{ type: 'text', text: String(text) }], ...(isError ? { isError: true } : {}) });

async function callTool(token, name, args, signal, ctx) {
    const s = seat(token);
    if (name === 'get_rules') return s.joined ? textResult(s.rules || 'No rules yet: they arrive with your first turn. Call wait_for_turn.') : textResult('Call join first.', true);
    if (name === 'join') {
        if (!pages.size) return textResult('No WAR arena is open. Open the arena setup in WAR, pick this seat, and call join again.', true);
        // Names the address called: Antigravity, its config edited to a new address, went on
        // calling the old one until restarted, and told the user its config's address was
        // refused (asp67, 27 Oct). The harness can now say what went wrong.
        if ((!s.listed || !pages.has(s.page)) && ctx && ctx.shared) return textResult(`The open arena has no seat with the code ${token}. `
            + 'Check the code in the message that told you to play: the user copies that message from the seat\'s row in the WAR arena setup ("Copy start chat message"). '
            + 'If the arena was set up anew since, the user sends you the new message. Then call join again with its code.', true);
        if (!s.listed || !pages.has(s.page)) return textResult(`The open arena does not use this seat address. You called ${hubBase()}/mcp/${token}, `
            + 'and the WAR arena setup lists a different address for its seat, or none. Tell the user which address you called. '
            + 'If the seat\'s address was changed in your MCP settings, you are still connected with the old one: the harness must reload or restart to use the new one. '
            + 'Otherwise the user picks this seat in the WAR arena setup. Then call join again.', true);
        s.joined = true;
        toPage({ type: 'join', token, client: s.client || '' });
        const seriesNote = s.seriesTotal > 1
            ? ` for a ${s.seriesTotal}-match series. Play ALL ${s.seriesTotal} matches without stopping: between matches wait_for_turn returns roundOver (with matchOver: false, seriesContinues: true) — call final_word if asked, then immediately call wait_for_turn for the next match. Stop ONLY when wait_for_turn returns matchOver: true.\n`
            : `. This is how you play, until the match is over:\n`;
        return textResult((s.rules ? s.rules + '\n\n' : '')
            + `You have joined as seat ${s.seat != null ? s.seat : '?'}${seriesNote}`
            + LOOP + '\nDo not stop to explain or to ask: keep calling the tools. ' + NEXT_WAIT);
    }
    // After the end every call hears it, joined or not: a harness busy when the match
    // ended got "Call join first" for its end_turn and rejoined to find out (asp67, 26 Oct).
    // Answered in every state, and in a match it says plainly what it is not: a model that
    // tries it mid-game must not take it for a command or think it lost a turn (asp67).
    if (name === 'check_connection') {
        s.checked = true;
        tellWatchers({ type: 'check', name: s.client || '' });
        log(token, 'connection checked');
        const what = 'check_connection only confirms the connection while setting up: it is not a game command, changed nothing'
            + (s.turn ? ' and did not use one of your commands' : '') + '.';
        if (s.over) return textResult(`Connected. ${what} The match is over: stop playing.`);
        if (s.turn) return textResult(`Connected. ${what} It is still your turn: give your game commands, then call end_turn.`);
        if (s.joined && !s.listed) return textResult(`Connected, but no WAR page has your seat right now (the page was closed or reloaded). ${what} Call wait_for_turn: it hands you the next turn as soon as a page has your seat again.`);
        if (s.joined) return textResult(`Connected. ${what} ${NEXT_WAIT}`);
        return textResult('Connected: WAR reaches this harness, and its tools work. Nothing more to do now: stop here. '
            + 'When the user starts a match, they will send you the message to play; until then, call no other WAR tool.');
    }
    if (name === 'final_word') {
        if (s.final == null) return textResult('There is no final message to answer.' + (s.over ? (s.seriesContinues ? ' Call wait_for_turn for the next match.' : ' The match is over: stop playing.') : ''));
        toPage({ type: 'final_word', token, text: String((args && args.text) || '') });
        s.final = null;
        log(token, 'final word given');
        if (s.seriesContinues) {
            const ser = s.series;
            s.over = null;
            s.seriesContinues = false;
            const nextLabel = ser ? `Match ${ser.nextRound || (ser.round + 1)}/${ser.total}` : 'the next match';
            return textResult(`Thank you: your final word is recorded. ${nextLabel} of the series starts next — DO NOT STOP. ${NEXT_WAIT}`);
        }
        return textResult('Thank you: your final word is recorded with the match. The match is over: stop playing.');
    }
    if (s.over && name !== 'join' && name !== 'get_rules') {
        const res = overResult(s);
        if (s.seriesContinues && !s.final && name === 'wait_for_turn') {
            s.over = null;
            s.seriesContinues = false;
        }
        return textResult(JSON.stringify(res));
    }
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
                resolve(textResult(JSON.stringify(s.paused ? { waiting: true, paused: true, next: PAUSED }
                    : { waiting: true, next: s.listed ? 'Not your turn yet. Call wait_for_turn again now.'
                    : 'No WAR arena has this seat open right now (the page was closed or reloaded). Call wait_for_turn again to wait for it.' }))); }, WAIT_MS);
            s.waiters.push(w);
        });
    }
    if (name === 'end_turn') {
        if (s.paused) return textResult(PAUSED);
        if (!s.turn) return noTurn(s);
        toPage({ type: 'end_turn', token, turn: s.turn.turn });
        s.turn = null;
        return textResult('Turn ended. ' + NEXT_WAIT);
    }
    if (!GAME_NAMES.has(name)) return textResult(`Unknown tool "${name}".`, true);
    if (s.paused) return textResult(PAUSED);
    if (!s.turn) return noTurn(s);
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

// ctx: { token } for a seat's own address; { shared, session } for the shared one, whose
// seat is the one its session joined (none before join).
async function rpc(ctx, msg, signal) {
    const { id, method, params } = msg || {};
    const x = ctx.session || null;
    if (x && method === 'initialize' && params && params.clientInfo) { x.client = String(params.clientInfo.name || '').slice(0, 80); x.version = String(params.clientInfo.version || '').slice(0, 40); }
    const token = ctx.token || (x && x.token) || null;
    const label = token || (ctx.shared ? 'war' + (x && x.client ? ' (' + x.client + ')' : '') : '?');
    if (msg && method === 'tools/call') log(label, 'calls ' + (params && params.name) + (params && params.arguments && Object.keys(params.arguments).length ? ' ' + JSON.stringify(params.arguments).slice(0, 120) : ''));
    else if (msg && method && method !== 'ping') log(label, method + (method === 'initialize' && params && params.clientInfo ? ' from ' + params.clientInfo.name : ''));
    const reply = result => ({ jsonrpc: '2.0', id, result });
    const fail = (code, message) => ({ jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message } });
    if (!msg || msg.jsonrpc !== '2.0' || typeof method !== 'string') return fail(-32600, 'Invalid Request');
    if (id === undefined) return null;   // a notification: nothing to answer
    if (method === 'initialize') noteClient(params && params.clientInfo);
    if (token) {
        const s = seat(token);
        if (method === 'initialize' && params && params.clientInfo) s.client = String(params.clientInfo.name || '').slice(0, 80);
        else if (x && x.client) s.client = x.client;
        if (!s.seen) { s.seen = true; toPage({ type: 'harness', token, connected: true }); }
        // Every call tells the page the harness is still at it: a seat whose harness has gone
        // quiet for longer than a round is marked "harness idle" in the arena.
        toPage({ type: 'call', token });
    }
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
            if (ctx.shared && (params.name === 'join' || !token)) return reply(await sharedCall(ctx, params.name, params.arguments, signal));
            return reply(await callTool(token, params.name, params.arguments, signal, ctx));
        }
        case 'prompts/list': return reply({ prompts: [{ name: 'play', description: 'Join this WAR seat and play the match to its end.' }] });
        case 'prompts/get':
            if (!params || params.name !== 'play') return fail(-32602, 'Unknown prompt');
            return reply({ description: 'Play this WAR seat', messages: [{ role: 'user', content: { type: 'text', text: KICKOFF } }] });
        default: return fail(-32601, 'Method not found: ' + method);
    }
}

// A call on the shared address that has no seat yet, and every join there: join with a code
// ties the session to that seat (taking it over from an older session, e.g. the harness
// restarted); check_connection answers without one; anything else asks for the code.
async function sharedCall(ctx, name, args, signal) {
    const x = ctx.session;
    const code = args && typeof args.code === 'string' ? args.code.trim() : '';
    if (name === 'check_connection' && !(x && x.token)) {
        tellWatchers({ type: 'check', name: (x && x.client) || '' });
        log('war' + (x && x.client ? ' (' + x.client + ')' : ''), 'connection checked');
        return textResult('Connected: WAR reaches this harness, and its tools work. Nothing more to do now: stop here. '
            + 'When the user starts a match, they will send you the message to play; until then, call no other WAR tool.');
    }
    if (name !== 'join') return textResult('You have not joined a seat yet: ' + joinWithCode);
    if (!x) return textResult('WAR cannot tell this harness\'s calls apart: it sends no MCP session id (Mcp-Session-Id). '
        + `Use the seat's own address instead of the shared one: ${hubBase()}/mcp/${TOKEN_RE.test(code) ? code : '<seat code>'}. Tell the user so.`, true);
    if (!code) return x.token ? callTool(x.token, 'join', args, signal, ctx) : textResult('To join, ' + joinWithCode, true);
    if (!TOKEN_RE.test(code)) return textResult(`"${code.slice(0, 40)}" is not a seat code. ` + 'To join, ' + joinWithCode, true);
    if (x.client && seats.has(code)) seats.get(code).client = x.client;   // join tells the page who joined
    const r = await callTool(code, 'join', args, signal, ctx);
    if (!r.isError) {
        for (const o of sessions.values()) if (o !== x && o.token === code) o.token = null;
        x.token = code;
        const s = seat(code);
        if (!s.seen) { s.seen = true; toPage({ type: 'harness', token: code, connected: true }); }
    }
    return r;
}

// ---- HTTP --------------------------------------------------------------------------
function cors(req, res) {
    const o = req.headers.origin;
    if (o && originOk(o)) {
        res.setHeader('Access-Control-Allow-Origin', o);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Private-Network', 'true');
        res.setHeader('Access-Control-Allow-Headers', 'content-type, mcp-protocol-version, mcp-session-id, accept');
        res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    }
}
const hubBase = () => 'http://127.0.0.1:' + ((server.address() && server.address().port) || PORT);
function json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); }

const server = http.createServer((req, res) => {
    cors(req, res);
    if (req.headers.origin && !originOk(req.headers.origin)) return json(res, 403, { error: 'origin not allowed' });
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/status' && req.method === 'GET')
        return json(res, 200, { hub: 'war-mcp-hub', version: VERSION, page: pages.size > 0, pages: pages.size,
            seats: [...seats.values()].filter(s => s.listed).map(s => ({ seat: s.seat, harness: s.seen, joined: s.joined })),
            // Joined seats no page lists (0.3.5): a harness left waiting, which `seats` hid.
            detached: [...seats.values()].filter(s => !s.listed && s.joined).map(s => ({ seat: s.seat, harness: s.seen, joined: true })),
            sessions: sessions.size, clients: [...clients.keys()] });
    const shared = url.pathname === '/mcp' || url.pathname === '/mcp/';
    const m = shared ? null : /^\/mcp\/([^/]+)\/?$/.exec(url.pathname);
    if (!shared && !m) return json(res, 404, { error: 'not found' });
    const token = m ? m[1] : null;
    if (!shared && !TOKEN_RE.test(token)) return json(res, 404, { error: 'unknown seat address' });
    const sid = String(req.headers['mcp-session-id'] || '').slice(0, 100);
    if (shared && req.method === 'DELETE') { if (sid) sessions.delete(sid); res.writeHead(204); return res.end(); }
    if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }); return res.end(); }
    let body = '';
    const gone = new AbortController();
    res.on('close', () => { if (!res.writableFinished) gone.abort(); });
    req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', async () => {
        let msg;
        try { msg = JSON.parse(body); } catch (e) { return json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
        // The shared address: a new session at initialize, its id sent back in Mcp-Session-Id.
        let ctx = { token };
        if (shared) {
            const init = [].concat(msg).some(q => q && q.method === 'initialize');
            const x = sid ? sessionFor(sid) : init ? sessionFor(crypto.randomUUID()) : null;
            if (x) res.setHeader('Mcp-Session-Id', x.id);
            ctx = { shared: true, session: x };
        }
        try {
            if (Array.isArray(msg)) {
                const out = (await Promise.all(msg.map(q => rpc(ctx, q, gone.signal)))).filter(Boolean);
                if (!out.length) { res.writeHead(202); return res.end(); }
                return json(res, 200, out);
            }
            const out = await rpc(ctx, msg, gone.signal);
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
    else {
        // A second hub on this computer: say so plainly instead of a stack trace (asp67, 27 Oct).
        server.on('error', e => {
            if (e && e.code === 'EADDRINUSE') {
                console.error(`Port ${PORT} is already in use: a WAR hub is probably running on this computer already (look for its window).`);
                console.error('You need only one. If that one is older, stop it with Ctrl+C in its window and start this again.');
                process.exit(1);
            }
            throw e;
        });
        server.listen(PORT, '127.0.0.1', () => {
            const port = server.address().port;
            console.log(`WAR MCP hub ${VERSION} on http://127.0.0.1:${port}`);
            console.log(`  harness address: http://127.0.0.1:${port}/mcp   (one for every seat; the seat code is in the start message)`);
            console.log('  the hub only answers on this computer: your browser and your harness must run here too');
            console.log('  leave this window open while you play; Ctrl+C stops the hub');
        });
    }
}
module.exports = { server, KICKOFF, VERSION };
