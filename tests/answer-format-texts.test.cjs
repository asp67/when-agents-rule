// What a seat is told about HOW to answer is true for that seat (b1276). Models copy our
// notation back, so a wrong form in a prompt or an error is a wrong form in the next
// reply. Two seats were told the other one's form:
//  - a seat whose endpoint refused the tools array is sent none, yet its prompt still said
//    "ACT BY CALLING THE TOOLS. They are the only way anything happens" and "Calling the
//    tools is still the primary channel", and its errors said "ONE raw JSON object" where
//    one object per action is read;
//  - a seat that calls tools, out of output tokens, was told that "a bare
//    {"action":"wait",...} beats an empty turn": raw JSON, which is not read from a tool
//    seat at all.
const test = require('node:test'), assert = require('node:assert/strict');
const { stubSeat } = require('./lib/stub-seat.cjs');

// The answer of a model that spent its whole output budget thinking.
const SPENT = { choices: [{ finish_reason: 'length', message: { role: 'assistant', content: null } }], usage: { prompt_tokens: 10, completion_tokens: 1024 } };
const systemOf = s => { const m = s.requests[s.requests.length - 1].body.messages; return m[0].role === 'system' ? m[0].content : ''; };

test('a tool seat out of tokens is told to call wait, not to write JSON', async () => {
    const s = await stubSeat({ reply: SPENT });
    await s.turn();
    const told = s.c.lastActionResult;
    assert.match(told, /^\[ERROR\] You returned NOTHING/);
    assert.match(told, /a bare call of "wait" with \{"reason":"thinking"\} beats an empty turn\./);
    assert.doesNotMatch(told, /\{"action"/, 'no raw JSON form: it is not read from this seat');
    assert.ok((s.requests[0].body.tools || []).length > 0, 'it has the tools');
});

test('a seat whose endpoint takes no tools is told to write JSON, everywhere', async () => {
    const s = await stubSeat({ reply: SPENT, model: { toolFallback: true, _reqOpts: { omitTools: true } } });
    await s.turn();
    assert.equal(s.requests[0].body.tools, undefined, 'no tools are sent');
    const prompt = systemOf(s);
    assert.doesNotMatch(prompt, /ACT BY CALLING THE TOOLS/);
    assert.doesNotMatch(prompt, /Calling the tools is still the primary channel/);
    assert.match(prompt, /ACT BY WRITING RAW JSON OBJECTS/);
    assert.match(prompt, /this endpoint takes no tool calls/);
    assert.match(prompt, /ACTIONS \(\? = optional\)\. Answer each with \{"action"/, 'with the shapes to write');
    const told = s.c.lastActionResult;
    assert.match(told, /a bare \{"action":"wait","params":\{"reason":"thinking"\}\} beats an empty turn\./);
    const how = s.mgr.constructor.howToAnswer(s.c);
    assert.match(how, /^Reply with one raw JSON object per action, up to 3, e\.g\. \{"action":"wait"/);
    assert.doesNotMatch(how, /ONE raw JSON object/);
});

test('a tool seat with the fallback switched on keeps both channels, tools first', async () => {
    const s = await stubSeat({ reply: SPENT, model: { toolFallback: true } });
    await s.turn();
    const prompt = systemOf(s);
    assert.match(prompt, /ACT BY CALLING THE TOOLS/);
    assert.match(prompt, /IF TOOL CALLING FAILS FOR YOU/);
    assert.match(s.c.lastActionResult, /a bare call of "wait"/);
});
