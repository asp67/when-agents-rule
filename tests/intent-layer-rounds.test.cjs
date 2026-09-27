'use strict';
// The intent layer in a turn-based match: a seat's answer is held until every seat has
// answered and the round is played, and so are its rings and bubbles. Driven through the
// live path -- two model seats asked by the harness on frames, answered by stub
// endpoints, one of them held back -- so it is the real round that decides.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Realm } = require('../tools/bench/realm.cjs');

test('turn-based: nothing is drawn for a held answer; the round is drawn when it is played', async () => {
    let release, slowAsked = false;
    const gate = new Promise(r => { release = r; });
    const json = body => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    const reply = (tile, reason) => json({ id: 'x', object: 'chat.completion', model: 'stub',
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
        choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
            tool_calls: [{ id: 'c' + tile, type: 'function', function: { name: 'explore', arguments: JSON.stringify({ tile, reason }) } }] } }] });
    const stubFetch = async url => {
        if (String(url).includes('/models')) return json({ data: [{ id: 'stub' }] });
        if (String(url).includes('slow.test')) { slowAsked = true; await gate; return reply('C3', 'Slow and sure.'); }
        return reply('D4', 'Quick look at the centre.');
    };
    const realm = new Realm({ seed: 24680 });
    Object.assign(realm.context, { AbortController, setTimeout, clearTimeout, fetch: stubFetch, Response });
    const g = realm.game;
    // Watching from before the start, so every answer is news to it.
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/intent-layer.js'), 'utf8'), realm.context, { filename: 'js/intent-layer.js' });
    const layer = vm.runInContext('new IntentLayer(game)', realm.context);
    layer.poll(0);
    const started = g._startArenaFromSetup({ seed: 'intent-rounds', difficulty: 'easy', turnBased: true, setup: [
        { civ: 'greek', type: 'llm', connection: { endpoint: 'http://fast.test/v1', model: 'stub', name: 'Fast' } },
        { civ: 'persian', type: 'llm', connection: { endpoint: 'http://slow.test/v1', model: 'stub', name: 'Slow' } }] });
    let done = false; started.then(() => { done = true; }, () => { done = true; });
    for (let i = 0; !done && i < 2000; i++) { realm.rafQueue.splice(0).forEach(cb => cb()); await new Promise(r => setImmediate(r)); }
    assert.ok(g.gameStarted);
    const mgr = g.openAIAIManager, [fast, slow] = mgr.aiControllers;
    assert.equal(mgr.turnBased, true);
    // The fast seat answers; the slow one is still thinking, so the round waits.
    for (let i = 0; i < 400 && !(slowAsked && fast.turnLog.length); i++) { realm.frame(); await new Promise(r => setImmediate(r)); }
    assert.ok(fast.turnLog.length > 0 && slowAsked, 'the fast seat has answered, the slow one was asked');
    assert.equal(slow.turnLog.length, 0);
    let t = 1000;
    for (let i = 0; i < 20; i++) { realm.frame(); await new Promise(r => setImmediate(r)); layer.poll(t += 100); }
    assert.equal(layer.intents.length + layer.bubbles.length, 0, 'the answer is held, and so is its bubble');
    // Both have answered: the round is played, and both are drawn.
    release();
    for (let i = 0; i < 200 && layer.bubbles.length < 2; i++) { realm.frame(); await new Promise(r => setImmediate(r)); layer.poll(t += 100); }
    assert.deepEqual(Array.from(layer.bubbles, b => b.text).sort(), ['Quick look at the centre.', 'Slow and sure.']);
    assert.equal(layer.intents.length, 2);
    mgr._stopped = true;
});
