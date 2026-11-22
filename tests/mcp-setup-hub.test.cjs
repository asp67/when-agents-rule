'use strict';
// Build 1219 (asp67, 22 November 2026): "On game setup, check if mcp server is up and
// running". The page kept a line open to the hub all along, but showed it only as a seat's
// red dot. The arena setup now says it in a line of its own: running, and which version,
// or not running, with the command that starts it.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const root = path.resolve(__dirname, '..');

function page(hubs = {}) {
    const els = {}, asked = [];
    const list = { insertAdjacentElement: (where, el) => { els[el.id] = el; } };
    els.arenaSlotsList = list;
    const links = new Map();
    const WarMcpLink = function () {};
    WarMcpLink.shared = url => { if (!links.has(url)) links.set(url, { hubUp: !!hubs[url], onChange: () => () => {}, setSeats() {}, status: () => ({ hub: !!hubs[url] }) }); return links.get(url); };
    let answer = null;
    const context = vm.createContext({ console, Date, JSON, Map, Set, WarMcpLink, getUiLang: () => 'en', t: (k, v) => k + (v ? JSON.stringify(v) : ''),
        location: { origin: 'http://localhost:8099', href: 'http://localhost:8099/index.html' }, localStorage: { getItem: () => null, setItem() {} },
        navigator: { platform: 'Win32', userAgent: 'x' },
        fetch: url => { asked.push(url); return new Promise(res => { answer = v => res({ json: () => Promise.resolve(v) }); }); },
        document: { getElementById: id => els[id] || null, createElement: () => { const el = { id: '', className: '', _html: '', remove() { delete els[this.id]; } };
            Object.defineProperty(el, 'innerHTML', { get() { return this._html; }, set(v) { this._html = v; el.writes = (el.writes || 0) + 1; } }); return el; } } });
    vm.runInContext(fs.readFileSync(path.join(root, 'js/ui.js'), 'utf8') + '\nthis.UI = UIManager;', context);
    vm.runInContext(fs.readFileSync(path.join(root, 'js/mcp-ui.js'), 'utf8'), context);
    const u = Object.create(context.UI.prototype);
    u.escapeHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
    u._setupMode = 'arena';
    u._arenaConfig = { count: 3, models: [{ id: 'm1', provider: 'mcp', mcpToken: 'tok1', harness: 'claude-code' }, { id: 'm2', provider: 'mcp', mcpToken: 'tok2', harness: 'hermes' },
        { id: 'm3', provider: 'openai', endpoint: 'http://x/v1' }], slots: [{ control: 'm1' }, { control: 'm2' }, { control: 'ki' }, { control: 'm3' }] };
    return { u, els, links, asked, hubs, give: v => answer && answer(v) };
}
const HUB = 'http://127.0.0.1:8765';

test('with the MCP server down the setup says so, and how to start it', () => {
    const { u, els, asked } = page();
    u.renderMcpArenaNote();
    const html = els.mcpArenaNote.innerHTML;
    assert.match(html, /^<p class="mcp-hub-line err"><span class="seat-dot"><\/span>mcp\.note\.hubDown\{&quot;url&quot;:&quot;http:\/\/127\.0\.0\.1:8765&quot;\}<\/p>/, 'first thing in the note');
    assert.match(html, /<div class="mcp-code"><pre>[^<]*node war-mcp-hub\.cjs/, 'the command that starts it, to copy');
    assert.match(html, /mcp\.note\.hubRetry/);
    assert.match(html, /mcp\.note\.title.*mcp\.note\.s1.*mcp\.note\.s3/s, 'and the three steps after it, as before');
    assert.equal(asked.length, 0, 'a server that is down is not asked for its version');
    assert.deepEqual(JSON.parse(JSON.stringify(u.mcpSetupHubs())), [{ url: HUB, up: false, version: '' }], 'two seats on one hub: one line');
});

test('when it comes up the line turns green by itself, with the version once the hub has said it', async () => {
    const { u, els, links, asked, give } = page();
    u.renderMcpArenaNote();
    const writes = () => els.mcpArenaNote.writes;
    assert.equal(writes(), 1);
    u.renderMcpArenaNote();
    assert.equal(writes(), 1, 'drawn anew only when what it says has changed: it holds a button to copy from');
    // The hub is started: the page's line to it opens, and the seat dots are refreshed.
    links.get(HUB).hubUp = true;
    Object.assign(u, { seatReadyHtml: () => '', arenaStartBlocked: () => [] });
    u.refreshSeatDots();
    assert.equal(writes(), 2);
    assert.match(els.mcpArenaNote.innerHTML, /^<p class="mcp-hub-line ok"><span class="seat-dot"><\/span>mcp\.note\.hubUp\{&quot;url&quot;:&quot;http:\/\/127\.0\.0\.1:8765&quot;,&quot;v&quot;:&quot;&quot;\}<\/p><strong>/);
    assert.doesNotMatch(els.mcpArenaNote.innerHTML, /mcp-code|hubRetry/, 'no start command for a server that runs');
    assert.deepEqual(asked, [HUB + '/status'], 'asked once for its version');
    give({ version: '0.3.2' });
    await new Promise(r => setTimeout(r, 5));
    assert.match(els.mcpArenaNote.innerHTML, /mcp\.note\.hubUpV\{&quot;url&quot;:&quot;http:\/\/127\.0\.0\.1:8765&quot;,&quot;v&quot;:&quot;0\.3\.2&quot;\}/);
    u.refreshSeatDots(); u.refreshSeatDots();
    assert.equal(asked.length, 1); assert.equal(writes(), 3);
    // It goes down again: red, with the command, and asked again when it is back.
    links.get(HUB).hubUp = false;
    u.refreshSeatDots();
    assert.match(els.mcpArenaNote.innerHTML, /mcp-hub-line err.*mcp-code/s);
    links.get(HUB).hubUp = true;
    u.refreshSeatDots();
    assert.equal(asked.length, 2);
});

test('no MCP seat, no note; a page served from elsewhere is told the server may refuse it', () => {
    const { u, els } = page();
    u._arenaConfig.slots = [{ control: 'ki' }, { control: 'm3' }, { control: 'ki' }];
    u.renderMcpArenaNote();
    assert.equal(els.mcpArenaNote, undefined);
    assert.equal(u.mcpSetupHubs().length, 0);
    // A seat with a hub of its own address gets a line of its own.
    const two = page({ 'http://10.0.0.5:9000': true });
    two.u._arenaConfig.models[1].endpoint = 'http://10.0.0.5:9000/';
    two.u.renderMcpArenaNote();
    assert.deepEqual(JSON.parse(JSON.stringify(two.u.mcpSetupHubs())).map(h => [h.url, h.up]), [[HUB, false], ['http://10.0.0.5:9000', true]]);
    assert.equal((two.els.mcpArenaNote.innerHTML.match(/mcp-hub-line/g) || []).length, 2);
    const src = fs.readFileSync(path.join(root, 'js/mcp-ui.js'), 'utf8');
    assert.match(src, /t\(this\.mcpOriginNeedsAllow\(this\.mcpPageOrigin\(\)\) \? 'mcp\.note\.hubDownOrigin' : 'mcp\.note\.hubDown', \{ url: h\.url \}\)/);
    assert.match(src, /this\.renderMcpArenaNote\(\);\s+\/\/ its line about the hub follows the hub/);
    const i18n = fs.readFileSync(path.join(root, 'js/i18n.js'), 'utf8');
    for (const key of ['mcp.note.hubUp', 'mcp.note.hubUpV', 'mcp.note.hubDown', 'mcp.note.hubDownOrigin', 'mcp.note.hubRetry']) assert.equal(i18n.split("'" + key + "':").length - 1, 4, key);
});
