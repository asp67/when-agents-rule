'use strict';
// What a model reads is spelled one way, the way its ids are: "town_center", so "center"
// (b1148). asp67, 8 Nov: DeepSeek V4.1 Flash wrote "Town Centre" in its reasons; nothing
// of ours taught it that, but the move_units tile description and the move result said
// "centre of that tile". Models copy our notation back, so the harness keeps to one spelling.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { createMatch } = require('../tools/bench/realm.cjs');

const BRITISH = /\b(centre|centred|centres|colour|armour|defence|harbour)\b/i;

test('the default system prompt is in American spelling', async () => {
    const m = await createMatch({ kind: 'arena', seed: 'spelling', seats: ['greek', 'persian'], mapSize: 1200 });
    const text = vm.runInContext('OpenAIAIManager.defaultSystemPrompt()', m.context);
    const hit = BRITISH.exec(text);
    assert.equal(hit, null, hit && 'the prompt says "' + text.slice(Math.max(0, hit.index - 60), hit.index + 40) + '"');
});

test('the tool definitions an MCP seat is offered are in American spelling', () => {
    const tools = fs.readFileSync(path.join(__dirname, '../tools/mcp/war-tools.json'), 'utf8');
    const hit = BRITISH.exec(tools);
    assert.equal(hit, null, hit && 'war-tools.json says "' + tools.slice(Math.max(0, hit.index - 60), hit.index + 40) + '"');
});
