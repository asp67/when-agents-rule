// The default system prompt is pinned to UIManager.ARENA_PROMPT_VERSION (b1089). A saved
// arena prompt is replaced by the default only when that version changes, so a change to
// the default's text without a bump leaves every saved prompt on the old text. It happened:
// b1084 added explore's "then", which the prompt's generated command list shows
// ("explore: tile, then?, ..."), the version stayed at v107, and asp67's next arena ran on
// the old list. Change the prompt, bump the version, and record both here.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), { createHash } = require('node:crypto');
const { createMatch } = require('../tools/bench/realm.cjs');

test('the default system prompt and its version change together', async () => {
    const pinned = JSON.parse(fs.readFileSync(path.join(__dirname, 'prompt-version.json'), 'utf8'));
    const m = await createMatch({ kind: 'arena', seed: 'prompt-version', seats: ['greek', 'persian'], mapSize: 1200 });
    const text = require('node:vm').runInContext('OpenAIAIManager.defaultSystemPrompt()', m.context);
    const sha = createHash('sha256').update(text.split('\r\n').join('\n')).digest('hex');
    const ui = fs.readFileSync(path.join(__dirname, '../js/ui.js'), 'utf8');
    const version = /static get ARENA_PROMPT_VERSION\(\) \{ return '([^']+)'; \}/.exec(ui)[1];
    assert.equal(sha, pinned.sha256, `the default system prompt changed: bump UIManager.ARENA_PROMPT_VERSION (now ${version}) `
        + `and record the new version and sha256 ${sha} in tests/prompt-version.json`);
    assert.equal(version, pinned.version, `ARENA_PROMPT_VERSION is ${version} but tests/prompt-version.json pins ${pinned.version}`);
});
