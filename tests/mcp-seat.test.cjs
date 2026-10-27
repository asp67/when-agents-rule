// An MCP seat's turn (docs/MCP-ARENA.md): its harness's calls come back through the hub
// link and run through the same parser as a library seat's tool calls.
'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createMatch } = require('../tools/bench/realm.cjs');

async function mcpSeat(answers) {
    const m = await createMatch({ kind: 'board', seed: 'mcp-seat', seats: [
        { civ: 'greek', age: 'bronze', buildings: [['town_center', -250, 0]], units: [['worker', -230, 0]] },
        { civ: 'persian', age: 'bronze', buildings: [['town_center', 250, 0]] }] });
    // The request path needs what a page has and the bench realm leaves out.
    Object.assign(m.context, { AbortController, setTimeout, clearTimeout });
    const mgr = m.game.openAIAIManager, c = m.controllers[0];
    c.model = { provider: 'mcp', endpoint: 'http://127.0.0.1:8765', mcpToken: 'seat-token-test0001', model: 'Claude Code' };
    const sent = [];
    // A stand-in for the hub link: it records what the seat was sent and answers with
    // the calls a harness would have made before end_turn.
    const link = { playTurn: async (token, turn, text, rules, signal) => {
        sent.push({ token, turn, text, rules });
        return answers.shift() || [];
    } };
    mgr._mcpLinks = new Map([['http://127.0.0.1:8765', link]]);
    return { m, mgr, c, sent };
}

test('an MCP seat is sent the turn a library seat would be, and its calls become the same commands', async () => {
    const { mgr, c, sent } = await mcpSeat([
        [{ name: 'plan', args: { objective: 'Grow', plan: ['workers'] } }, { name: 'train_unit', args: { unitType: 'worker', reason: 'more hands' } }]
    ]);
    const env = await mgr.sendToOpenAI(c, mgr.buildGameStateJSON(c));
    assert.deepEqual(JSON.parse(JSON.stringify(env.commands)), [{ action: 'train_unit', params: { unitType: 'worker', reason: 'more hands' } }]);
    assert.equal(env.objective, 'Grow');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].token, 'seat-token-test0001');
    assert.match(sent[0].text, /Game State JSON:\n\{/, 'the state, as a library seat gets it');
    assert.match(sent[0].rules, /greek|Greek/i, 'and the seat\'s system prompt, for its first turn');
    assert.equal(c._answeredVia, 'tool_call', 'answered over the tool channel, as a library seat');
});

test('a turn ended with no command is a wait, and the next turn carries the last result', async () => {
    const { mgr, c, sent } = await mcpSeat([[{ name: 'plan', args: { objective: 'Hold' } }], []]);
    const env = await mgr.sendToOpenAI(c, mgr.buildGameStateJSON(c));
    assert.equal(JSON.stringify(env.commands.map(x => x.action)), '["wait"]');
    // The executor wrote its result; a library seat would read it as the answer to its call.
    c.lastActionResult = 'OK - Waited this turn.';
    await mgr.sendToOpenAI(c, mgr.buildGameStateJSON(c));
    assert.match(sent[1].text, /RESULT of your PREVIOUS turn's commands: OK - Waited this turn\./);
});

// The whole chain, nothing stood in for: a game seat, the page's link (js/mcp-link.js),
// the hub (tools/mcp/war-mcp-hub.cjs) and a scripted harness speaking MCP over HTTP.
test('end to end: a harness over MCP plays a game seat through the hub', { timeout: 20000 }, async t => {
    const { spawn } = require('node:child_process'), path = require('node:path');
    const WarMcpLink = require('../js/mcp-link.js');
    const hub = await new Promise((resolve, reject) => {
        const p = spawn(process.execPath, [path.join(__dirname, '..', 'tools', 'mcp', 'war-mcp-hub.cjs'), '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = ''; p.stdout.on('data', c => { out += c; const mm = /127\.0\.0\.1:(\d+)/.exec(out); if (mm) resolve({ p, port: +mm[1] }); });
        p.on('exit', code => reject(new Error('hub exited ' + code)));
    });
    t.after(() => hub.p.kill());
    const base = 'http://127.0.0.1:' + hub.port, TOKEN = 'seat-token-e2e00001';
    const m = await createMatch({ kind: 'board', seed: 'mcp-e2e', seats: [
        { civ: 'greek', age: 'bronze', buildings: [['town_center', -250, 0]], units: [['worker', -230, 0]] },
        { civ: 'persian', age: 'bronze', buildings: [['town_center', 250, 0]] }] });
    Object.assign(m.context, { AbortController, setTimeout, clearTimeout });
    const mgr = m.game.openAIAIManager, c = m.controllers[0];
    c.model = { provider: 'mcp', endpoint: base, mcpToken: TOKEN, model: 'scripted harness' };
    const link = new WarMcpLink(base);
    t.after(() => link.close());
    mgr._mcpLinks = new Map([[base, link]]);
    link.connect();
    link.setSeats([{ token: TOKEN, seat: 1, name: 'scripted harness' }]);
    const seen = [];
    link.onChange((tok, st) => seen.push(st.joined ? 'joined' : st.harness ? 'harness' : st.hub ? 'hub' : 'none'));
    await new Promise(r => setTimeout(r, 150));
    let id = 1;
    const mcp = async (method, params) => (await (await fetch(base + '/mcp/' + TOKEN, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: id++, method, params }) })).json()).result;
    const tool = async (name, args = {}) => (await mcp('tools/call', { name, arguments: args })).content[0].text;
    assert.match(await tool('join'), /joined as seat 1/);
    assert.ok(link.status(TOKEN).joined, 'the page knows the seat joined (its dot turns green)');
    // The seat's turn starts on the page; the harness, waiting, receives it.
    const answer = mgr.sendToOpenAI(c, mgr.buildGameStateJSON(c));
    const state = await tool('wait_for_turn');
    assert.match(state, /^IT IS YOUR TURN[\s\S]*RULES OF THE GAME[\s\S]*Game State JSON:/, 'the first turn says what to do, carries the rules, then the state');
    assert.match(await tool('train_unit', { unitType: 'worker', reason: 'e2e' }), /^Queued \(1\/3\): train_unit[\s\S]*You can give 2 more, or call end_turn\./);
    assert.match(await tool('end_turn'), /Turn ended/);
    const env = await answer;
    assert.equal(JSON.stringify(env.commands), JSON.stringify([{ action: 'train_unit', params: { unitType: 'worker', reason: 'e2e' } }]));
    assert.ok(seen.includes('joined'));
    assert.match(await tool('get_rules'), /greek|Greek/i, 'get_rules has the seat\'s system prompt');
});

// asp67, 27 Oct: "after quitting the arena, all 4 seats still showed green even though I
// restarted the MCP hub". The page kept "joined" from before; the hub had said so once.
test('a seat\'s dot is green only while its harness is joined: not after the match, not after a hub restart', { timeout: 20000 }, async t => {
    const { spawn } = require('node:child_process'), path = require('node:path');
    const WarMcpLink = require('../js/mcp-link.js');
    const startHub = port => new Promise((resolve, reject) => {
        const p = spawn(process.execPath, [path.join(__dirname, '..', 'tools', 'mcp', 'war-mcp-hub.cjs'), '--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = ''; p.stdout.on('data', c => { out += c; const mm = /127\.0\.0\.1:(\d+)/.exec(out); if (mm) resolve({ p, port: +mm[1] }); });
        p.on('exit', code => reject(new Error('hub exited ' + code)));
    });
    let hub = await startHub(0);
    t.after(() => hub.p.kill());
    const base = 'http://127.0.0.1:' + hub.port, TOKEN = 'seat-token-dots0001';
    const link = new WarMcpLink(base);
    t.after(() => link.close());
    link.connect();
    link.setSeats([{ token: TOKEN, seat: 1, name: 'h' }]);
    await new Promise(r => setTimeout(r, 150));
    const join = async () => (await (await fetch(base + '/mcp/' + TOKEN, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'join', arguments: {} } }) })).json()).result.content[0].text;
    assert.match(await join(), /joined as seat 1/);
    await new Promise(r => setTimeout(r, 100));
    assert.equal(link.status(TOKEN).joined, true);
    link.over(TOKEN, {});
    assert.deepEqual(link.status(TOKEN), { hub: true, harness: true, joined: false }, 'after the match: harness in, not joined');
    assert.match(await join(), /joined as seat 1/);
    await new Promise(r => setTimeout(r, 100));
    assert.equal(link.status(TOKEN).joined, true);
    // The hub restarts on the same port; the page reconnects to a hub that knows no harness.
    const port = hub.port;
    await new Promise(r => { hub.p.once('exit', r); hub.p.kill(); });
    hub = await startHub(port);
    for (let i = 0; i < 40 && !link.hubUp; i++) await new Promise(r => setTimeout(r, 100));
    assert.equal(link.hubUp, true, 'reconnected');
    await new Promise(r => setTimeout(r, 100));
    assert.deepEqual(link.status(TOKEN), { hub: true, harness: false, joined: false }, 'red: waiting for the harness');
});

// The "harness idle" marker reads how long the seat's harness has made no call to the hub.
test('the link knows how long a seat\'s harness has been quiet', () => {
    const WarMcpLink = require('../js/mcp-link.js');
    const link = new WarMcpLink('http://127.0.0.1:1');
    link.setSeats([{ token: 'seat-token-quiet001', seat: 1 }]);
    assert.equal(link.quietMs('seat-token-quiet001'), null, 'nothing before its first call');
    link._fromHub({ type: 'call', token: 'seat-token-quiet001' });
    const s = link.state.get('seat-token-quiet001');
    s.lastCall -= 200000;
    assert.ok(link.quietMs('seat-token-quiet001') >= 200000);
    link._fromHub({ type: 'call', token: 'seat-token-quiet001' });
    assert.ok(link.quietMs('seat-token-quiet001') < 1000, 'a call resets it');
    assert.equal(link.quietMs('seat-token-unknown'), null);
});

test('stopping a match tells each MCP seat\'s harness it is over', async () => {
    const { mgr, c } = await mcpSeat([]);
    const told = [];
    mgr._mcpLinks.get('http://127.0.0.1:8765').over = (token, result) => told.push({ token, result });
    mgr.aiControllers = [c];
    mgr.stop();
    assert.equal(told.length, 1);
    assert.equal(told[0].token, 'seat-token-test0001');
    assert.equal(told[0].result.defeated, false);
});

test('an MCP seat is asked the closing question through its harness, and its final word is recorded like a library seat\'s', async () => {
    const { mgr, c } = await mcpSeat([]);
    const asked = [], notes = [];
    const link = mgr._mcpLinks.get('http://127.0.0.1:8765');
    link.finalWord = async (token, text) => { asked.push({ token, text }); return 'I scouted too late.'; };
    let overs = 0; link.over = () => { overs++; };
    mgr.transcripts = { note: (id, o) => notes.push(o), turnsFor: () => 0, record() {}, noteResult() {} };
    await mgr.askFinalWord(c, 'ended', { won: false, winner: 'persian' });
    assert.equal(asked.length, 1);
    assert.match(asked[0].text, /THE MATCH HAS ENDED[\s\S]*persian took it/, 'the same closing message a library seat gets');
    const fw = notes.find(n => n.type === 'final_word');
    assert.ok(fw && fw.text === 'I scouted too late.' && !fw.error, JSON.stringify(fw));
    mgr.aiControllers = [c];
    mgr.stop();
    assert.equal(overs, 0, 'no bare "over" after the closing message');
});
