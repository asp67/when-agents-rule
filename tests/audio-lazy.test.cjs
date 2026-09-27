'use strict';
// Unmuting without the 3.4-second freeze (review #12): no sound is synthesized on the
// click; each is made on first use from the PRNG state it began from in the old eager
// order, so every sample is identical to before. If a synthesizer changes, the table in
// js/audio.js (WAR_AUDIO_SEEDS) must be regenerated with WarAudio.recordSeeds().
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');

function load() {
    let made = 0;
    const param = () => ({ value: 0, cancelScheduledValues() {}, setTargetAtTime(v) { this.value = v; } });
    const node = () => ({ gain: param(), pan: param(), frequency: param(), playbackRate: param(), connect(to) { this.to = to; }, disconnect() {}, start() {}, stop() { this.onended?.(); } });
    class Context {
        constructor() { this.currentTime = 0; this.state = 'suspended'; this.destination = {}; }
        createGain() { return node(); } createStereoPanner() { return node(); } createBiquadFilter() { return node(); } createBufferSource() { return node(); }
        createDynamicsCompressor() { return { ...node(), threshold: param(), knee: param(), ratio: param(), attack: param(), release: param() }; }
        createBuffer(ch, len, rate) { made++; const d = new Float32Array(len); return { getChannelData: () => d, sampleRate: rate, duration: len / rate }; }
        async resume() { this.state = 'running'; } async suspend() { this.state = 'suspended'; }
    }
    const scope = vm.createContext({ window: { AudioContext: Context }, document: { hidden: false, addEventListener() {} },
        sessionStorage: { getItem() {}, setItem() {}, removeItem() {} }, localStorage: { getItem() { return null; }, setItem() {} },
        console, Math, setTimeout, clearTimeout });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/audio.js'), 'utf8') + '\nthis.WarAudio = WarAudio; this.SEEDS = WAR_AUDIO_SEEDS;', scope);
    return { W: scope.WarAudio, SEEDS: scope.SEEDS, Context, made: () => made };
}

test('the seed table is what the synthesizers produce (regenerate it if they change)', () => {
    const { W, SEEDS, Context } = load();
    const s = new W({}); s.ctx = new Context();
    assert.deepEqual(JSON.parse(JSON.stringify(s.recordSeeds())), JSON.parse(JSON.stringify(SEEDS)),
        'WAR_AUDIO_SEEDS is stale: regenerate it with WarAudio.recordSeeds()');
});

test('unmuting makes no sound at all; a sound made later is sample-identical to the eager one', async () => {
    const { W, SEEDS, Context, made } = load();
    const s = new W({ renderer: {} });
    await s.setEnabled(true);
    assert.equal(made(), 0, 'nothing synthesized on the click');
    assert.equal(s.seed, SEEDS.after, 'play draws from where the eager init left it');
    // The old eager order, made here in full for reference.
    const ref = new W({}); ref.ctx = new Context(); ref.seed = W.SEED0;
    const eager = {};
    for (const kind of W.KINDS) eager[kind] = Array.from({ length: 4 }, () => Array.from(ref.makeBuffer(kind).getChannelData(0)));
    // Lazily, in any order, from a running game's PRNG state.
    s.random(); s.random();
    const before = s.seed;
    for (const [kind, i] of [['victory', 2], ['step', 0], ['warning', 3], ['crackle', 1], ['start', 0], ['defeat', 3]])
        assert.deepEqual(Array.from(s.buffers[kind][i].getChannelData(0)), eager[kind][i], kind + ' #' + i);
    assert.equal(s.seed, before, 'making a sound late does not change what play draws next');
    assert.equal(s.buffers.victory[2], s.buffers.victory[2], 'made once, kept');
});

test('an announcement plays its four variants in turn', async () => {
    const { W } = load();
    const s = new W({ renderer: {} });
    await s.setEnabled(true);
    s.active = () => true;
    const played = [];
    for (let k = 0; k < 5; k++) {
        s.ctx.currentTime += 5;
        const before = s.voices.size;
        s.notify('built', true);
        const v = [...s.voices].at(-1);
        played.push(s.buffers.built.indexOf ? [0, 1, 2, 3].find(i => s.buffers.built[i] === v.source.buffer) : null);
        v.source.onended?.();
        assert.ok(s.voices.size <= before + 1);
    }
    assert.deepEqual(played, [0, 1, 2, 3, 0]);
});

async function live(game = {}) {
    const { W } = load();
    const g = Object.assign({ renderer: { cameraTarget: { x: 0, z: 0 }, _halfH: 40, units: [], buildings: [] }, gameStarted: true, pauseState: 'running',
        fogOfWar: { isPositionCurrentlyVisible: () => true }, spectatorMode: false }, game);
    const s = new W(g);
    await s.setEnabled(true);
    s.active = () => true;
    return { s, g };
}

test('footsteps habituate -- quieter the longer a march goes on, down to half, back after quiet; nothing else does', async () => {
    const { s } = await live();
    // A dense march: a step every fifth of a second.
    const vol = kind => { s.ctx.currentTime += 0.2; s.cells.clear(); s.recent = []; assert.equal(s.emit(kind, { x: 0, z: 0 }, 0.2), true); const v = [...s.voices].at(-1); v.source.stop(); return v.volume; };
    const first = vol('step');
    let v = first;
    for (let i = 0; i < 60; i++) v = vol('step');
    assert.ok(v < first * 0.75, 'a long march is quieter: ' + v + ' vs ' + first);
    assert.ok(v >= first * 0.5 - 1e-9, 'never below half');
    s.ctx.currentTime += 30;
    assert.ok(vol('step') > v * 1.3, 'recovered after quiet');
    const a = vol('chop'), b = vol('chop');
    assert.equal(a, b, 'work sounds do not habituate');
});

test('work and movement have their own buses and levels', async () => {
    const { s } = await live();
    s.ctx.currentTime += 1; s.emit('chop', { x: 0, z: 0 }, 0.3);
    assert.equal([...s.voices].at(-1).pan.to, s.workBus);
    s.ctx.currentTime += 1; s.cells.clear(); s.recent = []; s.emit('step', { x: 0, z: 0 }, 0.2);
    assert.equal([...s.voices].at(-1).pan.to, s.moveBus);
    s.ctx.currentTime += 1; s.emit('steel', { x: 0, z: 0 }, 0.2);
    assert.equal([...s.voices].at(-1).pan.to, s.effects);
    s.setLevel('movement', 0.2); s.setLevel('work', 0.7);
    assert.equal(s.moveBus.gain.value, 0.2);
    assert.equal(s.workBus.gain.value, 0.7);
});

test('the Campaign horn sounds when your own are hit -- once in twenty seconds, never for spectators', async () => {
    const { s } = await live();
    const heard = [];
    const notify = s.notify.bind(s);
    s.notify = (kind, ...rest) => { heard.push(kind); return notify(kind, ...rest); };
    const enemy = { owner: 'ai_1', type: 'warrior' }, mine = { owner: 'player', unitType: 'infantry', x: 0, z: 0 };
    s.combat(enemy, mine);
    s.ctx.currentTime += 5; s.combat(enemy, mine);
    assert.deepEqual(heard.filter(k => k === 'underAttack'), ['underAttack']);
    s.ctx.currentTime += 21; s.combat(enemy, mine);
    assert.equal(heard.filter(k => k === 'underAttack').length, 2);
    s.combat({ owner: 'player', type: 'warrior' }, { owner: 'ai_1', unitType: 'infantry', x: 0, z: 0 });
    assert.equal(heard.filter(k => k === 'underAttack').length, 2, 'hitting them is not being hit');
    const spec = await live({ spectatorMode: true });
    const h2 = []; spec.s.notify = k => h2.push(k);
    spec.s.combat(enemy, mine);
    assert.deepEqual(h2, []);
});

test('a new age sounds its stinger, once per change', async () => {
    const ai = { age: 'stone', civilization: 'greek', units: [], buildings: [] };
    const { s } = await live({ spectatorMode: true, aiManager: { aiPlayers: [ai] }, isPlayerEliminated: () => false });
    const heard = []; s.notify = (k, p, c) => heard.push([k, c && c.age]);
    s.matchEvents(); s.matchEvents();
    ai.age = 'neolithic'; s.matchEvents(); s.matchEvents();
    assert.deepEqual(heard.filter(h => h[0] === 'ageUp'), [['ageUp', 'neolithic']]);
});
