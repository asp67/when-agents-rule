// The draw-call diet (overhaul step A4), third step: a unit's bones are in its vertices. A
// unit was a draw per material and bone, sixteen to twenty of them and each twice with the
// shadow pass; it is a draw per material now, and one for its shadow.
const test = require('node:test'), assert = require('node:assert/strict');
const vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
const src = f => fs.readFileSync(path.join(__dirname, '../js/engine/' + f + '.js'), 'utf8');

function load() {
    const scope = { window: {}, console, performance: { now: () => 1000 } }; scope.window.window = scope.window; vm.createContext(scope);
    for (const f of ['math3d', 'mesh', 'texgen', 'buildings', 'units', 'atmosphere']) vm.runInContext(src(f), scope);
    let made = 0;
    scope.window.GLCore = { createMeshBuffers: (gl, mesh) => ({ id: ++made, mesh }), createShadowBuffers: (gl, mesh) => ({ id: ++made, mesh, shadowOnly: true }),
        drawMesh: (gl, prog, buf) => gl.drawn.push(buf) };
    vm.runInContext('Object.assign(globalThis, window);' + src('gamerenderer'), scope);
    return { W: scope.window, R: vm.runInContext('window.EngineRenderer', scope), scope };
}
const UNITS = [['worker', 'worker', 'greek'], ['infantry', 'militia', 'greek'], ['infantry', 'champion', 'greek'], ['ranged', 'archer', 'egyptian'],
    ['cavalry', 'cavalry', 'persian'], ['cavalry', 'scout', 'maya'], ['priest', 'priest', 'yamato'], ['infantry', 'champion', 'yamato']];
const partsOf = (W, [type, unit, civ]) => W.EngineUnits.parts(type, { civ, unit, badge: 'circle', variant: 0, coat: 0 });
const count = (W, p) => W.EngineMesh[p.kind](...p.args).positions.length / 3;

test('a unit is a mesh per material with the bone of every vertex in it: fewer draws, the same geometry', () => {
    const { W } = load(), U = W.EngineUnits;
    for (const which of UNITS) {
        const parts = partsOf(W, which), old = U.batches(parts), now = U.skinned(parts), name = which.join('/');
        assert.ok(now.batches.length <= old.length * 0.72, `${name}: ${old.length} draws were, ${now.batches.length} are`);
        assert.ok(now.batches.length <= 14, name + ': ' + now.batches.length);
        const verts = list => list.reduce((n, b) => n + b.mesh.positions.length / 3, 0);
        assert.equal(verts(now.batches), verts(old), name + ': every vertex');
        // Each vertex hangs on the bone its part hung on. Counted per bone name, both ways.
        const want = {}, got = {};
        for (const p of parts) want[p.bone || ''] = (want[p.bone || ''] || 0) + count(W, p);
        for (const b of now.batches) {
            assert.equal(b.mesh.bones.length, b.mesh.positions.length / 3);
            for (const i of b.mesh.bones) { const bone = i === 0 ? '' : now.bones[i - 1]; got[bone] = (got[bone] || 0) + 1; }
        }
        assert.deepEqual(got, want, name);
        assert.ok(now.bones.length >= 4 && now.bones.length <= U.MAX_BONES, name + ': ' + now.bones);
        // The shadow's shape: every solid part, none of the see-through, with the same bone numbers.
        const solid = parts.filter(p => !p.blend);
        assert.equal(now.caster.positions.length / 3, solid.reduce((n, p) => n + count(W, p), 0), name);
        assert.equal(now.caster.bones.filter(i => i > 0).length, solid.filter(p => p.bone).reduce((n, p) => n + count(W, p), 0), name);
        // The badge is printed into the fabric the same way as before.
        const badgeOld = old.filter(b => b.badgePaint), badgeNow = now.batches.filter(b => b.badgePaint);
        assert.equal(badgeNow.length, 1, name + ': one painted batch');
        assert.equal(badgeNow[0].mesh.uvs.length, badgeOld.reduce((n, b) => n + b.mesh.uvs.length, 0));
        assert.ok(badgeNow[0].mesh.uvs.every(Number.isFinite));
    }
});

test('no unit of any kind has more bones than the shader holds; one that had would say so', () => {
    const { W } = load(), U = W.EngineUnits, f = W.EngineAtmosphere;
    let most = 0, models = 0;
    for (const type of U.TYPES) for (const civ of ['greek', 'egyptian', 'yamato', 'persian', 'maya', 'roman', 'celtic', 'chinese'])
        for (const unit of ['worker', 'militia', 'warrior', 'hoplite', 'phalanx', 'champion', 'archer', 'crossbowman', 'elite_archer', 'cavalry', 'scout_cavalry', 'scout', 'spotter', 'priest', 'engineer', 'chariot']) {
            let parts; try { parts = U.parts(type, { civ, unit, badge: 'circle', variant: 0, coat: 0 }); } catch (e) { continue; }
            if (!parts.length) continue;
            most = Math.max(most, U.skinned(parts).bones.length); models++;
        }
    assert.ok(models > 100 && most >= 7 && most <= U.MAX_BONES, models + ' models, at most ' + most + ' bones');
    // The shaders hold one matrix more than that: number 0 is "no bone".
    for (const text of [f.vertex, f.shadowVertex]) assert.match(text, new RegExp('uniform mat4 uBones\\[' + (U.MAX_BONES + 1) + '\\];'));
    const tooMany = Array.from({ length: U.MAX_BONES + 1 }, (_, i) => ({ kind: 'box', args: [1, 1, 1], tex: 'white', bone: 'b' + i, m: W.M3D.identity() }));
    assert.throws(() => U.skinned(tooMany), /bones; the shader holds 12/);
    // A trebuchet on wheels is a unit too: its arm and its stone.
    const treb = U.skinned(W.EngineBuildings.parts('trebuchet', { age: 'bronze', civ: 'greek' }));
    assert.deepEqual(Array.from(treb.bones).sort(), ['arm', 'stone']);
});

test('the shaders move a vertex by its bone and then by the unit; a mesh without bones is drawn as it always was', () => {
    const { W } = load(), f = W.EngineAtmosphere;
    assert.match(f.vertex, /attribute float aBone;/);
    assert.match(f.vertex, /vec4 local = vec4\(aPosition, 1\.0\);\s+vec3 normal = aNormal;\s+if \(uSkin > 0\.5\) \{\s+mat4 bone = uBones\[int\(aBone \+ 0\.5\)\];\s+local = bone \* local;\s+normal = mat3\(bone\) \* normal;[^\n]*\n\s+\}\s+vec4 world = uModel \* local;/);
    assert.match(f.vertex, /vNormal = basis \* \(normal \/ max\(scale2, vec3\(0\.00001\)\)\);/);
    assert.match(f.shadowVertex, /if \(uSkin > 0\.5\) local = uBones\[int\(aBone \+ 0\.5\)\] \* local;\s+gl_Position = uLightMatrix\*uModel\*local;/);
    // What that sum does, in numbers: a bone's matrix first, the unit's after. It is what a draw per
    // bone did with one matrix (the unit's times the bone's).
    const m3 = W.M3D, bone = m3.rotateAround(m3.rotationX(0.6), 0, 1.2, 0), unit = m3.multiply(m3.translation(40, 0, -7), m3.rotationY(1.1));
    const at = (m, v) => [0, 1, 2].map(r => m[r] * v[0] + m[4 + r] * v[1] + m[8 + r] * v[2] + m[12 + r]);
    const v = [0.3, 0.4, -0.2], twoSteps = at(unit, at(bone, v)), oneMatrix = at(m3.multiply(unit, bone), v);
    twoSteps.forEach((x, i) => assert.ok(Math.abs(x - oneMatrix[i]) < 1e-4, x + ' against ' + oneMatrix[i]));   // the engine's matrices are 32-bit
});

test('the plumbing: a bone buffer only where a mesh has bones, and the position stays attribute 0', () => {
    const scope = { window: {}, console }; vm.createContext(scope);
    vm.runInContext(src('glcore'), scope);
    const G = scope.window.GLCore, log = [];
    const gl = new Proxy({}, { get: (t, k) => typeof k === 'string' && /^[A-Z][A-Z0-9_]*$/.test(k) ? k
        : k === 'getExtension' ? () => null : k === 'createVertexArray' ? undefined
        : (...a) => { log.push(k + '(' + a.map(x => (x && x.name) || (ArrayBuffer.isView(x) ? x.constructor.name + x.length : x)).join(',') + ')'); return k === 'createBuffer' ? { name: 'buf' + log.length } : k === 'getProgramParameter' ? (a[1] === 'LINK_STATUS' ? true : 0) : k === 'getShaderParameter' ? true : {}; } });
    const plain = G.createMeshBuffers(gl, { positions: [0, 0, 0], normals: [0, 1, 0], uvs: [0, 0], indices: [0, 0, 0] });
    assert.equal(plain.bone, null);
    const rigged = G.createMeshBuffers(gl, { positions: [0, 0, 0], normals: [0, 1, 0], uvs: [0, 0], indices: [0, 0, 0], bones: new Float32Array([3]) });
    assert.ok(rigged.bone);
    const prog = { attribs: { aPosition: 0, aNormal: 1, aUv: 2, aBone: 3 } };
    log.length = 0;
    G.pointMesh(gl, prog, rigged);
    assert.ok(log.includes('enableVertexAttribArray(3)') && log.includes('vertexAttribPointer(3,1,FLOAT,false,0,0)'));
    log.length = 0;
    G.pointMesh(gl, prog, plain);
    assert.ok(log.includes('disableVertexAttribArray(3)') && !log.includes('enableVertexAttribArray(3)'), 'no array: every vertex is bone 0');
    log.length = 0;
    G.deleteMeshBuffers(gl, rigged);
    assert.equal(log.filter(l => l.startsWith('deleteBuffer')).length, 5);
    // Linked with the position at 0, so an attribute that is often a constant can never land there.
    log.length = 0;
    G.compileProgram(gl, 'v', 'f');
    const bind = log.findIndex(l => l.includes("bindAttribLocation(") && l.includes(',0,aPosition)')), link = log.findIndex(l => l.startsWith('linkProgram'));
    assert.ok(bind >= 0 && bind < link, log.filter(l => /Attrib|link/.test(l)).join(' '));
});

// ---- the renderer ----------------------------------------------------------------------
function rig() {
    const { W, R, scope } = load();
    const r = Object.create(R.prototype), m3 = W.M3D;
    const walker = { x: 10, z: 20, health: 5, maxHealth: 5, isMoving: true, mesh: { visible: true } };
    Object.assign(r, { gl: {}, units: [walker], buildings: [], graphicsQuality: 'balanced', visualStyle: 'classic', WHITE: [1, 1, 1], tex: new Proxy({}, { get: (o, k) => (o[k] = o[k] || { name: k }) }),
        _unitDir: new WeakMap(), _unitPrev: new WeakMap(), _ghosts: [], _dustPool: [], _projectiles: [], _rubble: [], _rings: [], _halfH: 30, cameraTarget: { x: 10, z: 20 },
        _buf: (kind, args) => ({ kind, args }), _cull: () => false, _refreshIdentity() {}, _frameNo: 0, _dl: { opaque: [], blended: [], bars: [], casters: [] } });
    const model = r._unitModel(partsOf(W, ['infantry', 'hoplite', 'greek']));
    const entries = model.skin.map(p => ({ buf: p.buf, tex: r.tex[p.texName], tint: r.WHITE, base: m3.identity(), bone: null, blend: p.blend, model: m3.identity(), skin: true }));
    walker._engine = Object.assign(r._unitRig(model), { type: 'infantry', entries, phase: 0.4, far: () => [{ buf: { far: true }, tex: {}, tint: r.WHITE, base: m3.identity(), bone: null, blend: false, model: m3.identity(), skin: false }] });
    return { r, W, walker, model, m3, frame: (t = 3) => r._assembleFrame(t, 0.016, m3.identity()) };
}

test('in a frame a unit sends its pose as bone matrices, is moved as a whole, and casts as one shape', () => {
    const { r, W, walker, model, m3, frame } = rig(), ue = walker._engine;
    assert.deepEqual([model.skin.length < 12, Array.from(model.bones), !!model.caster, model.cpu.length > model.skin.length], [true, ['legL', 'armL', 'legR', 'armR'], true, true]);
    assert.deepEqual(Array.from(ue.boneMats.slice(0, 16)), Array.from(m3.identity()), 'bone 0 is no bone');
    frame();
    const pose = W.EngineUnits.pose('infantry', 'walk', 3, 0.4, { strike: null, stride: ue.stride });
    ue.boneNames.forEach((name, k) => assert.deepEqual(Array.from(ue.boneMats.slice((k + 1) * 16, (k + 2) * 16)), Array.from(pose.mats[name] || m3.identity()), name));
    assert.notDeepEqual(Array.from(ue.boneMats.slice(16, 32)), Array.from(m3.identity()), 'a walking leg is turned');
    assert.deepEqual(Array.from(ue.boneMats.slice(0, 16)), Array.from(m3.identity()));
    // Every solid batch: the unit's own matrix, the unit's bones, and no shadow of its own.
    const solid = r._dl.opaque.filter(e => e.bones);
    assert.equal(solid.length, model.skin.filter(p => !p.blend).length);
    assert.ok(solid.every(e => e.bones === ue.boneMats && e.noShadow === true && e.model === solid[0].model));
    assert.deepEqual([solid[0].model[12], solid[0].model[14]], [10, 20]);
    // The shadow: one entry, the same matrix, the same bones.
    assert.equal(r._dl.casters.length, 1);
    assert.deepEqual([r._dl.casters[0].buf === model.caster, r._dl.casters[0].bones === ue.boneMats, r._dl.casters[0].model === solid[0].model], [true, true, true]);
    // The blob under its feet lies flat and is see-through; it has no bone but rides in a rigged batch.
    assert.ok(r._dl.blended.some(e => e.bones === ue.boneMats && e.model !== solid[0].model));
});

test('a remembered unit, a far one and a fallen one', () => {
    const { r, walker, model, frame } = rig(), ue = walker._engine;
    // Faded (the analyzer's memory of a position): all of it see-through, nothing cast.
    walker._fade = 0.4;
    frame();
    assert.deepEqual([r._dl.opaque.filter(e => e.bones).length, r._dl.casters.length, r._dl.blended.filter(e => e.bones && e.alpha === 0.4).length], [0, 0, model.skin.length]);
    walker._fade = null;
    // From far up: the model merged at rest, no bones, and it casts for itself as it always did.
    r._halfH = 400;
    frame();
    const far = r._dl.opaque.filter(e => e.buf && e.buf.far);
    assert.deepEqual([far.length, far[0].bones, far[0].noShadow, r._dl.casters.length], [1, null, false, 0]);
    r._halfH = 30;
    // It falls in the pose it had: the bones are copied once, and stay as they were while the corpse sinks.
    frame();
    const before = Array.from(ue.boneMats);
    r._ghostFrom(walker, 'unit');
    const ghost = r._ghosts[0];
    assert.ok(ghost.entries.every(e => e.bones && e.bones !== ue.boneMats) && new Set(ghost.entries.map(e => e.bones)).size === 1);
    ue.boneMats.fill(9);
    assert.deepEqual(Array.from(ghost.entries[0].bones), before);
    r.units = [];
    frame();
    assert.ok(r._dl.blended.length === ghost.entries.length && r._dl.blended.every(e => e.bones === ghost.entries[0].bones && e.alpha < 1));
});

test('a unit\'s bones are sent to the card once, whatever the number of its batches', () => {
    const { r } = rig(), sent = [];
    const gl = new Proxy({ drawn: [] }, { get: (t, k) => k in t ? t[k] : typeof k === 'string' && /^[A-Z][A-Z0-9_]*$/.test(k) ? k
        : (...a) => { if (k === 'uniformMatrix4fv' && a[0] === 'uBones') sent.push('bones ' + a[2].tag); if (k === 'uniform1f' && a[0] === 'uSkin') sent.push('skin ' + a[1]); } });
    const A = Object.assign(new Float32Array(16), { tag: 'A' }), B = Object.assign(new Float32Array(16), { tag: 'B' });
    const e = (bones) => ({ buf: {}, tex: {}, model: [], bones });
    Object.assign(r, { gl, prog: { uniforms: new Proxy({}, { get: (t, k) => k }) }, sunDir: [0, 1, 0], _sky: [0, 0, 0], _sun: [1, 1, 1], visualStyle: 'cinematic',
        _dl: { opaque: [e(null), e(null), e(A), e(A), e(A), e(B), e(B), e(null), e(A)], blended: [e(A), e(null)], bars: [], casters: [] } });
    r._drawPicture({ view: [], proj: [], haze: [0, 1], eye: [0, 0, 0] }, { night: 0, key: [1, 1, 1], fillHigh: [0, 0, 0], fillLow: [0, 0, 0], grade: [1, 1, 1, 1], rim: 1 }, 0, [0, 0, 10, 10], false);
    assert.deepEqual(sent, ['skin 0', 'bones A', 'skin 1', 'bones B', 'skin 0', 'bones A', 'skin 1',      // the solid list
        'bones A', 'skin 1', 'skin 0']);                                                                   // the see-through list starts afresh; no bars here, nothing sent for them
    // The shadow pass: boneless first, then the casters, a unit's with its bones.
    sent.length = 0; gl.drawn.length = 0;
    Object.assign(r, { shadowProg: { uniforms: new Proxy({}, { get: (t, k) => k }) }, _shadowTarget: { size: 1024, framebuffer: {} }, _halfH: 40, cameraTarget: { x: 0, z: 0 } });
    r._dl = { opaque: [{ buf: 'pole', model: [] }, { buf: 'unit batch', model: [], noShadow: true, bones: A }], blended: [], bars: [],
        casters: [{ buf: 'house', model: [] }, { buf: 'unit A', model: [], bones: A }, { buf: 'unit B', model: [], bones: B }, { buf: 'tower', model: [] }] };
    r._renderShadows();
    assert.deepEqual(gl.drawn, ['pole', 'house', 'unit A', 'unit B', 'tower']);
    assert.deepEqual(sent, ['skin 0', 'bones A', 'skin 1', 'bones B', 'skin 0']);
});

// ---- one shared texture at middle distance (built off in 1183, on since 1184) ---------------
test('at middle distance a unit\'s plain materials share one texture: merged with their bones, and it can be switched off', () => {
    const { r, W, walker, model, m3, frame } = rig(), ue = walker._engine;
    r.gl = new Proxy({}, { get: (t, k) => typeof k === 'string' && /^[A-Z][A-Z0-9_]*$/.test(k) ? k : () => ({}) });
    r.tex = new Proxy({}, { get: (o, k) => (o[k] = o[k] || { name: k, _avg: [120, 90, 60] }) });
    r._unitModels = new Map([['k', model]]);
    const mid = r._unitMidModel('k');
    const plain = model.skin.filter(p => !p.team && !p.accent && !p.blend && !p.badgePaint), kept = model.skin.filter(p => !plain.includes(p));
    assert.ok(plain.length >= 4, plain.length + ' plain materials: ' + plain.map(p => p.texName));
    assert.equal(mid.length, kept.length + 1, `${model.skin.length} draws near, ${mid.length} at middle distance`);
    assert.ok(mid.length <= 6);
    // The merged batch: every vertex of the plain materials, each still on its bone, each reading its
    // material's own colour from the palette.
    const merged = mid[0].buf.mesh, corners = plain.reduce((n, p) => n + model.meshes[model.skin.indexOf(p)].positions.length / 3, 0);
    assert.deepEqual([mid[0].palette, merged.positions.length / 3, merged.bones.length], [true, corners, corners]);
    const bonesWere = Array.from(plain).flatMap(p => Array.from(model.meshes[model.skin.indexOf(p)].bones));   // Array.from: these lists live in the engine's realm
    assert.deepEqual(Array.from(merged.bones), bonesWere);
    const slots = new Set(); for (let i = 0; i < merged.uvs.length; i += 2) { slots.add(merged.uvs[i]); assert.equal(merged.uvs[i + 1], 0.5); }
    assert.equal(slots.size, new Set(plain.map(p => p.texName)).size, 'a colour per material');
    // What the seat tints, the badge and the blob under the feet are the same batches as up close.
    assert.ok(mid.length - 1 === kept.length && kept.every((p, i) => mid[i + 1] === p));
    assert.equal(r._unitMidModel('k'), mid, 'built once per model');

    // In the frame: only where the switch is on, only between the two heights.
    const wrap = list => list.map(p => ({ buf: p.buf, tex: {}, tint: r.WHITE, base: m3.identity(), bone: null, blend: p.blend, model: m3.identity(), skin: true }));
    ue.mid = () => wrap(mid);
    const drawn = () => { frame(); return ue.drawn === ue.entries ? 'near' : ue.drawn === ue.midEntries ? 'mid' : 'far'; };
    const MID = W.EngineRenderer.MID_UNIT_HALF_H, FAR = W.EngineRenderer.FAR_UNIT_HALF_H;
    assert.ok(MID > 20 && MID < FAR);
    r._halfH = MID + 20;
    r.unitPalette = false;
    assert.equal(drawn(), 'near', 'off: every material its own texture, as it was');
    r.unitPalette = true;
    assert.equal(drawn(), 'mid');
    assert.ok(r._dl.opaque.filter(e => e.bones === ue.boneMats).length === mid.filter(p => !p.blend).length && r._dl.casters.length === 1, 'it still walks, and still casts');
    r._halfH = MID - 1;
    assert.equal(drawn(), 'near', 'up close every material has its own texture');
    r._halfH = FAR + 50;
    assert.equal(drawn(), 'far');
    // A trebuchet on wheels has no such model and is drawn as it is.
    delete ue.mid; r._halfH = MID + 20;
    assert.equal(drawn(), 'near');
    // On since asp67 saw it side by side with what was (22 Nov 2026).
    assert.match(src('gamerenderer'), /this\.unitPalette = true;/);
});
