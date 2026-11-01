'use strict';
// Jumping around a re-simulated replay (b1145). asp67, 1 Nov: "one has to always start at
// the start and then fast forward to the place of interest instead of being able to just
// jump to a timestamp", and a jump made during a long one was lost. The worker now keeps
// keyframes as it goes, lands a jump back on the nearest one, and takes the newest request.
const test = require('node:test'), assert = require('node:assert/strict');
const { workerRealm, sample, raw, hasGit } = require('./lib/resim-worker-realm.cjs');

const NEEDS_GIT = { skip: !hasGit && 'no git history here' };
const S = hasGit ? sample('2026-10-08_claude-haiku5.5-gpt6-luna_20min') : null;   // build 1080, 40 steps a second
const init = async (w, extra = {}) => {
    const r = await w.send(Object.assign({ type: 'init', urls: {}, base: raw(S.version.commit), recs: S.recs }, extra));
    assert.equal(r.type, 'ready', r.problem);
};
const frames = w => w.out.filter(m => m.type === 'frame');
const until = async (cond, ms = 120000) => { const t = Date.now(); while (!cond()) { if (Date.now() - t > ms) throw new Error('timed out'); await new Promise(r => setTimeout(r, 20)); } };

test('a jump back lands where a fresh replay does, from a keyframe, and on again', NEEDS_GIT, async () => {
    const w = workerRealm();
    await init(w);
    const at6000 = await w.send({ type: 'to', step: 6000 });
    assert.equal(at6000.ok, true, at6000.problem);
    const h6000 = w.run('game.stateHash()');
    assert.ok(w.run('keyframes.map(k => k.step)').join() === [w.run('keyframes[0].step'), 2400, 4800].join(), 'kept on the way: ' + w.run('keyframes.map(k => k.step)'));

    const back = await w.send({ type: 'to', step: 3000 });
    assert.equal(back.step, 3000);
    assert.equal(back.ok, true, back.problem);
    const fresh = workerRealm();
    await init(fresh);
    const f3000 = await fresh.send({ type: 'to', step: 3000 });
    assert.equal(w.run('game.stateHash()'), fresh.run('game.stateHash()'), 'the world a fresh replay reaches');
    assert.equal(back.checked, f3000.checked, 'the same recorded inputs checked');
    assert.equal(JSON.stringify(back.scene.seats.map(s => s.units.length)), JSON.stringify(f3000.scene.seats.map(s => s.units.length)));

    const again = await w.send({ type: 'to', step: 6000 });
    assert.equal(again.ok, true, again.problem);
    assert.equal(w.run('game.stateHash()'), h6000, 'on from the keyframe, to the same world as the first time');
    assert.equal(again.checked, at6000.checked);
});

test('the newest request wins: a jump made during a long walk replaces it', NEEDS_GIT, async () => {
    const w = workerRealm();
    await init(w);
    const long = w.ctx.onmessage({ data: { type: 'to', step: 40000 } });   // not awaited: under way
    await w.ctx.onmessage({ data: { type: 'to', step: 1200 } });
    await long;
    await until(() => frames(w).length > 0);
    assert.equal(JSON.stringify(frames(w).map(f => f.step)), "[1200]", 'one answer, for the newest request');
    assert.ok(w.out.some(m => m.type === 'progress' && m.target === 40000), 'the long walk had begun');
});

test('left alone, the worker walks on ahead and keeps keyframes; a jump then is short', NEEDS_GIT, async () => {
    const w = workerRealm();
    await init(w, { indexAhead: true });
    const first = w.ctx.onmessage({ data: { type: 'to', step: 600 } });
    await until(() => w.out.some(m => m.type === 'indexed' && m.step >= 7200));
    const kept = w.run('keyframes.length');
    // A jump into what was walked ahead: restored from the keyframe at 7200, then 300 steps.
    const n = frames(w).length;
    w.ctx.onmessage({ data: { type: 'to', step: 7500 } });
    await until(() => frames(w).length > n);
    const f = frames(w)[frames(w).length - 1];
    assert.equal(f.step, 7500);
    assert.equal(f.ok, true, f.problem);
    assert.ok(f.indexed >= 7200 && kept >= 4);
    w.run('ahead = false');   // stop walking on, so the test ends
    await first;
});
