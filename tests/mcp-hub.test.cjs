// The WAR MCP hub (tools/mcp/war-mcp-hub.cjs, docs/MCP-ARENA.md): a harness's view over
// MCP (HTTP), the arena page's view over the WebSocket, and the stdio fallback.
'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs'), path = require('node:path');
const HUB = path.join(__dirname, '..', 'tools', 'mcp', 'war-mcp-hub.cjs');
const { currentTools, text, OUT } = require('../tools/mcp/build-tools.cjs');

function startHub(extra = []) {
    return new Promise((resolve, reject) => {
        const p = spawn(process.execPath, [HUB, '--port', '0', '--wait-ms', '400', ...extra], { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        p.stdout.on('data', c => { out += c; const m = /http:\/\/127\.0\.0\.1:(\d+)/.exec(out); if (m) resolve({ p, port: +m[1] }); });
        p.on('exit', code => reject(new Error('hub exited ' + code + ' ' + out)));
    });
}
let rid = 1;
async function mcp(port, token, method, params, headers = {}) {
    const r = await fetch(`http://127.0.0.1:${port}/mcp/${token}`, { method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
        body: JSON.stringify({ jsonrpc: '2.0', id: rid++, method, params }) });
    return r.status === 200 ? r.json() : { status: r.status };
}
// A hub that stops answering fails a test, not the run: every test has a time limit.
const LIMIT = { timeout: 15000 };
const call = async (port, token, name, args = {}) => (await mcp(port, token, 'tools/call', { name, arguments: args })).result;
const said = r => r.content[0].text;

function fakePage(port) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/page`);
    const inbox = [], waiting = [];
    ws.onmessage = e => { const m = JSON.parse(e.data); const w = waiting.findIndex(x => x.pred(m)); if (w >= 0) waiting.splice(w, 1)[0].res(m); else inbox.push(m); };
    const next = pred => new Promise(res => { const i = inbox.findIndex(pred); if (i >= 0) res(inbox.splice(i, 1)[0]); else waiting.push({ pred, res }); });
    return new Promise(res => ws.onopen = () => res({ ws, send: o => ws.send(JSON.stringify(o)), next }));
}

test('war-tools.json is what openai-ai.js offers a library seat today', LIMIT, () => {
    const have = fs.readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n');
    assert.equal(have, text(currentTools()), 'stale: run node tools/mcp/build-tools.cjs');
});

test('a harness sees the tools and the play prompt before any arena is open, and cannot join', LIMIT, async t => {
    const { p, port } = await startHub(); t.after(() => p.kill());
    const T = 'seat-token-aaaa1111';
    const init = await mcp(port, T, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.match(init.result.instructions, /First call join\. Then play this loop[\s\S]*1\. Call wait_for_turn/);
    const names = (await mcp(port, T, 'tools/list')).result.tools.map(x => x.name);
    for (const n of ['join', 'wait_for_turn', 'end_turn', 'get_rules', 'train_unit', 'move_units', 'attack_target', 'plan']) assert.ok(names.includes(n), n);
    const play = (await mcp(port, T, 'prompts/get', { name: 'play' })).result.messages[0].content.text;
    assert.match(play, /wait_for_turn/);
    const j = await call(port, T, 'join');
    assert.ok(j.isError && /No WAR arena is open/.test(said(j)), said(j));
    assert.equal((await fetch(`http://127.0.0.1:${port}/mcp/x`, { method: 'POST', body: '{}' })).status, 404, 'a malformed seat address');
});

test('a turn: join, wait, three commands and a plan, a fourth refused, end_turn; then the match ends', LIMIT, async t => {
    const { p, port } = await startHub(); t.after(() => p.kill());
    const T = 'seat-token-bbbb2222', OTHER = 'seat-token-cccc3333';
    const pg = await fakePage(port);
    assert.equal((await pg.next(m => m.type === 'hello')).maxCommandsPerTurn, 3);
    pg.send({ type: 'arena', seats: [{ token: T, seat: 1, name: 'Claude Code', rules: 'RULES FOR SEAT 1' }] });
    await new Promise(r => setTimeout(r, 50));
    const notListed = await call(port, OTHER, 'join');
    assert.ok(notListed.isError && /does not use this seat/.test(said(notListed)));
    assert.ok((await call(port, T, 'wait_for_turn')).isError, 'join comes first');
    const j = await call(port, T, 'join');
    assert.match(said(j), /RULES FOR SEAT 1[\s\S]*1\. Call wait_for_turn[\s\S]*3\. Call end_turn[\s\S]*Your next action: call wait_for_turn now\./, 'join tells the loop and the next call');
    assert.equal((await pg.next(m => m.type === 'harness')).token, T, 'the page sees the harness connect');
    assert.equal((await pg.next(m => m.type === 'join')).token, T, 'and join');
    // No turn yet: waiting, after --wait-ms.
    const waiting = JSON.parse(said(await call(port, T, 'wait_for_turn')));
    assert.equal(waiting.waiting, true); assert.match(waiting.next, /Call wait_for_turn again now/);
    // The turn arrives while the harness waits.
    const w = call(port, T, 'wait_for_turn');
    setTimeout(() => pg.send({ type: 'turn', token: T, turn: 7, state: { you: 'state of turn 7' } }), 100);
    const turn = said(await w);
    assert.match(turn, /^IT IS YOUR TURN\. [\s\S]*then call end_turn\.\n\n/, 'the turn says what to do');
    assert.deepEqual(JSON.parse(turn.slice(turn.indexOf('\n\n') + 2)), { you: 'state of turn 7' });
    // Commands go to the page and its answer comes back.
    const answer = async () => { const a = await pg.next(m => m.type === 'action'); pg.send({ type: 'result', id: a.id, text: 'OK - ' + a.name }); return a; };
    for (const [name, args] of [['train_unit', { unitType: 'militia' }], ['plan', { objective: 'x' }], ['explore', {}], ['wait', {}]]) {
        const [r, a] = await Promise.all([call(port, T, name, args), answer()]);
        assert.equal(said(r), 'OK - ' + name); assert.equal(a.turn, 7); assert.deepEqual(a.args, args);
    }
    const fourth = await call(port, T, 'train_unit', { unitType: 'militia' });
    assert.ok(fourth.isError && /3 commands this turn/.test(said(fourth)), 'plan is free, the fourth command is not');
    const end = await call(port, T, 'end_turn');
    assert.match(said(end), /Turn ended\. Your next action: call wait_for_turn now\./);
    assert.equal((await pg.next(m => m.type === 'end_turn')).turn, 7);
    assert.ok((await call(port, T, 'train_unit', {})).isError, 'no commands outside a turn');
    // An error from the game is an error result.
    pg.send({ type: 'turn', token: T, turn: 8, state: '{}' });
    await call(port, T, 'wait_for_turn');
    const [bad] = await Promise.all([call(port, T, 'build_structure', {}), (async () => { const a = await pg.next(m => m.type === 'action'); pg.send({ type: 'result', id: a.id, text: '[ERROR] no' }); })()]);
    assert.ok(bad.isError);
    // The match ends.
    pg.send({ type: 'over', token: T, result: { winner: 'greek' } });
    const over = JSON.parse(said(await call(port, T, 'wait_for_turn')));
    assert.equal(over.matchOver, true); assert.deepEqual(over.result, { winner: 'greek' }); assert.match(over.next, /Stop playing/);
    const status = await (await fetch(`http://127.0.0.1:${port}/status`)).json();
    assert.equal(status.page, true);
    assert.deepEqual(status.seats, [{ seat: 1, harness: true, joined: false }], 'told to stop, the harness is no longer joined');
    pg.ws.close();
});

test('only WAR pages and local pages may drive seats', LIMIT, async t => {
    const { p, port } = await startHub(); t.after(() => p.kill());
    const evil = await mcp(port, 'seat-token-dddd4444', 'tools/list', undefined, { origin: 'https://evil.example' });
    assert.equal(evil.status, 403);
    const okLocal = await fetch(`http://127.0.0.1:${port}/status`, { headers: { origin: 'http://localhost:8100' } });
    assert.equal(okLocal.headers.get('access-control-allow-origin'), 'http://localhost:8100');
    assert.equal(okLocal.headers.get('access-control-allow-private-network'), 'true');
    const pre = await fetch(`http://127.0.0.1:${port}/status`, { method: 'OPTIONS', headers: { origin: 'https://asp67.github.io', 'access-control-request-private-network': 'true' } });
    assert.equal(pre.status, 204); assert.equal(pre.headers.get('access-control-allow-private-network'), 'true');
});

test('the stdio fallback forwards to the running hub', LIMIT, async t => {
    const { p, port } = await startHub(); t.after(() => p.kill());
    const s = spawn(process.execPath, [HUB, '--stdio', '--token', 'seat-token-eeee5555', '--port', String(port)], { stdio: ['pipe', 'pipe', 'pipe'] });
    t.after(() => s.kill());
    const lines = [];
    const got = new Promise(res => s.stdout.on('data', c => { lines.push(...String(c).split('\n').filter(Boolean)); if (lines.length >= 2) res(); }));
    s.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } } }) + '\n');
    s.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    s.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
    await got;
    const [a, b] = lines.map(l => JSON.parse(l));
    assert.equal(a.id, 1); assert.equal(a.result.protocolVersion, '2024-11-05');
    assert.equal(b.id, 2); assert.ok(b.result.tools.some(x => x.name === 'join'), 'a notification gets no line');
});

// asp67, 26 Oct: "after quitting the arena and returning to the arena config page, the ready
// button keeps alternating between ready and hub not running". A second WAR page (a preview
// left open elsewhere) took the hub's one page slot, the first reconnected and took it back,
// every two seconds. Pages now share the hub, each hearing only about its own seats.
test('two WAR pages share the hub without knocking each other off; a page that comes back finds its harness joined', LIMIT, async t => {
    const { p, port } = await startHub(); t.after(() => p.kill());
    const A = 'seat-token-ffff6666', B = 'seat-token-gggg7777';
    const pa = await fakePage(port), pb = await fakePage(port);
    pa.send({ type: 'arena', seats: [{ token: A, seat: 1 }] });
    pb.send({ type: 'arena', seats: [{ token: B, seat: 2 }] });
    await new Promise(r => setTimeout(r, 50));
    assert.match(said(await call(port, A, 'join')), /joined as seat 1/);
    assert.equal((await pa.next(m => m.type === 'join')).token, A);
    await new Promise(r => setTimeout(r, 300));
    let closedB = false; pb.ws.onclose = () => { closedB = true; };
    assert.equal(closedB, false, 'the second page was not dropped');
    assert.equal((await (await fetch(`http://127.0.0.1:${port}/status`)).json()).pages, 2);
    // Page A goes away and comes back (a reload): its harness is still joined.
    pa.ws.close();
    await new Promise(r => setTimeout(r, 100));
    const pa2 = await fakePage(port);
    pa2.send({ type: 'arena', seats: [{ token: A, seat: 1 }] });
    assert.equal((await pa2.next(m => m.type === 'join')).token, A, 'the returning page sees the seat ready at once');
    pa2.ws.close(); pb.ws.close();
});

// asp67, 26 Oct: "do we have a mechanic that tells the harness when I quit the arena?" The
// page sends "over"; a harness busy at that moment hears it on its next wait, and the next
// arena waits for it to join again instead of showing the seat ready.
test('a match quit while the harness is busy: its next wait hears it is over, and the next arena waits for a new join', LIMIT, async t => {
    const { p, port } = await startHub(); t.after(() => p.kill());
    const T = 'seat-token-hhhh8888';
    const pg = await fakePage(port);
    pg.send({ type: 'arena', seats: [{ token: T, seat: 1 }] });
    await new Promise(r => setTimeout(r, 50));
    await call(port, T, 'join');
    pg.send({ type: 'turn', token: T, turn: 1, state: '{}' });
    await call(port, T, 'wait_for_turn');                       // mid-turn now
    pg.send({ type: 'over', token: T, result: { defeated: false } });
    await new Promise(r => setTimeout(r, 50));
    const over = JSON.parse(said(await call(port, T, 'wait_for_turn')));
    assert.equal(over.matchOver, true, 'told, although no longer joined');
    pg.send({ type: 'arena', seats: [{ token: T, seat: 1 }] });   // the next arena
    await new Promise(r => setTimeout(r, 50));
    const st = await (await fetch(`http://127.0.0.1:${port}/status`)).json();
    assert.deepEqual(st.seats, [{ seat: 1, harness: true, joined: false }], 'red until the harness joins again');
    pg.ws.close();
});

// A harness whose own timeout is shorter than the hub's wait gives up on wait_for_turn and
// moves on. The turn that arrives next must reach its next call, not the abandoned one.
test('a wait the harness gave up on does not swallow the next turn', LIMIT, async t => {
    const { p, port } = await startHub(['--wait-ms', '5000']); t.after(() => p.kill());
    const T = 'seat-token-iiii9999';
    const pg = await fakePage(port);
    pg.send({ type: 'arena', seats: [{ token: T, seat: 1 }] });
    await new Promise(r => setTimeout(r, 50));
    await call(port, T, 'join');
    const ac = new AbortController();
    const abandoned = fetch(`http://127.0.0.1:${port}/mcp/${T}`, { method: 'POST', signal: ac.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/call', params: { name: 'wait_for_turn', arguments: {} } }) }).catch(e => e.name);
    await new Promise(r => setTimeout(r, 150));
    ac.abort();
    assert.equal(await abandoned, 'AbortError');
    await new Promise(r => setTimeout(r, 100));
    pg.send({ type: 'turn', token: T, turn: 3, state: '{"turn":3}' });
    await new Promise(r => setTimeout(r, 100));
    const t0 = Date.now();
    const turn = said(await call(port, T, 'wait_for_turn'));
    assert.match(turn, /^IT IS YOUR TURN/, 'the next call gets the turn');
    assert.ok(Date.now() - t0 < 1000, 'at once, not after a wait: ' + (Date.now() - t0) + ' ms');
    pg.ws.close();
});

// asp67, 26 Oct, the first full game with an MCP seat: "The end of the game needs the final
// message with the request for the retrospective; currently the connection just closes."
// And the harness, busy when the match ended, got "Call join first" for its end_turn.
test('the end of a match: the closing message reaches the harness, its final word reaches the page, late calls hear the match is over', LIMIT, async t => {
    const { p, port } = await startHub(); t.after(() => p.kill());
    const T = 'seat-token-jjjj0000';
    const pg = await fakePage(port);
    pg.send({ type: 'arena', seats: [{ token: T, seat: 1 }] });
    await new Promise(r => setTimeout(r, 50));
    await call(port, T, 'join');
    pg.send({ type: 'turn', token: T, turn: 4, state: '{}' });
    await call(port, T, 'wait_for_turn');                       // mid-turn when the match ends
    pg.send({ type: 'final', token: T, text: 'THE MATCH HAS ENDED. You did not win. Say what you would do differently.' });
    await new Promise(r => setTimeout(r, 50));
    const late = JSON.parse(said(await call(port, T, 'end_turn')));
    assert.equal(late.matchOver, true, 'not "Call join first"');
    assert.match(late.finalMessage, /THE MATCH HAS ENDED/);
    assert.match(late.next, /call(ing)? final_word/i);
    const [answer, got] = await Promise.all([call(port, T, 'final_word', { text: 'I scouted too late.' }), pg.next(m => m.type === 'final_word')]);
    assert.match(said(answer), /recorded/);
    assert.equal(got.text, 'I scouted too late.');
    const after = JSON.parse(said(await call(port, T, 'wait_for_turn')));
    assert.equal(after.matchOver, true); assert.equal(after.finalMessage, undefined, 'answered once');
    pg.ws.close();
});
