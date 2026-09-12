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
    // MAX_HALF was 190, which framed the whole map on a landscape window and nowhere
    // else. Measured what the narrow end actually needs: the stage runs 0.486 of window
    // height, so a 920-wide window 1600 tall gives a stage aspect of 1.18 and wants 338.
    // 400 is the round boundary just past it -- size/2 -- which is the honest way to
    // state the guarantee: any window at least as wide as its stage is tall can reach
    // the full map. Below 900px the small-screen card takes over anyway.
    //
    // Raising it also lengthens the wheel's zoom-out in play, which is the point: the
    // cap is what a reader hits when they try to see the whole board and cannot.
    const MIN_HALF = 10, MAX_HALF = 520;
    // Scene ambient. Lives here rather than inline at the draw call because the
    // sea colour beyond the map has to be derived from the SAME value — two
    // copies drifting apart is exactly what put a visible seam at the horizon.
    const AMBIENT = [0.52, 0.55, 0.62];
    // The island's dimensions, owned by TexGen (which paints the coast from them).
    // The ground plane spans them, the surf ribbon follows them, and TerrainManager
    // clamps units against them — readers of one fact, which must not drift.
    const TERRAIN_SEED = TexGen.TERRAIN_SEED,
          TERRAIN_WORLD = TexGen.TERRAIN_WORLD,
          TERRAIN_LAND = TexGen.TERRAIN_LAND;
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
            this.replayMode = false;
            this._cameraMoveId = 0;

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

            this.prog = GLCore.compileProgram(this.gl, EngineAtmosphere.vertex, EngineAtmosphere.fragment);
            this.shadowProg = GLCore.compileProgram(this.gl, EngineAtmosphere.shadowVertex, EngineAtmosphere.shadowFragment);
            this.sunDir = M().normalize([-0.65, 0.72, 0.36]);
            this.visualStyle = 'cinematic';
            this._shadowTarget = null;
            this._lightMatrix = M().identity();
            this._shadowStrength = 0;
            const quality = 'cinematic'; // High on a full page reload; in-page choices remain in effect.
            this.setGraphicsQuality(quality);

            this._geo = new Map();          // 'kind:args' → GPU buffers
            this._resEntries = new WeakMap(); // resource → prebaked entries
            this._unitDir = new WeakMap();    // unit → smoothed facing
            this._unitPrev = new WeakMap();   // unit → last frame's x/z (facing reads REAL motion)
            this._footprint = new Map();      // 'type|age|civ' → measured mesh half-extents
            this.tex = null;                  // built on setTerrain (theme-aware)
            this._theme = null;
            this._fogTex = null;              // GL texture wrapping the fog canvas
            this._fogCanvas = null;
            this._dl = { opaque: [], blended: [], bars: [] }; // per-frame lists
            this.WHITE = [1, 1, 1];

            window.addEventListener('resize', () => this.onWindowResize());
            canvas.addEventListener('mousedown', (e) => this.onCanvasMouseDown(e));
            window.addEventListener('mousemove', (e) => this.onCanvasMouseMove(e));
            window.addEventListener('mouseup', (e) => this.onCanvasMouseUp(e));
            window.addEventListener('blur', () => this.cancelPointerGesture());
            document.addEventListener('visibilitychange', () => { if(document.hidden) this.cancelPointerGesture(); });
            canvas.addEventListener('contextmenu', (e) => e.preventDefault());
            canvas.addEventListener('wheel', (e) => this.onCanvasWheel(e), { passive: false });
            // touch-action none, or the browser claims the gesture for page scroll and
            // pinch-zoom before a handler ever sees it. Only the canvas: the panels
            // beside it still need to scroll normally.
            canvas.style.touchAction = 'none';
            canvas.addEventListener('touchstart', (e) => this.onCanvasTouchStart(e), { passive: false });
            canvas.addEventListener('touchmove', (e) => this.onCanvasTouchMove(e), { passive: false });
            canvas.addEventListener('touchend', (e) => this.onCanvasTouchEnd(e), { passive: false });
            canvas.addEventListener('touchcancel', () => this.cancelPointerGesture(), { passive: false });
            document.addEventListener('keydown', (e) => this.onKeyDown(e));
            document.addEventListener('keyup', (e) => this.onKeyUp(e));

            this._buildTextures('summer');
            this.animate();
        }

        // ---- materials -------------------------------------------------------
        setGraphicsQuality(value) {
            const sizes = { low: 0, balanced: 1024, cinematic: 2048 };
            if (!Object.prototype.hasOwnProperty.call(sizes,value)) value = 'balanced';
            if (this.graphicsQuality === value) return;
            this.graphicsQuality = value;
            if (value !== 'cinematic' && this._grass) { this._grass.dispose(); this._grass = null; }
            EngineAtmosphere.disposeShadowTarget(this.gl,this._shadowTarget);
            this._shadowTarget = sizes[value] ? EngineAtmosphere.createShadowTarget(this.gl,sizes[value]) : null;
            try { localStorage.setItem('warGraphicsQuality',value); } catch (e) {}
        }

        _renderShadows() {
            const target = this._shadowTarget;
            this._shadowStrength = target && this.visualStyle !== 'classic'
                ? Math.max(0,Math.min(1,(160-this._halfH)/60)) : 0;
            if (!this._shadowStrength) return;
            const gl = this.gl;
            const camera=EngineAtmosphere.shadowCamera(M(),this.cameraTarget,this._halfH,target.size,this.sunDir);
            this._lightMatrix=camera.matrix;
            this._shadowCamera=camera;
            // RG stores numeric depth. Dithering those colour bytes corrupts it.
            const dither=gl.isEnabled(gl.DITHER);
            gl.disable(gl.DITHER);
            gl.bindFramebuffer(gl.FRAMEBUFFER,target.framebuffer);
            gl.viewport(0,0,target.size,target.size);
            gl.clearColor(1,1,1,1); gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
            gl.useProgram(this.shadowProg);
            gl.uniformMatrix4fv(this.shadowProg.uniforms.uLightMatrix,false,this._lightMatrix);
            // Receiver-plane comparisons provide the bias for the packed map.
            // Only geometry already admitted by the visibility/fog pass can cast.
            for (const obj of this._dl.opaque) {
                if (obj === this._ground || obj === this._sea || obj.noShadow) continue;
                gl.uniformMatrix4fv(this.shadowProg.uniforms.uModel,false,obj.model);
                GLCore.drawMesh(gl,this.shadowProg,obj.buf);
            }
            gl.bindFramebuffer(gl.FRAMEBUFFER,null);
            if (dither) gl.enable(gl.DITHER);
        }

        _buildTextures(theme) {
            if (this._theme === theme && this.tex) return;
            this._theme = theme;
            const gl = this.gl;
            const canopyBase = theme === 'winter' ? [58, 92, 66]
                : (theme === 'desert' ? [110, 116, 62] : [83, 108, 61]);
            const T = (c, o) => GLCore.createTextureFromCanvas(gl, c, o);
            this.tex = {
                coast: T(TexGen.coastMask(), { clamp: true }),
                terrain: T(TexGen.terrain(theme, TERRAIN_SEED, 1024, TERRAIN_WORLD, TERRAIN_LAND), { clamp: true }),
                groundDetail: T(TexGen.groundDetail(theme)),
                worldBark: T(TexGen.worldSurface('bark',theme,44)),
                worldFoliage: T(TexGen.worldSurface('foliage',theme,55)),
                worldStone: T(TexGen.worldSurface('stone',theme,77)),
                worldOre: T(TexGen.worldSurface('ore',theme,88)),
                openWater: T(TexGen.openWater(theme, 5)),   // tiles — no clamp
                masonry: T(TexGen.masonry(22)),
                limestone: T(TexGen.limestone()),
                wood: T(TexGen.wood(33)),
                bark: T(TexGen.bark(44)),
                foliage: T(TexGen.foliage(55, canopyBase)),
                berries: T(TexGen.worldSurface('berries',theme,66)),
                rock: T(TexGen.rock(77)),
                gold: T(TexGen.rock(88, { gold: true })),
                plaster: T(TexGen.plaster(99)),
                thatch: T(TexGen.thatch(111)),
                rooftile: T(TexGen.rooftile(122)),
                neutralRoof: T(TexGen.neutralRoof()),
                awning: T(TexGen.awning(133)),
                field: T(TexGen.field(144, 128, 'rows')),
                field_dirt: T(TexGen.field(144, 128, 'dirt')),
                field_patchy: T(TexGen.field(144, 128, 'patchy')),
                shadow: T(TexGen.shadowBlob(), { clamp: true }),
                mote: T(TexGen.softMote(), { clamp: true }),
                cloth: T(TexGen.cloth(155)),
                skin: T(TexGen.skin(166)),
                hairBlack: T(TexGen.solid(25,22,23)),
                hairBrown: T(TexGen.solid(65,39,25)),
                hairBlond: T(TexGen.solid(170,128,58)),
                hairWhite: T(TexGen.solid(214,209,195)),
                mouth: T(TexGen.solid(83,37,31)),
                leather: T(TexGen.leather(177)),
                iron: T(TexGen.iron(188)),
                white: T(TexGen.solid(), { clamp: true }),
                ghost: T(TexGen.solid(255, 255, 255, 115), { clamp: true }),
                ring: T(TexGen.ring(), { clamp: true }),
                foam: T(TexGen.foam(199))
            };
            // Project the terrain colour onto its soil -> cover palette axis.
            // Keeping this in a uniform leaves the colour texture fully opaque.
            const palette=TexGen.TERRAIN_PALETTES[theme] || TexGen.TERRAIN_PALETTES.summer;
            const axis=palette.soil.map((soil,i)=>((palette.grass[i]+palette.grassDark[i])*.5-soil)/255);
            const norm=Math.max(.0001,axis.reduce((sum,v)=>sum+v*v,0));
            this._groundCover=axis.map(v=>v/norm);
            this._groundCover.push(-this._groundCover.reduce((sum,v,i)=>sum+v*palette.soil[i]/255,0));
            // theme atmosphere: sun character first, then the sea beyond the map.
            this._sun = theme === 'winter' ? [0.74, 0.77, 0.83]
                : (theme === 'desert' ? [0.99, 0.82, 0.59] : [0.96, 0.84, 0.66]);
            // The colour behind everything, and the colour distance fades toward.
            // This used to be derived as lit waterDeep, because the clear colour WAS
            // the sea past the map rim and any mismatch showed as a hard edge. The
            // open-water plane covers that rim now, so this is free to be sky — and
            // the haze keeps the two meeting cleanly without hand-matching anything:
            // the sea reaches the far plane already wearing this colour.
            this._sky = theme === 'winter' ? [0.60, 0.67, 0.76]
                : (theme === 'desert' ? [0.66, 0.71, 0.75] : [0.42, 0.60, 0.79]);
            this._daySun = this._sun.slice();
            this._daySky = this._sky.slice();
        }

        _buf(kind, args) {
            const key = kind + ':' + args.join(',');
            if (!this._geo.has(key)) {
                this._geo.set(key, GLCore.createMeshBuffers(this.gl, EngineMesh[kind](...args)));
            }
            return this._geo.get(key);
        }

        // True XZ half-extents of a composed building, measured from the geometry
        // the builder actually emitted: every vertex pushed through its own part
        // transform. Nothing else knows a building's real size — the codebase
        // carries five different guesses at it (the site footprint 7/12,
        // resourceClearance 3.5/5, the spawn footRadius 3.5/5, the unit clearance
        // 4.5/7, and the banner's 3.4/5.4) and no two agree. Cached per
        // type|age|civ, so it runs once per LOOK, not per building and not per
        // frame.
        _meshFootprint(parts, key) {
            if (this._footprint.has(key)) return this._footprint.get(key);
            let ex = 0, ez = 0;
            for (const p of parts) {
                if (p.blend || p.tex === 'shadow' || p.visualOnly) continue; // the contact shadow isn't structure
                const gen = EngineMesh[p.kind];
                if (!gen) continue;
                const P = gen(...p.args).positions;
                const m = p.m; // column-major: translation at 12/13/14
                for (let i = 0; i < P.length; i += 3) {
                    const x = P[i], y = P[i + 1], z = P[i + 2];
                    const wx = Math.abs(m[0] * x + m[4] * y + m[8] * z + m[12]);
                    const wz = Math.abs(m[2] * x + m[6] * y + m[10] * z + m[14]);
                    if (wx > ex) ex = wx;
                    if (wz > ez) ez = wz;
                }
            }
            const fp = { ex, ez };
            this._footprint.set(key, fp);
            return fp;
        }

        // ---- camera ----------------------------------------------------------
        _zoomFromPosition() {
            const p = this.camera.position, t = this.cameraTarget;
            const dist = Math.hypot(p.x - t.x, p.y - t.y, p.z - t.z) || 100;
            this._halfH = Math.max(MIN_HALF, Math.min(MAX_HALF, dist * HALF_PER_DIST));
        }

        // Every path that moves the look-at point — drag-pan, WASD, the action cam,
        // moveCameraTo — was unbounded, so a long drag could sail the island off past
        // the horizon and leave you adrift in empty sea with no way back but a reset.
        // Clamping here, at the one point every path funnels through, means no future
        // mover can forget to. The bound is the land square itself: the screen centre
        // always has ground under it, while the coast and open water stay framable.
        _clampTarget() {
            const half = (this.terrain && this.terrain.size > 0) ? this.terrain.size / 2 : 400;
            const t = this.cameraTarget;
            t.x = Math.min(half, Math.max(-half, t.x));
            t.z = Math.min(half, Math.max(-half, t.z));
        }

        _computeCam() {
            this._clampTarget();
            const m3 = M();
            const aspect = (this.W || 1) / (this.H || 1);
            // Narrow-FOV perspective: the eye sits far enough away that the frame
            // still covers ±halfH world units at the target — same zoom feel as
            // the old ortho, minus its reverse-perspective illusion at max zoom.
            const FOVY = 20 * Math.PI / 180;
            const tanHalf = Math.tan(FOVY / 2);
            const dist = this._halfH / tanHalf;
            const FAR = dist + 2200;
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
                // Keep foreground sea inside the frustum at maximum zoom and low
                // pitch. Subtracting a fixed 1400 from dist clipped the lower view.
                proj: m3.perspective(FOVY, aspect, Math.max(2, dist * 0.05), FAR),
                // Haze tied to the far plane, so geometry is fully faded BEFORE it is
                // clipped at EVERY zoom — otherwise the cut moves with dist and the
                // horizon slides. The map is 800 across and the eye sits ~dist away,
                // so land never reaches the start of it; only the open sea does.
                haze: [FAR * 0.55, FAR * 0.97]
            };
            return this._cam;
        }

        // The analyzer's opening shot: the whole island, square to the screen.
        //
        // A reader arriving at a match knows nothing about it yet and should not have to
        // go and find it. The play camera's 45-degree yaw is right for playing -- it is
        // how the game has always looked -- but it turns a square map into a lozenge,
        // which is the wrong first impression of a board someone is about to read. Yaw
        // zero puts the coastline parallel to the frame and the whole thing is legible
        // at a glance. MAX_HALF covers the full map with room to spare, and the constant
        // lives here because the clamp does.
        //
        // Instant, unlike moveCameraTo: this is where the view STARTS. Animating in from
        // wherever the camera happened to be would just be a lurch on arrival, and rAF
        // does not run at all in a hidden tab, so a tween here could silently never land.
        frameWholeMap() {
            this.cancelCameraMove();
            this.cameraTarget.set(0, 0, 0);
            this._yaw = 0;
            this._pitch = Math.atan(0.5);   // the default tilt, so the shot is repeatable
            // Fit, rather than zoom to the cap. The two axes need different amounts: the
            // tilt stretches how much ground a given half-height covers in depth, while
            // across the screen it is only aspect, so whichever wants more zoom wins.
            // Slamming to MAX_HALF instead would have opened a wide monitor on a tiny
            // island adrift in blue the moment that cap was raised for narrow ones.
            // Frame the COASTLINE with open water around it, not the play square. The
            // square is entirely land now, so fitting it exactly would fill the frame
            // edge to edge and the island would stop reading as an island -- which is
            // what the wide B-roll, the thumbnails and the showcase's opening shot are
            // all built on. The shore is what the eye reads as the map's edge, so that
            // is what the shot is composed around.
            const coast = TERRAIN_LAND + (TexGen.COAST_WOBBLE || 0) / 2;
            const extent = coast * 2 * 1.10;   // outermost shore, plus sea to sit in
            const aspect = (this.W || 1) / (this.H || 1);
            const need = Math.max(extent * Math.sin(this._pitch), extent / aspect) / 2;
            this._halfH = Math.max(MIN_HALF, Math.min(MAX_HALF, need * 1.06));
        }

        moveCameraTo(x, z) {
            if (!Number.isFinite(x) || !Number.isFinite(z)) return;
            const moveId = ++this._cameraMoveId;
            const sx = this.cameraTarget.x, sz = this.cameraTarget.z;
            const start = performance.now();
            const step = () => {
                if (moveId !== this._cameraMoveId) return;
                const k = Math.min(1, (performance.now() - start) / 500);
                this.cameraTarget.x = sx + (x - sx) * k;
                this.cameraTarget.z = sz + (z - sz) * k;
                if (k < 1) requestAnimationFrame(step);
            };
            step();
        }

        cancelCameraMove() { this._cameraMoveId++; }

        // Explicit camera commands share the same bounds as pointer gestures.
        // They only change the view, never entity positions or simulation speed.
        setCameraView(action, point) {
            this.cancelCameraMove();
            if (action === 'overview') { this.frameWholeMap(); return; }
            if (action === 'reset') {
                this._yaw = Math.PI / 4;
                this._pitch = Math.atan(0.5);
                this._halfH = 34;
            } else if (action === 'selection') {
                if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.z)) return;
                this.cameraTarget.set(point.x, 0, point.z);
                this._halfH = Math.min(this._halfH, 55);
            } else if (action === 'zoomIn' || action === 'zoomOut') {
                this._halfH *= action === 'zoomIn' ? 1 / 1.25 : 1.25;
            } else if (action === 'turnLeft' || action === 'turnRight') {
                this._yaw += (action === 'turnLeft' ? -1 : 1) * Math.PI / 4;
            }
            this._halfH = Math.max(MIN_HALF, Math.min(MAX_HALF, this._halfH));
            this._clampTarget();
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
        // A closed ribbon of quads laid along the painted coastline, for the surf.
        // Walks the square's perimeter as one continuous loop — which is what makes
        // the corners join by construction instead of by hand — and at each step
        // solves for the chebyshev radius where the waterline actually falls.
        // Returns the raw mesh rather than GPU buffers so it stays auditable.
        // inset places the ribbon's INNER edge in the mega-texture's own coast bands:
        // sand runs to landHalf+3 and water proper begins at landHalf+10, so +3 lays
        // the 7-wide ribbon exactly across the wetSand-to-water transition. It used
        // to sit at -2, which put five of its seven units up on dry beach.
        _coastRibbonMesh(seg = 480, width = 7, inset = 3) {
            const wob = TexGen.coastSampler(TERRAIN_SEED);
            const target = TERRAIN_LAND + inset;
            // The wobble depends on where we land, so the radius is implicit. Solve
            // by BISECTION: dist(r) = r + wobble(r) is strictly increasing, because
            // the wobble's slope stays under 1 across a noise cell. Fixed-point
            // iteration also converges on that, but only just — its contraction
            // factor sits near 0.94 where the noise is steep, so a few passes left
            // the ribbon drifting up to 3 units off the waterline. Bisection lands
            // it within 0.0002 for the same handful of samples.
            const radiusAt = (px, pz) => {
                let lo = target - TexGen.COAST_WOBBLE, hi = target + TexGen.COAST_WOBBLE;
                for (let i = 0; i < 18; i++) {
                    const mid = (lo + hi) / 2;
                    const d = mid + wob((mid * px) / TERRAIN_WORLD + 0.5,
                                        (mid * pz) / TERRAIN_WORLD + 0.5);
                    if (d < target) lo = mid; else hi = mid;
                }
                return (lo + hi) / 2;
            };
            const pts = [];
            let arc = 0;
            for (let i = 0; i <= seg; i++) {
                const t = (i / seg) * 4, side = Math.min(3, Math.floor(t)), s = t - side;
                const p = side === 0 ? [1, s * 2 - 1] : side === 1 ? [1 - s * 2, 1]
                    : side === 2 ? [-1, 1 - s * 2] : [s * 2 - 1, -1];
                const r = radiusAt(p[0], p[1]);
                const ix = r * p[0], iz = r * p[1];
                if (i) arc += Math.hypot(ix - pts[i - 1].ix, iz - pts[i - 1].iz);
                pts.push({ ix, iz, ox: (r + width) * p[0], oz: (r + width) * p[1], arc });
            }
            // Close the UV loop on a WHOLE number of tiles, or the surf shows a
            // visible break where the ribbon meets its own start.
            const tiles = Math.max(1, Math.round(arc / 17.5));
            const positions = [], normals = [], uvs = [], indices = [];
            pts.forEach(q => {
                const u = (q.arc / arc) * tiles;
                positions.push(q.ix, 0.18, q.iz, q.ox, 0.18, q.oz);
                normals.push(0, 1, 0, 0, 1, 0);
                uvs.push(u, 0, u, 1);
            });
            for (let i = 0; i < seg; i++) {
                const a = i * 2;
                indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
            }
            return { positions, normals, uvs, indices };
        }

        setTerrain(terrain) {
            if (this._grass) { this._grass.dispose(); this._grass = null; }
            if(this._clutterVisibilityTex){this.gl.deleteTexture(this._clutterVisibilityTex);this._clutterVisibilityTex=null;}
            this._clutterFow=null;
            this.terrain = terrain;
            const theme = terrain.difficulty === 'medium' ? 'winter'
                : (terrain.difficulty === 'hard' ? 'desert' : 'summer');
            this._buildTextures(theme);
            this._ground = {
                buf: this._buf('gridPlane', [TERRAIN_WORLD, 1, 1]),
                tex: this.tex.terrain, model: M().identity(), material: 1
            };
            // Open sea under everything, far past anything the camera can reach, so
            // the water's grain carries on to the horizon instead of stopping dead at
            // the ground plane's rim. Dropped well below y=0 rather than a hair: at
            // 2000 units out the depth buffer resolves ~0.12, so a token offset would
            // z-fight with the mega-texture's own water exactly where they overlap.
            const SEA = 12000;
            this._sea = {
                buf: this._buf('gridPlane', [SEA, 1, SEA / TexGen.OPEN_WATER_TILE]),
                tex: this.tex.openWater, model: M().translation(0, -0.35, 0), material: 2
            };
            // Replace THREE resource meshes with engine handles: fog toggles
            // handle.visible, depletion nulls res.mesh — both drive our draw.
            this._resEntries = new WeakMap();
            (terrain.resources || []).forEach(res => {
                res.mesh = res.type === 'wood'
                    ? { trunk: { visible: true }, leaves: { visible: true } }
                    : { visible: true };
            });
            // Shoreline foam: ONE closed ribbon that follows the painted coast,
            // pulsing and drifting (alpha/uvOff animated per frame). It replaces four
            // straight strips pinned at a fixed radius — the coast wobbles +/-13 units
            // around that square, so the old surf ran up the beach in places and sat
            // out in open water in others. Both now read the wobble from
            // TexGen.coastSampler, so they cannot drift apart again. A closed loop
            // also retires the corner hack the strips needed: there are no
            // overlapping ends left to double up and glow.
            this._foam = [{
                buf: GLCore.createMeshBuffers(this.gl, this._coastRibbonMesh()),
                tex: this.tex.foam, tint: this.WHITE, model: M().identity()
            }];

            const m3 = M();
            // Actual ground cover sits above the blended terrain surface; no
            // duplicate painted bushes, flowers or pebble spots underneath it.
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
                prop('sphere', [1, 7, 5], 'worldFoliage', this.WHITE, x, s * 0.5, z, s, s * 0.55, s, rng() * 6.28);
                if (rng() < 0.7) {
                    const a = rng() * 6.28, d = s * 0.8, s2 = s * (0.45 + rng() * 0.3);
                    prop('sphere', [1, 7, 5], 'worldFoliage', [0.88, 0.95, 0.85], x + Math.cos(a) * d, s2 * 0.5, z + Math.sin(a) * d, s2, s2 * 0.55, s2, rng() * 6.28);
                }
                if (snowCap) prop('sphere', [1, 7, 5], 'white', [0.93, 0.96, 1], x, s * 0.78, z, s * 0.72, s * 0.2, s * 0.72);
            };
            const pebble = (tint, texture='worldStone') => {
                const x = (rng() * 2 - 1) * HALF, z = (rng() * 2 - 1) * HALF;
                const s = 0.14 + rng() * 0.14;
                prop('sphere', [1, 6, 4], texture, tint, x, s * 0.5, z, s * 1.4, s * 0.6, s, rng() * 6.28);
            };
            if (theme === 'winter') {
                for (let i = 0; i < 220; i++) bush(true);
                for (let i = 0; i < 150; i++) pebble(Array(3).fill(.40+.10*i/149),'white');
            } else if (theme === 'desert') {
                for (let i = 0; i < 180; i++) bush(false);
                for (let i = 0; i < 150; i++) pebble([0.82, 0.6, 0.42]); // rust rocks
                for (let i = 0; i < 90; i++) pebble([0.9, 0.8, 0.62]);
            } else {
                for (let i = 0; i < 260; i++) bush(false);
                const petals = [[0.85, 0.84, 0.70], [0.78, 0.68, 0.40], [0.64, 0.57, 0.62]];
                for (let i = 0; i < 100; i++) { // sparse, muted flower tufts
                    const x = (rng() * 2 - 1) * HALF, z = (rng() * 2 - 1) * HALF;
                    const s = 0.11 + rng() * 0.08;
                    prop('sphere', [1, 5, 4], 'white', petals[(rng() * 3) | 0], x, 0.16, z, s, s, s);
                }
                for (let i = 0; i < 150; i++) pebble(Array(3).fill(.40+.10*i/149),'white');
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
                if (this._theme === 'winter' || this._theme === 'desert') {
                    const bare=this._theme==='winter' && ((i*37+11)%10)<2;
                    const style=this._theme==='desert'?'desert':bare?'bare':'pine';
                    const model=TRS(res.x,0,res.z,s,s,s,rot);
                    add('seasonalTree',[style,i%4,'bark'],'worldBark',model);
                    if(!bare){
                        add('seasonalTree',[style,i%4,'foliage'],'worldFoliage',model);
                        e.opaque[e.opaque.length-1].tint=this._theme==='desert'?[.78,.78,.66]:[.82,.94,1];
                    }
                    if(style==='pine'){
                        add('seasonalTree',[style,i%4,'snow'],'white',model);
                        e.opaque[e.opaque.length-1].tint=[.87,.92,.96];
                    }
                } else {
                    add('cylinder', [0.24, 0.4, 2.4, 7], 'worldBark', TRS(res.x, 1.2 * s, res.z, s, s, s, rot));
                    // Branch endpoints start inside the trunk and finish inside a
                    // single crown. Previously three upright stubs were detached.
                    for(let branch=0;branch<2;branch++) {
                        const a=rot+branch*2.6, dx=Math.sin(a), dz=Math.cos(a);
                        let fork=m3.multiply(m3.translation(res.x+dx*.45*s,2.2*s,res.z+dz*.45*s),m3.rotationY(a));
                        fork=m3.multiply(fork,m3.rotationX(Math.atan2(.9,1.4)));
                        fork=m3.multiply(fork,m3.scaling(s,s,s));
                        add('cylinder',[.09,.19,Math.hypot(.9,1.4),8],'worldBark',fork);
                    }
                    add('canopy',[i%4],'worldFoliage',TRS(res.x,3.3*s,res.z,2.15*s,1.38*s,1.88*s,rot));
                }
            } else if (res.type === 'stone') {
                add('disc', [2.0, 14], 'shadow', TRS(res.x, 0.05, res.z, 1, 1, 1), true);
                add('sphere', [1, 9, 6], 'worldStone', TRS(res.x, 0.9 - sink(2.3), res.z, 1.7, 1.15, 1.5, rot));
            } else if (res.type === 'gold') {
                add('disc', [1.8, 14], 'shadow', TRS(res.x, 0.05, res.z, 1, 1, 1), true);
                add('sphere', [1, 9, 6], 'worldOre', TRS(res.x, 0.8 - sink(2.1), res.z, 1.5, 1.05, 1.4, rot));
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

        // '#RRGGBB' → tint vec3 (team-badge colors are authored as CSS hex).
        _hexTint(hex) {
            return this._tintOf(parseInt(String(hex).replace('#', ''), 16));
        }

        // Fill/rim tints of an entity's team badge (per-seat ownership circle).
        // No seat (engine-test, defensive) → both fall back to the team tint so
        // the badge dissolves into the cloth instead of showing a wrong color.
        _flagTexture(seat,tint,unit=false) {
            if(!this._flagTextures)this._flagTextures=new Map();
            const key=JSON.stringify([seat,tint,unit]);
            if(this._flagTextures.has(key))return this._flagTextures.get(key);
            const c=document.createElement('canvas');c.width=256;c.height=unit?256:128;
            const ctx=c.getContext('2d');ctx.drawImage(TexGen.cloth(155),0,0,256,c.height);
            ctx.globalCompositeOperation='multiply';
            ctx.fillStyle=`rgb(${tint.map(v=>Math.round(v*255)).join(',')})`;ctx.fillRect(0,0,256,c.height);
            ctx.globalCompositeOperation='source-over';
            if(typeof drawTeamBadgeOnCanvas==='function'&&seat!=null){
                ctx.save();ctx.translate(128,c.height/2);if(!unit)ctx.scale((256/.85)/(128/.55),1);
                drawTeamBadgeOnCanvas(ctx,seat,0,0,unit?128:60,true);ctx.restore();
            }
            const tex=GLCore.createTextureFromCanvas(this.gl,c,{clamp:true});
            this._flagTextures.set(key,tex);return tex;
        }

        _badgeTints(seat, fallback) {
            const b = (typeof getTeamBadge === 'function') ? getTeamBadge(seat) : null;
            return b ? { fill: this._hexTint(b.fill), rim: this._hexTint(b.rim) }
                : { fill: fallback, rim: fallback };
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
            const bdef = (typeof getTeamBadge === 'function') ? getTeamBadge(unit.seat) : null;
            const badge = this._badgeTints(unit.seat, tint);
            const options={civ:unit.civilization,unit:unit.type,badge:bdef?bdef.shape:null,
                variant:EngineUnits.appearanceVariant(unit.civilization,unit._appearanceId ?? unit.handle ?? unit.id ?? '')};
            const modelKey=JSON.stringify([engineType,options.civ,options.unit,options.badge,options.variant]);
            if(!this._unitModels) this._unitModels=new Map();
            if(!this._unitModels.has(modelKey)) {
                const batches=EngineUnits.batches(EngineUnits.parts(engineType,options));
                this._unitModels.set(modelKey,batches.map(p=>({
                    buf:GLCore.createMeshBuffers(this.gl,p.mesh), texName:p.tex,
                    team:p.team,accent:p.accent,bone:p.bone,blend:p.blend,badgePaint:p.badgePaint
                })));
            }
            const entries=this._unitModels.get(modelKey).map(p=>({
                buf:p.buf,tex:p.badgePaint?this._flagTexture(unit.seat,tint,true):this.tex[p.texName],
                tint:p.badgePaint?this.WHITE:(p.accent?badge[p.accent]:(p.team?tint:this.WHITE)),
                base:M().identity(),bone:p.bone,blend:p.blend,model:M().identity()
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
                    archery_range: 4.6, academy: 5.1, market: 5.1, farm: 1.2, tower: 8.9, temple: 6
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
            const grassFoot = this._meshFootprint(parts, `${building.type}|${building.age}|${building.civilization}|${!!building.underConstruction}`);
            const ca = Math.abs(Math.cos(building.rotationY || 0)), sa = Math.abs(Math.sin(building.rotationY || 0));
            building._grassFootprint = { ex: (grassFoot.ex*ca + grassFoot.ez*sa)*BSCALE + 1,
                ez: (grassFoot.ex*sa + grassFoot.ez*ca)*BSCALE + 1 };
            parts.forEach((p, i) => {
                const entry = {
                    buf: this._buf(p.kind, p.args), tex: this.tex[p.tex],
                    tint: p.team ? tint : (p.tint || this.WHITE), // authored cultural finishes; flags retain player colors
                    model: m3.multiply(world, p.m), base: p.m
                };
                if (i === shellIdx) { entry.tint = tint; eb.shell = entry; }
                (p.blend ? eb.blended : eb.opaque).push(entry);
            });
            // a team-color banner post at the corner so ownership reads at a glance
            if (!building.underConstruction) {
                // Plant the post clear of the ACTUAL mesh. The old flat 3.4 (5.4 for
                // wonders) was a footprint no building ever agreed to: a tower reaches
                // ~3.2, but a town centre, house or archery range reaches ~6 and a
                // wonder more — and the pole is only 2.6 tall with its cloth at 2.25,
                // far below those roofs. So every large building simply swallowed its
                // own flag, and ownership stopped reading at a glance exactly where it
                // mattered most.
                const fp = this._meshFootprint(parts, `${building.type}|${building.age}|${building.civilization}`);
                const offX = fp.ex + 0.55, offZ = fp.ez + 0.55;
                const dressing=EngineBuildings.settlement(building.type,building.civilization,fp);
                eb.lamps=[];
                for(const side of (building.type==='town_center'||building.isWonder?[-1,1]:[-1])){
                    const lamp=EngineBuildings.entranceLamp(building.type,building.age,building.civilization,fp,parts,side,!!building.isWonder);
                    dressing.parts.push(...lamp.parts);
                    if(lamp.light){
                        const [x,y,z]=lamp.light;
                        eb.lamps.push({position:[world[0]*x+world[8]*z+world[12],world[5]*y+world[13],world[2]*x+world[10]*z+world[14]],early:lamp.early,
                            pool:m3.multiply(world,m3.multiply(m3.translation(x,.035,z),m3.scaling(2.1,1,1.8)))});
                    }
                }
                eb.details=dressing.parts.map(p=>({buf:this._buf(p.kind,p.args),tex:this.tex[p.tex],
                    tint:p.tint||this.WHITE,model:m3.multiply(world,p.m)}));
                if(dressing.fire){
                    const [x,y,z]=dressing.fire;
                    eb.fire=[world[0]*x+world[8]*z+world[12],world[5]*y+world[13],world[2]*x+world[10]*z+world[14]];
                }
                if(building.type!=='farm')eb.wear={buf:this._buf('disc',[1,18]),tex:this.tex.mote,
                    tint:this._theme==='winter'?[.45,.43,.37]:[.32,.25,.16],alpha:.26,
                    model:m3.multiply(world,m3.multiply(m3.translation(0,.025,fp.ez+.5),m3.scaling(1.45,1,2.3)))};
                eb.opaque.push({
                    buf: this._buf('cylinder', [0.07, 0.09, 2.6, 5]), tex: this.tex.bark, tint: this.WHITE,
                    model: m3.multiply(world, m3.translation(offX, 1.3, offZ))
                });
                eb.opaque.push({
                    buf: this._buf('flag', [0.85, 0.55, 12]), tex: this._flagTexture(building.seat,tint), tint:this.WHITE,
                    model: m3.multiply(world, m3.translation(offX + 0.45, 2.25, offZ))
                });
                eb.flagAnchor=m3.multiply(world,m3.translation(offX+.025,2.25,offZ));
                eb.flagParts=[{entry:eb.opaque[eb.opaque.length-1],local:m3.translation(.425,0,0)}];
                // The badge is printed into this same fabric, on both faces.
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

        spawnProjectile(from, to, kind, shooter) {
            if (this.game?.sound) this.game.sound.projectile(from, kind, shooter);
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
            if(this._flagTextures){this._flagTextures.forEach(tex=>this.gl.deleteTexture(tex));this._flagTextures.clear();}
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

        // minRadius widens the target without changing what a unit IS. The click
        // radius is a world measurement -- it has to be, it is drawn from the unit's own
        // size -- but that means how big it is ON SCREEN depends entirely on the zoom.
        // Callers that know the zoom can pass a floor here; existing callers pass
        // nothing and get exactly what they always did.
        pickUnitAt(x, z, owner = null, minRadius = 0) {
            let best = null, bestDist = Infinity;
            this.units.forEach(unit => {
                if (owner && unit.owner !== owner) return;
                if (unit.health <= 0) return;
                const dist = Math.hypot(unit.x - x, unit.z - z);
                if (dist <= Math.max(this.unitClickRadius(unit), minRadius) && dist < bestDist) {
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

        // ---- input: spectator navigation / campaign selection and navigation ----
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

        updatePointerCursor() {
            if(this.canvas && this.canvas.style) this.canvas.style.cursor=
                this._panDrag && this._panDrag.moved ? 'grabbing' : (this._spectating() || this.panMode ? 'grab' : '');
        }

        cancelPointerGesture() {
            this._clearHold();
            this._panDrag=null; this._rotateDrag=null; this._pinch=null;
            this._coordHold=false; this._touchCommandReady=false;
            this.keysPressed={};
            if(typeof game!=='undefined' && game && game.inputManager) game.inputManager.cancelGesture();
            this.updatePointerCursor();
        }

        _manualPan(dx,dy) {
            ++this._cameraMoveId; // an outstanding focus/overview tween cannot pull back
            const wpp=(2*this._halfH)/(this.canvas.clientHeight||1);
            const cy=Math.cos(this._yaw),sy=Math.sin(this._yaw);
            const right=-dx*wpp,forward=dy*wpp/Math.max(.17,Math.sin(this._pitch));
            this.cameraTarget.x+=right*cy-forward*sy;
            this.cameraTarget.z-=right*sy+forward*cy;
            this._clampTarget();
        }

        onCanvasMouseDown(event) {
            if(Date.now()<(this._ignoreMouseUntil||0)) return;
            const spectator=this._spectating();
            if(event.button===1) {
                if(typeof game!=='undefined' && game && game.disableActionCam) game.disableActionCam();
                this._rotateDrag={x:event.clientX,y:event.clientY};
                event.preventDefault();
            } else if((event.button===0 && (spectator || this.panMode)) || (event.button===2 && !spectator)) {
                this._panDrag={x:event.clientX,y:event.clientY,ox:event.clientX,oy:event.clientY,
                    moved:false,button:event.button,spectator};
                event.preventDefault();
            }
            this.updatePointerCursor();
        }

        onCanvasMouseMove(event) {
            if(Date.now()<(this._ignoreMouseUntil||0)) return;
            if(this._rotateDrag) {
                const dx=event.clientX-this._rotateDrag.x,dy=event.clientY-this._rotateDrag.y;
                this._rotateDrag={x:event.clientX,y:event.clientY};
                this._yaw-=dx*.006;
                this._pitch=Math.max(10*Math.PI/180,Math.min(89*Math.PI/180,this._pitch+dy*.004));
                return;
            }
            const pd=this._panDrag;
            if(!pd) return;
            if(pd.spectator!==this._spectating()) { this.cancelPointerGesture(); return; }
            if(!pd.moved) {
                if(Math.hypot(event.clientX-pd.ox,event.clientY-pd.oy)<5) return;
                pd.moved=true;
                if(typeof game!=='undefined' && game && game.disableActionCam) game.disableActionCam();
            }
            this._manualPan(event.clientX-pd.x,event.clientY-pd.y);
            pd.x=event.clientX;pd.y=event.clientY;
            this.updatePointerCursor();
        }

        onCanvasMouseUp(event) {
            const pd=this._panDrag;
            if(pd && event.button!==pd.button) return;
            this._panDrag=null;this._rotateDrag=null;
            this.updatePointerCursor();
            const onCanvas=!event.target || event.target===this.canvas;
            if(pd && !pd.moved && Math.hypot(event.clientX-pd.ox,event.clientY-pd.oy)<5
                && onCanvas && pd.button===0 && pd.spectator && this._spectating()
                && game.spectatorPick) {
                // Replay's viewport owns mouse picking, avoiding a duplicate pick.
                if(!this.replayMode) game.spectatorPick(event.clientX,event.clientY);
            } else if(pd && !pd.moved && pd.button===0 && !pd.spectator && !this._spectating()
                && onCanvas && Math.hypot(event.clientX-pd.ox,event.clientY-pd.oy)<5
                && typeof game!=='undefined' && game && game.inputManager) {
                // The hand tool changes drags, not ordinary unit/building clicks.
                game.inputManager.touchAction(event.clientX,event.clientY);
            }
        }

        onCanvasWheel(e) {
            e.preventDefault();
            // Manual zoom is a manual camera action — hand control back to the user.
            if (typeof game !== 'undefined' && game && game.spectatorMode && game.disableActionCam) game.disableActionCam();
            const factor = e.deltaY > 0 ? 1.12 : (1 / 1.12);
            this._halfH = Math.max(MIN_HALF, Math.min(MAX_HALF, this._halfH * factor));
        }

        // One finger pans in either mode, tap inspects/selects. A stationary
        // campaign hold arms a command, committed only on release. Multitouch,
        // movement, cancellation and leaving the screen discard that command.
        _spectating() {
            return !!(typeof game !== 'undefined' && game && game.spectatorMode);
        }

        _touchPair(e) {
            const a = e.touches[0], b = e.touches[1];
            const dx = b.clientX - a.clientX, dy = b.clientY - a.clientY;
            return {
                cx: (a.clientX + b.clientX) / 2, cy: (a.clientY + b.clientY) / 2,
                dist: Math.hypot(dx, dy), angle: Math.atan2(dy, dx),
                twist: 0, twistOn: false, tilt: 0, tiltOn: false
            };
        }

        _clearHold() {
            if (this._holdTimer) { clearTimeout(this._holdTimer); this._holdTimer = null; }
        }

        onCanvasTouchStart(e) {
            e.preventDefault();
            this._ignoreMouseUntil=Date.now()+800;
            this._touchSpectator=this._spectating();
            this._touchCommandReady=false;
            this._coordHold=false;
            if(typeof game!=='undefined' && game && game.inputManager) game.inputManager.cancelGesture();
            this._clearHold();
            if (e.touches.length === 1) {
                const x = e.touches[0].clientX, y = e.touches[0].clientY;
                this._pinch = null;
                this._panDrag = { x, y, ox: x, oy: y, moved: false };
                // A finger that stays put reads as holding the right button. Cancelled
                // by the first real movement, so a pan never waits on the timer.
                this._holdTimer = setTimeout(() => {
                    this._holdTimer = null;
                    if (!this._panDrag || this._panDrag.moved) return;
                    if(this._spectating()) {
                        this._coordHold=true;
                        if(game.inputManager) game.inputManager.showCoordFlag(x,y);
                    } else {
                        this._touchCommandReady=true;
                    }
                }, 450);
            } else {
                // Re-seeded on every extra finger, so a third one landing cannot leave
                // the pair measuring from where two other fingers used to be.
                this._panDrag = null;
                this._pinch = this._touchPair(e);
                if (game.disableActionCam) game.disableActionCam();
            }
        }

        onCanvasTouchMove(e) {
            if(this._touchSpectator!==this._spectating()) { this.cancelPointerGesture(); return; }
            e.preventDefault();
            this._ignoreMouseUntil=Date.now()+800;
            if (this._pinch && e.touches.length >= 2) {
                const p = this._pinch, now = this._touchPair(e);
                if (p.dist > 0 && now.dist > 0) {
                    this._halfH = Math.max(MIN_HALF, Math.min(MAX_HALF, this._halfH * (p.dist / now.dist)));
                }
                // Turning and tilting each stay locked until the gesture clearly asks
                // for them. Two fingers are never perfectly steady, so without the
                // locks a plain pinch walks the map a degree at a time and the north
                // you had is quietly gone with nothing to blame.
                let da = now.angle - p.angle;
                if (da > Math.PI) da -= 2 * Math.PI;
                else if (da < -Math.PI) da += 2 * Math.PI;
                now.twist = p.twist + da;
                now.twistOn = p.twistOn || Math.abs(now.twist) > 0.12;   // about 7 degrees
                if (now.twistOn) this._yaw -= da;                        // same sign as middle-drag
                const dy = now.cy - p.cy;
                now.tilt = p.tilt + dy;
                now.tiltOn = p.tiltOn || Math.abs(now.tilt) > 18;        // pixels
                if (now.tiltOn) {
                    this._pitch = Math.max(10 * Math.PI / 180,
                        Math.min(89 * Math.PI / 180, this._pitch + dy * 0.004));
                }
                this._pinch = now;
                return;
            }
            if (!this._panDrag || e.touches.length !== 1) return;
            const x = e.touches[0].clientX, y = e.touches[0].clientY;
            if (this._coordHold) {   // the flag follows the finger; no pan while it is up
                if (game.inputManager) game.inputManager.showCoordFlag(x, y);
                return;
            }
            if (!this._panDrag.moved) {
                // 8px, not the mouse's 5: a fingertip is wider than a cursor and a tap
                // meant as a pick drifts more than a click does.
                if (Math.hypot(x - this._panDrag.ox, y - this._panDrag.oy) < 8) return;
                this._panDrag.moved = true;
                this._touchCommandReady=false;
                this._clearHold();
                if (game.disableActionCam) game.disableActionCam();
            }
            const dx = x - this._panDrag.x, dy = y - this._panDrag.y;
            this._panDrag.x = x; this._panDrag.y = y;
            this._manualPan(dx,dy);
            this.updatePointerCursor();
        }

        onCanvasTouchEnd(e) {
            if(this._touchSpectator!==this._spectating()) { this.cancelPointerGesture(); return; }
            e.preventDefault();
            this._ignoreMouseUntil=Date.now()+800;
            this._clearHold();
            // Read BEFORE clearing: a long press ends with a finger that never moved,
            // which is the same shape as a tap, and would otherwise also inspect.
            const wasCoord = this._coordHold;
            if (wasCoord) {
                this._coordHold = false;
                if (game.inputManager) game.inputManager.hideCoordFlag();
            }
            const pd = this._panDrag;
            if (e.touches.length === 0) {
                this._panDrag = null;
                this._pinch = null;
                const released=e.changedTouches && e.changedTouches[0];
                const x=released?released.clientX:(pd?pd.x:0), y=released?released.clientY:(pd?pd.y:0);
                if (pd && !pd.moved && !wasCoord && Math.hypot(x-pd.ox,y-pd.oy)<8) {
                    // The analyzer owns picking on its own screen -- spectatorPick
                    // delegates to anPickAt there and returns. But anPickAt is reached
                    // from mousedown/mouseup on #anViewport, and this handler cancels the
                    // synthetic mouse events those rely on. So a tap on the replay board
                    // fell into the gap between the two: the renderer would not pick, and
                    // the analyzer never heard. Same delegation, made explicit.
                    const an = document.getElementById('analyzeScreen');
                    if (an && an.classList.contains('active')) {
                        if (game.ui && game.ui.anPickAt) game.ui.anPickAt(pd.ox, pd.oy);
                    } else if(this._spectating() && game.spectatorPick) {
                        game.spectatorPick(x,y);
                    } else if(game.inputManager) {
                        game.inputManager.touchAction(x,y,this._touchCommandReady);
                    }
                }
                this._touchCommandReady=false;
                this.updatePointerCursor();
            } else if (e.touches.length === 1) {
                this._touchCommandReady=false;
                // One of two lifted: carry on panning from where the remaining finger
                // is, rather than jumping the map by the gap between them.
                const t = e.touches[0];
                this._pinch = null;
                this._panDrag = { x: t.clientX, y: t.clientY, ox: t.clientX, oy: t.clientY, moved: true };
            } else {
                this._pinch = this._touchPair(e);
            }
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

            if (this._sea) dl.opaque.push(this._sea);      // under the island, out to the horizon
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
            if (this.graphicsQuality === 'cinematic' && typeof EngineGrass !== 'undefined') {
                if (!this._grass) this._grass = new EngineGrass.Grass(this);
                const grassStart = performance.now();
                dl.opaque.push(...this._grass.frame());
                this.grassStats.cpuMs = performance.now() - grassStart;
            }
            // (sub-pixel at halfH 90+, and the draw-call budget thanks us)
            if (this._props && this._halfH < 90) {
                for (const pr of this._props) {
                    if (this._cull(pr.x, pr.z, 3)) continue;
                    if (typeof EngineGrass !== 'undefined' && !EngineGrass.visibleRect(this.game?.fogOfWar,pr.x,pr.z,3,3,true)) continue;
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

            // Cosmetic motion pauses with the simulation. Keep a hard particle
            // budget: at most eight hearths, five two-triangle sprites each.
            const ambientTime=this.game?._environmentSeconds||0;
            const lightTime=this.game?._showcaseCivilization?(this.game._showcaseLightSeconds||0):ambientTime;
            const lampNight=window.EngineAtmosphere.daylight(lightTime,[1,1,1],[1,1,1],this._theme).night;
            let hearths=0, courtyards=0;
            // buildings
            for (const b of this.buildings) {
                const eb = b._engine;
                if (!eb || (b.mesh && b.mesh.visible === false) || this._cull(b.x, b.z, 18)) continue;
                const distance=Math.hypot(b.x-this.cameraTarget.x,b.z-this.cameraTarget.z);
                const detailFade=Math.max(0,Math.min(1,(300-distance)/90,(300-this._halfH)/105));
                // Clear the previous frame's light when hidden, zoomed out or disabled.
                for(const en of eb.opaque)en.localLights=null;
                for(const en of eb.details||[])en.localLights=null;
                if(eb.flagParts) {
                    const angle=this.graphicsQuality==='cinematic'?.12*Math.sin(ambientTime*1.7+b.x*.1)+.04*Math.sin(ambientTime*3.1+b.z*.1):0;
                    const flag=m3.multiply(eb.flagAnchor,m3.rotationY(angle));
                    const cloth=this.graphicsQuality==='cinematic'?[flag[12],flag[14],flag[0]/BSCALE,flag[2]/BSCALE]:null;
                    for(const p of eb.flagParts){p.entry.model=m3.multiply(flag,p.local);p.entry.cloth=cloth;}
                }
                if(this.graphicsQuality==='cinematic'&&detailFade>0&&!(b._fade!=null&&b._fade<1)) {
                    if(eb.wear)dl.blended.push({...eb.wear,alpha:eb.wear.alpha*detailFade});
                    if(eb.details&&courtyards++<24){
                        const lights=new Float32Array(12);let lightIndex=0;
                        const addLight=(x,y,z,strength)=>{if(lightIndex<3)lights.set([x,y,z,strength],4*lightIndex++);};
                        for(const en of eb.opaque)en.localLights=lights;
                        for(const en of eb.details)en.localLights=lights;
                        for(const lamp of eb.lamps||[]){
                        if(lamp&&lampNight>0&&(!this.game?.fogOfWar||this.game.fogOfWar.isPositionVisible(lamp.position[0],lamp.position[2]))){
                            const [x,y,z]=lamp.position;
                            const flicker=1+.05*Math.sin(ambientTime*8+x)+.025*Math.sin(ambientTime*13+z);
                            const strength=2*lampNight*detailFade*flicker;
                            addLight(x,y,z,strength);
                            dl.blended.push({buf:ringBuf,tex:this.tex.mote,tint:[1,.47,.10],alpha:strength*.20,additive:true,model:lamp.pool});
                            for(const [w,h,tint,alpha] of [[.65,.75,[1,.35,.045],.3],[.15,lamp.early?.34:.16,[1,.76,.28],.95]])
                                dl.blended.push({buf:quad,tex:this.tex.mote,tint,alpha:alpha*strength,additive:true,
                                    model:m3.multiply(m3.multiply(m3.translation(x,y,z),bb),m3.scaling(w,h*flicker,1))});
                        }
                        }
                        // Alpha fade shares the existing blended pass near the limit.
                        for(const p of eb.details) (detailFade===1?dl.opaque:dl.blended).push(detailFade===1?p:{...p,alpha:detailFade});
                        const visible=eb.fire&&(!this.game?.fogOfWar||this.game.fogOfWar.isPositionVisible(eb.fire[0],eb.fire[2]));
                        if(eb.fire&&visible&&hearths++<8){
                            const [x,y,z]=eb.fire,phase=ambientTime+b.x*.17+b.z*.11;
                            addLight(x,y+.55,z,3*detailFade);
                            dl.blended.push({buf:ringBuf,tex:this.tex.mote,tint:[1,.38,.07],alpha:.4*detailFade,additive:true,
                                model:m3.multiply(m3.translation(x,.04,z),m3.scaling(2.4,1,2.4))});
                            const mote=(px,py,pz,w,h,tint,alpha,emission=0)=>dl.blended.push({buf:quad,tex:this.tex.mote,tint,alpha:alpha*detailFade*(emission||1),additive:!!emission,
                                model:m3.multiply(m3.multiply(m3.translation(px,py,pz),bb),m3.scaling(w,h,1))});
                            for(let i=0;i<3;i++){
                                const age=((phase*.18+i/3)%1+1)%1;
                                mote(x+age*.65,y+.5+age*2.8,z+age*.25,.45+age*.8,.6+age*.9,[.43,.44,.45],Math.sin(age*Math.PI)*.18);
                            }
                            const flicker=1+.12*Math.sin(phase*9)+.08*Math.sin(phase*13);
                            mote(x,y+.42,z,.5,.65*flicker,[1,.30,.035],.85,3);
                            mote(x,y+.29,z,.23,.32*flicker,[1,.78,.22],.95,3);
                        }
                    }
                }
                if (b.underConstruction && eb.shell) {
                    // Unit-height shell box grown from the plinth to pct of the
                    // final building height (b._shellH, set in _composeBuilding).
                    const pct = Math.min(1, (b.buildProgress || 0) / (b.buildTime || 10000));
                    const hNow = Math.max(0.15, (b._shellH || 4) * pct);
                    eb.shell.model = m3.multiply(eb.world,
                        m3.multiply(m3.translation(0, 0.5 + hNow / 2, 0), m3.scaling(1, hNow, 1)));
                }
                const flash = b._flashUntil && now < b._flashUntil;
                // Same persistent fade as units: a remembered position renders
                // translucent through the blended pass, since alpha in the opaque
                // pass has nothing to blend against.
                if (b._fade != null && b._fade < 1) {
                    for (const en of eb.opaque) dl.blended.push({ ...en, alpha: b._fade });
                    for (const en of eb.blended) dl.blended.push({ buf: en.buf, tex: en.tex, tint: en.tint, model: en.model, alpha: b._fade });
                } else {
                for (const en of eb.opaque) dl.opaque.push(flash ? { ...en, tint: FLASH } : en);
                for (const en of eb.blended) dl.blended.push(en);
                }
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
                // Travel facing follows ACTUAL motion, not stale destinations. Only
                // SOME movers maintain targetX/targetZ: game.js's attack-move march
                // sets isMoving and advances the unit without ever touching it, and
                // the separation/clearance passes move units too. Steering by a
                // stale target is what left a unit that had just WON a fight
                // marching off to its rally point with its face still on the dead
                // enemy — walking backwards. Where a unit actually went is the one
                // signal every mover updates by definition. (The renderer's legacy
                // MOVER was deleted for this same stale-target reason; its facing
                // was left reading the same rotten value.)
                let dir = this._unitDir.get(u);
                if (dir === undefined) { dir = 0; this._unitDir.set(u, dir); }
                const prev = this._unitPrev.get(u);
                // isMoving gates it so the separation nudges can't spin an idle
                // unit on the spot; the delta then says which way it truly went.
                const facingTarget=u.isAttacking&&u.attackTarget?.health>0?u.attackTarget:null;
                if (facingTarget || (u.isMoving && prev)) {
                    // A live combat target is authoritative. Friendly separation
                    // can briefly displace a new defender away from the brawl;
                    // that correction must not turn its body away from the enemy.
                    const mx = facingTarget ? facingTarget.x-u.x : u.x-prev.x;
                    const mz = facingTarget ? facingTarget.z-u.z : u.z-prev.z;
                    if (mx * mx + mz * mz > 1e-6) {
                        const want = Math.atan2(mx, mz);
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
                }
                this._unitPrev.set(u, { x: u.x, z: u.z });
                const anim = (u.isHarvesting || u.isBuilding) ? 'harvest' : (u.isMoving ? 'walk' : 'idle');
                const pose = EngineUnits.pose(ue.type, anim, tSec, ue.phase);
                const spin = m3.rotationY(dir);
                const world = m3.multiply(m3.translation(u.x, pose.bob, u.z), spin);
                const flat = m3.multiply(m3.translation(u.x, 0, u.z), spin);
                const flash = u._flashUntil && now < u._flashUntil;
                let workerLights=null;
                const lampFade=Math.max(0,Math.min(1,(300-Math.hypot(u.x-this.cameraTarget.x,u.z-this.cameraTarget.z))/90,(300-this._halfH)/105));
                if(ue.lampLights)ue.lampLights.fill(0);
                if(u.type==='worker'&&ue.type==='worker'&&this.graphicsQuality==='cinematic'&&lampFade>0&&!(u._fade!=null&&u._fade<1)){
                    if(!this._workerLampModel)this._workerLampModel=EngineUnits.batches(EngineUnits.workerLantern()).map(p=>({buf:GLCore.createMeshBuffers(this.gl,p.mesh),texName:p.tex,tint:p.tex==='white'?[1,.64,.22]:this.WHITE}));
                    const [lx,ly,lz]=EngineUnits.WORKER_LANTERN_POSITION;
                    const x=world[0]*lx+world[8]*lz+world[12],y=world[5]*ly+world[13],z=world[2]*lx+world[10]*lz+world[14];
                    const visible=!this.game?.fogOfWar||this.game.fogOfWar.isPositionVisible(x,z);
                    const strength=visible?1.1*lampNight*lampFade*(1+.04*Math.sin(ambientTime*7+ue.phase)):0;
                    workerLights=ue.lampLights||=(new Float32Array(12));workerLights.set([x,y,z,strength]);
                    for(const part of this._workerLampModel){const e={...part,tex:this.tex[part.texName],model:world,localLights:workerLights};(lampFade===1?dl.opaque:dl.blended).push(lampFade===1?e:{...e,alpha:lampFade});}
                    if(strength>0){
                        dl.blended.push({buf:ringBuf,tex:this.tex.mote,tint:[1,.47,.10],alpha:strength*.18,additive:true,model:m3.multiply(m3.translation(x,.035,z),m3.scaling(1.6,1,1.6))});
                        for(const [w,h,tint,alpha]of[[.40,.46,[1,.38,.06],.28],[.09,.14,[1,.80,.38],.9]])
                            dl.blended.push({buf:quad,tex:this.tex.mote,tint,alpha:alpha*strength,additive:true,model:m3.multiply(m3.multiply(m3.translation(x,y,z),bb),m3.scaling(w,h,1))});
                    }
                }
                for (const e of ue.entries) {
                    const local = e.bone && pose.mats[e.bone] ? m3.multiply(pose.mats[e.bone], e.base) : e.base;
                    const model = m3.multiply(e.blend ? flat : world, local);
                    e.model = model; // keep the composed matrix — death ghosts snapshot it
                    // A faded entity goes through the BLENDED pass whatever its part says,
                    // because alpha in the opaque pass has nothing to blend against. `_fade`
                    // is persistent, unlike a death ghost: the analyzer uses it for a
                    // position it remembers but cannot currently see.
                    if (u._fade != null && u._fade < 1) {
                        dl.blended.push({ buf: e.buf, tex: e.tex, tint: e.tint, model, alpha: u._fade });
                    } else if (e.blend) dl.blended.push({ buf: e.buf, tex: e.tex, tint: e.tint, model });
                    else dl.opaque.push({ buf: e.buf, tex: e.tex, tint: flash ? FLASH : e.tint, model, localLights:workerLights });
                }
                if (u.selected) {
                    // Deliberately the same shape as the building ring above: same texture,
                    // same tint, a fixed world radius, no zoom scaling and no pixel floor.
                    // Every one of those was added to make an invisible ring visible, and
                    // the ring was never the problem — spectatorPick was deleting the
                    // selection on the same click that made it (see game.spectatorPick).
                    // With that fixed there is nothing left to compensate for, and a marker
                    // that behaves differently from the one next to it is its own bug.
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
        // The civ name is BAKED INTO the banner texture, so no amount of re-rendering
        // reaches it: the cache hands back the picture taken in whatever language was
        // active when that seat's first Town Center was drawn, and only a page reload —
        // which builds a new renderer with an empty cache — ever changed it. Switching
        // the UI to English left 希腊 floating over the Greek base.
        //
        // Dropping the entries is the whole fix: _assembleFrame calls _bannerFor for
        // every Town Center on every frame, so the next frame re-bakes each one in the
        // current language. Called between frames from the UI, never mid-draw, so the
        // textures being deleted are not in the display list anyone is about to submit.
        invalidateBanners() {
            if (!this._bannerTex) return;
            this._bannerTex.forEach(tex => { try { this.gl.deleteTexture(tex); } catch (e) {} });
            this._bannerTex.clear();
        }

        _bannerFor(building) {
            const civId = building.civilization || 'x';
            // Cache per (civ, SEAT), not per civ: with two seats on the same civ (a
            // 4× Egypt arena) a civ-only key gave every Town Center one identical
            // banner, so the map couldn't tell them apart — the exact problem the
            // seat badge on this banner now solves.
            const seat = building.seat != null ? building.seat : '?';
            const key = civId + ':' + seat;
            if (this._bannerTex.has(key)) return this._bannerTex.get(key);
            const civ = (typeof getCivilization === 'function') ? getCivilization(civId) : null;
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
            // Seat badge at the left; the civ name fills the rest, shrinking to fit
            // beside it so it never collides with the mark or the border.
            const hasBadge = typeof drawTeamBadgeOnCanvas === 'function' && building.seat != null;
            if (hasBadge) drawTeamBadgeOnCanvas(ctx, building.seat, 36, 32, 44, true);
            const name = (typeof t === 'function' ? t('civ.' + civId + '.name') : null) || civ.name || civId;
            const nameLeft = hasBadge ? 62 : 12, nameRight = 250;
            const cx = (nameLeft + nameRight) / 2, maxW = nameRight - nameLeft;
            let fs = 30;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillStyle = colHex;
            ctx.font = `bold ${fs}px sans-serif`;
            while (fs > 16 && ctx.measureText(name).width > maxW) { fs -= 2; ctx.font = `bold ${fs}px sans-serif`; }
            ctx.fillText(name, cx, 34);
            const tex = GLCore.createTextureFromCanvas(this.gl, c, { clamp: true, nomip: true });
            this._bannerTex.set(key, tex);
            return tex;
        }

        // fog display canvas → GL texture (uploaded only when fog marked it dirty)
        _syncFog() {
            const fow = this.game && this.game.fogOfWar;
            this._clutterFogActive = !!fow?.fogGrid;
            if (this._clutterFogActive && (this._clutterFow!==fow || this._clutterFogVersion!==fow.visibilityVersion)) {
                const gl=this.gl,n=fow.numTiles,bytes=new Uint8Array(n*n);
                for(let i=0;i<bytes.length;i++)bytes[i]=fow.fogGrid[i]>=1?255:0;
                if(!this._clutterVisibilityTex)this._clutterVisibilityTex=gl.createTexture();
                gl.bindTexture(gl.TEXTURE_2D,this._clutterVisibilityTex);
                gl.pixelStorei(gl.UNPACK_ALIGNMENT,1);
                gl.texImage2D(gl.TEXTURE_2D,0,gl.LUMINANCE,n,n,0,gl.LUMINANCE,gl.UNSIGNED_BYTE,bytes);
                gl.pixelStorei(gl.UNPACK_ALIGNMENT,4);
                gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);
                gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
                gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
                gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
                this._clutterFow=fow;this._clutterFogVersion=fow.visibilityVersion;
            }
            if (!fow || !fow.fogDisplayCanvas) { this._fogEntry = null; return; }
            const gl = this.gl;
            if (this._fogCanvas !== fow.fogDisplayCanvas || !this._fogEntry) {
                this._fogCanvas = fow.fogDisplayCanvas;
                if (this._fogTex) gl.deleteTexture(this._fogTex);
                // NPOT canvas (numTiles*4, e.g. 1600) — clamp + no mipmaps
                this._fogTex = GLCore.createTextureFromCanvas(gl, this._fogCanvas, { clamp: true, nomip: true });
                // The fog reaches past the map so it can fade out over water rather
                // than being cut off at the coast — the plane has to match.
                const size = fow.displayWorldSize || fow.mapSize || 800;
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
                const shot = game.directorPose ? game.directorPose() : null;
                if (shot) {
                    const want = Math.max(MIN_HALF, Math.min(MAX_HALF, shot.halfH));
                    if (shot.cut) {
                        // The cut IS the feature. No travel, no ease, no sailing
                        // across whatever happens to lie between two subjects --
                        // which is what made half of a recorded match dead air.
                        this.cameraTarget.x = shot.x; this.cameraTarget.z = shot.z;
                        this._halfH = want;
                        this._yaw = shot.yaw;
                        this._pitch = shot.pitch;
                    } else {
                        const k = Math.min(1, deltaTime * 1.6);
                        this.cameraTarget.x += (shot.x - this.cameraTarget.x) * k;
                        this.cameraTarget.z += (shot.z - this.cameraTarget.z) * k;
                        this._halfH += (want - this._halfH) * k;
                        // Shortest way round the circle. Eased raw, a camera at 350
                        // degrees easing toward 10 takes the 340-degree route and
                        // spins the whole board to travel twenty.
                        let d = shot.yaw - this._yaw;
                        while (d > Math.PI) d -= Math.PI * 2;
                        while (d < -Math.PI) d += Math.PI * 2;
                        this._yaw += d * k;
                        this._pitch += (shot.pitch - this._pitch) * k;
                    }
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
            // Separation stops an army stacking into one pillar. It applies ONLY
            // between units of the SAME owner — an enemy is not a wall. All-pairs
            // separation meant a charging unit had to out-shove the entire enemy
            // front to reach anything: the mover advances ~0.072/frame at speed
            // 1.5 while each neighbour pushes ~0.018 back, so six defenders
            // (0.108) simply repelled it and it never landed a blow, however the
            // LLM ordered it. Enemies interpenetrate now and melee always
            // connects; the cost is that opposing armies merge instead of holding
            // a front line, which is the deliberate trade.
            //
            // dt-SCALED: the push used to be a flat per-FRAME amount, so a 144Hz
            // display separated ~2.4x harder than a 60Hz one — the framerate
            // silently tuned the combat. Normalised to 60Hz so the constants keep
            // their old meaning; clamped so one long frame can't fling anyone.
            // A transcript is a snapshot: presentation must not push its recorded
            // entities apart or out of buildings between turns.
            if (!this.replayMode) {
                const SEPARATION_DIST = 1.2, SEPARATION_FORCE = 0.03;
                const sepK = Math.min(3, Math.max(0, deltaTime) * 60);
                for (let i = 0; i < this.units.length; i++) {
                    for (let j = i + 1; j < this.units.length; j++) {
                        const a = this.units[i], b = this.units[j];
                        if (a.owner !== b.owner) continue; // an enemy is not a wall
                        const dx = b.x - a.x, dz = b.z - a.z;
                        const dist = Math.sqrt(dx * dx + dz * dz);
                        if (dist < SEPARATION_DIST && dist > 0.01) {
                            const push = (SEPARATION_DIST - dist) * SEPARATION_FORCE * sepK;
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
                    // A marcher that has NOT yet acquired a target still ghosts every
                    // building: the radial clearance rings around a packed base overlap
                    // into channels it cannot thread, and it used to pin against them
                    // and slide along the walls forever instead of closing in —
                    // "can't reach the barracks from the side".
                    if (unit.isAttacking && !unit.attackTarget && unit.attackMove) return;
                    this.buildings.forEach(building => {
                        if (building.type === 'farm') return;
                        if (unit.task === 'building' && unit.buildTarget === building) return;
                        if (unit.task === 'repairing' && unit.repairTarget === building) return;
                        // Ghost through the ONE building you're attacking, so melee can
                        // close on it — the same per-target shape as the build/repair
                        // exemptions above. This used to exempt a combatant from EVERY
                        // building on the map, so the instant a unit retaliated it lost
                        // all clearance and its own squadmates' separation shoved it
                        // bodily THROUGH the nearest wall. Two pushes, one exempting
                        // fighters and one exempting nobody, disagreeing.
                        if (unit.isAttacking && unit.attackTarget === building) return;
                        const clr = building.isWonder ? WONDER_CLEARANCE : UNIT_BUILDING_CLEARANCE;
                        const dx = unit.x - building.x, dz = unit.z - building.z;
                        const dist = Math.sqrt(dx * dx + dz * dz);
                        // DEAD CENTRE is the one place this push could not reach. The old
                        // guard was `dist > 0.01`, meant to avoid dividing by zero, and it
                        // meant a unit standing exactly on a building's origin was left
                        // there forever — inside the mesh, permanently. Not a rare spot: a
                        // plain move snaps onto its destination exactly, so anything aimed
                        // at a building's coordinates lands on 0.00 and stops being pushed
                        // at the instant it most needs to be. game.clampSlot has always
                        // handled this case ("dead centre: any direction out"); the
                        // continuous push simply never learned it.
                        if (dist <= 0.01) {
                            unit.x = building.x + clr;
                        } else if (dist < clr) {
                            const push = (clr - dist) * 0.05 * sepK; // dt-scaled, like the pass above
                            unit.x += (dx / dist) * push;
                            unit.z += (dz / dist) * push;
                        }
                    });
                });
            }

            // draw ------------------------------------------------------------
            const gl = this.gl;
            const cam = this._computeCam();
            if (this.game?.sound) this.game.sound.update();
            if (typeof game !== 'undefined' && game?._actionCam && game.spectatorMode
                && game.gameStarted && game._director) {
                game._director.measureCoverage(this, Date.now());
            }
            const bb = M().billboard(cam.view);
            this._assembleFrame(now / 1000, deltaTime, bb);
            this._syncFog();
            const atmosphere = window.EngineAtmosphere.daylight(
                this.game?._showcaseCivilization ? (this.game._showcaseLightSeconds || 0) : (this.game?._environmentSeconds || 0),
                this._daySun, this._daySky, this._theme);
            this._sun = atmosphere.sun;
            this._sky = atmosphere.sky;
            this._renderShadows();

            gl.viewport(0, 0, this.W, this.H);
            gl.clearColor(this._sky[0], this._sky[1], this._sky[2], 1); // deep sea beyond the map
            gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
            gl.useProgram(this.prog);
            gl.uniformMatrix4fv(this.prog.uniforms.uProj, false, cam.proj);
            gl.uniformMatrix4fv(this.prog.uniforms.uView, false, cam.view);
            gl.uniform3fv(this.prog.uniforms.uSunDir, this.sunDir);
            gl.uniform3fv(this.prog.uniforms.uSunColor, this._sun);
            gl.uniform3fv(this.prog.uniforms.uAmbient, AMBIENT.map((v,i)=>v*(1-atmosphere.night*[0.60,0.51,0.34][i])));
            gl.uniform1f(this.prog.uniforms.uNight, atmosphere.night);
            gl.uniform3fv(this.prog.uniforms.uSky, this._sky);
            gl.uniform2fv(this.prog.uniforms.uHaze, cam.haze);
            gl.activeTexture(gl.TEXTURE0);
            gl.uniform1i(this.prog.uniforms.uTex, 0);
            gl.uniform3fv(this.prog.uniforms.uEye,cam.eye);
            // No time reset: the old modulo teleported waves every 68 minutes.
            gl.uniform1f(this.prog.uniforms.uTime,now/1000);
            gl.uniform1f(this.prog.uniforms.uGrassTime,(now/1000)%(Math.PI*20));
            gl.uniform1f(this.prog.uniforms.uClothTime,(this.game?._environmentSeconds||0)%Math.PI);
            gl.uniform1f(this.prog.uniforms.uClutterFog,this._clutterFogActive?1:0);
            gl.uniform1f(this.prog.uniforms.uClutterMapSize,this.game?.fogOfWar?.mapSize || 800);
            gl.activeTexture(gl.TEXTURE4);
            gl.bindTexture(gl.TEXTURE_2D,this._clutterVisibilityTex || this.tex.white);
            gl.uniform1i(this.prog.uniforms.uClutterVisibility,4);
            gl.activeTexture(gl.TEXTURE0);
            gl.uniform1f(this.prog.uniforms.uAtmosphere,this.visualStyle === 'classic' ? 0 : 1);
            gl.uniformMatrix4fv(this.prog.uniforms.uLightMatrix,false,this._lightMatrix);
            gl.uniform1f(this.prog.uniforms.uShadowStrength,this._shadowStrength);
            gl.uniform1f(this.prog.uniforms.uShadowTexel,this._shadowTarget ? 1/this._shadowTarget.size : 1);
            gl.uniform1f(this.prog.uniforms.uShadowDepthPerTexel,this._shadowCamera ? this._shadowCamera.depthPerTexel : 0);
            gl.uniform3fv(this.prog.uniforms.uShadowRight,this._shadowCamera ? this._shadowCamera.right : this.WHITE);
            gl.uniform3fv(this.prog.uniforms.uShadowUp,this._shadowCamera ? this._shadowCamera.up : this.WHITE);
            gl.activeTexture(gl.TEXTURE1);
            gl.bindTexture(gl.TEXTURE_2D,this._shadowTarget ? this._shadowTarget.texture : this.tex.white);
            gl.uniform1i(this.prog.uniforms.uShadowMap,1);
            gl.activeTexture(gl.TEXTURE2);
            gl.bindTexture(gl.TEXTURE_2D,this.tex.coast || this.tex.white);
            gl.uniform1i(this.prog.uniforms.uCoast,2);
            gl.activeTexture(gl.TEXTURE3);
            gl.bindTexture(gl.TEXTURE_2D,this.tex.groundDetail || this.tex.white);
            gl.uniform1i(this.prog.uniforms.uGroundDetail,3);
            gl.uniform1f(this.prog.uniforms.uPebbleGround,this.graphicsQuality === 'cinematic' && this._theme !== 'winter' ? 1 : 0);
            gl.uniform1f(this.prog.uniforms.uGrayGravel,this._theme === 'desert' ? 0 : 1);
            gl.uniform4fv(this.prog.uniforms.uGroundCover,this._groundCover || [0,0,0,0]);
            gl.activeTexture(gl.TEXTURE0);

            const draw = (list) => {
                for (const obj of list) {
                    gl.uniform1f(this.prog.uniforms.uVegetation,obj.vegetation?1:0);
                    gl.bindTexture(gl.TEXTURE_2D, obj.tex);
                    const metal = obj.tex === this.tex.gold || obj.tex === this.tex.iron;
                    gl.uniform1f(this.prog.uniforms.uMaterial,obj.material || (metal ? 3 : 0));
                    gl.uniform3fv(this.prog.uniforms.uTint, obj.tint || this.WHITE);
                    gl.uniform1f(this.prog.uniforms.uAlpha, (obj.alpha == null ? 1 : obj.alpha)
                        * (obj.tex === this.tex.shadow ? 1-this._shadowStrength*.45 : 1));
                    gl.uniform2f(this.prog.uniforms.uUvOffset,
                        obj.uvOff ? obj.uvOff[0] : 0, obj.uvOff ? obj.uvOff[1] : 0);
                    gl.uniform4fv(this.prog.uniforms.uCloth,obj.cloth||[0,0,0,0]);
                    gl.uniform4fv(this.prog.uniforms.uLocalLights,obj.localLights||(this._noLocalLights ||= new Float32Array(12)));
                    gl.uniformMatrix4fv(this.prog.uniforms.uModel, false, obj.model);
                    if(obj.additive)gl.blendFunc(gl.SRC_ALPHA,gl.ONE);
                    GLCore.drawMesh(gl, this.prog, obj.buf);
                    if(obj.additive)gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);
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
            this._completedFrames=(this._completedFrames || 0)+1;
        }
    }

    window.EngineRenderer = EngineRenderer;
})();
