// EngineRenderer — the game's renderer, in-house since M6 (it replaced the
// Three.js GameRenderer as a drop-in at M4, and the old path is now retired):
// same public methods, same entity bookkeeping, same embedded sim duties (AI
// unit movement lerp, separation, building clearance — game correctness
// depends on them), drawn by our own WebGL pipeline: locked dimetric camera,
// procedural textures, EngineBuildings/EngineUnits compositions, fog plane.
//
// Compatibility shims (the freeze line, documented in ENGINE.md):
// - this.renderer = { domElement, setSize, render } — input.js binds events to
//   renderer.renderer.domElement; render() is a no-op (we self-drive).
// - this.scene = { add, remove } no-ops — legacy callers (e.g. game.js death
//   cleanup) may still hand it objects; nothing needs a scene graph anymore.
// - this.camera / this.cameraTarget accept the game's position.set/lookAt
//   calls; distance from target maps onto the ortho zoom.
// - Entity handles: unit.mesh = {visible, position, rotation}, unit.healthBar =
//   {material:{color:{setHex}}}, building.mesh = {visible, children: []} — the
//   exact property surface game.js/fogofwar.js touch, all inert; the engine
//   derives visuals from entity state each frame instead. Fog hands us its
//   display canvas + a fogDirty flag; we own the texture and the fog plane.
(function () {
    const M = () => window.M3D;
    const HALF_PER_DIST = 0.3;   // camera.position.set(distance) → ortho halfH
    const MIN_HALF = 10, MAX_HALF = 190;
    const BSCALE = 0.78;         // engine building set → game footprint scale

    class EngineRenderer {
        constructor(container) {
            this.container = container;
            this.game = null;         // back-reference, set by game.js
            this.units = [];
            this.buildings = [];
            this.selectedUnits = [];
            this.selectedBuilding = null;
            this.terrain = null;
            this.isPlacingBuilding = false;
            this.placingBuildingType = null;
            this.buildingPreview = null; // {type, x, z, big} while placing
            this.cameraPosition = { x: 0, y: 80, z: 80 };
            this.minZoom = 32;
            this.maxZoom = 620;
            this.cameraPanSpeed = 0.8;
            this.keysPressed = {};
            this._marqueeEl = null;
            this._halfH = 34;
            this._yaw = Math.PI / 4;          // middle-drag horizontal turns the map
            this._pitch = Math.atan(0.5);     // middle-drag vertical tilts (10°..89°)
            this._panDrag = null;
            this._rotateDrag = null;
            this._projectiles = [];
            this._rings = [];
            this._ghosts = [];
            this._dustPool = [];
            this._bannerTex = new Map();
            this._lastTime = performance.now();

            // canvas + GL
            const W = container.clientWidth || window.innerWidth || 1280;
            const H = container.clientHeight || window.innerHeight || 720;
            const canvas = document.createElement('canvas');
            canvas.width = W; canvas.height = H;
            canvas.style.display = 'block';
            container.appendChild(canvas);
            this.canvas = canvas;
            this.W = W; this.H = H;
            this.gl = GLCore.createContext(canvas, { preserveDrawingBuffer: true });

            // inner-renderer + scene shims (see header)
            this.renderer = {
                domElement: canvas,
                setSize: (w, h) => { this.W = w; this.H = h; canvas.width = w; canvas.height = h; },
                setPixelRatio: () => {},
                render: () => {}
            };
            this.scene = { add: () => {}, remove: () => {} };

            // camera shims: any position/lookAt intent becomes ortho zoom + target
            const self = this;
            this.cameraTarget = {
                x: 0, y: 0, z: 0,
                set(x, y, z) { this.x = x; this.y = y || 0; this.z = z; }
            };
            this.camera = {
                aspect: W / H,
                position: {
                    x: 0, y: 80, z: 80,
                    set(x, y, z) { this.x = x; this.y = y; this.z = z; self._zoomFromPosition(); }
                },
                lookAt: () => self._zoomFromPosition(),
                updateProjectionMatrix: () => {}
            };

            const VS = `
                attribute vec3 aPosition;
                attribute vec3 aNormal;
                attribute vec2 aUv;
                uniform mat4 uProj, uView, uModel;
                uniform vec2 uUvOffset;   // slow drift for foam/water
                varying vec3 vNormal;
                varying vec2 vUv;
                void main() {
                    vNormal = mat3(uModel) * aNormal;
                    vUv = aUv + uUvOffset;
                    gl_Position = uProj * uView * uModel * vec4(aPosition, 1.0);
                }`;
            const FS = `
                precision mediump float;
                uniform sampler2D uTex;
                uniform vec3 uSunDir, uSunColor, uAmbient, uTint;
                uniform float uUnlit;
                uniform float uAlpha;     // fades: ghosts, dust, foam pulse
                varying vec3 vNormal;
                varying vec2 vUv;
                void main() {
                    vec4 t = texture2D(uTex, vUv);
                    vec3 base = t.rgb * uTint;
                    vec3 n = normalize(vNormal);
                    vec3 light = uAmbient + uSunColor * max(dot(n, uSunDir), 0.0);
                    gl_FragColor = vec4(mix(base * light, base, uUnlit), t.a * uAlpha);
                }`;
            this.prog = GLCore.compileProgram(this.gl, VS, FS);
            this.sunDir = M().normalize([-0.35, 0.9, 0.45]);

            this._geo = new Map();          // 'kind:args' → GPU buffers
            this._resEntries = new WeakMap(); // resource → prebaked entries
            this._unitDir = new WeakMap();    // unit → smoothed facing
            this.tex = null;                  // built on setTerrain (theme-aware)
            this._theme = null;
            this._fogTex = null;              // GL texture wrapping the fog canvas
            this._fogCanvas = null;
            this._dl = { opaque: [], blended: [], bars: [] }; // per-frame lists
            this.WHITE = [1, 1, 1];

            window.addEventListener('resize', () => this.onWindowResize());
            canvas.addEventListener('mousedown', (e) => this.onCanvasMouseDown(e));
            canvas.addEventListener('mousemove', (e) => this.onCanvasMouseMove(e));
            canvas.addEventListener('mouseup', (e) => this.onCanvasMouseUp(e));
            canvas.addEventListener('contextmenu', (e) => e.preventDefault());
            canvas.addEventListener('wheel', (e) => this.onCanvasWheel(e), { passive: false });
            document.addEventListener('keydown', (e) => this.onKeyDown(e));
            document.addEventListener('keyup', (e) => this.onKeyUp(e));

            this._buildTextures('summer');
            this.animate();
        }

        // ---- materials -------------------------------------------------------
        _buildTextures(theme) {
            if (this._theme === theme && this.tex) return;
            this._theme = theme;
            const gl = this.gl;
            const canopyBase = theme === 'winter' ? [58, 92, 66]
                : (theme === 'desert' ? [110, 116, 62] : [74, 112, 58]);
            const T = (c, o) => GLCore.createTextureFromCanvas(gl, c, o);
            this.tex = {
                terrain: T(TexGen.terrain(theme, 12345, 2048, 1000, 400), { clamp: true }),
                masonry: T(TexGen.masonry(22)),
                wood: T(TexGen.wood(33)),
                bark: T(TexGen.bark(44)),
                foliage: T(TexGen.foliage(55, canopyBase)),
                berries: T(TexGen.foliage(66, [64, 100, 52], { berries: true })),
                rock: T(TexGen.rock(77)),
                gold: T(TexGen.rock(88, { gold: true })),
                plaster: T(TexGen.plaster(99)),
                thatch: T(TexGen.thatch(111)),
                rooftile: T(TexGen.rooftile(122)),
                awning: T(TexGen.awning(133)),
                field: T(TexGen.field(144, 128, 'rows')),
                field_dirt: T(TexGen.field(144, 128, 'dirt')),
                field_patchy: T(TexGen.field(144, 128, 'patchy')),
                shadow: T(TexGen.shadowBlob(), { clamp: true }),
                cloth: T(TexGen.cloth(155)),
                skin: T(TexGen.skin(166)),
                leather: T(TexGen.leather(177)),
                iron: T(TexGen.iron(188)),
                white: T(TexGen.solid(), { clamp: true }),
                ghost: T(TexGen.solid(255, 255, 255, 115), { clamp: true }),
                ring: T(TexGen.ring(), { clamp: true }),
                foam: T(TexGen.foam(199))
            };
            // theme atmosphere: beyond-the-map "sky" (deep sea) + sun character
            this._sky = theme === 'winter' ? [0.10, 0.20, 0.29]
                : (theme === 'desert' ? [0.12, 0.30, 0.36] : [0.086, 0.212, 0.329]);
            this._sun = theme === 'winter' ? [0.74, 0.78, 0.88]
                : (theme === 'desert' ? [0.95, 0.84, 0.60] : [0.85, 0.78, 0.66]);
        }

        _buf(kind, args) {
            const key = kind + ':' + args.join(',');
            if (!this._geo.has(key)) {
                this._geo.set(key, GLCore.createMeshBuffers(this.gl, EngineMesh[kind](...args)));
            }
            return this._geo.get(key);
        }

        // ---- camera ----------------------------------------------------------
        _zoomFromPosition() {
            const p = this.camera.position, t = this.cameraTarget;
            const dist = Math.hypot(p.x - t.x, p.y - t.y, p.z - t.z) || 100;
            this._halfH = Math.max(MIN_HALF, Math.min(MAX_HALF, dist * HALF_PER_DIST));
        }

        _computeCam() {
            const m3 = M();
            const aspect = (this.W || 1) / (this.H || 1);
            // Narrow-FOV perspective: the eye sits far enough away that the frame
            // still covers ±halfH world units at the target — same zoom feel as
            // the old ortho, minus its reverse-perspective illusion at max zoom.
            const FOVY = 20 * Math.PI / 180;
            const tanHalf = Math.tan(FOVY / 2);
            const dist = this._halfH / tanHalf;
            const cam = m3.dimetricView(this.cameraTarget.x, this.cameraTarget.z, dist, this._yaw, this._pitch);
            const v = cam.view;
            this._cam = {
                view: v, eye: cam.eye, dir: cam.dir,
                right: [v[0], v[4], v[8]],
                up: [v[1], v[5], v[9]],
                halfH: this._halfH,
                halfW: this._halfH * aspect,
                tanHalf, aspect, dist,
                // Generous clip slack: at low pitch the visible ground stretches far
                // past the look-at point (and close under the eye) — the tighter
                // planes made units pop out of sight at the frame edges.
                proj: m3.perspective(FOVY, aspect, Math.max(2, dist - 1400), dist + 2200)
            };
            return this._cam;
        }

        moveCameraTo(x, z) {
            const sx = this.cameraTarget.x, sz = this.cameraTarget.z;
            const start = performance.now();
            const step = () => {
                const k = Math.min(1, (performance.now() - start) / 500);
                this.cameraTarget.x = sx + (x - sx) * k;
                this.cameraTarget.z = sz + (z - sz) * k;
                if (k < 1) requestAnimationFrame(step);
            };
            step();
        }

        animateCamera(x, y, z) { this.moveCameraTo(x, z - 80); }

        setSize(width, height) {
            if (width > 0 && height > 0) {
                this.camera.aspect = width / height;
                this.renderer.setSize(width, height);
            }
        }

        onWindowResize() {
            this.setSize(this.container.clientWidth, this.container.clientHeight);
        }

        // ---- terrain ---------------------------------------------------------
        setTerrain(terrain) {
            this.terrain = terrain;
            const theme = terrain.difficulty === 'medium' ? 'winter'
                : (terrain.difficulty === 'hard' ? 'desert' : 'summer');
            this._buildTextures(theme);
            this._ground = {
                buf: this._buf('gridPlane', [1000, 1, 1]),
                tex: this.tex.terrain, model: M().identity()
            };
            // Replace THREE resource meshes with engine handles: fog toggles
            // handle.visible, depletion nulls res.mesh — both drive our draw.
            this._resEntries = new WeakMap();
            (terrain.resources || []).forEach(res => {
                res.mesh = res.type === 'wood'
                    ? { trunk: { visible: true }, leaves: { visible: true } }
                    : { visible: true };
            });
            // shoreline foam: four surf strips just past the coast band, pulsing
            // and drifting (alpha/uvOff animated per frame). The x-side strips are
            // shortened by the strip WIDTH so they butt against the z-side strips
            // instead of crossing them (the corners used to double up and glow).
            const m3 = M();
            const LH = 401.5, FW = 7;
            const longBuf = this._buf('quad', [2 * LH + FW, FW, 46]);
            const shortBuf = this._buf('quad', [2 * LH - FW - 2, FW, 45]);
            const flat = (x, z, ry) => m3.multiply(
                m3.multiply(m3.translation(x, 0.18, z), m3.rotationY(ry)),
                m3.rotationX(-Math.PI / 2));
            this._foam = [
                { buf: longBuf, tex: this.tex.foam, tint: this.WHITE, model: flat(0, LH, 0) },
                { buf: longBuf, tex: this.tex.foam, tint: this.WHITE, model: flat(0, -LH, 0) },
                { buf: shortBuf, tex: this.tex.foam, tint: this.WHITE, model: flat(LH, 0, Math.PI / 2) },
                { buf: shortBuf, tex: this.tex.foam, tint: this.WHITE, model: flat(-LH, 0, Math.PI / 2) }
            ];

            // Ambient ground cover: real 3D shrubbery again — the flecks painted
            // into the mega-texture were too subtle alone and the map read bleak.
            // Prebaked entries, themed, seeded (a map seed reproduces the scatter),
            // drawn only below halfH 90 (sub-pixel beyond) and culled per prop.
            let pSeed = 424242;
            if (terrain.seed != null && terrain.seed !== '') {
                pSeed = 0;
                for (const ch of String(terrain.seed)) pSeed = (pSeed * 31 + ch.charCodeAt(0)) >>> 0;
            }
            const rng = TexGen.rng(pSeed);
            const props = [];
            const HALF = 340; // keep off the beach ring
            const TRSp = (x, y, z, sx, sy, sz, ry) => {
                let m = m3.translation(x, y, z);
                if (ry) m = m3.multiply(m, m3.rotationY(ry));
                return m3.multiply(m, m3.scaling(sx, sy, sz));
            };
            const prop = (kind, args, tex, tint, x, y, z, sx, sy, sz, ry) =>
                props.push({ buf: this._buf(kind, args), tex: this.tex[tex], tint, model: TRSp(x, y, z, sx, sy, sz, ry), x, z });
            const bush = (snowCap) => {
                const x = (rng() * 2 - 1) * HALF, z = (rng() * 2 - 1) * HALF;
                const s = 0.45 + rng() * 0.5;
                prop('sphere', [1, 7, 5], 'foliage', this.WHITE, x, s * 0.5, z, s, s * 0.55, s, rng() * 6.28);
                if (rng() < 0.7) {
                    const a = rng() * 6.28, d = s * 0.8, s2 = s * (0.45 + rng() * 0.3);
                    prop('sphere', [1, 7, 5], 'foliage', [0.88, 0.95, 0.85], x + Math.cos(a) * d, s2 * 0.5, z + Math.sin(a) * d, s2, s2 * 0.55, s2, rng() * 6.28);
                }
                if (snowCap) prop('sphere', [1, 7, 5], 'white', [0.93, 0.96, 1], x, s * 0.78, z, s * 0.72, s * 0.2, s * 0.72);
            };
            const pebble = (tint) => {
                const x = (rng() * 2 - 1) * HALF, z = (rng() * 2 - 1) * HALF;
                const s = 0.14 + rng() * 0.14;
                prop('sphere', [1, 6, 4], 'rock', tint, x, s * 0.5, z, s * 1.4, s * 0.6, s, rng() * 6.28);
            };
            if (theme === 'winter') {
                for (let i = 0; i < 220; i++) bush(true);
                for (let i = 0; i < 120; i++) { // snow patches
                    const x = (rng() * 2 - 1) * HALF, z = (rng() * 2 - 1) * HALF;
                    const s = 0.6 + rng() * 1.1;
                    prop('disc', [1, 10], 'white', [0.93, 0.96, 0.98], x, 0.04, z, s, 1, s * (0.7 + rng() * 0.5), rng() * 6.28);
                }
                for (let i = 0; i < 150; i++) pebble([0.62, 0.68, 0.76]);
            } else if (theme === 'desert') {
                for (let i = 0; i < 180; i++) bush(false);
                for (let i = 0; i < 150; i++) pebble([0.82, 0.6, 0.42]); // rust rocks
                for (let i = 0; i < 90; i++) pebble([0.9, 0.8, 0.62]);
            } else {
                for (let i = 0; i < 260; i++) bush(false);
                const petals = [[1, 0.98, 0.9], [1, 0.83, 0.35], [0.93, 0.55, 0.7]];
                for (let i = 0; i < 200; i++) { // flower tufts
                    const x = (rng() * 2 - 1) * HALF, z = (rng() * 2 - 1) * HALF;
                    const s = 0.11 + rng() * 0.08;
                    prop('sphere', [1, 5, 4], 'white', petals[(rng() * 3) | 0], x, 0.16, z, s, s, s);
                }
                for (let i = 0; i < 150; i++) pebble([0.72, 0.68, 0.62]);
            }
            this._props = props;
        }

        _resourceEntries(res, i) {
            let e = this._resEntries.get(res);
            if (e) return e;
            const m3 = M();
            const TRS = (x, y, z, sx, sy, sz, ry) => {
                let m = m3.translation(x, y, z);
                if (ry) m = m3.multiply(m, m3.rotationY(ry));
                return m3.multiply(m, m3.scaling(sx, sy, sz));
            };
            const rot = (i * 2.399) % 6.283; // deterministic per-node variation
            const s = 0.85 + ((i * 37) % 100) / 200;
            // Sink food/stone/gold nodes 5–20% of their height into the ground —
            // per-node character while shape and texture stay instantly readable.
            const sink01 = ((i * 53) % 100) / 100;
            const sink = h => (0.05 + sink01 * 0.15) * h;
            e = { opaque: [], blended: [] };
            const add = (kind, args, tex, model, blend) =>
                (blend ? e.blended : e.opaque).push({ buf: this._buf(kind, args), tex: this.tex[tex], model });
            if (res.type === 'wood') {
                add('disc', [2.2, 14], 'shadow', TRS(res.x, 0.05, res.z, s, 1, s), true);
                add('cylinder', [0.24, 0.4, 2.4, 7], 'bark', TRS(res.x, 1.2 * s, res.z, s, s, s, rot));
                if (this._theme === 'winter') {
                    add('cylinder', [0, 1, 1, 8], 'foliage', TRS(res.x, 3.1 * s, res.z, 2.2 * s, 3.4 * s, 2.2 * s));
                } else {
                    add('sphere', [1, 10, 7], 'foliage', TRS(res.x, 3.3 * s, res.z, 1.9 * s, 1.6 * s, 1.9 * s, rot));
                }
            } else if (res.type === 'stone') {
                add('disc', [2.0, 14], 'shadow', TRS(res.x, 0.05, res.z, 1, 1, 1), true);
                add('sphere', [1, 9, 6], 'rock', TRS(res.x, 0.9 - sink(2.3), res.z, 1.7, 1.15, 1.5, rot));
            } else if (res.type === 'gold') {
                add('disc', [1.8, 14], 'shadow', TRS(res.x, 0.05, res.z, 1, 1, 1), true);
                add('sphere', [1, 9, 6], 'gold', TRS(res.x, 0.8 - sink(2.1), res.z, 1.5, 1.05, 1.4, rot));
            } else { // food: berry bush
                add('sphere', [1, 9, 6], 'berries', TRS(res.x, 0.55 - sink(1.4), res.z, 1.15, 0.7, 1.15, rot));
            }
            this._resEntries.set(res, e);
            return e;
        }

        // ---- entities --------------------------------------------------------
        _tintOf(colorHex) {
            const c = colorHex == null ? 0xffffff : colorHex;
            return [((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255];
        }

        addUnit(unit) {
            // Re-add-safe: this.units doubles as the game's unit list
            // (game.getAllUnits), and a duplicate entry means duplicate combat
            // ticks — a re-added unit (e.g. a field upgrade recomposing its
            // mesh) must replace its old entry, never stack a second one.
            const prev = this.units.indexOf(unit);
            if (prev > -1) this.units.splice(prev, 1);
            this.units.push(unit);
            const engineType = unit.unitType === 'support' ? 'priest'
                : (EngineUnits.META[unit.unitType] ? unit.unitType : 'infantry');
            const tint = this._tintOf(unit.color);
            const entries = EngineUnits.parts(engineType, { civ: unit.civilization, unit: unit.type }).map(p => ({
                buf: this._buf(p.kind, p.args), tex: this.tex[p.tex],
                tint: p.team ? tint : this.WHITE,
                base: p.m, bone: p.bone, blend: p.blend, model: p.m
            }));
            unit._engine = { type: engineType, entries, phase: (this.units.length * 1.37) % 6.28 };
            // inert THREE-shaped handles for game.js/fogofwar.js property pokes
            unit.mesh = { visible: true, position: { set: () => {}, x: 0, y: 0, z: 0 }, rotation: { z: 0 } };
            unit.healthBar = { material: { color: { setHex: () => {} } } };
            unit.body = { material: { emissive: { setHex: () => {} } } };
            unit.baseY = 0;
        }

        removeUnit(unit) {
            const idx = this.units.indexOf(unit);
            if (idx > -1) this.units.splice(idx, 1);
            unit._engine = null;
            unit.mesh = null;
        }

        addBuilding(building) {
            this.buildings.push(building);
            this._composeBuilding(building);
        }

        _composeBuilding(building) {
            const m3 = M();
            const civ = (typeof getCivilization === 'function') ? getCivilization(building.civilization) : null;
            const civColor = (civ && civ.color) ? civ.color : building.color;
            building.color = civColor;
            const tint = this._tintOf(civColor);
            const world = m3.multiply(
                m3.multiply(
                    m3.translation(building.x, 0, building.z),
                    m3.rotationY(building.rotationY || 0)),
                m3.scaling(BSCALE, BSCALE, BSCALE));
            let parts, shellIdx = -1;
            if (building.underConstruction) {
                // The rising shell previews the FINAL height — it used to top out
                // at waist height while the progress said 100%, which read as the
                // build finishing at a third of the promised size.
                const H = {
                    town_center: 7.9, house: 4.5, barracks: 5.6, stable: 4.5,
                    archery_range: 4.6, market: 4.4, farm: 1.2, tower: 8.9, temple: 6
                };
                const foot = (building.isWonder ? 12 : 7);
                const h = building.isWonder ? 8.6 : (H[building.type] || 5);
                parts = EngineBuildings.site(foot, foot, h);
                shellIdx = 2; // the shell box — grows to full height with progress
                building._shellH = h;
            } else {
                // Wonders resolve by their real type (pyramid / akropolis /
                // firetemple / shrine — each has its own builder now); anything
                // unknown falls back to the generic wonder or a house.
                const known = EngineBuildings.TYPES.indexOf(building.type) >= 0;
                const type = known ? building.type : (building.isWonder ? 'wonder' : 'house');
                parts = EngineBuildings.parts(type, { age: building.age, civ: building.civilization });
            }
            const eb = { opaque: [], blended: [], shell: null, world };
            parts.forEach((p, i) => {
                const entry = {
                    buf: this._buf(p.kind, p.args), tex: this.tex[p.tex],
                    tint: p.team ? tint : this.WHITE, // cultural trim in the player color
                    model: m3.multiply(world, p.m), base: p.m
                };
                if (i === shellIdx) { entry.tint = tint; eb.shell = entry; }
                (p.blend ? eb.blended : eb.opaque).push(entry);
            });
            // a team-color banner post at the corner so ownership reads at a glance
            if (!building.underConstruction) {
                const off = building.isWonder ? 5.4 : 3.4;
                eb.opaque.push({
                    buf: this._buf('cylinder', [0.07, 0.09, 2.6, 5]), tex: this.tex.bark, tint: this.WHITE,
                    model: m3.multiply(world, m3.translation(off, 1.3, off))
                });
                eb.opaque.push({
                    buf: this._buf('box', [0.85, 0.55, 0.07]), tex: this.tex.cloth, tint,
                    model: m3.multiply(world, m3.translation(off + 0.45, 2.25, off))
                });
                // …and a team-color runner out the FRONT door: the walls are
                // near-symmetric in the early ages, so this ground strip is the
                // orientation cue that reads at any zoom. Long enough (z 3.2→7)
                // to emerge past every civ's front wall; plinths hide the rest.
                if (building.type !== 'farm') {
                    const rz = building.isWonder ? 6.8 : 5.1;
                    const rw = building.isWonder ? 2.2 : 1.7;
                    eb.opaque.push({
                        buf: this._buf('box', [rw, 0.05, 3.8]), tex: this.tex.cloth, tint,
                        model: m3.multiply(world, m3.translation(0, 0.08, rz))
                    });
                }
            }
            building._engine = eb;
            building.mesh = building.mesh && building.mesh.visible !== undefined
                ? building.mesh : { visible: true, children: [] };
            if (!building.healthBar) building.healthBar = { material: { color: { setHex: () => {} } } };
        }

        removeBuilding(building) {
            const idx = this.buildings.indexOf(building);
            if (idx > -1) this.buildings.splice(idx, 1);
            building._engine = null;
            building.mesh = null;
        }

        onBuildingCompleted(building) {
            if (!building) return;
            this._composeBuilding(building);
        }

        rebuildBuildingMesh(building) {
            if (!building) return;
            this._composeBuilding(building);
        }

        completeProduction(building) {
            building.isProducing = false;
            building.productionProgress = 0;
            if (building.productionType) {
                const unit = createUnit(building.productionType, building.x, building.z + 3,
                    building.owner, building.civilization,
                    building.owner === 'player' ? game.player.age : 'stone');
                this.addUnit(unit);
                building.productionQueue.shift();
                if (building.productionQueue.length > 0) {
                    building.isProducing = true;
                    building.productionType = building.productionQueue[0];
                    building.productionDuration = 5000;
                    building.productionProgress = 0;
                }
            }
        }

        // ---- deaths & effects --------------------------------------------------
        _ghostFrom(entity, kind) {
            const eb = entity._engine;
            if (!eb) return;
            const entries = (eb.entries || eb.opaque || []).map(e => ({
                buf: e.buf, tex: e.tex, tint: e.tint, model: e.model
            }));
            this._ghosts.push({ entries, px: entity.x, pz: entity.z, kind, t: 0, dur: kind === 'unit' ? 0.9 : 1.25 });
        }

        killUnit(unit) {
            this._ghostFrom(unit, 'unit');
            this.removeUnit(unit);
            unit.healthBar = null;
            this.spawnDust(unit.x, 0.5, unit.z, 10, 0x9a8f7a);
        }

        killBuilding(building) {
            this._ghostFrom(building, 'building');
            this.removeBuilding(building);
            building.healthBar = null;
            this.spawnDust(building.x, 1.4, building.z, 24, 0xb0a48e);
        }

        spawnProjectile(from, to, kind) {
            let p = this._projectiles.find(q => !q.active);
            if (!p) {
                if (this._projectiles.length >= 64) return;
                p = {};
                this._projectiles.push(p);
            }
            const dist = Math.hypot(to.x - from.x, to.z - from.z);
            Object.assign(p, {
                active: true, t: 0, dur: Math.max(0.16, dist / 42),
                sx: from.x, sy: from.y, sz: from.z, tx: to.x, ty: to.y, tz: to.z,
                arc: kind === 'stone' ? 2.0 : 3.0,
                tint: kind === 'stone' ? [0.6, 0.64, 0.68] : [0.48, 0.32, 0.19],
                scale: kind === 'stone' ? 0.24 : 0.09
            });
        }

        spawnBattleRing(x, z) {
            let r = this._rings.find(q => !q.active);
            if (!r) {
                if (this._rings.length >= 8) return;
                r = {};
                this._rings.push(r);
            }
            Object.assign(r, { active: true, t: 0, dur: 0.9, x, z });
        }

        flashHit(entity) {
            if (entity) entity._flashUntil = performance.now() + 130;
        }

        // Pooled dust burst: N billboarded motes scattering under gravity.
        spawnDust(x, y, z, count, color) {
            let d = this._dustPool.find(q => !q.active);
            if (!d) {
                if (this._dustPool.length >= 16) return;
                d = { N: 24, pos: new Float32Array(72), vel: new Float32Array(72) };
                this._dustPool.push(d);
            }
            d.active = true;
            d.t = 0;
            d.dur = 0.8;
            d.n = Math.min(d.N, count || d.N);
            d.tint = this._tintOf(color == null ? 0xb0a48e : color);
            for (let i = 0; i < d.n; i++) {
                const j = i * 3;
                d.pos[j] = x; d.pos[j + 1] = y; d.pos[j + 2] = z;
                const a = Math.random() * Math.PI * 2, r = 1.5 + Math.random() * 3;
                d.vel[j] = Math.cos(a) * r;
                d.vel[j + 1] = 2.2 + Math.random() * 2.6;
                d.vel[j + 2] = Math.sin(a) * r;
            }
        }

        resetEffects() {
            this._projectiles.forEach(p => { p.active = false; });
            this._rings.forEach(r => { r.active = false; });
            this._dustPool.forEach(d => { d.active = false; });
            this._ghosts = [];
        }

        clearScene() {
            this.resetEffects();
            this.units.forEach(u => { u._engine = null; u.mesh = null; });
            this.buildings.forEach(b => { b._engine = null; b.mesh = null; });
            this.units = [];
            this.buildings = [];
            this.deselectAll();
            this.removeBuildingPreview();
            this.isPlacingBuilding = false;
        }

        // ---- selection ---------------------------------------------------------
        selectUnit(unit) {
            this.selectedUnits.forEach(u => { u.selected = false; });
            this.selectedUnits = [unit];
            unit.selected = true;
        }

        selectMultipleUnits(units) {
            this.selectedUnits.forEach(u => { u.selected = false; });
            this.selectedUnits = units;
            units.forEach(u => { u.selected = true; });
        }

        deselectAll() {
            this.selectedUnits.forEach(u => { u.selected = false; });
            this.selectedUnits = [];
            this.buildings.forEach(b => { b.selected = false; });
        }

        showSelectionBox(x1, y1, x2, y2) {
            if (!this._marqueeEl) {
                const el = document.createElement('div');
                el.className = 'selection-marquee';
                this.container.appendChild(el);
                this._marqueeEl = el;
            }
            const el = this._marqueeEl;
            el.style.left = Math.min(x1, x2) + 'px';
            el.style.top = Math.min(y1, y2) + 'px';
            el.style.width = Math.abs(x2 - x1) + 'px';
            el.style.height = Math.abs(y2 - y1) + 'px';
            el.style.display = 'block';
        }

        hideSelectionBox() {
            if (this._marqueeEl) this._marqueeEl.style.display = 'none';
        }

        // ---- picking (perspective ray onto the y=0 plane) -----------------------
        worldToScreen(x, y, z) {
            const c = this._cam || this._computeCam();
            const v = c.view;
            const vx = v[0] * x + v[4] * y + v[8] * z + v[12];
            const vy = v[1] * x + v[5] * y + v[9] * z + v[13];
            const vz = v[2] * x + v[6] * y + v[10] * z + v[14];
            if (vz > -0.5) return null; // behind the eye
            const ndcX = (vx / -vz) / (c.tanHalf * c.aspect);
            const ndcY = (vy / -vz) / c.tanHalf;
            return {
                x: (ndcX + 1) / 2 * this.canvas.clientWidth,
                y: (1 - ndcY) / 2 * this.canvas.clientHeight
            };
        }

        getWorldPositionFromScreen(screenX, screenY) {
            const c = this._cam || this._computeCam();
            const rect = this.canvas.getBoundingClientRect();
            if (!rect.width || !rect.height) return null;
            const nx = ((screenX - rect.left) / rect.width) * 2 - 1;
            const ny = -((screenY - rect.top) / rect.height) * 2 + 1;
            // ray from the eye through the pixel
            const kx = nx * c.tanHalf * c.aspect, ky = ny * c.tanHalf;
            let dx = c.dir[0] + c.right[0] * kx + c.up[0] * ky;
            let dy = c.dir[1] + c.right[1] * kx + c.up[1] * ky;
            let dz = c.dir[2] + c.right[2] * kx + c.up[2] * ky;
            if (dy > -0.005) return null; // looking at/above the horizon
            const t = -c.eye[1] / dy;
            const x = c.eye[0] + dx * t, z = c.eye[2] + dz * t;
            const half = (this.terrain ? this.terrain.size : 800) / 2 + 90;
            if (x < -half || x > half || z < -half || z > half) return null;
            return { x, z };
        }

        getUnitsAtPosition(x, z, radius = 2, owner = null) {
            return this.units.filter(unit => {
                const dist = Math.hypot(unit.x - x, unit.z - z);
                if (dist >= radius) return false;
                if (owner && unit.owner !== owner) return false;
                return true;
            });
        }

        unitClickRadius(unit) {
            const widths = { cavalry: 1.6, infantry: 1.2, ranged: 1.1, support: 1.1, worker: 1.0 };
            const w = widths[unit.unitType] || widths[unit.type] || 1.1;
            return Math.max(2.0, w * 2);
        }

        pickUnitAt(x, z, owner = null) {
            let best = null, bestDist = Infinity;
            this.units.forEach(unit => {
                if (owner && unit.owner !== owner) return;
                if (unit.health <= 0) return;
                const dist = Math.hypot(unit.x - x, unit.z - z);
                if (dist <= this.unitClickRadius(unit) && dist < bestDist) {
                    bestDist = dist;
                    best = unit;
                }
            });
            return best;
        }

        getBuildingsAtPosition(x, z, radius = 3, owner = null) {
            return this.buildings.filter(building => {
                const dist = Math.hypot(building.x - x, building.z - z);
                if (dist >= radius) return false;
                if (owner && building.owner !== owner) return false;
                return true;
            });
        }

        // ---- building preview ----------------------------------------------------
        showBuildingPreview(buildingType, x, z) {
            this.removeBuildingPreview();
            let def = BUILDING_DEFS[buildingType];
            let isWonder = false;
            if (!def && this.game && this.game.player) {
                const civ = getCivilization(this.game.player.civilization);
                def = (civ?.uniqueBuildings || []).find(b => b.id === buildingType);
                isWonder = def && def.type === 'wonder';
            }
            if (!def) return;
            this.buildingPreview = { type: buildingType, x, z, big: isWonder, valid: true };
        }

        updateBuildingPreview(x, z) {
            if (this.buildingPreview && this.isPlacingBuilding) {
                this.buildingPreview.x = x;
                this.buildingPreview.z = z;
                this.buildingPreview.valid = this.isValidBuildingPosition(x, z, this.placingBuildingType);
            }
        }

        removeBuildingPreview() {
            this.buildingPreview = null;
        }

        isValidBuildingPosition(x, z, buildingType) {
            let def = BUILDING_DEFS[buildingType];
            if (!def && this.game && this.game.player) {
                const civ = getCivilization(this.game.player.civilization);
                def = (civ?.uniqueBuildings || []).find(b => b.id === buildingType);
            }
            if (!def) return false;
            const halfSize = (this.terrain ? this.terrain.size : 800) / 2 - 5;
            if (x < -halfSize || x > halfSize || z < -halfSize || z > halfSize) return false;
            for (const building of this.buildings) {
                const dist = Math.hypot(building.x - x, building.z - z);
                const need = (building.type === 'town_center' || building.isWonder) ? 11 : 9;
                if (dist < need) return false;
            }
            const isWonder = def.type === 'wonder';
            if (this.game && typeof this.game.isTooCloseToResource === 'function') {
                if (this.game.isTooCloseToResource(x, z, buildingType, isWonder)) return false;
            } else if (this.terrain && this.terrain.resources) {
                for (const resource of this.terrain.resources) {
                    if (Math.hypot(resource.x - x, resource.z - z) < (isWonder ? 9.5 : 8)) return false;
                }
            }
            return true;
        }

        // ---- input (locked camera: every drag pans, wheel zooms) -----------------
        isEditableTarget(el) {
            if (!el) return false;
            const tag = el.tagName;
            return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
        }

        onKeyDown(event) {
            if (this.isEditableTarget(event.target)) { this.keysPressed = {}; return; }
            this.keysPressed[event.key.toLowerCase()] = true;
        }

        onKeyUp(event) {
            this.keysPressed[event.key.toLowerCase()] = false;
        }

        onCanvasMouseDown(event) {
            const spectator = typeof game !== 'undefined' && game && game.spectatorMode;
            if (event.button === 1) {
                // middle mouse TURNS the map (yaw only — pitch stays dimetric)
                if (spectator && game.disableActionCam) game.disableActionCam();
                this._rotateDrag = { x: event.clientX, y: event.clientY };
                event.preventDefault();
            } else if (event.button === 0 && spectator) {
                if (game.disableActionCam) game.disableActionCam();
                this._panDrag = { x: event.clientX, y: event.clientY };
                event.preventDefault();
            }
        }

        onCanvasMouseMove(event) {
            if (this._rotateDrag) {
                const dx = event.clientX - this._rotateDrag.x;
                const dy = event.clientY - this._rotateDrag.y;
                this._rotateDrag = { x: event.clientX, y: event.clientY };
                this._yaw -= dx * 0.006;   // horizontal: turn around the look-at point
                // vertical: tilt between near-flat and (almost) top-down; 89° keeps
                // lookAt's up vector from degenerating
                this._pitch = Math.max(10 * Math.PI / 180,
                    Math.min(89 * Math.PI / 180, this._pitch + dy * 0.004));
                return;
            }
            if (!this._panDrag) return;
            const dx = event.clientX - this._panDrag.x;
            const dy = event.clientY - this._panDrag.y;
            this._panDrag = { x: event.clientX, y: event.clientY };
            const wpp = (2 * this._halfH) / (this.canvas.clientHeight || 1);
            // grab-and-drag: world follows the cursor (basis follows yaw + pitch)
            const cy = Math.cos(this._yaw), sy = Math.sin(this._yaw);
            const right = -dx * wpp;
            const fwd = dy * wpp / Math.max(0.17, Math.sin(this._pitch));
            this.cameraTarget.x += right * cy + fwd * -sy;
            this.cameraTarget.z += right * -sy + fwd * -cy;
        }

        onCanvasMouseUp() {
            this._panDrag = null;
            this._rotateDrag = null;
        }

        onCanvasWheel(e) {
            e.preventDefault();
            const factor = e.deltaY > 0 ? 1.12 : (1 / 1.12);
            this._halfH = Math.max(MIN_HALF, Math.min(MAX_HALF, this._halfH * factor));
        }

        updateCamera(deltaTime) {
            const speed = this.cameraPanSpeed * deltaTime / 16 * Math.max(0.6, this._halfH / 38);
            const keys = this.keysPressed;
            const fwd = ((keys['w'] || keys['arrowup']) ? 1 : 0) - ((keys['s'] || keys['arrowdown']) ? 1 : 0);
            const right = ((keys['d'] || keys['arrowright']) ? 1 : 0) - ((keys['a'] || keys['arrowleft']) ? 1 : 0);
            if (fwd || right) {
                const cy = Math.cos(this._yaw), sy = Math.sin(this._yaw);
                this.cameraTarget.x += (right * cy - fwd * sy) * speed;
                this.cameraTarget.z += (-right * sy - fwd * cy) * speed;
            }
        }

        // ---- per-frame ------------------------------------------------------------
        // The engine draws entities from their live x/z each frame, so these are
        // API-compat no-ops (the old renderer moved THREE meshes here).
        updateUnitPosition() {}
        updateBuildingPosition() {}
        updateHealthBars() { /* bars are assembled per frame in _assembleFrame */ }

        // Exact frustum test in VIEW space (the old screen-space estimate treated
        // the visible ground as a rectangle at the target distance — but the
        // perspective frustum on the ground is a trapezoid, so objects near the
        // screen edges popped in and out while panning). margin is world units;
        // the bottom edge gets extra headroom because a tall object's top can
        // lean into view while its ground point is already below the frustum.
        _cull(x, z, margin) {
            const c = this._cam;
            const v = c.view;
            const vx = v[0] * x + v[8] * z + v[12];   // (x, 0, z) — ground point
            const vy = v[1] * x + v[9] * z + v[13];
            const vz = v[2] * x + v[10] * z + v[14];
            if (vz > -2) return true;                 // at or behind the eye
            const d = -vz;
            if (Math.abs(vx) > d * c.tanHalf * c.aspect + margin) return true;
            if (vy > d * c.tanHalf + margin) return true;             // above the top edge
            if (vy < -(d * c.tanHalf) - margin - 14) return true;     // below, +14 tall-object headroom
            return false;
        }

        _barColor(pct) {
            return pct > 0.6 ? [0.18, 0.85, 0.25] : (pct > 0.3 ? [0.95, 0.82, 0.2] : [0.9, 0.25, 0.2]);
        }

        _assembleFrame(tSec, dt, bb) {
            const m3 = M();
            const dl = this._dl;
            dl.opaque.length = 0; dl.blended.length = 0; dl.bars.length = 0;
            const now = performance.now();
            const FLASH = [1, 0.28, 0.22];
            const quad = this._buf('quad', [1, 1]);
            const ringBuf = this._buf('disc', [1, 22]);
            const pushBar = (x, y, z, w, pct, tint) => {
                const anchor = m3.multiply(m3.translation(x, y, z), bb);
                dl.bars.push({ buf: quad, tex: this.tex.white, tint: [0.06, 0.07, 0.09], model: m3.multiply(anchor, m3.scaling(w, 0.22, 1)) });
                const fw = (w - 0.08) * Math.max(0.02, Math.min(1, pct));
                dl.bars.push({
                    buf: quad, tex: this.tex.white, tint,
                    model: m3.multiply(anchor, m3.multiply(m3.translation(-((w - 0.08) - fw) / 2, 0, 0.01), m3.scaling(fw, 0.14, 1)))
                });
            };

            if (this._ground) dl.opaque.push(this._ground);

            // shoreline foam: pulse (old sea rhythm: sin(t/1100ms)) + slow drift
            if (this._foam) {
                const pulse = 0.34 + 0.14 * Math.sin(tSec * 0.91);
                const drift = (tSec * 0.012) % 1;
                for (const f of this._foam) {
                    f.alpha = pulse;
                    f.uvOff = [drift, 0];
                    dl.blended.push(f);
                }
            }

            // ambient shrubbery/flowers/pebbles — skipped when zoomed far out
            // (sub-pixel at halfH 90+, and the draw-call budget thanks us)
            if (this._props && this._halfH < 90) {
                for (const pr of this._props) {
                    if (this._cull(pr.x, pr.z, 3)) continue;
                    dl.opaque.push(pr);
                }
            }

            // resources (fog toggles handle visibility; depletion nulls res.mesh)
            if (this.terrain && this.terrain.resources) {
                const rs = this.terrain.resources;
                for (let i = 0; i < rs.length; i++) {
                    const res = rs[i];
                    if (!res.mesh || res.amount <= 0) continue;
                    const vis = res.mesh.trunk ? res.mesh.trunk.visible : res.mesh.visible;
                    if (!vis || this._cull(res.x, res.z, 14)) continue;
                    const e = this._resourceEntries(res, i);
                    for (const en of e.opaque) dl.opaque.push(en);
                    for (const en of e.blended) dl.blended.push(en);
                }
            }

            // buildings
            for (const b of this.buildings) {
                const eb = b._engine;
                if (!eb || (b.mesh && b.mesh.visible === false) || this._cull(b.x, b.z, 18)) continue;
                if (b.underConstruction && eb.shell) {
                    // Unit-height shell box grown from the plinth to pct of the
                    // final building height (b._shellH, set in _composeBuilding).
                    const pct = Math.min(1, (b.buildProgress || 0) / (b.buildTime || 10000));
                    const hNow = Math.max(0.15, (b._shellH || 4) * pct);
                    eb.shell.model = m3.multiply(eb.world,
                        m3.multiply(m3.translation(0, 0.5 + hNow / 2, 0), m3.scaling(1, hNow, 1)));
                }
                const flash = b._flashUntil && now < b._flashUntil;
                for (const en of eb.opaque) dl.opaque.push(flash ? { buf: en.buf, tex: en.tex, tint: FLASH, model: en.model } : en);
                for (const en of eb.blended) dl.blended.push(en);
                const hpct = b.health / b.maxHealth;
                const by = (b.isWonder ? 10 : 6) * BSCALE + 1.2;
                if (!b.underConstruction && hpct < 0.999) pushBar(b.x, by, b.z, 4.6, hpct, this._barColor(hpct));
                if (b.type === 'farm' && !b.underConstruction && b.maxFoodAmount > 0) {
                    pushBar(b.x, 3.1, b.z, 3.4, b.foodAmount / b.maxFoodAmount, [0.85, 0.66, 0.2]);
                }
                if (b.selected || (this.game && this.game.selectedBuilding === b)) {
                    dl.blended.push({
                        buf: ringBuf, tex: this.tex.ring, tint: [0.35, 0.95, 0.55],
                        model: m3.multiply(m3.translation(b.x, 0.1, b.z), m3.scaling(6, 1, 6))
                    });
                }
                if (b.isWonder && !b.underConstruction) { // pulsing claim ring
                    dl.blended.push({
                        buf: ringBuf, tex: this.tex.ring, tint: this._tintOf(b.color),
                        alpha: 0.35 + 0.25 * Math.sin(tSec * 2),
                        model: m3.multiply(m3.translation(b.x, 0.12, b.z), m3.scaling(8.4, 1, 8.4))
                    });
                }
                if (b.type === 'town_center' && !b.underConstruction) {
                    const bt = this._bannerFor(b);
                    if (bt) dl.bars.push({
                        buf: quad, tex: bt, tint: this.WHITE,
                        model: m3.multiply(m3.multiply(m3.translation(b.x, by + 2.4, b.z), bb), m3.scaling(7.5, 1.9, 1))
                    });
                }
            }

            // units
            for (const u of this.units) {
                const ue = u._engine;
                if (!ue || (u.mesh && u.mesh.visible === false) || this._cull(u.x, u.z, 6)) continue;
                // smoothed facing from motion
                let dir = this._unitDir.get(u);
                if (dir === undefined) { dir = 0; this._unitDir.set(u, dir); }
                if (u.isMoving && u.targetX !== undefined) {
                    const want = Math.atan2(u.targetX - u.x, u.targetZ - u.z);
                    let d = want - dir;
                    while (d > Math.PI) d -= Math.PI * 2;
                    while (d < -Math.PI) d += Math.PI * 2;
                    // Small corrections steer smoothly (error-proportional rate);
                    // past ~100° it isn't steering, it's an about-face — pivot on
                    // the spot. At the old flat dt·10 rate a 180° turn took ~0.3s
                    // and cavalry visibly rode BACKWARDS through every U-turn.
                    if (Math.abs(d) > 1.8) dir = want;
                    else dir += d * Math.min(1, dt * (10 + 12 * Math.abs(d)));
                    this._unitDir.set(u, dir);
                }
                const anim = (u.isHarvesting || u.isBuilding) ? 'harvest' : (u.isMoving ? 'walk' : 'idle');
                const pose = EngineUnits.pose(ue.type, anim, tSec, ue.phase);
                const spin = m3.rotationY(dir);
                const world = m3.multiply(m3.translation(u.x, pose.bob, u.z), spin);
                const flat = m3.multiply(m3.translation(u.x, 0, u.z), spin);
                const flash = u._flashUntil && now < u._flashUntil;
                for (const e of ue.entries) {
                    const local = e.bone && pose.mats[e.bone] ? m3.multiply(pose.mats[e.bone], e.base) : e.base;
                    const model = m3.multiply(e.blend ? flat : world, local);
                    e.model = model; // keep the composed matrix — death ghosts snapshot it
                    if (e.blend) dl.blended.push({ buf: e.buf, tex: e.tex, tint: e.tint, model });
                    else dl.opaque.push({ buf: e.buf, tex: e.tex, tint: flash ? FLASH : e.tint, model });
                }
                if (u.selected) {
                    const r = ue.type === 'cavalry' ? 1.5 : 1.05;
                    dl.blended.push({
                        buf: ringBuf, tex: this.tex.ring, tint: [0.35, 0.95, 0.55],
                        model: m3.multiply(m3.translation(u.x, 0.08, u.z), m3.scaling(r, 1, r))
                    });
                }
                if (ue.type === 'priest') { // golden halo
                    dl.blended.push({
                        buf: ringBuf, tex: this.tex.ring, tint: [1, 0.85, 0.25], alpha: 0.9,
                        model: m3.multiply(m3.translation(u.x, 1.95 + pose.bob, u.z), m3.scaling(0.42, 1, 0.42))
                    });
                }
                if (u.carryingResource && u.carryingResourceType) { // carried-goods diamond
                    const cc = {
                        wood: [0.45, 0.30, 0.15], food: [0.85, 0.22, 0.20],
                        stone: [0.62, 0.62, 0.66], gold: [1, 0.80, 0.20]
                    }[u.carryingResourceType] || this.WHITE;
                    dl.bars.push({
                        buf: quad, tex: this.tex.white, tint: cc,
                        model: m3.multiply(
                            m3.multiply(m3.translation(u.x, 2.3 + Math.sin(tSec * 3 + ue.phase) * 0.07, u.z), bb),
                            m3.multiply(m3.rotationZ(Math.PI / 4), m3.scaling(0.4, 0.4, 1)))
                    });
                }
                const hpct = u.health / u.maxHealth;
                if (hpct < 0.999) {
                    pushBar(u.x, EngineUnits.META[ue.type].barY, u.z, 1.5, hpct, this._barColor(hpct));
                }
            }

            // ghost collapses (deaths)
            for (let i = this._ghosts.length - 1; i >= 0; i--) {
                const g = this._ghosts[i];
                g.t += dt;
                const k = Math.min(1, g.t / g.dur);
                if (k >= 1) { this._ghosts.splice(i, 1); continue; }
                let A;
                if (g.kind === 'unit') {
                    A = m3.multiply(m3.translation(g.px, -0.6 * k, g.pz),
                        m3.multiply(m3.rotationX(k * 1.2), m3.multiply(m3.scaling(1 - 0.3 * k, 1 - 0.3 * k, 1 - 0.3 * k), m3.translation(-g.px, 0, -g.pz))));
                } else {
                    A = m3.multiply(m3.translation(g.px, -0.9 * k, g.pz),
                        m3.multiply(m3.scaling(1 - 0.2 * k, Math.max(0.06, 1 - k), 1 - 0.2 * k), m3.translation(-g.px, 0, -g.pz)));
                }
                for (const e of g.entries) {
                    dl.blended.push({ buf: e.buf, tex: e.tex, tint: e.tint, alpha: 1 - k, model: m3.multiply(A, e.model) });
                }
            }

            // dust motes: scatter, rise, settle, fade
            for (const d of this._dustPool) {
                if (!d.active) continue;
                d.t += dt;
                const k = d.t / d.dur;
                if (k >= 1) { d.active = false; continue; }
                const a = 0.8 * (1 - k);
                for (let i = 0; i < d.n; i++) {
                    const j = i * 3;
                    d.pos[j] += d.vel[j] * dt;
                    d.pos[j + 1] += d.vel[j + 1] * dt;
                    d.pos[j + 2] += d.vel[j + 2] * dt;
                    d.vel[j + 1] -= 7 * dt; // gravity
                    dl.blended.push({
                        buf: quad, tex: this.tex.white, tint: d.tint, alpha: a,
                        model: m3.multiply(
                            m3.multiply(m3.translation(d.pos[j], Math.max(0.12, d.pos[j + 1]), d.pos[j + 2]), bb),
                            m3.scaling(0.55, 0.55, 1))
                    });
                }
            }

            // projectiles
            for (const p of this._projectiles) {
                if (!p.active) continue;
                p.t += dt / p.dur;
                if (p.t >= 1) { p.active = false; continue; }
                const k = p.t;
                const x = p.sx + (p.tx - p.sx) * k;
                const z = p.sz + (p.tz - p.sz) * k;
                const y = p.sy + (p.ty - p.sy) * k + Math.sin(Math.PI * k) * p.arc;
                const yaw = Math.atan2(p.tx - p.sx, p.tz - p.sz);
                dl.opaque.push({
                    buf: this._buf('box', [1, 1, 1]), tex: this.tex.white, tint: p.tint,
                    model: m3.multiply(m3.translation(x, y, z),
                        m3.multiply(m3.rotationY(yaw), m3.scaling(p.scale, p.scale, 1.2)))
                });
            }

            // battle-ring pings (drawn after fog so they show through it)
            this._ringEntries = [];
            for (const r of this._rings) {
                if (!r.active) continue;
                r.t += dt;
                const k = r.t / r.dur;
                if (k >= 1) { r.active = false; continue; }
                const s = (1 + k * 9);
                this._ringEntries.push({
                    buf: ringBuf, tex: this.tex.ring, tint: [1, 0.35, 0.24],
                    model: m3.multiply(m3.translation(r.x, 0.7, r.z), m3.scaling(s, 1, s))
                });
            }

            // building placement ghost
            if (this.buildingPreview) {
                const bp = this.buildingPreview;
                const s = bp.big ? 9 : 4.5;
                dl.blended.push({
                    buf: this._buf('box', [1, 1, 1]), tex: this.tex.ghost,
                    tint: bp.valid ? [0.25, 1, 0.35] : [1, 0.25, 0.2],
                    model: m3.multiply(m3.translation(bp.x, (bp.big ? 4 : 1.5), bp.z), m3.scaling(s, bp.big ? 8 : 3, s))
                });
            }
        }

        // Floating civ name plate above Town Centers (canvas → texture, cached
        // per civ) — the spectator's whose-base-is-whose anchor.
        _bannerFor(building) {
            const key = building.civilization || 'x';
            if (this._bannerTex.has(key)) return this._bannerTex.get(key);
            const civ = (typeof getCivilization === 'function') ? getCivilization(key) : null;
            if (!civ) return null;
            const c = document.createElement('canvas');
            c.width = 256; c.height = 64;
            const ctx = c.getContext('2d');
            const colHex = '#' + (civ.color || 0xffffff).toString(16).padStart(6, '0');
            ctx.fillStyle = 'rgba(10, 14, 24, 0.72)';
            ctx.strokeStyle = colHex;
            ctx.lineWidth = 5;
            const r = 18;
            ctx.beginPath();
            ctx.moveTo(r, 3); ctx.lineTo(253 - r, 3); ctx.arcTo(253, 3, 253, 3 + r, r);
            ctx.lineTo(253, 61 - r); ctx.arcTo(253, 61, 253 - r, 61, r);
            ctx.lineTo(r, 61); ctx.arcTo(3, 61, 3, 61 - r, r);
            ctx.lineTo(3, 3 + r); ctx.arcTo(3, 3, 3 + r, 3, r);
            ctx.closePath(); ctx.fill(); ctx.stroke();
            const name = (typeof t === 'function' ? t('civ.' + key + '.name') : null) || civ.name || key;
            ctx.font = 'bold 30px sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillStyle = colHex;
            ctx.fillText(name, 128, 34);
            const tex = GLCore.createTextureFromCanvas(this.gl, c, { clamp: true, nomip: true });
            this._bannerTex.set(key, tex);
            return tex;
        }

        // fog display canvas → GL texture (uploaded only when fog marked it dirty)
        _syncFog() {
            const fow = this.game && this.game.fogOfWar;
            if (!fow || !fow.fogDisplayCanvas) { this._fogEntry = null; return; }
            const gl = this.gl;
            if (this._fogCanvas !== fow.fogDisplayCanvas) {
                this._fogCanvas = fow.fogDisplayCanvas;
                // NPOT canvas (numTiles*4, e.g. 1600) — clamp + no mipmaps
                this._fogTex = GLCore.createTextureFromCanvas(gl, this._fogCanvas, { clamp: true, nomip: true });
                const size = fow.mapSize || 800;
                this._fogEntry = {
                    buf: this._buf('gridPlane', [size, 1, 1]),
                    tex: this._fogTex, tint: this.WHITE,
                    model: M().translation(0, 0.95, 0)
                };
            } else if (fow.fogDirty) {
                fow.fogDirty = false;
                gl.bindTexture(gl.TEXTURE_2D, this._fogTex);
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this._fogCanvas);
            }
        }

        animate() {
            requestAnimationFrame(() => this.animate());
            const now = performance.now();
            const deltaTime = Math.min(0.1, (now - this._lastTime) / 1000);
            this._lastTime = now;

            this.updateCamera(deltaTime * 1000);

            // spectator action camera: ease toward the director's subject
            // (locked dimetric view — the old cinematic orbit is gone by design)
            if (typeof game !== 'undefined' && game && game._actionCam && game.spectatorMode && game.gameStarted) {
                const hot = game.getActionCamTarget();
                if (hot) {
                    const k = Math.min(1, deltaTime * 1.6);
                    this.cameraTarget.x += (hot.x - this.cameraTarget.x) * k;
                    this.cameraTarget.z += (hot.z - this.cameraTarget.z) * k;
                }
            }

            // embedded sim duties (positional refereeing only) ---------------
            // NOTE: no unit MOVEMENT happens here. An earlier "kept bit-identical"
            // port carried over a legacy mover that advanced every non-player unit
            // a SECOND time (game.js integrates at 3×speed/s, this added 1× more),
            // so AI armies ran 33% hot on plain moves and — because it steered
            // toward a STALE targetX/Z during attack-marches — dragged them 33%
            // slow. Infantry visibly outpaced cavalry. game.js (updateUnitMovement /
            // updateWorkerTasks / updateCombat) is the single source of movement.
            const SEPARATION_DIST = 1.2, SEPARATION_FORCE = 0.03;
            for (let i = 0; i < this.units.length; i++) {
                for (let j = i + 1; j < this.units.length; j++) {
                    const a = this.units[i], b = this.units[j];
                    const dx = b.x - a.x, dz = b.z - a.z;
                    const dist = Math.sqrt(dx * dx + dz * dz);
                    if (dist < SEPARATION_DIST && dist > 0.01) {
                        const push = (SEPARATION_DIST - dist) * SEPARATION_FORCE;
                        const nx = dx / dist, nz = dz / dist;
                        a.x -= nx * push; a.z -= nz * push;
                        b.x += nx * push; b.z += nz * push;
                    }
                }
            }
            const UNIT_BUILDING_CLEARANCE = 4.5;
            // Wonders are far bigger than ordinary buildings (largest footprint:
            // the 13×13 pyramid — faces at 5.07, corners at 7.17 world units), so
            // the flat 4.5 let units walk straight THROUGH them. One uniform
            // radius for ALL wonders keeps the four civs balanced. Attackability
            // is unaffected: combatants are exempt from the push below, and
            // ranged reach (7.5+) out-ranges the zone anyway.
            const WONDER_CLEARANCE = 7.0;
            this.units.forEach(unit => {
                // Combatants are exempt: the push used to referee fights near
                // buildings — an attacking worker could never close to melee
                // range and just shoved its target around the walls forever.
                // Attack-MOVE marchers count too: before acquiring a target
                // (attackTarget still null) the push could pin them against a
                // packed base's clearance rings, sliding along walls instead
                // of closing in — "can't reach the barracks from the side".
                if (unit.isAttacking && (unit.attackTarget || unit.attackMove)) return;
                this.buildings.forEach(building => {
                    if (building.type === 'farm') return;
                    if (unit.task === 'building' && unit.buildTarget === building) return;
                    if (unit.task === 'repairing' && unit.repairTarget === building) return;
                    const clr = building.isWonder ? WONDER_CLEARANCE : UNIT_BUILDING_CLEARANCE;
                    const dx = unit.x - building.x, dz = unit.z - building.z;
                    const dist = Math.sqrt(dx * dx + dz * dz);
                    if (dist < clr && dist > 0.01) {
                        const push = (clr - dist) * 0.05;
                        unit.x += (dx / dist) * push;
                        unit.z += (dz / dist) * push;
                    }
                });
            });

            // draw ------------------------------------------------------------
            const gl = this.gl;
            const cam = this._computeCam();
            const bb = M().billboard(cam.view);
            this._assembleFrame(now / 1000, deltaTime, bb);
            this._syncFog();

            gl.viewport(0, 0, this.W, this.H);
            gl.clearColor(this._sky[0], this._sky[1], this._sky[2], 1); // deep sea beyond the map
            gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
            gl.useProgram(this.prog);
            gl.uniformMatrix4fv(this.prog.uniforms.uProj, false, cam.proj);
            gl.uniformMatrix4fv(this.prog.uniforms.uView, false, cam.view);
            gl.uniform3fv(this.prog.uniforms.uSunDir, this.sunDir);
            gl.uniform3fv(this.prog.uniforms.uSunColor, this._sun);
            gl.uniform3f(this.prog.uniforms.uAmbient, 0.52, 0.55, 0.62);
            gl.activeTexture(gl.TEXTURE0);
            gl.uniform1i(this.prog.uniforms.uTex, 0);

            const draw = (list) => {
                for (const obj of list) {
                    gl.bindTexture(gl.TEXTURE_2D, obj.tex);
                    gl.uniform3fv(this.prog.uniforms.uTint, obj.tint || this.WHITE);
                    gl.uniform1f(this.prog.uniforms.uAlpha, obj.alpha == null ? 1 : obj.alpha);
                    gl.uniform2f(this.prog.uniforms.uUvOffset,
                        obj.uvOff ? obj.uvOff[0] : 0, obj.uvOff ? obj.uvOff[1] : 0);
                    gl.uniformMatrix4fv(this.prog.uniforms.uModel, false, obj.model);
                    GLCore.drawMesh(gl, this.prog, obj.buf);
                }
            };

            gl.uniform1f(this.prog.uniforms.uUnlit, 0.0);
            draw(this._dl.opaque);

            gl.enable(gl.BLEND);
            gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
            gl.depthMask(false);
            gl.uniform1f(this.prog.uniforms.uUnlit, 1.0);
            draw(this._dl.blended);
            if (this._fogEntry) draw([this._fogEntry]);
            if (this._ringEntries && this._ringEntries.length) draw(this._ringEntries);
            gl.disable(gl.DEPTH_TEST); // bars read over everything, like the old sprites
            draw(this._dl.bars);
            gl.enable(gl.DEPTH_TEST);
            gl.depthMask(true);
            gl.disable(gl.BLEND);
        }
    }

    window.EngineRenderer = EngineRenderer;
})();
