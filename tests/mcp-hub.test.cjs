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
    assert.match(init.result.instructions, /Call join first/);
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
    assert.match(said(j), /RULES FOR SEAT 1[\s\S]*call wait_for_turn/);
    assert.equal((await pg.next(m => m.type === 'harness')).token, T, 'the page sees the harness connect');
    assert.equal((await pg.next(m => m.type === 'join')).token, T, 'and join');
    // No turn yet: waiting, after --wait-ms.
    assert.deepEqual(JSON.parse(said(await call(port, T, 'wait_for_turn'))), { waiting: true });
    // The turn arrives while the harness waits.
    const w = call(port, T, 'wait_for_turn');
    setTimeout(() => pg.send({ type: 'turn', token: T, turn: 7, state: { you: 'state of turn 7' } }), 100);
    assert.deepEqual(JSON.parse(said(await w)), { you: 'state of turn 7' });
    // Commands go to the page and its answer comes back.
    const answer = async () => { const a = await pg.next(m => m.type === 'action'); pg.send({ type: 'result', id: a.id, text: 'OK - ' + a.name }); return a; };
    for (const [name, args] of [['train_unit', { unitType: 'militia' }], ['plan', { objective: 'x' }], ['explore', {}], ['wait', {}]]) {
        const [r, a] = await Promise.all([call(port, T, name, args), answer()]);
        assert.equal(said(r), 'OK - ' + name); assert.equal(a.turn, 7); assert.deepEqual(a.args, args);
    }
    const fourth = await call(port, T, 'train_unit', { unitType: 'militia' });
    assert.ok(fourth.isError && /3 commands this turn/.test(said(fourth)), 'plan is free, the fourth command is not');
    const end = await call(port, T, 'end_turn');
    assert.match(said(end), /Turn ended/);
    assert.equal((await pg.next(m => m.type === 'end_turn')).turn, 7);
    assert.ok((await call(port, T, 'train_unit', {})).isError, 'no commands outside a turn');
    // An error from the game is an error result.
    pg.send({ type: 'turn', token: T, turn: 8, state: '{}' });
    await call(port, T, 'wait_for_turn');
    const [bad] = await Promise.all([call(port, T, 'build_structure', {}), (async () => { const a = await pg.next(m => m.type === 'action'); pg.send({ type: 'result', id: a.id, text: '[ERROR] no' }); })()]);
    assert.ok(bad.isError);
    // The match ends.
    pg.send({ type: 'over', token: T, result: { winner: 'greek' } });
    assert.deepEqual(JSON.parse(said(await call(port, T, 'wait_for_turn'))), { matchOver: true, result: { winner: 'greek' } });
    const status = await (await fetch(`http://127.0.0.1:${port}/status`)).json();
    assert.equal(status.page, true); assert.deepEqual(status.seats, [{ seat: 1, harness: true, joined: true }]);
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
